import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MaestroClient } from '../src/maestro/client'
import { connect, event, make, scope, Socket, thread, threadId, tick, uuid } from './fixtures/maestro-replay'
const clients: MaestroClient[]=[]
const create = (extra: Parameters<typeof make>[0] = {}) => {const env=make(extra);clients.push(env.client);return env}
afterEach(()=>{for(const c of clients)c.dispose();clients.length=0;vi.useRealTimers()})
const subscribed = async(extra: Parameters<typeof make>[0]={}) => {const env=create(extra);const release=env.client.retainThread(threadId);const socket=await connect(env.client,env.sockets);socket.ackSubscribe();await tick();return {...env,socket,release}}
const snapshot = (socket: Socket, n=2, subscriptionId=uuid(101)) => {socket.snapshot(Array.from({length:n},(_,i)=>event(i+1)),String(n),subscriptionId);socket.caught(String(n),subscriptionId)}
const json=(data:unknown)=>new Response(JSON.stringify(data),{status:200,headers:{'content-type':'application/json'}})

describe('Maestro subscription refs and recovery',()=>{
 it('shares wire subscription across refs, releases exactly once, remount resumes without creating or publishing',async()=>{
  const {client,socket,release}=await subscribed();const second=client.retainThread(threadId.toUpperCase());snapshot(socket)
  expect(socket.sent.filter(f=>f.type==='thread.subscribe')).toHaveLength(1);expect(client.store.getThread(threadId)?.refs).toBe(2)
  release();release();expect(socket.sent.filter(f=>f.type==='thread.unsubscribe')).toHaveLength(0)
  second();expect(socket.sent.filter(f=>f.type==='thread.unsubscribe')).toHaveLength(1)
  const third=client.retainThread(threadId);expect(socket.last('thread.subscribe').payload.cursor).toBe('cursor-2')
  expect(socket.sent.some(f=>f.type==='message.publish'||f.type==='thread.create')).toBe(false);third()
 })
 it('routes initial frames received immediately after ACK before the subscribe promise settles',async()=>{
  const env=create();env.client.retainThread(threadId);const socket=await connect(env.client,env.sockets);socket.ackSubscribe();snapshot(socket)
  expect(env.client.store.getThread(threadId)).toMatchObject({phase:'live',appliedSequence:'2',resumeCursor:'cursor-2'})
 })
 it('fences stale subscribe ACK after release and new retain of the same thread',async()=>{
  const env=create();const release=env.client.retainThread(threadId);const socket=await connect(env.client,env.sockets);const old=socket.last('thread.subscribe')
  release();env.client.retainThread(threadId);const fresh=socket.last('thread.subscribe');expect(fresh.id).not.toBe(old.id)
  socket.receive({id:old.id,type:'ack',payload:{status:'subscribed',subscription_id:uuid(111),replay_watermark:'2',replay_mode:'snapshot'}})
  snapshot(socket,2,uuid(111));expect(env.client.store.getThread(threadId)?.eventIds).toEqual([])
  socket.receive({id:fresh.id,type:'ack',payload:{status:'subscribed',subscription_id:uuid(112),replay_watermark:'1',replay_mode:'snapshot'}})
  snapshot(socket,1,uuid(112));await tick();expect(env.client.store.getThread(threadId)).toMatchObject({phase:'live',appliedSequence:'1'})
  expect(socket.sent.filter(f=>f.type==='thread.unsubscribe').some(f=>f.payload.subscription_id===uuid(111))).toBe(true)
 })
 it('reconnect restores only active refs from contiguous cursor and never resends unknown publication',async()=>{
  const {client,socket,sockets}=await subscribed();snapshot(socket)
  const sending=client.send({threadId,content:[{type:'text',text:'uncertain'}],clientEventId:'keep'}).catch(e=>e)
  socket.drop();await sending
  expect(client.store.getThread(threadId)?.commandsByKey.keep?.state).toBe('unknown')
  const next=await connect(client,sockets);expect(next.last('thread.subscribe').payload.cursor).toBe('cursor-2')
  expect(next.sent.some(f=>f.type==='message.publish')).toBe(false)
  next.ackSubscribe(uuid(102),'3');next.frame('thread.replay',{events:[event(3)],watermark:'3',next_cursor:null,has_more:false},uuid(102));next.caught('3',uuid(102));await tick()
  expect(client.store.getThread(threadId)).toMatchObject({phase:'live',appliedSequence:'3'});expect(client.store.getThread(threadId)?.eventIds).toHaveLength(3)
 })
 it('never applies a received cursor beyond a gap and resumes from the safe checkpoint',async()=>{
  vi.useFakeTimers();const {client,socket}=await subscribed();snapshot(socket,1)
  socket.frame('event.append',{event:event(3),cursor:'cursor-3'})
  expect(client.store.getThread(threadId)).toMatchObject({phase:'resync',appliedSequence:'1',resumeCursor:'cursor-1'})
  await vi.advanceTimersByTimeAsync(11);expect(socket.last('thread.subscribe').payload.cursor).toBe('cursor-1')
  socket.ackSubscribe(uuid(102),'3');socket.frame('thread.replay',{events:[event(2),event(3)],watermark:'3',next_cursor:null,has_more:false},uuid(102));socket.caught('3',uuid(102));await tick()
  expect(client.store.getThread(threadId)).toMatchObject({phase:'live',appliedSequence:'3',resumeCursor:'cursor-3'});expect(client.store.getThread(threadId)?.eventIds).toHaveLength(3)
 })
 it('cursor expiry clears prior canonical continuity and paginated history, keeps unknown intent, and requests snapshot',async()=>{
  vi.useFakeTimers();const {client,socket}=await subscribed();snapshot(socket,2)
  const send=client.send({threadId,content:[{type:'text',text:'uncertain'}],clientEventId:'unknown'}).catch(e=>e)
  socket.receive({id:socket.last('message.publish').id,type:'error',payload:{code:'CORE_UNAVAILABLE',message:'temporary',retryable:true,request_id:uuid(990)}});await send
  socket.frame('resync.required',{reason_code:'cursor_expired',action:'snapshot'})
  expect(client.store.getThread(threadId)).toMatchObject({resumeCursor:null,eventIds:[],commandsByKey:{unknown:{state:'unknown'}}})
  await vi.advanceTimersByTimeAsync(11);expect(socket.last('thread.subscribe').payload).not.toHaveProperty('cursor')
  socket.ackSubscribe(uuid(102),'1');const restored={...event(1),event_id:uuid(555)};socket.snapshot([restored],'1',uuid(102));socket.caught('1',uuid(102));await tick()
  expect(client.store.getThread(threadId)?.eventIds).toEqual([restored.event_id]);expect(socket.sent.filter(f=>f.type==='message.publish')).toHaveLength(1)
 })
 it('limits repeated resync loops and exposes explicit retry',async()=>{
  vi.useFakeTimers();const {client,socket}=await subscribed({maxReplayAttempts:1});snapshot(socket,1)
  socket.frame('resync.required',{reason_code:'sequence_gap',action:'replay'});await vi.advanceTimersByTimeAsync(11);socket.ackSubscribe(uuid(102),'1');await tick()
  socket.frame('resync.required',{reason_code:'sequence_gap',action:'replay'},uuid(102));await vi.advanceTimersByTimeAsync(30000)
  expect(client.store.getThread(threadId)?.phase).toBe('failed');expect(socket.sent.filter(f=>f.type==='thread.subscribe')).toHaveLength(2)
  client.retryReplay(threadId);await vi.advanceTimersByTimeAsync(11);expect(socket.sent.filter(f=>f.type==='thread.subscribe')).toHaveLength(3)
 })
 it('purges revoked thread, fences in-flight ACK, and does not reset unrelated threads',async()=>{
  const {client,socket}=await subscribed();snapshot(socket,1);client.store.patch(uuid(200),{phase:'idle'})
  const pending=client.send({threadId,content:[{type:'text',text:'pending'}],clientEventId:'pending'}).catch(e=>e);const command=socket.last('message.publish')
  socket.frame('subscription.revoked',{reason_code:'membership_removed'})
  const e=event(2);e.payload={content:command.payload.content,mentions:[],client_event_id:'pending'}
  socket.receive({id:command.id,type:'ack',payload:{status:'persisted',event:e,cursor:'two',duplicate:false}});await pending
  expect(client.store.getThread(threadId)).toMatchObject({phase:'revoked',eventIds:[],commandsByKey:{},optimisticByKey:{}})
  expect(client.publications.getSnapshot().events).toEqual([]);expect(client.store.getThread(uuid(200))?.phase).toBe('idle')
  await expect(client.retry(threadId,'pending')).rejects.toMatchObject({code:'UNKNOWN_OPERATION'})
 })
 it('keeps before pagination separate, shares concurrent loads, and discards response after release',async()=>{
  let resolve!: (r:Response)=>void;const fetcher=vi.fn(()=>new Promise<Response>(r=>{resolve=r}))
  const {client,socket,release}=await subscribed({fetch:fetcher});snapshot(socket,3)
  const first=client.loadBefore(threadId,{before:'older'});const second=client.loadBefore(threadId);expect(first).toBe(second);expect(fetcher).toHaveBeenCalledOnce()
  resolve(json({items:[event(1)],next_cursor:'page-before',has_more:true,watermark:'3'}));await first
  expect(client.store.getThread(threadId)).toMatchObject({resumeCursor:'cursor-3',beforeCursor:'page-before',appliedSequence:'3'})
  const late=client.loadBefore(threadId);release();resolve(json({items:[event(1)],next_cursor:'late',has_more:true,watermark:'3'}));await late
  expect(client.store.getThread(threadId)?.beforeCursor).toBe('page-before')
 })
 it('handles future events in snapshot/replay and malformed known event still fails closed',async()=>{
  const {client,socket}=await subscribed();const future={...event(1),type:'future.changed',payload:{v:'safe'}}
  socket.snapshot([future],'2',uuid(101),true);socket.frame('thread.replay',{events:[event(2)],watermark:'2',next_cursor:null,has_more:false});socket.caught('2')
  expect(client.store.getThread(threadId)).toMatchObject({phase:'live',appliedSequence:'2'});expect(client.store.getThread(threadId)?.eventsById[future.event_id]?.known).toBe(false)
  socket.frame('thread.replay',{events:[{...event(3),payload:{content:'invalid'}}],watermark:'3',next_cursor:null,has_more:false})
  expect(client.store.getThread(threadId)?.phase).toBe('disconnected');expect(client.store.getThread(threadId)?.appliedSequence).toBe('2')
 })
 it('supports metadata-only snapshot and covered final page with null next cursor',async()=>{
  const {client,socket}=await subscribed();socket.frame('thread.snapshot',{thread:thread('1'),events:[],watermark:'1',next_cursor:'zero',has_more:true})
  socket.frame('thread.replay',{events:[event(1)],watermark:'1',next_cursor:null,has_more:false});socket.caught('1')
  expect(client.store.getThread(threadId)).toMatchObject({phase:'live',appliedSequence:'1',resumeCursor:'cursor-1'})
 })
 it('auth loss removes all data and late old-socket frames cannot repopulate a new identity',async()=>{
  const {client,socket}=await subscribed();snapshot(socket)
  socket.receive({type:'session.expired',payload:{expires_at:new Date().toISOString(),reason_code:'expired'}})
  expect(client.store.getThread(threadId)?.eventIds).toEqual([]);expect(client.store.getThread(threadId)?.resumeCursor).toBeNull()
  socket.frame('event.append',{event:event(3),cursor:'three'});expect(client.store.getThread(threadId)?.eventIds).toEqual([])
  client.reset();expect(client.store.getSnapshot().threads).toEqual({})
 })
})

