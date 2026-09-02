import { GENERATION_TIMEOUT_MS, type ModelInput } from '../domain/policy'
import { buildDeterministicSuggestions } from '../domain/suggestions'
import type { AuthoredToken, DemoPreferences, HelperStatus, Suggestion } from '../domain/types'
import { buildRankingContext } from './prompt'
import { parseChosenCandidates } from '../domain/candidates'
import type { ChatEngine } from './webllm-loader'

export interface InferenceResult {
  suggestions: Suggestion[]
  status: HelperStatus
  usedModel: boolean
}

type ProgressFn = (text: string) => void
type EngineLoader = (onProgress?: ProgressFn, signal?: AbortSignal) => Promise<ChatEngine>

/**
 * Interrupt handle for the one generation that may be in flight. The runtime's
 * interrupt signal is sticky: calling interruptGenerate() while no request is
 * running would poison the next first generation ("Message error should not be
 * 0"). Ownership therefore lives here — an engine is interrupted only while a
 * generation it started has not finished, and the handle is cleared
 * synchronously the moment cancellation or completion happens.
 */
let activeGenerationInterrupt: (() => void) | null = null

let engine: ChatEngine | null = null
let loadPromise: Promise<ChatEngine> | null = null
let lifecycleVersion = 0
/** Owns the in-flight loader so a stalled/cancelled activation can terminate its worker. */
let activeActivationAbort: AbortController | null = null

const defaultEngineLoader: EngineLoader = async (onProgress, signal) => {
  const { loadWebLlmEngine } = await import('./webllm-loader')
  return loadWebLlmEngine(onProgress, signal)
}

// Unit suites substitute the engine by mocking the './webllm-loader' module
// itself, so no fake loader or engine can be injected outside a test runtime.
let engineLoader: EngineLoader = defaultEngineLoader

function reportAutomationDiagnostic(label: string, detail: unknown): void {
  if (typeof navigator === 'undefined' || !navigator.webdriver) return
  const value = detail instanceof Error ? `${detail.name}: ${detail.message}` : String(detail)
  console.warn(`[OwnSay QA] ${label}: ${value.slice(0, 800)}`)
}

function releaseEngine(target: ChatEngine | null): void {
  if (!target) return
  const releaser = target.dispose ?? target.unload
  if (!releaser) return
  try {
    void releaser.call(target).catch(() => {
      // Resource release is best-effort; the deterministic board is unaffected.
    })
  } catch {
    // A synchronous disposal failure must not affect deterministic communication.
  }
}

function resetEngine(next: ChatEngine | null = null): void {
  lifecycleVersion += 1
  // Any in-flight loader is told to stop NOW: its worker terminates even if
  // the runtime promise would never resolve on its own.
  activeActivationAbort?.abort()
  activeActivationAbort = null
  const previous = engine
  engine = next
  loadPromise = null
  activeGenerationInterrupt = null
  if (previous !== next) releaseEngine(previous)
}

function hasWebGpu(): boolean {
  return typeof navigator !== 'undefined' && 'gpu' in navigator && Boolean(navigator.gpu)
}

/**
 * Conservative known-device policy: this exact Fire tablet class cannot run
 * the local helper, so setup is refused BEFORE any runtime import, worker
 * creation, GPU request or model fetch. The AAC core never consults the UA.
 */
export function isKnownUnsupportedDevice(ua: string = typeof navigator === 'undefined' ? '' : navigator.userAgent): boolean {
  return /\bKFQUWI\b/.test(ua)
}

export type WebGpuProbe =
  | 'absent'
  | 'failed'
  | 'device-failed'
  | 'device-policy'
  | 'ok'

/**
 * Capability preflight: a mere `navigator.gpu` property is NOT a readiness
 * result. Requires a bounded `requestAdapter()` AND a bounded, successful
 * `adapter.requestDevice()`, disposing the diagnostic device afterwards.
 * Runs only after an explicit carer action and always before any import.
 */
export const WEBGPU_PROBE_TIMEOUT_MS = 4_000

interface ProbeAdapterLike {
  requestDevice?: () => Promise<unknown>
  destroy?: () => unknown
}

