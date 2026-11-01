import { describe, expect, it } from 'vitest'
import type { RasterOperation, StrokeOperation } from '../lib/types'
import { assetsForOperations, resolveRasterImages } from './rasterAssets'

const stroke: StrokeOperation = {
  id: 'stroke-1',
  kind: 'stroke',
  tool: 'pressure',
  points: [{ x: 0, y: 0, pressure: 0.5, time: 0 }],
  size: 8,
  smoothing: 0.5,
  streamline: 0.5,
  simulatePressure: false,
  createdAt: 0,
}

const raster: RasterOperation = {
  id: 'raster-1',
  kind: 'raster',
  assetId: 'asset-1',
  x: 0,
  y: 0,
  width: 10,
  height: 10,
  createdAt: 0,
}

describe('raster asset lookup', () => {
  it('reports no assets for a vector-only operations array', () => {
    expect(assetsForOperations([stroke, stroke])).toEqual([])
  })

  it('collects unique raster asset ids', () => {
    expect(assetsForOperations([stroke, raster, { ...raster, id: 'raster-2' }])).toEqual(['asset-1'])
  })

  it('caches per operations array so untouched layers are not rescanned', () => {
    const operations = [raster]
    const first = assetsForOperations(operations)
    const second = assetsForOperations(operations)
    expect(second).toBe(first)
    expect(assetsForOperations([...operations])).not.toBe(first)
  })

  it('resolves an empty map for a pure-vector document', async () => {
    const resolved = await resolveRasterImages({
      id: 'document-1',
      title: 'Vector',
      revision: 0,
      updatedAt: 0,
      layers: [{ id: 'layer-1', name: 'Layer 1', visible: true, opacity: 1, operations: [stroke] }],
      trace: { assetId: null, imageUrl: null, visible: true, opacity: 0.3, scale: 1 },
    })
    expect(resolved.size).toBe(0)
  })
})
