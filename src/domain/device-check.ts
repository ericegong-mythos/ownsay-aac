import { opaqueCode } from '../lib/id'
import { APP_VERSION } from './version'

/**
 * One-shot, carer-triggered device capability check for Fire-class tablets.
 *
 * Runs ONLY when a carer presses Run. It gathers local capability facts and
 * classifies them honestly. The report never contains: child names or ids,
 * profile data, vocabulary, authored messages, event history, storage
 * contents, secrets, query strings, or speech-voice names (a device may hold
 * personally named custom voices — only language/local/default aggregates).
 * Every probe degrades independently; nothing here can break the board.
 */

export type Probe<T> = { value: T } | { error: string }

export interface DeviceCheckReport {
  generatedAtUtc: string
  appVersion: string
  summary: {
    core: 'ready'
    savedLocally: 'yes' | 'temporary-session' | 'failed'
    offlineShell: 'ready' | 'shell-cached' | 'online-only' | 'unavailable'
    speech: 'ready' | 'api-present-no-local-voices' | 'text-only'
    localHelper: 'blocked-by-device-policy' | 'unavailable' | 'experimental' | 'ready'
  }
  browser: {
    userAgent: string
    platform: string
    online: boolean
    languages: string[]
    secureContext: boolean | null
    fireDevicePolicy: boolean
  }
  display: {
    screen: string
    screenAvailable: string | null
    innerViewport: string
    visualViewport: string | null
    visualViewportScale: number | null
    orientationType: string | null
    devicePixelRatio: number
    maxTouchPoints: number | null
    reducedMotion: boolean | null
    forcedColors: boolean | null
  }
  hardware: {
    hardwareConcurrency: number | null
    deviceMemoryGb: number | null
  }
  storage: {
    indexedDbRoundTrip: Probe<boolean>
    serviceWorker: Probe<string>
    cacheStorageRoundTrip: Probe<string>
    shellCaches: Probe<string>
    shellCacheVerified: Probe<boolean>
    estimate: Probe<string>
    persisted: Probe<boolean>
  }
  media: {
    mp3: string | null
    wav: string | null
  }
  graphics: {
    webgl2: boolean
    webgl1: boolean
    webgpuAdapterAndDevice: Probe<string>
  }
  speechCapability: {
    synthesisPresent: boolean
    /** Voices the browser explicitly reports as supplied by a local service. */
    localVoiceCount: number | null
    voiceCount: number | null
    enGbVoices: number | null
    englishVoices: number | null
    defaultVoiceLang: string | null
    defaultVoiceLocal: boolean | null
  }
  resourceOrigins: string[]
}

export interface DeviceCheckEnv {
  navigator: Navigator
  window: Window & {
    visualViewport?: { width: number; height: number; scale: number } | null
    matchMedia?: (query: string) => { matches: boolean }
  }
  document: Document
  performance?: { getEntriesByType?: (type: string) => Array<{ name: string }> }
}

function defaultEnv(): DeviceCheckEnv {
  return {
    navigator,
    window: window as DeviceCheckEnv['window'],
    document,
    performance,
  }
}

const WEBGPU_PROBE_TIMEOUT_MS = 4_000

const PROBE_TIMEOUT_MS = 5_000

/** Bounds EVERY diagnostic operation so a blocked API can hang nothing.
 * When the bound fires, `onTimeout` runs best-effort cleanup; the underlying
 * work may still finish later in the background but its result is discarded. */
