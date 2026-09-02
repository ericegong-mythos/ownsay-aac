#!/usr/bin/env node
// REAL-MODEL GATE for the release brief. Uses the persistent Chromium profile
// so the ~200 MB SmolLM2 weights come from cache. Walks ALL FIVE routines,
// records the exact suggestion dock output per routine (including which chips
// are labelled as chosen on this device), the visible fringe vocabulary the app
// offered, and writes machine-readable evidence for independent verification.
//
// Product-shaped flow (no test hooks): fresh installs land on the fictional
// demo chooser or the generic custom form; the optional model is then
// set up CARER-ONLY through the held drawer — the child-visible OwnSay
// Intelligence panel stays read-only throughout.
import { chromium } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const url = process.argv[2] ?? 'http://127.0.0.1:4174/'
const outDir = resolve(process.argv[3] ?? 'artifacts/visual-qa/ownsay-final')
const evidencePath = resolve('artifacts/real-model-evidence.json')
mkdirSync(outDir, { recursive: true })
const profileDir = resolve(outDir, '.real-model-profile')
mkdirSync(profileDir, { recursive: true })

const ROUTINES = ['Play', 'Food', 'School', 'Home', 'Outside']
// RESET_APP=1 clears ONLY app/service-worker state (registration, precache,
// local profiles) before the run — the `webllm/*` model-weight caches are
// always preserved so a new build can be tested without re-downloading.
const RESET_APP = process.env.RESET_APP === '1'

const consoleErrors = []
const pageErrors = []

const context = await chromium.launchPersistentContext(profileDir, {
  headless: true,
  args: ['--enable-unsafe-webgpu', '--use-angle=metal', '--mute-audio'],
  viewport: { width: 1280, height: 900 },
})
const pages = context.pages()
const page = pages[0] ?? (await context.newPage())
const failures = []
page.on('requestfailed', (request) => failures.push({ url: request.url(), error: request.failure()?.errorText }))
page.on('pageerror', (error) => {
  pageErrors.push(`${error.name}: ${error.message}`)
  process.stdout.write(`[browser:error] ${error.name}: ${error.message}\n`)
})
page.on('console', (message) => {
  if (message.type() === 'error' || message.type() === 'warning') {
    consoleErrors.push(`[${message.type()}] ${message.text().slice(0, 300)}`)
  }
})

// While the carer drawer is open the whole child surface is aria-hidden, so
// status reads go through the attribute (not the accessibility tree); the
// role-based locator stays reserved for child-visible checks after closing.
const panelStatus = () => page.locator('aside[aria-label="OwnSay Intelligence"]').getAttribute('data-status')

const panel = page.getByRole('complementary', { name: 'OwnSay Intelligence' })
const routineNav = page.getByRole('navigation', { name: 'Routine' })
const carerDialog = () => page.getByRole('dialog', { name: 'Carer settings' })
const isVisible = async (locator) => Boolean(await locator.isVisible().catch(() => false))

/**
 * Opens the carer drawer through a real product entry path: the sustained
 * ~1.2 s pointer hold first, standard keyboard activation as the accessible
 * fallback. Both are ordinary user actions — nothing is injected.
 */
async function openCarerSettings(why) {
  const dialog = carerDialog()
  if (await isVisible(dialog)) return dialog
  const hold = page.getByRole('button', { name: 'Open carer settings' })
  const box = await hold.boundingBox()
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    try {
      await dialog.waitFor({ state: 'visible', timeout: 8_000 })
      process.stdout.write(`carer entry (${why}): 1.2s press-and-hold\n`)
      return dialog
    } catch {
      process.stdout.write(`carer entry (${why}): hold did not open; falling back to keyboard\n`)
    } finally {
      await page.mouse.up().catch(() => {})
    }
  }
  // Keyboard activation reaches the same handler as switch/screen-reader users
  // (click with detail === 0 keeps standard button semantics).
  await hold.focus()
  await page.keyboard.press('Enter')
  await dialog.waitFor({ state: 'visible', timeout: 15_000 })
  process.stdout.write(`carer entry (${why}): keyboard activation\n`)
  return dialog
}

