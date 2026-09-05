export const LOGICAL_SIZE = 2048

export type Tool = 'pressure' | 'monoline' | 'eraser' | 'hand'
export type ThemeChoice = 'system' | 'dark' | 'light'
export type DockMode = 'references' | 'layers'

export interface DrawPoint {
  x: number
  y: number
  pressure: number
  time: number
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

export interface DrawingLayer {
  id: string
  name: string
  visible: boolean
  opacity: number
  operations: StrokeOperation[]
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
  style: ReferenceStyle
  scope: string
  source: string
  native: boolean
  match: 'Strong' | 'Close' | 'Related'
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
  revision: number
  generation: number
  strokeCount: number
  textHint: string
}

export interface SearchResponse {
  revision: number
  generation: number
  mode: SearchMode
  interpretation: string
  groups: ReferenceGroup[]
}

export interface HealthResult {
  mode: 'fixture' | 'cpu' | 'cuda'
  ready: boolean
  message: string
}
