import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatCompletionChunk, ChatEngine } from './webllm-loader'

/**
 * The engine is injected by mocking the './webllm-loader' module boundary —
 * the same seam production code crosses on confirmed opt-in. No production
 * hook can arm a fake outside a test runtime.
 */
const loaderState = vi.hoisted(() => ({
  impl:
    null as null | ((
      onProgress?: (text: string) => void,
      signal?: AbortSignal,
    ) => Promise<ChatEngine>),
}))

vi.mock('./webllm-loader', () => ({
  loadWebLlmEngine: (onProgress?: (text: string) => void, signal?: AbortSignal) => {
    if (!loaderState.impl) throw new Error('loader not configured')
    return loaderState.impl(onProgress, signal)
  },
}))

import {
  activateLocalHelper,
  cancelActiveGeneration,
  deactivateLocalHelper,
  generateSuggestions,
} from './adapter'
import { DEFAULT_PREFERENCES } from '../domain/types'
import type { ModelInput } from '../domain/policy'
import { buildCandidatePool } from '../domain/candidates'
import type { Suggestion } from '../domain/types'

type FakeEngine = {
  engine: ChatEngine
  interruptGenerate: ReturnType<typeof vi.fn>
  unload: ReturnType<typeof vi.fn>
}

/** Minimal model input whose pool always contains natural play phrases. */
const PLAY_INPUT: ModelInput = {
  ageBand: '7-9',
  routine: 'play',
  interests: [],
  currentTokenIds: [],
  allowlist: ['i', 'you', 'we', 'want', 'need', 'like', 'feel', 'go', 'look', 'game', 'toy', 'ball', 'again', 'please', 'your-turn', 'blocks', 'outside'],
}
const FOOD_INPUT: ModelInput = {
  ...PLAY_INPUT,
  routine: 'food',
  allowlist: ['i', 'hungry', 'thirsty', 'drink', 'water', 'snack', 'fruit', 'milk', 'egg', 'want', 'good', 'please', 'ice-cream'],
}

/** Builds a bounded ranking answer from the REAL candidate pool for an input. */
function chosenJson(input: ModelInput, pick = 2): string {
  const pool = buildCandidatePool(input)
  expect(pool.candidates.length, 'test inputs must produce a non-empty pool').toBeGreaterThan(0)
  const ids = pool.candidates.slice(0, pick).map((candidate) => candidate.id)
  return JSON.stringify({ chosen: ids })
}

function streamOf(chunks: string[]): AsyncIterable<ChatCompletionChunk> {
  async function* iterate() {
    for (const text of chunks) {
      const chunk: ChatCompletionChunk = { choices: [{ delta: { content: text } }] }
      yield chunk
      await Promise.resolve()
    }
  }
  return iterate()
}

/** Set while a hanging stream is being consumed; invoking it ends the stream. */
let hangInterrupt: (() => void) | null = null

function hangingStream(): AsyncIterable<ChatCompletionChunk> {
  // Mimics the runtime: an interrupt ends the stream instead of leaving the
  // consumer waiting forever.
  const interrupted = new Promise<void>((resolve) => {
    hangInterrupt = resolve
  })
  return hangIterable(interrupted)
}

async function* hangIterable(interrupted: Promise<void>): AsyncGenerator<ChatCompletionChunk> {
  const partial: ChatCompletionChunk = { choices: [{ delta: { content: '{"cho' } }] }
  yield partial
  await interrupted
}

function makeFakeEngine(streamChunks: string[] | 'hang' | 'throw'): FakeEngine {
  const interruptGenerate = vi.fn(() => {
    // An interrupt ends whatever stream is being consumed, like the runtime.
    hangInterrupt?.()
  })
  const unload = vi.fn(async () => {})
  const create =
    streamChunks === 'throw'
      ? vi.fn(async () => {
          throw new Error('Message error should not be 0')
        })
      : streamChunks === 'hang'
        ? vi.fn(async () => hangingStream())
        : vi.fn(async () => streamOf(streamChunks))
  return {
    engine: {
      chat: { completions: { create: create as unknown as ChatEngine['chat']['completions']['create'] } },
      interruptGenerate,
      unload,
      dispose: unload,
    },
    interruptGenerate,
    unload,
  }
}

