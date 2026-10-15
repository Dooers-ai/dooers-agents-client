import type { z } from 'zod'
import type { MaestroEvent, toMaestroPersistedResponse } from '../protocol/maestro/contracts.js'
import { uuidSchema } from '../protocol/maestro/vendor/common.js'
import { publicSchemas } from '../protocol/maestro/vendor/public.js'
import type {
  MaestroApprovalEffectOutcome,
  MaestroApprovalOutcomeBinding,
} from './approval-outcomes.js'
import { canonical, immutable } from './publications.js'
import type { MaestroStoreSnapshot } from './store.js'
import { MaestroClientError, type MaestroTransport } from './types.js'

export type MaestroApprovalDefinition = Extract<
  z.infer<(typeof publicSchemas)['Public.Interaction']>['definition'],
  { kind: 'tool_approval' }
>
export type MaestroApprovalInteraction = Omit<
  z.infer<(typeof publicSchemas)['Public.Interaction']>,
  'definition'
> & { definition: MaestroApprovalDefinition }
export type MaestroApprovalResponse = Extract<
  z.infer<(typeof publicSchemas)['Public.InteractionResponseRequest']>,
  { action: 'approve' | 'reject' | 'cancel' }
>
export type MaestroApprovalResult = ReturnType<typeof toMaestroPersistedResponse>
export interface MaestroApprovalIntent {
  threadId: string
  interactionId: string
  idempotencyKey: string
  request: MaestroApprovalResponse
}
export interface MaestroApprovalReceipt {
  intent: Readonly<MaestroApprovalIntent>
  state: 'pending' | 'unknown' | 'persisted' | 'conflict' | 'rejected'
  result?: MaestroApprovalResult
  errorCode?: string
}
export interface MaestroApprovalView {
  interaction: Omit<MaestroApprovalInteraction, 'definition'> & {
    definition: MaestroApprovalDefinition
  }
  requestEventId: string
  requestSequence: string
  originEventId: string
  originExecutionId: string
  decision: Extract<MaestroEvent, { type: 'interaction.responded' | 'interaction.expired' }> | null
  phaseId: string | null
  state: 'pending' | 'approved' | 'rejected' | 'canceled' | 'expired'
  waitingForDecision: boolean
  resuming: boolean
  /** Consent and delivery completion do not prove that a specific external effect succeeded. */
  effectOutcome: MaestroApprovalEffectOutcome
}
const fail = (code: string) => new MaestroClientError(code, 'Tool approval unavailable')
const id = (value: string) => uuidSchema.parse(value).toLowerCase()
/** The local candidate deliberately narrows v1 timestamps to exact milliseconds. */
export function approvalExpiry(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/.exec(value)
  if (!match || match[1] === '0000') return Number.NaN
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) return Number.NaN
  const normalized = `${value.slice(0, 19)}.${(match[7] ?? '').padEnd(3, '0')}Z`
  return new Date(ms).toISOString() === normalized ? ms : Number.NaN
}
/** Candidate preparation only. Replay is observational and never creates a decision. */
export class MaestroApprovals {
  private entries = new Map<string, MaestroApprovalReceipt>()
  private flights = new Map<string, Promise<MaestroApprovalResult>>()
  private listeners = new Set<() => void>()
  private snapshot: readonly MaestroApprovalReceipt[] = Object.freeze([])
  constructor(
    private readonly send: (
      intent: Readonly<MaestroApprovalIntent>,
      transport?: MaestroTransport
    ) => Promise<MaestroApprovalResult>,
    private readonly read: () => MaestroStoreSnapshot,
    private readonly authorize: (
      threadId: string,
      interactionId: string,
      confirmation: boolean
    ) => void,
    private readonly limit = 1000,
    private readonly outcomeFor?: (
      threadId: string,
      interactionId: string,
      binding: MaestroApprovalOutcomeBinding
    ) => MaestroApprovalEffectOutcome
  ) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  getSnapshot = () => this.snapshot
  current(threadId: string, interactionId: string): MaestroApprovalView | null {
    threadId = id(threadId)
    const state = this.read().threads[threadId]
    interactionId = id(interactionId)
    let created: Extract<MaestroEvent, { type: 'interaction.created' }> | undefined
    let decision: MaestroApprovalView['decision'] = null
    for (const item of Object.values(state?.eventsById ?? {})) {
      if (!item.known) continue
      const event = item.event
      if (
        event.type === 'interaction.created' &&
        event.payload.interaction.interaction_id === interactionId &&
        (!created || BigInt(event.sequence) < BigInt(created.sequence))
      )
        created = event
      if (
        (event.type === 'interaction.responded' || event.type === 'interaction.expired') &&
        event.payload.interaction_id === interactionId &&
        (!decision || BigInt(event.sequence) < BigInt(decision.sequence))
      )
        decision = event
    }
    if (!created || created.payload.interaction.definition.kind !== 'tool_approval') return null
    const interaction = created.payload.interaction
    const definition = interaction.definition
    if (
      definition.kind !== 'tool_approval' ||
      !Number.isFinite(approvalExpiry(definition.expires_at))
    )
      return null
    // A response from an earlier generation, wrong delivery or form cannot decide this request.
    if (
      decision &&
      (BigInt(decision.sequence) <= BigInt(created.sequence) ||
        decision.payload.delivery_id !== interaction.delivery_id ||
        (decision.type === 'interaction.responded' &&
          (!['approve', 'reject', 'cancel'].includes(decision.payload.action) ||
            decision.payload.phase_id !== interactionId ||
            decision.actor.kind !== 'human' ||
            !decision.actor.participantId ||
            !definition.eligible_participant_ids.includes(decision.actor.participantId) ||
            canonical(decision.payload.shared_data) !== canonical({}))))
    )
      decision = null
    const terminal =
      decision?.type === 'interaction.expired'
        ? 'expired'
        : decision?.type === 'interaction.responded'
          ? decision.payload.action === 'approve'
            ? 'approved'
            : decision.payload.action === 'reject'
              ? 'rejected'
              : 'canceled'
          : interaction.state
    if (!['pending', 'approved', 'rejected', 'canceled', 'expired'].includes(terminal)) return null
    const delivery = state?.deliveriesById[interaction.delivery_id]
    return immutable({
      interaction: { ...interaction, definition, state: terminal },
      requestEventId: created.eventId,
      requestSequence: created.sequence,
      originEventId: interaction.origin_event_id,
      originExecutionId: interaction.execution_id,
      decision,
      phaseId: decision?.type === 'interaction.responded' ? decision.payload.phase_id : null,
      state: terminal as MaestroApprovalView['state'],
      waitingForDecision: terminal === 'pending',
      resuming:
        terminal === 'approved' &&
        delivery?.phase_id === interactionId &&
        ['pending', 'running', 'retry_wait'].includes(delivery.state),
      effectOutcome: this.outcomeFor?.(threadId, interactionId, {
        deliveryId: interaction.delivery_id,
        agentParticipantId: interaction.agent_participant_id,
        argumentsHash: definition.arguments_hash,
        decisionEventId: decision?.type === 'interaction.responded' ? decision.eventId : null,
        approved: terminal === 'approved',
      }) ?? { state: 'unobserved' },
    })
  }
  list(threadId: string): readonly MaestroApprovalView[] {
    const ids = new Set<string>()
    for (const item of Object.values(this.read().threads[id(threadId)]?.eventsById ?? {}))
      if (
        item.known &&
        item.event.type === 'interaction.created' &&
        item.event.payload.interaction.definition.kind === 'tool_approval'
      )
        ids.add(item.event.payload.interaction.interaction_id)
    return [...ids]
      .map((target) => this.current(threadId, target))
      .filter((view): view is MaestroApprovalView => !!view)
  }
  validate(
    threadId: string,
    interactionId: string,
    request: MaestroApprovalResponse
  ): MaestroApprovalResponse {
    const parsed = publicSchemas['Public.InteractionResponseRequest'].parse(request)
    if (parsed.action === 'submit') throw fail('INVALID_REQUEST')
    const view = this.current(threadId, interactionId)
    if (!view) throw fail('NOT_FOUND')
    if (
      parsed.action === 'approve' &&
      parsed.data.arguments_hash !== view.interaction.definition.arguments_hash
    )
      throw fail('APPROVAL_HASH_MISMATCH')
    return parsed
  }
  request(
    threadId: string,
    interactionId: string,
    request: MaestroApprovalResponse,
    options: { transport?: MaestroTransport } = {}
  ) {
    threadId = id(threadId)
    interactionId = id(interactionId)
    const key = JSON.stringify([threadId, interactionId]),
      previous = this.entries.get(key)
    if (!previous || previous.state === 'rejected') {
      try {
        this.authorize(threadId, interactionId, false)
      } catch (cause) {
        return Promise.reject(cause)
      }
    }
    const parsed = this.validate(threadId, interactionId, request)
    if (previous && previous.state !== 'rejected') {
      if (canonical(previous.intent.request) !== canonical(parsed))
        return Promise.reject(fail('IDEMPOTENCY_CONFLICT'))
      if (previous.state === 'persisted') {
        this.authorize(threadId, interactionId, true)
        return Promise.resolve(previous.result!)
      }
      if (previous.state === 'pending' || previous.state === 'unknown')
        return this.run(key, previous.intent, options.transport)
      if (previous.state === 'conflict')
        return Promise.reject(fail('INTERACTION_ALREADY_RESPONDED'))
    }
    const view = this.current(threadId, interactionId)!
    if (view.state !== 'pending') return Promise.reject(fail('INTERACTION_ALREADY_RESPONDED'))
    if (approvalExpiry(view.interaction.definition.expires_at) <= Date.now())
      return Promise.reject(fail('INTERACTION_EXPIRED'))
    if (!previous && this.entries.size >= this.limit) return Promise.reject(fail('CLIENT_LIMIT'))
    return this.run(
      key,
      immutable({ threadId, interactionId, idempotencyKey: crypto.randomUUID(), request: parsed }),
      options.transport,
      false
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
    intent: Readonly<MaestroApprovalIntent>,
    transport?: MaestroTransport,
    confirmation = true
  ): Promise<MaestroApprovalResult> {
    const flight = this.flights.get(key)
    if (flight) return flight
    const wasUnknown = this.entries.get(key)?.state === 'unknown'
    let received = false
    this.set(key, { intent, state: 'pending' })
    const current = () => this.entries.get(key)?.intent === intent
    const promise = Promise.resolve()
      .then(() => {
        if (!current()) throw fail('DISCONNECTED')
        this.authorize(intent.threadId, intent.interactionId, confirmation)
        return this.send(intent, transport)
      })
      .then((result) => {
        received = true
        if (!current()) throw fail('FORBIDDEN')
        this.authorize(intent.threadId, intent.interactionId, true)
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
              : wasUnknown || received || error.publicationState === 'unknown'
                ? 'unknown'
                : error.publicationState === 'rejected' ||
                    [
                      'UNSUPPORTED_CAPABILITY',
                      'INVALID_REQUEST',
                      'VALIDATION_FAILED',
                      'FORBIDDEN',
                      'UNAUTHENTICATED',
                      'INTERACTION_EXPIRED',
                      'APPROVAL_HASH_MISMATCH',
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
    this.changed()
  }
  clear() {
    this.entries.clear()
    this.flights.clear()
    this.changed()
  }
  private set(key: string, value: MaestroApprovalReceipt) {
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
