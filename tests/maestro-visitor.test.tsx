import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MaestroClient } from '../src/maestro/client'
import { MaestroClientError } from '../src/maestro/types'
import { MaestroAgentClient } from '../src/maestro-agent-client'
import { AgentProvider, useAgentContext } from '../src/provider'
import { createAgentStore } from '../src/store'
import {
  visitorCredential,
  visitorExternalId,
  visitorInstanceAgent,
  visitorPrincipalId,
} from './fixtures/maestro-credential'
import { event, scope as humanScope, Socket, thread, threadId, tick, uuid } from './fixtures/maestro-replay'

const org = humanScope.organizationId
const visitorScope = {
  principalId: visitorPrincipalId,
  organizationId: org,
  workspaceId: null,
  actorType: 'external' as const,
}
const API = 'https://maestro.example/api/v1'
const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } })
const failure = (status: number, code: string, details?: Record<string, unknown>, headers: Record<string, string> = {}) =>
  json(
    { error: { code, message: 'Falha', retryable: status === 429, request_id: uuid(900), ...(details ? { details } : {}) } },
    status,
    headers
  )

const visitorParticipant = {
  participant_id: uuid(70),
  kind: 'external',
  external_id: visitorExternalId,
  channel: 'public_chat',
  display_name: 'Visitante',
  role: 'member',
  state: 'active',
  joined_sequence: '1',
  left_sequence: null,
}
const agentParticipant = {
  participant_id: uuid(71),
  kind: 'agent',
  principal_id: visitorInstanceAgent,
  instance_agent_id: visitorInstanceAgent,
  display_name: 'Agente',
  role: 'member',
  state: 'active',
  joined_sequence: '1',
  left_sequence: null,
  capabilities: ['messages.text'],
  availability: 'available',
}
/** The thread of a public chat visitor: the visitor and the agent of the link; permissions of a reader who writes. */
const visitorThread = (sequence = '1') => {
  const value = thread(sequence)
  value.participants = [visitorParticipant, agentParticipant]
  value.permissions = { ...value.permissions, manage: false, export: false, cancel: false, feedback: false, archive: false, remove_participants: false }
  value.channel = 'dooers-public-chat'
  value.channel_meta = { public_chat_label: 'Link do site' }
  return value
}
const externalActor = { kind: 'external', external_id: visitorExternalId, channel: 'public_chat', connection_type: 'guest', participant_id: uuid(70) }
const visitorMessage = (sequence: number, clientEventId: string, text = 'Olá') => {
  const e = event(sequence)
  e.actor = externalActor
  e.payload = { content: [{ type: 'text', text }], client_event_id: clientEventId, mentions: [] }
  return e
}
const agentReply = (sequence: number, text: string) => {
  const e = event(sequence)
  e.actor = { kind: 'agent', principal_id: visitorInstanceAgent, instance_agent_id: visitorInstanceAgent, participant_id: uuid(71), display_name: 'Agente' }
  e.payload = { content: [{ type: 'text', text }], mentions: [] }
  return e
}
const formEvent = (sequence: number) => {
  const e = event(sequence, 'form.created')
  e.actor = { kind: 'agent', principal_id: visitorInstanceAgent, instance_agent_id: visitorInstanceAgent, participant_id: uuid(71), display_name: 'Agente' }
  return e
}
const formResponded = (sequence: number, formEventId: string, values: Record<string, unknown>) => {
  const e = event(sequence, 'form.responded')
  e.actor = externalActor
  e.payload = { form_event_id: formEventId, values, cancelled: false }
  return e
}

