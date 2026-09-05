import { useMemo, useRef } from 'react'
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Image as ImageIcon,
  Layers3,
  Pin,
  PinOff,
  RefreshCw,
  Search,
  Sparkles,
  X,
} from 'lucide-react'
import { IconButton, StatusDot } from './primitives'
import { LayerInspector } from './LayerInspector'
import { useSearchStore } from '../state/searchStore'
import { useDocumentStore } from '../state/documentStore'
import { useUiStore } from '../state/uiStore'
import type { ReferenceAsset, ReferenceGroup } from '../lib/types'

const styleOptions = ['Manga / anime', 'Western ink', 'Realistic', 'Cartoon', 'Gesture']

function ReferenceCard({ asset }: { asset: ReferenceAsset }) {
  const selected = useSearchStore((state) => state.selectedAsset?.id === asset.id)
  const pinned = useSearchStore((state) => state.pinned.some((item) => item.id === asset.id))
  const setSelectedAsset = useSearchStore((state) => state.setSelectedAsset)
  const togglePin = useSearchStore((state) => state.togglePin)
  const setTrace = useDocumentStore((state) => state.setTrace)

  return (
    <article className={`reference-card ${selected ? 'is-selected' : ''}`}>
      <button className="reference-card__media" onClick={() => setSelectedAsset(asset)} aria-label={`View ${asset.title}`}>
        <img src={asset.imageUrl} alt={asset.title} draggable={false} />
        <span className="match-badge">{asset.match}</span>
      </button>
      <div className="reference-card__meta">
        <button className="reference-card__title" onClick={() => setSelectedAsset(asset)}>{asset.title}</button>
        <span>{asset.style}</span>
      </div>
      <div className="reference-card__actions">
        <span>{asset.native ? 'Native' : 'Extracted'}</span>
        <IconButton label={pinned ? 'Unpin reference' : 'Pin reference'} size="small" onClick={() => togglePin(asset)}>
          {pinned ? <PinOff size={14} /> : <Pin size={14} />}
        </IconButton>
        <IconButton label="Place on trace layer" size="small" disabled={!asset.traceAllowed} onClick={() => setTrace(asset.id, asset.imageUrl)}>
          <Layers3 size={14} />
        </IconButton>
      </div>
    </article>
  )
}

function ReferenceSection({ group }: { group: ReferenceGroup }) {
  return (
    <section className="reference-section">
      <header>
        <div>
          <h3>{group.title}</h3>
          {group.tentative ? <span className="tentative-label">Tentative</span> : null}
        </div>
        <span>{group.results.length}</span>
      </header>
      <div className="reference-grid">
        {group.results.map((asset) => <ReferenceCard asset={asset} key={asset.id} />)}
      </div>
    </section>
  )
}

function ReferenceDetail({ asset }: { asset: ReferenceAsset }) {
  const setSelectedAsset = useSearchStore((state) => state.setSelectedAsset)
  const pinned = useSearchStore((state) => state.pinned.some((item) => item.id === asset.id))
  const togglePin = useSearchStore((state) => state.togglePin)
  const setTrace = useDocumentStore((state) => state.setTrace)
  return (
    <section className="reference-detail">
      <header>
        <IconButton label="Back to reference grid" onClick={() => setSelectedAsset(null)}><ArrowLeft size={17} /></IconButton>
        <div><span className="dock-eyebrow">Selected reference</span><h2>{asset.title}</h2></div>
        <IconButton label="Close selected reference" onClick={() => setSelectedAsset(null)}><X size={17} /></IconButton>
      </header>
      <div className="reference-detail__media"><img src={asset.imageUrl} alt={asset.title} /></div>
      <dl>
        <div><dt>Style</dt><dd>{asset.style}</dd></div>
        <div><dt>Scope</dt><dd>{asset.scope}</dd></div>
        <div><dt>Source</dt><dd>{asset.source}</dd></div>
        <div><dt>Artwork</dt><dd>{asset.native ? 'Native line art' : 'Extracted line art'}</dd></div>
      </dl>
      <div className="reference-detail__actions">
        <button className="button" onClick={() => togglePin(asset)}>{pinned ? <PinOff size={15} /> : <Pin size={15} />}{pinned ? 'Unpin' : 'Pin'}</button>
        <button className="button button--primary" disabled={!asset.traceAllowed} onClick={() => setTrace(asset.id, asset.imageUrl)}><Layers3 size={15} />Trace</button>
        <a className="button" href={asset.imageUrl} target="_blank" rel="noreferrer"><ExternalLink size={15} />Open</a>
      </div>
    </section>
  )
}

