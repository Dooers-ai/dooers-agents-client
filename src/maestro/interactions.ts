import { z } from 'zod'
import type { MaestroEvent, toMaestroPersistedResponse } from '../protocol/maestro/contracts.js'
import { uuidSchema } from '../protocol/maestro/vendor/common.js'
import { publicSchemas } from '../protocol/maestro/vendor/public.js'
import { canonical, immutable } from './publications.js'
import type { MaestroStoreSnapshot } from './store.js'
import { MaestroClientError, type MaestroTransport } from './types.js'

export const maestroInteractionArtifactsSchema = z.strictObject({
  format_version: z.literal('maestro.interaction-artifacts.local.v1'),
  interaction_id: uuidSchema,
  items: z
    .array(
      z.strictObject({
        artifact_id: uuidSchema,
        field_name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/),
        filename: publicSchemas['Public.Artifact'].shape.filename,
      })
    )
    .max(3200),
})
export type MaestroBoundFieldArtifact = z.infer<
  typeof maestroInteractionArtifactsSchema
>['items'][number]
/** Public durable form types; no checkpoint, private response or legacy FormEvent. */
export type MaestroInteraction = z.infer<(typeof publicSchemas)['Public.Interaction']>
export type MaestroFormDefinition = Extract<MaestroInteraction['definition'], { kind: 'form' }>
export type MaestroFormField = MaestroFormDefinition['fields'][number]
export type MaestroFormResponse = Extract<
  z.infer<(typeof publicSchemas)['Public.InteractionResponseRequest']>,
  { action: 'submit' | 'cancel' }
>
export type MaestroInteractionResult = ReturnType<typeof toMaestroPersistedResponse>
export interface MaestroInteractionIntent {
  threadId: string
  interactionId: string
  idempotencyKey: string
  request: MaestroFormResponse
}
export interface MaestroInteractionReceipt {
  intent: Readonly<MaestroInteractionIntent>
  state: 'pending' | 'unknown' | 'persisted' | 'conflict' | 'rejected'
  result?: MaestroInteractionResult
  errorCode?: string
}
export interface MaestroInteractionView {
  interaction: MaestroInteraction
  formEventId: string
  originEventId: string
  originExecutionId: string
  decision: Extract<MaestroEvent, { type: 'interaction.responded' | 'interaction.expired' }> | null
  phaseId: string | null
  state: MaestroInteraction['state']
  waitingForInput: boolean
  resuming: boolean
}
const fail = (code: string) => new MaestroClientError(code, 'Durable interaction unavailable')
const id = (value: string) => uuidSchema.parse(value).toLowerCase()

