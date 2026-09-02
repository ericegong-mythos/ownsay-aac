export interface SpeechAdapter {
  /**
   * Attempts to speak `text`. Returns true ONLY when synthesis was actually
   * invoked successfully; absence, empty input, webdriver automation without
   * the explicit test stub, or any throwing engine returns false. When false,
   * `onEnd` is never invoked, so a "not started" attempt can never masquerade
   * as a finished utterance.
   */
  speak: (text: string, onEnd?: () => void) => boolean
  stop: () => void
  speaking: () => boolean
}

export interface VoiceOption {
  uri: string
  name: string
  lang: string
  /** True only when the browser reports that this voice is supplied locally. */
  localService: boolean
}

let impl: SpeechAdapter | null = null
let voicesReady = false
/** Per-profile preference; resolved against available voices at speak time. */
let preferredVoiceURI: string | null = null

function verifiedLocalVoices(voices: readonly SpeechSynthesisVoice[]): SpeechSynthesisVoice[] {
  // Fail closed: false and missing/unknown locality are not verified on-device.
  return voices.filter((voice) => voice.localService === true)
}

function preferBritishVoice(voices: readonly SpeechSynthesisVoice[]): SpeechSynthesisVoice | null {
  const localVoices = verifiedLocalVoices(voices)
  const byLang = localVoices.filter((voice) => /^en-GB/i.test(voice.lang))
  if (byLang.length > 0) {
    const generic = byLang.find((voice) => /google|microsoft|samantha|daniel|serena|libby/i.test(voice.name))
    return generic ?? byLang[0] ?? null
  }
  const english = localVoices.filter((voice) => /^en/i.test(voice.lang))
  if (english.length > 0) return english[0] ?? null
  // Last resort is still local: never delegate an unset voice to the browser.
  return localVoices.find((voice) => voice.default) ?? localVoices[0] ?? null
}

function resolveVoice(voices: readonly SpeechSynthesisVoice[]): SpeechSynthesisVoice | null {
  const localVoices = verifiedLocalVoices(voices)
  if (preferredVoiceURI) {
    // Revalidate locality on every utterance. A persisted URI may now be
    // absent, remote, or supplied by a different browser implementation.
    const chosen = localVoices.find((voice) => voice.voiceURI === preferredVoiceURI)
    if (chosen) return chosen
  }
  return preferBritishVoice(localVoices)
}

/** Sets a preference URI; speak-time resolution accepts verified-local voices only. */
export function setPreferredVoice(uri: string | null): void {
  preferredVoiceURI = uri && uri.trim() ? uri : null
}

/** Voices the browser explicitly reports as on-device, for carer selection. */
export function listSpeechVoices(): VoiceOption[] {
  if (typeof window === 'undefined' || !window.speechSynthesis) return []
  try {
    return verifiedLocalVoices(window.speechSynthesis.getVoices()).map((voice) => ({
      uri: voice.voiceURI,
      name: voice.name,
      lang: voice.lang,
      localService: true,
    }))
  } catch {
    // A broken synthesiser must never break carer settings.
    return []
  }
}

function browserSpeech(): SpeechAdapter {
  return {
    speak(text, onEnd) {
      if (typeof window === 'undefined' || !window.speechSynthesis || !text.trim()) return false
      // Never emit real audio from automated browser sessions. E2E tests that
      // exercise speech install an explicit in-page recorder and mark it here;
      // if that installation fails, automation remains silent by default.
      const testSpeechInstalled = (
        window as Window & { __OWNSAY_TEST_SPEECH_STUB__?: boolean }
      ).__OWNSAY_TEST_SPEECH_STUB__ === true
      if (navigator.webdriver && !testSpeechInstalled) return false
      try {
        window.speechSynthesis.cancel()
        // This is the shared privacy boundary for authored and test speech.
        // Never call speak() without a current voice that the browser itself
        // explicitly identifies as local; unset, remote and unknown are text-only.
        const voice = resolveVoice(window.speechSynthesis.getVoices())
        if (!voice) return false
        const utterance = new SpeechSynthesisUtterance(text)
        utterance.lang = 'en-GB'
        utterance.rate = 0.92
        utterance.voice = voice
        if (onEnd) {
          let done = false
          const finish = () => {
            if (done) return
            done = true
            onEnd()
          }
          utterance.onend = finish
          utterance.onerror = finish
        }
        window.speechSynthesis.speak(utterance)
        return true
      } catch {
        // A throwing constructor, voice list or synthesis engine means nothing
        // was spoken: report "not started" and never fire onEnd, so callers
        // cannot mistake silence for a finished utterance.
        try {
          window.speechSynthesis?.cancel()
        } catch {
          // Even cancel() may be broken here.
        }
        return false
      }
    },
    stop() {
      if (typeof window === 'undefined' || !window.speechSynthesis) return
      try {
        window.speechSynthesis.cancel()
      } catch {
        // Best-effort; silence is already the safe state.
      }
    },
    speaking() {
      try {
        return Boolean(typeof window !== 'undefined' && window.speechSynthesis?.speaking)
      } catch {
        return false
      }
    },
  }
}

export function getSpeechAdapter(): SpeechAdapter {
  if (!impl) impl = browserSpeech()
  return impl
}

export function setSpeechAdapter(next: SpeechAdapter | null): void {
  impl = next
}

let warmListenerAttached = false

/**
 * Idempotent warm-up: reads the voice list once and, only when voices arrive
 * late, subscribes a single `voiceschanged` listener on `speechSynthesis`
 * (never on `window`). Safe to call repeatedly; never requires the event.
 */
export function warmSpeechVoices(): void {
  if (typeof window === 'undefined' || !window.speechSynthesis) return
  if (voicesReady) return
  try {
    const list = window.speechSynthesis.getVoices() ?? []
    if (list.length > 0) {
      voicesReady = true
      return
    }
  } catch {
    // A broken voice list must not stop the board from working.
  }
  if (warmListenerAttached) return
  try {
    window.speechSynthesis.addEventListener(
      'voiceschanged',
      () => {
        voicesReady = true
      },
      { once: true },
    )
    warmListenerAttached = true
  } catch {
    // Delayed or absent voiceschanged support is fine; retry on next warm.
  }
}

export function speakAuthoredMessage(labels: readonly string[], onEnd?: () => void): boolean {
  return getSpeechAdapter().speak(labels.join(' '), onEnd)
}

export function stopSpeaking(): void {
  getSpeechAdapter().stop()
}
