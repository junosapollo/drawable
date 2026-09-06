/**
 * Right-side inspector for the current candidate.
 *
 * Holds the in-flight review form (primary style override, scope override,
 * quality, malformed/poor flags, and free-form note). Submission is
 * delegated to the parent: the parent owns the keyboard shortcuts and the
 * React Query mutation, this component just exposes a controlled form so
 * ``K`` / ``R`` / ``1..3`` can pre-fill it before commit.
 */

import { useEffect, useState } from 'react'
import { Check, X } from 'lucide-react'
import {
  PRIMARY_STYLES,
  SCOPE_LABELS,
  SCOPE_TITLES,
  STYLE_TITLES,
  type PrimaryStyle,
  type ScopeLabel,
} from '@drawable/contracts'
import { Button, StatusDot } from '../primitives'
import type { CurationCandidate } from './types'

export interface ReviewFormState {
  primaryStyle: PrimaryStyle
  scopes: ScopeLabel[]
  quality: 1 | 2 | 3 | null
  note: string
  malformedAnatomy: boolean
  poorExtraction: boolean
}

export interface CurateInspectorProps {
  candidate: CurationCandidate | null
  pendingForm: ReviewFormState | null
  onFormChange: (next: ReviewFormState) => void
  onKeep: () => void
  onReject: () => void
  onSnapshot: () => void
  busy: boolean
  snapshotPending: boolean
  disabled?: boolean
}

const QUALITY_DESCRIPTORS: Record<1 | 2 | 3, string> = {
  1: 'Reference quality only',
  2: 'Usable in the gallery',
  3: 'Anchor-quality example',
}

function defaultForm(candidate: CurationCandidate): ReviewFormState {
  return {
    primaryStyle: candidate.primary_style,
    scopes: [...candidate.scopes],
    quality: null,
    note: '',
    malformedAnatomy: false,
    poorExtraction: false,
  }
}

