import { beforeEach, expect, it } from 'vitest'
import { DooersThreadsOutbox } from '../src/dooers-threads-outbox'
import type { DooersThreadsSendInput } from '../src/dooers-threads/types'

beforeEach(() => localStorage.clear())
it('survives reload preserving publication identity, routing and model, isolated by scope', () => {
  const input: DooersThreadsSendInput = {threadId:'thread',clientEventId:'intent',content:[{type:'text',text:'@todos teste'}],routing:{mode:'all'},agentOptions:[{participant_id:'agent',model:'model-b'}]}
  new DooersThreadsOutbox('scope-a:',localStorage).put(input)
  const restored = new DooersThreadsOutbox('scope-a:',localStorage)
  expect(restored.entries()).toEqual([input])
  expect(new DooersThreadsOutbox('scope-b:',localStorage).entries()).toEqual([])
  restored.remove('intent')
  expect(restored.entries()).toEqual([])
})
it('does not overwrite a concurrent pending publication', () => {
  const a=new DooersThreadsOutbox('scope:',localStorage), b=new DooersThreadsOutbox('scope:',localStorage)
  a.put({threadId:'thread',clientEventId:'one',content:[]})
  b.put({threadId:'thread',clientEventId:'two',content:[]})
  a.remove('one')
  expect(b.entries().map(e=>e.clientEventId)).toEqual(['two'])
})
