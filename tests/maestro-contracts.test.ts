import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import {
  compareMaestroSequences,
  createMaestroConnectCommand,
  hasMaestroCapability,
  MaestroContractError,
  maestroPublicSchemas,
  parseMaestroCursor,
  toMaestroConnectAck,
  toMaestroError,
  toMaestroEvent,
  toMaestroEventPage,
  toMaestroParticipant,
  toMaestroParticipantPage,
  toMaestroPersistedResponse,
  toMaestroThread,
  toMaestroThreadPage,
  validateMaestroContract,
} from '../src/protocol/maestro/contracts'

interface Fixture {
  id: string
  schema: string
  valid: boolean
  data: unknown
}
const readFixtures = (path: string): Fixture[] => JSON.parse(readFileSync(path, 'utf8')).cases
const fixtures = [
  ...readFixtures('vendor/maestro-v1/contracts/fixtures/v1/public.json'),
  ...readFixtures('vendor/maestro-v1/contracts/fixtures/v1/public-publication.json'),
  ...readFixtures('vendor/maestro-v1/contracts/harness/boundary-fixtures.json').filter((c) =>
    c.schema.startsWith('Public.')
  ),
  ...readFixtures('tests/fixtures/maestro-consumer.json'),
]
const fixture = (schema: string) => fixtures.find((c) => c.schema === schema && c.valid)!.data
const consumerFixture = (id: string) => fixtures.find((c) => c.id === `consumer.${id}`)!.data

// Expected digest is shared with the service consumer test, independent of SDK parser output.
const expectedClassificationDigest =
  'ecb00e5770929bd05d87266fa8d7b722e35a989efb1716210252a9b11e491c18'

