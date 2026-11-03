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

const failure = (status: number, code: string, details?: Record<string, unknown>) =>
  json({ error: { code, message: 'Falha', retryable: false, request_id: uuid(900), ...(details ? { details } : {}) } }, status)
/** A reader who is not a participant (supervision): only agents are listed. */
const supervisedThread = (sequence = '2', permissions: Record<string, boolean> = {}) => {
  const value = thread(sequence)
  value.participants = [agentParticipant(AGENT, uuid(20), 'Agente Um')]
  value.permissions = { ...value.permissions, write: false, manage: false, cancel: false, feedback: false, archive: true, remove_participants: true, ...permissions }
  return value
}
const grantFor = (n = 90, lifetime = 60_000) => ({ supervision_grant_id: uuid(n), thread_id: threadId, access: 'read_only', expires_at: new Date(Date.now() + lifetime).toISOString(), policy_version: 1 })
const grantOf = (init?: RequestInit) => (init?.headers as Record<string, string> | undefined)?.['Maestro-Supervision-Grant']

afterEach(() => { cleanup(); vi.useRealTimers() })

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
  it('maps archive and remove permissions and exposes the thread state to the chat', () => {
    const value = sharedThread('3')
    value.permissions = { ...value.permissions, archive: true, remove_participants: false }
    const legacy = maestroThreadToLegacy(toMaestroThread(value), AGENT)
    expect(legacy.access).toEqual({ read: true, write: true, manage: true, archive: true, removeParticipants: false })
    expect(legacy.metadata).toMatchObject({ authority: 'maestro', state: 'active' })
    value.state = 'archived'
    expect(maestroThreadToLegacy(toMaestroThread(value), AGENT).metadata).toMatchObject({ state: 'archived' })
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
  it('without maestro the legacy client connects to the agent runtime URL', async () => {
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
    // connect() awaits a fresh auth token before opening the socket.
    await act(tick)
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
    await act(tick)
    expect(opened).toEqual(['wss://agent.example/ws'])
    view.unmount()
    globalThis.WebSocket = original
  })
})

