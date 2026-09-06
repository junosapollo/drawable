import { create } from 'zustand'
import { uid } from '../lib/drawing'
import type { DrawingDocument, StrokeOperation, Tool } from '../lib/types'

const makeDocument = (): DrawingDocument => ({
  id: uid('document'),
  title: 'Untitled drawing',
  revision: 0,
  updatedAt: Date.now(),
  layers: Array.from({ length: 4 }, (_, index) => ({
    id: `layer-${index + 1}`,
    name: `Layer ${index + 1}`,
    visible: true,
    opacity: 1,
    operations: [],
  })),
  trace: {
    assetId: null,
    imageUrl: null,
    visible: true,
    opacity: 0.3,
    scale: 1,
  },
})

function cloneDocument(document: DrawingDocument): DrawingDocument {
  return structuredClone(document)
}

interface DocumentState {
  document: DrawingDocument
  past: DrawingDocument[]
  future: DrawingDocument[]
  activeLayerId: string
  activeTool: Tool
  brushSize: number
  stabilization: number
  simulatePressure: boolean
  hasHydrated: boolean
  setHydrated: (value: boolean) => void
  replaceDocument: (document: DrawingDocument, activeLayerId?: string) => void
  setTitle: (title: string) => void
  setTool: (tool: Tool) => void
  setBrushSize: (size: number) => void
  setStabilization: (value: number) => void
  setSimulatePressure: (value: boolean) => void
  setActiveLayer: (id: string) => void
  commitOperation: (operation: StrokeOperation) => void
  updateLayer: (id: string, update: { name?: string; visible?: boolean; opacity?: number }) => void
  moveLayer: (id: string, direction: -1 | 1) => void
  clearLayer: (id: string) => void
  setTrace: (assetId: string, imageUrl: string) => void
  updateTrace: (update: Partial<Pick<DrawingDocument['trace'], 'visible' | 'opacity' | 'scale'>>) => void
  clearTrace: () => void
  setResolvedTraceImage: (imageUrl: string | null) => void
  undo: () => void
  redo: () => void
  newDocument: () => void
}

function mutateDocument(
  state: DocumentState,
  mutation: (document: DrawingDocument) => void,
  affectsSearch = true,
): Pick<DocumentState, 'document' | 'past' | 'future'> {
  const next = cloneDocument(state.document)
  mutation(next)
  if (affectsSearch) next.revision += 1
  next.updatedAt = Date.now()
  return {
    document: next,
    past: [...state.past.slice(-499), state.document],
    future: [],
  }
}

export const useDocumentStore = create<DocumentState>((set) => ({
  document: makeDocument(),
  past: [],
  future: [],
  activeLayerId: 'layer-1',
  activeTool: 'pressure',
  brushSize: 12,
  stabilization: 50,
  simulatePressure: true,
  hasHydrated: false,
  setHydrated: (hasHydrated) => set({ hasHydrated }),
  replaceDocument: (document, activeLayerId) => set((state) => ({ document: { ...cloneDocument(document), revision: state.document.revision + 1 }, past: [], future: [], activeLayerId: document.layers.some((layer) => layer.id === activeLayerId) ? activeLayerId! : document.layers[0]?.id ?? 'layer-1' })),
  setTitle: (title) => set((state) => mutateDocument(state, (document) => { document.title = title.slice(0, 80) }, false)),
  setTool: (activeTool) => set({ activeTool }),
  setBrushSize: (brushSize) => set({ brushSize: Math.min(40, Math.max(1, brushSize)) }),
  setStabilization: (stabilization) => set({ stabilization: Math.min(100, Math.max(0, stabilization)) }),
  setSimulatePressure: (simulatePressure) => set({ simulatePressure }),
  setActiveLayer: (activeLayerId) => set({ activeLayerId }),
  commitOperation: (operation) => set((state) => mutateDocument(state, (document) => {
    document.layers.find((layer) => layer.id === state.activeLayerId)?.operations.push(operation)
  })),
  updateLayer: (id, update) => set((state) => mutateDocument(state, (document) => {
    const layer = document.layers.find((candidate) => candidate.id === id)
    if (!layer) return
    if (update.name !== undefined) layer.name = update.name.slice(0, 40)
    if (update.visible !== undefined) layer.visible = update.visible
    if (update.opacity !== undefined) layer.opacity = Math.min(1, Math.max(0, update.opacity))
  }, update.visible !== undefined || update.opacity !== undefined)),
  moveLayer: (id, direction) => set((state) => mutateDocument(state, (document) => {
    const index = document.layers.findIndex((layer) => layer.id === id)
    const target = index + direction
    if (index < 0 || target < 0 || target >= document.layers.length) return
    const [layer] = document.layers.splice(index, 1)
    if (layer) document.layers.splice(target, 0, layer)
  })),
  clearLayer: (id) => set((state) => mutateDocument(state, (document) => {
    const layer = document.layers.find((candidate) => candidate.id === id)
    if (layer) layer.operations = []
  })),
  setTrace: (assetId, imageUrl) => set((state) => mutateDocument(state, (document) => {
    document.trace = { ...document.trace, assetId, imageUrl, visible: true }
  }, false)),
  updateTrace: (update) => set((state) => mutateDocument(state, (document) => {
    document.trace = { ...document.trace, ...update }
  }, false)),
  clearTrace: () => set((state) => mutateDocument(state, (document) => {
    document.trace.assetId = null
    document.trace.imageUrl = null
  }, false)),
  setResolvedTraceImage: (imageUrl) => set((state) => ({ document: { ...state.document, trace: { ...state.document.trace, imageUrl } } })),
  undo: () => set((state) => {
    const previous = state.past.at(-1)
    if (!previous) return state
    return { document: { ...cloneDocument(previous), revision: state.document.revision + 1, updatedAt: Date.now() }, past: state.past.slice(0, -1), future: [state.document, ...state.future].slice(0, 500) }
  }),
  redo: () => set((state) => {
    const next = state.future[0]
    if (!next) return state
    return { document: { ...cloneDocument(next), revision: state.document.revision + 1, updatedAt: Date.now() }, past: [...state.past, state.document].slice(-500), future: state.future.slice(1) }
  }),
  newDocument: () => set((state) => ({ document: { ...makeDocument(), revision: state.document.revision + 1 }, past: [], future: [], activeLayerId: 'layer-1' })),
}))
