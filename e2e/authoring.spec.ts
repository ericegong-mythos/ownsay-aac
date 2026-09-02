import { expect, test } from '@playwright/test'
import { completeOnboarding, installSpeechStub } from './helpers'

declare global {
  interface Window {
    __speech?: { speakTexts: string[]; cancelCount: number }
  }
}

test.describe('child authorship and deliberate speech', () => {
  let spoken: () => Promise<string[]>

  test.beforeEach(async ({ page }) => {
    await installSpeechStub(page)
    spoken = () => page.evaluate(() => (window.__speech as { speakTexts: string[] }).speakTexts)
    await page.goto('/', { waitUntil: 'networkidle' })
    await completeOnboarding(page)
  })

  test('authoring a message never speaks; Speak speaks exactly the authored words', async ({ page }) => {
    await page.getByRole('button', { name: 'Help, Core' }).click()
    await page.getByRole('button', { name: 'Want', exact: true }).click()

    const rail = page.getByRole('region', { name: 'Authorship rail' })
    await expect(rail.getByRole('button', { name: /Remove Help, Core/ })).toBeVisible()
    await expect(rail.getByRole('button', { name: /Remove Want, Board/ })).toBeVisible()
    expect(await spoken()).toEqual([])

    // Suggestion tap appends without speaking.
    const dock = page.getByLabel('Optional local suggestions')
    await dock.getByRole('button').first().click()
    expect(await spoken()).toEqual([])

    // Live region reflects authored change politely.
    await expect(page.locator('[aria-live="polite"]')).toContainText(/added|Suggestion added/i)

    // Deliberate Speak press is the only path to speech.
    await page.getByRole('button', { name: 'Speak', exact: true }).click()
    const texts = await spoken()
    expect(texts.length).toBe(1)
    expect(texts[0]?.startsWith('Help Want')).toBe(true)

    // While speaking, Speak disables and Stop enables.
    await expect(page.getByRole('button', { name: 'Speak', exact: true })).toBeDisabled()
    await page.getByRole('button', { name: 'Stop speaking' }).click()
    expect(await page.evaluate(() => window.__speech?.cancelCount ?? 0)).toBeGreaterThanOrEqual(1)
    await expect(page.locator('[aria-live="polite"]')).toHaveText('Speech stopped')

    // A second deliberate press may speak again after stop.
    await expect(page.getByRole('button', { name: 'Speak', exact: true })).toBeEnabled()
  })

  test('delete last, clear and chip removal edit only the rail', async ({ page }) => {
    await page.getByRole('button', { name: 'Yes, Core' }).click()
    await page.getByRole('button', { name: 'More, Core' }).click()
    await page.getByRole('button', { name: 'Want', exact: true }).click()

    const rail = page.getByRole('region', { name: 'Authorship rail' })
    await expect(rail.getByRole('button', { name: /Remove / })).toHaveCount(3)

    await page.getByRole('button', { name: 'Delete last' }).click()
    await expect(rail.getByRole('button', { name: /Remove Want, Board/ })).toBeHidden()

    await rail.getByRole('button', { name: /Remove Yes, Core/ }).click()
    await expect(rail.getByRole('button', { name: /Remove Yes, Core/ })).toBeHidden()

    await page.getByRole('button', { name: 'Clear' }).click()
    await expect(
      page.getByRole('region', { name: 'Authorship rail' }).getByText('Tap a word. Then press Speak.'),
    ).toBeVisible()
    await expect(page.getByRole('button', { name: 'Speak', exact: true })).toBeDisabled()
  })

  test('empty state copy matches the design system', async ({ page }) => {
    await expect(
      page.getByRole('region', { name: 'Authorship rail' }).getByText('Tap a word. Then press Speak.'),
    ).toBeVisible()
  })

  test('keyboard operation authors a word with visible focus ring', async ({ page }) => {
    await page.keyboard.press('Tab')
    await expect
      .poll(() =>
        page.evaluate(() => {
          const el = document.activeElement as HTMLElement | null
          return el ? getComputedStyle(el).outlineWidth : ''
        }),
      )
      .not.toBe('0px')

    // Focus the Help tile directly and operate it with Enter.
    await page.getByRole('button', { name: 'Help, Core' }).focus()
    await page.keyboard.press('Enter')
    const rail = page.getByRole('region', { name: 'Authorship rail' })
    await expect(rail.getByRole('button', { name: /Remove Help, Core/ })).toBeVisible()
  })

  test('landmarks and live region exist', async ({ page }) => {
    await expect(page.locator('header')).toBeVisible()
    await expect(page.getByRole('navigation', { name: 'Routine' })).toBeVisible()
    await expect(page.locator('main')).toBeVisible()
    await expect(page.locator('[aria-live="polite"]')).toBeAttached()
    await expect(page.getByLabel('Optional local suggestions')).toBeVisible()
  })

  test('reduced motion is honored: no animation runs longer than a frame', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.getByRole('button', { name: 'Food', exact: true }).click()
    await page.getByRole('button', { name: 'No, Core' }).click()

    const maxDuration = await page.evaluate(() => {
      const parseDurations = (value: string) =>
        value.split(',').map((part) => parseFloat(part) || 0)
      let max = 0
      for (const el of document.querySelectorAll<HTMLElement>('button')) {
        const style = getComputedStyle(el)
        for (const value of [style.transitionDuration, style.animationDuration]) {
          for (const duration of parseDurations(value)) {
            max = Math.max(max, duration)
          }
        }
      }
      for (const animation of document.getAnimations()) {
        const timing = animation.effect?.getTiming()
        max = Math.max(max, Number(timing?.duration ?? 0))
      }
      return max
    })
    expect(maxDuration, 'reduced motion must collapse all animation to ~0ms').toBeLessThanOrEqual(2)
  })
})
