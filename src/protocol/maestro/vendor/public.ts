import { z } from 'zod'
import {
  actorSchema,
  capabilitiesSchema,
  cursorSchema,
  declaredHumanIdSchema as declaredHumanId,
  declaredHumanNameSchema as declaredHumanName,
  displayNameSchema,
  errorResponseSchema,
  errorSchema,
  externalActorFields,
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
import { connectionContextSchema } from './identity.js'

// Values a handler writes through the production SDK have no per-field length ceiling, as in production (TEXT and
// JSONB columns): only the transport limits bound them (request body, AGENT_MESSAGE_MAX_BYTES, open-json-bytes).
// The other bounds here are v1 contract ceilings of Maestro-only fields, not production quotas (G04/G05).
const empty = z.strictObject({})
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const text = z.string()
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
// Agent text: production does not limit message size and neither does the field. Maestro's operational byte
// limit (AGENT_MESSAGE_MAX_BYTES, 1 MiB) and the callback body limit (2 MiB) refuse first with PAYLOAD_TOO_LARGE.
const agentTextPart = z.strictObject({ type: z.literal('text'), text: z.string() })
// Exact number: production stores a Python int with no bound (JSONB numeric) and writes a float with json.dumps
// (Python repr). JSON.parse rounds an integer beyond the JavaScript safe range to the nearest double and writes every
// whole float as an integer (10.0 becomes 10, 2.0**60 becomes 1152921504606847000: an int in Python). The Maestro
// reads such an integer as its exact source text and such a float as its Python repr (JSON.rawJSON, Node 24), and
// stores and returns the same text, so the handler reads a float where production reads one. A plain JSON.parse (browser, client) gives a number, as before. Each widened
// number exports the JSON Schema of the plain number: the wire format is the same.
// At most 4300 digits: Python reads and writes no longer int (sys.get_int_max_str_digits), so the SDK never sends one,
// and a longer one is VALIDATION_FAILED, as the double Infinity was, not a database refusal.
const exactIntegerText = /^-?(?:0|[1-9][0-9]{0,4299})$/
// Python repr of a whole float: 1.5e+25 (from 1e16), 10.0, 0.0 and -0.0 (below), or the exact decimal of a stored
// response (up to 309 digits and .0).
const exactFloatText = /^-?(?:[1-9](?:\.[0-9]+)?e\+[0-9]{2,3}|(?:0|[1-9][0-9]{0,308})\.0)$/
const isExactNumber = (value: unknown) => {
  const json = JSON as { isRawJSON?: (value: unknown) => boolean }
  if (typeof json.isRawJSON !== 'function' || !json.isRawJSON(value)) return false
  const text = (value as { rawJSON: string }).rawJSON
  return exactIntegerText.test(text) || exactFloatText.test(text)
}
const exactNumber = (schema: z.ZodNumber, exported: () => object) => {
  const widened = z.union([schema, z.custom<number>(isExactNumber)])
  widened._zod.toJSONSchema = exported
  return widened
}
// Production media fields (send.image alt, send.audio duration): str | None and float | None, no range rule.
// duration is any finite JSON number (a negative or a huge float included).
const mediaAlt = z.string()
const mediaDuration = exactNumber(z.number(), () => ({ type: 'number' }))
// Production int (pydantic int, JSONB): any integer, not only a JavaScript safe integer (z.number().int() is one).
// A whole number with no bound, exact beyond 2^53 in the Maestro.
const productionInt = exactNumber(z.number().multipleOf(1), () => ({
  type: 'number',
  multipleOf: 1,
}))
const attachmentPart = z.strictObject({
  type: z.literal('attachment'),
  artifact_id: uuidSchema,
  filename: publicArtifact.shape.filename.optional(),
  mime_type: publicArtifact.shape.mime_type.optional(),
  size_bytes: count.optional(),
  alt: mediaAlt.optional(),
  duration: mediaDuration.optional(),
  width: count.optional(),
  height: count.optional(),
})
// Open production values (dict[str, Any]: tool args/results, form values, chart rows, contact phones, Cloud API
// template components) are one recursive JSON value: no depth, list length, string length or key rules.
// The only bound is the serialized size of each open container (UTF-8 bytes of its compact JSON), mirrored
// by the open-json-bytes rule in semantics.py. The ceiling matches the request body limit of the API.
type Json = string | number | boolean | null | Json[] | { [key: string]: Json }
// Production dict[str, Any] keeps any int: an integer beyond 2^53 stays exact in the Maestro (see exactNumber).
const jsonNumber = exactNumber(z.number(), () => ({ type: 'number' }))
// A number the browser or an agent route wrote with JSON.stringify (a double): a value >= 1e21 is written 1e+21, the
// jsonb keeps its exact numeric, and the Maestro reads it back as its digits (the int production reads). The stored
// event and the saved definition must still validate; the exported JSON Schema is the plain number.
const storedNumber = exactNumber(z.number(), () => ({ type: 'number' }))
// A JSON.rawJSON value is a frozen object with one key (rawJSON): one that is not an exact number (an integer of more
// than 4300 digits) must fail, not pass as the record {"rawJSON": "..."}. The preprocess turns it into undefined,
// which no branch accepts; the exported JSON Schema is the union's.
const notRawRecord = (value: unknown) => {
  const json = JSON as { isRawJSON?: (value: unknown) => boolean }
  return typeof json.isRawJSON === 'function' && json.isRawJSON(value) && !isExactNumber(value)
    ? undefined
    : value
}
// M1: production's dict keeps a "__proto__" key like any other key. Zod's record skips it (so the prototype of its
// output never changes), which drops the value or, with an exact number in it, refuses the request. The record of an
// open object validates "__proto__" under a stand-in key (NUL + "__proto__") and writes it back as an own data property
// (defineProperty), never through the prototype setter. A key of the object that already looks like a stand-in (NUL +
// "__proto__" + NULs) gets one NUL more on the way in and one less on the way out, so the mapping is one to one. The
// order of the keys stays. The exported JSON Schema is the plain record's.
const PROTO_KEY = '__proto__'
const PROTO_STAND_IN = `\u0000${PROTO_KEY}`
const isStandIn = (key: string) =>
  key.startsWith(PROTO_STAND_IN) &&
  [...key.slice(PROTO_STAND_IN.length)].every((char) => char === '\u0000')
const renamedKeys = (value: Record<string, unknown>, rename: (key: string) => string) => {
  const copy: Record<string, unknown> = {}
  for (const key of Object.keys(value))
    Object.defineProperty(copy, rename(key), {
      value: value[key],
      writable: true,
      enumerable: true,
      configurable: true,
    })
  return copy
}
const hideProtoKey = (value: unknown) =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.keys(value).some((key) => key === PROTO_KEY || isStandIn(key))
    ? renamedKeys(value as Record<string, unknown>, (key) =>
        key === PROTO_KEY ? PROTO_STAND_IN : isStandIn(key) ? `${key}\u0000` : key
      )
    : value
const restoreProtoKey = (value: Record<string, Json>): Record<string, Json> =>
  Object.keys(value).some(isStandIn)
    ? (renamedKeys(value, (key) =>
        key === PROTO_STAND_IN ? PROTO_KEY : isStandIn(key) ? key.slice(0, -1) : key
      ) as Record<string, Json>)
    : value
const jsonRecord = () =>
  z.preprocess(hideProtoKey, z.record(z.string(), jsonValue)).overwrite(restoreProtoKey)
const jsonValue: z.ZodType<Json> = z
  .lazy(() =>
    z.preprocess(
      notRawRecord,
      z.union([z.string(), jsonNumber, z.boolean(), z.null(), z.array(jsonValue), jsonRecord()])
    )
  )
  .meta({ id: 'JsonValue' })
const OPEN_JSON_MAX_BYTES = 1048576
const withinOpenJsonBytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).length <= OPEN_JSON_MAX_BYTES
const boundedJson = <T extends z.ZodType>(schema: T) =>
  schema
    .refine(withinOpenJsonBytes, 'Open JSON must not exceed 1 MiB serialized')
    .meta({ 'x-maestro-semantic': 'open-json-bytes' })
