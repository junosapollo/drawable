import { rasterizeDocument } from '../lib/exportDocument'
import type { DrawingDocument } from '../lib/types'
import { resolveRasterBitmaps } from './rasterAssets'

export interface PreparedSnapshot {
  revision: number
  generation: number
  image: Blob
  worker: boolean
}

let worker: Worker | null = null
const pending = new Map<string, {
  resolve: (value: PreparedSnapshot) => void
  reject: (reason: unknown) => void
}>()

function snapshotWorker() {
  if (worker) return worker
  worker = new Worker(new URL('./snapshot.worker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = (event: MessageEvent<{ id: string; revision: number; generation: number; image?: Blob; error?: string }>) => {
    const request = pending.get(event.data.id)
    if (!request) return
    pending.delete(event.data.id)
    if (event.data.error || !event.data.image) request.reject(new Error(event.data.error ?? 'Snapshot worker returned no image'))
    else request.resolve({ revision: event.data.revision, generation: event.data.generation, image: event.data.image, worker: true })
  }
  worker.onerror = (event) => {
    for (const request of pending.values()) request.reject(new Error(event.message))
    pending.clear()
    worker?.terminate()
    worker = null
  }
  return worker
}

function canvasBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('Canvas snapshot failed')), 'image/png'))
}

async function mainThreadFallback(document: DrawingDocument, revision: number, generation: number): Promise<PreparedSnapshot> {
  const source = await rasterizeDocument(document, false)
  const target = globalThis.document.createElement('canvas')
  target.width = 512
  target.height = 512
  target.getContext('2d')?.drawImage(source, 0, 0, 512, 512)
  return { revision, generation, image: await canvasBlob(target), worker: false }
}

export async function prepareSnapshot(document: DrawingDocument, generation: number, signal: AbortSignal) {
  const revision = document.revision
  if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') return mainThreadFallback(document, revision, generation)
  const rasterAssets = await resolveRasterBitmaps(document)
  if (signal.aborted) {
    for (const asset of rasterAssets) asset.bitmap.close()
    throw new DOMException('Snapshot cancelled', 'AbortError')
  }
  const id = crypto.randomUUID()
  return new Promise<PreparedSnapshot>((resolve, reject) => {
    const onAbort = () => {
      pending.delete(id)
      reject(new DOMException('Snapshot cancelled', 'AbortError'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    pending.set(id, {
      resolve: (value) => { signal.removeEventListener('abort', onAbort); resolve(value) },
      reject: (error) => { signal.removeEventListener('abort', onAbort); reject(error) },
    })
    snapshotWorker().postMessage({ id, revision, generation, document, rasterAssets }, rasterAssets.map((asset) => asset.bitmap))
  })
}
