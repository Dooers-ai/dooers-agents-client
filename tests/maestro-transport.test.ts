import { credential } from './fixtures/maestro-credential'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MaestroClient } from '../src/maestro/client'
import { parseMaestroNetworkSchema, readMaestroNetworkEvent } from '../src/maestro/network'
import type { MaestroClientConfig, MaestroSocket } from '../src/maestro/types'
import fixtures from '../vendor/maestro-v1/contracts/fixtures/v1/public.json'
import { publicSchemas } from '../src/protocol/maestro/vendor/public'
const fixture = (schema: string): any => structuredClone(fixtures.cases.find(c => c.schema === schema && c.valid)!.data)
const id = '00000000-0000-4000-8000-000000000011'
const otherId = '00000000-0000-4000-8000-000000000012'
const thread = fixture('Public.Event.message.created').thread_id
const org = '00000000-0000-4000-8000-000000000001'
const principal = fixture('Public.Event.message.created').actor.principal_id
const scope = { principalId: principal, organizationId: org, workspaceId: null }
const caps = ['messages.text', 'threads.shared', 'history.replay']
const input = { threadId: thread, content: [{ type: 'text' as const, text: 'Hello' }], clientEventId: 'semantic-1' }
class Socket implements MaestroSocket {
  readyState = 0
  onopen: MaestroSocket['onopen'] = null
  onclose: MaestroSocket['onclose'] = null
  onerror: MaestroSocket['onerror'] = null
  onmessage: MaestroSocket['onmessage'] = null
  sent: any[] = []
  close = vi.fn(() => { this.readyState = 3 })
  constructor(readonly url: string) {}
  send(data: string) { this.sent.push(JSON.parse(data)) }
  open() { this.readyState = 1; this.onopen?.(new Event('open')) }
  receive(frame: unknown) { this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(frame) })) }
  drop() { this.readyState = 3; this.onclose?.(new CloseEvent('close')) }
  last() { return this.sent.at(-1)! }
}
const clients: MaestroClient[] = []
const sockets: Socket[] = []
const options = (extra: Partial<MaestroClientConfig> = {}): MaestroClientConfig => ({ mode: 'maestro', endpoint: 'https://maestro.example', scope, authToken: credential(principal, org), maxReconnectAttempts: 0, socketFactory: url => { const socket = new Socket(url); sockets.push(socket); return socket }, ...extra })
const make = (extra: Partial<MaestroClientConfig> = {}) => { const client = new MaestroClient(options(extra)); clients.push(client); return client }
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
function ackConnect(socket: Socket, advertised = caps) {
  socket.receive({ id: socket.last().id, type: 'ack', payload: { status: 'connected', connection_id: id, server_version: '0.0.0', protocol_version: 1, history_authority: 'maestro', capabilities: advertised, expires_at: new Date(Date.now() + 300000).toISOString() } })
}
async function connected(client = make(), advertised = caps) {
  const connecting = client.connect(); await tick()
  const socket = sockets.at(-1)!; socket.open(); await tick(); ackConnect(socket, advertised); await connecting
  return { client, socket }
}
function receipt(command = { payload: { ...input, client_event_id: input.clientEventId, thread_id: thread } }) {
  const event = fixture('Public.Event.message.created')
  event.thread_id = command.payload.thread_id
  event.payload = { content: command.payload.content, mentions: [], client_event_id: command.payload.client_event_id }
  return { status: 'persisted', event, cursor: 'opaque', duplicate: false }
}
function ackPublication(socket: Socket, body = receipt(socket.last())) { socket.receive({ id: socket.last().id, type: 'ack', payload: body }); return body }
async function subscribe(client: MaestroClient, socket: Socket) {
  const promise = client.subscribeThread(thread)
  socket.receive({ id: socket.last().id, type: 'ack', payload: { status: 'subscribed', subscription_id: otherId, replay_watermark: '0', replay_mode: 'snapshot' } })
  await promise
}
const errorFrame = (requestId: string, code = 'VALIDATION_FAILED', retryable = false) => ({ id: requestId, type: 'error', payload: { code, message: 'Rejected', retryable, request_id: id } })
afterEach(() => { for (const client of clients) client.dispose(); clients.length = 0; sockets.length = 0; vi.useRealTimers(); vi.restoreAllMocks() })

