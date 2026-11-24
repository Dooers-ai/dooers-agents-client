import { useCallback } from 'react'
import { useAgentContext, useStore } from '../provider'
import type { FeedbackTarget } from '../types'

export function useRememberFeedback() {
  return useStore((s) => s.actions.rememberFeedback)
}

export function useFeedback(targetId: string, targetType: FeedbackTarget = 'event') {
  const { client } = useAgentContext()

  const feedback = useStore((s) => s.feedback[targetId] ?? null)

  const like = useCallback(
    (reason?: string, classification?: string) =>
      client.sendFeedback(targetType, targetId, 'like', reason, classification),
    [client, targetType, targetId]
  )

  const dislike = useCallback(
    (reason?: string, classification?: string) =>
      client.sendFeedback(targetType, targetId, 'dislike', reason, classification),
    [client, targetType, targetId]
  )

  const clear = useCallback(
    () => client.sendFeedback(targetType, targetId, 'clear'),
    [client, targetType, targetId]
  )

  return { feedback, like, dislike, clear }
}