interface Call {
  method: string
  path: string
  headers: Record<string, string>
  body: unknown
}
/** The Maestro of a visitor: its own routes answer, anything else is recorded as refused. */
function maestroServer(options: { existing?: boolean; ensureStatus?: number; ensure?: () => Response; formEventId?: string } = {}) {
  const calls: Call[] = []
  const refused: Call[] = []
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname.replace('/api/v1', '')
    const call: Call = {
      method: init?.method ?? 'GET',
      path: path + new URL(url).search,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    }
    calls.push(call)
    if (path === '/public-chat/thread' && call.method === 'GET')
      return options.existing ? json(visitorThread()) : failure(404, 'NOT_FOUND')
    if (path === '/public-chat/thread' && call.method === 'POST') {
      if (options.ensure) return options.ensure()
      return json({ ...visitorThread(), permissions: { read: false, write: false, manage: false, supervise: false, export: false, cancel: false, feedback: false, archive: false, remove_participants: false } }, options.ensureStatus ?? (options.existing ? 200 : 201))
    }
    if (path === `/threads/${threadId}` && call.method === 'GET') return json(visitorThread())
    if (path === `/threads/${threadId}/forms/${options.formEventId}/responses` && call.method === 'POST') {
      const body = call.body as { values: Record<string, unknown> }
      return json({ status: 'persisted', event: formResponded(9, options.formEventId!, body.values), cursor: 'c9', duplicate: false }, 201)
    }
    refused.push(call)
    return failure(403, 'FORBIDDEN')
  })
  return { fetcher, calls, refused }
}

const sockets: Socket[] = []
async function setup(server: ReturnType<typeof maestroServer>, extra: Record<string, unknown> = {}) {
  const store = createAgentStore()
  const client = new MaestroAgentClient(store.getState().actions, {
    endpoint: 'https://maestro.example',
    scope: visitorScope,
    authToken: visitorCredential(org),
    visitor: true,
    ...extra,
    fetch: server.fetcher as unknown as typeof fetch,
    socketFactory: () => {
      const socket = new Socket()
      sockets.push(socket)
      return socket
    },
  })
  client.connect('ignored', visitorInstanceAgent, { organizationId: org, workspaceId: '', userId: '' })
  await tick()
  const socket = sockets.at(-1)!
  socket.open()
  await tick()
  socket.ackConnect()
  await tick()
  await tick()
  return { client, store, socket }
}
/** Answers the pending `message.publish` command as the Maestro does: the persisted event of the visitor. */
let sequence = 4
function ackPublish(socket: Socket, text?: string) {
  const frame = socket.last('message.publish')
  const sent = (frame.payload.content as { text: string }[])[0]!.text
  socket.receive({
    id: frame.id,
    type: 'ack',
    payload: { status: 'persisted', event: visitorMessage(++sequence, frame.payload.client_event_id, text ?? sent), cursor: `c${sequence}`, duplicate: false },
  })
  return frame
}

afterEach(() => {
  cleanup()
  sockets.length = 0
  localStorage.clear()
  vi.useRealTimers()
})

describe('visitor mode: closed routes', () => {
  it('never lists threads, reads participants or opens supervision', async () => {
    const server = maestroServer({ existing: true })
    const resolveName = vi.fn(() => 'Nome')
    const { client, store } = await setup(server, { threadListPollMs: 5, resolveName, supervisionAuthToken: visitorCredential(org) })
    client.subscribe(threadId)
    await tick()
    client.requestThreadList()
    client.loadMoreThreads()
    await client.addParticipant(threadId, { userId: uuid(5), kind: 'agent' })
    await client.removeParticipant(threadId, uuid(5))
    await client.archiveThread(threadId)
    await client.unarchiveThread(threadId)
    client.deleteThread(threadId)
    client.sendFeedback('event', uuid(6), 'like')
    await new Promise((resolve) => setTimeout(resolve, 40))
    const paths = server.calls.map((c) => `${c.method} ${c.path}`)
    expect(paths.some((p) => /^GET \/threads(\?|$)/.test(p))).toBe(false)
    expect(paths.some((p) => /participants|supervis/.test(p))).toBe(false)
    expect(server.refused).toEqual([])
    expect(resolveName).not.toHaveBeenCalled()
    expect(store.getState().connection.status).toBe('connected')
    client.disconnect()
  })

  it('an unreadable thread is reported and never read by supervision', async () => {
    const server = maestroServer()
    server.fetcher.mockImplementation(async (url: string) =>
      new URL(url).pathname.endsWith('/public-chat/thread') ? failure(404, 'NOT_FOUND') : failure(404, 'NOT_FOUND')
    )
    const errors: string[] = []
    const { client } = await setup(server)
    client.setOnError((error) => errors.push(error.code))
    client.subscribe(threadId)
    await tick()
    await tick()
    const urls = server.fetcher.mock.calls.map(([url]) => String(url))
    expect(urls.some((url) => /supervis/.test(url))).toBe(false)
    expect(errors).toContain('NOT_FOUND')
    client.disconnect()
  })

  it('never takes the legacy (non-visitor) options into the connection: forms stay HTTP', async () => {
    const server = maestroServer()
    const { client, socket } = await setup(server, { forms: true, turnModels: ['model-a'] })
    const connect = socket.last('connect')
    expect(connect.payload.client_capabilities).not.toContain('interactions.forms')
    expect(connect.payload.client_capabilities).not.toContain('chat_context.per_agent')
    client.disconnect()
  })
})

