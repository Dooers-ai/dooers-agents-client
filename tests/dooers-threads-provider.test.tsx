import { credential } from './fixtures/dooers-threads-credential'
import { StrictMode } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { DooersThreadsProvider, useDooersThreadsClient, useDooersThreadsConnection, useDooersThreadsPublications } from '../src/dooers-threads/provider'
import type { DooersThreadsClient } from '../src/dooers-threads/client'
import type { DooersThreadsClientConfig, DooersThreadsSocket } from '../src/dooers-threads/types'
import { AgentProvider, useAgentContext } from '../src/provider'
import type { AgentClient } from '../src/client'
class Socket implements DooersThreadsSocket {
  static OPEN = 1
  static all: Socket[] = []
  readyState = 0
  onopen: DooersThreadsSocket['onopen'] = null
  onclose: DooersThreadsSocket['onclose'] = null
  onmessage: DooersThreadsSocket['onmessage'] = null
  onerror: DooersThreadsSocket['onerror'] = null
  sent: any[] = []
  constructor(readonly url: string) { Socket.all.push(this) }
  send(data: string) { this.sent.push(JSON.parse(data)) }
  close = vi.fn(() => { this.readyState = 3 })
  open() { this.readyState = 1; this.onopen?.(new Event('open')) }
  receive(frame: unknown) { this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(frame) })) }
  ack() { this.receive({ id: this.sent.at(-1).id, type: 'ack', payload: { status: 'connected', connection_id: '00000000-0000-4000-8000-000000000001', protocol_version: 1, server_version: '0.0.0', history_authority: 'dooers_threads', capabilities: ['messages.text'], expires_at: new Date(Date.now() + 300000).toISOString() } }) }
}
let observed: DooersThreadsClient
let legacy: AgentClient
let events: readonly unknown[]
function Probe() { observed = useDooersThreadsClient(); const connection = useDooersThreadsConnection(); events = useDooersThreadsPublications().events; return <div>{connection.status}:{events.length}</div> }
function LegacyProbe() { legacy = useAgentContext().client; return null }
const config: DooersThreadsClientConfig = { mode: 'dooers_threads', endpoint: 'https://dooers-threads.example', scope: { principalId: 'human', organizationId: '00000000-0000-4000-8000-000000000001', workspaceId: null }, authToken: credential('human', '00000000-0000-4000-8000-000000000001', {}, 'dooers-threads-token'), maxReconnectAttempts: 0, socketFactory: url => new Socket(url) }
const flush = async () => { for (let i=0;i<12;i++) await Promise.resolve() }
afterEach(() => { cleanup(); Socket.all = []; vi.unstubAllGlobals() })
it('isolates identity before new children render and closes the old session', async () => {
  const view = render(<DooersThreadsProvider config={config}><Probe /></DooersThreadsProvider>); await act(flush)
  const first = observed!; const socket = Socket.all[0]!
  await act(async () => { socket.open(); await flush(); socket.ack(); await flush() })
  view.rerender(<DooersThreadsProvider config={{ ...config, scope: { ...config.scope, principalId: 'new-human' }, authToken: credential('new-human', config.scope.organizationId, {}, 'new-token') }}><Probe /></DooersThreadsProvider>)
  expect(observed!).not.toBe(first); expect(events!).toEqual([]); expect(first.getConnection().status).toBe('disconnected'); expect(socket.close).toHaveBeenCalled()
  await act(flush); const next = Socket.all.at(-1)!
  await act(async () => { next.open(); await flush() }); expect(next.sent.at(-1).payload.auth_token).toBe(credential('new-human', config.scope.organizationId, {}, 'new-token'))
})
it('reauthenticates changed token without replacing the client or sending connect twice', async () => {
  const view = render(<DooersThreadsProvider config={config}><Probe /></DooersThreadsProvider>); await act(flush)
  const first = observed!; const socket = Socket.all[0]!
  await act(async () => { socket.open(); await flush(); socket.ack(); await flush() })
  view.rerender(<DooersThreadsProvider config={{ ...config, authToken: credential('human', config.scope.organizationId, {}, 'new-token') }}><Probe /></DooersThreadsProvider>)
  await act(flush); expect(observed!).toBe(first); expect(Socket.all).toHaveLength(1); expect(socket.sent.at(-1).type).toBe('auth.refresh'); expect(first.getConnection().status).toBe('refreshing')
  await act(async () => { socket.receive({ id: socket.sent.at(-1).id, type: 'ack', payload: { status: 'authenticated', expires_at: new Date(Date.now() + 300000).toISOString() } }); await flush() })
  expect(first.getConnection().status).toBe('connected')
})
it('supports StrictMode setup-cleanup-setup without disposing the active client', async () => {
  render(<StrictMode><DooersThreadsProvider config={config}><Probe /></DooersThreadsProvider></StrictMode>); await act(flush)
  const active = Socket.all.at(-1)!
  await act(async () => { active.open(); await flush(); active.ack(); await flush() })
  expect(observed!.getConnection().status).toBe('connected')
  expect(active.sent.map(item => item.type)).toEqual(['connect'])
})
it('keeps private settings and analytics on the separate legacy agent connection', async () => {
  vi.stubGlobal('WebSocket', Socket)
  render(<AgentProvider url="wss://agent.example/ws" agentId="agent-id" authToken="agent-token"><DooersThreadsProvider config={config}><Probe /><LegacyProbe /></DooersThreadsProvider></AgentProvider>)
  await act(flush)
  const agent = Socket.all.find(s => s.url.startsWith('wss://agent.example'))!; const dooersThreads = Socket.all.find(s => s.url.startsWith('wss://dooers-threads.example'))!
  await act(async () => { agent.open(); dooersThreads.open(); await flush(); dooersThreads.ack(); await flush() })
  act(() => { legacy!.subscribeSettings(); legacy!.subscribeAnalytics() })
  expect(agent.sent.some(frame => frame.type === 'settings.subscribe')).toBe(true)
  expect(agent.sent.some(frame => frame.type === 'analytics.subscribe')).toBe(true)
  expect(dooersThreads.sent.map(frame => frame.type)).toEqual(['connect'])
  expect(JSON.stringify(dooersThreads.sent)).not.toContain('agent-token'); expect(JSON.stringify(agent.sent)).not.toContain('dooers-threads-token')
})
it('does not mark a newer provider credential authenticated by an earlier refresh ACK', async () => {
  const view = render(<DooersThreadsProvider config={config}><Probe /></DooersThreadsProvider>); await act(flush)
  const socket = Socket.all.at(-1)!
  await act(async () => { socket.open(); await flush(); socket.ack(); await flush() })
  const second = credential('human', config.scope.organizationId, {}, 'second')
  const third = credential('human', config.scope.organizationId, {}, 'third')
  view.rerender(<DooersThreadsProvider config={{...config, authToken:second}}><Probe /></DooersThreadsProvider>); await act(flush)
  view.rerender(<DooersThreadsProvider config={{...config, authToken:third}}><Probe /></DooersThreadsProvider>); await act(flush)
  expect(socket.sent.at(-1).payload.auth_token).toBe(second)
  await act(async () => { socket.receive({id:socket.sent.at(-1).id,type:'ack',payload:{status:'authenticated',expires_at:new Date(Date.now()+300000).toISOString()}}); await flush() })
  expect(socket.sent.at(-1).payload.auth_token).toBe(third); expect(observed!.getConnection().status).toBe('refreshing')
  await act(async () => { socket.receive({id:socket.sent.at(-1).id,type:'ack',payload:{status:'authenticated',expires_at:new Date(Date.now()+300000).toISOString()}}); await flush() })
  expect(observed!.getConnection().status).toBe('connected')
})
