import { useState } from 'react'
import { Check, ChevronLeft, ChevronRight, Crop, RotateCcw, X } from 'lucide-react'
import { ResearchShell } from '../components/AppChrome'
import { Button, StatusDot } from '../components/primitives'
import { fixtureAssets } from '../services/fixtures'

export default function CuratePage() {
  const [index, setIndex] = useState(4)
  const asset = fixtureAssets[index] ?? fixtureAssets[0]!
  return (
    <ResearchShell eyebrow="Dataset workspace" title="Curation">
      <div className="curation-layout">
        <aside className="research-sidebar">
          <div className="progress-block"><span>Review progress</span><strong>184 / 2,000</strong><div><i style={{ width: '9.2%' }} /></div></div>
          <nav className="filter-list">
            <button className="is-active"><span><StatusDot tone="warning" />Needs review</span><b>816</b></button>
            <button><span>Accepted</span><b>172</b></button>
            <button><span>Rejected</span><b>48</b></button>
            <button><span>Quarantined</span><b>13</b></button>
          </nav>
          <div className="keyboard-note"><kbd>K</kbd> Keep <kbd>R</kbd> Reject <kbd>1–3</kbd> Quality</div>
        </aside>
        <section className="candidate-stage">
          <div className="candidate-toolbar"><Button><Crop size={15} />Edit crop</Button><Button><RotateCcw size={15} />Reset view</Button><span>Candidate {asset.id}</span></div>
          <div className="candidate-image"><img src={asset.imageUrl} alt={asset.title} /></div>
          <div className="candidate-nav"><Button disabled={index === 0} onClick={() => setIndex(Math.max(0, index - 1))}><ChevronLeft size={16} />Previous</Button><span>{index + 1} of {fixtureAssets.length}</span><Button onClick={() => setIndex((index + 1) % fixtureAssets.length)}>Next<ChevronRight size={16} /></Button></div>
        </section>
        <aside className="candidate-inspector">
          <div className="inspector-title"><span className="dock-eyebrow">Candidate metadata</span><h2>{asset.title}</h2></div>
          <label><span>Primary style</span><select defaultValue={asset.style}><option>{asset.style}</option><option>Manga / anime</option><option>Gesture</option></select></label>
          <label><span>Primary scope</span><select defaultValue="Full body"><option>Full body</option><option>Face / head</option><option>Hand</option></select></label>
          <fieldset><legend>Quality</legend><div className="segmented-control"><button>1</button><button className="is-active">2</button><button>3</button></div></fieldset>
          <dl className="metadata-list"><div><dt>Source</dt><dd>Procedural fixture</dd></div><div><dt>Rights</dt><dd>Fixture-safe</dd></div><div><dt>Line art</dt><dd>{asset.native ? 'Native' : 'Extracted'}</dd></div><div><dt>SFW check</dt><dd><StatusDot tone="success" />Passed</dd></div></dl>
          <label className="note-field"><span>Review note</span><textarea placeholder="Optional note…" /></label>
          <div className="review-actions"><Button className="button--danger"><X size={16} />Reject</Button><Button className="button--primary"><Check size={16} />Keep</Button></div>
          <p className="scaffold-note">Interaction wiring follows after the artist workspace is accepted.</p>
        </aside>
      </div>
    </ResearchShell>
  )
}