describe('MaestroAgentClient projects Maestro state into the legacy store', () => {
  async function setup(fetcher: ReturnType<typeof vi.fn>, extra: Record<string, unknown> = {}) {
    const store = createAgentStore()
    const sockets: Socket[] = []
    const client = new MaestroAgentClient(store.getState().actions, {
      endpoint: 'https://maestro.example',
      scope,
      authToken: credential(scope.principalId, scope.organizationId),
      threadListPollMs: 0,
      ...extra,
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
  it('applies the chosen model only to invoked recipients, including all, and rejects unknown models', async () => {
    localStorage.clear()
    const mine = {...sharedThread('1', [agentParticipant(AGENT, uuid(20), 'Financeiro'), agentParticipant(OTHER_AGENT, uuid(21), 'Analista')]), routing_version:1}
    const fetcher = vi.fn(async () => json({items:[mine],next_cursor:null,has_more:false,watermark:'1'}))
    const {client} = await setup(fetcher, {turnModels:['model-a','model-b']})
    await tick()
    const send = vi.spyOn(client.getMaestroClient()!, 'send').mockRejectedValue(new Error('transport'))
    await expect(client.sendMessage({threadId,text:'@Analista calcule',chatContext:{llmModel:'model-b'}})).rejects.toThrow()
    expect(send.mock.calls[0]?.[0].agentOptions).toEqual([{participant_id:uuid(21),model:'model-b'}])
    await expect(client.sendMessage({threadId,text:'@todos calculem',chatContext:{llmModel:'model-b'}})).rejects.toThrow()
    expect(send.mock.calls[1]?.[0].agentOptions).toEqual([{participant_id:uuid(20),model:'model-b'},{participant_id:uuid(21),model:'model-b'}])
    client.clearInvocationSelection(threadId)
    await expect(client.sendMessage({threadId,text:'nota',chatContext:{llmModel:'model-b'}})).rejects.toThrow()
    expect(send.mock.calls[2]?.[0].agentOptions).toBeUndefined()
    await expect(client.sendMessage({threadId,text:'@todos teste',chatContext:{llmModel:'unknown'}})).rejects.toThrow('Selected model')
    expect(send).toHaveBeenCalledTimes(3)
    client.disconnect()
    localStorage.clear()
  })

  it('retains @ selection per sender and thread; all is one-shot and clearing is explicit', async () => {
    localStorage.clear()
    const mine = {...sharedThread('1', [agentParticipant(AGENT, uuid(20), 'Financeiro'), agentParticipant(OTHER_AGENT, uuid(21), 'Analista')]), routing_version:1}
    const fetcher = vi.fn(async () => json({items:[mine],next_cursor:null,has_more:false,watermark:'1'}))
    const {client} = await setup(fetcher)
    await tick()
    const transport = client.getMaestroClient()!
    const send = vi.spyOn(transport,'send').mockRejectedValue(new Error('simulated unavailable transport'))
    expect(client.getInvocationSelection(threadId)).toMatchObject({mode:'none'})
    await expect(client.sendMessage({threadId,text:'@Analista calcule'})).rejects.toThrow()
    expect(send.mock.calls[0]?.[0].routing).toEqual({mode:'direct',recipients:[uuid(21)]})
    expect(client.getInvocationSelection(threadId)).toMatchObject({mode:'direct',recipients:[uuid(21)]})
    await expect(client.sendMessage({threadId,text:'continue'})).rejects.toThrow()
    expect(send.mock.calls[1]?.[0].routing).toEqual({mode:'direct',recipients:[uuid(21)]})
    await expect(client.sendMessage({threadId,text:'(@todos) opinem'})).rejects.toThrow()
    expect(send.mock.calls[2]?.[0].routing).toEqual({mode:'all'})
    expect(client.getInvocationSelection(threadId)).toMatchObject({recipients:[uuid(21)]})
    expect(client.getInvocationSelection(threadId, '@Inexistente ajude')).toMatchObject({invalid:true})
    expect(client.getInvocationSelection(threadId, '@Pessoa revise')).toMatchObject({mode:'none',invalid:false})
    await expect(client.sendMessage({threadId,text:'@Pessoa revise'})).rejects.toThrow()
    expect(send.mock.calls[3]?.[0].routing).toEqual({mode:'none'})
    expect(client.getInvocationSelection(threadId)).toMatchObject({mode:'none'})
    client.clearInvocationSelection(threadId)
    expect(client.getInvocationSelection(threadId)).toMatchObject({mode:'none'})
    client.disconnect()
    localStorage.clear()
  })

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
  it('removes a participant by its legacy user id through Maestro', async () => {
    const two = sharedThread('2', [agentParticipant(AGENT, uuid(20), 'Agente Um'), agentParticipant(OTHER_AGENT, uuid(21), 'Agente Dois')])
    const fetcher = vi.fn(async (url: string, init?: RequestInit) =>
      init?.method === 'DELETE' || url.includes(`/threads/${threadId}`)
        ? json(two)
        : json({ items: [two], next_cursor: null, has_more: false, watermark: '2' })
    )
    const { client, socket } = await setup(fetcher)
    client.subscribe(threadId)
    await tick()
    socket.ackSubscribe()
    socket.frame('thread.snapshot', { thread: two, events: [event(1)], watermark: '2', next_cursor: null, has_more: false })
    socket.caught('2')
    await tick()
    await expect(client.removeParticipant(threadId, OTHER_AGENT.toUpperCase())).resolves.toBe(true)
    const removal = fetcher.mock.calls.find(([, init]) => init?.method === 'DELETE')!
    expect(String(removal[0])).toBe(`https://maestro.example/api/v1/threads/${threadId}/participants/${uuid(21)}`)
    // Unknown users are not sent to the server.
    await expect(client.removeParticipant(threadId, uuid(77))).resolves.toBe(false)
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(1)
    client.disconnect()
  })
  it('legacy runtimes cannot remove participants', async () => {
    const errors: string[] = []
    const legacy = new AgentClient(createAgentStore().getState().actions)
    legacy.setOnError((e) => errors.push(e.code))
    await expect(legacy.removeParticipant(threadId, AGENT)).resolves.toBe(false)
    expect(errors).toEqual(['UNSUPPORTED'])
  })
  it('legacy runtimes refuse agent participants without sending a frame', async () => {
    const errors: string[] = []
    const legacy = new AgentClient(createAgentStore().getState().actions)
    legacy.setOnError((e) => errors.push(e.code))
    await expect(legacy.addParticipant(threadId, { userId: AGENT, kind: 'agent' })).resolves.toBe(false)
    expect(errors).toEqual(['UNSUPPORTED'])
  })
  it('archives and unarchives through PATCH with the current version in If-Match', async () => {
    const active = sharedThread('2')
    active.version = 4
    active.permissions = { ...active.permissions, archive: true }
    const fetcher = vi.fn(async (url: string, init?: RequestInit) =>
      url.includes(`/threads/${threadId}`) ? json(init?.method === 'PATCH' ? { ...active, version: 5, state: JSON.parse(String(init.body)).state } : active) : json({ items: [active], next_cursor: null, has_more: false, watermark: '2' })
    )
    const { client } = await setup(fetcher)
    await expect(client.archiveThread(threadId)).resolves.toBe(true)
    const archived = fetcher.mock.calls.find(([, init]) => init?.method === 'PATCH')!
    expect(String(archived[0])).toBe(`https://maestro.example/api/v1/threads/${threadId}`)
    expect(JSON.parse(String(archived[1]?.body))).toEqual({ state: 'archived' })
    expect(archived[1]?.headers).toMatchObject({ 'If-Match': '4' })
    await expect(client.unarchiveThread(threadId)).resolves.toBe(true)
    const patches = fetcher.mock.calls.filter(([, init]) => init?.method === 'PATCH')
    expect(JSON.parse(String(patches[1]![1]?.body))).toEqual({ state: 'active' })
    client.disconnect()
  })
  it('a refused archive is reported and keeps the session connected', async () => {
    const errors: string[] = []
    const fetcher = vi.fn(async (url: string, init?: RequestInit) =>
      init?.method === 'PATCH' ? failure(403, 'FORBIDDEN') : url.includes(`/threads/${threadId}`) ? json(sharedThread('2')) : json({ items: [], next_cursor: null, has_more: false, watermark: '0' })
    )
    const { client } = await setup(fetcher)
    client.setOnError((e) => errors.push(e.code))
    await expect(client.archiveThread(threadId)).resolves.toBe(false)
    expect(errors).toEqual(['FORBIDDEN'])
    expect(client.isConnected()).toBe(true)
    client.disconnect()
  })
  it('legacy runtimes cannot archive or unarchive', async () => {
    const errors: string[] = []
    const legacy = new AgentClient(createAgentStore().getState().actions)
    legacy.setOnError((e) => errors.push(e.code))
    await expect(legacy.archiveThread(threadId)).resolves.toBe(false)
    await expect(legacy.unarchiveThread(threadId)).resolves.toBe(false)
    expect(errors).toEqual(['UNSUPPORTED', 'UNSUPPORTED'])
  })

  describe('supervision of conversations the reader does not participate in', () => {
    const supervisionFetch = (view = supervisedThread(), issued = { count: 0 }) =>
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/supervision')) return json(grantFor(90 + issued.count++))
        if (url.includes(`/threads/${threadId}`))
          return grantOf(init) ? json(view) : failure(404, 'NOT_FOUND')
        return json({ items: [], next_cursor: null, has_more: false, watermark: '0' })
      })
    const posts = (fetcher: ReturnType<typeof vi.fn>) => fetcher.mock.calls.filter(([url]) => String(url).endsWith('/supervision'))
    const answerPings = (socket: Socket) => {
      const send = socket.send.bind(socket)
      socket.send = (data: string) => {
        send(data)
        const frame = JSON.parse(data)
        if (frame.type === 'ping') socket.receive({ id: frame.id, type: 'pong', payload: frame.payload })
      }
    }
    const settle = async (ms = 0) => { await vi.advanceTimersByTimeAsync(ms) }

    it('opens supervision with the reason, binds the subscription to the grant and projects read-only access', async () => {
      const view = supervisedThread('1')
      const fetcher = supervisionFetch(view)
      const { client, store, socket } = await setup(fetcher)
      client.subscribe(threadId, { accessReason: 'Auditoria de qualidade' })
      await vi.waitFor(() => expect(socket.sent.filter((f) => f.type === 'thread.subscribe')).toHaveLength(2))
      expect(JSON.parse(String(posts(fetcher)[0]![1]?.body))).toEqual({ access_reason: 'Auditoria de qualidade' })
      expect(socket.last('thread.subscribe').payload.supervision_grant_id).toBe(uuid(90))
      socket.ackSubscribe()
      socket.frame('thread.snapshot', { thread: view, events: [event(1)], watermark: '1', next_cursor: null, has_more: false })
      socket.caught('1')
      await tick()
      expect(store.getState().threads[threadId]?.access).toEqual({ read: true, write: false, manage: false, archive: true, removeParticipants: true })
      expect(store.getState().events[threadId]).toHaveLength(1)
      expect(client.getMaestroClient()?.isSupervision(threadId)).toBe(true)
      client.disconnect()
    })

    it('a participant never opens supervision', async () => {
      const mine = sharedThread('2')
      const fetcher = vi.fn(async (url: string) => (url.includes(`/threads/${threadId}`) ? json(mine) : json({ items: [mine], next_cursor: null, has_more: false, watermark: '2' })))
      const { client, socket } = await setup(fetcher)
      client.subscribe(threadId, { accessReason: 'não precisa' })
      await tick()
      expect(posts(fetcher)).toHaveLength(0)
      expect(socket.last('thread.subscribe').payload.supervision_grant_id).toBeUndefined()
      client.disconnect()
    })

    it('without a reason, a Maestro answer that requires one becomes ACCESS_REASON_REQUIRED and the session stays up', async () => {
      const errors: string[] = []
      const fetcher = vi.fn(async (url: string) => {
        if (url.endsWith('/supervision')) return failure(403, 'FORBIDDEN', { reason_code: 'access_reason_required' })
        if (url.includes(`/threads/${threadId}`)) return failure(404, 'NOT_FOUND')
        return json({ items: [], next_cursor: null, has_more: false, watermark: '0' })
      })
      const { client, store } = await setup(fetcher)
      client.setOnError((e) => errors.push(e.code))
      client.subscribe(threadId)
      await vi.waitFor(() => expect(errors).toEqual(['ACCESS_REASON_REQUIRED']))
      expect(posts(fetcher)).toHaveLength(1)
      expect(JSON.parse(String(posts(fetcher)[0]![1]?.body))).toEqual({})
      expect(client.isConnected()).toBe(true)
      expect(store.getState().subscriptions.has(threadId)).toBe(false)
      // The chat re-subscribes with the reason it just collected.
      fetcher.mockImplementation(supervisionFetch().getMockImplementation()!)
      client.subscribe(threadId, { accessReason: 'Motivo informado' })
      await vi.waitFor(() => expect(posts(fetcher)).toHaveLength(2))
      expect(JSON.parse(String(posts(fetcher)[1]![1]?.body))).toEqual({ access_reason: 'Motivo informado' })
      client.disconnect()
    })

    it('a Maestro error code ACCESS_REASON_REQUIRED is passed through as is', async () => {
      const errors: string[] = []
      const { MaestroClientError } = await import('../src/maestro/types')
      const { client } = await setup(supervisionFetch())
      client.getMaestroClient()!.openSupervision = async () => { throw new MaestroClientError('ACCESS_REASON_REQUIRED', 'reason') }
      client.setOnError((e) => errors.push(e.code))
      client.subscribe(threadId)
      await vi.waitFor(() => expect(errors).toEqual(['ACCESS_REASON_REQUIRED']))
      client.disconnect()
    })

    it('opens and renews supervision with the supervision credential, never with the chat credential', async () => {
      vi.useFakeTimers()
      const supervisionToken = credential(scope.principalId, scope.organizationId, { scopes: ['threads:read', 'threads:supervise'] })
      const bearer = (call: unknown[]) => (call[1] as RequestInit).headers as Record<string, string>
      const view = supervisedThread('1')
      const fetcher = supervisionFetch(view)
      const { client, socket } = await setup(fetcher, { supervisionAuthToken: () => supervisionToken })
      answerPings(socket)
      client.subscribe(threadId, { accessReason: 'Auditoria' })
      await settle(50)
      expect(posts(fetcher)).toHaveLength(1)
      expect(bearer(posts(fetcher)[0]!).Authorization).toBe(`Bearer ${supervisionToken}`)
      socket.ackSubscribe()
      socket.frame('thread.snapshot', { thread: view, events: [event(1)], watermark: '1', next_cursor: null, has_more: false })
      socket.caught('1')
      await settle(50_500)
      expect(posts(fetcher)).toHaveLength(2)
      expect(bearer(posts(fetcher)[1]!).Authorization).toBe(`Bearer ${supervisionToken}`)
      // Ordinary reads keep the chat credential.
      const reads = fetcher.mock.calls.filter(([url]) => !String(url).endsWith('/supervision'))
      expect(reads.some((call) => bearer(call).Authorization === `Bearer ${supervisionToken}`)).toBe(false)
      client.disconnect()
    })

    it('a 404 from the supervision (no elevation, or not visible) is NOT_FOUND, never ACCESS_REASON_REQUIRED', async () => {
      const errors: string[] = []
      const fetcher = vi.fn(async (url: string) => {
        if (url.endsWith('/supervision')) return failure(404, 'NOT_FOUND')
        if (url.includes(`/threads/${threadId}`)) return failure(404, 'NOT_FOUND')
        return json({ items: [], next_cursor: null, has_more: false, watermark: '0' })
      })
      const { client, store } = await setup(fetcher)
      client.setOnError((e) => errors.push(e.code))
      client.subscribe(threadId)
      await vi.waitFor(() => expect(errors).toEqual(['NOT_FOUND']))
      expect(store.getState().subscriptions.has(threadId)).toBe(false)
      client.disconnect()
    })

    it('a reader who cannot supervise gets the Maestro error and no subscription', async () => {
      const errors: string[] = []
      const fetcher = vi.fn(async (url: string) =>
        url.includes(`/threads/${threadId}`) ? failure(404, 'NOT_FOUND') : json({ items: [], next_cursor: null, has_more: false, watermark: '0' })
      )
      const { client, store } = await setup(fetcher)
      client.setOnError((e) => errors.push(e.code))
      client.subscribe(threadId, { accessReason: 'tentativa' })
      await vi.waitFor(() => expect(errors).toEqual(['NOT_FOUND']))
      expect(store.getState().subscriptions.has(threadId)).toBe(false)
      client.disconnect()
    })

    it('renews the grant 10 s before it expires, without repeating the reason, and rebinds the subscription', async () => {
      vi.useFakeTimers()
      const view = supervisedThread('1')
      const fetcher = supervisionFetch(view)
      const { client, socket } = await setup(fetcher)
      answerPings(socket)
      client.subscribe(threadId, { accessReason: 'Auditoria' })
      await settle(50)
      expect(posts(fetcher)).toHaveLength(1)
      socket.ackSubscribe()
      socket.frame('thread.snapshot', { thread: view, events: [event(1)], watermark: '1', next_cursor: null, has_more: false })
      socket.caught('1')
      await settle(48_000)
      expect(posts(fetcher)).toHaveLength(1)
      await settle(2_500)
      expect(posts(fetcher)).toHaveLength(2)
      expect(JSON.parse(String(posts(fetcher)[1]![1]?.body))).toEqual({})
      await settle(500)
      const rebound = socket.sent.filter((f) => f.type === 'thread.subscribe')
      expect(rebound.at(-1)!.payload.supervision_grant_id).toBe(uuid(91))
      // Still the same conversation after the original 60 s window.
      await settle(15_000)
      expect(client.getMaestroClient()?.isSupervision(threadId)).toBe(true)
      expect(client.getMaestroClient()?.store.getThread(threadId)?.phase).not.toBe('revoked')
      client.disconnect()
    })

    it('a renewal that runs after the grant lapsed subscribes again from scratch', async () => {
      vi.useFakeTimers()
      const view = supervisedThread('1')
      const fetcher = supervisionFetch(view)
      const { client, socket } = await setup(fetcher)
      answerPings(socket)
      client.subscribe(threadId, { accessReason: 'Auditoria' })
      await settle(50)
      socket.ackSubscribe()
      socket.frame('thread.snapshot', { thread: view, events: [event(1)], watermark: '1', next_cursor: null, has_more: false })
      socket.caught('1')
      await settle(0)
      // The 60 s window ended while timers were suspended: the Maestro client already wiped the thread.
      client.getMaestroClient()!.closeThread(threadId)
      expect(client.getMaestroClient()!.store.getThread(threadId)?.phase).toBe('revoked')
      await settle(50_000)
      expect(posts(fetcher)).toHaveLength(2)
      await settle(100)
      expect(socket.last('thread.subscribe').payload.supervision_grant_id).toBe(uuid(91))
      client.disconnect()
    })

    it('a transient renewal failure is retried while the current grant is still valid', async () => {
      vi.useFakeTimers()
      const errors: string[] = []
      let calls = 0
      const view = supervisedThread('1')
      const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/supervision')) {
          const call = calls++
          return call === 1
            ? json({ error: { code: 'CORE_UNAVAILABLE', message: 'Indisponível', retryable: true, request_id: uuid(900) } }, 503)
            : json(grantFor(90 + call))
        }
        if (url.includes(`/threads/${threadId}`)) return grantOf(init) ? json(view) : failure(404, 'NOT_FOUND')
        return json({ items: [], next_cursor: null, has_more: false, watermark: '0' })
      })
      const { client, socket } = await setup(fetcher)
      answerPings(socket)
      client.setOnError((e) => errors.push(e.code))
      client.subscribe(threadId, { accessReason: 'Auditoria' })
      await settle(50)
      await settle(50_000)
      expect(posts(fetcher)).toHaveLength(2)
      await settle(3_100)
      expect(posts(fetcher)).toHaveLength(3)
      expect(errors).toEqual([])
      expect(client.getMaestroClient()?.isSupervision(threadId)).toBe(true)
      client.disconnect()
    })

    it('stops renewing once the chat leaves the conversation', async () => {
      vi.useFakeTimers()
      const fetcher = supervisionFetch()
      const { client, socket } = await setup(fetcher)
      answerPings(socket)
      client.subscribe(threadId, { accessReason: 'Auditoria' })
      await settle(50)
      expect(posts(fetcher)).toHaveLength(1)
      client.unsubscribe(threadId)
      expect(client.getMaestroClient()?.isSupervision(threadId)).toBe(false)
      await settle(200_000)
      expect(posts(fetcher)).toHaveLength(1)
      client.disconnect()
    })

    it('a renewal refused for lack of reason drops the conversation and asks for the reason again', async () => {
      vi.useFakeTimers()
      const errors: string[] = []
      let calls = 0
      const view = supervisedThread()
      const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/supervision')) return calls++ === 0 ? json(grantFor(90)) : failure(403, 'FORBIDDEN', { reason_code: 'access_reason_required' })
        if (url.includes(`/threads/${threadId}`)) return grantOf(init) ? json(view) : failure(404, 'NOT_FOUND')
        return json({ items: [], next_cursor: null, has_more: false, watermark: '0' })
      })
      const { client, store, socket } = await setup(fetcher)
      answerPings(socket)
      client.setOnError((e) => errors.push(e.code))
      client.subscribe(threadId, { accessReason: 'Auditoria' })
      await settle(50)
      await settle(51_000)
      expect(errors).toEqual(['ACCESS_REASON_REQUIRED'])
      expect(store.getState().subscriptions.has(threadId)).toBe(false)
      expect(client.getMaestroClient()?.isSupervision(threadId)).toBe(false)
      expect(client.isConnected()).toBe(true)
      client.disconnect()
    })

    it('a supervisor with archive permission archives without participating; one without it is refused locally', async () => {
      const errors: string[] = []
      const view = supervisedThread('1')
      view.version = 6
      const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/supervision')) return json(grantFor(90))
        if (url.includes(`/threads/${threadId}`))
          return init?.method === 'PATCH' ? json({ ...view, version: 7, state: 'archived' }) : grantOf(init) ? json(view) : failure(404, 'NOT_FOUND')
        return json({ items: [], next_cursor: null, has_more: false, watermark: '0' })
      })
      const { client, socket } = await setup(fetcher)
      client.setOnError((e) => errors.push(e.code))
      client.subscribe(threadId, { accessReason: 'Auditoria' })
      await vi.waitFor(() => expect(socket.sent.filter((f) => f.type === 'thread.subscribe')).toHaveLength(2))
      socket.ackSubscribe()
      socket.frame('thread.snapshot', { thread: view, events: [event(1)], watermark: '1', next_cursor: null, has_more: false })
      socket.caught('1')
      await tick()
      await expect(client.archiveThread(threadId)).resolves.toBe(true)
      const patch = fetcher.mock.calls.find(([, init]) => init?.method === 'PATCH')!
      expect(patch[1]?.headers).toMatchObject({ 'If-Match': '6' })
      expect(grantOf(patch[1])).toBeUndefined()
      // Without the archive permission the request never leaves the browser.
      view.permissions = { ...view.permissions, archive: false }
      await client.getMaestroClient()!.getThread(threadId)
      const before = fetcher.mock.calls.filter(([, init]) => init?.method === 'PATCH').length
      await expect(client.unarchiveThread(threadId)).resolves.toBe(false)
      expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(before)
      expect(errors).toEqual(['FORBIDDEN'])
      client.disconnect()
    })

    it('after adding itself as a participant the reader leaves supervision and subscribes as a participant', async () => {
      const view = supervisedThread('1', { manage: true })
      const joined = sharedThread('1')
      let added = false
      const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/supervision')) return json(grantFor(90))
        if (url.endsWith('/participants')) { added = true; return json(joined) }
        if (url.includes(`/threads/${threadId}`)) return added ? json(joined) : grantOf(init) ? json(view) : failure(404, 'NOT_FOUND')
        return json({ items: [], next_cursor: null, has_more: false, watermark: '0' })
      })
      const { client, store, socket } = await setup(fetcher)
      client.subscribe(threadId, { accessReason: 'Auditoria' })
      await vi.waitFor(() => expect(socket.sent.filter((f) => f.type === 'thread.subscribe')).toHaveLength(2))
      socket.ackSubscribe()
      socket.frame('thread.snapshot', { thread: view, events: [event(1)], watermark: '1', next_cursor: null, has_more: false })
      socket.caught('1')
      await tick()
      expect(store.getState().threads[threadId]?.access?.write).toBe(false)
      await expect(client.addParticipant(threadId, { userId: scope.principalId })).resolves.toBe(true)
      expect(client.getMaestroClient()?.isSupervision(threadId)).toBe(false)
      await vi.waitFor(() => expect(socket.sent.filter((f) => f.type === 'thread.subscribe')).toHaveLength(3))
      expect(socket.last('thread.subscribe').payload.supervision_grant_id).toBeUndefined()
      socket.ackSubscribe(uuid(102))
      socket.frame('thread.snapshot', { thread: joined, events: [event(1)], watermark: '1', next_cursor: null, has_more: false }, uuid(102))
      socket.caught('1', uuid(102))
      await tick()
      expect(store.getState().threads[threadId]?.access?.write).toBe(true)
      client.disconnect()
    })
  })
})
