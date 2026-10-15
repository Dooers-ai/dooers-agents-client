import type { z } from 'zod'
import { cursorSchema, sequenceSchema } from './vendor/common.js'
import { publicSchemas, wsAckSchemas, wsCommandSchemas } from './vendor/public.js'

/** Strict v1 conformity schemas. Network compatibility adapters are a separate layer. */
export { publicSchemas as maestroPublicSchemas } from './vendor/public.js'
export const MAESTRO_PROTOCOL_VERSION = 1 as const
export const MAESTRO_CONTRACT_MANIFEST_SHA256 =
  '7792256d9967ae2e3307b8dd627561e750ffeebc6f39ab270dbfd687336a1fcd'
export const MAESTRO_CONTRACT_SOURCE_REVISION =
  'sha256:a32633a5ae4eebe94786fac40da632314bbcc75e7ad07ed1c562714e735e583b'

export type MaestroWireEvent = z.infer<(typeof publicSchemas)['Public.Event']>
export type MaestroWireThread = z.infer<(typeof publicSchemas)['Public.Thread']>
export type MaestroWireParticipant = z.infer<(typeof publicSchemas)['Public.Participant']>
export type MaestroWireActor = z.infer<(typeof publicSchemas)['Public.Actor']>

export class MaestroContractError extends Error {
  readonly code = 'INVALID_MAESTRO_CONTRACT'
  constructor(readonly schema: string) {
    super(`Invalid Maestro v1 contract: ${schema}`)
    this.name = 'MaestroContractError'
  }
}

const registry: Readonly<Record<string, z.ZodType>> = publicSchemas

/** Does not authorize an operation or establish capability availability. */
export function validateMaestroContract(schema: string, value: unknown): boolean {
  return Object.hasOwn(registry, schema) && registry[schema]?.safeParse(value).success === true
}

function parse<T extends z.ZodType>(schema: T, name: string, value: unknown): z.output<T> {
  const result = schema.safeParse(value)
  if (!result.success) throw new MaestroContractError(name)
  return result.data
}

/** Numeric comparison without Number conversion, BigInt serialization, or cursor decoding. */
export function compareMaestroSequences(left: string, right: string): -1 | 0 | 1 {
  parse(sequenceSchema, 'sequence', left)
  parse(sequenceSchema, 'sequence', right)
  if (left.length !== right.length) return left.length < right.length ? -1 : 1
  return left === right ? 0 : left < right ? -1 : 1
}

export function parseMaestroCursor(value: unknown): string {
  return parse(cursorSchema, 'cursor', value)
}

export interface MaestroConnectInput {
  requestId: string
  authToken: string
  clientCapabilities?: readonly string[]
}

/** Only builds a validated frame; it neither opens a socket nor logs the credential. */
export function createMaestroConnectCommand(input: MaestroConnectInput) {
  const frame = {
    id: input.requestId,
    type: 'connect' as const,
    payload: {
      auth_token: input.authToken,
      protocol_version: MAESTRO_PROTOCOL_VERSION,
      client_capabilities: [...(input.clientCapabilities ?? [])],
    },
  }
  const schema = wsCommandSchemas['connect']
  if (!schema) throw new MaestroContractError('Public.WsCommand.connect')
  parse(schema, 'Public.WsCommand.connect', frame)
  return frame
}

export function toMaestroConnectAck(value: unknown) {
  const schema = wsAckSchemas['connect']
  if (!schema) throw new MaestroContractError('Public.WsAck.connect')
  const frame = parse(schema, 'Public.WsAck.connect', value)
  // The generated registry has a broad union value type; this guard narrows the
  // already validated payload without asserting a separate wire definition.
  if (!('connection_id' in frame.payload)) {
    throw new MaestroContractError('Public.WsAck.connect')
  }
  return {
    requestId: frame.id,
    status: frame.payload.status,
    connectionId: frame.payload.connection_id,
    expiresAt: frame.payload.expires_at,
    protocolVersion: frame.payload.protocol_version,
    serverVersion: frame.payload.server_version,
    historyAuthority: frame.payload.history_authority,
    capabilities: [...frame.payload.capabilities],
  }
}

/** Missing advertisement is always false; package/server version is not consulted. */
export function hasMaestroCapability(
  capabilities: readonly string[] | undefined,
  capability: string
): boolean {
  return capabilities?.includes(capability) === true
}

function actorToPublic(actor: MaestroWireActor) {
  const shared = {
    kind: actor.kind,
    principalId: actor.principal_id,
    participantId: actor.participant_id,
    displayName: actor.display_name,
  }
  return actor.kind === 'agent'
    ? { ...shared, kind: actor.kind, instanceAgentId: actor.instance_agent_id }
    : { ...shared, kind: actor.kind }
}

