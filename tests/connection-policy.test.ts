import { describe, expect, it } from 'vitest'
import { reconnectDelayMs, rotationDue } from '../src/helpers/connection-policy'

describe('reconnectDelayMs', () => {
  it('backs off and caps, with the lowest jitter', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map((n) => reconnectDelayMs(n, () => 0))).toEqual([
      800, 1600, 3200, 6400, 12800, 12800, 12800,
    ])
  })

  it('applies the highest jitter', () => {
    expect(reconnectDelayMs(0, () => 1)).toBeCloseTo(1200, 6)
  })
})

describe('rotationDue', () => {
  it('waits before the idle threshold', () => {
    expect(rotationDue(29 * 60_000, true)).toBe(false)
  })
  it('rotates when idle past the threshold', () => {
    expect(rotationDue(30 * 60_000, true)).toBe(true)
  })
  it('does not rotate a busy connection before the deadline', () => {
    expect(rotationDue(30 * 60_000, false)).toBe(false)
  })
  it('rotates a busy connection at the deadline', () => {
    expect(rotationDue(55 * 60_000, false)).toBe(true)
  })
})
