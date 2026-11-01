import { beforeEach, describe, expect, it } from 'vitest'
import { makeStrokeOperation } from '../lib/drawing'
import type { DrawingDocument, StrokeOperation } from '../lib/types'
import { documentsEquivalent, replaySequence } from '../services/recordingValidation'
import type { DrawingSequenceCurrent } from '../services/recordingTypes'
import { createDocumentStore, useDocumentStore, type DocumentCommand } from './documentStore'
import { estimateOperationBytes } from './documentHistory'

const stroke = (id = 'stroke', points = 2): StrokeOperation => ({
  id,
  kind: 'stroke',
  tool: 'pressure',
  points: Array.from({ length: points }, (_, index) => ({ x: index, y: index, pressure: 0.5, time: index })),
  size: 8,
  smoothing: 0.5,
  streamline: 0.5,
  simulatePressure: false,
  createdAt: 0,
})

const operationsOf = (document: DrawingDocument, index: number) => document.layers[index]?.operations ?? []

describe('document store', () => {
  beforeEach(() => useDocumentStore.getState().newDocument())

  it('starts with exactly four visible drawing layers', () => {
    const { document, activeLayerId } = useDocumentStore.getState()
    expect(document.layers).toHaveLength(4)
    expect(document.layers.every((layer) => layer.visible && layer.opacity === 1)).toBe(true)
    expect(activeLayerId).toBe('layer-1')
  })

  it('commits, undoes, and redoes one stroke without losing it', () => {
    const operation = makeStrokeOperation('pressure', [
      { x: 10, y: 10, pressure: 0.4, time: 0 },
      { x: 100, y: 90, pressure: 0.8, time: 16 },
    ], 8, 50, false)
    useDocumentStore.getState().commitOperation(operation)
    expect(useDocumentStore.getState().document.layers[0]?.operations).toHaveLength(1)
    useDocumentStore.getState().undo()
    expect(useDocumentStore.getState().document.layers[0]?.operations).toHaveLength(0)
    useDocumentStore.getState().redo()
    expect(useDocumentStore.getState().document.layers[0]?.operations[0]?.id).toBe(operation.id)
  })

  it('keeps layer edits undoable and bounded', () => {
    useDocumentStore.getState().updateLayer('layer-1', { opacity: 0.35, visible: false })
    expect(useDocumentStore.getState().document.layers[0]).toMatchObject({ opacity: 0.35, visible: false })
    useDocumentStore.getState().undo()
    expect(useDocumentStore.getState().document.layers[0]).toMatchObject({ opacity: 1, visible: true })
  })

  it('keeps search revisions monotonic while excluding metadata-only edits', () => {
    const initialRevision = useDocumentStore.getState().document.revision
    useDocumentStore.getState().setTitle('Character study')
    expect(useDocumentStore.getState().document.revision).toBe(initialRevision)
    useDocumentStore.getState().updateLayer('layer-1', { name: 'Inks' })
    expect(useDocumentStore.getState().document.revision).toBe(initialRevision)
    useDocumentStore.getState().updateLayer('layer-1', { opacity: 0.5 })
    const contentRevision = useDocumentStore.getState().document.revision
    expect(contentRevision).toBeGreaterThan(initialRevision)
    useDocumentStore.getState().undo()
    expect(useDocumentStore.getState().document.revision).toBeGreaterThan(contentRevision)
  })

  it('emits recorder commands only for successful mutations', () => {
    const commands: string[] = []
    const store = createDocumentStore({ onCommand: (command) => commands.push(command.type) })
    store.getState().updateLayer('layer-1', { opacity: 1 })
    store.getState().moveLayer('layer-1', -1)
    store.getState().clearLayer('layer-1')
    store.getState().undo()
    expect(commands).toEqual([])
    store.getState().commitOperation(makeStrokeOperation('monoline', [{ x: 1, y: 1, pressure: 0.5, time: 0 }], 4, 0, false))
    expect(commands).toEqual(['operation_committed'])
  })
})

