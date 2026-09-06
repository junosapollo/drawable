import { uid } from './drawing'
import {
  LOGICAL_SIZE,
  type DrawableProjectV1,
  type DrawingDocument,
  type DrawingLayer,
  type DrawingOperation,
  type EmbeddedProjectAsset,
  type PreparedImport,
  type StoredRasterAsset,
} from './types'
import { loadReferencedRasterAssets } from '../services/rasterAssets'

export const PROJECT_EXTENSION = '.drawable'
export const PROJECT_MIME = 'application/vnd.drawable.project+json'
const APP_VERSION = '0.1.0'
const MAX_PROJECT_BYTES = 50 * 1024 * 1024
const MAX_PNG_BYTES = 25 * 1024 * 1024
const MAX_SVG_BYTES = 5 * 1024 * 1024
const MAX_IMAGE_EDGE = 8192
const MAX_IMAGE_PIXELS = 40_000_000
const MAX_OPERATIONS = 10_000
const MAX_POINTS = 1_000_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredString(value: unknown, label: string, maximum: number) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) throw new Error(`${label} is invalid.`)
  return value
}

function finiteNumber(value: unknown, label: string, minimum: number, maximum: number) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`${label} is invalid.`)
  return value
}

function booleanValue(value: unknown, label: string) {
  if (typeof value !== 'boolean') throw new Error(`${label} is invalid.`)
  return value
}

function safeTitle(title: string) {
  return title.trim().replaceAll(/[^a-z0-9-_]+/gi, '-').replaceAll(/^-|-$/g, '') || 'drawing'
}

async function sha256(blob: Blob) {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function download(blob: Blob, filename: string) {
  const link = globalThis.document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = filename
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(link.href), 1000)
}

function blobToBase64(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result)
      resolve(result.slice(result.indexOf(',') + 1))
    }
    reader.onerror = () => reject(reader.error ?? new Error('Could not read project asset.'))
    reader.readAsDataURL(blob)
  })
}

function base64ToBlob(data: string, mimeType: 'image/png') {
  let decoded: string
  try {
    decoded = atob(data)
  } catch {
    throw new Error('A project asset is not valid base64 data.')
  }
  const bytes = new Uint8Array(decoded.length)
  for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index)
  return new Blob([bytes], { type: mimeType })
}

function validateStroke(value: Record<string, unknown>, pointCounter: { value: number }): DrawingOperation {
  const tool = requiredString(value.tool, 'Stroke tool', 20)
  if (tool !== 'pressure' && tool !== 'monoline' && tool !== 'eraser') throw new Error('Stroke tool is unsupported.')
  if (!Array.isArray(value.points) || value.points.length === 0) throw new Error('A stroke has no points.')
  pointCounter.value += value.points.length
  if (pointCounter.value > MAX_POINTS) throw new Error('The project exceeds the one-million-point limit.')
  return {
    id: requiredString(value.id, 'Operation ID', 120),
    kind: 'stroke',
    tool,
    points: value.points.map((point, index) => {
      if (!isRecord(point)) throw new Error(`Point ${index + 1} is invalid.`)
      return {
        x: finiteNumber(point.x, 'Point x', -16_384, 16_384),
        y: finiteNumber(point.y, 'Point y', -16_384, 16_384),
        pressure: finiteNumber(point.pressure, 'Point pressure', 0, 1),
        time: finiteNumber(point.time, 'Point time', 0, Number.MAX_SAFE_INTEGER),
      }
    }),
    size: finiteNumber(value.size, 'Brush size', 0.1, 1024),
    smoothing: finiteNumber(value.smoothing, 'Stroke smoothing', 0, 1),
    streamline: finiteNumber(value.streamline, 'Stroke streamline', 0, 1),
    simulatePressure: booleanValue(value.simulatePressure, 'Simulated pressure'),
    createdAt: finiteNumber(value.createdAt, 'Operation time', 0, Number.MAX_SAFE_INTEGER),
  }
}

function validateOperation(value: unknown, pointCounter: { value: number }): DrawingOperation {
  if (!isRecord(value)) throw new Error('A drawing operation is invalid.')
  if (value.kind === 'stroke') return validateStroke(value, pointCounter)
  if (value.kind !== 'raster') throw new Error('The project contains an unsupported drawing operation.')
  return {
    id: requiredString(value.id, 'Operation ID', 120),
    kind: 'raster',
    assetId: requiredString(value.assetId, 'Raster asset ID', 120),
    x: finiteNumber(value.x, 'Raster x', -16_384, 16_384),
    y: finiteNumber(value.y, 'Raster y', -16_384, 16_384),
    width: finiteNumber(value.width, 'Raster width', 0.1, 16_384),
    height: finiteNumber(value.height, 'Raster height', 0.1, 16_384),
    createdAt: finiteNumber(value.createdAt, 'Operation time', 0, Number.MAX_SAFE_INTEGER),
  }
}