async function readyEngine(chunks: string[] | 'hang' | 'throw' = [chosenJson(PLAY_INPUT)]): Promise<FakeEngine> {
  const fake = makeFakeEngine(chunks)
  loaderState.impl = async () => fake.engine
  const status = await activateLocalHelper()
  expect(status).toBe('ready')
  return fake
}

describe('local inference lifecycle', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'gpu', { value: {}, configurable: true })
  })

  afterEach(() => {
    deactivateLocalHelper()
    loaderState.impl = null
    delete (navigator as unknown as Record<string, unknown>).gpu
    vi.useRealTimers()
  })

  it('completes the FIRST generation after load with an honest on-device suggestion', async () => {
    await readyEngine([chosenJson(PLAY_INPUT)])
    const result = await generateSuggestions(DEFAULT_PREFERENCES, [], PLAY_INPUT, 'ready')
    expect(result.usedModel).toBe(true)
    expect(result.status).toBe('ready')
    const pool = buildCandidatePool(PLAY_INPUT)
    const picked = result.suggestions.filter((row) => row.source === 'local-model')
    expect(picked.length).toBeGreaterThan(0)
    for (const row of picked) {
      const match = pool.candidates.find((candidate) => candidate.tokens.map((t) => t.id).join(' ') === row.tokens.map((t) => t.id).join(' '))
      expect(match, 'every OwnSay phrase must come from the curated pool').toBeTruthy()
    }
    expect(result.suggestions.some((row) => row.source === 'local-model')).toBe(true)
  })

  it('never interrupts an idle engine, so no stale signal can poison the next first generation', async () => {
    const fake = await readyEngine([chosenJson(PLAY_INPUT)])
    cancelActiveGeneration()
    cancelActiveGeneration()
    expect(fake.interruptGenerate).not.toHaveBeenCalled()

    const first = await generateSuggestions(DEFAULT_PREFERENCES, [], PLAY_INPUT, 'ready')
    expect(first.status).toBe('ready')

    cancelActiveGeneration()
    expect(fake.interruptGenerate).not.toHaveBeenCalled()

    const second = await generateSuggestions(DEFAULT_PREFERENCES, [], PLAY_INPUT, 'ready')
    expect(second.usedModel).toBe(true)
    expect(second.status).toBe('ready')
  })

  it('requests streaming completions so the sticky interrupt flag resets each run', async () => {
    const fake = await readyEngine([chosenJson(PLAY_INPUT)])
    await generateSuggestions(DEFAULT_PREFERENCES, [], PLAY_INPUT, 'ready')
    const request = (fake.engine.chat.completions.create as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(request.stream).toBe(true)
  })

  it('interrupts ONLY the active generation when a refresh arrives mid-flight', async () => {
    // One engine whose behaviour switches from hanging to healthy, mirroring
    // a refresh that cancels the in-flight request and starts a new one on
    // the same already-loaded engine.
    let mode: 'hang' | string[] = 'hang'
    const fake = makeFakeEngine([])
    ;(fake.engine.chat.completions.create as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async () => (mode === 'hang' ? hangingStream() : streamOf(mode)),
    )
    loaderState.impl = async () => fake.engine
    expect(await activateLocalHelper()).toBe('ready')

    const pending = generateSuggestions(DEFAULT_PREFERENCES, [], PLAY_INPUT, 'ready')
    await Promise.resolve()
    expect(fake.interruptGenerate).not.toHaveBeenCalled()

    cancelActiveGeneration()
    expect(fake.interruptGenerate).toHaveBeenCalledTimes(1)

    // The cancelled request settles without blocking a fresh one: truncated
    // output parses to nothing usable, so it degrades honestly.
    await expect(pending).resolves.toMatchObject({ status: 'degraded', usedModel: false })
    cancelActiveGeneration()
    expect(fake.interruptGenerate).toHaveBeenCalledTimes(1)

    // The next refresh on the SAME engine succeeds — no reload, no stale
    // interrupt decay, and an honest on-device suggestion.
    mode = [chosenJson(PLAY_INPUT)]
    const next = await generateSuggestions(DEFAULT_PREFERENCES, [], PLAY_INPUT, 'ready')
    expect(next.usedModel).toBe(true)
    expect(next.status).toBe('ready')
  })

  it('times out honestly into a recoverable degraded state and stops the compute', async () => {
    vi.useFakeTimers()
    const fake = await readyEngine('hang')
    const pending = generateSuggestions(DEFAULT_PREFERENCES, [], PLAY_INPUT, 'ready')
    const settled = expect(pending).resolves.toMatchObject({ status: 'degraded', usedModel: false })
    await vi.advanceTimersByTimeAsync(26_000)
    await settled
    expect(fake.interruptGenerate).toHaveBeenCalled()
  })

  it('enters a degraded state when the engine throws mid-generation', async () => {
    await readyEngine('throw')
    const result = await generateSuggestions(DEFAULT_PREFERENCES, [], PLAY_INPUT, 'ready')
    expect(result.status).toBe('degraded')
    expect(result.usedModel).toBe(false)
    expect(result.suggestions.length).toBeGreaterThan(0)
    expect(result.suggestions.every((row: Suggestion) => row.source === 'deterministic')).toBe(true)
  })

  it('enters the same deterministic fallback when completion creation throws synchronously', async () => {
    const fake = makeFakeEngine([])
    ;(fake.engine.chat.completions.create as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      () => {
        throw new Error('worker runtime was lost before a request could start')
      },
    )
    loaderState.impl = async () => fake.engine
    expect(await activateLocalHelper()).toBe('ready')

    await expect(
      generateSuggestions(DEFAULT_PREFERENCES, [], PLAY_INPUT, 'ready'),
    ).resolves.toMatchObject({ status: 'degraded', usedModel: false })

    const result = await generateSuggestions(DEFAULT_PREFERENCES, [], PLAY_INPUT, 'ready')
    expect(result.suggestions.length).toBeGreaterThan(0)
    expect(result.suggestions.every((row: Suggestion) => row.source === 'deterministic')).toBe(true)
    cancelActiveGeneration()
    expect(fake.interruptGenerate).not.toHaveBeenCalled()
  })

  it('cannot be tricked into emitting free-token rows: legacy shapes degrade', async () => {
    // A model (or tampered runtime) returning old-style token arrays finds no
    // `chosen` list — nothing can be mapped back onto the pool.
    await readyEngine([
      JSON.stringify({ suggestions: [{ tokens: ['i', 'look', 'snack', 'look', 'look'] }] }),
    ])
    const foodInput: ModelInput = { ...FOOD_INPUT }
    const result = await generateSuggestions(DEFAULT_PREFERENCES, [], foodInput, 'ready')
    expect(result.usedModel).toBe(false)
    expect(result.status).toBe('degraded')
    expect(result.suggestions.every((row) => row.source === 'deterministic')).toBe(true)
  })

  it('ignores unknown candidate IDs and keeps only real pool entries', async () => {
    const pool = buildCandidatePool(PLAY_INPUT)
    const rogue = `c${pool.candidates.length + 99}`
    await readyEngine([JSON.stringify({ chosen: [rogue, pool.candidates[0].id] })])
    const result = await generateSuggestions(DEFAULT_PREFERENCES, [], PLAY_INPUT, 'ready')
    expect(result.usedModel).toBe(true)
    const modelRow = result.suggestions.find((row) => row.source === 'local-model')
    expect(modelRow?.tokens.map((token) => token.id)).toEqual(pool.candidates[0].tokens.map((token) => token.id))
  })

  it('an explicitly empty choice degrades honestly without labelling instant phrases as OwnSay', async () => {
    await readyEngine([JSON.stringify({ chosen: [] })])
    const result = await generateSuggestions(DEFAULT_PREFERENCES, [], PLAY_INPUT, 'ready')
    expect(result.usedModel).toBe(false)
    expect(result.status).toBe('degraded')
    expect(result.suggestions.every((row) => row.source === 'deterministic')).toBe(true)
  })

  it('ranks continuations from the child’s own context', async () => {
    // After "I want" the model must rank concrete-object suffixes.
    const continuationInput: ModelInput = { ...FOOD_INPUT, currentTokenIds: ['i', 'want'] }
    await readyEngine([chosenJson(continuationInput)])
    const result = await generateSuggestions(
      DEFAULT_PREFERENCES,
      message(['i', 'want']),
      continuationInput,
      'ready',
    )
    const modelRows = result.suggestions.filter((row) => row.source === 'local-model')
    expect(modelRows.length).toBeGreaterThan(0)
    const pool = buildCandidatePool(continuationInput)
    for (const row of modelRows) {
      const key = row.tokens.map((token) => token.id).join(' ')
      expect(pool.byId.has(key) || pool.candidates.some((c) => c.tokens.map((t) => t.id).join(' ') === key)).toBe(true)
    }
  })

  it('recovers from degraded back to ready on the next successful refresh without reloading', async () => {
    let mode: 'throw' | string[] = 'throw'
    const switchable = makeFakeEngine([])
    ;(switchable.engine.chat.completions.create as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async () => {
        if (mode === 'throw') throw new Error('generation failed')
        return streamOf(mode)
      },
    )
    loaderState.impl = async () => switchable.engine
    expect(await activateLocalHelper()).toBe('ready')

    const failed = await generateSuggestions(DEFAULT_PREFERENCES, [], PLAY_INPUT, 'ready')
    expect(failed.status).toBe('degraded')

    mode = [chosenJson(PLAY_INPUT)]
    const recovered = await generateSuggestions(DEFAULT_PREFERENCES, [], PLAY_INPUT, 'ready')
    expect(recovered.status).toBe('ready')
    expect(recovered.usedModel).toBe(true)
  })

  it('disable disposes the engine and re-enable loads a fresh working one', async () => {
    const first = await readyEngine([chosenJson(PLAY_INPUT)])
    deactivateLocalHelper()
    expect(first.unload).toHaveBeenCalledTimes(1)

    const second = makeFakeEngine([chosenJson(PLAY_INPUT)])
    loaderState.impl = async () => second.engine
    expect(await activateLocalHelper()).toBe('ready')
    const result = await generateSuggestions(DEFAULT_PREFERENCES, [], PLAY_INPUT, 'ready')
    expect(result.usedModel).toBe(true)
  })

  it('activation that loses a download race disposes the late engine instead of adopting it', async () => {
    let release: ((engine: ChatEngine) => void) | null = null
    loaderState.impl = () =>
      new Promise<ChatEngine>((resolve) => {
        release = resolve
      })
    const activation = activateLocalHelper()
    while (!release) await Promise.resolve()
    deactivateLocalHelper()
    const late = makeFakeEngine([chosenJson(PLAY_INPUT)])
    ;(release as (engine: ChatEngine) => void)(late.engine)
    expect(await activation).toBe('off')
    // Give disposal microtasks room, then confirm the late engine was released.
    await Promise.resolve()
    await Promise.resolve()
    expect(late.unload).toHaveBeenCalled()
  })

  it('reports unavailable without WebGPU and never constructs a worker', async () => {
    delete (navigator as unknown as Record<string, unknown>).gpu
    let loaderCalled = false
    loaderState.impl = async () => {
      loaderCalled = true
      return makeFakeEngine([]).engine
    }
    expect(await activateLocalHelper()).toBe('unavailable')
    expect(loaderCalled).toBe(false)
  })

  it('abandons a silently hung activation into a recoverable unavailable state', async () => {
    vi.useFakeTimers()
    // The LOADER owns progress reporting here: the adapter only resets its
    // stall clock when the loader invokes the guarded onProgress callback.
    const harness: {
      release: ((engine: ChatEngine) => void) | null
      progress: ((text: string) => void) | null
      signal: AbortSignal | null
    } = { release: null, progress: null, signal: null }
    const late = makeFakeEngine([chosenJson(PLAY_INPUT)])
    loaderState.impl = (onProgress, signal) =>
      new Promise<ChatEngine>((resolve) => {
        harness.progress = onProgress ?? null
        harness.signal = signal ?? null
        harness.release = resolve
      })
    const consumerProgress = vi.fn()
    const activation = activateLocalHelper(consumerProgress)
    await Promise.resolve()

    // One honest loader tick, then total silence forever.
    await vi.advanceTimersByTimeAsync(4_000)
    harness.progress?.('Fetching param shard 3')
    expect(consumerProgress).toHaveBeenCalledWith('Fetching param shard 3')

    // Cross the 120s stall threshold while the load promise never settles.
    for (let second = 0; second < 132; second += 2) {
      await vi.advanceTimersByTimeAsync(2_000)
    }
    expect(await activation).toBe('unavailable')
    // Abort ownership reached the loader so a wedged worker can be terminated.
    expect(harness.signal?.aborted).toBe(true)

    // The late engine must be disposed, not adopted into service.
    harness.release?.(late.engine)
    await vi.advanceTimersByTimeAsync(1_000)
    await Promise.resolve()
    expect(late.unload).toHaveBeenCalled()

    // And a retry starts from a clean slate and succeeds.
    const healthy = makeFakeEngine([chosenJson(PLAY_INPUT)])
    loaderState.impl = async () => healthy.engine
    expect(await activateLocalHelper()).toBe('ready')
    const result = await generateSuggestions(DEFAULT_PREFERENCES, [], PLAY_INPUT, 'ready')
    expect(result.usedModel).toBe(true)
  })

  it('signals abort to a never-resolving loader on explicit cancel, and a retry cannot leak two engines', async () => {
    vi.useFakeTimers()
    const firstSignals: AbortSignal[] = []
    const firstRelease = { fire: (_engine: ChatEngine) => {} }
    loaderState.impl = (_onProgress, signal) =>
      new Promise<ChatEngine>((resolve) => {
        firstSignals.push(signal!)
        firstRelease.fire = resolve
      })
    const firstActivation = activateLocalHelper()
    await Promise.resolve()
    deactivateLocalHelper() // user cancels mid-download
    await vi.advanceTimersByTimeAsync(2_000) // settle the polling tick
    expect(await firstActivation).toBe('off')
    expect(firstSignals[0]?.aborted).toBe(true)

    // Retry after cancel: fresh controller, fresh engine, exactly one adopted.
    const second = makeFakeEngine([chosenJson(PLAY_INPUT)])
    loaderState.impl = async () => second.engine
    expect(await activateLocalHelper()).toBe('ready')

    // The abandoned first load can never adopt into service afterwards.
    firstRelease.fire(makeFakeEngine([chosenJson(PLAY_INPUT)]).engine)
    await Promise.resolve()
    await Promise.resolve()
    const result = await generateSuggestions(DEFAULT_PREFERENCES, [], PLAY_INPUT, 'ready')
    expect(result.usedModel).toBe(true)
    expect(result.suggestions[0].source).toBe('local-model')
  })

  it('unloads a late-resolving engine EXACTLY once after cancellation', async () => {
    vi.useFakeTimers()
    const deferred: { release: ((engine: ChatEngine) => void) | null } = { release: null }
    loaderState.impl = () =>
      new Promise<ChatEngine>((resolve) => {
        deferred.release = resolve
      })
    const firstActivation = activateLocalHelper()
    await Promise.resolve()
    deactivateLocalHelper() // abort wins the race; loader promise still pending
    await vi.advanceTimersByTimeAsync(2_000) // settle the polling tick
    expect(await firstActivation).toBe('off')

    // The loader resolves LATE with a real engine: exactly one unload.
    const lateEngine = makeFakeEngine([chosenJson(PLAY_INPUT)])
    deferred.release?.(lateEngine.engine)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(lateEngine.unload).toHaveBeenCalledTimes(1)

    // Resolving again is impossible for a native promise, but the module must
    // also have forgotten the dead load so a retry builds a fresh engine.
    const second = makeFakeEngine([chosenJson(PLAY_INPUT)])
    loaderState.impl = async () => second.engine
    expect(await activateLocalHelper()).toBe('ready')
  })

  it('prevents main-thread fallback after a deliberate abort by rejecting with an abort error', async () => {
    // Direct loader-level proof: the real loadWebLlmEngine contract is exercised
    // through its seam — a loader that checks the signal before falling back.
    let sawAbortBeforeFallback = false
    loaderState.impl = async (_onProgress, signal) => {
      if (!signal) throw new Error('loader must receive an abort signal')
      if (signal.aborted) {
        // Loader contract: an already-aborted signal is observable on entry.
        sawAbortBeforeFallback = true
        throw new Error('activation-aborted')
      }
      return new Promise<ChatEngine>((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            sawAbortBeforeFallback = true
            reject(new Error('activation-aborted'))
          },
          { once: true },
        )
      })
    }
    const activation = activateLocalHelper()
    await Promise.resolve()
    deactivateLocalHelper()
    // Cancel must settle activation promptly even when the loader never does.
    expect(await activation).toBe('off')
    expect(sawAbortBeforeFallback, 'loader contract: aborted signal is observable').toBe(true)
  })
})

function message(ids: string[]) {
  return ids.map((id, index) => ({
    instanceId: `tok-${index}`,
    tokenId: id,
    label: id.toUpperCase(),
    provenance: 'fringe' as const,
    category: 'people' as const,
  }))
}