it('successful caught_up resets the budget for a later independent recovery incident',async()=>{
 vi.useFakeTimers();const {client,socket}=await subscribed({maxReplayAttempts:1});snapshot(socket,1)
 socket.frame('resync.required',{reason_code:'sequence_gap',action:'replay'});await vi.advanceTimersByTimeAsync(11);socket.ackSubscribe(uuid(102),'1');socket.caught('1',uuid(102));await tick()
 expect(client.store.getThread(threadId)?.phase).toBe('live')
 socket.frame('resync.required',{reason_code:'sequence_gap',action:'replay'},uuid(102));await vi.advanceTimersByTimeAsync(11)
 expect(socket.sent.filter(f=>f.type==='thread.subscribe')).toHaveLength(3);expect(client.store.getThread(threadId)?.phase).toBe('subscribing')
})
it('a receipt in flight across snapshot reset cannot repopulate the prior continuity',async()=>{
 vi.useFakeTimers();const {client,socket}=await subscribed();snapshot(socket,1)
 const pending=client.send({threadId,content:[{type:'text',text:'pending'}],clientEventId:'pending'}).catch(e=>e);const command=socket.last('message.publish')
 socket.frame('resync.required',{reason_code:'cursor_expired',action:'snapshot'})
 const e=event(2);e.payload={content:command.payload.content,mentions:[],client_event_id:'pending'}
 socket.receive({id:command.id,type:'ack',payload:{status:'persisted',event:e,cursor:'old-two',duplicate:false}});await pending
 expect(client.store.getThread(threadId)?.eventIds).toEqual([]);expect(client.store.getThread(threadId)?.commandsByKey.pending?.state).toBe('unknown')
 expect(client.publications.getSnapshot().events).toEqual([])
})

it('reconnect replay confirms an uncertain owned message after validated caught_up', async () => {
 const {client,socket,sockets}=await subscribed();snapshot(socket,1)
 const input={threadId,content:[{type:'text' as const,text:'recover replay'}],clientEventId:'replay-intent'}
 const sending=client.send(input).catch(e=>e);socket.drop();await sending
 const next=await connect(client,sockets);next.ackSubscribe(uuid(102),'2')
 const canonical=event(2);canonical.actor.principal_id=client.scope.principalId;canonical.payload={content:input.content,mentions:[],client_event_id:input.clientEventId}
 next.frame('thread.replay',{events:[canonical],watermark:'2',next_cursor:null,has_more:false},uuid(102))
 expect(client.publications.get(threadId,input.clientEventId)?.state).toBe('unknown')
 next.caught('2',uuid(102));await tick()
 expect(client.publications.get(threadId,input.clientEventId)?.state).toBe('persisted')
 expect(client.store.getThread(threadId)?.optimisticByKey).toEqual({})
 await expect(client.retry(threadId,input.clientEventId)).resolves.toMatchObject({eventId:canonical.event_id})
 expect(next.sent.some(f=>f.type==='message.publish')).toBe(false)
})
