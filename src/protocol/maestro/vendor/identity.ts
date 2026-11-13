import { z } from 'zod'
import {
  capabilitiesSchema,
  cursorSchema,
  displayNameSchema,
  externalChannelSchema,
  externalConnectionTypeSchema,
  externalIdSchema,
  opaquePrincipalSchema,
  scopeSchema,
  timestampSchema,
  uuidSchema,
  versionSchema,
} from './common.js'

/** Contratos de dados. Não verificam assinatura, sessão, membership nem permissão no core. */
export const maestroAudience = 'dooers-service-maestro' as const
export const coreIssuer = 'dooers-service-core' as const
export const humanScopes = [
  'threads:read',
  'threads:create',
  'messages:write',
  'participants:manage',
  'threads:manage',
  'threads:supervise',
  'executions:cancel',
  'roots:stop',
  'feedback:write',
  'artifacts:write',
  'interactions:write',
] as const
export const agentScopes = [
  'deliveries:read',
  'context:read',
  'responses:write',
  'processing:write',
  // Thread management by the agent (index 4.5). Humans already hold this scope; the agent holds it separately.
  'threads:manage',
] as const
/**
 * Public chat visitor (actor_type external). One scope: it opens the operations of externalOperations,
 * and only in the thread where the visitor is the active external participant. No human or agent token
 * carries it and no external token carries any other scope.
 */
export const externalScopes = ['public_chat:converse'] as const
type AnyScope =
  | (typeof humanScopes)[number]
  | (typeof agentScopes)[number]
  | (typeof externalScopes)[number]
export const identityScopeSchema = z.enum([
  ...new Set([...humanScopes, ...agentScopes, ...externalScopes]),
] as [AnyScope, ...AnyScope[]])
export const humanScopeSchema = z.enum(humanScopes)
export const agentScopeSchema = z.enum(agentScopes)
export const externalScopeSchema = z.enum(externalScopes)
const uniqueScopes = <T extends z.ZodType>(item: T, minimum = 1) =>
  z
    .array(item)
    .min(minimum)
    .max(32)
    .refine((value) => new Set(value).size === value.length, 'Scopes devem ser únicos')
    .meta({ uniqueItems: true })
export const humanScopesSchema = uniqueScopes(humanScopeSchema)
export const agentScopesSchema = uniqueScopes(agentScopeSchema)
export const externalScopesSchema = uniqueScopes(externalScopeSchema)
const referenceSchema = opaquePrincipalSchema
const tokenSchema = z.string().min(1).max(16384)
const epochSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const scopeFields = { organization_id: uuidSchema, workspace_id: uuidSchema.nullable() }
export const identityReasonSchema = z.enum([
  'invalid_token',
  'expired_token',
  'wrong_audience',
  'revoked_session',
  'revoked_credential',
  'organization_access_revoked',
  'workspace_access_revoked',
  'scope_mismatch',
  'agent_access_denied',
  'agent_inactive',
  'runtime_not_allowed',
  'capability_missing',
  'supervision_denied',
  'core_unavailable',
])
export const requiredRuntimeCapabilities = [
  'deliveries.http',
  'history.context',
  'messages.text',
  'responses.silence',
] as const

export const humanTokenRequestSchema = z.strictObject({ ...scopeFields, scopes: humanScopesSchema })
export const agentTokenRequestSchema = z.strictObject({
  ...scopeFields,
  agent_id: uuidSchema,
  runtime_id: uuidSchema.nullable(),
  scopes: agentScopesSchema,
})

const claimsBase = {
  iss: z.literal(coreIssuer),
  aud: z.literal(maestroAudience),
  sub: opaquePrincipalSchema,
  iat: epochSchema,
  exp: epochSchema,
  jti: uuidSchema,
  ...scopeFields,
}
export const humanTokenClaimsSchema = z
  .strictObject({
    ...claimsBase,
    actor_type: z.literal('human'),
    user_id: opaquePrincipalSchema,
    session_ref: referenceSchema,
    session_version: versionSchema,
    scopes: humanScopesSchema,
    runtime_id: uuidSchema.optional(),
    credential_version: versionSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.sub !== value.user_id)
      ctx.addIssue({
        code: 'custom',
        path: ['sub'],
        message: 'Subject deve ser o authUserId canônico',
      })
    if (value.exp <= value.iat || value.exp - value.iat > 300)
      ctx.addIssue({
        code: 'custom',
        path: ['exp'],
        message: 'TTL baseline deve estar entre 1 e 300s',
      })
  })
  .meta({ 'x-maestro-semantic': 'identity_human_claims' })

export const agentTokenClaimsSchema = z
  .strictObject({
    ...claimsBase,
    actor_type: z.literal('aiagent'),
    agent_id: uuidSchema,
    runtime_id: uuidSchema.nullable(),
    credential_version: versionSchema,
    authorization_version: versionSchema,
    scopes: agentScopesSchema,
  })
  .superRefine((value, ctx) => {
    if (value.sub !== value.agent_id)
      ctx.addIssue({
        code: 'custom',
        path: ['sub'],
        message: 'Subject deve ser a instância, nunca infraestrutura',
      })
    if (value.exp <= value.iat || value.exp - value.iat > 300)
      ctx.addIssue({
        code: 'custom',
        path: ['exp'],
        message: 'TTL baseline deve estar entre 1 e 300s',
      })
  })
  .meta({ 'x-maestro-semantic': 'identity_agent_claims' })

/**
 * Identity of a public chat visitor (index 4.3, plan 6). external_id is the production user_id: the guest id
 * (`guest:` + 22 characters of [A-Za-z0-9_-]) when connection_type is guest, or the raw id of the signed-in
 * user (never starting with `guest:`) when it is public_authenticated. The principal id (and the subject)
 * is namespaced, `public_chat:<public_chat_link_id>:<external_id>`, so it never equals a human principal id,
 * whose value is the raw user id; that namespace is why external_id is at most 207 characters.
 * The token lives at most 300 s like every Maestro token; the core re-issues it while the session lasts.
 */
