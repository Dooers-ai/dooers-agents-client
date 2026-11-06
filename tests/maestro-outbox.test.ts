import { beforeEach, expect, it } from 'vitest'
import { MaestroOutbox } from '../src/maestro-outbox'
import type { MaestroSendInput } from '../src/maestro/types'

beforeEach(() => localStorage.clear())
it('survives reload preserving publication identity, routing and model, isolated by scope', () => {
  const input: MaestroSendInput = {threadId:'thread',clientEventId:'intent',content:[{type:'text',text:'@todos teste'}],routing:{mode:'all'},agentOptions:[{participant_id:'agent',model:'model-b'}]}
  new MaestroOutbox('scope-a:',localStorage).put(input)
  const restored = new MaestroOutbox('scope-a:',localStorage)
  expect(restored.entries()).toEqual([input])
  expect(new MaestroOutbox('scope-b:',localStorage).entries()).toEqual([])
  restored.remove('intent')
  expect(restored.entries()).toEqual([])
})
it('does not overwrite a concurrent pending publication', () => {
  const a=new MaestroOutbox('scope:',localStorage), b=new MaestroOutbox('scope:',localStorage)
  a.put({threadId:'thread',clientEventId:'one',content:[]})
  b.put({threadId:'thread',clientEventId:'two',content:[]})
  a.remove('one')
  expect(b.entries().map(e=>e.clientEventId)).toEqual(['two'])
})
