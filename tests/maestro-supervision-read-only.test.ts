import { afterEach, expect, it, vi } from 'vitest'
import type { MaestroAttachment } from '../src/maestro/artifacts'
import type { MaestroClient } from '../src/maestro/client'
import { MAESTRO_SUPERVISION_READ_ONLY } from '../src/maestro/index'
import { event, make, thread, threadId, tick, uuid } from './fixtures/maestro-replay'

/**
 * SEC-03: supervision only reads. The Maestro refuses export, download and the PDF view link with a
 * supervision grant (403 `supervision_read_only`). The client never sends the grant there: it refuses
 * these actions itself, with the same reason code, and keeps the supervised thread open.
 */
const clients: MaestroClient[] = []
afterEach(() => {
  for (const client of clients) client.dispose()
  clients.length = 0
})
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
const image: MaestroAttachment = {
  type: 'attachment',
  artifact_id: uuid(40),
  filename: 'image.png',
  mime_type: 'image/png',
  size_bytes: 10,
}
const pdf: MaestroAttachment = {
  type: 'attachment',
  artifact_id: uuid(41),
  filename: 'report.pdf',
  mime_type: 'application/pdf',
  size_bytes: 10,
}
const grant = () => ({
  supervision_grant_id: uuid(90),
  thread_id: threadId,
  access: 'read_only',
  expires_at: new Date(Date.now() + 50000).toISOString(),
  policy_version: 1,
})
const readOnly = { code: 'FORBIDDEN', reasonCode: MAESTRO_SUPERVISION_READ_ONLY, threadId }

async function supervised() {
  const sent: Array<[string, RequestInit | undefined]> = []
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    sent.push([url, init])
    return url.endsWith('/supervision') ? json(grant()) : json({}, 500)
  })
  const env = make({ fetch: fetcher as unknown as typeof fetch })
  clients.push(env.client)
  const connecting = env.client.connect()
  await tick()
  const socket = env.sockets[0]!
  socket.open()
  await tick()
  socket.receive({
    id: socket.last('connect').id,
    type: 'ack',
    payload: {
      status: 'connected',
      connection_id: uuid(100),
      server_version: '0.0.0',
      protocol_version: 1,
      history_authority: 'maestro',
      capabilities: [
        'messages.text',
        'threads.shared',
        'history.replay',
        'attachments.durable',
        'export',
      ],
      expires_at: new Date(Date.now() + 300000).toISOString(),
    },
  })
  await connecting
  await env.client.openSupervision(threadId, 'Operational review', 'supervision-key')
  env.client.retainThread(threadId)
  await tick()
  socket.ackSubscribe()
  const view = thread('1')
  view.capabilities.push('attachments.durable')
  // The fixture thread already offers `export`. Even a projection that allowed export would not let
  // the supervised client send it.
  view.permissions = { ...view.permissions, write: false, export: true, supervise: true }
  const cited = event(1)
  cited.payload.content = [image, pdf]
  socket.frame('thread.snapshot', {
    thread: view,
    events: [cited],
    watermark: '1',
    next_cursor: null,
    has_more: false,
  })
  socket.caught('1')
  await tick()
  return { ...env, sent }
}

it('refuses file download and the PDF view link of a supervised thread without a request', async () => {
  const { client, sent } = await supervised()
  expect(client.isSupervision(threadId)).toBe(true)
  await expect(client.artifacts.open(threadId, image)).rejects.toMatchObject(readOnly)
  await expect(client.artifacts.viewLink(threadId, pdf)).rejects.toMatchObject(readOnly)
  expect(sent.filter(([url]) => url.includes('/artifacts/'))).toEqual([])
  // Not an access loss: the supervised thread stays open with its history.
  expect(client.store.getThread(threadId)?.phase).toBe('live')
  expect(client.store.getThread(threadId)?.eventIds).toHaveLength(1)
  expect(client.isSupervision(threadId)).toBe(true)
})

it('refuses the export of a supervised thread without a request and keeps the thread open', async () => {
  const { client, sent } = await supervised()
  await expect(client.exports.request(threadId)).rejects.toMatchObject(readOnly)
  expect(client.exports.getSnapshot()[0]).toMatchObject({ state: 'rejected', errorCode: 'FORBIDDEN' })
  expect(sent.filter(([url]) => url.includes('/export'))).toEqual([])
  expect(client.store.getThread(threadId)?.phase).toBe('live')
})

