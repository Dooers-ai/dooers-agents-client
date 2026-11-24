import { afterEach, describe, expect, it, vi } from 'vitest'
import { inspectDooersThreadsHumanCredential } from '../src/dooers-threads/credential'
import { DooersThreadsClient } from '../src/dooers-threads/client'
import { credential, visitorCredential, visitorExternalId, visitorLink, visitorPrincipalId } from './fixtures/dooers-threads-credential'
import corpus from './fixtures/dooers-threads-human-claims.json'
const org = '00000000-0000-4000-8000-000000000001'
const other = '00000000-0000-4000-8000-000000000002'
const scope = { principalId: 'human', organizationId: org, workspaceId: null }
const encode = (value: unknown) => btoa(JSON.stringify(value)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
const token = (claims: unknown, header = { alg: 'RS256', typ: 'dooers-threads-access+jwt', kid: 'synthetic' }) => `${encode(header)}.${encode(claims)}.c3ludGhldGlj`
const config = { mode: 'dooers_threads' as const, endpoint: 'https://dooers-threads.example', transport: 'http' as const, scope, authToken: credential(scope.principalId, org), maxReconnectAttempts: 0 }
const caps = () => new Response(JSON.stringify({ protocol_version: 1, schema_version: 1, server_version: '0.0.0', history_authority: 'dooers_threads', capabilities: ['messages.text'] }), { headers: { 'content-type': 'application/json' } })
const clients: DooersThreadsClient[] = []
afterEach(() => { clients.forEach(client => client.dispose()); clients.length = 0; vi.useRealTimers() })
describe('human credential binding filter', () => {
  it.each(corpus.cases)('canonical fixture $id', fixture => {
    const claims = fixture.data as Record<string, unknown>
    const target = { principalId: String(claims.sub), organizationId: String(claims.organization_id), workspaceId: claims.workspace_id as string | null }
    if (fixture.valid && claims.actor_type === 'human') expect(inspectDooersThreadsHumanCredential(token(claims), target, Number(claims.iat) * 1000 + 1000)).toBe(Number(claims.exp) * 1000)
    else expect(() => inspectDooersThreadsHumanCredential(token(claims), target, Number(claims.iat) * 1000 + 1000)).toThrow()
  })
  it.each([
    { sub: 'other', user_id: 'other' }, { user_id: 'other' }, { organization_id: other }, { workspace_id: other },
    { actor_type: 'aiagent' }, { iss: 'legacy' }, { aud: 'legacy' }, { exp: 1 }, { iat: Math.floor(Date.now() / 1000) + 30 },
    { session_version: 0 }, { credential_version: 0 }, { runtime_id: null }, { scopes: ['context:read'] }, { scopes: [] }, { scopes: ['messages:write', 'messages:write'] }, { extra: true },
  ])('rejects claims mismatch %j', claims => expect(() => inspectDooersThreadsHumanCredential(credential('human', org, claims), scope)).toThrow())
  it.each([{ alg: 'none', typ: 'dooers-threads-access+jwt', kid: 'x' }, { alg: 'RS256', typ: 'JWT', kid: 'x' }, { alg: 'HS256', typ: 'dooers-threads-access+jwt', kid: 'x' }])('rejects wrong header %j', header => {
    const claims = JSON.parse(atob(credential('human', org).split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/')))
    expect(() => inspectDooersThreadsHumanCredential(token(claims, header), scope)).toThrow()
  })
  it('rejects duplicate and escaped aliases in shallow JSON', () => {
    const original = credential('human', org)
    const [header, body, signature] = original.split('.')
    const raw = atob(body!.replace(/-/g, '+').replace(/_/g, '/')).replace('{', '{"\\u0073ub":"attacker",')
    const duplicate = `${header}.${btoa(raw).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')}.${signature}`
    expect(() => inspectDooersThreadsHumanCredential(duplicate, scope)).toThrow()
  })
  it.each(['principal', 'organization', 'workspace', 'machine'])('rejects %s changes before HTTP connect and refresh', async change => {
    const claims = change === 'principal' ? { sub: 'another', user_id: 'another' } : change === 'organization' ? { organization_id: other } : change === 'workspace' ? { workspace_id: other } : { actor_type: 'aiagent' }
    const fetcher = vi.fn(async () => caps())
    const denied = new DooersThreadsClient({ ...config, authToken: credential('human', org, claims), fetch: fetcher }); clients.push(denied)
    await expect(denied.connect()).rejects.toMatchObject({ code: 'UNAUTHENTICATED' }); expect(fetcher).not.toHaveBeenCalled()
    const client = new DooersThreadsClient({ ...config, authToken: credential('human', org), fetch: fetcher }); clients.push(client); await client.connect()
    await expect(client.refreshAuth(credential('human', org, claims))).rejects.toMatchObject({ code: 'UNAUTHENTICATED' }); expect(fetcher).toHaveBeenCalledTimes(1); expect(client.getConnection().status).toBe('unauthenticated')
  })
  it('still requires remote authentication after valid local claim inspection', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: 'Unverified signature', request_id: other, retryable: false } }), { status: 401, headers: { 'content-type': 'application/json' } }))
    const client = new DooersThreadsClient({ ...config, authToken: credential('human', org), fetch: fetcher }); clients.push(client)
    await expect(client.connect()).rejects.toMatchObject({ code: 'UNAUTHENTICATED' }); expect(fetcher).toHaveBeenCalledOnce(); expect(client.getConnection().status).toBe('unauthenticated')
  })
})

