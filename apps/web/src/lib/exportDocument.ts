import { outlineToPath, renderLayer, strokeOutline } from './drawing'
import { LOGICAL_SIZE, type DrawingDocument, type StrokeOperation } from './types'
import { loadReferencedRasterAssets, resolveRasterImages } from '../services/rasterAssets'

function download(blob: Blob, filename: string) {
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = filename
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(link.href), 1000)
}

function safeTitle(title: string) {
  return title.trim().replaceAll(/[^a-z0-9-_]+/gi, '-').replaceAll(/^-|-$/g, '') || 'drawing'
}

export async function rasterizeDocument(document: DrawingDocument, transparent: boolean) {
  const rasterAssets = await resolveRasterImages(document)
  const output = window.document.createElement('canvas')
  output.width = LOGICAL_SIZE
  output.height = LOGICAL_SIZE
  const context = output.getContext('2d')!
  if (!transparent) {
    context.fillStyle = '#fff'
    context.fillRect(0, 0, LOGICAL_SIZE, LOGICAL_SIZE)
  }
  for (const layer of [...document.layers].reverse()) {
    if (!layer.visible || layer.opacity <= 0) continue
    const layerCanvas = window.document.createElement('canvas')
    layerCanvas.width = LOGICAL_SIZE
    layerCanvas.height = LOGICAL_SIZE
    renderLayer(layerCanvas.getContext('2d')!, layer, rasterAssets)
    context.globalAlpha = layer.opacity
    context.drawImage(layerCanvas, 0, 0)
  }
  context.globalAlpha = 1
  return output
}

export async function exportPng(document: DrawingDocument, transparent: boolean) {
  const canvas = await rasterizeDocument(document, transparent)
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error('PNG export failed.')), 'image/png'))
  download(blob, `${safeTitle(document.title)}.png`)
}

function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('Could not read imported artwork.'))
    reader.readAsDataURL(blob)
  })
}

function isEraser(operation: DrawingDocument['layers'][number]['operations'][number]): operation is StrokeOperation {
  return operation.kind === 'stroke' && operation.tool === 'eraser'
}

export async function exportSvg(document: DrawingDocument) {
  const rasterData = new Map<string, string>()
  for (const asset of await loadReferencedRasterAssets(document)) rasterData.set(asset.id, await blobToDataUrl(asset.blob))
  const definitions: string[] = []
  const groups: string[] = []
  for (const layer of [...document.layers].reverse()) {
    if (!layer.visible || layer.opacity <= 0) continue
    const draws: string[] = []
    layer.operations.forEach((operation, index) => {
      if (operation.kind === 'raster') {
        const source = rasterData.get(operation.assetId)
        if (!source) return
        const followingErasers = layer.operations.slice(index + 1).filter(isEraser)
        const maskId = `${layer.id}-raster-${index}`
        if (followingErasers.length) definitions.push(`<mask id="${maskId}"><rect width="2048" height="2048" fill="white"/>${followingErasers.map((eraser) => `<path d="${outlineToPath(strokeOutline(eraser))}" fill="black"/>`).join('')}</mask>`)
        draws.push(`<image href="${source}" x="${operation.x}" y="${operation.y}" width="${operation.width}" height="${operation.height}"${followingErasers.length ? ` mask="url(#${maskId})"` : ''}/>`)
        return
      }
      if (operation.tool === 'eraser') return
      const drawPath = outlineToPath(strokeOutline(operation))
      if (!drawPath) return
      const followingErasers = layer.operations.slice(index + 1).filter(isEraser)
      if (followingErasers.length === 0) {
        draws.push(`<path d="${drawPath}"/>`)
        return
      }
      const maskId = `${layer.id}-draw-${index}`
      definitions.push(`<mask id="${maskId}"><rect width="2048" height="2048" fill="white"/>${followingErasers.map((eraser) => `<path d="${outlineToPath(strokeOutline(eraser))}" fill="black"/>`).join('')}</mask>`)
      draws.push(`<path d="${drawPath}" mask="url(#${maskId})"/>`)
    })
    groups.push(`<g opacity="${layer.opacity}" fill="#111214">${draws.join('')}</g>`)
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2048 2048"><defs>${definitions.join('')}</defs>${groups.join('')}</svg>`
  download(new Blob([svg], { type: 'image/svg+xml' }), `${safeTitle(document.title)}.svg`)
}