describe('visitor mode: thread lifecycle', () => {
  it('GET 404, then POST ensure at the first message, then publish', async () => {
    const server = maestroServer()
    const { client, store, socket } = await setup(server)
    expect(server.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /public-chat/thread'])
    expect(client.getVisitorThreadId()).toBeNull()

    const sending = client.sendMessage({ text: 'Oi' })
    await tick()
    await tick()
    expect(server.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /public-chat/thread',
      'POST /public-chat/thread',
      `GET /threads/${threadId}`,
    ])
    const frame = ackPublish(socket, 'Oi')
    await expect(sending).resolves.toEqual({ threadId })
    expect(frame.payload).toMatchObject({ thread_id: threadId, content: [{ type: 'text', text: 'Oi' }] })
    expect(client.getVisitorThreadId()).toBe(threadId)
    expect(store.getState().threads[threadId]).toMatchObject({ id: threadId, access: { read: true, write: true } })
    expect(store.getState().threads[threadId]?.metadata).toMatchObject({ channel: 'dooers-public-chat', channelMeta: { public_chat_label: 'Link do site' } })
    client.disconnect()
  })

  it('GET found: the thread is listed at the start and the first message still sends POST (200) once per session', async () => {
    const server = maestroServer({ existing: true })
    const { client, store, socket } = await setup(server)
    expect(server.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /public-chat/thread'])
    expect(store.getState().threadOrder).toEqual([threadId])
    expect(client.getVisitorThreadId()).toBe(threadId)

    client.subscribe(threadId)
    await tick()
    socket.ackSubscribe()
    socket.frame('thread.snapshot', { thread: visitorThread(), events: [], watermark: '1', next_cursor: null, has_more: false })
    socket.caught('1')
    await tick()

    const first = client.sendMessage({ text: 'Primeira', threadId })
    await tick()
    await tick()
    const posts = () => server.calls.filter((c) => c.method === 'POST' && c.path === '/public-chat/thread')
    expect(posts()).toHaveLength(1)
    ackPublish(socket, 'Primeira')
    await first

    const second = client.sendMessage({ text: 'Segunda', threadId })
    await tick()
    await tick()
    expect(posts()).toHaveLength(1)
    ackPublish(socket, 'Segunda')
    await second
    client.disconnect()
  })

  it('a new session of the client posts again at its first message', async () => {
    const server = maestroServer({ existing: true })
    const one = await setup(server)
    const first = one.client.sendMessage({ text: 'A', threadId })
    await tick()
    await tick()
    ackPublish(one.socket, 'A')
    await first
    one.client.disconnect()
    const two = await setup(server)
    const again = two.client.sendMessage({ text: 'B', threadId })
    await tick()
    await tick()
    ackPublish(two.socket, 'B')
    await again
    expect(server.calls.filter((c) => c.method === 'POST' && c.path === '/public-chat/thread')).toHaveLength(2)
    two.client.disconnect()
  })

  it('POST carries an Idempotency-Key and a body with only the declared pre-chat, no empty fields', async () => {
    const server = maestroServer()
    const { client, socket } = await setup(server)
    const sending = client.sendMessage({
      text: 'Oi',
      metadata: { guest_name: ' Ana ', guest_email: '', guest_phone: undefined, label: 'x', channel: 'y' },
    })
    await tick()
    await tick()
    const post = server.calls.find((c) => c.method === 'POST' && c.path === '/public-chat/thread')!
    expect(post.headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/)
    expect(post.body).toEqual({ guest: { name: 'Ana' } })
    ackPublish(socket)
    await sending
    client.disconnect()
  })

  it('POST body is empty when there is no pre-chat and never carries label, channel, key, external id or title', async () => {
    const server = maestroServer()
    const { client, socket } = await setup(server)
    const sending = client.sendMessage({ text: 'Oi', metadata: { guest_name: '  ', guest_email: '', guest_phone: '' } })
    await tick()
    await tick()
    const post = server.calls.find((c) => c.method === 'POST' && c.path === '/public-chat/thread')!
    expect(post.body).toEqual({})
    ackPublish(socket)
    await sending
    client.disconnect()
  })

  it('uses the pre-chat of the option when the first message carries no metadata, and the metadata wins when it has it', async () => {
    const server = maestroServer()
    const { client, socket } = await setup(server, { visitor: { guest: { name: 'Base', email: 'base@example.com', phone: null } } })
    const sending = client.sendMessage({ text: 'Oi', metadata: { guest_name: 'Nova' } })
    await tick()
    await tick()
    const post = server.calls.find((c) => c.method === 'POST' && c.path === '/public-chat/thread')!
    expect(post.body).toEqual({ guest: { name: 'Nova', email: 'base@example.com' } })
    ackPublish(socket)
    await sending
    client.disconnect()
  })

  it('a failed ensure leaves the message unsent and the next message tries the ensure again', async () => {
    let attempts = 0
    const server = maestroServer({ ensure: () => (++attempts === 1 ? failure(400, 'INVALID_REQUEST') : json(visitorThread(), 201)) })
    const { client, socket } = await setup(server)
    await expect(client.sendMessage({ text: 'Oi' })).rejects.toBeInstanceOf(MaestroClientError)
    expect(socket.sent.some((f) => f.type === 'message.publish')).toBe(false)
    const again = client.sendMessage({ text: 'Oi de novo' })
    await tick()
    await tick()
    ackPublish(socket, 'Oi de novo')
    await expect(again).resolves.toEqual({ threadId })
    expect(server.calls.filter((c) => c.method === 'POST' && c.path === '/public-chat/thread')).toHaveLength(2)
    client.disconnect()
  })

  it('an ensure refused with 429 and a long Retry-After surfaces RATE_LIMITED with the seconds and is not retried', async () => {
    const server = maestroServer({ ensure: () => failure(429, 'RATE_LIMITED', undefined, { 'Retry-After': '7' }) })
    const { client, store } = await setup(server)
    const failed = await client.sendMessage({ text: 'Oi' }).catch((cause: unknown) => cause)
    expect(failed).toBeInstanceOf(MaestroClientError)
    expect(failed).toMatchObject({ code: 'RATE_LIMITED', retryable: true, retryAfterSeconds: 7 })
    expect(store.getState().connection.sendError).toBeTruthy()
    expect(server.calls.filter((c) => c.method === 'POST' && c.path === '/public-chat/thread')).toHaveLength(1)
    client.disconnect()
  })

  it('an ensure refused with 429 and Retry-After up to 3 s waits and retries once with the same Idempotency-Key', async () => {
    let attempts = 0
    const server = maestroServer({ ensure: () => (++attempts === 1 ? failure(429, 'RATE_LIMITED', undefined, { 'Retry-After': '1' }) : json(visitorThread(), 201)) })
    const { client, socket } = await setup(server)
    const startedAt = Date.now()
    const sending = client.sendMessage({ text: 'Oi' })
    await new Promise((resolve) => setTimeout(resolve, 1100))
    await tick()
    ackPublish(socket, 'Oi')
    await expect(sending).resolves.toEqual({ threadId })
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1000)
    const posts = server.calls.filter((c) => c.method === 'POST' && c.path === '/public-chat/thread')
    expect(posts).toHaveLength(2)
    expect(posts[1]!.headers['Idempotency-Key']).toBe(posts[0]!.headers['Idempotency-Key'])
    client.disconnect()
  })

  it('an ensure that is still 429 after the one retry surfaces the error', async () => {
    const server = maestroServer({ ensure: () => failure(429, 'RATE_LIMITED', undefined, { 'Retry-After': '0' }) })
    const { client } = await setup(server)
    await expect(client.sendMessage({ text: 'Oi' })).rejects.toMatchObject({ code: 'RATE_LIMITED', retryAfterSeconds: 0 })
    expect(server.calls.filter((c) => c.method === 'POST' && c.path === '/public-chat/thread')).toHaveLength(2)
    client.disconnect()
  })

  it('trims the pre-chat, drops control characters and omits a field that ends up empty', async () => {
    const server = maestroServer()
    const { client, socket } = await setup(server)
    const sending = client.sendMessage({
      text: 'Oi',
      metadata: { guest_name: '\t Ana\u0000 Maria\n ', guest_email: ' ana@example.com\r\n', guest_phone: '\u0001\u001f \t' },
    })
    await tick()
    await tick()
    const post = server.calls.find((c) => c.method === 'POST' && c.path === '/public-chat/thread')!
    expect(post.body).toEqual({ guest: { name: 'Ana Maria', email: 'ana@example.com' } })
    ackPublish(socket)
    await sending
    client.disconnect()
  })
})

