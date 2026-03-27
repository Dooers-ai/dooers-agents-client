import { createStore } from 'zustand/vanilla'
import type { AnalyticsEvent, Run, SettingsItem, Thread, ThreadEvent } from './types'
import { isSettingsFieldGroup } from './types'

type FormState = {
  values: Record<string, unknown>
  submitting: boolean
  submitted: boolean
  cancelled: boolean
}

/** Extract form states from form.response events to restore submitted/cancelled state. */
function extractFormStates(
  events: ThreadEvent[],
  existing: Record<string, FormState>
): Record<string, FormState> {
  let result = existing
  for (const e of events) {
    if (e.type === 'form.response' && e.data) {
      const formEventId = e.data.form_event_id as string
      if (formEventId && !result[formEventId]) {
        const cancelled = (e.data.cancelled as boolean) ?? false
        const values = (e.data.values as Record<string, unknown>) ?? {}
        result = {
          ...result,
          [formEventId]: { values, submitting: false, submitted: !cancelled, cancelled },
        }
      }
    }
  }
  return result
}

export interface WorkerActions {
  setConnectionStatus: (status: WorkerState['connection']['status'], error?: string) => void
  setReconnectFailed: () => void
  resetReconnect: () => void
  onThreadList: (threads: Thread[], cursor?: string | null, totalCount?: number) => void
  onThreadListAppend: (threads: Thread[], cursor?: string | null, totalCount?: number) => void
  onThreadUpsert: (thread: Thread) => void
  onThreadDeleted: (threadId: string) => void
  onThreadSnapshot: (thread: Thread, events: ThreadEvent[], runs: Run[]) => void
  onEventAppend: (threadId: string, events: ThreadEvent[]) => void
  reconcileEvents: (
    threadId: string,
    events: ThreadEvent[],
    resolvedClientEventIds: string[]
  ) => void
  onEventListResult: (
    threadId: string,
    events: ThreadEvent[],
    cursor: string | null,
    hasMore: boolean
  ) => void
  onRunUpsert: (run: Run) => void
  addOptimistic: (threadId: string, event: ThreadEvent, clientEventId: string) => void
  removeOptimistic: (threadId: string, clientEventId: string) => void
  addSubscription: (threadId: string) => void
  removeSubscription: (threadId: string) => void
  onSettingsSnapshot: (fields: SettingsItem[], updatedAt: string) => void
  onSettingsPatch: (fieldId: string, value: unknown, updatedAt: string) => void
  onFeedbackAck: (targetId: string, feedback: 'like' | 'dislike') => void
  onAnalyticsEvent: (event: AnalyticsEvent) => void
  resetAnalytics: () => void
  initFormState: (formEventId: string, defaults: Record<string, unknown>) => void
  setFormValue: (formEventId: string, fieldName: string, value: unknown) => void
  setFormSubmitting: (formEventId: string, submitting: boolean) => void
  setFormSubmitted: (formEventId: string) => void
  setFormCancelled: (formEventId: string) => void
}

export interface WorkerState {
  connection: {
    status: 'idle' | 'connecting' | 'connected' | 'disconnected' | 'error'
    error: string | null
    reconnectAttempts: number
    reconnectFailed: boolean
  }
  threads: Record<string, Thread>
  threadOrder: string[]
  threadListCursor: string | null
  threadListHasMore: boolean
  threadListTotalCount: number
  events: Record<string, ThreadEvent[]>
  eventPagination: Record<string, { cursor: string | null; hasMore: boolean }>
  optimistic: Record<string, ThreadEvent[]>
  optimisticKeys: Record<string, string[]>
  runs: Record<string, Run[]>
  settings: {
    fields: SettingsItem[]
    updatedAt: string | null
    isLoading: boolean
  }
  feedback: Record<string, 'like' | 'dislike'>
  analytics: {
    events: AnalyticsEvent[]
    counters: {
      totalRequests: number
      feedbackLikes: number
      feedbackDislikes: number
    }
  }
  formStates: Record<string, FormState>
  subscriptions: Set<string>
  loadingThreads: Set<string>
  actions: WorkerActions
}

export type WorkerStore = ReturnType<typeof createWorkerStore>

