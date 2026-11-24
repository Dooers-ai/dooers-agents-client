import type { z } from 'zod'
import type {
  DooersThreadsConnectAck,
  DooersThreadsEvent,
} from '../protocol/dooers-threads/contracts.js'
import type { publicSchemas } from '../protocol/dooers-threads/vendor/public.js'

export type DooersThreadsTransport = 'websocket' | 'http'
export interface DooersThreadsScope {
  principalId: string
  organizationId: string
  workspaceId: string | null
  /**
   * Who the credential names. Omitted means a human (the only kind before the public chat).
   * `external` is a public chat visitor: `principalId` is the namespaced visitor id the exchange
   * returns (`public_chat:<link>:<external_id>`) and the token must carry that same `sub`.
   */
  actorType?: 'human' | 'external'
}
export type DooersThreadsCredential =
  | string
  | ((context: {
      scope: Readonly<DooersThreadsScope>
      signal: AbortSignal
    }) => string | Promise<string>)
export interface DooersThreadsSocket {
  readonly readyState: number
  onopen: ((event: Event) => void) | null
  onclose: ((event: CloseEvent) => void) | null
  onerror: ((event: Event) => void) | null
  onmessage: ((event: MessageEvent) => void) | null
  send(data: string): void
  close(code?: number, reason?: string): void
}
export interface DooersThreadsClientConfig {
  mode: 'dooers_threads'
  /** Opt-in client support only; server/thread capability and current ACL are still required. */
  durableForms?: boolean
  /** Local candidate only, disabled by default; does not grant approval authority. */
  toolApprovals?: boolean
  /** Explicit client support; runtime/thread capability and per-recipient schemas remain required. */
  perAgentOptions?: boolean
  /** HTTP origin only. WebSocket is always /ws, independently of apiPrefix. */
  endpoint: string
  apiPrefix?: string
  scope: DooersThreadsScope
  authToken: DooersThreadsCredential
  /**
   * Credential with `threads:supervise`, asked for only when a supervision grant is opened or renewed.
   * The ordinary credential never carries that scope. Falls back to `authToken` when omitted.
   */
  supervisionAuthToken?: DooersThreadsCredential
  transport?: DooersThreadsTransport
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
  onError?: (error: DooersThreadsClientError) => void
  onAuthRequired?: (
    reason: string
  ) => DooersThreadsCredential | Promise<DooersThreadsCredential | undefined> | undefined
  /** Dependency injection for non-browser runtimes and tests. Never receives agent credentials. */
  fetch?: typeof globalThis.fetch
  socketFactory?: (url: string) => DooersThreadsSocket
}
export type DooersThreadsConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'refreshing'
  | 'reconnecting'
  | 'unauthenticated'
  | 'failed'
export interface DooersThreadsConnection {
  status: DooersThreadsConnectionStatus
  capabilities: readonly string[]
  handshake: DooersThreadsConnectAck | null
  reconnectAttempt: number
}
export type DooersThreadsMessageContent = z.infer<
  (typeof publicSchemas)['Public.MessageCreateRequest']
>['content']
export type DooersThreadsAgentOptions = z.infer<
  (typeof publicSchemas)['Public.MessageCreateRequest']
>['agent_options']
export interface DooersThreadsSendInput {
  threadId: string
  content: DooersThreadsMessageContent
  clientEventId?: string
  mentions?: string[]
  routing?: z.infer<(typeof publicSchemas)['Public.MessageCreateRequest']>['routing']
  agentOptions?: DooersThreadsAgentOptions
}
export type DooersThreadsPublicationState = 'pending' | 'persisted' | 'rejected' | 'unknown'
export interface DooersThreadsPublicationResult {
  threadId: string
  eventId: string
  cursor: string
  clientEventId: string
  duplicate: boolean
  event: DooersThreadsEvent
}
export interface DooersThreadsPublication {
  threadId: string
  clientEventId: string
  state: DooersThreadsPublicationState
  result?: DooersThreadsPublicationResult
  error?: DooersThreadsClientError
}
export interface DooersThreadsPublicationSnapshot {
  publications: readonly DooersThreadsPublication[]
  events: readonly DooersThreadsEvent[]
}
/**
 * Error code of a thread whose frames carry an event the vendored contract cannot read. The same
 * bytes come back on every replay, so the thread ends; it is never an access loss.
 */
export const DOOERS_THREADS_THREAD_UNREADABLE = 'THREAD_UNREADABLE'
/**
 * `reasonCode` of a `FORBIDDEN` for an action that supervision does not allow: exporting, downloading
 * or opening a file, and the PDF view link. Supervision only reads; the person joins as a participant
 * for these actions. The client refuses them itself, before any request (the Dooers Threads refuses the grant
 * with the same reason code since SEC-03). It is not an access loss: the thread stays open.
 */
export const DOOERS_THREADS_SUPERVISION_READ_ONLY = 'supervision_read_only'

export class DooersThreadsClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
    readonly requestId?: string,
    readonly threadId?: string,
    readonly clientEventId?: string,
    readonly publicationState?: DooersThreadsPublicationState,
    /** `details.reason_code` of the Dooers Threads error, when it sent one. */
    readonly reasonCode?: string,
    /** Seconds to wait before another try (`Retry-After` / `details.retry_after_seconds`), when sent. */
    readonly retryAfterSeconds?: number
  ) {
    super(message)
    this.name = 'DooersThreadsClientError'
  }
}
