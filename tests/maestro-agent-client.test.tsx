import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentClient } from '../src/client'
import { useConnection } from '../src/hooks/use-connection'
import { toMaestroThread } from '../src/protocol/maestro/contracts'
import { toMaestroNetworkEvent } from '../src/maestro/network'
import { MaestroAgentClient } from '../src/maestro-agent-client'
import {
  legacyContentToMaestro,
  legacyFormValuesToMaestro,
  MAESTRO_AGENT_ROLE,
  maestroEventToLegacy,
  maestroExecutionToRun,
  maestroFormToLegacyData,
  maestroLegacyServerVersion,
  maestroThreadHasAgent,
  maestroThreadToLegacy,
} from '../src/maestro-legacy'
import { AgentProvider, useAgentContext } from '../src/provider'
import { createAgentStore } from '../src/store'
import { credential } from './fixtures/maestro-credential'
import { event, fixture, scope, Socket, thread, threadId, tick, uuid } from './fixtures/maestro-replay'

const AGENT = uuid(40)
const OTHER_AGENT = uuid(41)
const agentParticipant = (id: string, participant: string, name: string) => ({
  participant_id: participant,
  kind: 'agent',
  principal_id: id,
  instance_agent_id: id,
  display_name: name,
  role: 'member',
  state: 'active',
  joined_sequence: '1',
  left_sequence: null,
  capabilities: ['messages.text'],
  availability: 'available',
})
const sharedThread = (sequence = '0', agents = [agentParticipant(AGENT, uuid(20), 'Agente Um')]) => {
  const value = thread(sequence)
  value.participants = [...value.participants, ...agents]
  return value
}
const agentMessage = (sequence: number, text: string, agent = AGENT, participant = uuid(20), name = 'Agente Um') => {
  const e = event(sequence)
  e.actor = { kind: 'agent', principal_id: agent, instance_agent_id: agent, participant_id: participant, display_name: name }
  e.payload = { content: [{ type: 'text', text }], mentions: [] }
  return e
}
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })

afterEach(() => cleanup())

function fakeWebSocket(opened: string[]): typeof WebSocket {
  return class {
    static OPEN = 1
    readyState = 0
    onopen = null
    onmessage = null
    onclose = null
    onerror = null
    constructor(url: string) {
      opened.push(url)
    }
    close() {}
    send() {}
  } as unknown as typeof WebSocket
}

