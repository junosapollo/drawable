import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'

async function referenceLayerHashes(page: import('@playwright/test').Page) {
  return page.evaluate(async () => {
    const base = window.location.origin
    const [{ documentStore }, drawing, assets] = await Promise.all([
      import(new URL('/src/state/documentStore.ts', base).href),
      import(new URL('/src/lib/drawing.ts', base).href),
      import(new URL('/src/services/rasterAssets.ts', base).href),
    ])
    const documentModel = documentStore.getState().document
    const rasterAssets = await assets.resolveRasterImages(documentModel)
    const rows = []
    for (const layer of documentModel.layers) {
      const actualCanvas = document.querySelector<HTMLCanvasElement>(`canvas[data-layer-id="${layer.id}"]`)
      if (!actualCanvas) throw new Error(`Missing visible canvas for ${layer.id}`)
      const referenceCanvas = document.createElement('canvas')
      referenceCanvas.width = actualCanvas.width
      referenceCanvas.height = actualCanvas.height
      const referenceContext = referenceCanvas.getContext('2d')
      if (!referenceContext) throw new Error('Could not read reference canvas pixels')
      drawing.renderLayer(referenceContext, layer, rasterAssets)
      const referencePixels = referenceContext.getImageData(0, 0, referenceCanvas.width, referenceCanvas.height).data
      let nonTransparentPixels = 0
      for (let index = 3; index < referencePixels.length; index += 4) {
        if (referencePixels[index]) nonTransparentPixels += 1
      }
      const hash = async (pixels: Uint8ClampedArray) => {
        const digest = await crypto.subtle.digest('SHA-256', pixels)
        return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('')
      }
      rows.push({
        id: layer.id,
        width: actualCanvas.width,
        height: actualCanvas.height,
        hash: await hash(referencePixels),
        nonTransparentPixels,
      })
    }
    return rows.sort((left, right) => left.id.localeCompare(right.id))
  })
}

async function visibleLayerHashes(page: import('@playwright/test').Page) {
  return page.evaluate(async () => {
    const rows = []
    for (const canvas of document.querySelectorAll<HTMLCanvasElement>('canvas[data-layer-id]')) {
      const context = canvas.getContext('2d')
      if (!context) throw new Error('Could not read canvas pixels')
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
      const digest = await crypto.subtle.digest('SHA-256', pixels)
      const hash = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('')
      rows.push({ id: canvas.dataset.layerId, width: canvas.width, height: canvas.height, hash })
    }
    return rows.sort((left, right) => left.id.localeCompare(right.id))
  })
}

async function expectFullRenderMatches(page: import('@playwright/test').Page, requireInk = true) {
  const rows = await referenceLayerHashes(page)
  if (requireInk) expect(rows.some((row) => row.nonTransparentPixels > 0)).toBe(true)
  const expected = rows.map(({ id, width, height, hash }) => ({ id, width, height, hash }))
  await expect.poll(() => visibleLayerHashes(page), { timeout: 10_000 }).toEqual(expected)
}

async function drawAt(page: import('@playwright/test').Page, box: NonNullable<Awaited<ReturnType<import('@playwright/test').Locator['boundingBox']>>>, y: number) {
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * y)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.75, box.y + box.height * (y + 0.035), { steps: 12 })
  await page.mouse.up()
}

