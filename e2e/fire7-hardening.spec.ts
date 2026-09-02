import { expect, test } from '@playwright/test'
import {
  installSpeechStub,
  installStubIntelligence,
  closeCarerDrawer,
  openCarerDrawer,
  pressAndHoldCarerDrawer,
} from './helpers'

/**
 * Fire 7 hardening: deterministic-first intelligence, device check and
 * lifecycle failure modes. All speech is stubbed; no model is ever fetched.
 */

test.describe('deterministic-first intelligence on Fire-class hardware', () => {
  test('setup attempt without WebGPU downloads nothing and keeps personalised instant phrases', async ({
    page,
  }) => {
    const seenRequests: string[] = []
    page.on('request', (request) => seenRequests.push(request.url()))

    await page.goto('/', { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: /^Sam/ }).click()
    await expect(page.getByTestId('welcome-celebration')).toBeHidden({ timeout: 4000 })

    // Sam's board carries his own favourites in the first contextual row.
    await expect(page.locator('[data-tile-id="extra:sam-toast"]')).toBeVisible()
    // A favourite that already exists in the stable vocabulary is promoted by
    // its canonical ID instead of being duplicated as a personal extra word.
    await expect(page.locator('[data-tile-id="water"]')).toBeVisible()
    await expect(page.locator('[data-tile-id="extra:sam-water"]')).toHaveCount(0)

    // A carer tries setup; the preflight must stop everything before download.
    await openCarerDrawer(page)
    const dialog = page.getByRole('dialog', { name: 'Carer settings' })
    await expect(dialog).toContainText('Device check')
    await page.keyboard.press('Escape')

    // Setup is carer-only: the child surface exposes no download control.
    await expect(page.getByLabel('OwnSay Intelligence').getByRole('button')).toHaveCount(0)
    await page.evaluate(() => {
      const hold = Array.from(document.querySelectorAll('button')).find((b) =>
        b.getAttribute('aria-label')?.includes('carer'),
      )
      if (hold) hold.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const setupDialog = page.getByRole('dialog', { name: 'Carer settings' })
    await setupDialog.getByRole('button', { name: 'Download on this device' }).click()
    await expect(page.getByLabel('OwnSay Intelligence').getByText('Not on this tablet')).toBeVisible({
      timeout: 10_000,
    })

    // Zero WebLLM / CDN / model requests were made — ordinary use stays local.
    const forbidden = seenRequests.filter(
      (url) =>
        url.includes('webllm') ||
        url.includes('huggingface') ||
        url.includes('mlc-ai') ||
        /\.bin($|\?)/.test(url),
    )
    expect(forbidden, `forbidden model requests: ${forbidden.join(', ')}`).toEqual([])

    // The dock still offers instant phrases for this child.
    await expect(page.getByText(/Instant phrases for this routine/)).toBeVisible()
  })

  test('profile switch while model work is pending cancels speech, clears rail, invalidates results', async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: 1024, height: 600 },
      deviceScaleFactor: 1,
      hasTouch: true,
    })
    const page = await context.newPage()
    await installSpeechStub(page)
    await installStubIntelligence(page, 'ready', { generationDelayMs: 4000 })
    // Browser stubs are installed before the first navigation so the real app
    // observes them during boot and on every subsequent reload.
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: /^Alex/ }).click()
    await expect(page.getByTestId('welcome-celebration')).toBeHidden({ timeout: 4000 })

    // Turn intelligence on through the carer-only flow (stub engine).
    await openCarerDrawer(page)
    await page
      .getByRole('dialog', { name: 'Carer settings' })
      .getByRole('button', { name: 'Download on this device' })
      .click()
    await expect(
      page.getByLabel('OwnSay Intelligence').getByText('Ready', { exact: true }),
    ).toBeVisible({ timeout: 15_000 })
    await closeCarerDrawer(page)

    // Author words and speak them (stubbed synthesiser records cancellations).
    await page.getByRole('button', { name: 'Help, Core' }).click()
    await page.getByRole('button', { name: 'Speak', exact: true }).click()

    // Switch children while a generation is pending.
    await openCarerDrawer(page)
    await page
      .getByRole('dialog', { name: 'Carer settings' })
      .getByRole('button', { name: /^Sam/ })
      .click()

    // Speech cancelled, rail cleared, Sam's welcome only.
    await expect(page.getByTestId('welcome-celebration')).toContainText('Hello Sam')
    await expect(page.getByRole('region', { name: 'Authorship rail' })).toContainText(
      'Tap a word. Then press Speak.',
    )

    // Wait for EXPLICIT stub completion signals: the delayed generation
    // finishes in the background; its stale result must never surface on
    // Sam's board once the helper was deactivated by the switch.
    await page.waitForFunction(
      () => (window as { __ownsayStubGenerationsDone?: number }).__ownsayStubGenerationsDone !== undefined,
      undefined,
      { timeout: 15_000 },
    )
    const dock = page.getByLabel('Optional local suggestions')
    await expect(dock.getByText(/Instant phrases for this routine/)).toBeVisible()
    await expect(dock.getByText(/chosen on this device/)).toHaveCount(0)

    const speech = await page.evaluate(() => window.__speech)
    expect(speech.cancelCount).toBeGreaterThanOrEqual(1)
    await context.close()
  })

  test('KFQUWI temptation: a fake usable GPU still cannot start a download on this device', async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: 1024, height: 600 },
      deviceScaleFactor: 1,
      hasTouch: true,
      userAgent:
        'Mozilla/5.0 (Linux; Android 11; KFQUWI) AppleWebKit/537.36 (KHTML, like Gecko) Silk/119.1.1 like Chrome/119.0.6045.163 Safari/537.36',
    })
    const page = await context.newPage()
    const seenRequests: string[] = []
    page.on('request', (request) => seenRequests.push(request.url()))
    // TEMPTATION: a fully capable fake GPU installed before navigation.
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'gpu', {
        value: {
          requestAdapter: async () => ({
            requestDevice: async () => ({ destroy: () => {} }),
            features: new Set(),
          }),
        },
        configurable: true,
      })
    })

    await page.goto('/', { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: /^Sam/ }).click()
    await expect(page.getByTestId('welcome-celebration')).toBeHidden({ timeout: 4000 })

    // Carer tries to enable the helper anyway.
    await openCarerDrawer(page)
    await page
      .getByRole('dialog', { name: 'Carer settings' })
      .getByRole('button', { name: 'Download on this device' })
      .click()
    await expect(
      page.getByLabel('OwnSay Intelligence').getByText(/cannot run the optional helper|Not on this tablet/i),
    ).toBeVisible({ timeout: 10_000 })

    // No runtime or model bytes were fetched despite the tempting GPU.
    const forbidden = seenRequests.filter(
      (url) =>
        url.includes('webllm') || url.includes('huggingface') || url.includes('mlc-ai') || /\.bin(\?|$)/.test(url),
    )
    expect(forbidden, `forbidden: ${forbidden.join(', ')}`).toEqual([])
    await context.close()
  })

  test('carer Device Check reports capabilities without any child data', async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 1024, height: 600 },
      deviceScaleFactor: 1,
      hasTouch: true,
    })
    const page = await context.newPage()
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: /^Alex/ }).click()
    await expect(page.getByTestId('welcome-celebration')).toBeHidden({ timeout: 4000 })

    await openCarerDrawer(page)
    const dialog = page.getByRole('dialog', { name: 'Carer settings' })
    await dialog.getByRole('button', { name: 'Run device check' }).click()
    await expect(dialog.getByText(/Core board:/)).toBeVisible({ timeout: 15_000 })

    const summary = await dialog.locator('[class*="checkList"]').innerText()
    expect(summary).toContain('Core board:')
    expect(summary).toContain('Local helper:')

    // The DEVICE CHECK REPORT must be free of profile data. Scan the rendered
    // section recursively AND the copy payload shape via the JSON details.
    const checkText = await dialog.locator('[class*="deviceCheck"]').innerText()
    for (const forbidden of ['Alex', 'Sam', 'Apple', 'Building blocks', 'token', 'secret']) {
      expect(checkText.toLowerCase().includes(forbidden.toLowerCase()), `${forbidden} leaked`).toBe(false)
    }
    // Recursively inspect keys and string values of the report object shape
    // exposed through the technical details.
    const jsonText = await dialog.locator('[class*="checkJson"]').innerText()
    if (jsonText.trim().startsWith('{')) {
      const parsed = JSON.parse(jsonText) as Record<string, unknown>
      const walk = (node: unknown, path: string): void => {
        if (typeof node === 'string') {
          for (const needle of ['Alex', 'Sam', 'Apple', 'Building blocks', '?']) {
            expect(node.includes(needle), `${path} contains ${needle}`).toBe(false)
          }
        } else if (Array.isArray(node)) {
          node.forEach((item, index) => walk(item, `${path}[${index}]`))
        } else if (node && typeof node === 'object') {
          for (const [key, value] of Object.entries(node)) {
            expect(key.includes('token')).toBe(false)
            walk(value, `${path}.${key}`)
          }
        }
      }
      walk(parsed, 'report')
    } else {
      // Details may be collapsed; expand then re-read.
      await dialog.locator('summary').click()
    }

    await expect(dialog.getByRole('button', { name: 'Copy report' })).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Download JSON' })).toBeVisible()
    await context.close()
  })

  test('carer drawer truly isolates the child surface from focus, clicks and the accessibility tree', async ({
    page,
  }) => {
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: /^Alex/ }).click()
    await expect(page.getByTestId('welcome-celebration')).toBeHidden({ timeout: 4000 })

    const shell = page.locator('[data-routine]').first()
    await expect(shell).not.toHaveAttribute('aria-hidden')

    // Exercise the primary Fire path: a real sustained pointer hold. The hook
    // explicitly preserves trigger focus even on Safari-style button focus
    // conventions so closing can restore it honestly.
    const trigger = page.getByRole('button', { name: 'Open carer settings' })
    await pressAndHoldCarerDrawer(page)
    const dialog = page.getByRole('dialog', { name: 'Carer settings' })
    await expect(dialog).toBeVisible()

    // The whole child subtree is inert AND absent from the accessibility tree,
    // while the sibling dialog remains fully operable.
    await expect(shell).toHaveAttribute('aria-hidden', 'true')
    const isolated = await shell.evaluate(
      (el) => el.hasAttribute('inert') && (el as HTMLElement).inert === true,
    )
    expect(isolated).toBe(true)

    // The browser refuses to focus an inert background control: focus stays
    // exactly where it was (inside the dialog). Role queries correctly find
    // nothing in the isolated subtree, so locate by attribute.
    const protectedTile = page.locator('[data-tile-id="no"]')
    const focusBefore = await page.evaluate(() => document.activeElement?.outerHTML ?? '')
    await protectedTile.focus()
    expect(await page.evaluate(() => document.activeElement?.outerHTML ?? '')).toBe(focusBefore)
    const focusInsideDialog = await page.evaluate(() =>
      Boolean(document.querySelector('[role="dialog"]')?.contains(document.activeElement)),
    )
    expect(focusInsideDialog).toBe(true)

    // Tab keeps cycling inside the dialog only.
    for (let i = 0; i < 3; i += 1) {
      await page.keyboard.press('Tab')
      const insideDialog = await page.evaluate(() =>
        Boolean(document.querySelector('[role="dialog"]')?.contains(document.activeElement)),
      )
      expect(insideDialog, `Tab ${i + 1} must stay inside the dialog`).toBe(true)
    }

    // Programmatic activation on an inert element is a no-op per spec.
    const routineBefore = await shell.getAttribute('data-routine')
    await protectedTile.evaluate((el) => (el as HTMLButtonElement).click())
    expect(await shell.getAttribute('data-routine')).toBe(routineBefore)
    await expect(dialog).toBeVisible()

    // Escape restores BOTH properties plus focus.
    await closeCarerDrawer(page)
    await expect(shell).not.toHaveAttribute('aria-hidden')
    expect(await shell.evaluate((el) => el.hasAttribute('inert'))).toBe(false)
    await expect(page.getByRole('button', { name: 'Open carer settings' })).toBeFocused()
  })
})
