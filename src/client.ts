import { apiMessagesUrlToWebSocketUrl } from './helpers/api-messages-url-to-ws'
import {
  AUTH_TOKEN_TIMEOUT_MS,
  LIVENESS_BUSY_TIMEOUT_MS,
  LIVENESS_TIMEOUT_MS,
  MAX_CONSECUTIVE_FAILURES,
  PING_INTERVAL_MS,
  reconnectDelayMs,
  rotationDue,
  STABLE_CONNECTION_MS,
} from './helpers/connection-policy'
import type { ServerToClient } from './protocol/frames'
import type { WireC2S_ContentPart, WireSettingsItem } from './protocol/models'
import type { AgentActions } from './store'
import type {
  ChatContext,
  DisplayContentPart,
  SendContentPart,
  SettingsItem,
  ThreadArtifact,
  ThreadEvent,
} from './types'
import {
  publicSchemaFromResultPayload,
  toAnalyticsEvent,
  toRun,
  toSettingsItem,
  toThread,
  toThreadArtifact,
  toThreadEvent,
  toWireContentPart,
} from './types'
import { PACKAGE_VERSION } from './version'

const SEND_MESSAGE_TIMEOUT = 30_000
const ARTIFACTS_LIST_TIMEOUT = 5_000

/** Multipart filename for ``Blob`` uploads so server blob keys match WebSocket ``filename``. */
function blobPartFilename(blob: Blob, override?: string): string {
  const o = (override ?? '').trim()
  if (o) return o
  const t = (blob.type || '').toLowerCase()
  if (t.includes('webm')) return 'recording.webm'
  if (t.includes('ogg')) return 'recording.ogg'
  if (t.includes('mpeg') || t.includes('mp3')) return 'recording.mp3'
  if (t.includes('mp4') || t.includes('m4a') || t.includes('aac')) return 'recording.m4a'
  if (t.startsWith('audio/')) return `recording.${t.split('/')[1]?.split('+')[0] || 'bin'}`
  return 'recording.bin'
}

/** Silence a socket's handlers, then close it, so its late events never reach the client. */
function detachAndClose(ws: WebSocket, code?: number) {
  ws.onopen = null
  ws.onmessage = null
  ws.onclose = null
  ws.onerror = null
  ws.close(code)
}

async function readHttpErrorMessage(response: Response): Promise<string> {
  const raw = (await response.text().catch(() => '')) || ''
  const trimmed = raw.trim()
  if (!trimmed) {
    return `Upload failed: ${response.status} ${response.statusText}`.trim()
  }
  try {
    const j = JSON.parse(trimmed) as { detail?: unknown }
    const d = j.detail
    if (typeof d === 'string') return d
    if (Array.isArray(d) && d.length > 0) {
      const first = d[0] as { msg?: string }
      if (first && typeof first.msg === 'string') return first.msg
    }
  } catch {
    /* use body */
  }
  return trimmed.length > 300 ? `${trimmed.slice(0, 300)}…` : trimmed
}

export interface AgentConnectionConfig {
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
  /** Called before every socket (and upload) so a reconnect never reuses a stale handshake token. */
  getAuthToken?: () => string | undefined | Promise<string | undefined>
  channel?: string
  channelMeta?: Record<string, unknown>
}

export type OnErrorCallback = (error: { code: string; message: string; frameType: string }) => void

export interface UploadResult {
  refId: string
  mimeType: string
  filename: string
  sizeBytes: number
  /** Present when the template persisted the file (HTTP(S) or null if not applicable). */
  publicUrl?: string | null
}

export interface PublicSettingsSchemaResult {
  version: string
  fields: SettingsItem[]
}

/**
 * Talks to the agent messages server without an agent session (no `connect` frame).
 * Use for public/bootstrap operations allowed before an {@link AgentClient} is connected.
 */
export class AgentServerClient {
  private readonly wsUrl: string

  constructor(apiMessagesUrl: string) {
    this.wsUrl = apiMessagesUrlToWebSocketUrl(apiMessagesUrl)
  }

  /**
   * Opens a short-lived WebSocket, requests `settings.public_schema`, and returns the public field
   * list. Closes the socket when done.
   */
  fetchPublicSettingsSchema(options?: { timeoutMs?: number }): Promise<PublicSettingsSchemaResult> {
    const timeoutMs = options?.timeoutMs ?? 15_000

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl)
      const frameId = crypto.randomUUID()
      let settled = false

      const finish = (fn: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        try {
          ws.close()
        } catch {
          /* ignore */
        }
        fn()
      }

      const timer = setTimeout(() => {
        finish(() => reject(new Error('AgentServerClient.fetchPublicSettingsSchema: timeout')))
      }, timeoutMs)

      ws.onopen = () => {
        ws.send(
          JSON.stringify({
            id: frameId,
            type: 'settings.public_schema',
            payload: {},
          })
        )
      }

      ws.onmessage = (ev: MessageEvent) => {
        let msg: {
          id?: string
          type?: string
          payload?: {
            ack_id?: string
            ok?: boolean
            error?: { code?: string; message?: string }
            schema?: { version?: string; fields?: WireSettingsItem[] }
            schema_?: { version?: string; fields?: WireSettingsItem[] }
          }
        }
        try {
          msg = JSON.parse(ev.data as string)
        } catch {
          return
        }

        if (msg.type === 'ack' && msg.payload?.ack_id === frameId) {
          if (msg.payload?.ok === false) {
            finish(() =>
              reject(
                new Error(
                  msg.payload?.error?.message ??
                    'AgentServerClient.fetchPublicSettingsSchema: request rejected'
                )
              )
            )
          }
          return
        }

        if (msg.type === 'settings.public_schema.result' && msg.id === frameId) {
          const parsed = publicSchemaFromResultPayload(msg.payload ?? {})
          const fields = parsed.fields.map((w) => toSettingsItem(w))
          finish(() =>
            resolve({
              version: parsed.version,
              fields,
            })
          )
        }
      }

      ws.onerror = () => {
        finish(() =>
          reject(new Error('AgentServerClient.fetchPublicSettingsSchema: WebSocket error'))
        )
      }

      ws.onclose = (ev) => {
        if (settled) return
        finish(() =>
          reject(
            new Error(
              `AgentServerClient.fetchPublicSettingsSchema: connection closed (${ev.code})${ev.reason ? ` ${ev.reason}` : ''}`
            )
          )
        )
      }
    })
  }
}

