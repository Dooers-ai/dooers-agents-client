import { z } from 'zod'
import { uuidSchema } from '../protocol/maestro/vendor/common.js'
import { immutable } from './publications.js'
import { MaestroClientError } from './types.js'

/** Closed local candidate DTO from E12-05; this does not extend the public v1 wire. */
export const maestroApprovalOutcomeSchema = z
  .strictObject({
    format_version: z.literal('maestro.tool-approval-outcome.local.v1'),
    interaction_id: uuidSchema,
    delivery_id: uuidSchema,
    agent_participant_id: uuidSchema,
    decision_event_id: uuidSchema.nullable(),
    arguments_hash: z.string().regex(/^[a-f0-9]{64}$/),
    status: z.enum(['unobserved', 'pending', 'succeeded', 'unknown', 'manual_review']),
    revision: z
      .string()
      .regex(/^[1-9][0-9]{0,18}$/)
      .nullable(),
  })
  .refine((value) => (value.status === 'unobserved') === (value.revision === null))
  .refine((value) => value.status === 'unobserved' || value.decision_event_id !== null)
export type MaestroApprovalOutcome = z.infer<typeof maestroApprovalOutcomeSchema>
export interface MaestroApprovalEffectOutcome {
  state: MaestroApprovalOutcome['status']
  revision?: string | null
  decisionEventId?: string | null
}
export interface MaestroApprovalOutcomeBinding {
  deliveryId: string
  agentParticipantId: string
  argumentsHash: string
  decisionEventId: string | null
  approved: boolean
}
export interface MaestroApprovalOutcomeRead {
  threadId: string
  interactionId: string
  state: 'pending' | 'ready' | 'error'
  result?: MaestroApprovalOutcome
  errorCode?: string
}
const fail = (code: string) => new MaestroClientError(code, 'Approval outcome unavailable')
const keyFor = (threadId: string, interactionId: string) =>
  JSON.stringify([
    uuidSchema.parse(threadId).toLowerCase(),
    uuidSchema.parse(interactionId).toLowerCase(),
  ])
