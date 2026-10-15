// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { maestroPublicSchemas, toMaestroThread } from '../src/protocol/maestro/contracts'
import { toMaestroNetworkEvent } from '../src/maestro/network'
import { toMaestroConversationPresentation } from '../src/maestro/presentation'
import { MaestroStore, type MaestroStoreSnapshot } from '../src/maestro/store'
import type { MaestroConnection } from '../src/maestro/types'
import fixture from './fixtures/maestro-presentation.json'

function execution(e: typeof fixture.executions[number]) {
  if(e.state === 'completed') return maestroPublicSchemas['Public.Event.execution.completed'].shape.payload.parse(e)
  if(e.state === 'failed') return maestroPublicSchemas['Public.Event.execution.failed'].shape.payload.parse(e)
  if(e.state === 'canceled') return maestroPublicSchemas['Public.Event.execution.canceled'].shape.payload.parse(e)
  const started = maestroPublicSchemas['Public.Event.execution.started'].shape.payload.parse({...e,state:'running',completed_at:null})
  return e.state === 'suspended' ? {...started,state:'suspended' as const} : started
}
const thread = toMaestroThread(fixture.thread)
const scope = { principalId: 'viewer', organizationId: thread.organizationId, workspaceId: thread.workspaceId }
const connected = { status: 'connected', capabilities: ['messages.text'] } satisfies Pick<MaestroConnection, 'status'|'capabilities'>
function snapshot(): MaestroStoreSnapshot {
  const store = new MaestroStore(scope)
  store.observeThread(thread)
  const base = structuredClone(store.getSnapshot())
  const state = base.threads[thread.threadId]!
  const events = fixture.events.map(toMaestroNetworkEvent)
  return { ...base, threads: { [thread.threadId]: { ...state,
    eventsById: Object.fromEntries(events.map(e=>[e.event.eventId,e])),
    eventIds: events.map(e=>e.event.eventId).reverse(),
    deliveriesById: Object.fromEntries(fixture.deliveries.map(d=>[d.delivery_id,maestroPublicSchemas['Public.Delivery'].parse(d)])),
    executionsById: Object.fromEntries(fixture.executions.map(e=>[e.execution_id,execution(e)])),
    commandsByKey: Object.fromEntries(['pending','unknown','persisted','rejected'].map((state)=>[state,{threadId:thread.threadId,clientEventId:state,state}])) as any,
    optimisticByKey: { unknown: {threadId:thread.threadId,clientEventId:'unknown',content:[{type:'text',text:'Recuperável'}]} },
  } } }
}
const present = (s = snapshot(), connection = connected) => toMaestroConversationPresentation(s,thread.threadId,connection,scope)!
describe('Maestro presentation boundary',()=>{
 it('preserves six agent identities and opaque sequence across the wire and SDK conversions',()=>{
  const view=present();expect(view.participants.filter(p=>p.kind==='agent')).toHaveLength(6)
  expect(new Set(view.participants.map(p=>p.participantId)).size).toBe(8)
  expect(view.events.map(e=>e.sequence)).toEqual(fixture.events.map(e=>e.sequence))
  expect(view.events.map(e=>e.actor.participantId)).toEqual(fixture.events.map(e=>e.actor.participant_id))
  expect(view.thread.lastSequence).toBe('9007199254741010');expect(view.authority).toBe('maestro')
  expect('agentId' in view.thread).toBe(false);expect(JSON.parse(JSON.stringify(view))).toEqual(view)
 })
 it('keeps independent results and waiting input separate from active execution',()=>{
  const view=present();expect(view.deliveries.map(d=>d.state)).toEqual(['responded','silent','failed','running','waiting_input','waiting_broker'])
  expect(view.executions[1]?.outcome).toBe('silent');expect(view.executions[4]?.state).toBe('suspended')
  expect(view.hasPendingWork).toBe(true);expect(view.waitingForInput).toBe(true)
  const s=snapshot();const state=s.threads[thread.threadId]!;state.deliveriesById=Object.fromEntries(Object.entries(state.deliveriesById).filter(([,d])=>['silent','waiting_input'].includes(d.state)))
  expect(present(s).hasPendingWork).toBe(false);expect(present(s).waitingForInput).toBe(true)
 })
 it('keeps pending unknown persisted rejected commands separate from canonical events',()=>{
  const view=present();expect(view.publications.map(p=>p.state)).toEqual(['pending','unknown','persisted','rejected'])
  expect(view.publications[1]?.draft?.content).toEqual([{type:'text',text:'Recuperável'}]);expect(view.events).toHaveLength(6)
 })
 it.each(['archived','read_only','unsupported','disconnected'] as const)('fails closed for text action: %s',reason=>{
  const s=snapshot();const t=s.threads[thread.threadId]!.thread!;const connection={...connected}
  if(reason==='archived')t.state='archived'
  if(reason==='read_only')t.permissions.write=false
  if(reason==='unsupported')t.capabilities=[]
  if(reason==='disconnected')connection.status='disconnected' as any
  const view=present(s,connection);expect(view.textAction).toEqual({enabled:false,reason});expect(view.permissions).toEqual(t.permissions)
 })
 it.each(['failed','resync','subscribing','replaying','disconnected'] as const)('blocks a noncurrent thread %s despite global connection',phase=>{
  const s=snapshot();s.threads[thread.threadId]!.phase=phase
  expect(present(s).textAction).toEqual({enabled:false,reason:phase==='failed'?'unavailable':phase==='disconnected'?'disconnected':'recovering'})
 })
 it.each(['idle','live'] as const)('allows valid current HTTP snapshot or live thread %s',phase=>{
  const s=snapshot();s.threads[thread.threadId]!.phase=phase
  expect(present(s).textAction.enabled).toBe(true)
 })
 it('does not presume server support or infer write from owner or manage',()=>{
  expect(present(snapshot(),{...connected,capabilities:[]}).textAction.enabled).toBe(false)
  const s=snapshot();s.threads[thread.threadId]!.thread!.permissions.write=false
  expect(present(s).textAction.reason).toBe('read_only')
 })
 it.each(['revoked','no_read','deleted','deleting'])('does not expose content when %s',reason=>{
  const s=snapshot();const state=s.threads[thread.threadId]!
  if(reason==='revoked')state.phase='revoked';else if(reason==='no_read')state.thread!.permissions.read=false;else state.thread!.state=reason as any
  expect(present(s)).toBeNull()
 })
 it('rejects identity scope and authority mismatches',()=>{
  expect(()=>toMaestroConversationPresentation(snapshot(),thread.threadId,connected,{...scope,principalId:'another'})).toThrow('another session')
  const s=snapshot();s.threads[thread.threadId]!.thread!.mode='agent' as any
  expect(()=>present(s)).toThrow('authority or scope mismatch')
 })
 it('drops unknown payloads while preserving public position and actor',()=>{
  const s=snapshot();const state=s.threads[thread.threadId]!;const future=toMaestroNetworkEvent({...fixture.events[0],type:'future.private',payload:{secret:'not-renderable'}})
  state.eventsById={[future.event.eventId]:future};state.eventIds=[future.event.eventId]
  const view=present(s);expect(view.events[0]?.known).toBe(false);expect(JSON.stringify(view.events)).not.toContain('not-renderable');expect(view.events[0]?.sequence).toBe(fixture.events[0]?.sequence)
 })
 it('stops pending work at a correlated terminal execution, preserves A and never trusts a foreign execution',()=>{
  const s=snapshot();const state=s.threads[thread.threadId]!;
  const a=fixture.deliveries[0]!;const b=fixture.deliveries[2]!;
  state.deliveriesById={ [a.delivery_id]:maestroPublicSchemas['Public.Delivery'].parse(a), [b.delivery_id]:maestroPublicSchemas['Public.Delivery'].parse({...b,state:'running',completed_at:null,execution_id:fixture.executions[2]!.execution_id}) };
  state.executionsById[fixture.executions[2]!.execution_id]={...execution(fixture.executions[2]!),reason_code:'insufficient_balance'};
  const result=present(s);expect(result.hasPendingWork).toBe(false);
  expect(result.deliveries[0]?.state).toBe('responded');expect(result.events).toHaveLength(6);
  expect(result.executions.find(e=>e.executionId===fixture.executions[2]!.execution_id)?.commercialBlock).toEqual({reasonCode:'insufficient_balance',action:'review_balance',retryable:false});
  state.executionsById[fixture.executions[2]!.execution_id]={...state.executionsById[fixture.executions[2]!.execution_id]!,participant_id:a.participant_id};
  expect(present(s).hasPendingWork).toBe(true);
 })

})
