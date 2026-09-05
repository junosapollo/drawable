import { create } from 'zustand'
import type { ReferenceAsset, SearchResponse } from '../lib/types'

interface SearchState {
  generation: number
  drawing: boolean
  loading: boolean
  error: string | null
  response: SearchResponse | null
  textHint: string
  selectedStyle: string | null
  selectedAsset: ReferenceAsset | null
  pinned: ReferenceAsset[]
  invalidate: (drawing?: boolean) => number
  setDrawing: (drawing: boolean) => void
  setLoading: (loading: boolean) => void
  setResponse: (response: SearchResponse) => void
  setError: (error: string | null) => void
  setTextHint: (hint: string) => void
  setSelectedStyle: (style: string | null) => void
  setSelectedAsset: (asset: ReferenceAsset | null) => void
  togglePin: (asset: ReferenceAsset) => void
}

function readPins(): ReferenceAsset[] {
  try { return JSON.parse(localStorage.getItem('drawable-fixture-pins') ?? '[]') as ReferenceAsset[] }
  catch { return [] }
}

export const useSearchStore = create<SearchState>((set, get) => ({
  generation: 0,
  drawing: false,
  loading: false,
  error: null,
  response: null,
  textHint: '',
  selectedStyle: null,
  selectedAsset: null,
  pinned: readPins(),
  invalidate: (drawing = get().drawing) => {
    const generation = get().generation + 1
    set({ generation, drawing })
    return generation
  },
  setDrawing: (drawing) => set({ drawing }),
  setLoading: (loading) => set({ loading }),
  setResponse: (response) => set({ response, error: null, loading: false }),
  setError: (error) => set({ error, loading: false }),
  setTextHint: (textHint) => set((state) => ({ textHint: textHint.slice(0, 120), generation: state.generation + 1 })),
  setSelectedStyle: (selectedStyle) => set({ selectedStyle }),
  setSelectedAsset: (selectedAsset) => set({ selectedAsset }),
  togglePin: (asset) => set((state) => {
    const exists = state.pinned.some((item) => item.id === asset.id)
    const pinned = exists ? state.pinned.filter((item) => item.id !== asset.id) : [asset, ...state.pinned]
    localStorage.setItem('drawable-fixture-pins', JSON.stringify(pinned))
    return { pinned }
  }),
}))