export async function probeWebGpuSupport(timeoutMs: number = WEBGPU_PROBE_TIMEOUT_MS): Promise<WebGpuProbe> {
  if (isKnownUnsupportedDevice()) return 'device-policy'
  if (!hasWebGpu()) return 'absent'
  try {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter?: () => Promise<unknown> } }).gpu
    if (!gpu?.requestAdapter) return 'absent'

    let timer: ReturnType<typeof setTimeout> | undefined
    const adapter = (await Promise.race([
      gpu.requestAdapter(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs)
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer)
    })) as ProbeAdapterLike | null

    if (!adapter) return 'failed'

    // Adapter presence alone is not "ok": a real device must be creatable.
    if (!adapter.requestDevice) return 'device-failed'
    let deviceTimer: ReturnType<typeof setTimeout> | undefined
    const device = await Promise.race([
      adapter.requestDevice(),
      new Promise<null>((resolve) => {
        deviceTimer = setTimeout(() => resolve(null), timeoutMs)
      }),
    ]).finally(() => {
      if (deviceTimer) clearTimeout(deviceTimer)
    })
    // Dispose the diagnostic device when the API allows it.
    try {
      ;(device as { destroy?: () => void } | null)?.destroy?.()
    } catch {
      // Disposal is best-effort.
    }
    if (!device) return 'device-failed'
    return 'ok'
  } catch {
    return 'failed'
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout?: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          onTimeout?.()
          reject(new Error('timeout'))
        }, ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function loadEngine(onProgress?: ProgressFn): Promise<ChatEngine> {
  if (engine) return engine
  if (engineLoader === defaultEngineLoader && !hasWebGpu()) throw new Error('webgpu-unavailable')

  const version = lifecycleVersion
  if (!loadPromise) {
    // Fresh activation owns a fresh abort controller; resetEngine() fires it.
    activeActivationAbort?.abort()
    activeActivationAbort = new AbortController()
    loadPromise = engineLoader(onProgress, activeActivationAbort.signal)
  }

  const pending = loadPromise
  let loaded: ChatEngine
  try {
    loaded = await pending
  } catch (error) {
    if (loadPromise === pending) loadPromise = null
    throw error
  }
  if (version !== lifecycleVersion || loadPromise !== pending) {
    // Activation was cancelled or superseded mid-download: dispose what just
    // arrived (this terminates the worker thread) instead of adopting it.
    releaseEngine(loaded)
    throw new Error('activation-cancelled')
  }
  // Adoption completes this activation's ownership window.
  if (activeActivationAbort && loadPromise === pending) activeActivationAbort = null
  engine = loaded
  return loaded
}

/**
 * A healthy activation emits progress continuously: shard-by-shard downloads
 * and cache loads each report. If the runtime goes completely silent for this
 * long — a hung worker, a lost GPU device, a wedged shader compile — the
 * activation is abandoned into the recoverable unavailable state instead of
 * leaving a child's carer staring at "Downloading" forever. The timer restarts
 * on every progress callback, so genuinely slow networks are never punished.
 */
export const PROGRESS_STALL_MS = 120_000

export async function activateLocalHelper(onProgress?: ProgressFn): Promise<HelperStatus> {
  const version = lifecycleVersion
  let lastProgressAt = Date.now()
  let stalled = false
  const watchdog = setInterval(() => {
    if (Date.now() - lastProgressAt > PROGRESS_STALL_MS) stalled = true
  }, 2_000)
  const guardedProgress: ProgressFn = (text) => {
    lastProgressAt = Date.now()
    onProgress?.(text)
  }

  const sleep = (ms: number) => new Promise<'tick'>((resolve) => setTimeout(resolve, ms))
  let selfAbandoned = false

  try {
    // A rejected abandonment must never become an unhandled rejection.
    const settled = loadEngine(guardedProgress).then(
      () => 'done' as const,
      () => 'failed' as const,
    )
    while (version === lifecycleVersion) {
      const result = await Promise.race([settled, sleep(2_000)])
      if (result === 'done') return version === lifecycleVersion ? 'ready' : 'off'
      if (result === 'failed') {
        if (version !== lifecycleVersion) return 'off'
        engine = null
        loadPromise = null
        return 'unavailable'
      }
      if (stalled) {
        selfAbandoned = true
        break
      }
    }
    // Stalled out or superseded mid-load: abandon deterministically. Any late
    // engine is disposed by loadEngine's own lifecycle check.
    resetEngine()
    return !selfAbandoned && version !== lifecycleVersion ? 'off' : 'unavailable'
  } finally {
    clearInterval(watchdog)
  }
}

export function deactivateLocalHelper(): void {
  cancelActiveGeneration()
  resetEngine()
}

/**
 * Stops avoidable local compute when the message or tailoring context changes.
 * Only a generation that is currently in flight is interrupted; idle engines
 * are left untouched so their next first generation cannot hit the runtime's
 * stale-interrupt path.
 */
export function cancelActiveGeneration(): void {
  const interrupt = activeGenerationInterrupt
  activeGenerationInterrupt = null
  interrupt?.()
}

