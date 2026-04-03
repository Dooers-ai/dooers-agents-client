import { createContext, type ReactNode, useContext, useEffect, useMemo, useRef } from 'react'
import { useStore as useZustandStore } from 'zustand'
import { useShallow } from 'zustand/shallow'
import { AgentClient, type OnErrorCallback } from './client'
import { type AgentState, type AgentStore, createAgentStore } from './store'

interface AgentContextValue {
  store: AgentStore
  client: AgentClient
}

const AgentContext = createContext<AgentContextValue | null>(null)

export interface AgentProviderProps {
  url?: string
  agentId?: string
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

export function AgentProvider({
  url,
  agentId,
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
}: AgentProviderProps) {
  const storeRef = useRef<AgentStore | undefined>(undefined)
  const clientRef = useRef<AgentClient | undefined>(undefined)

  if (!storeRef.current) {
    storeRef.current = createAgentStore()
    clientRef.current = new AgentClient(storeRef.current.getState().actions)
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

  // Connect/disconnect lifecycle — skips connection when url or agentId are missing
  useEffect(() => {
    if (!url || !agentId) return
    clientRef.current?.connect(url, agentId, {
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
    agentId,
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
  const contextValue = useMemo<AgentContextValue>(
    () => ({ store: storeRef.current!, client: clientRef.current! }),
    []
  )

  return <AgentContext.Provider value={contextValue}>{children}</AgentContext.Provider>
}

// Internal hook for other hooks to access context
export function useAgentContext(): AgentContextValue {
  const ctx = useContext(AgentContext)
  if (!ctx) {
    throw new Error('useAgentContext must be used within a <AgentProvider>')
  }
  return ctx
}

// Selector hook with Object.is equality (for primitives)
export function useStore<T>(selector: (state: AgentState) => T): T {
  const { store } = useAgentContext()
  return useZustandStore(store, selector)
}

// Selector hook with shallow equality (for objects/arrays)
export function useShallowStore<T>(selector: (state: AgentState) => T): T {
  const { store } = useAgentContext()
  return useZustandStore(store, useShallow(selector))
}