/** Explicit local intentions. Replay observes decisions and never performs I/O. */
export class MaestroInteractions {
  private generation = 0
  private entries = new Map<string, MaestroInteractionReceipt>()
  private flights = new Map<string, Promise<MaestroInteractionResult>>()
  private bindings = new Set<string>()
  private listeners = new Set<() => void>()
  private snapshot: readonly MaestroInteractionReceipt[] = Object.freeze([])
  constructor(
    private readonly send: (
      intent: Readonly<MaestroInteractionIntent>,
      transport?: MaestroTransport
    ) => Promise<MaestroInteractionResult>,
    private readonly read: () => MaestroStoreSnapshot,
    private readonly limit = 1000,
    private readonly bind?: (
      threadId: string,
      interactionId: string,
      fieldName: string,
      artifactId: string
    ) => Promise<void>,
    private readonly recover?: (
      threadId: string,
      interactionId: string,
      signal: AbortSignal
    ) => Promise<MaestroBoundFieldArtifact[]>,
    private readonly authorize?: (
      threadId: string,
      interactionId: string,
      request: MaestroFormResponse
    ) => void
  ) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  getSnapshot = () => this.snapshot
  current(threadId: string, interactionId: string): MaestroInteractionView | null {
    threadId = id(threadId)
    interactionId = id(interactionId)
    const state = this.read().threads[threadId]
    let created: Extract<MaestroEvent, { type: 'interaction.created' }> | undefined
    let decision: MaestroInteractionView['decision'] = null
    for (const item of Object.values(state?.eventsById ?? {})) {
      if (!item.known) continue
      const event = item.event
      if (
        event.type === 'interaction.created' &&
        event.payload.interaction.interaction_id === interactionId
      )
        created = event
      if (
        (event.type === 'interaction.responded' || event.type === 'interaction.expired') &&
        event.payload.interaction_id === interactionId &&
        (!decision || BigInt(event.sequence) > BigInt(decision.sequence))
      )
        decision = event
    }
    if (!created || created.payload.interaction.definition.kind !== 'form') return null
    const interaction = created.payload.interaction
    // Never treat an older projection as a resurrection of an observed decision.
    if (decision && BigInt(decision.sequence) <= BigInt(created.sequence)) decision = null
    const terminal =
      decision?.type === 'interaction.expired'
        ? 'expired'
        : decision?.type === 'interaction.responded'
          ? decision.payload.action === 'submit'
            ? 'submitted'
            : decision.payload.action === 'cancel'
              ? 'canceled'
              : interaction.state
          : interaction.state
    const delivery = state?.deliveriesById[interaction.delivery_id]
    const phaseId = decision?.type === 'interaction.responded' ? decision.payload.phase_id : null
    return immutable({
      interaction: { ...interaction, state: terminal },
      formEventId: created.eventId,
      originEventId: interaction.origin_event_id,
      originExecutionId: interaction.execution_id,
      decision,
      phaseId,
      state: terminal,
      waitingForInput: terminal === 'pending',
      resuming:
        terminal === 'submitted' &&
        delivery?.phase_id === interactionId &&
        ['pending', 'running', 'retry_wait'].includes(delivery.state),
    })
  }
  list(threadId: string): readonly MaestroInteractionView[] {
    const ids = new Set<string>()
    for (const item of Object.values(this.read().threads[id(threadId)]?.eventsById ?? {}))
      if (
        item.known &&
        item.event.type === 'interaction.created' &&
        item.event.payload.interaction.definition.kind === 'form'
      )
        ids.add(item.event.payload.interaction.interaction_id)
    return [...ids].map((interactionId) => this.current(threadId, interactionId)!).filter(Boolean)
  }
  /** Only a correlated server binder receipt can authorize a local artifact reference. */
  async bindArtifact(
    threadId: string,
    interactionId: string,
    fieldName: string,
    artifactId: string
  ) {
    if (!this.bind) throw fail('UNSUPPORTED_CAPABILITY')
    const key = JSON.stringify([id(threadId), id(interactionId), fieldName, id(artifactId)])
    if (!this.bindings.has(key) && this.bindings.size >= this.limit * 32) throw fail('CLIENT_LIMIT')
    const generation = this.generation
    await this.bind(threadId, interactionId, fieldName, artifactId)
    if (generation !== this.generation) throw fail('FORBIDDEN')
    this.bindings.add(JSON.stringify([id(threadId), id(interactionId), fieldName, id(artifactId)]))
  }
  async restoreArtifacts(threadId: string, interactionId: string, signal: AbortSignal) {
    if (!this.recover) throw fail('UNSUPPORTED_CAPABILITY')
    const generation = this.generation
    const items = await this.recover(threadId, interactionId, signal)
    if (generation !== this.generation || signal.aborted) throw fail('FORBIDDEN')
    for (const item of items) {
      const key = JSON.stringify([
        id(threadId),
        id(interactionId),
        item.field_name,
        id(item.artifact_id),
      ])
      if (!this.bindings.has(key) && this.bindings.size >= this.limit * 32)
        throw fail('CLIENT_LIMIT')
      this.bindings.add(key)
    }
    return items
  }
  validate(
    threadId: string,
    interactionId: string,
    request: MaestroFormResponse
  ): MaestroFormResponse {
    const parsed = publicSchemas['Public.InteractionResponseRequest'].parse(request)
    if (parsed.action !== 'submit' && parsed.action !== 'cancel') throw fail('INVALID_REQUEST')
    const view = this.current(threadId, interactionId)
    if (!view || view.interaction.definition.kind !== 'form') throw fail('NOT_FOUND')
    if (parsed.action === 'cancel') return parsed
    const fields = view.interaction.definition.fields
    if (Object.keys(parsed.data).some((name) => !fields.some((field) => field.name === name)))
      throw fail('VALIDATION_FAILED')
    for (const field of fields) {
      const value = Object.hasOwn(parsed.data, field.name) ? parsed.data[field.name] : undefined
      if (value === undefined || value === null) {
        if (field.required) throw fail('VALIDATION_FAILED')
        continue
      }
      if (
        field.type === 'text' &&
        (typeof value !== 'string' ||
          value.length > field.max_length ||
          (field.required && !value.trim()))
      )
        throw fail('VALIDATION_FAILED')
      if (
        field.type === 'number' &&
        (typeof value !== 'number' ||
          !Number.isFinite(value) ||
          value < field.minimum ||
          value > field.maximum)
      )
        throw fail('VALIDATION_FAILED')
      if (field.type === 'boolean' && typeof value !== 'boolean') throw fail('VALIDATION_FAILED')
      if (
        field.type === 'select' &&
        (typeof value !== 'string' || !field.options.some((option) => option.value === value))
      )
        throw fail('VALIDATION_FAILED')
      if (field.type === 'artifact') {
        if (
          !Array.isArray(value) ||
          value.length > field.max_files ||
          (field.required && value.length === 0) ||
          new Set(value).size !== value.length
        )
          throw fail('VALIDATION_FAILED')
        const normalized = value.map((value) => id(value)).sort()
        if (new Set(normalized).size !== normalized.length) throw fail('VALIDATION_FAILED')
        parsed.data[field.name] = normalized
        for (const artifactId of normalized)
          if (
            !this.bindings.has(
              JSON.stringify([id(threadId), id(interactionId), field.name, id(artifactId)])
            )
          )
            throw fail('ARTIFACT_NOT_READY')
      }
    }
    if (new TextEncoder().encode(JSON.stringify(parsed)).length > 65536)
      throw fail('PAYLOAD_TOO_LARGE')
    return parsed
  }
  request(
    threadId: string,
    interactionId: string,
    request: MaestroFormResponse,
    options: { transport?: MaestroTransport } = {}
  ) {
    threadId = id(threadId)
    interactionId = id(interactionId)
    const key = JSON.stringify([threadId, interactionId]),
      previous = this.entries.get(key)
    if (!previous || previous.state === 'rejected') {
      try {
        this.authorize?.(threadId, interactionId, request)
      } catch (cause) {
        return Promise.reject(cause)
      }
    }
    const parsed = this.validate(threadId, interactionId, request)
    if (previous && previous.state !== 'rejected') {
      if (canonical(previous.intent.request) !== canonical(parsed))
        return Promise.reject(fail('IDEMPOTENCY_CONFLICT'))
      if (previous.state === 'persisted') return Promise.resolve(previous.result!)
      if (previous.state === 'pending' || previous.state === 'unknown')
        return this.run(key, previous.intent, options.transport)
      if (previous.state === 'conflict')
        return Promise.reject(fail('INTERACTION_ALREADY_RESPONDED'))
    }
    const view = this.current(threadId, interactionId)!
    if (view.state !== 'pending') return Promise.reject(fail('INTERACTION_ALREADY_RESPONDED'))
    if (Date.parse(view.interaction.definition.expires_at) <= Date.now())
      return Promise.reject(fail('INTERACTION_EXPIRED'))
    if (!previous && this.entries.size >= this.limit) return Promise.reject(fail('CLIENT_LIMIT'))
    return this.run(
      key,
      immutable({ threadId, interactionId, idempotencyKey: crypto.randomUUID(), request: parsed }),
      options.transport
    )
  }
  retry(threadId: string, interactionId: string, options: { transport?: MaestroTransport } = {}) {
    const key = JSON.stringify([id(threadId), id(interactionId)]),
      previous = this.entries.get(key)
    if (!previous || previous.state !== 'unknown') return Promise.reject(fail('INVALID_REQUEST'))
    return this.run(key, previous.intent, options.transport)
  }
  private run(
    key: string,
    intent: Readonly<MaestroInteractionIntent>,
    transport?: MaestroTransport
  ): Promise<MaestroInteractionResult> {
    const flight = this.flights.get(key)
    if (flight) return flight
    this.set(key, { intent, state: 'pending' })
    const current = () => this.entries.get(key)?.intent === intent
    const promise = Promise.resolve()
      .then(() => {
        if (!current()) throw fail('DISCONNECTED')
        return this.send(intent, transport)
      })
      .then((result) => {
        if (!current()) throw fail('FORBIDDEN')
        this.set(key, { intent, state: 'persisted', result })
        return result
      })
      .catch((cause: unknown) => {
        const error = cause instanceof MaestroClientError ? cause : fail('NETWORK_ERROR')
        if (current())
          this.set(key, {
            intent,
            state: ['IDEMPOTENCY_CONFLICT', 'INTERACTION_ALREADY_RESPONDED', 'CONFLICT'].includes(
              error.code
            )
              ? 'conflict'
              : error.publicationState === 'rejected' ||
                  [
                    'UNSUPPORTED_CAPABILITY',
                    'INVALID_REQUEST',
                    'VALIDATION_FAILED',
                    'FORBIDDEN',
                    'UNAUTHENTICATED',
                    'INTERACTION_EXPIRED',
                    'ARTIFACT_NOT_READY',
                    'NOT_FOUND',
                  ].includes(error.code)
                ? 'rejected'
                : 'unknown',
            errorCode: error.code,
          })
        throw error
      })
      .finally(() => {
        if (this.flights.get(key) === promise) this.flights.delete(key)
      })
    this.flights.set(key, promise)
    return promise
  }
  removeThread(threadId: string) {
    threadId = id(threadId)
    for (const [key, value] of this.entries)
      if (value.intent.threadId === threadId) {
        this.entries.delete(key)
        this.flights.delete(key)
      }
    for (const key of this.bindings) if (JSON.parse(key)[0] === threadId) this.bindings.delete(key)
    this.changed()
  }
  clear() {
    this.generation++
    this.entries.clear()
    this.flights.clear()
    this.bindings.clear()
    this.changed()
  }
  private set(key: string, value: MaestroInteractionReceipt) {
    this.entries.set(key, immutable(value))
    this.changed()
  }
  private changed() {
    this.snapshot = Object.freeze([...this.entries.values()])
    for (const listener of this.listeners) {
      try {
        listener()
      } catch {}
    }
  }
}
