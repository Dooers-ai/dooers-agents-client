import { credential } from './fixtures/maestro-credential'
import { afterEach, expect, it, vi } from 'vitest'
import { MaestroClient } from '../src/maestro/client'
import type { MaestroClientConfig, MaestroSocket } from '../src/maestro/types'
import fixtures from '../vendor/maestro-v1/contracts/fixtures/v1/public.json'
const fixture = (schema: string): any => structuredClone(fixtures.cases.find(c => c.schema === schema && c.valid)!.data)
const id = '00000000-0000-4000-8000-000000000011'
const otherId = '00000000-0000-4000-8000-000000000012'
const thread = fixture('Public.Event.message.created').thread_id
const org = '00000000-0000-4000-8000-000000000001'
const principal = fixture('Public.Event.message.created').actor.principal_id
const scope = { principalId: principal, organizationId: org, workspaceId: null }
const caps = ['messages.text', 'threads.shared', 'history.replay', 'executions.cancel']
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
afterEach(() => { for (const client of clients) client.dispose(); clients.length = 0; sockets.length = 0; vi.useRealTimers(); vi.restoreAllMocks() })


import { toMaestroEvent, toMaestroThread } from '../src/protocol/maestro/contracts'
import { MaestroControls } from '../src/maestro/controls'
const cancel = { threadId: thread, executionId: id }
const root = { threadId: thread, rootEventId: otherId }
const state = (client: MaestroClient) => client.controls.getSnapshot()[0]!
const ack = (socket: Socket, status = 'cancel_requested', target = id) => socket.receive({id:socket.last().id,type:'ack',payload:status === 'cancel_requested' ? {status,execution_id:target} : {status,root_event_id:target}})
function terminal(client: MaestroClient, executionId = id, status = 'canceled') {
  const t = fixture('Public.Thread'); t.thread_id=thread; t.last_sequence='0'; client.store.observeThread(toMaestroThread(t))
  const event = fixture('Public.Event.execution.' + (status === 'completed' ? 'completed' : 'canceled'))
  event.thread_id=thread; event.sequence="1"; event.payload.execution_id=executionId
  client.store.append(thread,{known:true,event:toMaestroEvent(event)},"cursor-1")
}
it('double click shares one command/key and ACK is requested, never canceled',async()=>{
 const {client,socket}=await connected();const a=client.cancelExecution(cancel),b=client.cancelExecution(cancel)
 expect(a).toBe(b);await tick();expect(socket.sent.filter(x=>x.type==='execution.cancel')).toHaveLength(1)
 const key=socket.last().payload.idempotency_key;ack(socket);await a
 expect(state(client)).toMatchObject({state:'requested',intent:{idempotencyKey:key}});expect(state(client).outcome).toBeUndefined()
 await client.cancelExecution(cancel);expect(socket.sent.filter(x=>x.type==='execution.cancel')).toHaveLength(1)
 terminal(client);expect(state(client)).toMatchObject({state:'observed',outcome:'canceled'})
})
it('lost WebSocket ACK retries via HTTP with exact same target/key/body',async()=>{
 vi.useFakeTimers();const fetcher=vi.fn(async()=>json({status:'cancel_requested',execution_id:id},202))
 const {client,socket}=await connected(make({requestTimeoutMs:100,fetch:fetcher}));const first=client.cancelExecution({...cancel,reasonCode:'user_requested'}).catch(x=>x)
 await tick();const payload=socket.last().payload;await vi.advanceTimersByTimeAsync(101);expect((await first).code).toBe('TIMEOUT');expect(state(client).state).toBe('unknown')
 await client.cancelExecution({...cancel,reasonCode:'user_requested'},{transport:'http'})
 expect(fetcher.mock.calls[0]![0]).toBe(`https://maestro.example/api/v1/executions/${id}/cancel`)
 expect(fetcher.mock.calls[0]![1]).toMatchObject({headers:{'Idempotency-Key':payload.idempotency_key},body:JSON.stringify({reason_code:'user_requested'}),credentials:'omit'})
 expect(state(client).state).toBe('requested')
})
it('terminal before ACK/lost ACK preserves canonical completed result without pretending cancellation',async()=>{
 vi.useFakeTimers();const {client,socket}=await connected(make({requestTimeoutMs:100}));const pending=client.cancelExecution(cancel).catch(x=>x)
 await tick();terminal(client,id,'completed');await vi.advanceTimersByTimeAsync(101);await pending
 expect(state(client)).toMatchObject({state:'observed',outcome:'completed'});expect(socket.sent.filter(x=>x.type==='root.stop')).toHaveLength(0)
})
it('canceling A leaves B running; root stop requires its own canonical event',async()=>{
 const {client,socket}=await connected();const a=client.cancelExecution(cancel);await tick();ack(socket);await a
 const b=client.cancelExecution({...cancel,executionId:otherId});await tick();ack(socket,'cancel_requested',otherId);await b
 terminal(client);expect(client.controls.getSnapshot().map(x=>x.state)).toEqual(['observed','requested'])
 const stop=client.stopRoot(root);await tick();expect(socket.last().payload.thread_id).toBe(thread);ack(socket,'stop_requested',otherId);await stop
 const e=fixture('Public.Event.root.stopped');e.thread_id=thread;e.sequence='2';e.event_id=crypto.randomUUID();e.payload.root_event_id=otherId;client.store.append(thread,{known:true,event:toMaestroEvent(e)},'cursor-2')
 expect(client.controls.getSnapshot()[2]).toMatchObject({state:'observed',outcome:'stopped'})
 const fresh=client.stopRoot({...root,rootEventId:id});await tick();expect(socket.last().payload.root_event_id).toBe(id);ack(socket,'stop_requested',id);await fresh
 expect(client.controls.getSnapshot()[3]!.state).toBe('requested')
})
it('ACK target mismatch never confirms and retries retain the original identity',async()=>{
 const {client,socket}=await connected();const a=client.cancelExecution(cancel);await tick();ack(socket,'cancel_requested',otherId)
 await expect(a).rejects.toMatchObject({code:'PROTOCOL_ERROR'});expect(state(client).state).toBe('unknown')
 await expect(client.cancelExecution({...cancel,reasonCode:'changed'})).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'})
})
it('capability absent blocks controls before network',async()=>{
 const {client,socket}=await connected(make(),[]);await expect(client.cancelExecution(cancel)).rejects.toMatchObject({code:'UNSUPPORTED_CAPABILITY'})
 expect(socket.sent).toHaveLength(1);expect(state(client).state).toBe('rejected')
})
it('confirmation wait is bounded and disconnect clears timers without sending any control',async()=>{
 vi.useFakeTimers();const {client,socket}=await connected(make({heartbeatMs:120000}));const a=client.cancelExecution(cancel);await tick();ack(socket);await a
 await vi.advanceTimersByTimeAsync(30001);expect(state(client).state).toBe('unconfirmed')
 const before=socket.sent.length;client.disconnect();await vi.advanceTimersByTimeAsync(120000);expect(socket.sent).toHaveLength(before)
 expect(vi.getTimerCount()).toBe(0)
})
it('reset/revocation and queued old request cannot resurrect private receipts',async()=>{
 const {client,socket}=await connected();const pending=client.cancelExecution(cancel);client.reset()
 await expect(pending).rejects.toMatchObject({code:'DISCONNECTED'});expect(client.controls.getSnapshot()).toEqual([]);expect(socket.sent.filter(x=>x.type==='execution.cancel')).toHaveLength(0)
})
it('thread access loss fences a delayed ACK',async()=>{
 const {client,socket}=await connected();const pending=client.cancelExecution(cancel);await tick();client.forgetThread(thread);ack(socket)
 await expect(pending).rejects.toMatchObject({code:'FORBIDDEN'});expect(client.controls.getSnapshot()).toEqual([])
})
it('bounds private receipts and validates UUIDs/reasons before any I/O',async()=>{
 const controls=new MaestroControls(async()=>{},()=>({scope,threads:{}}),1)
 controls.prepare({type:'execution.cancel',...cancel})
 expect(()=>controls.prepare({type:'root.stop',...root})).toThrow('limit')
 expect(()=>controls.prepare({type:'execution.cancel',...cancel,executionId:'bad'})).toThrow()
 controls.clear();expect(controls.getSnapshot()).toEqual([])
})
it('already terminal before request remains its canonical result after ACK',async()=>{
 const {client,socket}=await connected();terminal(client,id,'completed')
 const pending=client.cancelExecution(cancel);await tick();ack(socket);await pending
 expect(state(client)).toMatchObject({state:'observed',outcome:'completed'})
})
it('rejects malformed root target ACK and accepts exact HTTP root response',async()=>{
 const fetcher=vi.fn(async()=>json({status:'stop_requested',root_event_id:otherId}))
 const {client,socket}=await connected(make({fetch:fetcher}));const a=client.stopRoot(root);await tick();ack(socket,'stop_requested',id)
 await expect(a).rejects.toMatchObject({code:'PROTOCOL_ERROR'})
 await client.stopRoot(root,{transport:'http'})
 expect(fetcher.mock.calls[0]![0]).toBe(`https://maestro.example/api/v1/threads/${thread}/roots/${otherId}/stop`)
 expect(state(client).state).toBe('requested')
})

it('transport loss fences a queued control before dispatch and keeps its key for explicit retry',async()=>{
 const send=vi.fn(async()=>{})
 const controls=new MaestroControls(send,()=>({scope,threads:{}}))
 const pending=controls.request({type:'execution.cancel',...cancel})
 const key=controls.getSnapshot()[0]!.intent.idempotencyKey
 controls.disconnected()
 await expect(pending).rejects.toMatchObject({code:'DISCONNECTED'});expect(send).not.toHaveBeenCalled()
 expect(controls.getSnapshot()[0]?.state).toBe('unknown')
 await controls.request({type:'execution.cancel',...cancel})
 expect(send.mock.calls[0]![0].idempotencyKey).toBe(key)
 controls.clear()
})
