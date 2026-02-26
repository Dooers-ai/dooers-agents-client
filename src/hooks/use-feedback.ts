import { useCallback } from 'react'
import { useStore, useWorkerContext } from '../provider'
import type { FeedbackTarget } from '../types'

export function useFeedback(targetId: string, targetType: FeedbackTarget = 'event') {
  const { client } = useWorkerContext()

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

  return { feedback, like, dislike }
}
