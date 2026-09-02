#!/usr/bin/env node
// Capture the real first-run UI and every intelligence state for review.
// Intelligence states are exercised through the same test-only network
// boundary as the E2E suite: the lazy WebLLM chunks are replaced with a stub
// runtime at the network layer, so no model is downloaded and production code
// is never modified.
import { chromium } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const baseUrl = process.argv[2] ?? 'http://127.0.0.1:4173/'
const outDir = resolve(process.argv[3] ?? 'artifacts/visual-qa/intelligence')
mkdirSync(outDir, { recursive: true })

const viewports = [
  { name: 'mobile-375', width: 375, height: 812 },
  { name: 'desktop-1280', width: 1280, height: 900 },
]

async function completeOnboarding(page) {
  await page.getByLabel(/Nickname/).fill('Test')
  await page.getByRole('button', { name: /^7–9/ }).click()
  await page.getByRole('button', { name: 'Make this board ready' }).click()
  await page.getByRole('navigation', { name: 'Routine' }).waitFor()
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

function stubRoutes(context, mode) {
  context.route('**/assets/webllm-lib-*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/javascript',
      body:
        mode === 'unavailable'
          ? 'export async function CreateMLCEngine() { throw new Error("no webgpu") }\nexport async function CreateWebWorkerMLCEngine() { throw new Error("no webgpu") }\n'
          : STUB_MODULE.replace('makeEngine(false)', `makeEngine(${mode === 'fail' ? 'true' : 'false'})`),
    })
  })
}

const browser = await chromium.launch({ args: ['--mute-audio'] })

for (const viewport of viewports) {
  // First run + honest setup warning (real code path, no stub needed).
  const page = await browser.newPage({ viewport })
  await page.goto(baseUrl, { waitUntil: 'networkidle' })
  await page.screenshot({ path: `${outDir}/${viewport.name}-onboarding.png`, fullPage: true, animations: 'disabled' })
  await completeOnboarding(page)
  const panel = page.getByLabel('OwnSay Intelligence')
  await panel.getByRole('button', { name: 'Set up with a carer' }).click()
  await panel.getByText(/about 200 MB/).waitFor()
  await page.screenshot({ path: `${outDir}/${viewport.name}-setup-warning.png`, fullPage: true, animations: 'disabled' })
  await page.close()

  // Ready state through the stub engine.
  const readyContext = await browser.newContext({ viewport, serviceWorkers: 'block' })
  await readyContext.addInitScript(() => {
    Object.defineProperty(navigator, 'gpu', { value: {}, configurable: true })
  })
  stubRoutes(readyContext, 'ready')
  const ready = await readyContext.newPage()
  await ready.goto(baseUrl, { waitUntil: 'networkidle' })
  await completeOnboarding(ready)
  const readyPanel = ready.getByLabel('OwnSay Intelligence')
  await readyPanel.getByRole('button', { name: 'Set up with a carer' }).click()
  await readyPanel.getByRole('button', { name: 'Download on this device' }).click()
  try {
    await readyPanel.getByText('Ready').waitFor({ timeout: 30_000 })
  } catch (error) {
    const status = await readyPanel.getAttribute('data-status')
    const text = ((await readyPanel.innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ').slice(0, 300)
    throw new Error(`ready capture failed (status=${status}): ${text}`, { cause: error })
  }
  await ready.waitForTimeout(500)
  await ready.screenshot({ path: `${outDir}/${viewport.name}-intelligence-ready.png`, fullPage: true, animations: 'disabled' })
  await readyContext.close()

  // Degraded state through a failing engine.
  const degradedContext = await browser.newContext({ viewport, serviceWorkers: 'block' })
  await degradedContext.addInitScript(() => {
    Object.defineProperty(navigator, 'gpu', { value: {}, configurable: true })
  })
  stubRoutes(degradedContext, 'fail')
  const degraded = await degradedContext.newPage()
  await degraded.goto(baseUrl, { waitUntil: 'networkidle' })
  await completeOnboarding(degraded)
  const degradedPanel = degraded.getByLabel('OwnSay Intelligence')
  await degradedPanel.getByRole('button', { name: 'Set up with a carer' }).click()
  await degradedPanel.getByRole('button', { name: 'Download on this device' }).click()
  await degradedPanel.getByText('Trouble').waitFor({ timeout: 30_000 })
  await degraded.screenshot({ path: `${outDir}/${viewport.name}-intelligence-degraded.png`, fullPage: true, animations: 'disabled' })
  await degradedContext.close()

  // Unavailable state on genuinely unsupported hardware (no gpu stub).
  if (viewport.width > 800) {
    const unavailable = await browser.newPage({ viewport })
    await unavailable.goto(baseUrl, { waitUntil: 'networkidle' })
    await completeOnboarding(unavailable)
    const unavailablePanel = unavailable.getByLabel('OwnSay Intelligence')
    await unavailablePanel.getByRole('button', { name: 'Set up with a carer' }).click()
    await unavailablePanel.getByRole('button', { name: 'Download on this device' }).click()
    await unavailablePanel.getByText('Unavailable').waitFor({ timeout: 30_000 })
    await unavailable.screenshot({
      path: `${outDir}/${viewport.name}-intelligence-unavailable.png`,
      fullPage: true,
    })
    await unavailable.close()
  }
}

await browser.close()
console.log(`captured intelligence states to ${outDir}`)
