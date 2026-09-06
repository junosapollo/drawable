import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@radix-ui/react-tooltip'
import { useServiceStore } from '../services/serviceRegistry'
import type { JSX, ReactNode } from 'react'

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
    return (
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <TooltipProvider delayDuration={500}>{children}</TooltipProvider>
        </MemoryRouter>
      </QueryClientProvider>
    )
  }
}

beforeEach(() => {
  // Pretend the service registry has already probed the API and the API is
  // live with curation enabled. This is the only configuration the page
  // actually renders against.
  useServiceStore.setState({
    mode: 'live',
    health: {
      mode: 'cpu',
      ready: true,
      message: 'API',
      live: true,
      health: {
        ready: true,
        fixture_mode: true,
        cuda_available: false,
        device: 'cpu',
        gpu_name: null,
        vram_total_mb: null,
        torch_version: null,
        api_version: '0.1.0',
        schema_version: 1,
        models: [],
        dataset_version: 'synthetic',
        index_version: 'abc',
        gallery_size: 24,
        disabled_branches: [],
        warmup: 'skipped',
        warnings: [],
        curation_enabled: true,
      },
    },
  })
})

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
  useServiceStore.setState({ mode: 'probing', health: null })
})

describe('CuratePage', () => {
  it('renders the curator once a candidate is loaded', async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/curation/next')) {
        return Promise.resolve(
          mockJsonResponse({
            asset_id: 'ls_test',
            primary_style: 'manga_anime',
            scopes: ['eye'],
            width: 256,
            height: 256,
            thumbnail_url: '/api/v1/assets/ls_test/thumbnail',
            line_art_url: '/api/v1/assets/ls_test/line-art',
            origin: 'native_line_art',
            crop: null,
            review_state: 'unreviewed',
            quality_score: 0.85,
            sfw_safe: true,
            sfw_confidence: 0.99,
            source_work_id: 'synthetic-work-000',
          }),
        )
      }
      if (url.includes('/curation/progress')) {
        return Promise.resolve(
          mockJsonResponse({
            reviewed: 0,
            accepted: 0,
            rejected: 0,
            remaining: 2000,
            target: 2000,
            by_style: {
              manga_anime: { reviewed: 0, accepted: 0, rejected: 0, remaining: 1 },
              western_ink: { reviewed: 0, accepted: 0, rejected: 0, remaining: 0 },
              realistic_academic: { reviewed: 0, accepted: 0, rejected: 0, remaining: 0 },
              cartoon: { reviewed: 0, accepted: 0, rejected: 0, remaining: 0 },
              gesture_sketch: { reviewed: 0, accepted: 0, rejected: 0, remaining: 0 },
            },
            by_scope: {
              eye: { reviewed: 0, accepted: 0, rejected: 0, remaining: 1 },
              face_head: { reviewed: 0, accepted: 0, rejected: 0, remaining: 0 },
              hair: { reviewed: 0, accepted: 0, rejected: 0, remaining: 0 },
              hand: { reviewed: 0, accepted: 0, rejected: 0, remaining: 0 },
              foot: { reviewed: 0, accepted: 0, rejected: 0, remaining: 0 },
              upper_body_clothing: { reviewed: 0, accepted: 0, rejected: 0, remaining: 0 },
              full_body: { reviewed: 0, accepted: 0, rejected: 0, remaining: 0 },
              multi_character: { reviewed: 0, accepted: 0, rejected: 0, remaining: 0 },
            },
          }),
        )
      }
      return Promise.reject(new Error('unexpected URL ' + url))
    }) as unknown as typeof fetch

    const CuratePage = (await import('./CuratePage')).default
    render(<CuratePage />, { wrapper: makeWrapper() })
    await waitFor(() => expect(screen.getByTestId('inspector-asset-id').textContent).toBe('ls_test'))
    // The image is rendered through the real candidate URL.
    const img = screen.getByTestId('candidate-img') as HTMLImageElement
    expect(img.getAttribute('src')).toBe('/api/v1/assets/ls_test/thumbnail')
  })

  it('shows the empty state when the queue is drained', async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/curation/next')) {
        return Promise.resolve(
          mockJsonResponse({ error: { code: 'queue_empty', message: 'empty' } }, 404),
        )
      }
      if (url.includes('/curation/progress')) {
        return Promise.resolve(
          mockJsonResponse({
            reviewed: 24,
            accepted: 24,
            rejected: 0,
            remaining: 0,
            target: 2000,
            by_style: {
              manga_anime: { reviewed: 0, accepted: 0, rejected: 0, remaining: 0 },
              western_ink: { reviewed: 0, accepted: 0, rejected: 0, remaining: 0 },
              realistic_academic: { reviewed: 0, accepted: 0, rejected: 0, remaining: 0 },
              cartoon: { reviewed: 0, accepted: 0, rejected: 0, remaining: 0 },
              gesture_sketch: { reviewed: 0, accepted: 0, rejected: 0, remaining: 0 },
            },
            by_scope: {
              eye: { reviewed: 0, accepted: 0, rejected: 0, remaining: 0 },
              face_head: { reviewed: 0, accepted: 0, rejected: 0, remaining: 0 },
              hair: { reviewed: 0, accepted: 0, rejected: 0, remaining: 0 },
              hand: { reviewed: 0, accepted: 0, rejected: 0, remaining: 0 },
              foot: { reviewed: 0, accepted: 0, rejected: 0, remaining: 0 },
              upper_body_clothing: { reviewed: 0, accepted: 0, rejected: 0, remaining: 0 },
              full_body: { reviewed: 0, accepted: 0, rejected: 0, remaining: 0 },
              multi_character: { reviewed: 0, accepted: 0, rejected: 0, remaining: 0 },
            },
          }),
        )
      }
      return Promise.reject(new Error('unexpected URL ' + url))
    }) as unknown as typeof fetch
    const CuratePage = (await import('./CuratePage')).default
    render(<CuratePage />, { wrapper: makeWrapper() })
    await waitFor(() => expect(screen.getByText(/queue empty/i)).toBeInTheDocument())
  })

  it('disables the page when curation is off and the API is live', async () => {
    useServiceStore.setState({
      mode: 'live',
      health: {
        mode: 'cpu',
        ready: true,
        message: 'API',
        live: true,
        health: {
          ready: true,
          fixture_mode: true,
          cuda_available: false,
          device: 'cpu',
          gpu_name: null,
          vram_total_mb: null,
          torch_version: null,
          api_version: '0.1.0',
          schema_version: 1,
          models: [],
          dataset_version: 'synthetic',
          index_version: 'abc',
          gallery_size: 24,
          disabled_branches: [],
          warmup: 'skipped',
          warnings: [],
          curation_enabled: false,
        },
      },
    })
    const CuratePage = (await import('./CuratePage')).default
    render(<CuratePage />, { wrapper: makeWrapper() })
    expect(await screen.findByText(/Curation mode is off/i)).toBeInTheDocument()
  })

  it('submits a label on the K keyboard shortcut', async () => {
    let labelPayload: unknown = null
    globalThis.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/curation/next')) {
        return Promise.resolve(
          mockJsonResponse({
            asset_id: 'ls_shortcut',
            primary_style: 'manga_anime',
            scopes: ['eye'],
            width: 256,
            height: 256,
            thumbnail_url: '/api/v1/assets/ls_shortcut/thumbnail',
            line_art_url: '/api/v1/assets/ls_shortcut/line-art',
            origin: 'native_line_art',
            crop: null,
            review_state: 'unreviewed',
            quality_score: 0.85,
            sfw_safe: true,
            sfw_confidence: 0.99,
            source_work_id: 'synthetic-work-000',
          }),
        )
      }
      if (url.includes('/curation/progress')) {
        return Promise.resolve(
          mockJsonResponse({
            reviewed: 0,
            accepted: 0,
            rejected: 0,
            remaining: 2000,
            target: 2000,
            by_style: {},
            by_scope: {},
          }),
        )
      }
      if (url.includes('/curation/labels')) {
        labelPayload = init ? JSON.parse(init.body as string) : null
        return Promise.resolve(
          mockJsonResponse({ id: 1, asset_id: 'ls_shortcut', decision: 'keep', review_state: 'accepted' }),
        )
      }
      return Promise.reject(new Error('unexpected URL ' + url))
    }) as unknown as typeof fetch
    const CuratePage = (await import('./CuratePage')).default
    render(<CuratePage />, { wrapper: makeWrapper() })
    await screen.findByTestId('inspector-asset-id')
    // Set quality via the shortcut, then submit on K.
    fireEvent.keyDown(window, { key: '3' })
    fireEvent.keyDown(window, { key: 'k' })
    await waitFor(() => expect(labelPayload).toBeTruthy())
    expect(labelPayload).toMatchObject({ asset_id: 'ls_shortcut', decision: 'keep', quality: 3 })
  })

  it('submits a label on the R keyboard shortcut', async () => {
    let labelPayload: unknown = null
    globalThis.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/curation/next')) {
        return Promise.resolve(
          mockJsonResponse({
            asset_id: 'ls_reject',
            primary_style: 'manga_anime',
            scopes: ['eye'],
            width: 256,
            height: 256,
            thumbnail_url: '/api/v1/assets/ls_reject/thumbnail',
            line_art_url: '/api/v1/assets/ls_reject/line-art',
            origin: 'native_line_art',
            crop: null,
            review_state: 'unreviewed',
            quality_score: 0.85,
            sfw_safe: true,
            sfw_confidence: 0.99,
            source_work_id: 'synthetic-work-000',
          }),
        )
      }
      if (url.includes('/curation/progress')) {
        return Promise.resolve(
          mockJsonResponse({
            reviewed: 0,
            accepted: 0,
            rejected: 0,
            remaining: 2000,
            target: 2000,
            by_style: {},
            by_scope: {},
          }),
        )
      }
      if (url.includes('/curation/labels')) {
        labelPayload = init ? JSON.parse(init.body as string) : null
        return Promise.resolve(
          mockJsonResponse({ id: 1, asset_id: 'ls_reject', decision: 'reject', review_state: 'rejected' }),
        )
      }
      return Promise.reject(new Error('unexpected URL ' + url))
    }) as unknown as typeof fetch
    const CuratePage = (await import('./CuratePage')).default
    render(<CuratePage />, { wrapper: makeWrapper() })
    await screen.findByTestId('inspector-asset-id')
    fireEvent.keyDown(window, { key: '1' })
    fireEvent.keyDown(window, { key: 'r' })
    await waitFor(() => expect(labelPayload).toBeTruthy())
    expect(labelPayload).toMatchObject({ decision: 'reject' })
  })

  it('does not submit a keep without a quality', async () => {
    let labelPayload: unknown = null
    globalThis.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/curation/next')) {
        return Promise.resolve(
          mockJsonResponse({
            asset_id: 'ls_noquality',
            primary_style: 'manga_anime',
            scopes: ['eye'],
            width: 256,
            height: 256,
            thumbnail_url: '/api/v1/assets/ls_noquality/thumbnail',
            line_art_url: '/api/v1/assets/ls_noquality/line-art',
            origin: 'native_line_art',
            crop: null,
            review_state: 'unreviewed',
            quality_score: 0.85,
            sfw_safe: true,
            sfw_confidence: 0.99,
            source_work_id: 'synthetic-work-000',
          }),
        )
      }
      if (url.includes('/curation/progress')) {
        return Promise.resolve(
          mockJsonResponse({
            reviewed: 0,
            accepted: 0,
            rejected: 0,
            remaining: 2000,
            target: 2000,
            by_style: {},
            by_scope: {},
          }),
        )
      }
      if (url.includes('/curation/labels')) {
        labelPayload = init ? JSON.parse(init.body as string) : null
        return Promise.resolve(
          mockJsonResponse({ id: 1, asset_id: 'ls_noquality', decision: 'keep', review_state: 'accepted' }),
        )
      }
      return Promise.reject(new Error('unexpected URL ' + url))
    }) as unknown as typeof fetch
    const CuratePage = (await import('./CuratePage')).default
    render(<CuratePage />, { wrapper: makeWrapper() })
    await screen.findByTestId('inspector-asset-id')
    fireEvent.keyDown(window, { key: 'k' })
    // Allow any in-flight async work to settle.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(labelPayload).toBeNull()
  })

  it('renders the keyboard shortcut help HUD', async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/curation/next')) {
        return Promise.resolve(
          mockJsonResponse({
            asset_id: 'ls_help',
            primary_style: 'manga_anime',
            scopes: ['eye'],
            width: 256,
            height: 256,
            thumbnail_url: '/api/v1/assets/ls_help/thumbnail',
            line_art_url: '/api/v1/assets/ls_help/line-art',
            origin: 'native_line_art',
            crop: null,
            review_state: 'unreviewed',
            quality_score: 0.85,
            sfw_safe: true,
            sfw_confidence: 0.99,
            source_work_id: 'synthetic-work-000',
          }),
        )
      }
      if (url.includes('/curation/progress')) {
        return Promise.resolve(
          mockJsonResponse({
            reviewed: 0,
            accepted: 0,
            rejected: 0,
            remaining: 2000,
            target: 2000,
            by_style: {},
            by_scope: {},
          }),
        )
      }
      return Promise.reject(new Error('unexpected URL ' + url))
    }) as unknown as typeof fetch
    const CuratePage = (await import('./CuratePage')).default
    render(<CuratePage />, { wrapper: makeWrapper() })
    await screen.findByTestId('inspector-asset-id')
    // The help overlay always lists the core shortcuts.
    expect(screen.getByTestId('kbd-hud')).toBeInTheDocument()
    expect(screen.getByText(/Keep current candidate/i)).toBeInTheDocument()
    expect(screen.getByText(/Reject current candidate/i)).toBeInTheDocument()
    expect(screen.getByText(/Set quality/i)).toBeInTheDocument()
    expect(screen.getByText(/Toggle crop edit/i)).toBeInTheDocument()
  })

  it('flashes the last pressed key in the HUD', async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/curation/next')) {
        return Promise.resolve(
          mockJsonResponse({
            asset_id: 'ls_pulse',
            primary_style: 'manga_anime',
            scopes: ['eye'],
            width: 256,
            height: 256,
            thumbnail_url: '/api/v1/assets/ls_pulse/thumbnail',
            line_art_url: '/api/v1/assets/ls_pulse/line-art',
            origin: 'native_line_art',
            crop: null,
            review_state: 'unreviewed',
            quality_score: 0.85,
            sfw_safe: true,
            sfw_confidence: 0.99,
            source_work_id: 'synthetic-work-000',
          }),
        )
      }
      if (url.includes('/curation/progress')) {
        return Promise.resolve(
          mockJsonResponse({
            reviewed: 0,
            accepted: 0,
            rejected: 0,
            remaining: 2000,
            target: 2000,
            by_style: {},
            by_scope: {},
          }),
        )
      }
      return Promise.reject(new Error('unexpected URL ' + url))
    }) as unknown as typeof fetch
    const CuratePage = (await import('./CuratePage')).default
    render(<CuratePage />, { wrapper: makeWrapper() })
    await screen.findByTestId('inspector-asset-id')
    // No pulse yet.
    expect(screen.queryByTestId('kbd-hud-last')).toBeNull()
    // Press a quality key and the pulse appears.
    fireEvent.keyDown(window, { key: '2' })
    expect(await screen.findByTestId('kbd-hud-last')).toHaveTextContent('2')
  })

  it('shows a toast when K is pressed without a quality', async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/curation/next')) {
        return Promise.resolve(
          mockJsonResponse({
            asset_id: 'ls_toast',
            primary_style: 'manga_anime',
            scopes: ['eye'],
            width: 256,
            height: 256,
            thumbnail_url: '/api/v1/assets/ls_toast/thumbnail',
            line_art_url: '/api/v1/assets/ls_toast/line-art',
            origin: 'native_line_art',
            crop: null,
            review_state: 'unreviewed',
            quality_score: 0.85,
            sfw_safe: true,
            sfw_confidence: 0.99,
            source_work_id: 'synthetic-work-000',
          }),
        )
      }
      if (url.includes('/curation/progress')) {
        return Promise.resolve(
          mockJsonResponse({
            reviewed: 0,
            accepted: 0,
            rejected: 0,
            remaining: 2000,
            target: 2000,
            by_style: {},
            by_scope: {},
          }),
        )
      }
      return Promise.reject(new Error('unexpected URL ' + url))
    }) as unknown as typeof fetch
    const CuratePage = (await import('./CuratePage')).default
    render(<CuratePage />, { wrapper: makeWrapper() })
    await screen.findByTestId('inspector-asset-id')
    expect(screen.queryByTestId('kbd-toast-missing-quality')).toBeNull()
    fireEvent.keyDown(window, { key: 'k' })
    expect(await screen.findByTestId('kbd-toast-missing-quality')).toBeInTheDocument()
  })
})