export const externalPrincipalId = (linkId: string, externalId: string) =>
  `public_chat:${linkId}:${externalId}`
const guestExternalId = /^guest:[A-Za-z0-9_-]{22}$/
/** guest: the production guest id; public_authenticated: any other id (a raw user id never claims the guest prefix). */
export const externalIdMatchesConnection = (
  connectionType: 'guest' | 'public_authenticated',
  externalId: string
) =>
  connectionType === 'guest' ? guestExternalId.test(externalId) : !externalId.startsWith('guest:')
const externalIdentityFields = {
  external_id: z.string().min(1).max(207),
  channel: z.literal('public_chat'),
  connection_type: externalConnectionTypeSchema,
  public_chat_link_id: uuidSchema,
  instance_agent_id: uuidSchema,
}
const externalIdentityKeys = Object.keys(
  externalIdentityFields
) as (keyof typeof externalIdentityFields)[]
// Messages per minute of the link (production rateLimits.messagesPerMinute); the Maestro enforces it on publish.
const messageRateSchema = z.number().int().min(1).max(100000)
export const externalTokenClaimsSchema = z
  .strictObject({
    ...claimsBase,
    actor_type: z.literal('external'),
    ...externalIdentityFields,
    session_ref: referenceSchema,
    session_version: versionSchema,
    scopes: externalScopesSchema,
    rate_limit_msgs_per_min: messageRateSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.sub !== externalPrincipalId(value.public_chat_link_id, value.external_id))
      ctx.addIssue({
        code: 'custom',
        path: ['sub'],
        message: 'Subject deve ser o principal_id do visitante, com o namespace do link',
      })
    if (!externalIdMatchesConnection(value.connection_type, value.external_id))
      ctx.addIssue({
        code: 'custom',
        path: ['external_id'],
        message: 'external_id deve ter o formato do connection_type',
      })
    if (value.exp <= value.iat || value.exp - value.iat > 300)
      ctx.addIssue({
        code: 'custom',
        path: ['exp'],
        message: 'TTL baseline deve estar entre 1 e 300s',
      })
  })
  .meta({ 'x-maestro-semantic': 'identity_external_claims' })

export const tokenClaimsSchema = z.union([
  humanTokenClaimsSchema,
  agentTokenClaimsSchema,
  externalTokenClaimsSchema,
])
export const humanTokenResponseSchema = z.strictObject({
  access_token: tokenSchema,
  token_type: z.literal('Bearer'),
  expires_in: z.number().int().min(1).max(300),
  scope: scopeSchema,
  scopes: humanScopesSchema,
})
export const agentTokenResponseSchema = z.strictObject({
  access_token: tokenSchema,
  token_type: z.literal('Bearer'),
  expires_in: z.number().int().min(1).max(300),
  scope: scopeSchema,
  scopes: agentScopesSchema,
})

/**
 * Exchange of a public chat session for a Maestro token (plan 6, task 2). The core route takes the
 * session token the browser holds (the JWT the public chat already issues) and answers with the Maestro
 * token of the visitor. The token ends no later than the session and at most 300 s from now; the browser
 * exchanges again when it needs a new one. principal_id is the `sub` of the token (the namespaced visitor id,
 * which the client compares with the claims) and instance_agent_id is the agent of the link, which the client
 * uses as the agent principal of the thread. Nothing here is a profile: e-mail, name and roles of the
 * visitor go to the agent only, in the decision of thread.create.public_chat.
 */
export const externalTokenRequestSchema = z.strictObject({
  session_token: z.string().min(1).max(4096),
})
export const externalTokenResponseSchema = z
  .strictObject({
    token: tokenSchema,
    expires_at: timestampSchema,
    principal_id: opaquePrincipalSchema,
    ...externalIdentityFields,
  })
  .superRefine((value, ctx) => {
    if (value.principal_id !== externalPrincipalId(value.public_chat_link_id, value.external_id))
      ctx.addIssue({
        code: 'custom',
        path: ['principal_id'],
        message: 'principal_id deve ter o namespace do link e o external_id',
      })
    if (!externalIdMatchesConnection(value.connection_type, value.external_id))
      ctx.addIssue({
        code: 'custom',
        path: ['external_id'],
        message: 'external_id deve ter o formato do connection_type',
      })
  })
  .meta({ 'x-maestro-semantic': 'identity_external_token_response' })