describe('Maestro → legacy mapping', () => {
  it('maps participants to legacy users, flags agents and keeps reader permissions', () => {
    const legacy = maestroThreadToLegacy(
      toMaestroThread(sharedThread('3', [agentParticipant(AGENT, uuid(20), 'Agente Um'), agentParticipant(OTHER_AGENT, uuid(21), 'Agente Dois')])),
      AGENT
    )
    expect(legacy).toMatchObject({ id: threadId, agentId: AGENT, title: 'Thread de contrato', access: { read: true, write: true, manage: true } })
    expect(legacy.owner).toMatchObject({ userId: 'auth0|human-fixture', userName: 'Pessoa', systemRole: 'user' })
    expect(legacy.users.map((u) => [u.userId, u.userName, u.systemRole])).toEqual([
      ['auth0|human-fixture', 'Pessoa', 'user'],
      [AGENT, 'Agente Um', MAESTRO_AGENT_ROLE],
      [OTHER_AGENT, 'Agente Dois', MAESTRO_AGENT_ROLE],
    ])
  })
  it('resolves real names for the generic Maestro display names', () => {
    const resolve = (kind: 'human' | 'agent', id: string) =>
      kind === 'agent' && id === OTHER_AGENT ? 'Agente Maestro 2' : kind === 'human' ? 'Ana' : null
    const legacy = maestroThreadToLegacy(toMaestroThread(sharedThread('1', [agentParticipant(AGENT, uuid(20), 'Agente'), agentParticipant(OTHER_AGENT, uuid(21), 'Agente')])), AGENT, resolve)
    expect(legacy.users.map((u) => u.userName)).toEqual(['Ana', 'Agente', 'Agente Maestro 2'])
    expect(maestroEventToLegacy(toMaestroNetworkEvent(agentMessage(2, 'Oi', OTHER_AGENT, uuid(21), 'Agente')), resolve)?.author).toBe('Agente Maestro 2')
    expect(maestroEventToLegacy(toMaestroNetworkEvent(event(1)), resolve)?.user?.userName).toBe('Ana')
  })
  it('a thread belongs to every participating agent and not to removed ones', () => {
    const value = toMaestroThread(sharedThread('1', [agentParticipant(AGENT, uuid(20), 'A'), { ...agentParticipant(OTHER_AGENT, uuid(21), 'B'), state: 'removed', left_sequence: '2' }]))
    expect(maestroThreadHasAgent(value, AGENT.toUpperCase())).toBe(true)
    expect(maestroThreadHasAgent(value, OTHER_AGENT)).toBe(false)
    expect(maestroThreadHasAgent(toMaestroThread(thread()), AGENT)).toBe(false)
  })
  it('human messages carry the user, agent messages carry the agent name as author', () => {
    const human = maestroEventToLegacy(toMaestroNetworkEvent(event(1)))
    expect(human).toMatchObject({ type: 'message', actor: 'user', author: null, clientEventId: 'intent-1', user: { userId: 'auth0|human-fixture', userName: 'Pessoa' }, content: [{ type: 'text', text: 'Olá' }] })
    const reply = maestroEventToLegacy(toMaestroNetworkEvent(agentMessage(2, 'Oi', OTHER_AGENT, uuid(21), 'Agente Dois')))
    expect(reply).toMatchObject({ type: 'message', actor: 'assistant', author: 'Agente Dois', content: [{ type: 'text', text: 'Oi' }] })
    expect(reply?.user).toBeUndefined()
    expect(maestroEventToLegacy(toMaestroNetworkEvent(event(3, 'delivery.updated')))).toBeNull()
  })
  it('attachments map both ways through artifact ids', () => {
    expect(legacyContentToMaestro({ content: [{ type: 'text', text: 'veja' }, { type: 'document', refId: uuid(50), filename: 'a.pdf', mimeType: 'application/pdf' }] })).toEqual([
      { type: 'text', text: 'veja' },
      { type: 'attachment', artifact_id: uuid(50), filename: 'a.pdf', mime_type: 'application/pdf' },
    ])
    expect(legacyContentToMaestro({ text: '   ' })).toEqual([])
    const e = event(4)
    e.payload.content = [{ type: 'attachment', artifact_id: uuid(51), filename: 'foto.png', mime_type: 'image/png', size_bytes: 10 }]
    expect(maestroEventToLegacy(toMaestroNetworkEvent(e))?.content).toEqual([{ type: 'image', refId: uuid(51), filename: 'foto.png', alt: 'foto.png', mimeType: 'image/png' }])
  })
  it('durable forms become legacy form events and legacy values become Maestro data', () => {
    const fields = [
      { name: 'nome', label: 'Nome', required: true, share_response: true, type: 'text', max_length: 100 },
      { name: 'idade', label: 'Idade', required: false, share_response: true, type: 'number', minimum: 0, maximum: 120 },
      { name: 'aceite', label: 'Aceito', required: false, share_response: true, type: 'boolean' },
      { name: 'cor', label: 'Cor', required: true, share_response: true, type: 'select', options: [{ value: 'az', label: 'Azul' }] },
    ]
    const data = maestroFormToLegacyData({ title: 'Cadastro', fields })
    expect(data).toMatchObject({ message: 'Cadastro', elements: [{ type: 'text_input', name: 'nome' }, { type: 'text_input', input_type: 'number' }, { type: 'checkbox_input', options: [{ value: 'true' }] }, { type: 'select_input', options: [{ value: 'az', label: 'Azul' }] }] })
    expect(legacyFormValuesToMaestro(fields, { nome: 'Ana', idade: '31', aceite: ['true'], cor: 'az' })).toEqual({ nome: 'Ana', idade: 31, aceite: true, cor: 'az' })
    expect(legacyFormValuesToMaestro(fields, { nome: '', aceite: [] })).toEqual({ nome: null, aceite: false, cor: null })
    const created = fixture('Public.Event.interaction.created')
    const mapped = maestroEventToLegacy(toMaestroNetworkEvent(created))
    if (created.payload.interaction.definition.kind === 'form') expect(mapped).toMatchObject({ type: 'form', id: created.payload.interaction.interaction_id })
    else expect(mapped).toBeNull()
  })
  it('executions become runs; failures keep the reason', () => {
    const base = { execution_id: uuid(60), delivery_id: uuid(61), participant_id: uuid(20), phase_id: 'p', outcome: null, reason_code: null, deadline_at: '2026-10-13T15:00:00Z', completed_at: null }
    expect(maestroExecutionToRun({ ...base, state: 'running' } as never, threadId, AGENT, 'now')).toMatchObject({ status: 'running', agentId: AGENT, error: null })
    expect(maestroExecutionToRun({ ...base, state: 'failed', outcome: 'failed', reason_code: 'RUNTIME_ERROR', completed_at: 'x' } as never, threadId, AGENT, 'now')).toMatchObject({ status: 'failed', error: 'RUNTIME_ERROR' })
    expect(maestroLegacyServerVersion('0.1.0')).toBe('0.22.0+maestro.0.1.0')
  })
})