describe('public chat visitor credential (external)', () => {
  // A fixed clock half-way through a second: the test and the inspection read the same second.
  const pinClock = () => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-16T12:00:00.500Z')) }
  const visitor = { principalId: visitorPrincipalId, organizationId: org, workspaceId: null, actorType: 'external' as const }
  const strip = (claims: Record<string, unknown>) => ({ ...claims })
  it('accepts an external token whose sub is the visitor id of the exchange', () => {
    const exp = inspectDooersThreadsHumanCredential(visitorCredential(org), visitor)
    expect(exp).toBeGreaterThan(Date.now())
  })
  it('accepts public_authenticated and the optional message rate', () => {
    const principal = `public_chat:${visitorLink}:user-123`
    const claims = { sub: principal, external_id: 'user-123', connection_type: 'public_authenticated', rate_limit_msgs_per_min: 20 }
    expect(() => inspectDooersThreadsHumanCredential(visitorCredential(org, claims), { ...visitor, principalId: principal })).not.toThrow()
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
    expect(() => inspectDooersThreadsHumanCredential(visitorCredential(org, strip(claims)), visitor)).toThrow()
  })
  it('tolerates a visitor clock up to 60 s behind the issuer (iat in the future), but never a longer skew', () => {
    pinClock()
    const nowSeconds = Math.floor(Date.now() / 1000)
    const claims = (iat: number) => ({ iat, exp: iat + 300 })
    expect(() => inspectDooersThreadsHumanCredential(visitorCredential(org, claims(nowSeconds + 30)), visitor)).not.toThrow()
    expect(() => inspectDooersThreadsHumanCredential(visitorCredential(org, claims(nowSeconds + 60)), visitor)).not.toThrow()
    expect(() => inspectDooersThreadsHumanCredential(visitorCredential(org, claims(nowSeconds + 61)), visitor)).toThrow()
  })
  it('keeps the expiry strict for the visitor: a token past its exp is refused whatever the skew', () => {
    pinClock()
    const nowSeconds = Math.floor(Date.now() / 1000)
    expect(() => inspectDooersThreadsHumanCredential(visitorCredential(org, { iat: nowSeconds - 300, exp: nowSeconds }), visitor)).toThrow()
    expect(() => inspectDooersThreadsHumanCredential(visitorCredential(org, { iat: nowSeconds - 10, exp: nowSeconds - 1 }), visitor)).toThrow()
  })
  it('keeps the human token strict: iat in the future is refused without tolerance', () => {
    pinClock()
    const nowSeconds = Math.floor(Date.now() / 1000)
    expect(() => inspectDooersThreadsHumanCredential(credential('human', org, { iat: nowSeconds + 30, exp: nowSeconds + 330 }), scope)).toThrow()
  })
  it('a human scope refuses the external token and an external scope refuses a human token', () => {
    expect(() => inspectDooersThreadsHumanCredential(visitorCredential(org), { ...scope, principalId: visitorPrincipalId })).toThrow()
    expect(() => inspectDooersThreadsHumanCredential(credential('human', org), visitor)).toThrow()
  })
  it('the client checks sub against the visitor id before any request and on refresh', async () => {
    const fetcher = vi.fn(async () => caps())
    const wrong = new DooersThreadsClient({ ...config, scope: visitor, authToken: visitorCredential(org, { sub: `public_chat:${visitorLink}:guest:BBBBBBBBBBBBBBBBBBBBBB` }), fetch: fetcher }); clients.push(wrong)
    await expect(wrong.connect()).rejects.toMatchObject({ code: 'UNAUTHENTICATED' }); expect(fetcher).not.toHaveBeenCalled()
    const client = new DooersThreadsClient({ ...config, scope: visitor, authToken: visitorCredential(org), fetch: fetcher }); clients.push(client); await client.connect()
    expect(client.getConnection().status).toBe('connected')
    await expect(client.refreshAuth(visitorCredential(org, { sub: `public_chat:${visitorLink}:guest:BBBBBBBBBBBBBBBBBBBBBB` }))).rejects.toMatchObject({ code: 'UNAUTHENTICATED' })
    expect(client.getConnection().status).toBe('unauthenticated')
  })
  it('rejects an invalid actorType in the scope', () => {
    expect(() => new DooersThreadsClient({ ...config, scope: { ...scope, actorType: 'agent' as never } })).toThrow()
  })
})
