#!/usr/bin/env node
// Fire 7 hardening evidence captures: chooser, welcomes (motion + reduced),
// settled Play/Food states, composed message, carer settings, device check,
// unsupported intelligence, severe lanes and portrait.
// Usage: node scripts/capture-fire7-screens.mjs <url> <outDir>
import { chromium } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const url = process.argv[2] ?? 'http://127.0.0.1:4173/'
const outDir = resolve(process.argv[3] ?? 'artifacts/visual-qa/ownsay-fire7')
mkdirSync(outDir, { recursive: true })

const browser = await chromium.launch()

async function withContext(opts, fn) {
  const context = await browser.newContext({ deviceScaleFactor: 1, hasTouch: true, ...opts })
  const page = await context.newPage()
  await page.goto(url, { waitUntil: 'networkidle' })
  await fn(page, context)
  await context.close()
}

async function choose(page, child) {
  await page.getByRole('button', { name: new RegExp(`^${child}`) }).click()
  await page.waitForTimeout(750)
}

async function settle(page) {
  await page.waitForTimeout(1400)
}

async function openCarer(page) {
  const hold = page.getByRole('button', { name: 'Open carer settings' })
  const box = await hold.boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.waitForTimeout(1400)
  await page.mouse.up()
  await page.waitForTimeout(300)
}

const fire = {
  viewport: { width: 1024, height: 600 },
  userAgent:
    'Mozilla/5.0 (Linux; Android 11; KFQUWI) AppleWebKit/537.36 (KHTML, like Gecko) Silk/119.1.1 like Chrome/119.0.6045.163 Safari/537.36',
}

// 1. Chooser at Fire landscape.
await withContext(fire, async (page) => {
  await page.waitForTimeout(300)
  await page.screenshot({ path: `${outDir}/01-chooser-fire7-1024x600.png` })
})

// 2. Welcomes for both children at Fire landscape.
for (const child of ['Alex', 'Sam']) {
  await withContext(fire, async (page) => {
    await choose(page, child)
    await page.screenshot({ path: `${outDir}/02-welcome-${child.toLowerCase()}-fire7.png` })
    await settle(page)
    await page.screenshot({ path: `${outDir}/03-settled-play-${child.toLowerCase()}-fire7.png` })
  })
}

// 3. Settled Food states for both children.
for (const child of ['Alex', 'Sam']) {
  await withContext(fire, async (page) => {
    await choose(page, child)
    await settle(page)
    const nav = page.getByRole('navigation', { name: 'Routine' })
    await nav.getByRole('button', { name: 'Food', exact: true }).click()
    await page.waitForTimeout(400)
    await page.screenshot({ path: `${outDir}/04-settled-food-${child.toLowerCase()}-fire7.png` })
  })
}

// 4. Composed message on Alex's board.
await withContext(fire, async (page) => {
  await choose(page, 'Alex')
  await settle(page)
  await page.getByRole('button', { name: 'Help, Core' }).click()
  await page.getByRole('button', { name: 'Building blocks', exact: true }).click()
  await page.getByRole('button', { name: 'Want', exact: true }).click()
  await page.waitForTimeout(250)
  await page.screenshot({ path: `${outDir}/05-composed-message-fire7.png` })
})

// 5. Carer settings + Device check result.
await withContext(fire, async (page) => {
  await choose(page, 'Sam')
  await settle(page)
  await openCarer(page)
  await page.screenshot({ path: `${outDir}/06-carer-settings-fire7.png` })
  await page.getByRole('button', { name: 'Run device check' }).click()
  await page.waitForSelector('text=Core board:', { timeout: 20_000 })
  await page.waitForTimeout(300)
  await page.screenshot({ path: `${outDir}/07-device-check-fire7.png`, fullPage: true })
})

// 6. Unsupported intelligence state (no WebGPU in desktop Chromium by default).
await withContext(fire, async (page) => {
  await choose(page, 'Sam')
  await settle(page)
  const panel = page.getByLabel('OwnSay Intelligence')
  await panel.getByRole('button', { name: 'Set up with a carer' }).click()
  await panel.getByRole('button', { name: 'Download on this device' }).click()
  await page.waitForSelector('text=Not on this tablet', { timeout: 15_000 })
  await page.screenshot({ path: `${outDir}/08-intelligence-unsupported-fire7.png` })
})

// 7. Severe lane 1024×430 settled board.
await withContext(
  {
    viewport: { width: 1024, height: 430 },
    userAgent: fire.userAgent,
  },
  async (page) => {
    await choose(page, 'Alex')
    await settle(page)
    await page.screenshot({ path: `${outDir}/09-severe-lane-1024x430.png` })
  },
)

// 8. Portrait 600×1024 Sam food.
await withContext({ viewport: { width: 600, height: 1024 } }, async (page) => {
  await choose(page, 'Sam')
  await settle(page)
  const nav = page.getByRole('navigation', { name: 'Routine' })
  await nav.getByRole('button', { name: 'Food', exact: true }).click()
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${outDir}/10-portrait-sam-food-600x1024.png`, fullPage: false })
})

// 9. Reduced motion static welcome.
{
  const context = await browser.newContext({
    viewport: { width: 1024, height: 600 },
    reducedMotion: 'reduce',
    deviceScaleFactor: 1,
  })
  const page = await context.newPage()
  await page.goto(url, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: /^Alex/ }).click()
  await page.waitForTimeout(200)
  await page.screenshot({ path: `${outDir}/11-welcome-reduced-motion.png` })
  await context.close()
}

await browser.close()
console.log('fire7 captures written to', outDir)
