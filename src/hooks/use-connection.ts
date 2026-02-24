import { useCallback } from 'react'
import { useStore, useWorkerContext } from '../provider'

export function useConnection() {
  const { client } = useWorkerContext()

  const status = useStore((s) => s.connection.status)
  const error = useStore((s) => s.connection.error)
  const reconnectFailed = useStore((s) => s.connection.reconnectFailed)

  const reconnect = useCallback(() => client.retry(), [client])

  return { status, error, reconnectFailed, reconnect }
}