describe('Maestro v1 pinned contract consumer', () => {
  it('verifies exact source bytes and dependency pin', () => {
    expect(() =>
      execFileSync(process.execPath, ['scripts/maestro-contracts-check.mjs'])
    ).not.toThrow()
  })
  it.each([
    'empty-inventory',
    'missing-entry',
    'runtime-bytes',
    'fixture-bytes',
    'source-mapping',
    'dependency-version',
  ])('rejects %s before contract code executes', (mutation) => {
    const temp = mkdtempSync(join(tmpdir(), 'maestro-consumer-integrity-'))
    const manifestPath = 'vendor/maestro-v1/consumer-manifest.json'
    const consumer = JSON.parse(readFileSync(manifestPath, 'utf8'))
    try {
      for (const file of [
        ...Object.keys(consumer.files),
        manifestPath,
        'scripts/maestro-contracts-check.mjs',
        'package.json',
        'package-lock.json',
      ]) {
        mkdirSync(dirname(join(temp, file)), { recursive: true })
        copyFileSync(file, join(temp, file))
      }
      execFileSync(process.execPath, ['scripts/maestro-contracts-check.mjs'], {
        cwd: temp,
        stdio: 'pipe',
      })
      if (mutation === 'empty-inventory') consumer.files = {}
      if (mutation === 'missing-entry')
        delete consumer.files['src/protocol/maestro/vendor/public.ts']
      if (mutation === 'source-mapping')
        consumer.files['src/protocol/maestro/vendor/public.ts'].source = 'docs/contracts/v1/common.ts'
      writeFileSync(join(temp, manifestPath), JSON.stringify(consumer))
      if (mutation === 'runtime-bytes')
        writeFileSync(
          join(temp, 'src/protocol/maestro/vendor/public.ts'),
          'throw new Error("untrusted source must not execute")'
        )
      if (mutation === 'fixture-bytes')
        writeFileSync(
          join(temp, 'vendor/maestro-v1/contracts/fixtures/v1/public.json'),
          '{"cases":[]}'
        )
      if (mutation === 'dependency-version') {
        const pkg = JSON.parse(readFileSync(join(temp, 'package.json'), 'utf8'))
        pkg.dependencies.zod = '^4.4.3'
        writeFileSync(join(temp, 'package.json'), JSON.stringify(pkg))
      }
      expect(() =>
        execFileSync(process.execPath, ['scripts/maestro-contracts-check.mjs'], {
          cwd: temp,
          stdio: 'pipe',
        })
      ).toThrow()
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })
  it.each(fixtures)('$id', ({ schema, data, valid }) => {
    expect(validateMaestroContract(schema, data)).toBe(valid)
  })
  it('classifies the same ordered cases as the service consumer', () => {
    const result = fixtures.map((c) => [c.id, c.schema, validateMaestroContract(c.schema, c.data)])
    expect(createHash('sha256').update(JSON.stringify(result)).digest('hex')).toBe(
      expectedClassificationDigest
    )
    expect(new Set(fixtures.map((c) => c.id)).size).toBe(fixtures.length)
    expect(Object.keys(maestroPublicSchemas)).toHaveLength(107)
  })
  it('rejects unregistered schema names including inherited object properties', () => {
    expect(validateMaestroContract('toString', {})).toBe(false)
    expect(validateMaestroContract('Public.Future', {})).toBe(false)
  })
})

describe('Maestro public conversion boundaries', () => {
  it('creates connect without mode or credential in a URL', () => {
    const frame = createMaestroConnectCommand({
      requestId: '00000000-0000-4000-8000-000000000011',
      authToken: 'synthetic-only',
    })
    expect(frame.payload).toEqual({
      auth_token: 'synthetic-only',
      protocol_version: 1,
      client_capabilities: [],
    })
    expect(validateMaestroContract('Public.WsCommand.connect', frame)).toBe(true)
  })
  it('validates history authority and preserves advertised capabilities only', () => {
    const ack = toMaestroConnectAck(consumerFixture('ack-maestro-authority'))
    expect(ack.historyAuthority).toBe('maestro')
    expect(ack.capabilities).toEqual([])
    expect(hasMaestroCapability(ack.capabilities, 'messages.text')).toBe(false)
    expect(hasMaestroCapability(undefined, 'stream.delta')).toBe(false)
    expect(hasMaestroCapability(['future.extra'], 'messages.text')).toBe(false)
    expect(hasMaestroCapability(['messages.text'], 'messages.text')).toBe(true)
    expect(() => toMaestroConnectAck(consumerFixture('ack-agent-authority-rejected'))).toThrow(
      MaestroContractError
    )
    expect(() => toMaestroConnectAck(consumerFixture('ack-missing-authority-rejected'))).toThrow(
      MaestroContractError
    )
  })
  it('conserves event identity, opaque human author, payload and exact sequence', () => {
    const wire = maestroPublicSchemas['Public.Event'].parse(
      consumerFixture('sequence-above-safe-integer')
    )
    const event = toMaestroEvent(wire)
    expect(event.eventId).toBe(wire.event_id)
    expect(event.threadId).toBe(wire.thread_id)
    expect(event.sequence).toBe('900719925474099312345678901234567890')
    expect(event.actor.principalId).toBe(wire.actor.principal_id)
    expect(event.actor.participantId).toBe(wire.actor.participant_id)
    expect(event.payload).toEqual(wire.payload)
    expect(event.causationEventId).toBe(wire.causation_event_id)
    expect(event.rootEventId).toBe(wire.root_event_id)
    expect(event.createdAt).toBe(wire.created_at)
    expect(() => JSON.stringify(event)).not.toThrow()
    expect(() => toMaestroEvent(consumerFixture('sequence-numeric-rejected'))).toThrow(
      MaestroContractError
    )
  })
  it.each(
    fixtures.filter((c) => c.valid && c.schema.startsWith('Public.Event.'))
  )('preserves discriminated payload for $schema', (c) => {
    const wire = maestroPublicSchemas['Public.Event'].parse(c.data)
    const converted = toMaestroEvent(c.data)
    expect(converted.type).toBe(wire.type)
    expect(converted.payload).toEqual(wire.payload)
    expect(converted.eventId).toBe(wire.event_id)
  })
  it('keeps agent instance and participant identity distinct, without a singular thread agent', () => {
    const wire = maestroPublicSchemas['Public.Thread'].parse(fixture('Public.Thread'))
    const thread = toMaestroThread(wire)
    expect(thread.participants).toEqual(wire.participants.map(toMaestroParticipant))
    expect(thread.permissions).toEqual(wire.permissions)
    expect(thread.capabilities).toEqual(wire.capabilities)
    expect(thread.cursor).toBe(wire.cursor)
    expect(thread).not.toHaveProperty('agentId')
    expect(thread.organizationId).toBe(wire.organization_id)
    expect(thread.workspaceId).toBe(wire.workspace_id)
    const agent = maestroPublicSchemas['Public.Participant'].parse({
      ...wire.participants[0],
      kind: 'agent',
      role: 'member',
      principal_id: '00000000-0000-4000-8000-000000000007',
      instance_agent_id: '00000000-0000-4000-8000-000000000007',
      capabilities: [],
      availability: 'unknown',
    })
    if (agent.kind !== 'agent') throw new Error('Expected agent fixture')
    expect(toMaestroParticipant(agent)).toMatchObject({
      kind: 'agent',
      participantId: agent.participant_id,
      instanceAgentId: agent.instance_agent_id,
    })
  })
  it('preserves persisted receipt without inferring commit, broker receipt or a new operation key', () => {
    const wire = maestroPublicSchemas['Public.PersistedResponse'].parse(
      fixture('Public.PersistedResponse')
    )
    expect(toMaestroPersistedResponse(wire)).toEqual({
      status: 'persisted',
      event: toMaestroEvent(wire.event),
      cursor: wire.cursor,
      duplicate: wire.duplicate,
    })
  })
  it('preserves opaque cursors and pagination metadata across all supported pages', () => {
    const page = toMaestroEventPage(consumerFixture('opaque-cursor-preserved'))
    expect(page.nextCursor).toBe('opaque.v1:nao-decodificar/+=💬')
    expect(page.hasMore).toBe(true)
    expect(page.watermark).toBe('900719925474099312345')
    expect(parseMaestroCursor(page.nextCursor)).toBe(page.nextCursor)
    expect(() => parseMaestroCursor(1)).toThrow(MaestroContractError)
    for (const [schema, convert] of [
      ['Public.ThreadPage', toMaestroThreadPage],
      ['Public.ParticipantPage', toMaestroParticipantPage],
    ] as const) {
      const wire = maestroPublicSchemas[schema].parse(fixture(schema))
      const converted = convert(wire)
      expect(converted.nextCursor).toBe(wire.next_cursor)
      expect(converted.watermark).toBe(wire.watermark)
      expect(converted.hasMore).toBe(wire.has_more)
      expect(converted.items).toHaveLength(wire.items.length)
    }
  })
  it('retains structured error code, request and retryability without raw parse data', () => {
    const wire = maestroPublicSchemas['Public.Error'].parse(
      consumerFixture('error-non-retryable-preserved')
    )
    expect(toMaestroError(wire)).toMatchObject({
      code: wire.error.code,
      message: wire.error.message,
      requestId: wire.error.request_id,
      retryable: false,
    })
    const secret = 'never-print-this-token'
    try {
      createMaestroConnectCommand({ requestId: secret, authToken: secret })
      throw new Error('expected invalid request')
    } catch (error) {
      expect(error).toBeInstanceOf(MaestroContractError)
      expect(JSON.stringify(error)).not.toContain(secret)
      expect(String(error)).not.toContain(secret)
    }
  })
  it.each([
    ['9', '10', -1],
    ['10', '9', 1],
    ['9007199254740992', '9007199254740993', -1],
    ['9007199254740993', '9007199254740992', 1],
    ['0', '0', 0],
    ['100000000000000000000', '100000000000000000000', 0],
  ] as const)('compares %s and %s exactly', (left, right, expected) => {
    expect(compareMaestroSequences(left, right)).toBe(expected)
  })
  it.each(['01', '-1', '1.0', '1e2', '', ' 1'])('rejects noncanonical sequence %s', (invalid) => {
    expect(() => compareMaestroSequences(invalid, '1')).toThrow(MaestroContractError)
  })
})
