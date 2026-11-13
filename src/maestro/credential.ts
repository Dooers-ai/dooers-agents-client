import { opaquePrincipalSchema, uuidSchema } from '../protocol/maestro/vendor/common.js'
import { MaestroClientError, type MaestroScope } from './types.js'

const fields = new Set([
  'iss',
  'aud',
  'sub',
  'iat',
  'exp',
  'jti',
  'organization_id',
  'workspace_id',
  'actor_type',
  'user_id',
  'session_ref',
  'session_version',
  'scopes',
  'runtime_id',
  'credential_version',
])
// Public chat visitor token (Identity.ExternalTokenClaims). Mirrors the contract by hand: the identity
// schema is not part of the browser bundle.
const externalFields = new Set([
  'iss',
  'aud',
  'sub',
  'iat',
  'exp',
  'jti',
  'organization_id',
  'workspace_id',
  'actor_type',
  'external_id',
  'channel',
  'connection_type',
  'public_chat_link_id',
  'instance_agent_id',
  'session_ref',
  'session_version',
  'scopes',
  'rate_limit_msgs_per_min',
])
const externalScopes = new Set(['public_chat:converse'])
const guestExternalId = /^guest:[A-Za-z0-9_-]{22}$/
const humanScopes = new Set([
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
])
const fail = () => {
  throw new MaestroClientError(
    'UNAUTHENTICATED',
    'Maestro human credential does not match this session'
  )
}
const integer = (value: unknown, min: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min

function decode(segment: string): Record<string, unknown> {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) return fail()
  let binary: string
  try {
    binary = atob(segment.replace(/-/g, '+').replace(/_/g, '/'))
  } catch {
    return fail()
  }
  if (btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_') !== segment)
    return fail()
  const raw = new TextDecoder('utf-8', { fatal: true }).decode(
    Uint8Array.from(binary, (c) => c.charCodeAt(0))
  )
  // Token claims and headers are shallow. Reject duplicate keys (including
  // escaped aliases), nested objects, and non-string array entries before parse.
  const keys = new Set<string>()
  let index = 0
  let depth = 0
  while (index < raw.length) {
    const char = raw[index]
    if (char === '{') {
      if (++depth > 1) return fail()
      index++
      continue
    }
    if (char === '}') {
      depth--
      index++
      continue
    }
    if (char !== '"') {
      index++
      continue
    }
    const start = index++
    while (index < raw.length) {
      if (raw[index] === '\\') {
        index += 2
        continue
      }
      if (raw[index++] === '"') break
    }
    const literal = raw.slice(start, index)
    let next = index
    while (/\s/.test(raw[next] ?? '') && next < raw.length) next++
    if (raw[next] === ':') {
      const key: unknown = JSON.parse(literal)
      if (typeof key !== 'string' || keys.has(key)) return fail()
      keys.add(key)
    }
  }
  const value: unknown = JSON.parse(raw)
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail()
  return value as Record<string, unknown>
}

function inspectExternalClaims(
  claims: Record<string, unknown>,
  scope: Readonly<MaestroScope>,
  now: number
): number {
  if (
    Object.keys(claims).some((key) => !externalFields.has(key)) ||
    claims.iss !== 'dooers-service-core' ||
    claims.aud !== 'dooers-service-maestro' ||
    claims.actor_type !== 'external' ||
    typeof claims.external_id !== 'string' ||
    claims.external_id.length < 1 ||
    claims.external_id.length > 207 ||
    claims.channel !== 'public_chat' ||
    !uuidSchema.safeParse(claims.public_chat_link_id).success ||
    !uuidSchema.safeParse(claims.instance_agent_id).success ||
    (claims.connection_type !== 'guest' && claims.connection_type !== 'public_authenticated') ||
    (claims.connection_type === 'guest'
      ? !guestExternalId.test(claims.external_id)
      : claims.external_id.startsWith('guest:')) ||
    !opaquePrincipalSchema.safeParse(claims.sub).success ||
    // The subject is the namespaced visitor id and must be the one the token exchange returned.
    claims.sub !== `public_chat:${claims.public_chat_link_id}:${claims.external_id}` ||
    claims.sub !== scope.principalId ||
    !uuidSchema.safeParse(claims.organization_id).success ||
    claims.organization_id !== scope.organizationId ||
    claims.workspace_id !== scope.workspaceId ||
    (claims.workspace_id !== null && !uuidSchema.safeParse(claims.workspace_id).success) ||
    !uuidSchema.safeParse(claims.jti).success ||
    !opaquePrincipalSchema.safeParse(claims.session_ref).success ||
    !integer(claims.session_version, 1) ||
    !integer(claims.iat, 0) ||
    !integer(claims.exp, 0) ||
    claims.exp <= claims.iat ||
    claims.exp - claims.iat > 300 ||
    claims.iat > Math.floor(now / 1000) ||
    claims.exp <= Math.floor(now / 1000) ||
    !Array.isArray(claims.scopes) ||
    claims.scopes.length < 1 ||
    new Set(claims.scopes).size !== claims.scopes.length ||
    claims.scopes.some((item) => typeof item !== 'string' || !externalScopes.has(item)) ||
    (claims.rate_limit_msgs_per_min !== undefined &&
      (!integer(claims.rate_limit_msgs_per_min, 1) || claims.rate_limit_msgs_per_min > 100000))
  )
    return fail()
  return (claims.exp as number) * 1000
}

/**
 * Identity-confusion filter derived from Identity.HumanTokenClaims (or, for a scope with
 * `actorType: 'external'`, Identity.ExternalTokenClaims). This does NOT verify a signature, session,
 * grants or permissions. The authenticated /capabilities or WS connect/refresh remains mandatory on
 * every session.
 */
export function inspectMaestroHumanCredential(
  token: string,
  scope: Readonly<MaestroScope>,
  now = Date.now()
): number {
  try {
    if (token.length > 16384) return fail()
    const parts = token.split('.')
    if (
      parts.length !== 3 ||
      !parts[0] ||
      !parts[1] ||
      !parts[2] ||
      !/^[A-Za-z0-9_-]+$/.test(parts[2])
    )
      return fail()
    const header = decode(parts[0])
    if (
      Object.keys(header).some((key) => !['alg', 'typ', 'kid'].includes(key)) ||
      header.alg !== 'RS256' ||
      header.typ !== 'maestro-access+jwt' ||
      typeof header.kid !== 'string' ||
      !/^[A-Za-z0-9_.-]{1,128}$/.test(header.kid)
    )
      return fail()
    const claims = decode(parts[1])
    if (scope.actorType === 'external') return inspectExternalClaims(claims, scope, now)
    if (
      Object.keys(claims).some((key) => !fields.has(key)) ||
      claims.iss !== 'dooers-service-core' ||
      claims.aud !== 'dooers-service-maestro' ||
      claims.actor_type !== 'human' ||
      !opaquePrincipalSchema.safeParse(claims.sub).success ||
      claims.sub !== claims.user_id ||
      claims.sub !== scope.principalId ||
      !uuidSchema.safeParse(claims.organization_id).success ||
      claims.organization_id !== scope.organizationId ||
      claims.workspace_id !== scope.workspaceId ||
      (claims.workspace_id !== null && !uuidSchema.safeParse(claims.workspace_id).success) ||
      !uuidSchema.safeParse(claims.jti).success ||
      !opaquePrincipalSchema.safeParse(claims.session_ref).success ||
      !integer(claims.session_version, 1) ||
      !integer(claims.iat, 0) ||
      !integer(claims.exp, 0) ||
      claims.exp <= claims.iat ||
      claims.exp - claims.iat > 300 ||
      claims.iat > Math.floor(now / 1000) ||
      claims.exp <= Math.floor(now / 1000) ||
      !Array.isArray(claims.scopes) ||
      claims.scopes.length < 1 ||
      claims.scopes.length > 32 ||
      new Set(claims.scopes).size !== claims.scopes.length ||
      claims.scopes.some((item) => typeof item !== 'string' || !humanScopes.has(item)) ||
      (claims.runtime_id !== undefined && !uuidSchema.safeParse(claims.runtime_id).success) ||
      (claims.credential_version !== undefined && !integer(claims.credential_version, 1))
    )
      return fail()
    return claims.exp * 1000
  } catch {
    return fail()
  }
}