export const canonicalHumanSchema = z.strictObject({
  actor_type: z.literal('human'),
  principal_id: opaquePrincipalSchema,
})
export const canonicalAgentSchema = z.strictObject({
  actor_type: z.literal('aiagent'),
  principal_id: uuidSchema,
  runtime_id: uuidSchema.nullable(),
})
export const canonicalExternalSchema = z.strictObject({
  actor_type: z.literal('external'),
  principal_id: opaquePrincipalSchema,
  ...externalIdentityFields,
})
export const canonicalPrincipalSchema = z.discriminatedUnion('actor_type', [
  canonicalHumanSchema,
  canonicalAgentSchema,
  canonicalExternalSchema,
])
export const humanLineageSchema = z.strictObject({
  kind: z.literal('session'),
  session_ref: referenceSchema,
  session_version: versionSchema,
})
export const agentLineageSchema = z.strictObject({
  kind: z.literal('credential'),
  agent_id: uuidSchema,
  runtime_id: uuidSchema.nullable(),
  credential_version: versionSchema,
  authorization_version: versionSchema,
})
export const externalLineageSchema = z.strictObject({
  kind: z.literal('public_chat_session'),
  session_ref: referenceSchema,
  session_version: versionSchema,
  public_chat_link_id: uuidSchema,
  rate_limit_msgs_per_min: messageRateSchema.optional(),
})
export const introspectRequestSchema = z.strictObject({
  token: tokenSchema,
  request_id: uuidSchema,
})
const activeFields = {
  active: z.literal(true),
  token_ref: referenceSchema,
  token_id: uuidSchema,
  audience: z.literal(maestroAudience),
  scope: scopeSchema,
  issued_at: timestampSchema,
  expires_at: timestampSchema,
  authorization_version: versionSchema,
}
export const activeHumanIntrospectionSchema = z.strictObject({
  ...activeFields,
  principal: canonicalHumanSchema,
  scopes: humanScopesSchema,
  lineage: humanLineageSchema,
})
export const activeAgentIntrospectionSchema = z
  .strictObject({
    ...activeFields,
    principal: canonicalAgentSchema,
    scopes: agentScopesSchema,
    lineage: agentLineageSchema,
  })
  .superRefine((value, ctx) => {
    if (
      value.principal.principal_id !== value.lineage.agent_id ||
      value.principal.runtime_id !== value.lineage.runtime_id ||
      value.authorization_version !== value.lineage.authorization_version
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['lineage'],
        message: 'Lineage deve corresponder à instância e runtime canônicos',
      })
    }
  })
  .meta({ 'x-maestro-semantic': 'identity_agent_lineage' })

export const activeExternalIntrospectionSchema = z
  .strictObject({
    ...activeFields,
    principal: canonicalExternalSchema,
    scopes: externalScopesSchema,
    lineage: externalLineageSchema,
  })
  .superRefine((value, ctx) => {
    const visitor = value.principal
    if (
      visitor.principal_id !== externalPrincipalId(visitor.public_chat_link_id, visitor.external_id)
    )
      ctx.addIssue({
        code: 'custom',
        path: ['principal', 'principal_id'],
        message: 'Principal do visitante deve ter o namespace do link e o external_id',
      })
    if (!externalIdMatchesConnection(visitor.connection_type, visitor.external_id))
      ctx.addIssue({
        code: 'custom',
        path: ['principal', 'external_id'],
        message: 'external_id deve ter o formato do connection_type',
      })
    if (value.lineage.public_chat_link_id !== value.principal.public_chat_link_id)
      ctx.addIssue({
        code: 'custom',
        path: ['lineage'],
        message: 'Lineage deve corresponder ao link do chat público do principal',
      })
  })
  .meta({ 'x-maestro-semantic': 'identity_external_lineage' })

export const activeIntrospectionSchema = z
  .union([
    activeHumanIntrospectionSchema,
    activeAgentIntrospectionSchema,
    activeExternalIntrospectionSchema,
  ])
  .superRefine((value, ctx) => {
    if (
      Date.parse(value.expires_at) <= Date.parse(value.issued_at) ||
      Date.parse(value.expires_at) - Date.parse(value.issued_at) > 300_000
    )
      ctx.addIssue({
        code: 'custom',
        path: ['expires_at'],
        message: 'Expiração deve ser posterior à emissão',
      })
  })
  .meta({ 'x-maestro-semantic': 'identity_introspection_time' })

export const inactiveIntrospectionSchema = z.strictObject({
  active: z.literal(false),
  reason_code: identityReasonSchema,
})
export const introspectResponseSchema = z.union([
  activeIntrospectionSchema,
  inactiveIntrospectionSchema,
])

