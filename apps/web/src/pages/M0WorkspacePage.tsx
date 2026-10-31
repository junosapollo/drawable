import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowUpRight, Download, RefreshCw } from 'lucide-react'
import { ResearchShell } from '../components/AppChrome'
import { Button, StatusDot } from '../components/primitives'
import { exportM0EffortLog } from '../services/m0Effort'

type M0Workspace = {
  status: 'blocked' | 'complete'
  gpu_status: 'not_probed'
  training_authorized: false
  training_started: false
  gates: Record<string, string>
  blockers: Record<string, string>
  source_archive_status: Record<string, string>
  source_terms_status: Record<string, string>
  model_terms_status: Record<string, string>
  effort_log_available: boolean
  source_yield_sample_status: string
  source_yield_sample_count: number
}

const GATE_TITLES: Record<string, string> = {
  official_archive_reconciliation: 'Official archive and extraction reconciliation',
  source_work_rights_review: 'Source and work permissions',
  source_yield_review: 'Fixed source-yield review',
  ten_feasibility_sequences: 'Ten feasibility drawings and independent replay',
  human_effort_storage: 'Active effort, disk, and projected review cost',
  small_approved_gallery: 'Small, reviewed staging gallery',
  frozen_cpu_forward: 'Frozen encoder CPU measurements',
}

