/**
 * Live service implementation backed by the FastAPI worker.
 *
 * Adapts the wire contract (`@drawable/contracts`) to the UI's view models in
 * `lib/types.ts` so the reference dock does not care whether results come from
 * the fixture ranker or a real model.
 */

import {
  SCOPE_TITLES,
  STYLE_TITLES,
  type HealthResponse,
  type PrimaryStyle,
  type SearchGroup,
  type SearchResponse as ApiSearchResponse,
  type SearchResult,
  type StyleSelection,
} from '@drawable/contracts'
import type { HealthResult, ReferenceAsset, ReferenceGroup, SearchRequest, SearchResponse } from '../lib/types'
import { LOGICAL_SIZE } from '../lib/types'
import { api } from './apiClient'
import { fixtureAssets } from './fixtures'
import type { FrontendServices } from './frontendServices'

export const UI_STYLE_TO_API: Record<string, PrimaryStyle> = {
  'Manga / anime': 'manga_anime',
  'Western ink': 'western_ink',
  Realistic: 'realistic_academic',
  Cartoon: 'cartoon',
  Gesture: 'gesture_sketch',
}

const API_STYLE_TO_UI: Record<PrimaryStyle, ReferenceAsset['style']> = {
  manga_anime: 'Manga / anime',
  western_ink: 'Western ink',
  realistic_academic: 'Realistic',
  cartoon: 'Cartoon',
  gesture_sketch: 'Gesture',
}

export function matchLabel(relevance: number): ReferenceAsset['match'] {
  if (relevance >= 0.8) return 'Strong'
  if (relevance >= 0.6) return 'Close'
  return 'Related'
}

export function toReferenceAsset(result: SearchResult): ReferenceAsset {
  const scope = result.scopes.map((label) => SCOPE_TITLES[label]).join(' · ') || 'Reference'
  return {
    id: result.asset_id,
    title: `${scope} ${result.asset_id.slice(-4)}`,
    imageUrl: result.thumbnail_url,
    fullImageUrl: result.asset_url,
    style: API_STYLE_TO_UI[result.style],
    scope,
    source: 'Local gallery',
    native: result.origin === 'native_line_art',
    match: matchLabel(result.relevance),
    relevance: result.relevance,
    traceAllowed: true,
  }
}

export function toReferenceGroup(group: SearchGroup): ReferenceGroup {
  return {
    id: group.kind === 'best_match' ? 'best' : group.id,
    title: group.kind === 'style' && group.style ? STYLE_TITLES[group.style] : group.title,
    tentative: group.kind === 'provisional_scope',
    results: group.results.map(toReferenceAsset),
  }
}

export function toSearchResponse(response: ApiSearchResponse, request: SearchRequest): SearchResponse {
  const top = response.scope_predictions[0]
  const interpretation =
    response.mode === 'insufficient'
      ? 'Keep drawing'
      : top && top.label !== 'unknown'
        ? `${SCOPE_TITLES[top.label]} · ${Math.round(top.confidence * 100)}%`
        : 'Reading early marks'
  return {
    revision: response.revision,
    generation: request.generation,
    mode: request.strokeCount === 0 ? 'empty' : response.mode,
    interpretation,
    groups: response.groups.map(toReferenceGroup),
    warning: response.warning ?? null,
    timing: response.timing,
  }
}

export function toHealthResult(health: HealthResponse): HealthResult {
  const mode = health.fixture_mode ? 'fixture' : health.device === 'cuda' ? 'cuda' : 'cpu'
  const gallery = `${health.gallery_size.toLocaleString()} references`
  const message = !health.ready
    ? (health.warnings[0] ?? 'API is not ready')
    : health.device === 'cuda'
      ? `${health.gpu_name ?? 'GPU'} · ${gallery}`
      : `CPU fallback — slower search · ${gallery}`
  return { mode, ready: health.ready, message, live: true, health }
}

function toStyleSelection(selected: string | null): StyleSelection | undefined {
  if (!selected) return undefined
  return UI_STYLE_TO_API[selected] ?? undefined
}

export const liveServices: FrontendServices = {
  health: {
    get: async (signal) => toHealthResult(await api.health(signal)),
  },
  search: {
    async search(request, signal) {
      if (!request.image) throw new Error('Live search requires a snapshot image')
      const response = await api.search(
        {
          sessionId: request.sessionId,
          revision: request.revision,
          canvasWidth: LOGICAL_SIZE,
          canvasHeight: LOGICAL_SIZE,
          strokeCount: request.strokeCount,
          pointCount: request.pointCount,
          image: request.image,
          strokes: request.strokes,
          textHint: request.textHint || undefined,
          selectedStyle: toStyleSelection(request.selectedStyle),
        },
        signal,
      )
      return toSearchResponse(response, request)
    },
  },
  assets: {
    async resolveTrace(assetId: string) {
      const fixture = fixtureAssets.find((asset) => asset.id === assetId)
      if (fixture) return fixture.imageUrl
      if (assetId.startsWith('ls_')) return `/api/v1/assets/${assetId}/line-art`
      return null
    },
  },
  events: {
    record: (event) => api.recordEvent(event).then(() => undefined),
  },
  preferences: {
    get: () => api.getPreferences(),
    update: (update) => api.updatePreferences(update),
  },
}
