// Maestro events and parts projected exactly like the production server sends them.
// tests/fixtures/maestro-legacy-parity.json comes from the server SDK parity suite
// (scripts/maestro-legacy-parity-fixture.py): production = run_legacy, Maestro = output_for.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { maestroMentions } from '../src/maestro-mentions'
import {
  foldMaestroEvents,
  type MaestroNameResolver,
  maestroEventToLegacy,
  maestroRunsToLegacy,
  maestroThreadToLegacy,
} from '../src/maestro-legacy'
import { MaestroAgentClient } from '../src/maestro-agent-client'
import { toMaestroNetworkEvent } from '../src/maestro/network'
import type { MaestroExecution } from '../src/maestro/store'
import {
  type MaestroEvent,
  toMaestroParticipant,
  toMaestroThread,
  validateMaestroContract,
} from '../src/protocol/maestro/contracts'
import type { WireRun, WireThreadEvent } from '../src/protocol/models'
import { createAgentStore } from '../src/store'
import { type ThreadEvent, toDisplayContentPart, toRun, toThreadEvent } from '../src/types'
import fixtures from '../vendor/maestro-v1/contracts/fixtures/v1/public.json'
import parity from './fixtures/maestro-legacy-parity.json'
import { credential } from './fixtures/maestro-credential'
import { event, fixture, scope, Socket, thread, threadId, tick, uuid } from './fixtures/maestro-replay'

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

// --- Exact production shape, from the server parity suite ---

const resolve: MaestroNameResolver = (kind, id) =>
  kind === 'agent' && id === parity.agent.instance_agent_id
    ? parity.agent.name
    : kind === 'human' && id === parity.human.principal_id
      ? parity.human.name
      : null

/** A stored Maestro event as the client receives it. It must be valid for the vendored contract. */
function received(wire: unknown): MaestroEvent {
  expect(validateMaestroContract('Public.Event', wire)).toBe(true)
  const item = toMaestroNetworkEvent(wire)
  if (!item.known) throw new Error('unknown event')
  return item.event
}

/**
 * The production ThreadEvent as the production client builds it from the wire (client.ts calls
 * toThreadEvent). The 0.20.0 client has no contact part (toDisplayContentPart returns undefined);
 * this task keeps the production wire part (brief: "contact vira a parte de contato do wire").
 */
function production(wire: unknown): ThreadEvent {
  const event = wire as WireThreadEvent
  return { ...toThreadEvent(event), content: event.content?.map((part) => toDisplayContentPart(part) ?? part) }
}

/**
 * What the production chat reads (chat-event.tsx): every field but `user`, whose only rendered
 * value is the sender name `author || user.userName` (and the user id of a person's message).
 * Production gives every other event an empty `User(user_id="")`. An absent `author` and `null` are
 * the same: the production wire drops None (serialize_frame exclude_none) and `ThreadEvent.author`
 * is `string | null`.
 */
function shown(event: ThreadEvent | null | undefined) {
  if (!event) return event
  const { user, author, ...rest } = event
  return {
    ...rest,
    sender: author || user?.userName || null,
    ...(event.actor === 'user' ? { userId: user?.userId } : {}),
  }
}

/** Folds the events (in the given arrival order) and projects the target event. */
function folded(events: unknown[], target: string): ThreadEvent | null {
  const item = foldMaestroEvents(events.map(received)).find((e) => e.eventId === target)
  return item ? maestroEventToLegacy({ known: true, event: item }, resolve) : null
}

describe('each new Maestro event is the ThreadEvent the production server sends', () => {
  it.each(parity.cases)('$name igual à produção', ({ maestro, production: wire }) => {
    expect(shown(maestroEventToLegacy({ known: true, event: received(maestro) }, resolve))).toEqual(
      shown(production(wire))
    )
  })
  it.each(parity.folds)('$name igual à produção', ({ maestro, target, production: wire }) => {
    expect(shown(folded(maestro, target))).toEqual(shown(production(wire)))
  })
  it.each(parity.folds)('$name: a ordem de chegada não muda o resultado', ({ maestro, target, production: wire }) => {
    expect(shown(folded([...maestro].reverse(), target))).toEqual(shown(production(wire)))
  })
  it.each(parity.receipts.steps)('WhatsApp receipt, $name', ({ events, production: delivery }) => {
    // Maestro has no error_code: channel_delivery.updated keeps only the error text (error_message).
    const { error_code: _code, ...expected } = delivery as Record<string, unknown>
    const legacy = folded(parity.receipts.maestro.slice(0, events), parity.receipts.target)
    expect(legacy?.data?.delivery).toEqual(expected)
  })
  it.each(parity.runs)('$name: run.updated is the production Run', ({ maestro, production: wire }) => {
    const run = toRun(wire as WireRun)
    expect(maestroRunsToLegacy(maestro.map(received))).toEqual([
      {
        ...run,
        // Absent and null are the same (exclude_none). Production leaves agent_id empty when
        // run_start names no agent; Maestro always records the agent that ran (contract).
        error: run.error ?? null,
        agentId: run.agentId ?? parity.agent.instance_agent_id,
      },
    ])
  })
})

