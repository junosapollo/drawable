import { useEffect, useState } from 'react'
import {
  Download,
  Scan,
  Layers3,
  Moon,
  Redo2,
  Settings2,
  Sun,
  Undo2,
} from 'lucide-react'
import * as Slider from '@radix-ui/react-slider'
import { WorkspaceSwitcher } from './AppChrome'
import { IconButton, StatusDot } from './primitives'
import { useDocumentStore } from '../state/documentStore'
import { useUiStore } from '../state/uiStore'
import { useViewStore } from '../state/viewStore'
import { useSearchStore } from '../state/searchStore'

export function AppBar({ saveState }: { saveState: 'saved' | 'saving' | 'error' }) {
  const document = useDocumentStore((state) => state.document)
  const past = useDocumentStore((state) => state.past)
  const future = useDocumentStore((state) => state.future)
  const setTitle = useDocumentStore((state) => state.setTitle)
  const undo = useDocumentStore((state) => state.undo)
  const redo = useDocumentStore((state) => state.redo)
  const brushSize = useDocumentStore((state) => state.brushSize)
  const stabilization = useDocumentStore((state) => state.stabilization)
  const setBrushSize = useDocumentStore((state) => state.setBrushSize)
  const setStabilization = useDocumentStore((state) => state.setStabilization)
  const activeLayerId = useDocumentStore((state) => state.activeLayerId)
  const dockMode = useUiStore((state) => state.dockMode)
  const setDockMode = useUiStore((state) => state.setDockMode)
  const setExportOpen = useUiStore((state) => state.setExportOpen)
  const setSettingsOpen = useUiStore((state) => state.setSettingsOpen)
  const theme = useUiStore((state) => state.theme)
  const setTheme = useUiStore((state) => state.setTheme)
  const zoom = useViewStore((state) => state.zoom)
  const requestFit = useViewStore((state) => state.requestFit)
  const loading = useSearchStore((state) => state.loading)
  const response = useSearchStore((state) => state.response)
  const [titleDraft, setTitleDraft] = useState(document.title)

  useEffect(() => setTitleDraft(document.title), [document.title])
  const activeLayer = document.layers.find((layer) => layer.id === activeLayerId)
  const status = loading ? 'Finding references' : response?.mode === 'confident' ? 'References ready' : saveState === 'error' ? 'Autosave failed' : saveState === 'saving' ? 'Saving' : 'Saved locally'

  return (
    <header className="app-bar">
      <WorkspaceSwitcher />
      <div className="document-cluster">
        <input
          className="document-title"
          aria-label="Document name"
          value={titleDraft}
          onChange={(event) => setTitleDraft(event.target.value)}
          onBlur={() => { if (titleDraft.trim() && titleDraft !== document.title) setTitle(titleDraft.trim()) }}
          onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}
        />
        <span className="document-meta">2048 × 2048</span>
      </div>
      <div className="history-controls">
        <IconButton label="Undo · Ctrl Z" size="small" disabled={!past.length} onClick={undo}><Undo2 size={16} /></IconButton>
        <IconButton label="Redo · Ctrl Shift Z" size="small" disabled={!future.length} onClick={redo}><Redo2 size={16} /></IconButton>
      </div>
      <div className="context-controls">
        <label className="toolbar-slider">
          <span>Size</span>
          <Slider.Root min={1} max={40} step={1} value={[brushSize]} onValueChange={(value) => setBrushSize(value[0] ?? brushSize)}>
            <Slider.Track><Slider.Range /></Slider.Track><Slider.Thumb aria-label="Brush size" />
          </Slider.Root>
          <output>{brushSize}</output>
        </label>
        <label className="toolbar-slider toolbar-slider--wide">
          <span>Steady</span>
          <Slider.Root min={0} max={100} step={1} value={[stabilization]} onValueChange={(value) => setStabilization(value[0] ?? stabilization)}>
            <Slider.Track><Slider.Range /></Slider.Track><Slider.Thumb aria-label="Stabilization" />
          </Slider.Root>
          <output>{stabilization}</output>
        </label>
      </div>
      <div className="app-actions">
        <button className={`layer-summary ${dockMode === 'layers' ? 'is-active' : ''}`} onClick={() => setDockMode(dockMode === 'layers' ? 'references' : 'layers')}>
          <Layers3 size={16} /><span>{activeLayer?.name ?? 'Layer'}</span>
        </button>
        <IconButton label="Fit canvas · 0" size="small" onClick={requestFit}><Scan size={16} /></IconButton>
        <span className="zoom-value">{Math.round(zoom * 100)}%</span>
        <span className="save-status"><StatusDot tone={saveState === 'error' ? 'error' : loading ? 'warning' : 'success'} />{status}</span>
        <IconButton label="Export drawing" size="small" onClick={() => setExportOpen(true)}><Download size={16} /></IconButton>
        <IconButton label="Toggle theme" size="small" onClick={() => setTheme(globalThis.document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark')}>
          {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
        </IconButton>
        <IconButton label="Settings" size="small" onClick={() => setSettingsOpen(true)}><Settings2 size={16} /></IconButton>
      </div>
    </header>
  )
}
