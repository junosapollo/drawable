import { create } from 'zustand'

interface ViewState {
  zoom: number
  panX: number
  panY: number
  fitRequest: number
  setView: (zoom: number, panX: number, panY: number) => void
  requestFit: () => void
}

export const useViewStore = create<ViewState>((set) => ({
  zoom: 0.32,
  panX: 0,
  panY: 0,
  fitRequest: 0,
  setView: (zoom, panX, panY) => set({ zoom: Math.min(8, Math.max(0.1, zoom)), panX, panY }),
  requestFit: () => set((state) => ({ fitRequest: state.fitRequest + 1 })),
}))
