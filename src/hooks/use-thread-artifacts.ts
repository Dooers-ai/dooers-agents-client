import { useCallback, useEffect, useRef, useState } from 'react'
import { useAgentContext } from '../provider'
import type { ArtifactDirection, ThreadArtifact } from '../types'

export interface UseThreadArtifactsOptions {
  direction?: ArtifactDirection | 'all'
  enabled?: boolean
  limit?: number
}

export function useThreadArtifacts(
  threadId: string | null,
  options?: UseThreadArtifactsOptions
) {
  const { client } = useAgentContext()
  const direction = options?.direction ?? 'all'
  const enabled = options?.enabled !== false
  const limit = options?.limit

  const [artifacts, setArtifacts] = useState<ThreadArtifact[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const cursorRef = useRef<string | null>(null)

  const load = useCallback(
    async (append: boolean) => {
      if (!threadId) return
      setIsLoading(true)
      setError(null)
      try {
        const result = await client.requestThreadArtifactsList(threadId, {
          cursor: append ? cursorRef.current : null,
          limit,
          direction,
        })
        cursorRef.current = result.cursor
        setCursor(result.cursor)
        setHasMore(result.hasMore)
        setArtifacts((prev) => (append ? [...prev, ...result.artifacts] : result.artifacts))
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load artifacts')
      } finally {
        setIsLoading(false)
      }
    },
    [threadId, client, limit, direction]
  )

  useEffect(() => {
    if (!threadId || !enabled) {
      setArtifacts([])
      setCursor(null)
      cursorRef.current = null
      setHasMore(false)
      setError(null)
      return
    }
    void load(false)
  }, [threadId, enabled, direction, load])

  const loadMore = useCallback(() => {
    if (!hasMore || isLoading) return
    void load(true)
  }, [hasMore, isLoading, load])

  const refresh = useCallback(() => {
    void load(false)
  }, [load])

  return { artifacts, cursor, hasMore, isLoading, error, loadMore, refresh }
}
