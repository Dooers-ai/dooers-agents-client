import type { z } from 'zod'
import { uuidSchema } from '../protocol/maestro/vendor/common.js'
import { publicSchemas } from '../protocol/maestro/vendor/public.js'
import { parseMaestroNetwork } from './network.js'
import { MaestroClientError, type MaestroMessageContent } from './types.js'

export type MaestroArtifact = z.infer<(typeof publicSchemas)['Public.Artifact']>
export type MaestroAttachment = Extract<MaestroMessageContent[number], { type: 'attachment' }>
export interface MaestroUploadOptions {
  /** Optional explicit client action to obtain an artifact-write credential before each attempt. */
  authorize?: (signal: AbortSignal) => Promise<void>
}
export interface MaestroUploadDraft {
  readonly id: string
  readonly filename: string
  readonly sizeBytes: number
  readonly state: 'pending' | 'error' | 'ready'
  readonly artifact?: MaestroArtifact
  readonly errorCode?: string
}
export interface MaestroArtifactResource {
  readonly url: string
  readonly mimeType: string
  readonly filename: string
  readonly expiresAt: number
  release(): void
}
type Host = {
  workspaceId: string | null
  request(path: string, init: RequestInit, threadId?: string): Promise<Response>
  failure(error: MaestroClientError, threadId?: string): void
}
type Intent = {
  authorize?: (signal: AbortSignal) => Promise<void>
  file: Blob
  filename: string
  key: string
  hash?: string
  controller: AbortController
  draft: MaestroUploadDraft
  inflight?: Promise<void>
}
const failure = (code: string, retryable = false) =>
  new MaestroClientError(code, 'Artifact request unavailable', retryable)
