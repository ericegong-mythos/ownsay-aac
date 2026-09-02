#!/usr/bin/env node
// Diagnostic probe: instruments the REAL activation path without changing the
// app. Logs every OwnSay Intelligence data-status transition, visible progress
// copy, console/pageerror traffic, request failures, service-worker state and
// CacheStorage inventory — so an activation stall can be attributed precisely.
import { chromium } from '@playwright/test'
import { resolve } from 'node:path'

const url = process.argv[2] ?? 'http://127.0.0.1:4173/'
const profileDir = resolve('artifacts/visual-qa/ownsay-final/.real-model-profile')
const MODE = process.argv[3] ?? 'observe' // observe | wake | setup

const context = await chromium.launchPersistentContext(profileDir, {
  headless: true,
  args: ['--enable-unsafe-webgpu', '--use-angle=metal', '--mute-audio'],
  viewport: { width: 1280, height: 900 },
})
const page = context.pages()[0] ?? (await context.newPage())

page.on('console', (m) => process.stdout.write(`[console:${m.type()}] ${m.text().slice(0, 300)}\n`))
page.on('pageerror', (e) => process.stdout.write(`[pageerror] ${e.name}: ${e.message}\n`))
page.on('requestfailed', (r) =>
  process.stdout.write(`[requestfailed] ${r.url()} :: ${r.failure()?.errorText}\n`),
)

await context.exposeFunction('probeLog', (line) => process.stdout.write(`[probe] ${line}\n`))

await page.addInitScript(() => {
  const seen = new Set()
  const start = () => {
    const hook = () => {
      const node = document.querySelector('[aria-label="OwnSay Intelligence"]')
      if (!node) return
      const status = node.getAttribute('data-status')
      const key = `${status}:${node.textContent ?? ''}`
      if (!seen.has(key)) {
        seen.add(key)
        window.probeLog?.(`status=${status} :: ${(node.textContent ?? '').replace(/\s+/g, ' ').slice(0, 240)}`)
      }
    }
    new MutationObserver(hook).observe(document.body, { childList: true, subtree: true, characterData: true })
    hook()
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start)
  else start()
})

try {
  await page.goto(url, { waitUntil: 'networkidle' })

  const env = await page.evaluate(async () => {
    const cachesList = []
    for (const name of await caches.keys()) {
      const cache = await caches.open(name)
      const keys = await cache.keys()
      let bytes = 0
      for (const request of keys.slice(0, 12)) {
        const response = await cache.match(request)
        if (response) bytes += Number((await response.arrayBuffer()).byteLength)
      }
      cachesList.push({ name, entries: keys.length, sampledBytes: bytes })
    }
    const databases = indexedDB.databases ? await indexedDB.databases() : []
    const registration = await navigator.serviceWorker.getRegistration()
    return {
      gpu: Boolean(navigator.gpu),
      serviceWorker: registration
        ? {
            scope: registration.scope,
            activeScriptURL: registration.active?.scriptURL ?? null,
            installingScriptURL: registration.installing?.scriptURL ?? null,
            waitingScriptURL: registration.waiting?.scriptURL ?? null,
          }
        : null,
      caches: cachesList,
      databases: databases.map((entry) => ({ name: entry.name, version: entry.version })),
      panelStatus: document.querySelector('[aria-label="OwnSay Intelligence"]')?.getAttribute('data-status') ?? null,
      panelText: document.querySelector('[aria-label="OwnSay Intelligence"]')?.textContent ?? '',
      hasOnboarding: Boolean(document.querySelector('#nickname-input, [id="nickname-input"]')),
    }
  })
  console.log(JSON.stringify({ env }, null, 2))

  if (MODE !== 'observe') {
    const panel = page.getByRole('complementary', { name: 'OwnSay Intelligence' })
    const current = await panel.getAttribute('data-status')
    if (current === 'off' || current === null) {
      const paused = await panel.getByRole('button', { name: /Wake/ }).isVisible().catch(() => false)
      if (paused) {
        console.log('path: paused -> wake')
        await panel.getByRole('button', { name: /Wake/ }).click()
      } else {
        console.log('path: fresh -> setup')
        await panel.getByRole('button', { name: 'Set up with a carer' }).click()
        await panel.getByRole('button', { name: 'Download on this device' }).click()
      }
    } else {
      console.log(`path: none needed (status=${current})`)
    }

    const deadline = Date.now() + 10 * 60_000
    while (Date.now() < deadline) {
      const status = await panel.getAttribute('data-status')
      if (status === 'ready' || status === 'unavailable' || status === 'degraded') break
      await page.waitForTimeout(2000)
    }
    console.log(`final status=${await panel.getAttribute('data-status')}`)
    const dock = page.getByLabel('Optional local suggestions')
    try {
      await dock.getByText(/chosen on this device|Instant phrases/).waitFor({ timeout: 30_000 })
      console.log(await dock.innerText())
    } catch {
      console.log('dock note never settled')
    }
  }
} finally {
  await context.close()
}
