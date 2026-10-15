import { act, cleanup, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { MaestroProvider, useMaestroStreams, useMaestroThread } from '../src/maestro/provider'
import { credential } from './fixtures/maestro-credential'
import { event, fixture, scope, Socket, thread, threadId, tick, uuid } from './fixtures/maestro-replay'
const sockets: Socket[]=[]
const config={mode:'maestro' as const,endpoint:'https://maestro.example',scope,authToken:credential(scope.principalId,scope.organizationId),maxReconnectAttempts:0,socketFactory:()=>{const s=new Socket();sockets.push(s);return s}}
const pid=uuid(8),eid=uuid(20)
function Probe(){const {streams,resyncRequired}=useMaestroStreams(threadId);const {state}=useMaestroThread(threadId);return <div>{streams.map(s=><span key={s.executionId+s.outputId}>{s.participantId}:{s.text}:provisional</span>)}<b>{state?.eventIds.length??0}:{String(resyncRequired)}</b></div>}
afterEach(()=>{cleanup();sockets.length=0})
it('hook shares canonical subscription, renders provisional separately, and clears on identity change',async()=>{
 const view=render(<MaestroProvider config={config}><Probe/></MaestroProvider>)
 await act(tick);const s=sockets[0]!
 await act(async()=>{s.open();await tick();s.receive({id:s.last('connect').id,type:'ack',payload:{status:'connected',connection_id:uuid(100),server_version:'0.0.0',protocol_version:1,history_authority:'maestro',capabilities:['messages.text','history.replay','stream.delta'],expires_at:new Date(Date.now()+300000).toISOString()}});await tick();s.ackSubscribe()
 const t=thread('1');t.participants=[{...fixture('Public.Participant'),participant_id:pid,kind:'agent',principal_id:uuid(81),role:'member',instance_agent_id:uuid(80),capabilities:[],availability:'available'}]
 const e=event(1,'execution.started');e.payload.execution_id=eid;e.payload.participant_id=pid
 s.frame('thread.snapshot',{thread:t,events:[e],watermark:'1',next_cursor:null,has_more:false});s.caught('1');await tick()})
 expect(s.sent.filter(f=>f.type==='thread.subscribe')).toHaveLength(1)
 await act(async()=>s.receive({type:'stream.delta',payload:{thread_id:threadId,participant_id:pid,execution_id:eid,output_id:'output:0',chunk_index:0,delta:'visible partial',ephemeral:true}}))
 expect(view.container.textContent).toContain(pid+':visible partial:provisional');expect(view.container.textContent).toContain('1:false')
 await act(async()=>{const e=event(2);e.execution_id=eid;e.output_id='output:0';s.frame('event.append',{event:e,cursor:'cursor-2'})})
 expect(view.container.textContent).not.toContain('partial');expect(view.container.textContent).toContain('2:false')
 view.rerender(<MaestroProvider config={{...config,scope:{...scope,principalId:'other'},authToken:credential('other',scope.organizationId)}}><Probe/></MaestroProvider>)
 expect(view.container.textContent).toBe('0:false');expect(s.close).toHaveBeenCalled()
})
