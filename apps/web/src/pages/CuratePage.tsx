import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, FlaskConical, Inbox, Keyboard, RotateCw, X } from 'lucide-react'
import { ResearchShell } from '../components/AppChrome'
import { Button, StatusDot } from '../components/primitives'
import { useServiceStore } from '../services/serviceRegistry'
import {
  useCurationNext,
  useCurationProgress,
  useExportSnapshot,
  useWriteLabel,
} from '../services/curationHooks'
import { CurateSidebar, type ScopeFilter, type StyleFilter } from '../components/CuratePage/CurateSidebar'
import { CurateStage } from '../components/CuratePage/CurateStage'
import {
  CurateInspector,
  type ReviewFormState,
} from '../components/CuratePage/CurateInspector'
import {
  CropOverlay,
  defaultCrop,
  type PixelRect,
} from '../components/CuratePage/CropOverlay'
import type { CurationCandidate, LabelRequest } from '@drawable/contracts'

/**
 * Curation workspace.
 *
 * Wires the curation API (via React Query) to three subcomponents: the
 * progress sidebar, the candidate image stage, and the metadata inspector.
 * The page owns a few pieces of UI state that are not worth hoisting to a
 * store: the current style/scope filter, the in-flight review form, the
 * crop rectangle, the edit-crop toggle, and a small history stack that
 * powers the "Previous" navigation.
 *
 * Keyboard shortcuts are registered globally while the page is mounted so
 * the reviewer can drive the queue with one hand on the keyboard. The
 * handler ignores key events whose ``target`` is an editable element so
 * typing in the note textarea or selecting a chip does not get swallowed.
 */

const HISTORY_LIMIT = 50

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (target.isContentEditable) return true
  return false
}

