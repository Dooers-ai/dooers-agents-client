import { useCallback, useMemo } from 'react'
import { supportsThreadSearch } from '../helpers/server-version'
import { useAgentContext, useStore } from '../provider'

/** Lightweight read-only hook — thread list, count, and loading state. */
export function useThreadsList() {
  const threadOrder = useStore((s) => s.threadOrder)
  const threadMap = useStore((s) => s.threads)

  const threads = useMemo(
    () =>
      threadOrder.flatMap((id) => {
        const t = threadMap[id]
        return t ? [t] : []
      }),
    [threadOrder, threadMap]
  )

  const isLoading = useStore((s) => s.connection.status !== 'connected')
  const hasMore = useStore((s) => s.threadListHasMore)
  const totalCount = useStore((s) => s.threadListTotalCount)

  return { threads, isLoading, hasMore, totalCount }
}

/** Actions-only hook (delete, load more). */
export function useThreadsActions() {
  const { client } = useAgentContext()

  const deleteThread = useCallback((threadId: string) => client.deleteThread(threadId), [client])
  const loadMore = useCallback((limit?: number) => client.loadMoreThreads(limit), [client])
  const requestThreadList = useCallback(
    (cursor?: string | null, limit?: number, queue?: string | null) =>
      client.requestThreadList(cursor, limit, queue),
    [client]
  )
  const updateThread = useCallback(
    (threadId: string, patch: { queue?: string | null }) => client.updateThread(threadId, patch),
    [client]
  )

  return { deleteThread, loadMore, requestThreadList, updateThread }
}

/**
 * Title search over every thread the connection may see (agents-server ≥ 0.25.0).
 * ``supported`` is false on older servers: ``search`` then sends nothing and returns false,
 * and the caller should filter the loaded list instead.
 */
const NO_THREADS: never[] = []

export function useThreadSearch() {
  const { client } = useAgentContext()
  const state = useStore((s) => s.threadSearch)
  const supported = useStore((s) => supportsThreadSearch(s.connection.serverVersion))

  const search = useCallback(
    (query: string, opts?: { queue?: string | null; limit?: number }) =>
      client.searchThreads(query, opts),
    [client]
  )
  const loadMore = useCallback(() => client.loadMoreThreadSearch(), [client])
  const clear = useCallback(() => client.clearThreadSearch(), [client])

  return {
    query: state?.query ?? null,
    threads: state?.threads ?? NO_THREADS,
    hasMore: state?.hasMore ?? false,
    totalCount: state?.totalCount ?? 0,
    isLoading: state?.isLoading ?? false,
    supported,
    search,
    loadMore,
    clear,
  }
}
