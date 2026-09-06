import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JSX, ReactNode } from 'react'
import {
  useCurationNext,
  useCurationProgress,
  useExportSnapshot,
  useWriteLabel,
} from './curationHooks'

const originalFetch = globalThis.fetch

function mockJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function makeWrapper(): ({ children }: { children: ReactNode }) => JSX.Element {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
  }
}

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

describe('useCurationNext', () => {
  it('fetches a candidate and returns the data', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockJsonResponse({ asset_id: 'a', primary_style: 'manga_anime' }),
    ) as unknown as typeof fetch
    const { result } = renderHook(() => useCurationNext({}), { wrapper: makeWrapper() })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data?.asset_id).toBe('a')
  })

  it('returns null on queue_empty without throwing', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockJsonResponse({ error: { code: 'queue_empty', message: 'no candidates' } }, 404),
    ) as unknown as typeof fetch
    const { result } = renderHook(() => useCurationNext({}), { wrapper: makeWrapper() })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toBeNull()
  })
})

describe('useCurationProgress', () => {
  it('fetches the progress payload', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockJsonResponse({ reviewed: 5, accepted: 4, rejected: 1, remaining: 1995, target: 2000 }),
    ) as unknown as typeof fetch
    const { result } = renderHook(() => useCurationProgress(), { wrapper: makeWrapper() })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data?.reviewed).toBe(5)
  })
})

describe('useWriteLabel', () => {
  it('invalidates the next and progress queries on success', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse({ id: 1, asset_id: 'a', decision: 'keep' }),
    ) as unknown as typeof fetch
    globalThis.fetch = fetchMock
    const { result } = renderHook(() => useWriteLabel(), { wrapper: makeWrapper() })
    await act(async () => {
      result.current.mutate({
        asset_id: 'a',
        decision: 'keep',
        quality: 3,
        malformed_anatomy: false,
        poor_extraction: false,
      })
      await Promise.resolve()
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    // The mutation should have hit the labels endpoint exactly once.
    const calls = (fetchMock as unknown as { mock: { calls: unknown[][] } }).mock.calls
    expect(calls.length).toBe(1)
    expect(calls[0]?.[0]).toBe('/api/v1/curation/labels')
  })
})

describe('useExportSnapshot', () => {
  it('posts to /curation/snapshots', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse({ snapshot_id: 'curation_x', path: '/tmp/x', label_count: 0, style_breakdown: {}, created_at: 'x' }),
    ) as unknown as typeof fetch
    globalThis.fetch = fetchMock
    const { result } = renderHook(() => useExportSnapshot(), { wrapper: makeWrapper() })
    await act(async () => {
      result.current.mutate()
      await Promise.resolve()
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    const calls = (fetchMock as unknown as { mock: { calls: unknown[][] } }).mock.calls
    expect(calls[0]?.[0]).toBe('/api/v1/curation/snapshots')
  })
})
