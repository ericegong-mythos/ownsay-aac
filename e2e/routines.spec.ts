import { expect, test } from '@playwright/test'
import { completeOnboarding, installSpeechStub } from './helpers'

declare global {
  interface Window {
    __speech?: { speakTexts: string[]; cancelCount: number }
  }
}

const ROUTINES = ['Play', 'Food', 'School', 'Home', 'Outside'] as const

async function contextTileIds(page: import('@playwright/test').Page): Promise<string[]> {
  return page
    .getByRole('region')
    .filter({ has: page.getByRole('heading', { name: /Right now/ }) })
    .locator('[data-tile-id]')
    .evaluateAll((tiles) => tiles.map((tile) => (tile as HTMLElement).dataset.tileId ?? ''))
}

async function anyTimeTileIds(page: import('@playwright/test').Page): Promise<string[]> {
  return page
    .getByRole('region')
    .filter({ has: page.getByRole('heading', { name: 'Anytime words' }) })
    .locator('[data-tile-id]')
    .evaluateAll((tiles) => tiles.map((tile) => (tile as HTMLElement).dataset.tileId ?? ''))
}

async function suggestionLabels(page: import('@playwright/test').Page): Promise<string[]> {
  const dock = page.getByLabel('Optional local suggestions')
  await expect(dock.getByRole('button')).toHaveCount(4)
  return dock.getByRole('button').allTextContents()
}

test.describe('routine worlds drive the whole board', () => {
  let spoken: () => Promise<string[]>

  test.beforeEach(async ({ page }) => {
    await installSpeechStub(page)
    spoken = () => page.evaluate(() => (window.__speech as { speakTexts: string[] }).speakTexts)
    await page.goto('/', { waitUntil: 'networkidle' })
    await completeOnboarding(page)
  })

  test('every routine materially changes right-now words, suggestions and selected state', async ({ page }) => {
    test.setTimeout(60_000)
    const nav = page.getByRole('navigation', { name: 'Routine' })

    const snapshots = new Map<
      string,
      { context: string[]; anytime: string[]; suggestions: string[] }
    >()

    for (const routine of ROUTINES) {
      await nav.getByRole('button', { name: routine }).click()
      await expect(nav.getByRole('button', { name: routine })).toHaveAttribute('aria-pressed', 'true')

      // Contextual heading names the world.
      await expect(page.getByRole('heading', { name: new RegExp(`Right now · `) })).toBeVisible()

      const context = await contextTileIds(page)
      const anytime = await anyTimeTileIds(page)
      const suggestions = await suggestionLabels(page)

      expect(context.length, `${routine}: contextual slots present`).toBeGreaterThanOrEqual(4)
      expect(new Set(context).size, `${routine}: contextual tiles unique`).toBe(context.length)
      expect(suggestions, `${routine}: four starters`).toHaveLength(4)
      expect(new Set(suggestions).size, `${routine}: starters distinct`).toBe(4)

      snapshots.set(routine, { context, anytime, suggestions })
    }

    // Material difference between every pair of worlds.
    for (let a = 0; a < ROUTINES.length; a += 1) {
      for (let b = a + 1; b < ROUTINES.length; b += 1) {
        const worldA = snapshots.get(ROUTINES[a])!
        const worldB = snapshots.get(ROUTINES[b])!
        const sharedContext = worldA.context.filter((id) => worldB.context.includes(id))
        expect(
          sharedContext.length,
          `${ROUTINES[a]} vs ${ROUTINES[b]} share too many context words`,
        ).toBeLessThan(Math.min(worldA.context.length, worldB.context.length))
        const sameSuggestions = worldA.suggestions.filter((label) => worldB.suggestions.includes(label))
        expect(
          sameSuggestions.length,
          `${ROUTINES[a]} vs ${ROUTINES[b]} starters must differ`,
        ).toBeLessThan(4)
      }
    }

    expect(await spoken()).toEqual([])
  })

  test('authored rail survives a routine change and nothing speaks', async ({ page }) => {
    const nav = page.getByRole('navigation', { name: 'Routine' })
    await page.getByRole('button', { name: 'Help, Core' }).click()
    await page.getByRole('button', { name: 'Want', exact: true }).first().click()

    await nav.getByRole('button', { name: 'Food' }).click()
    const rail = page.getByRole('region', { name: 'Authorship rail' })
    await expect(rail.getByRole('button', { name: /Remove Help, Core/ })).toBeVisible()
    await expect(rail.getByRole('button', { name: /Remove Want, Board/ })).toBeVisible()

    // Routine change must not append or speak.
    expect(await rail.getByRole('button', { name: /Remove / }).count()).toBe(2)
    expect(await spoken()).toEqual([])

    // Speak still works after the swap, speaking only authored words.
    await page.getByRole('button', { name: 'Speak', exact: true }).click()
    const texts = await spoken()
    expect(texts).toHaveLength(1)
    expect(texts[0]?.startsWith('Help Want')).toBe(true)
    await page.getByRole('button', { name: 'Stop speaking' }).click()
  })

  test('selected routine survives reload', async ({ page }) => {
    const nav = page.getByRole('navigation', { name: 'Routine' })
    await nav.getByRole('button', { name: 'Outside' }).click()
    await expect(nav.getByRole('button', { name: 'Outside' })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByRole('heading', { name: /Right now/ })).toBeVisible()
    await page.waitForTimeout(300)

    await page.reload({ waitUntil: 'networkidle' })
    await expect(page.getByRole('navigation', { name: 'Routine' }).getByRole('button', { name: 'Outside' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await expect(
      page
        .getByRole('region')
        .filter({ has: page.getByRole('heading', { name: /Right now/ }) })
        .getByRole('button', { name: 'Park' }),
    ).toBeVisible()
  })
})