function validateProjectDocument(value: unknown) {
  if (!isRecord(value)) throw new Error('The project document is missing.')
  if (!Array.isArray(value.layers) || value.layers.length !== 4) throw new Error('A drawable project must contain exactly four layers.')
  const pointCounter = { value: 0 }
  let operationCount = 0
  const layerIds = new Set<string>()
  const operationIds = new Set<string>()
  const layers: DrawingLayer[] = value.layers.map((rawLayer, index) => {
    if (!isRecord(rawLayer) || !Array.isArray(rawLayer.operations)) throw new Error(`Layer ${index + 1} is invalid.`)
    const id = requiredString(rawLayer.id, 'Layer ID', 80)
    if (layerIds.has(id)) throw new Error('Layer IDs must be unique.')
    layerIds.add(id)
    operationCount += rawLayer.operations.length
    if (operationCount > MAX_OPERATIONS) throw new Error('The project exceeds the 10,000-operation limit.')
    const operations = rawLayer.operations.map((operation) => validateOperation(operation, pointCounter))
    for (const operation of operations) {
      if (operationIds.has(operation.id)) throw new Error('Operation IDs must be unique.')
      operationIds.add(operation.id)
    }
    return {
      id,
      name: requiredString(rawLayer.name, 'Layer name', 40),
      visible: booleanValue(rawLayer.visible, 'Layer visibility'),
      opacity: finiteNumber(rawLayer.opacity, 'Layer opacity', 0, 1),
      operations,
    }
  })
  if (layerIds.size !== 4 || !['layer-1', 'layer-2', 'layer-3', 'layer-4'].every((id) => layerIds.has(id))) throw new Error('The project does not use drawable’s four stable layer IDs.')
  if (!isRecord(value.trace)) throw new Error('Trace metadata is invalid.')
  const assetId = value.trace.assetId
  if (assetId !== null && typeof assetId !== 'string') throw new Error('Trace asset ID is invalid.')
  return {
    title: requiredString(value.title, 'Project title', 80),
    layers,
    trace: {
      assetId,
      imageUrl: null,
      visible: booleanValue(value.trace.visible, 'Trace visibility'),
      opacity: finiteNumber(value.trace.opacity, 'Trace opacity', 0, 1),
      scale: finiteNumber(value.trace.scale, 'Trace scale', 0.25, 2),
    },
  }
}

async function validateEmbeddedAssets(rawAssets: unknown, document: ReturnType<typeof validateProjectDocument>) {
  if (!Array.isArray(rawAssets)) throw new Error('Project assets are invalid.')
  const assets: StoredRasterAsset[] = []
  const assetIds = new Set<string>()
  for (const rawAsset of rawAssets) {
    if (!isRecord(rawAsset)) throw new Error('A project asset is invalid.')
    const id = requiredString(rawAsset.id, 'Asset ID', 120)
    if (assetIds.has(id)) throw new Error('Asset IDs must be unique.')
    assetIds.add(id)
    if (rawAsset.mimeType !== 'image/png') throw new Error('Only normalized PNG project assets are supported.')
    const data = requiredString(rawAsset.data, 'Asset data', MAX_PROJECT_BYTES * 2)
    const blob = base64ToBlob(data, 'image/png')
    const byteLength = finiteNumber(rawAsset.byteLength, 'Asset byte length', 1, MAX_PNG_BYTES)
    if (blob.size !== byteLength) throw new Error('A project asset has an incorrect byte length.')
    const checksum = requiredString(rawAsset.sha256, 'Asset checksum', 64)
    if (!/^[a-f0-9]{64}$/.test(checksum) || await sha256(blob) !== checksum) throw new Error('A project asset checksum does not match.')
    if (id !== `raster-${checksum}`) throw new Error('A project asset ID does not match its content.')
    assets.push({
      id,
      mimeType: 'image/png',
      width: finiteNumber(rawAsset.width, 'Asset width', 1, LOGICAL_SIZE),
      height: finiteNumber(rawAsset.height, 'Asset height', 1, LOGICAL_SIZE),
      sha256: checksum,
      blob,
    })
  }
  for (const layer of document.layers) {
    for (const operation of layer.operations) {
      if (operation.kind === 'raster' && !assetIds.has(operation.assetId)) throw new Error('A raster operation references a missing project asset.')
    }
  }
  const referencedIds = new Set(document.layers.flatMap((layer) => layer.operations.flatMap((operation) => operation.kind === 'raster' ? [operation.assetId] : [])))
  if (assets.some((asset) => !referencedIds.has(asset.id))) throw new Error('The project contains an unreferenced asset.')
  return assets
}