const updateCase = parity.folds.find((c) => c.name === 'update_user_event')!
const receiptTarget = parity.receipts.target
const receiptEvents = parity.receipts.maestro
const deliveryUpdate = (status: string, sequence: number) => {
  const wire = structuredClone(receiptEvents.find((e) => e.type === 'channel_delivery.updated')!) as Record<string, any>
  wire.event_id = uuid(700 + sequence)
  wire.sequence = String(sequence)
  wire.payload = { ...wire.payload, status }
  return wire
}

describe('foldMaestroEvents', () => {
  it('edição que chega antes do original é aplicada', () => {
    const [original, , updated] = updateCase.maestro
    const events = foldMaestroEvents([received(updated), received(original)])
    expect(events.map((e) => e.type)).toEqual(['message.created'])
    expect(maestroEventToLegacy({ known: true, event: events[0]! })?.content).toEqual([
      { type: 'text', text: 'Olá (mensagem revisada)' },
    ])
  })
  it('the latest edit wins', () => {
    const [original, , updated] = updateCase.maestro
    const later = structuredClone(updated) as Record<string, any>
    later.event_id = uuid(801)
    later.sequence = '99'
    later.payload = { ...later.payload, content: [{ type: 'text', text: 'Segunda revisão' }] }
    const events = foldMaestroEvents([received(later), received(original), received(updated)])
    expect(maestroEventToLegacy({ known: true, event: events[0]! })?.content).toEqual([{ type: 'text', text: 'Segunda revisão' }])
  })
  it('message.removed takes the target out, also before the original arrives', () => {
    const [original] = updateCase.maestro
    const removed = structuredClone(updateCase.maestro[2]) as Record<string, any>
    removed.type = 'message.removed'
    removed.payload = { event_id: (original as { event_id: string }).event_id }
    expect(foldMaestroEvents([received(removed), received(original)])).toEqual([])
  })
  it('status de entrega não volta', () => {
    const base = receiptEvents.slice(0, 3) // run, message with route, accepted
    const legacy = folded([...base, deliveryUpdate('read', 50), deliveryUpdate('delivered', 51)], receiptTarget)
    expect(legacy?.data?.delivery).toMatchObject({ status: 'read' })
  })
  it('failed is final and a later read never replaces it', () => {
    const base = receiptEvents.slice(0, 3)
    const legacy = folded([...base, deliveryUpdate('failed', 50), deliveryUpdate('read', 51)], receiptTarget)
    expect(legacy?.data?.delivery).toMatchObject({ status: 'failed' })
  })
  it('the run a person message opened gives it its run id, like production', () => {
    const [original, run] = updateCase.maestro
    const events = foldMaestroEvents([received(original), received(run)])
    const human = events.find((e) => e.type === 'message.created')!
    expect(maestroEventToLegacy({ known: true, event: human })?.runId).toBe((run as { payload: { run_id: string } }).payload.run_id)
  })
})

