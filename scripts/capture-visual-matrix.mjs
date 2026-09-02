#!/usr/bin/env node
// Capture the full visual-QA matrix required by the release brief:
// every viewport, onboarding, board, composed message, carer drawer,
// intelligence states, reduced motion, increased contrast and zoom reflow.
import { chromium } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const baseUrl = process.argv[2] ?? 'http://127.0.0.1:4173/'
const outDir = resolve(process.argv[3] ?? 'artifacts/visual-qa/ownsay-final')
mkdirSync(outDir, { recursive: true })

const VIEWPORTS = [
  { name: '320x568', width: 320, height: 568 },
  { name: '375x812', width: 375, height: 812 },
  { name: '390x844', width: 390, height: 844 },
  { name: '768x1024', width: 768, height: 1024 },
  { name: '1024x768', width: 1024, height: 768 },
  { name: '1280x800', width: 1280, height: 800 },
  { name: '1440x900', width: 1440, height: 900 },
]

async function onboard(page, nickname = 'QA') {
  const input = page.getByLabel(/Nickname/)
  if (await input.isVisible().catch(() => false)) {
    await input.fill(nickname)
    await page.getByRole('button', { name: /^10–12/ }).click()
    await page.getByRole('button', { name: 'Make this board ready' }).click()
    await page.getByRole('navigation', { name: 'Routine' }).waitFor()
  }
}

const STUB_MODULE = String.raw`
function answerFor(request) {
  const user = request.messages.filter(function (m) { return m.role === 'user' }).map(function (m) { return m.content }).join('\n')
  const ids = []
  for (const line of user.split('\n')) {
    const match = /^(c\d+) = /.exec(line.trim())
    if (match) ids.push(match[1])
  }
  return JSON.stringify({ chosen: ids.slice(0, 4) })
}
function makeEngine(fail) {
  return {
    chat: { completions: { create: async function (request) {
      if (fail) throw new Error('Message error should not be 0')
      const text = answerFor(request)
      return (async function* () {
        const size = Math.ceil(text.length / 3)
        for (let i = 0; i < text.length; i += size) {
          yield { choices: [{ delta: { content: text.slice(i, i + size) } }] }
        }
      })()
    } } },
    interruptGenerate: async function () {},
    unload: async function () {},
  }
}
export async function CreateMLCEngine(modelId, opts) {
  opts?.initProgressCallback?.({ text: 'Fetching model (stub) [0/1]' })
  opts?.initProgressCallback?.({ text: 'Finishing load (stub) [1/1]' })
  return makeEngine(false)
}
export async function CreateWebWorkerMLCEngine(worker, modelId, opts) {
  return CreateMLCEngine(modelId, opts)
}
`

// Screenshots must show the SETTLED interface: Playwright fast-forwards CSS
// animations to their end state when animations are disabled.
const SHOT = { animations: 'disabled' }
const browser = await chromium.launch({ args: ['--mute-audio'] })

