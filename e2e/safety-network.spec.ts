import { expect, test, type Locator, type Page } from '@playwright/test'
import {
  closeCarerDrawer,
  completeOnboarding,
  installStubIntelligence,
  openCarerDrawer,
} from './helpers'

const MODEL_PATTERN = /(huggingface\.co|hf\.co|\.gguf|mlc-ai|mlc\.ai|raw\.githubusercontent)/i

test.beforeEach(async ({ page }) => {
  await page.goto('/', { waitUntil: 'networkidle' })
  await completeOnboarding(page)
})

test.describe('model safety boundary', () => {
  test('normal load and deterministic use make zero model or cross-origin requests', async ({ page }) => {
    const requests: string[] = []
    page.on('request', (request) => requests.push(request.url()))

    // Exercise the deterministic product: authoring, routine, suggestion.
    await page.getByRole('button', { name: 'No, Core' }).click()
    await page.getByRole('button', { name: 'School', exact: true }).click()
    const dock = page.getByLabel('Optional local suggestions')
    await dock.getByRole('button').first().click()
    await page.getByRole('button', { name: 'Delete last' }).click()
    await page.getByRole('button', { name: 'Clear' }).click()

    const base = test.info().project.use.baseURL ?? ''
    for (const url of requests) {
      expect(url.startsWith(base), `cross-origin request: ${url}`).toBe(true)
      expect(url, `model artefact request during normal use: ${url}`).not.toMatch(MODEL_PATTERN)
    }
    expect(requests.some((url) => /assets\/webllm/i.test(url)), 'WebLLM bundle must stay unloaded').toBe(false)
  })

  test('no research framing remains in the consumer UI', async ({ page }) => {
    const body = await page.locator('body').innerText()
    expect(body).not.toMatch(/\bAI\b/)
    expect(body).not.toContain('Research prototype')
    expect(body).not.toContain('not a clinical device')
    expect(body).not.toContain('Synthetic demo')
    expect(body).not.toContain('Demo profile')
  })

  test.describe('with the stub intelligence runtime', () => {
    test.use({ serviceWorkers: 'block' })

    test('setup requires the explicit carer confirmation before any model code is fetched', async ({ page }) => {
      await installStubIntelligence(page, 'ready')
      const requests: string[] = []
      page.on('request', (request) => requests.push(request.url()))

      const dialog = await intelligenceDialog(page)
      expect(requests.some((url) => /assets\/webllm/i.test(url)), 'no model code before confirmation').toBe(false)

      await dialog.getByRole('button', { name: 'Download on this device' }).click()
      await expect(dialog.getByText('On and running on this device.')).toBeVisible({ timeout: 30_000 })
      await closeCarerDrawer(page)
      await expect(panelLocator(page).getByText('Ready')).toBeVisible()
      expect(requests.some((url) => /assets\/webllm/i.test(url))).toBe(true)
    })

    test('the first generation after Ready is labelled as chosen on this device and survives refresh', async ({
      page,
    }) => {
      const requests: string[] = []
      page.on('request', (request) => requests.push(request.url()))
      await installStubIntelligence(page, 'ready')

      const panel = panelLocator(page)
      await activate(page)

      const dock = page.getByLabel('Optional local suggestions')
      // The exact gate the stale-interrupt bug used to fail.
      await expect(dock.getByText(/OwnSay phrases are chosen on this device/)).toBeVisible({ timeout: 30_000 })
      await expect(dock.getByRole('button', { name: /\(OwnSay phrase\)/ }).first()).toBeVisible()

      // Repeated refresh while ready keeps working — routine change re-runs
      // generation through the same engine with no stale-interrupt decay.
      await page.getByRole('navigation', { name: 'Routine' }).getByRole('button', { name: 'Food' }).click()
      await expect(dock.getByText(/OwnSay phrases are chosen on this device/)).toBeVisible({ timeout: 20_000 })
      await expect(dock.getByRole('button', { name: /\(OwnSay phrase\)/ }).first()).toBeVisible()

      for (const url of requests) {
        expect(url.startsWith(test.info().project.use.baseURL ?? ''), `cross-origin: ${url}`).toBe(true)
        expect(url, `real model artefact request: ${url}`).not.toMatch(MODEL_PATTERN)
      }

      // Turning off returns to instant phrases honestly.
      const dialog = await intelligenceDialog(page, false)
      await dialog.getByRole('button', { name: 'Turn off' }).click()
      await closeCarerDrawer(page)
      await expect(panel.getByText('Not set up')).toBeVisible()
      await expect(dock.getByText(/Instant phrases for this routine/)).toBeVisible()
    })

    test('reload remembers setup as paused without loading model code automatically', async ({ page }) => {
      await installStubIntelligence(page, 'ready')
      await activate(page)
      // Activation also triggers the first bounded ranking round. Let every
      // request owned by that deliberate action settle before starting the
      // reload ledger, otherwise a late request from setup is misattributed
      // to the ordinary reload we are trying to measure.
      await expect(
        page.getByLabel('Optional local suggestions').getByText(/OwnSay phrases are chosen on this device/),
      ).toBeVisible({ timeout: 30_000 })

      const requestsAfterReload: string[] = []
      page.on('request', (request) => requestsAfterReload.push(request.url()))
      await page.reload({ waitUntil: 'networkidle' })

      await expect(panelLocator(page).getByText('Paused', { exact: true })).toBeVisible()
      const dialog = await intelligenceDialog(page, false)
      await expect(dialog.getByRole('button', { name: 'Wake OwnSay Intelligence' })).toBeVisible()
      await closeCarerDrawer(page)
      expect(
        requestsAfterReload.filter((url) => /assets\/webllm/i.test(url)),
        'a normal reload must not fetch or start the model runtime',
      ).toEqual([])
    })

    test('generation failure enters a calm degraded state that never claims on-device output', async ({ page }) => {
      await installStubIntelligence(page, 'fail')

      const dialog = await intelligenceDialog(page)
      await dialog.getByRole('button', { name: 'Download on this device' }).click()
      await expect(dialog.getByText(/could not finish just now/)).toBeVisible({ timeout: 30_000 })
      await closeCarerDrawer(page)
      const panel = panelLocator(page)
      await expect(panel.getByText('Trouble')).toBeVisible()
      await expect(panel.getByText(/could not finish just now/)).toBeVisible()

      const dock = page.getByLabel('Optional local suggestions')
      await expect(dock.getByText(/Instant phrases for this routine/)).toBeVisible()
      await expect(dock.getByText(/chosen on this device/)).toHaveCount(0)

      // The board itself is untouched by the failure.
      await page.getByRole('button', { name: 'Yes, Core' }).click()
      await expect(
        page.getByRole('region', { name: 'Authorship rail' }).getByRole('button', { name: /Remove Yes, Core/ }),
      ).toBeVisible()

      // Recoverable: Try again re-runs generation through the same engine.
      const retryDialog = await intelligenceDialog(page, false)
      await retryDialog.getByRole('button', { name: 'Try again' }).click()
      await closeCarerDrawer(page)
      await expect(panel.getByText('Ready').or(panel.getByText('Trouble'))).toBeVisible({ timeout: 30_000 })
    })

    test('unsupported devices get an honest explanation and keep instant phrases', async ({ page }) => {
      // Remove WebGPU explicitly so the honest unsupported-hardware path runs
      // identically on every engine regardless of built-in GPU availability.
      await page.evaluate(() => {
        Object.defineProperty(navigator, 'gpu', { value: undefined, configurable: true })
      })
      const dialog = await intelligenceDialog(page)
      await dialog.getByRole('button', { name: 'Download on this device' }).click()
      await expect(dialog.getByText(/does not support the optional helper/)).toBeVisible({ timeout: 30_000 })
      await closeCarerDrawer(page)
      const panel = panelLocator(page)
      await expect(panel.getByText('Not on this tablet')).toBeVisible()
      await expect(panel.getByText(/does not support the technology/)).toBeVisible()

      // The board keeps working exactly as before.
      const dock = page.getByLabel('Optional local suggestions')
      await expect(dock.getByText(/Instant phrases for this routine/)).toBeVisible()
      await dock.getByRole('button').first().click()
      const rail = page.getByRole('region', { name: 'Authorship rail' })
      await expect(rail.getByRole('button', { name: /Remove / })).toHaveCount(3)
      await expect(page.getByRole('button', { name: 'Speak', exact: true })).toBeEnabled()
    })
  })
})

function panelLocator(page: Page): Locator {
  return page.getByRole('complementary', { name: 'OwnSay Intelligence' })
}

async function intelligenceDialog(page: Page, expectDownloadWarning = true): Promise<Locator> {
  await openCarerDrawer(page)
  const dialog = page.getByRole('dialog', { name: 'Carer settings' })
  if (expectDownloadWarning) await expect(dialog.getByText(/about 200 MB/)).toBeVisible()
  return dialog
}

async function activate(page: Page): Promise<void> {
  const dialog = await intelligenceDialog(page)
  await dialog.getByRole('button', { name: 'Download on this device' }).click()
  await expect(dialog.getByText('On and running on this device.')).toBeVisible({ timeout: 30_000 })
  await closeCarerDrawer(page)
  await expect(panelLocator(page).getByText('Ready')).toBeVisible()
}
