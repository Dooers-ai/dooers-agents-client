import { describe, expect, it } from 'vitest'
import { publicSchemaFromResultPayload } from '../src/types'

describe('publicSchemaFromResultPayload', () => {
  const catalog = {
    version: '1.0',
    fields: [{ id: 'llm_models', type: 'select' as const, label: 'Models' }],
  }

  it('reads payload.schema (agents-server >= 0.19.1)', () => {
    const parsed = publicSchemaFromResultPayload({ schema: catalog })
    expect(parsed.version).toBe('1.0')
    expect(parsed.fields).toHaveLength(1)
    expect(parsed.fields[0]?.id).toBe('llm_models')
  })

  it('reads payload.schema_ (agents-server 0.19.0 dump bug)', () => {
    const parsed = publicSchemaFromResultPayload({ schema_: catalog })
    expect(parsed.fields).toHaveLength(1)
    expect(parsed.fields[0]?.id).toBe('llm_models')
  })

  it('returns empty fields when neither key is present', () => {
    const parsed = publicSchemaFromResultPayload({})
    expect(parsed.fields).toEqual([])
  })
})