export class AgentClient {
  private ws: WebSocket | null = null
  private callbacks: AgentActions
  private onError: OnErrorCallback | null = null

  private url = ''
  private httpBaseUrl = ''
  /**
   * Explicit HTTP base for resolving relative content URLs (e.g. `/audio/<id>`).
   * When set (from the agent's canonical `hostUrl`), it takes precedence over
   * deriving the base from the WS URL — which cannot know the Load Balancer
   * path prefix (`/<agent-seg>`) and would otherwise drop it.
   */
  private httpBaseUrlOverride: string | undefined
  private agentId = ''
  /** Mirrors ``AgentProvider`` ``agentId`` so HTTP uploads work before WS ``connect`` completes. */
  private uploadAgentId = ''
  /** Current chat thread id for ``POST /uploads`` (aligns GCS path with ``hydrate_thread_events``). */
  private uploadThreadId = ''
  /** Optional run id for ``POST /uploads`` (metadata only). */
  private uploadRunId = ''
  private uploadUrl: string | undefined
  private config: AgentConnectionConfig = {
    organizationId: '',
    workspaceId: '',
    userId: '',
    channel: 'dooers-platform',
  }

  private connectFrameId = ''
  private isIntentionallyClosed = false
  private lastFrameAt = 0
  private resumeListenersAttached = false
  private consecutiveFailures = 0
  private connected = false
  private attemptInFlight = false
  private attemptGeneration = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  /** When the current primary socket was acked (or promoted). Drives the planned renewal. */
  private connectedAt = 0
  /** Runs reported as `running`; renewal waits for them until the hard deadline. */
  private activeRuns = new Set<string>()
  /** Renewal socket waiting for its connect ack. Never carries traffic before promotion. */
  private candidate: { ws: WebSocket; frameId: string } | null = null
  /** Restored on a renewed socket, where the status never changes for the app to resubscribe. */
  private analyticsSubscribed = false

  // Refcounted subscriptions
  private subscriptionRefs = new Map<string, number>()
  /** Elevated view reasons retained for reconnect re-subscribe (same process day). */
  private subscriptionAccessReasons = new Map<string, string>()

  // Track optimistic events for reconciliation
  private pendingOptimistic = new Map<string, { threadId: string; clientEventId: string }>()