test('draws strokes and advances fixture references', async ({ page }) => {
  await page.goto('/draw')
  await expect(page.getByLabel('Drawing canvas')).toBeVisible()
  const stage = page.getByLabel('Drawing canvas')
  const box = await stage.boundingBox()
  if (!box) throw new Error('Canvas stage has no bounds')
  for (let index = 0; index < 3; index += 1) {
    await page.mouse.move(box.x + box.width * 0.35, box.y + box.height * (0.38 + index * 0.06))
    await page.mouse.down()
    await page.mouse.move(box.x + box.width * 0.58, box.y + box.height * (0.45 + index * 0.06), { steps: 8 })
    await page.mouse.up()
  }
  await expect(page.getByText('Best match')).toBeVisible({ timeout: 5000 })
  await page.getByRole('button', { name: /View Eye study/i }).first().click()
  await expect(page.getByText('Selected reference')).toBeVisible()
  await page.getByRole('button', { name: 'Trace', exact: true }).click()
  await page.getByRole('button', { name: 'Layers', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Remove trace' })).toBeVisible()
})

test('opens layers and changes theme', async ({ page }) => {
  await page.goto('/draw')
  await page.getByRole('button', { name: 'Layers', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Layers' })).toBeVisible()
  await expect(page.getByLabel('Name Layer 1')).toBeVisible()
  const themeButton = page.getByRole('button', { name: 'Toggle theme' })
  await themeButton.click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', /dark|light/)
})

test('support routes render their fixture shells', async ({ page }) => {
  await page.goto('/curate?mode=fixture')
  await expect(page.getByText(/non-persistent fixture demonstration/i)).toBeVisible()
  await page.goto('/benchmark')
  await expect(page.getByText('Anonymized pool')).toBeVisible()
  await page.goto('/setup')
  await expect(page.getByText(/Source and model review|Prepare a real reference review/i)).toBeVisible()
})

test('records only an explicitly consented local sequence', async ({ page }) => {
  await page.goto('/record')
  await expect(page.getByTestId('record-workspace')).toBeVisible()
  await page.getByRole('button', { name: 'Configure a recording' }).click()
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByRole('alert')).toContainText('required')
  await page.getByLabel(/I created this drawing/).check()
  await page.getByLabel(/I can grant the permissions I selected/).check()
  await page.getByLabel(/I have checked the reference terms/).check()
  await page.getByLabel(/I consent to this recording being stored locally/).check()
  await page.getByLabel(/I consent to evaluation/).check()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Begin recording' }).click()
  const stage = page.getByLabel('Drawing canvas')
  await expect(stage).toBeVisible()
  const box = await stage.boundingBox()
  if (!box) throw new Error('Recorder canvas stage has no bounds')
  await page.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.35)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.62, box.y + box.height * 0.55, { steps: 8 })
  await page.mouse.up()
  await page.getByRole('button', { name: 'Finish recording' }).click()
  await expect(page.getByRole('heading', { name: 'Review your recording' })).toBeVisible()
  await page.getByRole('button', { name: 'Accept and save locally' }).click()
  await expect(page.getByRole('heading', { name: 'Recording accepted' })).toBeVisible()
  await page.getByRole('button', { name: 'Record another' }).click()
  await page.getByRole('button', { name: 'Load accepted recordings' }).click()
  await expect(page.getByText(/Local recordings \(1\)/)).toBeVisible()
  const batchDownload = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export all accepted recordings' }).click()
  expect((await batchDownload).suggestedFilename()).toMatch(/^drawable-recordings-.*\.json$/)
})

test('autosaves, restores, and exports the drawing', async ({ page }) => {
  await page.goto('/draw')
  const stage = page.getByLabel('Drawing canvas')
  const box = await stage.boundingBox()
  if (!box) throw new Error('Canvas stage has no bounds')
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.4)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.55, { steps: 10 })
  await page.mouse.up()
  await page.waitForTimeout(900)
  await page.reload()
  await expect(page.getByText('Continue your last drawing?')).toBeVisible()
  await page.getByRole('button', { name: 'Restore drawing' }).click()
  await expect(page.getByText('Continue your last drawing?')).toBeHidden()
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export drawing' }).click()
  await page.getByRole('button', { name: /PNG · White background/ }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toBe('Untitled-drawing.png')
})

