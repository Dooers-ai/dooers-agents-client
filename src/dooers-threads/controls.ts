import { uuidSchema } from '../protocol/dooers-threads/vendor/common.js'
import { wsCommandSchemas } from '../protocol/dooers-threads/vendor/public.js'
import { canonical, immutable } from './publications.js'
import type { DooersThreadsStoreSnapshot } from './store.js'
import { DooersThreadsClientError, type DooersThreadsTransport } from './types.js'

export type DooersThreadsControlInput = {
  threadId: string
  idempotencyKey?: string
  reasonCode?: string
} & ({ type: 'execution.cancel'; executionId: string } | { type: 'root.stop'; rootEventId: string })
export type DooersThreadsControlIntent = Readonly<
  DooersThreadsControlInput & { idempotencyKey: string }
>
export type DooersThreadsControlState =
  | 'pending'
  | 'requested'
  | 'unconfirmed'
  | 'unknown'
  | 'rejected'
  | 'observed'
export interface DooersThreadsControl {
  intent: DooersThreadsControlIntent
  state: DooersThreadsControlState
  /** Only canonical replay/state can supply this field; ACK is never terminal. */
  outcome?: string
  errorCode?: string
}
const targetKey = (input: DooersThreadsControlInput) =>
  JSON.stringify([
    input.threadId,
    input.type,
    input.type === 'execution.cancel' ? input.executionId : input.rootEventId,
  ])

