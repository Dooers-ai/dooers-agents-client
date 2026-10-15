import { afterEach, expect, it, vi } from 'vitest'
import { MaestroArtifacts, type MaestroAttachment } from '../src/maestro/artifacts'
import type { MaestroClient } from '../src/maestro/client'
import { event, make, thread, threadId, tick, uuid } from './fixtures/maestro-replay'
const clients: MaestroClient[] = []
afterEach(() => { for (const c of clients) c.dispose(); clients.length = 0; vi.useRealTimers(); vi.unstubAllGlobals() })
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
const uploaded = (metadata: any) => ({ artifact: { artifact_id: uuid(40), ...metadata, state: 'ready_unbound', created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 120000).toISOString() }, upload_session_id: uuid(41), upload_mode: 'multipart_proxy', max_size_bytes: 8388608, expires_at: new Date(Date.now() + 120000).toISOString() })
async function setup(fetcher: typeof fetch, attachments = true) {
 const env = make({ fetch: fetcher }); clients.push(env.client)
 const connecting = env.client.connect(); await tick(); const socket = env.sockets[0]!; socket.open(); await tick()
 socket.receive({ id: socket.last('connect').id, type: 'ack', payload: { status: 'connected', connection_id: uuid(100), server_version: '0.0.0', protocol_version: 1, history_authority: 'maestro', capabilities: ['messages.text', 'threads.shared', 'history.replay', ...(attachments ? ['attachments.durable'] : [])], expires_at: new Date(Date.now() + 300000).toISOString() } }); await connecting
 return { ...env, socket }
}
const file = () => new Blob(['synthetic durable media'], { type: 'image/png' })
async function ready(client: MaestroClient, id: string) { await client.artifacts.retry(id) }
const attachment: MaestroAttachment = { type: 'attachment', artifact_id: uuid(40), filename: 'image.png', mime_type: 'image/png', size_bytes: file().size }
async function history(env: Awaited<ReturnType<typeof setup>>) {
 env.client.retainThread(threadId); await tick(); env.socket.ackSubscribe()
 const e = event(1); e.payload.content = [attachment]
 const t = thread('1'); t.capabilities.push('attachments.durable')
 env.socket.frame('thread.snapshot', { thread: t, events: [e], watermark: '1', next_cursor: null, has_more: false }); env.socket.caught('1'); await tick()
}
const bytes = () => new Response('synthetic durable media', { headers: { 'Content-Type': 'image/png', 'Content-Length': String(file().size), 'Cache-Control': 'private, no-store', 'Content-Disposition': 'attachment; filename="image.png"', 'X-Content-Type-Options': 'nosniff' } })
it('lost ACK retries the same multipart File/hash/key and never supplies an agent endpoint or JSON content type', async () => {
 const requests: any[] = []
 const fetcher = vi.fn(async (url, init) => { const body = init!.body as FormData; const meta = JSON.parse(String(body.get('metadata'))); requests.push({ url, init, meta, file: await (body.get('file') as Blob).text() }); if (requests.length === 1) throw new TypeError('ACK lost'); return json(uploaded(meta), 201) })
 const { client } = await setup(fetcher)
 const id = client.artifacts.add(file(), 'image.png'); await expect(ready(client, id)).rejects.toMatchObject({ code: 'NETWORK_ERROR' })
 expect(client.artifacts.getSnapshot()[0]!.state).toBe('error'); expect(() => client.artifacts.content()).toThrow()
 await ready(client, id)
 expect(requests).toHaveLength(2); expect(requests[0].meta).toEqual(requests[1].meta); expect(requests[0].file).toBe(requests[1].file)
 expect(requests[0].init.headers['Idempotency-Key']).toBe(requests[1].init.headers['Idempotency-Key'])
 expect(requests[0].url).toBe('https://maestro.example/api/v1/artifacts'); expect(requests[0].meta.workspace_id).toBeNull(); expect(requests[0].meta.thread_id).toBeUndefined()
 expect(requests[0].init.headers['Content-Type']).toBeUndefined(); expect(requests[0].init).toMatchObject({ credentials: 'omit', redirect: 'error', cache: 'no-store' })
 expect(client.artifacts.content()).toEqual([attachment]); expect(JSON.stringify(client.artifacts.content())).not.toMatch(/url|Bearer|sha256/)
})
it('removing a pending file aborts and ignores a late response', async () => {
 let resolve!: (r: Response) => void; let meta: any
 const { client } = await setup(vi.fn(async (_url, init) => { meta = JSON.parse(String((init!.body as FormData).get('metadata'))); return new Promise<Response>(r => { resolve = r }) }))
 const id = client.artifacts.add(file(), 'image.png'); const pending = client.artifacts.retry(id); await vi.waitFor(() => expect(resolve).toBeDefined())
 client.artifacts.remove(id); resolve(json(uploaded(meta), 201)); await expect(pending).rejects.toMatchObject({ code: 'DISCONNECTED' }); expect(client.artifacts.getSnapshot()).toEqual([])
})
it('scope reset and revoked credentials clear File intentions before a late upload can restore them', async () => {
 const fetcher = vi.fn(async () => json({ error: { code: 'FORBIDDEN', message: 'Access denied', retryable: false, request_id: uuid(99) } }, 403))
 const { client } = await setup(fetcher)
 const id = client.artifacts.add(file(), 'image.png'); await expect(client.artifacts.retry(id)).rejects.toMatchObject({ code: 'FORBIDDEN' })
 expect(client.artifacts.getSnapshot()).toEqual([]); expect(client.getConnection().status).toBe('unauthenticated'); expect(fetcher).toHaveBeenCalledTimes(1)
})
it('missing negotiated capability never sends the selected file', async () => {
 const fetcher = vi.fn(); const { client } = await setup(fetcher, false)
 const id = client.artifacts.add(file(), 'image.png'); await expect(ready(client, id)).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' }); expect(fetcher).not.toHaveBeenCalled()
})
it('download builds only the proxy ID path, keeps authorization out of URLs and bounds resources to 60 seconds', async () => {
 const fetcher = vi.fn(async () => bytes()); const env = await setup(fetcher); await history(env)
 const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:private-object'); const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
 vi.useFakeTimers(); const r = await env.client.artifacts.open(threadId, attachment)
 expect(fetcher.mock.calls[0]![0]).toBe(`https://maestro.example/api/v1/artifacts/${attachment.artifact_id}/download`)
 expect(fetcher.mock.calls[0]![1]).toMatchObject({ credentials: 'omit', redirect: 'error', cache: 'no-store', headers: { Authorization: expect.stringMatching(/^Bearer /) } })
 expect(r.url).toBe('blob:private-object'); expect(create).toHaveBeenCalledTimes(1)
 await vi.advanceTimersByTimeAsync(60000); expect(revoke).toHaveBeenCalledWith('blob:private-object'); expect(fetcher).toHaveBeenCalledTimes(1)
 create.mockRestore(); revoke.mockRestore()
})
it('revocation during chunks cancels the read, exposes no partial Blob and does not renew', async () => {
 let stream!: ReadableStreamDefaultController<Uint8Array>
 const fetcher = vi.fn(async () => new Response(new ReadableStream({ start(c) { stream = c; c.enqueue(new Uint8Array([1,2])) } }), { headers: { 'content-type': 'image/png', 'content-length': String(file().size), 'cache-control': 'private, no-store', 'content-disposition': 'attachment', 'x-content-type-options': 'nosniff' } }))
 const env = await setup(fetcher); await history(env)
 const create = vi.spyOn(URL, 'createObjectURL'); const pending = env.client.artifacts.open(threadId, attachment); const rejected = expect(pending).rejects.toMatchObject({ code: 'DISCONNECTED' })
 await tick(); env.client.closeThread(threadId); await rejected
 expect(create).not.toHaveBeenCalled(); expect(fetcher).toHaveBeenCalledTimes(1); create.mockRestore()
})
it('known thread revocation releases an existing Blob and prevents new calls', async () => {
 const fetcher = vi.fn(async () => bytes()); const env = await setup(fetcher); await history(env)
 const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:released'); const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
 await env.client.artifacts.open(threadId, attachment)
 env.client.closeThread(threadId); expect(revoke).toHaveBeenCalledWith('blob:released')
 await expect(env.client.artifacts.open(threadId, attachment)).rejects.toMatchObject({ code: 'FORBIDDEN' }); expect(fetcher).toHaveBeenCalledTimes(1)
 create.mockRestore(); revoke.mockRestore()
})
it('an artifact from another history cannot be retained under the wrong thread', async () => {
 const fetcher = vi.fn(async () => bytes()); const env = await setup(fetcher); await history(env)
 await expect(env.client.artifacts.open(uuid(80), attachment)).rejects.toMatchObject({ code: 'FORBIDDEN' }); expect(fetcher).not.toHaveBeenCalled()
})
it('rejects oversize/active header filenames before I/O and stops ambiguous length/content responses', async () => {
 const request = vi.fn(async () => new Response('abc', { headers: { 'content-type':'image/png','content-length':'4','cache-control':'private, no-store','content-disposition':'attachment','x-content-type-options':'nosniff' } }))
 const manager = new MaestroArtifacts({ workspaceId:null, request, failure:()=>{} }, 3)
 expect(() => manager.add(new Blob(['1234'], {type:'image/png'}), 'x.png')).toThrow()
 expect(() => manager.add(new Blob(['x'], {type:'image/png'}), 'bad"name.png')).toThrow()
 await expect(manager.open(threadId, attachment)).rejects.toMatchObject({ code:'PROTOCOL_ERROR' }); expect(request).toHaveBeenCalledTimes(1); manager.clear()
})