async function getWorkspace(): Promise<M0Workspace> {
  const response = await fetch('/api/v1/feasibility/m0', { credentials: 'same-origin', cache: 'no-store' })
  const value = await response.json().catch(() => ({})) as M0Workspace & { detail?: string }
  if (!response.ok) throw new Error(value.detail ?? `M0 status is unavailable (${response.status})`)
  return value
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

export default function M0WorkspacePage() {
  const [workspace, setWorkspace] = useState<M0Workspace | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function refresh() {
    setBusy(true)
    setError('')
    try { setWorkspace(await getWorkspace()) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not load M0 status.') }
    finally { setBusy(false) }
  }

  useEffect(() => { void refresh() }, [])

  async function downloadEffort() {
    try { downloadBlob(await exportM0EffortLog(), `drawable-m0-effort-${new Date().toISOString().slice(0, 10)}.json`) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not export the local effort log.') }
  }

  return (
    <ResearchShell eyebrow="Feasibility milestone" title="M0 owner workspace" badge={workspace?.status === 'complete' ? 'Evidence complete' : 'Evidence pending'}>
      <div className="m0-workspace">
        <section className="m0-hero">
          <div>
            <span className="dock-eyebrow">Current project boundary</span>
            <h1>{workspace?.status === 'complete' ? 'M0 evidence is ready for owner review' : 'Complete feasibility before pilot collection'}</h1>
            <p>This workspace shows hash-verified evidence and the remaining owner work. A gate stays incomplete until its evidence is reviewed and attested. No GPU probe, download, model load, training, or upload happens from this page.</p>
          </div>
          <Button onClick={() => void refresh()} disabled={busy}><RefreshCw size={15} />Refresh evidence</Button>
        </section>

        {error ? <p className="m0-error" role="alert">{error}. Start the local API with <code>CURATION_MODE=1</code> to read private M0 status.</p> : null}

        <div className="m0-status-grid">
          <article><span>GPU status</span><strong>Not probed</strong><small>The owner has disabled local GPU checks for this phase.</small></article>
          <article><span>Training</span><strong>Not authorized</strong><small>No optimizer, backward pass, weight update, or data upload.</small></article>
          <article><span>Source-yield sample</span><strong>{workspace ? `${workspace.source_yield_sample_count} selected · ${workspace.source_yield_sample_status}` : 'Loading'}</strong><small>The fixed queue appears only for source strata that pass provenance and permission checks.</small></article>
        </div>

        <section className="m0-panel">
          <header><div><span className="dock-eyebrow">M0 exit checklist</span><h2>Evidence gates</h2></div><span>{workspace ? Object.values(workspace.gates).filter((value) => value === 'complete').length : 0} / 7 complete</span></header>
          <div className="m0-gates">
            {Object.entries(GATE_TITLES).map(([gate, title]) => {
              const complete = workspace?.gates[gate] === 'complete'
              return <article key={gate}>
                <StatusDot tone={complete ? 'success' : 'warning'} />
                <div><strong>{title}</strong><small>{complete ? 'Owner-reviewed evidence is hash verified.' : workspace?.blockers[gate] ?? 'Evidence has not been reviewed and attested.'}</small></div>
              </article>
            })}
          </div>
        </section>

        <div className="m0-two-column">
          <section className="m0-panel">
            <header><div><span className="dock-eyebrow">Local review tasks</span><h2>Sources and candidate yield</h2></div></header>
            <div className="m0-registry-list">
              {Object.entries(workspace?.source_terms_status ?? {}).map(([id, status]) => <div key={id}><span>{id}</span><strong>{status} · archive {workspace?.source_archive_status[id] ?? 'not audited'}</strong></div>)}
            </div>
            <p>Review the actual source and per-work terms before opening source pixels. The fixed pilot-v1 sample has 230 candidates when every source stratum is eligible. Blocked sources remain reported as unavailable.</p>
            <div className="m0-actions">
              <Link className="button button--primary" to="/curate?queue=pilot-v1">Open fixed source-yield queue<ArrowUpRight size={15} /></Link>
              <code>uv run --project services/api --locked drawable data sample --root datasets --recipe pilot-v1</code>
            </div>
          </section>

          <section className="m0-panel">
            <header><div><span className="dock-eyebrow">Frozen model review</span><h2>Inference permissions</h2></div></header>
            <div className="m0-registry-list">
              {Object.entries(workspace?.model_terms_status ?? {}).map(([id, status]) => <div key={id}><span>{id}</span><strong>{status}</strong></div>)}
            </div>
            <p>Exact checkpoint revisions and byte hashes are pinned in the model registry. Record inference terms separately from training, derivative, and cloud-processing terms. CPU measurements become available only after the model files and a permitted staging gallery are in place.</p>
            <code>uv run --project ml --locked drawable-ml models verify --purpose inference --data-root datasets</code>
          </section>
        </div>

        <div className="m0-two-column">
          <section className="m0-panel">
            <header><div><span className="dock-eyebrow">Ten owner-created studies</span><h2>Record feasibility drawings</h2></div></header>
            <p>Use the task sheet for ten freehand studies with no external reference. Record consent, scope, style, active effort, and the final state. The drawing recorder keeps work in an isolated browser profile and does not add it to the reference gallery. After saving, load the accepted recordings and export one JSON batch from the recording library.</p>
            <div className="m0-actions"><Link className="button button--primary" to="/record">Open drawing recorder<ArrowUpRight size={15} /></Link><code>npm run m0:record -- --data-root datasets</code></div>
            <p>Import the exported batch and independently replay ten selected IDs:</p>
            <code>drawable m0 recording-import --root datasets --input &lt;batch.json&gt;</code>
            <code>drawable m0 replay-recordings --root datasets --batch &lt;private-batch-path&gt; --recording-id &lt;id&gt; (repeat ten times)</code>
          </section>
          <section className="m0-panel">
            <header><div><span className="dock-eyebrow">Effort evidence</span><h2>Track and export active time</h2></div><span>{workspace?.effort_log_available ? 'Imported' : 'Browser local'}</span></header>
            <p>The floating timer counts foreground-visible work in four M0 categories and checkpoints to IndexedDB every 15 seconds. It pauses when this browser tab is hidden or you leave the M0 and Record workspaces. Returning to a tracked workspace does not restart it. Export the log, then import it into the private data root before generating the effort gate report.</p>
            <div className="m0-actions">
              <Button onClick={() => void downloadEffort()}><Download size={15} />Download effort log</Button>
              <code>uv run --project services/api --locked drawable m0 effort-import --root datasets --input &lt;downloaded-file&gt;</code>
            </div>
          </section>
        </div>

        <section className="m0-panel m0-next-step">
          <header><div><span className="dock-eyebrow">When the evidence is real</span><h2>Assemble and attest M0 reports</h2></div></header>
          <ol>
            <li>Reacquire only the official archives needed for the fixed review sample, save receipts, and reconcile every extracted file against a clean extraction.</li>
            <li>Capture current terms snapshots and record your actual use decisions for each source and work.</li>
            <li>Review the fixed candidate queue, complete ten recordings, export the recording batch, and run Chromium replay verification.</li>
            <li>Create a review-only snapshot from individually reviewed permitted assets, recheck it with <code>drawable m0 gallery-report</code>, then measure both frozen encoders on CPU.</li>
            <li>Review and attest all seven gate reports, then assemble <code>reports/private/feasibility.json</code>. The report remains blocked when any input is missing or stale.</li>
          </ol>
          <code>uv run --project services/api --locked drawable readiness report --root datasets --stage m0</code>
        </section>
      </div>
    </ResearchShell>
  )
}
