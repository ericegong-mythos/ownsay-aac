import { expect, test } from '@playwright/test'
import { closeCarerDrawer, completeOnboarding, openCarerDrawer } from './helpers'

test.describe('local child profiles', () => {
  test('first-run setup creates one child-specific local profile without an account', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' })
    await expect(page.getByText('Who is this board for?')).toBeVisible()
    // Fictional examples lead; the custom path remains deliberate.
    await expect(page.getByRole('button', { name: /Alex/ })).toBeVisible()
    await page.getByRole('button', { name: 'Set up a different way' }).click()
    // Continue stays blocked until an age band is chosen.
    await page.getByLabel(/Nickname/).fill('Maya')
    await expect(page.getByRole('button', { name: 'Make this board ready' })).toBeDisabled()
    await page.getByRole('button', { name: /^7–9/ }).click()
    await page.getByRole('button', { name: 'Make this board ready' }).click()

    await expect(page.locator('[class*="childTag"]')).toHaveText('Maya')
    // No account or backend: the deterministic board is already usable offline-local.
    const section = page
      .getByRole('region')
      .filter({ has: page.getByRole('heading', { name: 'Core words' }) })
    await expect(section.locator('[data-tile-id]')).toHaveCount(8)
  })

  test('siblings keep isolated boards behind the protected carer switch', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' })
    await completeOnboarding(page, 'Maya')

    // Maya gets her own routine default (scoped to the drawer's choices).
    await openCarerDrawer(page)
    const dialog = page.getByRole('dialog', { name: 'Carer settings' })
    await dialog
      .getByRole('group', { name: 'Words', exact: true })
      .getByRole('button', { name: 'Home', exact: true })
      .click()
    await dialog.getByRole('button', { name: 'Add another child' }).click()
    await page.getByLabel(/New child’s nickname/).fill('Theo')
    await page
      .getByRole('group', { name: /New child’s age group/ })
      .getByRole('button', { name: '10–12' })
      .click()
    await dialog.getByRole('button', { name: 'Create board' }).click()
    await closeCarerDrawer(page)

    // Theo is now active with his own defaults.
    await expect(page.locator('[class*="childTag"]')).toHaveText('Theo')
    await expect(
      page.getByRole('navigation', { name: 'Routine' }).getByRole('button', { name: 'Play' }),
    ).toHaveAttribute('aria-pressed', 'true')

    // Switching back to Maya restores HER routine, never Theo's.
    await openCarerDrawer(page)
    await page.getByRole('button', { name: /^Maya/ }).click()
    await expect(page.locator('[class*="childTag"]')).toHaveText('Maya')
    await expect(
      page.getByRole('navigation', { name: 'Routine' }).getByRole('button', { name: 'Home' }),
    ).toHaveAttribute('aria-pressed', 'true')

    // Removing a board requires a deliberate second confirmation.
    await openCarerDrawer(page)
    await page.getByRole('button', { name: 'Remove this board' }).click()
    await page.getByRole('button', { name: /Really remove Maya’s board\?/ }).click()
    await expect(page.locator('[class*="childTag"]')).toHaveText('Theo')
    await closeCarerDrawer(page)
  })

  test('extra words join the anytime zone without touching the protected core', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' })
    await completeOnboarding(page)
    await openCarerDrawer(page)
    await page.getByLabel('New extra word').fill('Grandma')
    await page.getByRole('button', { name: 'Add word' }).click()
    await closeCarerDrawer(page)

    const anytime = page.getByRole('region', { name: /Anytime words/ })
    await expect(anytime.getByRole('button', { name: 'Grandma' })).toBeVisible()

    // Core count untouched at eight, in order.
    const section = page
      .getByRole('region')
      .filter({ has: page.getByRole('heading', { name: 'Core words' }) })
    await expect(section.locator('[data-tile-id]')).toHaveCount(8)

    // Tapping it authors a token and never speaks.
    await anytime.getByRole('button', { name: 'Grandma' }).click()
    const rail = page.getByRole('region', { name: 'Authorship rail' })
    await expect(rail.getByRole('button', { name: /Remove Grandma, Board/ })).toBeVisible()
  })

  test('voice selection prefers en-GB options and persists per profile', async ({ page }) => {
    // Headless engines ship no voices; inject a stable set for this test only.
    await page.addInitScript(() => {
      let voiceReads = 0
      const voices = [
        { voiceURI: 'v-en-gb-daniel', name: 'Daniel', lang: 'en-GB', default: false, localService: true },
        { voiceURI: 'v-en-gb-sonia', name: 'Sonia', lang: 'en-GB', default: true, localService: true },
        { voiceURI: 'v-en-gb-remote', name: 'Remote', lang: 'en-GB', default: false, localService: false },
      ]
      Object.defineProperty(window, 'speechSynthesis', {
        // Keep the test double API-complete: profile/data boundaries
        // deliberately cancel any active utterance before changing child.
        value: {
          // Reproduce a common delayed-list lifecycle without relying on an
          // event: empty during initial render, populated before the effect.
          getVoices: () => (++voiceReads === 1 ? [] : voices),
          addEventListener: () => {},
          cancel: () => {},
          speak: () => {},
        },
        configurable: true,
      })
    })
    await page.goto('/', { waitUntil: 'networkidle' })
    await completeOnboarding(page)
    await openCarerDrawer(page)
    const dialog = page.getByRole('dialog', { name: 'Carer settings' })
    const select = dialog.getByLabel(/^Spoken voice for/)
    // The post-subscription refresh finds the late local list, and the remote
    // entry remains absent.
    await expect(select.getByRole('option', { name: /Remote/ })).toHaveCount(0)
    await select.selectOption({ label: 'Sonia · on-device (en-GB)' })
    await expect(select).toHaveValue('v-en-gb-sonia')
    await closeCarerDrawer(page)
    await page.reload({ waitUntil: 'networkidle' })
    await openCarerDrawer(page)
    await expect(page.getByLabel(/^Spoken voice for/)).toHaveValue('v-en-gb-sonia')
    await closeCarerDrawer(page)
  })
})
