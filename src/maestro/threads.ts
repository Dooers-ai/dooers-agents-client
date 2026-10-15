import { compareMaestroSequences, toMaestroThread } from '../protocol/maestro/contracts.js'
import type { MaestroClient } from './client.js'
import { toMaestroNetworkEvent } from './network.js'
import { MaestroClientError } from './types.js'

type Reference = {
  count: number
  revision: number
  subscriptionId?: string
  pending: boolean
  watermark: string
  mode: 'snapshot' | 'replay'
  retries: number
  timer?: ReturnType<typeof setTimeout>
  permissionDirty?: boolean
  permissionFlight?: object
  permissionSequence?: string
  history?: Promise<void>
}
const failure = (cause: unknown) =>
  cause instanceof MaestroClientError
    ? cause
    : new MaestroClientError('PROTOCOL_ERROR', 'Invalid Maestro replay')

/** Ref ownership and recovery live above the single wire subscription API. */
export class MaestroThreads {
  private refs = new Map<string, Reference>()
  private epoch = 0
  constructor(
    private readonly client: MaestroClient,
    private readonly retryLimit: number,
    private readonly retryDelay: number
  ) {
    client.onFrame((frame) => this.frame(frame))
    client.subscribeConnection(() => {
      const status = client.getConnection().status
      if (status === 'connected') for (const [id, ref] of this.refs) this.start(id, ref)
      else if (status !== 'refreshing') this.disconnected()
    })
  }
  retain(threadId: string): () => void {
    threadId = this.client.normalizeThreadId(threadId)
    let ref = this.refs.get(threadId)
    if (!ref) {
      ref = { count: 0, revision: 0, pending: false, retries: 0, watermark: '0', mode: 'snapshot' }
      this.refs.set(threadId, ref)
    }
    ref.count++
    this.client.store.patch(threadId, { refs: ref.count })
    this.start(threadId, ref)
    let released = false
    return () => {
      if (released) return
      released = true
      if (this.refs.get(threadId) !== ref) return
      ref.count--
      this.client.store.patch(threadId, { refs: ref.count })
      if (ref.count) return
      ref.revision++
      clearTimeout(ref.timer)
      this.refs.delete(threadId)
      if (ref.subscriptionId) void this.client.unsubscribeThread(ref.subscriptionId).catch(() => {})
      this.client.store.patch(threadId, { phase: 'idle' })
    }
  }
  close(threadId: string) {
    const ref = this.refs.get(threadId)
    if (ref?.subscriptionId) void this.client.unsubscribeThread(ref.subscriptionId).catch(() => {})
    if (ref) this.revoke(threadId, ref)
    else {
      this.client.forgetThread(threadId)
      this.client.store.revoke(threadId)
    }
  }
  reset() {
    this.epoch++
    for (const ref of this.refs.values()) {
      ref.revision++
      clearTimeout(ref.timer)
    }
    this.refs.clear()
  }
  private disconnected() {
    for (const [id, ref] of this.refs) {
      ref.revision++
      ref.pending = false
      ref.permissionFlight = undefined
      ref.permissionDirty = false
      ref.subscriptionId = undefined
      clearTimeout(ref.timer)
      ref.timer = undefined
      ref.retries = 0
      this.client.store.patch(id, { phase: 'disconnected', historyLoading: false })
    }
  }
  accessLost() {
    this.epoch++
    this.disconnected()
    this.client.store.clear()
    for (const [id, ref] of this.refs)
      this.client.store.patch(id, { refs: ref.count, phase: 'disconnected' })
  }
  private start(id: string, ref: Reference) {
    if (
      !ref.count ||
      ref.pending ||
      ref.subscriptionId ||
      ref.timer ||
      this.client.getConnection().status !== 'connected' ||
      ['revoked', 'failed'].includes(this.client.store.getThread(id)?.phase ?? '')
    )
      return
    const revision = ++ref.revision
    const cursor = this.client.store.getThread(id)?.resumeCursor ?? undefined
    ref.pending = true
    this.client.store.patch(id, { phase: 'subscribing', error: null })
    void this.client
      .subscribeThread(id, cursor, (subscriptionId, watermark, mode) => {
        if (this.refs.get(id) === ref && ref.revision === revision && ref.count) {
          ref.subscriptionId = subscriptionId
          ref.watermark = watermark
          ref.mode = mode
          this.client.store.patch(id, { phase: 'replaying' })
        }
      })
      .then((ack) => {
        if (this.refs.get(id) !== ref || ref.revision !== revision || !ref.count) {
          void this.client.unsubscribeThread(ack.subscriptionId).catch(() => {})
          return
        }
        ref.subscriptionId = ack.subscriptionId
        ref.pending = false
      })
      .catch((cause) => {
        if (this.refs.get(id) !== ref || ref.revision !== revision) return
        ref.pending = false
        const e = failure(cause)
        if (['NOT_FOUND', 'FORBIDDEN', 'UNAUTHENTICATED'].includes(e.code)) this.revoke(id, ref)
        else this.recover(id, ref, e.code === 'CURSOR_EXPIRED' || e.code === 'CURSOR_INVALID', e)
      })
  }
  retry(threadId: string, snapshot = false) {
    const id = this.client.normalizeThreadId(threadId),
      ref = this.refs.get(id)
    if (!ref) throw new MaestroClientError('NOT_SUBSCRIBED', 'Retain a thread before replay')
    if (this.client.store.getThread(id)?.phase === 'revoked')
      throw new MaestroClientError('FORBIDDEN', 'Thread access was revoked')
    ref.retries = 0
    this.recover(
      id,
      ref,
      snapshot,
      new MaestroClientError('RESYNC_REQUIRED', 'Explicit replay requested')
    )
  }
  private recover(id: string, ref: Reference, snapshot: boolean, cause: MaestroClientError) {
    if (ref.timer || this.refs.get(id) !== ref || !ref.count) return
    const old = ref.subscriptionId
    ref.permissionFlight = undefined
    ref.permissionSequence = undefined
    ref.revision++
    ref.pending = false
    ref.subscriptionId = undefined
    if (old) void this.client.unsubscribeThread(old).catch(() => {})
    if (snapshot) this.client.resetThreadContinuity(id)
    this.client.store.restart(id, snapshot)
    this.client.store.patch(id, { phase: 'resync', error: cause })
    if (
      ++ref.retries > this.retryLimit ||
      cause.code === 'CAPACITY_EXCEEDED' ||
      cause.code === 'UNSUPPORTED_CAPABILITY'
    ) {
      this.client.store.patch(id, { phase: 'failed' })
      return
    }
    ref.timer = setTimeout(
      () => {
        ref.timer = undefined
        this.start(id, ref)
      },
      Math.min(this.retryDelay * 2 ** (ref.retries - 1), 30000)
    )
  }
  private revoke(id: string, ref: Reference) {
    ref.permissionFlight = undefined
    ref.permissionDirty = false
    ref.revision++
    ref.pending = false
    ref.subscriptionId = undefined
    clearTimeout(ref.timer)
    ref.timer = undefined
    this.client.forgetThread(id)
    this.client.store.revoke(id)
  }
  private permissionsChanged(id: string, ref: Reference, values: unknown[]) {
    const floor =
      ref.permissionSequence ?? this.client.store.getThread(id)?.thread?.lastSequence ?? '0'
    let latest = floor
    for (const value of values) {
      const parsed = toMaestroNetworkEvent(value)
      if (!parsed.known) continue
      const event = parsed.event
      if (compareMaestroSequences(event.sequence, latest) <= 0) continue
      if (event.type === 'message.created' && event.actor.kind !== 'human') continue
      if (
        ![
          'message.created',
          'delivery.updated',
          'execution.started',
          'execution.completed',
          'execution.failed',
          'execution.canceled',
          'root.stopped',
          'participant.added',
          'participant.removed',
          'thread.updated',
          'thread.archived',
        ].includes(event.type)
      )
        continue
      latest = event.sequence
    }
    if (latest === floor) return
    ref.permissionSequence = latest
    ref.permissionDirty = true
    this.client.store.invalidateCancellationPermission(id)
    this.refreshPermissions(id, ref)
  }
  private refreshPermissions(id: string, ref: Reference) {
    if (
      ref.permissionFlight ||
      !ref.permissionDirty ||
      !ref.count ||
      this.client.store.getThread(id)?.phase !== 'live' ||
      this.client.getConnection().status !== 'connected'
    )
      return
    const flight = {},
      revision = ref.revision
    ref.permissionFlight = flight
    const current = () =>
      this.refs.get(id) === ref &&
      ref.count > 0 &&
      ref.revision === revision &&
      ref.permissionFlight === flight &&
      this.client.getConnection().status === 'connected'
    void Promise.resolve()
      .then(async () => {
        if (!current()) return
        ref.permissionDirty = false
        // Um burst canônico dispara uma leitura; mudanças durante o HTTP viram uma leitura seguinte.
        await this.client.refreshThreadPermissions(id, () => current() && !ref.permissionDirty)
      })
      .catch((cause) => {
        if (
          current() &&
          ['NOT_FOUND', 'FORBIDDEN', 'UNAUTHENTICATED'].includes(failure(cause).code)
        )
          this.revoke(id, ref)
      })
      .finally(() => {
        if (ref.permissionFlight !== flight) return
        ref.permissionFlight = undefined
        if (this.refs.get(id) === ref && ref.revision === revision && ref.count > 0)
          this.refreshPermissions(id, ref)
      })
  }
  private frame(frame: { type: string; payload: unknown }) {
    if (frame.type === 'client.access_lost') {
      this.accessLost()
      return
    }
    const payload = frame.payload as {
      subscription_id: string
      events: unknown[]
      watermark: string
      next_cursor: string | null
      has_more: boolean
      thread: { thread_id: string; last_sequence: string }
      event: unknown
      cursor: string
      action: string
      reason_code: string
    }
    const pair = [...this.refs].find(([, ref]) => ref.subscriptionId === payload.subscription_id)
    if (!pair) return
    const [id, ref] = pair
    try {
      switch (frame.type) {
        case 'thread.snapshot':
          if (
            payload.thread.thread_id !== id ||
            payload.thread.last_sequence !== payload.watermark ||
            ref.mode !== 'snapshot'
          )
            throw new MaestroClientError('PROTOCOL_ERROR', 'Snapshot thread mismatch')
          this.client.store.observeThread(toMaestroThread(payload.thread))
          ref.permissionSequence = payload.watermark
          if (this.client.store.getThread(id)?.phase === 'revoked') {
            this.revoke(id, ref)
            return
          }
          this.client.store.page(
            id,
            payload.events.map(toMaestroNetworkEvent),
            payload.watermark,
            payload.next_cursor,
            payload.has_more
          )
          break
        case 'thread.replay':
          this.permissionsChanged(id, ref, payload.events)
          this.client.store.page(
            id,
            payload.events.map(toMaestroNetworkEvent),
            payload.watermark,
            payload.next_cursor,
            payload.has_more
          )
          break
        case 'event.append':
          this.client.store.append(id, toMaestroNetworkEvent(payload.event), payload.cursor)
          if (
            ['deleting', 'deleted'].includes(this.client.store.getThread(id)?.thread?.state ?? '')
          ) {
            this.close(id)
            return
          }
          this.permissionsChanged(id, ref, [payload.event])
          break
        case 'thread.caught_up':
          if (
            compareMaestroSequences(payload.watermark, ref.watermark) < 0 ||
            !this.client.store.caughtUp(id, payload.watermark, payload.cursor)
          )
            this.recover(
              id,
              ref,
              false,
              new MaestroClientError('SEQUENCE_GAP', 'Replay watermark is not covered')
            )
          else {
            ref.retries = 0
            this.refreshPermissions(id, ref)
          }
          break
        case 'resync.required':
          this.recover(
            id,
            ref,
            payload.action === 'snapshot',
            new MaestroClientError('RESYNC_REQUIRED', `Replay required: ${payload.reason_code}`)
          )
          return
        case 'subscription.revoked':
          this.revoke(id, ref)
          return
      }
      if (this.client.store.hasGap(id))
        this.recover(
          id,
          ref,
          false,
          new MaestroClientError('SEQUENCE_GAP', 'Replay has a sequence gap')
        )
    } catch (cause) {
      this.recover(id, ref, false, failure(cause))
    }
  }
  loadBefore(threadId: string, options: { before?: string; limit?: number } = {}): Promise<void> {
    const id = this.client.normalizeThreadId(threadId),
      ref = this.refs.get(id)
    if (!ref)
      return Promise.reject(
        new MaestroClientError('NOT_SUBSCRIBED', 'Retain a thread before loading history')
      )
    if (ref.history) return ref.history
    const state = this.client.store.getThread(id)!
    if (state.phase === 'revoked')
      return Promise.reject(new MaestroClientError('FORBIDDEN', 'Thread access was revoked'))
    const before = options.before ?? state.beforeCursor ?? state.resumeCursor
    if (!before)
      return Promise.reject(
        new MaestroClientError(
          'NO_HISTORY_CURSOR',
          'Wait for replay before requesting older history'
        )
      )
    if (!options.before && state.beforeCursor === null && !state.historyHasMore)
      return Promise.resolve()
    const revision = ref.revision,
      epoch = this.epoch
    this.client.store.patch(id, { historyLoading: true })
    const promise = this.client
      .getHistoryPage(id, { before, limit: options.limit })
      .then((page) => {
        if (this.refs.get(id) !== ref || ref.revision !== revision || this.epoch !== epoch) return
        if (page.hasMore && page.nextCursor === before)
          throw new MaestroClientError('PROTOCOL_ERROR', 'History cursor did not progress')
        this.client.store.history(id, page)
      })
      .catch((cause) => {
        if (this.refs.get(id) === ref && ref.revision === revision && this.epoch === epoch) {
          const e = failure(cause)
          if (['NOT_FOUND', 'FORBIDDEN', 'UNAUTHENTICATED'].includes(e.code)) this.revoke(id, ref)
          else this.client.store.patch(id, { error: e })
        }
        throw cause
      })
      .finally(() => {
        if (ref.history === promise) ref.history = undefined
        if (this.refs.get(id) === ref && ref.revision === revision && this.epoch === epoch)
          this.client.store.patch(id, { historyLoading: false })
      })
    ref.history = promise
    return promise
  }
}
