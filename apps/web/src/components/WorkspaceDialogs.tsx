import { useState } from 'react'
import { Download, ExternalLink, FileUp, Keyboard, LoaderCircle, MonitorCog } from 'lucide-react'
import * as Slider from '@radix-ui/react-slider'
import { AppDialog, Button, Field } from './primitives'
import { useUiStore } from '../state/uiStore'
import { useDocumentStore } from '../state/documentStore'
import { exportPng, exportSvg } from '../lib/exportDocument'
import type { DrawingDocument, ThemeChoice } from '../lib/types'
import { exportDrawableProject, prepareImport } from '../lib/projectFiles'
import { stageImport } from '../services/persistence'

export function WorkspaceDialogs() {
  const settingsOpen = useUiStore((state) => state.settingsOpen)
  const exportOpen = useUiStore((state) => state.exportOpen)
  const importOpen = useUiStore((state) => state.importOpen)
  const shortcutsOpen = useUiStore((state) => state.shortcutsOpen)
  const setSettingsOpen = useUiStore((state) => state.setSettingsOpen)
  const setExportOpen = useUiStore((state) => state.setExportOpen)
  const setImportOpen = useUiStore((state) => state.setImportOpen)
  const setShortcutsOpen = useUiStore((state) => state.setShortcutsOpen)
  const theme = useUiStore((state) => state.theme)
  const setTheme = useUiStore((state) => state.setTheme)
  const brushSize = useDocumentStore((state) => state.brushSize)
  const stabilization = useDocumentStore((state) => state.stabilization)
  const simulatePressure = useDocumentStore((state) => state.simulatePressure)
  const setBrushSize = useDocumentStore((state) => state.setBrushSize)
  const setStabilization = useDocumentStore((state) => state.setStabilization)
  const setSimulatePressure = useDocumentStore((state) => state.setSimulatePressure)
  const document = useDocumentStore((state) => state.document)
  const activeLayerId = useDocumentStore((state) => state.activeLayerId)
  const [exportError, setExportError] = useState<string | null>(null)

  const runExport = async (action: () => Promise<void>) => {
    setExportError(null)
    try {
      await action()
      setExportOpen(false)
    } catch (error) {
      setExportError(error instanceof Error ? error.message : 'The drawing could not be exported.')
    }
  }

  return (
    <>
      <AppDialog open={settingsOpen} onOpenChange={setSettingsOpen} title="Workspace settings" description="Drawing input and appearance are stored locally on this device.">
        <div className="settings-sections">
          <section><h3><MonitorCog size={16} />Appearance</h3><div className="segmented-control">{(['system', 'dark', 'light'] as ThemeChoice[]).map((choice) => <button key={choice} className={theme === choice ? 'is-active' : ''} onClick={() => setTheme(choice)}>{choice}</button>)}</div></section>
          <section>
            <h3>Brush</h3>
            <Field label="Size" value={`${brushSize} px`}><Slider.Root min={1} max={40} value={[brushSize]} onValueChange={(value) => setBrushSize(value[0] ?? brushSize)}><Slider.Track><Slider.Range /></Slider.Track><Slider.Thumb /></Slider.Root></Field>
            <Field label="Stabilization" value={`${stabilization}%`}><Slider.Root min={0} max={100} value={[stabilization]} onValueChange={(value) => setStabilization(value[0] ?? stabilization)}><Slider.Track><Slider.Range /></Slider.Track><Slider.Thumb /></Slider.Root></Field>
            <label className="switch-row"><span><strong>Simulated pressure</strong><small>Use velocity-based pressure for mouse input.</small></span><input type="checkbox" checked={simulatePressure} onChange={(event) => setSimulatePressure(event.target.checked)} /></label>
          </section>
          <button className="text-action" onClick={() => { setSettingsOpen(false); setShortcutsOpen(true) }}><Keyboard size={16} />View keyboard shortcuts</button>
        </div>
      </AppDialog>
      <ImportDialog open={importOpen} onOpenChange={setImportOpen} />
      <AppDialog open={exportOpen} onOpenChange={(open) => { setExportOpen(open); if (open) setExportError(null) }} title="Export drawing" description="The reference trace image is never embedded.">
        <div className="export-options">
          <ExportOption title="drawable project · Editable" detail="Layers, strokes, and imported artwork" onClick={() => runExport(() => exportDrawableProject(document, activeLayerId))} />
          <ExportOption title="PNG · White background" detail="2048 × 2048 raster" onClick={() => runExport(() => exportPng(document, false))} />
          <ExportOption title="PNG · Transparent" detail="2048 × 2048 raster" onClick={() => runExport(() => exportPng(document, true))} />
          <ExportOption title="SVG" detail="Vector strokes, imported artwork, and erase masks" onClick={() => runExport(() => exportSvg(document))} />
          {exportError ? <p className="dialog-error" role="alert">{exportError}</p> : null}
        </div>
      </AppDialog>
      <AppDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} title="Keyboard shortcuts">
        <div className="shortcut-grid">
          {[['B', 'Pressure brush'], ['M', 'Monoline'], ['E', 'Eraser'], ['Space', 'Pan'], ['0', 'Fit canvas'], ['[  ]', 'Brush size'], ['Ctrl Z', 'Undo'], ['Ctrl Shift Z', 'Redo']].map(([key, action]) => <div key={key}><kbd>{key}</kbd><span>{action}</span></div>)}
        </div>
      </AppDialog>
    </>
  )
}

