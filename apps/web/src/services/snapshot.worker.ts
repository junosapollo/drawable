/// <reference lib="webworker" />
import { getStroke } from 'perfect-freehand'
import type { DrawingDocument, StrokeOperation } from '../lib/types'
import { LOGICAL_SIZE } from '../lib/types'
import { outlineToPath } from '../lib/drawing'

interface SnapshotMessage {
  id: string
  revision: number
  generation: number
  document: DrawingDocument
  rasterAssets: Array<{ id: string; bitmap: ImageBitmap }>
}

function drawOperation(context: OffscreenCanvasRenderingContext2D, operation: StrokeOperation) {
  const points = getStroke(operation.points.map((point) => [point.x, point.y, point.pressure]), {
    size: operation.size,
    thinning: operation.tool === 'pressure' ? 0.65 : 0,
    smoothing: operation.smoothing,
    streamline: operation.streamline,
    simulatePressure: operation.simulatePressure,
    start: { cap: true, taper: 0 },
    end: { cap: operation.tool !== 'pressure', taper: operation.tool === 'pressure' ? 8 : 0 },
    last: true,
  })
  const path = outlineToPath(points)
  if (!path) return
  context.save()
  context.fillStyle = '#111214'
  context.globalCompositeOperation = operation.tool === 'eraser' ? 'destination-out' : 'source-over'
  context.fill(new Path2D(path))
  context.restore()
}

self.onmessage = async (event: MessageEvent<SnapshotMessage>) => {
  const { id, revision, generation, document, rasterAssets } = event.data
  try {
    const assets = new Map(rasterAssets.map((asset) => [asset.id, asset.bitmap]))
    const output = new OffscreenCanvas(512, 512)
    const outputContext = output.getContext('2d')
    if (!outputContext) throw new Error('2D worker canvas unavailable')
    outputContext.fillStyle = '#fff'
    outputContext.fillRect(0, 0, 512, 512)
    for (const layer of [...document.layers].reverse()) {
      if (!layer.visible || layer.opacity <= 0) continue
      const layerCanvas = new OffscreenCanvas(512, 512)
      const layerContext = layerCanvas.getContext('2d')
      if (!layerContext) continue
      layerContext.scale(512 / LOGICAL_SIZE, 512 / LOGICAL_SIZE)
      for (const operation of layer.operations) {
        if (operation.kind === 'raster') {
          const bitmap = assets.get(operation.assetId)
          if (bitmap) layerContext.drawImage(bitmap, operation.x, operation.y, operation.width, operation.height)
        } else drawOperation(layerContext, operation)
      }
      outputContext.globalAlpha = layer.opacity
      outputContext.drawImage(layerCanvas, 0, 0)
    }
    outputContext.globalAlpha = 1
    const image = await output.convertToBlob({ type: 'image/png' })
    self.postMessage({ id, revision, generation, image })
  } catch (error) {
    self.postMessage({ id, revision, generation, error: error instanceof Error ? error.message : 'Snapshot failed' })
  } finally {
    for (const asset of rasterAssets) asset.bitmap.close()
  }
}

export {}
