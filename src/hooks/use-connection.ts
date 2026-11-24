import { useCallback } from 'react'
import { DooersThreadsAgentClient } from '../dooers-threads-agent-client'
import { useAgentContext, useStore } from '../provider'

export function useConnection() {
  const { client } = useAgentContext()

  const status = useStore((s) => s.connection.status)
  const error = useStore((s) => s.connection.error)
  const serverVersion = useStore((s) => s.connection.serverVersion)
  const sendError = useStore((s) => s.connection.sendError)
  const reconnectFailed = useStore((s) => s.connection.reconnectFailed)

  const reconnect = useCallback(() => client.retry(), [client])
  const dismissSendError = useCallback(() => {
    client.clearSendError()
  }, [client])

  /** ``dooers_threads`` when the selected agent is served through Dooers Threads (multi-participant threads). */
  const transport: 'legacy' | 'dooers_threads' =
    client instanceof DooersThreadsAgentClient ? 'dooers_threads' : 'legacy'

  return {
    transport,
    status,
    error,
    serverVersion,
    sendError,
    dismissSendError,
    reconnectFailed,
    reconnect,
  }
}
