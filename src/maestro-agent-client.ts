// Transporte Maestro atrás da API legada (AgentProvider + hooks). O chat existente
// continua chamando os mesmos métodos; aqui eles viram HTTP/WS do Maestro e o
// estado canônico do MaestroStore é projetado no store legado.
import { AgentClient, type AgentConnectionConfig, type UploadResult } from './client'
import { MaestroClient } from './maestro/client'
import type { MaestroStore, MaestroThreadState } from './maestro/store'
import type { MaestroClientConfig, MaestroCredential, MaestroScope } from './maestro/types'
import { MaestroClientError } from './maestro/types'
import {
  legacyContentToMaestro,
  legacyFormValuesToMaestro,
  type MaestroNameResolver,
  maestroEventToLegacy,
  maestroExecutionToRun,
  maestroLegacyServerVersion,
  maestroThreadHasAgent,
  maestroThreadToLegacy,
} from './maestro-legacy'
import type { AgentActions } from './store'
import type {
  ChatContext,
  DisplayContentPart,
  SendContentPart,
  Thread,
  ThreadArtifact,
  ThreadEvent,
} from './types'

/** Configuração do transporte Maestro. Presente ⇒ o agente selecionado é servido pelo Maestro. */
export interface AgentMaestroOptions {
  /** Origem HTTP da API Maestro (configuração da aplicação, nunca do agente). */
  endpoint: string
  apiPrefix?: string
  allowInsecureLocalhost?: boolean
  /** Escopo da sessão humana: principal, organização e workspace (null = pessoal). */
  scope: MaestroScope
  /** Credencial humana emitida pelo core; uma função é chamada a cada (re)autenticação. */
  authToken: MaestroCredential
  /** Nome real de pessoas/agentes pelo id (o Maestro só guarda "Humano"/"Agente"). */
  resolveName?: MaestroNameResolver
  /** Liga formulários duráveis (interaction.respond). Desligado por padrão. */
  forms?: boolean
  /** Intervalo de releitura da lista de threads do agente (ms). 0 desliga. Padrão 15 s. */
  threadListPollMs?: number
  /** Injeção para testes/ambientes sem browser. */
  fetch?: MaestroClientConfig['fetch']
  socketFactory?: MaestroClientConfig['socketFactory']
}

const LIST_PAGE_SIZE = 100
const LIST_MAX_PAGES = 5
const PENDING_RUN_PREFIX = 'maestro-pending:'

type Retained = { count: number; release: () => void }

function errorMessage(cause: unknown): string {
  if (cause instanceof Error && cause.message) return cause.message
  return 'Maestro request failed'
}

/**
 * Repete uma vez, com a mesma chave de idempotência, quando o Maestro devolve uma falha
 * transitória (ex.: CORE_UNAVAILABLE na autorização). A chave impede efeito duplicado.
 */
async function onceMore<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (cause) {
    if (
      !(cause instanceof MaestroClientError) ||
      !(cause.retryable || cause.code === 'CORE_UNAVAILABLE')
    )
      throw cause
    await new Promise((resolve) => setTimeout(resolve, 750))
    return operation()
  }
}

function titleFrom(params: { text?: string; content?: SendContentPart[] }): string {
  const text =
    params.text ??
    params.content?.find(
      (part): part is Extract<SendContentPart, { type: 'text' }> => part.type === 'text'
    )?.text ??
    ''
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > 80 ? `${clean.slice(0, 77)}…` : clean
}

export class MaestroAgentClient extends AgentClient {
  readonly transport = 'maestro' as const
  private maestro: MaestroClient | null = null
  private agentPrincipalId = ''
  private user: AgentConnectionConfig = { organizationId: '', workspaceId: '', userId: '' }
  private subscriptions: (() => void)[] = []
  private retained = new Map<string, Retained>()
  private snapshotted = new Set<string>()
  private eventSignatures = new Map<string, Map<string, string>>()
  private threadSignatures = new Map<string, string>()
  private runSignatures = new Map<string, string>()
  private runStarts = new Map<string, string>()
  private feedbackSignatures = new Map<string, string>()
  private pendingClientEvents = new Map<string, string>()
  private listCursor: string | null = null
  private listing: Promise<void> | null = null
  private listAgain = false
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private refreshTimer: ReturnType<typeof setTimeout> | null = null
  private reauthenticated = false
  private closed = true

