import { apiMessagesUrlToWebSocketUrl } from './helpers/api-messages-url-to-ws'
import type { ServerToClient } from './protocol/frames'
import type { WireC2S_ContentPart, WireSettingsItem } from './protocol/models'
import type { AgentActions } from './store'
import type { DisplayContentPart, SendContentPart, SettingsItem, ThreadEvent } from './types'
import {
  toAnalyticsEvent,
  toRun,
  toSettingsItem,
  toThread,
  toThreadEvent,
  toWireContentPart,
} from './types'

const MAX_RECONNECT_ATTEMPTS = 5
const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 16000]
const SEND_MESSAGE_TIMEOUT = 30_000

export interface AgentConnectionConfig {
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
}

export type OnErrorCallback = (error: { code: string; message: string; frameType: string }) => void

export interface UploadResult {
  refId: string
  mimeType: string
  filename: string
  sizeBytes: number
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
          const raw = msg.payload?.schema as
            | { version?: string; fields?: WireSettingsItem[] }
            | undefined
          const fieldsWire = raw?.fields ?? []
          const fields = fieldsWire.map((w) => toSettingsItem(w))
          finish(() =>
            resolve({
              version: typeof raw?.version === 'string' ? raw.version : '1.0',
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
  private agentId = ''
  private uploadUrl: string | undefined
  private config: AgentConnectionConfig = {
    organizationId: '',
    workspaceId: '',
    userId: '',
  }

  private connectFrameId = ''
  private isIntentionallyClosed = false
  private reconnectAttempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  // Refcounted subscriptions
  private subscriptionRefs = new Map<string, number>()

  // Track optimistic events for reconciliation
  private pendingOptimistic = new Map<string, { threadId: string; clientEventId: string }>()

  // Pending message promises — resolved when event.append arrives with matching clientEventId
  private pendingMessages = new Map<
    string,
    { resolve: (value: { threadId: string }) => void; timer: ReturnType<typeof setTimeout> }
  >()

  // Track last event ID per thread for gap recovery on reconnect
  private lastEventIds = new Map<string, string>()

  // Pagination
  private lastThreadListCursor: string | null = null
  private isLoadingMore = false

  // Event pagination cursors per thread
  private eventPaginationCursors = new Map<string, string | null>()

  constructor(callbacks: AgentActions) {
    this.callbacks = callbacks
  }

  setOnError(cb: OnErrorCallback | null) {
    this.onError = cb
  }

  setUploadUrl(url: string | undefined) {
    this.uploadUrl = url
  }

  async upload(file: File | Blob): Promise<UploadResult> {
    if (!this.uploadUrl) {
      throw new Error('uploadUrl not configured')
    }

    const formData = new FormData()
    formData.append('file', file)

    const headers: Record<string, string> = {}
    if (this.config.authToken) {
      headers.Authorization = `Bearer ${this.config.authToken}`
    }

    const response = await fetch(this.uploadUrl, {
      method: 'POST',
      body: formData,
      headers,
    })

    if (!response.ok) {
      throw new Error(`Upload failed: ${response.status} ${response.statusText}`)
    }

    const result = await response.json()
    return {
      refId: result.ref_id,
      mimeType: result.mime_type,
      filename: result.filename,
      sizeBytes: result.size_bytes,
    }
  }

  connect(url: string, agentId: string, config?: AgentConnectionConfig) {
    this.url = apiMessagesUrlToWebSocketUrl(url)
    this.agentId = agentId
    this.config = config ?? { organizationId: '', workspaceId: '', userId: '' }
    this.isIntentionallyClosed = false

    // Derive HTTP base URL from WebSocket URL for resolving relative content URLs
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

    this.callbacks.setConnectionStatus('connecting')
    this.createConnection()
  }

  disconnect() {
    this.isIntentionallyClosed = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    // Clean up pending message promises
    for (const [, pending] of this.pendingMessages) {
      clearTimeout(pending.timer)
    }
    this.pendingMessages.clear()
    if (this.ws) {
      this.ws.onopen = null
      this.ws.onmessage = null
      this.ws.onclose = null
      this.ws.onerror = null
      this.ws.close()
      this.ws = null
    }
    this.callbacks.setConnectionStatus('disconnected')
  }

  retry() {
    this.reconnectAttempts = 0
    this.isIntentionallyClosed = false
    this.callbacks.setConnectionStatus('connecting')
    this.createConnection()
  }

  // --- Thread operations ---

  requestThreadList(cursor?: string | null, limit?: number) {
    this.send('thread.list', { cursor, limit })
  }

  subscribe(threadId: string) {
    const refs = this.subscriptionRefs.get(threadId) ?? 0
    this.subscriptionRefs.set(threadId, refs + 1)
    if (refs === 0) {
      const afterEventId = this.lastEventIds.get(threadId) ?? null
      this.send('thread.subscribe', { thread_id: threadId, after_event_id: afterEventId })
      this.callbacks.addSubscription(threadId)
    }
  }

  unsubscribe(threadId: string) {
    const refs = this.subscriptionRefs.get(threadId) ?? 0
    if (refs <= 1) {
      this.subscriptionRefs.delete(threadId)
      this.lastEventIds.delete(threadId)
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

  loadMoreThreads(limit?: number) {
    const cursor = this.lastThreadListCursor
    if (!cursor || this.isLoadingMore) return
    this.isLoadingMore = true
    this.send('thread.list', { cursor, limit })
  }

  loadOlderEvents(threadId: string, limit?: number) {
    const cursor = this.eventPaginationCursors.get(threadId)
    this.send('event.list', {
      thread_id: threadId,
      before_event_id: cursor ?? null,
      limit,
    })
  }

  // --- Settings ---

  subscribeSettings(options?: { audience?: 'creator' | 'user'; agentOwnerUserId?: string | null }) {
    this.send('settings.subscribe', {
      agent_id: this.agentId,
      audience: options?.audience ?? 'user',
      agent_owner_user_id: options?.agentOwnerUserId ?? null,
    })
  }

  unsubscribeSettings() {
    this.send('settings.unsubscribe', { agent_id: this.agentId })
  }

  patchSetting(fieldId: string, value: unknown) {
    this.send('settings.patch', { field_id: fieldId, value })
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
    this.send('analytics.subscribe', { agent_id: this.agentId })
  }

  unsubscribeAnalytics() {
    this.send('analytics.unsubscribe', { agent_id: this.agentId })
  }

  // --- Messaging ---

  sendMessage(params: {
    text?: string
    threadId?: string
    content?: SendContentPart[]
  }): Promise<{ threadId: string }> {
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
              return { type: 'audio', duration: p.duration }
            case 'image':
              return { type: 'image' }
            case 'document':
              return { type: 'document' }
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

    this.send('event.create', {
      thread_id: params.threadId,
      client_event_id: clientEventId,
      event: {
        type: 'message' as const,
        actor: 'user' as const,
        content,
      },
    })

    return promise
  }

  sendFormResponse(params: {
    threadId: string
    formEventId: string
    cancelled: boolean
    values: Record<string, unknown>
  }): Promise<{ threadId: string }> {
    const clientEventId = crypto.randomUUID()
    const promise = this.createPendingPromise(clientEventId)

    this.send('event.create', {
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
    })

    return promise
  }

  // --- Private ---

  private createPendingPromise(clientEventId: string): Promise<{ threadId: string }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingMessages.delete(clientEventId)
        reject(new Error('Request timed out waiting for server response'))
      }, SEND_MESSAGE_TIMEOUT)

      this.pendingMessages.set(clientEventId, { resolve, timer })
    })
  }

