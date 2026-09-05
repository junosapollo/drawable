import { getStroke } from 'perfect-freehand'
import type { DrawPoint, DrawingLayer, StrokeOperation } from './types'

export function uid(prefix: string) {
  const value = typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `${prefix}-${value}`
}

export function stabilizationOptions(value: number) {
  return {
    smoothing: 0.1 + 0.009 * value,
    streamline: 0.009 * value,
  }
}

export function strokeOutline(operation: StrokeOperation): number[][] {
  return getStroke(
    operation.points.map((point) => [point.x, point.y, point.pressure]),
    {
      size: operation.size,
      thinning: operation.tool === 'pressure' ? 0.65 : 0,
      smoothing: operation.smoothing,
      streamline: operation.streamline,
      simulatePressure: operation.simulatePressure,
      start: { cap: true, taper: 0 },
      end: { cap: operation.tool !== 'pressure', taper: operation.tool === 'pressure' ? 8 : 0 },
      last: true,
    },
  )
}

export function outlineToPath(points: number[][]) {
  if (points.length < 4) return ''
  const first = points[0]
  const second = points[1]
  const third = points[2]
  if (!first || !second || !third) return ''
  let path = `M${first[0]?.toFixed(2)},${first[1]?.toFixed(2)} Q${second[0]?.toFixed(2)},${second[1]?.toFixed(2)} ${((second[0] ?? 0) + (third[0] ?? 0)) / 2},${((second[1] ?? 0) + (third[1] ?? 0)) / 2} T`
  for (let index = 2; index < points.length - 1; index += 1) {
    const current = points[index]
    const next = points[index + 1]
    if (!current || !next) continue
    path += `${(((current[0] ?? 0) + (next[0] ?? 0)) / 2).toFixed(2)},${(((current[1] ?? 0) + (next[1] ?? 0)) / 2).toFixed(2)} `
  }
  return `${path}Z`
}

export function renderOperation(
  context: CanvasRenderingContext2D,
  operation: StrokeOperation,
  preview = false,
) {
  const pathData = outlineToPath(strokeOutline(operation))
  if (!pathData) return
  context.save()
  if (operation.tool === 'eraser') {
    if (preview) {
      context.globalCompositeOperation = 'source-over'
      context.fillStyle = 'rgba(118, 124, 134, 0.28)'
    } else {
      context.globalCompositeOperation = 'destination-out'
      context.fillStyle = '#000'
    }
  } else {
    context.globalCompositeOperation = 'source-over'
    context.fillStyle = '#111214'
  }
  context.fill(new Path2D(pathData))
  context.restore()
}

export function renderLayer(context: CanvasRenderingContext2D, layer: DrawingLayer) {
  context.clearRect(0, 0, context.canvas.width, context.canvas.height)
  for (const operation of layer.operations) renderOperation(context, operation)
}

export function countDocumentStrokes(layers: DrawingLayer[]) {
  return layers.reduce((total, layer) => total + (layer.visible ? layer.operations.length : 0), 0)
}

export function makeStrokeOperation(
  tool: Exclude<import('./types').Tool, 'hand'>,
  points: DrawPoint[],
  size: number,
  stabilization: number,
  simulatePressure: boolean,
): StrokeOperation {
  const options = stabilizationOptions(stabilization)
  return {
    id: uid('stroke'),
    kind: 'stroke',
    tool,
    points,
    size,
    ...options,
    simulatePressure,
    createdAt: Date.now(),
  }
}
