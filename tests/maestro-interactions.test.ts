import { afterEach, expect, it, vi } from 'vitest'
import { MaestroInteractions } from '../src/maestro/interactions'
import { MaestroStore } from '../src/maestro/store'
import { MaestroClientError } from '../src/maestro/types'
import { toMaestroEvent, toMaestroThread } from '../src/protocol/maestro/contracts'
import { connect, event, make, scope, thread, threadId, tick, uuid } from './fixtures/maestro-replay'
const disposers: (() => void)[] = []
afterEach(() => disposers.splice(0).forEach(close => close()))
import { interactionId, form, responded } from './fixtures/maestro-interaction'
const receipt = () => ({status:'persisted' as const,duplicate:false,cursor:'cursor-2',event:toMaestroEvent(responded())})
const manager = (send = vi.fn(async()=>receipt()), binder=vi.fn(async()=>{})) => { const store=new MaestroStore(scope);store.receipt(toMaestroEvent(form()));const manager=new MaestroInteractions(send,store.getSnapshot,1000,binder);disposers.push(()=>manager.clear());return {manager,store,send,binder} }
it('coalesces double submit into one stable key and never labels pending as a decision', async()=>{let finish!: (v:ReturnType<typeof receipt>)=>void;const {manager,send}=managerFactory(vi.fn(()=>new Promise(r=>{finish=r})));const a=manager.request(threadId,interactionId,{action:'submit',data:{name:'Ada'}}),b=manager.request(threadId,interactionId,{action:'submit',data:{name:'Ada'}});expect(a).toBe(b);expect(manager.getSnapshot()[0]?.state).toBe('pending');expect(manager.current(threadId,interactionId)?.state).toBe('pending');await tick();finish(receipt());await a;expect(send).toHaveBeenCalledTimes(1);expect(manager.getSnapshot()[0]?.state).toBe('persisted')})
const managerFactory = manager
it('unknown requires explicit retry, retains exact body/key across transports, and rejects a different decision',async()=>{const send=vi.fn().mockRejectedValueOnce(new Error('lost ACK')).mockResolvedValueOnce(receipt());const {manager}=managerFactory(send);await expect(manager.request(threadId,interactionId,{action:'submit',data:{name:'Ada'}},{transport:'http'})).rejects.toMatchObject({code:'NETWORK_ERROR'});expect(manager.getSnapshot()[0]?.state).toBe('unknown');await expect(manager.request(threadId,interactionId,{action:'cancel',data:{}})).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});await manager.retry(threadId,interactionId,{transport:'websocket'});expect(send.mock.calls[0]![0]).toEqual(send.mock.calls[1]![0]);expect(send.mock.calls[1]![1]).toBe('websocket')})
it('two consumers reconstruct the same first decision without publishing on replay/reload',async()=>{const a=managerFactory(),b=managerFactory();a.store.receipt(toMaestroEvent(responded()));b.store.receipt(toMaestroEvent(responded()));expect(a.manager.current(threadId,interactionId)).toEqual(b.manager.current(threadId,interactionId));expect(a.manager.current(threadId,interactionId)).toMatchObject({state:'submitted',waitingForInput:false,phaseId:interactionId});expect(a.send).not.toHaveBeenCalled();expect(b.send).not.toHaveBeenCalled();await expect(a.manager.request(threadId,interactionId,{action:'submit',data:{name:'Ada'}})).rejects.toMatchObject({code:'INTERACTION_ALREADY_RESPONDED'})})
it.each(['cancel','expired'] as const)('projects %s and forbids productive continuation', async terminal=>{const {manager,store,send}=managerFactory();if(terminal==='cancel')store.receipt(toMaestroEvent(responded('cancel')));else{const e=event(2,'interaction.expired');e.payload={interaction_id:interactionId,delivery_id:uuid(304)};store.receipt(toMaestroEvent(e))}expect(manager.current(threadId,interactionId)).toMatchObject({state:terminal==='cancel'?'canceled':'expired',waitingForInput:false,resuming:false});await expect(manager.request(threadId,interactionId,{action:'submit',data:{name:'Ada'}})).rejects.toMatchObject({code:'INTERACTION_ALREADY_RESPONDED'});expect(send).not.toHaveBeenCalled()})
it('rejects invalid fields and arbitrary URL/reference without consuming the form',async()=>{const {manager,send,binder}=managerFactory();for(const data of [{name:'Ada',extra:true},{name:22},{name:'Ada',file:['https://storage.invalid/x']},{name:'Ada',file:[uuid(309)]}])expect(()=>manager.request(threadId,interactionId,{action:'submit',data} as never)).toThrow();expect(send).not.toHaveBeenCalled();expect(manager.getSnapshot()).toEqual([]);await manager.bindArtifact(threadId,interactionId,'file',uuid(309));expect(binder).toHaveBeenCalledWith(threadId,interactionId,'file',uuid(309));await manager.request(threadId,interactionId,{action:'submit',data:{name:'Ada',file:[uuid(309)]}});expect(send).toHaveBeenCalledTimes(1)})
it('failed ACL binding cannot authorize a reference and another field cannot reuse one',async()=>{const binder=vi.fn().mockRejectedValueOnce(new MaestroClientError('FORBIDDEN','No ACL')).mockResolvedValueOnce(undefined);const {manager}=managerFactory(undefined,binder);await expect(manager.bindArtifact(threadId,interactionId,'file',uuid(309))).rejects.toMatchObject({code:'FORBIDDEN'});expect(()=>manager.request(threadId,interactionId,{action:'submit',data:{name:'Ada',file:[uuid(309)]}})).toThrow();await manager.bindArtifact(threadId,interactionId,'other',uuid(309));expect(()=>manager.request(threadId,interactionId,{action:'submit',data:{name:'Ada',file:[uuid(309)]}})).toThrow()})
it('preserves conflict until canonical decision; clearing scope fences a late ACK',async()=>{let finish!: (v:ReturnType<typeof receipt>)=>void;const {manager}=managerFactory(vi.fn(()=>new Promise(r=>{finish=r})));const p=manager.request(threadId,interactionId,{action:'submit',data:{name:'Ada'}});await tick();manager.clear();finish(receipt());await expect(p).rejects.toMatchObject({code:'FORBIDDEN'});expect(manager.getSnapshot()).toEqual([])})
it('conflict never offers a fresh key or overwrites the winner',async()=>{const {manager,send}=managerFactory(vi.fn().mockRejectedValue(new MaestroClientError('INTERACTION_ALREADY_RESPONDED','First wins')));await expect(manager.request(threadId,interactionId,{action:'submit',data:{name:'Ada'}})).rejects.toThrow();expect(manager.getSnapshot()[0]?.state).toBe('conflict');await expect(manager.request(threadId,interactionId,{action:'submit',data:{name:'Ada'}})).rejects.toThrow();expect(send).toHaveBeenCalledTimes(1)})
const authorized = async(fetch: typeof globalThis.fetch) => {
 const hostFetch: typeof globalThis.fetch = (input, init) => String(input).endsWith('/fields/artifacts') ? Promise.resolve(new Response(JSON.stringify({format_version:'maestro.interaction-artifacts.local.v1',interaction_id:interactionId,items:[]}),{headers:{'content-type':'application/json'}})) : fetch(input,init)
 const env=make({fetch:hostFetch,durableForms:true});disposers.push(()=>env.client.dispose());const socket=await connect(env.client,env.sockets)
 const config=env.client.getConnection();(env.client as any).setConnection({...config,capabilities:[...config.capabilities,'interactions.forms','attachments.durable']})
 const t=thread('1');t.capabilities.push('interactions.forms','attachments.durable');t.permissions.write=true;t.participants=[{participant_id:uuid(305),kind:'human',principal_id:scope.principalId,role:'owner',state:'active',joined_sequence:'1',left_sequence:null,display_name:'Human'}]
 env.client.store.observeThread(toMaestroThread(t));env.client.store.receipt(toMaestroEvent(form()));env.client.store.caughtUp(threadId,'0','cursor-0')
 await env.client.interactionUploads.restore(threadId,interactionId)
 return {...env,socket}
}
it('HTTP ACK tolerates additive public fields, validates shared projection, and can be retried via WS after lost ACK',async()=>{const fetch=vi.fn().mockRejectedValueOnce(new TypeError('lost after commit'));const {client,socket}=await authorized(fetch);await expect(client.interactions.request(threadId,interactionId,{action:'submit',data:{name:'Ada',private_note:'secret'}},{transport:'http'})).rejects.toThrow();const retry=client.interactions.retry(threadId,interactionId,{transport:'websocket'});await tick();const frame=socket.last('interaction.respond');expect(frame.payload.idempotency_key).toBe(client.interactions.getSnapshot()[0]?.intent.idempotencyKey);socket.receive({id:frame.id,type:'ack',payload:{status:'persisted',duplicate:true,cursor:'cursor-2',event:responded(),future:'compatible'}});await retry;expect(client.interactions.current(threadId,interactionId)?.state).toBe('submitted');expect(fetch).toHaveBeenCalledTimes(1)})
it.each(['wrong actor','wrong target','wrong phase','private shared data'])('rejects %s ACK without claiming success',async variant=>{const e=responded();if(variant==='wrong actor')e.actor.principal_id='other';if(variant==='wrong target')e.payload.interaction_id=uuid(999);if(variant==='wrong phase')e.payload.phase_id='initial';if(variant==='private shared data')e.payload.shared_data.private_note='secret';const {client}=await authorized(vi.fn(async()=>new Response(JSON.stringify({status:'persisted',duplicate:false,cursor:'cursor-2',event:e}),{headers:{'content-type':'application/json'}})));await expect(client.interactions.request(threadId,interactionId,{action:'submit',data:{name:'Ada',private_note:'secret'}},{transport:'http'})).rejects.toMatchObject({code:'PROTOCOL_ERROR'});expect(client.interactions.getSnapshot()[0]?.state).toBe('unknown');expect(client.interactions.current(threadId,interactionId)?.state).toBe('pending')})
it('capability off does not issue commands or change the legacy form surface',async()=>{const fetch=vi.fn();const {client,sockets}=make({fetch,durableForms:true});disposers.push(()=>client.dispose());await connect(client,sockets);client.store.receipt(toMaestroEvent(form()));await expect(client.interactions.request(threadId,interactionId,{action:'cancel',data:{}},{transport:'http'})).rejects.toMatchObject({code:'UNSUPPORTED_CAPABILITY'});expect(fetch).not.toHaveBeenCalled()})
it('a definitive validation rejection permits correction with a new key and rechecks current authorization',async()=>{const send=vi.fn().mockRejectedValueOnce(new MaestroClientError('VALIDATION_FAILED','Not consumed')).mockResolvedValueOnce(receipt());const {manager}=managerFactory(send);await expect(manager.request(threadId,interactionId,{action:'submit',data:{name:'Ada'}})).rejects.toMatchObject({code:'VALIDATION_FAILED'});expect(manager.getSnapshot()[0]?.state).toBe('rejected');await manager.request(threadId,interactionId,{action:'submit',data:{name:'Grace'}});expect(send.mock.calls[1]![0].request.data).toEqual({name:'Grace'});expect(send.mock.calls[1]![0].idempotencyKey).not.toBe(send.mock.calls[0]![0].idempotencyKey)})