async function parseProject(file: File): Promise<PreparedImport> {
  if (file.size > MAX_PROJECT_BYTES) throw new Error('Drawable projects must be 50 MiB or smaller.')
  let raw: unknown
  try {
    raw = JSON.parse(await file.text())
  } catch {
    throw new Error('This is not a valid drawable project file.')
  }
  if (!isRecord(raw) || raw.format !== 'drawable-project') throw new Error('This file is not a drawable project.')
  if (raw.formatVersion !== 1) throw new Error(typeof raw.formatVersion === 'number' && raw.formatVersion > 1 ? 'This project was created by a newer version of drawable.' : 'This project version is unsupported.')
  requiredString(raw.applicationVersion, 'Application version', 40)
  const exportedAt = requiredString(raw.exportedAt, 'Export timestamp', 40)
  if (!Number.isFinite(Date.parse(exportedAt))) throw new Error('The project export timestamp is invalid.')
  const validated = validateProjectDocument(raw.document)
  const activeLayerId = requiredString(raw.activeLayerId, 'Active layer', 80)
  if (!validated.layers.some((layer) => layer.id === activeLayerId)) throw new Error('The active layer does not exist.')
  const assets = await validateEmbeddedAssets(raw.assets, validated)
  const document: DrawingDocument = {
    id: `import-${crypto.randomUUID()}`,
    revision: 0,
    updatedAt: Date.now(),
    ...validated,
  }
  return { document, activeLayerId, assets, sourceKind: 'project' }
}

function validateSvg(source: string) {
  if (/<!doctype|<!entity/i.test(source)) throw new Error('SVG document types and entities are not supported.')
  const parsed = new DOMParser().parseFromString(source, 'image/svg+xml')
  if (parsed.querySelector('parsererror') || parsed.documentElement.localName !== 'svg') throw new Error('The SVG is malformed.')
  const forbidden = parsed.querySelector('script, foreignObject, iframe, object, embed, image, audio, video, style, animate, animateMotion, animateTransform, set')
  if (forbidden) throw new Error('The SVG contains unsupported active or embedded content.')
  for (const element of [...parsed.querySelectorAll('*')]) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase()
      const value = attribute.value.trim()
      if (name.startsWith('on') || name === 'src' || name === 'style') throw new Error('The SVG contains unsupported active attributes.')
      if ((name === 'href' || name.endsWith(':href')) && !value.startsWith('#')) throw new Error('External SVG references are not allowed.')
      const urls = [...value.matchAll(/url\(([^)]+)\)/gi)]
      if (urls.some((match) => !String(match[1]).trim().replaceAll(/["']/g, '').startsWith('#'))) throw new Error('External SVG resources are not allowed.')
    }
  }
  return new XMLSerializer().serializeToString(parsed.documentElement)
}

function canvasBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('Could not normalize the imported image.')), 'image/png'))
}

async function decodeImage(blob: Blob) {
  const url = URL.createObjectURL(blob)
  const image = new Image()
  image.src = url
  try {
    await image.decode()
    return { source: image as CanvasImageSource, width: image.naturalWidth, height: image.naturalHeight, release: () => URL.revokeObjectURL(url) }
  } catch {
    URL.revokeObjectURL(url)
    throw new Error('The selected image could not be decoded.')
  }
}

async function validatePngHeader(file: File) {
  const bytes = new Uint8Array(await file.slice(0, 24).arrayBuffer())
  const signature = [137, 80, 78, 71, 13, 10, 26, 10]
  if (bytes.length < 24 || !signature.every((value, index) => bytes[index] === value)) throw new Error('The selected file is not a valid PNG image.')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const width = view.getUint32(16)
  const height = view.getUint32(20)
  if (!width || !height || width > MAX_IMAGE_EDGE || height > MAX_IMAGE_EDGE || width * height > MAX_IMAGE_PIXELS) throw new Error('The image dimensions exceed the 8192-pixel or 40-megapixel limit.')
}