/** Private, bounded File intentions. These are neither canonical events nor storage references. */
export class MaestroArtifacts {
  private intents = new Map<string, Intent>()
  private resources = new Map<
    MaestroArtifactResource,
    { threadId: string; timer: ReturnType<typeof setTimeout> }
  >()
  private reads = new Map<AbortController, string>()
  private observers = new Set<() => void>()
  private snapshot: readonly MaestroUploadDraft[] = Object.freeze([])
  constructor(
    private host: Host,
    readonly maxBytes = 8 * 1024 * 1024
  ) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 64 * 1024 * 1024)
      throw failure('INVALID_CONFIG')
  }
  subscribe = (listener: () => void) => {
    this.observers.add(listener)
    return () => {
      this.observers.delete(listener)
    }
  }
  getSnapshot = () => this.snapshot
  private changed() {
    this.snapshot = Object.freeze([...this.intents.values()].map((i) => i.draft))
    for (const listener of this.observers) {
      try {
        listener()
      } catch {}
    }
  }
  /** Select once; retry retains the original bytes, key, hash and workspace. */
  add(file: Blob, filename: string, options: MaestroUploadOptions = {}): string {
    if (this.intents.size >= 16 || file.size < 1 || file.size > this.maxBytes)
      throw failure('PAYLOAD_TOO_LARGE')
    publicSchemas['Public.ArtifactCreateRequest'].parse({
      filename,
      mime_type: file.type,
      size_bytes: file.size,
      sha256: '0'.repeat(64),
      workspace_id: this.host.workspaceId,
    })
    // A quote cannot round-trip the strict multipart filename header. Reject instead of renaming user input.
    if (filename.includes('"')) throw failure('INVALID_REQUEST')
    const id = crypto.randomUUID()
    this.intents.set(id, {
      file,
      filename,
      authorize: options.authorize,
      key: crypto.randomUUID(),
      controller: new AbortController(),
      draft: Object.freeze({ id, filename, sizeBytes: file.size, state: 'pending' }),
    })
    this.changed()
    void this.retry(id).catch(() => {})
    return id
  }
  retry(id: string): Promise<void> {
    const intent = this.intents.get(id)
    if (!intent) return Promise.reject(failure('INVALID_REQUEST'))
    if (intent.inflight) return intent.inflight
    if (intent.draft.state === 'ready') return Promise.resolve()
    intent.draft = Object.freeze({
      id,
      filename: intent.filename,
      sizeBytes: intent.file.size,
      state: 'pending',
    })
    this.changed()
    const current = () => {
      if (this.intents.get(id) !== intent || intent.controller.signal.aborted)
        throw failure('DISCONNECTED')
    }
    const run = async () => {
      try {
        current()
        await intent.authorize?.(intent.controller.signal)
        current()
        if (!intent.hash) {
          const bytes = new Uint8Array(await intent.file.arrayBuffer())
          current()
          try {
            intent.hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
              .map((b) => b.toString(16).padStart(2, '0'))
              .join('')
          } finally {
            bytes.fill(0)
          }
        }
        current()
        const request = publicSchemas['Public.ArtifactCreateRequest'].parse({
          filename: intent.filename,
          mime_type: intent.file.type,
          size_bytes: intent.file.size,
          sha256: intent.hash,
          workspace_id: this.host.workspaceId,
        })
        const body = new FormData()
        body.append('metadata', JSON.stringify(request))
        body.append('file', intent.file, intent.filename)
        const response = await this.host.request('/artifacts', {
          method: 'POST',
          headers: { 'Idempotency-Key': intent.key },
          body,
          signal: intent.controller.signal,
        })
        const data = await this.readResponse(response, 65536, intent.controller.signal)
        current()
        if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? ''))
          throw failure('PROTOCOL_ERROR')
        const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data))
        if (!response.ok) throw this.responseError(value)
        if (response.status !== 201) throw failure('PROTOCOL_ERROR')
        const result = parseMaestroNetwork(publicSchemas['Public.UploadSessionResponse'], value)
        const a = result.artifact
        if (
          result.upload_mode !== 'multipart_proxy' ||
          a.state !== 'ready_unbound' ||
          a.filename !== request.filename ||
          a.mime_type !== request.mime_type ||
          a.size_bytes !== request.size_bytes ||
          a.sha256 !== request.sha256 ||
          !a.expires_at ||
          Date.parse(a.expires_at) <= Date.now()
        )
          throw failure('PROTOCOL_ERROR')
        intent.draft = Object.freeze({
          id,
          filename: intent.filename,
          sizeBytes: intent.file.size,
          state: 'ready',
          artifact: Object.freeze(a),
        })
      } catch (cause) {
        const e = cause instanceof MaestroClientError ? cause : failure('NETWORK_ERROR', true)
        if (this.intents.get(id) === intent)
          intent.draft = Object.freeze({
            id,
            filename: intent.filename,
            sizeBytes: intent.file.size,
            state: 'error',
            errorCode: e.code,
          })
        this.host.failure(e)
        throw e
      } finally {
        intent.inflight = undefined
        this.changed()
      }
    }
    intent.inflight = run()
    return intent.inflight
  }
  remove(id: string) {
    this.intents.get(id)?.controller.abort()
    this.intents.delete(id)
    this.changed()
  }
  clearUploads() {
    for (const i of this.intents.values()) i.controller.abort()
    this.intents.clear()
    this.changed()
  }
  clear() {
    this.clearUploads()
    for (const c of this.reads.keys()) c.abort()
    for (const r of this.resources.keys()) r.release()
    this.changed()
  }
  closeThread(threadId: string) {
    for (const [c, id] of this.reads) if (id === threadId) c.abort()
    for (const [r, entry] of this.resources) if (entry.threadId === threadId) r.release()
  }
  /** Blocks pending/failed/expired uploads. Returned parts contain no File, URL or token. */
  content(): MaestroAttachment[] {
    return [...this.intents.values()].map(({ draft }) => {
      const a = draft.artifact
      if (draft.state !== 'ready' || !a?.expires_at || Date.parse(a.expires_at) <= Date.now())
        throw failure('ARTIFACT_NOT_READY')
      return {
        type: 'attachment',
        artifact_id: a.artifact_id,
        filename: a.filename,
        mime_type: a.mime_type,
        size_bytes: a.size_bytes,
      }
    })
  }
  /** No bearer URL is exposed. Each explicit open performs a new authenticated proxy read; no background renewals. */
  async open(
    threadId: string,
    attachment: MaestroAttachment,
    signal?: AbortSignal
  ): Promise<MaestroArtifactResource> {
    if (this.reads.size >= 2 || this.resources.size >= 8) throw failure('RATE_LIMITED', true)
    threadId = uuidSchema.parse(threadId).toLowerCase()
    const id = uuidSchema.parse(attachment.artifact_id).toLowerCase()
    const c = new AbortController()
    this.reads.set(c, threadId)
    const lifetime = AbortSignal.any([c.signal, ...(signal ? [signal] : [])])
    const chunks: Uint8Array[] = []
    try {
      const response = await this.host.request(
        `/artifacts/${id}/download`,
        { method: 'GET', signal: lifetime },
        threadId
      )
      if (!response.ok) {
        const bytes = await this.readResponse(response, 65536, lifetime)
        throw this.responseError(
          JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
        )
      }
      if (
        response.status !== 200 ||
        response.headers.get('x-content-type-options') !== 'nosniff' ||
        !/^private,\s*no-store$/i.test(response.headers.get('cache-control') ?? '') ||
        !/^attachment(?:;|$)/i.test(response.headers.get('content-disposition') ?? '')
      )
        throw failure('PROTOCOL_ERROR')
      const type = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
      const length = response.headers.get('content-length')
      if (
        !length ||
        !/^[1-9][0-9]*$/.test(length) ||
        Number(length) > this.maxBytes ||
        (attachment.size_bytes !== undefined && Number(length) !== attachment.size_bytes) ||
        (attachment.mime_type && type !== attachment.mime_type)
      )
        throw failure('PROTOCOL_ERROR')
      const bytes = await this.readResponse(response, Number(length), lifetime, chunks)
      if (bytes.byteLength !== Number(length) || lifetime.aborted) throw failure('PROTOCOL_ERROR')
      const blob = new Blob([bytes], { type })
      bytes.fill(0)
      const url = URL.createObjectURL(blob)
      const resource: MaestroArtifactResource = Object.freeze({
        url,
        mimeType: type,
        filename: attachment.filename ?? 'attachment',
        expiresAt: Date.now() + 60000,
        release: () => {
          const entry = this.resources.get(resource)
          if (!entry) return
          clearTimeout(entry.timer)
          this.resources.delete(resource)
          URL.revokeObjectURL(url)
        },
      })
      this.resources.set(resource, { threadId, timer: setTimeout(() => resource.release(), 60000) })
      return resource
    } catch (cause) {
      const e = cause instanceof MaestroClientError ? cause : failure('NETWORK_ERROR', true)
      this.host.failure(e, threadId)
      throw e
    } finally {
      // Abort the native transport even when header validation exits before acquiring its reader.
      c.abort()
      for (const chunk of chunks) chunk.fill(0)
      this.reads.delete(c)
    }
  }
  private responseError(value: unknown) {
    const e = parseMaestroNetwork(publicSchemas['Public.Error'], value).error
    return failure(e.code, e.retryable)
  }
  private async readResponse(
    response: Response,
    max: number,
    signal: AbortSignal,
    chunks: Uint8Array[] = []
  ): Promise<Uint8Array<ArrayBuffer>> {
    const reader = response.body?.getReader()
    if (!reader) throw failure('PROTOCOL_ERROR')
    let count = 0
    const abort = () => {
      void reader.cancel().catch(() => {})
    }
    signal.addEventListener('abort', abort, { once: true })
    try {
      for (;;) {
        if (signal.aborted) throw failure('DISCONNECTED')
        const next = await reader.read()
        if (signal.aborted) {
          next.value?.fill(0)
          throw failure('DISCONNECTED')
        }
        if (next.done) break
        count += next.value.byteLength
        if (count > max) {
          next.value.fill(0)
          throw failure('PAYLOAD_TOO_LARGE')
        }
        chunks.push(next.value)
      }
      const result = new Uint8Array(count)
      let offset = 0
      for (const chunk of chunks) {
        result.set(chunk, offset)
        offset += chunk.byteLength
      }
      return result
    } finally {
      signal.removeEventListener('abort', abort)
      await reader.cancel().catch(() => {})
      reader.releaseLock()
      for (const chunk of chunks) chunk.fill(0)
    }
  }
}