function mergeWithInstantBackup(model: Suggestion[], fallback: Suggestion[]): Suggestion[] {
  const seen = new Set(model.map((suggestion) => suggestion.tokens.map((token) => token.id).join(' ')))
  const instant = fallback.filter((suggestion) => {
    const key = suggestion.tokens.map((token) => token.id).join(' ')
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return [...model, ...instant].slice(0, 4)
}

interface StreamChunk {
  choices?: Array<{ delta?: { content?: string }; message?: { content?: string } }>
}

async function consumeStreamingCompletion(
  stream: AsyncIterable<StreamChunk> | Promise<AsyncIterable<StreamChunk>>,
): Promise<string> {
  const iterator = await stream
  let text = ''
  for await (const chunk of iterator) {
    text += chunk.choices?.[0]?.delta?.content ?? ''
  }
  return text
}

export async function generateSuggestions(
  prefs: DemoPreferences,
  message: readonly AuthoredToken[],
  input: ModelInput,
  status: HelperStatus,
  instantFallback?: Suggestion[],
): Promise<InferenceResult> {
  const fallbackRows = instantFallback ?? buildDeterministicSuggestions(prefs, message)

  if (status !== 'ready') {
    return { suggestions: fallbackRows, status, usedModel: false }
  }

  // The engine captured at call time. If it is swapped or cleared while the
  // request is in flight (helper turned off, new download), the result is void.
  const activeEngine = engine

  if (!activeEngine) {
    return { suggestions: fallbackRows, status: 'unavailable', usedModel: false }
  }

  // Bounded rank-and-select: the model only ever returns candidate IDs from
  // this pool. Free-token composition is physically impossible.
  const ranking = buildRankingContext(input)
  if (ranking.pool.candidates.length === 0) {
    // No sensible candidates for this context: honest degraded state.
    return { suggestions: fallbackRows, status: 'degraded', usedModel: false }
  }

  const interruptThisGeneration = () => {
    try {
      void Promise.resolve(activeEngine.interruptGenerate?.()).catch(() => {
        // Interruption is best-effort. Sequence checks still reject stale output.
      })
    } catch {
      // A synchronous interruption failure must not affect the board.
    }
  }
  activeGenerationInterrupt = interruptThisGeneration

  try {
    // Keep creation inside the guarded lifecycle as runtimes may throw before
    // returning a promise (for example after a worker or GPU device loss).
    // Streaming completions reset the runtime's sticky interrupt signal at
    // the start of every stream.
    const streamPromise = activeEngine.chat.completions.create({
      messages: [
        { role: 'system', content: 'Choose candidate IDs for an AAC board. Answer with JSON only.' },
        { role: 'user', content: ranking.prompt },
      ],
      temperature: 0,
      max_tokens: 48,
      stream: true,
      response_format: {
        type: 'json_object',
        schema: ranking.schema,
      },
    })
    const text = await withTimeout(
      consumeStreamingCompletion(streamPromise),
      GENERATION_TIMEOUT_MS,
      () => {
        if (activeGenerationInterrupt === interruptThisGeneration) interruptThisGeneration()
      },
    )
    if (engine !== activeEngine) {
      return { suggestions: fallbackRows, status: 'off', usedModel: false }
    }
    const { chosen } = parseChosenCandidates(extractJsonObject(text), ranking.pool)
    if (chosen.length === 0) {
      reportAutomationDiagnostic('model selection rejected', text || '(empty response)')
      // Honest degraded state: the ranking produced nothing usable, so the
      // dock falls back to instant phrases and never labels them as OwnSay.
      return { suggestions: fallbackRows, status: 'degraded', usedModel: false }
    }
    const modelRows = chosen.map((candidate) => ({
      id: `local-model:${candidate.id}:${candidate.tokens.map((token) => token.id).join(' ')}`,
      tokens: candidate.tokens.map((token) => ({ ...token })),
      source: 'local-model' as const,
    }))
    return {
      suggestions: mergeWithInstantBackup(modelRows, fallbackRows),
      status: 'ready',
      usedModel: true,
    }
  } catch (error) {
    reportAutomationDiagnostic('model generation failed', error)
    if (engine !== activeEngine) {
      return { suggestions: fallbackRows, status: 'off', usedModel: false }
    }
    return { suggestions: fallbackRows, status: 'degraded', usedModel: false }
  } finally {
    if (activeGenerationInterrupt === interruptThisGeneration) activeGenerationInterrupt = null
  }
}

/** Extracts the outermost JSON object from a possibly chatty completion. */
function extractJsonObject(raw: string): unknown {
  const trimmed = raw.trim()
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    return JSON.parse(trimmed.slice(start, end + 1)) as unknown
  } catch {
    return null
  }
}
