/**
 * CanvasStage.test.tsx
 *
 * Tests focused on the two rendering optimisations added to CanvasStage:
 *  A. Committed-layer incremental rendering (append vs. full-rebuild)
 *  B. Active-stroke rAF coalescing (at most one paint per frame)
 *
 * Test infrastructure:
 *  - Real isolated createDocumentStore() through DocumentStoreProvider
 *  - Mocked resolveRasterImages with controllable promises
 *  - Mocked canvas 2D contexts that record every call
 *  - Manually advanced rAF queue
 */

import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CanvasStage } from './CanvasStage'
import { renderDrawingOperation, renderLayer } from '../lib/drawing'
import { createDocumentStore } from '../state/documentStore'
import { DocumentStoreProvider } from '../state/documentStore'
import type { StoreApi } from 'zustand/vanilla'
import type { DocumentState } from '../state/documentStore'

// ─── Module mocks ────────────────────────────────────────────────────────────

vi.mock('../lib/drawing', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/drawing')>()
  return {
    ...real,
    renderLayer: vi.fn(),
    renderDrawingOperation: vi.fn(),
    renderOperation: vi.fn(),
  }
})

// resolveRasterImages is replaced with a controllable deferred.
vi.mock('../services/rasterAssets', () => ({
  resolveRasterImages: vi.fn(() => Promise.resolve(new Map())),
}))

// useSearchStore/useViewStore are not the focus; provide minimal stubs.
vi.mock('../state/searchStore', () => ({
  useSearchStore: (selector: (s: { invalidate: () => number; setDrawing: (b: boolean) => void; generation: number; drawing: boolean; loading: boolean; error: null; response: null; textHint: string; selectedStyle: null; selectedAsset: null; pinned: never[] }) => unknown) => {
    const state = {
      invalidate: vi.fn(() => 1),
      setDrawing: vi.fn(),
      generation: 0,
      drawing: false,
      loading: false,
      error: null,
      response: null,
      textHint: '',
      selectedStyle: null,
      selectedAsset: null,
      pinned: [],
    }
    return selector(state)
  },
}))

vi.mock('../state/viewStore', () => ({
  useViewStore: (selector: (s: { zoom: number; panX: number; panY: number; fitRequest: number; setView: () => void; requestFit: () => void }) => unknown) => {
    const state = {
      zoom: 1,
      panX: 0,
      panY: 0,
      fitRequest: 0,
      setView: vi.fn(),
      requestFit: vi.fn(),
    }
    return selector(state)
  },
}))

// ─── Canvas context mock ──────────────────────────────────────────────────────

function makeContextMock() {
  return {
    clearRect: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    fill: vi.fn(),
    drawImage: vi.fn(),
    globalCompositeOperation: 'source-over',
    fillStyle: '',
  }
}

let contextMocks: Map<HTMLCanvasElement, ReturnType<typeof makeContextMock>>

beforeEach(() => {
  contextMocks = new Map()

  // jsdom doesn't implement ResizeObserver; provide a no-op stub.
  const ResizeObserverStub = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverStub

  // jsdom doesn't implement PointerEvent; provide a stub subclassing MouseEvent.
  class PointerEventStub extends MouseEvent {
    readonly pointerId: number
    readonly pressure: number
    readonly pointerType: string

    constructor(type: string, params: PointerEventInit = {}) {
      super(type, params)
      this.pointerId = params.pointerId ?? 0
      this.pressure = params.pressure ?? 0
      this.pointerType = params.pointerType ?? 'mouse'
    }
  }
  ;(globalThis as unknown as { PointerEvent: unknown }).PointerEvent = PointerEventStub

  // jsdom doesn't implement setPointerCapture; provide a no-op stub.
  HTMLElement.prototype.setPointerCapture = vi.fn()

  // Intercept getContext on every canvas element.
  const originalGetContext = HTMLCanvasElement.prototype.getContext
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
    this: HTMLCanvasElement,
    type: string,
  ) {
    if (type === '2d') {
      if (!contextMocks.has(this)) contextMocks.set(this, makeContextMock())
      return contextMocks.get(this) as unknown as CanvasRenderingContext2D
    }
    return originalGetContext.call(this, type as '2d')
  })

  // Stub Path2D (jsdom does not implement it).
  ;(globalThis as { Path2D?: unknown }).Path2D = class {
    constructor(_: string) {}
  }

  // Manual rAF queue.
  let frameId = 0
  const frames = new Map<number, FrameRequestCallback>()
  vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
    frameId += 1
    frames.set(frameId, cb)
    return frameId
  })
  vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation((id: number) => {
    frames.delete(id)
  })
  ;(globalThis as { __flushRaf?: () => void }).__flushRaf = () => {
    for (const [id, cb] of [...frames]) {
      frames.delete(id)
      cb(performance.now())
    }
  }
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  delete (globalThis as { __flushRaf?: () => void }).__flushRaf
  delete (globalThis as { PointerEvent?: unknown }).PointerEvent
})