describe('visitor mode: publish, forms and 429 on the Maestro client', () => {
  const caps = () => json({ protocol_version: 1, schema_version: 1, server_version: '0.0.0', history_authority: 'maestro', capabilities: ['messages.text', 'threads.shared', 'history.replay'] })
  const http = (handler: (url: string, init?: RequestInit) => Response | Promise<Response>) => {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => (new URL(url).pathname.endsWith('/capabilities') ? caps() : handler(url, init)))
    const client = new MaestroClient({
      mode: 'maestro',
      endpoint: 'https://maestro.example',
      transport: 'http',
      scope: visitorScope,
      authToken: visitorCredential(org),
      maxReconnectAttempts: 0,
      fetch: fetcher as unknown as typeof fetch,
    })
    return { client, fetcher }
  }
  it('accepts the receipt of the visitor (external actor with the visitor id) and refuses another external contact', async () => {
    const { client } = http((url, init) => {
      const body = JSON.parse(String(init?.body)) as { client_event_id: string }
      return json({ status: 'persisted', event: visitorMessage(5, body.client_event_id), cursor: 'c5', duplicate: false }, 201)
    })
    await client.connect()
    const result = await client.send({ threadId, content: [{ type: 'text', text: 'Olá' }], clientEventId: 'intent-1' })
    expect(result).toMatchObject({ threadId, clientEventId: 'intent-1', duplicate: false })
    client.dispose()

    const other = http((url, init) => {
      const body = JSON.parse(String(init?.body)) as { client_event_id: string }
      const e = visitorMessage(5, body.client_event_id)
      e.actor = { ...externalActor, external_id: 'guest:BBBBBBBBBBBBBBBBBBBBBB' }
      return json({ status: 'persisted', event: e, cursor: 'c5', duplicate: false }, 201)
    })
    await other.client.connect()
    await expect(other.client.send({ threadId, content: [{ type: 'text', text: 'Olá' }], clientEventId: 'intent-2' })).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
    other.client.dispose()
  })

  it('publish over the link limit: 429 RATE_LIMITED with Retry-After, retryable, state rejected', async () => {
    const { client, fetcher } = http(() => failure(429, 'RATE_LIMITED', undefined, { 'Retry-After': '12' }))
    await client.connect()
    const failed = await client.send({ threadId, content: [{ type: 'text', text: 'Olá' }], clientEventId: 'intent-3' }).catch((cause: unknown) => cause)
    expect(failed).toMatchObject({ code: 'RATE_LIMITED', retryable: true, retryAfterSeconds: 12, publicationState: 'rejected', threadId, clientEventId: 'intent-3' })
    const post = fetcher.mock.calls.find(([url]) => String(url).endsWith(`/threads/${threadId}/events`))!
    expect((post[1]?.headers as Record<string, string>)['Idempotency-Key']).toBe('intent-3')
    expect(client.getConnection().status).toBe('connected')
    client.dispose()
  })

  it('takes Retry-After from the error details when the header is absent, and from a WebSocket error frame', async () => {
    const { client } = http(() => failure(429, 'RATE_LIMITED', { retry_after_seconds: 30 }))
    await client.connect()
    await expect(client.send({ threadId, content: [{ type: 'text', text: 'Olá' }], clientEventId: 'intent-4' })).rejects.toMatchObject({ code: 'RATE_LIMITED', retryAfterSeconds: 30 })
    client.dispose()

    const server = maestroServer({ existing: true })
    const { client: agent, socket } = await setup(server)
    const sending = agent.sendMessage({ text: 'Oi', threadId })
    await tick()
    await tick()
    const frame = socket.last('message.publish')
    socket.receive({ id: frame.id, type: 'error', payload: { code: 'RATE_LIMITED', message: 'Muitas mensagens', retryable: true, request_id: uuid(901), details: { retry_after_seconds: 9 } } })
    await expect(sending).rejects.toMatchObject({ code: 'RATE_LIMITED', retryable: true, retryAfterSeconds: 9 })
    agent.disconnect()
  })

  it('the visitor answers a form over HTTP, never with interaction.respond', async () => {
    const formId = uuid(20)
    const form = formEvent(3)
    form.event_id = formId
    const server = maestroServer({ existing: true, formEventId: formId })
    const { client, socket } = await setup(server)
    client.subscribe(threadId)
    await tick()
    socket.ackSubscribe()
    socket.frame('thread.snapshot', { thread: visitorThread('3'), events: [form], watermark: '3', next_cursor: null, has_more: false })
    socket.caught('3')
    await tick()
    await client.sendFormResponse({ threadId, formEventId: formId, cancelled: false, values: { nome: 'Ana' } })
    const post = server.calls.find((c) => c.method === 'POST' && c.path === `/threads/${threadId}/forms/${formId}/responses`)!
    expect(post.body).toEqual({ values: { nome: 'Ana' }, cancelled: false })
    expect(post.headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/)
    expect(socket.sent.some((f) => f.type === 'interaction.respond')).toBe(false)
    client.disconnect()
  })
})

