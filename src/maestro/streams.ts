import type { z } from 'zod'
import type { wsFrameSchemas } from '../protocol/maestro/vendor/public.js'

export type MaestroStreamDelta = Extract<
  z.infer<(typeof wsFrameSchemas)[string]>['payload'],
  { delta: string }
>
export type MaestroStreamReset = Extract<
  z.infer<(typeof wsFrameSchemas)[string]>['payload'],
  { output_id: string; reason_code: string }
>
export interface MaestroStream {
  readonly threadId: string
  readonly executionId: string
  readonly outputId: string
  readonly participantId: string
  readonly text: string
  readonly chunkCount: number
  readonly byteLength: number
  readonly ephemeral: true
}
/** E09-01 local policy. Never governs the size of a durable final. */
export const maestroStreamLimits = Object.freeze({
  deltaBytes: 16384,
  outputBytes: 65536,
  sessionBytes: 262144,
  activeOutputs: 16,
  outputChunks: 256,
  controlEntries: 128,
})
export const maestroStreamKey = (executionId: string, outputId: string) =>
  JSON.stringify([executionId, outputId])
const outputKey = (threadId: string, executionId: string, outputId: string) =>
  JSON.stringify([threadId, executionId, outputId])
const executionKey = (threadId: string, executionId: string) =>
  JSON.stringify([threadId, executionId])
type PartialStream = { stream: MaestroStream; chunks: string[] }

/** Bounded provisional projection. No canonical events, cursors, receipts or effect ledger. */
export class MaestroStreams {
  private partials = new Map<string, PartialStream>()
  private closed = new Set<string>()
  private terminal = new Set<string>()
  private totalBytes = 0
  private enabled = false
  private exhausted = false
  get resyncRequired() {
    return this.exhausted
  }
  get controlCount() {
    return this.closed.size + this.terminal.size
  }
  get byteLength() {
    return this.totalBytes
  }
  get activeCount() {
    return this.partials.size
  }
  capability(enabled: boolean) {
    if (!enabled) this.interrupt()
    this.enabled = enabled
  }
  private overflow() {
    this.exhausted = true
    this.partials.clear()
    this.totalBytes = 0
  }
  private remove(key: string) {
    const partial = this.partials.get(key)
    if (partial) this.totalBytes -= partial.stream.byteLength
    this.partials.delete(key)
  }
  private close(key: string) {
    this.remove(key)
    if (this.closed.has(key) || this.exhausted) return
    if (this.controlCount >= maestroStreamLimits.controlEntries) this.overflow()
    else this.closed.add(key)
  }
  /** Keep output tombstones until scope disposal: reconnect must not resurrect a known partial. */
  interrupt(threadId?: string) {
    for (const [key, partial] of this.partials)
      if (!threadId || partial.stream.threadId === threadId) this.close(key)
  }
  removeParticipant(threadId: string, participantId: string) {
    for (const [key, partial] of this.partials)
      if (partial.stream.threadId === threadId && partial.stream.participantId === participantId)
        this.close(key)
  }
  final(threadId: string, executionId: string, outputId: string) {
    this.close(outputKey(threadId, executionId, outputId))
  }
  endExecution(threadId: string, executionId: string) {
    const key = executionKey(threadId, executionId)
    for (const [id, partial] of this.partials)
      if (partial.stream.threadId === threadId && partial.stream.executionId === executionId)
        this.remove(id)
    if (this.terminal.has(key) || this.exhausted) return
    if (this.controlCount >= maestroStreamLimits.controlEntries) this.overflow()
    else this.terminal.add(key)
  }
  reset(frame: MaestroStreamReset) {
    if (!this.enabled || this.exhausted) return
    this.close(outputKey(frame.thread_id, frame.execution_id, frame.output_id))
  }
  delta(frame: MaestroStreamDelta) {
    if (!this.enabled || this.exhausted) return
    const key = outputKey(frame.thread_id, frame.execution_id, frame.output_id)
    if (
      this.closed.has(key) ||
      this.terminal.has(executionKey(frame.thread_id, frame.execution_id))
    )
      return
    if (this.controlCount >= maestroStreamLimits.controlEntries) {
      this.overflow()
      return
    }
    const partial = this.partials.get(key)
    const chunks = partial?.chunks ?? []
    const bytes = new TextEncoder().encode(frame.delta).length
    if (
      !Number.isSafeInteger(frame.chunk_index) ||
      frame.chunk_index < 0 ||
      !frame.delta.length ||
      frame.delta.length > 16384 ||
      bytes > maestroStreamLimits.deltaBytes ||
      (partial && partial.stream.participantId !== frame.participant_id)
    ) {
      this.close(key)
      return
    }
    if (frame.chunk_index < chunks.length) {
      if (chunks[frame.chunk_index] !== frame.delta) this.close(key)
      return
    }
    if (
      frame.chunk_index !== chunks.length ||
      chunks.length >= maestroStreamLimits.outputChunks ||
      (partial?.stream.byteLength ?? 0) + bytes > maestroStreamLimits.outputBytes ||
      (!partial && this.partials.size >= maestroStreamLimits.activeOutputs) ||
      this.totalBytes + bytes > maestroStreamLimits.sessionBytes
    ) {
      this.close(key)
      return
    }
    chunks.push(frame.delta)
    this.partials.set(key, {
      chunks,
      stream: Object.freeze({
        threadId: frame.thread_id,
        executionId: frame.execution_id,
        outputId: frame.output_id,
        participantId: frame.participant_id,
        text: chunks.join(''),
        chunkCount: chunks.length,
        byteLength: (partial?.stream.byteLength ?? 0) + bytes,
        ephemeral: true,
      }),
    })
    this.totalBytes += bytes
  }
  forThread(threadId: string): Readonly<Record<string, MaestroStream>> {
    return Object.freeze(
      Object.fromEntries(
        [...this.partials.values()]
          .filter(({ stream }) => stream.threadId === threadId)
          .map(({ stream }) => [maestroStreamKey(stream.executionId, stream.outputId), stream])
      )
    )
  }
  /** Only full scope disposal releases tombstones and the exhausted latch. */
  clear() {
    this.partials.clear()
    this.closed.clear()
    this.terminal.clear()
    this.totalBytes = 0
    this.exhausted = false
    this.enabled = false
  }
}