for (const vp of VIEWPORTS) {
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    serviceWorkers: 'block',
  })
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'gpu', { value: {}, configurable: true })
  })
  await context.route('**/assets/webllm-lib-*', (route) =>
    route.fulfill({ status: 200, contentType: 'text/javascript', body: STUB_MODULE }),
  )
  await context.route('**/assets/webllm.worker-*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/javascript',
      body: '/* OwnSay visual-QA worker stub; runtime stub ignores it. */',
    }),
  )
  const page = await context.newPage()

  // 1. Onboarding.
  await page.goto(baseUrl, { waitUntil: 'networkidle' })
  await page.screenshot({ path: `${outDir}/${vp.name}-onboarding.png`, fullPage: true, ...SHOT })

  // 2. Board with empty rail + deterministic suggestions.
  await onboard(page)
  await page.screenshot({ path: `${outDir}/${vp.name}-board-empty.png`, fullPage: true, ...SHOT })

  // 3. Composed message across core + fringe + suggestion tokens.
  await page.getByRole('button', { name: 'I want', exact: false }).first().click().catch(() => {})
  for (const label of ['Help, Core', 'Want']) {
    await page.getByRole('button', { name: label, exact: true }).click()
  }
  const dock = page.getByLabel('Optional local suggestions')
  await dock.getByRole('button').last().click().catch(() => {})
  await page.screenshot({ path: `${outDir}/${vp.name}-message-composed.png`, fullPage: true, ...SHOT })

  // 4. Every routine world.
  for (const routine of ['Play', 'Food', 'School', 'Home', 'Outside']) {
    await page.getByRole('navigation', { name: 'Routine' }).getByRole('button', { name: routine }).click()
    await page.waitForTimeout(450)
    await page.screenshot({
      path: `${outDir}/${vp.name}-routine-${routine.toLowerCase()}.png`,
      fullPage: true,
    })
  }

  // 5. Carer drawer.
  const hold = page.getByRole('button', { name: 'Open carer settings' })
  const box = await hold.boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.waitForTimeout(1500)
  await page.mouse.up()
  const dialog = page.getByRole('dialog', { name: 'Carer settings' })
  await dialog.waitFor()
  await page.screenshot({ path: `${outDir}/${vp.name}-carer-drawer-top.png`, fullPage: false, ...SHOT })
  await dialog.evaluate((node) => node.scrollTo(0, node.scrollHeight))
  await page.waitForTimeout(150)
  await page.screenshot({ path: `${outDir}/${vp.name}-carer-drawer-bottom.png`, fullPage: false, ...SHOT })
  await page.keyboard.press('Escape')

  // 6. Intelligence states via the stub runtime.
  const clearButton = page.getByRole('button', { name: 'Clear', exact: true })
  if (await clearButton.isEnabled().catch(() => false)) await clearButton.click()
  await page.getByRole('navigation', { name: 'Routine' }).getByRole('button', { name: 'Play' }).click()
  await page.waitForTimeout(450)
  const panel = page.getByLabel('OwnSay Intelligence')
  await panel.getByRole('button', { name: 'Set up with a carer' }).click()
  await page.screenshot({ path: `${outDir}/${vp.name}-intelligence-warning.png`, fullPage: true, ...SHOT })
  await panel.getByRole('button', { name: 'Download on this device' }).click()
  try {
    await panel.getByText('Ready').waitFor({ timeout: 30_000 })
  } catch (error) {
    const status = await panel.getAttribute('data-status')
    const text = ((await panel.innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ').slice(0, 300)
    throw new Error(`ready capture failed (status=${status}): ${text}`, { cause: error })
  }
  await dock.getByText(/chosen on this device/).waitFor({ timeout: 30_000 })
  await page.screenshot({ path: `${outDir}/${vp.name}-intelligence-ready.png`, fullPage: true, ...SHOT })

  // 7. Offline badge.
  await context.setOffline(true)
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${outDir}/${vp.name}-offline-ready.png`, fullPage: false, ...SHOT })
  await context.setOffline(false)

  // 8. Overflow probe.
  const overflow = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }))
  if (overflow.scroll > overflow.client) {
    console.log(`OVERFLOW ${vp.name}: scrollWidth ${overflow.scroll} > clientWidth ${overflow.client}`)
  }

  await context.close()
}

// Reduced motion, increased contrast / forced colors, and 200% zoom reflow.
const a11y = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' })
const a11yPage = await a11y.newPage()
await a11yPage.emulateMedia({ reducedMotion: 'reduce', forcedColors: 'active' })
await a11yPage.goto(baseUrl, { waitUntil: 'networkidle' })
await a11yPage.screenshot({ path: `${outDir}/forced-colors-onboarding.png`, fullPage: true, ...SHOT })
await onboard(a11yPage, 'Contrast')
await a11yPage.screenshot({ path: `${outDir}/forced-colors-board.png`, fullPage: true, ...SHOT })

const motion = await browser.newContext({ viewport: { width: 375, height: 812 }, reducedMotion: 'reduce' })
const motionPage = await motion.newPage()
await motionPage.emulateMedia({ reducedMotion: 'reduce' })
await motionPage.goto(baseUrl, { waitUntil: 'networkidle' })
await onboard(motionPage, 'Motion')
await motionPage.getByRole('button', { name: 'No, Core' }).click()
const maxDuration = await motionPage.evaluate(() => {
  let max = 0
  const parse = (value) => value.split(',').map((part) => parseFloat(part) || 0)
  for (const el of document.querySelectorAll('button')) {
    const style = getComputedStyle(el)
    for (const value of [style.transitionDuration, style.animationDuration]) {
      for (const d of parse(value)) max = Math.max(max, d)
    }
  }
  for (const animation of document.getAnimations()) {
    max = Math.max(max, Number(animation.effect?.getTiming()?.duration ?? 0))
  }
  return max
})
console.log(`reduced-motion max duration: ${maxDuration}ms`)

// WCAG 1.4.4/1.4.10 reflow probe: 200% zoom of the 1280px desktop layout is
// equivalent to a 640px viewport; CSS zoom also forces true rescaling.
const zoom = await browser.newContext({ viewport: { width: 640, height: 800 }, deviceScaleFactor: 1 })
const zoomPage = await zoom.newPage()
await zoomPage.goto(baseUrl, { waitUntil: 'networkidle' })
await onboard(zoomPage, 'Zoom')
await zoomPage.evaluate(() => {
  document.documentElement.style.zoom = '2'
})
await zoomPage.waitForTimeout(500)
const zoomOverflow = await zoomPage.evaluate(() => ({
  client: Math.round(document.documentElement.clientWidth),
  scroll: Math.round(document.documentElement.scrollWidth),
}))
console.log(`200% zoom reflow: client ${zoomOverflow.client} scroll ${zoomOverflow.scroll}`)
if (zoomOverflow.scroll > zoomOverflow.client) console.log('OVERFLOW at 200% zoom')
await zoomPage.screenshot({ path: `${outDir}/zoom-200-board.png`, fullPage: false, ...SHOT })

// Keyboard-only pass at desktop size.
const kb = await browser.newContext({ viewport: { width: 1280, height: 800 } })
const kbPage = await kb.newPage()
await kbPage.goto(baseUrl, { waitUntil: 'networkidle' })
await onboard(kbPage, 'Keyboard')
let focusVisibleCount = 0
const keyboardStops = []
for (let i = 0; i < 20; i += 1) {
  await kbPage.keyboard.press('Tab')
  const stop = await kbPage.evaluate(() => {
    const el = document.activeElement
    if (!(el instanceof HTMLElement) || el === document.body) {
      return { label: 'body', visible: false }
    }
    const style = getComputedStyle(el)
    return {
      label: el.getAttribute('aria-label') || el.textContent?.trim().slice(0, 80) || el.tagName,
      visible: style.outlineWidth !== '0px' && style.outlineStyle !== 'none',
    }
  })
  keyboardStops.push(stop)
  if (stop.visible) focusVisibleCount += 1
}
console.log(`keyboard pass: ${focusVisibleCount}/20 stops showed visible focus`)
if (focusVisibleCount !== keyboardStops.length) {
  console.log(`keyboard failures: ${JSON.stringify(keyboardStops.filter((stop) => !stop.visible))}`)
}
await kb.close()

await browser.close()
console.log(`visual matrix captured to ${outDir}`)
