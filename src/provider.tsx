import { createContext, type ReactNode, useContext, useEffect, useMemo, useRef } from 'react'
import { useStore as useZustandStore } from 'zustand'
import { useShallow } from 'zustand/shallow'
import { type OnErrorCallback, WorkerClient } from './client'
import { createWorkerStore, type WorkerState, type WorkerStore } from './store'

interface WorkerContextValue {
  store: WorkerStore
  client: WorkerClient
}

const WorkerContext = createContext<WorkerContextValue | null>(null)

export interface WorkerProviderProps {
  url?: string
  workerId?: string
  organizationId?: string
  workspaceId?: string
  userId?: string
  userName?: string
  userEmail?: string
  identityIds?: string[]
  systemRole?: string
  organizationRole?: string
  workspaceRole?: string
  authToken?: string
  uploadUrl?: string
  onError?: OnErrorCallback
  children: ReactNode
}

export function WorkerProvider({
  url,
  workerId,
  organizationId,
  workspaceId,
  userId,
  userName,
  userEmail,
  identityIds,
  systemRole,
  organizationRole,
  workspaceRole,
  authToken,
  uploadUrl,
  onError,
  children,
}: WorkerProviderProps) {
  const storeRef = useRef<WorkerStore | undefined>(undefined)
  const clientRef = useRef<WorkerClient | undefined>(undefined)

  if (!storeRef.current) {
    storeRef.current = createWorkerStore()
    clientRef.current = new WorkerClient(storeRef.current.getState().actions)
  }

  // Update onError callback
  useEffect(() => {
    clientRef.current?.setOnError(onError ?? null)
  }, [onError])

  // Update upload URL
  useEffect(() => {
    clientRef.current?.setUploadUrl(uploadUrl)
  }, [uploadUrl])

  // Stable key for identityIds to avoid reference-equality churn
  const identityIdsKey = identityIds?.join(',') ?? ''

  // Connect/disconnect lifecycle — skips connection when url or workerId are missing
  useEffect(() => {
    if (!url || !workerId) return
    clientRef.current?.connect(url, workerId, {
      organizationId,
      workspaceId,
      userId,
      userName,
      userEmail,
      identityIds: identityIdsKey ? identityIdsKey.split(',') : undefined,
      systemRole,
      organizationRole,
      workspaceRole,
      authToken,
    })
    return () => clientRef.current?.disconnect()
  }, [
    url,
    workerId,
    organizationId,
    workspaceId,
    userId,
    userName,
    userEmail,
    identityIdsKey,
    systemRole,
    organizationRole,
    workspaceRole,
    authToken,
  ])

  // Stable context value — refs never change after initial creation
  const contextValue = useMemo<WorkerContextValue>(
    () => ({ store: storeRef.current!, client: clientRef.current! }),
    []
  )

  return <WorkerContext.Provider value={contextValue}>{children}</WorkerContext.Provider>
}

// Internal hook for other hooks to access context
export function useWorkerContext(): WorkerContextValue {
  const ctx = useContext(WorkerContext)
  if (!ctx) {
    throw new Error('useWorkerContext must be used within a <WorkerProvider>')
  }
  return ctx
}

// Selector hook with Object.is equality (for primitives)
export function useStore<T>(selector: (state: WorkerState) => T): T {
  const { store } = useWorkerContext()
  return useZustandStore(store, selector)
}

// Selector hook with shallow equality (for objects/arrays)
export function useShallowStore<T>(selector: (state: WorkerState) => T): T {
  const { store } = useWorkerContext()
  return useZustandStore(store, useShallow(selector))
}
