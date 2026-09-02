#!/usr/bin/env node
// Fire-class performance measurement (engineering evidence, NOT physical
// KFQUWI emulation): Playwright Chromium + CDP on the 1024x600 DPR-1 touch
// lane, 6x CPU throttle, and REAL network shaping via
// Network.emulateNetworkConditions — latency plus download/upload throughput
// in bytes/second applied inside Chromium's network stack, not route-delay
// approximations. The browser is launched muted and the app's speech adapter
// stays silent under webdriver automation, so no audio is ever produced.
//
// Hard gates (any one exits non-zero):
//   - any long task over 100 ms
//   - any console error or uncaught page error
//   - any failed request (network failure or HTTP >= 400)
//   - any unexpected cross-origin request or any model/runtime request during
//     ordinary deterministic use
//   - any interaction-correctness failure (exact token in the authorship
//     rail, routine/contextual-vocabulary change, suggestion append, or the
//     repeated/torture burst sequence)
// Plus the standing engineering ceilings (DOM size, heap, tap p95).
//
// Usage: node scripts/fire-perf.mjs <url> [outDir]
import { chromium } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Protected core order is fixed by the release brief; ids come from src/domain/protected-core.ts. */
export const CORE_TILES = [
  { id: 'no', label: 'No' },
  { id: 'stop', label: 'Stop' },
  { id: 'help', label: 'Help' },
  { id: 'hurts', label: 'Hurts' },
  { id: 'break', label: 'Break' },
  { id: 'yes', label: 'Yes' },
  { id: 'more', label: 'More' },
  { id: 'finished', label: 'Finished' },
]

const CPU_THROTTLE_RATE = 6

/** Fire-lane WAN shape as stated by the audit. */
export const NETWORK_PROFILE = { latencyMs: 150, downloadKbps: 1600, uploadKbps: 750 }

/** CDP Network.emulateNetworkConditions takes throughput in BYTES per second. */
export const kbpsToBytesPerSecond = (kbps) => (kbps * 1000) / 8

/** Exact payload sent to Network.emulateNetworkConditions. */
export const CDP_NETWORK_CONDITIONS = {
  offline: false,
  latency: NETWORK_PROFILE.latencyMs,
  downloadThroughput: kbpsToBytesPerSecond(NETWORK_PROFILE.downloadKbps),
  uploadThroughput: kbpsToBytesPerSecond(NETWORK_PROFILE.uploadKbps),
}

const CEILINGS = {
  domSteady: 400,
  domWelcome: 500,
  heapSteadyMiB: 32,
  heapAfterStressMiB: 48,
  retainedGrowthMiB: 4,
  coreTapP95Ms: 200,
  longTaskMs: 100,
}

/** Model/runtime requests must never happen during ordinary deterministic use. */
export function isModelRequestUrl(requestUrl) {
  return /webllm|@mlc-ai|mlc-llm|huggingface\.co|smollm|\.wasm(?:[?#]|$)/i.test(requestUrl)
}

/** Only http(s) requests can be cross-origin; data:/blob:/about: are inert. */
export function isCrossOriginUrl(requestUrl, origin) {
  try {
    const parsed = new URL(requestUrl)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    return parsed.origin !== origin
  } catch {
    return false
  }
}

export function percentile95(samples) {
  if (samples.length === 0) return null
  const sorted = [...samples].sort((a, b) => a - b)
  // Nearest-rank method.
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)]
}

const errorText = (error) => (error instanceof Error ? error.message.split('\n')[0] : String(error))

/** Exact token labels currently on the authorship rail, in order. */
const readRailLabels = (page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('[aria-label="Authorship rail"] [role="listitem"] button'))
      .map(
        (node) =>
          /^Remove (.*), (?:Core|Board|Local suggestion)$/.exec(node.getAttribute('aria-label') ?? '')?.[1] ??
          null,
      )
      .filter((label) => label !== null),
  )

/** Wait until the rail holds exactly `expected` chips whose token label is `label`. */
const waitForChipCount = (page, label, expected, timeout) =>
  page.waitForFunction(
    ({ label: wanted, expected: wantedCount }) => {
      const labels = Array.from(
        document.querySelectorAll('[aria-label="Authorship rail"] [role="listitem"] button'),
      )
        .map(
          (node) =>
            /^Remove (.*), (?:Core|Board|Local suggestion)$/.exec(node.getAttribute('aria-label') ?? '')?.[1] ??
            null,
        )
        .filter((chip) => chip !== null)
      return labels.filter((chip) => chip === wanted).length === wantedCount
    },
    { label, expected },
    { timeout },
  )