export const authorizationOperations = [
  'thread.create',
  'thread.list',
  'thread.read',
  'thread.subscribe',
  'thread.export',
  'thread.rename',
  'thread.archive',
  'thread.unarchive',
  'thread.delete',
  'thread.ownership.transfer',
  'participant.add',
  'participant.remove',
  'participant.leave',
  'message.publish',
  'execution.cancel',
  'root.stop',
  'feedback.write',
  'feedback.delete',
  'artifact.upload',
  'artifact.complete',
  'artifact.link',
  'artifact.upload.prethread',
  'artifact.read',
  'artifact.download',
  'interaction.respond',
  'thread.supervision.list',
  'thread.supervision.open',
  'thread.supervision.read',
  'thread.supervision.subscribe',
  'thread.supervision.export',
  'delivery.read',
  'delivery.context',
  'delivery.respond',
  'delivery.heartbeat',
  'delivery.complete',
  'delivery.suspend',
  // Operations only an aiagent performs, outside a delivery (index 4.5).
  'thread.queue.update',
  'message.update',
  'message.remove',
  'run.write',
  'channel_delivery.write',
  'artifact.link.issue',
  // Operation only the external principal performs: creating its own visitor thread, through the
  // public chat ensure route. The generic thread.create stays refused for it (index 4.5, plan 6).
  'thread.create.public_chat',
] as const
export const authorizationOperationSchema = z.enum(authorizationOperations)
export type AuthorizationOperation = z.infer<typeof authorizationOperationSchema>
export const authorizationScopeRules: Record<AuthorizationOperation, readonly string[]> = {
  'thread.create': ['threads:create'],
  'thread.list': ['threads:read'],
  'thread.read': ['threads:read'],
  'thread.subscribe': ['threads:read'],
  'thread.export': ['threads:read'],
  'thread.rename': ['threads:manage'],
  'thread.archive': ['threads:manage'],
  'thread.unarchive': ['threads:manage'],
  'thread.delete': ['threads:manage'],
  'thread.ownership.transfer': ['threads:manage', 'participants:manage'],
  'participant.add': ['participants:manage'],
  'participant.remove': ['participants:manage'],
  'participant.leave': ['threads:read'],
  'message.publish': ['messages:write'],
  'execution.cancel': ['executions:cancel'],
  'root.stop': ['roots:stop'],
  'feedback.write': ['feedback:write'],
  'feedback.delete': ['feedback:write'],
  'artifact.upload': ['artifacts:write', 'messages:write'],
  'artifact.complete': ['artifacts:write', 'messages:write'],
  'artifact.link': ['artifacts:write', 'messages:write'],
  'artifact.upload.prethread': ['artifacts:write', 'threads:create'],
  'artifact.read': ['threads:read'],
  'artifact.download': ['threads:read'],
  'interaction.respond': ['interactions:write', 'messages:write'],
  'thread.supervision.list': ['threads:supervise'],
  'thread.supervision.open': ['threads:supervise'],
  'thread.supervision.read': ['threads:supervise'],
  'thread.supervision.subscribe': ['threads:supervise'],
  'thread.supervision.export': ['threads:supervise'],
  'delivery.read': ['deliveries:read', 'context:read'],
  'delivery.context': ['deliveries:read', 'context:read'],
  'delivery.respond': ['responses:write'],
  'delivery.heartbeat': ['processing:write'],
  'delivery.complete': ['processing:write'],
  'delivery.suspend': ['processing:write', 'responses:write'],
  'thread.queue.update': ['threads:manage'],
  'message.update': ['threads:manage'],
  'message.remove': ['threads:manage'],
  'run.write': ['threads:manage'],
  'channel_delivery.write': ['threads:manage'],
  'artifact.link.issue': ['threads:manage'],
  'thread.create.public_chat': ['public_chat:converse'],
}
/** Operation of the visitor thread: only the external principal performs it (see externalOperations). */
export const publicChatThreadCreateOperation = 'thread.create.public_chat' as const
/**
 * Operations the external principal may perform with public_chat:converse (plan 6, ruling F5). It never
 * lists, creates through the generic route, renames, archives, exports, supervises or removes anything,
 * and never takes a delivery.* or agent-only operation. Uploads go through artifact.upload.prethread: the
 * visitor has no agent execution. Every operation but the ensure one still needs the Maestro to find
 * the visitor as the active external participant of the thread (external_id, channel, connection type,
 * public chat link and agent of the token): that check needs the thread state and runs in the Maestro.
 * thread.create.public_chat has no thread yet; it may only target the visitor and the agent of the link.
 */
export const externalOperations = [
  'thread.read',
  'thread.subscribe',
  'message.publish',
  'artifact.upload.prethread',
  'artifact.read',
  'artifact.download',
  'interaction.respond',
  publicChatThreadCreateOperation,
] as const satisfies readonly AuthorizationOperation[]
/**
 * Operations an aiagent may perform with threads:manage (index 4.5): seven existing ones released
 * to the agent plus the six agent-only ones. With more than one active agent in the thread the
 * Maestro still refuses thread.rename, thread.queue.update, thread.delete, participant.add,
 * message.update/message.remove on events of another actor and message.publish as another actor
 * (FORBIDDEN, reason_code multi_agent_thread); a form answered for an agent that left the thread is
 * FORBIDDEN, reason_code agent_not_participant. Both checks need the thread state and run in the Maestro.
 */
export const agentOnlyOperations = [
  'thread.queue.update',
  'message.update',
  'message.remove',
  'run.write',
  'channel_delivery.write',
  'artifact.link.issue',
] as const satisfies readonly AuthorizationOperation[]
export const agentManagedOperations = [
  'thread.create',
  'thread.list',
  'thread.read',
  'thread.rename',
  'thread.delete',
  'participant.add',
  'message.publish',
  ...agentOnlyOperations,
] as const satisfies readonly AuthorizationOperation[]
export const principalTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('human'), principal_id: opaquePrincipalSchema }),
  z.strictObject({
    kind: z.literal('agent'),
    principal_id: uuidSchema,
    runtime_id: uuidSchema.nullable(),
  }),
])
/** Person on a messaging channel, with no Dooers principal. Only an aiagent may target one (see the exchange gate). */
const externalTargetSchema = z.strictObject({
  kind: z.literal('external'),
  external_id: externalIdSchema,
  channel: externalChannelSchema,
})
export const authorizationTargetSchema = z.discriminatedUnion('kind', [
  ...principalTargetSchema.options,
  externalTargetSchema,
])
/**
 * Operations whose targets may include an external participant: creating a channel thread, adding a
 * participant, and the visitor creating its own thread (where only the visitor itself may be the target).
 */
export const externalTargetOperations = [
  'thread.create',
  'participant.add',
  publicChatThreadCreateOperation,
] as const
const targetIdentity = (target: z.infer<typeof authorizationTargetSchema>) =>
  target.kind === 'external' ? `${target.channel}:${target.external_id}` : target.principal_id
const participantContextSchema = z
  .strictObject({
    participant_id: uuidSchema,
    target: principalTargetSchema,
    role: z.enum(['owner', 'member']),
  })
  .superRefine((value, ctx) => {
    if (value.target.kind === 'agent' && value.role === 'owner')
      ctx.addIssue({ code: 'custom', path: ['role'], message: 'Agente não pode ser owner' })
  })
  .meta({ 'x-maestro-semantic': 'identity_participant_role' })

/**
 * Person and workspace data that production handlers read from the core ConnectionContext
 * (validate-agent-session): one entry per active human of the evaluated set, plus the workspace
 * queue catalog. Agent-only: it reaches the agent-facing Maestro schemas, never a browser (4.3.1).
 */