// ─── Helpers ─────────────────────────────────────────────────────────────────

import { resolveRasterImages } from '../services/rasterAssets'

function makeDeferred() {
  let resolve!: (v: Map<string, CanvasImageSource>) => void
  const promise = new Promise<Map<string, CanvasImageSource>>((res) => { resolve = res })
  return { promise, resolve }
}

function renderWithStore(store: StoreApi<DocumentState>) {
  return render(
    <DocumentStoreProvider store={store}>
      <CanvasStage searchIntegration="disabled" />
    </DocumentStoreProvider>,
  )
}

function flushRaf() {
  ;(globalThis as { __flushRaf?: () => void }).__flushRaf?.()
}

// ─── A. Committed-layer incremental rendering ─────────────────────────────────

describe('committed-layer rendering', () => {
  it('A1: fully initialises every layer on first render', async () => {
    const deferred = makeDeferred()
    vi.mocked(resolveRasterImages).mockReturnValue(deferred.promise)

    const store = createDocumentStore()
    renderWithStore(store)

    await act(async () => { deferred.resolve(new Map()) })

    const layerCount = store.getState().document.layers.length
    expect(vi.mocked(renderLayer)).toHaveBeenCalledTimes(layerCount)
  })

  it('A2: single stroke append calls renderDrawingOperation once; renderLayer not called for that layer', async () => {
    const store = createDocumentStore()

    // First render (initial empty state).
    const firstDeferred = makeDeferred()
    vi.mocked(resolveRasterImages).mockReturnValueOnce(firstDeferred.promise)
    renderWithStore(store)
    await act(async () => { firstDeferred.resolve(new Map()) })

    vi.mocked(renderLayer).mockClear()
    vi.mocked(renderDrawingOperation).mockClear()

    // Commit a stroke to layer-1.
    const secondDeferred = makeDeferred()
    vi.mocked(resolveRasterImages).mockReturnValueOnce(secondDeferred.promise)

    const op = {
      id: 'stroke-1',
      kind: 'stroke' as const,
      tool: 'pressure' as const,
      points: [{ x: 100, y: 100, pressure: 0.5, time: 0 }],
      size: 12,
      smoothing: 0.1,
      streamline: 0,
      simulatePressure: false,
      createdAt: Date.now(),
    }
    act(() => { store.getState().commitOperation(op) })
    await act(async () => { secondDeferred.resolve(new Map()) })

    // Only the new operation was drawn; full rebuild must not have been called for layer-1.
    expect(vi.mocked(renderDrawingOperation)).toHaveBeenCalledTimes(1)
    // Other layers (empty, so no-ops in append path) must not trigger renderLayer.
    expect(vi.mocked(renderLayer)).toHaveBeenCalledTimes(0)
  })

  it('A3: multiple batched appends draw only the suffix in order', async () => {
    const store = createDocumentStore()

    const firstDeferred = makeDeferred()
    vi.mocked(resolveRasterImages).mockReturnValueOnce(firstDeferred.promise)
    renderWithStore(store)
    await act(async () => { firstDeferred.resolve(new Map()) })

    // Commit op1.
    const op1 = {
      id: 'stroke-op1', kind: 'stroke' as const, tool: 'pressure' as const,
      points: [{ x: 10, y: 10, pressure: 0.5, time: 0 }], size: 12,
      smoothing: 0.1, streamline: 0, simulatePressure: false, createdAt: 1,
    }
    const secondDeferred = makeDeferred()
    vi.mocked(resolveRasterImages).mockReturnValueOnce(secondDeferred.promise)
    act(() => { store.getState().commitOperation(op1) })
    await act(async () => { secondDeferred.resolve(new Map()) })

    vi.mocked(renderLayer).mockClear()
    vi.mocked(renderDrawingOperation).mockClear()

    // Commit op2 then op3 in the same React update batch.
    const op2 = { ...op1, id: 'stroke-op2', createdAt: 2 }
    const op3 = { ...op1, id: 'stroke-op3', createdAt: 3 }
    const thirdDeferred = makeDeferred()
    vi.mocked(resolveRasterImages).mockReturnValueOnce(thirdDeferred.promise)
    act(() => {
      store.getState().commitOperation(op2)
      store.getState().commitOperation(op3)
    })
    await act(async () => { thirdDeferred.resolve(new Map()) })

    // Two new operations drawn (op2 and op3 are the suffix after op1).
    expect(vi.mocked(renderDrawingOperation)).toHaveBeenCalledTimes(2)
    expect(vi.mocked(renderLayer)).toHaveBeenCalledTimes(0)
  })

  it('A4: eraser append uses renderDrawingOperation (not renderLayer)', async () => {
    const store = createDocumentStore()

    // Seed a stroke first.
    const stroke = {
      id: 'stroke-seed', kind: 'stroke' as const, tool: 'pressure' as const,
      points: [{ x: 10, y: 10, pressure: 0.5, time: 0 }], size: 12,
      smoothing: 0.1, streamline: 0, simulatePressure: false, createdAt: 1,
    }
    const d1 = makeDeferred()
    vi.mocked(resolveRasterImages).mockReturnValueOnce(d1.promise)
    renderWithStore(store)
    await act(async () => { d1.resolve(new Map()) })

    const d2 = makeDeferred()
    vi.mocked(resolveRasterImages).mockReturnValueOnce(d2.promise)
    act(() => { store.getState().commitOperation(stroke) })
    await act(async () => { d2.resolve(new Map()) })

    vi.mocked(renderLayer).mockClear()
    vi.mocked(renderDrawingOperation).mockClear()

    // Append an eraser.
    const eraser = {
      id: 'eraser-1', kind: 'stroke' as const, tool: 'eraser' as const,
      points: [{ x: 20, y: 20, pressure: 0.5, time: 0 }], size: 16,
      smoothing: 0.1, streamline: 0, simulatePressure: false, createdAt: 2,
    }
    const d3 = makeDeferred()
    vi.mocked(resolveRasterImages).mockReturnValueOnce(d3.promise)
    act(() => { store.getState().commitOperation(eraser) })
    await act(async () => { d3.resolve(new Map()) })

    expect(vi.mocked(renderDrawingOperation)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(renderLayer)).toHaveBeenCalledTimes(0)
  })

  it('A5: metadata-only updates (title, trace) do not trigger any canvas painting', async () => {
    const store = createDocumentStore()
    const d1 = makeDeferred()
    vi.mocked(resolveRasterImages).mockReturnValueOnce(d1.promise)
    renderWithStore(store)
    await act(async () => { d1.resolve(new Map()) })

    vi.mocked(renderLayer).mockClear()
    vi.mocked(renderDrawingOperation).mockClear()

    // Title change: changes document metadata without altering operations.
    await act(async () => { store.getState().setTitle('My sketch') })

    // Trace visibility toggle.
    await act(async () => { store.getState().updateTrace({ visible: false }) })

    // Invariant 5: Metadata-only updates do not paint operations or rebuild layers.
    expect(vi.mocked(renderLayer)).toHaveBeenCalledTimes(0)
    expect(vi.mocked(renderDrawingOperation)).toHaveBeenCalledTimes(0)
  })

  it('A6: undo triggers a full rebuild of the affected layer, not an append', async () => {
    const store = createDocumentStore()
    const d1 = makeDeferred()
    vi.mocked(resolveRasterImages).mockReturnValueOnce(d1.promise)
    renderWithStore(store)
    await act(async () => { d1.resolve(new Map()) })

    // Commit a stroke.
    const op = {
      id: 'stroke-undo', kind: 'stroke' as const, tool: 'pressure' as const,
      points: [{ x: 1, y: 1, pressure: 0.5, time: 0 }], size: 12,
      smoothing: 0.1, streamline: 0, simulatePressure: false, createdAt: 1,
    }
    const d2 = makeDeferred()
    vi.mocked(resolveRasterImages).mockReturnValueOnce(d2.promise)
    act(() => { store.getState().commitOperation(op) })
    await act(async () => { d2.resolve(new Map()) })

    vi.mocked(renderLayer).mockClear()
    vi.mocked(renderDrawingOperation).mockClear()

    // Undo.
    const d3 = makeDeferred()
    vi.mocked(resolveRasterImages).mockReturnValueOnce(d3.promise)
    act(() => { store.getState().undo() })
    await act(async () => { d3.resolve(new Map()) })

    // The affected layer must be fully rebuilt (prefix is no longer valid).
    expect(vi.mocked(renderLayer)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(renderDrawingOperation)).toHaveBeenCalledTimes(0)
  })

  it('A7: redo after undo uses the append path when valid', async () => {
    const store = createDocumentStore()
    const d1 = makeDeferred()
    vi.mocked(resolveRasterImages).mockReturnValueOnce(d1.promise)
    renderWithStore(store)
    await act(async () => { d1.resolve(new Map()) })

    const op = {
      id: 'stroke-redo', kind: 'stroke' as const, tool: 'pressure' as const,
      points: [{ x: 1, y: 1, pressure: 0.5, time: 0 }], size: 12,
      smoothing: 0.1, streamline: 0, simulatePressure: false, createdAt: 1,
    }
    const d2 = makeDeferred()
    vi.mocked(resolveRasterImages).mockReturnValueOnce(d2.promise)
    act(() => { store.getState().commitOperation(op) })
    await act(async () => { d2.resolve(new Map()) })

    // Undo.
    const d3 = makeDeferred()
    vi.mocked(resolveRasterImages).mockReturnValueOnce(d3.promise)
    act(() => { store.getState().undo() })
    await act(async () => { d3.resolve(new Map()) })

    vi.mocked(renderLayer).mockClear()
    vi.mocked(renderDrawingOperation).mockClear()

    // Redo restores the operation — the baseline is now empty (after undo rebuilt),
    // so the restored op is a single append on top of the empty layer.
    const d4 = makeDeferred()
    vi.mocked(resolveRasterImages).mockReturnValueOnce(d4.promise)
    act(() => { store.getState().redo() })
    await act(async () => { d4.resolve(new Map()) })

    expect(vi.mocked(renderDrawingOperation)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(renderLayer)).toHaveBeenCalledTimes(0)
  })

  it('A8: clear layer causes a full rebuild of only that layer', async () => {
    const store = createDocumentStore()
    const op = {
      id: 'stroke-clr', kind: 'stroke' as const, tool: 'pressure' as const,
      points: [{ x: 1, y: 1, pressure: 0.5, time: 0 }], size: 12,
      smoothing: 0.1, streamline: 0, simulatePressure: false, createdAt: 1,
    }
    const d1 = makeDeferred()
    vi.mocked(resolveRasterImages).mockReturnValueOnce(d1.promise)
    renderWithStore(store)
    await act(async () => { d1.resolve(new Map()) })

    const d2 = makeDeferred()
    vi.mocked(resolveRasterImages).mockReturnValueOnce(d2.promise)
    act(() => { store.getState().commitOperation(op) })
    await act(async () => { d2.resolve(new Map()) })

    vi.mocked(renderLayer).mockClear()
    vi.mocked(renderDrawingOperation).mockClear()

    const d3 = makeDeferred()
    vi.mocked(resolveRasterImages).mockReturnValueOnce(d3.promise)
    act(() => { store.getState().clearLayer('layer-1') })
    await act(async () => { d3.resolve(new Map()) })

    // The cleared layer is rebuilt; other layers are append-only (empty → empty).
    expect(vi.mocked(renderLayer)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(renderDrawingOperation)).toHaveBeenCalledTimes(0)
  })

  it('A9: document replacement rebuilds all layers even when IDs are unchanged', async () => {
    const store = createDocumentStore()
    const d1 = makeDeferred()
    vi.mocked(resolveRasterImages).mockReturnValueOnce(d1.promise)
    renderWithStore(store)
    await act(async () => { d1.resolve(new Map()) })

    vi.mocked(renderLayer).mockClear()
    vi.mocked(renderDrawingOperation).mockClear()

    const { document } = store.getState()
    const newDoc = {
      ...document,
      id: 'new-doc-id',
      title: 'Replaced',
    }
    const d2 = makeDeferred()
    vi.mocked(resolveRasterImages).mockReturnValueOnce(d2.promise)
    act(() => { store.getState().replaceDocument(newDoc) })
    await act(async () => { d2.resolve(new Map()) })

    // All 4 layers must be fully rebuilt because document.id changed.
    expect(vi.mocked(renderLayer)).toHaveBeenCalledTimes(4)
  })

  it('A10: stale raster resolution does not paint or update baselines', async () => {
    const store = createDocumentStore()

    // Render #1.
    const d1 = makeDeferred()
    vi.mocked(resolveRasterImages).mockReturnValueOnce(d1.promise)
    renderWithStore(store)

    // Render #2 starts before #1 resolves (simulate slow raster load).
    const op = {
      id: 'stroke-stale', kind: 'stroke' as const, tool: 'pressure' as const,
      points: [{ x: 1, y: 1, pressure: 0.5, time: 0 }], size: 12,
      smoothing: 0.1, streamline: 0, simulatePressure: false, createdAt: 1,
    }
    const d2 = makeDeferred()
    vi.mocked(resolveRasterImages).mockReturnValueOnce(d2.promise)
    act(() => { store.getState().commitOperation(op) })

    // Resolve #2 first (newer wins).
    await act(async () => { d2.resolve(new Map()) })

    vi.mocked(renderLayer).mockClear()
    vi.mocked(renderDrawingOperation).mockClear()

    // Now resolve #1 (stale) — it should be a no-op because its active flag is false.
    await act(async () => { d1.resolve(new Map()) })

    // Nothing should have been painted by the stale completion.
    expect(vi.mocked(renderLayer)).toHaveBeenCalledTimes(0)
    expect(vi.mocked(renderDrawingOperation)).toHaveBeenCalledTimes(0)
  })
})

