export function credential(principalId: string, organizationId: string, options: Record<string, unknown> = {}, kid = 'synthetic') {
  const encode = (value: unknown) => btoa(JSON.stringify(value)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
  return `${encode({ alg: 'RS256', typ: 'dooers-threads-access+jwt', kid })}.${encode({ iss: 'dooers-service-core', aud: 'dooers-service-threads', sub: principalId, user_id: principalId, organization_id: organizationId, workspace_id: null, actor_type: 'human', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300, jti: '00000000-0000-4000-8000-000000000001', session_ref: 'synthetic-session', session_version: 1, scopes: ['threads:read', 'messages:write'], ...options })}.c3ludGhldGlj`
}

export const visitorLink = '00000000-0000-4000-8000-000000000060'
export const visitorInstanceAgent = '00000000-0000-4000-8000-000000000061'
export const visitorExternalId = 'guest:AAAAAAAAAAAAAAAAAAAAAA'
export const visitorPrincipalId = `public_chat:${visitorLink}:${visitorExternalId}`
/** Public chat visitor token (Identity.ExternalTokenClaims): `sub` is the namespaced visitor id. */
export function visitorCredential(organizationId: string, options: Record<string, unknown> = {}, kid = 'synthetic') {
  const encode = (value: unknown) => btoa(JSON.stringify(value)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
  return `${encode({ alg: 'RS256', typ: 'dooers-threads-access+jwt', kid })}.${encode({ iss: 'dooers-service-core', aud: 'dooers-service-threads', sub: visitorPrincipalId, organization_id: organizationId, workspace_id: null, actor_type: 'external', external_id: visitorExternalId, channel: 'public_chat', connection_type: 'guest', public_chat_link_id: visitorLink, instance_agent_id: visitorInstanceAgent, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300, jti: '00000000-0000-4000-8000-000000000001', session_ref: 'synthetic-session', session_version: 1, scopes: ['public_chat:converse'], ...options })}.c3ludGhldGlj`
}
