import { describe, expect, it } from 'vitest'
import {
  compareSemver,
  isServerAtLeast,
  supportsThreadArtifactsList,
} from '../src/helpers/server-version'

describe('server-version', () => {
  it('compareSemver orders versions', () => {
    expect(compareSemver('0.17.0', '0.16.9')).toBe(1)
    expect(compareSemver('0.17.0', '0.17.0')).toBe(0)
    expect(compareSemver('0.16.1', '0.17.0')).toBe(-1)
  })

  it('supportsThreadArtifactsList from 0.17.1', () => {
    expect(supportsThreadArtifactsList(null)).toBe(false)
    expect(supportsThreadArtifactsList('0.17.0')).toBe(false)
    expect(supportsThreadArtifactsList('0.17.1')).toBe(true)
    expect(supportsThreadArtifactsList('0.18.0')).toBe(true)
    expect(isServerAtLeast('1.0.0', '0.17.1')).toBe(true)
  })
})