describe('Maestro connection and auth', () => {
  it('opens /ws outside API prefix, no token query/mode/agent, and requires validated handshake', async () => {
    const client = make({ apiPrefix: '/custom/v3' })
    const connecting = client.connect(); await tick(); const socket = sockets[0]!
    expect(socket.url).toBe('wss://maestro.example/ws')
    expect(client.getConnection().status).toBe('connecting')
    socket.open(); await tick()
    expect(socket.last()).toMatchObject({ type: 'connect', payload: { auth_token: credential(principal, org), protocol_version: 1, client_capabilities: ['messages.text', 'attachments.durable', 'feedback', 'export'] } })
    expect(socket.last().payload).not.toHaveProperty('mode')
    socket.receive({ id: socket.last().id, type: 'ack', payload: { status: 'connected', connection_id: id, server_version: '900.0.0', protocol_version: 1, history_authority: 'maestro', capabilities: [], expires_at: new Date(Date.now() + 300000).toISOString(), future_optional: true }, future_optional: true })
    await connecting
    await expect(client.send(input)).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' })
  })
  it.each(['https://user:password@maestro.example', 'https://maestro.example/api/v1', 'https://maestro.example/?token=x', 'http://remote.example', 'ftp://maestro.example'])('rejects unsafe/ambiguous endpoint %s', endpoint => expect(() => make({ endpoint })).toThrow())
  it('allows explicit local HTTP without granting arbitrary insecure hosts', () => { expect(make({ endpoint: 'http://127.0.0.1:8000', allowInsecureLocalhost: true })).toBeInstanceOf(MaestroClient); expect(() => make({ endpoint: 'http://remote.example', allowInsecureLocalhost: true })).toThrow() })
  it('rejects agent mode without fallback', () => expect(() => make({ mode: 'agent' as 'maestro' })).toThrow())
  it('requires actual refresh ACK before new sends and switches HTTP token afterwards', async () => {
    const fetcher = vi.fn(async () => json(receipt()))
    const { client, socket } = await connected(make({ fetch: fetcher }))
    const refreshedToken = credential(principal, org, {}, 'new-token')
    const refresh = client.refreshAuth(refreshedToken); await tick()
    expect(socket.last()).toMatchObject({ type: 'auth.refresh', payload: { auth_token: refreshedToken } })
    expect(client.getConnection().status).toBe('refreshing')
    await expect(client.send(input)).rejects.toMatchObject({ code: 'DISCONNECTED' })
    socket.receive({ id: socket.last().id, type: 'ack', payload: { status: 'authenticated', expires_at: new Date(Date.now() + 300000).toISOString() } })
    await refresh
    await client.send(input, { transport: 'http' })
    expect(fetcher.mock.calls[0]![1].headers.Authorization).toBe(`Bearer ${refreshedToken}`)
  })
  it('rejects denied refresh and clears access before asking for a replacement', async () => {
    const required = vi.fn()
    const { client, socket } = await connected(make({ onAuthRequired: required }))
    const send = client.send(input); ackPublication(socket); await send
    const refresh = client.refreshAuth(credential(principal, org, {}, 'revoked-session')); await tick(); socket.receive(errorFrame(socket.last().id, 'FORBIDDEN'))
    await expect(refresh).rejects.toMatchObject({ code: 'FORBIDDEN' }); await tick()
    expect(client.publications.getSnapshot().events).toEqual([])
    expect(client.getConnection().status).toBe('unauthenticated')
    expect(required).toHaveBeenCalledOnce()
  })
  it('expires locally and never emits execution.cancel on disconnect', async () => {
    vi.useFakeTimers(); const { client, socket } = await connected()
    await vi.advanceTimersByTimeAsync(300001)
    expect(client.getConnection().status).not.toBe('connected')
    expect(socket.sent.some(frame => frame.type === 'execution.cancel')).toBe(false)
  })
  it('bounds credential resolution and passes cancellation without logging token', async () => {
    vi.useFakeTimers(); let signal: AbortSignal | undefined
    const client = make({ requestTimeoutMs: 100, authToken: ctx => { signal = ctx.signal; return new Promise(() => {}) } })
    const promise = client.connect().catch(e => e)
    await vi.advanceTimersByTimeAsync(101)
    expect((await promise).code).toBe('TIMEOUT'); expect(signal!.aborted).toBe(true); expect(sockets).toHaveLength(0)
  })
  it('bounds heartbeat and rejects a pong with a different nonce', async () => {
    vi.useFakeTimers(); const { client, socket } = await connected(make({ heartbeatMs: 100 }))
    await vi.advanceTimersByTimeAsync(101)
    expect(socket.last().type).toBe('ping')
    socket.receive({ id: socket.last().id, type: 'pong', payload: { nonce: 'wrong' } }); await tick()
    expect(client.getConnection().status).toBe('failed')
  })
})

