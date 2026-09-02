import { describe, expect, it, vi } from 'vitest'
import { getSpeechAdapter, setSpeechAdapter, speakAuthoredMessage, stopSpeaking } from './adapter'

describe('speech adapter', () => {
  it('does not speak until speakAuthoredMessage is called', () => {
    const speak = vi.fn()
    const stop = vi.fn()
    setSpeechAdapter({ speak, stop, speaking: () => false })

    expect(speak).not.toHaveBeenCalled()
    speakAuthoredMessage(['I', 'want'])
    expect(speak).toHaveBeenCalledWith('I want', undefined)
    stopSpeaking()
    expect(stop).toHaveBeenCalledTimes(1)
    expect(getSpeechAdapter()).toBeTruthy()
  })

  it('passes an end callback so the UI can leave the speaking state', () => {
    let endCallback: (() => void) | undefined
    const speak = vi.fn((_text: string, onEnd?: () => void) => {
      endCallback = onEnd
      return true
    })
    const stop = vi.fn()
    setSpeechAdapter({ speak, stop, speaking: () => false })

    expect(speakAuthoredMessage(['I', 'want'], () => {})).toBe(true)
    expect(typeof endCallback).toBe('function')
    endCallback?.()
  })
})
