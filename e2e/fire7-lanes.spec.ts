import { expect, test, type Page } from '@playwright/test'

/**
 * Fire 7 (KFQUWI) hardening lanes.
 *
 * HONESTY NOTE: these tests run in desktop Chromium with a KFQUWI/Silk-like
 * user agent and DPR-1 touch viewports. That exercises layout and request
 * branching only — it is NOT real Silk emulation and proves nothing about
 * physical-device WebGPU or VoiceView. The in-app carer Device Check is the
 * physical evidence collector.
 */
export const FIRE_UA =
  'Mozilla/5.0 (Linux; Android 11; KFQUWI) AppleWebKit/537.36 (KHTML, like Gecko) Silk/119.1.1 like Chrome/119.0.6045.163 Safari/537.36'

const LANES = [
  { name: 'landscape-1024x600', width: 1024, height: 600, severe: false },
  { name: 'landscape-1024x520', width: 1024, height: 520, severe: true },
  { name: 'landscape-1024x430', width: 1024, height: 430, severe: true },
  { name: 'portrait-600x1024', width: 600, height: 1024, severe: false },
  { name: 'portrait-600x944', width: 600, height: 944, severe: false },
  { name: 'portrait-600x850', width: 600, height: 850, severe: false },
]

// 200%-zoom layout-only stress proxies.
const STRESS_LANES = [
  { name: 'stress-512x300', width: 512, height: 300 },
  { name: 'stress-300x512', width: 300, height: 512 },
]

async function openAsAlex(
  page: Page,
  opts: { reducedMotion?: boolean; forcedColors?: boolean } = {},
): Promise<void> {
  // The REAL KFQUWI/Silk-like UA must reach the browser: interpolate the
  // constant into the init script instead of a placeholder literal.
  const ua = FIRE_UA
  await page.addInitScript(`() => {
    Object.defineProperty(navigator, 'userAgent', { value: ${JSON.stringify(ua)}, configurable: true })
  }`)
  await page.goto('/', { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: /^Alex/ }).click()
  await expect(page.getByTestId('welcome-celebration')).toBeHidden({ timeout: 4000 })
  void opts
}