// ─── B. Active-stroke rAF coalescing ─────────────────────────────────────────
// jsdom does not propagate PointerEvent.pointerId from the init dict, so
// all pointer events dispatched by fireEvent will have pointerId === 0.
// We work around this by dispatching events via `new PointerEvent()` which
// jsdom does support (the property is readable even if not settable via init
// in older versions), or by simply not setting drawingPointer in a way that
// depends on pointerId matching. The approach used here: dispatch real
// PointerEvents using `element.dispatchEvent(new PointerEvent(...))` which
// preserves the init dict including pointerId.

describe('active-stroke rAF coalescing', () => {
  function dispatch(element: Element, type: string, init: PointerEventInit = {}) {
    element.dispatchEvent(
      new PointerEvent(type, {
        pointerId: 1,
        clientX: 200,
        clientY: 200,
        button: 0,
        buttons: 1,
        pressure: 0.5,
        pointerType: 'mouse',
        bubbles: true,
        cancelable: true,
        ...init,
      }),
    )
  }

  it('B1: no active paint occurs before a rAF is flushed', async () => {
    const { renderOperation } = await import('../lib/drawing')
    const store = createDocumentStore()
    const d1 = makeDeferred()
    vi.mocked(resolveRasterImages).mockReturnValue(d1.promise)
    const { getByLabelText } = renderWithStore(store)
    await act(async () => { d1.resolve(new Map()) })

    vi.mocked(renderOperation).mockClear()
    const rafSpy = vi.mocked(requestAnimationFrame)
    rafSpy.mockClear()

    const stage = getByLabelText('Drawing canvas')
    act(() => { dispatch(stage, 'pointerdown') })

    // requestAnimationFrame must have been queued exactly once.
    expect(rafSpy).toHaveBeenCalledTimes(1)
    // But renderOperation must NOT have been called yet.
    expect(vi.mocked(renderOperation)).toHaveBeenCalledTimes(0)
  })

  it('B2: flushing the rAF causes exactly one active paint for multiple moves', async () => {
    const { renderOperation } = await import('../lib/drawing')
    const store = createDocumentStore()
    const d1 = makeDeferred()
    vi.mocked(resolveRasterImages).mockReturnValue(d1.promise)
    const { getByLabelText } = renderWithStore(store)
    await act(async () => { d1.resolve(new Map()) })

    vi.mocked(renderOperation).mockClear()

    const stage = getByLabelText('Drawing canvas')
    act(() => {
      dispatch(stage, 'pointerdown')
      dispatch(stage, 'pointermove', { clientX: 210 })
      dispatch(stage, 'pointermove', { clientX: 220 })
      dispatch(stage, 'pointermove', { clientX: 230 })
    })

    // Still zero paints before flush.
    expect(vi.mocked(renderOperation)).toHaveBeenCalledTimes(0)

    // Flush — should produce exactly one paint.
    act(() => { flushRaf() })

    expect(vi.mocked(renderOperation)).toHaveBeenCalledTimes(1)
  })

  it('B3: second burst of moves produces one additional paint, not one per event', async () => {
    const { renderOperation } = await import('../lib/drawing')
    const store = createDocumentStore()
    const d1 = makeDeferred()
    vi.mocked(resolveRasterImages).mockReturnValue(d1.promise)
    const { getByLabelText } = renderWithStore(store)
    await act(async () => { d1.resolve(new Map()) })

    vi.mocked(renderOperation).mockClear()

    const stage = getByLabelText('Drawing canvas')
    act(() => {
      dispatch(stage, 'pointerdown')
      dispatch(stage, 'pointermove', { clientX: 210 })
      dispatch(stage, 'pointermove', { clientX: 220 })
    })
    act(() => { flushRaf() })
    expect(vi.mocked(renderOperation)).toHaveBeenCalledTimes(1)

    // Second burst.
    act(() => {
      dispatch(stage, 'pointermove', { clientX: 230 })
      dispatch(stage, 'pointermove', { clientX: 240 })
      dispatch(stage, 'pointermove', { clientX: 250 })
    })
    act(() => { flushRaf() })
    // Total should be 2 (one per burst), not 4 (one per event).
    expect(vi.mocked(renderOperation)).toHaveBeenCalledTimes(2)
  })

  it('B4: pointerup cancels queued frame; no active paint fires after overlay is cleared', async () => {
    const { renderOperation } = await import('../lib/drawing')
    const store = createDocumentStore()
    const dImm = makeDeferred()
    vi.mocked(resolveRasterImages).mockReturnValue(dImm.promise)
    const { getByLabelText } = renderWithStore(store)
    await act(async () => { dImm.resolve(new Map()) })

    vi.mocked(renderOperation).mockClear()
    const cancelSpy = vi.mocked(cancelAnimationFrame)
    cancelSpy.mockClear()

    const stage = getByLabelText('Drawing canvas')
    act(() => {
      dispatch(stage, 'pointerdown')
      dispatch(stage, 'pointermove', { clientX: 210 })
    })

    // Pointerup before flushing rAF: the queued frame should be cancelled.
    const commitDeferred = makeDeferred()
    vi.mocked(resolveRasterImages).mockReturnValueOnce(commitDeferred.promise)
    act(() => { dispatch(stage, 'pointerup') })

    // cancelAnimationFrame must have been called.
    expect(cancelSpy).toHaveBeenCalledTimes(1)

    // Flushing rAF now should NOT call renderOperation (the frame was cancelled).
    act(() => { flushRaf() })
    expect(vi.mocked(renderOperation)).toHaveBeenCalledTimes(0)
  })

  it('B5: pointercancel cancels queued frame', async () => {
    const { renderOperation } = await import('../lib/drawing')
    const store = createDocumentStore()
    const d1 = makeDeferred()
    vi.mocked(resolveRasterImages).mockReturnValue(d1.promise)
    const { getByLabelText } = renderWithStore(store)
    await act(async () => { d1.resolve(new Map()) })

    vi.mocked(renderOperation).mockClear()
    const cancelSpy = vi.mocked(cancelAnimationFrame)
    cancelSpy.mockClear()

    const stage = getByLabelText('Drawing canvas')
    act(() => {
      dispatch(stage, 'pointerdown')
      dispatch(stage, 'pointermove', { clientX: 210 })
    })

    act(() => { dispatch(stage, 'pointercancel') })

    // The queued frame was cancelled.
    expect(cancelSpy).toHaveBeenCalledTimes(1)
    act(() => { flushRaf() })
    expect(vi.mocked(renderOperation)).toHaveBeenCalledTimes(0)
  })

  it('B6: unmount cancels pending rAF frame', async () => {
    const store = createDocumentStore()
    const d1 = makeDeferred()
    vi.mocked(resolveRasterImages).mockReturnValue(d1.promise)
    const { getByLabelText, unmount } = renderWithStore(store)
    await act(async () => { d1.resolve(new Map()) })

    const { renderOperation } = await import('../lib/drawing')
    vi.mocked(renderOperation).mockClear()
    const cancelSpy = vi.mocked(cancelAnimationFrame)
    cancelSpy.mockClear()

    const stage = getByLabelText('Drawing canvas')
    act(() => {
      dispatch(stage, 'pointerdown')
      dispatch(stage, 'pointermove', { clientX: 210 })
    })

    // Unmount before rAF fires — the cleanup should cancel the frame.
    act(() => { unmount() })

    expect(cancelSpy).toHaveBeenCalledTimes(1)
    act(() => { flushRaf() })

    // renderOperation must not have been called after unmount.
    expect(vi.mocked(renderOperation)).toHaveBeenCalledTimes(0)
  })
})


