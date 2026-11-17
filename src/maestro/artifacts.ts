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
  /**
   * Local guard before a download: throws when the thread history in this client does not cite
   * the artifact. It sends nothing and is not an access loss, so `failure` is not called.
   */
  authorize?(threadId: string, artifactId: string): void
  request(path: string, init: RequestInit, threadId?: string): Promise<Response>
  failure(error: MaestroClientError, threadId?: string): void
  /** I1: the Maestro API base (`origin + prefix`); a view link must be on this origin. */
  apiBase?: string
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
/** Default per-file bound: same 25 MiB limit as the production chat upload policy. */
export const MAESTRO_DEFAULT_ARTIFACT_BYTES = 25 * 1024 * 1024
/**
 * True when an event payload cites the artifact. Generic on purpose: it does not depend on the
 * event type, so events added by later contracts (edits, form responses) authorize reads too.
 */
export function payloadReferencesArtifact(payload: unknown, artifactId: string): boolean {
  const wanted = artifactId.toLowerCase()
  const pending: { value: unknown; depth: number }[] = [{ value: payload, depth: 0 }]
  for (let visited = 0; pending.length && visited < 4096; visited++) {
    const { value, depth } = pending.pop()!
    if (!value || typeof value !== 'object' || depth > 12) continue
    if (Array.isArray(value)) {
      for (const item of value) pending.push({ value: item, depth: depth + 1 })
      continue
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === 'artifact_id' && typeof child === 'string' && child.toLowerCase() === wanted)
        return true
      if (child && typeof child === 'object') pending.push({ value: child, depth: depth + 1 })
    }
  }
  return false
}
/** Raster images that production components render in an `<img>`. */
const INLINE_IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
])
/**
 * SVG shows as an image, as in production (`<img src>`). It never gets a `blob:` URL: a `blob:` is
 * same-origin with the app, so a person who opens it in a new tab would run its script in the app
 * origin. `open()` gives SVG a `data:image/svg+xml` URL instead: an `<img>` renders it without script,
 * and a document opened from it has an opaque origin, never the app's (production opens the file from
 * the storage host, not from the app). The web renders it only inside `<img>`.
 */
export const MAESTRO_SVG_TYPE = 'image/svg+xml'
function dataUrl(type: string, bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  return `data:${type};base64,${btoa(binary)}`
}
/**
 * MIME type for the `blob:` URL of an artifact. A `blob:` URL is same-origin with the web app:
 * if a tab navigates to one of type text/html, SVG or XML, the file runs script in the app origin.
 * Only media that the production components render inline (raster images, audio) keep their real
 * type. Everything else gets `application/octet-stream`, so navigation downloads the file. Any type
 * whose subtype ends in `+xml` also gets it, even under `audio/`. SVG never reaches a `blob:` (see
 * `MAESTRO_SVG_TYPE`): it is shown from a `data:` URL.
 *
 * PDF (I1): the `blob:` is `application/octet-stream` too, so no PDF ever opens in the app origin.
 * Production opens a PDF in its View panel from the storage host, another origin; the View panel
 * here opens the Maestro's short-lived view link (`viewLink`), served `inline` from the Maestro
 * origin. The `blob:` only downloads the file, with its real name.
 */
export function maestroBlobType(mimeType: string): string {
  const type = mimeType.split(';')[0]!.trim().toLowerCase()
  // A `+xml` suffix marks an XML document whatever the type says (audio/x+xml, image/svg+xml).
  if (type.endsWith('+xml')) return 'application/octet-stream'
  if (INLINE_IMAGE_TYPES.has(type) || /^audio\/[a-z0-9][a-z0-9.+_-]*$/.test(type)) return type
  return 'application/octet-stream'
}
/** I1: the only type the person views through the Maestro's view link. */
export const MAESTRO_VIEW_TYPE = 'application/pdf'
const failure = (code: string, retryable = false, message = 'Artifact request unavailable') =>
  new MaestroClientError(code, message, retryable)
