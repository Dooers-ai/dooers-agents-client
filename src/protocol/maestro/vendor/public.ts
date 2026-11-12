import { z } from 'zod'
import {
  actorSchema,
  capabilitiesSchema,
  cursorSchema,
  displayNameSchema,
  errorResponseSchema,
  errorSchema,
  externalFields,
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
const resultEventIds = z
  .array(uuidSchema)
  .max(1000)
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
const textPart = z.strictObject({ type: z.literal('text'), text })
// Agent text: production does not limit message size. The contract ceiling is the callback body limit
// (2 MiB); Maestro's operational byte limit (AGENT_MESSAGE_MAX_BYTES, 1 MiB) refuses first with
// PAYLOAD_TOO_LARGE. Human text keeps the 64 Ki character ceiling above.
const agentTextPart = z.strictObject({ type: z.literal('text'), text: z.string().max(2097152) })
const attachmentPart = z.strictObject({
  type: z.literal('attachment'),
  artifact_id: uuidSchema,
  filename: publicArtifact.shape.filename.optional(),
  mime_type: publicArtifact.shape.mime_type.optional(),
  size_bytes: count.optional(),
  alt: z.string().max(1024).optional(),
  duration: z.number().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  width: count.optional(),
  height: count.optional(),
})
// Open production values (dict[str, Any]: tool args/results, form values, chart rows, contact phones, Cloud API
// template components) are one recursive JSON value: no depth, list length, string length or key rules.
// The only bound is the serialized size of each open container (UTF-8 bytes of its compact JSON), mirrored
// by the open-json-bytes rule in semantics.py. The ceiling matches the request body limit of the API.
type Json = string | number | boolean | null | Json[] | { [key: string]: Json }
const jsonValue: z.ZodType<Json> = z
  .lazy(() =>
    z.union([
      z.string(),
      z.number(),
      z.boolean(),
      z.null(),
      z.array(jsonValue),
      z.record(z.string(), jsonValue),
    ])
  )
  .meta({ id: 'JsonValue' })
const OPEN_JSON_MAX_BYTES = 1048576
const withinOpenJsonBytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).length <= OPEN_JSON_MAX_BYTES
const boundedJson = <T extends z.ZodType>(schema: T) =>
  schema
    .refine(withinOpenJsonBytes, 'Open JSON must not exceed 1 MiB serialized')
    .meta({ 'x-maestro-semantic': 'open-json-bytes' })
const openObject = boundedJson(z.record(z.string(), jsonValue))
// Production ContactPart.phones is list[dict[str, Any]]: open objects, passed through as-is.
const contactPhone = z.record(z.string(), jsonValue)
const contactPart = z.strictObject({
  type: z.literal('contact'),
  display_name: z.string().max(512),
  vcard: text.optional(),
  phones: boundedJson(z.array(contactPhone)).optional(),
})
// Agent-only part: the SDK keeps the original URL when it cannot download send.image/audio/document media.
const mediaLinkPart = z.strictObject({
  type: z.literal('media_link'),
  kind: z.enum(['image', 'audio', 'document']),
  // Long signed URLs (cloud storage, CDN) must not fail an agent run.
  url: z.url({ protocol: /^https?$/ }).max(8192),
  mime_type: publicArtifact.shape.mime_type.optional(),
  filename: publicArtifact.shape.filename.optional(),
  alt: z.string().max(1024).optional(),
  duration: z.number().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
})
const humanContentPart = z.discriminatedUnion('type', [textPart, attachmentPart, contactPart])
const contentPart = z.discriminatedUnion('type', [
  agentTextPart,
  attachmentPart,
  contactPart,
  mediaLinkPart,
])
const nonblankParts = (parts: z.infer<typeof contentPart>[]) =>
  parts.some((p) => p.type !== 'text' || p.text.trim().length > 0)
const content = z
  .array(contentPart)
  .min(1)
  .max(32)
  .refine(nonblankParts, 'Message must contain text, an attachment, a contact or a media link')
  .meta({ 'x-maestro-semantic': 'nonblank-content' })
