import { useEffect } from 'react'
import { AlertTriangle, CheckCircle2, Cpu, Database, FolderCheck, Gauge, HardDrive, RefreshCw } from 'lucide-react'
import { ResearchShell } from '../components/AppChrome'
import { Button, StatusDot } from '../components/primitives'
import { useServiceStore } from '../services/serviceRegistry'

type Tone = 'success' | 'warning' | 'error' | 'neutral'

export default function SetupPage() {
  const mode = useServiceStore((state) => state.mode)
  const health = useServiceStore((state) => state.health)
  const probe = useServiceStore((state) => state.probe)
  useEffect(() => { if (mode === 'probing') void probe() }, [mode, probe])

  const api = health?.health
  const live = mode === 'live'
  const ready = live ? Boolean(api?.ready) : true
  const hasIndexedDb = typeof indexedDB !== 'undefined'

  const checks: { icon: typeof Cpu; name: string; value: string; detail: string; status: Tone }[] = [
    {
      icon: Cpu,
      name: 'Runtime',
      value: mode === 'probing' ? 'Connecting…' : live ? `API ${api?.api_version ?? ''}`.trim() : 'Fixture mode',
      detail: live ? (api?.device === 'cuda' ? `${api.gpu_name} · ${api.vram_total_mb} MB` : 'CPU fallback — slower search') : 'No local API detected',
      status: mode === 'probing' ? 'neutral' : live ? (api?.device === 'cuda' ? 'success' : 'warning') : 'warning',
    },
    {
      icon: Database,
      name: 'Reference gallery',
      value: live ? `${(api?.gallery_size ?? 0).toLocaleString()} references` : '30 procedural assets',
      detail: live ? (api?.dataset_version ? `Dataset ${api.dataset_version}` : 'No gallery manifest configured') : 'Development-only fixtures',
      status: live ? (api?.gallery_size ? 'success' : 'error') : 'success',
    },
    {
      icon: Gauge,
      name: 'Inference',
      value: live ? (api?.fixture_mode ? 'Fixture ranker' : api?.warmup === 'complete' ? 'Models warm' : 'Warming up') : 'Simulated',
      detail: live ? `${api?.models.filter((model) => model.loaded).length ?? 0} of ${api?.models.length ?? 0} models loaded` : 'Deterministic 320 ms response',
      status: live ? (api?.fixture_mode ? 'warning' : 'success') : 'warning',
    },
    {
      icon: HardDrive,
      name: 'Persistence',
      value: 'IndexedDB',
      detail: hasIndexedDb ? 'Available in this browser' : 'Unavailable — autosave disabled',
      status: hasIndexedDb ? 'success' : 'error',
    },
  ]

  const title = !ready
    ? 'The API started with a setup error'
    : live
      ? 'LineScout API connected'
      : 'drawable can run without a backend'
  const blurb = !ready
    ? (api?.warnings[0] ?? 'A mandatory component failed to load.')
    : live
      ? 'The canvas is talking to the local FastAPI worker. Search results come from the fixture ranker until the Milestone 4 models are trained.'
      : 'The frontend is using local procedural references. Start the API (see services/api/README.md) and reload to switch to real mode.'

  return (
    <ResearchShell eyebrow="Local system" title="Setup and health">
      <div className="setup-page">
        <section className="setup-hero">
          <div className="health-icon">{ready ? <CheckCircle2 size={26} /> : <AlertTriangle size={26} />}</div>
          <div><span className="dock-eyebrow">{ready ? 'Workspace ready' : 'Setup required'}</span><h1>{title}</h1><p>{blurb}</p></div>
          <Button onClick={() => void probe()}><RefreshCw size={15} />Run checks again</Button>
        </section>
        <div className="setup-grid">{checks.map(({ icon: Icon, name, value, detail, status }) => <article key={name}><Icon size={20} /><div><span>{name}</span><strong>{value}</strong><small>{detail}</small></div><StatusDot tone={status} /></article>)}</div>
        <section className="artifact-panel">
          <header><div><FolderCheck size={18} /><h2>Real-mode artifacts</h2></div><span>{live ? (api?.fixture_mode ? 'Fixture ranker' : 'Configured') : 'Not configured'}</span></header>
          <div className="artifact-list">
            {(api?.models ?? [
              { name: 'semantic', version: 'missing', loaded: false },
              { name: 'structural', version: 'missing', loaded: false },
              { name: 'stroke', version: 'missing', loaded: false },
              { name: 'scope', version: 'missing', loaded: false },
              { name: 'pose', version: 'missing', loaded: false },
            ]).map((model) => (
              <div key={model.name}><span>{model.name} model</span><code>{model.loaded ? model.version : `missing (${model.version})`}</code></div>
            ))}
            <div><span>Reference index</span><code>{api?.index_version ?? 'missing'}</code></div>
            <div><span>Schema version</span><code>{api?.schema_version ?? '—'}</code></div>
          </div>
          {api?.warnings.length ? <ul className="setup-warnings">{api.warnings.map((warning) => <li key={warning}><AlertTriangle size={13} />{warning}</li>)}</ul> : null}
          <p>{live ? 'Model checkpoints and FAISS indexes are produced by the ml pipeline in Milestone 4.' : 'This is expected during frontend development. Drawing, autosave, export, and fixture search remain available.'}</p>
        </section>
      </div>
    </ResearchShell>
  )
}