export function toMaestroParticipant(value: unknown) {
  const item = parse(publicSchemas['Public.Participant'], 'Public.Participant', value)
  const shared = {
    participantId: item.participant_id,
    principalId: item.principal_id,
    displayName: item.display_name,
    ...(item.avatar_url === undefined ? {} : { avatarUrl: item.avatar_url }),
    state: item.state,
    joinedSequence: item.joined_sequence,
    leftSequence: item.left_sequence,
  }
  return item.kind === 'agent'
    ? {
        ...shared,
        kind: item.kind,
        role: item.role,
        instanceAgentId: item.instance_agent_id,
        capabilities: [...item.capabilities],
        availability: item.availability,
      }
    : { ...shared, kind: item.kind, role: item.role }
}

function eventToPublic(event: MaestroWireEvent) {
  return {
    eventId: event.event_id,
    threadId: event.thread_id,
    sequence: event.sequence,
    type: event.type,
    schemaVersion: event.schema_version,
    actor: actorToPublic(event.actor),
    // Domain payloads retain their canonical, discriminated wire shape. Never
    // recursively rename arbitrary form fields, option keys, or user content.
    payload: event.payload,
    createdAt: event.created_at,
    causationEventId: event.causation_event_id,
    rootEventId: event.root_event_id,
    ...(event.delivery_id === undefined ? {} : { deliveryId: event.delivery_id }),
    ...(event.execution_id === undefined ? {} : { executionId: event.execution_id }),
    ...(event.output_id === undefined ? {} : { outputId: event.output_id }),
  }
}

export function toMaestroThread(value: unknown) {
  const thread = parse(publicSchemas['Public.Thread'], 'Public.Thread', value)
  return {
    threadId: thread.thread_id,
    mode: thread.mode,
    organizationId: thread.organization_id,
    scopeKind: thread.scope_kind,
    workspaceId: thread.workspace_id,
    title: thread.title,
    state: thread.state,
    version: thread.version,
    participants: thread.participants.map(toMaestroParticipant),
    permissions: thread.permissions,
    capabilities: [...thread.capabilities],
    lastSequence: thread.last_sequence,
    cursor: thread.cursor,
    supervisionPolicy: thread.supervision_policy,
    policyVersion: thread.policy_version,
    createdAt: thread.created_at,
    updatedAt: thread.updated_at,
  }
}

export function toMaestroPersistedResponse(value: unknown) {
  const response = parse(
    publicSchemas['Public.PersistedResponse'],
    'Public.PersistedResponse',
    value
  )
  return {
    status: response.status,
    event: toMaestroEvent(response.event),
    cursor: response.cursor,
    duplicate: response.duplicate,
  }
}

export function toMaestroEventPage(value: unknown) {
  const page = parse(publicSchemas['Public.EventPage'], 'Public.EventPage', value)
  return {
    items: page.items.map(toMaestroEvent),
    nextCursor: page.next_cursor,
    hasMore: page.has_more,
    watermark: page.watermark,
  }
}

export function toMaestroThreadPage(value: unknown) {
  const page = parse(publicSchemas['Public.ThreadPage'], 'Public.ThreadPage', value)
  return {
    items: page.items.map(toMaestroThread),
    nextCursor: page.next_cursor,
    hasMore: page.has_more,
    watermark: page.watermark,
  }
}

export function toMaestroParticipantPage(value: unknown) {
  const page = parse(publicSchemas['Public.ParticipantPage'], 'Public.ParticipantPage', value)
  return {
    items: page.items.map(toMaestroParticipant),
    nextCursor: page.next_cursor,
    hasMore: page.has_more,
    watermark: page.watermark,
  }
}

export function toMaestroError(value: unknown) {
  const { error } = parse(publicSchemas['Public.Error'], 'Public.Error', value)
  return {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    requestId: error.request_id,
    ...(error.details === undefined
      ? {}
      : {
          details: {
            ...(error.details.field === undefined ? {} : { field: error.details.field }),
            ...(error.details.reason_code === undefined
              ? {}
              : { reasonCode: error.details.reason_code }),
            ...(error.details.retry_after_seconds === undefined
              ? {}
              : { retryAfterSeconds: error.details.retry_after_seconds }),
            ...(error.details.recovery === undefined ? {} : { recovery: error.details.recovery }),
          },
        }),
  }
}

export type MaestroEvent = {
  [Kind in MaestroWireEvent['type']]: Omit<ReturnType<typeof eventToPublic>, 'type' | 'payload'> &
    Pick<Extract<MaestroWireEvent, { type: Kind }>, 'type' | 'payload'>
}[MaestroWireEvent['type']]

export function toMaestroEvent(value: unknown): MaestroEvent {
  const event = parse(publicSchemas['Public.Event'], 'Public.Event', value)
  // Canonical parsing establishes the discriminated pair; mapping copies type and
  // payload together. TypeScript does not distribute that object mapping itself.
  return eventToPublic(event) as MaestroEvent
}
export type MaestroThread = ReturnType<typeof toMaestroThread>
export type MaestroParticipant = ReturnType<typeof toMaestroParticipant>
export type MaestroPersistedResponse = ReturnType<typeof toMaestroPersistedResponse>
export type MaestroConnectAck = ReturnType<typeof toMaestroConnectAck>
export type MaestroError = ReturnType<typeof toMaestroError>
