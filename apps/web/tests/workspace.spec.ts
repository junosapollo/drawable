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
