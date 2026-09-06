import { expect, test } from '@playwright/test'

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
  await page.goto('/curate')
  await expect(page.getByText('Candidate metadata')).toBeVisible()
  await page.goto('/benchmark')
  await expect(page.getByText('Anonymized pool')).toBeVisible()
  await page.goto('/setup')
  await expect(page.getByText('drawable can run without a backend')).toBeVisible()
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
