/**
 * Typed fetch helpers for the `/api/v1/curation/*` endpoints.
 *
 * The shared `apiClient` already handles the URL prefix, JSON encoding, and
 * structured error parsing; this module adds the curation-specific shapes
 * (which are generated into `@drawable/contracts`) and a couple of ergonomic
 * defaults — for example, a `GET /curation/next` 404 with code
 * ``queue_empty`` is normalised to a ``null`` return value so the React
 * Query layer can treat "no more candidates" as a normal state instead of
 * an error.
 */

import {
  type CurationCandidate,
  type CurationProgress,
  type LabelRequest,
  type LabelResponse,
  type PrimaryStyle,
  type ScopeLabel,
  type SnapshotResponse,
} from '@drawable/contracts'
import { ApiError, apiRequest as request } from './apiClient'

export interface NextCandidateQuery {
  style?: PrimaryStyle
  scope?: ScopeLabel
}

/** 404 -> ``null``, anything else propagates as an :class:`ApiError`. */
export async function fetchNextCandidate(
  query: NextCandidateQuery,
  signal?: AbortSignal,
): Promise<CurationCandidate | null> {
  const params = new URLSearchParams()
  if (query.style) params.set('style', query.style)
  if (query.scope) params.set('scope', query.scope)
  const path = params.toString() ? `/curation/next?${params}` : '/curation/next'
  try {
    return await request<CurationCandidate>(path, { signal })
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      // ``queue_empty`` is the "we drained the queue" path; ``gallery_unavailable``
      // means the API was started without a gallery manifest. Both are
      // first-class empty states from the UI's perspective.
      if (error.code === 'queue_empty' || error.code === 'gallery_unavailable') return null
    }
    throw error
  }
}

export function fetchCurationProgress(signal?: AbortSignal): Promise<CurationProgress> {
  return request<CurationProgress>('/curation/progress', { signal })
}

export function writeLabel(body: LabelRequest): Promise<LabelResponse> {
  return request<LabelResponse>('/curation/labels', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export function exportSnapshot(): Promise<SnapshotResponse> {
  return request<SnapshotResponse>('/curation/snapshots', { method: 'POST' })
}
