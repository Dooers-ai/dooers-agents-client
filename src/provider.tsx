import { createContext, type ReactNode, useContext, useEffect, useMemo, useRef } from 'react'
import { useStore as useZustandStore } from 'zustand'
import { useShallow } from 'zustand/shallow'
import { AgentClient, type AgentConnectionConfig, type OnErrorCallback } from './client'
import { type AgentMaestroOptions, MaestroAgentClient } from './maestro-agent-client'
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
  /**
   * Explicit HTTP base (agent `hostUrl`: scheme+host+seg, no message path) used
   * to resolve relative content URLs like `/audio/<id>`. When omitted, the base
   * is derived from `url` — which cannot preserve the Load Balancer path prefix.
   */
  httpBaseUrl?: string
  /**
   * When set, the selected agent is served by Maestro: the same hooks talk to the
   * Maestro API (HTTP/WS) instead of the agent runtime WebSocket, and ``url`` is ignored.
   */
  maestro?: AgentMaestroOptions
  onError?: OnErrorCallback
  children: ReactNode
}

/** Session identity of the Maestro transport; a change creates a fresh client and store. */
function maestroKey(maestro: AgentMaestroOptions | undefined): string {
  if (!maestro) return ''
  return JSON.stringify([
    maestro.endpoint,
    maestro.apiPrefix ?? null,
    maestro.allowInsecureLocalhost === true,
    maestro.forms === true,
    maestro.scope.principalId,
    maestro.scope.organizationId,
    maestro.scope.workspaceId,
  ])
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
  httpBaseUrl,
  maestro,
  onError,
  children,
}: AgentProviderProps) {
  const maestroRef = useRef(maestro)
  maestroRef.current = maestro
  const transportKey = maestroKey(maestro)

  // Legacy and Maestro transports never share a store: switching agents between
  // authorities starts from an empty, isolated state.
  const { store, client } = useMemo(() => {
    const store = createAgentStore()
    const actions = store.getState().actions
    const options = maestroRef.current
    const client =
      transportKey && options
        ? new MaestroAgentClient(actions, {
            ...options,
            authToken:
              typeof options.authToken === 'function'
                ? (context) => {
                    const current = maestroRef.current?.authToken ?? options.authToken
                    return typeof current === 'function' ? current(context) : current
                  }
                : options.authToken,
          })
        : new AgentClient(actions)
    return { store, client }
  }, [transportKey])

  // Update onError callback
  useEffect(() => {
    client.setOnError(onError ?? null)
  }, [client, onError])

  // Update upload URL
  useEffect(() => {
    client.setUploadUrl(uploadUrl)
  }, [client, uploadUrl])

  // Set the explicit HTTP base (hostUrl) before connect derives one from the WS URL.
  useEffect(() => {
    client.setHttpBaseUrl(httpBaseUrl)
  }, [client, httpBaseUrl])

  // HTTP uploads require agent_id before WS connect completes
  useEffect(() => {
    client.setUploadAgentId(agentId)
  }, [client, agentId])

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
  // Maestro connects to its configured endpoint; the agent runtime URL is not used.
  const target = transportKey ? (maestroRef.current?.endpoint ?? '') : (url ?? '')
  useEffect(() => {
    if (!target || !agentId) {
      client.disconnect()
      return
    }
    client.connect(target, agentId, connectionConfigRef.current)
    return () => client.disconnect()
  }, [client, target, agentId])

  // Hot-update metadata (handshake token refresh, roles, user fields) without reconnecting.
  useEffect(() => {
    if (!target || !agentId) return
    client.updateConnectionConfig(connectionConfig)
  }, [client, target, agentId, connectionConfig])

  // Stable per transport: a new value only when the client/store pair is recreated.
  const contextValue = useMemo<AgentContextValue>(() => ({ store, client }), [store, client])

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