const openObject = boundedJson(jsonRecord())
// Production never checks the type of tool args and results (the dict annotation is not enforced: handlers send
// None, "", 0, False, [], "ok"). Any JSON value, null and scalars included, with the same size ceiling.
// The lazy wrapper keeps the exported schema a plain $ref to JsonValue instead of inlining the union at each use.
const openValue = boundedJson(z.lazy(() => jsonValue))
// Production ContactPart.phones is list[dict[str, Any]]: open objects, passed through as-is.
const contactPhone = jsonRecord()
// display_name: production str with no length rule (WireS2C_ContactPart).
const contactPart = z.strictObject({
  type: z.literal('contact'),
  display_name: z.string(),
  vcard: text.optional(),
  phones: boundedJson(z.array(contactPhone)).optional(),
})
// Agent-only part: the production image, audio or document part the SDK did not upload (send.image/audio/document
// when it cannot download the URL, and the parts of send.update_user_event and Repository.create_event). The fields
// are the production values as the handler passed them (WireS2C_ImagePart/AudioPart/DocumentPart: every field is
// optional, url and ref_id included, str and int with no rule): any text, as production stores it, with no URL,
// MIME or filename rule, and any integer.
const mediaLinkPart = z.strictObject({
  type: z.literal('media_link'),
  kind: z.enum(['image', 'audio', 'document']),
  url: z.string().optional(),
  mime_type: z.string().optional(),
  filename: z.string().optional(),
  alt: mediaAlt.optional(),
  duration: mediaDuration.optional(),
  width: productionInt.optional(),
  height: productionInt.optional(),
  size_bytes: productionInt.optional(),
  // Production ref_id: the upload id of the part (in Maestro mode, the artifact_id the handler received).
  ref_id: z.string().optional(),
})
const humanContentPart = z.discriminatedUnion('type', [textPart, attachmentPart, contactPart])
const contentPart = z.discriminatedUnion('type', [
  agentTextPart,
  attachmentPart,
  contactPart,
  mediaLinkPart,
])
const nonblankParts = (parts: z.infer<typeof humanContentPart>[]) =>
  parts.some((p) => p.type !== 'text' || p.text.trim().length > 0)
