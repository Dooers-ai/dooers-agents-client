import { useCallback, useEffect } from 'react'
import { useAgentContext, useStore } from '../provider'

export type UseSchedulesOptions = {
  autoLoad?: boolean
  /** Only schedules that post into this thread. */
  threadId?: string | null
}

/** Reminders and recurring tasks of the connected user (agents-server ≥ 0.26.0). */
export function useSchedules(options?: UseSchedulesOptions) {
  const { client } = useAgentContext()
  const autoLoad = options?.autoLoad !== false
  const threadId = options?.threadId ?? null
  const schedules = useStore((s) => s.schedules)
  const status = useStore((s) => s.connection.status)
  const serverVersion = useStore((s) => s.connection.serverVersion)
  const supported = status === 'connected' && !!serverVersion && client.supportsFrontierFeatures()

  const refresh = useCallback(() => client.requestSchedules({ threadId }), [client, threadId])

  useEffect(() => {
    if (!autoLoad || !supported) return
    client.requestSchedules({ threadId })
  }, [autoLoad, supported, client, threadId])

  const pause = useCallback((id: string) => client.setScheduleStatus(id, 'paused'), [client])
  const resume = useCallback((id: string) => client.setScheduleStatus(id, 'active'), [client])
  const cancel = useCallback((id: string) => client.deleteSchedule(id), [client])

  const items = threadId
    ? schedules.items.filter((item) => item.threadId === threadId)
    : schedules.items
  return {
    supported,
    schedules: items,
    available: schedules.available,
    loaded: schedules.loaded,
    isLoading: schedules.isLoading,
    refresh,
    pause,
    resume,
    cancel,
  }
}
