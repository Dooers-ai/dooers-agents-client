import { afterEach, describe, expect, it, vi } from 'vitest'
import { MaestroAgentClient } from '../src/maestro-agent-client'
import { maestroEventToLegacy, maestroFormToLegacyData } from '../src/maestro-legacy'
import { createAgentStore } from '../src/store'
import { credential } from './fixtures/maestro-credential'
import { MaestroContractError } from '../src/protocol/maestro/contracts'
import {
  readMaestroNetworkEvent,
  readMaestroNetworkPage,
  readMaestroReplayFrame,
  toMaestroNetworkEvent,
} from '../src/maestro/network'
import type { MaestroClient } from '../src/maestro/client'
import type { MaestroClientError } from '../src/maestro/types'
import {
  connect,
  event,
  make,
  scope,
  Socket,
  thread,
  threadId,
  tick,
  uuid,
} from './fixtures/maestro-replay'

const messageWith = (content: unknown[]) => {
  const e = event(1)
  e.payload.content = content
  return e
}
const formWith = (fields: unknown[]) => {
  const e = event(1, 'interaction.created')
  e.payload.interaction.definition.fields = fields
  return e
}
const textField = (name: string) => ({
  name,
  label: name,
  required: true,
  share_response: false,
  type: 'text',
  max_length: 100,
})
const hologramField = (name = 'holo') => ({
  name,
  label: 'Holo',
  required: false,
  share_response: false,
  type: 'hologram',
  depth: 3,
})
const unsupported = () => {
  const calls: [string, string][] = []
  return {
    calls,
    report: (kind: string, type: string) => calls.push([kind, type]),
  }
}

const clients: MaestroClient[] = []
afterEach(() => {
  for (const c of clients) c.dispose()
  clients.length = 0
  vi.useRealTimers()
})

describe('Maestro forward-compatible receive: content parts', () => {
  it('message.created com parte desconhecida mantém as partes conhecidas', () => {
    const r = readMaestroNetworkEvent(
      messageWith([
        { type: 'text', text: 'oi' },
        { type: 'hologram', id: 'x' },
      ])
    )
    expect(r.known).toBe(true)
    expect((r.event as any).payload.content).toEqual([{ type: 'text', text: 'oi' }])
  })
  it('remove várias partes desconhecidas, também seguidas, e preserva a ordem', () => {
    const r = readMaestroNetworkEvent(
      messageWith([
        { type: 'hologram', id: 'a' },
        { type: 'hologram', id: 'b' },
        { type: 'text', text: 'um' },
        { type: 'sticker', id: 'c' },
        { type: 'text', text: 'dois' },
        { type: 'hologram', id: 'd' },
      ])
    )
    expect((r.event as any).payload.content).toEqual([
      { type: 'text', text: 'um' },
      { type: 'text', text: 'dois' },
    ])
  })
  it('mantém o tipo desconhecido fora do resultado público e reporta uma vez por tipo', () => {
    const { calls, report } = unsupported()
    const r = toMaestroNetworkEvent(
      messageWith([
        { type: 'text', text: 'oi' },
        { type: 'hologram', id: 'a' },
        { type: 'hologram', id: 'b' },
        { type: 'sticker' },
      ]),
      report
    )
    expect(r.known).toBe(true)
    expect(JSON.stringify(r)).not.toContain('hologram')
    expect(calls.sort()).toEqual([
      ['content_part', 'hologram'],
      ['content_part', 'sticker'],
    ])
  })
  it('mantém anexo conhecido ao lado de parte desconhecida', () => {
    const attachment = {
      type: 'attachment',
      artifact_id: uuid(900),
      filename: 'a.png',
      mime_type: 'image/png',
      size_bytes: 3,
    }
    const r = readMaestroNetworkEvent(messageWith([{ type: 'hologram' }, attachment]))
    expect((r.event as any).payload.content).toEqual([attachment])
  })
  it('continua rejeitando parte conhecida inválida e parte sem tipo', () => {
    expect(() => readMaestroNetworkEvent(messageWith([{ type: 'text' }]))).toThrow(
      MaestroContractError
    )
    expect(() =>
      readMaestroNetworkEvent(messageWith([{ type: 'text', text: 'oi' }, { id: 'sem-tipo' }]))
    ).toThrow(MaestroContractError)
    expect(() =>
      readMaestroNetworkEvent(messageWith([{ type: 'text', text: 'oi' }, { type: 7 }]))
    ).toThrow(MaestroContractError)
  })
  it('não remove campo conhecido de uma parte conhecida', () => {
    expect(() =>
      readMaestroNetworkEvent(messageWith([{ type: 'text', text: 'oi', hologram: true }]))
    ).not.toThrow()
    expect(() =>
      readMaestroNetworkEvent(messageWith([{ type: 'text', text: 'oi', extra: { type: 'x' } }]))
    ).not.toThrow()
  })
  it('não aplica a tolerância a outros discriminadores (ator)', () => {
    const e = messageWith([{ type: 'text', text: 'oi' }])
    e.actor = { ...e.actor, kind: 'robot' }
    expect(() => readMaestroNetworkEvent(e)).toThrow(MaestroContractError)
  })
  it('página de eventos mantém as partes conhecidas de cada mensagem', () => {
    const { calls, report } = unsupported()
    const page = readMaestroNetworkPage(
      {
        items: [
          messageWith([
            { type: 'text', text: 'oi' },
            { type: 'hologram', id: 'x' },
          ]),
          {
            ...event(2),
            type: 'message.reactionado',
            payload: { qualquer: 1 },
          },
        ],
        next_cursor: null,
        has_more: false,
        watermark: '2',
      },
      report
    )
    expect(page.items[0]).toMatchObject({
      known: true,
      event: { payload: { content: [{ type: 'text', text: 'oi' }] } },
    })
    expect(page.items[1]).toMatchObject({ known: false })
    expect(calls).toContainEqual(['content_part', 'hologram'])
  })
  it('frame de replay e snapshot mantêm as partes conhecidas', () => {
    const frame = {
      type: 'thread.replay',
      payload: {
        subscription_id: uuid(101),
        events: [
          messageWith([
            { type: 'hologram', id: 'x' },
            { type: 'text', text: 'oi' },
          ]),
        ],
        watermark: '1',
        next_cursor: null,
        has_more: false,
      },
    }
    expect(() => readMaestroReplayFrame('thread.replay', frame)).not.toThrow()
  })
})

