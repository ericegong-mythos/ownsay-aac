import type { Page, TestInfo } from '@playwright/test'
import { expect } from '@playwright/test'

export const PROTECTED_CORE_LABELS = [
  'No',
  'Stop',
  'Help',
  'Hurts',
  'Break',
  'Yes',
  'More',
  'Finished',
]

/**
 * Completes the first-run setup through the product path so a fresh browser
 * context lands on the child board. The profile then persists in that
 * context's IndexedDB across reloads. The custom path sits behind the
 * fictional demo-profile cards.
 */
export async function completeOnboarding(page: Page, nickname = 'Test'): Promise<void> {
  await page.getByRole('button', { name: 'Set up a different way' }).click()
  await page.getByLabel(/Nickname/).fill(nickname)
  await page
    .getByRole('group', { name: 'Age group' })
    .getByRole('button', { name: /^7–9\b/ })
    .click()
  await page.getByRole('button', { name: 'Make this board ready' }).click()
  await expect(page.getByRole('navigation', { name: 'Routine' })).toBeVisible({ timeout: 10_000 })
}

/**
 * Test-only injection boundary for the optional intelligence: the production
 * app is never modified. The dynamic WebLLM runtime and worker chunks are
 * replaced at the network layer, while the app's real loader, activation,
 * generation, sanitisation and state-machine code runs against a fake engine.
 * A production build cannot activate this — only this harness can.
 */
export type StubEngineMode = 'ready' | 'fail'

export async function installStubIntelligence(
  page: Page,
  mode: StubEngineMode,
  options: { generationDelayMs?: number } = {},
): Promise<void> {
  // Installed via addInitScript so EVERY navigation (including reloads) sees
  // a usable fake GPU: the preflight requires requestAdapter() AND
  // requestDevice() to succeed.
  const installGpu = () => {
    Object.defineProperty(navigator, 'gpu', {
      value: {
        requestAdapter: async () => ({
          requestDevice: async () => ({ destroy: () => {} }),
        }),
      },
      configurable: true,
    })
  }
  await page.addInitScript(installGpu)
  // The suite installs the stub after its common onboarding navigation; make
  // the current document capable too, while addInitScript covers reloads.
  await page.evaluate(installGpu)

  const moduleSource = String.raw`
const jsonChunks = (text, pieces = 3) => {
  const size = Math.ceil(text.length / pieces)
  const parts = []
  for (let i = 0; i < text.length; i += size) parts.push(text.slice(i, i + size))
  return parts
}
const answerFor = (request) => {
  const user = request.messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n')
  const ids = []
  for (const line of user.split('\n')) {
    const match = /^(c\d+) = /.exec(line.trim())
    if (match) ids.push(match[1])
  }
  return JSON.stringify({ chosen: ids.slice(0, 4) })
}
function makeEngine() {
  return {
    chat: {
      completions: {
        create: async (request) => {
          const delay = ${JSON.stringify(options.generationDelayMs ?? 0)}
          if (delay > 0 && !window.__ownsayStubDelayDone) {
            window.__ownsayStubDelayDone = true
            await new Promise((resolve) => setTimeout(resolve, delay))
          }
          window.__ownsayStubGenerationsDone = (window.__ownsayStubGenerationsDone ?? 0) + 1
          if (${JSON.stringify(mode)} === 'fail') {
            throw new Error('Message error should not be 0')
          }
          const iterator = (async function* () {
            for (const piece of jsonChunks(answerFor(request))) {
              yield { choices: [{ delta: { content: piece } }] }
            }
          })()
          return iterator
        },
      },
    },
    interruptGenerate: async () => {},
    unload: async () => {},
  }
}
export async function CreateMLCEngine(modelId, opts) {
  opts?.initProgressCallback?.({ text: 'Fetching model (stub) [0/1]' })
  opts?.initProgressCallback?.({ text: 'Finishing load (stub) [1/1]' })
  const engine = makeEngine()
  window.__ownsayStubEngine = engine
  return engine
}
export async function CreateWebWorkerMLCEngine(worker, modelId, opts) {
  return CreateMLCEngine(modelId, opts)
}
`

  await page.route('**/assets/webllm-lib-*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/javascript',
      body: moduleSource,
    })
  })
  await page.route('**/assets/webllm.worker-*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/javascript',
      body: '/* OwnSay E2E worker stub; the runtime stub ignores this worker. */',
    })
  })
}

/**
 * Stub speechSynthesis so deliberate Speak presses are observable without any
 * real audio. The stub records calls into window.__speech and flags itself via
 * window.__OWNSAY_TEST_SPEECH_STUB__ (see src/speech/adapter.ts). It never fires
 * onend, so the app relies on its own stop control or safety timer.
 */
export async function installSpeechStub(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const store = window.__speech ?? { speakTexts: [] as string[], cancelCount: 0 }
    class FakeUtterance {
      text: string
      lang = ''
      voice: unknown = null
      rate = 1
      onend: (() => void) | null = null
      onerror: (() => void) | null = null
      constructor(text: string) {
        this.text = text
      }
    }
    const synth = {
      cancel() {
        store.cancelCount += 1
      },
      getVoices() {
        return [
          {
            voiceURI: 'ownsay-e2e-local',
            name: 'Daniel',
            lang: 'en-GB',
            default: true,
            localService: true,
          } as SpeechSynthesisVoice,
        ]
      },
      speak(utterance: { text: string }) {
        store.speakTexts.push(utterance.text)
      },
      speaking: () => false,
      addEventListener: () => {},
    }
    Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true })
    Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: FakeUtterance, configurable: true })
    Object.defineProperty(window, '__speech', { value: store, configurable: true })
    Object.defineProperty(window, '__OWNSAY_TEST_SPEECH_STUB__', { value: true, configurable: true })
  })
}

export async function openCarerDrawer(page: Page): Promise<void> {
  const hold = page.getByRole('button', { name: 'Open carer settings' })
  await hold.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog', { name: 'Carer settings' })).toBeVisible({ timeout: 10_000 })
}

/** Exercises the real sustained-pointer entry gesture; use only where the gesture itself is under test. */
export async function pressAndHoldCarerDrawer(page: Page): Promise<void> {
  const hold = page.getByRole('button', { name: 'Open carer settings' })
  const box = await hold.boundingBox()
  if (!box) throw new Error('Hold for carer button not rendered')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  try {
    await expect(
      page.getByRole('dialog', { name: 'Carer settings' }),
      '1.2s press-and-hold must open carer settings',
    ).toBeVisible({ timeout: 10_000 })
  } finally {
    await page.mouse.up()
  }
}

export async function closeCarerDrawer(page: Page): Promise<void> {
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Carer settings' })).toBeHidden()
}

export async function setDensity(page: Page, density: 'Large' | 'Standard' | 'More words'): Promise<void> {
  await openCarerDrawer(page)
  await page.getByRole('button', { name: density }).click()
  await closeCarerDrawer(page)
}

export async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const widths = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }))
  expect(widths.scroll, 'page must not clip horizontally').toBe(widths.client)
}

/** Skips with an explicit reason when the engine cannot register a service worker (WebKit automation limitation). */
export async function requireServiceWorker(page: Page, testInfo: TestInfo): Promise<boolean> {
  const registered = await page
    .evaluate(async () => {
      if (!('serviceWorker' in navigator)) return false
      for (let i = 0; i < 50; i += 1) {
        const reg = await navigator.serviceWorker.getRegistration()
        if (reg) return true
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      return false
    })
    .catch(() => false)
  if (!registered) {
    testInfo.skip(true, `${testInfo.projectName}: service worker registration unavailable in this engine`)
  }
  return registered
}
