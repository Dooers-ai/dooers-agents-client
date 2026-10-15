import type { z } from 'zod'
import {
  compareMaestroSequences,
  type MaestroEvent,
  type MaestroParticipant,
  type MaestroThread,
  toMaestroParticipant,
} from '../protocol/maestro/contracts.js'
import { uuidSchema } from '../protocol/maestro/vendor/common.js'
import type { publicSchemas } from '../protocol/maestro/vendor/public.js'
import type { MaestroNetworkEvent, MaestroNetworkPage } from './network.js'
import { canonical, immutable } from './publications.js'
import {
  type MaestroStream,
  type MaestroStreamDelta,
  type MaestroStreamReset,
  MaestroStreams,
} from './streams.js'
import {
  MaestroClientError,
  type MaestroPublication,
  type MaestroPublicationSnapshot,
  type MaestroScope,
  type MaestroSendInput,
} from './types.js'

export type MaestroDelivery = z.infer<(typeof publicSchemas)['Public.Delivery']>
type WireExecution = Extract<
  MaestroEvent,
  { type: 'execution.started' | 'execution.completed' | 'execution.failed' | 'execution.canceled' }
>['payload']
export type MaestroExecution =
  | WireExecution
  | (Omit<WireExecution, 'state'> & { state: 'suspended' })
export type MaestroThreadPhase =
  | 'idle'
  | 'subscribing'
  | 'replaying'
  | 'live'
  | 'disconnected'
  | 'resync'
  | 'revoked'
  | 'failed'
export interface MaestroThreadState {
  threadId: string
  thread: MaestroThread | null
  eventsById: Readonly<Record<string, MaestroNetworkEvent>>
  eventIds: readonly string[]
  participantsById: Readonly<Record<string, MaestroParticipant>>
  deliveriesById: Readonly<Record<string, MaestroDelivery>>
  executionsById: Readonly<Record<string, MaestroExecution>>
  optimisticByKey: Readonly<Record<string, Readonly<MaestroSendInput>>>
  commandsByKey: Readonly<Record<string, MaestroPublication>>
  appliedSequence: string
  receivedSequence: string
  resumeCursor: string | null
  beforeCursor: string | null
  historyHasMore: boolean
  historyLoading: boolean
  phase: MaestroThreadPhase
  refs: number
  error: MaestroClientError | null
  hasPendingWork: boolean
  waitingForInput: boolean
  streamsByKey: Readonly<Record<string, MaestroStream>>
  streamResyncRequired: boolean
}
export interface MaestroStoreSnapshot {
  scope: Readonly<MaestroScope>
  threads: Readonly<Record<string, MaestroThreadState>>
}
type Internal = {
  state: MaestroThreadState
  sequenceIds: Map<string, string>
  pending: Map<string, MaestroNetworkEvent>
  checkpoints: Map<string, string>
  checkpointSequence: string
  versions: Map<string, string>
}
const next = (sequence: string) => (BigInt(sequence) + 1n).toString()
const fail = (code: string, message: string) => new MaestroClientError(code, message)
const empty = (threadId: string): MaestroThreadState => ({
  threadId,
  thread: null,
  eventsById: {},
  eventIds: [],
  participantsById: {},
  deliveriesById: {},
  executionsById: {},
  optimisticByKey: {},
  commandsByKey: {},
  appliedSequence: '0',
  receivedSequence: '0',
  resumeCursor: null,
  beforeCursor: null,
  historyHasMore: true,
  historyLoading: false,
  phase: 'idle',
  refs: 0,
  error: null,
  hasPendingWork: false,
  waitingForInput: false,
  streamsByKey: {},
  streamResyncRequired: false,
})