describe('document store structural sharing', () => {
  it('shares untouched layers and prior operations across a commit', () => {
    const store = createDocumentStore()
    const first = stroke('first')
    store.getState().commitOperation(first)
    const before = store.getState().document
    store.getState().commitOperation(stroke('second'))
    const after = store.getState().document

    expect(after).not.toBe(before)
    expect(after.layers[0]).not.toBe(before.layers[0])
    for (let index = 1; index < 4; index += 1) {
      expect(after.layers[index]).toBe(before.layers[index])
    }
    expect(after.layers[0]?.operations[0]).toBe(before.layers[0]?.operations[0])
  })

  it('shares the committed points array while copying the operation object', () => {
    const store = createDocumentStore()
    const first = stroke('first', 4)
    store.getState().commitOperation(first)
    const entry = store.getState().past[0]
    expect(entry?.kind).toBe('operation_appended')
    if (entry?.kind === 'operation_appended' && entry.operation.kind === 'stroke') {
      expect(entry.operation).not.toBe(first)
      expect(entry.operation.points).toBe(first.points)
    }
  })

  it('keeps the layers array shared for metadata-only changes', () => {
    const store = createDocumentStore()
    const layers = store.getState().document.layers

    store.getState().setTitle('Sketch')
    expect(store.getState().document.layers).toBe(layers)

    store.getState().updateTrace({ opacity: 0.5 })
    expect(store.getState().document.layers).toBe(layers)

    store.getState().setTrace('asset-1', 'blob:trace')
    expect(store.getState().document.layers).toBe(layers)

    store.getState().setResolvedTraceImage('blob:resolved')
    expect(store.getState().document.layers).toBe(layers)
  })

  it('shares sibling layers for a single-layer property edit', () => {
    const store = createDocumentStore()
    const before = store.getState().document.layers
    store.getState().updateLayer('layer-2', { opacity: 0.4 })
    const after = store.getState().document.layers
    expect(after[0]).toBe(before[0])
    expect(after[1]).not.toBe(before[1])
    expect(after[2]).toBe(before[2])
    expect(after[3]).toBe(before[3])
  })

  it('never mutates the document passed to replaceDocument', () => {
    const store = createDocumentStore()
    const incoming = structuredClone(store.getState().document)
    incoming.title = 'Imported'
    const snapshot = structuredClone(incoming)
    store.getState().replaceDocument(incoming)
    expect(incoming).toEqual(snapshot)
    expect(store.getState().document.title).toBe('Imported')
  })

  it('does not mutate previously committed operations', () => {
    const store = createDocumentStore()
    const first = stroke('first', 3)
    store.getState().commitOperation(first)
    const snapshot = structuredClone(first)
    store.getState().commitOperation(stroke('second'))
    expect(store.getState().document.layers[0]?.operations[0]).toEqual(snapshot)
  })
})

