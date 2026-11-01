import type { DrawingDocument, DrawingLayer, DrawingOperation, TraceState } from '../lib/types'

type LayerSettings = Pick<DrawingLayer, 'name' | 'visible' | 'opacity'>
type TracePatch = Partial<Pick<TraceState, 'assetId' | 'imageUrl' | 'visible' | 'opacity' | 'scale'>>

export interface HistoryLimits {
  maxEntries: number
  maxBytes: number
}

export const DEFAULT_HISTORY_LIMITS: HistoryLimits = {
  maxEntries: 500,
  maxBytes: 32 * 1024 * 1024,
}

export type HistoryEntry = { bytes: number } & (
  | { kind: 'operation_appended'; layerId: string; operation: DrawingOperation }
  | { kind: 'layer_properties_changed'; layerId: string; before: LayerSettings; after: LayerSettings }
  | { kind: 'layer_moved'; layerId: string; from: number; to: number }
  | { kind: 'layer_cleared'; layerId: string; operations: DrawingOperation[] }
  | { kind: 'title_changed'; before: string; after: string }
  | {
      kind: 'trace_changed'
      // Only the fields the command actually wrote. `imageUrl` is included for
      // setTrace/clearTrace and deliberately excluded from updateTrace so a
      // later setResolvedTraceImage() is not clobbered by redo.
      before: TracePatch
      after: TracePatch
    }
)

const POINT_BYTES = 48 // conservative: 4 numbers plus per-point object overhead
const OPERATION_OVERHEAD = 96

export function estimateOperationBytes(operation: DrawingOperation): number {
  if (operation.kind === 'stroke') {
    return OPERATION_OVERHEAD + operation.points.length * POINT_BYTES
  }
  return OPERATION_OVERHEAD + 64
}

function patchLength(patch: TracePatch): number {
  return (patch.imageUrl?.length ?? 0) + (patch.assetId?.length ?? 0)
}

export function operationAppendedEntry(layerId: string, operation: DrawingOperation): HistoryEntry {
  return {
    kind: 'operation_appended',
    layerId,
    operation,
    bytes: estimateOperationBytes(operation),
  }
}

export function layerPropertiesChangedEntry(
  layerId: string,
  before: LayerSettings,
  after: LayerSettings,
): HistoryEntry {
  return {
    kind: 'layer_properties_changed',
    layerId,
    before,
    after,
    bytes: 128 + 2 * (before.name.length + after.name.length),
  }
}

export function layerMovedEntry(layerId: string, from: number, to: number): HistoryEntry {
  return { kind: 'layer_moved', layerId, from, to, bytes: 128 }
}

export function layerClearedEntry(layerId: string, operations: DrawingOperation[]): HistoryEntry {
  let bytes = 128
  for (const operation of operations) bytes += estimateOperationBytes(operation)
  return { kind: 'layer_cleared', layerId, operations, bytes }
}

export function titleChangedEntry(before: string, after: string): HistoryEntry {
  return {
    kind: 'title_changed',
    before,
    after,
    bytes: 64 + 2 * (before.length + after.length),
  }
}

export function traceChangedEntry(before: TracePatch, after: TracePatch): HistoryEntry {
  return {
    kind: 'trace_changed',
    before,
    after,
    bytes: 128 + 2 * (patchLength(before) + patchLength(after)),
  }
}

function findLayer(document: DrawingDocument, layerId: string) {
  return document.layers.find((layer) => layer.id === layerId)
}

function replaceLayer(
  document: DrawingDocument,
  layerId: string,
  update: (layer: DrawingLayer) => DrawingLayer,
): DrawingDocument {
  const index = document.layers.findIndex((layer) => layer.id === layerId)
  const current = index >= 0 ? document.layers[index] : undefined
  if (!current) return document
  const next = update(current)
  if (next === current) return document
  const layers = document.layers.slice()
  layers[index] = next
  return { ...document, layers }
}

function moveLayerTo(document: DrawingDocument, layerId: string, target: number): DrawingDocument {
  const index = document.layers.findIndex((layer) => layer.id === layerId)
  if (index < 0 || target < 0 || target >= document.layers.length || index === target) return document
  const layers = document.layers.slice()
  const [layer] = layers.splice(index, 1)
  if (!layer) return document
  layers.splice(target, 0, layer)
  return { ...document, layers }
}

export function applyHistoryEntry(
  document: DrawingDocument,
  entry: HistoryEntry,
  direction: 'undo' | 'redo',
): DrawingDocument {
  switch (entry.kind) {
    case 'operation_appended': {
      const layer = findLayer(document, entry.layerId)
      if (!layer) return document
      if (direction === 'redo') {
        if (layer.operations.at(-1)?.id === entry.operation.id) return document
        return replaceLayer(document, entry.layerId, (current) => ({
          ...current,
          operations: [...current.operations, entry.operation],
        }))
      }
      const operations = layer.operations.at(-1)?.id === entry.operation.id
        ? layer.operations.slice(0, -1)
        : layer.operations.filter((operation) => operation.id !== entry.operation.id)
      return replaceLayer(document, entry.layerId, (current) => ({ ...current, operations }))
    }
    case 'layer_properties_changed':
      return replaceLayer(document, entry.layerId, (layer) => ({
        ...layer,
        ...(direction === 'redo' ? entry.after : entry.before),
      }))
    case 'layer_moved':
      return moveLayerTo(
        document,
        entry.layerId,
        direction === 'redo' ? entry.to : entry.from,
      )
    case 'layer_cleared':
      return replaceLayer(document, entry.layerId, (layer) => ({
        ...layer,
        operations: direction === 'redo' ? [] : entry.operations,
      }))
    case 'title_changed':
      return { ...document, title: direction === 'redo' ? entry.after : entry.before }
    case 'trace_changed':
      return {
        ...document,
        trace: { ...document.trace, ...(direction === 'redo' ? entry.after : entry.before) },
      }
    default: {
      const exhaustive: never = entry
      return exhaustive
    }
  }
}

export function trimPast(entries: HistoryEntry[], limits: HistoryLimits): HistoryEntry[] {
  let total = entries.reduce((sum, entry) => sum + entry.bytes, 0)
  let start = 0
  // Keep at least the newest entry even if it alone exceeds maxBytes.
  while (entries.length - start > limits.maxEntries || (total > limits.maxBytes && entries.length - start > 1)) {
    total -= entries[start]!.bytes
    start += 1
  }
  return start === 0 ? entries : entries.slice(start)
}

export function trimFuture(entries: HistoryEntry[], limits: HistoryLimits): HistoryEntry[] {
  let total = entries.reduce((sum, entry) => sum + entry.bytes, 0)
  let end = entries.length
  // Future is newest-first; drop from the end (oldest redo entries).
  while (end > limits.maxEntries || (total > limits.maxBytes && end > 1)) {
    end -= 1
    total -= entries[end]!.bytes
  }
  return end === entries.length ? entries : entries.slice(0, end)
}
