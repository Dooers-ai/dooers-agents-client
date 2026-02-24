import { useCallback } from 'react'
import { useShallowStore, useStore, useWorkerContext } from '../provider'

export function useSettings() {
  const { client } = useWorkerContext()

  const fields = useShallowStore((s) => s.settings.fields)
  const updatedAt = useStore((s) => s.settings.updatedAt)
  const isLoading = useStore((s) => s.settings.isLoading)

  const subscribe = useCallback(() => client.subscribeSettings(), [client])
  const unsubscribe = useCallback(() => client.unsubscribeSettings(), [client])

  const patchField = useCallback(
    (fieldId: string, value: unknown) => client.patchSetting(fieldId, value),
    [client]
  )

  return { fields, updatedAt, isLoading, subscribe, unsubscribe, patchField }
}
