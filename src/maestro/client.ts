import type { z } from 'zod'
import {
  createMaestroConnectCommand,
  type MaestroEvent,
  toMaestroConnectAck,
  toMaestroEvent,
  toMaestroEventPage,
  toMaestroPersistedResponse,
  toMaestroThread,
  toMaestroThreadPage,
} from '../protocol/maestro/contracts.js'
import { opaquePrincipalSchema, uuidSchema } from '../protocol/maestro/vendor/common.js'
import {
  publicSchemas,
  wsCommandSchemas,
  wsFrameSchemas,
} from '../protocol/maestro/vendor/public.js'
import { MaestroApprovalOutcomes } from './approval-outcomes.js'
import { approvalExpiry, MaestroApprovals } from './approvals.js'
import { MaestroArtifacts } from './artifacts.js'
import { type MaestroControlInput, type MaestroControlIntent, MaestroControls } from './controls.js'
import { inspectMaestroHumanCredential } from './credential.js'
import { MaestroExports } from './exports.js'
import { MaestroFeedback } from './feedback.js'
import { MaestroInteractionUploads } from './interaction-uploads.js'
import { MaestroInteractions, maestroInteractionArtifactsSchema } from './interactions.js'
import {
  parseMaestroNetwork,
  parseMaestroNetworkSchema,
  readMaestroNetworkEvent,
  readMaestroNetworkPage,
  readMaestroReplayFrame,
} from './network.js'
import { canonical, immutable, MaestroPublicationLedger, publicationKey } from './publications.js'
import { MaestroStore } from './store.js'
import { MaestroThreads } from './threads.js'
import {
  type MaestroClientConfig,
  MaestroClientError,
  type MaestroConnection,
  type MaestroCredential,
  type MaestroPublicationResult,
  type MaestroSendInput,
  type MaestroSocket,
  type MaestroTransport,
} from './types.js'

type Message = z.infer<(typeof publicSchemas)['Public.MessageCreateRequest']>
type Pending = {
  command: string
  payload: unknown
  resolve: (value: unknown) => void
  reject: (error: MaestroClientError) => void
  timer: ReturnType<typeof setTimeout>
  onAccepted?: (frame: unknown) => void
  requestForbidden?: boolean
}
type Listener = (frame: { type: string; payload: unknown }) => void
const authCodes = new Set(['UNAUTHENTICATED', 'FORBIDDEN'])
const technicalCodes = new Set(['DEPENDENCY_UNAVAILABLE', 'CORE_UNAVAILABLE', 'INTERNAL_ERROR'])
const rejectionState = (code: string, status = 400) =>
  technicalCodes.has(code) || status >= 500 ? ('unknown' as const) : ('rejected' as const)
const error = (code: string, message: string, retryable = false) =>
  new MaestroClientError(code, message, retryable)
const bounded = (value: number | undefined, fallback: number, min: number, max: number) => {
  const result = value ?? fallback
  if (!Number.isInteger(result) || result < min || result > max)
    throw error('INVALID_CONFIG', 'Invalid Maestro transport limit')
  return result
}

export class MaestroClient {
  readonly publications = new MaestroPublicationLedger()
  readonly toolApprovalsEnabled: boolean
  readonly approvals: MaestroApprovals
  readonly approvalOutcomes: MaestroApprovalOutcomes
  readonly durableFormsEnabled: boolean
  readonly perAgentOptionsEnabled: boolean
  readonly interactionUploads: MaestroInteractionUploads
  readonly interactions: MaestroInteractions
  readonly feedback: MaestroFeedback
  readonly exports: MaestroExports
  readonly artifacts: MaestroArtifacts
  private readonly fieldArtifacts: MaestroArtifacts
  readonly controls: MaestroControls
  readonly store: MaestroStore
  private readonly threads: MaestroThreads
  private threadRevisions = new Map<string, number>()
  readonly scope: Readonly<MaestroClientConfig['scope']>
  private readonly config: MaestroClientConfig
  private readonly origin: string
  private readonly api: string
  private readonly socketUrl: string
  private readonly timeoutMs: number
  private readonly heartbeatMs: number
  private readonly maxBytes: number
  private readonly maxPublications: number
  private readonly reconnectLimit: number
  private readonly reconnectBase: number
  private readonly reconnectMax: number
  private readonly transport: MaestroTransport
  private credential: MaestroCredential
  private token: string | null = null
  private socket: MaestroSocket | null = null
  private generation = 0
  private controller = new AbortController()
  private requests = new Map<string, Pending>()
  private intents = new Map<string, Message>()
  private sends = new Map<string, Promise<MaestroPublicationResult>>()
  private subscriptions = new Map<string, string>()
  private connection: MaestroConnection = immutable({
    status: 'disconnected',
    capabilities: [],
    handshake: null,
    reconnectAttempt: 0,
  })
  private observers = new Set<() => void>()
  private frames = new Set<Listener>()
  private connecting: Promise<void> | null = null
  private refreshing: Promise<void> | null = null
  private refreshingCredential: MaestroCredential | null = null
  private reconnectTimer?: ReturnType<typeof setTimeout>
  private heartbeatTimer?: ReturnType<typeof setTimeout>
  private expiryTimer?: ReturnType<typeof setTimeout>
  private stopped = true
  private disposed = false