// Agent messages (message.create and message.update outputs, the stored message.created and message.updated)
// accept a blank text part: production send.text("") and send.update_user_event store it. Human requests keep
// nonblank-content.
const agentContent = z.array(contentPart).min(1).max(32)
// Human messages cannot carry media_link: only agents hold URLs they did not upload as artifacts.
const humanContent = z
  .array(humanContentPart)
  .min(1)
  .max(32)
  .refine(nonblankParts, 'Message must contain text, an attachment or a contact')
  .meta({ 'x-maestro-semantic': 'nonblank-content' })
// Production send.template: template_name and template_language are str, stored as sent (pipeline.py).
const messageTemplate = z.strictObject({
  template_name: z.string(),
  template_language: z.string(),
  template_components: boundedJson(z.array(jsonRecord())).optional(),
})
// Production send.whatsapp.*: to_e164 and instance_id are str, stored as sent.
const messageWhatsapp = z.strictObject({
  to_e164: z.string(),
  instance_id: z.string(),
})
// Run that produced the event (production run_id, handlers/pipeline.py); every agent output may carry it.
const runId = uuidSchema
// run_id of a message the agent writes through the agent API (production ThreadEvent.run_id: str | None, a TEXT
// column): any text, as the free-text Run.agent_id. A UUID stays valid.
const messageRunId = z.string()
// Agent that ran it (production Run.agent_id, send.run_start(agent_id=...)): str | None in the model and a TEXT
// column without limit, so a handler may pass any text ("dooers-assistant"), not only an instance id. Same
// ceiling, as the other free ids the agent writes; a UUID stays valid.
const runAgentId = text
// data: production ThreadEvent.data (ingest/create_event data, data.source of an inbound channel message,
// data.delivery of the reply), one open JSON value. Only the agent writes it (agent API and agent outputs).
const agentMessageFields = {
  // Production author: str | None, a TEXT column.
  author: z.string().optional(),
  template: messageTemplate.optional(),
  whatsapp: messageWhatsapp.optional(),
  run_id: messageRunId.optional(),
  data: openObject.optional(),
}
// Free text the agent writes (reasoning, form/chart messages, run error): production str, no length rule.
const longText = z.string()
// Ids, names, labels and titles the agent writes in tool, form, chart and reasoning events. Production types them
// str and enforces no length (there is no column or model limit), so neither does the contract. The callback
// body limit (2 MiB) bounds the sum.
const agentLabel = z.string()
// Title a thread keeps after an agent thread.update. Production stores TEXT with no length rule, and so does the
// contract. The agent routes (create and PATCH) take the same rule; the human create and rename keep 200.
export const threadTitle = z.string()
const queueName = z.string().max(200)
const runStatus = z.enum(['running', 'succeeded', 'failed'])
// Status of a message on a channel (production data.delivery.status); failed is final.
const channelDeliveryStatus = z.enum(['accepted', 'sent', 'delivered', 'read', 'failed'])
// Provider error code as the provider sends it (WhatsApp: an integer such as 131047, or a text code).
const providerErrorCode = z.union([z.string().min(1).max(64), z.number().int()])
// Production writes display_name None when the handler gives none, so null is as valid as absent.
const toolFields = {
  id: agentLabel,
  name: agentLabel,
  display_name: agentLabel.nullish(),
}
const reasoningPayload = z.strictObject({
  text: longText,
  author: agentLabel.nullish(),
  run_id: runId.optional(),
})
const toolCallPayload = z.strictObject({
  ...toolFields,
  args: openValue,
  run_id: runId.optional(),
})
const toolResultPayload = z.strictObject({
  ...toolFields,
  args: openValue.optional(),
  result: openValue,
  run_id: runId.optional(),
})
const toolTransactionPayload = z.strictObject({
  ...toolFields,
  args: openValue,
  result: openValue,
  run_id: runId.optional(),
})
const panelSize = z.enum(['small', 'medium', 'large'])
// WireS2C_ChartEventData (protocol/models.py): title, message, size and series have defaults there (send.chart always
// sends them, a handler that builds the AgentEvent by hand may not), so they are optional here and stored as sent
// (production dumps with exclude_unset; the browser applies the defaults). The model ignores extra keys (pydantic)
// and model_dump drops them, so the chart and its series accept them here and the execution drops them before
// storing (`withoutChartExtras`), as production does.
const chartSeries = z.looseObject({
  key: agentLabel,
  label: agentLabel.nullish(),
  color: agentLabel.nullish(),
})
const chartPayload = z.looseObject({
  title: agentLabel.optional(),
  message: longText.optional(),
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
  size: panelSize.optional(),
  x_key: agentLabel,
  y_keys: z.array(agentLabel),
  data: boundedJson(z.array(jsonRecord())),
  series: z.array(chartSeries).optional(),
  x_label: agentLabel.nullish(),
  y_label: agentLabel.nullish(),
  run_id: runId.optional(),
})
// WireS2C_Form*Element (protocol/models.py): order, required, disabled and the per-element variants default in the wire model.
const formElementBase = {
  name: agentLabel,
  label: agentLabel,
  order: productionInt.optional(),
  required: z.boolean().optional(),
  disabled: z.boolean().optional(),
}
// FormOption(BaseModel) ignores extra keys like the other form models: accepted here, dropped before storing.
const formOption = z.looseObject({ value: agentLabel, label: agentLabel })
const formOptions = z.array(formOption)
const knownFormElements = [
  z.looseObject({
    ...formElementBase,
    type: z.literal('text_input'),
    placeholder: agentLabel.nullish(),
    default: longText.nullish(),
    input_type: z.enum(['text', 'password', 'email', 'number', 'date']).optional(),
  }),
  z.looseObject({
    ...formElementBase,
    type: z.literal('textarea_input'),
    placeholder: agentLabel.nullish(),
    default: longText.nullish(),
    rows: productionInt.nullish(),
  }),
  z.looseObject({
    ...formElementBase,
    type: z.literal('select_input'),
    options: formOptions,
    default: longText.nullish(),
    placeholder: agentLabel.nullish(),
  }),
  z.looseObject({
    ...formElementBase,
    type: z.literal('radio_input'),
    options: formOptions,
    default: longText.nullish(),
    variant: z.enum(['native', 'button']).optional(),
  }),
  z.looseObject({
    ...formElementBase,
    type: z.literal('checkbox_input'),
    options: formOptions,
    default: z.array(agentLabel).nullish(),
    variant: z.enum(['native', 'button']).optional(),
  }),
  z.looseObject({
    ...formElementBase,
    type: z.literal('file_input'),
    upload_url: agentLabel,
    accept: agentLabel.nullish(),
    multiple: z.boolean().optional(),
  }),
] as const
const KNOWN_FORM_ELEMENT_TYPES: readonly string[] = knownFormElements.map((e) => e.shape.type.value)
// Production passes an element of any other type through as it came (a warning in the log, no failure) and fails on
// one that is not a dict. A known type is never an open object: its own model validates it (semantic rule
// unknown-form-element, mirrored in semantics.py). The list of elements is bounded as a whole (open-json-bytes).
const unknownFormElement = z
  .record(z.string(), jsonValue)
  .refine((element) => !KNOWN_FORM_ELEMENT_TYPES.includes(element['type'] as string))
  .meta({ 'x-maestro-semantic': 'unknown-form-element' })
