import type { z } from 'zod'
import type { toDooersThreadsPersistedResponse } from '../protocol/dooers-threads/contracts.js'
import { uuidSchema } from '../protocol/dooers-threads/vendor/common.js'
import { publicSchemas } from '../protocol/dooers-threads/vendor/public.js'
export type DooersThreadsFeedbackResult = ReturnType<typeof toDooersThreadsPersistedResponse>

import { canonical, immutable } from './publications.js'
import type { DooersThreadsStoreSnapshot } from './store.js'
import { DooersThreadsClientError } from './types.js'

export type DooersThreadsFeedbackValue = z.infer<(typeof publicSchemas)['Public.FeedbackRequest']>
export interface DooersThreadsFeedbackIntent {
  threadId: string
  eventId: string
  idempotencyKey: string
  request: DooersThreadsFeedbackValue
}
export interface DooersThreadsFeedbackReceipt {
  intent: Readonly<DooersThreadsFeedbackIntent>
  state: 'pending' | 'persisted' | 'unknown' | 'conflict' | 'rejected'
  result?: DooersThreadsFeedbackResult
  errorCode?: string
}
/** A per-human receipt ledger, separate from public feedback events and legacy useFeedback. */
export class DooersThreadsFeedback {
  private entries = new Map<string, DooersThreadsFeedbackReceipt>()
  private flights = new Map<string, Promise<DooersThreadsFeedbackResult>>()
  private listeners = new Set<() => void>()
  private snapshot: readonly DooersThreadsFeedbackReceipt[] = Object.freeze([])
  private generation = 0
  constructor(
    private readonly send: (
      intent: Readonly<DooersThreadsFeedbackIntent>
    ) => Promise<DooersThreadsFeedbackResult>,
    private readonly read: () => DooersThreadsStoreSnapshot,
    private readonly principalId: string,
    private readonly limit = 1000
  ) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  getSnapshot = () => this.snapshot
  current(threadId: string, eventId: string): DooersThreadsFeedbackValue | null {
    const state = this.read().threads[threadId]
    let current: DooersThreadsFeedbackValue | null = null
    for (const item of Object.values(state?.eventsById ?? {})) {
      if (!item.known || item.event.type !== 'feedback.updated') continue
      const payload = item.event.payload
      if (
        payload.target_event_id === eventId &&
        payload.principal_id === this.principalId &&
        (!current || payload.feedback.version > current.version)
      )
        current = payload.feedback
    }
    return current
  }
  /** A conflict is recoverable only after this human's canonical revision reaches the rejected one. */
  requiresRefresh(threadId: string, eventId: string): boolean {
    const previous = this.entries.get(JSON.stringify([threadId, eventId]))
    return (
      previous?.state === 'conflict' &&
      (this.current(threadId, eventId)?.version ?? 0) < previous.intent.request.version
    )
  }
  request(input: {
    threadId: string
    eventId: string
    value: DooersThreadsFeedbackValue['value']
    classification?: string | null
    reason?: string | null
  }): Promise<DooersThreadsFeedbackResult> {
    const threadId = uuidSchema.parse(input.threadId).toLowerCase(),
      eventId = uuidSchema.parse(input.eventId).toLowerCase(),
      key = JSON.stringify([threadId, eventId])
    const previous = this.entries.get(key)
    if (this.requiresRefresh(threadId, eventId))
      return Promise.reject(
        new DooersThreadsClientError(
          'VERSION_CONFLICT',
          'Refresh canonical feedback before changing the vote'
        )
      )
    const request = publicSchemas['Public.FeedbackRequest'].parse({
      value: input.value,
      classification: input.classification ?? null,
      reason: input.reason ?? null,
      version: (this.current(threadId, eventId)?.version ?? 0) + 1,
    })
    if (request.value === null && (request.classification !== null || request.reason !== null))
      return Promise.reject(
        new DooersThreadsClientError(
          'INVALID_REQUEST',
          'Cleared feedback cannot retain classification or reason'
        )
      )
    if (previous && ['pending', 'unknown'].includes(previous.state)) {
      if (
        canonical({ ...request, version: previous.intent.request.version }) !==
        canonical(previous.intent.request)
      )
        return Promise.reject(
          new DooersThreadsClientError(
            'IDEMPOTENCY_CONFLICT',
            'Confirm the previous vote before changing it'
          )
        )
      return this.run(key, previous.intent)
    }
    if (
      previous?.state === 'persisted' &&
      (!this.current(threadId, eventId) ||
        canonical(this.current(threadId, eventId)) === canonical(previous.intent.request)) &&
      canonical({ ...request, version: previous.intent.request.version }) ===
        canonical(previous.intent.request)
    )
      return Promise.resolve(previous.result!)
    if (!previous && this.entries.size >= this.limit)
      return Promise.reject(
        new DooersThreadsClientError('CLIENT_LIMIT', 'Feedback receipt limit reached')
      )
    const intent = immutable({ threadId, eventId, idempotencyKey: crypto.randomUUID(), request })
    return this.run(key, intent)
  }
  retry(threadId: string, eventId: string) {
    const key = JSON.stringify([
        uuidSchema.parse(threadId).toLowerCase(),
        uuidSchema.parse(eventId).toLowerCase(),
      ]),
      previous = this.entries.get(key)
    if (!previous || previous.state !== 'unknown')
      return Promise.reject(
        new DooersThreadsClientError('INVALID_REQUEST', 'No uncertain feedback to confirm')
      )
    return this.run(key, previous.intent)
  }
  private run(
    key: string,
    intent: Readonly<DooersThreadsFeedbackIntent>
  ): Promise<DooersThreadsFeedbackResult> {
    const flight = this.flights.get(key)
    if (flight) return flight
    const generation = this.generation
    this.set(key, { intent, state: 'pending' })
    const current = () => generation === this.generation && this.entries.get(key)?.intent === intent
    const promise = Promise.resolve()
      .then(() => {
        if (!current()) throw new DooersThreadsClientError('DISCONNECTED', 'Feedback scope changed')
        return this.send(intent)
      })
      .then((result) => {
        if (!current()) throw new DooersThreadsClientError('FORBIDDEN', 'Feedback access changed')
        this.set(key, { intent, state: 'persisted', result })
        return result
      })
      .catch((cause: unknown) => {
        const error =
          cause instanceof DooersThreadsClientError
            ? cause
            : new DooersThreadsClientError(
                'NETWORK_ERROR',
                'Feedback confirmation unavailable',
                true
              )
        if (current())
          this.set(key, {
            intent,
            state: ['VERSION_CONFLICT', 'IDEMPOTENCY_CONFLICT', 'CONFLICT'].includes(error.code)
              ? 'conflict'
              : error.publicationState === 'rejected' ||
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
        if (this.flights.get(key) === promise) this.flights.delete(key)
      })
    this.flights.set(key, promise)
    return promise
  }
  removeThread(threadId: string) {
    for (const [key, item] of this.entries)
      if (item.intent.threadId === threadId) {
        this.entries.delete(key)
        this.flights.delete(key)
      }
    this.changed()
  }
  clear() {
    this.generation++
    this.entries.clear()
    this.flights.clear()
    this.changed()
  }
  private set(key: string, value: DooersThreadsFeedbackReceipt) {
    this.entries.set(key, immutable(value))
    this.changed()
  }
  private changed() {
    this.snapshot = Object.freeze([...this.entries.values()])
    for (const listener of this.listeners) listener()
  }
}
