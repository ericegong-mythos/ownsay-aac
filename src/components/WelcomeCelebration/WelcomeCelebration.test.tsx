import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WelcomeCelebration } from './WelcomeCelebration'

function stubReducedMotion(reduced: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: reduced && query.includes('reduce'),
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  // jsdom exposes requestAnimationFrame, which the overlay uses to mount its
  // pixel-art stage one frame after the greeting. These tests pin the rendered
  // result and timings, so they exercise the synchronous fallback path unless
  // a test stubs frames itself.
  vi.stubGlobal('requestAnimationFrame', undefined)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  delete (window as { matchMedia?: unknown }).matchMedia
})

describe('welcome celebration', () => {
  it('greets the chosen child with their own favourite sprites', () => {
    stubReducedMotion(false)
    const { unmount } = render(
      <WelcomeCelebration childName="Alex" spriteKeys={['apple', 'blocks', 'train', 'drawing']} onComplete={vi.fn()} />,
    )
    expect(screen.getByTestId('welcome-celebration')).toHaveTextContent('Hello Alex')
    expect(document.querySelectorAll('svg[viewBox="0 0 16 16"]')).toHaveLength(4)
    // Every colour band survives consolidation into paths.
    const applePaths = document.querySelectorAll('svg[viewBox="0 0 16 16"]')[0].querySelectorAll('path')
    expect(applePaths.length).toBeGreaterThanOrEqual(3)
    unmount()
    // Unknown sprite keys are ignored rather than rendered as empty boxes.
    const unknown = render(
      <WelcomeCelebration childName="Sam" spriteKeys={['toast', 'mystery']} onComplete={vi.fn()} />,
    )
    expect(screen.getByTestId('welcome-celebration')).toHaveTextContent('Hello Sam')
    expect(document.querySelectorAll('svg[viewBox="0 0 16 16"]')).toHaveLength(1)
    unknown.unmount()
    // Prototype-chain property names are untrusted strings, never sprites.
    render(
      <WelcomeCelebration
        childName="Sam"
        spriteKeys={['__proto__', 'constructor', 'toString', 'hasOwnProperty']}
        onComplete={vi.fn()}
      />,
    )
    expect(document.querySelectorAll('svg[viewBox="0 0 16 16"]')).toHaveLength(0)
  })

  it('mounts the pixel-art stage in a second commit after the shell paints', () => {
    stubReducedMotion(false)
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    })
    vi.stubGlobal('cancelAnimationFrame', () => {})
    render(<WelcomeCelebration childName="Alex" spriteKeys={['apple']} onComplete={vi.fn()} />)
    // First painted frame: overlay shell with the greeting only.
    act(() => {
      frames.splice(0).forEach((callback) => callback(16))
    })
    expect(screen.getByTestId('welcome-celebration')).toHaveTextContent('Hello Alex')
    expect(document.querySelector('[data-testid] svg')).toBeNull()
    // One more painted frame and the stage joins, still inside the moment.
    act(() => {
      frames.splice(0).forEach((callback) => callback(32))
    })
    expect(document.querySelectorAll('svg[viewBox="0 0 16 16"]')).toHaveLength(1)
  })

  it('is pointer-transparent and finishes within the brief window without side effects', async () => {
    stubReducedMotion(false)
    const onComplete = vi.fn()
    render(<WelcomeCelebration childName="Alex" spriteKeys={['apple']} onComplete={onComplete} />)
    const overlay = screen.getByTestId('welcome-celebration')
    expect(overlay.style.pointerEvents).toBe('none')
    expect(onComplete).not.toHaveBeenCalled()
    // Motion celebration stays within the hard 1.5s cap.
    vi.advanceTimersByTime(1499)
    expect(onComplete).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onComplete).toHaveBeenCalledTimes(1)
  })

  it('collapses to a calm static welcome under prefers-reduced-motion', () => {
    stubReducedMotion(true)
    const onComplete = vi.fn()
    render(
      <WelcomeCelebration
        childName="Sam"
        spriteKeys={['toast', 'water', 'bubbles', 'puzzle']}
        onComplete={onComplete}
      />,
    )
    // No confetti nodes at all in the static version.
    expect(document.querySelectorAll('i')).toHaveLength(0)
    vi.advanceTimersByTime(800)
    expect(onComplete).toHaveBeenCalledTimes(1)
  })
})
