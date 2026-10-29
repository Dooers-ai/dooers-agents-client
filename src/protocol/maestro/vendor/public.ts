import { z } from 'zod'
import {
  actorSchema,
  capabilitiesSchema,
  cursorSchema,
  displayNameSchema,
  errorResponseSchema,
  errorSchema,
  idempotencyKeySchema,
  opaquePrincipalSchema,
  protocolVersionSchema,
  reasonCodeSchema,
  scopeSchema,
  sequenceSchema,
  timestampSchema,
  uuidSchema,
  versionSchema,
} from './common.js'

// These are v1 contract ceilings, not production quotas (G04/G05).
const empty = z.strictObject({})
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const text = z.string().max(65536)
const reason = z.strictObject({ reason_code: reasonCodeSchema.optional() })
const accessReason = z.string().min(1).max(500)
const uniqueIds = z
  .array(uuidSchema)
  .max(100)
  .refine((v) => new Set(v).size === v.length, 'IDs must be unique')
  .meta({ uniqueItems: true })
const threadState = z.enum(['active', 'archived', 'deleting', 'deleted'])
const deliveryState = z.enum([
  'waiting_broker',
  'pending',
  'running',
  'retry_wait',
  'waiting_input',
  'responded',
  'silent',
  'failed',
  'canceled',
  'expired',
])
const phase = z.union([z.literal('initial'), uuidSchema])
const outputId = idempotencyKeySchema
const publicArtifact = z.strictObject({
  artifact_id: uuidSchema,
  filename: z
    .string()
    .min(1)
    .max(255)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Filenames must exclude separators and header control characters.
    .regex(/^[^/\\\u0000-\u001f\u007f]+$/),
  mime_type: z
    .string()
    .min(3)
    .max(128)
    .regex(/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/),
  size_bytes: count,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  state: z.enum([
    'uploading',
    'validating',
    'ready_unbound',
    'linked',
    'rejected',
    'expired',
    'deleting',
    'deleted',
  ]),
  created_at: timestampSchema,
  expires_at: timestampSchema.nullable(),
})
const contentPart = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('text'), text }),
  z.strictObject({
    type: z.literal('attachment'),
    artifact_id: uuidSchema,
    filename: publicArtifact.shape.filename.optional(),
    mime_type: publicArtifact.shape.mime_type.optional(),
    size_bytes: count.optional(),
  }),
])
const content = z
  .array(contentPart)
  .min(1)
  .max(32)
  .refine(
    (parts) => parts.some((p) => p.type === 'attachment' || p.text.trim().length > 0),
    'Message must contain text or an attachment'
  )
  .meta({ 'x-maestro-semantic': 'nonblank-content' })
const options = z
  .array(
    z.strictObject({
      participant_id: uuidSchema,
      model: z.string().min(1).max(128).optional(),
      effort: z.enum(['minimal', 'low', 'medium', 'high', 'max']).optional(),
    })
  )
  .max(100)
  .refine(
    (v) => new Set(v.map((i) => i.participant_id)).size === v.length,
    'Options must be unique by participant'
  )
  .meta({ 'x-maestro-semantic': 'unique-option-participant' })
