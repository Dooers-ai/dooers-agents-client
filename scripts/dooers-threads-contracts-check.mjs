import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
const read = (name) => readFileSync(path.join(root, name))
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const pin = 'b764561c5385b9e84ed6c955704dff7de31b0f30f1a38a6555f289b4e6b423cf'
const consumer = JSON.parse(read('vendor/dooers-threads-v1/consumer-manifest.json'))
const manifestBytes = read('vendor/dooers-threads-v1/contracts/manifest.json')
if (hash(manifestBytes) !== pin || consumer.source_manifest_sha256 !== pin) {
  throw new Error('Dooers Threads source manifest pin mismatch')
}
const manifest = JSON.parse(manifestBytes)
const expectedFiles = {
  'src/protocol/dooers-threads/vendor/common.ts': 'docs/contracts/v1/common.ts',
  'src/protocol/dooers-threads/vendor/identity.ts': 'docs/contracts/v1/identity.ts',
  'src/protocol/dooers-threads/vendor/public.ts': 'docs/contracts/v1/public.ts',
  'vendor/dooers-threads-v1/contracts/fixtures/v1/public.json': 'docs/contracts/fixtures/v1/public.json',
  'vendor/dooers-threads-v1/contracts/fixtures/v1/public-publication.json': 'docs/contracts/fixtures/v1/public-publication.json',
  'vendor/dooers-threads-v1/contracts/harness/boundary-fixtures.json': 'docs/contracts/harness/boundary-fixtures.json',
  'vendor/dooers-threads-v1/contracts/catalog-public.json': 'docs/contracts/catalog-public.json',
  'vendor/dooers-threads-v1/contracts/manifest.json': 'docs/contracts/manifest.json',
  'vendor/dooers-threads-v1/contracts/generated/v1/bundle-manifest.json': 'docs/contracts/generated/v1/bundle-manifest.json',
}
if (JSON.stringify(Object.keys(consumer.files).sort()) !== JSON.stringify(Object.keys(expectedFiles).sort()) || consumer.bundle_manifest_sha256 !== manifest.bundle_manifest_sha256) {
  throw new Error('Dooers Threads consumer file inventory or bundle mismatch')
}
if (consumer.source_revision !== manifest.source_revision || consumer.runtime_dependency.zod !== '4.4.3') {
  throw new Error('Dooers Threads source revision or dependency mismatch')
}
for (const [local, file] of Object.entries(consumer.files)) {
  if (file.source !== expectedFiles[local]) throw new Error('Dooers Threads source path mismatch')
  const expected = file.source === 'docs/contracts/manifest.json' ? pin : manifest.files[file.source]
  if (!expected || file.sha256 !== expected || hash(read(local)) !== expected) {
    throw new Error(`Dooers Threads vendored file mismatch: ${local}`)
  }
}
const pkg = JSON.parse(read('package.json'))
const lock = JSON.parse(read('package-lock.json'))
if (pkg.dependencies.zod !== '4.4.3' || lock.packages['node_modules/zod'].version !== '4.4.3') {
  throw new Error('Dooers Threads requires exact Zod 4.4.3')
}
console.log(JSON.stringify({ ok: true, consumer: consumer.consumer, files: Object.keys(consumer.files).length, manifest_sha256: pin }))
