import { useCallback } from 'react'
import { useAgentContext, useShallowStore } from '../provider'

export function useAnalytics() {
  const { client } = useAgentContext()

  const events = useShallowStore((s) => s.analytics.events)
  const counters = useShallowStore((s) => s.analytics.counters)

  const subscribe = useCallback(() => client.subscribeAnalytics(), [client])
  const unsubscribe = useCallback(() => client.unsubscribeAnalytics(), [client])

  return { events, counters, subscribe, unsubscribe }
}