  constructor(
    callbacks: AgentActions,
    private readonly options: AgentMaestroOptions
  ) {
    super(callbacks)
  }

  /** Reprojeta threads e eventos já exibidos (ex.: nomes resolvidos depois da carga). */
  refreshProjection() {
    const maestro = this.maestro
    if (!maestro) return
    this.threadSignatures.clear()
    for (const known of this.eventSignatures.values()) known.clear()
    this.sync(maestro.store)
    this.requestThreadList()
  }

  /** Cliente Maestro subjacente (para diagnóstico/testes). */
  getMaestroClient(): MaestroClient | null {
    return this.maestro
  }

  override updateConnectionConfig(config: Partial<AgentConnectionConfig>) {
    super.updateConnectionConfig(config)
    this.user = { ...this.user, ...config }
  }

  override isConnected(): boolean {
    return this.maestro?.getConnection().status === 'connected'
  }

  override connect(_url: string, agentId: string, config?: AgentConnectionConfig) {
    this.teardown()
    this.closed = false
    this.agentPrincipalId = agentId.trim().toLowerCase()
    this.user = config ?? { organizationId: '', workspaceId: '', userId: '' }
    super.updateConnectionConfig(this.user)
    const maestro = new MaestroClient({
      mode: 'maestro',
      endpoint: this.options.endpoint,
      ...(this.options.apiPrefix ? { apiPrefix: this.options.apiPrefix } : {}),
      scope: this.options.scope,
      authToken: this.options.authToken,
      allowInsecureLocalhost: this.options.allowInsecureLocalhost === true,
      durableForms: this.options.forms === true,
      maxThreads: 1000,
      maxReconnectAttempts: 8,
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
      ...(this.options.socketFactory ? { socketFactory: this.options.socketFactory } : {}),
      onError: (failure) => this.report(failure),
    })
    this.maestro = maestro
    this.subscriptions.push(maestro.subscribeConnection(() => this.onConnection(maestro)))
    this.subscriptions.push(maestro.store.subscribe(() => this.sync(maestro.store)))
    this.callbacks.setConnectionStatus('connecting')
    void maestro.connect().catch(() => {})
  }

  override disconnect() {
    this.teardown()
    this.callbacks.setConnectionStatus('disconnected')
  }

  override retry() {
    this.reauthenticated = false
    this.callbacks.resetReconnect()
    this.callbacks.setConnectionStatus('connecting')
    void this.maestro?.connect().catch(() => {})
  }

  private teardown() {
    this.closed = true
    if (this.pollTimer) clearInterval(this.pollTimer)
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    this.pollTimer = null
    this.refreshTimer = null
    for (const unsubscribe of this.subscriptions.splice(0)) unsubscribe()
    for (const ref of this.retained.values()) ref.release()
    this.retained.clear()
    this.snapshotted.clear()
    this.eventSignatures.clear()
    this.threadSignatures.clear()
    this.runSignatures.clear()
    this.feedbackSignatures.clear()
    this.pendingClientEvents.clear()
    this.listCursor = null
    this.maestro?.dispose()
    this.maestro = null
  }

  private report(failure: unknown) {
    const error =
      failure instanceof MaestroClientError
        ? failure
        : new MaestroClientError('MAESTRO_ERROR', errorMessage(failure))
    this.onError?.({ code: error.code, message: error.message, frameType: 'maestro' })
  }

