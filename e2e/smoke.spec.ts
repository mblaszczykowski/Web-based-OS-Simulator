import { test, expect } from '@playwright/test'

test('boots, drags the Terminal window, and runs a command', async ({ page }) => {
  await page.goto('/')

  const input = page.locator('#terminal-input')
  await expect(input).toBeVisible({ timeout: 15_000 })

  const titlebar = page.getByLabel('Terminal window titlebar', { exact: false })
  const before = await titlebar.boundingBox()
  if (!before) throw new Error('Terminal titlebar has no bounding box')

  await page.mouse.move(before.x + 60, before.y + 10)
  await page.mouse.down()
  await page.mouse.move(before.x + 160, before.y + 110, { steps: 10 })
  await page.mouse.up()

  const after = await titlebar.boundingBox()
  if (!after) throw new Error('Terminal titlebar lost its bounding box after dragging')
  expect(Math.abs(after.x - before.x)).toBeGreaterThan(50)
  expect(Math.abs(after.y - before.y)).toBeGreaterThan(50)

  await input.click()
  await input.fill('ps')
  await input.press('Enter')

  await expect(page.locator('.term-output', { hasText: 'PID' })).toBeVisible()
  await expect(input).toHaveValue('')
})