const formElement = z.union([z.discriminatedUnion('type', knownFormElements), unknownFormElement])
// Own keys only: `key in shape` would also keep an extra named constructor, toString, valueOf or hasOwnProperty.
const keepKnown = (value: Record<string, unknown>, shape: z.ZodRawShape) =>
  Object.fromEntries(Object.entries(value).filter(([key]) => Object.hasOwn(shape, key)))
const formElementShapes = new Map<string, z.ZodRawShape>(
  knownFormElements.map((element) => [element.shape.type.value, element.shape])
)
/**
 * What production stores of a chart: WireS2C_ChartEventData ignores extra keys and model_dump drops them, for the
 * chart and for each series. The execution applies this to the parsed output, so no extra key reaches an event.
 */
export const withoutChartExtras = <C extends { series?: Record<string, unknown>[] | undefined }>(
  chart: C
): C => ({
  ...(keepKnown(chart, chartPayload.shape) as C),
  ...(chart.series === undefined
    ? {}
    : { series: chart.series.map((item) => keepKnown(item, chartSeries.shape)) }),
})
/**
 * Known form elements keep only the fields of their model, and so do their options (FormOption); an element of
 * another type is stored as it came.
 */
export const withoutFormElementExtras = (elements: Record<string, unknown>[]) =>
  elements.map((element) => {
    const shape =
      typeof element['type'] === 'string' ? formElementShapes.get(element['type']) : undefined
    if (shape === undefined) return element
    const kept = keepKnown(element, shape)
    const options = kept['options']
    return Array.isArray(options)
      ? {
          ...kept,
          options: options.map((o) => keepKnown(o as Record<string, unknown>, formOption.shape)),
        }
      : kept
  })