test('exports and reopens an editable drawable project in a new tab', async ({ page }) => {
  await page.goto('/draw')
  const stage = page.getByLabel('Drawing canvas')
  const box = await stage.boundingBox()
  if (!box) throw new Error('Canvas stage has no bounds')
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.42)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.62, box.y + box.height * 0.58, { steps: 10 })
  await page.mouse.up()
  await expect(page.getByText('Possibly an eye')).toBeVisible({ timeout: 5000 })
  await page.getByRole('button', { name: /View Eye study/i }).first().click()
  await page.getByRole('button', { name: 'Trace', exact: true }).click()

  const projectDownload = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export drawing' }).click()
  await page.getByRole('button', { name: /drawable project · Editable/ }).click()
  const downloaded = await projectDownload
  const projectPath = `/tmp/${downloaded.suggestedFilename()}`
  await downloaded.saveAs(projectPath)

  await page.getByRole('button', { name: 'Import sketch' }).click()
  await page.locator('input[type="file"]').setInputFiles(projectPath)
  await expect(page.getByText(/is ready to open as an independent drawing/)).toBeVisible()
  const popupPromise = page.waitForEvent('popup')
  await page.getByRole('link', { name: 'Open imported sketch' }).click()
  const imported = await popupPromise
  await imported.waitForLoadState('domcontentloaded')
  await expect(imported.getByText('Imported sketch opened as a new local drawing.')).toBeVisible()
  expect(new URL(imported.url()).searchParams.get('document')).not.toBe(new URL(page.url()).searchParams.get('document'))
  await expect(imported.getByLabel('Document name')).toHaveValue('Untitled drawing')
  await expect(imported.getByRole('button', { name: 'Hide trace · H' })).toBeVisible()
  await expect(page.getByLabel('Document name')).toHaveValue('Untitled drawing')
  await expect.poll(() => imported.locator('canvas.drawing-surface').evaluateAll((canvases) => canvases.some((canvas) => {
    const context = (canvas as HTMLCanvasElement).getContext('2d')
    if (!context) return false
    const pixels = context.getImageData(0, 0, context.canvas.width, context.canvas.height).data
    for (let index = 3; index < pixels.length; index += 4) if (pixels[index]) return true
    return false
  }))).toBe(true)
})

test('imports a safe SVG as flattened bottom-layer artwork', async ({ page }, testInfo) => {
  await page.goto('/draw')
  await page.getByRole('button', { name: 'Import sketch' }).click()
  await page.locator('input[type="file"]').setInputFiles({
    name: 'gesture-study.svg',
    mimeType: 'image/svg+xml',
    buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180"><path d="M20 150 Q150 10 300 140" fill="none" stroke="#111" stroke-width="12"/></svg>'),
  })
  await expect(page.getByText(/is ready to open as an independent drawing/)).toBeVisible()
  const popupPromise = page.waitForEvent('popup')
  await page.getByRole('link', { name: 'Open imported sketch' }).click()
  const imported = await popupPromise
  await imported.waitForLoadState('domcontentloaded')
  await expect(imported.getByLabel('Document name')).toHaveValue('gesture-study')
  await expect(imported.getByText('Possibly an eye')).toBeVisible({ timeout: 5000 })
  await imported.getByRole('button', { name: 'Layers', exact: true }).click()
  await expect(imported.getByLabel('Name Imported sketch')).toBeVisible()
  const clearImported = imported.getByRole('button', { name: 'Clear Imported sketch' })
  await expect(clearImported).toBeEnabled()
  await expect.poll(() => imported.locator('canvas.drawing-surface').first().evaluate((canvas) => {
    const context = (canvas as HTMLCanvasElement).getContext('2d')
    if (!context) return false
    const pixels = context.getImageData(0, 0, context.canvas.width, context.canvas.height).data
    for (let index = 3; index < pixels.length; index += 4) if (pixels[index]) return true
    return false
  })).toBe(true)
  await clearImported.click()
  await imported.getByRole('button', { name: 'Clear layer' }).click()
  await expect(clearImported).toBeDisabled()
  await imported.keyboard.press('Control+z')
  await expect(clearImported).toBeEnabled()

  const projectDownload = imported.waitForEvent('download')
  await imported.getByRole('button', { name: 'Export drawing' }).click()
  await imported.getByRole('button', { name: /drawable project · Editable/ }).click()
  const project = await projectDownload
  const projectPath = testInfo.outputPath('gesture-study.drawable')
  await project.saveAs(projectPath)
  await imported.getByRole('button', { name: 'Import sketch' }).click()
  await imported.locator('input[type="file"]').setInputFiles(projectPath)
  await expect(imported.getByText(/is ready to open as an independent drawing/)).toBeVisible()
  const reopenedPromise = imported.waitForEvent('popup')
  await imported.getByRole('link', { name: 'Open imported sketch' }).click()
  const reopened = await reopenedPromise
  await reopened.waitForLoadState('domcontentloaded')
  await expect(reopened.getByLabel('Document name')).toHaveValue('gesture-study')
  await reopened.getByRole('button', { name: 'Layers', exact: true }).click()
  await expect(reopened.getByRole('button', { name: 'Clear Imported sketch' })).toBeEnabled()
})

