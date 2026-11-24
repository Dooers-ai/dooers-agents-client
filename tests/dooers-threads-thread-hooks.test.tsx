import { StrictMode } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { DooersThreadsProvider, useDooersThreadsClient, useDooersThreadsThread, useDooersThreadsParticipants, useDooersThreadsExecutions } from '../src/dooers-threads/provider'
import type { DooersThreadsClient } from '../src/dooers-threads/client'
import type { DooersThreadsClientConfig } from '../src/dooers-threads/types'
import { credential } from './fixtures/dooers-threads-credential'
import { event, scope, Socket, threadId, tick } from './fixtures/dooers-threads-replay'
let client: DooersThreadsClient
let sockets: Socket[]=[]
const config: DooersThreadsClientConfig={mode:'dooers_threads',endpoint:'https://dooers-threads.example',scope,authToken:credential(scope.principalId,scope.organizationId),maxReconnectAttempts:0,socketFactory:()=>{const s=new Socket();sockets.push(s);return s}}
function Probe(){client=useDooersThreadsClient();const {state}=useDooersThreadsThread(threadId);return <div data-testid="events">{state?.eventIds.length ?? 0}</div>}
function Members(){const participants=useDooersThreadsParticipants(threadId);const {waitingForInput}=useDooersThreadsExecutions(threadId);return <span>{participants.length}:{String(waitingForInput)}</span>}
const open = async()=>{await act(tick);const socket=sockets.at(-1)!;await act(async()=>{socket.open();await tick();socket.ackConnect();await tick();socket.ackSubscribe();socket.snapshot([event(1)],'1');socket.caught('1');await tick()});return socket}
afterEach(()=>{cleanup();sockets=[]})
it('three hook consumers share one subscription, and removing one preserves the others',async()=>{
 const view=render(<DooersThreadsProvider config={config}><Probe/><Members/></DooersThreadsProvider>);const socket=await open()
 expect(client.store.getThread(threadId)?.refs).toBe(3);expect(socket.sent.filter(f=>f.type==='thread.subscribe')).toHaveLength(1)
 view.rerender(<DooersThreadsProvider config={config}><Probe/></DooersThreadsProvider>);expect(client.store.getThread(threadId)?.refs).toBe(1)
 expect(socket.sent.filter(f=>f.type==='thread.unsubscribe')).toHaveLength(0);expect(view.getByTestId('events').textContent).toBe('1')
})
it('StrictMode remount leaves one active ref and no publication or thread creation',async()=>{
 render(<StrictMode><DooersThreadsProvider config={config}><Probe/></DooersThreadsProvider></StrictMode>);const socket=await open()
 expect(client.store.getThread(threadId)?.refs).toBe(1);expect(socket.sent.filter(f=>f.type==='thread.subscribe')).toHaveLength(1)
 expect(socket.sent.some(f=>f.type==='message.publish'||f.type==='thread.create')).toBe(false)
})
it('switching principal hides old history and pending messages before new handshake',async()=>{
 const view=render(<DooersThreadsProvider config={config}><Probe/></DooersThreadsProvider>);const socket=await open();const previous=client
 let pending!:Promise<unknown>;await act(async()=>{pending=client.send({threadId,content:[{type:'text',text:'private pending'}],clientEventId:'private'}).catch(e=>e);await tick()})
 const next={...config,scope:{...scope,principalId:'another-human'},authToken:credential('another-human',scope.organizationId)}
 view.rerender(<DooersThreadsProvider config={next}><Probe/></DooersThreadsProvider>);await act(tick);await pending
 expect(client).not.toBe(previous);expect(view.getByTestId('events').textContent).toBe('0');expect(client.store.getThread(threadId)?.commandsByKey).toEqual({})
 expect(previous.store.getSnapshot().threads).toEqual({});expect(socket.close).toHaveBeenCalled()
})
