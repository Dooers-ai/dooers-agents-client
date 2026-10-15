import type { MaestroEvent } from '../protocol/maestro/contracts.js'
import {
  MaestroClientError,
  type MaestroPublication,
  type MaestroPublicationResult,
  type MaestroPublicationSnapshot,
} from './types.js'

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`
  return JSON.stringify(value)
}
export function immutable<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) immutable(item)
    Object.freeze(value)
  }
  return value
}
export function publicationKey(thread: string, key: string) {
  return JSON.stringify([thread, key])
}

/** Publication receipts only. E04-10 owns replay, contiguous cursors and the thread store. */
export class MaestroPublicationLedger {
  private snapshot: MaestroPublicationSnapshot = immutable({ publications: [], events: [] })
  private listeners = new Set<() => void>()
  getSnapshot = () => this.snapshot
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  get(threadId: string, clientEventId: string) {
    threadId = threadId.toLowerCase()
    return this.snapshot.publications.find(
      (p) => p.threadId === threadId && p.clientEventId === clientEventId
    )
  }
  set(publication: MaestroPublication) {
    const publications = this.snapshot.publications.filter(
      (p) => p.threadId !== publication.threadId || p.clientEventId !== publication.clientEventId
    )
    this.publish({ ...this.snapshot, publications: [...publications, immutable(publication)] })
  }
  observe(event: MaestroEvent) {
    const existing = this.snapshot.events.find(
      (item) =>
        item.eventId === event.eventId ||
        (item.threadId === event.threadId && item.sequence === event.sequence) ||
        (item.threadId === event.threadId &&
          item.type === 'message.created' &&
          event.type === 'message.created' &&
          item.actor.principalId === event.actor.principalId &&
          item.payload.client_event_id !== undefined &&
          item.payload.client_event_id === event.payload.client_event_id)
    )
    if (existing) {
      if (canonical(existing) !== canonical(event))
        throw new MaestroClientError('PROTOCOL_ERROR', 'Conflicting canonical event')
      return
    }
    this.publish({ ...this.snapshot, events: [...this.snapshot.events, immutable(event)] })
  }
  persist(result: MaestroPublicationResult) {
    this.observe(result.event)
    this.set({
      threadId: result.threadId,
      clientEventId: result.clientEventId,
      state: 'persisted',
      result,
    })
  }
  removeThread(threadId: string) {
    this.publish({
      publications: this.snapshot.publications.filter((p) => p.threadId !== threadId),
      events: this.snapshot.events.filter((e) => e.threadId !== threadId),
    })
  }
  clear() {
    this.publish({ publications: [], events: [] })
  }
  private publish(snapshot: MaestroPublicationSnapshot) {
    this.snapshot = immutable(snapshot)
    for (const listener of this.listeners) {
      try {
        listener()
      } catch {
        /* UI observers cannot change commit results. */
      }
    }
  }
}
