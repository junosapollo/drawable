import { beforeEach, describe, expect, it } from 'vitest'
import { makeStrokeOperation } from '../lib/drawing'
import { useDocumentStore } from './documentStore'

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
})
