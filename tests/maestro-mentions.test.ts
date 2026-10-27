import { describe, expect, it } from 'vitest'
import { maestroMentions } from '../src/maestro-mentions'
import type { MaestroParticipant } from '../src/protocol/maestro/contracts'

const agent = (participantId: string, instanceAgentId: string): MaestroParticipant => ({
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
const human: MaestroParticipant = {
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
  'i-m1': 'Agente Maestro',
  'i-m2': 'Agente Maestro 2',
}
const resolve = (_kind: 'human' | 'agent', id: string) => names[id]
const thread = [
  human,
  agent('p-mkt', 'i-mkt'),
  agent('p-jur', 'i-jur'),
  agent('p-m1', 'i-m1'),
  agent('p-m2', 'i-m2'),
]

describe('maestroMentions', () => {
  it('maps a full agent name to its participant id', () => {
    expect(maestroMentions('@Agente de Marketing, uma legenda?', thread, resolve)).toEqual([
      'p-mkt',
    ])
  })

  it('accepts the short name, any case and without accents', () => {
    expect(maestroMentions('oi @juridico e @MARKETING', thread, resolve)).toEqual([
      'p-jur',
      'p-mkt',
    ])
  })

  it('keeps text order and prefers the longest name', () => {
    expect(maestroMentions('@Agente Maestro 2 depois @Agente Maestro', thread, resolve)).toEqual([
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
      expect(maestroMentions(text, joined, resolve)).toEqual(['p-jur', 'p-mkt'])
  })

  it('ignores e-mails, unknown names and text without @', () => {
    expect(maestroMentions('escreva para ana@marketing.com', thread, resolve)).toEqual([])
    expect(maestroMentions('@Financeiro?', thread, resolve)).toEqual([])
    expect(maestroMentions('fale com o marketing', thread, resolve)).toEqual([])
  })

  it('does not mention removed agents', () => {
    const removed = { ...agent('p-mkt', 'i-mkt'), state: 'removed' as const }
    expect(maestroMentions('@marketing', [removed], resolve)).toEqual([])
  })
})
