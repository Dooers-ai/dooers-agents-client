// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { MaestroClientProvider, useMaestroApproval, useMaestroApprovals } from '../src/maestro/provider'
import { toMaestroEvent } from '../src/protocol/maestro/contracts'
import { approval, approvalDecision, approvalId, approvalThread } from './fixtures/maestro-approval'
import { make, threadId, tick, uuid } from './fixtures/maestro-replay'
const clear: (() => void)[] = []
afterEach(() => { cleanup(); clear.splice(0).forEach(close => close()); vi.useRealTimers() })
async function setup(fetch: typeof globalThis.fetch, expiry?: string) {
  const { client, sockets } = make({ fetch, toolApprovals: true }); clear.push(() => client.dispose())
  const connected = client.connect(); await tick(); const socket = sockets[0]!; socket.open(); await tick()
  socket.receive({ id: socket.last('connect').id, type: 'ack', payload: { status: 'connected', connection_id: uuid(100), server_version: '0.0.0', protocol_version: 1, history_authority: 'maestro', capabilities: ['messages.text', 'threads.shared', 'history.replay', 'interactions.tool_approval'], expires_at: new Date(Date.now() + 60000).toISOString() } }); await connected
  const wrapper = ({ children }: { children: ReactNode }) => <MaestroClientProvider client={client}>{children}</MaestroClientProvider>
  const a = renderHook(() => useMaestroApproval(threadId, approvalId), { wrapper }), b = renderHook(() => useMaestroApproval(threadId, approvalId), { wrapper }), list = renderHook(() => useMaestroApprovals(threadId), { wrapper })
  await act(async () => { await tick(); socket.ackSubscribe(uuid(101), '1'); const value = approval(); if (expiry) value.payload.interaction.definition.expires_at = expiry; socket.frame('thread.snapshot', { thread: approvalThread(), events: [value], watermark: '1', next_cursor: null, has_more: false }); socket.caught('1'); await tick() })
  return { client, socket, a, b, list }
}
it('multiple hooks share one subscription; replay approval remains separate from execution outcome', async () => {
  const fetch = vi.fn(); const { client, socket, a, b, list } = await setup(fetch)
  expect(socket.sent.filter(frame => frame.type === 'thread.subscribe')).toHaveLength(1)
  expect(a.result.current.canRespond).toBe(true); expect(list.result.current).toHaveLength(1)
  await act(async () => { client.store.receipt(toMaestroEvent(approvalDecision())); await tick() })
  expect(a.result.current.current?.state).toBe('approved'); expect(b.result.current.current?.effectOutcome.state).toBe('unobserved')
  expect(a.result.current.canRespond).toBe(false); expect(fetch).not.toHaveBeenCalled()
})
it('lost ACK is shared unknown and retry uses the same command key without reconnect auto-approve', async () => {
  const fetch = vi.fn().mockRejectedValueOnce(new TypeError('lost ACK')).mockResolvedValueOnce(new Response(JSON.stringify({ status: 'persisted', duplicate: true, cursor: 'cursor-2', event: approvalDecision() }), { headers: { 'content-type': 'application/json' } }))
  const { a, b } = await setup(fetch)
  await act(async () => { await expect(a.result.current.approve({ transport: 'http' })).rejects.toThrow() })
  expect(b.result.current.receipt?.state).toBe('unknown'); expect(a.result.current.current?.state).toBe('pending')
  await act(async () => { await b.result.current.retry({ transport: 'http' }) })
  expect(new Headers(fetch.mock.calls[0]![1].headers).get('Idempotency-Key')).toBe(new Headers(fetch.mock.calls[1]![1].headers).get('Idempotency-Key'))
  expect(a.result.current.current?.state).toBe('approved'); expect(a.result.current.current?.effectOutcome.state).toBe('unobserved')
})
it('closeThread removes receipt intent and disables mounted approval controls', async () => {
  const { client, a } = await setup(vi.fn().mockRejectedValue(new TypeError('offline')))
  await act(async () => { await expect(a.result.current.reject({ transport: 'http' })).rejects.toThrow() })
  expect(a.result.current.receipt?.state).toBe('unknown')
  await act(async () => { client.closeThread(threadId); await tick() })
  expect(a.result.current.current).toBeNull(); expect(a.result.current.canRespond).toBe(false); expect(a.result.current.receipt).toBeUndefined()
})
it('expiry timer disables an idle mounted control without publishing or polling', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  const fetch = vi.fn(); const { a } = await setup(fetch, new Date(Date.now() + 500).toISOString())
  expect(a.result.current.canRespond).toBe(true)
  await act(async () => { vi.advanceTimersByTime(501); await tick() })
  expect(a.result.current.canRespond).toBe(false); expect(fetch).not.toHaveBeenCalled()
})
it('canonical subscription revocation purges only its thread and blocks all mounted decisions', async () => {
  const { client, socket, a } = await setup(vi.fn().mockRejectedValue(new TypeError('offline')))
  client.store.patch(uuid(700), { phase: 'idle' })
  await act(async () => { await expect(a.result.current.approve({ transport: 'http' })).rejects.toThrow() })
  await act(async () => { socket.frame('subscription.revoked', { reason_code: 'membership_removed' }); await tick() })
  expect(a.result.current.canRespond).toBe(false); expect(a.result.current.receipt).toBeUndefined()
  expect(client.store.getThread(threadId)?.phase).toBe('revoked'); expect(client.store.getThread(uuid(700))?.phase).toBe('idle')
  expect(client.getConnection().status).toBe('connected')
})
it('explicit outcome refresh updates individual and list hooks without another consent', async () => {
  const fetch=vi.fn(async()=>new Response(JSON.stringify({format_version:'maestro.tool-approval-outcome.local.v1',interaction_id:approvalId,delivery_id:uuid(404),agent_participant_id:uuid(402),decision_event_id:uuid(2),arguments_hash:'a'.repeat(64),status:'succeeded',revision:'1'}),{headers:{'content-type':'application/json'}}))
  const {client,a,b,list,socket}=await setup(fetch)
  await act(async()=>{client.store.receipt(toMaestroEvent(approvalDecision()));await tick()})
  expect(a.result.current.current?.effectOutcome.state).toBe('unobserved')
  await act(async()=>{await a.result.current.refreshOutcome();await tick()})
  expect(a.result.current.current?.effectOutcome.state).toBe('succeeded');expect(b.result.current.current?.effectOutcome.state).toBe('succeeded')
  expect(list.result.current[0]?.effectOutcome.state).toBe('succeeded')
  expect(fetch).toHaveBeenCalledTimes(1);expect(socket.sent.some(frame=>frame.type==='interaction.respond')).toBe(false)
})
it('last mounted outcome consumer aborts the GET and discards its late body', async () => {
  let finish!:(response:Response)=>void;let signal!:AbortSignal
  const fetch=vi.fn((_input:Parameters<typeof globalThis.fetch>[0],init?:RequestInit)=>{signal=init!.signal!;return new Promise<Response>(resolve=>{finish=resolve})})
  const {client,a,b}=await setup(fetch)
  let pending!:Promise<unknown>
  await act(async()=>{pending=a.result.current.refreshOutcome().catch(error=>error);await tick()})
  a.unmount();expect(signal.aborted).toBe(false);b.unmount();expect(signal.aborted).toBe(true)
  const cancel=vi.fn()
  await act(async()=>{finish(new Response(new ReadableStream({cancel}),{headers:{'content-type':'application/json'}}));await pending;await tick()})
  expect(cancel).toHaveBeenCalledTimes(1);expect(client.approvalOutcomes.getSnapshot()).toEqual([])
})