test('imports PNG artwork and rejects active SVG content without changing the current tab', async ({ page }) => {
  await page.goto('/draw')
  await page.getByRole('button', { name: 'Import sketch' }).click()
  await page.locator('input[type="file"]').setInputFiles({
    name: 'ink.png',
    mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mNkYGD4z8DAwMgAI0AMBgAEGgIBO6V/iQAAAABJRU5ErkJggg==', 'base64'),
  })
  await expect(page.getByText(/is ready to open as an independent drawing/)).toBeVisible()
  await page.locator('input[type="file"]').setInputFiles({
    name: 'unsafe.svg',
    mimeType: 'image/svg+xml',
    buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
  })
  await expect(page.getByRole('alert')).toContainText('unsupported active or embedded content')
  await expect(page.getByRole('link', { name: 'Open imported sketch' })).toHaveCount(0)
  const pngPayload = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mNkYGD4z8DAwMgAI0AMBgAEGgIBO6V/iQAAAABJRU5ErkJggg=='
  const badChecksum = '0'.repeat(64)
  const rasterId = `raster-${badChecksum}`
  const corruptProject = {
    format: 'drawable-project', formatVersion: 1, applicationVersion: '0.1.0', exportedAt: new Date(0).toISOString(), activeLayerId: 'layer-1',
    document: {
      title: 'Corrupt project',
      layers: Array.from({ length: 4 }, (_, index) => ({ id: `layer-${index + 1}`, name: `Layer ${index + 1}`, visible: true, opacity: 1, operations: index === 3 ? [{ id: 'raster-one', kind: 'raster', assetId: rasterId, x: 0, y: 0, width: 2048, height: 2048, createdAt: 1 }] : [] })),
      trace: { assetId: null, visible: true, opacity: 0.3, scale: 1 },
    },
    assets: [{ id: rasterId, mimeType: 'image/png', width: 2048, height: 2048, byteLength: Buffer.from(pngPayload, 'base64').length, sha256: badChecksum, data: pngPayload }],
  }
  await page.locator('input[type="file"]').setInputFiles({ name: 'corrupt.drawable', mimeType: 'application/vnd.drawable.project+json', buffer: Buffer.from(JSON.stringify(corruptProject)) })
  await expect(page.getByRole('alert')).toContainText('checksum does not match')
  await expect(page.getByRole('link', { name: 'Open imported sketch' })).toHaveCount(0)
  await expect(page.getByLabel('Document name')).toHaveValue('Untitled drawing')
})

