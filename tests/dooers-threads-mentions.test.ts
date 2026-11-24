import { describe, expect, it } from 'vitest'
import { dooersThreadsMentions } from '../src/dooers-threads-mentions'
import type { DooersThreadsParticipant } from '../src/protocol/dooers-threads/contracts'

const agent = (participantId: string, instanceAgentId: string): DooersThreadsParticipant => ({
  participantId,
  principalId: instanceAgentId,
  displayName: 'Agente',
  state: 'active',
  joinedSequence: '1',
  leftSequence: null,
  kind: 'agent',
  role: 'member',
  instanceAgentId,
  capabilities: [],
  availability: 'unknown',
})
const human: DooersThreadsParticipant = {
  participantId: 'p-human',
  principalId: 'user-1',
  displayName: 'Humano',
  state: 'active',
  joinedSequence: '1',
  leftSequence: null,
  kind: 'human',
  role: 'owner',
}
const names: Record<string, string> = {
  'i-mkt': 'Agente de Marketing',
  'i-jur': 'Agente Jurídico',
  'i-m1': 'Agente Dooers Threads',
  'i-m2': 'Agente Dooers Threads 2',
}
const resolve = (_kind: 'human' | 'agent', id: string) => names[id]
const thread = [
  human,
  agent('p-mkt', 'i-mkt'),
  agent('p-jur', 'i-jur'),
  agent('p-m1', 'i-m1'),
  agent('p-m2', 'i-m2'),
]

describe('dooersThreadsMentions', () => {
  it('maps a full agent name to its participant id', () => {
    expect(dooersThreadsMentions('@Agente de Marketing, uma legenda?', thread, resolve)).toEqual([
      'p-mkt',
    ])
  })

  it('accepts the short name, any case and without accents', () => {
    expect(dooersThreadsMentions('oi @juridico e @MARKETING', thread, resolve)).toEqual([
      'p-jur',
      'p-mkt',
    ])
  })

  it('keeps text order and prefers the longest name', () => {
    expect(dooersThreadsMentions('@Agente Dooers Threads 2 depois @Agente Dooers Threads', thread, resolve)).toEqual([
      'p-m2',
      'p-m1',
    ])
  })

  it('turns @all / @todos / @todo into a mention of every agent, in join order', () => {
    const joined = [
      human,
      { ...agent('p-mkt', 'i-mkt'), joinedSequence: '3' },
      { ...agent('p-jur', 'i-jur'), joinedSequence: '2' },
    ]
    for (const text of ['@all bom dia', '@todos, bom dia', 'bom dia @todo', '@Marketing e @todos'])
      expect(dooersThreadsMentions(text, joined, resolve)).toEqual(['p-jur', 'p-mkt'])
  })

  it('ignores e-mails, unknown names and text without @', () => {
    expect(dooersThreadsMentions('escreva para ana@marketing.com', thread, resolve)).toEqual([])
    expect(dooersThreadsMentions('@Financeiro?', thread, resolve)).toEqual([])
    expect(dooersThreadsMentions('fale com o marketing', thread, resolve)).toEqual([])
  })

  it('does not mention removed agents', () => {
    const removed = { ...agent('p-mkt', 'i-mkt'), state: 'removed' as const }
    expect(dooersThreadsMentions('@marketing', [removed], resolve)).toEqual([])
  })
})

it('strict @all excludes suspended agents while preserving legacy parsing', () => {
  const suspended = {...agent('p-jur','i-jur'),state:'suspended' as const}
  const participants = [agent('p-mkt','i-mkt'),suspended]
  expect(dooersThreadsMentions('(@todos)',participants,resolve,true)).toEqual(['p-mkt'])
  expect(dooersThreadsMentions('(@todos)',participants,resolve)).toEqual(['p-jur','p-mkt'])
})