  constructor(config: MaestroClientConfig) {
    if (config.durableForms !== undefined && typeof config.durableForms !== 'boolean')
      throw error('INVALID_CONFIG', 'Invalid durable form opt-in')
    this.durableFormsEnabled = config.durableForms === true
    if (config.toolApprovals !== undefined && typeof config.toolApprovals !== 'boolean')
      throw error('INVALID_CONFIG', 'Invalid tool approval opt-in')
    this.toolApprovalsEnabled = config.toolApprovals === true
    if (config.perAgentOptions !== undefined && typeof config.perAgentOptions !== 'boolean')
      throw new Error('Invalid per-agent options opt-in')
    this.perAgentOptionsEnabled = config.perAgentOptions === true
    const endpoint = new URL(config.endpoint)
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)
    if (
      config.mode !== 'maestro' ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash ||
      endpoint.pathname !== '/' ||
      !(
        endpoint.protocol === 'https:' ||
        (endpoint.protocol === 'http:' && local && config.allowInsecureLocalhost === true)
      )
    )
      throw error(
        'INVALID_CONFIG',
        'Maestro requires an explicit HTTPS origin (or opted-in loopback HTTP)'
      )
    const prefix = config.apiPrefix ?? '/api/v1'
    if (!/^\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(prefix))
      throw error('INVALID_CONFIG', 'Invalid Maestro API prefix')
    const scope = { ...config.scope }
    if (
      !opaquePrincipalSchema.safeParse(scope.principalId).success ||
      !uuidSchema.safeParse(scope.organizationId).success ||
      (scope.workspaceId !== null && !uuidSchema.safeParse(scope.workspaceId).success)
    )
      throw error('INVALID_CONFIG', 'Invalid Maestro scope')
    scope.organizationId = scope.organizationId.toLowerCase()
    scope.workspaceId = scope.workspaceId?.toLowerCase() ?? null
    this.scope = Object.freeze(scope)
    this.config = { ...config, scope: this.scope }
    this.origin = endpoint.origin
    this.api = `${this.origin}${prefix}`
    this.socketUrl = `${endpoint.protocol === 'https:' ? 'wss:' : 'ws:'}//${endpoint.host}/ws`
    this.transport = config.transport ?? 'websocket'
    if (!['websocket', 'http'].includes(this.transport))
      throw error('INVALID_CONFIG', 'Invalid Maestro transport')
    this.credential = config.authToken
    this.timeoutMs = bounded(config.requestTimeoutMs, 15000, 100, 120000)
    this.heartbeatMs = bounded(config.heartbeatMs, 20000, 100, 120000)
    this.maxBytes = bounded(config.maxResponseBytes, 1048576, 1024, 8388608)
    this.maxPublications = bounded(config.maxPublications, 1000, 1, 10000)
    this.reconnectLimit = bounded(config.maxReconnectAttempts, 5, 0, 20)
    this.reconnectBase = bounded(config.reconnectBaseMs, 500, 100, 30000)
    this.reconnectMax = bounded(config.reconnectMaxMs, 30000, this.reconnectBase, 120000)
    this.store = new MaestroStore(this.scope, {
      maxBufferedEvents: bounded(config.maxBufferedEvents, 1000, 1, 10000),
      maxEventsPerThread: bounded(config.maxEventsPerThread, 20000, 100, 100000),
      maxThreads: bounded(config.maxThreads, 100, 1, 1000),
    })
    this.approvalOutcomes = new MaestroApprovalOutcomes(
      async (threadId, interactionId, signal) => {
        this.requireApprovalOutcomeRead(threadId)
        const revision = this.threadRevisions.get(threadId) ?? 0
        const generation = this.generation
        const raw = await this.http(
          `/candidate/tool-approvals/threads/${threadId}/interactions/${interactionId}/outcome`,
          { method: 'GET', signal },
          this.token,
          [200],
          4096,
          true,
          true
        )
        this.assertGeneration(generation)
        this.assertThreadRevision(threadId, revision)
        this.requireApprovalOutcomeRead(threadId)
        return raw
      },
      (threadId, interactionId) => {
        const view = this.approvals.current(threadId, interactionId)
        return view
          ? {
              deliveryId: view.interaction.delivery_id,
              agentParticipantId: view.interaction.agent_participant_id,
              argumentsHash: view.interaction.definition.arguments_hash,
              decisionEventId:
                view.decision?.type === 'interaction.responded' ? view.decision.eventId : null,
              approved: view.state === 'approved',
            }
          : null
      },
      (threadId) => this.requireApprovalOutcomeRead(threadId),
      this.maxPublications
    )
    this.approvals = new MaestroApprovals(
      async (intent, transport = this.transport) => {
        this.requireApproval(intent.threadId, intent.interactionId, true)
        const revision = this.threadRevisions.get(intent.threadId) ?? 0
        const generation = this.generation
        let raw: unknown
        if (transport === 'websocket') {
          const frame = (await this.command(
            'interaction.respond',
            {
              interaction_id: intent.interactionId,
              idempotency_key: intent.idempotencyKey,
              ...intent.request,
            },
            undefined,
            true
          )) as { payload: unknown }
          raw = frame.payload
        } else if (transport === 'http') {
          raw = await this.http(
            `/interactions/${intent.interactionId}/responses`,
            {
              method: 'POST',
              headers: { 'Idempotency-Key': intent.idempotencyKey },
              body: JSON.stringify(intent.request),
            },
            this.token,
            [200, 201],
            this.maxBytes,
            true
          )
        } else throw error('INVALID_REQUEST', 'Unknown approval transport')
        try {
          this.assertGeneration(generation)
          this.assertThreadRevision(intent.threadId, revision)
          this.requireApproval(intent.threadId, intent.interactionId, true)
        } catch (cause) {
          const failure =
            cause instanceof MaestroClientError
              ? cause
              : error('PROTOCOL_ERROR', 'Approval confirmation unavailable')
          throw new MaestroClientError(
            failure.code,
            failure.message,
            failure.retryable,
            failure.requestId,
            intent.threadId,
            undefined,
            'unknown'
          )
        }
        const result = toMaestroPersistedResponse(
          parseMaestroNetwork(publicSchemas['Public.PersistedResponse'], raw)
        )
        const view = this.approvals.current(intent.threadId, intent.interactionId)!
        const member = Object.values(
          this.store.getThread(intent.threadId)?.participantsById ?? {}
        ).find(
          (item) =>
            item.kind === 'human' &&
            item.principalId === this.scope.principalId &&
            item.state === 'active'
        )
        if (
          result.event.threadId !== intent.threadId ||
          result.event.type !== 'interaction.responded' ||
          result.event.actor.kind !== 'human' ||
          result.event.actor.principalId !== this.scope.principalId ||
          result.event.actor.participantId !== member?.participantId ||
          result.event.payload.interaction_id !== intent.interactionId ||
          result.event.payload.delivery_id !== view.interaction.delivery_id ||
          result.event.payload.action !== intent.request.action ||
          result.event.payload.phase_id !== intent.interactionId ||
          BigInt(result.event.sequence) <= BigInt(view.requestSequence) ||
          canonical(result.event.payload.shared_data) !== canonical({})
        )
          throw error('PROTOCOL_ERROR', 'Approval receipt differs from the original intention')
        this.store.receipt(result.event)
        return result
      },
      this.store.getSnapshot,
      (threadId, interactionId, confirmation) =>
        this.requireApproval(threadId, interactionId, confirmation),
      this.maxPublications,
      (threadId, interactionId, binding) =>
        this.approvalOutcomes.current(threadId, interactionId, binding)
    )
    this.interactions = new MaestroInteractions(
      async (intent, transport = this.transport) => {
        this.requireForm(intent.threadId, intent.interactionId, true, false)
        const revision = this.threadRevisions.get(intent.threadId) ?? 0
        const generation = this.generation
        let raw: unknown
        if (transport === 'websocket') {
          const frame = (await this.command('interaction.respond', {
            interaction_id: intent.interactionId,
            idempotency_key: intent.idempotencyKey,
            ...intent.request,
          })) as { payload: unknown }
          raw = frame.payload
        } else if (transport === 'http') {
          raw = await this.http(`/interactions/${intent.interactionId}/responses`, {
            method: 'POST',
            headers: { 'Idempotency-Key': intent.idempotencyKey },
            body: JSON.stringify(intent.request),
          })
        } else throw error('INVALID_REQUEST', 'Unknown interaction transport')
        this.assertGeneration(generation)
        this.assertThreadRevision(intent.threadId, revision)
        const result = toMaestroPersistedResponse(
          parseMaestroNetwork(publicSchemas['Public.PersistedResponse'], raw)
        )
        const view = this.interactions.current(intent.threadId, intent.interactionId)!
        const fields =
          view.interaction.definition.kind === 'form' ? view.interaction.definition.fields : []
        const shared =
          intent.request.action === 'submit'
            ? Object.fromEntries(
                Object.entries(intent.request.data).filter(([name]) =>
                  fields.some((field) => field.name === name && field.share_response)
                )
              )
            : {}
        if (
          result.event.threadId !== intent.threadId ||
          result.event.type !== 'interaction.responded' ||
          result.event.actor.kind !== 'human' ||
          result.event.actor.principalId !== this.scope.principalId ||
          result.event.payload.interaction_id !== intent.interactionId ||
          result.event.payload.delivery_id !== view.interaction.delivery_id ||
          result.event.payload.action !== intent.request.action ||
          result.event.payload.phase_id !== intent.interactionId ||
          canonical(result.event.payload.shared_data) !== canonical(shared)
        )
          throw error('PROTOCOL_ERROR', 'Interaction receipt differs from the original intention')
        this.store.receipt(result.event)
        return result
      },
      this.store.getSnapshot,
      this.maxPublications,
      async (threadId, interactionId, fieldName, artifactId) => {
        this.requireForm(threadId, interactionId)
        const revision = this.threadRevisions.get(threadId) ?? 0
        const result = await this.http(
          `/interactions/${interactionId}/fields/${fieldName}/artifacts`,
          { method: 'POST', body: JSON.stringify({ artifact_id: artifactId }) }
        )
        this.assertThreadRevision(threadId, revision)
        if (
          !result ||
          typeof result !== 'object' ||
          !('status' in result) ||
          result.status !== 'bound' ||
          !('artifact_id' in result) ||
          result.artifact_id !== artifactId ||
          !('interaction_id' in result) ||
          result.interaction_id !== interactionId ||
          !('field_name' in result) ||
          result.field_name !== fieldName
        )
          throw error('PROTOCOL_ERROR', 'Field binding receipt differs')
      },
      async (threadId, interactionId, signal) => {
        this.requireForm(threadId, interactionId, false, false)
        const revision = this.threadRevisions.get(threadId) ?? 0
        const raw = await this.http(
          `/interactions/${interactionId}/fields/artifacts`,
          { method: 'GET', signal },
          this.token,
          [200],
          2 * 1024 * 1024
        )
        this.assertThreadRevision(threadId, revision)
        if (signal.aborted) throw error('DISCONNECTED', 'Field recovery was canceled')
        this.requireForm(threadId, interactionId, false, false)
        const parsed = maestroInteractionArtifactsSchema.safeParse(raw)
        if (!parsed.success || parsed.data.interaction_id !== interactionId)
          throw error('PROTOCOL_ERROR', 'Invalid own-field recovery response')
        const view = this.interactions.current(threadId, interactionId)!
        const fields =
          view.interaction.definition.kind === 'form' ? view.interaction.definition.fields : []
        if (
          new Set(parsed.data.items.map((item) => item.artifact_id)).size !==
            parsed.data.items.length ||
          parsed.data.items.some(
            (item) =>
              !fields.some((field) => field.name === item.field_name && field.type === 'artifact')
          ) ||
          fields.some(
            (field) =>
              field.type === 'artifact' &&
              parsed.data.items.filter((item) => item.field_name === field.name).length >
                field.max_files
          )
        )
          throw error('PROTOCOL_ERROR', 'Field recovery differs from form definition')
        return parsed.data.items
      },
      (threadId, interactionId, request) =>
        this.requireForm(threadId, interactionId, false, request.action === 'submit')
    )
    this.feedback = new MaestroFeedback(
      async (intent) => {
        this.requireThreadFeature(intent.threadId, 'feedback')
        const target = this.store.getThread(intent.threadId)?.eventsById[intent.eventId]
        if (
          !target?.known ||
          target.event.type !== 'message.created' ||
          target.event.actor.kind !== 'agent' ||
          this.isSupervision(intent.threadId)
        )
          throw error('FORBIDDEN', 'Feedback requires a canonical agent message')
        const revision = this.threadRevisions.get(intent.threadId) ?? 0
        const result = toMaestroPersistedResponse(
          parseMaestroNetwork(
            publicSchemas['Public.PersistedResponse'],
            await this.http(`/threads/${intent.threadId}/events/${intent.eventId}/feedback`, {
              method: 'PUT',
              headers: { 'Idempotency-Key': intent.idempotencyKey },
              body: JSON.stringify(intent.request),
            })
          )
        )
        this.assertThreadRevision(intent.threadId, revision)
        if (
          result.event.threadId !== intent.threadId ||
          result.event.type !== 'feedback.updated' ||
          result.event.payload.target_event_id !== intent.eventId ||
          result.event.payload.principal_id !== this.scope.principalId ||
          canonical(result.event.payload.feedback) !== canonical(intent.request)
        )
          throw error('PROTOCOL_ERROR', 'Feedback receipt target differs')
        this.store.receipt(result.event)
        return result
      },
      this.store.getSnapshot,
      this.scope.principalId,
      this.maxPublications
    )
    this.exports = new MaestroExports(
      async (threadId, key, watermark) => {
        this.requireThreadFeature(threadId, 'export')
        const revision = this.threadRevisions.get(threadId) ?? 0
        const result = await this.http(
          `/threads/${threadId}/export?${new URLSearchParams({ format: 'json', ...(watermark === undefined ? {} : { watermark }) })}`,
          { method: 'GET', headers: { 'Idempotency-Key': key, ...this.grantHeader(threadId) } }
        )
        this.assertThreadRevision(threadId, revision)
        return result
      },
      async (threadId, path, signal) => {
        this.requireThreadFeature(threadId, 'export')
        if (!/^\/exports\/artifacts\/[0-9a-f-]{36}\/download$/.test(path))
          throw error('PROTOCOL_ERROR', 'Invalid private export path')
        const generation = this.generation,
          token = this.token
        if (!token) throw error('UNAUTHENTICATED', 'Maestro credential unavailable')
        const response = await (this.config.fetch ?? globalThis.fetch)(`${this.api}${path}`, {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}`, ...this.grantHeader(threadId) },
          credentials: 'omit',
          redirect: 'error',
          cache: 'no-store',
          signal: AbortSignal.any([this.controller.signal, signal]),
        })
        try {
          this.assertGeneration(generation)
          if (response.url && response.url !== `${this.api}${path}`)
            throw error('PROTOCOL_ERROR', 'Unexpected export origin')
        } catch (cause) {
          await response.body?.cancel().catch(() => {})
          throw cause
        }
        return response
      },
      prefix,
      this.timeoutMs,
      (failure, threadId) => {
        if (authCodes.has(failure.code)) this.invalidate(failure)
        else this.closeThread(threadId)
      }
    )
    const createArtifacts = () =>
      new MaestroArtifacts(
        {
          workspaceId: this.scope.workspaceId,
          request: async (path, init, threadId) => {
            this.requireCapability('attachments.durable')
            if (threadId) {
              const state = this.store.getThread(threadId)
              const id = /^\/artifacts\/([0-9a-f-]{36})\/download$/.exec(path)?.[1]
              const visible =
                state &&
                Object.values(state.eventsById).some(
                  (item) =>
                    item.known &&
                    item.event.type === 'message.created' &&
                    item.event.payload.content.some(
                      (part) => part.type === 'attachment' && part.artifact_id === id
                    )
                )
              if (
                !state?.thread ||
                state.phase === 'revoked' ||
                !state.thread.capabilities.includes('attachments.durable') ||
                !visible
              )
                throw error('FORBIDDEN', 'Attachment is not in the authorized thread history')
            }
            const generation = this.generation
            const token = this.token
            if (!token) throw error('UNAUTHENTICATED', 'Maestro credential unavailable')
            const response = await (this.config.fetch ?? globalThis.fetch)(`${this.api}${path}`, {
              ...init,
              headers: {
                Authorization: `Bearer ${token}`,
                ...init.headers,
                ...(threadId ? this.grantHeader(threadId) : {}),
              },
              credentials: 'omit',
              redirect: 'error',
              cache: 'no-store',
              signal: AbortSignal.any([
                this.controller.signal,
                AbortSignal.timeout(this.timeoutMs),
                ...(init.signal ? [init.signal] : []),
              ]),
            })
            this.assertGeneration(generation)
            if (response.url && response.url !== `${this.api}${path}`)
              throw error('PROTOCOL_ERROR', 'Unexpected artifact origin')
            return response
          },
          failure: (failure, threadId) => {
            if (authCodes.has(failure.code)) this.invalidate(failure)
            else if (
              threadId &&
              ['NOT_FOUND', 'THREAD_DELETED', 'THREAD_ACCESS_REVOKED'].includes(failure.code)
            )
              this.closeThread(threadId)
          },
        },
        config.maxArtifactBytes
      )
    this.artifacts = createArtifacts()
    this.fieldArtifacts = createArtifacts()
    this.interactionUploads = new MaestroInteractionUploads(
      this.fieldArtifacts,
      (threadId, interactionId, fieldName) => {
        const view = this.requireForm(threadId, interactionId)
        this.requireCapability('attachments.durable')
        if (
          view.interaction.definition.kind !== 'form' ||
          !view.interaction.definition.fields.some(
            (field) => field.name === fieldName && field.type === 'artifact'
          )
        )
          throw error('VALIDATION_FAILED', 'Invalid form field')
        const field = view.interaction.definition.fields.find((field) => field.name === fieldName)
        if (
          field?.type === 'artifact' &&
          this.interactionUploads
            .getSnapshot()
            .filter(
              (item) =>
                item.threadId === threadId.toLowerCase() &&
                item.interactionId === interactionId.toLowerCase() &&
                item.fieldName === fieldName
            ).length >= field.max_files
        )
          throw error(
            'BOUND_ARTIFACT_IMMUTABLE',
            'Current field files cannot be replaced; cancel this form to change files'
          )
      },
      (threadId, interactionId, fieldName, draftId) =>
        this.retryInteractionField(threadId, interactionId, fieldName, draftId),
      (threadId, interactionId, signal) =>
        this.interactions.restoreArtifacts(threadId, interactionId, signal)
    )
    this.store.subscribe(() => {
      for (const state of Object.values(this.store.getSnapshot().threads))
        if (state.phase === 'revoked' && state.threadId) this.artifacts.closeThread(state.threadId)
    })
    this.controls = new MaestroControls(
      (intent, transport) => this.sendControl(intent, transport),
      this.store.getSnapshot,
      this.maxPublications
    )
    this.store.subscribe(this.controls.reconcile)
    this.threads = new MaestroThreads(
      this,
      bounded(config.maxReplayAttempts, 3, 0, 10),
      bounded(config.replayRetryMs, 250, 10, 30000)
    )
    this.publications.subscribe(() => this.store.publications(this.publications.getSnapshot()))
  }

  /** Local checks are UI guardrails; current Core/server authorization remains authoritative. */
  canApprove(threadId: string, interactionId: string): boolean {
    try {
      this.requireApproval(threadId, interactionId)
      return true
    } catch {
      return false
    }
  }
  private requireApprovalOutcomeRead(threadId: string) {
    if (!this.toolApprovalsEnabled)
      throw error('UNSUPPORTED_CAPABILITY', 'Tool approval outcomes require explicit client opt-in')
    this.requireCapability('interactions.tool_approval')
    const state = this.store.getThread(threadId)
    const member = Object.values(state?.participantsById ?? {}).find(
      (item) =>
        item.kind === 'human' &&
        item.principalId === this.scope.principalId &&
        item.state === 'active'
    )
    if (
      !state?.thread ||
      state.phase !== 'live' ||
      !['active', 'archived'].includes(state.thread.state) ||
      !state.thread.permissions.read ||
      !state.thread.capabilities.includes('interactions.tool_approval') ||
      this.isSupervision(threadId) ||
      !member
    )
      throw error('FORBIDDEN', 'Approval outcome read is not authorized')
  }
  private requireApproval(threadId: string, interactionId: string, confirmation = false) {
    if (!this.toolApprovalsEnabled)
      throw error('UNSUPPORTED_CAPABILITY', 'Tool approvals require explicit client opt-in')
    this.requireCapability('interactions.tool_approval')
    const state = this.store.getThread(threadId)
    const view = this.approvals.current(threadId, interactionId)
    const member = Object.values(state?.participantsById ?? {}).find(
      (item) =>
        item.kind === 'human' &&
        item.principalId === this.scope.principalId &&
        item.state === 'active'
    )
    const agent = view && state?.participantsById[view.interaction.agent_participant_id]
    if (
      !state?.thread ||
      state.phase !== 'live' ||
      state.thread.state !== 'active' ||
      !state.thread.permissions.write ||
      !state.thread.capabilities.includes('interactions.tool_approval') ||
      this.isSupervision(threadId) ||
      !member ||
      !view ||
      !agent ||
      agent.kind !== 'agent' ||
      agent.state !== 'active' ||
      !agent.capabilities.includes('interactions.tool_approval') ||
      !view.interaction.definition.eligible_participant_ids.includes(member.participantId)
    )
      throw error('FORBIDDEN', 'Tool approval is not authorized')
    if (
      !confirmation &&
      (view.state !== 'pending' ||
        !(approvalExpiry(view.interaction.definition.expires_at) > Date.now()))
    )
      throw error('INTERACTION_EXPIRED', 'Tool approval is terminal')
  }
  private requireForm(
    threadId: string,
    interactionId: string,
    confirmation = false,
    confirmedFields = true
  ) {
    if (!this.durableFormsEnabled)
      throw error('UNSUPPORTED_CAPABILITY', 'Durable forms require explicit client opt-in')
    this.requireCapability('interactions.forms')
    const state = this.store.getThread(threadId)
    const view = this.interactions.current(threadId, interactionId)
    const member = Object.values(state?.participantsById ?? {}).find(
      (item) =>
        item.kind === 'human' &&
        item.principalId === this.scope.principalId &&
        item.state === 'active'
    )
    if (
      !state?.thread ||
      state.phase !== 'live' ||
      state.thread.state !== 'active' ||
      !state.thread.permissions.write ||
      !state.thread.capabilities.includes('interactions.forms') ||
      this.isSupervision(threadId) ||
      !member ||
      !view ||
      !view.interaction.definition.eligible_participant_ids.includes(member.participantId)
    )
      throw error('FORBIDDEN', 'Durable form is not authorized')
    if (
      !confirmation &&
      (view.state !== 'pending' || Date.parse(view.interaction.definition.expires_at) <= Date.now())
    )
      throw error('INTERACTION_EXPIRED', 'Durable form is terminal')
    if (
      confirmedFields &&
      view.interaction.definition.kind === 'form' &&
      view.interaction.definition.fields.some((field) => field.type === 'artifact') &&
      !this.interactionUploads.isRestored(threadId, interactionId)
    )
      throw error(
        'INTERACTION_FIELDS_UNCONFIRMED',
        'Recover current field bindings before changing or submitting this form'
      )
    return view
  }
  async retryInteractionField(
    threadId: string,
    interactionId: string,
    fieldName: string,
    draftId: string
  ) {
    threadId = this.checkId(threadId)
    interactionId = this.checkId(interactionId)
    const view = this.requireForm(threadId, interactionId)
    if (
      view.interaction.definition.kind !== 'form' ||
      !view.interaction.definition.fields.some(
        (field) => field.name === fieldName && field.type === 'artifact'
      )
    )
      throw error('VALIDATION_FAILED', 'Invalid form field')
    const revision = this.threadRevisions.get(threadId) ?? 0
    await this.fieldArtifacts.retry(draftId)
    this.assertThreadRevision(threadId, revision)
    this.requireForm(threadId, interactionId)
    const draft = this.fieldArtifacts.getSnapshot().find((item) => item.id === draftId)
    if (draft?.state !== 'ready' || !draft.artifact)
      throw error('ARTIFACT_NOT_READY', 'Field upload is not ready')
    this.interactionUploads.markBinding(draftId)
    await this.interactions.bindArtifact(
      threadId,
      interactionId,
      fieldName,
      draft.artifact.artifact_id
    )
    this.assertThreadRevision(threadId, revision)
    this.fieldArtifacts.remove(draftId)
    return draft.artifact.artifact_id
  }

  private requireThreadFeature(threadId: string, feature: 'feedback' | 'export') {
    this.requireCapability(feature)
    const state = this.store.getThread(threadId)
    if (
      !state?.thread ||
      state.phase !== 'live' ||
      !state.thread.permissions[feature] ||
      !state.thread.capabilities.includes(feature)
    )
      throw error('FORBIDDEN', 'Thread feature unavailable')
  }
  private supervisionGrants = new Map<
    string,
    { id: string; timer: ReturnType<typeof setTimeout> }
  >()

  /** Explicit access-loss boundary for tombstones, removal and short-lived grants. */
  closeThread(threadId: string) {
    threadId = this.checkId(threadId)
    const grant = this.supervisionGrants.get(threadId)
    if (grant) clearTimeout(grant.timer)
    this.supervisionGrants.delete(threadId)
    this.artifacts.closeThread(threadId)
    this.interactionUploads.removeThread(threadId)
    this.interactions.removeThread(threadId)
    this.approvals.removeThread(threadId)
    this.approvalOutcomes.removeThread(threadId)
    this.feedback.removeThread(threadId)
    this.exports.removeThread(threadId)
    this.threads.close(threadId)
  }
  isSupervision(threadId: string) {
    return this.supervisionGrants.has(this.checkId(threadId))
  }
  private grantHeader(threadId: string): Record<string, string> {
    const grant = this.supervisionGrants.get(threadId)
    return grant ? { 'Maestro-Supervision-Grant': grant.id } : {}
  }
  async addParticipant(
    threadId: string,
    request: z.infer<(typeof publicSchemas)['Public.ParticipantAddRequest']>,
    key: string
  ) {
    return this.manageThread(
      threadId,
      '/participants',
      'POST',
      'Public.ParticipantAddRequest',
      request,
      key
    )
  }
  async removeParticipant(
    threadId: string,
    participantId: string,
    request: z.infer<(typeof publicSchemas)['Public.ReasonRequest']>,
    key: string
  ) {
    return this.manageThread(
      threadId,
      `/participants/${this.checkId(participantId)}`,
      'DELETE',
      'Public.ReasonRequest',
      request,
      key
    )
  }
  async transferOwnership(threadId: string, participantId: string, version: number, key: string) {
    await this.manageThread(
      threadId,
      '/ownership',
      'POST',
      'Public.OwnershipRequest',
      { participant_id: this.checkId(participantId) },
      key,
      version
    )
  }
  async changeThreadState(
    threadId: string,
    state: 'active' | 'archived',
    version: number,
    key: string
  ) {
    await this.manageThread(
      threadId,
      '',
      'PATCH',
      'Public.ThreadPatchRequest',
      { state },
      key,
      version
    )
  }
  async deleteThread(threadId: string, version: number, key: string) {
    const result = await this.manageThread(
      threadId,
      '',
      'DELETE',
      'Public.ReasonRequest',
      {},
      key,
      version,
      true
    )
    const receipt = parseMaestroNetwork(publicSchemas['Public.DeleteResponse'], result)
    this.closeThread(threadId)
    return receipt
  }
  private async manageThread(
    threadId: string,
    suffix: string,
    method: string,
    schema:
      | 'Public.ParticipantAddRequest'
      | 'Public.ReasonRequest'
      | 'Public.OwnershipRequest'
      | 'Public.ThreadPatchRequest',
    request: unknown,
    key: string,
    version?: number,
    deleting = false
  ) {
    this.requireCapability('threads.shared')
    threadId = this.checkId(threadId)
    if (this.supervisionGrants.has(threadId)) throw error('FORBIDDEN', 'Supervision is read-only')
    const headers =
      version === undefined
        ? publicSchemas['Public.MutationHeaders'].parse({ 'Idempotency-Key': key })
        : publicSchemas['Public.VersionedHeaders'].parse({
            'Idempotency-Key': key,
            'If-Match': String(version),
          })
    const body = publicSchemas[schema].parse(request)
    const revision = this.threadRevisions.get(threadId) ?? 0
    try {
      const result = await this.http(
        `/threads/${threadId}${suffix}`,
        { method, headers, body: JSON.stringify(body) },
        this.token,
        deleting ? [202] : [200, 201]
      )
      this.assertThreadRevision(threadId, revision)
      // Mutation receipts may deliberately omit current permissions. Always read a fresh projection.
      if (!deleting) await this.getThread(threadId)
      return result
    } catch (cause) {
      if (
        cause instanceof MaestroClientError &&
        ['NOT_FOUND', 'UNAUTHENTICATED'].includes(cause.code)
      )
        this.closeThread(threadId)
      throw cause
    }
  }
  async openSupervision(threadId: string, accessReason: string, key: string) {
    this.requireCapability('threads.shared')
    threadId = this.checkId(threadId)
    const headers = publicSchemas['Public.MutationHeaders'].parse({ 'Idempotency-Key': key })
    const body = publicSchemas['Public.SupervisionRequest'].parse({
      access_reason: accessReason.trim(),
    })
    const revision = this.threadRevisions.get(threadId) ?? 0
    const grant = parseMaestroNetwork(
      publicSchemas['Public.SupervisionGrant'],
      await this.http(`/threads/${threadId}/supervision`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      })
    )
    this.assertThreadRevision(threadId, revision)
    const lifetime = Date.parse(grant.expires_at) - Date.now()
    if (grant.thread_id !== threadId || lifetime <= 0 || lifetime > 60000)
      throw error('PROTOCOL_ERROR', 'Invalid supervision grant')
    const prior = this.supervisionGrants.get(threadId)
    if (prior) clearTimeout(prior.timer)
    this.supervisionGrants.set(threadId, {
      id: grant.supervision_grant_id,
      timer: setTimeout(() => this.closeThread(threadId), lifetime),
    })
    return grant
  }

  /** Multiple consumers share one wire subscription and release it with the last reference. */
  retainThread(threadId: string) {
    return this.threads.retain(threadId)
  }
  retryReplay(threadId: string, options: { snapshot?: boolean } = {}) {
    this.threads.retry(threadId, options.snapshot)
  }
  loadBefore(threadId: string, options: { before?: string; limit?: number } = {}) {
    return this.threads.loadBefore(threadId, options)
  }
  normalizeThreadId(threadId: string) {
    return this.checkId(threadId)
  }
  /** A new server snapshot discards proofs from the prior replay continuity. */
  resetThreadContinuity(threadId: string) {
    threadId = this.checkId(threadId)
    this.threadRevisions.set(threadId, (this.threadRevisions.get(threadId) ?? 0) + 1)
  }
  /** Internal access-loss boundary also fences in-flight receipts and removes retry intents. */
  forgetThread(threadId: string) {
    threadId = this.checkId(threadId)
    this.threadRevisions.set(threadId, (this.threadRevisions.get(threadId) ?? 0) + 1)
    this.artifacts.closeThread(threadId)
    this.interactionUploads.removeThread(threadId)
    this.interactions.removeThread(threadId)
    this.approvals.removeThread(threadId)
    this.approvalOutcomes.removeThread(threadId)
    this.feedback.removeThread(threadId)
    this.exports.removeThread(threadId)
    this.controls.removeThread(threadId)
    this.publications.removeThread(threadId)
    for (const key of this.intents.keys())
      if (JSON.parse(key)[0] === threadId) this.intents.delete(key)
  }
  private assertThreadRevision(threadId: string, revision: number) {
    if ((this.threadRevisions.get(threadId) ?? 0) !== revision)
      throw error('FORBIDDEN', 'Thread access changed during the request')
  }
  getConnection = () => this.connection
  subscribeConnection = (listener: () => void) => {
    this.observers.add(listener)
    return () => {
      this.observers.delete(listener)
    }
  }
  onFrame(listener: Listener) {
    this.frames.add(listener)
    return () => {
      this.frames.delete(listener)
    }
  }
  hasCapability(capability: string) {
    return (
      this.connection.status === 'connected' && this.connection.capabilities.includes(capability)
    )
  }

  connect(): Promise<void> {
    if (this.disposed) return Promise.reject(error('DISPOSED', 'Maestro client was disposed'))
    if (this.connection.status === 'connected') return Promise.resolve()
    if (this.connecting) return this.connecting
    if (this.refreshing) return this.refreshing
    this.stopped = false
    clearTimeout(this.reconnectTimer)
    this.controller.abort()
    this.controller = new AbortController()
    const generation = ++this.generation
    this.setConnection({ status: 'connecting', capabilities: [], handshake: null })
    const promise = this.open(generation)
      .catch((cause: unknown) => {
        const failure = this.failure(cause)
        if (generation === this.generation) {
          this.closeSocket(failure)
          if (authCodes.has(failure.code)) this.invalidate(failure)
          else {
            this.setConnection({ status: 'failed', capabilities: [], handshake: null })
            this.scheduleReconnect()
          }
          this.report(failure)
        }
        throw failure
      })
      .finally(() => {
        if (this.connecting === promise) this.connecting = null
      })
    this.connecting = promise
    return promise
  }

  /** Transport closure never requests execution cancellation. Retains uncertain receipts for explicit retry. */
  disconnect() {
    this.controls.disconnected()
    this.stopped = true
    this.generation++
    this.controller.abort()
    this.connecting = null
    this.refreshing = null
    clearTimeout(this.reconnectTimer)
    clearTimeout(this.expiryTimer)
    this.closeSocket(error('DISCONNECTED', 'Maestro disconnected', true))
    this.token = null
    this.setConnection({
      status: 'disconnected',
      capabilities: [],
      handshake: null,
      reconnectAttempt: 0,
    })
  }
  /** Scope/lifecycle disposal removes all private in-memory content. */
  reset() {
    this.interactionUploads.clear()
    this.interactions.clear()
    this.approvals.clear()
    this.approvalOutcomes.clear()
    this.feedback.clear()
    this.exports.clear()
    this.artifacts.clear()
    for (const grant of this.supervisionGrants.values()) clearTimeout(grant.timer)
    this.supervisionGrants.clear()
    this.disconnect()
    this.threads.reset()
    this.store.clear()
    this.controls.clear()
    this.publications.clear()
    this.intents.clear()
    this.sends.clear()
  }
  dispose() {
    this.reset()
    this.disposed = true
    this.frames.clear()
    this.observers.clear()
  }

  refreshAuth(credential: MaestroCredential = this.credential): Promise<void> {
    if (this.disposed) return Promise.reject(error('DISPOSED', 'Maestro client was disposed'))
    if (this.refreshing) {
      if (this.refreshingCredential === credential) return this.refreshing
      return this.refreshing.then(() => this.refreshAuth(credential))
    }
    if (this.connecting) return this.connecting.then(() => this.refreshAuth(credential))
    if (this.connection.status !== 'connected') {
      this.credential = credential
      return this.connect()
    }
    const generation = this.generation
    this.setConnection({ status: 'refreshing' })
    this.refreshingCredential = credential
    const promise = (async () => {
      const token = await this.resolveCredential(credential)
      this.assertGeneration(generation)
      if (this.transport === 'websocket') {
        const ack = await this.command('auth.refresh', { auth_token: token })
        const parsed = parseMaestroNetworkSchema('Public.WsAck.auth.refresh', ack) as {
          payload: { expires_at: string }
        }
        this.assertGeneration(generation)
        this.token = token
        this.armCredentialExpiry(token, parsed.payload.expires_at)
        this.setConnection({
          status: 'connected',
          handshake: this.connection.handshake
            ? { ...this.connection.handshake, expiresAt: parsed.payload.expires_at }
            : null,
        })
      } else {
        const data = await this.http('/capabilities', { method: 'GET' }, token)
        const caps = parseMaestroNetwork(publicSchemas['Public.Capabilities'], data)
        this.assertGeneration(generation)
        this.armCredentialExpiry(token)
        this.token = token
        this.setConnection({ status: 'connected', capabilities: caps.capabilities })
      }
      this.credential = credential
    })()
      .catch((cause: unknown) => {
        const failure = this.failure(cause)
        if (generation === this.generation) {
          this.invalidate(failure)
          this.report(failure)
        }
        throw failure
      })
      .finally(() => {
        if (this.refreshing === promise) {
          this.refreshing = null
          this.refreshingCredential = null
        }
      })
    this.refreshing = promise
    return promise
  }

  /** Creates a recoverable semantic identity before performing I/O. No offline queue. */
  prepareMessage(input: MaestroSendInput): Readonly<MaestroSendInput & { clientEventId: string }> {
    const clientEventId = input.clientEventId ?? crypto.randomUUID()
    const body = publicSchemas['Public.MessageCreateRequest'].parse({
      type: 'message.create',
      client_event_id: clientEventId,
      content: input.content,
      ...(input.mentions === undefined
        ? {}
        : { mentions: input.mentions.map((id) => this.checkId(id)) }),
      ...(input.agentOptions === undefined
        ? {}
        : {
            agent_options: input.agentOptions
              .map((option) => ({
                ...option,
                participant_id: this.checkId(option.participant_id),
              }))
              .sort((a, b) => a.participant_id.localeCompare(b.participant_id)),
          }),
    })
    const threadId = this.checkId(input.threadId)
    return immutable({
      threadId,
      clientEventId,
      content: body.content,
      ...(body.mentions === undefined ? {} : { mentions: body.mentions }),
      ...(body.agent_options === undefined ? {} : { agentOptions: body.agent_options }),
    })
  }
  send(
    input: MaestroSendInput,
    options: { transport?: MaestroTransport } = {}
  ): Promise<MaestroPublicationResult> {
    let prepared: ReturnType<MaestroClient['prepareMessage']>
    try {
      prepared = this.prepareMessage(input)
    } catch {
      return Promise.reject(error('INVALID_REQUEST', 'Invalid Maestro message'))
    }
    const key = publicationKey(prepared.threadId, prepared.clientEventId)
    const body: Message = immutable({
      type: 'message.create',
      client_event_id: prepared.clientEventId,
      content: prepared.content,
      mentions: prepared.mentions ?? [],
      agent_options: prepared.agentOptions ?? [],
    })
    const previous = this.intents.get(key)
    if (previous && canonical(previous) !== canonical(body))
      return Promise.reject(
        new MaestroClientError(
          'IDEMPOTENCY_CONFLICT',
          'The same publication key must preserve its original content',
          false,
          undefined,
          prepared.threadId,
          prepared.clientEventId,
          'rejected'
        )
      )
    const active = this.sends.get(key)
    if (active) return active
    const known = this.publications.get(prepared.threadId, prepared.clientEventId)
    if (known?.state === 'persisted' && known.result) return Promise.resolve(known.result)
    try {
      this.requireCapability('messages.text')
      if (body.content.some((part) => part.type === 'attachment'))
        this.requireCapability('attachments.durable')
      if (body.agent_options?.length) {
        if (!this.perAgentOptionsEnabled)
          throw error('UNSUPPORTED_CAPABILITY', 'Per-agent options require explicit opt-in')
        this.requireCapability('chat_context.per_agent')
      }
      if (!previous && this.intents.size >= this.maxPublications)
        throw error(
          'CAPACITY_EXCEEDED',
          'Publication memory limit reached; reconcile or dispose this scope'
        )
    } catch (cause) {
      return Promise.reject(this.failure(cause))
    }
    const transport = options.transport ?? this.transport
    if (!['http', 'websocket'].includes(transport))
      return Promise.reject(error('INVALID_REQUEST', 'Unknown transport'))
    if (transport === 'websocket' && this.socket?.readyState !== 1)
      return Promise.reject(error('DISCONNECTED', 'An authenticated WebSocket is required', true))
    try {
      this.store.optimistic(prepared)
    } catch (cause) {
      return Promise.reject(this.failure(cause))
    }
    this.intents.set(key, body)
    this.publications.set({
      threadId: prepared.threadId,
      clientEventId: prepared.clientEventId,
      state: 'pending',
    })
    const generation = this.generation
    const threadRevision = this.threadRevisions.get(prepared.threadId) ?? 0
    const promise = this.publish(prepared.threadId, body, transport)
      .then((raw) => {
        this.assertGeneration(generation)
        this.assertThreadRevision(prepared.threadId, threadRevision)
        const result = this.acceptReceipt(prepared.threadId, body, raw)
        this.store.receipt(result.event)
        this.publications.persist(result)
        return result
      })
      .catch((cause: unknown) => {
        // A validated live event can prove persistence before this request's ACK.
        // A later timeout, rejection or malformed ACK cannot retract that proof.
        const confirmed = this.publications.get(prepared.threadId, prepared.clientEventId)
        if (
          !this.disposed &&
          generation === this.generation &&
          (this.threadRevisions.get(prepared.threadId) ?? 0) === threadRevision &&
          confirmed?.state === 'persisted' &&
          confirmed.result
        )
          return confirmed.result
        const failure = this.failure(cause)
        // Transport loss and malformed/mismatched receipts cannot prove absence of commit.
        const state = failure.publicationState ?? 'unknown'
        const enriched = new MaestroClientError(
          failure.code,
          failure.message,
          failure.retryable,
          failure.requestId,
          prepared.threadId,
          prepared.clientEventId,
          state
        )
        if (
          !this.disposed &&
          generation === this.generation &&
          (this.threadRevisions.get(prepared.threadId) ?? 0) === threadRevision
        )
          this.publications.set({
            threadId: prepared.threadId,
            clientEventId: prepared.clientEventId,
            state,
            error: enriched,
          })
        else if (
          !this.disposed &&
          this.publications.get(prepared.threadId, prepared.clientEventId)?.state === 'pending'
        )
          this.publications.set({
            threadId: prepared.threadId,
            clientEventId: prepared.clientEventId,
            state: 'unknown',
            error: enriched,
          })
        this.report(enriched)
        throw enriched
      })
      .finally(() => {
        if (this.sends.get(key) === promise) this.sends.delete(key)
      })
    this.sends.set(key, promise)
    return promise
  }
  retry(threadId: string, clientEventId: string, options: { transport?: MaestroTransport } = {}) {
    threadId = this.checkId(threadId)
    const body = this.intents.get(publicationKey(threadId, clientEventId))
    if (!body)
      return Promise.reject(
        error('UNKNOWN_OPERATION', 'No publication with that key in this scope')
      )
    return this.send(
      {
        threadId,
        clientEventId,
        content: body.content,
        mentions: body.mentions,
        agentOptions: body.agent_options,
      },
      options
    )
  }

  async listThreads(
    options: {
      cursor?: string
      limit?: number
      state?: 'active' | 'archived' | 'deleting' | 'deleted'
    } = {}
  ) {
    this.requireCapability('threads.shared')
    const revisions = new Map(this.threadRevisions)
    const query = publicSchemas['Public.ThreadListQuery'].parse({
      ...options,
      scope_kind: this.scope.workspaceId ? 'workspace' : 'personal',
      ...(this.scope.workspaceId ? { workspace_id: this.scope.workspaceId } : {}),
    })
    const page = toMaestroThreadPage(
      parseMaestroNetwork(
        publicSchemas['Public.ThreadPage'],
        await this.http(`/threads${this.query(query)}`, { method: 'GET' })
      )
    )
    for (const thread of page.items) {
      this.assertThreadRevision(thread.threadId, revisions.get(thread.threadId) ?? 0)
      this.checkThreadScope(thread)
      this.store.observeThread(thread)
    }
    return page
  }
  async getThread(threadId: string) {
    return this.readThread(threadId, () => true)
  }
  /**
   * Cria uma thread no escopo desta sessão. O recibo 201 traz permissões neutras
   * (todas false); a projeção do leitor é relida antes de devolver a thread.
   */
  async createThread(
    request: Omit<
      z.infer<(typeof publicSchemas)['Public.ThreadCreateRequest']>,
      'scope_kind' | 'workspace_id'
    >,
    key: string
  ) {
    this.requireCapability('threads.shared')
    const headers = publicSchemas['Public.MutationHeaders'].parse({ 'Idempotency-Key': key })
    const body = publicSchemas['Public.ThreadCreateRequest'].parse(
      this.scope.workspaceId
        ? { ...request, scope_kind: 'workspace', workspace_id: this.scope.workspaceId }
        : { ...request, scope_kind: 'personal' }
    )
    const receipt = toMaestroThread(
      parseMaestroNetwork(
        publicSchemas['Public.Thread'],
        await this.http(
          '/threads',
          { method: 'POST', headers, body: JSON.stringify(body) },
          this.token,
          [200, 201]
        )
      )
    )
    this.checkThreadScope(receipt)
    return this.getThread(receipt.threadId)
  }
  /** @internal Atualização consultiva; respostas de uma subscription antiga são descartadas. */
  refreshThreadPermissions(threadId: string, current: () => boolean) {
    return this.readThread(threadId, current)
  }
  private async readThread(threadId: string, current: () => boolean) {
    this.requireCapability('threads.shared')
    threadId = this.checkId(threadId)
    const revision = this.threadRevisions.get(threadId) ?? 0
    let thread: ReturnType<typeof toMaestroThread>
    try {
      thread = toMaestroThread(
        parseMaestroNetwork(
          publicSchemas['Public.Thread'],
          await this.http(`/threads/${threadId}`, {
            method: 'GET',
            headers: this.grantHeader(threadId),
          })
        )
      )
    } catch (cause) {
      if (
        cause instanceof MaestroClientError &&
        ['NOT_FOUND', 'FORBIDDEN', 'UNAUTHENTICATED', 'THREAD_DELETING'].includes(cause.code)
      )
        this.closeThread(threadId)
      throw cause
    }
    this.assertThreadRevision(threadId, revision)
    this.checkThreadScope(thread)
    if (thread.threadId !== threadId) throw error('PROTOCOL_ERROR', 'Thread response mismatch')
    if (current()) this.store.observeThread(thread, true)
    return thread
  }
  async getHistory(
    threadId: string,
    options: { after?: string; before?: string; limit?: number } = {}
  ) {
    this.requireCapability('history.replay')
    threadId = this.checkId(threadId)
    const revision = this.threadRevisions.get(threadId) ?? 0
    const query = publicSchemas['Public.EventsQuery'].parse(options)
    const page = toMaestroEventPage(
      parseMaestroNetwork(
        publicSchemas['Public.EventPage'],
        await this.http(`/threads/${threadId}/events${this.query(query)}`, {
          method: 'GET',
          headers: this.grantHeader(threadId),
        })
      )
    )
    this.assertThreadRevision(threadId, revision)
    if (page.items.some((item) => item.threadId !== threadId))
      throw error('PROTOCOL_ERROR', 'History response mismatch')
    return page
  }
  /** Receive-compatible page reader; unlike getHistory it retains future event envelopes. */
  async getHistoryPage(
    threadId: string,
    options: { after?: string; before?: string; limit?: number } = {}
  ) {
    this.requireCapability('history.replay')
    threadId = this.checkId(threadId)
    const revision = this.threadRevisions.get(threadId) ?? 0
    const query = publicSchemas['Public.EventsQuery'].parse(options)
    const page = readMaestroNetworkPage(
      await this.http(`/threads/${threadId}/events${this.query(query)}`, {
        method: 'GET',
        headers: this.grantHeader(threadId),
      })
    )
    this.assertThreadRevision(threadId, revision)
    if (page.items.some((item) => item.event.threadId !== threadId))
      throw error('PROTOCOL_ERROR', 'History response mismatch')
    return page
  }
  /** Low-level single wire subscription; retainThread owns reference counts and recovery. */
  async subscribeThread(
    threadId: string,
    cursor?: string,
    onSubscribed?: (subscriptionId: string, watermark: string, mode: 'snapshot' | 'replay') => void
  ) {
    this.requireCapability('history.replay')
    threadId = this.checkId(threadId)
    const frame = await this.command(
      'thread.subscribe',
      {
        thread_id: threadId,
        ...(this.supervisionGrants.has(threadId)
          ? { supervision_grant_id: this.supervisionGrants.get(threadId)!.id }
          : {}),
        ...(cursor === undefined ? {} : { cursor }),
      },
      (accepted) => {
        const ack = accepted as {
          payload: {
            subscription_id: string
            replay_watermark: string
            replay_mode: 'snapshot' | 'replay'
          }
        }
        onSubscribed?.(
          ack.payload.subscription_id,
          ack.payload.replay_watermark,
          ack.payload.replay_mode
        )
      }
    )
    const ack = parseMaestroNetworkSchema('Public.WsAck.thread.subscribe', frame) as {
      payload: {
        subscription_id: string
        replay_watermark: string
        replay_mode: 'snapshot' | 'replay'
      }
    }
    return {
      subscriptionId: ack.payload.subscription_id,
      replayWatermark: ack.payload.replay_watermark,
      replayMode: ack.payload.replay_mode,
    }
  }
  async unsubscribeThread(subscriptionId: string) {
    this.requireCapability('history.replay')
    subscriptionId = this.checkId(subscriptionId)
    this.subscriptions.delete(subscriptionId)
    const frame = await this.command('thread.unsubscribe', { subscription_id: subscriptionId })
    const ack = parseMaestroNetworkSchema('Public.WsAck.thread.unsubscribe', frame) as {
      payload: { subscription_id: string }
    }
    if (ack.payload.subscription_id !== subscriptionId)
      throw error('PROTOCOL_ERROR', 'Subscription response mismatch')
    this.subscriptions.delete(subscriptionId)
  }

  cancelExecution(
    input: Omit<Extract<MaestroControlInput, { type: 'execution.cancel' }>, 'type'>,
    options: { transport?: MaestroTransport } = {}
  ) {
    return this.controls.request({ ...input, type: 'execution.cancel' }, options)
  }
  stopRoot(
    input: Omit<Extract<MaestroControlInput, { type: 'root.stop' }>, 'type'>,
    options: { transport?: MaestroTransport } = {}
  ) {
    return this.controls.request({ ...input, type: 'root.stop' }, options)
  }
  private async sendControl(
    intent: MaestroControlIntent,
    transport: MaestroTransport = this.transport
  ) {
    this.requireCapability('executions.cancel')
    const revision = this.threadRevisions.get(intent.threadId) ?? 0
    const generation = this.generation
    const reason = intent.reasonCode === undefined ? {} : { reason_code: intent.reasonCode }
    const cancel = intent.type === 'execution.cancel'
    const payload = cancel
      ? { execution_id: intent.executionId, idempotency_key: intent.idempotencyKey, ...reason }
      : {
          thread_id: intent.threadId,
          root_event_id: intent.rootEventId,
          idempotency_key: intent.idempotencyKey,
          ...reason,
        }
    let response: unknown
    if (transport === 'websocket') {
      const frame = (await this.command(intent.type, payload)) as { payload: unknown }
      response = frame.payload
    } else if (transport === 'http') {
      response = await this.http(
        cancel
          ? `/executions/${intent.executionId}/cancel`
          : `/threads/${intent.threadId}/roots/${intent.rootEventId}/stop`,
        {
          method: 'POST',
          headers: { 'Idempotency-Key': intent.idempotencyKey },
          body: JSON.stringify(reason),
        },
        this.token,
        cancel ? [202] : [200]
      )
    } else throw error('INVALID_REQUEST', 'Unknown transport')
    this.assertGeneration(generation)
    this.assertThreadRevision(intent.threadId, revision)
    if (cancel) {
      const ack = parseMaestroNetwork(publicSchemas['Public.CancelResponse'], response)
      if (ack.execution_id !== intent.executionId)
        throw error('PROTOCOL_ERROR', 'Cancellation target mismatch')
    } else {
      const ack = parseMaestroNetwork(publicSchemas['Public.StopResponse'], response)
      if (ack.root_event_id !== intent.rootEventId)
        throw error('PROTOCOL_ERROR', 'Root stop target mismatch')
    }
  }

  private async open(generation: number) {
    const token = await this.resolveCredential(this.credential)
    this.assertGeneration(generation)
    if (this.transport === 'http') {
      const caps = parseMaestroNetwork(
        publicSchemas['Public.Capabilities'],
        await this.http('/capabilities', { method: 'GET' }, token)
      )
      this.assertGeneration(generation)
      this.armCredentialExpiry(token)
      this.token = token
      this.setConnection({
        status: 'connected',
        capabilities: caps.capabilities,
        reconnectAttempt: 0,
      })
      return
    }
    const socket = (this.config.socketFactory ?? ((url) => new WebSocket(url)))(this.socketUrl)
    this.socket = socket
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(error('TIMEOUT', 'WebSocket open timed out', true)),
        this.timeoutMs
      )
      socket.onopen = () => {
        clearTimeout(timer)
        resolve()
      }
      socket.onclose = () => {
        clearTimeout(timer)
        reject(error('DISCONNECTED', 'WebSocket closed before connect', true))
      }
      socket.onerror = () => {
        clearTimeout(timer)
        reject(error('NETWORK_ERROR', 'WebSocket could not open', true))
      }
      this.controller.signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer)
          reject(error('DISCONNECTED', 'Connection canceled', true))
        },
        { once: true }
      )
    })
    this.assertGeneration(generation)
    socket.onmessage = (event) => {
      if (generation === this.generation) this.receive(event.data)
    }
    socket.onclose = () => {
      if (generation === this.generation && !this.stopped)
        this.lost(error('DISCONNECTED', 'WebSocket connection lost', true))
    }
    socket.onerror = () => {
      if (generation === this.generation)
        this.lost(error('NETWORK_ERROR', 'WebSocket transport failed', true))
    }
    const command = createMaestroConnectCommand({
      requestId: crypto.randomUUID(),
      authToken: token,
      clientCapabilities: [
        'messages.text',
        'attachments.durable',
        'feedback',
        'export',
        ...(this.durableFormsEnabled ? ['interactions.forms'] : []),
        ...(this.toolApprovalsEnabled ? ['interactions.tool_approval'] : []),
        ...(this.perAgentOptionsEnabled ? ['chat_context.per_agent'] : []),
      ],
    })
    const ack = toMaestroConnectAck(await this.request(command))
    this.assertGeneration(generation)
    this.token = token
    this.armCredentialExpiry(token, ack.expiresAt)
    this.setConnection({
      status: 'connected',
      capabilities: ack.capabilities,
      handshake: ack,
      reconnectAttempt: 0,
    })
    this.armHeartbeat()
  }

  private async publish(
    threadId: string,
    body: Message,
    transport: MaestroTransport
  ): Promise<unknown> {
    if (transport === 'http')
      return this.http(`/threads/${threadId}/events`, {
        method: 'POST',
        headers: { 'Idempotency-Key': body.client_event_id },
        body: JSON.stringify(body),
      })
    const { type: _, ...message } = body
    const ack = await this.command('message.publish', { thread_id: threadId, ...message })
    return (ack as { payload: unknown }).payload
  }
  private acceptReceipt(threadId: string, body: Message, raw: unknown): MaestroPublicationResult {
    const receipt = toMaestroPersistedResponse(
      parseMaestroNetwork(publicSchemas['Public.PersistedResponse'], raw)
    )
    return this.acceptPublicationEvent(
      threadId,
      body,
      receipt.event,
      receipt.cursor,
      receipt.duplicate
    )
  }
  private acceptPublicationEvent(
    threadId: string,
    body: Message,
    event: MaestroEvent,
    cursor: string,
    duplicate: boolean
  ): MaestroPublicationResult {
    if (
      event.type !== 'message.created' ||
      event.threadId !== threadId ||
      event.actor.kind !== 'human' ||
      event.actor.principalId !== this.scope.principalId ||
      event.payload.client_event_id !== body.client_event_id ||
      canonical({
        content: event.payload.content,
        mentions: event.payload.mentions,
        agent_options: event.payload.agent_options ?? [],
      }) !==
        canonical({
          content: body.content,
          mentions: body.mentions ?? [],
          agent_options: body.agent_options ?? [],
        })
    )
      throw error('PROTOCOL_ERROR', 'Publication receipt does not match the original intention')
    return immutable({
      threadId,
      eventId: event.eventId,
      cursor,
      clientEventId: body.client_event_id,
      duplicate,
      event,
    })
  }
  private command(
    command: string,
    payload: unknown,
    onAccepted?: (frame: unknown) => void,
    requestForbidden = false
  ) {
    const schema = wsCommandSchemas[command]
    if (!schema)
      return Promise.reject(error('UNSUPPORTED_CAPABILITY', 'Unsupported Maestro command'))
    const parsed = schema.safeParse({ id: crypto.randomUUID(), type: command, payload })
    if (!parsed.success) return Promise.reject(error('INVALID_REQUEST', 'Invalid Maestro command'))
    return this.request(parsed.data, onAccepted, requestForbidden)
  }
  private request(
    frame: { id: string; type: string; payload: unknown },
    onAccepted?: (frame: unknown) => void,
    requestForbidden = false
  ): Promise<unknown> {
    if (this.socket?.readyState !== 1)
      return Promise.reject(error('DISCONNECTED', 'No open Maestro WebSocket', true))
    if (this.requests.size >= 100)
      return Promise.reject(error('CAPACITY_EXCEEDED', 'Too many pending commands'))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requests.delete(frame.id)
        reject(error('TIMEOUT', 'Command confirmation timed out', true))
      }, this.timeoutMs)
      this.requests.set(frame.id, {
        command: frame.type,
        onAccepted,
        requestForbidden,
        payload: frame.payload,
        resolve,
        reject,
        timer,
      })
      try {
        this.socket!.send(JSON.stringify(frame))
      } catch {
        clearTimeout(timer)
        this.requests.delete(frame.id)
        reject(error('NETWORK_ERROR', 'Command could not be sent', true))
      }
    })
  }
  private receive(data: unknown) {
    try {
      if (typeof data !== 'string' || new TextEncoder().encode(data).length > this.maxBytes)
        throw error('PROTOCOL_ERROR', 'Invalid or oversized WebSocket frame')
      const frame: unknown = JSON.parse(data)
      if (
        !frame ||
        typeof frame !== 'object' ||
        !('type' in frame) ||
        typeof frame.type !== 'string'
      )
        throw error('PROTOCOL_ERROR', 'Malformed WebSocket frame')
      if (frame.type === 'ack' || frame.type === 'error' || frame.type === 'pong') {
        if (!('id' in frame) || typeof frame.id !== 'string')
          throw error('PROTOCOL_ERROR', 'Missing response correlation')
        const pending = this.requests.get(frame.id)
        if (!pending) return // Duplicate or late response cannot settle another command.
        const parsed =
          frame.type === 'error'
            ? parseMaestroNetwork(publicSchemas['Public.WsError'], frame)
            : parseMaestroNetworkSchema(
                pending.command === 'ping' ? 'Public.WsPong' : `Public.WsAck.${pending.command}`,
                frame
              )
        clearTimeout(pending.timer)
        this.requests.delete(frame.id)
        if (frame.type === 'error') {
          const payload = (parsed as z.infer<(typeof publicSchemas)['Public.WsError']>).payload
          const failure = new MaestroClientError(
            payload.code,
            payload.message,
            payload.retryable,
            frame.id,
            undefined,
            undefined,
            rejectionState(payload.code)
          )
          pending.reject(failure)
          if (
            authCodes.has(payload.code) &&
            !(pending.requestForbidden && payload.code === 'FORBIDDEN')
          )
            this.invalidate(failure)
        } else {
          if (pending.command === 'thread.subscribe') {
            const ack = parsed as { payload: { subscription_id: string } }
            const threadId = (pending.payload as { thread_id: string }).thread_id
            this.subscriptions.set(ack.payload.subscription_id, threadId)
          }
          pending.onAccepted?.(parsed)
          pending.resolve(parsed)
        }
        return
      }
      if (frame.type === 'event.append') {
        this.append(frame)
        return
      }
      const schema = wsFrameSchemas[frame.type]
      if (!schema) return // Unknown unsolicited frames are ignored, never capabilities/ACKs.
      const parsed =
        frame.type === 'thread.snapshot' || frame.type === 'thread.replay'
          ? readMaestroReplayFrame(frame.type, frame)
          : parseMaestroNetwork(schema, frame)
      if (this.connection.status !== 'connected' && this.connection.status !== 'refreshing')
        throw error('PROTOCOL_ERROR', 'Unsolicited data before authenticated handshake')
      if (parsed.type === 'session.expired') {
        this.invalidate(error('UNAUTHENTICATED', 'Maestro session expired'))
        return
      }
      if (parsed.type === 'session.expiring') {
        this.requestCredential('session_expiring')
        return
      }
      if ('subscription_id' in parsed.payload) {
        if (!this.subscriptions.has(parsed.payload.subscription_id)) return
        if (parsed.type === 'subscription.revoked' || parsed.type === 'resync.required')
          this.subscriptions.delete(parsed.payload.subscription_id)
      }
      if (parsed.type === 'stream.delta' || parsed.type === 'stream.reset') {
        const stream = parseMaestroNetwork(schema, frame).payload
        if (
          !('thread_id' in stream) ||
          !this.hasCapability('stream.delta') ||
          ![...this.subscriptions.values()].includes(stream.thread_id)
        )
          return
        if ('delta' in stream) this.store.streamDelta(stream)
        else if ('output_id' in stream && 'reason_code' in stream) this.store.streamReset(stream)
        return
      }
      this.emit(parsed)
      // Replay/snapshot events become publication proof only after the SDK has
      // validated continuity and scope, never by a second UI-level event merge.
      if (parsed.type === 'thread.caught_up' && 'subscription_id' in parsed.payload) {
        const threadId = this.subscriptions.get(parsed.payload.subscription_id)
        const state = threadId ? this.store.getThread(threadId) : undefined
        if (threadId && state?.phase === 'live' && state.resumeCursor) {
          for (const item of Object.values(state.eventsById)) {
            if (item.known)
              this.confirmObservedPublication(threadId, item.event, state.resumeCursor)
          }
        }
      }
    } catch (cause) {
      this.report(this.failure(cause))
      this.lost(error('PROTOCOL_ERROR', 'Invalid Maestro server response'))
    }
  }
  private append(value: object) {
    // Derive the envelope from frozen frame fields; the event adapter separately
    // permits future event types without confirming or enabling them.
    const schema = wsFrameSchemas['event.append']!
    const payloadSchema: z.ZodObject = schema.shape.payload
    if (!('event' in payloadSchema.shape)) throw error('PROTOCOL_ERROR', 'Missing append schema')
    const envelope = schema.extend({ payload: payloadSchema.omit({ event: true }) })
    const { payload } = parseMaestroNetwork(envelope, value)
    if (typeof payload.subscription_id !== 'string' || typeof payload.cursor !== 'string')
      throw error('PROTOCOL_ERROR', 'Invalid append envelope')
    const thread = this.subscriptions.get(payload.subscription_id)
    if (!thread) return
    const source = value as { payload: { event: unknown } }
    const parsed = readMaestroNetworkEvent(source.payload.event)
    if (parsed.event.thread_id !== thread)
      throw error('PROTOCOL_ERROR', 'Subscription thread mismatch')
    if (parsed.known)
      this.confirmObservedPublication(thread, toMaestroEvent(parsed.event), payload.cursor)
    this.emit({
      type: 'event.append',
      payload: { ...payload, event: parsed.event, known: parsed.known },
    })
  }

  private confirmObservedPublication(threadId: string, event: MaestroEvent, cursor: string) {
    if (
      event.type !== 'message.created' ||
      event.actor.kind !== 'human' ||
      event.actor.principalId !== this.scope.principalId ||
      !event.payload.client_event_id
    )
      return
    const intent = this.intents.get(publicationKey(threadId, event.payload.client_event_id))
    if (!intent) return
    const result = this.acceptPublicationEvent(threadId, intent, event, cursor, false)
    const previous = this.publications.get(threadId, event.payload.client_event_id)
    if (previous?.state === 'persisted') {
      if (canonical(previous.result?.event) !== canonical(event))
        throw error('PROTOCOL_ERROR', 'Conflicting canonical publication')
      return
    }
    this.store.receipt(result.event)
    this.publications.persist(result)
  }
  private async http(
    path: string,
    init: RequestInit,
    token = this.token,
    accepted = [200, 201],
    maximumBytes = this.maxBytes,
    requestForbidden = false,
    rootPath = false
  ): Promise<unknown> {
    if (!token) throw error('UNAUTHENTICATED', 'Maestro credential unavailable')
    const generation = this.generation
    const localController = new AbortController()
    const signal = AbortSignal.any([
      this.controller.signal,
      ...(init.signal ? [init.signal] : []),
      localController.signal,
      AbortSignal.timeout(this.timeoutMs),
    ])
    const wait = <T>(operation: Promise<T>): Promise<T> => {
      if (!init.signal) return operation
      return new Promise<T>((resolve, reject) => {
        const abort = () => {
          signal.removeEventListener('abort', abort)
          reject(
            error(
              signal.reason?.name === 'TimeoutError' ? 'TIMEOUT' : 'DISCONNECTED',
              'Private HTTP read canceled',
              true
            )
          )
        }
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
        operation.then(
          (value) => {
            signal.removeEventListener('abort', abort)
            resolve(value)
          },
          (cause) => {
            signal.removeEventListener('abort', abort)
            reject(cause)
          }
        )
      })
    }
    let response: Response | undefined
    try {
      const fetching = (this.config.fetch ?? globalThis.fetch)(
        `${rootPath ? this.origin : this.api}${path}`,
        {
          ...init,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
            ...(init.body ? { 'Content-Type': 'application/json' } : {}),
            ...init.headers,
          },
          credentials: 'omit',
          redirect: 'error',
          cache: 'no-store',
          signal,
        }
      )
      if (init.signal)
        void fetching.then(
          (late) => {
            if (signal.aborted) void late.body?.cancel().catch(() => {})
          },
          () => {}
        )
      response = await wait(fetching)
      this.assertGeneration(generation)
      if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? ''))
        throw error('PROTOCOL_ERROR', 'Expected a JSON response')
      const reader = response.body?.getReader()
      if (!reader) throw error('PROTOCOL_ERROR', 'Empty HTTP response')
      let total = 0
      const chunks: Uint8Array[] = []
      try {
        for (;;) {
          const chunk = await wait(reader.read())
          if (chunk.done) break
          total += chunk.value.byteLength
          if (total > maximumBytes)
            throw error('PROTOCOL_ERROR', 'HTTP response exceeds byte limit')
          chunks.push(chunk.value)
        }
      } finally {
        await reader.cancel().catch(() => {})
        reader.releaseLock()
      }
      this.assertGeneration(generation)
      const bytes = new Uint8Array(total)
      let offset = 0
      for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.byteLength
      }
      const data: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
      if (!response.ok) {
        const parsed = parseMaestroNetwork(publicSchemas['Public.Error'], data).error
        const failure = new MaestroClientError(
          parsed.code,
          parsed.message,
          parsed.retryable,
          parsed.request_id,
          undefined,
          undefined,
          rejectionState(parsed.code, response.status)
        )
        if (
          authCodes.has(parsed.code) &&
          !(requestForbidden && parsed.code === 'FORBIDDEN' && response.status !== 401)
        )
          this.invalidate(failure)
        throw failure
      }
      if (!accepted.includes(response.status))
        throw error('PROTOCOL_ERROR', 'Unexpected HTTP status')
      return data
    } catch (cause) {
      if (cause instanceof MaestroClientError) throw cause
      throw error('NETWORK_ERROR', 'Maestro HTTP response unavailable', true)
    } finally {
      localController.abort()
      if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {})
    }
  }
  private async resolveCredential(credential: MaestroCredential) {
    const controller = new AbortController()
    const signal = AbortSignal.any([this.controller.signal, controller.signal])
    let timer: ReturnType<typeof setTimeout> | undefined
    let abort: (() => void) | undefined
    const canceled = new Promise<never>((_, reject) => {
      abort = () => reject(error('DISCONNECTED', 'Credential request canceled', true))
      signal.addEventListener('abort', abort, { once: true })
      timer = setTimeout(() => {
        reject(error('TIMEOUT', 'Credential resolution timed out', true))
        controller.abort()
      }, this.timeoutMs)
    })
    let token: string
    try {
      token = await Promise.race([
        typeof credential === 'function' ? credential({ scope: this.scope, signal }) : credential,
        canceled,
      ])
    } finally {
      clearTimeout(timer)
      if (abort) signal.removeEventListener('abort', abort)
    }
    if (
      typeof token !== 'string' ||
      token.length < 1 ||
      token.length > 16384 ||
      /[\r\n]/.test(token)
    )
      throw error('UNAUTHENTICATED', 'Invalid Maestro credential')
    inspectMaestroHumanCredential(token, this.scope)
    return token
  }
  private requireCapability(capability: string) {
    if (this.connection.status !== 'connected')
      throw error('DISCONNECTED', 'Authenticate Maestro before sending commands', true)
    if (!this.hasCapability(capability))
      throw error('UNSUPPORTED_CAPABILITY', `Maestro capability unavailable: ${capability}`)
  }
  private checkId(id: string) {
    if (!uuidSchema.safeParse(id).success)
      throw error('INVALID_REQUEST', 'Invalid Maestro resource ID')
    return id.toLowerCase()
  }
  private checkThreadScope(thread: ReturnType<typeof toMaestroThread>) {
    if (
      thread.organizationId !== this.scope.organizationId ||
      thread.workspaceId !== this.scope.workspaceId
    )
      throw error('PROTOCOL_ERROR', 'Thread scope mismatch')
  }
  private query(values: object) {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(values))
      if (value !== undefined && value !== null) params.set(key, String(value))
    return params.size ? `?${params}` : ''
  }
  private assertGeneration(generation: number) {
    if (generation !== this.generation || this.disposed || this.controller.signal.aborted)
      throw error('DISCONNECTED', 'Maestro session changed', true)
  }
  private failure(cause: unknown) {
    return cause instanceof MaestroClientError
      ? cause
      : error('PROTOCOL_ERROR', 'Invalid Maestro response')
  }
  private setConnection(update: Partial<MaestroConnection>) {
    this.connection = immutable({ ...this.connection, ...update })
    this.store.setStreamCapability(
      this.connection.status === 'connected' &&
        this.connection.capabilities.includes('stream.delta')
    )
    for (const observer of this.observers) {
      try {
        observer()
      } catch {}
    }
  }
  private emit(frame: { type: string; payload: unknown }) {
    for (const listener of this.frames) {
      try {
        listener(immutable(frame))
      } catch {}
    }
  }
  private report(failure: MaestroClientError) {
    try {
      this.config.onError?.(failure)
    } catch {}
  }
  private closeSocket(failure: MaestroClientError) {
    clearTimeout(this.heartbeatTimer)
    const socket = this.socket
    this.socket = null
    if (socket) {
      socket.onclose = null
      socket.onmessage = null
      socket.onerror = null
      socket.onopen = null
      try {
        socket.close(1000, 'client_cleanup')
      } catch {}
    }
    for (const request of this.requests.values()) {
      clearTimeout(request.timer)
      request.reject(failure)
    }
    this.requests.clear()
    this.subscriptions.clear()
  }
  private lost(failure: MaestroClientError) {
    this.interactionUploads.invalidateRecovery()
    this.generation++
    this.controller.abort()
    this.connecting = null
    this.refreshing = null
    clearTimeout(this.expiryTimer)
    this.closeSocket(failure)
    this.token = null
    this.controls.disconnected()
    this.setConnection({ status: 'disconnected', capabilities: [], handshake: null })
    this.emit({ type: 'client.disconnected', payload: { code: failure.code } })
    this.scheduleReconnect()
  }
  private invalidate(failure: MaestroClientError) {
    this.interactionUploads.clear()
    this.interactions.clear()
    this.approvals.clear()
    this.approvalOutcomes.clear()
    this.feedback.clear()
    this.exports.clear()
    this.artifacts.clear()
    this.stopped = true
    this.generation++
    this.controller.abort()
    this.connecting = null
    this.refreshing = null
    clearTimeout(this.reconnectTimer)
    clearTimeout(this.expiryTimer)
    this.closeSocket(failure)
    this.token = null
    this.controls.clear()
    this.publications.clear()
    this.intents.clear()
    this.sends.clear()
    this.setConnection({ status: 'unauthenticated', capabilities: [], handshake: null })
    this.emit({ type: 'client.access_lost', payload: { code: failure.code } })
    this.requestCredential(failure.code)
  }
  private requestCredential(reason: string) {
    const generation = this.generation
    if (!this.config.onAuthRequired) return
    Promise.resolve()
      .then(() => this.config.onAuthRequired?.(reason))
      .then((credential) => {
        if (credential && generation === this.generation && !this.disposed)
          return this.refreshAuth(credential)
      })
      .catch((cause) => this.report(this.failure(cause)))
  }
  private armCredentialExpiry(token: string, expiresAt?: string) {
    const expires = inspectMaestroHumanCredential(token, this.scope)
    this.armExpiry(
      new Date(Math.min(expires, expiresAt ? Date.parse(expiresAt) : expires)).toISOString()
    )
  }
  private armExpiry(expiresAt: string) {
    const remaining = Date.parse(expiresAt) - Date.now()
    if (remaining <= 0 || remaining > 2147483647)
      throw error('UNAUTHENTICATED', 'Invalid session expiry')
    clearTimeout(this.expiryTimer)
    this.expiryTimer = setTimeout(
      () => this.invalidate(error('UNAUTHENTICATED', 'Maestro session expired')),
      remaining
    )
  }
  private armHeartbeat() {
    clearTimeout(this.heartbeatTimer)
    this.heartbeatTimer = setTimeout(async () => {
      if (this.connection.status === 'refreshing') {
        this.armHeartbeat()
        return
      }
      if (this.connection.status !== 'connected') return
      const generation = this.generation
      const nonce = crypto.randomUUID()
      try {
        const pong = (await this.command('ping', { nonce })) as { payload: { nonce: string } }
        if (pong.payload.nonce !== nonce) throw error('PROTOCOL_ERROR', 'Heartbeat nonce mismatch')
        this.armHeartbeat()
      } catch (cause) {
        if (!this.stopped && generation === this.generation) this.lost(this.failure(cause))
      }
    }, this.heartbeatMs)
  }
  private scheduleReconnect() {
    if (this.stopped || this.disposed || this.transport !== 'websocket') return
    const attempt = this.connection.reconnectAttempt + 1
    if (attempt > this.reconnectLimit) {
      this.setConnection({ status: 'failed' })
      return
    }
    const ceiling = Math.min(this.reconnectMax, this.reconnectBase * 2 ** (attempt - 1))
    this.setConnection({ status: 'reconnecting', reconnectAttempt: attempt })
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = setTimeout(
      () => {
        void this.connect().catch(() => {})
      },
      ceiling / 2 + (Math.random() * ceiling) / 2
    )
  }
}