/** Read-only cache. It cannot consent, reserve or execute an effect. */
export class MaestroApprovalOutcomes {
  private entries = new Map<string, MaestroApprovalOutcomeRead>()
  private flights = new Map<
    string,
    { promise: Promise<MaestroApprovalOutcome>; controller: AbortController }
  >()
  private listeners = new Set<() => void>()
  private leases = new Map<string, number>()
  private snapshot: readonly MaestroApprovalOutcomeRead[] = Object.freeze([])
  constructor(
    private readonly read: (
      threadId: string,
      interactionId: string,
      signal: AbortSignal
    ) => Promise<unknown>,
    private readonly binding: (
      threadId: string,
      interactionId: string
    ) => MaestroApprovalOutcomeBinding | null,
    private readonly authorize: (threadId: string, interactionId: string) => void,
    private readonly limit = 1000
  ) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  getSnapshot = () => this.snapshot
  current(
    threadId: string,
    interactionId: string,
    binding: MaestroApprovalOutcomeBinding
  ): MaestroApprovalEffectOutcome {
    try {
      this.authorize(threadId, interactionId)
    } catch {
      return { state: 'unobserved' }
    }
    const entry = this.entries.get(keyFor(threadId, interactionId))
    const result = entry?.state === 'ready' ? entry.result : undefined
    if (
      !result ||
      !binding.approved ||
      !binding.decisionEventId ||
      result.decision_event_id !== binding.decisionEventId ||
      result.delivery_id !== binding.deliveryId ||
      result.agent_participant_id !== binding.agentParticipantId ||
      result.arguments_hash !== binding.argumentsHash
    )
      return { state: 'unobserved' }
    return immutable({
      state: result.status,
      revision: result.revision,
      decisionEventId: result.decision_event_id,
    })
  }
  retain(threadId: string, interactionId: string) {
    const key = keyFor(threadId, interactionId)
    this.leases.set(key, (this.leases.get(key) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      const count = this.leases.get(key) ?? 0
      if (count > 1) this.leases.set(key, count - 1)
      else {
        this.leases.delete(key)
        this.flights.get(key)?.controller.abort()
        this.flights.delete(key)
        this.entries.delete(key)
        this.changed()
      }
    }
  }
  refresh(threadId: string, interactionId: string): Promise<MaestroApprovalOutcome> {
    const key = keyFor(threadId, interactionId)
    const [thread, target] = JSON.parse(key) as [string, string]
    try {
      this.authorize(thread, target)
    } catch (cause) {
      return Promise.reject(cause)
    }
    const existing = this.flights.get(key)
    if (existing) return existing.promise
    const expected = this.binding(thread, target)
    if (!expected) return Promise.reject(fail('NOT_FOUND'))
    const previous = this.entries.get(key)
    if (!previous && this.entries.size >= this.limit) return Promise.reject(fail('CLIENT_LIMIT'))
    const controller = new AbortController()
    const pending = immutable({
      threadId: thread,
      interactionId: target,
      state: 'pending' as const,
      ...(previous?.result ? { result: previous.result } : {}),
    })
    this.entries.set(key, pending)
    this.changed()
    const current = () => this.entries.get(key) === pending && !controller.signal.aborted
    const promise = Promise.resolve()
      .then(() => {
        if (!current()) throw fail('DISCONNECTED')
        this.authorize(thread, target)
        return this.read(thread, target, controller.signal)
      })
      .then((raw) => {
        if (!current()) throw fail('FORBIDDEN')
        this.authorize(thread, target)
        const parsed = maestroApprovalOutcomeSchema.safeParse(raw)
        if (!parsed.success) throw fail('PROTOCOL_ERROR')
        const result = parsed.data
        const now = this.binding(thread, target)
        if (
          !now ||
          result.interaction_id !== target ||
          result.delivery_id !== expected.deliveryId ||
          result.agent_participant_id !== expected.agentParticipantId ||
          result.arguments_hash !== expected.argumentsHash ||
          now.deliveryId !== expected.deliveryId ||
          now.agentParticipantId !== expected.agentParticipantId ||
          now.argumentsHash !== expected.argumentsHash ||
          (now.decisionEventId && result.decision_event_id !== now.decisionEventId)
        )
          throw fail('PROTOCOL_ERROR')
        const old = previous?.result
        if (
          old &&
          ((old.decision_event_id && result.decision_event_id !== old.decision_event_id) ||
            (old.revision !== null &&
              (result.revision === null || BigInt(result.revision) < BigInt(old.revision))) ||
            (old.revision !== null &&
              old.revision === result.revision &&
              JSON.stringify(old) !== JSON.stringify(result)))
        )
          throw fail('PROTOCOL_ERROR')
        this.entries.set(
          key,
          immutable({ threadId: thread, interactionId: target, state: 'ready', result })
        )
        this.changed()
        return result
      })
      .catch((cause) => {
        const error = cause instanceof MaestroClientError ? cause : fail('NETWORK_ERROR')
        if (current()) {
          this.entries.set(
            key,
            immutable({
              threadId: thread,
              interactionId: target,
              state: 'error',
              errorCode: error.code,
              ...(previous?.result ? { result: previous.result } : {}),
            })
          )
          this.changed()
        }
        throw error
      })
      .finally(() => {
        if (this.flights.get(key)?.promise === promise) this.flights.delete(key)
      })
    this.flights.set(key, { promise, controller })
    return promise
  }
  removeThread(threadId: string) {
    threadId = uuidSchema.parse(threadId).toLowerCase()
    for (const key of this.leases.keys())
      if ((JSON.parse(key) as string[])[0] === threadId) this.leases.delete(key)
    for (const [key, entry] of this.entries)
      if (entry.threadId === threadId) {
        this.flights.get(key)?.controller.abort()
        this.flights.delete(key)
        this.entries.delete(key)
      }
    this.changed()
  }
  clear() {
    for (const flight of this.flights.values()) flight.controller.abort()
    this.flights.clear()
    this.leases.clear()
    this.entries.clear()
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
