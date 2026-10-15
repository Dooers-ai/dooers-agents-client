import { describe, expect, it } from 'vitest'
import { MaestroStore } from '../src/maestro/store'
import { readMaestroNetworkPage, toMaestroNetworkEvent as read } from '../src/maestro/network'
import { compareMaestroSequences, toMaestroThread } from '../src/protocol/maestro/contracts'
import { event, fixture, scope, thread, threadId, uuid } from './fixtures/maestro-replay'
const make = () => new MaestroStore(scope)

describe('scoped normalized Maestro store', () => {
 it('separates command, optimistic intent and canonical data; receipts never prove continuity',()=>{
  const store=make(), intent={threadId,clientEventId:'intent',content:[{type:'text' as const,text:'Olá'}]}
  store.optimistic(intent)
  store.publications({events:[],publications:[{threadId,clientEventId:'intent',state:'unknown'}]})
  expect(store.getThread(threadId)).toMatchObject({appliedSequence:'0',resumeCursor:null,optimisticByKey:{intent},commandsByKey:{intent:{state:'unknown'}}})
  const e=read(event(2));if(!e.known)throw Error();store.receipt(e.event)
  expect(store.getThread(threadId)?.eventIds).toEqual([e.event.eventId]);expect(store.getThread(threadId)?.appliedSequence).toBe('0')
  store.publications({events:[e.event],publications:[{threadId,clientEventId:'intent',state:'persisted',result:{threadId,clientEventId:'intent',eventId:e.event.eventId,event:e.event,cursor:'two',duplicate:false}}]})
  expect(store.getThread(threadId)?.optimisticByKey).toEqual({});expect(store.getThread(threadId)?.resumeCursor).toBeNull()
 })
 it('buffers out of order events and advances only the covered cursor checkpoint',()=>{
  const store=make();store.append(threadId,read(event(1)),'one');store.append(threadId,read(event(3)),'three')
  expect(store.getThread(threadId)).toMatchObject({appliedSequence:'1',receivedSequence:'3',resumeCursor:'one'})
  expect(store.caughtUp(threadId,'3','bad')).toBe(false)
  store.append(threadId,read(event(2)),'two');expect(store.getThread(threadId)).toMatchObject({appliedSequence:'3',resumeCursor:'three'})
  expect(store.caughtUp(threadId,'3','caught')).toBe(true)
  store.append(threadId,read(event(1)),'old');expect(store.getThread(threadId)?.resumeCursor).toBe('caught')
 })
 it('consumes more than 500 events, equal timestamps, and duplicate replay without dropping pages',()=>{
  const store=make()
  for(let offset=0;offset<650;offset+=100) {const end=Math.min(offset+100,650);store.page(threadId,Array.from({length:end-offset},(_,i)=>read(event(offset+i+1))),'650',end<650?`cursor-${end}`:null,end<650)}
  expect(store.caughtUp(threadId,'650','cursor-650')).toBe(true)
  store.page(threadId,[read(event(650))],'650',null,false)
  expect(store.getThread(threadId)?.eventIds).toHaveLength(650);expect(store.getThread(threadId)?.appliedSequence).toBe('650')
 })
 it('never converts large sequence to Number or mistakes 10 as less than 9',()=>{
  expect(compareMaestroSequences('10','9')).toBe(1);expect(compareMaestroSequences('9007199254740993','9007199254740992')).toBe(1)
  const store=make();store.append(threadId,read(event('9007199254740993')),'unsafe')
  expect(store.getThread(threadId)).toMatchObject({appliedSequence:'0',receivedSequence:'9007199254740993',resumeCursor:null})
  expect(JSON.stringify(store.getSnapshot())).toContain('9007199254740993')
 })
 it('keeps history before cursor independent and does not regress durable projections',()=>{
  const store=make();store.append(threadId,read(event(1)),'one');store.append(threadId,read(event(2)),'two')
  store.history(threadId,readMaestroNetworkPage({items:[event(1)],watermark:'2',next_cursor:'old-before',has_more:true}))
  expect(store.getThread(threadId)).toMatchObject({resumeCursor:'two',appliedSequence:'2',beforeCursor:'old-before',historyHasMore:true})
 })
 it('preserves snapshot membership while replaying older membership events',()=>{
  const store=make(), t=thread('2');t.participants[0].state='removed';t.participants[0].left_sequence='2'
  store.observeThread(toMaestroThread(t))
  const added=event(1,'participant.added');added.payload.participant=t.participants[0];added.payload.participant.state='active';added.payload.participant.left_sequence=null
  store.page(threadId,[read(added),read(event(2))],'2',null,false)
  expect(Object.values(store.getThread(threadId)!.participantsById)[0].state).toBe('removed')
 })
 it('projects independent delivery states and execution outcomes only after the gap is covered',()=>{
  const store=make(), started=event(2,'execution.started'), d=event(1,'delivery.updated')
  store.append(threadId,read(started),'two');expect(store.getThread(threadId)?.executionsById).toEqual({})
  store.append(threadId,read(d),'one');expect(store.getThread(threadId)?.hasPendingWork).toBe(true)
  const waiting=event(3,'delivery.updated');waiting.payload.delivery.state='waiting_input';store.append(threadId,read(waiting),'three')
  expect(store.getThread(threadId)).toMatchObject({hasPendingWork:false,waitingForInput:true});expect(Object.values(store.getThread(threadId)!.executionsById)[0].state).toBe('suspended')
  const failed=event(4,'delivery.updated');failed.payload.delivery.delivery_id=uuid(222);failed.payload.delivery.state='failed';store.append(threadId,read(failed),'four')
  expect(Object.keys(store.getThread(threadId)!.deliveriesById)).toHaveLength(2)
 })
 it('retains unknown durable envelopes for continuity without interpreting payload or actor as a capability',()=>{
  const store=make(), unknown={...event(1),type:'future.changed',payload:{capabilities:['admin'],text:'future'}}
  store.page(threadId,[read(unknown)],'1',null,false);expect(store.caughtUp(threadId,'1','one')).toBe(true)
  expect(store.getThread(threadId)?.eventsById[unknown.event_id]?.known).toBe(false);expect(store.getThread(threadId)?.executionsById).toEqual({})
 })
 it('refuses contradictory IDs, same sequence different ID, scope and order mismatches',()=>{
  const store=make();store.append(threadId,read(event(1)),'one')
  expect(()=>store.append(threadId,read({...event(1),payload:{...event(1).payload,content:[{type:'text',text:'changed'}]}}),'one')).toThrow(/Conflicting/)
  expect(()=>store.append(threadId,read({...event(1),event_id:uuid(9)}),'one')).toThrow(/Conflicting/)
  expect(()=>store.page(threadId,[read(event(3)),read(event(2))],'3',null,false)).toThrow(/order/)
  expect(()=>store.append(threadId,read({...event(2),thread_id:uuid(999)}),'two')).toThrow(/thread/)
  expect(()=>store.observeThread(toMaestroThread({...thread(),organization_id:uuid(999)}))).toThrow(/scope/)
 })
 it('clears all private thread material on revocation and rejects optimistic work',()=>{
  const store=make();store.append(threadId,read(event(1)),'one');store.revoke(threadId)
  expect(store.getThread(threadId)).toMatchObject({phase:'revoked',eventIds:[],resumeCursor:null,commandsByKey:{},participantsById:{}})
  expect(()=>store.optimistic({threadId,content:[],clientEventId:'x'})).toThrow(/revoked/)
  store.append(threadId,read(event(2)),'two');expect(store.getThread(threadId)?.eventIds).toEqual([])
 })
 it('bounds pending gaps and stored history without silently dropping accepted data',()=>{
  const store=new MaestroStore(scope,{maxBufferedEvents:1,maxEventsPerThread:2,maxThreads:1})
  store.append(threadId,read(event(2)),'two');expect(()=>store.append(threadId,read(event(3)),'three')).toThrow(/buffer/)
  expect(store.getThread(threadId)?.resumeCursor).toBeNull()
  expect(()=>store.receipt(read(event(4)).event as any)).toThrow(/memory/)
  expect(()=>store.patch(uuid(999),{phase:'idle'})).toThrow(/memory/)
 })
 it('a new snapshot clears unproven prior continuity while preserving unknown operations',()=>{
  const store=make();store.append(threadId,read(event(1)),'one');store.publications({events:[],publications:[{threadId,clientEventId:'unknown',state:'unknown'}]});store.restart(threadId,true)
  expect(store.getThread(threadId)).toMatchObject({appliedSequence:'0',resumeCursor:null,commandsByKey:{unknown:{state:'unknown'}}});expect(store.getThread(threadId)?.eventIds).toHaveLength(0)
 })
})

it('an unrelated publication update cannot repopulate persisted events or receipts after snapshot reset',()=>{
 const store=make(), own=read(event(1));if(!own.known)throw Error()
 const publication={threadId,clientEventId:'prior',state:'persisted' as const,result:{threadId,clientEventId:'prior',eventId:own.event.eventId,event:own.event,cursor:'one',duplicate:false}}
 store.receipt(own.event);store.publications({events:[own.event],publications:[publication]});store.restart(threadId,true)
 store.publications({events:[own.event],publications:[publication,{threadId:uuid(999),clientEventId:'new',state:'pending'}]})
 expect(store.getThread(threadId)?.eventIds).toEqual([]);expect(store.getThread(threadId)?.commandsByKey).toEqual({})
})
