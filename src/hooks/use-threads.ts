import { useCallback, useMemo } from 'react'
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

  return { deleteThread, loadMore }
}