describe('visitor mode: pending outbox', () => {
  const outboxKeys = () => Object.keys(localStorage).filter((key) => key.startsWith('maestro.outbox.'))
  async function leavePending() {
    const server = maestroServer({ existing: true })
    const first = await setup(server)
    const send = vi.spyOn(MaestroClient.prototype, 'send').mockRejectedValue(new Error('connection lost'))
    await expect(first.client.sendMessage({ text: 'Pendente', threadId })).rejects.toThrow()
    first.client.disconnect()
    expect(outboxKeys()).toHaveLength(1)
    return { server, send }
  }
  it('drops an entry whose thread is gone (404) with a visible failure and does not replay it on the next connection', async () => {
    const { server, send } = await leavePending()
    send.mockRejectedValue(new MaestroClientError('NOT_FOUND', 'Thread not found', false, undefined, threadId, 'x', 'rejected'))
    const errors: string[] = []
    const second = await setup(server, { onError: undefined })
    second.client.setOnError((error) => errors.push(error.code))
    await tick()
    expect(send).toHaveBeenCalledTimes(2)
    expect(outboxKeys()).toHaveLength(0)
    expect(second.store.getState().connection.sendError).toContain('descartada')
    second.client.disconnect()
    send.mockClear()
    const third = await setup(server)
    await tick()
    expect(send).not.toHaveBeenCalled()
    expect(third.store.getState().connection.sendError).toBeNull()
    third.client.disconnect()
    send.mockRestore()
  })
  it('keeps an entry that failed for another reason', async () => {
    const { server, send } = await leavePending()
    const second = await setup(server)
    await tick()
    expect(outboxKeys()).toHaveLength(1)
    expect(second.store.getState().connection.sendError).toContain('preservado')
    second.client.disconnect()
    send.mockRestore()
  })
})

