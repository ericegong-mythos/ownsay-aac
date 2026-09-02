import { expect, test, type Page } from '@playwright/test'
import { PROTECTED_CORE_LABELS, closeCarerDrawer, expectNoHorizontalOverflow, openCarerDrawer } from './helpers'

async function chooseDemoProfile(page: Page, name: 'Alex' | 'Sam'): Promise<void> {
  await page.goto('/', { waitUntil: 'networkidle' })
  await expect(page.getByText('Who is this board for?')).toBeVisible()
  await page.getByRole('button', { name: new RegExp(`^${name}`) }).click()
  await expect(page.getByTestId('welcome-celebration')).toContainText(`Hello ${name}`)
}

async function coreTileIds(page: Page): Promise<string[]> {
  const section = page
    .getByRole('region')
    .filter({ has: page.getByRole('heading', { name: 'Core words' }) })
  return section.locator('[data-tile-id]').evaluateAll((tiles) =>
    tiles.map((tile) => (tile as HTMLElement).dataset.tileId ?? ''),
  )
}

test.describe('fictional demo profiles', () => {
  test('fresh install offers the two starters and lands on the chosen child with a usable board beneath the welcome', async ({
    page,
  }) => {
    await chooseDemoProfile(page, 'Alex')

    // Both starter boards exist locally; the chosen one is active.
    await openCarerDrawer(page)
    const dialog = page.getByRole('dialog', { name: 'Carer settings' })
    await expect(dialog.getByRole('button', { name: /^Alex/ })).toBeVisible()
    await expect(dialog.getByRole('button', { name: /^Sam/ })).toBeVisible()
    await closeCarerDrawer(page)
    await expect(page.locator('[class*="childTag"]')).toHaveText('Alex')

    // The protected core works while the celebration is still up.
    await page.getByRole('button', { name: 'More, Core' }).click()
    const rail = page.getByRole('region', { name: 'Authorship rail' })
    await expect(rail.getByRole('button', { name: /Remove More, Core/ })).toBeVisible()

    // The celebration leaves by itself and never speaks or appends words.
    await expect(page.getByTestId('welcome-celebration')).toBeHidden({ timeout: 4000 })
    expect(await rail.getByRole('button', { name: /^Remove/ }).count()).toBe(1)

    // Switching to the other example is deliberate and isolated.
    await page.getByRole('button', { name: 'Help, Core' }).click()
    await openCarerDrawer(page)
    await page.getByRole('dialog', { name: 'Carer settings' }).getByRole('button', { name: /^Sam/ }).click()
    await expect(page.getByTestId('welcome-celebration')).toContainText('Hello Sam')
    await expect(page.locator('[class*="childTag"]')).toHaveText('Sam')
    // Alex's in-progress message never leaks into Sam's empty rail.
    await expect(page.getByRole('region', { name: 'Authorship rail' })).toContainText(
      'Tap a word. Then press Speak.',
    )
  })

  test('starter vocabulary is distinct, visible and editable without touching the core', async ({ page }) => {
    await chooseDemoProfile(page, 'Sam')
    await expect(page.getByTestId('welcome-celebration')).toBeHidden({ timeout: 4000 })

    // Sam's favourites are on his board; Alex's personal words are not.
    const anytime = page.getByRole('region', { name: /Anytime words/ })
    await expect(anytime.getByRole('button', { name: 'Not that' })).toBeVisible()
    await expect(page.locator('[data-tile-id="extra:sam-toast"]')).toHaveCount(1)
    await expect(page.locator('[data-tile-id="extra:alex-building-blocks"]')).toHaveCount(0)
    expect(await coreTileIds(page)).toEqual([
      'no',
      'stop',
      'help',
      'hurts',
      'break',
      'yes',
      'more',
      'finished',
    ])
  })

  test('restore adds only missing starter boards and never overwrites existing profiles', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: 'Set up a different way' }).click()
    await page.getByLabel(/Nickname/).fill('Cousin Ada')
    await page.getByRole('group', { name: 'Age group' }).getByRole('button', { name: /^7–9\b/ }).click()
    await page.getByRole('button', { name: 'Make this board ready' }).click()
    await expect(page.locator('[class*="childTag"]')).toHaveText('Cousin Ada')

    await openCarerDrawer(page)
    await page.getByRole('button', { name: 'Restore fictional demo boards' }).click()
    await expect(
      page.getByRole('dialog', { name: 'Carer settings' }).getByRole('button', { name: /^Alex/ }),
    ).toBeVisible()
    await closeCarerDrawer(page)

    // Second press is a no-op; Ada's board is untouched and stays active.
    await openCarerDrawer(page)
    await page.getByRole('button', { name: 'Restore fictional demo boards' }).click()
    await expect(page.locator('[aria-live="polite"]')).toContainText('already here')
    await expect(page.locator('[class*="childTag"]')).toHaveText('Cousin Ada')
    await closeCarerDrawer(page)
  })

  test('a carer can disable the welcome celebration per child', async ({ page }) => {
    await chooseDemoProfile(page, 'Alex')
    await expect(page.getByTestId('welcome-celebration')).toBeHidden({ timeout: 4000 })

    await openCarerDrawer(page)
    const dialog = page.getByRole('dialog', { name: 'Carer settings' })
    await dialog.getByRole('button', { name: 'Celebration off' }).click()
    await dialog.getByRole('button', { name: /^Sam/ }).click()
    await expect(page.getByTestId('welcome-celebration')).toContainText('Hello Sam')
    await expect(page.getByTestId('welcome-celebration')).toBeHidden({ timeout: 4000 })

    await openCarerDrawer(page)
    await page.getByRole('dialog', { name: 'Carer settings' }).getByRole('button', { name: /^Alex/ }).click()
    // Alex's celebration was switched off: no overlay appears.
    await expect(page.getByTestId('welcome-celebration')).toHaveCount(0)
    await expect(page.locator('[class*="childTag"]')).toHaveText('Alex')

    // Reload keeps the choice.
    await page.reload({ waitUntil: 'networkidle' })
    await expect(page.getByTestId('welcome-celebration')).toHaveCount(0)
    await openCarerDrawer(page)
    await expect(
      page
        .getByRole('dialog', { name: 'Carer settings' })
        .getByRole('button', { name: 'Celebration off' }),
    ).toHaveAttribute('data-selected', 'true')
    await closeCarerDrawer(page)
  })

  test('1024×600 landscape keeps header, worlds, voice canvas, Speak and all eight core words in view without overflow', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1024, height: 600 })
    await chooseDemoProfile(page, 'Sam')
    await expect(page.getByTestId('welcome-celebration')).toBeHidden({ timeout: 4000 })

    await expectNoHorizontalOverflow(page)

    // All eight protected controls are rendered at meaningful size.
    const section = page
      .getByRole('region')
      .filter({ has: page.getByRole('heading', { name: 'Core words' }) })
    const tiles = section.locator('[data-tile-id]')
    await expect(tiles).toHaveCount(8)
    const labels = await tiles.evaluateAll((nodes) =>
      nodes.map((node) => (node as HTMLElement).getAttribute('aria-label') ?? ''),
    )
    expect(labels).toEqual(PROTECTED_CORE_LABELS.map((label) => `${label}, Core`))

    // Speak action is on screen without scrolling.
    const speak = page.getByRole('button', { name: 'Speak', exact: true })
    const speakBox = await speak.boundingBox()
    expect(speakBox && speakBox.y + speakBox.height <= 600, 'Speak must sit inside the first screen').toBe(true)

    // Every visible control meets the 44px floor.
    const tooSmall: string[] = []
    for (const button of await page.locator('button:visible').all()) {
      const box = await button.boundingBox()
      if (!box) continue
      if (box.height < 44 || box.width < 44) {
        tooSmall.push(`${await button.getAttribute('aria-label') ?? await button.textContent()}: ${Math.round(box.width)}x${Math.round(box.height)}`)
      }
    }
    expect(tooSmall, `controls below 44px: ${tooSmall.join(', ')}`).toEqual([])

    // All eight core tiles are within the first viewport height as well.
    const boxes = await tiles.evaluateAll((nodes) =>
      nodes.map((node) => {
        const rect = (node as HTMLElement).getBoundingClientRect()
        return rect.top + rect.height <= 600 + 1
      }),
    )
    expect(boxes.every(Boolean), 'all core tiles must fit above the fold at 1024×600').toBe(true)
  })

  test('600×1024 portrait keeps the fixed 4×2 core grid and no horizontal overflow', async ({ page }) => {
    await page.setViewportSize({ width: 600, height: 1024 })
    await chooseDemoProfile(page, 'Alex')
    await expect(page.getByTestId('welcome-celebration')).toBeHidden({ timeout: 4000 })

    await expectNoHorizontalOverflow(page)
    const columns = await page
      .getByRole('region')
      .filter({ has: page.getByRole('heading', { name: 'Core words' }) })
      .locator('[data-tile-id]')
      .evaluateAll((nodes) => {
        const rows = new Set<number>()
        let previousTop = Number.NaN
        for (const node of nodes) {
          const rect = (node as HTMLElement).getBoundingClientRect()
          if (Number.isNaN(previousTop) || Math.abs(rect.top - previousTop) > 8) rows.add(rows.size)
          previousTop = rect.top
        }
        return { count: nodes.length, rowCount: rows.size }
      })
    expect(columns.count).toBe(8)
    expect(columns.rowCount).toBe(2)
  })

  test('reduced motion replaces the celebration with a calm static hello and no confetti', async ({
    browser,
  }) => {
    const context = await browser.newContext({
      reducedMotion: 'reduce',
      viewport: { width: 1280, height: 800 },
    })
    const page = await context.newPage()
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: /^Alex/ }).click()
    const overlay = page.getByTestId('welcome-celebration')
    await expect(overlay).toBeVisible()
    expect(await overlay.locator('i').count()).toBe(0)
    await expect(overlay).toContainText('Hello Alex')
    // The static version also leaves promptly.
    await expect(overlay).toBeHidden({ timeout: 2500 })
    await context.close()
  })
})
