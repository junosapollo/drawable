import { create } from 'zustand'
import type { DockMode, ThemeChoice } from '../lib/types'

function initialTheme(): ThemeChoice {
  const saved = localStorage.getItem('drawable-theme')
  return saved === 'dark' || saved === 'light' || saved === 'system' ? saved : 'system'
}

interface UiState {
  theme: ThemeChoice
  dockMode: DockMode
  dockCollapsed: boolean
  dockWidth: number
  settingsOpen: boolean
  exportOpen: boolean
  importOpen: boolean
  shortcutsOpen: boolean
  setTheme: (theme: ThemeChoice) => void
  setDockMode: (mode: DockMode) => void
  setDockCollapsed: (collapsed: boolean) => void
  setDockWidth: (width: number) => void
  setSettingsOpen: (open: boolean) => void
  setExportOpen: (open: boolean) => void
  setImportOpen: (open: boolean) => void
  setShortcutsOpen: (open: boolean) => void
}

export const useUiStore = create<UiState>((set) => ({
  theme: initialTheme(),
  dockMode: 'references',
  dockCollapsed: false,
  dockWidth: Number(localStorage.getItem('drawable-dock-width')) || 400,
  settingsOpen: false,
  exportOpen: false,
  importOpen: false,
  shortcutsOpen: false,
  setTheme: (theme) => {
    localStorage.setItem('drawable-theme', theme)
    const dark = theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches)
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    set({ theme })
  },
  setDockMode: (dockMode) => set({ dockMode, dockCollapsed: false }),
  setDockCollapsed: (dockCollapsed) => set({ dockCollapsed }),
  setDockWidth: (value) => {
    const dockWidth = Math.min(520, Math.max(340, value))
    localStorage.setItem('drawable-dock-width', String(dockWidth))
    set({ dockWidth })
  },
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setExportOpen: (exportOpen) => set({ exportOpen }),
  setImportOpen: (importOpen) => set({ importOpen }),
  setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),
}))