export function CurateInspector({
  candidate,
  pendingForm,
  onFormChange,
  onKeep,
  onReject,
  onSnapshot,
  busy,
  snapshotPending,
  disabled,
}: CurateInspectorProps) {
  // When the candidate changes, reset the local draft so the inspector
  // doesn't carry reviewer notes from the previous asset forward.
  const [draft, setDraft] = useState<ReviewFormState | null>(pendingForm)
  useEffect(() => {
    setDraft(pendingForm)
  }, [pendingForm, candidate?.asset_id])

  // When the candidate first arrives we also seed a fresh form in the
  // parent so keyboard shortcuts have a target to mutate.
  useEffect(() => {
    if (candidate && !pendingForm) {
      onFormChange(defaultForm(candidate))
    }
  }, [candidate, pendingForm, onFormChange])

  if (!candidate) {
    return (
      <aside className="candidate-inspector">
        <div className="inspector-title">
          <span className="dock-eyebrow">Candidate metadata</span>
          <h2>No candidate</h2>
        </div>
        <p className="scaffold-note">
          The curation queue is empty. Press <kbd>→</kbd> to fetch the next
          asset or export a snapshot to release the work so far.
        </p>
        <div className="review-actions">
          <Button disabled={disabled || snapshotPending} onClick={onSnapshot}>
            Export snapshot
          </Button>
        </div>
      </aside>
    )
  }

  const update = (patch: Partial<ReviewFormState>) => {
    if (!draft) return
    const next = { ...draft, ...patch }
    setDraft(next)
    onFormChange(next)
  }

  const toggleScope = (scope: ScopeLabel) => {
    if (!draft) return
    const has = draft.scopes.includes(scope)
    const scopes = has ? draft.scopes.filter((value) => value !== scope) : [...draft.scopes, scope]
    update({ scopes })
  }

  const form = draft ?? defaultForm(candidate)
  const canKeep = form.quality !== null && !busy
  const canReject = !busy

  return (
    <aside className="candidate-inspector">
      <div className="inspector-title">
        <span className="dock-eyebrow">Candidate metadata</span>
        <h2 data-testid="inspector-asset-id">{candidate.asset_id}</h2>
      </div>

      <label>
        <span>Primary style</span>
        <select
          value={form.primaryStyle}
          onChange={(event) => update({ primaryStyle: event.target.value as PrimaryStyle })}
          disabled={busy}
          data-testid="style-select"
        >
          {PRIMARY_STYLES.map((style) => (
            <option key={style} value={style}>
              {STYLE_TITLES[style]}
            </option>
          ))}
        </select>
      </label>

      <fieldset>
        <legend>Scopes (toggle)</legend>
        <div className="scope-chips">
          {SCOPE_LABELS.filter((scope) => scope !== 'unknown').map((scope) => {
            const active = form.scopes.includes(scope)
            return (
              <button
                key={scope}
                type="button"
                className={`chip ${active ? 'is-active' : ''}`}
                aria-pressed={active}
                onClick={() => toggleScope(scope)}
                disabled={busy}
                data-testid={`scope-chip-${scope}`}
              >
                {SCOPE_TITLES[scope]}
              </button>
            )
          })}
        </div>
      </fieldset>

      <fieldset>
        <legend>Quality</legend>
        <div className="segmented-control" role="radiogroup" aria-label="Quality">
          {([1, 2, 3] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={form.quality === value}
              className={form.quality === value ? 'is-active' : ''}
              onClick={() => update({ quality: value })}
              title={QUALITY_DESCRIPTORS[value]}
              disabled={busy}
              data-testid={`quality-${value}`}
            >
              {value}
            </button>
          ))}
        </div>
        <small className="field-hint">
          {form.quality ? QUALITY_DESCRIPTORS[form.quality] : 'Required to keep'}
        </small>
      </fieldset>

      <fieldset className="flag-fieldset">
        <legend>Flags</legend>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={form.malformedAnatomy}
            onChange={(event) => update({ malformedAnatomy: event.target.checked })}
            disabled={busy}
            data-testid="flag-malformed"
          />
          Malformed anatomy
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={form.poorExtraction}
            onChange={(event) => update({ poorExtraction: event.target.checked })}
            disabled={busy}
            data-testid="flag-poor"
          />
          Poor line-art extraction
        </label>
      </fieldset>

      <label className="note-field">
        <span>Review note</span>
        <textarea
          value={form.note}
          onChange={(event) => update({ note: event.target.value })}
          maxLength={2000}
          placeholder="Optional note…"
          disabled={busy}
          data-testid="note-input"
        />
      </label>

      <dl className="metadata-list">
        <div>
          <dt>Source work</dt>
          <dd data-testid="source-work">{candidate.source_work_id}</dd>
        </div>
        <div>
          <dt>Resolution</dt>
          <dd>
            {candidate.width} × {candidate.height}
          </dd>
        </div>
        <div>
          <dt>Line art</dt>
          <dd>{candidate.origin === 'native_line_art' ? 'Native' : 'Extracted'}</dd>
        </div>
        <div>
          <dt>Quality score</dt>
          <dd>{candidate.quality_score.toFixed(2)}</dd>
        </div>
        <div>
          <dt>SFW check</dt>
          <dd>
            <StatusDot tone={candidate.sfw_safe ? 'success' : 'warning'} />
            {candidate.sfw_safe ? `Passed · ${(candidate.sfw_confidence * 100).toFixed(0)}%` : 'Flagged'}
          </dd>
        </div>
      </dl>

      <div className="review-actions">
        <Button
          className="button--danger"
          onClick={onReject}
          disabled={!canReject}
          data-testid="reject-button"
        >
          <X size={16} /> Reject <kbd>R</kbd>
        </Button>
        <Button
          className="button--primary"
          onClick={onKeep}
          disabled={!canKeep}
          data-testid="keep-button"
        >
          <Check size={16} /> Keep <kbd>K</kbd>
        </Button>
      </div>

      <div className="review-actions review-actions--secondary">
        <Button
          onClick={onSnapshot}
          disabled={disabled || snapshotPending}
          data-testid="snapshot-button"
        >
          {snapshotPending ? 'Exporting…' : 'Export snapshot'}
        </Button>
      </div>
    </aside>
  )
}