export const routingIntent = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('none') }),
  z.strictObject({ mode: z.literal('all') }),
  z.strictObject({ mode: z.literal('direct'), recipients: uniqueIds.min(1) }),
])
export const routingDecision = z.strictObject({
  version: z.literal(1),
  mode: z.enum(['none', 'direct', 'all']),
  recipients: uniqueIds,
  execution: z.literal('sequential'),
})
const messageInputFields = {
  routing: routingIntent.optional(),
  client_event_id: idempotencyKeySchema,
  content,
  mentions: uniqueIds.optional(),
  agent_options: options.optional(),
}
const messageCreate = z.strictObject({ type: z.literal('message.create'), ...messageInputFields })
const participantFields = {
  participant_id: uuidSchema,
  display_name: displayNameSchema,
  avatar_url: z
    .url({ protocol: /^https$/ })
    .regex(/^https:\/\//)
    .optional(),
  state: z.enum(['active', 'suspended', 'removed']),
  joined_sequence: sequenceSchema,
  left_sequence: sequenceSchema.nullable(),
}
const participant = z.discriminatedUnion('kind', [
  z.strictObject({
    ...participantFields,
    kind: z.literal('human'),
    principal_id: opaquePrincipalSchema,
    role: z.enum(['owner', 'member']),
  }),
  z.strictObject({
    ...participantFields,
    kind: z.literal('agent'),
    principal_id: uuidSchema,
    instance_agent_id: uuidSchema,
    role: z.literal('member'),
    capabilities: capabilitiesSchema,
    availability: z.enum(['available', 'unavailable', 'unknown']),
  }),
])
const permissions = z.strictObject({
  read: z.boolean(),
  write: z.boolean(),
  manage: z.boolean(),
  supervise: z.boolean(),
  export: z.boolean(),
  cancel: z.boolean(),
  feedback: z.boolean(),
  archive: z.boolean(),
  remove_participants: z.boolean(),
})
const threadFields = {
  routing_version: z.literal(1).optional(),
  thread_id: uuidSchema,
  mode: z.literal('maestro'),
  title: z.string().max(200),
  state: threadState,
  version: versionSchema,
  participants: z.array(participant).max(100),
  permissions,
  capabilities: capabilitiesSchema,
  last_sequence: sequenceSchema,
  cursor: cursorSchema,
  supervision_policy: z.enum(['strict', 'operational', 'open']),
  policy_version: versionSchema,
  created_at: timestampSchema,
  updated_at: timestampSchema,
}
const thread = z.discriminatedUnion('scope_kind', [
  scopeSchema.options[0].extend(threadFields),
  scopeSchema.options[1].extend(threadFields),
])
const participantTarget = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('human'), principal_id: opaquePrincipalSchema }),
  z.strictObject({ kind: z.literal('agent'), principal_id: uuidSchema }),
])
const createFields = {
  routing_version: z.literal(1).optional(),
  title: z.string().max(200).optional(),
  participants: z.array(participantTarget).max(99),
}
const threadCreate = z.discriminatedUnion('scope_kind', [
  z.strictObject({
    scope_kind: z.literal('personal'),
    workspace_id: z.null().optional(),
    ...createFields,
  }),
  z.strictObject({ scope_kind: z.literal('workspace'), workspace_id: uuidSchema, ...createFields }),
])
const threadPatch = z.union([
  z.strictObject({
    title: z.string().min(1).max(200),
    state: z.enum(['active', 'archived']).optional(),
  }),
  z.strictObject({
    title: z.string().min(1).max(200).optional(),
    state: z.enum(['active', 'archived']),
  }),
])
const page = <T extends z.ZodType>(item: T) =>
  z.strictObject({
    items: z.array(item).max(100),
    next_cursor: cursorSchema.nullable(),
    has_more: z.boolean(),
    watermark: sequenceSchema,
  })