// Public field names can coincide with Object.prototype; only submitted own values count.
const namedFieldManager = (name: string, type: 'text' | 'boolean', required: boolean) => {
  const store = new MaestroStore(scope)
  const created = form()
  created.payload.interaction.definition.fields = [{
    name,
    label: 'Public field',
    type,
    required,
    share_response: true,
    ...(type === 'text' ? { max_length: 20 } : {}),
  }]
  // Parsing the canonical public event also proves these names remain permitted by v1.
  store.receipt(toMaestroEvent(created))
  const instance = new MaestroInteractions(vi.fn(async () => receipt()), store.getSnapshot)
  disposers.push(() => instance.clear())
  return instance
}
for (const name of ['constructor', 'toString']) {
  for (const type of ['text', 'boolean'] as const) {
    it(`allows omitted optional ${type} field named ${name}`, () => {
      const instance = namedFieldManager(name, type, false)
      const result = instance.validate(threadId, interactionId, { action: 'submit', data: {} })
      expect(Object.keys(result.data)).toEqual([])
      expect(Object.hasOwn(result.data, name)).toBe(false)
    })
    it(`rejects unanswered required ${type} field named ${name}`, () => {
      const instance = namedFieldManager(name, type, true)
      expect(() => instance.validate(threadId, interactionId, { action: 'submit', data: {} }))
        .toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }))
    })
    it(`preserves own required ${type} answer named ${name}`, () => {
      const value = type === 'boolean' ? false : 'Ada'
      const instance = namedFieldManager(name, type, true)
      const result = instance.validate(threadId, interactionId, {
        action: 'submit', data: { [name]: value },
      })
      expect(Object.hasOwn(result.data, name)).toBe(true)
      expect(result.data[name]).toBe(value)
    })
  }
}
it('preserves ordinary required false and optional omitted fields', () => {
  const boolean = namedFieldManager('accepted', 'boolean', true)
  expect(boolean.validate(threadId, interactionId, {
    action: 'submit', data: { accepted: false },
  }).data).toEqual({ accepted: false })
  const optional = namedFieldManager('note', 'text', false)
  expect(optional.validate(threadId, interactionId, { action: 'submit', data: {} }).data).toEqual({})
})