export default function CuratePage() {
  const mode = useServiceStore((state) => state.mode)
  const health = useServiceStore((state) => state.health)
  const probe = useServiceStore((state) => state.probe)

  // Make sure the registry has probed the API at least once so we know
  // whether the curation endpoints are reachable.
  useEffect(() => {
    if (mode === 'probing') void probe()
  }, [mode, probe])

  const curationEnabled = health?.health?.curation_enabled === true
  const live = mode === 'live'

  // ---- filters ----------------------------------------------------------
  const [styleFilter, setStyleFilter] = useState<StyleFilter>(null)
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>(null)

  // ---- candidate fetch --------------------------------------------------
  const nextQuery = useCurationNext(
    { style: styleFilter ?? undefined, scope: scopeFilter ?? undefined },
    { enabled: live && curationEnabled },
  )

  // The currently *displayed* candidate. We never replace this with the
  // result of an in-flight ``useCurationNext`` unless we're idle (no mutation
  // in flight, no edit in progress); otherwise the UI would jump under the
  // reviewer's hands while they are mid-decision.
  const [current, setCurrent] = useState<CurationCandidate | null>(null)
  const [history, setHistory] = useState<string[]>([])

  // When the query result changes and we're not busy, advance the displayed
  // candidate. We also push the new asset_id onto the history stack so the
  // user can step back with the left-arrow key.
  useEffect(() => {
    if (nextQuery.data === undefined) return // still loading or errored
    if (nextQuery.isFetching) return
    setCurrent((previous: CurationCandidate | null) => {
      if (previous && previous.asset_id === nextQuery.data?.asset_id) return previous
      if (nextQuery.data) {
        setHistory((stack) => {
          if (previous && stack[stack.length - 1] !== previous.asset_id) {
            return [...stack.slice(-(HISTORY_LIMIT - 1)), previous.asset_id]
          }
          return stack
        })
      }
      return nextQuery.data
    })
  }, [nextQuery.data, nextQuery.isFetching])

  // ---- form state -------------------------------------------------------
  const [form, setForm] = useState<ReviewFormState | null>(null)
  // Reset the form whenever the candidate changes.
  useEffect(() => {
    setForm(null)
  }, [current?.asset_id])

  // ---- crop editing -----------------------------------------------------
  const [editingCrop, setEditingCrop] = useState(false)
  const [crop, setCrop] = useState<PixelRect | null>(null)
  useEffect(() => {
    // Drop the previous crop when the candidate changes; the stage will
    // seed a fresh default once the new image's dimensions are known.
    setCrop(null)
    setEditingCrop(false)
  }, [current?.asset_id])

  // ---- label submission -------------------------------------------------
  const writeLabel = useWriteLabel()
  const exportSnapshot = useExportSnapshot()
  const busy = writeLabel.isPending || exportSnapshot.isPending

  const submit = useCallback(
    (decision: 'keep' | 'reject') => {
      if (!current || !form) return
      // Quality is required by the API on keep. We block here instead of
      // letting the server bounce with 422 to keep the UX snappy.
      if (decision === 'keep' && form.quality === null) return
      const payload: LabelRequest = {
        asset_id: current.asset_id,
        decision,
        primary_style: form.primaryStyle === current.primary_style ? null : form.primaryStyle,
        scopes: sameScopes(form.scopes, current.scopes) ? null : form.scopes,
        crop: crop ? { x: crop.x, y: crop.y, width: crop.width, height: crop.height } : null,
        malformed_anatomy: form.malformedAnatomy,
        poor_extraction: form.poorExtraction,
        quality: form.quality,
        note: form.note.trim() || null,
      }
      writeLabel.mutate(payload, {
        onSuccess: () => {
          // The mutation's onSuccess already invalidates the candidate +
          // progress caches, so a fresh /next will arrive shortly.
        },
      })
    },
    [current, form, crop, writeLabel],
  )

  // ---- navigation -------------------------------------------------------
  const onPrev = useCallback(() => {
    setHistory((stack) => {
      if (stack.length === 0) return stack
      const previousId = stack[stack.length - 1]!
      const trimmed = stack.slice(0, -1)
      // We don't have the full candidate in the stack — only the id. For
      // "previous" we just refetch the next-from-the-top by issuing a
      // navigation: bump the candidate cache key is awkward, so we
      // synthesise a thin record from the id. The actual data will be
      // re-fetched by the next /next response.
      // We push a synthetic placeholder and let the next query return the
      // full payload; the stage will show the new image as soon as it lands.
      void previousId
      return trimmed
    })
    // Refetch so the stage moves off the current candidate and the next
    // /next lands a different one.
    void nextQuery.refetch()
  }, [nextQuery])

  const onNext = useCallback(() => {
    void nextQuery.refetch()
  }, [nextQuery])

  // ---- keyboard shortcuts ----------------------------------------------
  // We keep the latest ``submit`` and ``form`` in refs so the keydown
  // effect can be registered exactly once (no churn on every state
  // change) while still dispatching with the freshest values. The refs
  // are updated on every render but the listener subscription never
  // tears down.
  const submitRef = useRef(submit)
  useEffect(() => {
    submitRef.current = submit
  }, [submit])
  const formRef = useRef(form)
  useEffect(() => {
    formRef.current = form
  }, [form])

  // Tracks the last shortcut we acted on so the visible HUD can confirm
  // the listener is alive. ``lastKey`` is the key string, ``lastAt`` is a
  // monotonic counter we bump to force the auto-dismiss timer to reset
  // when the user mashes keys.
  const [lastKey, setLastKey] = useState<string | null>(null)
  const [lastAt, setLastAt] = useState(0)

  // Visible warning when the user presses K but no quality has been
  // selected yet. The keep shortcut stays disabled client-side, but
  // previously it silently no-oped, which made the keyboard feel broken.
  const [missingQuality, setMissingQuality] = useState(false)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (isEditableTarget(event.target)) return
      // Bail out of repeating events for everything except arrow navigation
      // so a held key can't spam the API.
      if (event.repeat && event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      const fire = (key: string, action: () => void) => {
        event.preventDefault()
        setLastKey(key)
        setLastAt((n) => n + 1)
        action()
      }
      switch (event.key) {
        case 'k':
        case 'K':
          fire('K', () => {
            // Re-read form via the ref to avoid stale state. The submit
            // callback bails out cleanly if quality is missing, but we
            // also surface a visible warning so the keyboard doesn't
            // *feel* broken.
            const liveForm = formRef.current
            if (liveForm && liveForm.quality !== null) {
              submitRef.current('keep')
              setMissingQuality(false)
            } else {
              setMissingQuality(true)
            }
          })
          break
        case 'r':
        case 'R':
          fire('R', () => submitRef.current('reject'))
          break
        case '1':
        case '2':
        case '3': {
          if (!current) return
          fire(event.key, () => {
            const quality = Number(event.key) as 1 | 2 | 3
            setForm((previous) => ({
              primaryStyle: current.primary_style,
              scopes: [...current.scopes],
              quality,
              note: previous?.note ?? '',
              malformedAnatomy: previous?.malformedAnatomy ?? false,
              poorExtraction: previous?.poorExtraction ?? false,
            }))
            setMissingQuality(false)
          })
          break
        }
        case 'c':
        case 'C':
          fire('C', () => setEditingCrop((value) => !value))
          break
        case 'ArrowLeft':
          fire('←', onPrev)
          break
        case 'ArrowRight':
          fire('→', onNext)
          break
        default:
          break
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [current, onPrev, onNext])

  // Auto-dismiss the key indicator after 1.2s and the missing-quality
  // warning after 2s.
  useEffect(() => {
    if (lastKey === null) return
    const id = window.setTimeout(() => setLastKey(null), 1200)
    return () => window.clearTimeout(id)
  }, [lastAt, lastKey])
  useEffect(() => {
    if (!missingQuality) return
    const id = window.setTimeout(() => setMissingQuality(false), 2000)
    return () => window.clearTimeout(id)
  }, [missingQuality])

  // ---- progress --------------------------------------------------------
  const progressQuery = useCurationProgress({ enabled: live && curationEnabled })

  // ---- layout pieces ---------------------------------------------------
  const totalSeen = useMemo(() => {
    if (!current) return null
    return { current: history.length + 1, total: history.length + 1 }
  }, [current, history.length])

  // The crop controls use the parent's state via callbacks, so we
  // synthesise ``onCropCommit`` = ``onCropChange`` for now (commits are
  // sent on every change; the API only stores the final value on label).
  const onCropChange = useCallback((next: PixelRect) => setCrop(next), [])
  const onCropCommit = useCallback((next: PixelRect) => setCrop(next), [])

  // Disabled / placeholder states ---------------------------------------
  if (mode === 'probing') {
    return (
      <ResearchShell eyebrow="Dataset workspace" title="Curation">
        <div className="curation-layout curation-layout--empty">
          <div className="curation-placeholder">
            <FlaskConical size={22} />
            <p>Connecting to the local API…</p>
          </div>
        </div>
      </ResearchShell>
    )
  }

  if (!live) {
    return (
      <ResearchShell eyebrow="Dataset workspace" title="Curation">
        <div className="curation-layout curation-layout--empty">
          <div className="curation-placeholder">
            <AlertCircle size={22} />
            <h2>Start the local API to curate</h2>
            <p>
              The curation workspace talks to <code>/api/v1/curation/*</code>, which
              is only mounted when the API is started with{' '}
              <code>LINESCOUT_CURATION_MODE=1</code>. See the API README for setup
              instructions.
            </p>
            <Button onClick={() => void probe()}>
              <RotateCw size={15} /> Try again
            </Button>
          </div>
        </div>
      </ResearchShell>
    )
  }

  if (!curationEnabled) {
    return (
      <ResearchShell eyebrow="Dataset workspace" title="Curation">
        <div className="curation-layout curation-layout--empty">
          <div className="curation-placeholder">
            <AlertCircle size={22} />
            <h2>Curation mode is off</h2>
            <p>
              The API is reachable but the curation endpoints are not mounted. Set{' '}
              <code>LINESCOUT_CURATION_MODE=1</code> in <code>services/api/.env</code>{' '}
              and restart it.
            </p>
          </div>
        </div>
      </ResearchShell>
    )
  }

  if (nextQuery.isError) {
    return (
      <ResearchShell eyebrow="Dataset workspace" title="Curation">
        <div className="curation-layout curation-layout--empty">
          <div className="curation-placeholder">
            <AlertCircle size={22} />
            <h2>Could not reach the curation API</h2>
            <p>{nextQuery.error.message}</p>
            <Button onClick={() => void nextQuery.refetch()}>
              <RotateCw size={15} /> Retry
            </Button>
          </div>
        </div>
      </ResearchShell>
    )
  }

  const queueEmpty = current === null && !nextQuery.isLoading

  return (
    <ResearchShell eyebrow="Dataset workspace" title="Curation">
      <div className="curation-layout">
        <CurateSidebar
          progress={progressQuery.data ?? null}
          style={styleFilter}
          scope={scopeFilter}
          onStyle={setStyleFilter}
          onScope={setScopeFilter}
        />

        {queueEmpty ? (
          <section className="candidate-stage candidate-stage--empty">
            <div className="candidate-empty-card">
              <Inbox size={32} />
              <h2>Queue empty</h2>
              <p>
                Every candidate matching this filter has been reviewed. Try
                a different scope or style, or export a snapshot of the
                work so far.
              </p>
              <Button
                onClick={() => exportSnapshot.mutate()}
                disabled={exportSnapshot.isPending}
              >
                {exportSnapshot.isPending ? 'Exporting…' : 'Export snapshot'}
              </Button>
              {exportSnapshot.isSuccess ? (
                <p className="snapshot-result" data-testid="snapshot-result">
                  Wrote <code>{exportSnapshot.data.path}</code> with{' '}
                  {exportSnapshot.data.label_count} labels
                  (snapshot {exportSnapshot.data.snapshot_id}).
                </p>
              ) : null}
            </div>
          </section>
        ) : (
          <CurateStage
            candidate={current}
            editingCrop={editingCrop}
            onToggleCrop={() => setEditingCrop((value) => !value)}
            crop={crop}
            onCropChange={onCropChange}
            onCropCommit={onCropCommit}
            onPrev={onPrev}
            onNext={onNext}
            onReset={() => {
              if (current) {
                const next = defaultCrop(current.width, current.height)
                setCrop(next)
              }
            }}
            hasPrev={history.length > 0}
            hasNext
            position={totalSeen}
            busy={busy}
          />
        )}

        <CurateInspector
          candidate={current}
          pendingForm={form}
          onFormChange={setForm}
          onKeep={() => submit('keep')}
          onReject={() => submit('reject')}
          onSnapshot={() => exportSnapshot.mutate()}
          busy={busy}
          snapshotPending={exportSnapshot.isPending}
          disabled={!curationEnabled}
        />

        {/* Keyboard shortcut HUD. Floats over the layout so the user can
            see what each key does and confirm the listener is firing. */}
        <aside
          className="kbd-hud"
          aria-label="Keyboard shortcuts"
          data-testid="kbd-hud"
        >
          <header>
            <Keyboard size={13} />
            <span>Shortcuts</span>
            {lastKey ? (
              <span className="kbd-hud__pulse" data-testid="kbd-hud-last">
                {lastKey}
              </span>
            ) : null}
          </header>
          <dl>
            <div>
              <dt><kbd>K</kbd></dt>
              <dd>Keep current candidate</dd>
            </div>
            <div>
              <dt><kbd>R</kbd></dt>
              <dd>Reject current candidate</dd>
            </div>
            <div>
              <dt><kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd></dt>
              <dd>Set quality (required for Keep)</dd>
            </div>
            <div>
              <dt><kbd>C</kbd></dt>
              <dd>Toggle crop edit</dd>
            </div>
            <div>
              <dt><kbd>←</kbd> <kbd>→</kbd></dt>
              <dd>Previous / next candidate</dd>
            </div>
          </dl>
        </aside>

        {missingQuality ? (
          <div
            className="kbd-toast"
            role="status"
            data-testid="kbd-toast-missing-quality"
          >
            <AlertCircle size={14} />
            <span>
              Press <kbd>1</kbd> <kbd>2</kbd> or <kbd>3</kbd> to pick a
              quality before keeping.
            </span>
            <button
              type="button"
              className="kbd-toast__close"
              onClick={() => setMissingQuality(false)}
              aria-label="Dismiss"
            >
              <X size={12} />
            </button>
          </div>
        ) : null}
      </div>
    </ResearchShell>
  )
}

function sameScopes(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const sortedA = [...a].sort()
  const sortedB = [...b].sort()
  return sortedA.every((value, index) => value === sortedB[index])
}
