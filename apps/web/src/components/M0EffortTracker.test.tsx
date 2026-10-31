import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom'
import type { M0EffortChunk } from '../services/m0Effort'
import { M0EffortTracker } from './M0EffortTracker'

const storage = vi.hoisted(() => ({
  chunks: [] as M0EffortChunk[],
  failure: null as Error | null,
  pending: null as { promise: Promise<void>; resolve: () => void } | null,
}))

vi.mock('../services/m0Effort', async () => {
  const actual = await vi.importActual<typeof import('../services/m0Effort')>('../services/m0Effort')
  return {
    ...actual,
    appendM0EffortChunk: vi.fn(async (chunk: M0EffortChunk) => {
      storage.chunks.push(chunk)
      if (storage.pending) await storage.pending.promise
      if (storage.failure) throw storage.failure
    }),
  }
})

function TestRoutes() {
  return (
    <MemoryRouter initialEntries={['/m0']}>
      <Routes>
        <Route path="/m0" element={<nav><Link to="/draw">Draw</Link><Link to="/record">Record</Link></nav>} />
        <Route path="/record" element={<nav><Link to="/m0">M0</Link><Link to="/draw">Draw</Link></nav>} />
        <Route path="/draw" element={<nav><Link to="/m0">M0</Link></nav>} />
      </Routes>
      <M0EffortTracker />
    </MemoryRouter>
  )
}

async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

beforeEach(() => {
  storage.chunks = []
  storage.failure = null
  storage.pending = null
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] })
  vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('M0 effort timer lifecycle', () => {
  it('pauses on leaving tracked work and does not resume when returning', async () => {
    render(<TestRoutes />)
    fireEvent.click(screen.getByRole('button', { name: 'Start effort' }))
    await advance(2_000)
    fireEvent.click(screen.getByRole('link', { name: 'Draw' }))
    expect(screen.queryByLabelText('M0 active effort timer')).toBeNull()
    await advance(5_000)
    fireEvent.click(screen.getByRole('link', { name: 'M0' }))
    expect(screen.getByRole('button', { name: 'Start effort' })).toBeVisible()
    await advance(3_000)
    expect(storage.chunks).toHaveLength(1)
    expect(storage.chunks[0]!.activeMs).toBe(2_000)
    expect(screen.getByLabelText('M0 active effort timer').querySelector('output')).toHaveTextContent('00:00:02')
  })

  it('keeps timing when switching between M0 and Record', async () => {
    render(<TestRoutes />)
    fireEvent.click(screen.getByRole('button', { name: 'Start effort' }))
    await advance(2_000)
    fireEvent.click(screen.getByRole('link', { name: 'Record' }))
    expect(screen.getByRole('button', { name: 'Pause effort' })).toBeVisible()
    await advance(2_000)
    fireEvent.click(screen.getByRole('link', { name: 'M0' }))
    expect(screen.getByRole('button', { name: 'Pause effort' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Pause effort' }))
    await advance(0)
    expect(storage.chunks).toHaveLength(1)
    expect(storage.chunks[0]!.activeMs).toBe(4_000)
  })

  it('pauses when the document becomes hidden and does not resume when visible again', async () => {
    render(<TestRoutes />)
    fireEvent.click(screen.getByRole('button', { name: 'Start effort' }))
    await advance(2_000)
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    fireEvent(document, new Event('visibilitychange'))
    expect(screen.getByRole('button', { name: 'Start effort' })).toBeVisible()
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    await advance(5_000)
    expect(storage.chunks).toHaveLength(1)
    expect(storage.chunks[0]!.activeMs).toBe(2_000)
  })

  it('writes one final interval when unmounted', async () => {
    const rendered = render(<TestRoutes />)
    fireEvent.click(screen.getByRole('button', { name: 'Start effort' }))
    await advance(2_000)
    rendered.unmount()
    await advance(0)
    expect(storage.chunks).toHaveLength(1)
    expect(storage.chunks[0]!.activeMs).toBe(2_000)
  })

  it('blocks restart until a paused interval has been persisted', async () => {
    let resolve!: () => void
    const promise = new Promise<void>((yes) => { resolve = yes })
    storage.pending = { promise, resolve }
    render(<TestRoutes />)
    fireEvent.click(screen.getByRole('button', { name: 'Start effort' }))
    await advance(2_000)
    fireEvent.click(screen.getByRole('button', { name: 'Pause effort' }))
    expect(screen.getByRole('button', { name: 'Start effort' })).toBeDisabled()
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(storage.chunks).toHaveLength(1)
    expect(storage.chunks[0]!.activeMs).toBe(2_000)
    await act(async () => { resolve(); await promise; await Promise.resolve(); await Promise.resolve() })
    expect(screen.getByRole('button', { name: 'Start effort' })).toBeEnabled()
  })
})
