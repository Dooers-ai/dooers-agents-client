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