export function createWorkerStore() {
  return createStore<WorkerState>()((set) => ({
    connection: {
      status: 'idle',
      error: null,
      reconnectAttempts: 0,
      reconnectFailed: false,
    },
    threads: {},
    threadOrder: [],
    threadListCursor: null,
    threadListHasMore: false,
    threadListTotalCount: 0,
    events: {},
    eventPagination: {},
    optimistic: {},
    optimisticKeys: {},
    runs: {},
    settings: {
      fields: [],
      updatedAt: null,
      isLoading: true,
    },
    feedback: {},
    formStates: {},
    analytics: {
      events: [],
      counters: { totalRequests: 0, feedbackLikes: 0, feedbackDislikes: 0 },
    },
    subscriptions: new Set(),
    loadingThreads: new Set(),

    actions: {
      setConnectionStatus: (status, error) =>
        set((s) => ({
          connection: { ...s.connection, status, error: error ?? null },
        })),

      setReconnectFailed: () =>
        set((s) => ({
          connection: { ...s.connection, reconnectFailed: true },
        })),

      resetReconnect: () =>
        set((s) => ({
          connection: { ...s.connection, reconnectAttempts: 0, reconnectFailed: false },
        })),

      onThreadList: (threads, cursor, totalCount) =>
        set(() => {
          const map: Record<string, Thread> = {}
          const order: string[] = []
          for (const t of threads) {
            map[t.id] = t
            order.push(t.id)
          }
          return {
            threads: map,
            threadOrder: order,
            threadListCursor: cursor ?? null,
            threadListHasMore: cursor != null,
            threadListTotalCount: totalCount ?? 0,
          }
        }),

      onThreadListAppend: (threads, cursor) =>
        set((s) => {
          const map = { ...s.threads }
          const order = [...s.threadOrder]
          for (const t of threads) {
            if (!map[t.id]) {
              order.push(t.id)
            }
            map[t.id] = t
          }
          return {
            threads: map,
            threadOrder: order,
            threadListCursor: cursor ?? null,
            threadListHasMore: cursor != null,
          }
        }),

      onThreadUpsert: (thread) =>
        set((s) => {
          const threads = { ...s.threads, [thread.id]: thread }
          const threadOrder = s.threadOrder.includes(thread.id)
            ? s.threadOrder
            : [thread.id, ...s.threadOrder]
          return { threads, threadOrder }
        }),

      onThreadDeleted: (threadId) =>
        set((s) => {
          const { [threadId]: _, ...threads } = s.threads
          const { [threadId]: _e, ...events } = s.events
          const { [threadId]: _r, ...runs } = s.runs
          const { [threadId]: _o, ...optimistic } = s.optimistic
          const { [threadId]: _k, ...optimisticKeys } = s.optimisticKeys
          const { [threadId]: _p, ...eventPagination } = s.eventPagination
          const threadOrder = s.threadOrder.filter((id) => id !== threadId)
          const subscriptions = new Set(s.subscriptions)
          subscriptions.delete(threadId)
          const loadingThreads = new Set(s.loadingThreads)
          loadingThreads.delete(threadId)
          // Clean up form states for events belonging to this thread
          const deletedEvents = s.events[threadId] ?? []
          const deletedEventIds = new Set(deletedEvents.map((e) => e.id))
          const formStates = { ...s.formStates }
          for (const key of Object.keys(formStates)) {
            if (deletedEventIds.has(key)) {
              delete formStates[key]
            }
          }
          return {
            threads,
            threadOrder,
            events,
            runs,
            optimistic,
            optimisticKeys,
            eventPagination,
            subscriptions,
            loadingThreads,
            formStates,
          }
        }),

      onThreadSnapshot: (thread, snapshotEvents, runs) =>
        set((s) => {
          const threads = { ...s.threads, [thread.id]: thread }
          const threadOrder = s.threadOrder.includes(thread.id)
            ? s.threadOrder
            : [thread.id, ...s.threadOrder]
          const loadingThreads = new Set(s.loadingThreads)
          loadingThreads.delete(thread.id)

          // Events may already exist from event.append arriving before the
          // snapshot (race between the two data paths). Existing array is
          // already in chronological order. Append only snapshot events we
          // don't have yet — never reorder what's already in place.
          const existing = s.events[thread.id] ?? []
          let mergedEvents: ThreadEvent[]
          if (existing.length === 0) {
            mergedEvents = snapshotEvents
          } else {
            const existingIds = new Set(existing.map((e) => e.id))
            const newFromSnapshot = snapshotEvents.filter((e) => !existingIds.has(e.id))
            mergedEvents = newFromSnapshot.length > 0 ? [...existing, ...newFromSnapshot] : existing
          }

          // Snapshot is authoritative — clear optimistic state for this thread.
          const optimistic = { ...s.optimistic }
          const optimisticKeys = { ...s.optimisticKeys }
          delete optimistic[thread.id]
          delete optimisticKeys[thread.id]

          return {
            threads,
            threadOrder,
            events: { ...s.events, [thread.id]: mergedEvents },
            runs: { ...s.runs, [thread.id]: runs },
            optimistic,
            optimisticKeys,
            loadingThreads,
            formStates: extractFormStates(mergedEvents, s.formStates),
          }
        }),

      onEventAppend: (threadId, newEvents) =>
        set((s) => {
          const existing = s.events[threadId] ?? []
          const existingIds = new Set(existing.map((e) => e.id))
          // Separate new events from updates to existing events
          const updates = new Map<string, ThreadEvent>()
          const appends: ThreadEvent[] = []
          for (const e of newEvents) {
            if (existingIds.has(e.id)) {
              updates.set(e.id, e)
            } else {
              appends.push(e)
            }
          }
          // Apply in-place updates then append new events
          const merged = updates.size > 0 ? existing.map((e) => updates.get(e.id) ?? e) : existing
          return {
            events: { ...s.events, [threadId]: [...merged, ...appends] },
            formStates: extractFormStates(appends, s.formStates),
          }
        }),

      reconcileEvents: (threadId, newEvents, resolvedClientEventIds) =>
        set((s) => {
          // Append confirmed events
          const existing = s.events[threadId] ?? []
          const existingIds = new Set(existing.map((e) => e.id))
          const unique = newEvents.filter((e) => !existingIds.has(e.id))

          // Remove reconciled optimistic events
          let optEvents = s.optimistic[threadId] ?? []
          let optKeys = s.optimisticKeys[threadId] ?? []
          for (const clientEventId of resolvedClientEventIds) {
            const idx = optKeys.indexOf(clientEventId)
            if (idx >= 0) {
              optEvents = [...optEvents]
              optEvents.splice(idx, 1)
              optKeys = [...optKeys]
              optKeys.splice(idx, 1)
            }
          }

          return {
            events: { ...s.events, [threadId]: [...existing, ...unique] },
            optimistic: { ...s.optimistic, [threadId]: optEvents },
            optimisticKeys: { ...s.optimisticKeys, [threadId]: optKeys },
          }
        }),

      onEventListResult: (threadId, olderEvents, cursor, hasMore) =>
        set((s) => {
          const existing = s.events[threadId] ?? []
          const existingIds = new Set(existing.map((e) => e.id))
          const unique = olderEvents.filter((e) => !existingIds.has(e.id))
          return {
            events: { ...s.events, [threadId]: [...unique, ...existing] },
            eventPagination: {
              ...s.eventPagination,
              [threadId]: { cursor, hasMore },
            },
          }
        }),

      onRunUpsert: (run) =>
        set((s) => {
          const existing = s.runs[run.threadId] ?? []
          const idx = existing.findIndex((r) => r.id === run.id)
          const updated =
            idx >= 0 ? existing.map((r) => (r.id === run.id ? run : r)) : [...existing, run]
          return { runs: { ...s.runs, [run.threadId]: updated } }
        }),

      addOptimistic: (threadId, event, clientEventId) =>
        set((s) => ({
          optimistic: {
            ...s.optimistic,
            [threadId]: [...(s.optimistic[threadId] ?? []), event],
          },
          optimisticKeys: {
            ...s.optimisticKeys,
            [threadId]: [...(s.optimisticKeys[threadId] ?? []), clientEventId],
          },
        })),

      removeOptimistic: (threadId, clientEventId) =>
        set((s) => {
          const keys = s.optimisticKeys[threadId] ?? []
          const idx = keys.indexOf(clientEventId)
          if (idx < 0) return s
          const newKeys = [...keys]
          newKeys.splice(idx, 1)
          const newEvents = [...(s.optimistic[threadId] ?? [])]
          newEvents.splice(idx, 1)
          return {
            optimistic: { ...s.optimistic, [threadId]: newEvents },
            optimisticKeys: { ...s.optimisticKeys, [threadId]: newKeys },
          }
        }),

      addSubscription: (threadId) =>
        set((s) => {
          const subscriptions = new Set(s.subscriptions)
          subscriptions.add(threadId)
          const loadingThreads = new Set(s.loadingThreads)
          loadingThreads.add(threadId)
          return { subscriptions, loadingThreads }
        }),

      removeSubscription: (threadId) =>
        set((s) => {
          const subscriptions = new Set(s.subscriptions)
          subscriptions.delete(threadId)
          const loadingThreads = new Set(s.loadingThreads)
          loadingThreads.delete(threadId)
          return { subscriptions, loadingThreads }
        }),

      onSettingsSnapshot: (fields, updatedAt) =>
        set(() => ({
          settings: { fields, updatedAt, isLoading: false },
        })),

      onSettingsPatch: (fieldId, value, updatedAt) =>
        set((s) => ({
          settings: {
            ...s.settings,
            updatedAt,
            fields: s.settings.fields.map((item) => {
              if (isSettingsFieldGroup(item)) {
                const hasField = item.fields.some((f) => f.id === fieldId)
                if (hasField) {
                  return {
                    ...item,
                    fields: item.fields.map((f) => (f.id === fieldId ? { ...f, value } : f)),
                  }
                }
                return item
              }
              return item.id === fieldId ? { ...item, value } : item
            }),
          },
        })),

      onFeedbackAck: (targetId, feedback) =>
        set((s) => ({
          feedback: { ...s.feedback, [targetId]: feedback },
        })),

      onAnalyticsEvent: (event) =>
        set((s) => {
          const events = [...s.analytics.events, event]
          const trimmed = events.length > 50 ? events.slice(-50) : events
          const counters = { ...s.analytics.counters }
          if (event.event === 'feedback.like') {
            counters.feedbackLikes += 1
          } else if (event.event === 'feedback.dislike') {
            counters.feedbackDislikes += 1
          } else {
            counters.totalRequests += 1
          }
          return { analytics: { events: trimmed, counters } }
        }),

      resetAnalytics: () =>
        set(() => ({
          analytics: {
            events: [],
            counters: { totalRequests: 0, feedbackLikes: 0, feedbackDislikes: 0 },
          },
        })),
      initFormState: (formEventId, defaults) =>
        set((s) => {
          if (s.formStates[formEventId]) return s
          return {
            formStates: {
              ...s.formStates,
              [formEventId]: {
                values: defaults,
                submitting: false,
                submitted: false,
                cancelled: false,
              },
            },
          }
        }),
      setFormSubmitting: (formEventId, submitting) =>
        set((s) => {
          const existing = s.formStates[formEventId]
          if (!existing) return s
          return {
            formStates: {
              ...s.formStates,
              [formEventId]: { ...existing, submitting },
            },
          }
        }),
      setFormValue: (formEventId, fieldName, value) =>
        set((s) => {
          const existing = s.formStates[formEventId]
          if (!existing || existing.submitted || existing.cancelled) return s
          return {
            formStates: {
              ...s.formStates,
              [formEventId]: {
                ...existing,
                values: { ...existing.values, [fieldName]: value },
              },
            },
          }
        }),
      setFormSubmitted: (formEventId) =>
        set((s) => {
          const existing = s.formStates[formEventId]
          if (!existing) return s
          return {
            formStates: {
              ...s.formStates,
              [formEventId]: { ...existing, submitting: false, submitted: true },
            },
          }
        }),
      setFormCancelled: (formEventId) =>
        set((s) => {
          const existing = s.formStates[formEventId]
          if (!existing) return s
          return {
            formStates: {
              ...s.formStates,
              [formEventId]: { ...existing, submitting: false, cancelled: true },
            },
          }
        }),
    },
  }))
}
