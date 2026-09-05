import { Brush, Eraser, Eye, EyeOff, Hand, PenTool, Redo2, SlidersHorizontal, Undo2 } from 'lucide-react'
import { IconButton } from './primitives'
import { useDocumentStore } from '../state/documentStore'
import { useUiStore } from '../state/uiStore'

export function ToolRail() {
  const activeTool = useDocumentStore((state) => state.activeTool)
  const setTool = useDocumentStore((state) => state.setTool)
  const traceVisible = useDocumentStore((state) => state.document.trace.visible)
  const hasTrace = useDocumentStore((state) => Boolean(state.document.trace.imageUrl))
  const updateTrace = useDocumentStore((state) => state.updateTrace)
  const setSettingsOpen = useUiStore((state) => state.setSettingsOpen)
  const undo = useDocumentStore((state) => state.undo)
  const redo = useDocumentStore((state) => state.redo)
  const canUndo = useDocumentStore((state) => state.past.length > 0)
  const canRedo = useDocumentStore((state) => state.future.length > 0)

  return (
    <nav className="tool-rail" aria-label="Drawing tools">
      <div className="tool-group">
        <IconButton label="Pressure brush · B" active={activeTool === 'pressure'} onClick={() => setTool('pressure')}>
          <Brush size={19} />
        </IconButton>
        <IconButton label="Monoline brush · M" active={activeTool === 'monoline'} onClick={() => setTool('monoline')}>
          <PenTool size={19} />
        </IconButton>
        <IconButton label="Vector eraser · E" active={activeTool === 'eraser'} onClick={() => setTool('eraser')}>
          <Eraser size={19} />
        </IconButton>
        <IconButton label="Hand tool · hold Space" active={activeTool === 'hand'} onClick={() => setTool('hand')}>
          <Hand size={19} />
        </IconButton>
      </div>
      <div className="tool-group tool-group--secondary">
        <IconButton className="portrait-history" label="Undo" disabled={!canUndo} onClick={undo}><Undo2 size={19} /></IconButton>
        <IconButton className="portrait-history" label="Redo" disabled={!canRedo} onClick={redo}><Redo2 size={19} /></IconButton>
        <IconButton label="Brush settings" onClick={() => setSettingsOpen(true)}>
          <SlidersHorizontal size={19} />
        </IconButton>
        <IconButton
          label={traceVisible ? 'Hide trace · H' : 'Show trace · H'}
          active={hasTrace && traceVisible}
          disabled={!hasTrace}
          onClick={() => updateTrace({ visible: !traceVisible })}
        >
          {traceVisible ? <Eye size={19} /> : <EyeOff size={19} />}
        </IconButton>
      </div>
    </nav>
  )
}