function ExportOption({ title, detail, onClick }: { title: string; detail: string; onClick: () => void | Promise<void> }) {
  return <Button className="export-option" onClick={onClick}><Download size={18} /><span><strong>{title}</strong><small>{detail}</small></span></Button>
}

function ImportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [state, setState] = useState<'idle' | 'validating' | 'ready' | 'error'>('idle')
  const [message, setMessage] = useState('')
  const [token, setToken] = useState<string | null>(null)
  const reset = () => { setState('idle'); setMessage(''); setToken(null) }
  const handleFile = async (file: File | undefined) => {
    if (!file) return
    setState('validating')
    setMessage(`Checking ${file.name}…`)
    setToken(null)
    try {
      const prepared = await prepareImport(file)
      const nextToken = await stageImport(prepared)
      setToken(nextToken)
      setMessage(`${file.name} is ready to open as an independent drawing.`)
      setState('ready')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The selected sketch could not be imported.')
      setState('error')
    }
  }
  return (
    <AppDialog
      open={open}
      onOpenChange={(next) => { onOpenChange(next); if (!next) reset() }}
      title="Import sketch"
      description="Open an editable drawable project, PNG, or self-contained SVG in a new tab."
    >
      <div className="import-panel">
        <label className="file-picker">
          <input
            type="file"
            accept=".drawable,application/vnd.drawable.project+json,image/png,image/svg+xml"
            disabled={state === 'validating'}
            onChange={(event) => { void handleFile(event.target.files?.[0]); event.currentTarget.value = '' }}
          />
          <FileUp size={20} />
          <span><strong>{state === 'ready' ? 'Choose another file' : 'Choose a sketch'}</strong><small>.drawable, PNG, or SVG</small></span>
        </label>
        {state !== 'idle' ? (
          <div className={`import-result import-result--${state}`} role={state === 'error' ? 'alert' : 'status'}>
            {state === 'validating' ? <LoaderCircle className="spin" size={17} /> : <span className="status-dot" />}
            <span>{message}</span>
          </div>
        ) : null}
        {state === 'ready' && token ? (
          <a className="button button--primary import-open" href={`/draw?import=${encodeURIComponent(token)}`} target="_blank" rel="noopener noreferrer">
            <ExternalLink size={16} />Open imported sketch
          </a>
        ) : null}
        <p className="import-footnote">Your current drawing stays open and unchanged in this tab.</p>
      </div>
    </AppDialog>
  )
}

export function RestoreDialog({ document, onRestore, onDiscard }: { document: DrawingDocument | null; onRestore: () => void; onDiscard: () => void }) {
  return (
    <AppDialog open={Boolean(document)} onOpenChange={(open) => { if (!open) onDiscard() }} title="Continue your last drawing?" description={document ? `${document.title} · saved ${new Date(document.updatedAt).toLocaleString()}` : undefined}>
      <div className="dialog-actions">
        <Button onClick={onDiscard}>Start new</Button>
        <Button className="button--primary" onClick={onRestore}>Restore drawing</Button>
      </div>
    </AppDialog>
  )
}