it('explicit upload authorization failure preserves the selected File and retries the same intention before any bytes leave', async () => {
 const fetcher=vi.fn(async(_url,init)=>json(uploaded(JSON.parse(String((init!.body as FormData).get('metadata')))),201))
 const {client}=await setup(fetcher)
 const authorize=vi.fn().mockRejectedValueOnce(new TypeError('Synthetic Core token outage')).mockResolvedValue(undefined)
 const id=client.artifacts.add(file(),'image.png',{authorize})
 await expect(client.artifacts.retry(id)).rejects.toMatchObject({code:'NETWORK_ERROR'})
 expect(fetcher).not.toHaveBeenCalled();expect(client.artifacts.getSnapshot()[0]?.state).toBe('error')
 await client.artifacts.retry(id);expect(authorize).toHaveBeenCalledTimes(2);expect(fetcher).toHaveBeenCalledTimes(1);expect(client.artifacts.content()).toEqual([attachment])
})
it('invalid download headers abort the native request before its slot is released', async () => {
 const signals:AbortSignal[]=[]
 let active=0
 const env=await setup(vi.fn(async(_url,init)=>{
   const signal=init!.signal!;signals.push(signal);active++
   const body=new ReadableStream<Uint8Array>({start(controller){
     controller.enqueue(new Uint8Array([1]))
     signal.addEventListener('abort',()=>{active--;controller.error(new DOMException('Canceled','AbortError'))},{once:true})
   }})
   return new Response(body,{headers:{'content-type':'image/png','content-length':String(file().size),'cache-control':'private, no-store','content-disposition':'attachment'}})
 }))
 await history(env)
 for(let attempt=0;attempt<3;attempt++){
   await expect(env.client.artifacts.open(threadId,attachment)).rejects.toMatchObject({code:'PROTOCOL_ERROR'})
   expect(signals.at(-1)?.aborted).toBe(true)
   expect(active).toBe(0)
 }
})