async function parseImage(file: File, sourceKind: 'png' | 'svg'): Promise<PreparedImport> {
  const maximum = sourceKind === 'png' ? MAX_PNG_BYTES : MAX_SVG_BYTES
  if (file.size > maximum) throw new Error(`${sourceKind.toUpperCase()} files must be ${maximum / 1024 / 1024} MiB or smaller.`)
  if (sourceKind === 'png') await validatePngHeader(file)
  const sourceBlob = sourceKind === 'svg'
    ? new Blob([validateSvg(await file.text())], { type: 'image/svg+xml' })
    : file
  const image = await decodeImage(sourceBlob)
  if (!image.width || !image.height || image.width > MAX_IMAGE_EDGE || image.height > MAX_IMAGE_EDGE || image.width * image.height > MAX_IMAGE_PIXELS) {
    image.release()
    throw new Error('The image dimensions exceed the 8192-pixel or 40-megapixel limit.')
  }
  const canvas = globalThis.document.createElement('canvas')
  canvas.width = LOGICAL_SIZE
  canvas.height = LOGICAL_SIZE
  const scale = Math.min(LOGICAL_SIZE / image.width, LOGICAL_SIZE / image.height)
  const width = image.width * scale
  const height = image.height * scale
  canvas.getContext('2d')?.drawImage(image.source, (LOGICAL_SIZE - width) / 2, (LOGICAL_SIZE - height) / 2, width, height)
  image.release()
  const blob = await canvasBlob(canvas)
  const checksum = await sha256(blob)
  const assetId = `raster-${checksum}`
  const title = file.name.replace(/\.(drawable|png|svg)$/i, '').trim().slice(0, 80) || 'Imported sketch'
  const layers: DrawingLayer[] = Array.from({ length: 4 }, (_, index) => ({
    id: `layer-${index + 1}`,
    name: index === 3 ? 'Imported sketch' : `Layer ${index + 1}`,
    visible: true,
    opacity: 1,
    operations: index === 3 ? [{ id: uid('raster'), kind: 'raster', assetId, x: 0, y: 0, width: LOGICAL_SIZE, height: LOGICAL_SIZE, createdAt: Date.now() }] : [],
  }))
  return {
    document: {
      id: `import-${crypto.randomUUID()}`,
      title,
      revision: 0,
      updatedAt: Date.now(),
      layers,
      trace: { assetId: null, imageUrl: null, visible: true, opacity: 0.3, scale: 1 },
    },
    activeLayerId: 'layer-1',
    assets: [{ id: assetId, mimeType: 'image/png', width: LOGICAL_SIZE, height: LOGICAL_SIZE, sha256: checksum, blob }],
    sourceKind,
  }
}

export async function prepareImport(file: File) {
  const lowerName = file.name.toLowerCase()
  if (lowerName.endsWith(PROJECT_EXTENSION)) return parseProject(file)
  if (file.type === 'image/png' || lowerName.endsWith('.png')) return parseImage(file, 'png')
  if (file.type === 'image/svg+xml' || lowerName.endsWith('.svg')) return parseImage(file, 'svg')
  throw new Error('Choose a .drawable, PNG, or SVG file.')
}

export async function exportDrawableProject(document: DrawingDocument, activeLayerId: string) {
  const storedAssets = await loadReferencedRasterAssets(document)
  const assets: EmbeddedProjectAsset[] = await Promise.all(storedAssets.map(async (asset) => ({
    id: asset.id,
    mimeType: asset.mimeType,
    width: asset.width,
    height: asset.height,
    byteLength: asset.blob.size,
    sha256: asset.sha256,
    data: await blobToBase64(asset.blob),
  })))
  const project: DrawableProjectV1 = {
    format: 'drawable-project',
    formatVersion: 1,
    applicationVersion: APP_VERSION,
    exportedAt: new Date().toISOString(),
    document: {
      title: document.title,
      layers: structuredClone(document.layers),
      trace: {
        assetId: document.trace.assetId,
        visible: document.trace.visible,
        opacity: document.trace.opacity,
        scale: document.trace.scale,
      },
    },
    activeLayerId,
    assets,
  }
  const blob = new Blob([JSON.stringify(project)], { type: PROJECT_MIME })
  if (blob.size > MAX_PROJECT_BYTES) throw new Error('This project is larger than the 50 MiB project limit.')
  download(blob, `${safeTitle(document.title)}${PROJECT_EXTENSION}`)
}
