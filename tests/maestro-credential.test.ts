import { afterEach, describe, expect, it, vi } from 'vitest'
import { inspectMaestroHumanCredential } from '../src/maestro/credential'
import { MaestroClient } from '../src/maestro/client'
import { credential, visitorCredential, visitorExternalId, visitorLink, visitorPrincipalId } from './fixtures/maestro-credential'
import corpus from './fixtures/maestro-human-claims.json'
const org = '00000000-0000-4000-8000-000000000001'
const other = '00000000-0000-4000-8000-000000000002'
const scope = { principalId: 'human', organizationId: org, workspaceId: null }
const encode = (value: unknown) => btoa(JSON.stringify(value)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
const token = (claims: unknown, header = { alg: 'RS256', typ: 'maestro-access+jwt', kid: 'synthetic' }) => `${encode(header)}.${encode(claims)}.c3ludGhldGlj`
const config = { mode: 'maestro' as const, endpoint: 'https://maestro.example', transport: 'http' as const, scope, authToken: credential(scope.principalId, org), maxReconnectAttempts: 0 }
const caps = () => new Response(JSON.stringify({ protocol_version: 1, schema_version: 1, server_version: '0.0.0', history_authority: 'maestro', capabilities: ['messages.text'] }), { headers: { 'content-type': 'application/json' } })
const clients: MaestroClient[] = []
afterEach(() => { clients.forEach(client => client.dispose()); clients.length = 0; vi.useRealTimers() })
describe('human credential binding filter', () => {
  it.each(corpus.cases)('canonical fixture $id', fixture => {
    const claims = fixture.data as Record<string, unknown>
    const target = { principalId: String(claims.sub), organizationId: String(claims.organization_id), workspaceId: claims.workspace_id as string | null }
    if (fixture.valid && claims.actor_type === 'human') expect(inspectMaestroHumanCredential(token(claims), target, Number(claims.iat) * 1000 + 1000)).toBe(Number(claims.exp) * 1000)
    else expect(() => inspectMaestroHumanCredential(token(claims), target, Number(claims.iat) * 1000 + 1000)).toThrow()
  })
  it.each([
    { sub: 'other', user_id: 'other' }, { user_id: 'other' }, { organization_id: other }, { workspace_id: other },
    { actor_type: 'aiagent' }, { iss: 'legacy' }, { aud: 'legacy' }, { exp: 1 }, { iat: Math.floor(Date.now() / 1000) + 30 },
    { session_version: 0 }, { credential_version: 0 }, { runtime_id: null }, { scopes: ['context:read'] }, { scopes: [] }, { scopes: ['messages:write', 'messages:write'] }, { extra: true },
  ])('rejects claims mismatch %j', claims => expect(() => inspectMaestroHumanCredential(credential('human', org, claims), scope)).toThrow())
  it.each([{ alg: 'none', typ: 'maestro-access+jwt', kid: 'x' }, { alg: 'RS256', typ: 'JWT', kid: 'x' }, { alg: 'HS256', typ: 'maestro-access+jwt', kid: 'x' }])('rejects wrong header %j', header => {
    const claims = JSON.parse(atob(credential('human', org).split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/')))
    expect(() => inspectMaestroHumanCredential(token(claims, header), scope)).toThrow()
  })
  it('rejects duplicate and escaped aliases in shallow JSON', () => {
    const original = credential('human', org)
    const [header, body, signature] = original.split('.')
    const raw = atob(body!.replace(/-/g, '+').replace(/_/g, '/')).replace('{', '{"\\u0073ub":"attacker",')
    const duplicate = `${header}.${btoa(raw).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')}.${signature}`
    expect(() => inspectMaestroHumanCredential(duplicate, scope)).toThrow()
  })
  it.each(['principal', 'organization', 'workspace', 'machine'])('rejects %s changes before HTTP connect and refresh', async change => {
    const claims = change === 'principal' ? { sub: 'another', user_id: 'another' } : change === 'organization' ? { organization_id: other } : change === 'workspace' ? { workspace_id: other } : { actor_type: 'aiagent' }
    const fetcher = vi.fn(async () => caps())
    const denied = new MaestroClient({ ...config, authToken: credential('human', org, claims), fetch: fetcher }); clients.push(denied)
    await expect(denied.connect()).rejects.toMatchObject({ code: 'UNAUTHENTICATED' }); expect(fetcher).not.toHaveBeenCalled()
    const client = new MaestroClient({ ...config, authToken: credential('human', org), fetch: fetcher }); clients.push(client); await client.connect()
    await expect(client.refreshAuth(credential('human', org, claims))).rejects.toMatchObject({ code: 'UNAUTHENTICATED' }); expect(fetcher).toHaveBeenCalledTimes(1); expect(client.getConnection().status).toBe('unauthenticated')
  })
  it('still requires remote authentication after valid local claim inspection', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: 'Unverified signature', request_id: other, retryable: false } }), { status: 401, headers: { 'content-type': 'application/json' } }))
    const client = new MaestroClient({ ...config, authToken: credential('human', org), fetch: fetcher }); clients.push(client)
    await expect(client.connect()).rejects.toMatchObject({ code: 'UNAUTHENTICATED' }); expect(fetcher).toHaveBeenCalledOnce(); expect(client.getConnection().status).toBe('unauthenticated')
  })
})

