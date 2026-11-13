import { describe, expect, it } from 'vitest'
import type { WireS2C_FormElement } from '../src/protocol/models'
import { toFormEventData, toFormElement } from '../src/types'

describe('toFormElement', () => {
  it('keeps an element of an unknown type as a text field with its own name, never undefined', () => {
    const unknown = { type: 'slider', name: 'nivel', label: 'Nível', order: 2, required: true, min: 0 } as unknown as WireS2C_FormElement
    expect(toFormElement(unknown)).toEqual({
      name: 'nivel',
      label: 'Nível',
      order: 2,
      required: true,
      disabled: false,
      type: 'text_input',
      placeholder: null,
      default: null,
      inputType: 'text',
    })
  })
  it('toFormEventData keeps every element, known or not', () => {
    const data = toFormEventData({
      message: 'x',
      elements: [
        { type: 'text_input', name: 'a', label: 'A' },
        { type: 'slider', name: 'b', label: 'B' },
      ],
    })
    expect(data.elements.map((element) => [element.name, element.type])).toEqual([
      ['a', 'text_input'],
      ['b', 'text_input'],
    ])
  })
})
