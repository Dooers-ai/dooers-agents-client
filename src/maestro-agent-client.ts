// Transporte Maestro atrás da API legada (AgentProvider + hooks). O chat existente
// continua chamando os mesmos métodos; aqui eles viram HTTP/WS do Maestro e o
// estado canônico do MaestroStore é projetado no store legado.
import {
  AgentClient,
  type AgentConnectionConfig,
  type PublicSettingsSchemaResult,
  type UploadResult,
} from './client'
import { MaestroClient } from './maestro/client'
import type { MaestroStore, MaestroThreadState } from './maestro/store'
import type { MaestroClientConfig, MaestroCredential, MaestroScope } from './maestro/types'
import { MAESTRO_THREAD_UNREADABLE, MaestroClientError } from './maestro/types'
import {
  foldMaestroEvents,
  legacyContentToMaestro,
  legacyFormValuesToMaestro,
  type MaestroNameResolver,
  maestroEventToLegacy,
  maestroLegacyServerVersion,
  maestroParticipantLegacyId,
  maestroRunsToLegacy,
  maestroThreadHasAgent,
  maestroThreadToLegacy,
} from './maestro-legacy'
import { maestroMentions, maestroMentionsEveryone } from './maestro-mentions'
import { MaestroOutbox } from './maestro-outbox'
import type { MaestroEvent, MaestroParticipant } from './protocol/maestro/contracts'
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
  /** Enable only after every reader/runtime supports routing v1. New threads only. */
  invocationRouting?: boolean
  /** Operator-approved model catalog; server and recipient validate every override. */
  turnModels?: string[]
  /** Origem HTTP da API Maestro (configuração da aplicação, nunca do agente). */
  endpoint: string
  apiPrefix?: string
  allowInsecureLocalhost?: boolean
  /** Escopo da sessão humana: principal, organização e workspace (null = pessoal). */
  scope: MaestroScope
  /** Credencial humana emitida pelo core; uma função é chamada a cada (re)autenticação. */
  authToken: MaestroCredential
  /** Credencial com `threads:supervise`, pedida só ao abrir/renovar a supervisão (o token do chat não a tem). */
  supervisionAuthToken?: MaestroCredential
  /** Nome real de pessoas/agentes pelo id (o Maestro só guarda "Humano"/"Agente"). */
  resolveName?: MaestroNameResolver
  /** Liga formulários duráveis (interaction.respond). Desligado por padrão. */
  forms?: boolean
  /** Intervalo de releitura da lista de threads do agente (ms). 0 desliga. Padrão 15 s. */
  threadListPollMs?: number
  /**
   * Modo visitante do chat público (credencial `external`, `scope.actorType: 'external'`). Desligado por
   * padrão. Ligado: sem lista de threads, sem resolvedor de nomes, sem supervisão, sem participantes,
   * formulários só por HTTP; a thread do visitante vem de `GET/POST /public-chat/thread`.
   * `true` ou um objeto; `guest` é o pré-chat conhecido na carga (o `metadata` da primeira mensagem o substitui).
   */
  visitor?: boolean | AgentMaestroVisitorOptions
  /** Injeção para testes/ambientes sem browser. */
  fetch?: MaestroClientConfig['fetch']
  socketFactory?: MaestroClientConfig['socketFactory']
}

/** Pré-chat declarado pelo visitante (nunca verificado). Campos vazios são omitidos. */
export interface AgentMaestroVisitorGuest {
  name?: string | null
  email?: string | null
  phone?: string | null
}
export interface AgentMaestroVisitorOptions {
  guest?: AgentMaestroVisitorGuest
}

const LIST_PAGE_SIZE = 100
const LIST_MAX_PAGES = 5
const PENDING_RUN_PREFIX = 'maestro-pending:'
/** A supervision grant lasts at most 60 s: renew it this long before it expires. */
const RENEW_BEFORE_MS = 10_000
const RENEW_RETRY_MS = 3_000

type Retained = { count: number; release: () => void }
/** A conversation read by supervision (the reader does not participate). */
type Supervised = { timer: ReturnType<typeof setTimeout> | null; expiresAt: number }

/**
 * The Maestro asks for an access reason either with its own error code or as the reason code of
 * a refusal. The chat only knows the legacy code, so both become ``ACCESS_REASON_REQUIRED``.
 */
