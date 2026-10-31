import { useCallback, useState } from 'react'
import { useAgentContext, useStore } from '../provider'

/**
 * Stop button support for a thread: whether a run is in progress and a ``cancel()`` that sends
 * ``run.cancel`` (agents-server ≥ 0.26.0). The answer streamed so far stays in the thread.
 */
export function useRunControl(threadId: string | null) {
  const { client } = useAgentContext()
  const [isCanceling, setIsCanceling] = useState(false)
  const activeRunId = useStore((s) => {
    if (!threadId) return null
    const runs = s.runs[threadId]
    const running = runs?.filter((run) => run.status === 'running') ?? []
    return running.length ? (running[running.length - 1]?.id ?? null) : null
  })
  const serverVersion = useStore((s) => s.connection.serverVersion)
  const canCancel =
    !!threadId && !!activeRunId && client.supportsFrontierFeatures() && !!serverVersion

  const cancel = useCallback(async () => {
    if (!threadId || !activeRunId) return false
    setIsCanceling(true)
    try {
      await client.cancelRun(threadId, activeRunId)
      return true
    } catch {
      return false
    } finally {
      setIsCanceling(false)
    }
  }, [client, threadId, activeRunId])

  return { isRunning: !!activeRunId, activeRunId, canCancel, isCanceling, cancel }
}
