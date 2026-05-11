import { useCallback } from 'react'
import { useAgentContext, useStore } from '../provider'

export function useConnection() {
  const { client } = useAgentContext()

  const status = useStore((s) => s.connection.status)
  const error = useStore((s) => s.connection.error)
  const sendError = useStore((s) => s.connection.sendError)
  const reconnectFailed = useStore((s) => s.connection.reconnectFailed)

  const reconnect = useCallback(() => client.retry(), [client])
  const dismissSendError = useCallback(() => {
    client.clearSendError()
  }, [client])

  return { status, error, sendError, dismissSendError, reconnectFailed, reconnect }
}
