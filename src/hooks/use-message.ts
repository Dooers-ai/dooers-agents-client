import { useCallback } from 'react'
import { useWorkerContext } from '../provider'
import type { ContentPart } from '../types'

export function useMessage() {
  const { client } = useWorkerContext()

  const send = useCallback(
    (params: { text?: string; threadId?: string; content?: ContentPart[] }) => {
      return client.sendMessage(params)
    },
    [client]
  )

  return { send }
}
