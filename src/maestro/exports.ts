import { z } from 'zod'
import { sequenceSchema, uuidSchema } from '../protocol/maestro/vendor/common.js'
import { publicSchemas } from '../protocol/maestro/vendor/public.js'
import { parseMaestroNetwork } from './network.js'
import { immutable } from './publications.js'
import { MaestroClientError } from './types.js'

export type MaestroExportResponse = z.infer<(typeof publicSchemas)['Public.ExportResponse']>
export interface MaestroExportReceipt {
  threadId: string
  idempotencyKey: string
  watermark?: string
  state: 'pending' | 'ready' | 'unknown' | 'rejected' | 'expired'
  result?: MaestroExportResponse
  errorCode?: string
}
const snapshotSchema = z.strictObject({
  format_version: z.literal('maestro.export.local.v1'),
  thread_id: uuidSchema,
  watermark: sequenceSchema,
  events: z.array(publicSchemas['Public.Event']).max(10000),
})
const failure = (code: string, message: string) => new MaestroClientError(code, message)
/** Export UUIDs and paths stay private; no generic artifact link, storage URL or auto-renewal. */
export class MaestroExports {
  private entries = new Map<string, MaestroExportReceipt>()
  private flights = new Map<string, Promise<MaestroExportResponse>>()
  private readers = new Map<string, AbortController>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private listeners = new Set<() => void>()
  private snapshot: readonly MaestroExportReceipt[] = Object.freeze([])
  private generation = 0
  constructor(
    private readonly generate: (
      threadId: string,
      key: string,
      watermark?: string
    ) => Promise<unknown>,
    private readonly download: (
      threadId: string,
      path: string,
      signal: AbortSignal
    ) => Promise<Response>,
    private readonly apiPrefix: string,
    private readonly timeoutMs: number,
    private readonly denied: (error: MaestroClientError, threadId: string) => void
  ) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  getSnapshot = () => this.snapshot
  request(threadId: string, options: { watermark?: string } = {}): Promise<MaestroExportResponse> {
    threadId = uuidSchema.parse(threadId).toLowerCase()
    if (options.watermark !== undefined) sequenceSchema.parse(options.watermark)
    const prior = this.entries.get(threadId)
    if (prior && ['pending', 'unknown'].includes(prior.state)) {
      if (prior.watermark !== options.watermark)
        return Promise.reject(
          failure(
            'IDEMPOTENCY_CONFLICT',
            'Confirm the previous export before changing its snapshot'
          )
        )
      return this.run(prior)
    }
    if (this.entries.size >= 100 && !prior)
      return Promise.reject(failure('CLIENT_LIMIT', 'Export receipt limit reached'))
    return this.run(
      immutable({ threadId, idempotencyKey: crypto.randomUUID(), ...options, state: 'pending' })
    )
  }
  retry(threadId: string) {
    const prior = this.entries.get(uuidSchema.parse(threadId).toLowerCase())
    if (!prior || prior.state !== 'unknown')
      return Promise.reject(failure('INVALID_REQUEST', 'No uncertain export to confirm'))
    return this.run(prior)
  }
  private run(intent: MaestroExportReceipt): Promise<MaestroExportResponse> {
    const flight = this.flights.get(intent.threadId)
    if (flight) return flight
    const generation = this.generation
    this.set({ ...intent, state: 'pending' })
    const current = () =>
      generation === this.generation &&
      this.entries.get(intent.threadId)?.idempotencyKey === intent.idempotencyKey
    const promise = Promise.resolve()
      .then(() => {
        if (!current()) throw failure('FORBIDDEN', 'Export scope changed')
        return this.generate(intent.threadId, intent.idempotencyKey, intent.watermark)
      })
      .then((value) => {
        const result = parseMaestroNetwork(publicSchemas['Public.ExportResponse'], value)
        const remaining = Date.parse(result.expires_at) - Date.now()
        if (
          result.download_path !==
            `${this.apiPrefix}/exports/artifacts/${result.artifact_id}/download` ||
          remaining <= 0 ||
          remaining > 600000 ||
          (intent.watermark && intent.watermark !== result.watermark)
        )
          throw failure('PROTOCOL_ERROR', 'Invalid export receipt')
        if (!current()) throw failure('FORBIDDEN', 'Export access changed')
        this.set({ ...intent, result, state: 'ready' })
        clearTimeout(this.timers.get(intent.threadId))
        this.timers.set(
          intent.threadId,
          setTimeout(() => {
            this.readers.get(intent.threadId)?.abort()
            if (current()) this.set({ ...intent, state: 'expired' })
            this.timers.delete(intent.threadId)
          }, remaining)
        )
        return result
      })
      .catch((cause: unknown) => {
        const error =
          cause instanceof MaestroClientError
            ? cause
            : failure('NETWORK_ERROR', 'Export confirmation unavailable')
        if (current())
          this.set({
            ...intent,
            state:
              error.publicationState === 'rejected' ||
              [
                'FORBIDDEN',
                'UNAUTHENTICATED',
                'UNSUPPORTED_CAPABILITY',
                'INVALID_REQUEST',
              ].includes(error.code)
                ? 'rejected'
                : 'unknown',
            errorCode: error.code,
          })
        throw error
      })
      .finally(() => {
        if (this.flights.get(intent.threadId) === promise) this.flights.delete(intent.threadId)
      })
    this.flights.set(intent.threadId, promise)
    return promise
  }
  async open(threadId: string): Promise<Blob> {
    threadId = uuidSchema.parse(threadId).toLowerCase()
    const receipt = this.entries.get(threadId),
      result = receipt?.result
    if (
      !receipt ||
      receipt.state !== 'ready' ||
      !result ||
      Date.parse(result.expires_at) <= Date.now()
    )
      throw failure('EXPORT_EXPIRED', 'Export is unavailable or expired')
    if (this.readers.has(threadId) || this.readers.size >= 2)
      throw failure('CLIENT_LIMIT', 'Export download already in progress')
    const controller = new AbortController(),
      generation = this.generation
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(Math.min(this.timeoutMs, Date.parse(result.expires_at) - Date.now())),
    ])
    this.readers.set(threadId, controller)
    let response: Response | undefined, reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    try {
      response = await this.download(
        threadId,
        result.download_path.slice(this.apiPrefix.length),
        signal
      )
      if (!response.ok) {
        if (
          response.status === 401 ||
          response.status === 403 ||
          response.status === 404 ||
          response.status === 410
        ) {
          const error = failure(
            response.status === 401 ? 'UNAUTHENTICATED' : 'FORBIDDEN',
            'Export access removed or expired'
          )
          this.removeThread(threadId)
          this.denied(error, threadId)
          throw error
        }
        throw failure('NETWORK_ERROR', 'Export download unavailable')
      }
      const length = response.headers.get('content-length'),
        size = Number(length)
      if (
        response.status !== 200 ||
        response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !==
          'text/plain' ||
        response.headers.get('x-content-type-options')?.toLowerCase() !== 'nosniff' ||
        !response.headers
          .get('cache-control')
          ?.toLowerCase()
          .split(',')
          .map((value) => value.trim())
          .includes('no-store') ||
        !/^attachment(?:;|$)/i.test(response.headers.get('content-disposition') ?? '') ||
        (response.headers.get('content-encoding') &&
          response.headers.get('content-encoding') !== 'identity') ||
        (length !== null &&
          (!/^\d+$/.test(length) || !Number.isSafeInteger(size) || size > 8388608))
      )
        throw failure('PROTOCOL_ERROR', 'Unsafe export download headers')
      reader = response.body?.getReader()
      if (!reader) throw failure('PROTOCOL_ERROR', 'Empty export download')
      const chunks: Uint8Array[] = []
      let total = 0
      for (;;) {
        if (signal.aborted) throw failure('TIMEOUT', 'Export download expired')
        const currentReader = reader
        const chunk = await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
          const onAbort = () => reject(failure('TIMEOUT', 'Export download canceled or expired'))
          signal.addEventListener('abort', onAbort, { once: true })
          if (signal.aborted) onAbort()
          currentReader
            .read()
            .then(resolve, reject)
            .finally(() => signal.removeEventListener('abort', onAbort))
        })
        if (chunk.done) break
        total += chunk.value.byteLength
        if (total > 8388608) throw failure('PROTOCOL_ERROR', 'Export exceeds byte limit')
        chunks.push(chunk.value)
      }
      if (length !== null && total !== size)
        throw failure('PROTOCOL_ERROR', 'Truncated export download')
      const bytes = new Uint8Array(total)
      let offset = 0
      for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.byteLength
      }
      const hash = response.headers.get('x-content-sha256')
      if (hash) {
        if (!/^[0-9a-f]{64}$/.test(hash)) throw failure('PROTOCOL_ERROR', 'Invalid export hash')
        const actual = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
          .map((byte) => byte.toString(16).padStart(2, '0'))
          .join('')
        if (actual !== hash) throw failure('PROTOCOL_ERROR', 'Export hash mismatch')
      }
      const value = snapshotSchema.parse(
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
      )
      if (
        value.thread_id !== threadId ||
        value.watermark !== result.watermark ||
        value.events.some((event) => event.thread_id !== threadId) ||
        generation !== this.generation ||
        signal.aborted ||
        this.entries.get(threadId) !== receipt ||
        Date.parse(result.expires_at) <= Date.now()
      )
        throw failure('FORBIDDEN', 'Export changed during download')
      return new Blob([bytes], { type: 'text/plain' })
    } finally {
      controller.abort()
      if (reader) {
        await reader.cancel().catch(() => {})
        reader.releaseLock()
      } else await response?.body?.cancel().catch(() => {})
      if (this.readers.get(threadId) === controller) this.readers.delete(threadId)
    }
  }
  cancelOpen(threadId: string) {
    this.readers.get(uuidSchema.parse(threadId).toLowerCase())?.abort()
  }
  removeThread(threadId: string) {
    clearTimeout(this.timers.get(threadId))
    this.timers.delete(threadId)
    this.readers.get(threadId)?.abort()
    this.readers.delete(threadId)
    this.entries.delete(threadId)
    this.flights.delete(threadId)
    this.changed()
  }
  clear() {
    this.generation++
    for (const id of [...this.entries.keys()]) this.removeThread(id)
  }
  private set(receipt: MaestroExportReceipt) {
    this.entries.set(receipt.threadId, immutable(receipt))
    this.changed()
  }
  private changed() {
    this.snapshot = Object.freeze([...this.entries.values()])
    for (const listener of this.listeners) listener()
  }
}
