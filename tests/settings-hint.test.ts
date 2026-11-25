import { describe, expect, it } from 'vitest'
import type { WireSettingsItem } from '../src/protocol/models'
import { toSettingsItem } from '../src/types'

const field = {
  id: 'composer_models',
  type: 'multiselect',
  label: 'Modelos no seletor',
  required: false,
  readonly: false,
  value: ['a'],
  placeholder: null,
  options: [{ value: 'a', label: 'A' }],
  min: null,
  max: null,
  rows: null,
  src: null,
  width: null,
  height: null,
  upload_url: null,
  accept: null,
}

describe('settings hint and multiselect', () => {
  it('keeps hint on fields and groups', () => {
    const group = toSettingsItem({
      id: 'g',
      label: 'G',
      collapsible: null,
      hint: 'Ajuda do grupo',
      fields: [{ ...field, hint: 'Ajuda do campo' }],
    } as WireSettingsItem)
    expect(group).toMatchObject({
      hint: 'Ajuda do grupo',
      fields: [{ type: 'multiselect', hint: 'Ajuda do campo', value: ['a'] }],
    })
  })

  it('defaults hint to null for older servers', () => {
    expect(toSettingsItem(field as WireSettingsItem)).toMatchObject({ hint: null })
  })
})