const formPayload = z.strictObject({
  message: longText,
  elements: boundedJson(z.array(formElement)),
  submit_label: agentLabel,
  cancel_label: agentLabel,
  // Production reads .get("size", "medium") and never checks it (only the chart size is a pydantic Literal).
  size: agentLabel.nullish(),
  run_id: runId.optional(),
})
// Production send.update_user_event(event_id: str, content): any id (the Maestro event_id, or the SDK id this agent
// gave when it published the event); pipeline.py only logs a warning when no event has it. An edit may leave a blank
// text, as production stores it (the agent content rule, like message.create).
const messageUpdatePayload = z.strictObject({
  event_id: z.string(),
  content: agentContent,
  run_id: runId.optional(),
})
export const threadUpdatePayload = z.strictObject({
  title: threadTitle.optional(),
  queue: queueName.nullish(),
  run_id: runId.optional(),
})
// Production send.add_participant(user_id: str, user_name: str | None, user_email: str | None,
// identity_ids: list[str] | None): free text and a list of any length, stored in JSONB.
const participantAddPayload = z.strictObject({
  user: z.strictObject({
    user_id: z.string(),
    user_name: z.string().nullish(),
    user_email: z.string().nullish(),
    identity_ids: z.array(z.string()).optional(),
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
// Email, identity ids and roles of a human reach only the agent-facing context (index 4.3.1), never a
// browser. They come from the core ConnectionContext (or, for an event actor, from the profile the
// publishing agent declared); the roles keep the production values (system_role, organization_role,
// workspace_role).
// Production User.user_email and User.identity_ids: str | None and list[str], no length or count rule.
const humanContact = {
  email: z.string().nullish(),
  identity_ids: z.array(z.string()).optional(),
}
const humanIdentity = {
  ...humanContact,
  system_role: z.string().min(1).max(64).optional(),
  organization_role: z.string().min(1).max(64).optional(),
  workspace_role: z.string().min(1).max(64).optional(),
}
// Pre-chat form of the production public chat (guest_name, guest_email, guest_phone of the metadata of the first
// message). Declared by the visitor, never verified: the agent reads it next to the identity the core gave.
// Lengths are the ones of the core person (name 200, e-mail 320) and 64 for the phone; empty values are dropped.
const guestProfile = z.strictObject({
  name: z.string().max(200).optional(),
  email: z.string().max(320).optional(),
  phone: z.string().max(64).optional(),
})
// What only the agent reads of a public chat visitor: the core person (e-mail, identity_ids and the three
// production roles, the same names as the human) and the pre-chat form. Never in a browser shape (index 4.3.1).
const visitorAgentFields = { ...humanIdentity, guest_profile: guestProfile.optional() }
const participantOf = <H extends z.ZodRawShape, E extends z.ZodRawShape>(
  humanExtra: H,
  externalExtra: E
) =>
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
      ...externalActorFields,
      ...externalExtra,
      kind: z.literal('external'),
      role: z.literal('member'),
    }),
  ])
