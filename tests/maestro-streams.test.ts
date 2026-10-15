import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { toMaestroEvent, toMaestroThread } from '../src/protocol/maestro/contracts'
import { MaestroStore } from '../src/maestro/store'
import { MaestroStreams, maestroStreamKey, maestroStreamLimits } from '../src/maestro/streams'
import { event, fixture, scope, thread, threadId, uuid } from './fixtures/maestro-replay'
import corpus from './fixtures/maestro-streaming-scenarios.json'

const participantId = uuid(8)
const executionId = uuid(20)
const delta = (index = 0, text = 'A', output = 'output:0', execution = executionId, tid = threadId) => ({thread_id: tid, participant_id: participantId, execution_id: execution, output_id: output, chunk_index: index, delta: text, ephemeral: true as const})
const partials = (s: MaestroStreams) => Object.values(s.forThread(threadId))
const streams = () => {const s = new MaestroStreams();s.capability(true);return s}
export function preparedStore() {
  const s = new MaestroStore(scope)
  const t = thread()
  t.participants = [{...fixture('Public.Participant'), participant_id: participantId, kind: 'agent', principal_id: uuid(81), role: 'member', instance_agent_id: uuid(80), capabilities: [], availability: 'available'}]
  s.observeThread(toMaestroThread(t))
  const started = event(1, 'execution.started')
  started.payload.execution_id = executionId
  started.payload.participant_id = participantId
  s.append(threadId, {known: true, event: toMaestroEvent(started)}, 'cursor-1')
  s.caughtUp(threadId, '1', 'cursor-1')
  s.setStreamCapability(true)
  return s
}
const finalEvent = (sequence = 2, id = executionId, output = 'output:0', text = 'durable final') => {
  const e = event(sequence)
  e.execution_id = id; e.output_id = output
  e.payload.execution_id = id; e.payload.output_id = output
  e.payload.content = [{type:'text', text}]
  return toMaestroEvent(e)
}