async function tryProbe<T>(run: () => Promise<T>, onTimeout?: () => void): Promise<Probe<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let timedOut = false
  try {
    const value = await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true
          reject(new Error(`diagnostic timed out after ${PROBE_TIMEOUT_MS} ms`))
        }, PROBE_TIMEOUT_MS)
      }),
    ])
    return { value }
  } catch (error) {
    if (timedOut && onTimeout) {
      try {
        onTimeout()
      } catch {
        // Best-effort only.
      }
    }
    return { error: error instanceof Error ? error.message : String(error) }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function probeOk<T>(probe: Probe<T>): probe is { value: T } {
  return !('error' in probe)
}

function trySync<T>(run: () => T): Probe<T> {
  try {
    return { value: run() }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

function stripQuery(url: string): string {
  try {
    const parsed = new URL(url, 'https://same.origin')
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}` || url.split('?')[0]
  } catch {
    return url.split('?')[0] ?? url
  }
}

/** Query-free, path-free origin for shareable resource evidence. */
function originOnly(url: string): string | null {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

/** Query-free same-origin-safe display value for a service-worker scope. */
function scopePathname(scope: string): string {
  try {
    const parsed = new URL(scope)
    return `${parsed.pathname}`
  } catch {
    return '/'
  }
}

export interface SpeechTestOutcome {
  started: boolean
  ended: boolean
  error: string | null
  timedOut: boolean
}

/**
 * A carer-deliberate, silent-safe speech test. The outcome reflects the real
 * adapter contract: `started` is true only when synthesis was actually
 * invoked, and a timeout cancels the utterance instead of leaving it running.
 * Nothing here auto-speaks; the check itself never plays sound.
 */
export async function runSpeechTest(
  attempt: { speak: (text: string, onEnd?: () => void) => boolean; stop: () => void },
  timeoutMs = 8_000,
): Promise<SpeechTestOutcome> {
  const outcome: SpeechTestOutcome = { started: false, ended: false, error: null, timedOut: false }
  await new Promise<void>((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      resolve()
    }
    const timer = window.setTimeout(() => {
      outcome.timedOut = true
      try {
        attempt.stop()
      } catch {
        // Best-effort cancellation.
      }
      finish()
    }, timeoutMs)
    try {
      outcome.started = attempt.speak('OwnSay voice test.', () => {
        if (settled) return
        outcome.ended = true
        finish()
      }) === true
      // "Not started" finishes immediately: no end event will ever come.
      if (!outcome.started && !settled) finish()
    } catch (error) {
      outcome.error = error instanceof Error ? error.message : String(error)
      try {
        attempt.stop()
      } catch {
        // Best-effort cancellation.
      }
      finish()
    }
  })
  return outcome
}

export function classify(report: DeviceCheckReport): DeviceCheckReport['summary'] {
  const idb = report.storage.indexedDbRoundTrip
  const savedLocally: DeviceCheckReport['summary']['savedLocally'] = probeOk(idb) && idb.value
    ? 'yes'
    : 'failed'

  const sw = report.storage.serviceWorker
  const swValue = probeOk(sw) ? sw.value : ''
  // Offline `ready` demands an ACTIVE worker controlling THIS page plus a
  // verified `/index.html` inside the app's own production shell cache. A
  // generic CacheStorage round-trip proves only CacheStorage — never the shell.
  const swControlled = swValue.startsWith('registered') && /controlled/.test(swValue)
  const shellVerifiedProbe = report.storage.shellCacheVerified
  const shellVerified =
    Boolean(shellVerifiedProbe) &&
    probeOk(shellVerifiedProbe as Probe<boolean>) &&
    (shellVerifiedProbe as { value: boolean }).value === true
  const cache = report.storage.cacheStorageRoundTrip
  const cacheOk = probeOk(cache) && /round-trip ok/.test(cache.value)
  let offlineShell: DeviceCheckReport['summary']['offlineShell']
  if (swControlled && shellVerified && cacheOk) offlineShell = 'ready'
  // A registration exists (controlling or not): the shell may already be
  // cached, but without page control plus verification it cannot claim ready.
  else if (swValue.startsWith('registered')) offlineShell = 'shell-cached'
  else offlineShell = report.browser.online ? 'online-only' : 'unavailable'

  const voices = report.speechCapability
  const speech: DeviceCheckReport['summary']['speech'] =
    voices.synthesisPresent && (voices.localVoiceCount ?? 0) > 0
      ? 'ready'
      : voices.synthesisPresent
        ? 'api-present-no-local-voices'
        : 'text-only'

  const gpu = report.graphics.webgpuAdapterAndDevice
  let helper: DeviceCheckReport['summary']['localHelper']
  if (report.browser.fireDevicePolicy) helper = 'blocked-by-device-policy'
  else if (probeOk(gpu) && /adapter and device/i.test(gpu.value)) helper = 'experimental'
  else helper = 'unavailable'

  // `core` is ready whenever this code is executing: the deterministic board
  // does not depend on any optional API. Storage quality is reported
  // separately so a failed IndexedDB can never hide a working board.
  return { core: 'ready', savedLocally, offlineShell, speech, localHelper: helper }
}

export async function collectDeviceCheck(env: DeviceCheckEnv = defaultEnv()): Promise<DeviceCheckReport> {
  const { navigator: nav, window: win, performance: perf } = env

  const secureContext = trySync(() => (win as { isSecureContext?: boolean }).isSecureContext === true)

  const reducedMotion = trySync(() =>
    typeof win.matchMedia === 'function' ? win.matchMedia('(prefers-reduced-motion: reduce)').matches : null,
  )
  const forcedColors = trySync(() =>
    typeof win.matchMedia === 'function' ? win.matchMedia('(forced-colors: active)').matches : null,
  )

  // Full diagnostic round-trip on a RANDOM database: open → write → commit →
  // close → reopen → read → verify → close → delete database. The app's own
  // records are untouched. Blocked or failed DELETION is not success.
  const diagCleanups: Array<() => void> = []
  const indexedDbRoundTrip = await tryProbe(
    async () => {
      // IndexedDB is a Window API. Do not accept a non-standard navigator
      // alias: the result must describe the same API the app itself uses.
      const idb = win.indexedDB
      if (!idb) return false
      const dbName = `ownsay-diag-${opaqueCode(String(Date.now()) + Math.random())}`
      const storeName = 'probe'
      // Holder keeps the connection visible to later stages without fighting
      // control-flow analysis over assignments made inside IDB callbacks.
      const opened: { db: IDBDatabase | null } = { db: null }
      const closeQuietly = () => {
        try {
          opened.db?.close()
        } catch {
          // Best-effort.
        }
        opened.db = null
      }
      const dropDatabaseQuietly = () => {
        try {
          const request = idb.deleteDatabase(dbName)
          request.onsuccess = request.onerror = request.onblocked = () => {}
        } catch {
          // Best-effort.
        }
      }
      try {
        await new Promise<void>((resolveOpen, reject) => {
          const request = idb.open(dbName, 1)
          request.onupgradeneeded = () => {
            request.result.createObjectStore(storeName)
          }
          request.onsuccess = () => {
            opened.db = request.result
            // Registered before any await so a timeout can release the handle
            // and drop this random diagnostic database.
            diagCleanups.push(closeQuietly, dropDatabaseQuietly)
            try {
              const tx = opened.db.transaction(storeName, 'readwrite')
              tx.objectStore(storeName).put('ok', 'probe-key')
              // The open/write stage completes ONLY when the transaction
              // commits; closing early would leave this promise unresolved.
              tx.oncomplete = () => resolveOpen()
              tx.onerror = () => reject(tx.error ?? new Error('write failed'))
              tx.onabort = () => reject(tx.error ?? new Error('write aborted'))
            } catch (error) {
              reject(error instanceof Error ? error : new Error('tx failed'))
            }
          }
          request.onerror = () => reject(request.error ?? new Error('open failed'))
          request.onblocked = () => reject(new Error('open blocked'))
        })
        closeQuietly()
        await new Promise<void>((resolve, reject) => {
          const request = idb.open(dbName, 1)
          request.onsuccess = () => {
            const db = request.result
            try {
              const tx = db.transaction(storeName, 'readonly')
              const read = tx.objectStore(storeName).get('probe-key')
              read.onsuccess = () => {
                db.close()
                if (read.result === 'ok') resolve()
                else reject(new Error('read/verify failed'))
              }
              read.onerror = () => reject(read.error ?? new Error('read failed'))
            } catch (error) {
              db.close()
              reject(error instanceof Error ? error : new Error('verify tx failed'))
            }
          }
          request.onerror = () => reject(request.error ?? new Error('reopen failed'))
        })
      } catch (error) {
        // Any failed round-trip stage must still drop this random diagnostic
        // database; only the strict deletion result below reports success.
        dropDatabaseQuietly()
        throw error
      } finally {
        closeQuietly()
        diagCleanups.length = 0
      }
      const deleted = await new Promise<boolean>((resolve) => {
        const request = idb.deleteDatabase(dbName)
        request.onsuccess = () => resolve(true)
        request.onerror = () => resolve(false)
        request.onblocked = () => resolve(false)
      })
      if (!deleted) throw new Error('diagnostic database cleanup failed (delete blocked or errored)')
      return true
    },
    () => {
      for (const cleanup of diagCleanups.splice(0, diagCleanups.length)) {
        try {
          cleanup()
        } catch {
          // Best-effort only.
        }
      }
    },
  )

  const serviceWorker = await tryProbe(async () => {
    const swContainer = (
      nav as Navigator & {
        serviceWorker?: {
          getRegistration?: () => Promise<ServiceWorkerRegistration | undefined>
          controller?: ServiceWorker | null
        }
      }
    ).serviceWorker
    if (!swContainer?.getRegistration) return 'unsupported'
    const registration = await swContainer.getRegistration()
    if (!registration) return 'supported-unregistered'
    // Query-free, filename-only script display; query-free pathname-only
    // scope. Nothing cross-origin or parameterised is ever shown or stored.
    const script = registration.active?.scriptURL ?? registration.installing?.scriptURL ?? 'unknown'
    const scriptPath = stripQuery(script).split('/').pop() ?? 'unknown'
    const controller = swContainer.controller ? 'controlled' : 'uncontrolled'
    return `registered · ${scriptPath} · scope ${scopePathname(registration.scope)} · ${controller}`
  })

  const cacheStorageRoundTrip = await tryProbe(async () => {
    const cachesRef = (win as Window & { caches?: CacheStorage }).caches
    if (!cachesRef) return 'unsupported'
    const name = `ownsay-diag-${opaqueCode(String(Date.now()))}`
    const cache = await cachesRef.open(name)
    await cache.put('/ownsay-diag-probe', new Response('ok'))
    const hit = await cache.match('/ownsay-diag-probe')
    const body = (await hit?.text()) ?? ''
    await cachesRef.delete(name)
    if (body !== 'ok') throw new Error('cache verify failed')
    return 'round-trip ok'
  })

  const shellCaches = await tryProbe(async () => {
    const cachesRef = (win as Window & { caches?: { keys?: () => Promise<string[]> } }).caches
    if (!cachesRef?.keys) return 'unsupported'
    const names = ((await cachesRef.keys()) as string[]) ?? []
    // Count only genuine production shell caches, never diagnostic ones.
    const ownsayShells = names.filter(
      (name) => /^ownsay-(?!diag)/i.test(name) || (/ownsay/i.test(name) && /precache/i.test(name)),
    )
    return ownsayShells.length > 0 ? `${ownsayShells.length} shell cache(s)` : 'none yet'
  })

  /** OwnSay's production shell precache (Workbox cacheId 'ownsay', see
   * vite.config.ts). Diagnostic caches are excluded so a generic round-trip
   * can never masquerade as shell evidence. */
  const isShellCacheName = (name: string): boolean =>
    /^ownsay-(?!diag)/i.test(name) || (/ownsay/i.test(name) && /precache/i.test(name))

  /**
   * Offline-ready evidence: an ACTIVE service worker controlling this page
   * PLUS a verified `/index.html` entry inside the app's own production shell
   * cache. Each ownsay-named cache is opened and searched individually so a
   * hit can never come from an unrelated cache.
   */
  const shellCacheVerified = await tryProbe(async () => {
    const cachesRef = win.caches as CacheStorage | undefined
    if (!cachesRef?.keys || !cachesRef.open) return false
    const names = ((await cachesRef.keys()) as string[]) ?? []
    for (const name of names.filter(isShellCacheName)) {
      try {
        const shellCache = await cachesRef.open(name)
        const hit = await shellCache.match('/index.html')
        if (hit) return true
      } catch {
        // Try the next candidate cache.
      }
    }
    return false
  })

  const estimate = await tryProbe(async () => {
    if (!nav.storage?.estimate) return 'not exposed'
    const result = await nav.storage.estimate()
    const quotaMb = result.quota ? Math.round(result.quota / (1024 * 1024)) : null
    const usageMb = result.usage ? Math.round(result.usage / (1024 * 1024)) : null
    return quotaMb !== null ? `≈${usageMb ?? '?'} MB used of ≈${quotaMb} MB quota` : 'not exposed'
  })

  const persisted = await tryProbe(async () => {
    if (!nav.storage?.persisted) return false
    return nav.storage.persisted()
  })

  const audioSupport = trySync(() => {
    if (typeof Audio !== 'function') return null
    const element = new Audio()
    return {
      mp3: element.canPlayType('audio/mpeg') || '',
      wav: element.canPlayType('audio/wav') || element.canPlayType('audio/x-wav') || '',
    }
  })

  const graphics = trySync(() => {
    const canvas = env.document.createElement('canvas')
    const gl2 = canvas.getContext('webgl2')
    const gl1 = gl2 ? null : canvas.getContext('webgl')
    const lose = (context: unknown) => {
      ;(context as { loseContext?: () => void } | null)?.loseContext?.()
    }
    const webgl2Ok = Boolean(gl2)
    if (gl2) lose(gl2)
    if (gl1) lose(gl1)
    return { webgl2: webgl2Ok, webgl1: webgl2Ok || Boolean(gl1) }
  })

  const webgpuAdapterAndDevice = await tryProbe(async () => {
    const gpu = (
      nav as Navigator & {
        gpu?: {
          requestAdapter?: () => Promise<unknown>
        }
      }
    ).gpu
    if (!gpu?.requestAdapter) return 'absent'
    let timer: ReturnType<typeof setTimeout> | undefined
    const adapter = (await Promise.race([
      gpu.requestAdapter(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), WEBGPU_PROBE_TIMEOUT_MS)
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer)
    })) as { requestDevice?: () => Promise<unknown>; destroy?: () => unknown } | null
    if (!adapter) return 'no adapter returned'
    if (!adapter.requestDevice) return 'adapter without device support'
    let deviceTimer: ReturnType<typeof setTimeout> | undefined
    const device = (await Promise.race([
      adapter.requestDevice(),
      new Promise<null>((resolve) => {
        deviceTimer = setTimeout(() => resolve(null), WEBGPU_PROBE_TIMEOUT_MS)
      }),
    ]).finally(() => {
      if (deviceTimer) clearTimeout(deviceTimer)
    })) as { destroy?: () => void } | null
    try {
      device?.destroy?.()
    } catch {
      // Best-effort disposal.
    }
    return device ? 'adapter and device obtained (capability evidence only)' : 'device creation failed'
  })

  const voices = trySync(() => {
    const synth = win.speechSynthesis
    if (!synth) return { present: false, list: [] as Array<{ lang: string; localService: boolean; default: boolean }> }
    const list = (synth.getVoices() ?? []).map((voice) => ({
      lang: voice.lang,
      localService: voice.localService,
      default: voice.default,
    }))
    return { present: true, list }
  })
  const voiceList = !('error' in voices) ? voices.value.list : []
  const localVoiceList = voiceList.filter((voice) => voice.localService === true)
  const defaultVoice = voiceList.find((voice) => voice.default)

  // Shareable evidence keeps ORIGINS ONLY: no paths, no query strings, no
  // cross-origin path leakage — just protocol//host pairs, deduplicated.
  const resourceOrigins = trySync(() => {
    const entries = perf?.getEntriesByType?.('resource') ?? []
    const origins = new Set<string>()
    for (const entry of entries) {
      const origin = originOnly(entry.name)
      if (origin) origins.add(origin)
    }
    return [...origins].slice(0, 12)
  })

  const vv = win.visualViewport
  const orientation = trySync(() => (win.screen as Screen & { orientation?: { type?: string } }).orientation?.type ?? null)
  const maxTouchPoints = trySync(() => nav.maxTouchPoints ?? null)

  const firePolicy = /\bKFQUWI\b/.test(nav.userAgent ?? '')

  const report: DeviceCheckReport = {
    generatedAtUtc: new Date().toISOString(),
    appVersion: APP_VERSION,
    summary: {
      core: 'ready',
      savedLocally: 'failed',
      offlineShell: 'online-only',
      speech: 'text-only',
      localHelper: 'unavailable',
    },
    browser: {
      userAgent: nav.userAgent ?? '',
      platform: nav.platform ?? '',
      online: nav.onLine === true,
      languages: Array.isArray(nav.languages) ? [...nav.languages].slice(0, 6) : [],
      secureContext: !('error' in secureContext) ? secureContext.value : null,
      fireDevicePolicy: firePolicy,
    },
    display: {
      screen: `${win.screen?.width ?? '?'}×${win.screen?.height ?? '?'}`,
      screenAvailable:
        win.screen?.availWidth != null ? `${win.screen.availWidth}×${win.screen.availHeight}` : null,
      innerViewport: `${win.innerWidth}×${win.innerHeight}`,
      visualViewport: vv ? `${Math.round(vv.width)}×${Math.round(vv.height)}` : null,
      visualViewportScale: vv ? vv.scale : null,
      orientationType: !('error' in orientation) ? orientation.value : null,
      devicePixelRatio: win.devicePixelRatio ?? 0,
      maxTouchPoints: !('error' in maxTouchPoints) ? maxTouchPoints.value : null,
      reducedMotion: !('error' in reducedMotion) ? reducedMotion.value : null,
      forcedColors: !('error' in forcedColors) ? forcedColors.value : null,
    },
    hardware: {
      hardwareConcurrency: nav.hardwareConcurrency ?? null,
      deviceMemoryGb: (nav as Navigator & { deviceMemory?: number }).deviceMemory ?? null,
    },
    storage: {
      indexedDbRoundTrip,
      serviceWorker,
      cacheStorageRoundTrip,
      shellCaches,
      shellCacheVerified,
      estimate,
      persisted,
    },
    media: {
      mp3: !('error' in audioSupport) ? audioSupport.value?.mp3 ?? null : null,
      wav: !('error' in audioSupport) ? audioSupport.value?.wav ?? null : null,
    },
    graphics: {
      webgl2: !('error' in graphics) && graphics.value.webgl2,
      webgl1: !('error' in graphics) && graphics.value.webgl1,
      webgpuAdapterAndDevice,
    },
    speechCapability: {
      synthesisPresent: !('error' in voices) && voices.value.present,
      localVoiceCount: !('error' in voices) && voices.value.present ? localVoiceList.length : null,
      voiceCount: !('error' in voices) && voices.value.present ? voiceList.length : null,
      enGbVoices: !('error' in voices) ? voiceList.filter((voice) => /^en-gb/i.test(voice.lang)).length : null,
      englishVoices: !('error' in voices) ? voiceList.filter((voice) => /^en/i.test(voice.lang)).length : null,
      defaultVoiceLang: defaultVoice?.lang ?? null,
      defaultVoiceLocal: defaultVoice?.localService ?? null,
    },
    resourceOrigins: !('error' in resourceOrigins) ? resourceOrigins.value : [],
  }

  report.summary = classify(report)
  return report
}