// Agent messages (message.create output and the stored message.created) accept a blank text part:
// production send.text("") stores it. Human requests keep nonblank-content.
const agentContent = z.array(contentPart).min(1).max(32)
// Human messages cannot carry media_link: only agents hold URLs they did not upload as artifacts.
const humanContent = z
  .array(humanContentPart)
  .min(1)
  .max(32)
  .refine(nonblankParts, 'Message must contain text, an attachment or a contact')
  .meta({ 'x-maestro-semantic': 'nonblank-content' })
const messageTemplate = z.strictObject({
  template_name: z.string().min(1).max(512),
  template_language: z.string().min(1).max(64),
  template_components: boundedJson(z.array(z.record(z.string(), jsonValue))).optional(),
})
const messageWhatsapp = z.strictObject({
  to_e164: z.string().min(1).max(64),
  instance_id: z.string().min(1).max(256),
})
// Run that produced the event (production run_id, handlers/pipeline.py); every agent output may carry it.
const runId = uuidSchema
const agentMessageFields = {
  author: z.string().max(200).optional(),
  template: messageTemplate.optional(),
  whatsapp: messageWhatsapp.optional(),
  run_id: runId.optional(),
}
// Free text the agent writes (reasoning, form/chart messages, run error): same 1 MiB ceiling as open JSON.
const longText = z.string().max(OPEN_JSON_MAX_BYTES)
const queueName = z.string().max(200)
const runStatus = z.enum(['running', 'succeeded', 'failed'])
const toolFields = {
  id: z.string().max(1024),
  name: z.string().max(1024),
  display_name: z.string().max(4096).optional(),
}
const reasoningPayload = z.strictObject({
  text: longText,
  author: z.string().max(200).optional(),
  run_id: runId.optional(),
})
const toolCallPayload = z.strictObject({
  ...toolFields,
  args: openObject,
  run_id: runId.optional(),
})
const toolResultPayload = z.strictObject({
  ...toolFields,
  args: openObject.optional(),
  result: openObject,
  run_id: runId.optional(),
})
const toolTransactionPayload = z.strictObject({
  ...toolFields,
  args: openObject,
  result: openObject,
  run_id: runId.optional(),
})
const panelSize = z.enum(['small', 'medium', 'large'])
// WireS2C_ChartEventData (protocol/models.py): AgentEvent.data of send.chart always carries title, message, size and series.
const chartPayload = z.strictObject({
  title: z.string().max(4096),
  message: longText,
  chart_type: z.enum([
    'bar',
    'bar_horizontal',
    'stacked_bar',
    'line',
    'area',
    'pie',
    'donut',
    'scatter',
  ]),
  size: panelSize,
  x_key: z.string().max(1024),
  y_keys: z.array(z.string().max(1024)).max(1000),
  data: boundedJson(z.array(z.record(z.string(), jsonValue))),
  series: z
    .array(
      z.strictObject({
        key: z.string().max(1024),
        label: z.string().max(4096).nullish(),
        color: z.string().max(256).nullish(),
      })
    )
    .max(1000),
  x_label: z.string().max(4096).optional(),
  y_label: z.string().max(4096).optional(),
  run_id: runId.optional(),
})
// WireS2C_Form*Element (protocol/models.py): order, required, disabled and the per-element variants default in the wire model.
const formElementBase = {
  name: z.string().max(1024),
  label: z.string().max(4096),
  order: z.number().int().optional(),
  required: z.boolean().optional(),
  disabled: z.boolean().optional(),
}
const formOptions = z
  .array(z.strictObject({ value: z.string().max(4096), label: z.string().max(4096) }))
  .max(5000)