it('does not accept unnegotiated provisional data', () => {
 const s = new MaestroStreams();s.delta(delta());expect(partials(s)).toEqual([])
 s.capability(true);s.delta(delta());expect(partials(s)[0]?.text).toBe('A')
 s.capability(false);s.capability(true);s.delta(delta());expect(partials(s)).toEqual([])
})
it('duplicates are inert; conflicts, gaps and reset wait for durable final', () => {
 for (const kind of ['conflict','gap','reset','author']) {
  const s = streams();s.delta(delta());s.delta(delta());expect(partials(s)[0]?.text).toBe('A')
  if(kind==='reset')s.reset({thread_id:threadId,execution_id:executionId,output_id:'output:0',reason_code:'lost'})
  else if(kind==='author')s.delta({...delta(1),participant_id:uuid(9)})
  else s.delta(delta(kind==='gap'?2:0,'B'))
  s.delta(delta(0,'new'));expect(partials(s)).toEqual([]);expect(s.controlCount).toBe(1)
 }
})
it('isolates identical output IDs by execution and thread without timestamp sorting', () => {
 const s = streams();s.delta(delta());s.delta(delta(0,'B','output:0',uuid(21)));s.delta(delta(0,'C','output:0',executionId,uuid(99)))
 expect(partials(s).map(x=>x.text)).toEqual(['A','B']);expect(Object.values(s.forThread(uuid(99)))[0]?.text).toBe('C')
 s.endExecution(threadId,executionId);s.delta(delta(1));expect(partials(s).map(x=>x.text)).toEqual(['B'])
})
it('UTF-8 and UTF-16 bounds are distinct, including astral and lone surrogate input', () => {
 for (const text of ['é'.repeat(8193),'😀'.repeat(4097),'x'.repeat(16385),'\ud800'.repeat(5462)]) {
  const s=streams();s.delta(delta(0,text));expect(partials(s)).toEqual([]);expect(s.controlCount).toBe(1)
 }
 for (const text of ['é'.repeat(8192),'😀'.repeat(4096),'x'.repeat(16384)]) {
  const s=streams();s.delta(delta(0,text));expect(partials(s)[0]?.byteLength).toBe(16384)
 }
})
it('bounds bytes, chunk indexes and chunk metadata without dropping a tombstone', () => {
 const s=streams();for(let i=0;i<256;i++)s.delta(delta(i,'x'))
 expect(partials(s)[0]?.chunkCount).toBe(256);s.delta(delta(255,'x'));expect(s.byteLength).toBe(256)
 s.delta(delta(256,'x'));expect(s.byteLength).toBe(0);s.delta(delta());expect(partials(s)).toEqual([])
 for(const index of [-1,0.1,Number.MAX_SAFE_INTEGER+1,Number.MAX_SAFE_INTEGER]){const s=streams();s.delta(delta(index));expect(partials(s)).toEqual([])}
})
it('exact per-output limit is admitted, overflow clears only that output',()=>{
 const s=streams();for(let i=0;i<4;i++)s.delta(delta(i,'x'.repeat(16384)))
 s.delta(delta(0,'other','output:1'));expect(s.byteLength).toBe(65541)
 s.delta(delta(4,'x'));expect(partials(s).map(x=>x.text)).toEqual(['other']);expect(s.byteLength).toBe(5)
})
it('session bounds span all threads and outputs',()=>{
 const s=streams();for(let i=0;i<16;i++)s.delta(delta(0,'x','output:'+i))
 s.delta(delta(0,'overflow','output:99',executionId,uuid(99)));expect(s.activeCount).toBe(16);expect(s.controlCount).toBe(1)
 const bytes=streams();for(let o=0;o<4;o++)for(let i=0;i<4;i++)bytes.delta(delta(i,'x'.repeat(16384),'output:'+o))
 expect(bytes.byteLength).toBe(262144);bytes.delta(delta(0,'x','output:99',executionId,uuid(99)));expect(bytes.byteLength).toBe(262144);expect(bytes.controlCount).toBe(1)
})
it('control exhaustion latches, clears all text, and cannot be undone by reconnect',()=>{
 const s=streams();s.delta(delta())
 for(let i=0;i<128;i++)s.endExecution(threadId,uuid(100+i))
 expect(s.controlCount).toBe(128);s.delta(delta(1));expect(s.resyncRequired).toBe(true);expect(s.byteLength).toBe(0)
 s.capability(false);s.capability(true);s.delta(delta(0,'late','output:new'));expect(s.activeCount).toBe(0);expect(s.controlCount).toBe(128)
 s.clear();s.capability(true);s.delta(delta());expect(s.activeCount).toBe(1)
})
it('reconnect tombstones all known partials and participant removal is isolated',()=>{
 const s=streams();s.delta(delta());s.delta({...delta(0,'B','output:1'),participant_id:uuid(9)})
 s.removeParticipant(threadId,participantId);expect(partials(s).map(x=>x.text)).toEqual(['B'])
 s.interrupt();s.delta(delta());s.delta({...delta(0,'B','output:1'),participant_id:uuid(9)});expect(s.activeCount).toBe(0)
})
it('store keeps provisional state separate from canonical history/cursor and replaces it on final',()=>{
 for(const finalFirst of [false,true]){
  const s=preparedStore(), final=finalEvent()
  if(finalFirst)s.receipt(final)
  s.streamDelta(delta());s.streamDelta(delta())
  expect(s.getThread(threadId)?.appliedSequence).toBe('1');expect(s.getThread(threadId)?.resumeCursor).toBe('cursor-1')
  expect(s.getThread(threadId)?.eventIds.length).toBe(finalFirst?2:1)
  s.receipt(final);s.receipt(final);s.streamDelta(delta(1))
  expect(s.getThread(threadId)?.streamsByKey).toEqual({});expect(s.getThread(threadId)?.eventIds).toHaveLength(2)
  s.append(threadId,{known:true,event:final},'cursor-2');expect(s.getThread(threadId)?.appliedSequence).toBe('2')
  expect(()=>s.receipt({...final,payload:{...final.payload,content:[{type:'text',text:'conflict'}]}} as typeof final)).toThrow('Conflicting canonical')
 }
})
it('only known active execution and agent membership can authorize a provisional projection',()=>{
 const s=preparedStore();s.streamDelta(delta(0,'unknown','output:0',uuid(999)));expect(s.getThread(threadId)?.streamsByKey).toEqual({})
 s.streamDelta({...delta(),participant_id:uuid(999)});expect(s.getThread(threadId)?.streamsByKey).toEqual({})
 s.streamDelta(delta());expect(Object.values(s.getThread(threadId)!.streamsByKey)[0]?.participantId).toBe(participantId)
})
it('terminal receipt and replay clear partial without creating a false final, including final recovered later',()=>{
 const s=preparedStore();s.streamDelta(delta())
 const e=event(3,'execution.completed');e.payload.execution_id=executionId;e.payload.participant_id=participantId
 s.receipt(toMaestroEvent(e));s.streamDelta(delta(1));expect(s.getThread(threadId)?.streamsByKey).toEqual({})
 expect(s.getThread(threadId)?.appliedSequence).toBe('1')
 s.page(threadId,[{known:true,event:finalEvent()} ,{known:true,event:toMaestroEvent(e)}],'3','cursor-3',false)
 expect(s.getThread(threadId)?.eventIds).toHaveLength(3);expect(s.getThread(threadId)?.appliedSequence).toBe('3')
})
it.each(['disconnected','resync','revoked','idle'] as const)('clears partial on %s and snapshot retry cannot resurrect it',phase=>{
 const s=preparedStore();s.streamDelta(delta());s.patch(threadId,{phase});expect(s.getThread(threadId)?.streamsByKey).toEqual({})
 s.restart(threadId,true);s.patch(threadId,{phase:'live'});s.streamDelta(delta());expect(s.getThread(threadId)?.streamsByKey).toEqual({})
})
it('unknown future durable events do not create streams or interpret private payloads',()=>{
 const s=preparedStore();s.append(threadId,{known:false,event:{...finalEvent(),type:'future.internal',payload:{delta:'private',execution_id:executionId,output_id:'output:0'}}},'cursor-2')
 expect(s.getThread(threadId)?.streamsByKey).toEqual({});s.streamDelta(delta());expect(Object.values(s.getThread(threadId)!.streamsByKey)).toHaveLength(1)
})

