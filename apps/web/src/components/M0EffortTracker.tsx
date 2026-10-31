import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { EffortTimer, type EffortTimerView } from '../services/effortTimer'
import { M0_EFFORT_CATEGORIES, type M0EffortCategory } from '../services/m0Effort'

const LABELS: Record<M0EffortCategory, string> = {
  'source-review': 'Source review',
  'asset-review': 'Reference review',
  'feasibility-drawing': 'Feasibility drawing',
  'evidence-review': 'Evidence review',
}

const M0_TRACKED_ROUTES = ['/m0', '/record']

export function M0EffortTracker() {
  const location = useLocation()
  const route = location.pathname.replace(/\/+$/, '') || '/'
  const isTrackedRoute = M0_TRACKED_ROUTES.includes(route)
  const [category, setCategory] = useState<M0EffortCategory>('asset-review')
  const [view, setView] = useState<EffortTimerView>({ running: false, activeMs: 0, pendingStop: false, error: '' })
  const mounted = useRef(true)
  const timerRef = useRef<EffortTimer | null>(null)
  if (!timerRef.current) {
    timerRef.current = new EffortTimer((nextView) => {
      if (mounted.current) setView(nextView)
    })
  }
  const timer = timerRef.current

  useLayoutEffect(() => {
    if (!isTrackedRoute) timer.pause()
  }, [isTrackedRoute, timer])

  useEffect(() => {
    mounted.current = true
    const tickTimer = window.setInterval(() => timer.tick(), 1000)
    const checkpointTimer = window.setInterval(() => timer.checkpoint(), 15_000)
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') timer.pause()
    }
    const onPageHide = () => timer.pause()
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', onPageHide)
    return () => {
      window.clearInterval(tickTimer)
      window.clearInterval(checkpointTimer)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', onPageHide)
      mounted.current = false
      timer.pause()
    }
  }, [timer])

  const elapsed = Math.floor(view.activeMs / 1000)
  const label = `${String(Math.floor(elapsed / 3600)).padStart(2, '0')}:${String(Math.floor((elapsed % 3600) / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`

  if (!isTrackedRoute) return null

  return (
    <aside className="m0-effort-tracker" aria-label="M0 active effort timer">
      <span className={`m0-effort-dot ${view.running ? 'is-running' : ''}`} aria-hidden="true" />
      <label className="sr-only" htmlFor="m0-effort-category">Effort category</label>
      <select id="m0-effort-category" value={category} disabled={view.running || view.pendingStop} onChange={(event) => setCategory(event.target.value as M0EffortCategory)}>
        {M0_EFFORT_CATEGORIES.map((item) => <option key={item} value={item}>{LABELS[item]}</option>)}
      </select>
      <output aria-live="off">{label}</output>
      <button type="button" className={view.running ? 'is-active' : ''} disabled={view.pendingStop} onClick={() => { if (view.running) timer.pause(); else if (document.visibilityState === 'visible') timer.start(category) }}>
        {view.running ? 'Pause effort' : 'Start effort'}
      </button>
      {view.error ? <span className="m0-effort-error" role="status">Effort log unavailable</span> : null}
    </aside>
  )
}