/** M3: the refusal of a `HEAD` (no body): the same codes the Maestro gives a GET with that status. */
function headError(status: number): MaestroClientError {
  if (status === 401) return failure('UNAUTHENTICATED')
  if (status === 403) return failure('FORBIDDEN')
  if (status === 404) return failure('NOT_FOUND')
  if (status === 409) return failure('ARTIFACT_NOT_READY', true)
  if (status === 429) return failure('RATE_LIMITED', true)
  return status >= 500 ? failure('DEPENDENCY_UNAVAILABLE', true) : failure('PROTOCOL_ERROR')
}
/** Production's text for a file over the limit (`POST /uploads` of the agent, HTTP 413). */
export const maestroFileTooLargeText = (maxBytes: number) => `File exceeds ${maxBytes} byte limit`
/**
 * The name production stores for a file the browser uploads (I1). Production's `POST /uploads` keeps
 * `UploadFile.filename` as Starlette decodes it from the multipart header: no NFC, no trim (NFD from
 * Safari or HFS+ stays NFD). The browser writes that header escaping three characters (HTML
 * multipart/form-data encoding): LF as `%0A`, CR as `%0D` and `"` as `%22`. An empty name is
 * `upload` (`file.filename or "upload"`). The Maestro gets the same name, so the handler, the
 * history and the download see what production shows.
 */
