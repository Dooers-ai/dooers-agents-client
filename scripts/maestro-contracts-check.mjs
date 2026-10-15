import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
const read = (name) => readFileSync(path.join(root, name))
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const pin = '7792256d9967ae2e3307b8dd627561e750ffeebc6f39ab270dbfd687336a1fcd'
const consumer = JSON.parse(read('vendor/maestro-v1/consumer-manifest.json'))
const manifestBytes = read('vendor/maestro-v1/contracts/manifest.json')
if (hash(manifestBytes) !== pin || consumer.source_manifest_sha256 !== pin) {
  throw new Error('Maestro source manifest pin mismatch')
}
const manifest = JSON.parse(manifestBytes)
const expectedFiles = {
  'src/protocol/maestro/vendor/common.ts': 'contracts/v1/common.ts',
  'src/protocol/maestro/vendor/public.ts': 'contracts/v1/public.ts',
  'vendor/maestro-v1/contracts/fixtures/v1/public.json': 'contracts/fixtures/v1/public.json',
  'vendor/maestro-v1/contracts/fixtures/v1/public-publication.json': 'contracts/fixtures/v1/public-publication.json',
  'vendor/maestro-v1/contracts/harness/boundary-fixtures.json': 'contracts/harness/boundary-fixtures.json',
  'vendor/maestro-v1/contracts/catalog-public.json': 'contracts/catalog-public.json',
  'vendor/maestro-v1/contracts/manifest.json': 'contracts/manifest.json',
  'vendor/maestro-v1/contracts/generated/v1/bundle-manifest.json': 'contracts/generated/v1/bundle-manifest.json',
}
if (JSON.stringify(Object.keys(consumer.files).sort()) !== JSON.stringify(Object.keys(expectedFiles).sort()) || consumer.bundle_manifest_sha256 !== manifest.bundle_manifest_sha256) {
  throw new Error('Maestro consumer file inventory or bundle mismatch')
}
if (consumer.source_revision !== manifest.source_revision || consumer.runtime_dependency.zod !== '4.4.3') {
  throw new Error('Maestro source revision or dependency mismatch')
}
for (const [local, file] of Object.entries(consumer.files)) {
  if (file.source !== expectedFiles[local]) throw new Error('Maestro source path mismatch')
  const expected = file.source === 'contracts/manifest.json' ? pin : manifest.files[file.source]
  if (!expected || file.sha256 !== expected || hash(read(local)) !== expected) {
    throw new Error(`Maestro vendored file mismatch: ${local}`)
  }
}
const pkg = JSON.parse(read('package.json'))
const lock = JSON.parse(read('package-lock.json'))
if (pkg.dependencies.zod !== '4.4.3' || lock.packages['node_modules/zod'].version !== '4.4.3') {
  throw new Error('Maestro requires exact Zod 4.4.3')
}
console.log(JSON.stringify({ ok: true, consumer: consumer.consumer, files: Object.keys(consumer.files).length, manifest_sha256: pin }))