// Backend admission/cancel and canonical conflict are exercised at their own authority.
// These fixed cases run the accepted corpus against the actual incremental projector.
const excluded = new Set(['stale-fence','unauthorized','request-rate','conflicting-final'])
describe('E09-01 accepted corpus: client provisional outcomes',()=>{
 for(const c of corpus.cases.filter(c=>!excluded.has(c.id))) it(c.id,()=>{
  const s=new MaestroStreams();s.capability(c.capabilities.includes('stream.delta'))
  for(const step of c.steps){const v=step as {op:string;execution?:string;output?:string;index?:number;text?:string;repeat?:number}
   if(v.op==='delta')s.delta(delta(v.index??0,(v.text??'').repeat(v.repeat??1),v.output??'',v.execution??''))
   else if(v.op==='final')s.final(threadId,v.execution??'',v.output??'')
   else if(v.op==='terminal')s.endExecution(threadId,v.execution??'')
   else if(v.op==='reset')s.reset({thread_id:threadId,execution_id:v.execution??'',output_id:v.output??'',reason_code:'lost'})
   else if(v.op==='reconnect')s.interrupt()
   else if(v.op==='scope_clear')s.clear()
  }
  const actual=partials(s).map(v=>[maestroStreamKey(v.executionId,v.outputId),createHash('sha256').update(v.text).digest('hex')]).sort(([a],[b])=>a!.localeCompare(b!))
  expect(actual).toEqual(c.expected.partial_hashes);expect(s.activeCount).toBe(c.expected.partials)
 })
})
it('policy values match frozen local E09-01 thresholds',()=>{
 expect(maestroStreamLimits).toEqual({deltaBytes:16384,outputBytes:65536,sessionBytes:262144,activeOutputs:16,outputChunks:256,controlEntries:128})
})
it('duplicate delta preserves snapshot identity and emits no redundant observer notification',()=>{
 const s=preparedStore();let changes=0;s.subscribe(()=>changes++);s.streamDelta(delta());const snapshot=s.getSnapshot()
 s.streamDelta(delta());expect(changes).toBe(1);expect(s.getSnapshot()).toBe(snapshot)
 expect(Object.isFrozen(s.getThread(threadId)?.streamsByKey)).toBe(true)
})
it('store exposes control exhaustion without triggering canonical replay or suppressing durable finals',()=>{
 const s=preparedStore();s.streamDelta(delta())
 for(let i=0;i<129;i++)s.receipt(finalEvent(i+2,uuid(200+i)))
 expect(s.getThread(threadId)?.streamResyncRequired).toBe(true);expect(s.getThread(threadId)?.streamsByKey).toEqual({})
 expect(s.getThread(threadId)?.phase).toBe('live');expect(s.getThread(threadId)?.appliedSequence).toBe('1');expect(s.getThread(threadId)?.eventIds).toHaveLength(130)
 s.setStreamCapability(false);s.setStreamCapability(true);s.streamDelta(delta(0,'late','output:1'));expect(s.getThread(threadId)?.streamsByKey).toEqual({})
 s.clear();expect(s.getSnapshot().threads).toEqual({})
})
it('snapshot archive and participant removal discard only affected provisional state',()=>{
 const s=preparedStore();s.streamDelta(delta())
 const removed=event(2,'participant.removed');removed.payload.participant_id=participantId
 s.append(threadId,{known:true,event:toMaestroEvent(removed)},'cursor-2');expect(s.getThread(threadId)?.streamsByKey).toEqual({})
 const archived=preparedStore();archived.streamDelta(delta());const t={...archived.getThread(threadId)!.thread!,state:'archived' as const,lastSequence:'2'}
 archived.observeThread(t);archived.streamDelta(delta(0,'new','output:1'));expect(archived.getThread(threadId)?.streamsByKey).toEqual({})
})