const pagination = {
  cursor: cursorSchema.optional(),
  limit: z.number().int().min(1).max(100).optional(),
}
const pageQuery = z.strictObject(pagination)
const listFields = { state: threadState.optional(), ...pagination }
const threadListQuery = z.discriminatedUnion('scope_kind', [
  z.strictObject({
    scope_kind: z.literal('personal'),
    workspace_id: z.null().optional(),
    ...listFields,
  }),
  z.strictObject({ scope_kind: z.literal('workspace'), workspace_id: uuidSchema, ...listFields }),
])
const delivery = z.strictObject({
  delivery_id: uuidSchema,
  trigger_event_id: uuidSchema,
  participant_id: uuidSchema,
  state: deliveryState,
  attempt_count: count,
  execution_id: uuidSchema.nullable(),
  phase_id: phase,
  reason_code: reasonCodeSchema.nullable(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
  completed_at: timestampSchema.nullable(),
  expires_at: timestampSchema,
})
const fieldBase = {
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z][a-zA-Z0-9_]*$/),
  label: z.string().min(1).max(200),
  required: z.boolean(),
  share_response: z.boolean(),
}
const formField = z.discriminatedUnion('type', [
  z.strictObject({
    ...fieldBase,
    type: z.literal('text'),
    max_length: z.number().int().min(1).max(65536),
  }),
  z.strictObject({
    ...fieldBase,
    type: z.literal('number'),
    minimum: z.number(),
    maximum: z.number(),
  }),
  z.strictObject({ ...fieldBase, type: z.literal('boolean') }),
  z.strictObject({
    ...fieldBase,
    type: z.literal('select'),
    options: z
      .array(
        z.strictObject({ value: z.string().min(1).max(128), label: z.string().min(1).max(200) })
      )
      .min(1)
      .max(100),
  }),
  z.strictObject({
    ...fieldBase,
    type: z.literal('artifact'),
    max_files: z.number().int().min(1).max(32),
  }),
])
const interactionInputFields = {
  expires_at: timestampSchema,
  eligible_participant_ids: uniqueIds.min(1),
  title: z.string().min(1).max(200),
}
const interactionDefinition = z.discriminatedUnion('kind', [
  z.strictObject({
    ...interactionInputFields,
    kind: z.literal('form'),
    schema_version: protocolVersionSchema,
    fields: z
      .array(formField)
      .min(1)
      .max(100)
      .refine((v) => new Set(v.map((i) => i.name)).size === v.length, 'Field names must be unique')
      .meta({ 'x-maestro-semantic': 'unique-form-field' }),
    actions: z.tuple([z.literal('submit'), z.literal('cancel')]),
  }),
  z.strictObject({
    ...interactionInputFields,
    kind: z.literal('tool_approval'),
    schema_version: protocolVersionSchema,
    tool_name: z.string().min(1).max(128),
    action_description: z.string().min(1).max(1000),
    arguments_hash: z.string().regex(/^[a-f0-9]{64}$/),
    effect_scope: z.string().min(1).max(500),
    actions: z.tuple([z.literal('approve'), z.literal('reject')]),
  }),
])
const interaction = z.strictObject({
  interaction_id: uuidSchema,
  origin_event_id: uuidSchema,
  agent_participant_id: uuidSchema,
  execution_id: uuidSchema,
  delivery_id: uuidSchema,
  definition: interactionDefinition,
  state: z.enum(['pending', 'submitted', 'approved', 'rejected', 'canceled', 'expired']),
})
// Dynamic field names are intentionally limited values. E11 validates against the saved form definition.
const formValue = z.union([
  z.string().max(65536),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(uuidSchema).max(32),
])
const formData = z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/), formValue)
const interactionResponse = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('submit'), data: formData }),
  z.strictObject({ action: z.literal('cancel'), data: empty }),
  z.strictObject({
    action: z.literal('approve'),
    data: z.strictObject({ arguments_hash: z.string().regex(/^[a-f0-9]{64}$/) }),
  }),
  z.strictObject({ action: z.literal('reject'), data: empty }),
])
const feedback = z.strictObject({
  value: z.enum(['positive', 'negative']).nullable(),
  classification: z.string().min(1).max(64).nullable(),
  reason: z.string().max(2000).nullable(),
  version: versionSchema,
})
const eventFields = {
  event_id: uuidSchema,
  thread_id: uuidSchema,
  sequence: sequenceSchema,
  schema_version: protocolVersionSchema,
  actor: actorSchema,
  created_at: timestampSchema,
  causation_event_id: uuidSchema.nullable(),
  root_event_id: uuidSchema.nullable(),
  delivery_id: uuidSchema.optional(),
  execution_id: uuidSchema.optional(),
  output_id: outputId.optional(),
}
const eventOf = <T extends string, P extends z.ZodType>(type: T, payload: P) =>
  z.strictObject({ ...eventFields, type: z.literal(type), payload })