  private onConnection(maestro: MaestroClient) {
    if (this.maestro !== maestro || this.closed) return
    const connection = maestro.getConnection()
    switch (connection.status) {
      case 'connected': {
        this.reauthenticated = false
        this.callbacks.setServerVersion(
          maestroLegacyServerVersion(connection.handshake?.serverVersion)
        )
        this.callbacks.setConnectionStatus('connected')
        this.callbacks.resetReconnect()
        this.armRefresh(maestro, connection.handshake?.expiresAt)
        this.startPolling()
        this.requestThreadList()
        break
      }
      case 'refreshing':
        // Renovação de credencial com a conexão aberta: o chat continua utilizável.
        break
      case 'connecting':
      case 'reconnecting':
        this.callbacks.setConnectionStatus('connecting')
        break
      case 'disconnected':
        this.callbacks.setConnectionStatus('disconnected')
        break
      case 'unauthenticated':
        // Credencial expirada/recusada: uma nova emissão pelo core antes de desistir.
        if (!this.reauthenticated) {
          this.reauthenticated = true
          this.callbacks.setConnectionStatus('connecting')
          void maestro.connect().catch(() => {})
        } else {
          this.callbacks.setConnectionStatus('error', 'Maestro: authentication required')
        }
        break
      case 'failed':
        this.callbacks.setReconnectFailed()
        this.callbacks.setConnectionStatus('error', 'Maestro unavailable')
        break
    }
  }

  private armRefresh(maestro: MaestroClient, expiresAt: string | undefined) {
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    this.refreshTimer = null
    const expiry = expiresAt ? Date.parse(expiresAt) : Number.NaN
    if (!Number.isFinite(expiry)) return
    const wait = Math.max(1_000, expiry - Date.now() - 30_000)
    this.refreshTimer = setTimeout(() => {
      if (this.maestro === maestro) void maestro.refreshAuth().catch(() => {})
    }, wait)
  }

  private startPolling() {
    const interval = this.options.threadListPollMs ?? 15_000
    if (this.pollTimer || interval <= 0) return
    this.pollTimer = setInterval(() => {
      if (this.isConnected()) this.requestThreadList()
    }, interval)
  }

  // --- Lista de threads do agente selecionado ---

  private legacyThread(thread: Parameters<typeof maestroThreadToLegacy>[0]): Thread {
    return maestroThreadToLegacy(thread, this.agentPrincipalId, this.options.resolveName)
  }

  private async collect(cursor: string | undefined, wanted: number) {
    const maestro = this.maestro
    if (!maestro) return { threads: [] as Thread[], cursor: null as string | null }
    const threads: Thread[] = []
    let next = cursor
    let pages = 0
    do {
      const page = await maestro.listThreads({
        ...(next ? { cursor: next } : {}),
        limit: LIST_PAGE_SIZE,
      })
      for (const thread of page.items)
        if (maestroThreadHasAgent(thread, this.agentPrincipalId))
          threads.push(this.legacyThread(thread))
      next = page.hasMore && page.nextCursor ? page.nextCursor : undefined
      pages++
    } while (next && pages < LIST_MAX_PAGES && threads.length < wanted)
    threads.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    return { threads, cursor: next ?? null }
  }

  override requestThreadList(_cursor?: string | null, limit?: number, _queue?: string | null) {
    if (!this.maestro || !this.isConnected()) return
    if (this.listing) {
      this.listAgain = true
      return
    }
    const sentAt = Date.now()
    const maestro = this.maestro
    this.listing = this.collect(undefined, limit ?? 50)
      .then(({ threads, cursor }) => {
        if (this.maestro !== maestro) return
        this.listCursor = cursor
        this.callbacks.onThreadList(threads, cursor, threads.length, null, sentAt)
      })
      .catch((cause) => this.report(cause))
      .finally(() => {
        this.listing = null
        if (this.listAgain) {
          this.listAgain = false
          this.requestThreadList()
        }
      })
  }

  override loadMoreThreads(limit?: number) {
    const cursor = this.listCursor
    if (!cursor || this.listing || !this.maestro) return
    const maestro = this.maestro
    this.listing = this.collect(cursor, limit ?? 50)
      .then(({ threads, cursor: next }) => {
        if (this.maestro !== maestro) return
        this.listCursor = next
        this.callbacks.onThreadListAppend(threads, next)
      })
      .catch((cause) => this.report(cause))
      .finally(() => {
        this.listing = null
      })
  }