describe('message, tool and run details of production', () => {
  const single = (name: string) => parity.cases.find((c) => c.name === name)!
  it('áudio do agente guarda refId', () => {
    const wire = structuredClone(single('audio').maestro) as Record<string, any>
    wire.payload.content = [{ type: 'attachment', artifact_id: uuid(60), filename: 'resposta.ogg', mime_type: 'audio/ogg', size_bytes: 10 }]
    expect(maestroEventToLegacy(toMaestroNetworkEvent(wire), resolve)?.content).toEqual([
      { type: 'audio', refId: uuid(60), filename: 'resposta.ogg', mimeType: 'audio/ogg', sizeBytes: 10 },
    ])
  })
  it('a tool event without display name or args keeps them null, as production data does', () => {
    const call = structuredClone(single('tool_call').maestro) as Record<string, any>
    delete call.payload.display_name
    expect(maestroEventToLegacy(toMaestroNetworkEvent(call), resolve)?.data).toEqual({
      id: 'call-42',
      name: 'buscar_pedido',
      display_name: null,
      args: { pedido: '42' },
    })
    const result = structuredClone(single('tool_result').maestro) as Record<string, any>
    delete result.payload.args
    expect(maestroEventToLegacy(toMaestroNetworkEvent(result), resolve)?.data).toMatchObject({ args: null })
  })
  it('an empty agent author falls back to the agent name, as production does', () => {
    const wire = structuredClone(single('text_author').maestro) as Record<string, any>
    wire.payload.author = ''
    expect(maestroEventToLegacy(toMaestroNetworkEvent(wire), resolve)?.author).toBe(parity.agent.name)
  })
  describe('run closure, strict parity with production', () => {
    const [start, end] = parity.runs[0]!.maestro
    const runId = (start as { payload: { run_id: string } }).payload.run_id
    /** The run's closing event, rewritten as a plain ``run_end`` (succeeded) or a failure. */
    const closing = (status: 'succeeded' | 'failed') => {
      const wire = structuredClone(end) as Record<string, any>
      wire.payload.status = status
      if (status === 'succeeded') delete wire.payload.error
      return received(wire)
    }
    it('a run with no closing run.updated stays running', () => {
      expect(maestroRunsToLegacy([received(start)])).toEqual([
        expect.objectContaining({ id: runId, status: 'running', endedAt: null, error: null }),
      ])
    })
    it.each(['succeeded', 'failed'] as const)('a run.updated with %s closes the run', (status) => {
      const closed = closing(status)
      const [run] = maestroRunsToLegacy([received(start), closed])
      expect(run).toMatchObject({ id: runId, status, endedAt: closed.createdAt })
      expect(run?.error ?? null).toBe(status === 'failed' ? (end as any).payload.error : null)
    })
  })
  it('the thread queue and channel reach the legacy thread', () => {
    const value = thread('1')
    Object.assign(value, { queue: 'suporte', channel: 'whatsapp', channel_meta: { instance_id: 'inst-1' } })
    const legacy = maestroThreadToLegacy(toMaestroThread(value), AGENT)
    expect(legacy.queue).toBe('suporte')
    expect(legacy.metadata).toMatchObject({ channel: 'whatsapp', channelMeta: { instance_id: 'inst-1' } })
    expect(maestroThreadToLegacy(toMaestroThread(thread('1')), AGENT)).toMatchObject({
      queue: null,
      metadata: { channel: 'dooers-platform' },
    })
  })
})

// --- MaestroAgentClient: runs, queue and production forms ---

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })

afterEach(() => vi.useRealTimers())

