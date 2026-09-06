/**
 * LineScout API contracts.
 *
 * `./openapi.ts` is generated from `openapi.json` (which is exported from the
 * FastAPI app) — never edit it by hand. This file adds ergonomic aliases and
 * the runtime constant arrays the UI needs for chips, ordering, and guards.
 * The arrays are checked against the generated unions at compile time, so a
 * taxonomy change on the Python side fails `npm run check` here until updated.
 */

import type { components, operations, paths } from './openapi'

export type { components, operations, paths }

type Schemas = components['schemas']

// ------------------------------------------------------------------ enums

export type PrimaryStyle = Schemas['PrimaryStyle']
export type ScopeLabel = Schemas['ScopeLabel']
export type LineArtOrigin = Schemas['LineArtOrigin']
export type SearchMode = Schemas['SearchMode']
export type InteractionEvent = Schemas['InteractionEvent']
export type StyleSelection = Schemas['StyleSelection']

/** Fixed default style-row order for new preference profiles (spec §3). */
export const DEFAULT_STYLE_ORDER = [
  'manga_anime',
  'realistic_academic',
  'western_ink',
  'cartoon',
  'gesture_sketch',
] as const satisfies readonly PrimaryStyle[]

export const PRIMARY_STYLES = [
  'manga_anime',
  'western_ink',
  'realistic_academic',
  'cartoon',
  'gesture_sketch',
] as const satisfies readonly PrimaryStyle[]

export const SCOPE_LABELS = [
  'eye',
  'face_head',
  'hair',
  'hand',
  'foot',
  'upper_body_clothing',
  'full_body',
  'multi_character',
  'unknown',
] as const satisfies readonly ScopeLabel[]

export const STYLE_TITLES: Record<PrimaryStyle, string> = {
  manga_anime: 'Manga / anime',
  western_ink: 'Western comic / ink',
  realistic_academic: 'Realistic / academic',
  cartoon: 'Cartoon',
  gesture_sketch: 'Gesture / sketch',
}

export const SCOPE_TITLES: Record<ScopeLabel, string> = {
  eye: 'Eye',
  face_head: 'Face / head',
  hair: 'Hair',
  hand: 'Hand',
  foot: 'Foot',
  upper_body_clothing: 'Upper body / clothing',
  full_body: 'Full body',
  multi_character: 'Multi-character',
  unknown: 'Unknown',
}

// Exhaustiveness guards: if the Python enum gains a member, these stop compiling.
type AssertSame<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never
const _styles: AssertSame<(typeof PRIMARY_STYLES)[number], PrimaryStyle> = true
const _scopes: AssertSame<(typeof SCOPE_LABELS)[number], ScopeLabel> = true
void _styles
void _scopes

export function isPrimaryStyle(value: unknown): value is PrimaryStyle {
  return typeof value === 'string' && (PRIMARY_STYLES as readonly string[]).includes(value)
}

// ------------------------------------------------------------------ models

export type HealthResponse = Schemas['HealthResponse']
export type ModelVersion = Schemas['ModelVersion']

export type SearchResponse = Schemas['SearchResponse']
export type SearchGroup = Schemas['SearchGroup']
export type SearchResult = Schemas['SearchResult']
export type SearchTiming = Schemas['SearchTiming']
export type ScopePrediction = Schemas['ScopePrediction']

export type StrokeSequence = Schemas['StrokeSequence']
export type Stroke = Schemas['Stroke']
export type StrokePoint = Schemas['StrokePoint']

export type EventRequest = Schemas['EventRequest']
export type EventResponse = Schemas['EventResponse']

export type PreferencesResponse = Schemas['PreferencesResponse']
export type PreferencesUpdate = Schemas['PreferencesUpdate']
export type StyleAffinity = Schemas['StyleAffinity']

// ----------------------------------------------------------------- curation

export type CropBox = Schemas['CropBox']
export type CurationCandidate = Schemas['CurationCandidate']
export type CurationProgress = Schemas['CurationProgress']
export type LabelRequest = Schemas['LabelRequest']
export type LabelResponse = Schemas['LabelResponse']
export type SnapshotResponse = Schemas['SnapshotResponse']

export type ErrorResponse = { error: { code: string; message: string; field?: string | null } }

/** Multipart fields for `POST /api/v1/search`; `image` and `strokes` are Blobs. */
export type SearchFormFields = Schemas['Body_search_api_v1_search_post']

// ------------------------------------------------------------------ limits (mirror services/api/config.py)

export const SEARCH_LIMITS = {
  maxImageBytes: 4 * 1024 * 1024,
  maxStrokesBytes: 2 * 1024 * 1024,
  maxTextHintChars: 120,
  minPointsForSearch: 20,
  minInkDiagonalRatio: 0.02,
  canvasLogicalSize: 2048,
  snapshotSize: 512,
  debounceMs: 350,
} as const

export const API_PREFIX = '/api/v1'