export function ReferenceDock() {
  const dockMode = useUiStore((state) => state.dockMode)
  const setDockMode = useUiStore((state) => state.setDockMode)
  const dockCollapsed = useUiStore((state) => state.dockCollapsed)
  const setDockCollapsed = useUiStore((state) => state.setDockCollapsed)
  const response = useSearchStore((state) => state.response)
  const loading = useSearchStore((state) => state.loading)
  const error = useSearchStore((state) => state.error)
  const textHint = useSearchStore((state) => state.textHint)
  const setTextHint = useSearchStore((state) => state.setTextHint)
  const selectedStyle = useSearchStore((state) => state.selectedStyle)
  const setSelectedStyle = useSearchStore((state) => state.setSelectedStyle)
  const selectedAsset = useSearchStore((state) => state.selectedAsset)
  const pinned = useSearchStore((state) => state.pinned)
  const invalidate = useSearchStore((state) => state.invalidate)
  const scrollRef = useRef<HTMLDivElement>(null)

  const groups = useMemo(() => {
    if (!response) return []
    if (!selectedStyle || response.mode !== 'confident') return response.groups
    const best = response.groups.find((group) => group.id === 'best')
    const rest = response.groups.filter((group) => group.id !== 'best')
    rest.sort((left, right) => Number(right.title === selectedStyle) - Number(left.title === selectedStyle))
    return best ? [best, ...rest] : rest
  }, [response, selectedStyle])

  if (dockMode === 'layers') return <aside className="reference-dock layer-dock"><LayerInspector /></aside>

  if (dockCollapsed) {
    return (
      <aside className="reference-dock reference-dock--collapsed">
        <button className="collapsed-dock-button" onClick={() => setDockCollapsed(false)}><ImageIcon size={18} /><span>References</span><ChevronRight size={16} /></button>
      </aside>
    )
  }

  const empty = !response || response.mode === 'empty'
  return (
    <aside className={`reference-dock ${selectedAsset ? 'has-selection' : ''}`}>
      <div className="reference-dock__toolbar">
        <div><span className="dock-eyebrow">Live copilot</span><h2>References</h2></div>
        <div className="reference-toolbar-actions">
          <IconButton label="Layers" onClick={() => setDockMode('layers')}><Layers3 size={17} /></IconButton>
          <IconButton label="Collapse references" onClick={() => setDockCollapsed(true)}><ChevronDown size={17} /></IconButton>
        </div>
      </div>
      <div className="reference-query">
        <label>
          <Search size={15} />
          <input value={textHint} onChange={(event) => setTextHint(event.target.value)} placeholder="Optional hint…" aria-label="Reference text hint" />
          {textHint ? <button aria-label="Clear hint" onClick={() => setTextHint('')}><X size={14} /></button> : null}
        </label>
        <div className="style-chips" aria-label="Preferred style">
          <button className={!selectedStyle ? 'is-active' : ''} onClick={() => setSelectedStyle(null)}>All</button>
          {styleOptions.map((style) => <button key={style} className={selectedStyle === style ? 'is-active' : ''} onClick={() => setSelectedStyle(style)}>{style.split(' ')[0]}</button>)}
        </div>
      </div>
      <div className="reference-status" role="status">
        <span><StatusDot tone={error ? 'error' : loading ? 'warning' : response?.mode === 'confident' ? 'success' : 'neutral'} />{error ? 'Search interrupted' : loading ? 'Looking at your drawing…' : response?.interpretation ?? 'Waiting for marks'}</span>
        <span className="fixture-badge">Fixture</span>
      </div>
      {selectedAsset ? <ReferenceDetail asset={selectedAsset} /> : null}
      <div className="reference-scroll" ref={scrollRef}>
        {error ? (
          <div className="dock-empty"><RefreshCw size={22} /><h3>References are unavailable</h3><p>{error}</p><button className="button" onClick={() => invalidate()}>Try again</button></div>
        ) : empty ? (
          <div className="dock-empty"><Sparkles size={24} /><h3>Start drawing</h3><p>Reference ideas will appear here after each finished stroke.</p></div>
        ) : response?.mode === 'insufficient' ? (
          <div className="dock-empty"><ImageIcon size={24} /><h3>Keep drawing</h3><p>There isn’t enough information for a useful reference yet.</p></div>
        ) : (
          <>
            {groups.map((group) => <ReferenceSection group={group} key={group.id} />)}
            {pinned.length ? <ReferenceSection group={{ id: 'pinned', title: 'Pinned', results: pinned }} /> : null}
          </>
        )}
      </div>
    </aside>
  )
}

export function DockResizer() {
  const dockWidth = useUiStore((state) => state.dockWidth)
  const setDockWidth = useUiStore((state) => state.setDockWidth)
  const start = useRef<{ x: number; width: number } | null>(null)
  return (
    <div
      className="dock-resizer"
      role="separator"
      aria-label="Resize reference panel"
      aria-orientation="vertical"
      tabIndex={0}
      onPointerDown={(event) => {
        start.current = { x: event.clientX, width: dockWidth }
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={(event) => {
        if (start.current) setDockWidth(start.current.width + start.current.x - event.clientX)
      }}
      onPointerUp={() => { start.current = null }}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft') setDockWidth(dockWidth + 10)
        if (event.key === 'ArrowRight') setDockWidth(dockWidth - 10)
      }}
    />
  )
}
