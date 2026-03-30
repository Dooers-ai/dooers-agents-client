import { useCallback, useEffect, useState } from 'react'
import { useAgentContext, useStore } from '../provider'
import type { FormElement, FormEventData } from '../types'

export function useForm(formEventId: string, formData: FormEventData, threadId?: string) {
  const { client, store } = useAgentContext()
  const formState = useStore((s) => s.formStates[formEventId])
  const [errors, setErrors] = useState<Record<string, string>>({})

  // Initialize form state with defaults
  useEffect(() => {
    const defaults: Record<string, unknown> = {}
    for (const el of formData.elements) {
      if ('default' in el && el.default != null) {
        defaults[el.name] = el.default
      }
    }
    store.getState().actions.initFormState(formEventId, defaults)
  }, [formEventId, formData.elements, store])

  const values = formState?.values ?? {}
  const isSubmitting = formState?.submitting ?? false
  const isSubmitted = formState?.submitted ?? false
  const isCancelled = formState?.cancelled ?? false
  const isDisabled = isSubmitting || isSubmitted || isCancelled

  const setValue = useCallback(
    (fieldName: string, value: unknown) => {
      store.getState().actions.setFormValue(formEventId, fieldName, value)
      setErrors((prev) => {
        if (!prev[fieldName]) return prev
        const next = { ...prev }
        delete next[fieldName]
        return next
      })
    },
    [formEventId, store]
  )

  const validate = useCallback((): boolean => {
    const currentValues = store.getState().formStates[formEventId]?.values ?? {}
    const newErrors: Record<string, string> = {}

    for (const el of formData.elements) {
      if (!el.required) continue
      const val = currentValues[el.name]
      if (isEmptyValue(el, val)) {
        newErrors[el.name] = 'Required'
      }
    }

    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }, [formEventId, formData.elements, store])

  const submit = useCallback(async () => {
    const state = store.getState()
    const fs = state.formStates[formEventId]
    if (!fs || fs.submitting || fs.submitted || fs.cancelled) return
    if (!validate()) return

    state.actions.setFormSubmitting(formEventId, true)
    const currentValues = state.formStates[formEventId]?.values ?? {}

    if (!threadId) {
      state.actions.setFormSubmitted(formEventId)
      return
    }

    try {
      await client.sendFormResponse({
        threadId,
        formEventId,
        cancelled: false,
        values: currentValues,
      })
      store.getState().actions.setFormSubmitted(formEventId)
    } catch {
      store.getState().actions.setFormSubmitting(formEventId, false)
    }
  }, [formEventId, threadId, validate, client, store])

  const cancel = useCallback(async () => {
    const state = store.getState()
    const fs = state.formStates[formEventId]
    if (!fs || fs.submitting || fs.submitted || fs.cancelled) return

    state.actions.setFormSubmitting(formEventId, true)

    if (!threadId) {
      state.actions.setFormCancelled(formEventId)
      return
    }

    try {
      await client.sendFormResponse({
        threadId,
        formEventId,
        cancelled: true,
        values: {},
      })
      store.getState().actions.setFormCancelled(formEventId)
    } catch {
      store.getState().actions.setFormSubmitting(formEventId, false)
    }
  }, [formEventId, threadId, client, store])

  return {
    values,
    errors,
    setValue,
    validate,
    submit,
    cancel,
    isSubmitting,
    isSubmitted,
    isCancelled,
    isDisabled,
  }
}

function isEmptyValue(element: FormElement, val: unknown): boolean {
  if (val == null) return true
  if (typeof val === 'string' && val.trim() === '') return true
  if (element.type === 'checkbox_input' && Array.isArray(val) && val.length === 0) return true
  return false
}
