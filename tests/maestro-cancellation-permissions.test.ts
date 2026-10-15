import { afterEach, expect, it, vi } from 'vitest'
import type { MaestroClient } from '../src/maestro/client'
import { event, make, thread, threadId, tick, uuid } from './fixtures/maestro-replay'
const clients: MaestroClient[] = []
afterEach(() => { for (const client of clients) client.dispose(); clients.length = 0; vi.useRealTimers() })
const json = (sequence: string, cancel: boolean) => {
  const value = thread(sequence); value.permissions.cancel = cancel
  return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
}
async function setup(fetcher: typeof fetch) {
  const env = make({ fetch: fetcher }); clients.push(env.client)
  const release = env.client.retainThread(threadId)
  const connecting = env.client.connect(); await tick()
  const socket = env.sockets.at(-1)!; socket.open(); await tick()
  socket.receive({ id: socket.last('connect').id, type: 'ack', payload: {
    status: 'connected', connection_id: uuid(100), server_version: '0.0.0', protocol_version: 1,
    history_authority: 'maestro', capabilities: ['threads.shared', 'history.replay', 'executions.cancel'],
    expires_at: new Date(Date.now() + 300000).toISOString(),
  } })
  await connecting; socket.ackSubscribe(); await tick()
  const empty = thread('0'); empty.permissions.cancel = false
  socket.frame('thread.snapshot', { thread: empty, events: [], watermark: '0', next_cursor: null, has_more: false })
  socket.caught('0'); await tick()
  return { ...env, socket, release }
}
it('empty snapshot stays false, then first canonical target refreshes real permissions once', async () => {
  const fetcher = vi.fn(async () => json('1', true))
  const { client, socket } = await setup(fetcher)
  expect(client.store.getThread(threadId)?.thread?.permissions.cancel).toBe(false)
  expect(fetcher).not.toHaveBeenCalled()
  socket.frame('event.append', { event: event(1), cursor: 'one' }); await tick()
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(client.store.getThread(threadId)?.thread?.permissions.cancel).toBe(true)
  socket.frame('event.append', { event: event(1), cursor: 'one' }); await tick()
  expect(fetcher).toHaveBeenCalledTimes(1)
})
it('coalesces a burst and one dirty follow-up; stale permission is not restored while newer targets wait', async () => {
  const pending: ((value: Response) => void)[] = []
  const fetcher = vi.fn(() => new Promise<Response>(resolve => pending.push(resolve)))
  const { client, socket } = await setup(fetcher)
  for (let n = 1; n <= 5; n++) socket.frame('event.append', { event: event(n), cursor: `cursor-${n}` })
  await tick(); expect(fetcher).toHaveBeenCalledTimes(1)
  for (let n = 6; n <= 10; n++) socket.frame('event.append', { event: event(n), cursor: `cursor-${n}` })
  pending[0]!(json('5', true)); await tick()
  expect(client.store.getThread(threadId)?.thread?.permissions.cancel).toBe(false)
  expect(fetcher).toHaveBeenCalledTimes(2)
  pending[1]!(json('10', true)); await tick()
  expect(client.store.getThread(threadId)?.thread?.permissions.cancel).toBe(true)
  await tick(); expect(fetcher).toHaveBeenCalledTimes(2)
})
it('release fences a pending permission response and does not start a dirty follow-up', async () => {
  let complete!: (value: Response) => void
  const fetcher = vi.fn(() => new Promise<Response>(resolve => { complete = resolve }))
  const { client, socket, release } = await setup(fetcher)
  socket.frame('event.append', { event: event(1), cursor: 'one' }); await tick()
  socket.frame('event.append', { event: event(2), cursor: 'two' })
  release(); complete(json('2', true)); await tick()
  expect(client.store.getThread(threadId)?.thread?.permissions.cancel).toBe(false)
  expect(fetcher).toHaveBeenCalledTimes(1)
})
it('transient read failure stays fail-closed without a polling loop', async () => {
  const fetcher = vi.fn(async () => { throw new TypeError('offline') })
    .mockResolvedValueOnce(json('1', true))
  const { client, socket } = await setup(fetcher)
  socket.frame('event.append', { event: event(1), cursor: 'one' }); await tick()
  expect(client.store.getThread(threadId)?.thread?.permissions.cancel).toBe(true)
  const before = client.store.getThread(threadId)!.thread!
  socket.frame('event.append', { event: event(2), cursor: 'two' })
  expect(client.store.getThread(threadId)?.thread?.permissions.cancel).toBe(false)
  expect(client.store.getThread(threadId)?.thread?.permissions).toEqual({ ...before.permissions, cancel: false })
  expect(client.store.getThread(threadId)?.thread?.capabilities).toEqual(before.capabilities)
  expect(client.store.getThread(threadId)?.eventIds).toHaveLength(2)
  await tick(); await tick(); expect(fetcher).toHaveBeenCalledTimes(2)
})
it('canonical lifecycle update can refresh permissions at the same sequence', async () => {
  const fetcher = vi.fn(async () => json('1', true))
  const { client, socket } = await setup(fetcher)
  const updated = event(1, 'thread.updated'); updated.payload.state = 'active'
  updated.payload.version = thread('1').version
  socket.frame('event.append', { event: updated, cursor: 'one' }); await tick()
  expect(client.store.getThread(threadId)?.thread?.permissions.cancel).toBe(true)
})

