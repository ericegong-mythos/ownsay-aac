import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Exercises the REAL browser adapter against hostile speechSynthesis
 * environments: absent, empty input, webdriver automation, zero/delayed/
 * throwing voice lists, and throwing engines. The adapter must degrade to a
 * silent no-op AND report honestly whether synthesis was actually invoked —
 * a "not started" attempt must never masquerade as a finished utterance by
 * firing onEnd.
 *
 * Each test gets a FRESH module instance so the adapter's internal voice
 * warm-up state cannot leak between cases.
 */

type Adapter = typeof import('./adapter')

type SynthStub = Omit<Partial<SpeechSynthesis>, 'speaking'> & {
  speaking?: boolean | (() => boolean)
  getVoices?: () => SpeechSynthesisVoice[]
}

let adapter: Adapter

function withSynth(synth: SynthStub | undefined): void {
  Object.defineProperty(window, 'speechSynthesis', {
    value: synth,
    configurable: true,
    writable: true,
  })
}

beforeEach(async () => {
  vi.resetModules()
  adapter = await import('./adapter')
  // Always exercise the REAL browser adapter, never a cached test double.
  adapter.setSpeechAdapter(null)
})

afterEach(() => {
  delete (window as { speechSynthesis?: unknown }).speechSynthesis
  delete (window as { SpeechSynthesisUtterance?: unknown }).SpeechSynthesisUtterance
  adapter.setSpeechAdapter(null)
  Object.defineProperty(navigator, 'webdriver', { value: false, configurable: true })
})

function stubUtterance(): void {
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
  Object.defineProperty(window, 'SpeechSynthesisUtterance', {
    value: FakeUtterance,
    configurable: true,
  })
}

function voice(
  uri: string,
  overrides: Partial<Pick<SpeechSynthesisVoice, 'name' | 'lang' | 'default' | 'localService'>> = {},
): SpeechSynthesisVoice {
  return {
    voiceURI: uri,
    name: overrides.name ?? 'Test Voice',
    lang: overrides.lang ?? 'en-GB',
    default: overrides.default ?? false,
    localService: overrides.localService ?? true,
  } as SpeechSynthesisVoice
}