  /** Filas não existem no Maestro. */
  override updateThread(_threadId: string, _patch: { queue?: string | null }) {}

  // --- Assinatura de threads e projeção no store legado ---

  override subscribe(threadId: string, _options?: { accessReason?: string }) {
    const maestro = this.maestro
    if (!maestro) return
    let id: string
    try {
      id = maestro.normalizeThreadId(threadId)
    } catch {
      return
    }
    const current = this.retained.get(id)
    if (current) {
      current.count++
      return
    }
    this.callbacks.addSubscription(id)
    this.retained.set(id, { count: 1, release: maestro.retainThread(id) })
    // A projeção atual do leitor (permissões, participantes) vem do GET da thread.
    void maestro.getThread(id).catch((cause) => {
      if (this.maestro !== maestro) return
      this.report(cause)
      if (cause instanceof MaestroClientError && ['NOT_FOUND', 'FORBIDDEN'].includes(cause.code))
        this.callbacks.removeSubscription(id)
    })
    this.sync(maestro.store)
  }

  override unsubscribe(threadId: string) {
    const id = threadId.toLowerCase()
    const ref = this.retained.get(id)
    if (!ref) return
    if (ref.count > 1) {
      ref.count--
      return
    }
    ref.release()
    this.retained.delete(id)
    this.snapshotted.delete(id)
    this.eventSignatures.delete(id)
    this.threadSignatures.delete(id)
    this.callbacks.removeSubscription(id)
  }

  override loadOlderEvents(threadId: string, limit?: number) {
    const maestro = this.maestro
    if (!maestro) return
    const id = threadId.toLowerCase()
    void maestro
      .loadBefore(id, limit ? { limit } : {})
      .then(() => {
        const state = maestro.store.getThread(id)
        this.callbacks.onEventListResult(id, [], null, Boolean(state?.historyHasMore))
      })
      .catch((cause) => this.report(cause))
  }

  private legacyEvents(state: MaestroThreadState): ThreadEvent[] {
    const events: ThreadEvent[] = []
    for (const eventId of state.eventIds) {
      const item = state.eventsById[eventId]
      if (!item) continue
      const mapped = maestroEventToLegacy(item, this.options.resolveName)
      if (mapped) events.push(mapped)
    }
    return events
  }

  private agentOfParticipant(state: MaestroThreadState, participantId: string): string | null {
    const participant = state.participantsById[participantId]
    return participant?.kind === 'agent' ? participant.instanceAgentId : null
  }

  private syncRuns(id: string, state: MaestroThreadState) {
    let running = false
    for (const execution of Object.values(state.executionsById)) {
      if (!this.runStarts.has(execution.execution_id))
        this.runStarts.set(execution.execution_id, new Date().toISOString())
      const run = maestroExecutionToRun(
        execution,
        id,
        this.agentOfParticipant(state, execution.participant_id),
        this.runStarts.get(execution.execution_id) as string
      )
      if (run.status === 'running') running = true
      const signature = JSON.stringify(run)
      if (this.runSignatures.get(run.id) === signature) continue
      this.runSignatures.set(run.id, signature)
      this.callbacks.onRunUpsert(run)
    }
    // Entrega pendente antes de a execução começar também mostra "aguardando resposta".
    const pendingId = `${PENDING_RUN_PREFIX}${id}`
    const pending = state.hasPendingWork && !state.waitingForInput && !running
    const previous = this.runSignatures.get(pendingId)
    const status = pending ? 'running' : 'succeeded'
    if (previous === status || (previous === undefined && !pending)) return
    this.runSignatures.set(pendingId, status)
    if (!this.runStarts.has(pendingId)) this.runStarts.set(pendingId, new Date().toISOString())
    this.callbacks.onRunUpsert({
      id: pendingId,
      threadId: id,
      agentId: null,
      status,
      startedAt: this.runStarts.get(pendingId) as string,
      endedAt: pending ? null : new Date().toISOString(),
      error: null,
    })
  }

