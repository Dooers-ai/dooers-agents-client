import { useCallback, useEffect, useMemo } from 'react'
import { useStore, useWorkerContext } from '../provider'
import type { Run, Thread, ThreadEvent, ThreadState } from '../types'

const EMPTY_ARRAY: ThreadEvent[] = []
const EMPTY_RUNS: Run[] = []

export function useThreadDetails(threadId: string | null): ThreadState {
  const { client } = useWorkerContext()

  // Auto-subscribe/unsubscribe
  useEffect(() => {
    if (!threadId) return
    client.subscribe(threadId)
    return () => client.unsubscribe(threadId)
  }, [threadId, client])

  // All selectors return direct store references or constants — Object.is is sufficient
  const thread = useStore((s): Thread | null => (threadId ? (s.threads[threadId] ?? null) : null))
  const isLoading = useStore((s) => (threadId ? s.loadingThreads.has(threadId) : false))
  const isWaiting = useStore((s) => {
    if (!threadId) return false
    const r = s.runs[threadId]
    return r ? r.some((run) => run.status === 'running') : false
  })

  const optimistic = useStore((s) =>
    threadId ? (s.optimistic[threadId] ?? EMPTY_ARRAY) : EMPTY_ARRAY
  )
  const confirmed = useStore((s) => (threadId ? (s.events[threadId] ?? EMPTY_ARRAY) : EMPTY_ARRAY))
  const runs = useStore((s) => (threadId ? (s.runs[threadId] ?? EMPTY_RUNS) : EMPTY_RUNS))

  // Merge with useMemo — stable ref when inputs are the same arrays
  const events = useMemo(
    () => (optimistic.length ? [...confirmed, ...optimistic] : confirmed),
    [optimistic, confirmed]
  )

  return { thread, events, runs, isLoading, isWaiting }
}

export function useThreadEvents(threadId: string | null) {
  const { client } = useWorkerContext()

  const hasOlderEvents = useStore((s) =>
    threadId ? (s.eventPagination[threadId]?.hasMore ?? true) : false
  )

  const loadOlderEvents = useCallback(
    (limit?: number) => {
      if (threadId) client.loadOlderEvents(threadId, limit)
    },
    [threadId, client]
  )

  return { hasOlderEvents, loadOlderEvents }
}
