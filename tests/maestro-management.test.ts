import { afterEach, expect, it, vi } from 'vitest'
import type { MaestroClient } from '../src/maestro/client'
import { connect, event, make, thread, threadId, tick, uuid } from './fixtures/maestro-replay'
const clients: MaestroClient[] = []
afterEach(() => { for (const client of clients) client.dispose(); clients.length = 0; vi.useRealTimers() })
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
async function setup(fetcher: typeof fetch) { const env = make({ fetch: fetcher }); clients.push(env.client); const socket = await connect(env.client, env.sockets); return { ...env, socket } }
it('uses exact versioned headers and a fresh authorized read after the commit receipt', async () => {
  const value = thread('2'); value.version = 2
  const fetcher = vi.fn(async (_url, init) => init?.method === 'GET' ? json(value) : json({ ...value, permissions: { ...value.permissions, manage: false } }))
  const { client } = await setup(fetcher)
  await client.transferOwnership(threadId, uuid(9), 1, 'ownership-key')
  expect(fetcher).toHaveBeenCalledTimes(2)
  expect(fetcher.mock.calls[0]![1]).toMatchObject({ method: 'POST', credentials: 'omit', headers: { 'If-Match': '1', 'Idempotency-Key': 'ownership-key' }, body: JSON.stringify({ participant_id: uuid(9) }) })
  expect(client.store.getThread(threadId)?.thread?.version).toBe(2)
})
it('an uncertain mutation retries with the same key and does not optimistically add a participant', async () => {
  const fetcher = vi.fn(async () => json(thread())).mockRejectedValueOnce(new TypeError('lost ACK'))
  const { client } = await setup(fetcher)
  const target = { kind: 'human' as const, principal_id: 'new-human', role: 'member' as const }
  await expect(client.addParticipant(threadId, target, 'stable-key')).rejects.toMatchObject({ code: 'NETWORK_ERROR' })
  expect(client.store.getThread(threadId)).toBeUndefined()
  await client.addParticipant(threadId, target, 'stable-key')
  expect(fetcher.mock.calls[0]![1]?.headers).toMatchObject({ 'Idempotency-Key': 'stable-key' })
  expect(fetcher.mock.calls[1]![1]?.headers).toMatchObject({ 'Idempotency-Key': 'stable-key' })
})
it('202 deletion validates the persisted job receipt, removes content and closes its subscription', async () => {
  const fetcher = vi.fn(async () => json({ deletion_job_id: uuid(70), state: 'deleting' }, 202))
  const { client, socket } = await setup(fetcher)
  client.retainThread(threadId); await tick(); socket.ackSubscribe(); socket.snapshot([event(1)], '1'); socket.caught('1'); await tick()
  expect(client.store.getThread(threadId)?.eventIds).toHaveLength(1)
  expect(await client.deleteThread(threadId, 1, 'delete-key')).toEqual({ deletion_job_id: uuid(70), state: 'deleting' })
  expect(client.store.getThread(threadId)?.phase).toBe('revoked')
  expect(client.store.getThread(threadId)?.eventIds).toHaveLength(0)
  expect(socket.last('thread.unsubscribe')).toBeDefined()
})
it('a supervision grant is audited before reads and bound to HTTP + WebSocket; expiration clears content', async () => {
  vi.useFakeTimers()
  const grant = { supervision_grant_id: uuid(90), thread_id: threadId, access: 'read_only', expires_at: new Date(Date.now() + 50000).toISOString(), policy_version: 1 }
  const fetcher = vi.fn(async (_url, init) => init?.method === 'POST' ? json(grant) : json(thread('1')))
  const { client, socket } = await setup(fetcher)
  await client.openSupervision(threadId, 'Operational review', 'supervision-key')
  await client.getThread(threadId)
  expect(fetcher.mock.calls[0]![1]?.body).toBe(JSON.stringify({ access_reason: 'Operational review' }))
  expect(fetcher.mock.calls[1]![1]?.headers).toMatchObject({ 'Maestro-Supervision-Grant': uuid(90) })
  client.retainThread(threadId); await tick()
  expect(socket.last('thread.subscribe').payload.supervision_grant_id).toBe(uuid(90))
  socket.ackSubscribe(); socket.snapshot([event(1)], '1'); socket.caught('1'); await tick()
  await expect(client.changeThreadState(threadId, 'archived', 1, 'forged-write')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(fetcher).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(50000)
  expect(client.store.getThread(threadId)?.phase).toBe('revoked')
  expect(client.store.getThread(threadId)?.eventIds).toHaveLength(0)
  expect(client.isSupervision(threadId)).toBe(false)
})
it('same canonical sequence refreshes ownership and participants as well as permissions', async () => {
  const updated = thread('2'); updated.version = 2; updated.participants[0]!.role = 'member'
  const fetcher = vi.fn(async () => json(updated))
  const { client } = await setup(fetcher)
  const prior = structuredClone(updated); prior.participants[0]!.role = 'owner'
  const { toMaestroThread } = await import('../src/protocol/maestro/contracts')
  client.store.observeThread(toMaestroThread(prior))
  await client.getThread(threadId)
  expect(Object.values(client.store.getThread(threadId)!.participantsById)[0]!.role).toBe('member')
})
it('an expired supervision grant fences a late HTTP response and cannot restore cleared history', async () => {
  vi.useFakeTimers()
  let finish!: (response: Response) => void
  const grant = { supervision_grant_id: uuid(90), thread_id: threadId, access: 'read_only', expires_at: new Date(Date.now() + 20000).toISOString(), policy_version: 1 }
  const fetcher = vi.fn(async (_url, init) => init?.method === 'POST' ? json(grant) : new Promise<Response>(resolve => { finish = resolve }))
  const { client } = await setup(fetcher)
  await client.openSupervision(threadId, 'Review with late network response', 'late-grant')
  const read = client.getThread(threadId)
  const rejected = expect(read).rejects.toMatchObject({ code: 'FORBIDDEN' })
  await vi.advanceTimersByTimeAsync(20000)
  finish(json(thread('5')))
  await rejected
  expect(client.store.getThread(threadId)?.phase).toBe('revoked')
  expect(client.store.getThread(threadId)?.thread).toBeNull()
  expect(client.store.getThread(threadId)?.eventIds).toHaveLength(0)
})
const failure = (status: number, code: string) => json({ error: { code, message: 'Falha', retryable: false, request_id: uuid(900) } }, status)
const supervisedGrant = () => ({ supervision_grant_id: uuid(90), thread_id: threadId, access: 'read_only', expires_at: new Date(Date.now() + 50000).toISOString(), policy_version: 1 })
/** What the Maestro serves for the thread; supervise() points it at the supervisor's view. */
const served: { value: ReturnType<typeof thread> } = { value: thread('1') }
async function supervise(permissions: Record<string, boolean>, fetcher: ReturnType<typeof vi.fn>) {
  const env = await setup(fetcher)
  await env.client.openSupervision(threadId, 'Operational review', 'supervision-key')
  env.client.retainThread(threadId); await tick()
  env.socket.ackSubscribe()
  const view = thread('1'); view.permissions = { ...view.permissions, write: false, ...permissions }
  served.value = view
  env.socket.frame('thread.snapshot', { thread: view, events: [event(1)], watermark: '1', next_cursor: null, has_more: false })
  env.socket.caught('1'); await tick()
  return { ...env, view }
}
it('supervision without a reason omits access_reason (the Maestro decides whether one is required)', async () => {
  const fetcher = vi.fn(async () => json(supervisedGrant()))
  const { client } = await setup(fetcher)
  await client.openSupervision(threadId, undefined, 'open-mode-key')
  expect(fetcher.mock.calls[0]![1]?.body).toBe(JSON.stringify({}))
  await client.openSupervision(threadId, '   ', 'blank-key')
  expect(fetcher.mock.calls[1]![1]?.body).toBe(JSON.stringify({}))
})
it('a request-scoped 403 on a management call does not end the authenticated session', async () => {
  const fetcher = vi.fn(async () => failure(403, 'FORBIDDEN'))
  const { client } = await setup(fetcher)
  await expect(client.changeThreadState(threadId, 'archived', 1, 'denied-key')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(client.getConnection().status).toBe('connected')
  await expect(client.openSupervision(threadId, 'Motivo', 'denied-supervision')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(client.getConnection().status).toBe('connected')
})
it('a 401 on a management call is still a session boundary', async () => {
  const fetcher = vi.fn(async () => failure(401, 'UNAUTHENTICATED'))
  const { client } = await setup(fetcher)
  await expect(client.changeThreadState(threadId, 'archived', 1, 'expired-key')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' })
  expect(client.getConnection().status).toBe('unauthenticated')
})
it('a supervisor archives only with the archive permission, and never adds, transfers or removes without theirs', async () => {
  const sent: Array<[string, RequestInit | undefined]> = []
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    sent.push([url, init])
    if (url.endsWith('/supervision')) return json(supervisedGrant())
    return json(served.value)
  })
  const { client, view } = await supervise({ archive: true, remove_participants: false, manage: false }, fetcher)
  await client.changeThreadState(threadId, 'archived', 1, 'archive-key')
  const patch = sent.find(([, init]) => init?.method === 'PATCH')!
  expect(patch[1]?.headers).toMatchObject({ 'If-Match': '1', 'Idempotency-Key': 'archive-key' })
  expect((patch[1]?.headers as Record<string, string>)['Maestro-Supervision-Grant']).toBeUndefined()
  await expect(client.removeParticipant(threadId, view.participants[0]!.participant_id, {}, 'remove-key')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  await expect(client.addParticipant(threadId, { kind: 'human', principal_id: 'someone', role: 'member' }, 'add-key')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  await expect(client.transferOwnership(threadId, uuid(9), 1, 'transfer-key')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  await expect(client.deleteThread(threadId, 1, 'delete-key')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  const mutations = sent.filter(([url, init]) => ['PATCH', 'DELETE', 'POST'].includes(init?.method ?? '') && !url.endsWith('/supervision'))
  expect(mutations.map(([, init]) => init?.method)).toEqual(['PATCH'])
})
it('with remove_participants a supervisor removes another participant without the grant header', async () => {
  const sent: Array<[string, RequestInit | undefined]> = []
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => { sent.push([url, init]); return url.endsWith('/supervision') ? json(supervisedGrant()) : json(served.value) })
  const { client } = await supervise({ remove_participants: true }, fetcher)
  await client.removeParticipant(threadId, uuid(9), {}, 'remove-key')
  const removal = sent.find(([, init]) => init?.method === 'DELETE')!
  expect(removal[0]).toBe(`https://maestro.example/api/v1/threads/${threadId}/participants/${uuid(9)}`)
  expect((removal[1]?.headers as Record<string, string>)['Maestro-Supervision-Grant']).toBeUndefined()
})
