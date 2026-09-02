import { expect, test } from '@playwright/test'
import {
  PROTECTED_CORE_LABELS,
  closeCarerDrawer,
  completeOnboarding,
  expectNoHorizontalOverflow,
  openCarerDrawer,
  setDensity,
} from './helpers'

const AGE_BANDS = ['4–6', '7–9', '10–12'] as const
const DENSITIES = ['Large', 'Standard', 'More words'] as const
const ROUTINES = ['Play', 'Food', 'School', 'Home', 'Outside'] as const

/** The fringe now spans the contextual and anytime sections; both are board words. */
function fringeSection(page: import('@playwright/test').Page) {
  return page
    .locator('section')
    .filter({
      has: page.getByRole('heading', { name: /Right now|Anytime words/ }),
    })
}

test.describe('protected core invariants', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' })
    await completeOnboarding(page)
  })

  test('core order and visibility hold across every age band, density and routine', async ({ page }) => {
    // This deliberately exhaustive 45-state interaction matrix can exceed
    // the default 30-second budget in WebKit on a shared two-core CI runner.
    // Keep the coverage; give that real workload an explicit slow-test budget.
    test.slow()

    for (const band of AGE_BANDS) {
      await openCarerDrawer(page)
      await page.getByRole('button', { name: band }).click()
      await closeCarerDrawer(page)

      for (const density of DENSITIES) {
        await setDensity(page, density)

        for (const routine of ROUTINES) {
          await page.getByRole('button', { name: routine, exact: true }).first().click()

          const section = page
            .getByRole('region')
            .filter({ has: page.getByRole('heading', { name: 'Core words' }) })
          const labels = await section.locator('[data-tile-id]').evaluateAll((tiles) =>
            tiles.map((tile) => {
              const el = tile as HTMLElement
              const accessible = el.getAttribute('aria-label') ?? ''
              return {
                word: accessible.replace(/, Core$/, ''),
                width: el.getBoundingClientRect().width,
              }
            }),
          )

          expect(labels.map((label) => label.word)).toEqual(PROTECTED_CORE_LABELS)
          for (const label of labels) {
            expect(label.width, `${label.word} must be visible`).toBeGreaterThan(0)
          }

          // The fringe never contains protected vocabulary.
          const fringeIds = await fringeSection(page)
            .locator('[data-tile-id]')
            .evaluateAll((tiles) => tiles.map((tile) => (tile as HTMLElement).dataset.tileId))
          for (const protectedId of ['no', 'stop', 'help', 'hurts', 'break', 'yes', 'more', 'finished']) {
            expect(fringeIds).not.toContain(protectedId)
          }
        }
      }
    }
    await expectNoHorizontalOverflow(page)
  })

  test('tap target sizes meet the accessibility floor', async ({ page }) => {
    const tooSmall: string[] = []
    for (const button of await page.locator('button:visible').all()) {
      const box = await button.boundingBox()
      if (!box) continue
      if (box.height < 44 || box.width < 44) {
        tooSmall.push(`${await button.getAttribute('aria-label') ?? await button.textContent()}: ${box.width}x${box.height}`)
      }
    }
    expect(tooSmall, `controls below 44px: ${tooSmall.join(', ')}`).toEqual([])

    const coreSection = page
      .getByRole('region')
      .filter({ has: page.getByRole('heading', { name: 'Core words' }) })
    for (const tile of await coreSection.locator('[data-tile-id]').all()) {
      const box = await tile.boundingBox()
      expect(box?.height, 'primary AAC tiles stay 64px+').toBeGreaterThanOrEqual(64)
    }
  })

  test('suggestion dock is unmistakably secondary', async ({ page }) => {
    const dock = page.getByLabel('Optional local suggestions')
    await expect(dock.getByText(/Instant phrases for this routine/)).toBeVisible()
    await expect(dock.getByText('Suggestions')).toBeVisible()

    const dockBox = await dock.boundingBox()
    const boardBox = await fringeSection(page).first().boundingBox()
    expect(dockBox && boardBox ? dockBox.y : -1).toBeGreaterThan(boardBox?.y ?? Number.MAX_SAFE_INTEGER)
  })

  test('density separates age from access needs', async ({ page }) => {
    await setDensity(page, 'Large')
    const largeCount = await fringeSection(page).locator('[data-tile-id]').count()
    await setDensity(page, 'More words')
    const moreCount = await fringeSection(page).locator('[data-tile-id]').count()
    expect(moreCount).toBeGreaterThan(largeCount)
  })
})
