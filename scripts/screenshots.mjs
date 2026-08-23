// Captures the README screenshots against the production build.
// Run with: npm run screenshots

import { chromium } from '@playwright/test'
import { mkdirSync } from 'node:fs'

const BASE = process.env.BASE_URL ?? 'http://localhost:4173'
const OUT = 'docs'

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function type(page, command) {
  const input = page.locator('#terminal-input')
  await input.click()
  await input.fill(command)
  await input.press('Enter')
  await wait(120)
}

async function openWindow(page, label) {
  await page.getByLabel(`Open ${label} window`, { exact: true }).click()
  await wait(200)
}

async function closeWindow(page, title) {
  const win = page.locator(`[aria-label="${title} window"]`)
  if (await win.count()) {
    await win.first().getByLabel('Close', { exact: true }).click()
    await wait(150)
  }
}

const ALL_WINDOWS = ['Scheduler', 'Memory', 'Filesystem', 'Process sync', 'Network', 'Terminal', 'Syscall trace']

async function closeAll(page) {
  for (const title of ALL_WINDOWS) await closeWindow(page, title)
}

/** Opens one window on its own, maximized, and screenshots just that window. */
async function soloWindow(page, dockLabel, title, name, settle = 1200) {
  await closeAll(page)
  await openWindow(page, dockLabel)
  const win = page.locator(`[aria-label="${title} window"]`)
  await win.getByLabel('Maximize', { exact: true }).click()
  await wait(settle)
  await shot(page, name, win)
}

async function shot(page, name, locator) {
  const target = locator ?? page
  await target.screenshot({ path: `${OUT}/${name}.png`, scale: 'css' })
  console.log(`  wrote ${OUT}/${name}.png`)
}

const run = async () => {
  mkdirSync(OUT, { recursive: true })

  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })
  await page.goto(BASE)
  await page.locator('#terminal-input').waitFor({ timeout: 20_000 })
  await wait(600)

  // Build a state worth looking at: a few processes, a pipeline, a fork,
  // some files and a symlink.
  await type(page, 'reset-fs')
  await type(page, 'stress 4')
  await type(page, 'run --threads=3 renderer')
  await type(page, 'pipe producer consumer')
  await type(page, 'write /var/log/app.log request handled in 12ms')
  await type(page, 'write /notes.txt scheduler notes')
  await type(page, 'ln -s /notes.txt /home/notes')
  await wait(6000)
  await type(page, 'fork 3')
  // The turnaround and waiting averages only count processes that have
  // finished, so let enough of them finish to make the figures mean
  // something before the first capture.
  await wait(32000)

  console.log('capturing…')

  // 1. The desktop as it opens, with several windows in play.
  await shot(page, 'screenshot-desktop')

  await soloWindow(page, 'Scheduler', 'Scheduler', 'screenshot-scheduler')
  await soloWindow(page, 'Memory', 'Memory', 'screenshot-memory')
  await soloWindow(page, 'Filesystem', 'Filesystem', 'screenshot-filesystem', 2500)

  // The IPC tab, reached through the shared-session link rather than a
  // click, which the window stacking makes unreliable.
  await page.goto(`${BASE}?sync=ipc`)
  // The window layout persists, so reopen the terminal explicitly rather
  // than assuming the reload brings it back.
  await wait(2500)
  await openWindow(page, 'Terminal')
  await page.locator('#terminal-input').waitFor({ timeout: 20_000 })
  await wait(400)
  await type(page, 'pipe producer consumer')
  await wait(3500)
  await closeAll(page)
  await openWindow(page, 'Sync')
  await page.locator('[aria-label="Process sync window"]').getByLabel('Maximize', { exact: true }).click()
  await wait(2500)
  await shot(page, 'screenshot-ipc', page.locator('[aria-label="Process sync window"]'))

  // Terminal and syscall trace side by side.
  await closeAll(page)
  await openWindow(page, 'Terminal')
  await openWindow(page, 'Trace')
  await page.locator('#terminal-input').waitFor({ timeout: 20_000 })
  await type(page, 'ps')
  await type(page, 'lsof')
  await wait(800)
  await shot(page, 'screenshot-terminal')

  await browser.close()
  console.log('done')
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