test('incremental rendering produces pixel-identical results to a full layer rebuild', async ({ page }) => {
  await page.goto('/draw')
  const stage = page.getByLabel('Drawing canvas')
  await expect(stage).toBeVisible()
  const box = await stage.boundingBox()
  if (!box) throw new Error('Canvas stage has no bounds')

  // Draw overlapping strokes to exercise incremental append rendering.
  for (let index = 0; index < 3; index++) {
    await drawAt(page, box, 0.34 + index * 0.035)
  }
  await expectFullRenderMatches(page)

  // An overlapping eraser must preserve compositing order on the append path.
  await page.getByRole('button', { name: /Vector eraser/ }).click()
  await drawAt(page, box, 0.37)
  await expectFullRenderMatches(page)

  await page.keyboard.press('Control+z')
  await expectFullRenderMatches(page)

  await page.keyboard.press('Control+Shift+z')
  await expectFullRenderMatches(page)

  // Clear the active layer through the workspace UI, then verify its rebuilt pixels.
  await page.getByRole('button', { name: 'Layers', exact: true }).click()
  await page.getByRole('button', { name: 'Clear Layer 1' }).click()
  await page.getByRole('button', { name: 'Clear layer', exact: true }).click()
  await expectFullRenderMatches(page, false)

  // Import raster artwork, then append another stroke above the raster layer.
  await page.getByRole('button', { name: 'Import sketch' }).click()
  await page.locator('input[type="file"]').setInputFiles({
    name: 'reference.png',
    mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mNkYGD4z8DAwMgAI0AMBgAEGgIBO6V/iQAAAABJRU5ErkJggg==', 'base64'),
  })
  await expect(page.getByText(/is ready to open as an independent drawing/)).toBeVisible()
  const popupPromise = page.waitForEvent('popup')
  await page.getByRole('link', { name: 'Open imported sketch' }).click()
  const imported = await popupPromise
  await imported.waitForLoadState('domcontentloaded')
  const importedStage = imported.getByLabel('Drawing canvas')
  const importedBox = await importedStage.boundingBox()
  if (!importedBox) throw new Error('Imported drawing canvas has no bounds')
  await expectFullRenderMatches(imported)
  await drawAt(imported, importedBox, 0.45)
  await expectFullRenderMatches(imported)

  // Wait for the exact current revision to reach IndexedDB before reload.
  await expect.poll(() => imported.evaluate(async () => {
    const { documentStore } = await import(new URL('/src/state/documentStore.ts', location.origin).href)
    const current = documentStore.getState().document
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('drawable-documents', 2)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      const saved = await new Promise<{ document?: { revision?: number; layers?: Array<{ operations?: Array<{ id?: string }> }> } } | undefined>((resolve, reject) => {
        const request = db.transaction('documents').objectStore('documents').get(`document:${current.id}:current`)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      const currentIds = current.layers.flatMap((layer: { operations: Array<{ id: string }> }) => layer.operations.map((operation: { id: string }) => operation.id))
      const savedIds = saved?.document?.layers?.flatMap((layer) => layer.operations?.map((operation) => operation.id) ?? []) ?? []
      return saved?.document?.revision === current.revision && JSON.stringify(savedIds) === JSON.stringify(currentIds)
    } finally {
      db.close()
    }
  }), { timeout: 10_000 }).toBe(true)

  const expectedHashes = await referenceLayerHashes(imported)
  await imported.close()
  await page.goto('/draw')
  await expect(page.getByText('Continue your last drawing?')).toBeVisible()
  await page.getByRole('button', { name: 'Restore drawing' }).click()
  await expect(page.getByText('Continue your last drawing?')).toBeHidden()

  await expect.poll(async () => {
    return visibleLayerHashes(page)
  }, { timeout: 10_000 }).toEqual(expectedHashes.map(({ id, width, height, hash }) => ({ id, width, height, hash })))
  await expectFullRenderMatches(page)
})

test('effort timer pauses across workspace navigation and only exports tracked time', async ({ page }, testInfo) => {
  await page.goto('/m0')
  const tracker = page.getByLabel('M0 active effort timer')
  await tracker.getByRole('button', { name: 'Start effort' }).click()
  const startedAt = Date.now()
  await page.waitForTimeout(1200)

  await page.getByRole('button', { name: 'Switch workspace' }).click()
  await page.getByRole('menuitem', { name: /^Draw$/ }).click()
  await page.getByLabel('Drawing canvas').waitFor()
  await page.waitForTimeout(1600)

  await page.getByRole('button', { name: 'Switch workspace' }).click()
  await page.getByRole('menuitem', { name: /^M0$/ }).click()
  await expect(page.getByLabel('M0 active effort timer').getByRole('button', { name: 'Start effort' })).toBeVisible()

  await page.getByLabel('M0 active effort timer').getByRole('button', { name: 'Start effort' }).click()
  await page.waitForTimeout(1200)
  await page.getByLabel('M0 active effort timer').getByRole('button', { name: 'Pause effort' }).click()
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download effort log' }).click()
  const download = await downloadPromise
  const logPath = testInfo.outputPath(download.suggestedFilename())
  await download.saveAs(logPath)
  const log = JSON.parse(await readFile(logPath, 'utf8')) as { chunks: Array<{ activeMs: number }> }
  const trackedMs = log.chunks.reduce((sum, chunk) => sum + chunk.activeMs, 0)
  expect(trackedMs).toBeGreaterThan(1500)
  expect(trackedMs).toBeLessThan(Date.now() - startedAt - 700)
})
