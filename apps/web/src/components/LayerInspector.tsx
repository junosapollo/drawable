import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, Eye, EyeOff, Trash2, X } from 'lucide-react'
import * as Slider from '@radix-ui/react-slider'
import { renderOperation } from '../lib/drawing'
import type { DrawingLayer } from '../lib/types'
import { useDocumentStore } from '../state/documentStore'
import { useUiStore } from '../state/uiStore'
import { AppDialog, Button, IconButton } from './primitives'

function LayerThumbnail({ layer }: { layer: DrawingLayer }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    if (!canvas || !context) return
    context.clearRect(0, 0, canvas.width, canvas.height)
    context.save()
    context.scale(canvas.width / 2048, canvas.height / 2048)
    for (const operation of layer.operations) renderOperation(context, operation)
    context.restore()
  }, [layer])
  return <canvas ref={canvasRef} className="layer-thumbnail" width={56} height={56} aria-hidden="true" />
}

function LayerNameInput({ layer, onCommit }: { layer: DrawingLayer; onCommit: (name: string) => void }) {
  const [draft, setDraft] = useState(layer.name)
  useEffect(() => setDraft(layer.name), [layer.name])
  const commit = () => {
    const name = draft.trim() || layer.name
    setDraft(name)
    if (name !== layer.name) onCommit(name)
  }
  return (
    <input
      aria-label={`Name ${layer.name}`}
      value={draft}
      onClick={(event) => event.stopPropagation()}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur()
        if (event.key === 'Escape') { setDraft(layer.name); event.currentTarget.blur() }
      }}
    />
  )
}

function CommitSlider({ value, label, min = 0, max = 100, onCommit }: { value: number; label: string; min?: number; max?: number; onCommit: (value: number) => void }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  return (
    <>
      <Slider.Root min={min} max={max} step={1} value={[draft]} onValueChange={(next) => setDraft(next[0] ?? draft)} onValueCommit={(next) => onCommit(next[0] ?? draft)}>
        <Slider.Track><Slider.Range /></Slider.Track><Slider.Thumb aria-label={label} /></Slider.Root>
      <output>{Math.round(draft)}%</output>
    </>
  )
}

export function LayerInspector() {
  const document = useDocumentStore((state) => state.document)
  const activeLayerId = useDocumentStore((state) => state.activeLayerId)
  const setActiveLayer = useDocumentStore((state) => state.setActiveLayer)
  const updateLayer = useDocumentStore((state) => state.updateLayer)
  const moveLayer = useDocumentStore((state) => state.moveLayer)
  const clearLayer = useDocumentStore((state) => state.clearLayer)
  const updateTrace = useDocumentStore((state) => state.updateTrace)
  const clearTrace = useDocumentStore((state) => state.clearTrace)
  const setDockMode = useUiStore((state) => state.setDockMode)
  const [clearId, setClearId] = useState<string | null>(null)
  const clearTarget = document.layers.find((layer) => layer.id === clearId)

  return (
    <div className="layer-inspector">
      <header className="dock-header">
        <div><span className="dock-eyebrow">Document</span><h2>Layers</h2></div>
        <IconButton label="Close layers" onClick={() => setDockMode('references')}><X size={17} /></IconButton>
      </header>
      <div className="layer-list">
        {document.layers.map((layer, index) => (
          <article
            key={layer.id}
            className={`layer-row ${layer.id === activeLayerId ? 'is-active' : ''}`}
            onClick={() => setActiveLayer(layer.id)}
          >
            <IconButton label={layer.visible ? `Hide ${layer.name}` : `Show ${layer.name}`} onClick={(event) => { event.stopPropagation(); updateLayer(layer.id, { visible: !layer.visible }) }}>
              {layer.visible ? <Eye size={16} /> : <EyeOff size={16} />}
            </IconButton>
            <LayerThumbnail layer={layer} />
            <div className="layer-row__content">
              <LayerNameInput layer={layer} onCommit={(name) => updateLayer(layer.id, { name })} />
              <div className="layer-opacity">
                <span>Opacity</span>
                <CommitSlider value={layer.opacity * 100} label={`${layer.name} opacity`} onCommit={(value) => updateLayer(layer.id, { opacity: value / 100 })} />
              </div>
            </div>
            <div className="layer-actions">
              <IconButton label="Move layer up" size="small" disabled={index === 0} onClick={(event) => { event.stopPropagation(); moveLayer(layer.id, -1) }}><ChevronUp size={14} /></IconButton>
              <IconButton label="Move layer down" size="small" disabled={index === document.layers.length - 1} onClick={(event) => { event.stopPropagation(); moveLayer(layer.id, 1) }}><ChevronDown size={14} /></IconButton>
              <IconButton label={`Clear ${layer.name}`} size="small" disabled={!layer.operations.length} onClick={(event) => { event.stopPropagation(); setClearId(layer.id) }}><Trash2 size={14} /></IconButton>
            </div>
          </article>
        ))}
      </div>
      <section className="trace-row">
        <div className="trace-row__heading">
          <div>
            <span className="dock-eyebrow">Reference</span>
            <strong>Trace layer</strong>
          </div>
          <IconButton label={document.trace.visible ? 'Hide trace' : 'Show trace'} disabled={!document.trace.imageUrl} onClick={() => updateTrace({ visible: !document.trace.visible })}>
            {document.trace.visible ? <Eye size={16} /> : <EyeOff size={16} />}
          </IconButton>
        </div>
        {document.trace.imageUrl ? (
          <>
            <label className="layer-opacity layer-opacity--trace">
              <span>Opacity</span>
              <CommitSlider value={document.trace.opacity * 100} label="Trace opacity" onCommit={(value) => updateTrace({ opacity: value / 100 })} />
            </label>
            <label className="layer-opacity layer-opacity--trace">
              <span>Scale</span>
              <CommitSlider value={document.trace.scale * 100} min={25} max={200} label="Trace scale" onCommit={(value) => updateTrace({ scale: value / 100 })} />
            </label>
            <Button className="button--quiet" onClick={clearTrace}>Remove trace</Button>
          </>
        ) : <p className="muted-copy">Choose Trace on a reference to place it behind the drawing.</p>}
      </section>
      <AppDialog open={Boolean(clearId)} onOpenChange={(open) => { if (!open) setClearId(null) }} title={`Clear ${clearTarget?.name ?? 'layer'}?`} description="This removes every mark on the layer. You can undo it afterward.">
        <div className="dialog-actions">
          <Button onClick={() => setClearId(null)}>Cancel</Button>
          <Button className="button--danger" onClick={() => { if (clearId) clearLayer(clearId); setClearId(null) }}>Clear layer</Button>
        </div>
      </AppDialog>
    </div>
  )
}
