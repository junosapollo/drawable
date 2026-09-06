import type { HealthResponse, SearchTiming, StrokeSequence } from '@drawable/contracts'

export const LOGICAL_SIZE = 2048

export type Tool = 'pressure' | 'monoline' | 'eraser' | 'hand'
export type ThemeChoice = 'system' | 'dark' | 'light'
export type DockMode = 'references' | 'layers'

export type PointerKind = 'pen' | 'mouse' | 'touch'

export interface DrawPoint {
  x: number
  y: number
  pressure: number
  time: number
  /** Pointer type that produced the sample; older autosaves omit it. */
  pointerType?: PointerKind
}

export interface StrokeOperation {
  id: string
  kind: 'stroke'
  tool: Exclude<Tool, 'hand'>
  points: DrawPoint[]
  size: number
  smoothing: number
  streamline: number
  simulatePressure: boolean
  createdAt: number
}

export interface RasterOperation {
  id: string
  kind: 'raster'
  assetId: string
  x: number
  y: number
  width: number
  height: number
  createdAt: number
}

export type DrawingOperation = StrokeOperation | RasterOperation

export interface DrawingLayer {
  id: string
  name: string
  visible: boolean
  opacity: number
  operations: DrawingOperation[]
}

export interface TraceState {
  assetId: string | null
  imageUrl: string | null
  visible: boolean
  opacity: number
  scale: number
}

export interface DrawingDocument {
  id: string
  title: string
  revision: number
  updatedAt: number
  layers: DrawingLayer[]
  trace: TraceState
}

export type ReferenceStyle =
  | 'Manga / anime'
  | 'Western ink'
  | 'Realistic'
  | 'Cartoon'
  | 'Gesture'

export interface ReferenceAsset {
  id: string
  title: string
  imageUrl: string
  /** Trace-compatible full asset; falls back to imageUrl when absent. */
  fullImageUrl?: string
  style: ReferenceStyle
  scope: string
  source: string
  native: boolean
  match: 'Strong' | 'Close' | 'Related'
  relevance?: number
  traceAllowed: boolean
}

export interface ReferenceGroup {
  id: string
  title: string
  tentative?: boolean
  results: ReferenceAsset[]
}

export type SearchMode = 'empty' | 'insufficient' | 'provisional' | 'confident'

export interface SearchRequest {
  sessionId: string
  revision: number
  generation: number
  strokeCount: number
  pointCount: number
  textHint: string
  selectedStyle: string | null
  /** 512×512 PNG snapshot of visible ink; required by the live service. */
  image?: Blob
  strokes?: StrokeSequence
}

export interface SearchResponse {
  revision: number
  generation: number
  mode: SearchMode
  interpretation: string
  groups: ReferenceGroup[]
  warning?: string | null
  timing?: SearchTiming
}

export interface HealthResult {
  mode: 'fixture' | 'cpu' | 'cuda'
  ready: boolean
  message: string
  /** True when the result came from the API rather than the local fixture. */
  live?: boolean
  health?: HealthResponse
}

export interface EmbeddedProjectAsset {
  id: string
  mimeType: 'image/png'
  width: number
  height: number
  byteLength: number
  sha256: string
  data: string
}

export interface ExportedDrawingDocument extends Omit<DrawingDocument, 'id' | 'revision' | 'updatedAt' | 'trace'> {
  trace: Omit<TraceState, 'imageUrl'>
}

export interface DrawableProjectV1 {
  format: 'drawable-project'
  formatVersion: 1
  applicationVersion: string
  exportedAt: string
  document: ExportedDrawingDocument
  activeLayerId: string
  assets: EmbeddedProjectAsset[]
}

export interface StoredRasterAsset {
  id: string
  mimeType: 'image/png'
  width: number
  height: number
  sha256: string
  blob: Blob
}

export interface PreparedImport {
  document: DrawingDocument
  activeLayerId: string
  assets: StoredRasterAsset[]
  sourceKind: 'project' | 'png' | 'svg'
}