const connectionText = (max: number) => z.string().max(max)
export const connectionHumanSchema = z.strictObject({
  principal_id: opaquePrincipalSchema,
  name: connectionText(200),
  email: connectionText(320),
  identity_ids: z.array(z.string().min(1).max(256)).max(256),
  system_role: z.string().min(1).max(64),
  organization_role: z.string().min(1).max(64),
  workspace_role: z.string().min(1).max(64),
})
export const workspaceQueueMemberSchema = z.strictObject({
  user_id: z.string().min(1).max(256),
  user_name: connectionText(200),
  user_email: connectionText(320),
  identity_ids: z.array(z.string().min(1).max(256)).max(256),
  claims: z.record(
    z.string().min(1).max(128),
    z.union([z.string().max(4096), z.number(), z.boolean()])
  ),
})
export const workspaceQueueSchema = z.strictObject({
  slug: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
  name: connectionText(200),
  members: z.array(workspaceQueueMemberSchema).max(1000),
})
export const connectionContextSchema = z.strictObject({
  humans: z.array(connectionHumanSchema).max(100),
  workspace: z.strictObject({
    // Slugs of the catalog (production allowed_queues); both empty in a personal scope.
    allowed_queues: z.array(workspaceQueueSchema.shape.slug).max(1000),
    queues: z.array(workspaceQueueSchema).max(1000),
  }),
})

/**
 * Person and workspace data of the public chat visitor, as production handlers read them from the
 * connection context of the session (validate-connection): the visitor as one person (principal_id is the
 * external_id, the production user_id) and the workspace queue catalog. Authenticated: name, e-mail,
 * identity_ids and the roles of the signed-in user. Guest: no name, no e-mail, no identity_ids and the
 * `guest` role in the three roles. Agent-only, like connectionContextSchema: it answers
 * thread.create.public_chat inside the allowed decision and never reaches a browser (index 4.3.1).
 */
export const visitorContextSchema = z.strictObject({
  person: connectionHumanSchema,
  workspace: connectionContextSchema.shape.workspace,
})

export const authorizeRequestSchema = z
  .strictObject({
    request_id: uuidSchema,
    token_ref: referenceSchema,
    operation: authorizationOperationSchema,
    scope: scopeSchema,
    thread_id: uuidSchema.nullable(),
    targets: z.array(authorizationTargetSchema).max(100),
    runtime_id: uuidSchema.optional(),
    writes_output: z.boolean().optional(),
    // Agent only (index 4.3.1): asks the core for the person and workspace data of the connection
    // context (see connectionContextSchema). Answered inside the allowed decision, never alone.
    include_connection: z.boolean().optional(),
    resource: z
      .strictObject({
        event_id: uuidSchema.optional(),
        root_event_id: uuidSchema.optional(),
        artifact_id: uuidSchema.optional(),
        interaction_id: uuidSchema.optional(),
        delivery_id: uuidSchema.optional(),
        execution_id: uuidSchema.optional(),
      })
      .optional(),
    membership_context: z
      .strictObject({
        version: versionSchema,
        participants: z.array(participantContextSchema).max(100),
      })
      .optional(),
    supervision: z
      .strictObject({
        purpose: z.string().min(1).max(256),
        access_reason: z.string().min(1).max(2000).regex(/\S/).optional(),
      })
      .optional(),
  })
  .superRefine((value, ctx) => {
    const unbound = [
      'thread.create',
      'thread.list',
      'thread.supervision.list',
      'artifact.upload.prethread',
      publicChatThreadCreateOperation,
    ]
    if (!unbound.includes(value.operation) && value.thread_id === null)
      ctx.addIssue({
        code: 'custom',
        path: ['thread_id'],
        message: 'Operação exige a thread canônica carregada pelo Maestro',
      })
    if (value.operation.startsWith('thread.supervision.') && !value.supervision)
      ctx.addIssue({
        code: 'custom',
        path: ['supervision'],
        message: 'Supervisão deve ser explícita',
      })
    if (
      value.writes_output !== undefined &&
      !['delivery.complete', 'delivery.suspend'].includes(value.operation)
    )
      ctx.addIssue({
        code: 'custom',
        path: ['writes_output'],
        message: 'Intenção de saída pertence somente a complete/suspend',
      })
    if (
      value.targets.some((target) => target.kind === 'external') &&
      !(externalTargetOperations as readonly string[]).includes(value.operation)
    )
      ctx.addIssue({
        code: 'custom',
        path: ['targets'],
        message:
          'Alvo external só existe em thread.create, participant.add e thread.create.public_chat',
      })
    const keys = value.targets.map((target) => `${target.kind}:${targetIdentity(target)}`)
    if (new Set(keys).size !== keys.length)
      ctx.addIssue({ code: 'custom', path: ['targets'], message: 'Alvos devem ser únicos' })
  })
  .meta({ 'x-maestro-semantic': 'identity_authorize_request' })

/** Projeção somente S2S: infra_agent_id jamais entra em Candidate, Actor ou Participant públicos. */
export const authorizedRuntimeSchema = z
  .strictObject({
    instance_agent_id: uuidSchema,
    infra_agent_id: uuidSchema,
    runtime_id: uuidSchema,
    thread_management: z.literal('maestro'),
    maestro_protocol_version: z.literal(1),
    capabilities: capabilitiesSchema,
    runtime_version: versionSchema,
  })
  .superRefine((value, ctx) => {
    if (!requiredRuntimeCapabilities.every((capability) => value.capabilities.includes(capability)))
      ctx.addIssue({
        code: 'custom',
        path: ['capabilities'],
        message: 'Runtime autorizado precisa das capabilities mínimas Maestro',
      })
  })
  .meta({ 'x-maestro-semantic': 'identity_runtime_capabilities' })

