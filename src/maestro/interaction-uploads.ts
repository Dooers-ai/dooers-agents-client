import type { MaestroArtifacts } from './artifacts.js'
import type { MaestroBoundFieldArtifact } from './interactions.js'
import { immutable } from './publications.js'
import { MaestroClientError } from './types.js'
export interface MaestroFieldUpload {
  id: string
  threadId: string
  interactionId: string
  fieldName: string
  filename: string
  state: 'pending' | 'unknown' | 'error' | 'ready'
  removable: boolean
  artifactId?: string
  errorCode?: string
}
export interface MaestroFieldRestore {
  threadId: string
  interactionId: string
  state: 'pending' | 'ready' | 'error'
  errorCode?: string
}
/** Owns field drafts independently of the message composer; successful bindings cannot be unbound. */
export class MaestroInteractionUploads {
  private restores = new Map<string, MaestroFieldRestore>()
  private restoreFlights = new Map<string, Promise<void>>()
  private restoreControllers = new Map<string, AbortController>()
  private refs = new Map<string, number>()
  private restoreSnapshot: readonly MaestroFieldRestore[] = Object.freeze([])
  private binding = new Set<string>()
  private entries = new Map<string, Omit<MaestroFieldUpload, 'removable'>>()
  private flights = new Map<string, Promise<string>>()
  private listeners = new Set<() => void>()
  private snapshot: readonly MaestroFieldUpload[] = Object.freeze([])
  constructor(
    private artifacts: MaestroArtifacts,
    private authorize: (threadId: string, interactionId: string, fieldName: string) => void,
    private bind: (
      threadId: string,
      interactionId: string,
      fieldName: string,
      draftId: string
    ) => Promise<string>,
    private recover?: (
      threadId: string,
      interactionId: string,
      signal: AbortSignal
    ) => Promise<MaestroBoundFieldArtifact[]>
  ) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  getSnapshot = () => this.snapshot
  getRestoreSnapshot = () => this.restoreSnapshot
  isRestored(threadId: string, interactionId: string) {
    return (
      this.restores.get(JSON.stringify([threadId.toLowerCase(), interactionId.toLowerCase()]))
        ?.state === 'ready'
    )
  }
  retain(threadId: string, interactionId: string) {
    const key = JSON.stringify([threadId.toLowerCase(), interactionId.toLowerCase()])
    this.refs.set(key, (this.refs.get(key) ?? 0) + 1)
    return () => {
      const count = (this.refs.get(key) ?? 1) - 1
      if (count > 0) {
        this.refs.set(key, count)
        return
      }
      this.refs.delete(key)
      this.restoreControllers.get(key)?.abort()
      this.restoreControllers.delete(key)
      this.restoreFlights.delete(key)
      if (this.restores.get(key)?.state === 'pending') this.restores.delete(key)
      this.changed()
    }
  }
  restore(threadId: string, interactionId: string, retry = false): Promise<void> {
    threadId = threadId.toLowerCase()
    interactionId = interactionId.toLowerCase()
    const key = JSON.stringify([threadId, interactionId]),
      flight = this.restoreFlights.get(key),
      previous = this.restores.get(key)
    if (flight) return flight
    if (previous && !retry) return Promise.resolve()
    const recover = this.recover
    if (!recover)
      return Promise.reject(
        new MaestroClientError('UNSUPPORTED_CAPABILITY', 'Field recovery unavailable')
      )
    const controller = new AbortController(),
      pending: MaestroFieldRestore = immutable({ threadId, interactionId, state: 'pending' })
    this.restoreControllers.set(key, controller)
    this.restores.set(key, pending)
    this.changed()
    const current = () => !controller.signal.aborted && this.restores.get(key) === pending
    const run = Promise.resolve()
      .then(() => {
        if (!current()) throw new MaestroClientError('DISCONNECTED', 'Field recovery closed')
        return recover(threadId, interactionId, controller.signal)
      })
      .then((items) => {
        if (!current()) throw new MaestroClientError('FORBIDDEN', 'Field recovery closed')
        if (
          this.entries.size +
            items.filter(
              (item) =>
                ![...this.entries.values()].some(
                  (entry) =>
                    entry.threadId === threadId &&
                    entry.interactionId === interactionId &&
                    entry.artifactId === item.artifact_id
                )
            ).length >
          3200
        )
          throw new MaestroClientError('CLIENT_LIMIT', 'Field draft limit reached')
        for (const item of items)
          if (
            ![...this.entries.values()].some(
              (entry) =>
                entry.threadId === threadId &&
                entry.interactionId === interactionId &&
                entry.artifactId === item.artifact_id
            )
          ) {
            const id = `bound:${item.artifact_id}`
            this.entries.set(
              id,
              immutable({
                id,
                threadId,
                interactionId,
                fieldName: item.field_name,
                filename: item.filename,
                state: 'ready',
                artifactId: item.artifact_id,
              })
            )
          }
        this.restores.set(key, immutable({ threadId, interactionId, state: 'ready' }))
      })
      .catch((cause: unknown) => {
        const error =
          cause instanceof MaestroClientError
            ? cause
            : new MaestroClientError('NETWORK_ERROR', 'Field recovery unavailable', true)
        if (current())
          this.restores.set(
            key,
            immutable({ threadId, interactionId, state: 'error', errorCode: error.code })
          )
        throw error
      })
      .finally(() => {
        if (this.restoreFlights.get(key) === run) {
          this.restoreFlights.delete(key)
          this.restoreControllers.delete(key)
        }
        this.changed()
      })
    this.restoreFlights.set(key, run)
    return run
  }
  add(
    threadId: string,
    interactionId: string,
    fieldName: string,
    file: Blob,
    filename: string
  ): string {
    if (
      this.entries.size >= 3200 ||
      [...this.entries.values()].filter((item) => item.state !== 'ready').length >= 16
    )
      throw new MaestroClientError('CLIENT_LIMIT', 'Field draft limit reached')
    this.authorize(threadId, interactionId, fieldName)
    const id = this.artifacts.add(file, filename)
    this.entries.set(
      id,
      immutable({
        id,
        threadId: threadId.toLowerCase(),
        interactionId: interactionId.toLowerCase(),
        fieldName,
        filename,
        state: 'pending',
      })
    )
    this.changed()
    void this.retry(id).catch(() => {})
    return id
  }
  retry(id: string): Promise<string> {
    const prior = this.entries.get(id),
      flight = this.flights.get(id)
    if (flight) return flight
    if (!prior)
      return Promise.reject(new MaestroClientError('INVALID_REQUEST', 'Field upload not found'))
    if (prior.state === 'ready') return Promise.resolve(prior.artifactId!)
    const pending = immutable({ ...prior, state: 'pending' as const, errorCode: undefined })
    this.entries.set(id, pending)
    this.changed()
    const run = Promise.resolve()
      .then(() => {
        if (this.entries.get(id) !== pending)
          throw new MaestroClientError('DISCONNECTED', 'Field upload closed')
        return this.bind(prior.threadId, prior.interactionId, prior.fieldName, id)
      })
      .then((artifactId) => {
        if (this.entries.get(id) !== pending)
          throw new MaestroClientError('FORBIDDEN', 'Field upload closed')
        this.entries.set(id, immutable({ ...pending, state: 'ready', artifactId }))
        return artifactId
      })
      .catch((cause: unknown) => {
        const error =
          cause instanceof MaestroClientError
            ? cause
            : new MaestroClientError('NETWORK_ERROR', 'Field binding unavailable', true)
        if (this.entries.get(id) === pending)
          this.entries.set(
            id,
            immutable({
              ...pending,
              state:
                error.retryable ||
                [
                  'NETWORK_ERROR',
                  'TIMEOUT',
                  'PROTOCOL_ERROR',
                  'DEPENDENCY_UNAVAILABLE',
                  'CORE_UNAVAILABLE',
                ].includes(error.code)
                  ? 'unknown'
                  : 'error',
              errorCode: error.code,
            })
          )
        throw error
      })
      .finally(() => {
        if (this.flights.get(id) === run) this.flights.delete(id)
        this.changed()
      })
    this.flights.set(id, run)
    return run
  }
  markBinding(id: string) {
    if (!this.entries.has(id))
      throw new MaestroClientError('DISCONNECTED', 'Field draft closed before binding')
    this.binding.add(id)
    this.changed()
  }
  remove(id: string) {
    if (this.entries.get(id)?.state === 'ready' || this.binding.has(id))
      throw new MaestroClientError(
        'BOUND_ARTIFACT_IMMUTABLE',
        'Bound files cannot be removed; cancel this form to change files'
      )
    this.artifacts.remove(id)
    this.entries.delete(id)
    this.binding.delete(id)
    this.flights.delete(id)
    this.changed()
  }
  invalidateRecovery() {
    for (const controller of this.restoreControllers.values()) controller.abort()
    this.restores.clear()
    this.restoreFlights.clear()
    this.restoreControllers.clear()
    this.changed()
  }
  removeThread(threadId: string) {
    threadId = threadId.toLowerCase()
    for (const [id, item] of this.entries)
      if (item.threadId === threadId) {
        this.artifacts.remove(id)
        this.entries.delete(id)
        this.binding.delete(id)
        this.flights.delete(id)
      }
    for (const [key, item] of this.restores)
      if (item.threadId === threadId) {
        this.restoreControllers.get(key)?.abort()
        this.restoreControllers.delete(key)
        this.restoreFlights.delete(key)
        this.restores.delete(key)
        this.refs.delete(key)
      }
    this.changed()
  }
  clear() {
    for (const id of this.entries.keys()) this.artifacts.remove(id)
    for (const controller of this.restoreControllers.values()) controller.abort()
    this.entries.clear()
    this.binding.clear()
    this.flights.clear()
    this.restores.clear()
    this.restoreFlights.clear()
    this.restoreControllers.clear()
    this.refs.clear()
    this.changed()
  }
  private changed() {
    this.snapshot = Object.freeze(
      [...this.entries.values()].map((item) =>
        immutable({ ...item, removable: item.state !== 'ready' && !this.binding.has(item.id) })
      )
    )
    this.restoreSnapshot = Object.freeze([...this.restores.values()])
    for (const listener of this.listeners) {
      try {
        listener()
      } catch {}
    }
  }
}