describe('public chat visitor credential (external)', () => {
  const visitor = { principalId: visitorPrincipalId, organizationId: org, workspaceId: null, actorType: 'external' as const }
  const strip = (claims: Record<string, unknown>) => ({ ...claims })
  it('accepts an external token whose sub is the visitor id of the exchange', () => {
    const exp = inspectMaestroHumanCredential(visitorCredential(org), visitor)
    expect(exp).toBeGreaterThan(Date.now())
  })
  it('accepts public_authenticated and the optional message rate', () => {
    const principal = `public_chat:${visitorLink}:user-123`
    const claims = { sub: principal, external_id: 'user-123', connection_type: 'public_authenticated', rate_limit_msgs_per_min: 20 }
    expect(() => inspectMaestroHumanCredential(visitorCredential(org, claims), { ...visitor, principalId: principal })).not.toThrow()
  })
  it.each([
    ['sub differs from the visitor id of the exchange', { sub: `public_chat:${visitorLink}:guest:BBBBBBBBBBBBBBBBBBBBBB` }],
    ['sub without the link namespace', { sub: visitorExternalId }],
    ['another organization', { organization_id: other }],
    ['workspace set', { workspace_id: other }],
    ['a human scope', { scopes: ['threads:read'] }],
    ['an extra scope', { scopes: ['public_chat:converse', 'messages:write'] }],
    ['duplicate scope', { scopes: ['public_chat:converse', 'public_chat:converse'] }],
    ['no scopes', { scopes: [] }],
    ['another channel', { channel: 'whatsapp' }],
    ['guest id with the wrong format', { sub: `public_chat:${visitorLink}:guest:short`, external_id: 'guest:short' }],
    ['public_authenticated claiming the guest prefix', { connection_type: 'public_authenticated' }],
    ['human actor type', { actor_type: 'human' }],
    ['unknown claim', { user_id: visitorPrincipalId }],
    ['too long lifetime', { exp: Math.floor(Date.now() / 1000) + 600 }],
    ['expired', { iat: Math.floor(Date.now() / 1000) - 400, exp: Math.floor(Date.now() / 1000) - 100 }],
    ['wrong issuer', { iss: 'legacy' }],
    ['instance agent not a uuid', { instance_agent_id: 'agent' }],
    ['rate limit zero', { rate_limit_msgs_per_min: 0 }],
  ])('rejects %s', (_label, claims) => {
    expect(() => inspectMaestroHumanCredential(visitorCredential(org, strip(claims)), visitor)).toThrow()
  })
  it('a human scope refuses the external token and an external scope refuses a human token', () => {
    expect(() => inspectMaestroHumanCredential(visitorCredential(org), { ...scope, principalId: visitorPrincipalId })).toThrow()
    expect(() => inspectMaestroHumanCredential(credential('human', org), visitor)).toThrow()
  })
  it('the client checks sub against the visitor id before any request and on refresh', async () => {
    const fetcher = vi.fn(async () => caps())
    const wrong = new MaestroClient({ ...config, scope: visitor, authToken: visitorCredential(org, { sub: `public_chat:${visitorLink}:guest:BBBBBBBBBBBBBBBBBBBBBB` }), fetch: fetcher }); clients.push(wrong)
    await expect(wrong.connect()).rejects.toMatchObject({ code: 'UNAUTHENTICATED' }); expect(fetcher).not.toHaveBeenCalled()
    const client = new MaestroClient({ ...config, scope: visitor, authToken: visitorCredential(org), fetch: fetcher }); clients.push(client); await client.connect()
    expect(client.getConnection().status).toBe('connected')
    await expect(client.refreshAuth(visitorCredential(org, { sub: `public_chat:${visitorLink}:guest:BBBBBBBBBBBBBBBBBBBBBB` }))).rejects.toMatchObject({ code: 'UNAUTHENTICATED' })
    expect(client.getConnection().status).toBe('unauthenticated')
  })
  it('rejects an invalid actorType in the scope', () => {
    expect(() => new MaestroClient({ ...config, scope: { ...scope, actorType: 'agent' as never } })).toThrow()
  })
})