export const supervisionPolicySchema = z.strictObject({
  mode: z.enum(['strict', 'operational', 'open']),
  reason_required: z.boolean(),
  policy_version: versionSchema,
})
/**
 * Elevação do usuário no escopo da conversa, calculada pelo core (autoridade de identidade).
 * Precedência: organization_admin > workspace_manager > platform_admin; null quando nenhuma se aplica.
 * Não é papel local de participante (owner/member) e não concede escrita: o Maestro combina a
 * elevação com a participação ativa na tabela de regras de acesso.
 */
export const threadElevationSchema = z.enum([
  'organization_admin',
  'workspace_manager',
  'platform_admin',
])
const targetDecisionSchema = z.discriminatedUnion('allowed', [
  z.strictObject({
    target: authorizationTargetSchema,
    allowed: z.literal(true),
    reason_code: z.literal('allowed'),
  }),
  z.strictObject({
    target: authorizationTargetSchema,
    allowed: z.literal(false),
    reason_code: identityReasonSchema,
  }),
])
const decisionFields = {
  decision_id: uuidSchema,
  request_id: uuidSchema,
  token_ref: referenceSchema,
  principal: canonicalPrincipalSchema,
  thread_id: uuidSchema.nullable(),
  resource: authorizeRequestSchema.shape.resource,
  operation: authorizationOperationSchema,
  scope: scopeSchema,
  authorization_version: versionSchema,
  valid_until: timestampSchema,
  targets: z.array(targetDecisionSchema).max(100),
}
export const allowedAuthorizationSchema = z
  .strictObject({
    ...decisionFields,
    allowed: z.literal(true),
    reason_code: z.literal('allowed'),
    context: z.strictObject({
      runtime: authorizedRuntimeSchema.optional(),
      supervision: supervisionPolicySchema.optional(),
      elevation: threadElevationSchema.nullable(),
      connection: connectionContextSchema.optional(),
      // Only the decision of thread.create.public_chat carries it, and always (see visitorContextSchema).
      visitor: visitorContextSchema.optional(),
    }),
  })
  .superRefine((value, ctx) => {
    if (value.targets.some((target) => !target.allowed))
      ctx.addIssue({
        code: 'custom',
        path: ['targets'],
        message: 'Um alvo negado impede allowed=true na mutação atômica',
      })
    if (value.principal.actor_type === 'aiagent' && value.operation.startsWith('delivery.')) {
      const runtime = value.context.runtime
      if (
        !runtime ||
        runtime.instance_agent_id !== value.principal.principal_id ||
        runtime.runtime_id !== value.principal.runtime_id
      )
        ctx.addIssue({
          code: 'custom',
          path: ['context', 'runtime'],
          message: 'Delivery exige binding da instância/runtime autenticados',
        })
    }
    if (value.operation.startsWith('thread.supervision.') && !value.context.supervision)
      ctx.addIssue({
        code: 'custom',
        path: ['context', 'supervision'],
        message: 'Decisão elevada precisa da política efetiva',
      })
    const ensuring =
      value.operation === publicChatThreadCreateOperation &&
      value.principal.actor_type === 'external'
    if (ensuring !== (value.context.visitor !== undefined))
      ctx.addIssue({
        code: 'custom',
        path: ['context', 'visitor'],
        message: 'Só a decisão de thread.create.public_chat do visitante traz o perfil, e sempre',
      })
  })
  .meta({ 'x-maestro-semantic': 'identity_allowed_authorization' })

export const deniedAuthorizationSchema = z.strictObject({
  ...decisionFields,
  allowed: z.literal(false),
  reason_code: identityReasonSchema,
})
export const authorizeResponseSchema = z.union([
  allowedAuthorizationSchema,
  deniedAuthorizationSchema,
])

