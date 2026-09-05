import { AlertTriangle, CheckCircle2 } from 'lucide-react'
import { ResearchShell } from '../components/AppChrome'
import { Button } from '../components/primitives'
import { fixtureAssets } from '../services/fixtures'

export default function BenchmarkPage() {
  return (
    <ResearchShell eyebrow="Evaluation workspace" title="Blind benchmark">
      <div className="benchmark-layout">
        <aside className="benchmark-query">
          <span className="dock-eyebrow">Query 17 of 250</span>
          <div className="query-image"><img src={fixtureAssets[1]?.imageUrl} alt="Anonymous partial drawing query" /></div>
          <h2>40% completion</h2><p>Rate whether each result would help continue this visible drawing.</p>
          <div className="progress-block"><span>Run progress</span><strong>6.8%</strong><div><i style={{ width: '6.8%' }} /></div></div>
          <div className="benchmark-key"><span><b>0</b>Unrelated</span><span><b>1</b>Broad</span><span><b>2</b>Useful</span><span><b>3</b>Strong</span></div>
        </aside>
        <section className="judgment-area">
          <header><div><span className="dock-eyebrow">Anonymized pool</span><h2>Candidate references</h2></div><span className="saved-label"><CheckCircle2 size={15} />Progress saved</span></header>
          <div className="judgment-grid">
            {fixtureAssets.slice(3, 11).map((asset, index) => (
              <article className="judgment-card" key={asset.id}>
                <img src={asset.imageUrl} alt={`Candidate ${index + 1}`} />
                <div><span>Candidate {String.fromCharCode(65 + index)}</span><div className="score-control">{[0, 1, 2, 3].map((score) => <button className={index % 4 === score ? 'is-active' : ''} key={score}>{score}</button>)}</div></div>
              </article>
            ))}
          </div>
          <footer><span><AlertTriangle size={15} />System identities remain hidden until the run is complete.</span><Button className="button--primary">Save and continue</Button></footer>
        </section>
      </div>
    </ResearchShell>
  )
}
