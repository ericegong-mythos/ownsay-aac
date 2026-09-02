#!/usr/bin/env node
// Capture full-page screenshots of the running app at mobile and desktop widths.
// Usage: node scripts/capture-ui-screenshots.mjs <url> <outDir>
import { chromium, webkit } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const url = process.argv[2] ?? 'http://127.0.0.1:5173/'
const outDir = resolve(process.argv[3] ?? 'artifacts/visual-qa')
mkdirSync(outDir, { recursive: true })

const viewports = [
  { name: 'mobile-375', width: 375, height: 812 },
  { name: 'desktop-1280', width: 1280, height: 900 },
]

const engines = { chromium, webkit }
const only = process.env.BROWSER
for (const [name, engine] of Object.entries(engines)) {
  if (only && only !== name) continue
  const browser = await engine.launch()
  for (const vp of viewports) {
    const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } })
    await page.goto(url, { waitUntil: 'networkidle' })
    await page.waitForTimeout(400)
    const file = `${outDir}/${vp.name}-${name}.png`
    await page.screenshot({ path: file, fullPage: true })
    console.log('captured', file)
    await page.close()
  }
  await browser.close()
}