/** Bounded, private command receipts. Not an execution or effect ledger. No automatic command retry. */
export class DooersThreadsControls {
  private entries = new Map<string, DooersThreadsControl>()
  private flights = new Map<string, Promise<void>>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private listeners = new Set<() => void>()
  private snapshot: readonly DooersThreadsControl[] = Object.freeze([])
  private generation = 0
  private projections = new Map<string, { events: unknown; executions: unknown; phase: unknown }>()
  constructor(
    private readonly send: (
      intent: DooersThreadsControlIntent,
      transport?: DooersThreadsTransport
    ) => Promise<void>,
    private readonly read: () => DooersThreadsStoreSnapshot,
    private readonly limit = 1000,
    private readonly confirmationMs = 30000
  ) {}
  getSnapshot = () => this.snapshot
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  prepare(input: DooersThreadsControlInput): DooersThreadsControlIntent {
    const threadId = uuidSchema.parse(input.threadId).toLowerCase()
    const idempotencyKey = input.idempotencyKey ?? crypto.randomUUID()
    const raw =
      input.type === 'execution.cancel'
        ? {
            execution_id: input.executionId.toLowerCase(),
            idempotency_key: idempotencyKey,
            ...(input.reasonCode === undefined ? {} : { reason_code: input.reasonCode }),
          }
        : {
            thread_id: threadId,
            root_event_id: input.rootEventId.toLowerCase(),
            idempotency_key: idempotencyKey,
            ...(input.reasonCode === undefined ? {} : { reason_code: input.reasonCode }),
          }
    wsCommandSchemas[input.type]!.parse({ id: crypto.randomUUID(), type: input.type, payload: raw })
    const intent = immutable({
      ...input,
      threadId,
      idempotencyKey,
      ...(input.type === 'execution.cancel'
        ? { executionId: input.executionId.toLowerCase() }
        : { rootEventId: input.rootEventId.toLowerCase() }),
    }) as DooersThreadsControlIntent
    const key = targetKey(intent)
    const existing = this.entries.get(key)
    if (existing) {
      if (
        existing.intent.reasonCode !== intent.reasonCode ||
        (input.idempotencyKey && input.idempotencyKey !== existing.intent.idempotencyKey)
      )
        throw new DooersThreadsClientError(
          'IDEMPOTENCY_CONFLICT',
          'A different control intent already exists for this target'
        )
      return existing.intent
    }
    if (this.entries.size >= this.limit)
      throw new DooersThreadsClientError('CLIENT_LIMIT', 'Control receipt limit reached')
    this.entries.set(key, immutable({ intent, state: 'unconfirmed' }))
    this.changed()
    return intent
  }
  request(
    input: DooersThreadsControlInput,
    options: { transport?: DooersThreadsTransport } = {}
  ): Promise<void> {
    let intent: DooersThreadsControlIntent
    try {
      intent = this.prepare(input)
    } catch (error) {
      return Promise.reject(error)
    }
    const key = targetKey(intent)
    const flight = this.flights.get(key)
    if (flight) return flight
    const entry = this.entries.get(key)!
    if (entry.state === 'observed' || entry.state === 'requested') return Promise.resolve()
    const generation = this.generation
    this.set(key, { intent, state: 'pending' })
    const current = () => generation === this.generation && this.entries.get(key)?.intent === intent
    const promise = Promise.resolve()
      .then(() => {
        if (!current()) throw new DooersThreadsClientError('DISCONNECTED', 'Control scope changed')
        return this.send(intent, options.transport)
      })
      .then(() => {
        if (!current() || this.entries.get(key)?.state === 'observed') return
        this.set(key, { intent, state: 'requested' })
        this.timers.set(
          key,
          setTimeout(() => {
            this.timers.delete(key)
            if (current() && this.entries.get(key)?.state === 'requested')
              this.set(key, { intent, state: 'unconfirmed' })
          }, this.confirmationMs)
        )
        this.reconcile(true)
      })
      .catch((error: unknown) => {
        if (current() && this.entries.get(key)?.state !== 'observed') {
          const failure =
            error instanceof DooersThreadsClientError
              ? error
              : new DooersThreadsClientError(
                  'NETWORK_ERROR',
                  'Control confirmation unavailable',
                  true
                )
          this.set(key, {
            intent,
            state:
              failure.publicationState === 'rejected' ||
              ['UNSUPPORTED_CAPABILITY', 'INVALID_REQUEST'].includes(failure.code)
                ? 'rejected'
                : 'unknown',
            errorCode: failure.code,
          })
        }
        throw error
      })
      .finally(() => {
        if (this.flights.get(key) === promise) this.flights.delete(key)
      })
    this.flights.set(key, promise)
    return promise
  }
  reconcile = (force = false) => {
    const snapshot = this.read()
    for (const [key, entry] of this.entries) {
      const thread = snapshot.threads[entry.intent.threadId]
      if (thread?.phase === 'revoked') {
        this.removeThread(entry.intent.threadId)
        continue
      }
      if (!thread || entry.state === 'observed') continue
      const prior = this.projections.get(key)
      if (
        !force &&
        prior?.events === thread.eventsById &&
        prior.executions === thread.executionsById &&
        prior.phase === thread.phase
      )
        continue
      this.projections.set(key, {
        events: thread.eventsById,
        executions: thread.executionsById,
        phase: thread.phase,
      })
      const intent = entry.intent
      const execution =
        intent.type === 'execution.cancel' ? thread.executionsById[intent.executionId] : undefined
      const outcome =
        execution && execution.state !== 'running'
          ? execution.state
          : intent.type === 'root.stop' &&
              Object.values(thread.eventsById).some(
                (item) =>
                  item.known &&
                  item.event.type === 'root.stopped' &&
                  item.event.payload.root_event_id === intent.rootEventId
              )
            ? 'stopped'
            : undefined
      if (outcome) this.set(key, { intent, state: 'observed', outcome })
    }
  }
  /** Stop confirmation timers without emitting cancellation when transport/provider closes. */
  disconnected() {
    this.generation++
    this.flights.clear()
    for (const [key, entry] of this.entries) {
      clearTimeout(this.timers.get(key))
      if (entry.state === 'pending') this.set(key, { ...entry, state: 'unknown' })
      if (entry.state === 'requested') this.set(key, { ...entry, state: 'unconfirmed' })
    }
    this.timers.clear()
  }
  removeThread(threadId: string) {
    for (const [key, entry] of this.entries)
      if (entry.intent.threadId === threadId) {
        clearTimeout(this.timers.get(key))
        this.timers.delete(key)
        this.entries.delete(key)
        this.projections.delete(key)
        this.flights.delete(key)
      }
    this.changed()
  }
  clear() {
    this.generation++
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    this.entries.clear()
    this.projections.clear()
    this.flights.clear()
    this.changed()
  }
  private set(key: string, entry: DooersThreadsControl) {
    if (canonical(this.entries.get(key)) === canonical(entry)) return
    clearTimeout(this.timers.get(key))
    this.timers.delete(key)
    this.entries.set(key, immutable(entry))
    this.changed()
  }
  private changed() {
    this.snapshot = Object.freeze([...this.entries.values()])
    for (const listener of this.listeners) listener()
  }
}