describe('document store history semantics', () => {
  it('undoes and redoes a layer move in both directions', () => {
    const store = createDocumentStore()
    store.getState().moveLayer('layer-1', 1)
    expect(store.getState().document.layers.map((layer) => layer.id)).toEqual(['layer-2', 'layer-1', 'layer-3', 'layer-4'])
    store.getState().undo()
    expect(store.getState().document.layers.map((layer) => layer.id)).toEqual(['layer-1', 'layer-2', 'layer-3', 'layer-4'])
    store.getState().redo()
    expect(store.getState().document.layers.map((layer) => layer.id)).toEqual(['layer-2', 'layer-1', 'layer-3', 'layer-4'])
  })

  it('restores every operation after clearing a layer', () => {
    const store = createDocumentStore()
    const first = stroke('first')
    const second = stroke('second')
    store.getState().commitOperation(first)
    store.getState().commitOperation(second)
    store.getState().clearLayer('layer-1')
    expect(operationsOf(store.getState().document, 0)).toHaveLength(0)
    store.getState().undo()
    expect(operationsOf(store.getState().document, 0).map((operation) => operation.id)).toEqual([first.id, second.id])
    store.getState().redo()
    expect(operationsOf(store.getState().document, 0)).toHaveLength(0)
  })

  it('restores truncated titles and ignores an unchanged title', () => {
    const store = createDocumentStore()
    const longTitle = 'x'.repeat(100)
    store.getState().setTitle(longTitle)
    expect(store.getState().document.title).toHaveLength(80)
    const state = store.getState()
    store.getState().setTitle(longTitle)
    expect(store.getState()).toBe(state)
    store.getState().undo()
    expect(store.getState().document.title).toBe('Untitled drawing')
    store.getState().redo()
    expect(store.getState().document.title).toBe('x'.repeat(80))
  })

  it('undoes and redoes trace commands without clobbering a resolved image', () => {
    const store = createDocumentStore()
    store.getState().setTrace('asset-1', 'blob:original')
    store.getState().updateTrace({ opacity: 0.5 })
    const historyLength = store.getState().past.length
    store.getState().setResolvedTraceImage('blob:resolved')
    expect(store.getState().past).toHaveLength(historyLength)
    expect(store.getState().document.trace.imageUrl).toBe('blob:resolved')

    store.getState().undo()
    expect(store.getState().document.trace).toMatchObject({ opacity: 0.3, imageUrl: 'blob:resolved' })
    store.getState().redo()
    expect(store.getState().document.trace).toMatchObject({ opacity: 0.5, imageUrl: 'blob:resolved' })

    store.getState().clearTrace()
    expect(store.getState().document.trace).toMatchObject({ assetId: null, imageUrl: null, visible: true })
    store.getState().undo()
    expect(store.getState().document.trace).toMatchObject({ assetId: 'asset-1', imageUrl: 'blob:resolved' })
    store.getState().redo()
    expect(store.getState().document.trace).toMatchObject({ assetId: null, imageUrl: null })
  })

  it('undoes and redoes visibility and scale updates', () => {
    const store = createDocumentStore()
    store.getState().updateTrace({ visible: false })
    store.getState().updateTrace({ scale: 2 })
    store.getState().undo()
    expect(store.getState().document.trace.scale).toBe(1)
    store.getState().undo()
    expect(store.getState().document.trace.visible).toBe(true)
    store.getState().redo()
    expect(store.getState().document.trace.visible).toBe(false)
    store.getState().redo()
    expect(store.getState().document.trace.scale).toBe(2)
  })

  it('resets history on replacement and creation', () => {
    const store = createDocumentStore()
    store.getState().commitOperation(stroke('first'))
    const incoming = structuredClone(store.getState().document)
    incoming.title = 'Restored'
    store.getState().replaceDocument(incoming)
    expect(store.getState().past).toHaveLength(0)
    expect(store.getState().future).toHaveLength(0)
    const replaced = store.getState()
    store.getState().undo()
    expect(store.getState()).toBe(replaced)

    store.getState().commitOperation(stroke('second'))
    store.getState().newDocument()
    expect(store.getState().past).toHaveLength(0)
    expect(store.getState().future).toHaveLength(0)
    expect(store.getState().document.layers.map((layer) => layer.id)).toEqual(['layer-1', 'layer-2', 'layer-3', 'layer-4'])
    expect(store.getState().activeLayerId).toBe('layer-1')
  })

  it('caps past and future by entry count and keeps the newest entry', () => {
    const store = createDocumentStore({ history: { maxEntries: 3 } })
    for (let index = 0; index < 5; index += 1) store.getState().commitOperation(stroke(`stroke-${index}`))
    expect(store.getState().past).toHaveLength(3)
    const retained = store.getState().past.map((entry) => entry.kind === 'operation_appended' ? entry.operation.id : '')
    expect(retained).toEqual(['stroke-2', 'stroke-3', 'stroke-4'])

    for (let index = 0; index < 5; index += 1) store.getState().undo()
    expect(store.getState().past).toHaveLength(0)
    expect(store.getState().future).toHaveLength(3)
    const redoable = store.getState().future.map((entry) => entry.kind === 'operation_appended' ? entry.operation.id : '')
    expect(redoable).toEqual(['stroke-2', 'stroke-3', 'stroke-4'])
  })

  it('enforces the byte budget while retaining the newest entry', () => {
    const store = createDocumentStore({ history: { maxBytes: 200 } })
    store.getState().commitOperation(stroke('first', 10))
    store.getState().commitOperation(stroke('second', 10))
    expect(store.getState().past).toHaveLength(1)
    const retained = store.getState().past[0]
    expect(retained?.kind === 'operation_appended' ? retained.operation.id : null).toBe('second')

    const tiny = createDocumentStore({ history: { maxBytes: 1 } })
    tiny.getState().commitOperation(stroke('only'))
    expect(tiny.getState().past).toHaveLength(1)
  })

  it('returns the same state for no-op actions', () => {
    const store = createDocumentStore()
    const state = store.getState()
    store.getState().updateLayer('layer-1', { opacity: 1 })
    store.getState().moveLayer('layer-1', -1)
    store.getState().moveLayer('missing', 1)
    store.getState().clearLayer('layer-1')
    store.getState().setTitle('Untitled drawing')
    store.getState().setResolvedTraceImage(null)
    store.getState().undo()
    store.getState().redo()
    expect(store.getState()).toBe(state)
  })
})

