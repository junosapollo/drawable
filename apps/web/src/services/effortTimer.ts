import { appendM0EffortChunk, type M0EffortCategory, type M0EffortChunk } from './m0Effort'

export interface EffortTimerView {
  running: boolean
  activeMs: number
  pendingStop: boolean
  error: string
}

interface ActiveSegment {
  sessionId: string
  category: M0EffortCategory
  segmentStartedAt: string
  lastCheckpointAt: number
  lastUiTickAt: number
}

interface EffortTimerDependencies {
  append: (chunk: M0EffortChunk) => Promise<void>
  monotonicNow: () => number
  wallNow: () => Date
  newId: () => string
  onChange: (view: EffortTimerView) => void
}

const defaultDependencies: Omit<EffortTimerDependencies, 'onChange'> = {
  append: appendM0EffortChunk,
  monotonicNow: () => performance.now(),
  wallNow: () => new Date(),
  newId: () => crypto.randomUUID(),
}

export class EffortTimer {
  private active: ActiveSegment | null = null
  private activeMs = 0
  private pendingWrites = 0
  private closingSessionId: string | null = null
  private failedSessions = new Set<string>()
  private writeQueue: Promise<void> = Promise.resolve()
  private error = ''
  private readonly dependencies: EffortTimerDependencies

  constructor(onChange: (view: EffortTimerView) => void, dependencies: Partial<EffortTimerDependencies> = {}) {
    this.dependencies = { ...defaultDependencies, ...dependencies, onChange }
  }

  get view(): EffortTimerView {
    return {
      running: this.active !== null,
      activeMs: this.activeMs,
      pendingStop: this.closingSessionId !== null,
      error: this.error,
    }
  }

  start(category: M0EffortCategory) {
    if (this.active || this.closingSessionId) return false
    const startedAt = this.dependencies.wallNow().toISOString()
    const now = this.dependencies.monotonicNow()
    this.activeMs = 0
    this.error = ''
    this.active = {
      sessionId: this.dependencies.newId(),
      category,
      segmentStartedAt: startedAt,
      lastCheckpointAt: now,
      lastUiTickAt: now,
    }
    this.emit()
    return true
  }

  tick() {
    if (!this.active) return
    this.advanceUi(this.active, this.dependencies.monotonicNow())
    this.emit()
  }

  checkpoint() {
    if (!this.active) return
    const now = this.dependencies.monotonicNow()
    this.advanceUi(this.active, now)
    this.captureChunk(this.active, 'periodic', now)
    this.emit()
  }

  pause() {
    const active = this.active
    if (!active) return
    const now = this.dependencies.monotonicNow()
    this.advanceUi(active, now)
    this.active = null
    this.closingSessionId = active.sessionId
    this.captureChunk(active, 'paused', now)
    if (this.pendingWrites === 0) this.closingSessionId = null
    this.emit()
  }

  private advanceUi(active: ActiveSegment, now: number) {
    this.activeMs += Math.max(0, now - active.lastUiTickAt)
    active.lastUiTickAt = now
  }

  private captureChunk(active: ActiveSegment, checkpoint: M0EffortChunk['checkpoint'], now: number) {
    const activeMs = Math.max(0, Math.round(now - active.lastCheckpointAt))
    if (activeMs === 0) return

    const endedAt = this.dependencies.wallNow().toISOString()
    const chunk: M0EffortChunk = {
      schemaVersion: 1,
      chunkId: this.dependencies.newId(),
      sessionId: active.sessionId,
      category: active.category,
      startedAt: active.segmentStartedAt,
      endedAt,
      activeMs,
      checkpoint,
    }
    // Advance the interval before enqueueing so a simultaneous pause never
    // overlaps a periodic checkpoint that is still waiting on IndexedDB.
    active.segmentStartedAt = endedAt
    active.lastCheckpointAt = now
    this.enqueue(active.sessionId, chunk)
  }

  private enqueue(sessionId: string, chunk: M0EffortChunk) {
    this.pendingWrites += 1
    this.writeQueue = this.writeQueue
      .then(async () => {
        if (!this.failedSessions.has(sessionId)) await this.dependencies.append(chunk)
      })
      .catch((cause: unknown) => {
        this.failedSessions.add(sessionId)
        if (this.active?.sessionId === sessionId) this.active = null
        this.closingSessionId = sessionId
        this.error = cause instanceof Error ? cause.message : 'Could not save the local effort log.'
        this.emit()
      })
      .then(() => {
        this.pendingWrites = Math.max(0, this.pendingWrites - 1)
        if (this.pendingWrites === 0 && this.closingSessionId === sessionId) {
          this.closingSessionId = null
        }
        this.emit()
      })
  }

  private emit() {
    this.dependencies.onChange(this.view)
  }
}