const participant = participantOf({}, {})
const agentParticipant = participantOf(humanIdentity, visitorAgentFields)
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
  title: threadTitle,
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
  // The thread id the caller chose in production (ThreadEvent.thread_id, TEXT): no length rule.
  external_key: z.string().min(1).nullish(),
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
// First message of a public chat visitor: ensures the visitor's thread (idempotent). The visitor, the link, the
// agent, the channel and its label come from the token and the core, never from this body. Returns Public.Thread.
const publicChatThreadRequest = z.strictObject({ guest: guestProfile.optional() })
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
    title: threadTitle.min(1),
    queue: queueName.nullable().optional(),
  }),
  z.strictObject({
    title: threadTitle.min(1).optional(),
    queue: queueName.nullable(),
  }),
])
// Agent-only thread creation (POST /v1/agent/threads): idempotent by external_key, channel metadata allowed.
// owner: the human the SDK caller names (production Thread.owner, User.user_id: any text); the core authorizes it
// like any target. An id that cannot be a core principal (opaquePrincipalSchema) is a person the core does not know.
const agentOwner = z.strictObject({ kind: z.literal('human'), principal_id: z.string().min(1) })
const agentCreateFields = {
  title: threadTitle.optional(),
  participants: z.array(agentParticipantTarget).max(99),
  queue: queueName.nullish(),
  channel: threadFields.channel,
  channel_meta: threadFields.channel_meta,
  external_key: z.string().min(1).optional(),
  owner: agentOwner.optional(),
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
// Delivery context (GET /deliveries/:id/context): direction "backward" reads from the cutoff back to
// the first event, newest first; each next_cursor works only in its own direction and delivery.
const contextQuery = z.strictObject({
  ...pagination,
  direction: z.enum(['forward', 'backward']).optional(),
})
// Agent list (GET /v1/agent/threads): only threads where the agent is an active participant, in the
// token scope. queue "" lists threads without queue (production's "__none__" filter).
// external_key_sha256: the SHA-256 (lowercase hex of the UTF-8 bytes) of an external_key too long for a URL (the
// request line and headers share 16 KiB). It finds the same thread as external_key; the caller compares the key it
// gets back.
const agentThreadListQuery = z.strictObject({
  external_key: z.string().min(1).optional(),
  external_key_sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  queue: queueName.optional(),
  order: z.enum(['asc', 'desc']).optional(),
  ...pagination,
})
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
    minimum: storedNumber,
    maximum: storedNumber,
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
  storedNumber,
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
const durableEventsFor = <
  A extends z.ZodType,
  Pt extends z.ZodType,
  Th extends z.ZodType,
  M extends z.ZodRawShape,
>(kit: {
  actor: A
  participant: Pt
  thread: Th
  /** Extra envelope fields of message.created (the agent catalog adds its origin mark). */
  message: M
}) => {
  const { participant, thread } = kit
  const eventOf = <
    T extends string,
    P extends z.ZodType,
    E extends z.ZodRawShape = Record<never, never>,
  >(
    type: T,
    payload: P,
    extra?: E
  ) =>
    z.strictObject({
      ...eventFields,
      ...(extra ?? ({} as E)),
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
        title: threadTitle,
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
    'message.created': eventOf('message.created', messagePayload, kit.message),
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
      runUpdatePayload.extend({ agent_id: runAgentId, trigger_event_id: uuidSchema })
    ),
    'channel_delivery.updated': eventOf(
      'channel_delivery.updated',
      z.strictObject({
        event_id: uuidSchema,
        channel: z.literal('whatsapp'),
        status: channelDeliveryStatus,
        error: z.string().max(1000).optional(),
        provider_message_id: z.string().min(1).max(256).optional(),
        error_code: providerErrorCode.optional(),
      })
    ),
  }
}
export const durableEventSchemas = durableEventsFor({
  actor: actorSchema,
  participant,
  thread,
  message: {},
})
// Agent catalog: a message published through the agent API carries the publishing agent (origin mark).
// Only that agent reads back the email and identity_ids it declared for a human (index 4.3.1).
const agentDurableEventSchemas = durableEventsFor({
  actor: agentActor,
  participant: agentParticipant,
  thread: agentThread,
  message: { published_by_instance_agent_id: uuidSchema.optional() },
})
const event = z.union(Object.values(durableEventSchemas))
const agentEvent = z.union(Object.values(agentDurableEventSchemas))
// Agent API outside a delivery (plan 5, task 2). The agent publishes as itself or, only in a thread where
// it is the single agent, as a human (any user_id, as production create_event/dispatch) or as an external
// contact. email and identity_ids of the declared human come back only in agent schemas (index 4.3.1).
const agentPublicationActor = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('self') }),
  z.strictObject({
    kind: z.literal('human'),
    // Production User.user_id and User.user_name: any non-empty text, no length or character rule.
    principal_id: declaredHumanId,
    display_name: declaredHumanName.optional(),
    // The agent declares email and identity_ids only; the roles come from the core, in responses.
    ...humanContact,
  }),
  z.strictObject({ kind: z.literal('external'), ...externalFields }),
])
// trigger: true opens a delivery for the publishing agent itself (only for a human or external actor).
const agentEventCreate = z.strictObject({
  type: z.literal('message.created'),
  actor: agentPublicationActor,
  payload: z.strictObject({ content: agentContent, ...agentMessageFields }),
  trigger: z.boolean(),
  idempotency_key: idempotencyKeySchema,
})
// cursor: position of the published event, to follow the next events with GET .../events?cursor=.
const agentEventCreated = z.strictObject({
  event: agentEvent,
  delivery_id: uuidSchema.optional(),
  cursor: cursorSchema,
})
// Agent event list: Maestro event log of one thread; removed events are left out (production remove_event).
// type is one event type or a comma-separated list; actor_kind, actor_id and run_id filter server-side.
// actor_id and run_id filter the values the agent wrote (production User.user_id and ThreadEvent.run_id: any text).
const agentEventListQuery = z.strictObject({
  cursor: cursorSchema.optional(),
  limit: z.number().int().min(1).max(100).optional(),
  order: z.enum(['asc', 'desc']).optional(),
  type: z
    .string()
    .max(4096)
    .regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*(,[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*){0,63}$/)
    .optional(),
  actor_kind: z.enum(['human', 'agent', 'system', 'external']).optional(),
  actor_id: z.string().min(1).optional(),
  run_id: z.string().min(1).optional(),
})
// Agent API side routes outside a delivery (plan 5, task 3). Upload: multipart with this metadata part
// first and the file after it, as the execution upload; the thread comes from the path.
const agentArtifactCreate = z.strictObject({
  filename: publicArtifact.shape.filename,
  mime_type: publicArtifact.shape.mime_type,
  size_bytes: count,
  sha256: publicArtifact.shape.sha256,
})
// Production chat_upload fields (ref_id = artifact_id). mime_type is the canonical type stored by the
// file policy: an attachment part that names a type must use this one.
const agentArtifact = z.strictObject({
  artifact_id: uuidSchema,
  filename: publicArtifact.shape.filename,
  mime_type: publicArtifact.shape.mime_type,
  size_bytes: count,
})
// Production Run folded from run.updated: agent_id, started_at and trigger_event_id of the first event of
// the run; status and error of the last; ended_at of the last when it is terminal.
const agentRun = z.strictObject({
  run_id: runId,
  thread_id: uuidSchema,
  agent_id: runAgentId,
  status: runStatus,
  error: longText.nullable(),
  started_at: timestampSchema,
  ended_at: timestampSchema.nullable(),
  trigger_event_id: uuidSchema,
})
const agentRunListQuery = z.strictObject({
  cursor: cursorSchema.optional(),
  limit: z.number().int().min(1).max(100).optional(),
})
// status is the provider status as received: one that is not a channel status is answered
// {applied: false} (production _receipt_moves_forward), not refused.
const agentChannelDeliveryCreate = z.strictObject({
  thread_id: z.string().min(1),
  event_id: uuidSchema,
  channel: z.literal('whatsapp'),
  status: z.string().min(1).max(64),
  error: z.string().max(1000).optional(),
  error_code: providerErrorCode.optional(),
  provider_message_id: z.string().min(1).max(256).optional(),
})
const agentChannelDeliveryCreated = z.union([
  z.strictObject({ applied: z.literal(true), event: agentEvent }),
  z.strictObject({ applied: z.literal(false) }),
])
const agentChannelDeliveryQuery = z.strictObject({
  provider_message_id: z.string().min(1).max(256),
})
const agentChannelDelivery = z.strictObject({
  thread_id: uuidSchema,
  event_id: uuidSchema,
  status: channelDeliveryStatus,
})
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
// Agent routes: the agent's external_key (the SDK thread id) first, then the Maestro thread id.
const agentThreadPath = z.strictObject({ id: z.string().min(1) })
const agentThreadEventPath = agentThreadPath.extend({ eventId: uuidSchema })
// GET /agent/events/:id: the Maestro event_id or the client_event_id the agent chose when it published.
const agentEventPath = z.strictObject({ id: idempotencyKeySchema })
const agentThreadArtifactPath = agentThreadPath.extend({ artifactId: uuidSchema })
const agentRunPath = z.strictObject({ id: runId })
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
  extra: E,
  tolerant = false
) =>
  z.strictObject({
    output_id: outputId,
    type: z.literal(type),
    payload: tolerant ? z.looseObject(payload) : z.strictObject(payload),
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
    outputOf('chart.create', chartPayload.shape, extra, true),
    outputOf('form.create', formPayload.shape, extra),
    outputOf('message.update', messageUpdatePayload.shape, extra),
    // Maestro fills trigger_event_id of run.updated from the execution; agent_id defaults to the
    // executing agent. Production send.run_start(agent_id=...) records the Run with the text the handler
    // passed (not necessarily an instance id), and so does Maestro.
    outputOf('run.update', { ...runUpdatePayload.shape, agent_id: runAgentId.optional() }, extra),
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
// Current thread view of a delivery context (agent-only). Values are the state at the context cutoff:
// title and queue come from the last thread.created/thread.updated at or below the cutoff; channel,
// channel_meta, created_at and owner_instance_agent_id never change after creation. Same field
// definitions as Public.AgentThread, so the SDK reads the thread row of production unchanged.
// external_key is the key the CALLER chose for the thread (dispatch, ingest, WhatsApp: the id the
// handler sees as thread_id in production); null when there is none and for a public chat visitor
// thread, whose key (public:<link>:...) belongs to the Maestro and is never shown to a handler.
// Optional only so responses of a Maestro that predates this field stay valid; the Maestro always emits it.
const contextThread = z.strictObject({
  thread_id: threadFields.thread_id,
  title: threadFields.title,
  queue: queueName.nullable(),
  channel: threadFields.channel.unwrap(),
  channel_meta: z.union([openObject, z.null()]),
  created_at: threadFields.created_at,
  owner_instance_agent_id: threadFields.owner_instance_agent_id,
  external_key: threadFields.external_key,
})
const contextResponse = z.strictObject({
  delivery_id: uuidSchema,
  // Present on every page (first and later, forward and backward) of the same delivery, always
  // with the same values: the thread at the cutoff. Optional only so responses of a Maestro that
  // predates this field stay valid; the Maestro always emits it.
  thread: contextThread.optional(),
  trigger_event: agentEvent,
  invocation_event: agentEvent.optional(),
  participants: z.array(agentParticipant).max(100),
  // Production allowed_queues and queues (the workspace queue catalog from the core); empty in a
  // personal scope. Agent-only: absent when the Maestro has no core connection context.
  workspace: connectionContextSchema.shape.workspace.optional(),
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
  'Public.PublicChatThreadRequest': publicChatThreadRequest,
  'Public.ThreadListQuery': threadListQuery,
  'Public.ThreadPage': page(thread),
  'Public.SupervisionListQuery': supervisionListQuery,
  'Public.SupervisionThreadPage': page(
    z.strictObject({
      thread_id: uuidSchema,
      scope: scopeSchema,
      title: threadTitle,
      state: threadState,
      updated_at: timestampSchema,
    })
  ),
  'Public.ThreadPatchRequest': threadPatch,
  'Public.AgentThreadPatchRequest': agentThreadPatch,
  'Public.AgentThreadCreateRequest': agentThreadCreate,
  'Public.AgentThread': agentThread,
  'Public.AgentThreadPage': page(agentThread),
  'Public.AgentThreadListQuery': agentThreadListQuery,
  'Public.AgentThreadPath': agentThreadPath,
  'Public.AgentThreadEventPath': agentThreadEventPath,
  'Public.AgentEventPath': agentEventPath,
  'Public.AgentEvent': agentEvent,
  'Public.AgentEventPage': page(agentEvent),
  'Public.AgentEventListQuery': agentEventListQuery,
  'Public.AgentEventCreateRequest': agentEventCreate,
  'Public.AgentEventCreateResponse': agentEventCreated,
  'Public.AgentThreadArtifactPath': agentThreadArtifactPath,
  'Public.AgentArtifactCreateRequest': agentArtifactCreate,
  'Public.AgentArtifact': agentArtifact,
  'Public.AgentRun': agentRun,
  'Public.AgentRunPage': page(agentRun),
  'Public.AgentRunListQuery': agentRunListQuery,
  'Public.AgentRunPath': agentRunPath,
  'Public.AgentChannelDeliveryRequest': agentChannelDeliveryCreate,
  'Public.AgentChannelDeliveryResponse': agentChannelDeliveryCreated,
  'Public.AgentChannelDeliveryQuery': agentChannelDeliveryQuery,
  'Public.AgentChannelDelivery': agentChannelDelivery,
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
  'Public.ContextQuery': contextQuery,
  'Public.ContextThread': contextThread,
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
