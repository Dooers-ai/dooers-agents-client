import { afterEach, expect, it, vi } from 'vitest'
import { MaestroApprovals, approvalExpiry } from '../src/maestro/approvals'
import { MaestroStore } from '../src/maestro/store'
import { MaestroClientError } from '../src/maestro/types'
import { toMaestroEvent, toMaestroThread } from '../src/protocol/maestro/contracts'
import { approval, approvalDecision, approvalId, approvalThread, publicCommitment } from './fixtures/maestro-approval'
import { connect, event, make, scope, threadId, tick, uuid } from './fixtures/maestro-replay'
const dispose: (() => void)[] = []
afterEach(() => dispose.splice(0).forEach(close => close()))
const response = (e = approvalDecision()) => ({ status: 'persisted' as const, duplicate: false, cursor: 'cursor-2', event: toMaestroEvent(e) })
const request = { action: 'approve' as const, data: { arguments_hash: publicCommitment } }
const setupManager = (send = vi.fn(async () => response()), authorize = vi.fn()) => {
  const store = new MaestroStore(scope); store.receipt(toMaestroEvent(approval()))
  const manager = new MaestroApprovals(send, store.getSnapshot, authorize); dispose.push(() => manager.clear())
  return { manager, store, send, authorize }
}
const setupClient = async (fetch: typeof globalThis.fetch, optIn = true) => {
  const env = make({ fetch, toolApprovals: optIn }); dispose.push(() => env.client.dispose())
  const socket = await connect(env.client, env.sockets)
  ;(env.client as any).setConnection({ ...env.client.getConnection(), capabilities: [...env.client.getConnection().capabilities, 'interactions.tool_approval'] })
  env.client.store.observeThread(toMaestroThread(approvalThread()))
  env.client.store.receipt(toMaestroEvent(approval())); env.client.store.caughtUp(threadId, '0', 'cursor-0')
  return { ...env, socket }
}
it('coalesces identical intentions and never renders a pending ACK as approval', async () => {
  let finish!: (value: ReturnType<typeof response>) => void
  const { manager, send } = setupManager(vi.fn(() => new Promise(resolve => { finish = resolve })))
  const a = manager.request(threadId, approvalId, request), b = manager.request(threadId, approvalId, request)
  expect(a).toBe(b); expect(manager.current(threadId, approvalId)?.state).toBe('pending'); await tick()
  finish(response()); await a; expect(send).toHaveBeenCalledTimes(1)
  expect(manager.getSnapshot()[0]?.state).toBe('persisted')
  expect(manager.current(threadId, approvalId)?.effectOutcome.state).toBe('unobserved')
})
it('lost ACK preserves exact hash/body/key; only explicit retry sends across transports', async () => {
  const send = vi.fn().mockRejectedValueOnce(new Error('ACK lost')).mockResolvedValueOnce(response())
  const { manager, store } = setupManager(send)
  await expect(manager.request(threadId, approvalId, request, { transport: 'http' })).rejects.toMatchObject({ code: 'NETWORK_ERROR' })
  store.receipt(toMaestroEvent(approvalDecision()))
  expect(manager.current(threadId, approvalId)?.state).toBe('approved'); expect(send).toHaveBeenCalledTimes(1)
  await expect(manager.request(threadId, approvalId, { action: 'reject', data: {} })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
  await manager.retry(threadId, approvalId, { transport: 'websocket' })
  expect(send.mock.calls[0]![0]).toEqual(send.mock.calls[1]![0]); expect(send.mock.calls[1]![1]).toBe('websocket')
})
it.each(['approve', 'reject', 'cancel'] as const)('replay %s is canonical, duplicate input is observational, outcome is separate', action => {
  const a = setupManager(), b = setupManager(); const decided = toMaestroEvent(approvalDecision(action))
  for (const item of [a, b]) { item.store.receipt(decided); item.store.receipt(decided) }
  expect(a.manager.current(threadId, approvalId)).toEqual(b.manager.current(threadId, approvalId))
  expect(a.manager.current(threadId, approvalId)).toMatchObject({ state: action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'canceled', effectOutcome: { state: 'unobserved' }, waitingForDecision: false })
  expect(a.send).not.toHaveBeenCalled(); expect(b.send).not.toHaveBeenCalled()
})
it('expiry is terminal and microseconds/calendar overflow are outside the local candidate', async () => {
  const { manager, store, send } = setupManager(); const expired = event(2, 'interaction.expired')
  expired.payload = { interaction_id: approvalId, delivery_id: uuid(404) }; store.receipt(toMaestroEvent(expired))
  await expect(manager.request(threadId, approvalId, request)).rejects.toMatchObject({ code: 'INTERACTION_ALREADY_RESPONDED' })
  for (const invalid of ['2026-02-30T00:00:00Z','2026-01-01T00:00:00.000200Z','0000-01-01T00:00:00Z','2026-01-01T00:00:00+00:00']) expect(Number.isNaN(approvalExpiry(invalid))).toBe(true)
  for (const valid of ['0001-01-01T00:00:00Z','9999-12-31T23:59:59.999Z','2026-01-01T00:00:00.1Z']) expect(Number.isFinite(approvalExpiry(valid))).toBe(true)
  expect(send).not.toHaveBeenCalled()
})
it('rejects mutated commitment or private fields before creating an intention', () => {
  const { manager, send } = setupManager()
  expect(() => manager.request(threadId, approvalId, { action: 'approve', data: { arguments_hash: 'b'.repeat(64) } })).toThrow()
  expect(() => manager.request(threadId, approvalId, { ...request, data: { ...request.data, private_nonce: 'secret' } } as never)).toThrow()
  expect(manager.getSnapshot()).toEqual([]); expect(send).not.toHaveBeenCalled()
})
it('conflict requires canonical replay and never generates another key', async () => {
  const { manager, send, store } = setupManager(vi.fn().mockRejectedValue(new MaestroClientError('INTERACTION_ALREADY_RESPONDED', 'First wins')))
  await expect(manager.request(threadId, approvalId, request)).rejects.toThrow()
  expect(manager.getSnapshot()[0]?.state).toBe('conflict')
  await expect(manager.request(threadId, approvalId, request)).rejects.toThrow(); expect(send).toHaveBeenCalledTimes(1)
  store.receipt(toMaestroEvent(approvalDecision('reject'))); expect(manager.current(threadId, approvalId)?.state).toBe('rejected')
})
it('clear fences a late ACK and cannot resurrect an old receipt', async () => {
  let finish!: (value: ReturnType<typeof response>) => void
  const { manager } = setupManager(vi.fn(() => new Promise(resolve => { finish = resolve })))
  const pending = manager.request(threadId, approvalId, request); await tick(); manager.clear(); finish(response())
  await expect(pending).rejects.toMatchObject({ code: 'FORBIDDEN' }); expect(manager.getSnapshot()).toEqual([])
})
it('opt-in defaults off and emits no approval capability unless selected', async () => {
  const env = make(); dispose.push(() => env.client.dispose()); const socket = await connect(env.client, env.sockets)
  expect(socket.last('connect').payload.client_capabilities).not.toContain('interactions.tool_approval')
  const { client } = await setupClient(vi.fn(), false)
  await expect(client.approvals.request(threadId, approvalId, request)).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' })
})
it('HTTP approval ACK is validated and is consent, never an effect outcome', async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ ...response(), event: approvalDecision(), future: 'compatible' }), { headers: { 'content-type': 'application/json' } }))
  const { client } = await setupClient(fetch)
  await client.approvals.request(threadId, approvalId, request, { transport: 'http' })
  expect(JSON.parse(fetch.mock.calls[0]![1]?.body as string)).toEqual(request)
  expect(client.approvals.current(threadId, approvalId)).toMatchObject({ state: 'approved', effectOutcome: { state: 'unobserved' } })
})
it.each(['actor', 'participant', 'target', 'delivery', 'phase', 'shared', 'sequence'] as const)('rejects mismatched %s ACK without inventing success', async variant => {
  const e = approvalDecision()
  if (variant === 'actor') e.actor.principal_id = 'other'
  if (variant === 'participant') e.actor.participant_id = uuid(999)
  if (variant === 'target') e.payload.interaction_id = uuid(999)
  if (variant === 'delivery') e.payload.delivery_id = uuid(999)
  if (variant === 'phase') e.payload.phase_id = 'initial'
  if (variant === 'shared') e.payload.shared_data.secret = 'private'
  if (variant === 'sequence') e.sequence = '1'
  const { client } = await setupClient(vi.fn(async () => new Response(JSON.stringify({ ...response(), event: e }), { headers: { 'content-type': 'application/json' } })))
  await expect(client.approvals.request(threadId, approvalId, request, { transport: 'http' })).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
  expect(client.approvals.getSnapshot()[0]?.state).toBe('unknown'); expect(client.approvals.current(threadId, approvalId)?.state).toBe('pending')
})
it('revoked capability blocks a saved unknown intention without clearing another agent', async () => {
  const fetch = vi.fn().mockRejectedValue(new TypeError('offline')); const { client } = await setupClient(fetch)
  client.store.receipt(toMaestroEvent(approval(3, uuid(411), uuid(412))))
  await expect(client.approvals.request(threadId, approvalId, request, { transport: 'http' })).rejects.toThrow()
  ;(client as any).setConnection({ ...client.getConnection(), capabilities: [] })
  await expect(client.approvals.retry(threadId, approvalId, { transport: 'http' })).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' })
  expect(fetch).toHaveBeenCalledTimes(1); expect(client.approvals.current(threadId, uuid(411))?.state).toBe('pending')
})
it('removed originating agent blocks its request while another request stays observable', async () => {
  const fetch = vi.fn(); const { client } = await setupClient(fetch)
  const t = approvalThread(); t.version = 2; t.last_sequence = '2'; t.cursor = 'cursor-2'; t.participants[1]!.state = 'removed'; client.store.observeThread(toMaestroThread(t))
  expect(client.canApprove(threadId, approvalId)).toBe(false)
  await expect(client.approvals.request(threadId, approvalId, request, { transport: 'http' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(fetch).not.toHaveBeenCalled(); expect(client.approvals.current(threadId, approvalId)?.state).toBe('pending')
})
it('a revoked retry preserves the immutable unknown key when capability later returns', async () => {
  const fetch = vi.fn().mockRejectedValueOnce(new TypeError('lost ACK')).mockResolvedValueOnce(new Response(JSON.stringify({ ...response(), event: approvalDecision() }), { headers: { 'content-type': 'application/json' } }))
  const { client } = await setupClient(fetch)
  await expect(client.approvals.request(threadId, approvalId, request, { transport: 'http' })).rejects.toThrow()
  const intent = client.approvals.getSnapshot()[0]!.intent
  const connection = client.getConnection()
  ;(client as any).setConnection({ ...connection, capabilities: [] })
  await expect(client.approvals.retry(threadId, approvalId)).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' })
  expect(client.approvals.getSnapshot()[0]).toMatchObject({ state: 'unknown', intent })
  ;(client as any).setConnection(connection)
  await client.approvals.retry(threadId, approvalId, { transport: 'http' })
  expect(new Headers(fetch.mock.calls[1]![1]?.headers).get('Idempotency-Key')).toBe(intent.idempotencyKey)
})
it('delivery responded never masquerades as the specific effect receipt', () => {
  const { manager, store, send } = setupManager()
  store.receipt(toMaestroEvent(approvalDecision()))
  const delivery = event(3, 'delivery.updated')
  delivery.payload.delivery.delivery_id = uuid(404); delivery.payload.delivery.phase_id = approvalId; delivery.payload.delivery.state = 'responded'
  store.receipt(toMaestroEvent(delivery))
  expect(manager.current(threadId, approvalId)).toMatchObject({ state: 'approved', resuming: false, effectOutcome: { state: 'unobserved' } })
  expect(send).not.toHaveBeenCalled()
})
it.each(['delivery', 'phase', 'shared', 'actor'] as const)('invalid replay %s cannot become consent', variant => {
  const { manager, store, send } = setupManager(); const e = approvalDecision()
  if (variant === 'delivery') e.payload.delivery_id = uuid(999)
  if (variant === 'phase') e.payload.phase_id = 'initial'
  if (variant === 'shared') e.payload.shared_data.secret = 'private'
  if (variant === 'actor') e.actor.participant_id = uuid(999)
  store.receipt(toMaestroEvent(e))
  expect(manager.current(threadId, approvalId)).toMatchObject({ state: 'pending', decision: null })
  expect(send).not.toHaveBeenCalled()
})
it('confirmation after a late ACL change remains unknown because the decision may have committed', async () => {
  const authorize = vi.fn().mockImplementationOnce(() => {}).mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw new MaestroClientError('FORBIDDEN', 'Revoked after commit') })
  const { manager } = setupManager(undefined, authorize)
  await expect(manager.request(threadId, approvalId, request)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(manager.getSnapshot()[0]?.state).toBe('unknown')
})
it.each(['http', 'websocket'] as const)('request-scoped FORBIDDEN over %s preserves the authenticated conversation and other agent', async transport => {
  const denied = { code: 'FORBIDDEN', message: 'This request is no longer eligible', retryable: false, request_id: uuid(900) }
  const fetch = vi.fn(async () => new Response(JSON.stringify({ error: denied }), { status: 403, headers: { 'content-type': 'application/json' } }))
  const { client, socket } = await setupClient(fetch)
  client.store.receipt(toMaestroEvent(approval(3, uuid(411), uuid(412))))
  const deciding = client.approvals.request(threadId, approvalId, request, { transport })
  const observed = expect(deciding).rejects.toMatchObject({ code: 'FORBIDDEN' })
  if (transport === 'websocket') { await tick(); socket.receive({ id: socket.last('interaction.respond').id, type: 'error', payload: { code: denied.code, message: denied.message, retryable: false, request_id: denied.request_id } }) }
  await observed
  expect(client.getConnection().status).toBe('connected')
  expect(client.approvals.current(threadId, uuid(411))?.state).toBe('pending')
  expect(client.approvals.getSnapshot()[0]?.state).toBe('rejected')
})
it('scope-wide UNAUTHENTICATED still clears approval intents and disconnects', async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: 'Session expired', retryable: false, request_id: uuid(900) } }), { status: 401, headers: { 'content-type': 'application/json' } }))
  const { client } = await setupClient(fetch)
  await expect(client.approvals.request(threadId, approvalId, request, { transport: 'http' })).rejects.toMatchObject({ code: 'UNAUTHENTICATED' })
  expect(client.getConnection().status).toBe('unauthenticated'); expect(client.approvals.getSnapshot()).toEqual([])
})
it('wrong-correlated and unsolicited WS request errors cannot settle an approval or clear other state', async () => {
  const { client, socket } = await setupClient(vi.fn())
  const pending = client.approvals.request(threadId, approvalId, request, { transport: 'websocket' }); await tick()
  const command = socket.last('interaction.respond')
  socket.receive({ id: uuid(999), type: 'error', payload: { code: 'FORBIDDEN', message: 'Unrelated', retryable: false, request_id: uuid(900) } })
  expect(client.approvals.getSnapshot()[0]?.state).toBe('pending'); expect(client.getConnection().status).toBe('connected')
  socket.receive({ id: command.id, type: 'ack', payload: { ...response(), event: approvalDecision() } })
  await pending; expect(client.approvals.current(threadId, approvalId)?.state).toBe('approved')
})
it('real client retry after terminal replay retains the original HTTP intent and confirms via WS', async () => {
  const { client, socket } = await setupClient(vi.fn().mockRejectedValueOnce(new TypeError('lost ACK')))
  await expect(client.approvals.request(threadId, approvalId, request, { transport: 'http' })).rejects.toThrow()
  const intent = client.approvals.getSnapshot()[0]!.intent
  client.store.receipt(toMaestroEvent(approvalDecision()))
  const retry = client.approvals.retry(threadId, approvalId, { transport: 'websocket' }); await tick()
  const command = socket.last('interaction.respond')
  expect(command.payload).toEqual({ interaction_id: approvalId, idempotency_key: intent.idempotencyKey, ...request })
  socket.receive({ id: command.id, type: 'ack', payload: { ...response(), event: approvalDecision(), duplicate: true } })
  await retry; expect(client.approvals.getSnapshot()[0]?.state).toBe('persisted')
})
it('ACL changes while an HTTP ACK is in flight preserve unknown and never ingest the late receipt', async () => {
  let finish!: (response: Response) => void
  const { client } = await setupClient(vi.fn(() => new Promise<Response>(resolve => { finish = resolve })))
  const pending = client.approvals.request(threadId, approvalId, request, { transport: 'http' }); const rejected = expect(pending).rejects.toMatchObject({ code: 'FORBIDDEN' }); await tick()
  const t = approvalThread(); t.last_sequence = '2'; t.cursor = 'cursor-2'; t.permissions.write = false
  client.store.observeThread(toMaestroThread(t))
  finish(new Response(JSON.stringify({ ...response(), event: approvalDecision() }), { headers: { 'content-type': 'application/json' } }))
  await rejected
  expect(client.approvals.getSnapshot()[0]?.state).toBe('unknown'); expect(client.approvals.current(threadId, approvalId)?.state).toBe('pending')
  expect(client.getConnection().status).toBe('connected')
})
it('unsolicited session expiry still clears all scope-bound intents', async () => {
  const { client, socket } = await setupClient(vi.fn().mockRejectedValueOnce(new TypeError('lost ACK')))
  await expect(client.approvals.request(threadId, approvalId, request, { transport: 'http' })).rejects.toThrow()
  socket.receive({ type: 'session.expired', payload: { expires_at: new Date().toISOString(), reason_code: 'expired' } })
  expect(client.getConnection().status).toBe('unauthenticated'); expect(client.approvals.getSnapshot()).toEqual([])
})
it.each(['reject', 'cancel'] as const)('%s has empty data and its ACK is never a successful effect', async action => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ ...response(), event: approvalDecision(action) }), { headers: { 'content-type': 'application/json' } }))
  const { client } = await setupClient(fetch)
  await client.approvals.request(threadId, approvalId, { action, data: {} }, { transport: 'http' })
  expect(JSON.parse(fetch.mock.calls[0]![1]?.body as string)).toEqual({ action, data: {} })
  expect(client.approvals.current(threadId, approvalId)).toMatchObject({ state: action === 'reject' ? 'rejected' : 'canceled', effectOutcome: { state: 'unobserved' } })
})
it('a new intention rechecks expiry at the send boundary while unknown confirmation stays distinct', async () => {
  const fetch = vi.fn(); const { client } = await setupClient(fetch)
  const value = approval(3, uuid(450)); value.payload.interaction.definition.expires_at = new Date(Date.now() + 500).toISOString()
  client.store.receipt(toMaestroEvent(value))
  const sent = vi.spyOn(Date, 'now')
  const initial = Date.now(); sent.mockReturnValueOnce(initial).mockReturnValueOnce(initial).mockReturnValue(initial + 1000)
  const pending = client.approvals.request(threadId, uuid(450), request, { transport: 'http' })
  await expect(pending).rejects.toMatchObject({ code: 'INTERACTION_EXPIRED' })
  expect(fetch).not.toHaveBeenCalled(); expect(client.approvals.getSnapshot()[0]?.state).toBe('rejected')
  sent.mockRestore()
})
it('HTTP 401 remains a session boundary even if its error code is FORBIDDEN', async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ error: { code: 'FORBIDDEN', message: 'Session denied', retryable: false, request_id: uuid(900) } }), { status: 401, headers: { 'content-type': 'application/json' } }))
  const { client } = await setupClient(fetch)
  await expect(client.approvals.request(threadId, approvalId, request, { transport: 'http' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(client.getConnection().status).toBe('unauthenticated'); expect(client.approvals.getSnapshot()).toEqual([])
})
it('originating-agent capability loss disables that request while a different capable agent stays actionable', async () => {
  const fetch = vi.fn(); const { client } = await setupClient(fetch)
  const t = approvalThread(); t.last_sequence = '3'; t.cursor = 'cursor-3'
  t.participants[1]!.capabilities = []
  t.participants.push({ ...t.participants[1]!, participant_id: uuid(412), principal_id: uuid(417), instance_agent_id: uuid(418), capabilities: ['interactions.tool_approval'] })
  client.store.observeThread(toMaestroThread(t))
  client.store.receipt(toMaestroEvent(approval(3, uuid(411), uuid(412))))
  expect(client.canApprove(threadId, approvalId)).toBe(false); expect(client.canApprove(threadId, uuid(411))).toBe(true)
  await expect(client.approvals.request(threadId, approvalId, request, { transport: 'http' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(fetch).not.toHaveBeenCalled(); expect(client.getConnection().status).toBe('connected')
})
const authoritativeOutcome = (status = 'succeeded', revision: string | null = '1') => ({ format_version: 'maestro.tool-approval-outcome.local.v1', interaction_id: approvalId, delivery_id: uuid(404), agent_participant_id: uuid(402), decision_event_id: uuid(2), arguments_hash: publicCommitment, status, revision })
it('explicit candidate outcome GET uses the root route and proves a separate correlated result', async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify(authoritativeOutcome()), { headers: { 'content-type': 'application/json' } }))
  const { client } = await setupClient(fetch); client.store.receipt(toMaestroEvent(approvalDecision()))
  expect(client.approvals.current(threadId, approvalId)?.effectOutcome.state).toBe('unobserved')
  await client.approvalOutcomes.refresh(threadId, approvalId)
  expect(fetch.mock.calls[0]![0]).toBe(`https://maestro.example/candidate/tool-approvals/threads/${threadId}/interactions/${approvalId}/outcome`)
  expect(fetch.mock.calls[0]![1]).toMatchObject({method:'GET',credentials:'omit',cache:'no-store'})
  expect(fetch.mock.calls[0]![1]?.body).toBeUndefined()
  expect(client.approvals.current(threadId, approvalId)?.effectOutcome).toMatchObject({state:'succeeded',revision:'1',decisionEventId:uuid(2)})
})
it('outcome read permits current read-only archived member after the old approver and agent were removed', async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify(authoritativeOutcome()), { headers: { 'content-type': 'application/json' } }))
  const { client } = await setupClient(fetch);client.store.receipt(toMaestroEvent(approvalDecision()))
  const t=approvalThread();t.last_sequence='3';t.cursor='cursor-3';t.state='archived';t.permissions.write=false
  t.participants[0]!.state='removed';t.participants[1]!.state='removed'
  t.participants.push({...t.participants[0]!,participant_id:uuid(900),state:'active'})
  client.store.observeThread(toMaestroThread(t))
  expect(client.canApprove(threadId,approvalId)).toBe(false)
  await client.approvalOutcomes.refresh(threadId,approvalId)
  expect(client.approvals.current(threadId,approvalId)?.effectOutcome.state).toBe('succeeded')
})
it('outcome transport failure does not become unobserved success or remove another agent', async () => {
  const {client}=await setupClient(vi.fn().mockRejectedValue(new TypeError('journal unavailable')))
  client.store.receipt(toMaestroEvent(approvalDecision()));client.store.receipt(toMaestroEvent(approval(3,uuid(411),uuid(412))))
  await expect(client.approvalOutcomes.refresh(threadId,approvalId)).rejects.toMatchObject({code:'NETWORK_ERROR'})
  expect(client.approvalOutcomes.getSnapshot()[0]).toMatchObject({state:'error',errorCode:'NETWORK_ERROR'})
  expect(client.approvals.current(threadId,approvalId)?.effectOutcome.state).toBe('unobserved')
  expect(client.approvals.current(threadId,uuid(411))?.state).toBe('pending');expect(client.getConnection().status).toBe('connected')
})
it('outcome delivered before local replay reconciles only after the corresponding canonical approve', async () => {
  const fetch=vi.fn(async()=>new Response(JSON.stringify(authoritativeOutcome()),{headers:{'content-type':'application/json'}}))
  const {client}=await setupClient(fetch);await client.approvalOutcomes.refresh(threadId,approvalId)
  expect(client.approvals.current(threadId,approvalId)).toMatchObject({state:'pending',effectOutcome:{state:'unobserved'}})
  client.store.receipt(toMaestroEvent(approvalDecision()))
  expect(client.approvals.current(threadId,approvalId)).toMatchObject({state:'approved',effectOutcome:{state:'succeeded'}})
  expect(fetch).toHaveBeenCalledTimes(1)
})