describe('Maestro forward-compatible receive: form fields', () => {
  it('form.created com campo desconhecido mantém os outros campos', () => {
    const r = readMaestroNetworkEvent(
      formWith([textField('nome'), hologramField(), textField('cidade')])
    )
    expect(r.known).toBe(true)
    expect(
      (r.event as any).payload.interaction.definition.fields.map((f: { name: string }) => f.name)
    ).toEqual(['nome', 'cidade'])
  })
  it('reporta o campo desconhecido uma vez por tipo e não o expõe no resultado', () => {
    const { calls, report } = unsupported()
    const r = toMaestroNetworkEvent(
      formWith([textField('nome'), hologramField('a'), hologramField('b')]),
      report
    )
    expect(r.known).toBe(true)
    expect(JSON.stringify(r)).not.toContain('hologram')
    expect(calls).toEqual([['form_field', 'hologram']])
  })
  it('continua rejeitando campo conhecido inválido', () => {
    expect(() =>
      readMaestroNetworkEvent(formWith([{ ...textField('nome'), max_length: 0 }, hologramField()]))
    ).toThrow(MaestroContractError)
  })
  it('mantém o tipo de interação desconhecido como erro de contrato', () => {
    const e = formWith([textField('nome')])
    e.payload.interaction.definition.kind = 'poll'
    expect(() => readMaestroNetworkEvent(e)).toThrow(MaestroContractError)
  })
})

describe('Maestro forward-compatible receive: event types', () => {
  it('evento de tipo desconhecido continua known: false e é reportado', () => {
    const { calls, report } = unsupported()
    const future = {
      ...event(1),
      type: 'message.updated',
      payload: { qualquer: 1 },
    }
    const r = toMaestroNetworkEvent(future, report)
    expect(r.known).toBe(false)
    expect(calls).toEqual([['event', 'message.updated']])
  })
  it('sem callback, nada quebra', () => {
    expect(() =>
      toMaestroNetworkEvent(messageWith([{ type: 'hologram' }, { type: 'text', text: 'oi' }]))
    ).not.toThrow()
  })
})

