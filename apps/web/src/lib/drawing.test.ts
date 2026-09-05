import { describe, expect, it } from 'vitest'
import { makeStrokeOperation, outlineToPath, stabilizationOptions, strokeOutline } from './drawing'

describe('drawing geometry', () => {
  it('maps stabilization to the specified smoothing values', () => {
    expect(stabilizationOptions(50).smoothing).toBeCloseTo(0.55)
    expect(stabilizationOptions(50).streamline).toBeCloseTo(0.45)
    expect(stabilizationOptions(0)).toEqual({ smoothing: 0.1, streamline: 0 })
  })

  it('creates a closed vector outline from input points', () => {
    const operation = makeStrokeOperation('monoline', [
      { x: 10, y: 10, pressure: 0.5, time: 0 },
      { x: 80, y: 80, pressure: 0.5, time: 16 },
      { x: 160, y: 100, pressure: 0.5, time: 32 },
    ], 12, 50, true)
    const path = outlineToPath(strokeOutline(operation))
    expect(path.startsWith('M')).toBe(true)
    expect(path.endsWith('Z')).toBe(true)
  })
})
