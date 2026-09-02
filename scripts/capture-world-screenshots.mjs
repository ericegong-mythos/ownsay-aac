#!/usr/bin/env node
// Capture one screenshot per routine world at mobile and desktop widths.
import { chromium } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const url = process.argv[2] ?? 'http://127.0.0.1:4173/'
const outDir = resolve(process.argv[3] ?? 'artifacts/visual-qa/worlds')
mkdirSync(outDir, { recursive: true })

const viewports = [
  { name: 'mobile-375', width: 375, height: 812 },
  { name: 'desktop-1280', width: 1280, height: 900 },
]

const browser = await chromium.launch()
for (const vp of viewports) {
  const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } })
  await page.goto(url, { waitUntil: 'networkidle' })
  for (const routine of ['Food', 'School', 'Home', 'Outside']) {
    await page.getByRole('navigation', { name: 'Routine' }).getByRole('button', { name: routine }).click()
    await page.waitForTimeout(450)
    const file = `${outDir}/${vp.name}-${routine.toLowerCase()}.png`
    await page.screenshot({ path: file, fullPage: true })
    console.log('captured', file)
  }
  await page.close()
}
await browser.close()