describe('AgentProvider transport switch', () => {
  function Probe({ onReady }: { onReady: (value: { client: AgentClient; transport: string }) => void }) {
    const { client } = useAgentContext()
    const { transport } = useConnection()
    onReady({ client, transport })
    return null
  }
  it('without maestro the legacy client connects to the agent runtime URL', () => {
    const sockets: string[] = []
    const original = globalThis.WebSocket
    globalThis.WebSocket = fakeWebSocket(sockets)
    let seen: { client: AgentClient; transport: string } | undefined
    const view = render(
      <AgentProvider url="wss://agent.example/ws" agentId={AGENT}>
        <Probe onReady={(v) => { seen = v }} />
      </AgentProvider>
    )
    expect(seen?.transport).toBe('legacy')
    expect(seen?.client).not.toBeInstanceOf(MaestroAgentClient)
    expect(sockets).toEqual(['wss://agent.example/ws'])
    view.unmount()
    globalThis.WebSocket = original
  })
  it('with maestro the same hooks use the Maestro client and never open the runtime URL', async () => {
    const opened: string[] = []
    const original = globalThis.WebSocket
    globalThis.WebSocket = fakeWebSocket(opened)
    const sockets: Socket[] = []
    let seen: { client: AgentClient; transport: string } | undefined
    const maestro = {
      endpoint: 'https://maestro.example',
      scope,
      authToken: credential(scope.principalId, scope.organizationId),
      threadListPollMs: 0,
      fetch: vi.fn(async () => json({ items: [], next_cursor: null, has_more: false, watermark: '0' })),
      socketFactory: () => {
        const socket = new Socket()
        sockets.push(socket)
        return socket
      },
    }
    const view = render(
      <AgentProvider url="wss://agent.example/ws" agentId={AGENT} maestro={maestro}>
        <Probe onReady={(v) => { seen = v }} />
      </AgentProvider>
    )
    await act(tick)
    expect(seen?.transport).toBe('maestro')
    expect(seen?.client).toBeInstanceOf(MaestroAgentClient)
    expect(opened).toEqual([])
    expect(sockets).toHaveLength(1)
    // Removing the Maestro option switches back to an isolated legacy client.
    view.rerender(
      <AgentProvider url="wss://agent.example/ws" agentId={AGENT}>
        <Probe onReady={(v) => { seen = v }} />
      </AgentProvider>
    )
    expect(seen?.transport).toBe('legacy')
    expect(opened).toEqual(['wss://agent.example/ws'])
    view.unmount()
    globalThis.WebSocket = original
  })
})

describe('MaestroAgentClient projects Maestro state into the legacy store', () => {
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
  it('lists only threads of the selected agent, then streams messages with per-agent authorship', async () => {
    const mine = sharedThread('2', [agentParticipant(AGENT, uuid(20), 'Agente Um'), agentParticipant(OTHER_AGENT, uuid(21), 'Agente Dois')])
    const foreign = { ...thread('1'), thread_id: uuid(99) }
    const fetcher = vi.fn(async (url: string) =>
      url.includes(`/threads/${threadId}`) ? json(mine) : json({ items: [mine, foreign], next_cursor: null, has_more: false, watermark: '2' })
    )
    const { client, store, socket } = await setup(fetcher)
    await tick()
    expect(store.getState().connection).toMatchObject({ status: 'connected', serverVersion: '0.22.0+maestro.0.0.0' })
    expect(store.getState().threadOrder).toEqual([threadId])
    expect(store.getState().threads[threadId]?.users.map((u) => u.userName)).toEqual(['Pessoa', 'Agente Um', 'Agente Dois'])

    client.subscribe(threadId)
    await tick()
    expect(store.getState().loadingThreads.has(threadId)).toBe(true)
    socket.ackSubscribe()
    socket.frame('thread.snapshot', { thread: mine, events: [event(1), agentMessage(2, 'Resposta do um')], watermark: '2', next_cursor: null, has_more: false })
    socket.caught('2')
    await tick()
    expect(store.getState().loadingThreads.has(threadId)).toBe(false)
    expect(store.getState().events[threadId]?.map((e) => [e.actor, e.author])).toEqual([
      ['user', null],
      ['assistant', 'Agente Um'],
    ])
    socket.frame('event.append', { event: agentMessage(3, 'Resposta do dois', OTHER_AGENT, uuid(21), 'Agente Dois'), cursor: 'three' })
    await tick()
    expect(store.getState().events[threadId]?.at(-1)).toMatchObject({ author: 'Agente Dois', content: [{ type: 'text', text: 'Resposta do dois' }] })
    client.disconnect()
    expect(store.getState().connection.status).toBe('disconnected')
  })
  it('adds an agent participant through Maestro and refreshes the list', async () => {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) =>
      init?.method === 'POST' || url.includes(`/threads/${threadId}`)
        ? json(sharedThread('3'))
        : json({ items: [], next_cursor: null, has_more: false, watermark: '0' })
    )
    const { client } = await setup(fetcher)
    await expect(client.addParticipant(threadId, { userId: OTHER_AGENT.toUpperCase(), kind: 'agent' })).resolves.toBe(true)
    const post = fetcher.mock.calls.find(([, init]) => init?.method === 'POST')!
    expect(String(post[0])).toBe(`https://maestro.example/api/v1/threads/${threadId}/participants`)
    expect(JSON.parse(String(post[1]?.body))).toEqual({ kind: 'agent', principal_id: OTHER_AGENT, role: 'member' })
    client.disconnect()
  })
  it('legacy runtimes refuse agent participants without sending a frame', async () => {
    const errors: string[] = []
    const legacy = new AgentClient(createAgentStore().getState().actions)
    legacy.setOnError((e) => errors.push(e.code))
    await expect(legacy.addParticipant(threadId, { userId: AGENT, kind: 'agent' })).resolves.toBe(false)
    expect(errors).toEqual(['UNSUPPORTED'])
  })
})