  private createConnection() {
    if (this.ws) {
      this.ws.onopen = null
      this.ws.onmessage = null
      this.ws.onclose = null
      this.ws.onerror = null
      this.ws.close()
    }

    this.ws = new WebSocket(this.url)

    this.ws.onopen = () => {
      this.authenticate()
    }

    this.ws.onmessage = (e: MessageEvent) => {
      try {
        const frame = JSON.parse(e.data as string) as ServerToClient
        this.route(frame)
      } catch {
        // Ignore malformed frames
      }
    }

    this.ws.onclose = () => {
      if (!this.isIntentionallyClosed) {
        this.scheduleReconnect()
      }
    }

    this.ws.onerror = () => {
      // onclose will fire after onerror
    }
  }

  private authenticate() {
    this.connectFrameId = crypto.randomUUID()
    this.sendRaw({
      id: this.connectFrameId,
      type: 'connect',
      payload: {
        agent_id: this.agentId,
        organization_id: this.config.organizationId ?? '',
        workspace_id: this.config.workspaceId ?? '',
        user: {
          user_id: this.config.userId ?? '',
          user_name: this.config.userName ?? null,
          user_email: this.config.userEmail ?? null,
          identity_ids: this.config.identityIds ?? [],
          system_role: this.config.systemRole ?? 'user',
          organization_role: this.config.organizationRole ?? 'member',
          workspace_role: this.config.workspaceRole ?? 'member',
        },
        auth_token: this.config.authToken,
        client: { name: 'dooers-agents-client', version: '0.1.0' },
      },
    })
  }