describe('MaestroAgentClient with production events', () => {
  async function setup(fetcher: ReturnType<typeof vi.fn>) {
    const store = createAgentStore()
    const sockets: Socket[] = []
    const client = new MaestroAgentClient(store.getState().actions, {
      endpoint: 'https://maestro.example',
      scope,
      authToken: credential(scope.principalId, scope.organizationId),
      threadListPollMs: 0,
      fetch: fetcher as unknown as typeof fetch,
      socketFactory: () => {
        const socket = new Socket()
        sockets.push(socket)
        return socket
      },
    })
    client.connect('ignored', AGENT, { organizationId: scope.organizationId, workspaceId: '', userId: scope.principalId })
    await tick()
    const socket = sockets.at(-1)!
    socket.open()
    await tick()
    socket.ackConnect()
    await tick()
    return { client, store, socket }
  }
  /** A fixture event moved into the contract-fixture thread, after the human message 1. */
  const inThread = (wire: unknown, sequence: number) => {
    const value = structuredClone(wire) as Record<string, any>
    value.thread_id = threadId
    value.sequence = String(sequence)
    return value
  }
  const formCase = parity.folds.find((c) => c.name === 'form_response_submit')!
  const formCreated = () => inThread(formCase.maestro.find((e) => e.type === 'form.created'), 2)
  const listOf = (items: unknown[]) => json({ items, next_cursor: null, has_more: false, watermark: '0' })

  it('run.updated upserts the production run in the store', async () => {
    const fetcher = vi.fn(async () => listOf([]))
    const { client, store, socket } = await setup(fetcher)
    client.subscribe(threadId)
    await tick()
    socket.ackSubscribe()
    const [start, end] = parity.runs[0]!.maestro
    socket.snapshot([event(1), inThread(start, 2)], '2')
    socket.caught('2')
    await tick()
    const runId = (start as { payload: { run_id: string } }).payload.run_id
    expect(store.getState().runs[threadId]?.find((r) => r.id === runId)).toMatchObject({ status: 'running', endedAt: null })
    socket.frame('event.append', { event: inThread(end, 3), cursor: 'three' })
    await tick()
    expect(store.getState().runs[threadId]?.find((r) => r.id === runId)).toMatchObject({
      status: 'failed',
      error: 'Serviço de pedidos indisponível',
    })
    client.disconnect()
  })
  it.each(['completed', 'failed', 'timed_out'] as const)(
    'an execution that %s without a closing run.updated leaves the production run running',
    async (state) => {
      const fetcher = vi.fn(async () => listOf([]))
      const { client, store, socket } = await setup(fetcher)
      client.subscribe(threadId)
      await tick()
      socket.ackSubscribe()
      const [start] = parity.runs[0]!.maestro
      const runStart = inThread(start, 2)
      const ended = structuredClone(runStart) as Record<string, any>
      Object.assign(ended, {
        event_id: uuid(70),
        sequence: '3',
        type: state === 'completed' ? 'execution.completed' : 'execution.failed',
        payload: {
          execution_id: runStart.execution_id,
          delivery_id: uuid(71),
          participant_id: runStart.actor.participant_id,
          phase_id: 'initial',
          state,
          outcome: state === 'completed' ? 'responded' : 'failed',
          reason_code: state === 'completed' ? null : 'deadline_exceeded',
          deadline_at: '2026-11-11T21:00:00Z',
          completed_at: '2026-11-11T21:00:00Z',
        },
      })
      socket.snapshot([event(1), runStart, ended], '3')
      socket.caught('3')
      await tick()
      const runId = (start as { payload: { run_id: string } }).payload.run_id
      expect(store.getState().runs[threadId]?.find((r) => r.id === runId)).toMatchObject({
        status: 'running',
        endedAt: null,
      })
      client.disconnect()
    }
  )
  it('thread.updated with a queue moves the legacy thread to that queue', async () => {
    const fetcher = vi.fn(async () => listOf([]))
    const { client, store, socket } = await setup(fetcher)
    client.subscribe(threadId)
    await tick()
    socket.ackSubscribe()
    socket.snapshot([event(1)], '1')
    socket.caught('1')
    await tick()
    const update = event(2, 'thread.updated')
    update.payload = { thread_id: threadId, title: 'Thread de contrato', state: 'active', version: 2, queue: 'suporte' }
    socket.frame('event.append', { event: update, cursor: 'two' })
    await tick()
    expect(store.getState().threads[threadId]?.queue).toBe('suporte')
    client.disconnect()
  })
  it('resposta de form.created usa a rota de forms', async () => {
    const created = formCreated()
    const responded = inThread(formCase.maestro.find((e) => e.type === 'form.responded'), 3)
    responded.actor = { kind: 'human', principal_id: scope.principalId, participant_id: uuid(4), display_name: 'Pessoa' }
    const fetcher = vi.fn(async (url: string, init?: RequestInit) =>
      init?.method === 'POST' ? json({ status: 'persisted', event: responded, cursor: 'c3', duplicate: false }, 201) : listOf([])
    )
    const { client, store, socket } = await setup(fetcher)
    client.subscribe(threadId)
    await tick()
    socket.ackSubscribe()
    socket.snapshot([event(1), created], '2')
    socket.caught('2')
    await tick()
    expect(store.getState().events[threadId]?.find((e) => e.id === created.event_id)).toMatchObject({ type: 'form' })
    await expect(
      client.sendFormResponse({ threadId, formEventId: created.event_id, cancelled: false, values: { nome: 'Ana', plano: 'pro' } })
    ).resolves.toEqual({ threadId })
    const post = fetcher.mock.calls.find(([, init]) => init?.method === 'POST')!
    expect(String(post[0])).toBe(`https://maestro.example/api/v1/threads/${threadId}/forms/${created.event_id}/responses`)
    expect(JSON.parse(String(post[1]?.body))).toEqual({ values: { nome: 'Ana', plano: 'pro' }, cancelled: false })
    expect((post[1]?.headers as Record<string, string>)['Idempotency-Key']).toBeTruthy()
    await tick()
    expect(store.getState().events[threadId]?.find((e) => e.id === responded.event_id)).toMatchObject({
      type: 'form.response',
      data: { form_event_id: created.event_id, cancelled: false, values: { nome: 'Ana', plano: 'pro' } },
    })
    client.disconnect()
  })
})