describe('publication receipts and semantic retries', () => {
  it.each(['append-first', 'ack-first'])('updates ledger before resolving and deduplicates %s', async order => {
    const { client, socket } = await connected(); await subscribe(client, socket)
    let settled = false
    const send = client.send(input).then(result => { settled = true; expect(client.publications.get(thread, input.clientEventId)?.state).toBe('persisted'); expect(client.publications.getSnapshot().events).toHaveLength(1); return result })
    const command = socket.last(); const body = receipt(command)
    const append = { type: 'event.append', payload: { subscription_id: otherId, event: body.event, cursor: body.cursor } }
    const ack = { id: command.id, type: 'ack', payload: body }
    if (order === 'append-first') { socket.receive(append); await tick(); expect(settled).toBe(false); socket.receive(ack) } else { socket.receive(ack); await send; socket.receive(append) }
    socket.receive(append); socket.receive(ack)
    const result = await send
    expect(result).toMatchObject({ threadId: thread, clientEventId: 'semantic-1', eventId: body.event.event_id, cursor: 'opaque' })
    expect(client.publications.getSnapshot().events).toHaveLength(1)
  })
  it('generates a recoverable key before I/O and never accepts an offline queue', async () => {
    const client = make(); const prepared = client.prepareMessage({ ...input, clientEventId: undefined })
    expect(prepared.clientEventId).toMatch(/^[a-f0-9-]{36}$/)
    await expect(client.send(prepared)).rejects.toMatchObject({ code: 'DISCONNECTED' })
    expect(client.publications.getSnapshot().publications).toHaveLength(0)
  })
  it('keeps unknown on disconnect and retries via HTTP with the same key/body', async () => {
    const fetcher = vi.fn(async () => json(receipt()))
    const { client, socket } = await connected(make({ fetch: fetcher }))
    const send = client.send(input); const observed = send.catch(e => e); const original = socket.last()
    socket.drop(); expect((await observed).publicationState).toBe('unknown')
    expect(client.publications.get(thread, input.clientEventId)?.state).toBe('unknown')
    const reconnect = client.connect(); await tick(); const next = sockets.at(-1)!; next.open(); await tick(); ackConnect(next); await reconnect
    expect(next.sent.map(frame => frame.type)).toEqual(['connect'])
    const result = await client.retry(thread, input.clientEventId, { transport: 'http' })
    const call = fetcher.mock.calls[0]!
    const body = JSON.parse(call[1].body)
    expect(call[0]).toBe(`https://maestro.example/api/v1/threads/${thread}/events`)
    expect(call[1]).toMatchObject({ credentials: 'omit', redirect: 'error', cache: 'no-store' })
    expect(call[1].headers['Idempotency-Key']).toBe(original.payload.client_event_id)
    expect(body).toEqual({ type: 'message.create', client_event_id: original.payload.client_event_id, content: original.payload.content, mentions: [], agent_options: [] })
    expect(result.clientEventId).toBe(input.clientEventId)
  })
  it('retries uncertain HTTP on WS and rejects payload mutation locally', async () => {
    const { client, socket } = await connected(make({ fetch: vi.fn(async () => { throw new Error('synthetic secret'); }) }))
    await expect(client.send(input, { transport: 'http' })).rejects.toMatchObject({ code: 'NETWORK_ERROR', publicationState: 'unknown' })
    await expect(client.send({ ...input, content: [{ type: 'text', text: 'changed' }] })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
    const retry = client.retry(thread, input.clientEventId); expect(socket.last().payload.client_event_id).toBe(input.clientEventId); ackPublication(socket); await retry
  })
  it('deduplicates concurrent attempts and returns the existing persisted result', async () => {
    const { client, socket } = await connected(); const first = client.send(input); const second = client.send(input, { transport: 'http' })
    expect(first).toBe(second); expect(socket.sent.filter(frame => frame.type === 'message.publish')).toHaveLength(1)
    ackPublication(socket); const result = await first; expect(await client.send(input)).toBe(result)
  })
  it('does not confuse a different actor with a matching client_event_id', async () => {
    const { client, socket } = await connected(); await subscribe(client, socket)
    const send = client.send(input); const body = receipt(socket.last()); body.event.actor.principal_id = 'someone-else'
    socket.receive({ type: 'event.append', payload: { subscription_id: otherId, event: body.event, cursor: 'other' } })
    expect(client.publications.getSnapshot().events).toHaveLength(0)
    ackPublication(socket); await send; expect(client.publications.getSnapshot().events).toHaveLength(1)
  })
  it('turns a timeout into unknown and ignores late ACK without auto-resending', async () => {
    vi.useFakeTimers(); const { client, socket } = await connected(make({ requestTimeoutMs: 100 }))
    const observed = client.send(input).catch(e => e); const command = socket.last()
    await vi.advanceTimersByTimeAsync(101); expect((await observed).publicationState).toBe('unknown')
    socket.receive({ id: command.id, type: 'ack', payload: receipt(command) })
    expect(client.publications.get(thread, input.clientEventId)?.state).toBe('unknown')
    expect(socket.sent.filter(frame => frame.type === 'message.publish')).toHaveLength(1)
  })
  it('marks a canonical rejection rejected and never retries it automatically', async () => {
    const { client, socket } = await connected(); const send = client.send(input); socket.receive(errorFrame(socket.last().id, 'IDEMPOTENCY_CONFLICT'))
    await expect(send).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', publicationState: 'rejected' })
    expect(client.publications.get(thread, input.clientEventId)?.state).toBe('rejected')
  })
  it.each(['key', 'thread', 'author', 'content'])('does not accept mismatched %s in receipt', async field => {
    const { client, socket } = await connected(); const send = client.send(input); const body = receipt(socket.last())
    if (field === 'key') body.event.payload.client_event_id = 'other'
    if (field === 'thread') body.event.thread_id = otherId
    if (field === 'author') body.event.actor.principal_id = 'other'
    if (field === 'content') body.event.payload.content[0].text = 'other'
    ackPublication(socket, body); await expect(send).rejects.toMatchObject({ code: 'PROTOCOL_ERROR', publicationState: 'unknown' })
    expect(client.publications.getSnapshot().events).toHaveLength(0)
  })
  it('disallows sending unsupported attachments and limits retained operations', async () => {
    const { client, socket } = await connected(make({ maxPublications: 1 }))
    await expect(client.send({ ...input, content: [{ type: 'attachment', artifact_id: id }] })).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' })
    const send = client.send(input); ackPublication(socket); await send
    await expect(client.send({ ...input, clientEventId: 'second' })).rejects.toMatchObject({ code: 'CAPACITY_EXCEEDED' })
  })
  it('observer exceptions cannot change a persisted receipt', async () => {
    const { client, socket } = await connected(); client.publications.subscribe(() => { throw new Error('observer') })
    const send = client.send(input); ackPublication(socket); await expect(send).resolves.toHaveProperty('eventId')
  })
})

describe('network compatibility and isolation', () => {
  it('accepts additive fields at nested event/actor/content paths without weakening required fields', () => {
    const receipt = fixture('Public.PersistedResponse')
    receipt.extra = true; receipt.event.extra = true; receipt.event.actor.extra = true; receipt.event.payload.content[0].extra = true
    expect(parseMaestroNetworkSchema('Public.PersistedResponse', receipt)).toEqual(fixture('Public.PersistedResponse'))
    delete receipt.event.sequence
    expect(() => parseMaestroNetworkSchema('Public.PersistedResponse', receipt)).toThrow()
  })
  it('retains arbitrary user form fields rather than stripping recursively by name', () => {
    const event = fixture('Public.Event.interaction.responded')
    expect(readMaestroNetworkEvent(event).event).toEqual(event)
  })
  it('represents a future event without accepting wrong schema versions or enabling its action', () => {
    const event = fixture('Public.Event.message.created'); event.type = 'future.event'; event.payload = { arbitrary: true }
    expect(readMaestroNetworkEvent(event)).toMatchObject({ known: false, event: { type: 'future.event' } })
    event.schema_version = 2; expect(() => readMaestroNetworkEvent(event)).toThrow()
  })
  it('strict command schemas still reject unknown input fields', () => expect(publicSchemas['Public.MessageCreateRequest'].safeParse({ type: 'message.create', client_event_id: 'x', content: input.content, secret: true }).success).toBe(false))
  it('explicit HTTP transport negotiates capabilities and emits no WebSocket or agent request', async () => {
    const calls: [string, RequestInit][] = []
    const client = make({ transport: 'http', apiPrefix: '/v2/local', fetch: (async (url, init) => { calls.push([String(url), init!]); return json(calls.length === 1 ? { protocol_version: 1, schema_version: 1, server_version: '0.0.0', history_authority: 'maestro', capabilities: caps } : receipt()) }) as typeof fetch })
    await client.connect(); await client.send(input)
    expect(sockets).toHaveLength(0); expect(calls.map(c => c[0])).toEqual(['https://maestro.example/v2/local/capabilities', `https://maestro.example/v2/local/threads/${thread}/events`])
    expect('subscribeSettings' in client).toBe(false); expect('subscribeAnalytics' in client).toBe(false)
  })
  it('fails closed on oversize/binary frames and cannot leak received raw text into errors', async () => {
    const errors: unknown[] = []; const { client, socket } = await connected(make({ maxResponseBytes: 1024, onError: failure => errors.push(failure) }))
    socket.onmessage?.(new MessageEvent('message', { data: 'secret'.repeat(1000) }))
    expect(client.getConnection().status).toBe('failed'); expect(JSON.stringify(errors)).not.toContain('secret')
  })
  it('disposal aborts pending HTTP and prevents a late response from repopulating state', async () => {
    let resolve!: (response: Response) => void; let signal: AbortSignal | undefined
    const { client } = await connected(make({ fetch: (async (_url, init) => { signal = init!.signal!; return new Promise<Response>(done => { resolve = done }) }) as typeof fetch }))
    const sending = client.send(input, { transport: 'http' }).catch(e => e); client.dispose(); expect(signal!.aborted).toBe(true)
    resolve(json(receipt())); expect((await sending).publicationState).toBe('unknown'); expect(client.publications.getSnapshot().events).toEqual([])
  })
  it('reconnects with bounded jitter and never republishes an unknown intention', async () => {
    vi.useFakeTimers(); vi.spyOn(Math, 'random').mockReturnValue(0)
    const resolver = vi.fn(() => credential(principal, org)); const { client, socket } = await connected(make({ maxReconnectAttempts: 2, reconnectBaseMs: 100, requestTimeoutMs: 100, authToken: resolver }))
    const sending = client.send(input).catch(e => e); socket.drop(); await sending
    await vi.advanceTimersByTimeAsync(51); expect(sockets).toHaveLength(2); expect(resolver).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(101); await vi.advanceTimersByTimeAsync(101); await vi.advanceTimersByTimeAsync(101)
    expect(sockets).toHaveLength(3); expect(client.getConnection().status).toBe('failed')
    expect(sockets.flatMap(s => s.sent).filter(frame => frame.type === 'message.publish')).toHaveLength(1)
  })
})

it('serializes distinct credentials and only resolves each refresh after its own ACK', async () => {
  const { client, socket } = await connected()
  const second = credential(principal, org, {}, 'second')
  const third = credential(principal, org, {}, 'third')
  const refreshB = client.refreshAuth(second)
  const refreshC = client.refreshAuth(third)
  let cSettled = false; void refreshC.then(() => { cSettled = true })
  await tick(); expect(socket.last().payload.auth_token).toBe(second)
  socket.receive({ id: socket.last().id, type: 'ack', payload: { status: 'authenticated', expires_at: new Date(Date.now() + 300000).toISOString() } })
  await refreshB; await tick()
  expect(cSettled).toBe(false); expect(socket.last().payload.auth_token).toBe(third)
  expect(client.getConnection().status).toBe('refreshing')
  socket.receive({ id: socket.last().id, type: 'ack', payload: { status: 'authenticated', expires_at: new Date(Date.now() + 300000).toISOString() } })
  await refreshC; expect(cSettled).toBe(true)
})
it.each(['websocket', 'http'] as const)('keeps a technical %s response unknown until same-key duplicate receipt', async transport => {
  let attempts = 0
  const fetcher = vi.fn(async () => {
    attempts++
    return attempts === 1
      ? json({ error: errorFrame(id, 'DEPENDENCY_UNAVAILABLE', true).payload }, 503)
      : json({ ...receipt(), duplicate: true })
  })
  const { client, socket } = await connected(make({ fetch: fetcher }))
  const sending = client.send(input, { transport })
  if (transport === 'websocket') socket.receive(errorFrame(socket.last().id, 'CORE_UNAVAILABLE', true))
  await expect(sending).rejects.toMatchObject({ publicationState: 'unknown', retryable: true })
  expect(client.publications.get(thread, input.clientEventId)?.state).toBe('unknown')
  const retry = client.retry(thread, input.clientEventId, { transport })
  if (transport === 'websocket') ackPublication(socket, { ...receipt(socket.last()), duplicate: true })
  await expect(retry).resolves.toMatchObject({ clientEventId: input.clientEventId, duplicate: true })
  expect(client.publications.getSnapshot().events).toHaveLength(1)
  if (transport === 'http') expect(fetcher.mock.calls.map((call: any) => call[1].headers['Idempotency-Key'])).toEqual([input.clientEventId, input.clientEventId])
})
it('normalizes UUID inputs and lookup while preserving the opaque publication key', async () => {
  const orgId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const threadId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  const mention = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  const workspaceId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
  const returnedThread = fixture('Public.Thread'); returnedThread.thread_id = threadId; returnedThread.organization_id = orgId; returnedThread.scope_kind = 'workspace'; returnedThread.workspace_id = workspaceId
  const fetcher = vi.fn(async (url: string) => url.endsWith('/events') ? json({ items: [], next_cursor: null, has_more: false, watermark: '0' }) : json(returnedThread))
  const { client, socket } = await connected(make({ scope: { principalId: principal, organizationId: orgId.toUpperCase(), workspaceId: workspaceId.toUpperCase() }, authToken: credential(principal, orgId, { workspace_id: workspaceId }), fetch: fetcher as typeof fetch }))
  expect(client.scope.organizationId).toBe(orgId); expect(client.scope.workspaceId).toBe(workspaceId)
  const send = client.send({ threadId: threadId.toUpperCase(), clientEventId: 'OpaqueKEY-X', content: input.content, mentions: [mention.toUpperCase()] })
  expect(socket.last().payload).toMatchObject({ thread_id: threadId, client_event_id: 'OpaqueKEY-X', mentions: [mention] })
  const body = receipt(socket.last()); body.event.payload.mentions = [mention]; ackPublication(socket, body)
  const result = await send
  expect(result.threadId).toBe(threadId); expect(result.clientEventId).toBe('OpaqueKEY-X')
  expect(client.publications.get(threadId.toUpperCase(), 'OpaqueKEY-X')?.state).toBe('persisted')
  expect(await client.retry(threadId.toUpperCase(), 'OpaqueKEY-X')).toBe(result)
  await client.getThread(threadId.toUpperCase()); await client.getHistory(threadId.toUpperCase())
  expect(fetcher.mock.calls.map(call => call[0])).toEqual([`https://maestro.example/api/v1/threads/${threadId}`, `https://maestro.example/api/v1/threads/${threadId}/events`])
  const subscribing = client.subscribeThread(threadId.toUpperCase()); expect(socket.last().payload.thread_id).toBe(threadId)
  socket.receive({ id: socket.last().id, type: 'ack', payload: { status: 'subscribed', subscription_id: otherId, replay_watermark: '0', replay_mode: 'snapshot' } }); await subscribing
})

describe('canonical live publication proofs (E07-05)', () => {
  const append = (socket: Socket, body: ReturnType<typeof receipt>) => socket.receive({ type: 'event.append', payload: { subscription_id: otherId, event: body.event, cursor: body.cursor } })
  it.each(['before-timeout', 'after-timeout', 'before-rejection'])('confirms %s without requiring another send', async (order) => {
    vi.useFakeTimers()
    const { client, socket } = await connected(make({ requestTimeoutMs: 100 }))
    await subscribe(client, socket)
    const sending = client.send(input).catch(e => e)
    const command = socket.last(); const body = receipt(command)
    if (order === 'after-timeout') { await vi.advanceTimersByTimeAsync(101); expect((await sending).publicationState).toBe('unknown') }
    append(socket, body)
    expect(client.publications.get(thread, input.clientEventId)?.state).toBe('persisted')
    expect(client.store.getThread(thread)?.optimisticByKey).toEqual({})
    if (order === 'before-rejection') socket.receive(errorFrame(command.id))
    else await vi.advanceTimersByTimeAsync(101)
    if (order !== 'after-timeout') expect(await sending).toMatchObject({eventId: body.event.event_id})
    expect(await client.retry(thread, input.clientEventId)).toMatchObject({eventId: body.event.event_id})
    expect(socket.sent.filter(f => f.type === 'message.publish')).toHaveLength(1)
    expect(client.publications.getSnapshot().events).toHaveLength(1)
  })
  it.each(['content', 'thread', 'actor', 'actor-kind', 'key'])('does not confirm a mismatched live %s', async field => {
    const { client, socket } = await connected(); await subscribe(client, socket)
    const sending = client.send(input).catch(e=>e); const body = receipt(socket.last())
    if(field === 'content') body.event.payload.content = [{type:'text',text:'forged'}]
    if(field === 'thread') body.event.thread_id = otherId
    if(field === 'actor') body.event.actor.principal_id = 'other-human'
    if(field === 'actor-kind') body.event.actor = { ...body.event.actor, kind: 'agent', instance_agent_id: id }
    if(field === 'key') body.event.payload.client_event_id = 'other-key'
    append(socket,body)
    expect(client.publications.get(thread,input.clientEventId)?.state).not.toBe('persisted')
    client.disconnect(); await sending
  })
  it('retains rejected draft until scope reset and cannot leak it to a later identity', async () => {
    const { client, socket } = await connected()
    const sending = client.send(input).catch(e=>e)
    socket.receive(errorFrame(socket.last().id)); await sending
    expect(client.store.getThread(thread)?.optimisticByKey[input.clientEventId]).toEqual(input)
    expect(client.store.getThread(thread)?.commandsByKey[input.clientEventId]?.state).toBe('rejected')
    client.reset()
    expect(client.store.getSnapshot().threads).toEqual({})
    expect(client.publications.getSnapshot().publications).toEqual([])
  })
})

it('typed agent principal equal to a UUID human cannot confirm that human publication', async () => {
  const human = id
  const { client, socket } = await connected(make({ scope: { ...scope, principalId: human }, authToken: credential(human, org) }))
  await subscribe(client, socket)
  const sending = client.send(input).catch(e=>e); const body = receipt(socket.last())
  body.event.actor = { ...body.event.actor, kind: 'agent', principal_id: human, instance_agent_id: otherId }
  // This is a structurally valid agent, not a malformed fixture rejected by the parser.
  expect(publicSchemas['Public.Event.message.created'].safeParse(body.event).success).toBe(true)
  socket.receive({ type: 'event.append', payload: { subscription_id: otherId, event: body.event, cursor: body.cursor } })
  expect(client.publications.get(thread,input.clientEventId)?.state).toBe('pending')
  client.disconnect(); await sending
})


describe('per-recipient options semantic identity', () => {
  const recipientOptions = [
    { participant_id: id, model: 'model-a', effort: 'low' as const },
    { participant_id: otherId, model: 'model-b', effort: 'max' as const },
  ]
  it('copies and canonicalizes the map before I/O', () => {
    const client = make({ perAgentOptions: true })
    const raw = structuredClone(recipientOptions)
    const prepared = client.prepareMessage({ ...input, agentOptions: raw })
    raw[0]!.model = 'mutated'
    expect(prepared.agentOptions).toEqual(recipientOptions)
    expect(client.prepareMessage({ ...input, agentOptions: [...recipientOptions].reverse() })).toEqual(prepared)
    expect(Object.isFrozen(prepared.agentOptions![0])).toBe(true)
  })
  it('offers the capability only under explicit opt-in', async () => {
    const { client, socket } = await connected(make({ perAgentOptions: true }), [...caps, 'chat_context.per_agent'])
    expect(socket.sent[0].payload.client_capabilities).toContain('chat_context.per_agent')
    const promise = client.send({ ...input, agentOptions: recipientOptions })
    expect(socket.last().payload.agent_options).toEqual(recipientOptions)
    const original = socket.last()
    const accepted = receipt(original)
    accepted.event.payload.agent_options = recipientOptions
    ackPublication(socket, accepted)
    await promise
    await expect(client.send({ ...input, agentOptions: [{ ...recipientOptions[0]!, model: 'changed' }, recipientOptions[1]!] })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
  })
  it('requires both opt-in and server capability', async () => {
    const { client } = await connected()
    await expect(client.send({ ...input, agentOptions: recipientOptions })).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' })
    const enabled = (await connected(make({ perAgentOptions: true }))).client
    await expect(enabled.send({ ...input, agentOptions: recipientOptions })).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' })
  })
  it('preserves both blocks on unknown HTTP to WS retry and recovery', async () => {
    const fetcher = vi.fn(async () => { throw new TypeError('lost acknowledgement') })
    const { client, socket } = await connected(make({ perAgentOptions: true, fetch: fetcher }), [...caps, 'chat_context.per_agent'])
    const prepared = client.prepareMessage({ ...input, agentOptions: recipientOptions })
    await expect(client.send(prepared, { transport: 'http' })).rejects.toMatchObject({ publicationState: 'unknown' })
    const pending = client.retry(thread, input.clientEventId, { transport: 'websocket' })
    expect(socket.last().payload.agent_options).toEqual(recipientOptions)
    const accepted = receipt(socket.last())
    accepted.event.payload.agent_options = recipientOptions
    ackPublication(socket, accepted)
    await pending
    expect(client.publications.get(thread, input.clientEventId)?.result?.event.payload).toMatchObject({ agent_options: recipientOptions })
  })
})
