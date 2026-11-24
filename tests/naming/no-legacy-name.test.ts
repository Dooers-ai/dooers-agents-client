import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// The legacy product name is assembled from parts so this file does not contain it.
const LEGACY = 'mae' + 'stro'
const LEGACY_PATTERN = new RegExp(LEGACY, 'i')
const ROOT = resolve(import.meta.dirname, '..', '..')

// Global exceptions only: historical docs, old changelog entries and binary files.
const ALLOWLIST: RegExp[] = [
  /^docs\/(decisoes|plans|tasks|contexto)\//,
  /^CHANGELOG\.md$/,
  /\.(tgz|png|jpe?g|gif|ico|pdf|woff2?|zip|gz)$/i,
]

function trackedFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 })
  return out
    .toString('utf8')
    .split('\0')
    .filter((file) => file.length > 0)
}

function isBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8000).includes(0)
}

describe('legacy product name', () => {
  it(`has no legacy ${LEGACY} name outside the allowlist`, () => {
    const violations: string[] = []
    for (const file of trackedFiles()) {
      if (ALLOWLIST.some((rule) => rule.test(file))) continue
      if (LEGACY_PATTERN.test(file)) violations.push(`${file}: path`)
      let content: Buffer
      try {
        content = readFileSync(resolve(ROOT, file))
      } catch {
        continue
      }
      if (isBinary(content)) continue
      const lines = content.toString('utf8').split('\n')
      const hit = lines.findIndex((line) => LEGACY_PATTERN.test(line))
      if (hit >= 0) violations.push(`${file}:${hit + 1}: content`)
    }
    expect(violations.slice(0, 20), `${violations.length} violation(s)`).toEqual([])
  })
})
