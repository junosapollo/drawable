import { describe, expect, it, vi } from 'vitest'
import { EffortTimer } from './effortTimer'
import type { M0EffortChunk } from './m0Effort'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function timerHarness(append: (chunk: M0EffortChunk) => Promise<void>) {
  let monotonic = 0
  let wall = Date.UTC(2026, 0, 1)
  let id = 0
  const onChange = vi.fn()
  const timer = new EffortTimer(onChange, {
    append,
    monotonicNow: () => monotonic,
    wallNow: () => new Date(wall),
    newId: () => `id-${++id}`,
  })
  return {
    timer,
    onChange,
    setNow(value: number) { monotonic = value; wall = Date.UTC(2026, 0, 1) + value },
  }
}

async function settleMicrotasks() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('EffortTimer', () => {
  it('splits a checkpoint and pause at exact boundaries while writes are pending', async () => {
    const writes: M0EffortChunk[] = []
    const pending: Array<ReturnType<typeof deferred<void>>> = []
    const harness = timerHarness((chunk) => {
      writes.push(chunk)
      const next = deferred<void>()
      pending.push(next)
      return next.promise
    })
    const { timer } = harness

    expect(timer.start('asset-review')).toBe(true)
    harness.setNow(15_000)
    timer.checkpoint()
    harness.setNow(20_000)
    timer.pause()
    timer.pause()
    expect(timer.view.activeMs).toBe(20_000)
    expect(timer.view.pendingStop).toBe(true)
    expect(timer.start('asset-review')).toBe(false)
    await vi.waitFor(() => expect(writes).toHaveLength(1))

    // A slow IndexedDB write must not extend the interval after the pause.
    harness.setNow(30_000)
    pending[0]!.resolve()
    await vi.waitFor(() => expect(writes).toHaveLength(2))
    expect(writes.map(({ activeMs }) => activeMs)).toEqual([15_000, 5_000])
    expect(writes[0]!.endedAt).toBe(writes[1]!.startedAt)
    pending[1]!.resolve()
    await vi.waitFor(() => expect(timer.view.pendingStop).toBe(false))
    expect(timer.view.activeMs).toBe(20_000)
  })

  it('does not start a duplicate paused chunk when stop events repeat', async () => {
    const append = vi.fn(async (_chunk: M0EffortChunk) => undefined)
    const harness = timerHarness(append)
    harness.timer.start('asset-review')
    harness.setNow(1250)
    harness.timer.pause()
    harness.timer.pause()
    await settleMicrotasks()
    expect(append).toHaveBeenCalledTimes(1)
    expect(append.mock.calls[0]![0]).toMatchObject({ activeMs: 1250, checkpoint: 'paused' })
  })

  it('stops after a failed checkpoint, discards queued intervals, and requires a new start', async () => {
    const firstWrite = deferred<void>()
    const append = vi.fn()
      .mockReturnValueOnce(firstWrite.promise)
      .mockResolvedValue(undefined)
    const harness = timerHarness(append)
    const { timer } = harness

    timer.start('asset-review')
    harness.setNow(15_000)
    timer.checkpoint()
    harness.setNow(18_000)
    timer.pause()
    expect(timer.view.running).toBe(false)
    expect(timer.view.pendingStop).toBe(true)
    firstWrite.reject(new Error('IndexedDB unavailable'))
    await vi.waitFor(() => expect(timer.view.pendingStop).toBe(false))
    await settleMicrotasks()

    expect(append).toHaveBeenCalledTimes(1)
    expect(timer.view.error).toBe('IndexedDB unavailable')
    expect(timer.start('asset-review')).toBe(true)
    expect(timer.view.error).toBe('')
    harness.setNow(19_000)
    timer.pause()
    await settleMicrotasks()
    expect(append).toHaveBeenCalledTimes(2)
  })

  it('records no time when paused before the first clock tick', async () => {
    const append = vi.fn(async () => undefined)
    const harness = timerHarness(append)
    harness.timer.start('asset-review')
    harness.timer.pause()
    await settleMicrotasks()
    expect(append).not.toHaveBeenCalled()
    expect(harness.timer.view.pendingStop).toBe(false)
  })
})
