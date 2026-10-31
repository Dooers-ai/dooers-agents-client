import { useCallback, useEffect } from 'react'
import { useAgentContext, useStore } from '../provider'
import type { MemoryKind, MemoryRecord, MemoryScope } from '../types'
import { canEditMemory } from '../types'

export type UseMemoriesOptions = {
  /** Load the list and preferences when the connection is ready (default true). */
  autoLoad?: boolean
}

/**
 * Long-term memory of the connected user for this agent: list/search, create, edit, pin, delete,
 * plus custom instructions ("about me", "how to answer"). Requires agents-server ≥ 0.26.0.
 */
export function useMemories(options?: UseMemoriesOptions) {
  const { client } = useAgentContext()
  const autoLoad = options?.autoLoad !== false
  const memory = useStore((s) => s.memory)
  const status = useStore((s) => s.connection.status)
  const serverVersion = useStore((s) => s.connection.serverVersion)
  const supported = status === 'connected' && !!serverVersion && client.supportsFrontierFeatures()

  useEffect(() => {
    if (!autoLoad || !supported) return
    client.requestMemories()
    client.requestMemoryPrefs()
  }, [autoLoad, supported, client])

  const search = useCallback(
    (query: string, scope?: MemoryScope | null) => client.requestMemories({ query, scope }),
    [client]
  )
  const loadMore = useCallback(
    () => client.requestMemories({ query: memory.query, append: true }),
    [client, memory.query]
  )
  const create = useCallback(
    (content: string, opts?: { scope?: MemoryScope; kind?: MemoryKind; pinned?: boolean }) =>
      client.createMemory(content, opts),
    [client]
  )
  const update = useCallback(
    (memoryId: string, patch: { content?: string; pinned?: boolean; kind?: MemoryKind }) =>
      client.updateMemory(memoryId, patch),
    [client]
  )
  const remove = useCallback((memoryId: string) => client.deleteMemory(memoryId), [client])
  const share = useCallback((memoryId: string) => client.shareMemory(memoryId), [client])
  const canEdit = useCallback(
    (record: MemoryRecord) =>
      canEditMemory(record, {
        userId: client.currentUserId(),
        canManageWorkspace: memory.canManageWorkspace,
      }),
    [client, memory.canManageWorkspace]
  )
  const updatePrefs = useCallback(
    (patch: { enabled?: boolean; customInstructions?: string; aboutMe?: string }) =>
      client.updateMemoryPrefs(patch),
    [client]
  )

  return {
    supported,
    memories: memory.items,
    available: memory.available,
    canManageWorkspace: memory.canManageWorkspace,
    isLoading: memory.isLoading,
    loaded: memory.loaded,
    hasMore: memory.hasMore,
    query: memory.query,
    prefs: memory.prefs,
    search,
    loadMore,
    create,
    update,
    remove,
    /** Share a personal memory with the workspace members. */
    share,
    /** Whether the signed-in user may edit/delete this memory. */
    canEdit,
    updatePrefs,
  }
}
