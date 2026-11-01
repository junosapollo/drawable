import { describe, expect, it } from 'vitest'
import type { DrawingDocument, DrawingLayer, DrawingOperation, StrokeOperation } from '../lib/types'
import {
  DEFAULT_HISTORY_LIMITS,
  applyHistoryEntry,
  estimateOperationBytes,
  layerClearedEntry,
  layerMovedEntry,
  layerPropertiesChangedEntry,
  operationAppendedEntry,
  titleChangedEntry,
  traceChangedEntry,
  trimFuture,
  trimPast,
  type HistoryEntry,
} from './documentHistory'

function layer(id: string, operations: DrawingOperation[] = []): DrawingLayer {
  return { id, name: id, visible: true, opacity: 1, operations }
}

function documentWith(layers: DrawingLayer[]): DrawingDocument {
  return {
    id: 'document-1',
    title: 'Untitled drawing',
    revision: 3,
    updatedAt: 1,
    layers,
    trace: { assetId: null, imageUrl: null, visible: true, opacity: 0.3, scale: 1 },
  }
}

function stroke(id: string, pointCount = 2): StrokeOperation {
  return {
    id,
    kind: 'stroke',
    tool: 'pressure',
    points: Array.from({ length: pointCount }, (_, index) => ({ x: index, y: index, pressure: 0.5, time: index })),
    size: 8,
    smoothing: 0.5,
    streamline: 0.5,
    simulatePressure: false,
    createdAt: 0,
  }
}

describe('document history entries', () => {
  it('estimates operation bytes without walking point objects', () => {
    expect(estimateOperationBytes(stroke('a', 10))).toBe(96 + 10 * 48)
    expect(estimateOperationBytes({ id: 'r', kind: 'raster', assetId: 'asset', x: 0, y: 0, width: 1, height: 1, createdAt: 0 })).toBe(96 + 64)
  })

  it('appends on redo and removes on undo while sharing untouched layers', () => {
    const first = stroke('first')
    const second = stroke('second')
    const base = documentWith([layer('layer-1', [first]), layer('layer-2')])
    const entry = operationAppendedEntry('layer-1', second)

    const appended = applyHistoryEntry(base, entry, 'redo')
    expect(appended.layers[0]?.operations).toEqual([first, second])
    expect(appended.layers[1]).toBe(base.layers[1])
    expect(base.layers[0]?.operations).toEqual([first])

    expect(applyHistoryEntry(appended, entry, 'redo')).toBe(appended)

    const removed = applyHistoryEntry(appended, entry, 'undo')
    expect(removed.layers[0]?.operations).toEqual([first])
    expect(removed.layers[1]).toBe(base.layers[1])
  })

  it('restores layer settings without touching operations', () => {
    const operations = [stroke('a')]
    const base = documentWith([layer('layer-1', operations)])
    const entry = layerPropertiesChangedEntry(
      'layer-1',
      { name: 'layer-1', visible: true, opacity: 1 },
      { name: 'Inks', visible: false, opacity: 0.4 },
    )

    const changed = applyHistoryEntry(base, entry, 'redo')
    expect(changed.layers[0]).toMatchObject({ name: 'Inks', visible: false, opacity: 0.4 })
    expect(changed.layers[0]?.operations).toBe(operations)

    const restored = applyHistoryEntry(changed, entry, 'undo')
    expect(restored.layers[0]).toMatchObject({ name: 'layer-1', visible: true, opacity: 1 })
    expect(restored.layers[0]?.operations).toBe(operations)
  })

  it('moves layers by index and reverses the move', () => {
    const base = documentWith([layer('a'), layer('b'), layer('c')])
    const entry = layerMovedEntry('a', 0, 2)
    const moved = applyHistoryEntry(base, entry, 'redo')
    expect(moved.layers.map((item) => item.id)).toEqual(['b', 'c', 'a'])
    expect(applyHistoryEntry(moved, entry, 'undo').layers.map((item) => item.id)).toEqual(['a', 'b', 'c'])
    expect(applyHistoryEntry(base, layerMovedEntry('a', 0, 5), 'redo')).toBe(base)
  })

  it('retains the removed operations array for a clear', () => {
    const operations = [stroke('a'), stroke('b')]
    const base = documentWith([layer('layer-1', operations)])
    const entry = layerClearedEntry('layer-1', operations)
    expect(entry.bytes).toBeGreaterThan(operations.reduce((sum, operation) => sum + estimateOperationBytes(operation), 0))

    const cleared = applyHistoryEntry(base, entry, 'redo')
    expect(cleared.layers[0]?.operations).toEqual([])
    const restored = applyHistoryEntry(cleared, entry, 'undo')
    expect(restored.layers[0]?.operations).toBe(operations)
  })

  it('applies partial trace patches and leaves untouched fields alone', () => {
    const base = documentWith([layer('layer-1')])
    const entry = traceChangedEntry({ opacity: 0.3 }, { opacity: 0.6 })
    const changed = applyHistoryEntry(base, entry, 'redo')
    expect(changed.trace).toMatchObject({ opacity: 0.6, assetId: null, imageUrl: null, visible: true })
    expect(changed.layers).toBe(base.layers)
    expect(applyHistoryEntry(changed, entry, 'undo').trace.opacity).toBe(0.3)
  })

  it('applies title changes and ignores unknown layers', () => {
    const base = documentWith([layer('layer-1')])
    const entry = titleChangedEntry('Untitled drawing', 'Sketch')
    const changed = applyHistoryEntry(base, entry, 'redo')
    expect(changed.title).toBe('Sketch')
    expect(changed.layers).toBe(base.layers)
    expect(applyHistoryEntry(changed, entry, 'undo').title).toBe('Untitled drawing')
    expect(applyHistoryEntry(base, operationAppendedEntry('missing', stroke('x')), 'redo')).toBe(base)
  })
})

describe('history trimming', () => {
  const entry = (bytes: number): HistoryEntry => ({
  kind: 'operation_appended',
  layerId: 'layer-1',
  operation: stroke('a'),
  bytes,
})

  it('keeps the newest entries within the count limit', () => {
    const entries = [entry(1), entry(2), entry(3), entry(4)]
    expect(trimPast(entries, { maxEntries: 2, maxBytes: 100 })).toEqual([entries[2], entries[3]])
  })

  it('evicts the oldest past entries to satisfy the byte budget', () => {
    const entries = [entry(50), entry(50), entry(50)]
    expect(trimPast(entries, { maxEntries: 10, maxBytes: 60 })).toEqual([entries[2]])
  })

  it('always keeps the newest past entry even when it exceeds the budget alone', () => {
    const entries = [entry(50), entry(500)]
    expect(trimPast(entries, { maxEntries: 10, maxBytes: 100 })).toEqual([entries[1]])
  })

  it('drops the deepest future entries first', () => {
    const entries = [entry(1), entry(2), entry(3), entry(4)]
    expect(trimFuture(entries, { maxEntries: 2, maxBytes: 100 })).toEqual([entries[0], entries[1]])
    expect(trimFuture(entries, { maxEntries: 10, maxBytes: 6 })).toEqual([entries[0], entries[1], entries[2]])
  })

  it('exposes the documented default limits', () => {
    expect(DEFAULT_HISTORY_LIMITS).toEqual({ maxEntries: 500, maxBytes: 32 * 1024 * 1024 })
  })
})