describe('MaestroClient reports unknown types through onError', () => {
  const setup = async () => {
    const errors: MaestroClientError[] = []
    const env = make({ onError: (e) => errors.push(e) })
    clients.push(env.client)
    env.client.retainThread(threadId)
    const socket = await connect(env.client, env.sockets)
    socket.ackSubscribe()
    await tick()
    return { ...env, socket, errors }
  }
  it('snapshot com parte desconhecida aplica a mensagem e chama onError uma vez por tipo', async () => {
    const { client, socket, errors } = await setup()
    const first = messageWith([
      { type: 'text', text: 'oi' },
      { type: 'hologram', id: 'x' },
    ])
    socket.snapshot([first], '1')
    socket.caught('1')
    await tick()
    const view = client.store.getThread(threadId)!
    expect(view.eventIds).toHaveLength(1)
    const second = messageWith([
      { type: 'hologram', id: 'y' },
      { type: 'text', text: 'dois' },
    ])
    second.sequence = '2'
    second.event_id = uuid(2)
    socket.frame('event.append', { event: second, cursor: 'cursor-2' })
    await tick()
    expect(client.store.getThread(threadId)?.eventIds).toHaveLength(2)
    const unsupportedErrors = errors.filter((e) => e.code === 'UNSUPPORTED_CONTENT')
    expect(unsupportedErrors).toHaveLength(1)
    expect(unsupportedErrors[0]!.message).toContain('hologram')
  })
  it('evento de tipo desconhecido chama onError uma vez por tipo', async () => {
    const { socket, errors } = await setup()
    const future = (n: number) => ({
      ...event(n),
      type: 'message.updated',
      payload: { qualquer: n },
    })
    socket.snapshot([future(1), future(2)], '2')
    socket.caught('2')
    await tick()
    const codes = errors.filter((e) => e.code === 'UNSUPPORTED_CONTENT')
    expect(codes).toHaveLength(1)
    expect(codes[0]!.message).toContain('message.updated')
  })
  it('callback onError que lança não derruba o parse', async () => {
    const env = make({
      onError: () => {
        throw new Error('boom')
      },
    })
    clients.push(env.client)
    env.client.retainThread(threadId)
    const socket = await connect(env.client, env.sockets)
    socket.ackSubscribe()
    await tick()
    socket.snapshot([messageWith([{ type: 'hologram' }, { type: 'text', text: 'oi' }])], '1')
    socket.caught('1')
    await tick()
    expect(env.client.store.getThread(threadId)?.eventIds).toHaveLength(1)
  })
  it('getHistoryPage mantém partes conhecidas', async () => {
    const errors: MaestroClientError[] = []
    const page = {
      items: [messageWith([{ type: 'hologram' }, { type: 'text', text: 'oi' }])],
      next_cursor: null,
      has_more: false,
      watermark: '1',
    }
    const env = make({
      onError: (e) => errors.push(e),
      fetch: async () =>
        new Response(JSON.stringify(page), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    })
    clients.push(env.client)
    await connect(env.client, env.sockets)
    const result = await env.client.getHistoryPage(threadId)
    expect(result.items[0]).toMatchObject({
      known: true,
      event: { payload: { content: [{ type: 'text', text: 'oi' }] } },
    })
    expect(errors.filter((e) => e.code === 'UNSUPPORTED_CONTENT')).toHaveLength(1)
  })

  it('event.append e getHistory com mensagem toda desconhecida mantêm o evento com content vazio', async () => {
    const errors: MaestroClientError[] = []
    const history = {
      items: [messageWith([{ type: 'hologram' }])],
      next_cursor: null,
      has_more: false,
      watermark: '1',
    }
    const env = make({
      onError: (e) => errors.push(e),
      fetch: async () =>
        new Response(JSON.stringify(history), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    })
    clients.push(env.client)
    env.client.retainThread(threadId)
    const socket = await connect(env.client, env.sockets)
    socket.ackSubscribe()
    await tick()
    socket.snapshot([event(1)], '1')
    socket.caught('1')
    await tick()
    const appended = messageWith([{ type: 'hologram' }])
    appended.sequence = '2'
    appended.event_id = uuid(2)
    socket.frame('event.append', { event: appended, cursor: 'cursor-2' })
    await tick()
    const stored = env.client.store.getThread(threadId)!
    expect(stored.eventIds).toHaveLength(2)
    expect((stored.eventsById[stored.eventIds[1]!] as any).event.payload.content).toEqual([])
    const page = await env.client.getHistory(threadId)
    expect(page.items[0]!.payload).toMatchObject({ content: [] })
    expect(errors.filter((e) => e.code === 'UNSUPPORTED_CONTENT')).toHaveLength(1)
  })
})

describe('Maestro forward-compatible receive: everything unknown', () => {
  it('mensagem só com partes desconhecidas mantém o evento com content vazio e reporta uma vez', () => {
    const { calls, report } = unsupported()
    const r = toMaestroNetworkEvent(
      messageWith([{ type: 'hologram' }, { type: 'hologram', id: 'b' }, { type: 'sticker' }]),
      report
    )
    expect(r.known).toBe(true)
    expect((r.event as any).payload.content).toEqual([])
    expect((r.event as any).payload.mentions).toEqual([])
    expect((r.event as any).eventId).toBe(uuid(1))
    expect(calls.sort()).toEqual([
      ['content_part', 'hologram'],
      ['content_part', 'sticker'],
    ])
  })
  it('form só com campos desconhecidos mantém o evento com fields vazio e reporta uma vez', () => {
    const { calls, report } = unsupported()
    const r = toMaestroNetworkEvent(formWith([hologramField('a'), hologramField('b')]), report)
    expect(r.known).toBe(true)
    const definition = (r.event as any).payload.interaction.definition
    expect(definition.fields).toEqual([])
    expect(definition.title).toBe('Nome')
    expect(calls).toEqual([['form_field', 'hologram']])
  })
  it('o marcador interno nunca aparece no resultado', () => {
    const r = readMaestroNetworkEvent(messageWith([{ type: 'hologram' }]))
    expect(JSON.stringify(r.event)).not.toContain('"-"')
    const f = readMaestroNetworkEvent(formWith([hologramField()]))
    expect(JSON.stringify(f.event)).not.toContain('unsupported')
  })
  it('parte conhecida malformada ao lado de partes todas desconhecidas continua falhando', () => {
    expect(() =>
      readMaestroNetworkEvent(messageWith([{ type: 'text' }, { type: 'hologram' }]))
    ).toThrow(MaestroContractError)
    expect(() =>
      readMaestroNetworkEvent(formWith([{ ...textField('nome'), max_length: 0 }, hologramField()]))
    ).toThrow(MaestroContractError)
  })
  it('um array esvaziado não afeta outro array do mesmo lote', () => {
    const { calls, report } = unsupported()
    const page = readMaestroNetworkPage(
      {
        items: [
          messageWith([{ type: 'hologram' }]),
          {
            ...messageWith([{ type: 'text', text: 'oi' }, { type: 'hologram' }]),
            sequence: '2',
            event_id: uuid(2),
          },
          { ...formWith([hologramField()]), sequence: '3', event_id: uuid(3) },
        ],
        next_cursor: null,
        has_more: false,
        watermark: '3',
      },
      report
    )
    const items = page.items.map((i) => (i.event as any).payload)
    expect(items[0].content).toEqual([])
    expect(items[1].content).toEqual([{ type: 'text', text: 'oi' }])
    expect(items[2].interaction.definition.fields).toEqual([])
    expect(calls).toContainEqual(['content_part', 'hologram'])
    expect(calls).toContainEqual(['form_field', 'hologram'])
  })
  it('a projeção legada aceita content e fields vazios', () => {
    const message = maestroEventToLegacy(toMaestroNetworkEvent(messageWith([{ type: 'hologram' }])))
    expect(message).toMatchObject({ type: 'message', content: [] })
    const form = maestroEventToLegacy(toMaestroNetworkEvent(formWith([hologramField()])))
    expect(form).toMatchObject({ type: 'form', data: { message: 'Nome', elements: [] } })
    expect(maestroFormToLegacyData({ title: 't', fields: [] })).toMatchObject({ elements: [] })
  })
  it('evento todo desconhecido chega ao store legado sem lançar', async () => {
    const errors: { code: string; message: string }[] = []
    const store = createAgentStore()
    const sockets: Socket[] = []
    const client = new MaestroAgentClient(store.getState().actions, {
      endpoint: 'https://maestro.example',
      scope,
      authToken: credential(scope.principalId, scope.organizationId),
      threadListPollMs: 0,
      forms: true,
      fetch: (async () =>
        new Response(
          JSON.stringify({ items: [], next_cursor: null, has_more: false, watermark: '0' }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }
        )) as unknown as typeof fetch,
      socketFactory: () => {
        const socket = new Socket()
        sockets.push(socket)
        return socket
      },
    })
    client.setOnError((e) => errors.push(e))
    client.connect('ignored', uuid(40), {
      organizationId: scope.organizationId,
      workspaceId: '',
      userId: scope.principalId,
    })
    await tick()
    const socket = sockets.at(-1)!
    socket.open()
    await tick()
    socket.ackConnect()
    await tick()
    client.subscribe(threadId)
    await tick()
    socket.ackSubscribe()
    const empty = messageWith([{ type: 'hologram' }])
    const form = { ...formWith([hologramField()]), sequence: '2', event_id: uuid(2) }
    socket.frame('thread.snapshot', {
      thread: thread('2'),
      events: [empty, form],
      watermark: '2',
      next_cursor: null,
      has_more: false,
    })
    socket.caught('2')
    await tick()
    const events = store.getState().events[threadId] ?? []
    expect(events.find((e) => e.type === 'message')).toMatchObject({ content: [] })
    expect(events.find((e) => e.type === 'form')).toMatchObject({ data: { elements: [] } })
    expect(errors.filter((e) => e.code === 'UNSUPPORTED_CONTENT')).toHaveLength(2)
    client.disconnect()
  })
})
