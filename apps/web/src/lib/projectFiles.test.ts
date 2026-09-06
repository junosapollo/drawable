import { describe, expect, it } from 'vitest'
import { prepareImport } from './projectFiles'

function project(overrides: Record<string, unknown> = {}) {
  return {
    format: 'drawable-project',
    formatVersion: 1,
    applicationVersion: '0.1.0',
    exportedAt: new Date(0).toISOString(),
    activeLayerId: 'layer-1',
    assets: [],
    document: {
      title: 'Round trip',
      layers: Array.from({ length: 4 }, (_, index) => ({
        id: `layer-${index + 1}`,
        name: `Layer ${index + 1}`,
        visible: true,
        opacity: 1,
        operations: [],
      })),
      trace: { assetId: 'fixture-1', visible: true, opacity: 0.3, scale: 1 },
    },
    ...overrides,
  }
}

function projectFile(value: unknown) {
  const source = JSON.stringify(value)
  const file = new File([source], 'study.drawable', { type: 'application/vnd.drawable.project+json' })
  Object.defineProperty(file, 'text', { value: async () => source })
  return file
}

describe('drawable project import', () => {
  it('validates four editable layers while keeping trace metadata portable', async () => {
    const imported = await prepareImport(projectFile(project()))
    expect(imported.sourceKind).toBe('project')
    expect(imported.document.layers).toHaveLength(4)
    expect(imported.document.trace).toMatchObject({ assetId: 'fixture-1', imageUrl: null, opacity: 0.3 })
    expect(imported.activeLayerId).toBe('layer-1')
  })

  it('rejects newer project versions without returning partial data', async () => {
    await expect(prepareImport(projectFile(project({ formatVersion: 2 })))).rejects.toThrow('newer version')
  })

  it('rejects documents that violate the fixed four-layer contract', async () => {
    const invalid = project()
    invalid.document.layers.pop()
    await expect(prepareImport(projectFile(invalid))).rejects.toThrow('exactly four layers')
  })
})