/** Envelope de conformidade/adapter: correla resposta com introspecção e request; não é uma rota extra. */
export const authorizationExchangeSchema = z
  .strictObject({
    evaluated_at: timestampSchema,
    introspection: activeIntrospectionSchema,
    request: authorizeRequestSchema,
    response: authorizeResponseSchema,
  })
  .superRefine((value, ctx) => {
    const { introspection, request, response } = value
    const reject = (message: string) => ctx.addIssue({ code: 'custom', message })
    const sameScope = (a: z.infer<typeof scopeSchema>, b: z.infer<typeof scopeSchema>) =>
      a.organization_id === b.organization_id &&
      a.workspace_id === b.workspace_id &&
      a.scope_kind === b.scope_kind
    if (
      request.token_ref !== introspection.token_ref ||
      response.token_ref !== introspection.token_ref
    )
      reject('Decisão deve referenciar a mesma introspecção')
    if (
      response.principal.actor_type !== introspection.principal.actor_type ||
      response.principal.principal_id !== introspection.principal.principal_id
    )
      reject('Decisão deve manter principal introspectado')
    if (
      response.request_id !== request.request_id ||
      response.thread_id !== request.thread_id ||
      response.operation !== request.operation ||
      !sameScope(response.scope, request.scope)
    )
      reject('Decisão deve corresponder ao request, thread, operação e escopo solicitados')
    const resourceKeys = [
      'event_id',
      'root_event_id',
      'artifact_id',
      'interaction_id',
      'delivery_id',
      'execution_id',
    ] as const
    if (resourceKeys.some((key) => response.resource?.[key] !== request.resource?.[key]))
      reject('Decisão deve manter os bindings do recurso solicitado')
    const targetKey = (target: z.infer<typeof authorizationTargetSchema>) =>
      `${target.kind}:${targetIdentity(target)}:${target.kind === 'agent' ? target.runtime_id : ''}`
    if (
      response.targets.length !== request.targets.length ||
      new Set(response.targets.map((target) => targetKey(target.target))).size !==
        request.targets.length ||
      request.targets.some(
        (target) =>
          !response.targets.some((result) => targetKey(result.target) === targetKey(target))
      )
    )
      reject('Decisão deve cobrir cada alvo exatamente uma vez')
    if (!response.allowed) return
    if (!sameScope(introspection.scope, request.scope))
      reject('Autorização não pode ampliar organização/workspace do token')
    if (response.authorization_version !== introspection.authorization_version)
      reject('Reintrospectar quando a versão de autorização mudar')
    const now = Date.parse(value.evaluated_at)
    if (now < Date.parse(introspection.issued_at) || now >= Date.parse(introspection.expires_at))
      reject('Introspecção precisa estar vigente')
    if (
      Date.parse(response.valid_until) <= now ||
      Date.parse(response.valid_until) >
        Math.min(Date.parse(introspection.expires_at), now + 60_000)
    )
      reject('Decisão deve vencer em até 60s e antes do token')
    const actor = introspection.principal.actor_type
    let required = authorizationScopeRules[request.operation]
    if (request.operation === 'delivery.complete' && request.writes_output)
      required = [...required, 'responses:write']
    const agentArtifacts = ['artifact.upload', 'artifact.complete', 'artifact.link']
    if (actor === 'external') {
      // Deny by default: only the listed operations, with the one external scope.
      if (!(externalOperations as readonly string[]).includes(request.operation))
        reject('Operação não permitida ao principal external')
      required = [...externalScopes]
      const visitor = introspection.principal
      // The decision must name the same visitor (not only the same subject): link, agent and connection type.
      const decided = response.principal
      if (
        decided.actor_type !== 'external' ||
        externalIdentityKeys.some((key) => decided[key] !== visitor[key])
      )
        reject('Decisão deve manter o principal external introspectado')
      const ownTarget = (target: z.infer<typeof authorizationTargetSchema>) =>
        target.kind === 'external'
          ? target.channel === visitor.channel && target.external_id === visitor.external_id
          : target.kind === 'agent' && target.principal_id === visitor.instance_agent_id
      if (
        request.targets.length > 0 &&
        (request.operation !== publicChatThreadCreateOperation || !request.targets.every(ownTarget))
      )
        reject('Principal external só tem como alvo o próprio visitante e o agente do link')
      // The profile of the visitor answers the ensure operation: the person is the visitor, and a guest
      // carries the guest roles only (no name, e-mail or identity_ids).
      const profile = response.context.visitor
      if (profile) {
        if (profile.person.principal_id !== visitor.external_id)
          reject('Perfil do visitante deve descrever o próprio visitante')
        const guestRoles = ['system_role', 'organization_role', 'workspace_role'] as const
        const asGuest =
          profile.person.name === '' &&
          profile.person.email === '' &&
          profile.person.identity_ids.length === 0 &&
          guestRoles.every((role) => profile.person[role] === 'guest')
        if (
          visitor.connection_type === 'guest'
            ? !asGuest
            : guestRoles.some((role) => profile.person[role] === 'guest')
        )
          reject('Perfil do visitante deve corresponder ao connection_type')
      }
    } else if (actor === 'aiagent') {
      if (agentArtifacts.includes(request.operation)) required = ['responses:write']
      else if (['artifact.read', 'artifact.download'].includes(request.operation))
        required = ['deliveries:read', 'context:read']
      else if ((agentManagedOperations as readonly string[]).includes(request.operation))
        required = ['threads:manage']
      else if (!request.operation.startsWith('delivery.'))
        reject('Operação humana não pode ser autorizada ao agente')
    } else if (request.operation.startsWith('delivery.'))
      reject('Operação de delivery não pode ser autorizada a humano')
    else if ((agentOnlyOperations as readonly string[]).includes(request.operation))
      reject('Operação exclusiva do agente não pode ser autorizada a humano')
    else if (request.operation === publicChatThreadCreateOperation)
      reject('Operação exclusiva do principal external não pode ser autorizada a humano')
    if (actor === 'human' && request.targets.some((target) => target.kind === 'external'))
      reject('Somente o agente pode ter participante external como alvo')
    const scopes: readonly string[] = introspection.scopes
    if (!required.every((scope) => scopes.includes(scope)))
      reject('Scopes insuficientes para operação')
    if (actor === 'aiagent') {
      const runtime = response.context.runtime
      if (
        !runtime ||
        runtime.instance_agent_id !== introspection.principal.principal_id ||
        runtime.runtime_id !== introspection.principal.runtime_id
      )
        reject('Operação de agente exige runtime canônico autorizado')
      if (request.runtime_id && request.runtime_id !== runtime?.runtime_id)
        reject('Runtime solicitado difere da decisão')
    }
    if (response.context.visitor && actor !== 'external')
      reject('Somente o visitante recebe o perfil do visitante')
    if (request.include_connection && actor !== 'aiagent')
      reject('Somente o agente pede o contexto de conexão')
    if (response.context.connection && !request.include_connection)
      reject('Contexto de conexão só volta quando foi pedido')
    if (request.include_connection && !response.context.connection)
      reject('Decisão permitida deve trazer o contexto de conexão pedido')
    if (response.context.connection) {
      const people = new Set(
        (request.membership_context?.participants ?? []).flatMap((p) =>
          p.target.kind === 'human' ? [p.target.principal_id] : []
        )
      )
      const added = new Set(
        request.targets.flatMap((t) => (t.kind === 'human' ? [t.principal_id] : []))
      )
      if (
        response.context.connection.humans.some(
          (human) => !people.has(human.principal_id) && !added.has(human.principal_id)
        )
      )
        reject('Contexto de conexão só descreve pessoas do conjunto avaliado')
    }
    if (request.operation.startsWith('thread.supervision.')) {
      const policy = response.context.supervision
      if (policy) {
        const requiredReason =
          policy.mode === 'strict' ||
          (policy.mode === 'operational' && request.scope.scope_kind === 'personal')
        if (policy.reason_required !== requiredReason)
          reject('Obrigatoriedade de motivo deve corresponder à política/escopo')
        if (requiredReason && !request.supervision?.access_reason)
          reject('Política exige motivo antes da leitura elevada')
      }
    }
  })
  .meta({ 'x-maestro-semantic': 'identity_authorization_exchange' })

