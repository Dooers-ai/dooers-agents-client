import type { z } from 'zod'
import type { MaestroConnectAck, MaestroEvent } from '../protocol/maestro/contracts.js'
import type { publicSchemas } from '../protocol/maestro/vendor/public.js'

export type MaestroTransport = 'websocket' | 'http'
export interface MaestroScope {
  principalId: string
  organizationId: string
  workspaceId: string | null
}
export type MaestroCredential =
  | string
  | ((context: { scope: Readonly<MaestroScope>; signal: AbortSignal }) => string | Promise<string>)
export interface MaestroSocket {
  readonly readyState: number
  onopen: ((event: Event) => void) | null
  onclose: ((event: CloseEvent) => void) | null
  onerror: ((event: Event) => void) | null
  onmessage: ((event: MessageEvent) => void) | null
  send(data: string): void
  close(code?: number, reason?: string): void
}
export interface MaestroClientConfig {
  mode: 'maestro'
  /** Opt-in client support only; server/thread capability and current ACL are still required. */
  durableForms?: boolean
  /** Local candidate only, disabled by default; does not grant approval authority. */
  toolApprovals?: boolean
  /** Explicit client support; runtime/thread capability and per-recipient schemas remain required. */
  perAgentOptions?: boolean
  /** HTTP origin only. WebSocket is always /ws, independently of apiPrefix. */
  endpoint: string
  apiPrefix?: string
  scope: MaestroScope
  authToken: MaestroCredential
  /**
   * Credential with `threads:supervise`, asked for only when a supervision grant is opened or renewed.
   * The ordinary credential never carries that scope. Falls back to `authToken` when omitted.
   */
  supervisionAuthToken?: MaestroCredential
  transport?: MaestroTransport
  allowInsecureLocalhost?: boolean
  requestTimeoutMs?: number
  heartbeatMs?: number
  maxReconnectAttempts?: number
  reconnectBaseMs?: number
  reconnectMaxMs?: number
  /** Local memory bound; server MIME/quota/size decisions remain authoritative. */
  maxArtifactBytes?: number
  maxResponseBytes?: number
  maxPublications?: number
  maxBufferedEvents?: number
  maxEventsPerThread?: number
  maxThreads?: number
  maxReplayAttempts?: number
  replayRetryMs?: number
  onError?: (error: MaestroClientError) => void
  onAuthRequired?: (
    reason: string
  ) => MaestroCredential | Promise<MaestroCredential | undefined> | undefined
  /** Dependency injection for non-browser runtimes and tests. Never receives agent credentials. */
  fetch?: typeof globalThis.fetch
  socketFactory?: (url: string) => MaestroSocket
}
export type MaestroConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'refreshing'
  | 'reconnecting'
  | 'unauthenticated'
  | 'failed'
export interface MaestroConnection {
  status: MaestroConnectionStatus
  capabilities: readonly string[]
  handshake: MaestroConnectAck | null
  reconnectAttempt: number
}
export type MaestroMessageContent = z.infer<
  (typeof publicSchemas)['Public.MessageCreateRequest']
>['content']
export type MaestroAgentOptions = z.infer<
  (typeof publicSchemas)['Public.MessageCreateRequest']
>['agent_options']
export interface MaestroSendInput {
  threadId: string
  content: MaestroMessageContent
  clientEventId?: string
  mentions?: string[]
  routing?: z.infer<(typeof publicSchemas)['Public.MessageCreateRequest']>['routing']
  agentOptions?: MaestroAgentOptions
}
export type MaestroPublicationState = 'pending' | 'persisted' | 'rejected' | 'unknown'
export interface MaestroPublicationResult {
  threadId: string
  eventId: string
  cursor: string
  clientEventId: string
  duplicate: boolean
  event: MaestroEvent
}
export interface MaestroPublication {
  threadId: string
  clientEventId: string
  state: MaestroPublicationState
  result?: MaestroPublicationResult
  error?: MaestroClientError
}
export interface MaestroPublicationSnapshot {
  publications: readonly MaestroPublication[]
  events: readonly MaestroEvent[]
}
export class MaestroClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
    readonly requestId?: string,
    readonly threadId?: string,
    readonly clientEventId?: string,
    readonly publicationState?: MaestroPublicationState,
    /** `details.reason_code` of the Maestro error, when it sent one. */
    readonly reasonCode?: string
  ) {
    super(message)
    this.name = 'MaestroClientError'
  }
}
