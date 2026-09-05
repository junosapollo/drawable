import { outlineToPath, renderLayer, strokeOutline } from './drawing'
import { LOGICAL_SIZE, type DrawingDocument } from './types'

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

export function rasterizeDocument(document: DrawingDocument, transparent: boolean) {
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
    renderLayer(layerCanvas.getContext('2d')!, layer)
    context.globalAlpha = layer.opacity
    context.drawImage(layerCanvas, 0, 0)
  }
  context.globalAlpha = 1
  return output
}

export function exportPng(document: DrawingDocument, transparent: boolean) {
  rasterizeDocument(document, transparent).toBlob((blob) => {
    if (blob) download(blob, `${safeTitle(document.title)}.png`)
  }, 'image/png')
}

export function exportSvg(document: DrawingDocument) {
  const definitions: string[] = []
  const groups: string[] = []
  for (const layer of [...document.layers].reverse()) {
    if (!layer.visible || layer.opacity <= 0) continue
    const draws: string[] = []
    layer.operations.forEach((operation, index) => {
      if (operation.tool === 'eraser') return
      const drawPath = outlineToPath(strokeOutline(operation))
      if (!drawPath) return
      const followingErasers = layer.operations.slice(index + 1).filter((candidate) => candidate.tool === 'eraser')
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
