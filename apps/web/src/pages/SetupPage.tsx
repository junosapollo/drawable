import { CheckCircle2, Cpu, Database, FolderCheck, Gauge, HardDrive, RefreshCw } from 'lucide-react'
import { ResearchShell } from '../components/AppChrome'
import { Button, StatusDot } from '../components/primitives'

const checks = [
  { icon: Cpu, name: 'Runtime', value: 'Fixture mode', detail: 'No local API required', status: 'success' as const },
  { icon: Database, name: 'Reference gallery', value: '30 procedural assets', detail: 'Development-only fixtures', status: 'success' as const },
  { icon: Gauge, name: 'Inference', value: 'Simulated', detail: 'Deterministic 320 ms response', status: 'warning' as const },
  { icon: HardDrive, name: 'Persistence', value: 'IndexedDB', detail: 'Available in this browser', status: 'success' as const },
]

export default function SetupPage() {
  return (
    <ResearchShell eyebrow="Local system" title="Setup and health">
      <div className="setup-page">
        <section className="setup-hero"><div className="health-icon"><CheckCircle2 size={26} /></div><div><span className="dock-eyebrow">Workspace ready</span><h1>drawable can run without a backend</h1><p>The frontend is using local procedural references. Switch to real mode when the API and indexes are available.</p></div><Button><RefreshCw size={15} />Run checks again</Button></section>
        <div className="setup-grid">{checks.map(({ icon: Icon, name, value, detail, status }) => <article key={name}><Icon size={20} /><div><span>{name}</span><strong>{value}</strong><small>{detail}</small></div><StatusDot tone={status} /></article>)}</div>
        <section className="artifact-panel"><header><div><FolderCheck size={18} /><h2>Real-mode artifacts</h2></div><span>Not configured</span></header><div className="artifact-list"><div><span>Semantic encoder</span><code>missing</code></div><div><span>Structural encoder</span><code>missing</code></div><div><span>Reference index</span><code>missing</code></div><div><span>Ranking profile</span><code>missing</code></div></div><p>This is expected during frontend development. Drawing, autosave, export, and fixture search remain available.</p></section>
      </div>
    </ResearchShell>
  )
}