describe('visitor mode: session expiry', () => {
  it('re-reads the credential through the token callback on refresh and keeps the session', async () => {
    const server = maestroServer({ existing: true })
    const authToken = vi.fn(async () => visitorCredential(org))
    const { client, socket } = await setup(server, { authToken })
    expect(authToken).toHaveBeenCalledTimes(1)
    const refreshing = client.getMaestroClient()!.refreshAuth()
    await tick()
    socket.receive({ id: socket.last('auth.refresh').id, type: 'ack', payload: { status: 'authenticated', expires_at: new Date(Date.now() + 300000).toISOString() } })
    await refreshing
    expect(authToken).toHaveBeenCalledTimes(2)
    client.disconnect()
  })

  it('a refresh the application cannot serve ends in the reconnect-failed state, once, for the application to decide', async () => {
    const server = maestroServer({ existing: true })
    let calls = 0
    const authToken = vi.fn(async () => {
      if (++calls === 1) return visitorCredential(org)
      throw new MaestroClientError('UNAUTHENTICATED', 'Session expired')
    })
    const { client, store } = await setup(server, { authToken })
    const refreshing = client.getMaestroClient()!.refreshAuth().catch(() => {})
    await refreshing
    await tick()
    await tick()
    await tick()
    expect(store.getState().connection.reconnectFailed).toBe(true)
    expect(store.getState().connection.status).toBe('error')
    // The application re-resolves and asks again: retry() reads the credential once more.
    authToken.mockImplementation(async () => visitorCredential(org))
    client.retry()
    await tick()
    const socket = sockets.at(-1)!
    socket.open()
    await tick()
    socket.ackConnect()
    await tick()
    expect(store.getState().connection.status).toBe('connected')
    expect(store.getState().connection.reconnectFailed).toBe(false)
    client.disconnect()
  })
})