async function closeCarerSettings() {
  await page.keyboard.press('Escape')
  await carerDialog().waitFor({ state: 'hidden', timeout: 10_000 })
}

/** Lets the visual-only welcome moment finish so the board is fully interactable. */
async function settleWelcome() {
  const overlay = page.getByTestId('welcome-celebration')
  if (await isVisible(overlay)) {
    await overlay.waitFor({ state: 'hidden', timeout: 12_000 }).catch(() => {})
  }
  await overlay.waitFor({ state: 'detached', timeout: 5_000 }).catch(() => {})
}

try {
  await page.goto(url, { waitUntil: 'networkidle' })

  if (RESET_APP) {
    const cleared = await page.evaluate(async () => {
      const kept = []
      for (const name of await caches.keys()) {
        if (/^webllm\//.test(name)) {
          kept.push(name)
          continue
        }
        await caches.delete(name)
      }
      if ('serviceWorker' in navigator) {
        const registration = await navigator.serviceWorker.getRegistration()
        await registration?.unregister()
      }
      await new Promise((resolve) => {
        const request = indexedDB.deleteDatabase('ownsay-aac')
        request.onsuccess = () => resolve()
        request.onerror = () => resolve()
        request.onblocked = () => resolve()
      })
      return { keptCaches: kept }
    })
    console.log(`app state reset (kept model caches: ${cleared.keptCaches.join(', ')})`)
    await page.goto(url, { waitUntil: 'networkidle' })
  }

  // First run on this persistent profile: complete onboarding once, whichever
  // front door the build offers — fictional demo cards or the
  // generic custom form tucked behind them. An already-onboarded profile
  // skips straight to the child board.
  const profilePrompt = page.getByText('Who is this board for?')
  const customToggle = page.getByRole('button', { name: 'Set up a different way' })
  const readyButton = page.getByRole('button', { name: 'Make this board ready' })

  let entryPath = null
  for (let attempt = 0; attempt < 90 && !entryPath; attempt += 1) {
    if (await isVisible(profilePrompt)) entryPath = 'demo-chooser'
    else if (await isVisible(readyButton)) entryPath = 'custom-form'
    else if (await isVisible(customToggle)) entryPath = 'custom-toggle'
    else if (await isVisible(routineNav)) entryPath = 'already-onboarded'
    else await page.waitForTimeout(500)
  }
  if (!entryPath) throw new Error('neither onboarding nor the child board appeared within 45s')
  process.stdout.write(`onboarding path: ${entryPath}\n`)

  if (entryPath === 'demo-chooser') {
    await page.getByRole('button', { name: /^Alex/ }).click()
  } else if (entryPath === 'custom-toggle' || entryPath === 'custom-form') {
    if (entryPath === 'custom-toggle') await customToggle.click()
    await page.getByLabel(/Nickname/).fill('Probe')
    await page.getByRole('group', { name: 'Age group' }).getByRole('button', { name: /^10–12/ }).click()
    await readyButton.click()
  }
  await routineNav.waitFor({ state: 'visible', timeout: 30_000 })
  await settleWelcome()

  // Optional intelligence is set up CARER-ONLY: the read-only child panel has
  // no controls at all, so every action below happens inside the held drawer.
  const initialStatus = await panelStatus()
  if (initialStatus !== 'ready') {
    const dialog = await openCarerSettings('setup')
    const runningNote = dialog.getByText('On and running on this device.')
    if (!(await isVisible(runningNote))) {
      const downloadButton = dialog.getByRole('button', { name: 'Download on this device' })
      const wakeButton = dialog.getByRole('button', { name: 'Wake OwnSay Intelligence' })
      const retryButton = dialog.getByRole('button', { name: 'Try again' })
      if (await isVisible(downloadButton)) {
        console.log('activation path: fresh -> carer confirms download warning')
        await dialog.getByText(/about 200 MB/).waitFor({ timeout: 10_000 })
        await downloadButton.click()
      } else if (await isVisible(wakeButton)) {
        console.log('activation path: paused -> carer wakes')
        await wakeButton.click()
      } else if (await isVisible(retryButton)) {
        console.log('activation path: trouble -> carer retries')
        await retryButton.click()
      } else {
        throw new Error(
          `carer drawer offered no intelligence action for status "${initialStatus ?? 'unknown'}": ${(await dialog.innerText()).replace(/\s+/g, ' ').slice(0, 300)}`,
        )
      }
    } else {
      console.log('activation path: already running inside the drawer')
    }
    // Phase 1: the carer's action must take hold — the explicit downloading
    // phase or an immediate honest verdict (e.g. unsupported hardware). A bare
    // idle 'off' must NOT satisfy this: it is the pre-preflight state and once
    // produced a false-settled race right after the click.
    await page.waitForFunction(
      () => {
        const status = document.querySelector('[aria-label="OwnSay Intelligence"]')?.getAttribute('data-status')
        return status === 'downloading' || status === 'ready' || status === 'unavailable' || status === 'unsupported'
      },
      undefined,
      { timeout: 60_000 },
    )
    console.log(`activation underway: ${await panelStatus()}`)
    // Phase 2: wait for ANY settled terminal state, then fail loudly below
    // with full evidence. First uncached runs download ~200 MB — give room.
    await page.waitForFunction(
      () => {
        const status = document.querySelector('[aria-label="OwnSay Intelligence"]')?.getAttribute('data-status')
        return status === 'ready' || status === 'unavailable' || status === 'unsupported'
      },
      undefined,
      { timeout: 20 * 60_000 },
    )
    console.log(`activation settled: ${await panelStatus()}`)
  }

  const finalStatus = await panelStatus()
  if (finalStatus !== 'ready') {
    const panelText = ((await panel.innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ').slice(0, 400)
    console.error(JSON.stringify(
      {
        activationFailed: true,
        finalStatus,
        panelText,
        failures: failures.slice(0, 10),
        pageErrors,
        consoleErrors: consoleErrors.slice(0, 15),
      },
      null,
      2,
    ))
    throw new Error(`real model activation ended in ${finalStatus ?? 'unknown'}`)
  }
  console.log('model status: ready')

  // Close the drawer and validate what the CHILD actually sees: the read-only
  // panel reporting Ready and the live suggestion dock beneath it.
  await closeCarerSettings()
  await panel.getByText('Ready').waitFor({ timeout: 10_000 })
  const dock = page.getByLabel('Optional local suggestions')
  await dock.waitFor({ state: 'visible', timeout: 10_000 })
  console.log('child surface: read-only panel Ready, suggestion dock live')

  const evidence = []

  const dumpState = async (why) => {
    const panelText = ((await panel.innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ').slice(0, 300)
    process.stdout.write(
      `[diagnose:${why}] status=${await panelStatus().catch(() => '?')} panel="${panelText}" pageErrors=${JSON.stringify(pageErrors.slice(-3))} consoleErrors=${JSON.stringify(consoleErrors.slice(-3))}\n`,
    )
  }

  for (const routine of ROUTINES) {
    await routineNav.getByRole('button', { name: routine }).click()
    // The dock note switches to "OwnSay phrases are chosen on this device…"
    // only after a successful gated generation for THIS routine. A transient
    // degraded round may honestly occur; the product's own recovery (Try again
    // behind the carer drawer) is exercised once per routine.
    try {
      await dock.getByText(/chosen on this device/).waitFor({ timeout: 45_000 })
    } catch {
      await dumpState(`${routine}:no-ownsay-first-pass`)
      const dialog = await openCarerSettings(`${routine} recovery`)
      const trouble = dialog.getByRole('button', { name: 'Try again' })
      if (!(await isVisible(trouble))) {
        await closeCarerSettings().catch(() => {})
        throw new Error(`routine ${routine}: dock never showed an on-device phrase and the carer drawer offers no Try again`)
      }
      await trouble.click()
      await closeCarerSettings()
      await dock.getByText(/chosen on this device/).waitFor({ timeout: 45_000 })
    }
    await page.waitForTimeout(400)

    const captured = await dock.getByRole('button').evaluateAll((nodes) =>
      nodes.map((node) => ({
        label: node.textContent ?? '',
        ariaLabel: node.getAttribute('aria-label') ?? '',
        fromModel: (node.getAttribute('aria-label') ?? '').includes('(OwnSay phrase)'),
      })),
    )
    const fringeIds = await page
      .getByRole('region', { name: /Right now|Anytime words/ })
      .locator('[data-tile-id]')
      .evaluateAll((tiles) => tiles.map((tile) => tile.getAttribute('data-tile-id')))

    const ownsayPhrases = captured.filter((row) => row.fromModel)
    if (ownsayPhrases.length === 0) {
      throw new Error(`no on-device phrase reached the dock for routine ${routine}`)
    }
    await page.screenshot({
      path: `${outDir}/real-intelligence-${routine.toLowerCase()}.png`,
      fullPage: true,
      animations: 'disabled',
    })
    const profile = await page.evaluate(async () => {
      const db = await new Promise((resolve) => {
        const request = indexedDB.open('ownsay-aac', 2)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => resolve(null)
      })
      if (!db) return null
      const profiles = await new Promise((resolve) => {
        const getAll = db.transaction('profiles', 'readonly').objectStore('profiles').getAll()
        getAll.onsuccess = () => resolve(getAll.result ?? [])
        getAll.onerror = () => resolve([])
      })
      db.close()
      return profiles[0] ?? null
    })
    evidence.push({
      routine,
      ownsayPhrases: ownsayPhrases.map((row) => ({ text: row.label.replace(/OwnSay$/i, '').trim(), ariaLabel: row.ariaLabel })),
      instantPhrases: captured.filter((row) => !row.fromModel).map((row) => row.label.trim()),
      boardFringeIds: [...new Set(fringeIds)],
      profilePrefs: profile
        ? {
            nickname: profile.nickname,
            ageBand: profile.ageBand,
            accessDensity: profile.accessDensity,
            interests: profile.interests,
            // Privacy-bounded reconstruction fields: ONLY the carer-configured
            // personal word metadata needed to rebuild the exact buildModelInput
            // the live app used (identity, display label, routine tag and
            // suggestion eligibility). Authored messages and events are never
            // recorded.
            extraWords: Array.isArray(profile.extraWords)
              ? profile.extraWords.map((word) => ({
                  id: word.id,
                  label: word.label,
                  ...(word.routine ? { routine: word.routine } : {}),
                  ...(word.tone ? { tone: word.tone } : {}),
                }))
              : [],
          }
        : null,
    })
    process.stdout.write(
      `${routine}: ${JSON.stringify(evidence.at(-1)?.ownsayPhrases.map((p) => p.text))} (instant: ${evidence
        .at(-1)
        ?.instantPhrases.length})\n`,
    )
  }

  writeFileSync(evidencePath, JSON.stringify({ capturedAt: new Date().toISOString(), engine: 'WebGPU · SmolLM2-360M-Instruct-q4f32_1-MLC (q4f32_1)', evidence }, null, 2))
  console.log(`evidence written to ${evidencePath}`)
} finally {
  await context.close()
}
if (failures.length > 0) {
  console.log(`request failures during probe: ${JSON.stringify(failures.slice(0, 5))}`)
}