  private syncFeedback(state: MaestroThreadState) {
    const principal = this.options.scope.principalId
    for (const eventId of state.eventIds) {
      const item = state.eventsById[eventId]
      if (!item?.known || item.event.type !== 'feedback.updated') continue
      const payload = item.event.payload
      if (payload.principal_id !== principal || !payload.feedback.value) continue
      const value = payload.feedback.value === 'positive' ? 'like' : 'dislike'
      const key = payload.target_event_id
      const signature = `${payload.feedback.version}:${value}`
      if (this.feedbackSignatures.get(key) === signature) continue
      this.feedbackSignatures.set(key, signature)
      this.callbacks.onFeedbackAck(key, value)
    }
  }

  private sync(store: MaestroStore) {
    if (!this.maestro || this.maestro.store !== store) return
    for (const id of this.retained.keys()) {
      const state = store.getThread(id)
      if (!state) continue
      if (!this.snapshotted.has(id)) {
        if (state.phase === 'revoked' || state.phase === 'failed') {
          if (state.error) this.report(state.error)
          continue
        }
        if (!state.thread || state.phase !== 'live') continue
        const events = this.legacyEvents(state)
        this.snapshotted.add(id)
        this.eventSignatures.set(
          id,
          new Map(events.map((event) => [event.id, JSON.stringify(event)]))
        )
        const thread = this.legacyThread(state.thread)
        this.threadSignatures.set(id, JSON.stringify(thread))
        this.callbacks.onThreadSnapshot(
          thread,
          events,
          [],
          state.historyHasMore && !!state.beforeCursor
        )
        for (const event of events)
          if (event.clientEventId) this.pendingClientEvents.delete(event.clientEventId)
        this.syncRuns(id, state)
        this.syncFeedback(state)
        continue
      }
      if (state.thread) {
        const thread = this.legacyThread(state.thread)
        const signature = JSON.stringify(thread)
        if (this.threadSignatures.get(id) !== signature) {
          this.threadSignatures.set(id, signature)
          this.callbacks.onThreadUpsert(thread)
        }
      }
      const known = this.eventSignatures.get(id) ?? new Map<string, string>()
      this.eventSignatures.set(id, known)
      const changed: ThreadEvent[] = []
      for (const event of this.legacyEvents(state)) {
        const signature = JSON.stringify(event)
        if (known.get(event.id) === signature) continue
        known.set(event.id, signature)
        changed.push(event)
      }
      if (changed.length) {
        const resolved = changed
          .map((event) => event.clientEventId)
          .filter((key): key is string => !!key && this.pendingClientEvents.has(key))
        for (const key of resolved) this.pendingClientEvents.delete(key)
        if (resolved.length) this.callbacks.reconcileEvents(id, changed, resolved)
        else this.callbacks.onEventAppend(id, changed)
      }
      this.syncRuns(id, state)
      this.syncFeedback(state)
    }
  }

  // --- Mensagens, participantes, formulários, feedback, anexos ---

  override async sendMessage(params: {
    text?: string
    threadId?: string
    content?: SendContentPart[]
    metadata?: Record<string, unknown>
    chatContext?: ChatContext
    queue?: string | null
  }): Promise<{ threadId: string }> {
    this.callbacks.setSendError(null)
    const maestro = this.maestro
    if (!maestro) throw new Error('Not connected')
    const content = legacyContentToMaestro(params)
    if (!content.length) throw new Error('Message must contain text or an attachment')
    const clientEventId = crypto.randomUUID()
    let threadId = params.threadId?.toLowerCase()
    try {
      if (!threadId) {
        const key = crypto.randomUUID()
        const request = {
          title: titleFrom(params),
          participants: [{ kind: 'agent' as const, principal_id: this.agentPrincipalId }],
        }
        const created = await onceMore(() => maestro.createThread(request, key))
        threadId = created.threadId
        this.callbacks.onThreadUpsert(this.legacyThread(created))
      } else {
        this.pendingClientEvents.set(clientEventId, threadId)
        this.callbacks.addOptimistic(
          threadId,
          this.optimistic(threadId, params, clientEventId),
          clientEventId
        )
      }
      await maestro.send({ threadId, content, clientEventId })
      return { threadId }
    } catch (cause) {
      if (threadId && this.pendingClientEvents.delete(clientEventId))
        this.callbacks.removeOptimistic(threadId, clientEventId)
      const message = errorMessage(cause)
      this.callbacks.setSendError(message)
      throw cause instanceof Error ? cause : new Error(message)
    }
  }

