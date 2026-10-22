import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('../', import.meta.url))
const temp = mkdtempSync(path.join(os.tmpdir(), 'maestro-client-contract-package-'))
const read = (name) => JSON.parse(readFileSync(path.join(root, name), 'utf8'))
try {
  execFileSync(process.execPath, ['scripts/maestro-contracts-check.mjs'], { cwd: root })
  const [packed] = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temp], { cwd: root, encoding: 'utf8' }))
  assert(!packed.files.some(f => /(^|\/)(\.env|node_modules|tests|src)\//.test(f.path)))
  writeFileSync(path.join(temp, 'package.json'), JSON.stringify({ private: true, type: 'module' }))
  // An isolated, actual npm installation. No sibling imports, symlinks or network.
  const react = read('node_modules/react/package.json').version
  execFileSync('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', path.join(temp, packed.filename), `react@${react}`], { cwd: temp, stdio: 'pipe' })
  const cases = [
    ...read('vendor/maestro-v1/contracts/fixtures/v1/public.json').cases,
    ...read('vendor/maestro-v1/contracts/fixtures/v1/public-publication.json').cases,
    ...read('vendor/maestro-v1/contracts/harness/boundary-fixtures.json').cases.filter(c => c.schema.startsWith('Public.')),
    ...read('tests/fixtures/maestro-consumer.json').cases,
  ]
  writeFileSync(path.join(temp, 'fixtures.json'), JSON.stringify(cases))
  writeFileSync(path.join(temp, 'smoke.mjs'), `
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import * as esm from 'dooers-agents-client/maestro/contracts'
import * as legacy from 'dooers-agents-client'
const require = createRequire(import.meta.url)
const cjs = require('dooers-agents-client/maestro/contracts')
const legacyCjs = require('dooers-agents-client')
assert.equal(typeof legacy.AgentServerClient, 'function')
assert.equal(typeof legacyCjs.AgentServerClient, 'function')
const cases = JSON.parse(readFileSync(new URL('./fixtures.json', import.meta.url), 'utf8'))
for (const api of [esm, cjs]) {
  const result = cases.map(c => [c.id, c.schema, api.validateMaestroContract(c.schema,c.data)])
  assert.deepEqual(result.map(c => c[2]), cases.map(c => c.valid))
  assert.equal(createHash('sha256').update(JSON.stringify(result)).digest('hex'), 'ecb00e5770929bd05d87266fa8d7b722e35a989efb1716210252a9b11e491c18')
  assert.equal(api.compareMaestroSequences('9007199254740992','9007199254740993'), -1)
  const frame = api.createMaestroConnectCommand({requestId:'00000000-0000-4000-8000-000000000011',authToken:'synthetic'})
  assert.equal(Object.hasOwn(frame.payload,'mode'),false)
}
console.log(JSON.stringify({installed:true,esm:cases.length,cjs:cases.length,legacy:true}))
`)
  const smoke = JSON.parse(execFileSync(process.execPath, ['smoke.mjs'], { cwd: temp, encoding: 'utf8' }))
  writeFileSync(path.join(temp, 'consumer.ts'), `
import { createMaestroConnectCommand, toMaestroEvent, type MaestroEvent, type MaestroWireEvent } from 'dooers-agents-client/maestro/contracts'
import { AgentServerClient } from 'dooers-agents-client'
const frame = createMaestroConnectCommand({requestId:'id',authToken:'token'})
const version: 1 = frame.payload.protocol_version
const validate = (wire: MaestroWireEvent): MaestroEvent => toMaestroEvent(wire)
const render = (event: MaestroEvent) => event.type === 'message.created' ? event.payload.content : null
void [version, validate, render, AgentServerClient]
`)
  execFileSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--skipLibCheck', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2022', 'consumer.ts'], { cwd: temp, stdio: 'pipe' })
  const browser = await build({ stdin: { contents: "export * from 'dooers-agents-client/maestro/contracts'", resolveDir: temp }, bundle: true, platform: 'browser', format: 'esm', write: false, metafile: true, logLevel: 'silent' })
  assert.equal(Object.values(browser.metafile.outputs).flatMap(o => o.imports).length, 0)
  const inputs = Object.keys(browser.metafile.inputs)
  assert(!inputs.some(p => /(?:node:|\/identity\.|\/delivery\.|\/react\/|\/zustand\/)/.test(p)))
  assert(!/from\s*["']node:|require\(["'](?:node:|crypto)/.test(browser.outputFiles[0].text))
  console.log(JSON.stringify({ ...smoke, types: true, browser: true, browser_inputs: inputs.length, package_sha256: createHash('sha256').update(readFileSync(path.join(temp, packed.filename))).digest('hex') }))
} finally {
  rmSync(temp, { recursive: true, force: true })
}
