import { useCallback } from 'react'
import { useAgentContext } from '../provider'
import type { ChatContext, ContentPart } from '../types'

export function useMessage() {
  const { client } = useAgentContext()

  const send = useCallback(
    (params: {
      text?: string
      threadId?: string
      content?: ContentPart[]
      metadata?: Record<string, unknown>
      chatContext?: ChatContext
    }) => {
      return client.sendMessage(params)
    },
    [client]
  )

  return { send }
}