const messagePayload = z.strictObject({
  routing: routingIntent.optional(),
  routing_decision: routingDecision.optional(),
  content,
  mentions: uniqueIds,
  client_event_id: idempotencyKeySchema.optional(),
  execution_id: uuidSchema.optional(),
  output_id: outputId.optional(),
  agent_options: options.optional(),
})
const executionPayload = z.strictObject({
  execution_id: uuidSchema,
  delivery_id: uuidSchema,
  participant_id: uuidSchema,
  phase_id: phase,
  state: z.enum(['running', 'completed', 'failed', 'timed_out', 'canceled', 'suspended']),
  outcome: z.enum(['responded', 'silent', 'failed', 'canceled']).nullable(),
  reason_code: reasonCodeSchema.nullable(),
  deadline_at: timestampSchema,
  completed_at: timestampSchema.nullable(),
})
export const durableEventSchemas = {
  'thread.created': eventOf('thread.created', z.strictObject({ thread })),
  'thread.updated': eventOf(
    'thread.updated',
    z.strictObject({
      thread_id: uuidSchema,
      title: z.string().max(200),
      state: z.enum(['active', 'archived']),
      version: versionSchema,
    })
  ),
  'thread.archived': eventOf(
    'thread.archived',
    z.strictObject({ thread_id: uuidSchema, version: versionSchema })
  ),
  'participant.added': eventOf(
    'participant.added',
    z.strictObject({ participant, history_policy: z.literal('full') })
  ),
  'participant.removed': eventOf(
    'participant.removed',
    z.strictObject({
      participant_id: uuidSchema,
      left_sequence: sequenceSchema,
      reason_code: reasonCodeSchema.optional(),
    })
  ),
  'message.created': eventOf('message.created', messagePayload),
  'execution.started': eventOf(
    'execution.started',
    executionPayload.extend({
      state: z.literal('running'),
      outcome: z.null(),
      completed_at: z.null(),
    })
  ),
  'execution.completed': eventOf(
    'execution.completed',
    executionPayload.extend({
      state: z.literal('completed'),
      outcome: z.enum(['responded', 'silent']),
      completed_at: timestampSchema,
    })
  ),
  'execution.failed': eventOf(
    'execution.failed',
    executionPayload.extend({
      state: z.enum(['failed', 'timed_out']),
      outcome: z.literal('failed'),
      completed_at: timestampSchema,
    })
  ),
  'execution.canceled': eventOf(
    'execution.canceled',
    executionPayload.extend({
      state: z.literal('canceled'),
      outcome: z.literal('canceled'),
      completed_at: timestampSchema,
    })
  ),
  'delivery.updated': eventOf('delivery.updated', z.strictObject({ delivery })),
  'root.stopped': eventOf(
    'root.stopped',
    z.strictObject({ root_event_id: uuidSchema, reason_code: reasonCodeSchema.optional() })
  ),
  'interaction.created': eventOf('interaction.created', z.strictObject({ interaction })),
  'interaction.responded': eventOf(
    'interaction.responded',
    z.strictObject({
      interaction_id: uuidSchema,
      action: z.enum(['submit', 'cancel', 'approve', 'reject']),
      shared_data: formData,
      delivery_id: uuidSchema,
      phase_id: phase,
    })
  ),
  'interaction.expired': eventOf(
    'interaction.expired',
    z.strictObject({ interaction_id: uuidSchema, delivery_id: uuidSchema })
  ),
  'feedback.updated': eventOf(
    'feedback.updated',
    z.strictObject({ target_event_id: uuidSchema, principal_id: opaquePrincipalSchema, feedback })
  ),
}
const event = z.union(Object.values(durableEventSchemas))
const persisted = z.strictObject({
  status: z.literal('persisted'),
  event,
  cursor: cursorSchema,
  duplicate: z.boolean(),
})
const capabilitiesResponse = z.strictObject({
  protocol_version: protocolVersionSchema,
  schema_version: protocolVersionSchema,
  server_version: z.string().min(1).max(64),
  history_authority: z.literal('maestro'),
  capabilities: capabilitiesSchema,
})
const pathId = z.strictObject({ id: uuidSchema })
const participantPath = z.strictObject({ id: uuidSchema, participantId: uuidSchema })
const rootPath = z.strictObject({ id: uuidSchema, eventId: uuidSchema })
const mutationHeaders = z.strictObject({ 'Idempotency-Key': idempotencyKeySchema })
const versionedHeaders = mutationHeaders.extend({ 'If-Match': z.string().regex(/^[1-9][0-9]*$/) })
const readHeaders = z.strictObject({ 'Maestro-Supervision-Grant': uuidSchema.optional() })
const supervisionListQuery = z.discriminatedUnion('scope_kind', [
  threadListQuery.options[0].extend({ access_reason: accessReason.optional() }),
  threadListQuery.options[1].extend({ access_reason: accessReason.optional() }),
])
const eventsQuery = z.union([
  z.strictObject({ after: cursorSchema.optional(), limit: pagination.limit }),
  z.strictObject({ before: cursorSchema, limit: pagination.limit }),
])
const deliveryListQuery = pageQuery.extend({
  event: uuidSchema.optional(),
  root: uuidSchema.optional(),
  state: deliveryState.optional(),
})
const cancelResult = z.strictObject({
  status: z.literal('cancel_requested'),
  execution_id: uuidSchema,
})
const stopResult = z.strictObject({
  status: z.literal('stop_requested'),
  root_event_id: uuidSchema,
})
const supervisionGrant = z.strictObject({
  supervision_grant_id: uuidSchema,
  thread_id: uuidSchema,
  access: z.literal('read_only'),
  expires_at: timestampSchema,
  policy_version: versionSchema,
})
const exportQuery = z.strictObject({
  format: z.literal('json'),
  cursor: cursorSchema.optional(),
  watermark: sequenceSchema.optional(),
})
const exportResponse = z.strictObject({
  artifact_id: uuidSchema,
  watermark: sequenceSchema,
  download_path: z.string().regex(/^\/(?:[a-zA-Z0-9_-]+\/)*artifacts\/[0-9a-f-]{36}\/download$/),
  expires_at: timestampSchema,
})
const artifactCreate = z.strictObject({
  filename: publicArtifact.shape.filename,
  mime_type: publicArtifact.shape.mime_type,
  size_bytes: count,
  sha256: publicArtifact.shape.sha256,
  workspace_id: uuidSchema.nullable(),
  thread_id: uuidSchema.optional(),
  execution_id: uuidSchema.optional(),
  lease_fence: sequenceSchema.optional(),
})
const uploadSession = z.strictObject({
  artifact: publicArtifact,
  upload_session_id: uuidSchema,
  upload_mode: z.enum(['multipart_proxy', 'direct_private']),
  max_size_bytes: count,
  expires_at: timestampSchema,
})
const artifactComplete = z.strictObject({
  upload_session_id: uuidSchema,
  sha256: publicArtifact.shape.sha256,
  size_bytes: count,
})
const downloadMetadata = z.strictObject({
  artifact_id: uuidSchema,
  mime_type: publicArtifact.shape.mime_type,
  size_bytes: count,
  filename: publicArtifact.shape.filename,
  cache_control: z.literal('private, no-store'),
  content_disposition: z.literal('attachment'),
  x_content_type_options: z.literal('nosniff'),
})
const output = z.strictObject({
  output_id: outputId,
  type: z.literal('message.create'),
  payload: z.strictObject({
    content,
    mentions: uniqueIds,
    agent_options: options.optional(),
    handoff: z.strictObject({ recipients: uniqueIds.min(1).max(1) }).optional(),
  }),
})
const heartbeat = z.strictObject({
  lease_fence: sequenceSchema,
  progress_code: reasonCodeSchema.optional(),
})
const outputRequest = output.extend({ lease_fence: sequenceSchema })
const streamRequest = z.strictObject({
  lease_fence: sequenceSchema,
  output_id: outputId,
  chunk_index: count,
  delta: z.string().min(1).max(16384),
})
const complete = z.discriminatedUnion('outcome', [
  z.strictObject({
    lease_fence: sequenceSchema,
    outcome: z.literal('responded'),
    reason_code: reasonCodeSchema.optional(),
    outputs: z.array(output).max(32).optional(),
  }),
  z.strictObject({
    lease_fence: sequenceSchema,
    outcome: z.literal('silent'),
    reason_code: reasonCodeSchema.optional(),
    outputs: z.tuple([]).optional(),
  }),
  z.strictObject({
    lease_fence: sequenceSchema,
    outcome: z.literal('failed'),
    reason_code: reasonCodeSchema,
    outputs: z.array(output).max(32).optional(),
  }),
  z.strictObject({
    lease_fence: sequenceSchema,
    outcome: z.literal('canceled'),
    reason_code: reasonCodeSchema.optional(),
    outputs: z.tuple([]).optional(),
  }),
])
const callbackResult = z.strictObject({
  delivery_id: uuidSchema,
  execution_id: uuidSchema,
  state: z.enum(['responded', 'silent', 'failed', 'canceled', 'waiting_input']),
  result_event_ids: uniqueIds,
})
const suspend = z.strictObject({
  lease_fence: sequenceSchema,
  interaction: interactionDefinition,
  checkpoint_ref: z.string().min(1).max(512).optional(),
  output_id: outputId,
})
const brokerEvent = z.strictObject({
  protocol_version: protocolVersionSchema,
  schema_version: protocolVersionSchema,
  event_id: uuidSchema,
  organization_id: uuidSchema,
  thread_id: uuidSchema,
  sequence: sequenceSchema,
  destination_kind: z.enum(['deliveries', 'gateway']),
  occurred_at: timestampSchema,
})
const contextResponse = z.strictObject({
  delivery_id: uuidSchema,
  trigger_event: event,
  invocation_event: event.optional(),
  participants: z.array(participant).max(100),
  context_cursor: cursorSchema,
  history: page(event),
})
const retryRequest = z.strictObject({
  reason_code: reasonCodeSchema,
  expected_execution_id: uuidSchema.nullable(),
})
const retryResult = z.strictObject({ delivery, retry_scheduled: z.boolean() })