function accessFailure(cause: unknown): unknown {
  return cause instanceof MaestroClientError &&
    (cause.code === 'ACCESS_REASON_REQUIRED' || cause.reasonCode === 'access_reason_required')
    ? new MaestroClientError('ACCESS_REASON_REQUIRED', cause.message, false, cause.requestId)
    : cause
}

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

/** The longest `Retry-After` the visitor's ensure waits for before its one retry. */
const ENSURE_RETRY_AFTER_MAX_S = 3

/**
 * Ensure of the visitor's thread: a 429 with `Retry-After` up to 3 s waits that long and retries once
 * with the same key; a longer wait is surfaced (with `retryAfterSeconds`) and not retried. Any other
 * transient failure follows the ordinary single retry.
 */
async function ensureWithRetryAfter<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (cause) {
    if (
      cause instanceof MaestroClientError &&
      cause.code === 'RATE_LIMITED' &&
      cause.retryAfterSeconds !== undefined
    ) {
      if (cause.retryAfterSeconds > ENSURE_RETRY_AFTER_MAX_S) throw cause
      await new Promise((resolve) => setTimeout(resolve, cause.retryAfterSeconds! * 1000))
      return operation()
    }
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
  /** Threads being left because they cannot be read (guards the sync that leaving triggers). */
  private leaving = new Set<string>()
  private supervised = new Map<string, Supervised>()
  private snapshotted = new Set<string>()
  private eventSignatures = new Map<string, Map<string, string>>()
  private threadSignatures = new Map<string, string>()
  private runSignatures = new Map<string, string>()
  private runStarts = new Map<string, string>()
  private feedbackSignatures = new Map<string, string>()
  private pendingClientEvents = new Map<string, string>()
  private routingThreads = new Set<string>()
  private invocationSelections = new Map<string, string[]>()
  private outbox() {
    return new MaestroOutbox(
      `maestro.outbox.v1:${JSON.stringify([this.options.endpoint, this.options.scope.principalId, this.options.scope.organizationId, this.options.scope.workspaceId, this.agentPrincipalId])}:`,
      globalThis.localStorage
    )
  }
  private recoveringOutbox = false
  /** Visitante: sem resolvedor de nomes (o nome vem do próprio Maestro). */
  private readonly resolveName: MaestroNameResolver | undefined
  private readonly visitor: AgentMaestroVisitorOptions | null
  /** Visitante: a thread já foi aberta (POST ensure) nesta sessão do cliente. */
  private visitorEnsured = false
  private visitorEnsuring: Promise<string> | null = null
  private visitorThreadId: string | null = null
  /** Visitante: o GET da thread no início da sessão já respondeu (200 ou 404). */
  private visitorResolved = false
  private visitorOpening: Promise<void> | null = null
  /**
   * Visitante: leituras pedidas antes da conexão (a thread guardada pelo navegador, lida no mount, antes do
   * efeito do provider chamar `connect`). Valem como leituras normais assim que a conexão abre.
   */
  private pendingSubscriptions = new Map<
    string,
    { count: number; options?: { accessReason?: string } }
  >()
  private async recoverOutbox(maestro: MaestroClient) {
    if (this.recoveringOutbox) return
    this.recoveringOutbox = true
    try {
      for (const input of this.outbox().entries()) {
        if (this.maestro !== maestro || this.closed) break
        try {
          await maestro.send(input)
          this.outbox().remove(input.clientEventId!)
        } catch (cause) {
          if (this.visitor && cause instanceof MaestroClientError && cause.code === 'NOT_FOUND') {
            // The guest thread is gone (idle guest cleanup): the pending message can never be
            // delivered. Drop it with a visible failure instead of replaying it on every connection.
            this.outbox().remove(input.clientEventId!)
            this.callbacks.onThreadDeleted(input.threadId.toLowerCase())
            if (this.visitorThreadId === input.threadId.toLowerCase()) {
              this.visitorEnsured = false
              this.visitorThreadId = null
            }
            this.callbacks.setSendError('Mensagem pendente descartada: a conversa não existe mais')
            this.report(cause)
            continue
          }
          this.callbacks.setSendError(`Envio pendente preservado: ${errorMessage(cause)}`)
          break
        }
      }
    } catch (cause) {
      this.callbacks.setSendError(
        `Não foi possível recuperar os envios pendentes: ${errorMessage(cause)}`
      )
    } finally {
      this.recoveringOutbox = false
    }
  }
  private selectionKey(threadId: string) {
    return `maestro.invocation.v1:${JSON.stringify([this.options.scope.principalId, this.options.scope.organizationId, this.options.scope.workspaceId, threadId])}`
  }
  private selected(threadId: string): string[] {
    const cached = this.invocationSelections.get(threadId)
    if (cached) return cached
    try {
      const raw = globalThis.localStorage?.getItem(this.selectionKey(threadId))
      const value: unknown = raw ? JSON.parse(raw) : []
      if (Array.isArray(value) && value.every((id) => typeof id === 'string')) return value
    } catch {
      /* Storage may be disabled. Session memory remains usable. */
    }
    return []
  }
  private selectInvocation(threadId: string, recipients: string[]) {
    this.invocationSelections.set(threadId, [...recipients])
    try {
      globalThis.localStorage?.setItem(this.selectionKey(threadId), JSON.stringify(recipients))
    } catch {}
  }
  override clearInvocationSelection(threadId?: string) {
    this.selectInvocation(threadId?.toLowerCase() ?? 'new', [])
  }
  override getInvocationSelection(threadId?: string, text = '') {
    const id = threadId?.toLowerCase()
    if (!id && !this.options.invocationRouting) return null
    if (!id)
      return this.invocationSelections.has('new')
        ? { mode: 'none' as const, recipients: [], labels: [], invalid: false }
        : {
            mode: 'direct' as const,
            recipients: [this.agentPrincipalId],
            labels: [this.resolveName?.('agent', this.agentPrincipalId)].filter(
              (name): name is string => Boolean(name)
            ),
            invalid: false,
          }
    if (!this.routingThreads.has(id)) return null
    const participants = this.participantsByThread.get(id ?? '') ?? []
    let mentions: string[]
    try {
      mentions = maestroMentions(text, participants, this.resolveName, true)
    } catch {
      return { mode: 'none' as const, recipients: [], labels: [], invalid: true }
    }
    const all = maestroMentionsEveryone(text)
    const explicit = mentions.length > 0
    mentions = mentions.filter((id) =>
      participants.some((p) => p.participantId === id && p.kind === 'agent')
    )
    const recipients = all
      ? participants
          .filter((p) => p.kind === 'agent' && p.state === 'active')
          .map((p) => p.participantId)
      : explicit
        ? mentions
        : this.selected(id ?? 'new')
    const labels = recipients.map((recipient) => {
      const p = participants.find((p) => p.participantId === recipient)
      if (!p) return ''
      return p.kind === 'agent'
        ? this.resolveName?.('agent', p.principalId) || p.displayName
        : (p.displayName ?? '')
    })
    return {
      mode: all ? ('all' as const) : recipients.length ? ('direct' as const) : ('none' as const),
      recipients,
      labels,
      invalid: recipients.some(
        (recipient) =>
          !participants.some(
            (p) => p.participantId === recipient && p.kind === 'agent' && p.state === 'active'
          )
      ),
    }
  }
  private participantsByThread = new Map<string, readonly MaestroParticipant[]>()
  private listCursor: string | null = null
  private listing: Promise<void> | null = null
  private listAgain = false
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private refreshTimer: ReturnType<typeof setTimeout> | null = null
  /** The expiry (ms) a renewal was already attempted for: a renewal that does not move it is not repeated. */
  private renewedExpiry = Number.NEGATIVE_INFINITY
  private reauthenticated = false
  private closed = true

  constructor(
    callbacks: AgentActions,
    private readonly options: AgentMaestroOptions
  ) {
    super(callbacks)
    this.visitor = options.visitor ? (options.visitor === true ? {} : options.visitor) : null
    this.resolveName = this.visitor ? undefined : options.resolveName
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
      ...(this.options.supervisionAuthToken && !this.visitor
        ? { supervisionAuthToken: this.options.supervisionAuthToken }
        : {}),
      allowInsecureLocalhost: this.options.allowInsecureLocalhost === true,
      // The visitor answers forms over HTTP and has no per-agent options.
      durableForms: this.options.forms === true && !this.visitor,
      perAgentOptions: Boolean(this.options.turnModels?.length) && !this.visitor,
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
    for (const reading of this.supervised.values()) if (reading.timer) clearTimeout(reading.timer)
    this.supervised.clear()
    for (const ref of this.retained.values()) ref.release()
    this.retained.clear()
    this.snapshotted.clear()
    this.eventSignatures.clear()
    this.threadSignatures.clear()
    this.runSignatures.clear()
    this.feedbackSignatures.clear()
    this.pendingClientEvents.clear()
    this.listCursor = null
    this.visitorEnsured = false
    this.visitorEnsuring = null
    this.visitorThreadId = null
    this.visitorResolved = false
    this.visitorOpening = null
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
        void this.recoverOutbox(maestro)
        this.requestThreadList()
        void this.openVisitorThread(maestro)
        this.openPendingSubscriptions()
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
          // The visitor token is re-issued by the application (silent re-resolve or login): the
          // chat shows the existing reconnect-failed state and the application decides.
          if (this.visitor) this.callbacks.setReconnectFailed()
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
    // The core caps the token at the end of the session, so near that end a renewal returns the same
    // expiry. Renewing again would loop (and trip the exchange rate limit): the renewal stays once per
    // expiry and the end of the session reaches the application as the usual 401 of the exchange.
    if (expiry <= this.renewedExpiry) return
    const wait = Math.max(1_000, expiry - Date.now() - 30_000)
    this.refreshTimer = setTimeout(() => {
      if (this.maestro !== maestro) return
      this.renewedExpiry = expiry
      void maestro.refreshAuth().catch(() => {})
    }, wait)
  }

  private startPolling() {
    const interval = this.visitor ? 0 : (this.options.threadListPollMs ?? 15_000)
    if (this.pollTimer || interval <= 0) return
    this.pollTimer = setInterval(() => {
      if (this.isConnected()) this.requestThreadList()
    }, interval)
  }

  // --- Lista de threads do agente selecionado ---

  private legacyThread(thread: Parameters<typeof maestroThreadToLegacy>[0]): Thread {
    // Participantes vistos por último, para transformar "@Nome" do texto em menção no envio.
    this.participantsByThread.set(thread.threadId.toLowerCase(), thread.participants)
    if (thread.routingVersion === 1) this.routingThreads.add(thread.threadId.toLowerCase())
    return maestroThreadToLegacy(thread, this.agentPrincipalId, this.resolveName)
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
    // The visitor has one thread and the list is closed to it: nothing to read.
    if (this.visitor) return
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
    if (this.visitor || !cursor || this.listing || !this.maestro) return
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

  /**
   * Participants read through the ordinary subscription. A reader who does not participate is
   * refused by the Maestro (404/403); if their role allows it they read by supervision instead,
   * with the access reason when the policy asks for one (``ACCESS_REASON_REQUIRED`` otherwise).
   */
  override subscribe(threadId: string, options?: { accessReason?: string }) {
    const maestro = this.maestro
    if (!maestro) {
      // A visitor's page that reloads with a stored thread asks for it before the connection exists:
      // keep the request for the connection to serve (the other modes keep their behaviour).
      if (this.visitor) {
        const id = threadId.toLowerCase()
        const pending = this.pendingSubscriptions.get(id)
        if (pending) pending.count++
        else this.pendingSubscriptions.set(id, { count: 1, ...(options ? { options } : {}) })
      }
      return
    }
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
    const entry: Retained = { count: 1, release: maestro.retainThread(id) }
    this.retained.set(id, entry)
    // A projeção atual do leitor (permissões, participantes) vem do GET da thread.
    void maestro.getThread(id).catch((cause) => {
      if (this.maestro !== maestro || this.retained.get(id) !== entry) return
      if (this.visitor && cause instanceof MaestroClientError && cause.code === 'NOT_FOUND') {
        // The thread this page stored is gone (the Maestro removes idle guest threads). Leave it so the
        // chat shows the empty thread, not a load that never ends; the first message opens a new one.
        this.dropSubscription(id)
      }
      if (
        !this.visitor &&
        cause instanceof MaestroClientError &&
        ['NOT_FOUND', 'FORBIDDEN'].includes(cause.code)
      ) {
        void this.supervise(maestro, id, entry, options?.accessReason)
        return
      }
      this.report(cause)
    })
    this.sync(maestro.store)
  }

  /** Serves, on the open connection, the reads asked for before it existed. */
  private openPendingSubscriptions() {
    const pending = [...this.pendingSubscriptions]
    this.pendingSubscriptions.clear()
    for (const [id, { count, options }] of pending)
      for (let holder = 0; holder < count; holder++) this.subscribe(id, options)
  }

  override unsubscribe(threadId: string) {
    const id = threadId.toLowerCase()
    const waiting = this.pendingSubscriptions.get(id)
    if (waiting) {
      if (waiting.count > 1) waiting.count--
      else this.pendingSubscriptions.delete(id)
      return
    }
    const ref = this.retained.get(id)
    if (!ref) return
    if (ref.count > 1) {
      ref.count--
      return
    }
    this.dropSubscription(id)
  }

  private dropSubscription(id: string) {
    // The grant goes first: closing the thread while it is still retained wipes what supervision showed.
    this.endSupervision(id)
    this.retained.get(id)?.release()
    this.retained.delete(id)
    this.snapshotted.delete(id)
    this.eventSignatures.delete(id)
    this.threadSignatures.delete(id)
    this.callbacks.removeSubscription(id)
  }

  // --- Leitura por supervisão (quem não participa) ---

  private async supervise(
    maestro: MaestroClient,
    id: string,
    entry: Retained,
    reason: string | undefined
  ) {
    // The ordinary subscription was refused; a grant must exist before the wire subscription.
    entry.release()
    entry.release = () => {}
    const live = () => this.maestro === maestro && this.retained.get(id) === entry
    try {
      const grant = await onceMore(() => maestro.openSupervision(id, reason, crypto.randomUUID()))
      if (!live()) {
        maestro.closeThread(id)
        return
      }
      this.armRenewal(maestro, id, grant.expires_at)
      entry.release = maestro.retainThread(id)
    } catch (cause) {
      if (!live()) return
      this.dropSubscription(id)
      this.report(accessFailure(cause))
      return
    }
    this.sync(maestro.store)
    void maestro.getThread(id).catch((cause) => {
      if (!live()) return
      this.dropSubscription(id)
      this.report(cause)
    })
  }

  private armRenewal(maestro: MaestroClient, id: string, expiresAt: string) {
    const previous = this.supervised.get(id)
    if (previous?.timer) clearTimeout(previous.timer)
    const expires = Date.parse(expiresAt)
    this.supervised.set(id, {
      expiresAt: expires,
      timer: setTimeout(
        () => this.renew(maestro, id),
        Math.max(1_000, expires - Date.now() - RENEW_BEFORE_MS)
      ),
    })
  }

  /**
   * Keeps the conversation readable while it stays subscribed: a new grant, then the wire
   * subscription (bound to one grant, revoked by the Maestro when it expires) moves onto it.
   * The reason is not sent again; the Maestro remembers an accepted one until the end of the UTC day.
   */
  private renew(maestro: MaestroClient, id: string) {
    const reading = this.supervised.get(id)
    const entry = this.retained.get(id)
    if (!reading || !entry || this.maestro !== maestro) return
    const live = () => this.maestro === maestro && this.retained.get(id) === entry
    void (async () => {
      try {
        const grant = await maestro.openSupervision(id, undefined, crypto.randomUUID())
        if (!live()) return
        this.armRenewal(maestro, id, grant.expires_at)
        const phase = maestro.store.getThread(id)?.phase
        if (phase === 'revoked' || phase === 'failed') {
          // The previous grant lapsed before the renewal ran: subscribe again from scratch.
          entry.release()
          entry.release = maestro.retainThread(id)
        } else maestro.retryReplay(id)
      } catch (cause) {
        if (!live()) return
        const transient =
          cause instanceof MaestroClientError &&
          (cause.retryable || cause.code === 'CORE_UNAVAILABLE')
        if (transient && Date.now() + RENEW_RETRY_MS < reading.expiresAt) {
          reading.timer = setTimeout(() => this.renew(maestro, id), RENEW_RETRY_MS)
          return
        }
        this.dropSubscription(id)
        this.report(accessFailure(cause))
      }
    })()
  }

  private stopRenewal(id: string) {
    const reading = this.supervised.get(id)
    if (reading?.timer) clearTimeout(reading.timer)
    this.supervised.delete(id)
  }

  /** Releases the grant and wipes the supervised content held by the Maestro client. */
  private endSupervision(id: string) {
    if (!this.supervised.has(id)) return
    this.stopRenewal(id)
    this.maestro?.closeThread(id)
  }

  /** The reader joined the conversation: from now on the ordinary subscription applies. */
  private leaveSupervision(maestro: MaestroClient, id: string) {
    const entry = this.retained.get(id)
    if (!entry || !this.supervised.has(id)) return
    this.endSupervision(id)
    entry.release()
    entry.release = maestro.retainThread(id)
    this.snapshotted.delete(id)
    this.eventSignatures.delete(id)
    this.threadSignatures.delete(id)
    void maestro.getThread(id).catch((cause) => this.report(cause))
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

  private knownEvents(state: MaestroThreadState): MaestroEvent[] {
    const events: MaestroEvent[] = []
    for (const eventId of state.eventIds) {
      const item = state.eventsById[eventId]
      if (item?.known) events.push(item.event)
    }
    return events
  }

  /** Edits, removals, delivery status and run ids land on their target event before projection. */
  private legacyEvents(state: MaestroThreadState): ThreadEvent[] {
    const events: ThreadEvent[] = []
    for (const event of foldMaestroEvents(this.knownEvents(state))) {
      const mapped = maestroEventToLegacy({ known: true, event }, this.resolveName)
      if (mapped) events.push(mapped)
    }
    return events
  }

  private syncRuns(id: string, state: MaestroThreadState) {
    // While an execution is running the agent already shows as working, so the pending indicator stays off.
    const running = Object.values(state.executionsById).some((e) => e.state === 'running')
    // Production has a Run only where the handler called run_start: every Run comes from run.updated.
    // An execution never makes or closes one.
    for (const run of maestroRunsToLegacy(this.knownEvents(state))) {
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
      if (state.phase === 'failed' && state.error?.code === MAESTRO_THREAD_UNREADABLE) {
        // The same replay would fail again: leave the thread once, so the chat stops loading and
        // shows the error. What was already read stays on screen. Leaving changes the store, which
        // runs this sync again while the thread is still retained: that inner run skips it.
        if (this.leaving.has(id)) continue
        this.leaving.add(id)
        try {
          this.dropSubscription(id)
        } finally {
          this.leaving.delete(id)
        }
        this.report(state.error)
        continue
      }
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

  // --- Thread do visitante do chat público ---

  /** Id da thread do visitante, quando já se conhece (GET no início da sessão ou POST ensure). */
  getVisitorThreadId(): string | null {
    return this.visitorThreadId
  }

  /** Início da sessão: lê a thread do visitante (404 = ainda não existe) e a mostra na lista. */
  private openVisitorThread(maestro: MaestroClient): Promise<void> {
    if (!this.visitor || this.visitorResolved) return Promise.resolve()
    if (this.visitorOpening) return this.visitorOpening
    const sentAt = Date.now()
    const opening = maestro
      .getPublicChatThread()
      .then((thread) => {
        if (this.maestro !== maestro || this.closed) return
        this.visitorResolved = true
        if (!thread) return
        this.visitorThreadId = thread.threadId
        this.callbacks.onThreadList([this.legacyThread(thread)], null, 1, null, sentAt)
      })
      .catch((cause) => {
        if (this.maestro === maestro && !this.closed) this.report(cause)
      })
      .finally(() => {
        if (this.visitorOpening === opening) this.visitorOpening = null
      })
    this.visitorOpening = opening
    return opening
  }

  /** Pré-chat declarado: `metadata.guest_*` da primeira mensagem (como a produção), senão o da opção. */
  private visitorGuest(
    metadata: Record<string, unknown> | undefined
  ): { name?: string; email?: string; phone?: string } | undefined {
    // Same rule as the server: edges trimmed, no control character (\x00-\x1f); empty means omitted.
    const pick = (value: unknown, limit: number) =>
      typeof value === 'string'
        ? [...value]
            .filter((character) => (character.codePointAt(0) ?? 0) >= 0x20)
            .join('')
            .trim()
            .slice(0, limit)
        : ''
    const base = this.visitor?.guest
    const name = pick(metadata?.guest_name, 200) || pick(base?.name, 200)
    const email = pick(metadata?.guest_email, 320) || pick(base?.email, 320)
    const phone = pick(metadata?.guest_phone, 64) || pick(base?.phone, 64)
    const guest = {
      ...(name ? { name } : {}),
      ...(email ? { email } : {}),
      ...(phone ? { phone } : {}),
    }
    return Object.keys(guest).length ? guest : undefined
  }

  /**
   * Primeira mensagem de cada sessão: POST ensure (mesmo com a thread já existente: renova o perfil do
   * visitante). Idempotente por chave; a chave fica a mesma nas repetições da mesma tentativa.
   */
  private ensureVisitorThread(
    maestro: MaestroClient,
    metadata: Record<string, unknown> | undefined
  ): Promise<string> {
    if (this.visitorEnsured && this.visitorThreadId) return Promise.resolve(this.visitorThreadId)
    if (this.visitorEnsuring) return this.visitorEnsuring
    const key = crypto.randomUUID()
    const guest = this.visitorGuest(metadata)
    const ensuring = ensureWithRetryAfter(() => maestro.ensurePublicChatThread(guest, key))
      .then((thread) => {
        if (this.maestro !== maestro || this.closed) throw new Error('Not connected')
        this.visitorEnsured = true
        this.visitorResolved = true
        this.visitorThreadId = thread.threadId
        this.callbacks.onThreadUpsert(this.legacyThread(thread))
        return thread.threadId
      })
      .finally(() => {
        if (this.visitorEnsuring === ensuring) this.visitorEnsuring = null
      })
    this.visitorEnsuring = ensuring
    return ensuring
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
      if (this.visitor) {
        // The visitor has one thread: the one the ensure route opens (or refreshes) for this session.
        const known = Boolean(threadId)
        threadId = await this.ensureVisitorThread(maestro, params.metadata)
        if (known) {
          this.pendingClientEvents.set(clientEventId, threadId)
          this.callbacks.addOptimistic(
            threadId,
            this.optimistic(threadId, params, clientEventId),
            clientEventId
          )
        }
      } else if (!threadId) {
        const key = crypto.randomUUID()
        const request = {
          title: titleFrom(params),
          ...(this.options.invocationRouting ? { routing_version: 1 as const } : {}),
          participants: [{ kind: 'agent' as const, principal_id: this.agentPrincipalId }],
        }
        const created = await onceMore(() => maestro.createThread(request, key))
        threadId = created.threadId
        this.callbacks.onThreadUpsert(this.legacyThread(created))
        const initial = created.participants.find(
          (p) => p.kind === 'agent' && p.principalId === this.agentPrincipalId
        )
        this.selectInvocation(
          threadId,
          !this.invocationSelections.has('new') && initial ? [initial.participantId] : []
        )
      } else {
        this.pendingClientEvents.set(clientEventId, threadId)
        this.callbacks.addOptimistic(
          threadId,
          this.optimistic(threadId, params, clientEventId),
          clientEventId
        )
      }
      const text = content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n')
      // The visitor never mentions or routes: the thread has the visitor and the agent of the link.
      const mentions = this.visitor
        ? []
        : maestroMentions(
            text,
            this.participantsByThread.get(threadId) ?? [],
            this.resolveName,
            this.routingThreads.has(threadId)
          )
      const selection = this.visitor ? null : this.getInvocationSelection(threadId, text)
      if (selection?.invalid)
        throw new Error('Destinatário indisponível. Selecione outro agente com @.')
      const routing = selection
        ? selection.mode === 'direct'
          ? { mode: 'direct' as const, recipients: selection.recipients }
          : { mode: selection.mode }
        : undefined
      // Selection belongs to the sender and thread; never infer it from another participant's event.
      if (selection?.mode === 'direct' || (selection?.mode === 'none' && mentions.length))
        this.selectInvocation(threadId, selection.recipients)
      const model = params.chatContext?.llmModel
      if (model && !this.options.turnModels?.includes(model))
        throw new Error('Selected model is not available through Maestro')
      const recipients = selection?.recipients ?? []
      const publication = maestro.prepareMessage({
        ...(model && recipients.length
          ? {
              agentOptions: recipients.map((participant_id) => ({ participant_id, model })),
            }
          : {}),
        threadId,
        content,
        clientEventId,
        ...(routing ? { routing } : {}),
        ...(mentions.length ? { mentions } : {}),
      })
      // Synchronous durable write precedes all transport awaits and composer clearing.
      this.outbox().put(publication)
      await maestro.send(publication)
      this.outbox().remove(clientEventId)
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
            ? {
                type: 'audio',
                refId: part.refId,
                ...(part.filename ? { filename: part.filename } : {}),
                ...(part.mimeType ? { mimeType: part.mimeType } : {}),
              }
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
    // The visitor cannot manage participants (the Maestro refuses with 403, which would end the session).
    if (!maestro || this.visitor) return Promise.resolve(false)
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
        if (kind === 'human' && user.userId === this.options.scope.principalId)
          this.leaveSupervision(maestro, id)
        return true
      })
      .catch((cause) => {
        this.report(cause)
        this.callbacks.setSendError(`Could not add participant: ${errorMessage(cause)}`)
        return false
      })
  }

  /** `userId` is what the legacy views show: the instance agent id for agents, the principal for people. */
  override removeParticipant(threadId: string, userId: string): Promise<boolean> {
    const maestro = this.maestro
    if (!maestro || this.visitor) return Promise.resolve(false)
    const id = threadId.toLowerCase()
    const wanted = userId.toLowerCase()
    const state = maestro.store.getThread(id)
    const participant = Object.values(state?.participantsById ?? {}).find(
      (p) => p.state !== 'removed' && maestroParticipantLegacyId(p).toLowerCase() === wanted
    )
    if (!participant) return Promise.resolve(false)
    const key = crypto.randomUUID()
    return onceMore(() => maestro.removeParticipant(id, participant.participantId, {}, key))
      .then(() => {
        this.requestThreadList()
        return true
      })
      .catch((cause) => {
        this.report(cause)
        this.callbacks.setSendError(`Could not remove participant: ${errorMessage(cause)}`)
        return false
      })
  }

  override archiveThread(threadId: string): Promise<boolean> {
    return this.changeState(threadId, 'archived')
  }

  override unarchiveThread(threadId: string): Promise<boolean> {
    return this.changeState(threadId, 'active')
  }

  /** Falhas são reportadas por ``onError``; a promise não rejeita. */
  private changeState(threadId: string, state: 'active' | 'archived'): Promise<boolean> {
    const maestro = this.maestro
    if (!maestro || this.visitor) return Promise.resolve(false)
    const id = threadId.toLowerCase()
    const key = crypto.randomUUID()
    return (async () => {
      const version =
        maestro.store.getThread(id)?.thread?.version ?? (await maestro.getThread(id)).version
      await onceMore(() => maestro.changeThreadState(id, state, version, key))
    })()
      .then(() => {
        this.requestThreadList()
        return true
      })
      .catch((cause) => {
        this.report(cause)
        this.callbacks.setSendError(
          `Could not ${state === 'archived' ? 'archive' : 'unarchive'} conversation: ${errorMessage(cause)}`
        )
        return false
      })
  }

  override deleteThread(threadId: string) {
    const maestro = this.maestro
    if (!maestro || this.visitor) return
    const id = threadId.toLowerCase()
    const version = maestro.store.getThread(id)?.thread?.version
    void (async () => {
      const current = version ?? (await maestro.getThread(id)).version
      await maestro.deleteThread(id, current, crypto.randomUUID())
      this.stopRenewal(id)
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
    if (!maestro || this.visitor) return
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
    const view = this.visitor
      ? undefined
      : maestro.interactions.current(threadId, params.formEventId)
    if (!view || view.interaction.definition.kind !== 'form') {
      // A production form (send.form without suspension) answers through the forms route.
      const form = maestro.store.getThread(threadId)?.eventsById[params.formEventId.toLowerCase()]
      if (!form?.known || form.event.type !== 'form.created')
        throw new Error('Form is not available in this conversation')
      try {
        await maestro.respondForm(
          threadId,
          form.event.eventId,
          { values: params.values, cancelled: params.cancelled },
          crypto.randomUUID()
        )
        return { threadId }
      } catch (cause) {
        const message = errorMessage(cause)
        this.callbacks.setSendError(message)
        throw cause instanceof Error ? cause : new Error(message)
      }
    }
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
          direction: event.actor.kind === 'human' || event.actor.kind === 'external' ? 'in' : 'out',
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
          userId:
            event.actor.kind === 'external' ? event.actor.externalId : event.actor.principalId,
          userName: event.actor.displayName ?? null,
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
  override fetchPublicSettingsSchema(): Promise<PublicSettingsSchemaResult> {
    const models = this.options.turnModels
    if (!models?.length)
      return Promise.reject(new Error('Settings schema is not available through Maestro'))
    return Promise.resolve({
      version: 'maestro-turn-models-v1',
      fields: [
        {
          id: 'llm_models',
          type: 'select',
          label: 'Model',
          value: models[0],
          required: false,
          readonly: false,
          visibility: 'user',
          placeholder: null,
          min: null,
          max: null,
          rows: null,
          src: null,
          width: null,
          height: null,
          uploadUrl: null,
          accept: null,
          options: models.map((value) => ({ value, label: value })),
        },
      ],
    })
  }
  override subscribeAnalytics() {}
  override unsubscribeAnalytics() {}
}