describe('browser speech adapter against hostile environments', () => {
  it('reports not-started (never onEnd) when speechSynthesis is absent', () => {
    withSynth(undefined)
    const onEnd = vi.fn()
    expect(adapter.speakAuthoredMessage(['Hello'], onEnd)).toBe(false)
    expect(onEnd).not.toHaveBeenCalled()
    expect(() => adapter.stopSpeaking()).not.toThrow()
    expect(adapter.listSpeechVoices()).toEqual([])
  })

  it('reports not-started for empty or whitespace-only input', () => {
    stubUtterance()
    const speakSpy = vi.fn()
    withSynth({
      cancel: vi.fn(),
      getVoices: () => [voice('v-local')],
      speaking: () => false,
      addEventListener: vi.fn(),
      speak: speakSpy,
    } as unknown as SynthStub & { speak: typeof speakSpy })
    const onEnd = vi.fn()
    expect(adapter.speakAuthoredMessage([], onEnd)).toBe(false)
    expect(adapter.speakAuthoredMessage(['   '], onEnd)).toBe(false)
    expect(onEnd).not.toHaveBeenCalled()
    expect(speakSpy).not.toHaveBeenCalled()
  })

  it('refuses webdriver sessions without the explicit test stub', () => {
    stubUtterance()
    const speakSpy = vi.fn()
    withSynth({
      cancel: vi.fn(),
      getVoices: () => [voice('v-local')],
      speaking: () => false,
      addEventListener: vi.fn(),
      speak: speakSpy,
    } as unknown as SynthStub & { speak: typeof speakSpy })
    Object.defineProperty(navigator, 'webdriver', { value: true, configurable: true })
    const onEnd = vi.fn()
    expect(adapter.speakAuthoredMessage(['Hello'], onEnd)).toBe(false)
    expect(onEnd).not.toHaveBeenCalled()
    expect(speakSpy).not.toHaveBeenCalled()

    // With the explicit stub installed, automation speech is permitted.
    ;(window as Window & { __OWNSAY_TEST_SPEECH_STUB__?: boolean }).__OWNSAY_TEST_SPEECH_STUB__ = true
    try {
      expect(adapter.speakAuthoredMessage(['Hello again'], onEnd)).toBe(true)
      expect(speakSpy).toHaveBeenCalledTimes(1)
    } finally {
      delete (window as { __OWNSAY_TEST_SPEECH_STUB__?: unknown }).__OWNSAY_TEST_SPEECH_STUB__
    }
  })

  it('fails closed with zero voices instead of delegating to a browser default', () => {
    stubUtterance()
    const speakSpy = vi.fn()
    withSynth({
      cancel: vi.fn(),
      getVoices: () => [],
      speaking: () => false,
      addEventListener: vi.fn(),
      speak: speakSpy,
    } as unknown as SynthStub & { speak: typeof speakSpy })
    const onEnd = vi.fn()
    expect(adapter.speakAuthoredMessage(['Yes'], onEnd)).toBe(false)
    expect(speakSpy).not.toHaveBeenCalled()
    expect(onEnd).not.toHaveBeenCalled()
  })

  it('never lists or selects remote and unknown-locality voices', () => {
    stubUtterance()
    const selectedVoices: unknown[] = []
    const local = voice('v-local-fr', { name: 'Local French', lang: 'fr-FR' })
    const remote = voice('v-remote-uk', {
      name: 'Remote British',
      lang: 'en-GB',
      localService: false,
      default: true,
    })
    const unknown = { ...voice('v-unknown'), localService: undefined } as unknown as SpeechSynthesisVoice
    withSynth({
      cancel: vi.fn(),
      getVoices: () => [remote, unknown, local],
      speaking: () => false,
      addEventListener: vi.fn(),
      speak: (utterance: { voice: unknown }) => selectedVoices.push(utterance.voice),
    } as unknown as SynthStub & { speak: (utterance: { voice: unknown }) => void })

    adapter.setPreferredVoice(remote.voiceURI)
    expect(adapter.listSpeechVoices()).toEqual([
      { uri: local.voiceURI, name: local.name, lang: local.lang, localService: true },
    ])
    expect(adapter.speakAuthoredMessage(['Private', 'message'])).toBe(true)
    expect(selectedVoices).toEqual([local])
  })

  it('does not invoke speech for remote-only or unknown-locality voice lists', () => {
    stubUtterance()
    const speakSpy = vi.fn()
    const remote = voice('v-remote', { localService: false })
    const unknown = { ...voice('v-unknown'), localService: undefined } as unknown as SpeechSynthesisVoice
    withSynth({
      cancel: vi.fn(),
      getVoices: () => [remote, unknown],
      speaking: () => false,
      addEventListener: vi.fn(),
      speak: speakSpy,
    } as unknown as SynthStub & { speak: typeof speakSpy })
    adapter.setPreferredVoice(remote.voiceURI)

    expect(adapter.speakAuthoredMessage(['Help'])).toBe(false)
    expect(speakSpy).not.toHaveBeenCalled()
    expect(adapter.listSpeechVoices()).toEqual([])
  })

  it('revalidates a persisted URI on every utterance when locality changes', () => {
    stubUtterance()
    const speakSpy = vi.fn()
    let current = voice('v-changing', { localService: true })
    withSynth({
      cancel: vi.fn(),
      getVoices: () => [current],
      speaking: () => false,
      addEventListener: vi.fn(),
      speak: speakSpy,
    } as unknown as SynthStub & { speak: typeof speakSpy })
    adapter.setPreferredVoice(current.voiceURI)

    expect(adapter.speakAuthoredMessage(['First'])).toBe(true)
    current = voice('v-changing', { localService: false })
    expect(adapter.speakAuthoredMessage(['Second'])).toBe(false)
    expect(speakSpy).toHaveBeenCalledTimes(1)
  })

  it('reports not-started when the voice list explodes during speak', () => {
    withSynth({
      cancel: vi.fn(),
      getVoices: () => {
        throw new Error('voices exploded')
      },
      speaking: () => false,
      addEventListener: vi.fn(),
      speak: vi.fn(),
    })
    // Voice listing degrades to an empty list for carer settings.
    expect(adapter.listSpeechVoices()).toEqual([])
    const onEnd = vi.fn()
    expect(() => adapter.speakAuthoredMessage(['No'], onEnd)).not.toThrow()
    // Nothing was invoked, so nothing may pretend it finished.
    expect(onEnd).not.toHaveBeenCalled()
  })

  it('reports not-started when the utterance constructor throws', () => {
    const speakSpy = vi.fn()
    withSynth({
      cancel: vi.fn(),
      getVoices: () => [voice('v-local')],
      speaking: () => false,
      addEventListener: vi.fn(),
      speak: speakSpy,
    })
    class BrokenUtterance {
      constructor() {
        throw new Error('no utterance for you')
      }
    }
    Object.defineProperty(window, 'SpeechSynthesisUtterance', {
      value: BrokenUtterance,
      configurable: true,
    })
    try {
      const onEnd = vi.fn()
      expect(() => adapter.speakAuthoredMessage(['Help'], onEnd)).not.toThrow()
      expect(speakSpy).not.toHaveBeenCalled()
      expect(onEnd).not.toHaveBeenCalled()
    } finally {
      delete (window as { SpeechSynthesisUtterance?: unknown }).SpeechSynthesisUtterance
    }
  })

  it('reports not-started and attempts cancellation when synth.speak throws', () => {
    stubUtterance()
    const cancel = vi.fn()
    withSynth({
      cancel,
      getVoices: () => [voice('v-local')],
      speaking: () => false,
      addEventListener: vi.fn(),
      speak: () => {
        throw new Error('engine refused')
      },
    } as unknown as SynthStub & { speak: () => void })
    const onEnd = vi.fn()
    expect(adapter.speakAuthoredMessage(['Break'], onEnd)).toBe(false)
    expect(cancel).toHaveBeenCalled()
    expect(onEnd).not.toHaveBeenCalled()
  })

  it('fires onEnd exactly once on a synchronous end and still reports started', () => {
    stubUtterance()
    type EndableUtterance = { onend?: (() => void) | null }
    let ended = false
    withSynth({
      cancel: vi.fn(),
      getVoices: () => [voice('v-local')],
      speaking: () => false,
      addEventListener: vi.fn(),
      speak: (utterance: EndableUtterance) => {
        // Degenerate engine: end fires synchronously inside speak().
        utterance.onend?.()
        ended = true
      },
    } as unknown as SynthStub & { speak: (utterance: EndableUtterance) => void })
    const onEnd = vi.fn()
    expect(adapter.speakAuthoredMessage(['More'], onEnd)).toBe(true)
    expect(ended).toBe(true)
    expect(onEnd).toHaveBeenCalledTimes(1)
  })

  it('collapses an error/end race into a single completion callback', async () => {
    stubUtterance()
    type EndableUtterance = { onend?: (() => void) | null; onerror?: (() => void) | null }
    withSynth({
      cancel: vi.fn(),
      getVoices: () => [voice('v-local')],
      speaking: () => false,
      addEventListener: vi.fn(),
      speak: (utterance: EndableUtterance) => {
        queueMicrotask(() => {
          utterance.onerror?.()
          utterance.onend?.()
        })
      },
    } as unknown as SynthStub & { speak: (utterance: EndableUtterance) => void })
    const onEnd = vi.fn()
    expect(adapter.speakAuthoredMessage(['Finished'], onEnd)).toBe(true)
    await Promise.resolve()
    expect(onEnd).toHaveBeenCalledTimes(1)
  })

  it('warms voices idempotently without assuming voiceschanged ever fires', async () => {
    const addEventListener = vi.fn()
    withSynth({
      getVoices: () => [],
      addEventListener,
    })
    expect(() => {
      adapter.warmSpeechVoices()
      adapter.warmSpeechVoices()
      adapter.warmSpeechVoices()
    }).not.toThrow()
    // Exactly ONE subscription no matter how many warm-up calls arrive.
    expect(addEventListener).toHaveBeenCalledTimes(1)
  })

  it('subscribes delayed voiceschanged on speechSynthesis itself, never on window', () => {
    const synthAdd = vi.fn()
    withSynth({
      getVoices: () => [],
      addEventListener: synthAdd,
    })
    adapter.warmSpeechVoices()
    // The subscription target must be the synthesiser object with the exact
    // event name — delayed voice lists announce there and nowhere else.
    expect(synthAdd).toHaveBeenCalledWith('voiceschanged', expect.any(Function), { once: true })
  })

  it('marks voices ready immediately when the list is populated synchronously', () => {
    withSynth({
      getVoices: () => [voice('v')],
      addEventListener: vi.fn(),
    })
    adapter.warmSpeechVoices()
    expect(adapter.listSpeechVoices()).toEqual([
      { uri: 'v', name: 'Test Voice', lang: 'en-GB', localService: true },
    ])
    expect(adapter.getSpeechAdapter()).toBeTruthy()
  })
})
