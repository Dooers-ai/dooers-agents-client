// Maestro events and parts projected exactly like the production server sends them.
import { describe, expect, it } from 'vitest'
import { maestroMentions } from '../src/maestro-mentions'
import { maestroEventToLegacy, maestroThreadToLegacy } from '../src/maestro-legacy'
import { toMaestroNetworkEvent } from '../src/maestro/network'
import { toMaestroParticipant, toMaestroThread } from '../src/protocol/maestro/contracts'
import fixtures from '../vendor/maestro-v1/contracts/fixtures/v1/public.json'
import { event, fixture, uuid } from './fixtures/maestro-replay'

const AGENT = uuid(40)
const agentActor = { kind: 'agent', principal_id: AGENT, instance_agent_id: AGENT, participant_id: uuid(20), display_name: 'Agente' }
const externalActor = { kind: 'external', external_id: '+5511999990000', channel: 'whatsapp', participant_id: uuid(30), display_name: 'Cliente' }
const externalParticipant = () =>
  structuredClone(
    fixtures.cases.find((c) => c.valid && c.schema === 'Public.Participant' && (c.data as { kind?: string }).kind === 'external')!.data
  )
const threadWithExternal = () => {
  const value = fixture('Public.Thread')
  value.participants.push(externalParticipant())
  return toMaestroThread(value)
}
const agentMessage = (content: unknown[]) => {
  const e = event(2)
  e.actor = agentActor
  e.payload = { content, mentions: [] }
  return e
}

describe('external participants (WhatsApp, public chat)', () => {
  it('a message from an external contact is a user message with the contact as user', () => {
    const e = event(1)
    e.actor = externalActor
    const legacy = maestroEventToLegacy(toMaestroNetworkEvent(e))
    expect(legacy).toMatchObject({ type: 'message', actor: 'user', author: null, content: [{ type: 'text', text: 'Olá' }] })
    expect(legacy?.user).toEqual({
      userId: '+5511999990000',
      userName: 'Cliente',
      userEmail: null,
      identityIds: [],
      systemRole: 'user',
      organizationRole: 'member',
      workspaceRole: 'member',
    })
  })
  it('without a display name the contact is named by its external id', () => {
    const e = event(1)
    e.actor = { kind: 'external', external_id: '+5511999990000', channel: 'whatsapp' }
    expect(maestroEventToLegacy(toMaestroNetworkEvent(e))?.user).toMatchObject({ userId: '+5511999990000', userName: '+5511999990000' })
  })
  it('the external participant keeps its id and channel, and becomes a legacy user', () => {
    const participant = toMaestroParticipant(externalParticipant())
    expect(participant).toMatchObject({ kind: 'external', externalId: '+5511999990000', channel: 'whatsapp', displayName: 'Cliente' })
    expect(participant).not.toHaveProperty('principalId')
    const thread = threadWithExternal()
    const external = thread.participants.find((p) => p.kind === 'external')
    expect(external).toBeDefined()
    const legacy = maestroThreadToLegacy(thread, AGENT)
    expect(legacy.users.map((u) => [u.userId, u.userName, u.systemRole])).toContainEqual(['+5511999990000', 'Cliente', 'user'])
    expect(legacy.metadata?.participants).toContainEqual({
      kind: 'external',
      participantId: external?.participantId,
      externalId: '+5511999990000',
      channel: 'whatsapp',
      displayName: 'Cliente',
    })
  })
  it('an external participant is not an agent recipient of mentions', () => {
    const thread = threadWithExternal()
    expect(thread.participants.some((p) => p.kind === 'external')).toBe(true)
    expect(maestroMentions('@Cliente olá', thread.participants)).toEqual([])
  })
})

describe('new content parts', () => {
  it('media_link becomes the production part of its kind, with the original URL', () => {
    const legacy = maestroEventToLegacy(
      toMaestroNetworkEvent(
        agentMessage([
          { type: 'media_link', kind: 'image', url: 'https://cdn.example.com/a.png', mime_type: 'image/png', alt: 'Gráfico', filename: 'a.png' },
          { type: 'media_link', kind: 'audio', url: 'https://cdn.example.com/a.ogg', mime_type: 'audio/ogg', duration: 3.5 },
          { type: 'media_link', kind: 'document', url: 'https://cdn.example.com/a.pdf', mime_type: 'application/pdf', filename: 'a.pdf' },
        ])
      )
    )
    expect(legacy?.content).toEqual([
      { type: 'image', url: 'https://cdn.example.com/a.png', mimeType: 'image/png', alt: 'Gráfico', filename: 'a.png' },
      { type: 'audio', url: 'https://cdn.example.com/a.ogg', mimeType: 'audio/ogg', duration: 3.5 },
      { type: 'document', url: 'https://cdn.example.com/a.pdf', mimeType: 'application/pdf', filename: 'a.pdf' },
    ])
  })
  it('contact becomes the contact part of the production wire', () => {
    const contact = { type: 'contact', display_name: 'Suporte', vcard: 'BEGIN:VCARD\nEND:VCARD', phones: [{ phone: '+551130000000', type: 'WORK' }] }
    expect(maestroEventToLegacy(toMaestroNetworkEvent(agentMessage([contact])))?.content).toEqual([contact])
    // Production ContactPart defaults: display_name "" and phones [] (vcard stays absent).
    expect(maestroEventToLegacy(toMaestroNetworkEvent(agentMessage([{ type: 'contact', display_name: 'Ana' }])))?.content).toEqual([
      { type: 'contact', display_name: 'Ana', phones: [] },
    ])
  })
})
