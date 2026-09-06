import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from './apiClient'
import {
  exportSnapshot,
  fetchCurationProgress,
  fetchNextCandidate,
  writeLabel,
} from './curationClient'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

function mockJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('fetchNextCandidate', () => {
  it('returns the candidate on a 200', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockJsonResponse({ asset_id: 'a', primary_style: 'manga_anime' }),
    ) as unknown as typeof fetch
    const result = await fetchNextCandidate({ style: 'manga_anime' })
    expect(result?.asset_id).toBe('a')
  })

  it('returns null on a 404 with code queue_empty', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockJsonResponse({ error: { code: 'queue_empty', message: 'no candidates' } }, 404),
    ) as unknown as typeof fetch
    expect(await fetchNextCandidate({})).toBeNull()
  })

  it('returns null on a 404 with code gallery_unavailable', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockJsonResponse({ error: { code: 'gallery_unavailable', message: 'no gallery' } }, 404),
    ) as unknown as typeof fetch
    expect(await fetchNextCandidate({})).toBeNull()
  })

  it('throws on a 404 with a different error code', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockJsonResponse({ error: { code: 'asset_not_found', message: 'nope' } }, 404),
    ) as unknown as typeof fetch
    await expect(fetchNextCandidate({})).rejects.toBeInstanceOf(ApiError)
  })

  it('appends the style and scope to the query string', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse({ asset_id: 'a' })) as unknown as typeof fetch
    globalThis.fetch = fetchMock
    await fetchNextCandidate({ style: 'cartoon', scope: 'eye' })
    const url = (fetchMock as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0] as string
    expect(url).toContain('style=cartoon')
    expect(url).toContain('scope=eye')
  })
})

describe('fetchCurationProgress', () => {
  it('hits /curation/progress', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse({ reviewed: 1, accepted: 1, rejected: 0, remaining: 1999, target: 2000 }),
    ) as unknown as typeof fetch
    globalThis.fetch = fetchMock
    const result = await fetchCurationProgress()
    expect(result.reviewed).toBe(1)
    expect((fetchMock as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0]).toBe(
      '/api/v1/curation/progress',
    )
  })
})

describe('writeLabel', () => {
  it('POSTs JSON to /curation/labels', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse({ id: 1, asset_id: 'a', decision: 'keep', review_state: 'accepted' }),
    ) as unknown as typeof fetch
    globalThis.fetch = fetchMock
    await writeLabel({
      asset_id: 'a',
      decision: 'keep',
      quality: 3,
      malformed_anatomy: false,
      poor_extraction: false,
    })
    const [url, init] = (fetchMock as unknown as { mock: { calls: unknown[][] } }).mock.calls[0] ?? []
    expect(url).toBe('/api/v1/curation/labels')
    expect((init as RequestInit).method).toBe('POST')
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({ decision: 'keep' })
  })
})

describe('exportSnapshot', () => {
  it('POSTs to /curation/snapshots', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse({ snapshot_id: 'curation_x', path: '/tmp/x.json', label_count: 0, style_breakdown: {}, created_at: 'x' }),
    ) as unknown as typeof fetch
    globalThis.fetch = fetchMock
    const result = await exportSnapshot()
    expect(result.snapshot_id).toBe('curation_x')
  })
})