  // Pending message promises — keyed by outbound frame id (same as client_event_id for sends).
  private pendingMessages = new Map<
    string,
    {
      resolve: (value: { threadId: string }) => void
      reject: (reason: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()

  private pendingArtifactsRequests = new Map<
    string,
    {
      threadId: string
      resolve: (value: {
        artifacts: ThreadArtifact[]
        cursor: string | null
        hasMore: boolean
      }) => void
      reject: (reason: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()

  private pendingPublicSchema = new Map<
    string,
    {
      resolve: (value: PublicSettingsSchemaResult) => void
      reject: (reason: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()

  // Track last event ID per thread for gap recovery on reconnect
  private lastEventIds = new Map<string, string>()

  // Pagination
  private lastThreadListCursor: string | null = null
  private threadListQueue: string | null = null
  private isLoadingMore = false
  /** One full ``thread.list`` at a time. A second call waits and replaces it. */
  private fullListInFlight = false
  private fullListSentAt = 0
  private fullListSentQueue: string | null = null
  private fullListPending: { queue: string | null; limit?: number } | null = null

  // Event pagination cursors per thread
  private eventPaginationCursors = new Map<string, string | null>()

  /** Active settings subscription — restored after reconnect. */
  private settingsSubscription: {
    audience: 'creator' | 'user'
    agentOwnerUserId: string | null
  } | null = null

  private pingTimer: ReturnType<typeof setInterval> | null = null

  constructor(callbacks: AgentActions) {
    this.callbacks = callbacks
  }

  setOnError(cb: OnErrorCallback | null) {
    this.onError = cb
  }

  setUploadUrl(url: string | undefined) {
    this.uploadUrl = url
  }

  /**
   * Set (or clear) the explicit HTTP base used to resolve relative content URLs.
   * Pass the agent's canonical `hostUrl` (base incl. LB seg, no message path).
   * Takes effect immediately and persists across reconnects.
   */
  setHttpBaseUrl(url: string | undefined) {
    const normalized = url?.trim().replace(/\/+$/, '')
    this.httpBaseUrlOverride = normalized || undefined
    if (this.httpBaseUrlOverride) {
      this.httpBaseUrl = this.httpBaseUrlOverride
    }
  }

  /** Sync from ``AgentProvider`` ``agentId``; used for ``POST /uploads`` ``agent_id`` (non-WS). */
  setUploadAgentId(agentId: string | undefined) {
    this.uploadAgentId = (agentId ?? '').trim()
  }

  /** Sync active thread id for chat uploads (must match persisted thread for signed URL keys). */
  setUploadThreadId(threadId: string | undefined) {
    this.uploadThreadId = (threadId ?? '').trim()
  }

  setUploadRunId(runId: string | undefined) {
    this.uploadRunId = (runId ?? '').trim()
  }

  /**
   * Merge connection metadata without tearing down the WebSocket.
   * Use for handshake token refresh and identity/role updates on an open session.
   */
  updateConnectionConfig(config: Partial<AgentConnectionConfig>) {
    this.config = { ...this.config, ...config }
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  async upload(file: File | Blob, options?: { filename?: string }): Promise<UploadResult> {
    if (!this.uploadUrl) {
      throw new Error('uploadUrl not configured')
    }

    const aid = (this.uploadAgentId || this.agentId || '').trim()
    if (!aid) {
      throw new Error('agentId is required for upload (set AgentProvider agentId)')
    }

    const formData = new FormData()
    if (file instanceof File) {
      const partName = options?.filename?.trim() || file.name.trim() || 'upload'
      formData.append('file', file, partName)
    } else {
      formData.append('file', file, blobPartFilename(file, options?.filename))
    }
    formData.append('agent_id', aid)
    const tid = this.uploadThreadId.trim()
    if (tid) {
      formData.append('thread_id', tid)
    }
    const rid = this.uploadRunId.trim()
    if (rid) {
      formData.append('run_id', rid)
    }

    const headers: Record<string, string> = {}
    const token = await this.resolveAuthToken()
    if (token) {
      headers.Authorization = `Bearer ${token}`
    }

    const response = await fetch(this.uploadUrl, {
      method: 'POST',
      body: formData,
      headers,
    })

    if (!response.ok) {
      const detail = await readHttpErrorMessage(response)
      throw new Error(detail)
    }

    const result = await response.json()
    return {
      refId: result.ref_id,
      mimeType: result.mime_type,
      filename: result.filename,
      sizeBytes: result.size_bytes ?? result.size ?? 0,
      publicUrl: result.public_url ?? undefined,
    }
  }

  connect(url: string, agentId: string, config?: AgentConnectionConfig) {
    this.url = apiMessagesUrlToWebSocketUrl(url)
    this.agentId = agentId
    this.uploadAgentId = agentId.trim()
    this.config = config ?? { organizationId: '', workspaceId: '', userId: '' }
    this.isIntentionallyClosed = false
    // A new target (e.g. another runtime after a give-up) starts with a full retry budget.
    this.consecutiveFailures = 0
    this.fullListInFlight = false
    this.fullListPending = null

    // Derive HTTP base URL from WebSocket URL for resolving relative content URLs
    if (this.httpBaseUrlOverride) {
      // Caller provided the canonical base (hostUrl); trust it verbatim so the
      // LB path prefix is preserved when resolving relative content URLs.
      this.httpBaseUrl = this.httpBaseUrlOverride
    } else {
      try {
        const parsed = new URL(this.url)
        parsed.protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:'
        parsed.pathname = ''
        parsed.search = ''
        parsed.hash = ''
        this.httpBaseUrl = parsed.toString().replace(/\/$/, '')
      } catch {
        this.httpBaseUrl = ''
      }
    }

    this.callbacks.resetReconnect()
    this.callbacks.setConnectionStatus('connecting')
    this.addResumeListeners()
    void this.openConnection()
  }

  /** Clear the last in-chat send error banner (see ``connection.sendError``). */
  clearSendError() {
    this.callbacks.setSendError(null)
  }

  private abortPendingMessages(reason: string) {
    for (const [clientEventId, pending] of this.pendingMessages) {
      clearTimeout(pending.timer)
      const opt = this.pendingOptimistic.get(clientEventId)
      if (opt?.threadId) {
        this.callbacks.removeOptimistic(opt.threadId, clientEventId)
      }
      this.pendingOptimistic.delete(clientEventId)
      pending.reject(new Error(reason))
    }
    this.pendingMessages.clear()
  }

  private abortPendingArtifacts(reason: string) {
    for (const [frameId, pending] of this.pendingArtifactsRequests) {
      clearTimeout(pending.timer)
      this.pendingArtifactsRequests.delete(frameId)
      pending.reject(new Error(reason))
    }
  }

  private abortPendingPublicSchema(reason: string) {
    for (const [frameId, pending] of this.pendingPublicSchema) {
      clearTimeout(pending.timer)
      this.pendingPublicSchema.delete(frameId)
      pending.reject(new Error(reason))
    }
  }

  disconnect() {
    this.isIntentionallyClosed = true
    this.attemptGeneration++
    this.attemptInFlight = false
    this.discardCandidate()
    this.connected = false
    this.stopHeartbeat()
    this.removeResumeListeners()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.abortPendingMessages('Disconnected')
    this.abortPendingArtifacts('Disconnected')
    this.abortPendingPublicSchema('Disconnected')
    this.fullListInFlight = false
    this.fullListPending = null
    if (this.ws) {
      detachAndClose(this.ws)
      this.ws = null
    }
    this.callbacks.setConnectionStatus('disconnected')
  }

  retry() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.consecutiveFailures = 0
    this.isIntentionallyClosed = false
    this.callbacks.resetReconnect()
    this.callbacks.setConnectionStatus('connecting')
    // An attempt already in flight is the retry; opening another would race it.
    if (this.attemptInFlight) return
    void this.openConnection()
  }

  // --- Thread operations ---

  requestThreadList(cursor?: string | null, limit?: number, queue?: string | null) {
    if (cursor) {
      this.send('thread.list', {
        cursor,
        limit,
        ...(this.threadListQueue ? { queue: this.threadListQueue } : {}),
      })
      return
    }
    const nextQueue = queue ?? null
    this.threadListQueue = nextQueue
    if (this.fullListInFlight) {
      if (nextQueue !== this.fullListSentQueue) {
        this.fullListPending = { queue: nextQueue, limit }
      }
      return
    }
    this.dispatchFullList(nextQueue, limit)
  }

  /** Full list (no cursor). The result applies this queue, not a later one. */
  private dispatchFullList(queue: string | null, limit?: number) {
    this.fullListInFlight = true
    this.fullListPending = null
    this.fullListSentQueue = queue
    this.threadListQueue = queue
    this.fullListSentAt = Date.now()
    this.send('thread.list', {
      limit,
      ...(queue ? { queue } : {}),
    })
  }

  updateThread(threadId: string, patch: { queue?: string | null }) {
    this.send('thread.update', { thread_id: threadId, queue: patch.queue ?? null })
  }

  subscribe(threadId: string, options?: { accessReason?: string }) {
    const refs = this.subscriptionRefs.get(threadId) ?? 0
    this.subscriptionRefs.set(threadId, refs + 1)
    if (options?.accessReason?.trim()) {
      this.subscriptionAccessReasons.set(threadId, options.accessReason.trim())
    }
    if (refs === 0) {
      const afterEventId = this.lastEventIds.get(threadId) ?? null
      const accessReason = this.subscriptionAccessReasons.get(threadId)
      this.send('thread.subscribe', {
        thread_id: threadId,
        after_event_id: afterEventId,
        ...(accessReason ? { access_reason: accessReason } : {}),
      })
      this.callbacks.addSubscription(threadId)
    }
  }

  unsubscribe(threadId: string) {
    const refs = this.subscriptionRefs.get(threadId) ?? 0
    if (refs <= 1) {
      this.subscriptionRefs.delete(threadId)
      this.subscriptionAccessReasons.delete(threadId)
      // Keep the cursor. A queue move can drop and resubscribe the open thread;
      // wiping it makes the next subscribe pull a full snapshot and race the tail.
      this.eventPaginationCursors.delete(threadId)
      this.send('thread.unsubscribe', { thread_id: threadId })
      this.callbacks.removeSubscription(threadId)
    } else {
      this.subscriptionRefs.set(threadId, refs - 1)
    }
  }

  deleteThread(threadId: string) {
    this.send('thread.delete', { thread_id: threadId })
  }

  addParticipant(
    threadId: string,
    user: {
      userId: string
      userName?: string | null
      userEmail?: string | null
      identityIds?: string[]
    }
  ) {
    this.send('thread.participants.add', {
      thread_id: threadId,
      user: {
        user_id: user.userId,
        user_name: user.userName ?? null,
        user_email: user.userEmail ?? null,
        identity_ids: user.identityIds ?? [],
        system_role: 'user',
        organization_role: 'member',
        workspace_role: 'member',
      },
    })
  }

  loadMoreThreads(limit?: number) {
    const cursor = this.lastThreadListCursor
    if (!cursor || this.isLoadingMore) return
    this.isLoadingMore = true
    this.send('thread.list', {
      cursor,
      limit,
      ...(this.threadListQueue ? { queue: this.threadListQueue } : {}),
    })
  }

  loadOlderEvents(threadId: string, limit?: number) {
    const cursor = this.eventPaginationCursors.get(threadId)
    this.send('event.list', {
      thread_id: threadId,
      before_event_id: cursor ?? null,
      limit,
    })
  }

  requestThreadArtifactsList(
    threadId: string,
    options?: {
      cursor?: string | null
      limit?: number
      direction?: 'in' | 'out' | 'all'
    }
  ): Promise<{ artifacts: ThreadArtifact[]; cursor: string | null; hasMore: boolean }> {
    if (!this.isConnected()) {
      return Promise.reject(new Error('Not connected'))
    }

    const frameId = crypto.randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingArtifactsRequests.delete(frameId)
        reject(new Error('thread.artifacts.list timed out'))
      }, ARTIFACTS_LIST_TIMEOUT)

      this.pendingArtifactsRequests.set(frameId, {
        threadId,
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (err) => {
          clearTimeout(timer)
          reject(err)
        },
        timer,
      })

      this.sendRaw({
        id: frameId,
        type: 'thread.artifacts.list',
        payload: {
          thread_id: threadId,
          cursor: options?.cursor ?? null,
          limit: options?.limit,
          direction: options?.direction ?? 'all',
        },
      })
    })
  }

  // --- Settings ---

  subscribeSettings(options?: { audience?: 'creator' | 'user'; agentOwnerUserId?: string | null }) {
    const audience = options?.audience ?? 'user'
    const agentOwnerUserId = options?.agentOwnerUserId ?? null
    this.settingsSubscription = { audience, agentOwnerUserId }
    this.send('settings.subscribe', {
      agent_id: this.agentId,
      audience,
      agent_owner_user_id: agentOwnerUserId,
    })
  }

  unsubscribeSettings() {
    this.settingsSubscription = null
    this.send('settings.unsubscribe', { agent_id: this.agentId })
  }

  patchSetting(fieldId: string, value: unknown) {
    this.send('settings.patch', { field_id: fieldId, value })
  }

  /**
   * Request ``settings.public_schema`` on the open session (schema + defaults, no stored values).
   */
  fetchPublicSettingsSchema(options?: { timeoutMs?: number }): Promise<PublicSettingsSchemaResult> {
    if (!this.isConnected()) {
      return Promise.reject(new Error('Not connected'))
    }
    const timeoutMs = options?.timeoutMs ?? 15_000
    const frameId = crypto.randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingPublicSchema.delete(frameId)
        reject(new Error('settings.public_schema timed out'))
      }, timeoutMs)

      this.pendingPublicSchema.set(frameId, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (err) => {
          clearTimeout(timer)
          reject(err)
        },
        timer,
      })

