import type { DrawingDocument, DrawingOperation } from '../lib/types'
import { loadRasterAsset } from './persistence'

const imageCache = new Map<string, Promise<HTMLImageElement>>()
const layerAssetCache = new WeakMap<DrawingOperation[], string[]>()

export function assetsForOperations(operations: DrawingOperation[]) {
  const cached = layerAssetCache.get(operations)
  if (cached) return cached
  const ids = [...new Set(operations.flatMap((operation) =>
    operation.kind === 'raster' ? [operation.assetId] : [],
  ))]
  layerAssetCache.set(operations, ids)
  return ids
}

function referencedAssetIds(document: DrawingDocument) {
  const ids = new Set<string>()
  for (const layer of document.layers) {
    for (const id of assetsForOperations(layer.operations)) ids.add(id)
  }
  return [...ids]
}

function decodeBlob(blob: Blob) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    const image = new Image()
    image.onload = () => {
      URL.revokeObjectURL(url)
      resolve(image)
    }
    image.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('Imported artwork could not be decoded.'))
    }
    image.src = url
  })
}

export async function resolveRasterImages(document: DrawingDocument) {
  const resolved = new Map<string, CanvasImageSource>()
  await Promise.all(referencedAssetIds(document).map(async (assetId) => {
    let pending = imageCache.get(assetId)
    if (!pending) {
      pending = loadRasterAsset(assetId).then((asset) => {
        if (!asset) throw new Error(`Imported artwork ${assetId} is unavailable.`)
        return decodeBlob(asset.blob)
      })
      imageCache.set(assetId, pending)
    }
    resolved.set(assetId, await pending)
  }))
  return resolved
}

export async function resolveRasterBitmaps(document: DrawingDocument) {
  const resolved: Array<{ id: string; bitmap: ImageBitmap }> = []
  for (const assetId of referencedAssetIds(document)) {
    const asset = await loadRasterAsset(assetId)
    if (!asset) throw new Error(`Imported artwork ${assetId} is unavailable.`)
    resolved.push({ id: assetId, bitmap: await createImageBitmap(asset.blob) })
  }
  return resolved
}

export async function loadReferencedRasterAssets(document: DrawingDocument) {
  const assets = []
  for (const assetId of referencedAssetIds(document)) {
    const asset = await loadRasterAsset(assetId)
    if (!asset) throw new Error(`Imported artwork ${assetId} is unavailable.`)
    assets.push(asset)
  }
  return assets
}

export function clearRasterImageCache() {
  imageCache.clear()
}