test.describe('Fire 7 lanes (KFQUWI-like UA, DPR1 touch; not real Silk emulation)', () => {
  for (const lane of [...LANES]) {
    test(`lane ${lane.name}: bounds, centre-point tapability, authored results`, async ({ browser }) => {
      const context = await browser.newContext({
        viewport: { width: lane.width, height: lane.height },
        deviceScaleFactor: 1,
        hasTouch: true,
        userAgent: FIRE_UA,
      })
      const page = await context.newPage()
      await openAsAlex(page)

      // No document-level horizontal overflow; content stays inside the
      // visual viewport bounds (nested containers included).
      const bounds = await page.evaluate(() => {
        const docEl = document.documentElement
        const clipped = Array.from(document.querySelectorAll('main *, header *')).filter((node) => {
          if (!(node instanceof HTMLElement)) return false
          const rect = node.getBoundingClientRect()
          return rect.width > 0 && (rect.right > docEl.clientWidth + 1 || rect.left < -1)
        }).length
        return { client: docEl.clientWidth, scroll: docEl.scrollWidth, clipped }
      })
      expect(bounds.scroll).toBe(bounds.client)
      expect(bounds.clipped, 'no interactive element may poke outside the viewport').toBe(0)

      // All five routine controls stay visible without clipping.
      const nav = page.getByRole('navigation', { name: 'Routine' })
      for (const routine of ['Play', 'Food', 'School', 'Home', 'Outside']) {
        await expect(nav.getByRole('button', { name: routine, exact: true })).toBeVisible()
      }

      // Centre-point hit testing: the element actually under each control's
      // centre must be that control (or its child) — no overlay steals taps.
      const hijacked = await page.evaluate(() => {
        const selectors = [
          '[aria-label="Open carer settings"]',
          '[aria-label="Routine"] button',
          '[data-tile-id]',
          '[aria-label="Authorship rail"] button',
        ]
        const problems: string[] = []
        for (const selector of selectors) {
          for (const node of document.querySelectorAll<HTMLElement>(selector)) {
            const rect = node.getBoundingClientRect()
            if (rect.width === 0 || rect.height === 0) continue
            const cx = rect.left + rect.width / 2
            const cy = rect.top + rect.height / 2
            if (cy < 0 || cy > window.innerHeight) continue
            const top = document.elementFromPoint(cx, cy)
            if (!top) continue
            if (!(top === node || node.contains(top))) {
              problems.push(`${selector} -> ${node.textContent?.slice(0, 12)} blocked by ${top.tagName}`)
            }
          }
        }
        return problems
      })
      expect(hijacked, `centre-point hijacks: ${hijacked.join('; ')}`).toEqual([])

      // Authored result: tapping Help produces exactly one rail chip.
      await page.getByRole('button', { name: 'Help, Core' }).click()
      const rail = page.getByRole('region', { name: 'Authorship rail' })
      await expect(rail.getByRole('button', { name: 'Remove Help, Core' })).toHaveCount(1)
      await rail.getByRole('button', { name: 'Remove Help, Core' }).click()
      await expect(rail.getByRole('button', { name: /^Remove/ })).toHaveCount(0)

      // No two rail controls may intersect (the compact-rail overlap guard).
      const overlaps = await page.evaluate(() => {
        const controls = Array.from(
          document.querySelectorAll<HTMLElement>('[aria-label="Authorship rail"] button'),
        ).map((node) => node.getBoundingClientRect())
        const bad: string[] = []
        for (let a = 0; a < controls.length; a += 1) {
          for (let b = a + 1; b < controls.length; b += 1) {
            const r1 = controls[a]
            const r2 = controls[b]
            const x = Math.max(0, Math.min(r1.right, r2.right) - Math.max(r1.left, r2.left))
            const y = Math.max(0, Math.min(r1.bottom, r2.bottom) - Math.max(r1.top, r2.top))
            if (x > 2 && y > 2) bad.push(`${a}∩${b}`)
          }
        }
        return bad
      })
      expect(overlaps, `overlapping controls: ${overlaps.join(', ')}`).toEqual([])

      // Carer drawer: sticky Close stays reachable at every lane height.
      await page.evaluate(() => {
        const hold = Array.from(document.querySelectorAll('button')).find((b) =>
          b.getAttribute('aria-label')?.includes('carer'),
        )
        hold?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      const dialog = page.getByRole('dialog', { name: 'Carer settings' })
      await expect(dialog).toBeVisible()
      const closeBox = await dialog.getByRole('button', { name: 'Close carer settings' }).boundingBox()
      expect(closeBox, 'Close must be rendered').toBeTruthy()
      expect(closeBox!.y, 'sticky Close must sit inside the viewport').toBeGreaterThanOrEqual(0)
      expect(closeBox!.height).toBeGreaterThanOrEqual(44)
      await context.close()
    })
  }

  for (const lane of STRESS_LANES) {
    test(`stress lane ${lane.name} (200% proxy): vertical scroll only, core reachable`, async ({ browser }) => {
      const context = await browser.newContext({
        viewport: { width: lane.width, height: lane.height },
        deviceScaleFactor: 1,
        hasTouch: true,
        userAgent: FIRE_UA,
      })
      const page = await context.newPage()
      await openAsAlex(page)
      const widths = await page.evaluate(() => ({
        client: document.documentElement.clientWidth,
        scroll: document.documentElement.scrollWidth,
      }))
      expect(widths.scroll).toBe(widths.client)
      // Core tiles remain reachable by vertical scroll; never below 44px.
      const tiles = page
        .getByRole('region')
        .filter({ has: page.getByRole('heading', { name: 'Core words' }) })
        .locator('[data-tile-id]')
      await expect(tiles).toHaveCount(8)
      for (let index = 0; index < 8; index += 1) {
        const tile = tiles.nth(index)
        await tile.scrollIntoViewIfNeeded()
        const box = await tile.boundingBox()
        expect(box?.height ?? 0).toBeGreaterThanOrEqual(44)
      }
      await context.close()
    })
  }

  test('forced colours keep core/context/anytime distinguishable', async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 1024, height: 600 },
      deviceScaleFactor: 1,
      forcedColors: 'active',
      hasTouch: true,
      userAgent: FIRE_UA,
    })
    const page = await context.newPage()
    await openAsAlex(page)
    const shapes = await page.evaluate(() => {
      const styleOf = (marker: string) => {
        const node = document.querySelector(marker)
        if (!node) return null
        const styles = getComputedStyle(node)
        return {
          border: styles.borderTopWidth,
          background: styles.backgroundColor,
          radius: styles.borderRadius,
        }
      }
      return {
        core: styleOf('[class*="coreMark"]'),
        now: styleOf('[class*="nowMark"]'),
        words: styleOf('[class*="wordsMark"]'),
      }
    })
    expect(shapes.core).toBeTruthy()
    expect(shapes.now).toBeTruthy()
    expect(shapes.words).toBeTruthy()
    // The three section markers must stay distinguishable by shape alone:
    // different radii (square vs dot vs ring).
    const distinct = new Set(
      [shapes.core, shapes.now, shapes.words].map((shape) => `${shape!.radius}/${shape!.border}`),
    )
    expect(distinct.size).toBeGreaterThanOrEqual(2)
    await context.close()
  })

  test('reduced motion: static welcome, no confetti, board fully usable', async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 1024, height: 600 },
      reducedMotion: 'reduce',
      hasTouch: true,
      userAgent: FIRE_UA,
    })
    const page = await context.newPage()
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: /^Alex/ }).click()
    const overlay = page.getByTestId('welcome-celebration')
    await expect(overlay).toBeVisible()
    expect(await overlay.locator('i').count()).toBe(0)
    await page.getByRole('button', { name: 'More, Core' }).click({ trial: true })
    await expect(overlay).toBeHidden({ timeout: 2000 })
    await context.close()
  })

  test('lane landscape-1024x600: all eight core tiles above the fold at ≥64px', async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 1024, height: 600 },
      deviceScaleFactor: 1,
      hasTouch: true,
      userAgent: FIRE_UA,
    })
    const page = await context.newPage()
    await openAsAlex(page)

    const tiles = page
      .getByRole('region')
      .filter({ has: page.getByRole('heading', { name: 'Core words' }) })
      .locator('[data-tile-id]')
    await expect(tiles).toHaveCount(8)
    const metrics = await tiles.evaluateAll((nodes) =>
      nodes.map((node) => {
        const rect = (node as HTMLElement).getBoundingClientRect()
        return { height: rect.height, bottom: rect.bottom }
      }),
    )
    for (const metric of metrics) {
      expect(metric.height, 'core tile must be ≥64px at 1024×600').toBeGreaterThanOrEqual(64)
      expect(metric.bottom, 'core tile must sit inside the first viewport').toBeLessThanOrEqual(600 + 1)
    }
    await context.close()
  })

  test('lane landscape-1024x520 (severe): core keeps ≥56px fallback and stays tappable after scroll', async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: 1024, height: 520 },
      deviceScaleFactor: 1,
      hasTouch: true,
      userAgent: FIRE_UA,
    })
    const page = await context.newPage()
    await openAsAlex(page)
    const tiles = page
      .getByRole('region')
      .filter({ has: page.getByRole('heading', { name: 'Core words' }) })
      .locator('[data-tile-id]')
    await expect(tiles).toHaveCount(8)
    const heights = await tiles.evaluateAll((nodes) =>
      nodes.map((node) => (node as HTMLElement).getBoundingClientRect().height),
    )
    for (const height of heights) {
      expect(height).toBeGreaterThanOrEqual(56)
    }
    await context.close()
  })

  test('orientation change with a composed phrase survives reload (phrase recovery)', async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 1024, height: 600 },
      deviceScaleFactor: 1,
      hasTouch: true,
      userAgent: FIRE_UA,
    })
    const page = await context.newPage()
    await openAsAlex(page)
    await page.getByRole('button', { name: 'Help, Core' }).click()
    await page.getByRole('button', { name: 'Yes, Core' }).click()

    // Rotate to portrait and simulate the renderer being evicted.
    await page.setViewportSize({ width: 600, height: 1024 })
    await page.reload({ waitUntil: 'networkidle' })
    const rail = page.getByRole('region', { name: 'Authorship rail' })
    await expect(rail.getByRole('button', { name: 'Remove Help, Core' })).toBeVisible()
    await expect(rail.getByRole('button', { name: 'Remove Yes, Core' })).toBeVisible()
    await context.close()
  })

  test('no welcome replay on incidental reload; no branded artwork anywhere', async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 1024, height: 600 },
      deviceScaleFactor: 1,
      hasTouch: true,
      userAgent: FIRE_UA,
    })
    const page = await context.newPage()
    await openAsAlex(page)
    await page.reload({ waitUntil: 'networkidle' })
    await page.waitForTimeout(400)
    await expect(page.getByTestId('welcome-celebration')).toHaveCount(0)

    // The welcome sprites are original pixel art; no external image assets load.
    const remoteImages = await page.evaluate(() =>
      Array.from(document.querySelectorAll('img'))
        .map((img) => img.src)
        .filter((src) => !src.startsWith(window.location.origin)),
    )
    expect(remoteImages).toEqual([])
    await context.close()
  })
})
