import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, api, buildSearchForm, gzipBytes } from './apiClient'

const png = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' })

describe('api client', () => {
  afterEach(() => vi.restoreAllMocks())

  it('builds the multipart search form with spec field names', async () => {
    const form = await buildSearchForm({
      sessionId: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
      revision: 7,
      canvasWidth: 2048,
      canvasHeight: 2048,
      strokeCount: 3,
      pointCount: 120,
      image: png,
      textHint: 'eye',
      selectedStyle: 'manga_anime',
      strokes: { version: 1, canvas_width: 2048, canvas_height: 2048, strokes: [] },
    })
    expect([...form.keys()].sort()).toEqual([
      'canvas_height', 'canvas_width', 'image', 'point_count', 'revision', 'selected_style',
      'session_id', 'stroke_count', 'strokes', 'text_hint',
    ])
    expect(form.get('revision')).toBe('7')
    expect((form.get('image') as File).name).toBe('snapshot.png')
    expect((form.get('strokes') as File).name).toBe('strokes.json.gz')
  })

  it('gzips stroke JSON with a gzip magic header', async () => {
    const bytes = await gzipBytes({ a: 1 })
    expect([bytes[0], bytes[1]]).toEqual([0x1f, 0x8b])
    // Round-trips through DecompressionStream.
    const source = new ReadableStream<BufferSource>({ start(c) { c.enqueue(bytes); c.close() } })
    const text = await new Response(source.pipeThrough(new DecompressionStream('gzip'))).text()
    expect(JSON.parse(text)).toEqual({ a: 1 })
  })

  it('omits optional fields when absent', async () => {
    const form = await buildSearchForm({
      sessionId: 's', revision: 1, canvasWidth: 2048, canvasHeight: 2048, strokeCount: 0, pointCount: 0, image: png,
    })
    expect(form.has('strokes')).toBe(false)
    expect(form.has('text_hint')).toBe(false)
    expect(form.has('selected_style')).toBe(false)
  })

  it('uses relative URLs and surfaces structured errors', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'image_too_large', message: 'too big', field: 'image' } }), { status: 413 }),
    )
    await expect(api.health()).rejects.toMatchObject({ status: 413, code: 'image_too_large', field: 'image' } satisfies Partial<ApiError>)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/health')
  })

  it('falls back to a generic error for non-JSON failures', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<html>', { status: 502, statusText: 'Bad Gateway' }))
    await expect(api.getPreferences()).rejects.toMatchObject({ status: 502, code: 'http_502' })
  })
})