describe('document store round-trip equivalence', () => {
  it('replays every entry kind back to the initial state and forward again', () => {
    const store = createDocumentStore()
    const initial = structuredClone(store.getState().document)
    const snapshots: DrawingDocument[] = []

    const capture = () => {
      if (store.getState().past.length > snapshots.length) snapshots.push(structuredClone(store.getState().document))
    }

    for (let index = 0; index < 40; index += 1) {
      const state = store.getState()
      switch (index % 10) {
        case 0:
          store.getState().commitOperation(stroke(`stroke-${index}`))
          break
        case 1:
          store.getState().updateLayer('layer-1', { opacity: 0.1 + (index % 5) * 0.1 })
          break
        case 2: {
          const firstLayer = state.document.layers[0]
          if (firstLayer) store.getState().moveLayer(firstLayer.id, 1)
          break
        }
        case 3:
          store.getState().setTitle(`Sketch ${index}`)
          break
        case 4:
          store.getState().updateLayer('layer-2', { visible: index % 20 === 4 })
          break
        case 5:
          store.getState().commitOperation(stroke(`stroke-${index}`, 4))
          break
        case 6:
          store.getState().setTrace(`asset-${index}`, `blob:trace-${index}`)
          break
        case 7:
          store.getState().updateTrace({ scale: 1 + (index % 3) })
          break
        case 8:
          store.getState().clearTrace()
          break
        case 9:
          store.getState().clearLayer('layer-1')
          break
      }
      capture()
    }

    expect(snapshots.length).toBe(store.getState().past.length)
    expect(snapshots.length).toBeGreaterThan(20)

    for (let index = snapshots.length - 1; index >= 1; index -= 1) {
      store.getState().undo()
      expect(documentsEquivalent(store.getState().document, snapshots[index - 1]!)).toBe(true)
    }
    store.getState().undo()
    expect(documentsEquivalent(store.getState().document, initial)).toBe(true)

    for (let index = 0; index < snapshots.length; index += 1) {
      store.getState().redo()
      expect(documentsEquivalent(store.getState().document, snapshots[index]!)).toBe(true)
    }

    store.getState().commitOperation(stroke('after-redo'))
    expect(store.getState().future).toHaveLength(0)
    const beforeRedo = store.getState()
    store.getState().redo()
    expect(store.getState()).toBe(beforeRedo)
  })
})

describe('document store and recording replay', () => {
  it('produces the same document as replaying the emitted commands', () => {
    const commands: DocumentCommand[] = []
    const store = createDocumentStore({ onCommand: (command) => commands.push(command) })

    store.getState().setActiveLayer('layer-1')
    store.getState().commitOperation(stroke('one'))
    store.getState().updateLayer('layer-1', { opacity: 0.5 })
    store.getState().setActiveLayer('layer-2')
    store.getState().commitOperation(stroke('two'))
    store.getState().moveLayer('layer-2', -1)
    store.getState().clearLayer('layer-1')
    store.getState().undo()
    store.getState().redo()
    store.getState().commitOperation(stroke('three'))

    const bundle = {
      document: structuredClone(store.getState().document),
      events: commands.map((command, index) => ({
        seq: index,
        atMs: index,
        action: { type: 'document_mutation', command },
      })),
    } as unknown as DrawingSequenceCurrent

    expect(documentsEquivalent(store.getState().document, replaySequence(bundle))).toBe(true)
  })

  it('keeps retained history proportional to committed strokes', () => {
    const store = createDocumentStore()
    const first = stroke('first', 50)
    const perStroke = estimateOperationBytes(first)
    for (let index = 0; index < 20; index += 1) store.getState().commitOperation(stroke(`stroke-${index}`, 50))
    const retained = store.getState().past.reduce((sum, entry) => sum + entry.bytes, 0)
    expect(retained).toBeLessThanOrEqual(20 * perStroke * 2)
  })
})
