import { describe, expect, it } from 'vitest'
import type { DrawPoint, StrokeOperation } from '../lib/types'
import { createDocumentStore } from './documentStore'
import { estimateOperationBytes } from './documentHistory'

const STROKES = 200
const POINTS_PER_STROKE = 500

function longStroke(index: number): StrokeOperation {
  const points: DrawPoint[] = Array.from({ length: POINTS_PER_STROKE }, (_, point) => ({
    x: (index * 17 + point) % 2048,
    y: (index * 29 + point * 3) % 2048,
    pressure: 0.5,
    time: point,
  }))
  return {
    id: `stroke-${index}`,
    kind: 'stroke',
    tool: 'pressure',
    points,
    size: 12,
    smoothing: 0.5,
    streamline: 0.5,
    simulatePressure: false,
    createdAt: index,
  }
}

function percentile(values: number[], fraction: number) {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0
}

describe('document store commit performance', () => {
  it('retains stroke payload rather than full-document snapshots', () => {
    const store = createDocumentStore()
    const initialLayers = store.getState().document.layers
    const strokes = Array.from({ length: STROKES }, (_, index) => longStroke(index))
    const commitMs: number[] = []

    for (const operation of strokes) {
      const start = performance.now()
      store.getState().commitOperation(operation)
      commitMs.push(performance.now() - start)
    }

    const totalMs = commitMs.reduce((sum, value) => sum + value, 0)
    const retainedBytes = store.getState().past.reduce((sum, entry) => sum + entry.bytes, 0)
    const rawBytes = STROKES * estimateOperationBytes(longStroke(0))
    const finalCloneMs = (() => {
      const start = performance.now()
      structuredClone(store.getState().document)
      return performance.now() - start
    })()

    console.info('[document-store perf]', {
      strokes: STROKES,
      pointsPerStroke: POINTS_PER_STROKE,
      p50Ms: percentile(commitMs, 0.5),
      p95Ms: percentile(commitMs, 0.95),
      totalMs,
      retainedBytes,
      rawBytes,
      retainedRatio: retainedBytes / rawBytes,
      finalCloneMs,
      oldCommitVolumeMs: finalCloneMs * STROKES,
    })

    expect(store.getState().past).toHaveLength(STROKES)
    expect(retainedBytes).toBeLessThanOrEqual(rawBytes * 2)
    expect(totalMs).toBeLessThan(5000)
    expect(store.getState().document.layers[1]).toBe(initialLayers[1])
    expect(store.getState().document.layers[2]).toBe(initialLayers[2])
    expect(store.getState().document.layers[3]).toBe(initialLayers[3])

    const entry = store.getState().past[0]
    expect(entry?.kind).toBe('operation_appended')
    if (entry?.kind === 'operation_appended' && entry.operation.kind === 'stroke' && strokes[0]) {
      expect(entry.operation.points).toBe(strokes[0].points)
    }
  }, 20000)
})