/** A single human/scope/authority owns this in-memory store. Cursors are never decoded. */
export class MaestroStore {
  private streams = new MaestroStreams()
  private entries = new Map<string, Internal>()
  private listeners = new Set<() => void>()
  private snapshot: MaestroStoreSnapshot
  constructor(
    readonly scope: Readonly<MaestroScope>,
    private readonly limits = {
      maxBufferedEvents: 1000,
      maxEventsPerThread: 20000,
      maxThreads: 100,
    }
  ) {
    this.snapshot = immutable({ scope, threads: {} })
  }
  getSnapshot = () => this.snapshot
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  getThread = (threadId: string) => this.snapshot.threads[threadId.toLowerCase()]
  private entry(threadId: string) {
    threadId = uuidSchema.parse(threadId).toLowerCase()
    let entry = this.entries.get(threadId)
    if (!entry) {
      if (this.entries.size >= this.limits.maxThreads)
        throw fail('CAPACITY_EXCEEDED', 'Thread memory limit reached')
      entry = {
        state: empty(threadId),
        sequenceIds: new Map(),
        pending: new Map(),
        checkpoints: new Map(),
        checkpointSequence: '0',
        versions: new Map(),
      }
      this.entries.set(threadId, entry)
    }
    return entry
  }
  setStreamCapability(enabled: boolean) {
    this.streams.capability(enabled)
    this.publishStreams()
  }
  streamDelta(frame: MaestroStreamDelta) {
    const entry = this.entries.get(frame.thread_id)
    if (!entry || entry.state.phase !== 'live' || entry.state.thread?.state !== 'active') return
    const participant = entry.state.participantsById[frame.participant_id]
    if (!participant || participant.kind !== 'agent' || participant.state !== 'active') return
    const execution = entry.state.executionsById[frame.execution_id]
    if (
      !execution ||
      execution.state !== 'running' ||
      execution.participant_id !== frame.participant_id
    )
      return
    this.streams.delta(frame)
    this.publishStreams()
  }
  streamReset(frame: MaestroStreamReset) {
    const entry = this.entries.get(frame.thread_id)
    if (!entry || entry.state.phase !== 'live' || entry.state.thread?.state !== 'active') return
    this.streams.reset(frame)
    this.publishStreams()
  }
  private attachStreams() {
    let changed = false
    for (const item of this.entries.values()) {
      const streamsByKey = this.streams.forThread(item.state.threadId)
      const previous = item.state.streamsByKey
      if (
        item.state.streamResyncRequired === this.streams.resyncRequired &&
        Object.keys(previous).length === Object.keys(streamsByKey).length &&
        Object.entries(streamsByKey).every(([key, stream]) => previous[key] === stream)
      )
        continue
      // Canonical descendants were already frozen by publish; do not walk the
      // complete replay history for every token or recreate unchanged hook data.
      item.state = Object.freeze({
        ...item.state,
        streamsByKey,
        streamResyncRequired: this.streams.resyncRequired,
      })
      changed = true
    }
    return changed
  }
  private publishStreams() {
    if (!this.attachStreams()) return
    this.snapshot = Object.freeze({
      scope: this.snapshot.scope,
      threads: Object.freeze(
        Object.fromEntries([...this.entries].map(([id, item]) => [id, item.state]))
      ),
    })
    for (const listener of this.listeners) {
      try {
        listener()
      } catch {
        /* Provisional observers do not control protocol state. */
      }
    }
  }
  private publish(entry?: Internal) {
    if (entry) {
      const deliveries = Object.values(entry.state.deliveriesById)
      entry.state = immutable({
        ...entry.state,
        hasPendingWork: deliveries.some((d) =>
          ['waiting_broker', 'pending', 'running', 'retry_wait'].includes(d.state)
        ),
        waitingForInput: deliveries.some((d) => d.state === 'waiting_input'),
      })
    }
    this.attachStreams()
    this.snapshot = immutable({
      scope: this.scope,
      threads: Object.fromEntries([...this.entries].map(([id, item]) => [id, item.state])),
    })
    for (const listener of this.listeners) {
      try {
        listener()
      } catch {
        /* Observers cannot change canonical application. */
      }
    }
  }
  patch(
    threadId: string,
    update: Partial<Pick<MaestroThreadState, 'phase' | 'refs' | 'error' | 'historyLoading'>>
  ) {
    const entry = this.entry(threadId)
    if (update.phase && update.phase !== 'live') this.streams.interrupt(entry.state.threadId)
    entry.state = { ...entry.state, ...update }
    this.publish(entry)
  }
  clear() {
    this.streams.clear()
    this.entries.clear()
    this.publish()
  }
  invalidateCancellationPermission(threadId: string) {
    const entry = this.entry(threadId)
    const thread = entry.state.thread
    if (!thread?.permissions.cancel) return
    entry.state = {
      ...entry.state,
      thread: { ...thread, permissions: { ...thread.permissions, cancel: false } },
    }
    this.publish(entry)
  }
  revoke(threadId: string) {
    const prior = this.entry(threadId)
    this.streams.interrupt(prior.state.threadId)
    this.entries.delete(threadId.toLowerCase())
    const entry = this.entry(threadId)
    entry.state = { ...entry.state, refs: prior.state.refs, phase: 'revoked' }
    this.publish(entry)
  }
  restart(threadId: string, snapshot: boolean) {
    const entry = this.entry(threadId)
    this.streams.interrupt(entry.state.threadId)
    entry.pending.clear()
    entry.checkpoints.clear()
    if (snapshot) {
      const { refs, optimisticByKey } = entry.state
      const commandsByKey = Object.fromEntries(
        Object.entries(entry.state.commandsByKey).filter(
          ([, command]) => command.state === 'pending' || command.state === 'unknown'
        )
      )
      entry.sequenceIds.clear()
      entry.versions.clear()
      entry.checkpointSequence = '0'
      entry.state = { ...empty(entry.state.threadId), refs, optimisticByKey, commandsByKey }
    }
    entry.state = {
      ...entry.state,
      phase: 'subscribing',
      error: null,
      ...(snapshot ? { appliedSequence: '0', resumeCursor: null } : {}),
    }
    this.publish(entry)
  }
  observeThread(thread: MaestroThread, refreshPermissions = false) {
    if (
      thread.organizationId !== this.scope.organizationId ||
      thread.workspaceId !== this.scope.workspaceId ||
      (thread.scopeKind === 'personal' && thread.workspaceId !== null)
    )
      throw fail('PROTOCOL_ERROR', 'Thread scope mismatch')
    const entry = this.entry(thread.threadId)
    if (entry.state.phase === 'revoked') return
    if (thread.state === 'deleted' || thread.state === 'deleting') {
      this.revoke(thread.threadId)
      return
    }
    if (this.newer(entry, 'thread', thread.lastSequence)) {
      entry.state = {
        ...entry.state,
        thread,
        participantsById: Object.fromEntries(thread.participants.map((p) => [p.participantId, p])),
      }
      if (thread.state !== 'active') this.streams.interrupt(entry.state.threadId)
      for (const p of thread.participants) {
        entry.versions.set(`participant:${p.participantId}`, thread.lastSequence)
        if (p.state !== 'active')
          this.streams.removeParticipant(entry.state.threadId, p.participantId)
      }
    }
    if (
      refreshPermissions &&
      entry.state.thread?.version === thread.version &&
      entry.state.thread.lastSequence === thread.lastSequence
    ) {
      entry.state = {
        ...entry.state,
        thread,
        participantsById: Object.fromEntries(thread.participants.map((p) => [p.participantId, p])),
      }
    }
    this.publish(entry)
  }
  optimistic(input: Readonly<MaestroSendInput & { clientEventId: string }>) {
    const entry = this.entry(input.threadId)
    if (entry.state.phase === 'revoked') throw fail('FORBIDDEN', 'Thread access was revoked')
    entry.state = {
      ...entry.state,
      optimisticByKey: { ...entry.state.optimisticByKey, [input.clientEventId]: input },
    }
    this.publish(entry)
  }
  publications(snapshot: MaestroPublicationSnapshot) {
    for (const publication of snapshot.publications) {
      const entry = this.entry(publication.threadId)
      if (entry.state.phase === 'revoked') continue
      if (publication.result && !entry.state.eventsById[publication.result.eventId]) continue
      const optimistic = { ...entry.state.optimisticByKey }
      if (publication.state === 'persisted') delete optimistic[publication.clientEventId]
      entry.state = {
        ...entry.state,
        optimisticByKey: optimistic,
        commandsByKey: { ...entry.state.commandsByKey, [publication.clientEventId]: publication },
      }
      this.publish(entry)
    }
  }
  /** A receipt proves this event exists, not that the preceding log has been received. */
  receipt(event: MaestroEvent) {
    const entry = this.entry(event.threadId)
    if (entry.state.phase === 'revoked') return
    this.insert(entry, { known: true, event })
    this.publish(entry)
  }
  page(
    threadId: string,
    events: readonly MaestroNetworkEvent[],
    watermark: string,
    cursor: string | null,
    hasMore: boolean
  ) {
    const entry = this.entry(threadId)
    if (entry.state.phase === 'revoked') return
    this.validatePage(events, threadId, watermark, hasMore, cursor)
    for (const item of events) this.enqueue(entry, item)
    const last = events.at(-1)?.event.sequence
    if (cursor && last) entry.checkpoints.set(last, cursor)
    this.drain(entry)
    entry.state = { ...entry.state, phase: 'replaying' }
    this.publish(entry)
  }
  append(threadId: string, item: MaestroNetworkEvent, cursor: string) {
    const entry = this.entry(threadId)
    if (entry.state.phase === 'revoked') return
    if (item.event.threadId !== threadId.toLowerCase())
      throw fail('PROTOCOL_ERROR', 'Event thread mismatch')
    this.enqueue(entry, item)
    entry.checkpoints.set(item.event.sequence, cursor)
    this.drain(entry)
    this.publish(entry)
  }
  caughtUp(threadId: string, watermark: string, cursor: string): boolean {
    const entry = this.entry(threadId)
    compareMaestroSequences(watermark, '0')
    if (entry.state.appliedSequence !== watermark || entry.pending.size) return false
    entry.checkpointSequence = watermark
    entry.state = { ...entry.state, phase: 'live', resumeCursor: cursor, error: null }
    this.publish(entry)
    return true
  }
  hasGap(threadId: string) {
    return (this.entries.get(threadId.toLowerCase())?.pending.size ?? 0) > 0
  }
  history(threadId: string, page: MaestroNetworkPage) {
    const entry = this.entry(threadId)
    if (entry.state.phase === 'revoked') return
    if (page.hasMore && !page.items.length)
      throw fail('PROTOCOL_ERROR', 'Empty historical page cannot progress')
    this.validatePage(page.items, threadId, page.watermark, page.hasMore, page.nextCursor)
    for (const item of page.items) this.insert(entry, item)
    entry.state = {
      ...entry.state,
      beforeCursor: page.nextCursor,
      historyHasMore: page.hasMore,
      historyLoading: false,
    }
    this.publish(entry)
  }
  private validatePage(
    events: readonly MaestroNetworkEvent[],
    threadId: string,
    watermark: string,
    hasMore: boolean,
    cursor: string | null
  ) {
    compareMaestroSequences(watermark, '0')
    if (hasMore && !cursor) throw fail('PROTOCOL_ERROR', 'History page cannot progress')
    let previous: string | undefined
    for (const item of events) {
      if (
        item.event.threadId !== threadId.toLowerCase() ||
        compareMaestroSequences(item.event.sequence, watermark) > 0 ||
        (previous !== undefined && compareMaestroSequences(previous, item.event.sequence) >= 0)
      )
        throw fail('PROTOCOL_ERROR', 'Invalid event page order or scope')
      previous = item.event.sequence
    }
  }
  private enqueue(entry: Internal, item: MaestroNetworkEvent) {
    this.insert(entry, item)
    const sequence = item.event.sequence
    if (compareMaestroSequences(sequence, entry.state.receivedSequence) > 0)
      entry.state = { ...entry.state, receivedSequence: sequence }
    if (compareMaestroSequences(sequence, entry.state.appliedSequence) <= 0) return
    entry.pending.set(sequence, item)
    if (entry.pending.size > this.limits.maxBufferedEvents) {
      entry.pending.clear()
      entry.checkpoints.clear()
      throw fail('BUFFER_EXCEEDED', 'Contiguous replay buffer limit reached')
    }
  }
  private drain(entry: Internal) {
    while (entry.pending.has(next(entry.state.appliedSequence))) {
      const sequence = next(entry.state.appliedSequence)
      const item = entry.pending.get(sequence)!
      if (item.known) this.project(entry, item.event)
      entry.pending.delete(sequence)
      entry.state = { ...entry.state, appliedSequence: sequence }
    }
    const positions = [...entry.checkpoints.keys()].sort(compareMaestroSequences)
    for (const sequence of positions) {
      if (compareMaestroSequences(sequence, entry.state.appliedSequence) <= 0) {
        if (compareMaestroSequences(sequence, entry.checkpointSequence) > 0) {
          entry.state = { ...entry.state, resumeCursor: entry.checkpoints.get(sequence)! }
          entry.checkpointSequence = sequence
        }
        entry.checkpoints.delete(sequence)
      }
    }
  }
  private insert(entry: Internal, item: MaestroNetworkEvent) {
    const event = item.event
    const existing = entry.state.eventsById[event.eventId]
    const sequenceId = entry.sequenceIds.get(event.sequence)
    if (existing || sequenceId) {
      if (!existing || sequenceId !== event.eventId || canonical(existing) !== canonical(item))
        throw fail('PROTOCOL_ERROR', 'Conflicting canonical event identity')
      return
    }
    if (entry.state.eventIds.length >= this.limits.maxEventsPerThread)
      throw fail('CAPACITY_EXCEEDED', 'Event memory limit reached; explicitly clear the scope')
    if (item.known) {
      const known = item.event
      if (known.type === 'message.created' && known.executionId && known.outputId)
        this.streams.final(known.threadId, known.executionId, known.outputId)
      if (
        known.type.startsWith('execution.') &&
        'execution_id' in known.payload &&
        'state' in known.payload &&
        known.payload.state !== 'running'
      )
        this.streams.endExecution(known.threadId, known.payload.execution_id as string)
    }
    entry.sequenceIds.set(event.sequence, event.eventId)
    const eventsById = { ...entry.state.eventsById, [event.eventId]: item }
    entry.state = {
      ...entry.state,
      eventsById,
      eventIds: [...entry.state.eventIds, event.eventId].sort((a, b) =>
        compareMaestroSequences(eventsById[a]!.event.sequence, eventsById[b]!.event.sequence)
      ),
    }
  }
  private newer(entry: Internal, key: string, sequence: string) {
    const prior = entry.versions.get(key)
    if (prior !== undefined && compareMaestroSequences(prior, sequence) >= 0) return false
    entry.versions.set(key, sequence)
    return true
  }
  private project(entry: Internal, event: MaestroEvent) {
    const payload = event.payload
    switch (event.type) {
      case 'participant.added': {
        const participant = toMaestroParticipant(event.payload.participant)
        if (this.newer(entry, `participant:${participant.participantId}`, event.sequence))
          entry.state = {
            ...entry.state,
            participantsById: {
              ...entry.state.participantsById,
              [participant.participantId]: participant,
            },
          }
        break
      }
      case 'participant.removed': {
        this.streams.removeParticipant(entry.state.threadId, event.payload.participant_id)
        const p = entry.state.participantsById[event.payload.participant_id]
        if (this.newer(entry, `participant:${event.payload.participant_id}`, event.sequence) && p)
          entry.state = {
            ...entry.state,
            participantsById: {
              ...entry.state.participantsById,
              [p.participantId]: {
                ...p,
                state: 'removed',
                leftSequence: event.payload.left_sequence,
              },
            },
          }
        break
      }
      case 'delivery.updated': {
        const d = event.payload.delivery
        if (this.newer(entry, `delivery:${d.delivery_id}`, event.sequence)) {
          entry.state = {
            ...entry.state,
            deliveriesById: { ...entry.state.deliveriesById, [d.delivery_id]: d },
          }
          // waiting_input durably ends productive execution, even when active execution_id is cleared.
          if (d.state === 'waiting_input')
            for (const e of Object.values(entry.state.executionsById)) {
              if (
                e.delivery_id === d.delivery_id &&
                e.state === 'running' &&
                this.newer(entry, `execution:${e.execution_id}`, event.sequence)
              ) {
                this.streams.endExecution(entry.state.threadId, e.execution_id)
                entry.state = {
                  ...entry.state,
                  executionsById: {
                    ...entry.state.executionsById,
                    [e.execution_id]: { ...e, state: 'suspended' },
                  },
                }
              }
            }
        }
        break
      }
      case 'execution.started':
      case 'execution.completed':
      case 'execution.failed':
      case 'execution.canceled': {
        const e = event.payload
        if (this.newer(entry, `execution:${e.execution_id}`, event.sequence))
          entry.state = {
            ...entry.state,
            executionsById: { ...entry.state.executionsById, [e.execution_id]: e },
          }
        break
      }
      case 'thread.updated':
      case 'thread.archived':
        if (event.type === 'thread.archived' || event.payload.state !== 'active')
          this.streams.interrupt(entry.state.threadId)
        if (entry.state.thread && this.newer(entry, 'thread', event.sequence))
          entry.state = {
            ...entry.state,
            thread: {
              ...entry.state.thread,
              ...('title' in payload ? { title: payload.title as string } : {}),
              state: event.type === 'thread.archived' ? 'archived' : event.payload.state,
              version: event.payload.version,
              lastSequence: event.sequence,
            },
          }
        break
    }
  }
}