export function maestroUploadFilename(filename: string): string {
  const name = filename.replace(/\n/g, '%0A').replace(/\r/g, '%0D').replace(/"/g, '%22')
  return name || 'upload'
}
/** Uploads sent at the same time; the others wait. The Maestro accepts at least this many per person. */
export const MAESTRO_PARALLEL_UPLOADS = 4
/** Files selected at once (the message parts limit of the Maestro, `MESSAGE_MAX_PARTS`). */
export const MAESTRO_MAX_SELECTED_FILES = 20
/** Tries of one upload the Maestro answers with 429 (too many uploads at the same time). */
const UPLOAD_RATE_LIMITED_TRIES = 4
/** Production's multipart part type: the browser sends `application/octet-stream` for an unknown type. */
function uploadType(file: Blob): string {
  const type = file.type.split(';')[0]!.trim()
  return /^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(type) && type.length <= 128
    ? type
    : 'application/octet-stream'
}
function abortableDelay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(failure('DISCONNECTED'))
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, ms)
    const abort = () => {
      clearTimeout(timer)
      reject(failure('DISCONNECTED'))
    }
    signal.addEventListener('abort', abort, { once: true })
  })
}
/** Private, bounded File intentions. These are neither canonical events nor storage references. */
export class MaestroArtifacts {
  private intents = new Map<string, Intent>()
  private resources = new Map<
    MaestroArtifactResource,
    {
      threadId: string
      artifactId: string
      sizeBytes: number
      svg: boolean
      timer: ReturnType<typeof setTimeout>
    }
  >()
  private reads = new Map<AbortController, string>()
  private observers = new Set<() => void>()
  private snapshot: readonly MaestroUploadDraft[] = Object.freeze([])
  constructor(
    private host: Host,
    readonly maxBytes = MAESTRO_DEFAULT_ARTIFACT_BYTES
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
  add(file: Blob, selected: string, options: MaestroUploadOptions = {}): string {
    const filename = maestroUploadFilename(selected)
    // The texts production shows (`POST /uploads` of the agent and `AgentServer.chat_upload`).
    if (file.size > this.maxBytes)
      throw failure('PAYLOAD_TOO_LARGE', false, maestroFileTooLargeText(this.maxBytes))
    // An empty file (0 byte) is a file: production's `POST /uploads` stores it and the handler gets `data == b""`.
    if (this.intents.size >= MAESTRO_MAX_SELECTED_FILES)
      throw failure(
        'PAYLOAD_TOO_LARGE',
        false,
        `Too many files at once (${MAESTRO_MAX_SELECTED_FILES})`
      )
    publicSchemas['Public.ArtifactCreateRequest'].parse({
      filename,
      mime_type: uploadType(file),
      size_bytes: file.size,
      sha256: '0'.repeat(64),
      workspace_id: this.host.workspaceId,
    })
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
        const type = uploadType(intent.file)
        const request = publicSchemas['Public.ArtifactCreateRequest'].parse({
          filename: intent.filename,
          mime_type: type,
          size_bytes: intent.file.size,
          sha256: intent.hash,
          workspace_id: this.host.workspaceId,
        })
        let value: unknown
        let status = 0
        for (let attempt = 1; ; attempt++) {
          // At most MAESTRO_PARALLEL_UPLOADS at the same time: the composer sends all the selected files.
          await this.uploadSlot(intent.controller.signal)
          try {
            current()
            const body = new FormData()
            body.append('metadata', JSON.stringify(request))
            body.append(
              'file',
              type === intent.file.type ? intent.file : new Blob([intent.file], { type }),
              intent.filename
            )
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
            value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data))
            status = response.status
          } finally {
            this.releaseUploadSlot()
          }
          if (status < 400) break
          const error = this.responseError(value)
          // Too many uploads at the same time: wait as the Maestro asks (Retry-After) and send again.
          if (error.code !== 'RATE_LIMITED' || attempt >= UPLOAD_RATE_LIMITED_TRIES) throw error
          await abortableDelay(
            Math.min(5000, Math.max(250, (error.retryAfterSeconds ?? 1) * 1000)),
            intent.controller.signal
          )
          current()
        }
        if (status !== 201) throw failure('PROTOCOL_ERROR')
        const result = parseMaestroNetwork(publicSchemas['Public.UploadSessionResponse'], value)
        const a = result.artifact
        // The Maestro stores a canonical type (the extension's when the declared one is generic):
        // the attachment carries the stored one, as the SDK does.
        if (
          result.upload_mode !== 'multipart_proxy' ||
          a.state !== 'ready_unbound' ||
          a.filename !== request.filename ||
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
        // A network failure shows the browser's text, as production (`fetch` rejects with it).
        const e =
          cause instanceof MaestroClientError
            ? cause
            : failure(
                'NETWORK_ERROR',
                true,
                cause instanceof Error && cause.message ? cause.message : 'Upload failed'
              )
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
    this.host.authorize?.(threadId, id)
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
      // 0 is a length: an empty file (production stores the empty upload).
      if (
        !length ||
        !/^(?:0|[1-9][0-9]*)$/.test(length) ||
        Number(length) > this.maxBytes ||
        (attachment.size_bytes !== undefined && Number(length) !== attachment.size_bytes) ||
        (attachment.mime_type && type !== attachment.mime_type)
      )
        throw failure('PROTOCOL_ERROR')
      // An empty body may have no stream (Response without a body): nothing to read.
      if (Number(length) === 0) await response.body?.cancel().catch(() => {})
      const bytes =
        Number(length) === 0
          ? new Uint8Array(0)
          : await this.readResponse(response, Number(length), lifetime, chunks)
      if (bytes.byteLength !== Number(length) || lifetime.aborted) throw failure('PROTOCOL_ERROR')
      // SVG: a `data:` URL (opaque origin if opened), never a same-origin `blob:` (MAESTRO_SVG_TYPE).
      const svg = type === MAESTRO_SVG_TYPE
      const url = svg
        ? dataUrl(MAESTRO_SVG_TYPE, bytes)
        : URL.createObjectURL(new Blob([bytes], { type: maestroBlobType(type) }))
      bytes.fill(0)
      return this.track(
        { threadId, artifactId: id, sizeBytes: Number(length), svg },
        url,
        type,
        attachment.filename ?? 'attachment'
      )
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
  /** A live resource for 60 s: then its `blob:` URL is revoked (a `data:` URL has nothing to revoke). */
  private track(
    entry: { threadId: string; artifactId: string; sizeBytes: number; svg: boolean },
    url: string,
    mimeType: string,
    filename: string
  ): MaestroArtifactResource {
    const resource: MaestroArtifactResource = Object.freeze({
      url,
      mimeType,
      filename,
      expiresAt: Date.now() + 60000,
      release: () => {
        const live = this.resources.get(resource)
        if (!live) return
        clearTimeout(live.timer)
        this.resources.delete(resource)
        if (!live.svg) URL.revokeObjectURL(url)
      },
    })
    this.resources.set(resource, { ...entry, timer: setTimeout(() => resource.release(), 60000) })
    return resource
  }
  /**
   * Renews a live resource without downloading the file again (M7). One authenticated `HEAD` of the
   * download (M3: the Maestro runs the same authorization and reads no byte of the file) checks the
   * access again (history, credential, the Maestro's authorization); then the same URL and the same
   * bytes stay for another 60 s. The returned resource has the same `url`; the old object no longer
   * revokes it. Production loads an `<img src>` once and keeps it on screen; this keeps the 60 s
   * access check without the 25 MiB read.
   */
  async renew(
    resource: MaestroArtifactResource,
    signal?: AbortSignal
  ): Promise<MaestroArtifactResource> {
    const live = this.resources.get(resource)
    if (!live) throw failure('ARTIFACT_NOT_READY')
    if (this.reads.size >= 2) throw failure('RATE_LIMITED', true)
    const { threadId, artifactId, sizeBytes } = live
    const c = new AbortController()
    this.reads.set(c, threadId)
    const lifetime = AbortSignal.any([c.signal, ...(signal ? [signal] : [])])
    try {
      this.host.authorize?.(threadId, artifactId)
      const response = await this.host.request(
        `/artifacts/${artifactId}/download`,
        { method: 'HEAD', signal: lifetime },
        threadId
      )
      if (!response.ok) {
        // A HEAD has no body: the refusal comes from the status alone.
        await response.body?.cancel().catch(() => {})
        throw headError(response.status)
      }
      const type = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
      if (
        response.status !== 200 ||
        response.headers.get('x-content-type-options') !== 'nosniff' ||
        !/^private,\s*no-store$/i.test(response.headers.get('cache-control') ?? '') ||
        !/^attachment(?:;|$)/i.test(response.headers.get('content-disposition') ?? '') ||
        type !== resource.mimeType ||
        response.headers.get('content-length') !== String(sizeBytes)
      )
        throw failure('PROTOCOL_ERROR')
      await response.body?.cancel().catch(() => {})
      if (lifetime.aborted || this.resources.get(resource) !== live) throw failure('DISCONNECTED')
      clearTimeout(live.timer)
      this.resources.delete(resource)
      return this.track(live, resource.url, resource.mimeType, resource.filename)
    } catch (cause) {
      const e = cause instanceof MaestroClientError ? cause : failure('NETWORK_ERROR', true)
      this.host.failure(e, threadId)
      throw e
    } finally {
      c.abort()
      this.reads.delete(c)
    }
  }
  /**
   * I1: the short-lived link that shows a PDF of the thread in the View panel. The Maestro checks the
   * same access as the download (`POST /artifacts/:id/links`) and serves the file `inline` from its
   * own origin, with `nosniff` and no CSP, as production's storage host (another origin) serves the
   * PDF to the same `<iframe>`: the public chat is framed by third-party sites (N1). The link is
   * refused here when it is not on the Maestro origin. Only a file of type `application/pdf` has a
   * view link.
   *
   * N3: `UNSUPPORTED_CAPABILITY` means "no view link here", and only that: the Maestro is on the app
   * origin (a proxy; the PDF never opens in the app origin, so no request is sent) or the Maestro has
   * no links (`ARTIFACT_LINKS_ENABLED` off). The web then downloads the PDF; every other code is a
   * refusal or a failure it shows to the person.
   */
  async viewLink(
    threadId: string,
    attachment: MaestroAttachment,
    signal?: AbortSignal
  ): Promise<{ url: string; expiresAt: string }> {
    threadId = uuidSchema.parse(threadId).toLowerCase()
    const id = uuidSchema.parse(attachment.artifact_id).toLowerCase()
    if (attachment.mime_type?.split(';')[0]?.trim().toLowerCase() !== MAESTRO_VIEW_TYPE)
      throw failure('VALIDATION_FAILED')
    this.host.authorize?.(threadId, id)
    const maestro = this.host.apiBase ? new URL(this.host.apiBase) : undefined
    const app = (globalThis as { location?: { origin?: string } }).location?.origin
    if (maestro && maestro.origin === app)
      throw failure('UNSUPPORTED_CAPABILITY', false, 'No view link on the app origin')
    try {
      const response = await this.host.request(
        `/artifacts/${id}/links`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
          ...(signal ? { signal } : {}),
        },
        threadId
      )
      const bytes = await this.readResponse(response, 65536, signal ?? new AbortController().signal)
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
      if (!response.ok) throw this.responseError(value)
      const link = parseMaestroNetwork(publicSchemas['Public.ArtifactLinkResponse'], value)
      const url = new URL(link.url)
      if (
        response.status !== 200 ||
        !maestro ||
        url.origin !== maestro.origin ||
        url.origin === app ||
        !url.pathname.startsWith(`${maestro.pathname.replace(/\/$/, '')}/artifact-links/`) ||
        url.search ||
        url.hash
      )
        throw failure('PROTOCOL_ERROR')
      return { url: url.href, expiresAt: link.expires_at }
    } catch (cause) {
      const e =
        cause instanceof MaestroClientError
          ? cause
          : cause instanceof SyntaxError
            ? failure('PROTOCOL_ERROR')
            : failure('NETWORK_ERROR', true)
      this.host.failure(e, threadId)
      throw e
    }
  }
  /**
   * The Maestro's refusal with the text the person sees: production's text when production has one
   * (file over the limit), otherwise the Maestro's own message for that cause. Never a generic text.
   */
  private responseError(value: unknown) {
    const e = parseMaestroNetwork(publicSchemas['Public.Error'], value).error
    const retryAfter = e.details?.retry_after_seconds
    return new MaestroClientError(
      e.code,
      e.code === 'PAYLOAD_TOO_LARGE' ? maestroFileTooLargeText(this.maxBytes) : e.message,
      e.retryable,
      e.request_id,
      undefined,
      undefined,
      undefined,
      e.details?.reason_code,
      typeof retryAfter === 'number' ? retryAfter : undefined
    )
  }
  private uploading = 0
  private uploadWaiters: (() => void)[] = []
  private async uploadSlot(signal: AbortSignal) {
    while (this.uploading >= MAESTRO_PARALLEL_UPLOADS) {
      if (signal.aborted) throw failure('DISCONNECTED')
      await new Promise<void>((resolve) => {
        const wake = () => {
          signal.removeEventListener('abort', wake)
          this.uploadWaiters = this.uploadWaiters.filter((waiter) => waiter !== wake)
          resolve()
        }
        this.uploadWaiters.push(wake)
        signal.addEventListener('abort', wake, { once: true })
      })
    }
    if (signal.aborted) {
      // M9: a release may have woken this waiter for the free slot, and its upload was removed in the
      // same tick. Pass the wake-up on, or the next waiter would wait for its own abort.
      this.uploadWaiters.shift()?.()
      throw failure('DISCONNECTED')
    }
    this.uploading++
  }
  private releaseUploadSlot() {
    this.uploading--
    this.uploadWaiters.shift()?.()
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
