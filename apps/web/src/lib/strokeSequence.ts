import type { StrokeSequence } from '@drawable/contracts'
import { LOGICAL_SIZE, type DrawingLayer } from './types'

/**
 * Flatten visible layers into the wire-format stroke sequence.
 *
 * Raw points are sent untouched (the server resamples/simplifies); timestamps
 * are rebased to the first sample so the payload does not leak wall-clock
 * time. Erase operations are included so the server can reproduce the raster.
 */
export function buildStrokeSequence(layers: DrawingLayer[]): StrokeSequence {
  const operations = layers.filter((layer) => layer.visible && layer.opacity > 0).flatMap((layer) => layer.operations)
  const origin = operations[0]?.points[0]?.time ?? 0
  return {
    version: 1,
    canvas_width: LOGICAL_SIZE,
    canvas_height: LOGICAL_SIZE,
    strokes: operations.map((operation) => ({
      tool: operation.tool,
      pointer: operation.points[0]?.pointerType ?? (operation.simulatePressure ? 'mouse' : 'pen'),
      points: operation.points.map((point) => ({
        x: point.x,
        y: point.y,
        p: Math.min(1, Math.max(0, point.pressure)),
        t: Math.max(0, point.time - origin),
      })),
    })),
  }
}

export function countDocumentPoints(layers: DrawingLayer[]): number {
  return layers.reduce(
    (total, layer) => (layer.visible ? total + layer.operations.reduce((sum, operation) => sum + operation.points.length, 0) : total),
    0,
  )
}
