import '@testing-library/jest-dom/vitest'
import { afterEach, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { setSpeechAdapter } from '../speech/adapter'

if (typeof PointerEvent === 'undefined' && typeof MouseEvent !== 'undefined') {
  class PointerEventPolyfill extends MouseEvent {
    pointerId = 1
  }
  Object.defineProperty(globalThis, 'PointerEvent', {
    value: PointerEventPolyfill,
    configurable: true,
  })
}

// jsdom emits a console error before returning null for canvas contexts. The
// device-check code deliberately treats a null context as "unsupported", so a
// quiet null stub models that browser result without obscuring real test output.
if (typeof HTMLCanvasElement !== 'undefined') {
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    value: vi.fn(() => null),
    configurable: true,
  })
}

const speak = vi.fn(() => true)
const stop = vi.fn()

setSpeechAdapter({
  speak,
  stop,
  speaking: () => false,
})

Object.defineProperty(globalThis, '__speechMock', {
  value: { speak, stop },
  configurable: true,
})

afterEach(() => {
  cleanup()
  speak.mockClear()
  stop.mockClear()
  setSpeechAdapter({
    speak,
    stop,
    speaking: () => false,
  })
})
