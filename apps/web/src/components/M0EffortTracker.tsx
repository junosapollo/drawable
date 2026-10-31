import { useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { appendM0EffortChunk, M0_EFFORT_CATEGORIES, type M0EffortCategory } from '../services/m0Effort'

interface ActiveSegment {
  sessionId: string
  category: M0EffortCategory
  segmentStartedAt: string
  lastCheckpointAt: number
  lastUiTickAt: number
}

const LABELS: Record<M0EffortCategory, string> = {
  'source-review': 'Source review',
  'asset-review': 'Reference review',
  'feasibility-drawing': 'Feasibility drawing',
  'evidence-review': 'Evidence review',
}

const M0_TRACKED_ROUTES = ['/m0', '/record']

export function M0EffortTracker() {
  const location = useLocation()
  const isTrackedRoute = M0_TRACKED_ROUTES.includes(location.pathname)
  const [category, setCategory] = useState<M0EffortCategory>('asset-review')
  const [running, setRunning] = useState(false)
  const [activeMs, setActiveMs] = useState(0)
  const [error, setError] = useState('')
  const segment = useRef<ActiveSegment | null>(null)

  useEffect(() => {
    if (!running) return
    const tick = () => {
      const active = segment.current
      if (!active) return
      const now = performance.now()
      setActiveMs((value) => value + Math.max(0, now - active.lastUiTickAt))
      active.lastUiTickAt = now
    }
    const timer = window.setInterval(tick, 1000)
    const checkpointTimer = window.setInterval(() => { void flush('periodic') }, 15_000)
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') void stop()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.clearInterval(timer)
      window.clearInterval(checkpointTimer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [running])

  async function flush(checkpoint: 'periodic' | 'paused') {
    const active = segment.current
    if (!active) return
    const now = performance.now()
    const delta = Math.max(0, Math.round(now - active.lastCheckpointAt))
    if (delta === 0) return
    const endedAt = new Date().toISOString()
    try {
      await appendM0EffortChunk({
        schemaVersion: 1,
        chunkId: crypto.randomUUID(),
        sessionId: active.sessionId,
        category: active.category,
        startedAt: active.segmentStartedAt,
        endedAt,
        activeMs: delta,
        checkpoint,
      })
      active.segmentStartedAt = endedAt
      active.lastCheckpointAt = now
      setError('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save the local effort log.')
      segment.current = null
      setRunning(false)
    }
  }

  async function stop() {
    if (!segment.current) return
    await flush('paused')
    segment.current = null
    setRunning(false)
  }

  function start() {
    if (document.visibilityState !== 'visible') return
    const now = new Date().toISOString()
    segment.current = {
      sessionId: crypto.randomUUID(),
      category,
      segmentStartedAt: now,
      lastCheckpointAt: performance.now(),
      lastUiTickAt: performance.now(),
    }
    setActiveMs(0)
    setError('')
    setRunning(true)
  }

  const elapsed = Math.floor(activeMs / 1000)
  const label = `${String(Math.floor(elapsed / 3600)).padStart(2, '0')}:${String(Math.floor((elapsed % 3600) / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`

  if (!isTrackedRoute) return null

  return (
    <aside className="m0-effort-tracker" aria-label="M0 active effort timer">
      <span className={`m0-effort-dot ${running ? 'is-running' : ''}`} aria-hidden="true" />
      <label className="sr-only" htmlFor="m0-effort-category">Effort category</label>
      <select id="m0-effort-category" value={category} disabled={running} onChange={(event) => setCategory(event.target.value as M0EffortCategory)}>
        {M0_EFFORT_CATEGORIES.map((item) => <option key={item} value={item}>{LABELS[item]}</option>)}
      </select>
      <output aria-live="off">{label}</output>
      <button type="button" className={running ? 'is-active' : ''} onClick={() => { if (running) void stop(); else start() }}>
        {running ? 'Pause effort' : 'Start effort'}
      </button>
      {error ? <span className="m0-effort-error" role="status">Effort log unavailable</span> : null}
    </aside>
  )
}