  private route(frame: ServerToClient) {
    switch (frame.type) {
      case 'ack': {
        if (frame.payload.ack_id === this.connectFrameId) {
          if (frame.payload.ok) {
            this.callbacks.setConnectionStatus('connected')
            this.callbacks.resetReconnect()
            this.requestThreadList()
            // Re-subscribe to previously tracked threads
            for (const threadId of this.subscriptionRefs.keys()) {
              const afterEventId = this.lastEventIds.get(threadId) ?? null
              this.send('thread.subscribe', {
                thread_id: threadId,
                after_event_id: afterEventId,
              })
            }
          } else {
            this.callbacks.setConnectionStatus('error', frame.payload.error?.message)
          }
        } else if (!frame.payload.ok && frame.payload.error) {
          this.onError?.({
            code: frame.payload.error.code,
            message: frame.payload.error.message,
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
        } else {
          this.callbacks.onThreadList(threads, cursor, totalCount)
        }
        this.isLoadingMore = false
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
        this.callbacks.onThreadSnapshot(thread, events, runs)
        break
      }

      case 'event.append': {
        const events = this.resolveEventUrls(frame.payload.events.map(toThreadEvent))
        // Collect reconciled client event IDs and resolve pending message promises
        const resolvedClientEventIds: string[] = []
        for (const event of events) {
          if (event.clientEventId && this.pendingOptimistic.has(event.clientEventId)) {
            resolvedClientEventIds.push(event.clientEventId)
            this.pendingOptimistic.delete(event.clientEventId)
          }
          if (event.clientEventId && this.pendingMessages.has(event.clientEventId)) {
            const pendingMessage = this.pendingMessages.get(event.clientEventId)
            if (pendingMessage) {
              clearTimeout(pendingMessage.timer)
              pendingMessage.resolve({ threadId: frame.payload.thread_id })
              this.pendingMessages.delete(event.clientEventId)
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

      case 'thread.upsert':
        this.callbacks.onThreadUpsert(toThread(frame.payload.thread))
        break

      case 'thread.deleted':
        this.callbacks.onThreadDeleted(frame.payload.thread_id)
        this.lastEventIds.delete(frame.payload.thread_id)
        break

      case 'run.upsert':
        this.callbacks.onRunUpsert(toRun(frame.payload.run))
        break

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

      case 'settings.public_schema.result':
        break

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
    }
  }

  private scheduleReconnect() {
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.callbacks.setReconnectFailed()
      this.callbacks.setConnectionStatus('error', 'Connection lost after maximum retries')
      return
    }
    this.callbacks.setConnectionStatus('disconnected')
    const delay = RECONNECT_DELAYS[this.reconnectAttempts] ?? 16000
    this.reconnectAttempts++
    this.reconnectTimer = setTimeout(() => {
      this.callbacks.setConnectionStatus('connecting')
      this.createConnection()
    }, delay)
  }

  private send(type: string, payload: unknown) {
    this.sendRaw({ id: crypto.randomUUID(), type, payload })
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
}
