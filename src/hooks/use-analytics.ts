import { useCallback } from 'react'
import { useShallowStore, useWorkerContext } from '../provider'

export function useAnalytics() {
  const { client } = useWorkerContext()

  const events = useShallowStore((s) => s.analytics.events)
  const counters = useShallowStore((s) => s.analytics.counters)

  const subscribe = useCallback(() => client.subscribeAnalytics(), [client])
  const unsubscribe = useCallback(() => client.unsubscribeAnalytics(), [client])

  return { events, counters, subscribe, unsubscribe }
}
