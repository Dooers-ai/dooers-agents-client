export function credential(principalId: string, organizationId: string, options: Record<string, unknown> = {}, kid = 'synthetic') {
  const encode = (value: unknown) => btoa(JSON.stringify(value)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
  return `${encode({ alg: 'RS256', typ: 'maestro-access+jwt', kid })}.${encode({ iss: 'dooers-service-core', aud: 'dooers-service-maestro', sub: principalId, user_id: principalId, organization_id: organizationId, workspace_id: null, actor_type: 'human', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300, jti: '00000000-0000-4000-8000-000000000001', session_ref: 'synthetic-session', session_version: 1, scopes: ['threads:read', 'messages:write'], ...options })}.c3ludGhldGlj`
}
