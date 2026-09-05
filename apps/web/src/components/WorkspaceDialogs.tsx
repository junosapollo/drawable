import { Download, Keyboard, MonitorCog } from 'lucide-react'
import * as Slider from '@radix-ui/react-slider'
import { AppDialog, Button, Field } from './primitives'
import { useUiStore } from '../state/uiStore'
import { useDocumentStore } from '../state/documentStore'
import { exportPng, exportSvg } from '../lib/exportDocument'
import type { DrawingDocument, ThemeChoice } from '../lib/types'

export function WorkspaceDialogs() {
  const settingsOpen = useUiStore((state) => state.settingsOpen)
  const exportOpen = useUiStore((state) => state.exportOpen)
  const shortcutsOpen = useUiStore((state) => state.shortcutsOpen)
  const setSettingsOpen = useUiStore((state) => state.setSettingsOpen)
  const setExportOpen = useUiStore((state) => state.setExportOpen)
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
      <AppDialog open={exportOpen} onOpenChange={setExportOpen} title="Export drawing" description="The reference trace is always excluded.">
        <div className="export-options">
          <ExportOption title="PNG · White background" detail="2048 × 2048 raster" onClick={() => { exportPng(document, false); setExportOpen(false) }} />
          <ExportOption title="PNG · Transparent" detail="2048 × 2048 raster" onClick={() => { exportPng(document, true); setExportOpen(false) }} />
          <ExportOption title="SVG" detail="Vector strokes with erase masks" onClick={() => { exportSvg(document); setExportOpen(false) }} />
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

function ExportOption({ title, detail, onClick }: { title: string; detail: string; onClick: () => void }) {
  return <Button className="export-option" onClick={onClick}><Download size={18} /><span><strong>{title}</strong><small>{detail}</small></span></Button>
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
