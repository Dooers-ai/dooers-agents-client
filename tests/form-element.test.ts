import { describe, expect, it } from 'vitest'
import type { WireS2C_FormElement } from '../src/protocol/models'
import { toFormElement, toFormEventData } from '../src/types'

const slider = { type: 'slider', name: 'nivel', label: 'Nível', order: 2, required: true, min: 0, default: 5 } as unknown as WireS2C_FormElement

describe('toFormElement', () => {
  it('legacy runtime: an unknown element yields undefined, as the production client does', () => {
    expect(toFormElement(slider)).toBeUndefined()
    const data = toFormEventData({ message: 'x', elements: [{ type: 'text_input', name: 'a', label: 'A' }, slider] })
    expect(data.elements).toHaveLength(2)
    expect(data.elements[1]).toBeUndefined()
  })
  it('legacy runtime: known elements are unchanged', () => {
    expect(toFormElement({ type: 'text_input', name: 'a', label: 'A' } as WireS2C_FormElement)).toEqual({
      name: 'a', label: 'A', order: 0, required: false, disabled: false, type: 'text_input', placeholder: null, default: null, inputType: 'text',
    })
  })
  it('Maestro: an unknown element keeps its base fields and its original type, never required, with no default', () => {
    expect(toFormElement(slider, { tolerateUnknown: true })).toEqual({
      name: 'nivel', label: 'Nível', order: 2, required: false, disabled: false, type: 'slider',
    })
  })
  it('Maestro: toFormEventData keeps every element, and an unknown one does not block validation', () => {
    const data = toFormEventData(
      { message: 'x', elements: [{ type: 'text_input', name: 'a', label: 'A', required: true }, slider] },
      { tolerateUnknown: true }
    )
    expect(data.elements.map((element) => [element.name, element.type, element.required])).toEqual([
      ['a', 'text_input', true],
      ['nivel', 'slider', false],
    ])
    // use-form validates `el.required` and collects `default`: nothing of the unknown element reaches either.
    expect(data.elements.some((element) => element.required && element.type === 'slider')).toBe(false)
    expect('default' in data.elements[1]!).toBe(false)
  })
  it('Maestro: known elements are identical with and without the option', () => {
    const raw = { message: 'x', elements: [{ type: 'select_input', name: 's', label: 'S', options: [{ value: 'a', label: 'A' }] }] }
    expect(toFormEventData(raw, { tolerateUnknown: true })).toEqual(toFormEventData(raw))
  })
})
