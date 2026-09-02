import { describe, expect, it, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { classify, collectDeviceCheck, runSpeechTest, type DeviceCheckEnv } from './device-check'

function makeEnv(overrides: Partial<DeviceCheckEnv> = {}): DeviceCheckEnv {
  const nav = {
    userAgent: 'Mozilla/5.0 (Linux; Android 11; KFQUWI) AppleWebKit/537.36 (KHTML, like Gecko) Silk/119-like',
    platform: 'Linux armv8l',
    onLine: false,
    languages: ['en-GB', 'en'],
    hardwareConcurrency: 4,
    maxTouchPoints: 5,
    storage: {
      estimate: async () => ({ quota: 1073741824, usage: 1048576 }),
      persisted: async () => false,
    },
  } as unknown as Navigator
  const win = {
    innerWidth: 1024,
    innerHeight: 430,
    screen: { width: 1024, height: 600 },
    devicePixelRatio: 1,
    visualViewport: { width: 979, height: 405, scale: 1 },
    matchMedia: (query: string) => ({ matches: query.includes('reduce') }),
    indexedDB: undefined,
  } as unknown as DeviceCheckEnv['window']
  return { navigator: nav, window: win, document: document, ...overrides }
}

describe('device check', () => {
  it('collects a complete report on a Fire-class environment without throwing', async () => {
    const report = await collectDeviceCheck(makeEnv())
    expect(report.browser.userAgent).toContain('KFQUWI')
    expect(report.browser.fireDevicePolicy).toBe(true)
    expect(report.display.innerViewport).toBe('1024×430')
    expect(report.display.visualViewportScale).toBe(1)
    expect(report.display.reducedMotion).toBe(true)
    // No IndexedDB in this env → recorded as failed storage, never fatal.
    expect('error' in report.storage.indexedDbRoundTrip || report.storage.indexedDbRoundTrip.value === false).toBe(
      true,
    )
    expect(report.summary.savedLocally).toBe('failed')
    expect(report.storage.serviceWorker).toEqual({ value: 'unsupported' })
    const estimate = report.storage.estimate
    expect(!('error' in estimate) ? estimate.value.includes('MB') : false).toBe(true)
    expect(report.graphics.webgl2).toBe(false)
    expect(report.graphics.webgpuAdapterAndDevice).toEqual({ value: 'absent' })
    // Known-device policy blocks the helper before any GPU work.
    expect(report.summary.localHelper).toBe('blocked-by-device-policy')
    expect(report.summary.core).toBe('ready')
    expect(report.summary.offlineShell).toBe('unavailable')
    expect(report.summary.speech).toBe('text-only')
    expect(report.appVersion).toBeTruthy()
    expect(Array.isArray(report.resourceOrigins)).toBe(true)
  })

  it('never contains child names, vocabulary, messages, ids or secrets', async () => {
    const report = await collectDeviceCheck(makeEnv())
    const json = JSON.stringify(report)
    const forbiddenSubstrings = [
      'Alex',
      'Sam',
      'Building blocks',
      'message',
      'nickname',
      'token',
      'secret',
      'prf-',
      'evt-',
      '?query=',
    ]
    for (const needle of forbiddenSubstrings) {
      expect(json.includes(needle), `"${needle}" must never appear`).toBe(false)
    }
    // Match the complete JSON string value: the browser's legitimate
    // `AppleWebKit` user-agent token is not the fictional vocabulary label.
    expect(json.includes('"Apple"'), 'the exact personal word must never appear').toBe(false)
    // Voice NAMES are personally identifying on some devices; only
    // language/local/default aggregates may ship.
    expect(json.includes('"sample"')).toBe(false)
    expect(json.toLowerCase().includes('voicename')).toBe(false)
    for (const key of Object.keys(report)) {
      expect(typeof key === 'string' && /name/i.test(key) && key !== 'platform').toBe(false)
    }
  })

  it('classifies a capable browser honestly without ever claiming local helper ready', () => {
    const base = JSON.parse(
      JSON.stringify({
        generatedAtUtc: '',
        appVersion: '1.1.1',
        summary: { core: 'ready', savedLocally: 'yes', offlineShell: 'ready', speech: 'ready', localHelper: 'unavailable' },
        browser: { userAgent: '', platform: '', online: true, languages: [], secureContext: true, fireDevicePolicy: false },
        display: {
          screen: '',
          screenAvailable: null,
          innerViewport: '',
          visualViewport: null,
          visualViewportScale: null,
          orientationType: null,
          devicePixelRatio: 1,
          maxTouchPoints: null,
          reducedMotion: null,
          forcedColors: null,
        },
        hardware: { hardwareConcurrency: null, deviceMemoryGb: null },
        storage: {
          indexedDbRoundTrip: { value: true },
          serviceWorker: { value: 'registered · sw.js · scope / · controlled' },
          cacheStorageRoundTrip: { value: 'round-trip ok' },
          shellCaches: { value: '2 shell cache(s)' },
          shellCacheVerified: { value: true },
          estimate: { value: 'x' },
          persisted: { value: true },
        },
        media: { mp3: 'probably', wav: 'probably' },
        graphics: { webgl2: true, webgl1: true, webgpuAdapterAndDevice: { value: 'adapter and device obtained (capability evidence only)' } },
        speechCapability: {
          synthesisPresent: true,
          localVoiceCount: 3,
          voiceCount: 3,
          enGbVoices: 1,
          englishVoices: 3,
          defaultVoiceLang: 'en-GB',
          defaultVoiceLocal: true,
        },
        resourceOrigins: [],
      }),
    ) as Parameters<typeof classify>[0]
    const full = JSON.parse(JSON.stringify(base))
    full.summary = classify(full)
    expect(full.summary.core).toBe('ready')
    expect(full.summary.savedLocally).toBe('yes')
    expect(full.summary.offlineShell).toBe('ready')
    expect(full.summary.speech).toBe('ready')
    // Capability evidence alone is experimental — bounded inference is the
    // only possible proof of ready.
    expect(full.summary.localHelper).toBe('experimental')

    const degraded = JSON.parse(JSON.stringify(base))
    degraded.storage.serviceWorker = { value: 'supported-unregistered' }
    degraded.storage.shellCacheVerified = { value: true }
    degraded.speechCapability.localVoiceCount = 0
    degraded.graphics.webgpuAdapterAndDevice = { value: 'absent' }
    degraded.summary = classify(degraded)
    expect(degraded.summary.offlineShell).toBe('online-only')
    expect(degraded.summary.speech).toBe('api-present-no-local-voices')
    expect(degraded.summary.localHelper).toBe('unavailable')

    const remoteOnly = JSON.parse(JSON.stringify(base))
    remoteOnly.speechCapability.localVoiceCount = 0
    remoteOnly.speechCapability.voiceCount = 3
    remoteOnly.speechCapability.defaultVoiceLocal = false
    remoteOnly.summary = classify(remoteOnly)
    expect(remoteOnly.summary.speech).toBe('api-present-no-local-voices')

    // A controlled worker alone is NOT enough: without a verified /index.html
    // inside the production shell cache, offline can never claim ready.
    const unverified = JSON.parse(JSON.stringify(base))
    unverified.storage.shellCacheVerified = { value: false }
    unverified.summary = classify(unverified)
    expect(unverified.summary.offlineShell).toBe('shell-cached')

    const policy = JSON.parse(JSON.stringify(base))
    policy.browser.fireDevicePolicy = true
    policy.summary = classify(policy)
    expect(policy.summary.localHelper).toBe('blocked-by-device-policy')
  })

  it('survives APIs that throw synchronously and reports the board as Core ready regardless', async () => {
    const hostile = makeEnv({
      window: {
        ...makeEnv().window,
        matchMedia: () => {
          throw new Error('matchMedia refused')
        },
        speechSynthesis: {
          getVoices: () => {
            throw new Error('voices refused')
          },
        } as unknown as SpeechSynthesis,
      },
    })
    const report = await collectDeviceCheck(hostile)
    expect(report.display.reducedMotion).toBeNull()
    expect(report.speechCapability.synthesisPresent).toBe(false)
    expect(report.summary.speech).toBe('text-only')
    // The running board is Core ready even when persistence fails.
    expect(report.summary.core).toBe('ready')
  })

  it('speech test captures start/end without auto-speaking during collection', async () => {
    let spoken = 0
    let endCallback: (() => void) | undefined
    let textSeen = ''
    const promise = runSpeechTest({
      speak: (text, onEnd) => {
        spoken += 1
        textSeen = text
        endCallback = onEnd
        return true
      },
      stop: () => {},
    })
    // The adapter is invoked synchronously by the run.
    await Promise.resolve()
    expect(spoken).toBe(1)
    expect(textSeen).toContain('voice test')
    endCallback?.()
    const result = await promise
    expect(result.started).toBe(true)
    expect(result.ended).toBe(true)
    expect(result.timedOut).toBe(false)
  })

  it('speech test reports a timeout when the synthesiser never ends and cancels the attempt', async () => {
    const stop = vi.fn()
    const result = await runSpeechTest({ speak: () => true, stop }, 30)
    expect(result.started).toBe(true)
    expect(result.ended).toBe(false)
    expect(result.timedOut).toBe(true)
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('speech test reports an honest not-started outcome when the adapter refuses', async () => {
    const stop = vi.fn()
    const result = await runSpeechTest({ speak: () => false, stop }, 30)
    expect(result.started).toBe(false)
    expect(result.ended).toBe(false)
    expect(result.error).toBeNull()
    expect(result.timedOut).toBe(false)
  })

  it('speech test captures a throwing adapter as an error and still stops', async () => {
    const stop = vi.fn()
    const result = await runSpeechTest(
      {
        speak: () => {
          throw new Error('engine exploded')
        },
        stop,
      },
      500,
    )
    expect(result.started).toBe(false)
    expect(result.error).toBe('engine exploded')
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('completes a real IndexedDB round trip on fake-indexeddb and cleans up its diagnostic database', async () => {
    const factory = new IDBFactory() as unknown as IDBFactory & {
      databases: () => Promise<Array<{ name?: string }>>
    }
    const env = makeEnv()
    ;(env.window as { indexedDB?: unknown }).indexedDB = factory
    const report = await collectDeviceCheck(env)
    // The full open → write/commit → close → reopen → read/verify → close →
    // delete cycle genuinely ran.
    expect(report.storage.indexedDbRoundTrip).toEqual({ value: true })
    expect(report.summary.savedLocally).toBe('yes')
    // Cleanup: the random diagnostic database is gone afterwards.
    const remaining = (await factory.databases())
      .map((db) => db.name ?? '')
      .filter((name) => name.startsWith('ownsay-diag-'))
    expect(remaining).toEqual([])
  })

  it('uses the Window IndexedDB contract and ignores a non-standard navigator alias', async () => {
    const env = makeEnv()
    ;(env.navigator as Navigator & { indexedDB?: IDBFactory }).indexedDB = new IDBFactory()
    ;(env.window as { indexedDB?: IDBFactory }).indexedDB = undefined
    const report = await collectDeviceCheck(env)
    expect(report.storage.indexedDbRoundTrip).toEqual({ value: false })
    expect(report.summary.savedLocally).toBe('failed')
  })

  it('bounds a hanging storage estimate so the check can never stay on Checking… forever', async () => {
    vi.useFakeTimers()
    try {
      const env = makeEnv()
      ;(env.navigator as unknown as { storage: unknown }).storage = {
        estimate: () => new Promise(() => {}),
        persisted: async () => false,
      }
      const pending = collectDeviceCheck(env)
      const report = await vi.advanceTimersByTimeAsync(5_100).then(() => pending)
      expect(report.summary.core).toBe('ready')
      const estimate = report.storage.estimate
      expect('error' in estimate).toBe(true)
      if ('error' in estimate) {
        expect(estimate.error).toMatch(/timed out/)
      }
    } finally {
      vi.useRealTimers()
    }
  })
})