export const candidatesRequestSchema = z.strictObject({
  ...scopeFields,
  kind: z.enum(['human', 'agent']),
  q: z.string().max(200).optional(),
  cursor: cursorSchema.optional(),
  limit: z.number().int().min(1).max(100).optional(),
  scopes: humanScopesSchema,
})
const candidateFields = {
  display_name: displayNameSchema,
  avatar_url: z
    .url({ protocol: /^https$/ })
    .regex(/^https:\/\//)
    .meta({ format: 'uri' })
    .optional(),
  eligible: z.boolean(),
  reason_code: identityReasonSchema.optional(),
}
export const humanCandidateSchema = z.strictObject({
  ...candidateFields,
  kind: z.literal('human'),
  principal_id: opaquePrincipalSchema,
  scopes: uniqueScopes(humanScopeSchema, 0),
})
export const agentCandidateSchema = z
  .strictObject({
    ...candidateFields,
    kind: z.literal('agent'),
    principal_id: uuidSchema,
    scopes: uniqueScopes(agentScopeSchema, 0),
    thread_management: z.enum(['agent', 'maestro']),
    maestro_protocol_version: z.literal(1).nullable(),
    capabilities: capabilitiesSchema,
    availability: z.enum(['available', 'unavailable', 'unknown']),
  })
  .superRefine((value, ctx) => {
    if (
      value.eligible &&
      (value.thread_management !== 'maestro' ||
        value.maestro_protocol_version !== 1 ||
        value.availability !== 'available' ||
        !requiredRuntimeCapabilities.every((capability) => value.capabilities.includes(capability)))
    )
      ctx.addIssue({
        code: 'custom',
        path: ['eligible'],
        message: 'Agente elegível exige runtime Maestro utilizável e capacidades mínimas',
      })
  })
  .meta({ 'x-maestro-semantic': 'identity_agent_candidate' })

export const candidateSchema = z
  .union([humanCandidateSchema, agentCandidateSchema])
  .superRefine((value, ctx) => {
    if (value.eligible && value.reason_code)
      ctx.addIssue({
        code: 'custom',
        path: ['reason_code'],
        message: 'Candidato elegível não pode carregar motivo de negação',
      })
  })
  .meta({ 'x-maestro-semantic': 'identity_candidate_reason' })

export const candidatesResponseSchema = z
  .strictObject({
    items: z.array(candidateSchema).max(100),
    next_cursor: cursorSchema.nullable(),
    has_more: z.boolean(),
  })
  .superRefine((value, ctx) => {
    if (value.has_more !== (value.next_cursor !== null))
      ctx.addIssue({
        code: 'custom',
        path: ['next_cursor'],
        message: 'Cursor deve indicar continuação sem truncamento silencioso',
      })
  })
  .meta({ 'x-maestro-semantic': 'identity_candidates_page' })

export const supervisionGrantSchema = z
  .strictObject({
    supervision_grant_id: referenceSchema,
    access_mode: z.literal('supervision'),
    principal_id: opaquePrincipalSchema,
    scope: scopeSchema,
    thread_id: uuidSchema,
    session_ref: referenceSchema,
    session_version: versionSchema,
    authorization_version: versionSchema,
    policy_version: versionSchema,
    audit_id: uuidSchema,
    allowed_actions: uniqueScopes(z.enum(['read', 'subscribe', 'export', 'download'])),
    issued_at: timestampSchema,
    expires_at: timestampSchema,
  })
  .superRefine((value, ctx) => {
    const ttl = Date.parse(value.expires_at) - Date.parse(value.issued_at)
    if (ttl <= 0 || ttl > 60_000)
      ctx.addIssue({
        code: 'custom',
        path: ['expires_at'],
        message: 'Grant exige reautorização/auditoria em até 60s',
      })
  })
  .meta({ 'x-maestro-semantic': 'identity_supervision_grant' })

export const identitySchemas: Record<string, z.ZodType> = {
  'Identity.HumanTokenRequest': humanTokenRequestSchema,
  'Identity.AgentTokenRequest': agentTokenRequestSchema,
  'Identity.HumanTokenClaims': humanTokenClaimsSchema,
  'Identity.AgentTokenClaims': agentTokenClaimsSchema,
  'Identity.ExternalTokenClaims': externalTokenClaimsSchema,
  'Identity.TokenClaims': tokenClaimsSchema,
  'Identity.ExternalTokenRequest': externalTokenRequestSchema,
  'Identity.ExternalTokenResponse': externalTokenResponseSchema,
  'Identity.HumanTokenResponse': humanTokenResponseSchema,
  'Identity.AgentTokenResponse': agentTokenResponseSchema,
  'Identity.IntrospectRequest': introspectRequestSchema,
  'Identity.IntrospectResponse': introspectResponseSchema,
  'Identity.AuthorizeRequest': authorizeRequestSchema,
  'Identity.AuthorizeResponse': authorizeResponseSchema,
  'Identity.ConnectionContext': connectionContextSchema,
  'Identity.VisitorContext': visitorContextSchema,
  'Identity.AuthorizationExchange': authorizationExchangeSchema,
  'Identity.CandidatesRequest': candidatesRequestSchema,
  'Identity.CandidatesResponse': candidatesResponseSchema,
  'Identity.Candidate': candidateSchema,
  'Identity.AuthorizedRuntime': authorizedRuntimeSchema,
  'Identity.SupervisionGrant': supervisionGrantSchema,
}
