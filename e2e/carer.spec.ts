import { expect, test } from '@playwright/test'
import * as fs from 'node:fs'
import {
  closeCarerDrawer,
  completeOnboarding,
  expectNoHorizontalOverflow,
  openCarerDrawer,
  pressAndHoldCarerDrawer,
  requireServiceWorker,
} from './helpers'

test.describe('carer controls', () => {
  test('a short pointer press stays guarded; a 1.2s hold opens settings', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' })
    await completeOnboarding(page)
    const hold = page.getByRole('button', { name: 'Open carer settings' })

    await hold.click()
    await page.waitForTimeout(400)
    await expect(page.getByRole('dialog', { name: 'Carer settings' })).toBeHidden()

    await pressAndHoldCarerDrawer(page)
  })

  test('standard keyboard activation opens carer settings', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' })
    await completeOnboarding(page)
    const hold = page.getByRole('button', { name: 'Open carer settings' })

    await hold.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('dialog', { name: 'Carer settings' })).toBeVisible()
  })

  test('assistive-technology click activation opens carer settings', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' })
    await completeOnboarding(page)
    const hold = page.getByRole('button', { name: 'Open carer settings' })

    await hold.evaluate((button: HTMLButtonElement) => button.click())
    await expect(page.getByRole('dialog', { name: 'Carer settings' })).toBeVisible()
  })

  test('carer help is written, offline and contains no embedded media', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 600 })
    await page.goto('/', { waitUntil: 'networkidle' })
    await completeOnboarding(page)
    await openCarerDrawer(page)

    const dialog = page.getByRole('dialog', { name: 'Carer settings' })
    await expect(dialog.getByText('Quick guide')).toBeVisible()
    await expect(dialog.getByText(/OwnSay never speaks by itself/)).toBeVisible()
    await expect(dialog.locator('video')).toHaveCount(0)
    await expectNoHorizontalOverflow(page)
  })

  test('age band and density changes are visible and persist across reload', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' })
    await completeOnboarding(page)
    await openCarerDrawer(page)
    const dialog = page.getByRole('dialog', { name: 'Carer settings' })
    const olderBand = dialog.getByRole('button', { name: '10–12', exact: true })
    await olderBand.focus()
    await olderBand.press('Enter')
    await expect(olderBand, 'preference updates must not reset keyboard focus').toBeFocused()
    const moreWords = dialog.getByRole('button', { name: 'More words', exact: true })
    await moreWords.click()
    await expect(moreWords).toHaveAttribute('data-selected', 'true')
    // This is the persistence test: wait for the IndexedDB transaction rather
    // than racing an immediate reload against a deliberately asynchronous put.
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              new Promise<string | undefined>((resolve, reject) => {
                const open = indexedDB.open('ownsay-aac')
                open.onerror = () => reject(open.error)
                open.onsuccess = () => {
                  const db = open.result
                  const read = db.transaction('profiles', 'readonly').objectStore('profiles').getAll()
                  read.onerror = () => {
                    db.close()
                    reject(read.error)
                  }
                  read.onsuccess = () => {
                    const rows = read.result as Array<{ accessDensity?: string }>
                    db.close()
                    resolve(rows[0]?.accessDensity)
                  }
                }
              }),
          ),
        { message: 'density preference must reach local storage before reload' },
      )
      .toBe('more')
    await closeCarerDrawer(page)

    await page.reload({ waitUntil: 'networkidle' })

    // The persisted profile survives reload: the words choices prove it.
    await openCarerDrawer(page)
    await expect(dialog.getByRole('button', { name: '10–12', exact: true })).toHaveAttribute('data-selected', 'true')
    await expect(dialog.getByRole('button', { name: 'More words', exact: true })).toHaveAttribute('data-selected', 'true')
    await closeCarerDrawer(page)

    // Intelligence starts honestly on every fresh load, without eager downloads.
    const panel = page.getByLabel('OwnSay Intelligence')
    await expect(panel.getByText('Not set up')).toBeVisible()

    // Protected core intact after persisted-state load.
    const section = page
      .getByRole('region')
      .filter({ has: page.getByRole('heading', { name: 'Core words' }) })
    await expect(section.locator('[data-tile-id]')).toHaveCount(8)
  })

  test('selected interests remain visible even on the smallest board and persist', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' })
    await completeOnboarding(page)
    await openCarerDrawer(page)
    const dialog = page.getByRole('dialog', { name: 'Carer settings' })
    await dialog.getByRole('button', { name: 'Large', exact: true }).click()
    await dialog.getByRole('button', { name: 'Vehicles', exact: true }).click()
    await expect(dialog.getByRole('button', { name: 'Vehicles', exact: true })).toHaveAttribute(
      'data-selected',
      'true',
    )
    await closeCarerDrawer(page)

    const rightNow = page
      .getByRole('region')
      .filter({ has: page.getByRole('heading', { name: /Right now/ }) })
    await expect(
      rightNow.getByRole('button', { name: /^(Bike|Car|Bus|Train)$/ }).first(),
      'a selected vehicle interest must not be crowded off the large-button board',
    ).toBeVisible()

    await expect
      .poll(() =>
        page.evaluate(
          () =>
            new Promise<boolean>((resolve, reject) => {
              const open = indexedDB.open('ownsay-aac')
              open.onerror = () => reject(open.error)
              open.onsuccess = () => {
                const db = open.result
                const read = db.transaction('profiles', 'readonly').objectStore('profiles').getAll()
                read.onerror = () => {
                  db.close()
                  reject(read.error)
                }
                read.onsuccess = () => {
                  const rows = read.result as Array<{ interests?: string[]; accessDensity?: string }>
                  db.close()
                  resolve(rows[0]?.accessDensity === 'large' && rows[0]?.interests?.includes('vehicles') === true)
                }
              }
            }),
        ),
      )
      .toBe(true)

    await page.reload({ waitUntil: 'networkidle' })
    await expect(
      page
        .getByRole('region')
        .filter({ has: page.getByRole('heading', { name: /Right now/ }) })
        .getByRole('button', { name: /^(Bike|Car|Bus|Train)$/ })
        .first(),
    ).toBeVisible()
  })

  test('backup download holds exactly the documented schema and restores through preview', async ({ page }, testInfo) => {
    await page.goto('/', { waitUntil: 'networkidle' })
    await completeOnboarding(page, 'Maya')
    await page.getByRole('button', { name: 'No, Core' }).click()
    await openCarerDrawer(page)

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Download backup' }).click(),
    ])
    const path = await download.path()
    const bundle = JSON.parse(fs.readFileSync(path!, 'utf8'))

    expect(bundle.app).toBe('ownsay-aac')
    expect(bundle.schema).toBe(3)
    expect(Object.keys(bundle).sort()).toEqual(
      ['app', 'disclaimer', 'events', 'exportedAt', 'profiles', 'schema'].sort(),
    )
    expect(bundle.profiles).toHaveLength(1)
    const profile = bundle.profiles[0]
    for (const key of Object.keys(profile)) {
      expect([
        'id',
        'nickname',
        'createdAt',
        'voiceURI',
        'ageBand',
        'accessDensity',
        'routine',
        'interests',
        'extraWords',
        'helperEnabled',
        'welcomeCelebration',
        'welcomeSprites',
        'starterKey',
      ]).toContain(key)
    }
    for (const event of bundle.events) {
      for (const key of Object.keys(event)) {
        expect(['id', 'timestamp', 'tileId', 'mode', 'status']).toContain(key)
      }
    }
    // Authored messages never enter the backup.
    expect(JSON.stringify(bundle)).not.toMatch(/"label"/)

    // Corrupt files fail safely with calm copy and change nothing.
    fs.mkdirSync(testInfo.outputDir, { recursive: true })
    const corrupt = testInfo.outputPath('ownsay-corrupt.json')
    fs.writeFileSync(corrupt, '{not json at all')
    const fileChooserPromise = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: 'Choose backup file…' }).click()
    const chooser = await fileChooserPromise
    await chooser.setFiles(corrupt)
    await expect(page.getByRole('alert')).toContainText(/could not be read as a backup/)
    await closeCarerDrawer(page)

    // A valid backup previews before anything changes, then restores.
    await openCarerDrawer(page)
    const restoreChooserPromise = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: 'Choose backup file…' }).click()
    const restoreChooser = await restoreChooserPromise
    await restoreChooser.setFiles(path!)
    await expect(page.getByText(/Restore “/)).toBeVisible()
    await expect(page.getByText(/Contains 1 board \(Maya\)/)).toBeVisible()
    await page.getByRole('button', { name: 'Restore backup' }).click()
    await expect(page.getByText(/Backup restored/)).toBeVisible()
    await closeCarerDrawer(page)

    // The restored board is active and intact.
    await expect(page.locator('.childTag, [class*="childTag"]')).toHaveText('Maya')
    await openCarerDrawer(page)
    await expect(page.getByRole('button', { name: 'Keep current' })).toHaveCount(0)
    await closeCarerDrawer(page)
  })

  test('clear local data needs a deliberate confirmation and then returns to first run', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' })
    await completeOnboarding(page)
    await openCarerDrawer(page)

    // Declining keeps every board.
    await page.getByRole('button', { name: 'Clear local data' }).click()
    await page.getByRole('button', { name: 'Keep data' }).click()
    await expect(page.getByRole('dialog', { name: 'Carer settings' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('navigation', { name: 'Routine' })).toBeVisible()

    // Confirming erases the device and lands back on setup, with no speech.
    await openCarerDrawer(page)
    await page.getByRole('button', { name: 'Clear local data' }).click()
    await page.getByRole('button', { name: /Erase everything/ }).click()
    await expect(page.getByText('Who is this board for?')).toBeVisible({ timeout: 10_000 })
  })

  test('offline app shell keeps the board usable after first load', async ({ page }, testInfo) => {
    test.skip(
      testInfo.project.name.startsWith('webkit'),
      'Playwright WebKit offline emulation bypasses service-worker responses; strict offline reload is covered by all Chromium viewports',
    )
    await page.goto('/', { waitUntil: 'networkidle' })
    await completeOnboarding(page)
    const hasSw = await requireServiceWorker(page, testInfo)
    if (!hasSw) return

    // Ensure the already-installed worker controls this client before the
    // strict offline navigation probe.
    if (!(await page.evaluate(() => navigator.serviceWorker.controller !== null))) {
      await page.reload({ waitUntil: 'networkidle' })
      await page.waitForFunction(() => navigator.serviceWorker.controller !== null)
    }

    await page.context().setOffline(true)
    await page.reload({ waitUntil: 'domcontentloaded' })

    await expect(page.getByRole('heading', { name: 'OwnSay', exact: true })).toBeVisible()
    // Playwright can leave navigator.onLine stale after a service-worker
    // navigation; dispatch the browser's offline signal to exercise the UI.
    await page.evaluate(() => window.dispatchEvent(new Event('offline')))
    await expect(page.getByRole('status')).toContainText('Offline · board and instant phrases are ready')
    const section = page
      .getByRole('region')
      .filter({ has: page.getByRole('heading', { name: 'Core words' }) })
    await expect(section.locator('[data-tile-id]')).toHaveCount(8)
    await section.getByRole('button', { name: 'Help, Core' }).click()
    const rail = page.getByRole('region', { name: 'Authorship rail' })
    await expect(rail.getByRole('button', { name: /Remove Help, Core/ })).toBeVisible()
    await expect(rail.getByRole('button', { name: 'Speak', exact: true })).toBeEnabled()
  })
})
