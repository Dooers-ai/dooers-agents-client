import { createContext, type ReactNode, useContext, useEffect, useMemo, useRef } from 'react'
import { useStore as useZustandStore } from 'zustand'
import { useShallow } from 'zustand/shallow'
import { AgentClient, type AgentConnectionConfig, type OnErrorCallback } from './client'
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
  userMobileNumber?: string
  userWhatsappNumber?: string
  identityIds?: string[]
  systemRole?: string
  organizationRole?: string
  workspaceRole?: string
  authToken?: string
  channel?: string
  channelMeta?: Record<string, unknown>
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
  userMobileNumber,
  userWhatsappNumber,
  identityIds,
  systemRole,
  organizationRole,
  workspaceRole,
  authToken,
  channel,
  channelMeta,
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

  // HTTP uploads require agent_id before WS connect completes
  useEffect(() => {
    clientRef.current?.setUploadAgentId(agentId)
  }, [agentId])

  // Stable key for identityIds to avoid reference-equality churn
  const identityIdsKey = identityIds?.join(',') ?? ''
  const channelMetaKey = channelMeta ? JSON.stringify(channelMeta) : ''

  const connectionConfig = useMemo((): AgentConnectionConfig => {
    let parsedChannelMeta: Record<string, unknown> | undefined
    if (channelMetaKey) {
      try {
        parsedChannelMeta = JSON.parse(channelMetaKey) as Record<string, unknown>
      } catch {
        parsedChannelMeta = channelMeta
      }
    }
    return {
      organizationId,
      workspaceId,
      userId,
      userName,
      userEmail,
      userMobileNumber,
      userWhatsappNumber,
      identityIds: identityIdsKey ? identityIdsKey.split(',') : undefined,
      systemRole,
      organizationRole,
      workspaceRole,
      authToken,
      channel,
      channelMeta: parsedChannelMeta,
    }
  }, [
    organizationId,
    workspaceId,
    userId,
    userName,
    userEmail,
    userMobileNumber,
    userWhatsappNumber,
    identityIdsKey,
    systemRole,
    organizationRole,
    workspaceRole,
    authToken,
    channel,
    channelMetaKey,
    channelMeta,
  ])

  const connectionConfigRef = useRef(connectionConfig)
  connectionConfigRef.current = connectionConfig

  // Hard reconnect only when endpoint or agent identity changes.
  useEffect(() => {
    if (!url || !agentId) {
      clientRef.current?.disconnect()
      return
    }
    clientRef.current?.connect(url, agentId, connectionConfigRef.current)
    return () => clientRef.current?.disconnect()
  }, [url, agentId])

  // Hot-update metadata (handshake token refresh, roles, user fields) without reconnecting.
  useEffect(() => {
    if (!url || !agentId) return
    clientRef.current?.updateConnectionConfig(connectionConfig)
  }, [url, agentId, connectionConfig])

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