const wsCommands = {
  connect: z.strictObject({
    auth_token: z.string().min(1).max(16384),
    protocol_version: protocolVersionSchema,
    client_capabilities: capabilitiesSchema,
  }),
  'auth.refresh': z.strictObject({ auth_token: z.string().min(1).max(16384) }),
  ping: z.strictObject({ nonce: z.string().min(1).max(128) }),
  'thread.subscribe': z.strictObject({
    thread_id: uuidSchema,
    cursor: cursorSchema.optional(),
    supervision_grant_id: uuidSchema.optional(),
  }),
  'thread.unsubscribe': z.strictObject({ subscription_id: uuidSchema }),
  'message.publish': z.strictObject({ thread_id: uuidSchema, ...messageInputFields }),
  'execution.cancel': z.strictObject({
    execution_id: uuidSchema,
    idempotency_key: idempotencyKeySchema,
    reason_code: reasonCodeSchema.optional(),
  }),
  'root.stop': z.strictObject({
    thread_id: uuidSchema,
    root_event_id: uuidSchema,
    idempotency_key: idempotencyKeySchema,
    reason_code: reasonCodeSchema.optional(),
  }),
  'interaction.respond': z.union(
    interactionResponse.options.map((action) =>
      action.extend({ interaction_id: uuidSchema, idempotency_key: idempotencyKeySchema })
    )
  ),
}
const connected = z.strictObject({
  status: z.literal('connected'),
  connection_id: uuidSchema,
  server_version: z.string().min(1).max(64),
  protocol_version: protocolVersionSchema,
  history_authority: z.literal('maestro'),
  capabilities: capabilitiesSchema,
  expires_at: timestampSchema,
})
const ackPayloads = {
  connect: connected,
  'auth.refresh': z.strictObject({
    status: z.literal('authenticated'),
    expires_at: timestampSchema,
  }),
  'thread.subscribe': z.strictObject({
    status: z.literal('subscribed'),
    subscription_id: uuidSchema,
    replay_watermark: sequenceSchema,
    replay_mode: z.enum(['snapshot', 'replay']),
  }),
  'thread.unsubscribe': z.strictObject({
    status: z.literal('unsubscribed'),
    subscription_id: uuidSchema,
  }),
  'message.publish': persisted,
  'execution.cancel': cancelResult,
  'root.stop': stopResult,
  'interaction.respond': persisted,
}
const frames = {
  'thread.snapshot': z.strictObject({
    subscription_id: uuidSchema,
    thread,
    events: z.array(event).max(100),
    watermark: sequenceSchema,
    next_cursor: cursorSchema.nullable(),
    has_more: z.boolean(),
  }),
  'thread.replay': z.strictObject({
    subscription_id: uuidSchema,
    events: z.array(event).max(100),
    watermark: sequenceSchema,
    next_cursor: cursorSchema.nullable(),
    has_more: z.boolean(),
  }),
  'thread.caught_up': z.strictObject({
    subscription_id: uuidSchema,
    cursor: cursorSchema,
    watermark: sequenceSchema,
  }),
  'event.append': z.strictObject({ subscription_id: uuidSchema, event, cursor: cursorSchema }),
  'stream.delta': z.strictObject({
    thread_id: uuidSchema,
    participant_id: uuidSchema,
    execution_id: uuidSchema,
    output_id: outputId,
    chunk_index: count,
    delta: z.string().min(1).max(16384),
    ephemeral: z.literal(true),
  }),
  'stream.reset': z.strictObject({
    thread_id: uuidSchema,
    execution_id: uuidSchema,
    output_id: outputId,
    reason_code: reasonCodeSchema,
  }),
  'subscription.revoked': z.strictObject({
    subscription_id: uuidSchema,
    reason_code: reasonCodeSchema,
  }),
  'session.expiring': z.strictObject({
    expires_at: timestampSchema,
    reason_code: reasonCodeSchema,
  }),
  'session.expired': z.strictObject({ expires_at: timestampSchema, reason_code: reasonCodeSchema }),
  'resync.required': z.strictObject({
    subscription_id: uuidSchema,
    reason_code: z.enum([
      'cursor_invalid',
      'cursor_expired',
      'slow_consumer',
      'buffer_exceeded',
      'sequence_gap',
    ]),
    action: z.enum(['snapshot', 'replay']),
  }),
}
export const wsCommandSchemas = Object.fromEntries(
  Object.entries(wsCommands).map(([type, payload]) => [
    type,
    z.strictObject({ id: uuidSchema, type: z.literal(type), payload }),
  ])
)
export const wsAckSchemas = Object.fromEntries(
  Object.entries(ackPayloads).map(([command, payload]) => [
    command,
    z.strictObject({ id: uuidSchema, type: z.literal('ack'), payload }),
  ])
)
export const wsFrameSchemas = Object.fromEntries(
  Object.entries(frames).map(([type, payload]) => [
    type,
    z.strictObject({ type: z.literal(type), payload }),
  ])
)

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`
  return JSON.stringify(value)
}
const publicationExchange = z
  .strictObject({
    organization_id: uuidSchema,
    thread_id: uuidSchema,
    principal_id: opaquePrincipalSchema,
    operation: z.literal('message.publish'),
    idempotency_key: idempotencyKeySchema,
    http: z.strictObject({ headers: mutationHeaders, body: messageCreate }),
    ws: z.strictObject({
      id: uuidSchema,
      type: z.literal('message.publish'),
      payload: wsCommands['message.publish'],
    }),
    expected_same_identity: z.literal(true),
    ack_after: z.literal('postgres_transaction_commit'),
    broker_required_for_ack: z.literal(false),
  })
  .superRefine((value, context) => {
    const wsPayload = wsCommands['message.publish'].parse(value.ws.payload)
    if (
      value.idempotency_key !== value.http.headers['Idempotency-Key'] ||
      value.idempotency_key !== value.http.body.client_event_id ||
      value.idempotency_key !== wsPayload.client_event_id ||
      value.thread_id !== wsPayload.thread_id
    )
      context.addIssue({ code: 'custom', message: 'HTTP and WS must preserve semantic identity' })
    const input = (
      body: z.infer<(typeof wsCommands)['message.publish']> | z.infer<typeof messageCreate>
    ) => ({
      ...(body.routing ? { routing: body.routing } : {}),
      content: body.content,
      mentions: body.mentions ?? [],
      agent_options: body.agent_options ?? [],
    })
    if (canonicalJson(input(value.http.body)) !== canonicalJson(input(wsPayload)))
      context.addIssue({ code: 'custom', message: 'Same idempotency key must preserve content' })
  })
  .meta({ 'x-maestro-semantic': 'publication-exchange' })

export const publicSchemas = {
  'Public.PublicationExchange': publicationExchange,
  'Public.Empty': empty,
  'Public.Scope': scopeSchema,
  'Public.Actor': actorSchema,
  'Public.Capabilities': capabilitiesResponse,
  'Public.Error': errorResponseSchema,
  'Public.Thread': thread,
  'Public.Participant': participant,
  'Public.ContentPart': contentPart,
  'Public.Event': event,
  'Public.Delivery': delivery,
  'Public.Artifact': publicArtifact,
  'Public.Interaction': interaction,
  'Public.IdPath': pathId,
  'Public.ParticipantPath': participantPath,
  'Public.RootPath': rootPath,
  'Public.MutationHeaders': mutationHeaders,
  'Public.VersionedHeaders': versionedHeaders,
  'Public.ReadHeaders': readHeaders,
  'Public.ThreadCreateRequest': threadCreate,
  'Public.ThreadListQuery': threadListQuery,
  'Public.ThreadPage': page(thread),
  'Public.SupervisionListQuery': supervisionListQuery,
  'Public.SupervisionThreadPage': page(
    z.strictObject({
      thread_id: uuidSchema,
      scope: scopeSchema,
      title: z.string().max(200),
      state: threadState,
      updated_at: timestampSchema,
    })
  ),
  'Public.ThreadPatchRequest': threadPatch,
  'Public.ReasonRequest': reason,
  'Public.DeleteResponse': z.strictObject({
    deletion_job_id: uuidSchema,
    state: z.literal('deleting'),
  }),
  'Public.PageQuery': pageQuery,
  'Public.ParticipantPage': page(participant),
  'Public.ParticipantAddRequest': z.union(
    participantTarget.options.map((target) => target.extend({ role: z.literal('member') }))
  ),
  'Public.OwnershipRequest': z.strictObject({ participant_id: uuidSchema }),
  'Public.EventsQuery': eventsQuery,
  'Public.EventPage': page(event),
  'Public.MessageCreateRequest': messageCreate,
  'Public.PersistedResponse': persisted,
  'Public.DeliveryListQuery': deliveryListQuery,
  'Public.DeliveryPage': page(delivery),
  'Public.CancelResponse': cancelResult,
  'Public.StopResponse': stopResult,
  'Public.SupervisionRequest': z.strictObject({ access_reason: accessReason.optional() }),
  'Public.SupervisionGrant': supervisionGrant,
  'Public.ExportQuery': exportQuery,
  'Public.ExportResponse': exportResponse,
  'Public.InteractionResponseRequest': interactionResponse,
  'Public.FeedbackRequest': feedback,
  'Public.ArtifactCreateRequest': artifactCreate,
  'Public.UploadSessionResponse': uploadSession,
  'Public.ArtifactCompleteRequest': artifactComplete,
  'Public.DownloadMetadata': downloadMetadata,
  'Public.ContextResponse': contextResponse,
  'Public.HeartbeatRequest': heartbeat,
  'Public.HeartbeatResponse': z.strictObject({ lease_until: timestampSchema }),
  'Public.OutputRequest': outputRequest,
  'Public.StreamRequest': streamRequest,
  'Public.StreamResponse': z.strictObject({
    status: z.literal('accepted'),
    ephemeral: z.literal(true),
    output_id: outputId,
    chunk_index: count,
  }),
  'Public.CompleteRequest': complete,
  'Public.CallbackResponse': callbackResult,
  'Public.SuspendRequest': suspend,
  'Public.BrokerEventRequest': brokerEvent,
  'Public.BrokerEventResponse': z.strictObject({
    status: z.literal('persisted'),
    duplicate: z.boolean(),
  }),
  'Public.RetryRequest': retryRequest,
  'Public.RetryResponse': retryResult,
  'Public.WsError': z.strictObject({
    id: uuidSchema,
    type: z.literal('error'),
    payload: errorSchema,
  }),
  'Public.WsPong': z.strictObject({
    id: uuidSchema,
    type: z.literal('pong'),
    payload: wsCommands.ping,
  }),
  ...Object.fromEntries(
    Object.entries(durableEventSchemas).map(([type, schema]) => [`Public.Event.${type}`, schema])
  ),
  ...Object.fromEntries(
    Object.entries(wsCommandSchemas).map(([type, schema]) => [`Public.WsCommand.${type}`, schema])
  ),
  ...Object.fromEntries(
    Object.entries(wsAckSchemas).map(([type, schema]) => [`Public.WsAck.${type}`, schema])
  ),
  ...Object.fromEntries(
    Object.entries(wsFrameSchemas).map(([type, schema]) => [`Public.WsFrame.${type}`, schema])
  ),
} satisfies Record<string, z.ZodType>