  private optimistic(
    threadId: string,
    params: { text?: string; content?: SendContentPart[] },
    clientEventId: string
  ): ThreadEvent {
    const content: DisplayContentPart[] = (
      params.content ?? [{ type: 'text', text: params.text ?? '' }]
    ).map(
      (part): DisplayContentPart =>
        part.type === 'text'
          ? { type: 'text', text: part.text }
          : part.type === 'audio'
            ? { type: 'audio', ...(part.mimeType ? { mimeType: part.mimeType } : {}) }
            : {
                type: part.type,
                refId: part.refId,
                ...(part.filename ? { filename: part.filename } : {}),
                ...(part.mimeType ? { mimeType: part.mimeType } : {}),
              }
    )
    return {
      id: `optimistic-${clientEventId}`,
      threadId,
      runId: null,
      type: 'message',
      actor: 'user',
      author: null,
      user: {
        userId: this.user.userId ?? '',
        userName: this.user.userName,
        userEmail: this.user.userEmail,
        identityIds: this.user.identityIds,
        systemRole: this.user.systemRole ?? 'user',
        organizationRole: this.user.organizationRole ?? 'member',
        workspaceRole: this.user.workspaceRole ?? 'member',
      },
      content,
      createdAt: new Date().toISOString(),
      clientEventId,
    }
  }

  /** Adiciona pessoa ou agente. Falhas são reportadas por ``onError``; a promise não rejeita. */
  override addParticipant(
    threadId: string,
    user: {
      userId: string
      userName?: string | null
      userEmail?: string | null
      identityIds?: string[]
      kind?: 'human' | 'agent'
    }
  ): Promise<boolean> {
    const maestro = this.maestro
    if (!maestro) return Promise.resolve(false)
    const id = threadId.toLowerCase()
    const kind = user.kind ?? 'human'
    const key = crypto.randomUUID()
    const target =
      kind === 'agent'
        ? {
            kind: 'agent' as const,
            principal_id: user.userId.toLowerCase(),
            role: 'member' as const,
          }
        : { kind: 'human' as const, principal_id: user.userId, role: 'member' as const }
    return onceMore(() => maestro.addParticipant(id, target, key))
      .then(() => {
        this.requestThreadList()
        return true
      })
      .catch((cause) => {
        this.report(cause)
        this.callbacks.setSendError(`Could not add participant: ${errorMessage(cause)}`)
        return false
      })
  }

  override deleteThread(threadId: string) {
    const maestro = this.maestro
    if (!maestro) return
    const id = threadId.toLowerCase()
    const version = maestro.store.getThread(id)?.thread?.version
    void (async () => {
      const current = version ?? (await maestro.getThread(id)).version
      await maestro.deleteThread(id, current, crypto.randomUUID())
      this.callbacks.onThreadDeleted(id)
    })().catch((cause) => this.report(cause))
  }

  override sendFeedback(
    _targetType: string,
    targetId: string,
    feedback: 'like' | 'dislike',
    reason?: string,
    classification?: string
  ) {
    const maestro = this.maestro
    if (!maestro) return
    const eventId = targetId.toLowerCase()
    const threadId = [...this.retained.keys()].find(
      (id) => maestro.store.getThread(id)?.eventsById[eventId]
    )
    if (!threadId) return
    const negative = feedback === 'dislike'
    void maestro.feedback
      .request({
        threadId,
        eventId,
        value: negative ? 'negative' : 'positive',
        classification: negative ? classification?.trim() || null : null,
        reason: negative ? reason?.trim() || null : null,
      })
      .then(() => this.callbacks.onFeedbackAck(eventId, feedback))
      .catch((cause) => this.report(cause))
  }

