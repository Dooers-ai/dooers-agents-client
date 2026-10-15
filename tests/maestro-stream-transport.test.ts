import { afterEach, expect, it } from 'vitest'
import { MaestroClient } from '../src/maestro/client'
import { credential } from './fixtures/maestro-credential'
import { event, fixture, make, scope, thread, threadId, tick, uuid } from './fixtures/maestro-replay'
const clients: MaestroClient[]=[]
afterEach(()=>{for(const c of clients)c.dispose();clients.length=0})
const pid=uuid(8),eid=uuid(20)
const delta=(output='output:0',index=0,text='provisional',execution=eid)=>({type:'stream.delta',payload:{thread_id:threadId,participant_id:pid,execution_id:execution,output_id:output,chunk_index:index,delta:text,ephemeral:true}})
const setup=async(capability=true)=>{
 const {client,sockets}=make();clients.push(client)
 const connecting=client.connect();await tick();const socket=sockets[0]!;socket.open();await tick()
 socket.receive({id:socket.last('connect').id,type:'ack',payload:{status:'connected',connection_id:uuid(100),server_version:'0.0.0',protocol_version:1,history_authority:'maestro',capabilities:['messages.text','threads.shared','history.replay',...(capability?['stream.delta']:[])],expires_at:new Date(Date.now()+300000).toISOString()}})
 await connecting
 const release=client.retainThread(threadId);await tick();socket.ackSubscribe()
 const t=thread('1');t.participants=[{...fixture('Public.Participant'),participant_id:pid,kind:'agent',principal_id:uuid(81),role:'member',instance_agent_id:uuid(80),capabilities:[],availability:'available'}]
 const e=event(1,'execution.started');e.payload.execution_id=eid;e.payload.participant_id=pid
 socket.frame('thread.snapshot',{thread:t,events:[e],watermark:'1',next_cursor:null,has_more:false});socket.caught('1');await tick()
 return {client,socket,release,sockets}
}
const partial=(client:MaestroClient)=>Object.values(client.store.getThread(threadId)?.streamsByKey??{})
it('negotiates receive-side stream frames, drops added private fields and unknown future frames',async()=>{
 const {client,socket}=await setup();const frame=delta()
 socket.receive({...frame,payload:{...frame.payload,private_reasoning:'secret'}})
 expect(partial(client)[0]?.text).toBe('provisional');expect(JSON.stringify(partial(client))).not.toContain('secret')
 socket.receive({type:'stream.future_private',payload:{thread_id:threadId,text:'secret'}})
 expect(partial(client)).toHaveLength(1);expect(client.store.getThread(threadId)?.eventIds).toHaveLength(1)
 expect(client.store.getThread(threadId)?.resumeCursor).toBe('cursor-1')
})
it('capability missing cannot enable stream through an unsolicited frame',async()=>{
 const {client,socket}=await setup(false);socket.receive(delta());expect(partial(client)).toEqual([]);expect(client.hasCapability('stream.delta')).toBe(false)
})
it('unknown executions, different participants and non-subscribed threads fail closed',async()=>{
 const {client,socket}=await setup()
 socket.receive(delta('output:0',0,'old',uuid(999)))
 const wrong=delta();socket.receive({...wrong,payload:{...wrong.payload,participant_id:uuid(999)}})
 socket.receive({...wrong,payload:{...wrong.payload,thread_id:uuid(999)}})
 expect(partial(client)).toEqual([])
})
it('final replacement and duplicate converge; delayed delta cannot recreate output',async()=>{
 const {client,socket}=await setup();socket.receive(delta())
 const e=event(2);e.execution_id=eid;e.output_id='output:0';e.payload.execution_id=eid;e.payload.output_id='output:0'
 socket.frame('event.append',{event:e,cursor:'cursor-2'});socket.frame('event.append',{event:e,cursor:'cursor-2'});socket.receive(delta('output:0',1,'late'))
 expect(partial(client)).toEqual([]);expect(client.store.getThread(threadId)?.eventIds).toHaveLength(2);expect(client.store.getThread(threadId)?.appliedSequence).toBe('2')
})
it('reset and oversized UTF-8 payloads discard partial without closing canonical channel',async()=>{
 const {client,socket}=await setup();socket.receive(delta())
 socket.receive({type:'stream.reset',payload:{thread_id:threadId,execution_id:eid,output_id:'output:0',reason_code:'lost'}})
 socket.receive(delta());socket.receive(delta('output:1',0,'é'.repeat(10000)))
 expect(partial(client)).toEqual([]);expect(client.getConnection().status).toBe('connected')
})
it('socket loss clears partial and old-generation callback cannot resurrect it',async()=>{
 const {client,socket}=await setup();socket.receive(delta());const old=socket.onmessage!;socket.drop()
 expect(partial(client)).toEqual([]);old(new MessageEvent('message',{data:JSON.stringify(delta('output:1'))}));expect(partial(client)).toEqual([])
})
it('refresh removes provisional content and same output cannot reopen after successful refresh',async()=>{
 const {client,socket}=await setup();socket.receive(delta())
 const refresh=client.refreshAuth(credential(scope.principalId,scope.organizationId));await tick();expect(partial(client)).toEqual([])
 socket.receive(delta('output:1'))
 socket.receive({id:socket.last('auth.refresh').id,type:'ack',payload:{status:'authenticated',expires_at:new Date(Date.now()+300000).toISOString()}})
 await refresh;socket.receive(delta());expect(partial(client)).toEqual([])
 socket.receive(delta('output:2'));expect(partial(client)).toHaveLength(1)
})
it('unsubscribe and revocation remove private partials without issuing cancellation',async()=>{
 const one=await setup();one.socket.receive(delta());one.release();expect(partial(one.client)).toEqual([]);one.socket.receive(delta('output:1'));expect(partial(one.client)).toEqual([])
 const two=await setup();two.socket.receive(delta());two.socket.frame('subscription.revoked',{reason_code:'membership_removed'});expect(two.client.store.getThread(threadId)?.phase).toBe('revoked');expect(partial(two.client)).toEqual([])
 expect([...one.socket.sent,...two.socket.sent].some(f=>f.type==='execution.cancel'||f.type==='root.stop')).toBe(false)
})
it('server-side session expiry clears all provisional content and canonical private state',async()=>{
 const {client,socket}=await setup();socket.receive(delta());socket.receive({type:'session.expired',payload:{expires_at:new Date().toISOString(),reason_code:'expired'}})
 expect(partial(client)).toEqual([]);expect(client.getConnection().status).toBe('unauthenticated');expect(client.store.getThread(threadId)?.eventIds??[]).toEqual([])
})