      this.sendRaw({
        id: frameId,
        type: 'settings.public_schema',
        payload: {},
      })
    })
  }

  // --- Feedback ---

  sendFeedback(
    targetType: string,
    targetId: string,
    feedback: 'like' | 'dislike',
    reason?: string,
    classification?: string
  ) {
    this.send('feedback', {
      target_type: targetType,
      target_id: targetId,
      feedback,
      reason,
      classification,
    })
  }

  // --- Analytics ---

  subscribeAnalytics() {
    this.analyticsSubscribed = true
    this.send('analytics.subscribe', { agent_id: this.agentId })
  }

  unsubscribeAnalytics() {
    this.analyticsSubscribed = false
    this.send('analytics.unsubscribe', { agent_id: this.agentId })
  }

  // --- Messaging ---

  sendMessage(params: {
    text?: string
    threadId?: string
    content?: SendContentPart[]
    metadata?: Record<string, unknown>
    chatContext?: ChatContext
    /** New-thread queue slug. Ignored when ``threadId`` is set. */
    queue?: string | null
  }): Promise<{ threadId: string }> {
    this.callbacks.setSendError(null)
    const clientEventId = crypto.randomUUID()
    const content: WireC2S_ContentPart[] = params.content
      ? params.content.map(toWireContentPart)
      : [{ type: 'text', text: params.text ?? '' }]

    // Build optimistic display content from send parts
    const displayContent: DisplayContentPart[] = params.content
      ? params.content.map((p): DisplayContentPart => {
          switch (p.type) {
            case 'text':
              return { type: 'text', text: p.text }
            case 'audio':
              return {
                type: 'audio',
                duration: p.duration,
                ...(p.url ? { url: p.url } : {}),
                ...(p.mimeType ? { mimeType: p.mimeType } : {}),
                ...(p.filename ? { filename: p.filename } : {}),
              }
            case 'image':
              return {
                type: 'image',
                ...(p.url ? { url: p.url } : {}),
                ...(p.mimeType ? { mimeType: p.mimeType } : {}),
                ...(p.filename ? { filename: p.filename } : {}),
              }
            case 'document':
              return {
                type: 'document',
                ...(p.url ? { url: p.url } : {}),
                ...(p.mimeType ? { mimeType: p.mimeType } : {}),
                ...(p.filename ? { filename: p.filename } : {}),
              }
            default:
              return { type: 'text', text: '' }
          }
        })
      : [{ type: 'text', text: params.text ?? '' }]

    // Build optimistic event
    const optimisticEvent: ThreadEvent = {
      id: `optimistic-${clientEventId}`,
      threadId: params.threadId ?? '',
      runId: null,
      type: 'message',
      actor: 'user',
      author: null,
      user: {
        userId: this.config.userId ?? '',
        userName: this.config.userName,
        userEmail: this.config.userEmail,
        identityIds: this.config.identityIds,
        systemRole: this.config.systemRole ?? 'user',
        organizationRole: this.config.organizationRole ?? 'member',
        workspaceRole: this.config.workspaceRole ?? 'member',
      },
      content: displayContent,
      createdAt: new Date().toISOString(),
    }

    if (params.threadId) {
      this.callbacks.addOptimistic(params.threadId, optimisticEvent, clientEventId)
    }

    this.pendingOptimistic.set(clientEventId, {
      threadId: params.threadId ?? '',
      clientEventId,
    })

    const promise = this.createPendingPromise(clientEventId)

    const payload: Record<string, unknown> = {
      thread_id: params.threadId,
      client_event_id: clientEventId,
      event: {
        type: 'message' as const,
        actor: 'user' as const,
        content,
      },
    }
    payload.metadata = this.withChannelMetadata(params.metadata)
    const chatContext = this.toWireChatContext(params.chatContext)
    if (chatContext) {
      payload.chat_context = chatContext
    }
    if (!params.threadId && params.queue) {
      payload.queue = params.queue
    }

    this.sendRaw({
      id: clientEventId,
      type: 'event.create',
      payload,
    })

    return promise
  }

  sendFormResponse(params: {
    threadId: string
    formEventId: string
    cancelled: boolean
    values: Record<string, unknown>
    metadata?: Record<string, unknown>
  }): Promise<{ threadId: string }> {
    this.callbacks.setSendError(null)
    const clientEventId = crypto.randomUUID()
    const promise = this.createPendingPromise(clientEventId)

    this.sendRaw({
      id: clientEventId,
      type: 'event.create',
      payload: {
        thread_id: params.threadId,
        client_event_id: clientEventId,
        event: {
          type: 'form.response' as const,
          actor: 'user' as const,
          content: [],
          data: {
            form_event_id: params.formEventId,
            cancelled: params.cancelled,
            values: params.values,
          },
        },
      },
      metadata: this.withChannelMetadata(params.metadata),
    })

    return promise
  }

  // --- Private ---

  private createPendingPromise(clientEventId: string): Promise<{ threadId: string }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const opt = this.pendingOptimistic.get(clientEventId)
        if (opt?.threadId) {
          this.callbacks.removeOptimistic(opt.threadId, clientEventId)
        }
        this.pendingOptimistic.delete(clientEventId)
        this.pendingMessages.delete(clientEventId)
        reject(new Error('Request timed out waiting for server response'))
      }, SEND_MESSAGE_TIMEOUT)

      this.pendingMessages.set(clientEventId, { resolve, reject, timer })
    })
  }

  /** Rejects when `getAuthToken` throws or has not settled within AUTH_TOKEN_TIMEOUT_MS. */
  private async resolveAuthToken(): Promise<string | undefined> {
    if (!this.config.getAuthToken) return this.config.authToken
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('auth token timeout')), AUTH_TOKEN_TIMEOUT_MS)
    })
    try {
      return await Promise.race([this.config.getAuthToken(), timeout])
    } finally {
      clearTimeout(timer)
    }
  }

  private async openConnection(): Promise<void> {
    const gen = ++this.attemptGeneration
    this.stopHeartbeat()
    this.discardCandidate()
    this.connected = false
    this.attemptInFlight = true

    let token: string | undefined
    try {
      token = await this.resolveAuthToken()
    } catch {
      if (gen !== this.attemptGeneration || this.isIntentionallyClosed) {
        if (gen === this.attemptGeneration) this.attemptInFlight = false
        return
      }
      this.attemptInFlight = false
      this.onAttemptFailed('auth token unavailable')
      return
    }
    if (gen !== this.attemptGeneration || this.isIntentionallyClosed) {
      // A newer attempt (or disconnect) owns attemptInFlight now.
      return
    }

    if (this.ws) {
      this.abortPendingMessages('Connection lost; reconnecting')
      this.abortPendingArtifacts('Connection lost; reconnecting')
      this.abortPendingPublicSchema('Connection lost; reconnecting')
      detachAndClose(this.ws)
    }

    const ws = new WebSocket(this.url)
    this.ws = ws
    this.activeRuns.clear()

    ws.onopen = () => {
      if (this.ws !== ws) return
      this.connectFrameId = crypto.randomUUID()
      this.authenticate(ws, token, this.connectFrameId)
    }
    this.bindPrimary(ws)
  }

  /** Route frames from the primary socket and react when it closes. */
  private bindPrimary(ws: WebSocket) {
    ws.onmessage = (e: MessageEvent) => {
      if (this.ws !== ws) return
      this.lastFrameAt = Date.now()
      try {
        const frame = JSON.parse(e.data as string) as ServerToClient
        this.route(frame)
      } catch {
        // Ignore malformed frames
      }
    }

    ws.onclose = () => {
      if (this.ws !== ws || this.isIntentionallyClosed) return
      this.stopHeartbeat()
      this.attemptInFlight = false
      if (this.connected) {
        this.handleConnectedDrop()
      } else {
        this.onAttemptFailed('connection closed')
      }
    }

    ws.onerror = () => {
      // onclose will fire after onerror
    }
  }

  /** Send the `connect` frame on this socket (the primary or a renewal candidate). */
  private authenticate(ws: WebSocket, token: string | undefined, frameId: string) {
    if (ws.readyState !== WebSocket.OPEN) return
    const frame = {
      id: frameId,
      type: 'connect',
      payload: {
        agent_id: this.agentId,
        organization_id: this.config.organizationId ?? '',
        workspace_id: this.config.workspaceId ?? '',
        user: {
          user_id: this.config.userId ?? '',
          user_name: this.config.userName ?? null,
          user_email: this.config.userEmail ?? null,
          user_mobile_number: this.config.userMobileNumber ?? null,
          user_whatsapp_number: this.config.userWhatsappNumber ?? null,
          identity_ids: this.config.identityIds ?? [],
          system_role: this.config.systemRole ?? 'user',
          organization_role: this.config.organizationRole ?? 'member',
          workspace_role: this.config.workspaceRole ?? 'member',
        },
        auth_token: token,
        client: { name: 'dooers-agents-client', version: PACKAGE_VERSION },
      },
    }
    ws.send(JSON.stringify(frame))
  }

  private route(frame: ServerToClient) {
    switch (frame.type) {
      case 'ack': {
        if (frame.payload.ack_id === this.connectFrameId) {
          if (frame.payload.ok) {
            this.handleConnected(frame.payload.server?.version ?? null)
          } else {
            const err = frame.payload.error
            const message = err?.message ?? 'connection rejected'
            try {
              this.onError?.({
                code: err?.code ?? 'CONNECTION_REJECTED',
                message,
                frameType: 'connect',
              })
            } catch {
              // A throwing app callback must not keep this attempt open and uncounted.
            }
            // Detach first: older servers keep the socket open, newer ones close it (1008).
            // Either way this attempt counts once.
            if (this.ws) detachAndClose(this.ws)
            this.attemptInFlight = false
            this.onAttemptFailed(message)
          }
        } else if (!frame.payload.ok && frame.payload.error) {
          const ackId = frame.payload.ack_id
          const err = frame.payload.error
          if (ackId) {
            const pending = this.pendingMessages.get(ackId)
            if (pending) {
              clearTimeout(pending.timer)
              this.pendingMessages.delete(ackId)
              const msg = err.message || 'Request rejected'
              const opt = this.pendingOptimistic.get(ackId)
              if (opt?.threadId) {
                this.callbacks.removeOptimistic(opt.threadId, ackId)
              }
              this.pendingOptimistic.delete(ackId)
              pending.reject(new Error(msg))
              this.callbacks.setSendError(msg)
            }
            const artifactsPending = this.pendingArtifactsRequests.get(ackId)
            if (artifactsPending) {
              clearTimeout(artifactsPending.timer)
              this.pendingArtifactsRequests.delete(ackId)
              const msg = err.message || 'Request rejected'
              artifactsPending.reject(new Error(msg))
            }
            const schemaPending = this.pendingPublicSchema.get(ackId)
            if (schemaPending) {
              clearTimeout(schemaPending.timer)
              this.pendingPublicSchema.delete(ackId)
              schemaPending.reject(new Error(err.message || 'Request rejected'))
            }
          }
          this.onError?.({
            code: err.code,
            message: err.message,
            frameType: 'ack',
          })
        }
        break
      }

      case 'thread.list.result': {
        const threads = frame.payload.threads.map(toThread)
        const cursor = frame.payload.cursor ?? null
        const totalCount = frame.payload.total_count
        this.lastThreadListCursor = cursor
        if (this.isLoadingMore) {
          this.callbacks.onThreadListAppend(threads, cursor, totalCount)
          this.isLoadingMore = false
          break
        }
        const sentAt = this.fullListSentAt
        const sentQueue = this.fullListSentQueue
        const pending = this.fullListPending
        this.fullListInFlight = false
        this.fullListPending = null
        if (pending && pending.queue !== sentQueue) {
          this.dispatchFullList(pending.queue, pending.limit)
          break
        }
        this.callbacks.onThreadList(
          threads,
          cursor,
          totalCount,
          sentQueue,
          sentAt > 0 ? sentAt : null
        )
        break
      }

      case 'thread.snapshot': {
        const thread = toThread(frame.payload.thread)
        const events = this.resolveEventUrls(frame.payload.events.map(toThreadEvent))
        const runs = (frame.payload.runs ?? []).map(toRun)
        // Track last event for gap recovery
        const lastEvent = events[events.length - 1]
        if (lastEvent) {
          this.lastEventIds.set(thread.id, lastEvent.id)
        }
        // Set initial event pagination cursor to oldest event
        const oldestEvent = events[0]
        if (oldestEvent) {
          this.eventPaginationCursors.set(thread.id, oldestEvent.id)
        }
        this.callbacks.onThreadSnapshot(thread, events, runs, frame.payload.has_more === true)
        break
      }

      case 'event.append': {
        const events = this.resolveEventUrls(frame.payload.events.map(toThreadEvent))
        // Collect reconciled client event IDs; resolve sends only after store update
        const resolvedClientEventIds: string[] = []
        const pendingIdsToResolve: string[] = []
        for (const event of events) {
          if (event.clientEventId && this.pendingOptimistic.has(event.clientEventId)) {
            resolvedClientEventIds.push(event.clientEventId)
            this.pendingOptimistic.delete(event.clientEventId)
          }
          if (event.clientEventId && this.pendingMessages.has(event.clientEventId)) {
            const pendingMessage = this.pendingMessages.get(event.clientEventId)
            if (pendingMessage) {
              clearTimeout(pendingMessage.timer)
              pendingIdsToResolve.push(event.clientEventId)
            }
          }
        }
        // Track last event for gap recovery on reconnect.
        // Only for subscribed threads — new threads receive event.append
        // before subscription exists, and lastEventIds feeds after_event_id
        // in subscribe(), which controls what the server includes in snapshots.
        const lastEvent = events[events.length - 1]
        if (lastEvent && this.subscriptionRefs.has(frame.payload.thread_id)) {
          this.lastEventIds.set(frame.payload.thread_id, lastEvent.id)
        }
        // Atomically append confirmed events and remove reconciled optimistic events
        if (resolvedClientEventIds.length > 0) {
          this.callbacks.reconcileEvents(frame.payload.thread_id, events, resolvedClientEventIds)
        } else {
          this.callbacks.onEventAppend(frame.payload.thread_id, events)
        }
        const tid = frame.payload.thread_id
        for (const id of pendingIdsToResolve) {
          const pending = this.pendingMessages.get(id)
          if (pending) {
            pending.resolve({ threadId: tid })
            this.pendingMessages.delete(id)
          }
        }
        break
      }

      case 'event.list.result': {
        const events = this.resolveEventUrls(frame.payload.events.map(toThreadEvent))
        this.eventPaginationCursors.set(frame.payload.thread_id, frame.payload.cursor)
        this.callbacks.onEventListResult(
          frame.payload.thread_id,
          events,
          frame.payload.cursor,
          frame.payload.has_more
        )
        break
      }

      case 'thread.artifacts.list.result': {
        const threadId = frame.payload.thread_id
        for (const [frameId, pending] of this.pendingArtifactsRequests) {
          if (pending.threadId !== threadId) continue
          clearTimeout(pending.timer)
          this.pendingArtifactsRequests.delete(frameId)
          pending.resolve({
            artifacts: this.resolveArtifactUrls(frame.payload.artifacts.map(toThreadArtifact)),
            cursor: frame.payload.cursor,
            hasMore: frame.payload.has_more,
          })
          break
        }
        break
      }

      case 'thread.upsert':
        this.callbacks.onThreadUpsert(toThread(frame.payload.thread))
        break

      case 'thread.deleted':
        this.callbacks.onThreadDeleted(frame.payload.thread_id)
        this.lastEventIds.delete(frame.payload.thread_id)
        break

      case 'run.upsert': {
        const run = toRun(frame.payload.run)
        if (run.status === 'running') this.activeRuns.add(run.id)
        else this.activeRuns.delete(run.id)
        this.callbacks.onRunUpsert(run)
        break
      }

      case 'settings.snapshot': {
        const fields = frame.payload.fields.map(toSettingsItem)
        this.callbacks.onSettingsSnapshot(fields, frame.payload.updated_at)
        break
      }

      case 'settings.patch':
        this.callbacks.onSettingsPatch(
          frame.payload.field_id,
          frame.payload.value,
          frame.payload.updated_at
        )
        break

      case 'settings.public_schema.result': {
        const pending = this.pendingPublicSchema.get(frame.id)
        if (pending) {
          this.pendingPublicSchema.delete(frame.id)
          clearTimeout(pending.timer)
          const parsed = publicSchemaFromResultPayload(
            frame.payload as {
              schema?: { version?: string; fields?: WireSettingsItem[] }
              schema_?: { version?: string; fields?: WireSettingsItem[] }
            }
          )
          pending.resolve({
            version: parsed.version,
            fields: parsed.fields.map(toSettingsItem),
          })
        }
        break
      }

      case 'feedback.ack':
        if (frame.payload.ok) {
          this.callbacks.onFeedbackAck(
            frame.payload.target_id,
            frame.payload.feedback as 'like' | 'dislike'
          )
        }
        break

      case 'analytics.event':
        this.callbacks.onAnalyticsEvent(toAnalyticsEvent(frame.payload))
        break

      case 'pong':
        break
    }
  }

  private resubscribeSettings() {
    if (!this.settingsSubscription) return
    this.send('settings.subscribe', {
      agent_id: this.agentId,
      audience: this.settingsSubscription.audience,
      agent_owner_user_id: this.settingsSubscription.agentOwnerUserId,
    })
  }

  /**
   * A connected socket was lost. One that stayed up is not a failed attempt: reset the count and
   * retry soon. One lost right after its ack counts, so accept-then-drop ends in a give-up.
   */
  private handleConnectedDrop() {
    const stable = Date.now() - this.connectedAt >= STABLE_CONNECTION_MS
    this.discardCandidate()
    this.connected = false
    this.abortPendingMessages('Connection lost; reconnecting')
    this.abortPendingArtifacts('Connection lost; reconnecting')
    this.abortPendingPublicSchema('Connection lost; reconnecting')
    if (!stable) {
      this.onAttemptFailed('connection dropped')
      return
    }
    this.consecutiveFailures = 0
    this.callbacks.setConnectionStatus('disconnected')
    this.scheduleReconnect(reconnectDelayMs(0))
  }

  /** Treat a connected socket that went silent as dropped. Returns true when it was dead. */
  private dropIfDead(): boolean {
    if (!this.connected) return false
    // The server runs a turn inline and does not answer pings meanwhile; allow a long silence then.
    const timeout = this.isIdle() ? LIVENESS_TIMEOUT_MS : LIVENESS_BUSY_TIMEOUT_MS
    if (Date.now() - this.lastFrameAt <= timeout) return false
    if (this.ws) detachAndClose(this.ws)
    this.attemptInFlight = false
    this.handleConnectedDrop()
    return true
  }

  private heartbeatTick() {
    if (this.dropIfDead()) return
    this.send('ping', {})
    if (
      this.connected &&
      !this.candidate &&
      rotationDue(Date.now() - this.connectedAt, this.isIdle())
    ) {
      void this.rotate()
    }
  }

  /** Nothing waits on the server and no run is in progress. */
  private isIdle(): boolean {
    return (
      this.pendingMessages.size === 0 &&
      this.pendingArtifactsRequests.size === 0 &&
      this.pendingPublicSchema.size === 0 &&
      this.activeRuns.size === 0
    )
  }

  /**
   * Make-before-break renewal ahead of the hosting cut (and onto a new revision after a
   * redeploy): open a second socket and swap only once its connect is acked.
   */
  private async rotate(): Promise<void> {
    const primary = this.ws
    let token: string | undefined
    try {
      token = await this.resolveAuthToken()
    } catch {
      return // failed or timed out: the next heartbeat tries again
    }
    // The primary dropped, was replaced or renewed, or another rotation won while the token loaded.
    if (this.ws !== primary || !this.connected || this.candidate) return

    const ws = new WebSocket(this.url)
    const candidate = { ws, frameId: crypto.randomUUID() }
    this.candidate = candidate

    ws.onopen = () => {
      if (this.candidate !== candidate) return
      this.authenticate(ws, token, candidate.frameId)
    }
    ws.onmessage = (e: MessageEvent) => {
      if (this.candidate !== candidate) return
      let frame: ServerToClient
      try {
        frame = JSON.parse(e.data as string) as ServerToClient
      } catch {
        return
      }
      if (frame.type !== 'ack' || frame.payload.ack_id !== candidate.frameId) return
      if (frame.payload.ok) {
        this.promoteCandidate(candidate, frame.payload.server?.version ?? null)
      } else {
        this.discardCandidate()
      }
    }
    ws.onclose = () => {
      if (this.candidate === candidate) this.discardCandidate()
    }
    ws.onerror = () => {
      if (this.candidate === candidate) this.discardCandidate()
    }
  }

  /** The renewal socket becomes the primary. The app never sees a status change. */
  private promoteCandidate(
    candidate: { ws: WebSocket; frameId: string },
    serverVersion: string | null
  ) {
    this.candidate = null
    // The replaced socket was up for ROTATE_AFTER_MS, well past STABLE_CONNECTION_MS.
    this.consecutiveFailures = 0
    // Pending requests keep their own timeouts: aborting them would report a drop that never was.
    if (this.ws) detachAndClose(this.ws, 1000)
    this.ws = candidate.ws
    this.connectFrameId = candidate.frameId
    candidate.ws.onopen = null
    this.bindPrimary(candidate.ws)
    this.connectedAt = this.lastFrameAt = Date.now()
    this.callbacks.setServerVersion(serverVersion?.trim() || null)
    this.restoreSession(this.threadListQueue)
  }

  /** Drop a renewal socket that was not promoted; the primary is untouched. */
  private discardCandidate() {
    const candidate = this.candidate
    if (!candidate) return
    this.candidate = null
    detachAndClose(candidate.ws)
  }

  private handleResume() {
    if (this.isIntentionallyClosed) return
    if (!this.connected) {
      this.retry()
      return
    }
    if (this.dropIfDead()) return
    this.send('ping', {})
  }

  private readonly onOnline = () => this.handleResume()
  private readonly onVisibilityChange = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    this.handleResume()
  }

  private addResumeListeners() {
    if (this.resumeListenersAttached || typeof window === 'undefined') return
    this.resumeListenersAttached = true
    window.addEventListener('online', this.onOnline)
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.onVisibilityChange)
    }
  }

  private removeResumeListeners() {
    if (!this.resumeListenersAttached) return
    this.resumeListenersAttached = false
    if (typeof window !== 'undefined') window.removeEventListener('online', this.onOnline)
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisibilityChange)
    }
  }

  private startHeartbeat() {
    this.stopHeartbeat()
    this.pingTimer = setInterval(() => this.heartbeatTick(), PING_INTERVAL_MS)
  }

  private stopHeartbeat() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
  }

  private handleConnected(serverVersion: string | null) {
    this.connected = true
    this.connectedAt = this.lastFrameAt = Date.now()
    this.attemptInFlight = false
    // consecutiveFailures is reset only once this socket proves stable (handleConnectedDrop).
    const sv = serverVersion?.trim()
    this.callbacks.setServerVersion(sv || null)
    this.callbacks.setConnectionStatus('connected')
    this.callbacks.resetReconnect()
    // The app re-requests its own queue filter when the status turns `connected`.
    this.restoreSession(null)
  }

  /**
   * Ask a fresh socket for everything the previous one carried: thread list, thread and
   * settings subscriptions, analytics, heartbeat.
   */
  private restoreSession(listQueue: string | null) {
    // Lists sent on the previous socket are never answered; do not wait for them.
    this.isLoadingMore = false
    this.dispatchFullList(listQueue)
    // Re-subscribe to previously tracked threads
    for (const threadId of this.subscriptionRefs.keys()) {
      const afterEventId = this.lastEventIds.get(threadId) ?? null
      const accessReason = this.subscriptionAccessReasons.get(threadId)
      this.send('thread.subscribe', {
        thread_id: threadId,
        after_event_id: afterEventId,
        ...(accessReason ? { access_reason: accessReason } : {}),
      })
    }
    this.resubscribeSettings()
    if (this.analyticsSubscribed) this.send('analytics.subscribe', { agent_id: this.agentId })
    this.startHeartbeat()
  }

  private onAttemptFailed(reason: string) {
    this.consecutiveFailures++
    if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      this.giveUp(reason)
      return
    }
    this.callbacks.setConnectionStatus('disconnected')
    this.scheduleReconnect(reconnectDelayMs(this.consecutiveFailures))
  }

  private giveUp(reason: string) {
    this.stopHeartbeat()
    this.abortPendingMessages(reason)
    this.abortPendingArtifacts(reason)
    this.abortPendingPublicSchema(reason)
    this.callbacks.setReconnectFailed()
    this.callbacks.setConnectionStatus('error', reason)
  }

  private scheduleReconnect(delayMs: number) {
    this.stopHeartbeat()
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.callbacks.setConnectionStatus('connecting')
      void this.openConnection()
    }, delayMs)
  }

  private send(type: string, payload: unknown) {
    this.sendRaw({ id: crypto.randomUUID(), type, payload })
  }

  private withChannelMetadata(
    metadata: Record<string, unknown> | undefined
  ): Record<string, unknown> | undefined {
    const channel = (this.config.channel || 'dooers-platform').trim() || 'dooers-platform'
    const base = metadata ? { ...metadata } : {}
    if (!('channel' in base)) {
      base.channel = channel
    }
    if (this.config.channelMeta && !('channel_meta' in base)) {
      base.channel_meta = this.config.channelMeta
    }
    return Object.keys(base).length > 0 ? base : undefined
  }

  private toWireChatContext(
    chatContext: ChatContext | undefined
  ): { llm_model?: string; reasoning_effort?: string } | undefined {
    const llmModel = chatContext?.llmModel?.trim()
    const reasoningEffort = chatContext?.reasoningEffort?.trim().toLowerCase()
    const out: { llm_model?: string; reasoning_effort?: string } = {}
    if (llmModel) out.llm_model = llmModel
    if (reasoningEffort) out.reasoning_effort = reasoningEffort
    return Object.keys(out).length > 0 ? out : undefined
  }

  private sendRaw(frame: unknown) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify(frame))
  }

  /** Resolve relative URLs in event content parts against the agent's HTTP base. */
  private resolveEventUrls(events: ThreadEvent[]): ThreadEvent[] {
    if (!this.httpBaseUrl) return events
    const base = this.httpBaseUrl
    return events.map((event) => {
      if (!event.content?.some((p) => 'url' in p && p.url?.startsWith('/'))) return event
      return {
        ...event,
        content: event.content.map((part) =>
          'url' in part && part.url?.startsWith('/') ? { ...part, url: `${base}${part.url}` } : part
        ),
      }
    })
  }

  private resolveArtifactUrls(artifacts: ThreadArtifact[]): ThreadArtifact[] {
    if (!this.httpBaseUrl) return artifacts
    const base = this.httpBaseUrl
    return artifacts.map((artifact) => {
      if (!artifact.url?.startsWith('/')) return artifact
      return { ...artifact, url: `${base}${artifact.url}` }
    })
  }
}