  override async sendFormResponse(params: {
    threadId: string
    formEventId: string
    cancelled: boolean
    values: Record<string, unknown>
    metadata?: Record<string, unknown>
  }): Promise<{ threadId: string }> {
    const maestro = this.maestro
    if (!maestro) throw new Error('Not connected')
    const threadId = params.threadId.toLowerCase()
    const view = maestro.interactions.current(threadId, params.formEventId)
    if (!view || view.interaction.definition.kind !== 'form')
      throw new Error('Form is not available in this conversation')
    try {
      await maestro.interactions.request(
        threadId,
        view.interaction.interaction_id,
        params.cancelled
          ? { action: 'cancel', data: {} }
          : {
              action: 'submit',
              data: legacyFormValuesToMaestro(view.interaction.definition.fields, params.values),
            }
      )
      return { threadId }
    } catch (cause) {
      const message = errorMessage(cause)
      this.callbacks.setSendError(message)
      throw cause instanceof Error ? cause : new Error(message)
    }
  }

  override async upload(file: File | Blob, options?: { filename?: string }): Promise<UploadResult> {
    const maestro = this.maestro
    if (!maestro) throw new Error('Not connected')
    const filename =
      options?.filename?.trim() || (file instanceof File ? file.name : '') || 'upload'
    const id = maestro.artifacts.add(file, filename)
    try {
      await maestro.artifacts.retry(id)
      const artifact = maestro.artifacts.getSnapshot().find((draft) => draft.id === id)?.artifact
      if (!artifact) throw new Error('Upload failed')
      return {
        refId: artifact.artifact_id,
        mimeType: artifact.mime_type,
        filename: artifact.filename,
        sizeBytes: artifact.size_bytes,
      }
    } finally {
      // O artefato fica ready_unbound no servidor e é vinculado ao enviar a mensagem.
      maestro.artifacts.remove(id)
    }
  }

  /** Arquivos citados nas mensagens já carregadas (sem URL: leitura exige proxy autenticado). */
  override requestThreadArtifactsList(
    threadId: string,
    _options?: { cursor?: string | null; limit?: number; direction?: 'in' | 'out' | 'all' }
  ): Promise<{ artifacts: ThreadArtifact[]; cursor: string | null; hasMore: boolean }> {
    const state = this.maestro?.store.getThread(threadId.toLowerCase())
    const artifacts: ThreadArtifact[] = []
    for (const eventId of state?.eventIds ?? []) {
      const item = state?.eventsById[eventId]
      if (!item?.known || item.event.type !== 'message.created') continue
      const event = item.event
      for (const part of event.payload.content) {
        if (part.type !== 'attachment') continue
        const mime = part.mime_type ?? ''
        artifacts.push({
          eventId: event.eventId,
          direction: event.actor.kind === 'human' ? 'in' : 'out',
          kind: mime.startsWith('image/')
            ? 'image'
            : mime.startsWith('audio/')
              ? 'audio'
              : 'document',
          filename: part.filename ?? null,
          mimeType: part.mime_type ?? null,
          url: null,
          refId: part.artifact_id,
          createdAt: event.createdAt,
          userId: event.actor.principalId,
          userName: event.actor.displayName,
        })
      }
    }
    return Promise.resolve({ artifacts: artifacts.reverse(), cursor: null, hasMore: false })
  }

  // Configurações privadas e analytics do agente continuam no runtime legado; não há equivalente Maestro.
  override subscribeSettings() {
    this.callbacks.onSettingsSnapshot([], new Date().toISOString())
  }
  override unsubscribeSettings() {}
  override patchSetting() {}
  override fetchPublicSettingsSchema(): Promise<never> {
    return Promise.reject(new Error('Settings schema is not available through Maestro'))
  }
  override subscribeAnalytics() {}
  override unsubscribeAnalytics() {}
}
