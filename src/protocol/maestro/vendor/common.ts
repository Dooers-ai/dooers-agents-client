import { z } from 'zod'

export const protocolVersionSchema = z.literal(1)
export const uuidSchema = z.uuid()
export const opaquePrincipalSchema = z
  .string()
  .min(1)
  .max(256)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Reject control characters in externally supplied identifiers.
  .regex(/^[^\u0000-\u001f\u007f]+$/)
export const sequenceSchema = z.string().regex(/^(0|[1-9][0-9]*)$/)
export const timestampSchema = z.iso.datetime({ offset: false })
export const cursorSchema = z.string().min(1).max(4096)
export const idempotencyKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\x21-\x7e]+$/)
export const scopeKindSchema = z.enum(['personal', 'workspace'])
export const scopeSchema = z.discriminatedUnion('scope_kind', [
  z.strictObject({
    organization_id: uuidSchema,
    scope_kind: z.literal('personal'),
    workspace_id: z.null(),
  }),
  z.strictObject({
    organization_id: uuidSchema,
    scope_kind: z.literal('workspace'),
    workspace_id: uuidSchema,
  }),
])
export const knownCapabilities = [
  'threads.shared',
  'participants.humans',
  'participants.agents',
  'history.replay',
  'history.context',
  'deliveries.http',
  'deliveries.status',
  'messages.text',
  'responses.silence',
  'attachments.durable',
  'stream.delta',
  'executions.cancel',
  'interactions.forms',
  'interactions.tool_approval',
  'feedback',
  'export',
  'chat_context.per_agent',
] as const
export const capabilitySchema = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/)
export const capabilitiesSchema = z
  .array(capabilitySchema)
  .max(64)
  .refine((v) => new Set(v).size === v.length, 'Capabilities must be unique')
  .meta({ uniqueItems: true })
export const reasonCodeSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[a-z][a-z0-9_]*$/)
export const versionSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
export const displayNameSchema = z.string().min(1).max(200)
export const actorSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('human'),
    principal_id: opaquePrincipalSchema,
    participant_id: uuidSchema.nullable(),
    display_name: displayNameSchema,
  }),
  z.strictObject({
    kind: z.literal('agent'),
    principal_id: uuidSchema,
    instance_agent_id: uuidSchema,
    participant_id: uuidSchema,
    display_name: displayNameSchema,
  }),
  z.strictObject({
    kind: z.literal('system'),
    principal_id: opaquePrincipalSchema,
    participant_id: z.null(),
    display_name: displayNameSchema,
  }),
])
export const publicErrorCodes = [
  'INVALID_REQUEST',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'VERSION_CONFLICT',
  'PAYLOAD_TOO_LARGE',
  'VALIDATION_FAILED',
  'RATE_LIMITED',
  'DEPENDENCY_UNAVAILABLE',
  'UNSUPPORTED_PROTOCOL',
  'UNSUPPORTED_CAPABILITY',
  'IDEMPOTENCY_CONFLICT',
  'THREAD_ARCHIVED',
  'THREAD_DELETING',
  'PARTICIPANT_INELIGIBLE',
  'CURSOR_INVALID',
  'CURSOR_EXPIRED',
  'LEASE_STALE',
  'EXECUTION_TERMINAL',
  'CAUSAL_BUDGET_EXHAUSTED',
  'INTERACTION_EXPIRED',
  'ARTIFACT_NOT_READY',
  'QUOTA_EXCEEDED',
  'CORE_UNAVAILABLE',
] as const
export const errorSchema = z.strictObject({
  code: z.enum(publicErrorCodes),
  message: z.string().min(1).max(500),
  retryable: z.boolean(),
  request_id: uuidSchema,
  details: z
    .strictObject({
      field: z.string().max(128).optional(),
      reason_code: reasonCodeSchema.optional(),
      retry_after_seconds: z.number().int().min(0).max(86400).optional(),
      recovery: z
        .enum(['retry_same_key', 'reconnect', 'snapshot', 'reauthenticate', 'none'])
        .optional(),
    })
    .optional(),
})
export const errorResponseSchema = z.strictObject({ error: errorSchema })
