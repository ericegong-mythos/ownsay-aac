#!/usr/bin/env node
// Fictional-demo visual QA captures: onboarding, welcome moment, both starter
// boards and the Fire 7 viewports. Usage: node scripts/capture-demo-profile-screens.mjs <url> <outDir>
import { chromium } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const url = process.argv[2] ?? 'http://127.0.0.1:4173/'
const outDir = resolve(process.argv[3] ?? 'artifacts/visual-qa/ownsay-demo-profiles')
mkdirSync(outDir, { recursive: true })

const browser = await chromium.launch()

async function withPage(viewport, fn) {
  const page = await browser.newPage({ viewport })
  await page.goto(url, { waitUntil: 'networkidle' })
  await fn(page)
  await page.close()
}

const shots = [
  {
    name: '01-onboarding-1024x600',
    viewport: { width: 1024, height: 600 },
    steps: async (page) => {
      await page.waitForTimeout(300)
      await page.screenshot({ path: `${outDir}/01-onboarding-1024x600.png`, fullPage: false })
    },
  },
]

// Onboarding at every key viewport first.
for (const [file, viewport] of Object.entries({
  '01-onboarding-fire7-landscape-1024x600': { width: 1024, height: 600 },
  '02-onboarding-fire7-portrait-600x1024': { width: 600, height: 1024 },
  '03-onboarding-mobile-375x812': { width: 375, height: 812 },
  '04-onboarding-desktop-1280x800': { width: 1280, height: 800 },
})) {
  await withPage(viewport, async (page) => {
    await page.waitForTimeout(300)
    await page.screenshot({ path: `${outDir}/${file}.png`, fullPage: false })
  })
}

// Welcome moment + settled board for each child.
for (const child of ['Alex', 'Sam']) {
  for (const [label, viewport] of Object.entries({
    'fire7-landscape-1024x600': { width: 1024, height: 600 },
    'fire7-portrait-600x1024': { width: 600, height: 1024 },
    'mobile-375x812': { width: 375, height: 812 },
    'desktop-1280x800': { width: 1280, height: 800 },
  })) {
    await withPage(viewport, async (page) => {
      await page.getByRole('button', { name: new RegExp(`^${child}`) }).click()
      // Catch the celebration mid-flight.
      await page.waitForTimeout(700)
      await page.screenshot({
        path: `${outDir}/10-welcome-${child}-${label}.png`,
        fullPage: false,
      })
      await page.waitForTimeout(1500)
      await page.screenshot({
        path: `${outDir}/20-board-${child}-${label}.png`,
        fullPage: true,
      })
    })
  }
}

// Food routine (favourites in context zone) + carer drawer, landscape tablet.
await withPage({ width: 1024, height: 600 }, async (page) => {
  await page.getByRole('button', { name: /^Sam/ }).click()
  await page.waitForTimeout(2200)
  const nav = page.getByRole('navigation', { name: 'Routine' })
  await nav.getByRole('button', { name: 'Food' }).click()
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${outDir}/30-board-sam-food-fire7.png`, fullPage: true })

  const hold = page.getByRole('button', { name: 'Open carer settings' })
  const box = await hold.boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.waitForTimeout(1400)
  await page.mouse.up()
  await page.waitForTimeout(300)
  await page.screenshot({ path: `${outDir}/40-carer-drawer-fire7.png`, fullPage: false })
})

await browser.close()
console.log('demo-profile captures written to', outDir)