it('recovery replaces a pending permission flight and an old response cannot strand the new generation', async () => {
  vi.useFakeTimers()
  const pending: ((value: Response) => void)[] = []
  const fetcher = vi.fn(() => new Promise<Response>(resolve => pending.push(resolve)))
  const { client, socket } = await setup(fetcher)
  socket.frame('event.append', { event: event(1), cursor: 'one' }); await tick()
  expect(fetcher).toHaveBeenCalledTimes(1)
  socket.frame('resync.required', { reason_code: 'sequence_gap', action: 'replay' })
  await vi.advanceTimersByTimeAsync(11)
  socket.ackSubscribe(uuid(102), '2')
  socket.frame('thread.replay', { events: [event(2)], watermark: '2', next_cursor: null, has_more: false }, uuid(102))
  socket.caught('2', uuid(102)); await tick()
  expect(fetcher).toHaveBeenCalledTimes(2)
  pending[0]!(json('1', true)); await tick()
  expect(client.store.getThread(threadId)?.thread?.permissions.cancel).toBe(false)
  pending[1]!(json('2', true)); await tick()
  expect(client.store.getThread(threadId)?.thread?.permissions.cancel).toBe(true)
  expect(fetcher).toHaveBeenCalledTimes(2)
})
it('disconnect and reconnect start a new permission flight without waiting for old HTTP', async () => {
  const pending: ((value: Response) => void)[] = []
  const fetcher = vi.fn(() => new Promise<Response>(resolve => pending.push(resolve)))
  const { client, socket, sockets } = await setup(fetcher)
  socket.frame('event.append', { event: event(1), cursor: 'one' }); await tick()
  socket.drop()
  const connecting = client.connect(); await tick()
  const next = sockets.at(-1)!; next.open(); await tick()
  next.receive({ id: next.last('connect').id, type: 'ack', payload: {
    status: 'connected', connection_id: uuid(103), server_version: '0.0.0', protocol_version: 1,
    history_authority: 'maestro', capabilities: ['threads.shared', 'history.replay', 'executions.cancel'],
    expires_at: new Date(Date.now() + 300000).toISOString(),
  } })
  await connecting; next.ackSubscribe(uuid(102), '2')
  next.frame('thread.replay', { events: [event(2)], watermark: '2', next_cursor: null, has_more: false }, uuid(102))
  next.caught('2', uuid(102)); await tick()
  expect(fetcher).toHaveBeenCalledTimes(2)
  pending[0]!(json('1', true)); await tick()
  expect(client.store.getThread(threadId)?.thread?.permissions.cancel).toBe(false)
  pending[1]!(json('2', true)); await tick()
  expect(client.store.getThread(threadId)?.thread?.permissions.cancel).toBe(true)
})