const waitForRailTotal = (page, expected, timeout) =>
  page.waitForFunction(
    (wantedCount) =>
      document.querySelectorAll('[aria-label="Authorship rail"] [role="listitem"] button').length ===
      wantedCount,
    expected,
    { timeout },
  )

/** Force the rail to a known-empty state, whatever an earlier guard left behind. */
const clearRail = async (page) => {
  const total = (await readRailLabels(page)).length
  if (total > 0) {
    await page.getByRole('button', { name: 'Clear', exact: true }).click()
    await waitForRailTotal(page, 0)
  }
}

/** Signature of the routine selector + the contextual ("Right now") vocabulary. */
const routineSignature = (page) =>
  page.evaluate(() => {
    const heading = document.getElementById('now-heading')?.textContent ?? ''
    const section = document.querySelector('[aria-labelledby="now-heading"]')
    const ids = section
      ? Array.from(section.querySelectorAll('[data-tile-id]'))
          .map((node) => node.getAttribute('data-tile-id'))
          .sort()
      : []
    return JSON.stringify({ heading, ids })
  })

async function main() {
  const url = process.argv[2] ?? 'http://127.0.0.1:4173/'
  const outDir = resolve(process.argv[3] ?? 'artifacts/perf')
  mkdirSync(outDir, { recursive: true })
  const origin = new URL(url).origin

  const failures = []
  const consoleErrors = []
  const pageErrors = []
  const requestUrls = []
  const failedRequests = []
  const crossOriginRequests = []
  const modelRequests = []

  const metrics = {
    measuredAtUtc: new Date().toISOString(),
    environment: {
      engine: 'Playwright Chromium + CDP',
      cpuThrottleRate: CPU_THROTTLE_RATE,
      network: {
        ...NETWORK_PROFILE,
        cdp: CDP_NETWORK_CONDITIONS,
        note: 'Real shaping via Network.emulateNetworkConditions (throughput in bytes/second at the network stack).',
      },
      viewport: '1024x600@1x touch',
      audio: 'Chromium launched with --mute-audio; speech adapter silent under webdriver.',
      honesty: 'Engineering evidence only — not physical KFQUWI emulation.',
    },
  }

  let phase = 'launch'
  const browser = await chromium.launch({ args: ['--mute-audio'] })
  try {
    const context = await browser.newContext({
      viewport: { width: 1024, height: 600 },
      deviceScaleFactor: 1,
      hasTouch: true,
    })
    try {
      const page = await context.newPage()
      page.setDefaultTimeout(15_000)

      page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text())
      })
      page.on('pageerror', (error) => pageErrors.push(String(error)))
      page.on('request', (request) => {
        const requestUrl = request.url()
        requestUrls.push(requestUrl)
        if (isModelRequestUrl(requestUrl)) modelRequests.push(requestUrl)
        else if (isCrossOriginUrl(requestUrl, origin)) crossOriginRequests.push(requestUrl)
      })
      page.on('requestfailed', (request) => {
        failedRequests.push(`${request.url()} :: ${request.failure()?.errorText ?? 'unknown'}`)
      })
      page.on('response', (response) => {
        if (response.status() >= 400) failedRequests.push(`${response.url()} :: HTTP ${response.status()}`)
      })

      // Web-vitals + long-task capture, installed before any app code runs.
      await page.addInitScript(() => {
        const store = { cls: 0, lcpMs: null, longTasks: [] }
        Object.defineProperty(window, '__ownsayPerf', { value: store, configurable: true })
        try {
          new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              if (!entry.hadRecentInput) store.cls += entry.value
            }
          }).observe({ type: 'layout-shift', buffered: true })
          new PerformanceObserver((list) => {
            const entries = list.getEntries()
            if (entries.length > 0) store.lcpMs = entries[entries.length - 1].startTime
          }).observe({ type: 'largest-contentful-paint', buffered: true })
          new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              store.longTasks.push({
                startTimeMs: Math.round(entry.startTime),
                durationMs: Math.round(entry.duration),
              })
            }
          }).observe({ type: 'longtask', buffered: true })
        } catch {
          // Observer types unsupported: vitals stay at their null/empty defaults.
        }
      })

      phase = 'cdp-setup'
      const session = await context.newCDPSession(page)
      await session.send('Network.enable')
      await session.send('Network.emulateNetworkConditions', CDP_NETWORK_CONDITIONS)
      await session.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLE_RATE })
      try {
        // Required before Performance.getMetrics returns real values.
        await session.send('Performance.enable')
      } catch {
        // Metric availability varies; heap is reported as null rather than faked.
      }

      const guard = async (name, fn) => {
        phase = name
        try {
          await fn()
        } catch (error) {
          failures.push(`[${name}] ${errorText(error)}`)
        }
      }

      let heapSteady = null
      let heapAfterStress = null
      async function heapBytes() {
        try {
          const heap = await session.send('Performance.getMetrics')
          const jsHeap = heap.metrics.find((metric) => metric.name === 'JSHeapUsedSize')
          return jsHeap ? jsHeap.value : null
        } catch {
          return null
        }
      }
      async function gcIfNeeded() {
        try {
          await session.send('HeapProfiler.collectGarbage')
        } catch {
          // Best-effort.
        }
      }

      // -- Load + onboarding (fresh context always lands on first-run setup) --
      let t0 = 0
      await guard('initial-load', async () => {
        t0 = Date.now()
        await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 })
      })
      await guard('onboarding', async () => {
        // Use one fictional demo profile for the cold-start performance path.
        await page.getByRole('button', { name: /^Alex/ }).click()
      })

      // -- Core readiness: all eight protected words present and enabled --
      await guard('core-ready', async () => {
        await page.waitForFunction((ids) => {
          return ids.every((id) => {
            const node = document.querySelector(`[data-tile-id="${id}"]`)
            if (!(node instanceof HTMLButtonElement) || node.disabled) return false
            const rect = node.getBoundingClientRect()
            return rect.width > 0 && rect.height > 0
          })
        }, CORE_TILES.map((tile) => tile.id))
        metrics.coreReadyMs = Date.now() - t0
      })

      await guard('dom-and-heap-baseline', async () => {
        metrics.domDuringWelcome = await page.evaluate(() => document.querySelectorAll('*').length)
        // The welcome moment self-dismisses; wait for it to leave rather than polling a fixed delay.
        await page
          .getByTestId('welcome-celebration')
          .waitFor({ state: 'detached', timeout: 5000 })
          .catch(() => {})
        await page.waitForTimeout(300)
        metrics.domSteady = await page.evaluate(() => document.querySelectorAll('*').length)
        await gcIfNeeded()
        heapSteady = await heapBytes()
        metrics.heapSteadyMiB = heapSteady === null ? null : +(heapSteady / (1024 * 1024)).toFixed(2)
      })

      // -- Core tap latency: each sample waits for THAT exact token on the rail --
      const tapLatencies = []
      await guard('core-tap-latency', async () => {
        for (let round = 0; round < 4 && tapLatencies.length < 30; round += 1) {
          for (const tile of CORE_TILES) {
            if (tapLatencies.length >= 30) break
            const beforeForLabel = (await readRailLabels(page)).filter((label) => label === tile.label).length
            const start = Date.now()
            await page.getByRole('button', { name: `${tile.label}, Core`, exact: true }).click()
            await waitForChipCount(page, tile.label, beforeForLabel + 1)
            tapLatencies.push(Date.now() - start)
            // Trim back so every sample is an append to a near-empty rail.
            const total = (await readRailLabels(page)).length
            await page.getByRole('button', { name: 'Delete last', exact: true }).click()
            await waitForRailTotal(page, total - 1)
          }
        }
        metrics.tapSamples = tapLatencies.length
        metrics.tapP95Ms = percentile95(tapLatencies)
      })

      // -- Suggestion selection latency: a suggestion is one chip per token,
      //    appended together. Gate the exact appended count AND the exact
      //    appended sequence (the whitespace-split phrase, in order). --
      await guard('suggestion-latency', async () => {
        const button = page.getByRole('button', { name: /^Add suggestion:/ }).first()
        await button.waitFor({ state: 'visible', timeout: 10_000 })
        const ariaLabel = (await button.getAttribute('aria-label')) ?? ''
        const match = /^Add suggestion: (.+) \((?:instant|OwnSay) phrase\)$/.exec(ariaLabel)
        if (!match) throw new Error(`could not parse suggestion label: ${ariaLabel}`)
        const expectedTokens = match[1].split(' ')
        const before = await readRailLabels(page)
        const start = Date.now()
        await button.click()
        await waitForRailTotal(page, before.length + expectedTokens.length)
        metrics.suggestionSelectMs = Date.now() - start
        const after = await readRailLabels(page)
        const appended = after.slice(before.length)
        if (
          after.length !== before.length + expectedTokens.length ||
          appended.some((label, index) => label !== expectedTokens[index])
        ) {
          failures.push(
            `[suggestion-latency] appended sequence mismatch: expected exactly ${expectedTokens.length} chip(s) ${JSON.stringify(expectedTokens)}, got ${JSON.stringify(appended)}`,
          )
        }
        // Reset the rail for the following phases.
        await clearRail(page)
      })

      // -- Routine switching: selected routine AND contextual vocabulary must change --
      const routineSwitchMs = {}
      await guard('routine-switch', async () => {
        for (const routine of ['food', 'play']) {
          const before = await routineSignature(page)
          const start = Date.now()
          await page
            .getByRole('navigation', { name: 'Routine' })
            .locator(`button[data-routine="${routine}"]`)
            .click()
          await page.waitForFunction(
            ({ routine: wanted, before: previous }) => {
              const selected = document.querySelector(
                `nav[aria-label="Routine"] button[data-routine="${wanted}"]`,
              )
              if (!selected || selected.getAttribute('data-selected') !== 'true') return false
              const heading = document.getElementById('now-heading')?.textContent ?? ''
              const section = document.querySelector('[aria-labelledby="now-heading"]')
              const ids = section
                ? Array.from(section.querySelectorAll('[data-tile-id]'))
                    .map((node) => node.getAttribute('data-tile-id'))
                    .sort()
                : []
              return JSON.stringify({ heading, ids }) !== previous
            },
            { routine, before },
          )
          routineSwitchMs[routine] = Date.now() - start
        }
        metrics.routineSwitchMs = routineSwitchMs
      })

      // -- Repeated/torture interaction correctness: rapid burst, exact sequence,
      //    delete-last, clear. Doubles as the heap stress sample. The rail is
      //    forced to a known-empty state first, so this gate measures the burst
      //    itself and stays independent of any earlier guarded failure. --
      await guard('torture-correctness', async () => {
        await clearRail(page)
        const expected = []
        const burstStart = Date.now()
        for (let index = 0; index < 40; index += 1) {
          const tile = index % 2 === 0 ? CORE_TILES[2] : CORE_TILES[1] // Help / Stop alternation
          expected.push(tile.label)
          await page.getByRole('button', { name: `${tile.label}, Core`, exact: true }).click()
        }
        await waitForRailTotal(page, expected.length, 30_000)
        metrics.tortureBurstMs = Date.now() - burstStart
        const afterBurst = await readRailLabels(page)
        if (afterBurst.length !== expected.length || afterBurst.some((label, index) => label !== expected[index])) {
          failures.push(
            `[torture-correctness] rail sequence mismatch after 40-tap burst: expected ${expected.length} chips in order, got ${afterBurst.length} (${afterBurst.slice(0, 6).join(',')}…)`,
          )
        }
        metrics.railChipsAfterBurst = afterBurst.length

        await gcIfNeeded()
        await page.waitForTimeout(200)
        heapAfterStress = await heapBytes()
        metrics.heapAfterStressMiB = heapAfterStress === null ? null : +(heapAfterStress / (1024 * 1024)).toFixed(2)
        metrics.retainedGrowthMiB =
          heapAfterStress === null || heapSteady === null
            ? null
            : +Math.max(0, (heapAfterStress - heapSteady) / (1024 * 1024)).toFixed(2)

        // Repeated delete-last must peel the burst in exact reverse order.
        for (let index = 0; index < 3; index += 1) {
          const remaining = expected.length - index
          await page.getByRole('button', { name: 'Delete last', exact: true }).click()
          await waitForRailTotal(page, remaining - 1)
        }
        const afterDeletes = await readRailLabels(page)
        const expectedAfterDeletes = expected.slice(0, -3)
        if (
          afterDeletes.length !== expectedAfterDeletes.length ||
          afterDeletes.some((label, index) => label !== expectedAfterDeletes[index])
        ) {
          failures.push('[torture-correctness] delete-last did not peel the burst in exact reverse order')
        }

        await page.getByRole('button', { name: 'Clear', exact: true }).click()
        await waitForRailTotal(page, 0)
        const afterClear = await readRailLabels(page)
        if (afterClear.length !== 0) {
          failures.push('[torture-correctness] Clear left chips on the rail')
        }
      })

      // -- Vitals readout (captured from the very first frame) --
      await guard('vitals', async () => {
        const vitals = await page.evaluate(() => window.__ownsayPerf ?? null)
        metrics.vitals = {
          cls: vitals ? +vitals.cls.toFixed(4) : null,
          lcpMs: vitals && vitals.lcpMs !== null ? Math.round(vitals.lcpMs) : null,
        }
        const longTasks = vitals?.longTasks ?? []
        metrics.longTasks = longTasks
        metrics.longTasksOver100ms = longTasks.filter((task) => task.durationMs > CEILINGS.longTaskMs).length
        metrics.maxLongTaskMs = longTasks.length > 0 ? Math.max(...longTasks.map((task) => task.durationMs)) : 0
      })
    } finally {
      await context.close().catch(() => {})
    }
  } catch (error) {
    failures.push(`[${phase}] run aborted: ${errorText(error)}`)
  } finally {
    metrics.networkAudit = {
      requestCount: requestUrls.length,
      failedRequests,
      crossOriginRequests,
      modelRequests,
      requestUrls: requestUrls.slice(0, 200),
    }
    metrics.consoleErrors = consoleErrors.slice(0, 20)
    metrics.pageErrors = pageErrors.slice(0, 20)

    if (consoleErrors.length > 0) failures.push(`console errors (${consoleErrors.length}): ${consoleErrors[0]}`)
    if (pageErrors.length > 0) failures.push(`uncaught page errors (${pageErrors.length}): ${pageErrors[0]}`)
    if (failedRequests.length > 0)
      failures.push(`failed requests (${failedRequests.length}): ${failedRequests[0]}`)
    if (crossOriginRequests.length > 0)
      failures.push(`unexpected cross-origin requests: ${[...new Set(crossOriginRequests)].join(', ')}`)
    if (modelRequests.length > 0)
      failures.push(`model/runtime requests during ordinary use: ${[...new Set(modelRequests)].join(', ')}`)
    if (metrics.longTasksOver100ms > 0)
      failures.push(`${metrics.longTasksOver100ms} long task(s) over 100 ms (max ${metrics.maxLongTaskMs} ms)`)

    if (typeof metrics.domSteady === 'number' && metrics.domSteady > CEILINGS.domSteady)
      failures.push(`DOM steady ${metrics.domSteady} > ${CEILINGS.domSteady}`)
    if (typeof metrics.domDuringWelcome === 'number' && metrics.domDuringWelcome > CEILINGS.domWelcome)
      failures.push(`DOM welcome ${metrics.domDuringWelcome} > ${CEILINGS.domWelcome}`)
    if (metrics.heapSteadyMiB !== null && metrics.heapSteadyMiB !== undefined && metrics.heapSteadyMiB > CEILINGS.heapSteadyMiB)
      failures.push(`heap steady ${metrics.heapSteadyMiB} MiB > ${CEILINGS.heapSteadyMiB}`)
    if (metrics.heapAfterStressMiB != null && metrics.heapAfterStressMiB > CEILINGS.heapAfterStressMiB)
      failures.push(`heap after stress ${metrics.heapAfterStressMiB} MiB > ${CEILINGS.heapAfterStressMiB}`)
    if (metrics.retainedGrowthMiB != null && metrics.retainedGrowthMiB > CEILINGS.retainedGrowthMiB)
      failures.push(`retained growth ${metrics.retainedGrowthMiB} MiB over ${CEILINGS.retainedGrowthMiB} MiB`)
    if (metrics.tapP95Ms != null && metrics.tapP95Ms > CEILINGS.coreTapP95Ms)
      failures.push(`core tap p95 ${metrics.tapP95Ms} ms > ${CEILINGS.coreTapP95Ms}`)

    metrics.failures = failures
    writeFileSync(resolve(outDir, 'fire-perf-results.json'), JSON.stringify(metrics, null, 2))
    console.log(JSON.stringify(metrics, null, 2))
    await browser.close().catch(() => {})
  }

  if (failures.length > 0) {
    console.error('FIRE PERFORMANCE LANE FAILED:')
    for (const failure of failures) console.error(` - ${failure}`)
    return 1
  }
  console.log('All Fire performance engineering ceilings and correctness gates passed.')
  return 0
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (isMain) {
  process.exitCode = await main()
}
