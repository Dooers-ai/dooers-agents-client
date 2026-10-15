import { vi } from 'vitest'
import fixtures from '../../vendor/maestro-v1/contracts/fixtures/v1/public.json'
import { MaestroClient } from '../../src/maestro/client'
import type { MaestroClientConfig, MaestroSocket } from '../../src/maestro/types'
import { credential } from './maestro-credential'
export const fixture = (schema: string): any => structuredClone(fixtures.cases.find(c => c.schema === schema && c.valid)!.data)
export const threadId = '00000000-0000-4000-8000-000000000003'
export const scope = { principalId: 'auth0|human-fixture', organizationId: '00000000-0000-4000-8000-000000000001', workspaceId: null }
export const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
export const event = (sequence: number | string, type = 'message.created') => {
  const e = fixture(`Public.Event.${type}`)
  e.sequence = String(sequence); e.event_id = uuid(Number(BigInt(sequence) % 999999999999n)); e.payload.client_event_id &&= `intent-${sequence}`
  return e
}
export const thread = (sequence = '0') => ({ ...fixture('Public.Thread'), last_sequence: sequence, cursor: `cursor-${sequence}` })
export const tick = async () => { for(let i=0;i<20;i++) await Promise.resolve() }
export class Socket implements MaestroSocket {
  readyState=0; onopen: MaestroSocket['onopen']=null; onclose: MaestroSocket['onclose']=null; onerror: MaestroSocket['onerror']=null; onmessage: MaestroSocket['onmessage']=null
  sent: any[]=[]
  send(data: string) { this.sent.push(JSON.parse(data)) }
  close = vi.fn(() => { this.readyState=3 })
  open() { this.readyState=1; this.onopen?.(new Event('open')) }
  receive(frame: unknown) { this.onmessage?.(new MessageEvent('message',{data:JSON.stringify(frame)})) }
  drop() { this.readyState=3; this.onclose?.(new CloseEvent('close')) }
  last(type?: string) { return type ? this.sent.filter(f=>f.type===type).at(-1)! : this.sent.at(-1)! }
  ackConnect() { this.receive({ id:this.last('connect').id, type:'ack', payload:{ status:'connected', connection_id:uuid(100), server_version:'0.0.0', protocol_version:1, history_authority:'maestro', capabilities:['messages.text','threads.shared','history.replay'], expires_at:new Date(Date.now()+300000).toISOString() } }) }
  ackSubscribe(id = uuid(101), watermark='0') { this.receive({id:this.last('thread.subscribe').id,type:'ack',payload:{status:'subscribed',subscription_id:id,replay_watermark:watermark,replay_mode:this.last('thread.subscribe').payload.cursor ? 'replay':'snapshot'}}); return id }
  frame(type: string, payload: object, subscriptionId=uuid(101)) { this.receive({ type, payload:{subscription_id:subscriptionId,...payload} }) }
  snapshot(events: unknown[], watermark: string, subscriptionId=uuid(101), hasMore=false) { this.frame('thread.snapshot',{thread:thread(watermark),events,watermark,next_cursor:hasMore?`cursor-${(events.at(-1) as any)?.sequence ?? 0}`:null,has_more:hasMore},subscriptionId) }
  caught(watermark: string, subscriptionId=uuid(101)) { this.frame('thread.caught_up',{watermark,cursor:`cursor-${watermark}`},subscriptionId) }
}
export const make = (extra: Partial<MaestroClientConfig> = {}) => {
 const sockets: Socket[]=[]
 const client = new MaestroClient({mode:'maestro',endpoint:'https://maestro.example',scope,authToken:credential(scope.principalId,scope.organizationId),maxReconnectAttempts:0,replayRetryMs:10,socketFactory:()=>{const socket=new Socket();sockets.push(socket);return socket},...extra})
 return {client,sockets}
}
export const connect = async (client: MaestroClient, sockets: Socket[]) => { const p=client.connect(); await tick(); const socket=sockets.at(-1)!;socket.open();await tick();socket.ackConnect();await p;return socket }