const formElement = z.discriminatedUnion('type', [
  z.strictObject({
    ...formElementBase,
    type: z.literal('text_input'),
    placeholder: z.string().max(4096).nullish(),
    default: longText.nullish(),
    input_type: z.enum(['text', 'password', 'email', 'number', 'date']).optional(),
  }),
  z.strictObject({
    ...formElementBase,
    type: z.literal('textarea_input'),
    placeholder: z.string().max(4096).nullish(),
    default: longText.nullish(),
    rows: z.number().int().min(1).nullish(),
  }),
  z.strictObject({
    ...formElementBase,
    type: z.literal('select_input'),
    options: formOptions,
    default: longText.nullish(),
    placeholder: z.string().max(4096).nullish(),
  }),
  z.strictObject({
    ...formElementBase,
    type: z.literal('radio_input'),
    options: formOptions,
    default: longText.nullish(),
    variant: z.enum(['native', 'button']).optional(),
  }),
  z.strictObject({
    ...formElementBase,
    type: z.literal('checkbox_input'),
    options: formOptions,
    default: z.array(z.string().max(4096)).max(5000).nullish(),
    variant: z.enum(['native', 'button']).optional(),
  }),
  z.strictObject({
    ...formElementBase,
    type: z.literal('file_input'),
    upload_url: z.string().max(8192),
    accept: z.string().max(4096).nullish(),
    multiple: z.boolean().optional(),
  }),
])
const formPayload = z.strictObject({
  message: longText,
  elements: z.array(formElement).max(1000),
  submit_label: z.string().max(4096),
  cancel_label: z.string().max(4096),
  size: panelSize,
  run_id: runId.optional(),
})
const messageUpdatePayload = z.strictObject({
  event_id: uuidSchema,
  content,
  run_id: runId.optional(),
})
export const threadUpdatePayload = z.strictObject({
  title: z.string().max(200).optional(),
  queue: queueName.nullish(),
  run_id: runId.optional(),
})
const participantAddPayload = z.strictObject({
  user: z.strictObject({
    user_id: z.string().max(256),
    user_name: z.string().max(200).nullish(),
    user_email: z.string().max(320).nullish(),
    identity_ids: z.array(z.string().min(1).max(256)).max(64).optional(),
  }),
  run_id: runId.optional(),
})
const runUpdatePayload = z.strictObject({
  run_id: runId,
  status: runStatus,
  error: longText.optional(),
})
// Body of the human answer to a production form (frame form.response without form_event_id, which is in the path).
const formResponse = z.strictObject({ values: openObject, cancelled: z.boolean() })
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
  content: humanContent,
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
// Email and identity ids of a human reach only the agent-facing context (index 4.3.1), never a browser.
const humanIdentity = {
  email: z.string().max(320).nullish(),
  identity_ids: z.array(z.string().min(1).max(256)).max(64).optional(),
}
const participantOf = <H extends z.ZodRawShape>(humanExtra: H) =>
  z.discriminatedUnion('kind', [
    z.strictObject({
      ...participantFields,
      ...humanExtra,
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
    z.strictObject({
      ...participantFields,
      ...externalFields,
      kind: z.literal('external'),
      role: z.literal('member'),
    }),
  ])
const participant = participantOf({})
const agentParticipant = participantOf(humanIdentity)
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
  permissions,
  capabilities: capabilitiesSchema,
  last_sequence: sequenceSchema,
  cursor: cursorSchema,
  supervision_policy: z.enum(['strict', 'operational', 'open']),
  policy_version: versionSchema,
  created_at: timestampSchema,
  updated_at: timestampSchema,
  // SDK parity (index 4.3): optional so threads of the original contract stay valid.
  queue: queueName.nullish(),
  channel: z.string().min(1).max(200).optional(),
  channel_meta: z.union([openObject, z.null()]).optional(),
  external_key: z.string().min(1).max(512).nullish(),
  owner_instance_agent_id: uuidSchema.nullish(),
}
const threadOf = <P extends z.ZodType>(participants: P) =>
  z.discriminatedUnion('scope_kind', [
    scopeSchema.options[0].extend({
      ...threadFields,
      participants: z.array(participants).max(100),
    }),
    scopeSchema.options[1].extend({
      ...threadFields,
      participants: z.array(participants).max(100),
    }),
  ])
const thread = threadOf(participant)
const agentThread = threadOf(agentParticipant)
const participantTarget = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('human'), principal_id: opaquePrincipalSchema }),
  z.strictObject({ kind: z.literal('agent'), principal_id: uuidSchema }),
])
// Only an aiagent targets an external participant (index 4.3): the human routes refuse it.
const agentParticipantTarget = z.discriminatedUnion('kind', [
  ...participantTarget.options,
  z.strictObject({ kind: z.literal('external'), ...externalFields }),
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
// Agent-only PATCH (thread.rename and thread.queue.update): "" and null remove the thread from its queue.
// The human PATCH above has no queue branch; the agent never archives, so there is no state here.
const agentThreadPatch = z.union([
  z.strictObject({
    title: z.string().min(1).max(200),
    queue: queueName.nullable().optional(),
  }),
  z.strictObject({
    title: z.string().min(1).max(200).optional(),
    queue: queueName.nullable(),
  }),
])
// Agent-only thread creation (POST /v1/agent/threads): idempotent by external_key, channel metadata allowed.
const agentCreateFields = {
  participants: z.array(agentParticipantTarget).max(99),
  queue: queueName.nullish(),
  channel: threadFields.channel,
  channel_meta: threadFields.channel_meta,
  external_key: z.string().min(1).max(512).optional(),
}
const agentThreadCreate = z.discriminatedUnion('scope_kind', [
  threadCreate.options[0].extend(agentCreateFields),
  threadCreate.options[1].extend(agentCreateFields),
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
  created_at: timestampSchema,
  causation_event_id: uuidSchema.nullable(),
  root_event_id: uuidSchema.nullable(),
  delivery_id: uuidSchema.optional(),
  execution_id: uuidSchema.optional(),
  output_id: outputId.optional(),
}
// Human actor of the agent-facing context: same shape plus email and identity_ids (index 4.3.1).
const [humanActor, ...otherActors] = actorSchema.options
const agentActor = z.discriminatedUnion('kind', [humanActor.extend(humanIdentity), ...otherActors])
const messagePayload = z.strictObject({
  routing: routingIntent.optional(),
  routing_decision: routingDecision.optional(),
  content: agentContent,
  mentions: uniqueIds,
  client_event_id: idempotencyKeySchema.optional(),
  execution_id: uuidSchema.optional(),
  output_id: outputId.optional(),
  agent_options: options.optional(),
  ...agentMessageFields,
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
// The same catalog twice: browsers get the public actor/participant, agents the one with email.
const durableEventsFor = <A extends z.ZodType, Pt extends z.ZodType, Th extends z.ZodType>(kit: {
  actor: A
  participant: Pt
  thread: Th
}) => {
  const { participant, thread } = kit
  const eventOf = <T extends string, P extends z.ZodType>(type: T, payload: P) =>
    z.strictObject({
      ...eventFields,
      actor: kit.actor,
      type: z.literal(type),
      payload,
    })
  return {
    'thread.created': eventOf('thread.created', z.strictObject({ thread })),
    'thread.updated': eventOf(
      'thread.updated',
      z.strictObject({
        thread_id: uuidSchema,
        title: z.string().max(200),
        state: z.enum(['active', 'archived']),
        version: versionSchema,
        queue: queueName.nullable().optional(),
        run_id: runId.optional(),
      })
    ),
    'thread.archived': eventOf(
      'thread.archived',
      z.strictObject({ thread_id: uuidSchema, version: versionSchema })
    ),
    'participant.added': eventOf(
      'participant.added',
      z.strictObject({ participant, history_policy: z.literal('full'), run_id: runId.optional() })
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
    'reasoning.created': eventOf('reasoning.created', reasoningPayload),
    'tool_call.created': eventOf('tool_call.created', toolCallPayload),
    'tool_result.created': eventOf('tool_result.created', toolResultPayload),
    'tool_transaction.created': eventOf('tool_transaction.created', toolTransactionPayload),
    'chart.created': eventOf('chart.created', chartPayload),
    'form.created': eventOf('form.created', formPayload),
    'form.responded': eventOf(
      'form.responded',
      z.strictObject({
        form_event_id: uuidSchema,
        values: formResponse.shape.values,
        cancelled: formResponse.shape.cancelled,
      })
    ),
    'message.updated': eventOf('message.updated', messageUpdatePayload),
    'message.removed': eventOf('message.removed', z.strictObject({ event_id: uuidSchema })),
    'run.updated': eventOf(
      'run.updated',
      runUpdatePayload.extend({ agent_id: uuidSchema, trigger_event_id: uuidSchema })
    ),
    'channel_delivery.updated': eventOf(
      'channel_delivery.updated',
      z.strictObject({
        event_id: uuidSchema,
        channel: z.literal('whatsapp'),
        status: z.enum(['accepted', 'sent', 'delivered', 'read', 'failed']),
        error: z.string().max(1000).optional(),
        provider_message_id: z.string().min(1).max(256).optional(),
      })
    ),
  }
}
export const durableEventSchemas = durableEventsFor({ actor: actorSchema, participant, thread })
const agentDurableEventSchemas = durableEventsFor({
  actor: agentActor,
  participant: agentParticipant,
  thread: agentThread,
})
const event = z.union(Object.values(durableEventSchemas))
const agentEvent = z.union(Object.values(agentDurableEventSchemas))
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
const formEventPath = z.strictObject({ id: uuidSchema, formEventId: uuidSchema })
const executionArtifactPath = z.strictObject({ id: uuidSchema, artifactId: uuidSchema })
// Link token: base64url(JSON payload) "." base64url(HMAC-SHA256); opaque to clients.
const artifactLinkPath = z.strictObject({
  token: z
    .string()
    .min(3)
    .max(512)
    .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
})
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
// Issued inside an execution: one artifact, no login, valid until expires_at (default 3600 s).
const artifactLinkResponse = z.strictObject({
  url: z.url({ protocol: /^https?$/ }).max(8192),
  expires_at: timestampSchema,
})
const outputOf = <T extends string, P extends z.ZodRawShape, E extends z.ZodRawShape>(
  type: T,
  payload: P,
  extra: E
) =>
  z.strictObject({
    output_id: outputId,
    type: z.literal(type),
    payload: z.strictObject(payload),
    ...extra,
  })
// Every agent output writes one event of the durableEventSchemas catalog (index 4.2/4.4).
const outputUnion = <E extends z.ZodRawShape>(extra: E) =>
  z.discriminatedUnion('type', [
    outputOf(
      'message.create',
      {
        content: agentContent,
        mentions: uniqueIds,
        agent_options: options.optional(),
        ...agentMessageFields,
        handoff: z.strictObject({ recipients: uniqueIds.min(1).max(1) }).optional(),
      },
      extra
    ),
    outputOf('reasoning.create', reasoningPayload.shape, extra),
    outputOf('tool_call.create', toolCallPayload.shape, extra),
    outputOf('tool_result.create', toolResultPayload.shape, extra),
    outputOf('tool_transaction.create', toolTransactionPayload.shape, extra),
    outputOf('chart.create', chartPayload.shape, extra),
    outputOf('form.create', formPayload.shape, extra),
    outputOf('message.update', messageUpdatePayload.shape, extra),
    // Maestro fills trigger_event_id of run.updated from the execution; agent_id defaults to the
    // executing agent (production send.run_start(agent_id=...) records the Run with that agent).
    outputOf('run.update', { ...runUpdatePayload.shape, agent_id: uuidSchema.optional() }, extra),
    outputOf('thread.update', threadUpdatePayload.shape, extra),
    outputOf('participant.add', participantAddPayload.shape, extra),
  ])
const output = outputUnion({})
const heartbeat = z.strictObject({
  lease_fence: sequenceSchema,
  progress_code: reasonCodeSchema.optional(),
})
const outputRequest = outputUnion({ lease_fence: sequenceSchema })
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
  result_event_ids: resultEventIds,
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
  trigger_event: agentEvent,
  invocation_event: agentEvent.optional(),
  participants: z.array(agentParticipant).max(100),
  context_cursor: cursorSchema,
  history: page(agentEvent),
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
  'Public.FormEventPath': formEventPath,
  'Public.ExecutionArtifactPath': executionArtifactPath,
  'Public.ArtifactLinkPath': artifactLinkPath,
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
  'Public.AgentThreadPatchRequest': agentThreadPatch,
  'Public.AgentThreadCreateRequest': agentThreadCreate,
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
  'Public.AgentParticipantAddRequest': z.union(
    agentParticipantTarget.options.map((target) => target.extend({ role: z.literal('member') }))
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
  'Public.FormResponseRequest': formResponse,
  'Public.FeedbackRequest': feedback,
  'Public.ArtifactCreateRequest': artifactCreate,
  'Public.UploadSessionResponse': uploadSession,
  'Public.ArtifactCompleteRequest': artifactComplete,
  'Public.DownloadMetadata': downloadMetadata,
  'Public.ArtifactLinkResponse': artifactLinkResponse,
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