describe('non-visitor mode is unchanged', () => {
  it('without the visitor option the Maestro client keeps the human behaviour', async () => {
    const calls: string[] = []
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}`)
      return json({ items: [], next_cursor: null, has_more: false, watermark: '0' })
    })
    const store = createAgentStore()
    const socketList: Socket[] = []
    const client = new MaestroAgentClient(store.getState().actions, {
      endpoint: 'https://maestro.example',
      scope: humanScope,
      authToken: (await import('./fixtures/maestro-credential')).credential(humanScope.principalId, org),
      threadListPollMs: 0,
      fetch: fetcher as unknown as typeof fetch,
      socketFactory: () => {
        const socket = new Socket()
        socketList.push(socket)
        return socket
      },
    })
    client.connect('ignored', uuid(40), { organizationId: org, workspaceId: '', userId: humanScope.principalId })
    await tick()
    socketList[0]!.open()
    await tick()
    socketList[0]!.ackConnect()
    await tick()
    await tick()
    expect(calls).toContain('GET /api/v1/threads')
    expect(calls.some((c) => c.includes('public-chat'))).toBe(false)
    expect(client.getVisitorThreadId()).toBeNull()
    client.disconnect()
  })
})

describe('AgentProvider with the visitor option', () => {
  it('passes the visitor mode to the Maestro client: the thread is read, the list is never asked', async () => {
    const server = maestroServer({ existing: true })
    const refs: { client?: unknown } = {}
    function Probe() {
      refs.client = useAgentContext().client
      return null
    }
    const view = render(
      <AgentProvider
        url="wss://ignored.example/ws"
        agentId={visitorInstanceAgent}
        organizationId={org}
        workspaceId=""
        userId=""
        maestro={{
          endpoint: 'https://maestro.example',
          scope: visitorScope,
          authToken: () => visitorCredential(org),
          visitor: true,
          threadListPollMs: 5,
          fetch: server.fetcher as unknown as typeof fetch,
          socketFactory: () => {
            const socket = new Socket()
            sockets.push(socket)
            return socket
          },
        }}
      >
        <Probe />
      </AgentProvider>
    )
    await act(tick)
    const socket = sockets.at(-1)!
    socket.open()
    await act(tick)
    socket.ackConnect()
    await act(tick)
    await act(tick)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30))
    })
    expect(refs.client).toBeInstanceOf(MaestroAgentClient)
    expect((refs.client as MaestroAgentClient).getVisitorThreadId()).toBe(threadId)
    expect(server.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /public-chat/thread'])
    view.unmount()
  })
})
