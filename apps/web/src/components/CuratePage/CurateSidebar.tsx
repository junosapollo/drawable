/**
 * Left-hand sidebar: review progress (overall and by style) and the
 * style/scope filter chips that scope the queue.
 *
 * Clicking a style chip sets the ``?style=`` filter on ``/curation/next``
 * (focused review of a single style). Clicking again clears the filter.
 */

import { useMemo } from 'react'
import {
  PRIMARY_STYLES,
  SCOPE_LABELS,
  SCOPE_TITLES,
  STYLE_TITLES,
  type PrimaryStyle,
  type ScopeLabel,
} from '@drawable/contracts'
import { StatusDot } from '../primitives'
import type { CurationProgress } from './types'

export type StyleFilter = PrimaryStyle | null
export type ScopeFilter = ScopeLabel | null

export interface CurateSidebarProps {
  progress: CurationProgress | null
  style: StyleFilter
  scope: ScopeFilter
  onStyle: (next: StyleFilter) => void
  onScope: (next: ScopeFilter) => void
}

export function CurateSidebar({ progress, style, scope, onStyle, onScope }: CurateSidebarProps) {
  const overall = useMemo(() => {
    if (!progress) {
      return { reviewed: 0, accepted: 0, rejected: 0, remaining: 0, target: 2000 }
    }
    return {
      reviewed: progress.reviewed,
      accepted: progress.accepted,
      rejected: progress.rejected,
      remaining: progress.remaining,
      target: progress.target,
    }
  }, [progress])

  const percent = overall.target > 0 ? Math.min(100, (overall.reviewed / overall.target) * 100) : 0

  const scopeOptions = SCOPE_LABELS.filter((label) => label !== 'unknown')

  return (
    <aside className="research-sidebar" aria-label="Review progress and filters">
      <div className="progress-block" data-testid="progress-block">
        <span>
          Review progress <strong data-testid="progress-text">{overall.reviewed} / {overall.target}</strong>
        </span>
        <div>
          <i style={{ width: `${percent.toFixed(1)}%` }} />
        </div>
        <ul className="progress-stats">
          <li>
            <StatusDot tone="success" /> {overall.accepted} accepted
          </li>
          <li>
            <StatusDot tone="error" /> {overall.rejected} rejected
          </li>
          <li>
            <StatusDot tone="warning" /> {overall.remaining} remaining
          </li>
        </ul>
      </div>

      <nav className="filter-list" aria-label="Filter by primary style">
        <span className="filter-heading">Primary style</span>
        <button
          type="button"
          className={style === null ? 'is-active' : ''}
          onClick={() => onStyle(null)}
          data-testid="style-filter-all"
        >
          <span>All styles</span>
          <b>{overall.reviewed}</b>
        </button>
        {PRIMARY_STYLES.map((value) => {
          const bucket = progress?.by_style[value]
          return (
            <button
              key={value}
              type="button"
              className={style === value ? 'is-active' : ''}
              onClick={() => onStyle(style === value ? null : value)}
              data-testid={`style-filter-${value}`}
            >
              <span>
                <StatusDot tone={bucket && bucket.remaining > 0 ? 'warning' : 'success'} />
                {STYLE_TITLES[value]}
              </span>
              <b>{bucket?.remaining ?? 0}</b>
            </button>
          )
        })}
      </nav>

      <nav className="filter-list" aria-label="Filter by scope">
        <span className="filter-heading">Scope</span>
        <button
          type="button"
          className={scope === null ? 'is-active' : ''}
          onClick={() => onScope(null)}
          data-testid="scope-filter-all"
        >
          <span>All scopes</span>
          <b>{overall.remaining}</b>
        </button>
        {scopeOptions.map((value) => {
          const bucket = progress?.by_scope[value]
          return (
            <button
              key={value}
              type="button"
              className={scope === value ? 'is-active' : ''}
              onClick={() => onScope(scope === value ? null : value)}
              data-testid={`scope-filter-${value}`}
            >
              <span>{SCOPE_TITLES[value]}</span>
              <b>{bucket?.remaining ?? 0}</b>
            </button>
          )
        })}
      </nav>

      <div className="keyboard-note">
        <div>
          <kbd>K</kbd> Keep
        </div>
        <div>
          <kbd>R</kbd> Reject
        </div>
        <div>
          <kbd>1</kbd>/<kbd>2</kbd>/<kbd>3</kbd> Quality
        </div>
        <div>
          <kbd>C</kbd> Toggle crop
        </div>
        <div>
          <kbd>←</kbd>/<kbd>→</kbd> History
        </div>
      </div>
    </aside>
  )
}
