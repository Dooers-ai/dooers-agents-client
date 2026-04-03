import { useCallback } from 'react'
import { useAgentContext } from '../provider'
import type { ContentPart } from '../types'

export function useMessage() {
  const { client } = useAgentContext()

  const send = useCallback(
    (params: { text?: string; threadId?: string; content?: ContentPart[] }) => {
      return client.sendMessage(params)
    },
    [client]
  )

  return { send }
}
