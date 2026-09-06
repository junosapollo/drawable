/**
 * Thin fetch client for the LineScout API.
 *
 * Every URL is relative: in development Vite proxies `/api` to the FastAPI
 * worker, and in production the static bundle is served next to it. The
 * browser must never be pointed at localhost directly.
 */

import {
  API_PREFIX,
  type ErrorResponse,
  type EventRequest,
  type EventResponse,
  type HealthResponse,
  type PreferencesResponse,
  type PreferencesUpdate,
  type SearchResponse,
  type StrokeSequence,
  type StyleSelection,
} from '@drawable/contracts'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly field?: string | null,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

async function parseError(response: Response): Promise<ApiError> {
  try {
    const body = (await response.json()) as Partial<ErrorResponse>
    if (body.error) return new ApiError(response.status, body.error.code, body.error.message, body.error.field)
  } catch {
    // fall through to the generic error
  }
  return new ApiError(response.status, `http_${response.status}`, response.statusText || 'Request failed')
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_PREFIX}${path}`, init)
  if (!response.ok) throw await parseError(response)
  return (await response.json()) as T
}

function json(body: unknown, method: 'POST' | 'PUT'): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}

export interface SearchPayload {
  sessionId: string
  revision: number
  canvasWidth: number
  canvasHeight: number
  strokeCount: number
  pointCount: number
  image: Blob
  strokes?: StrokeSequence
  textHint?: string
  selectedStyle?: StyleSelection
}

export async function gzipBytes(value: unknown): Promise<Uint8Array<ArrayBuffer>> {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  if (typeof CompressionStream === 'undefined') throw new Error('CompressionStream unavailable')
  const source = new ReadableStream<BufferSource>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
  const reader = source.pipeThrough(new CompressionStream('gzip')).getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value: chunk } = await reader.read()
    if (done) break
    chunks.push(chunk)
    total += chunk.byteLength
  }
  const out = new Uint8Array(new ArrayBuffer(total))
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

export async function gzipJson(value: unknown): Promise<Blob> {
  const bytes = await gzipBytes(value)
  return new Blob([bytes], { type: 'application/gzip' })
}

export async function buildSearchForm(payload: SearchPayload): Promise<FormData> {
  const form = new FormData()
  form.set('session_id', payload.sessionId)
  form.set('revision', String(payload.revision))
  form.set('canvas_width', String(payload.canvasWidth))
  form.set('canvas_height', String(payload.canvasHeight))
  form.set('stroke_count', String(payload.strokeCount))
  form.set('point_count', String(payload.pointCount))
  form.set('image', payload.image, 'snapshot.png')
  if (payload.strokes) form.set('strokes', await gzipJson(payload.strokes), 'strokes.json.gz')
  if (payload.textHint) form.set('text_hint', payload.textHint)
  if (payload.selectedStyle) form.set('selected_style', payload.selectedStyle)
  return form
}

export const api = {
  health: (signal?: AbortSignal) => request<HealthResponse>('/health', { signal }),

  async search(payload: SearchPayload, signal: AbortSignal): Promise<SearchResponse> {
    const body = await buildSearchForm(payload)
    return request<SearchResponse>('/search', { method: 'POST', body, signal })
  },

  recordEvent: (event: EventRequest) => request<EventResponse>('/events', json(event, 'POST')),

  getPreferences: () => request<PreferencesResponse>('/preferences'),
  updatePreferences: (update: PreferencesUpdate) => request<PreferencesResponse>('/preferences', json(update, 'PUT')),
}
