import 'fake-indexeddb/auto'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { App } from './App'
import { setSpeechAdapter } from './speech/adapter'
import { clearLocalData } from './persistence/store'
import { seedProfile } from './test/seedProfile'

/**
 * Ordered speech lifecycle against the composed rail. All speech here is an
 * inaudible controllable stub: nothing is ever played. Proves that cycle
 * identity keeps end/failure callbacks, the safety timeout, Stop, every rail
 * mutation, hide and rapid re-speak perfectly ordered — and that a "not
 * started" attempt never claims Speaking.
 */

let endCb: (() => void) | null = null
let spokenTexts: string[]
let stopCalls: number

function installStub(started: boolean | ((text: string) => boolean) = true): void {
  endCb = null
  spokenTexts = []
  stopCalls = 0
  setSpeechAdapter({
    speak: (text, onEnd) => {
      const ok = typeof started === 'function' ? started(text) : started
      if (!ok) return false
      spokenTexts.push(text)
      endCb = onEnd ?? null
      return true
    },
    stop: () => {
      stopCalls += 1
      endCb = null
    },
    speaking: () => false,
  })
}

/** Renders the app onto a seeded board with one authored word ("No"). */
async function renderBoardWithWords(): Promise<void> {
  await seedProfile()
  render(<App />)
  await screen.findByRole('navigation', { name: 'Routine' })
  fireEvent.click(screen.getByRole('button', { name: 'No, Core' }))
}

/**
 * Erases local state, tolerating the brief window where a previous test's
 * fire-and-forget write still holds an open IndexedDB connection (delete is
 * "blocked" only while such a connection exists).
 */
async function eraseLocalState(): Promise<void> {
  let lastError: unknown = null
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await clearLocalData()
      window.localStorage.clear()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 40))
    }
  }
  void lastError
  window.localStorage.clear()
}

beforeEach(async () => {
  await eraseLocalState()
})

afterEach(() => {
  setSpeechAdapter(null)
})

describe('ordered speech lifecycle', () => {
  it('never claims Speaking when synthesis did not start', async () => {
    installStub(() => false)
    await renderBoardWithWords()

    fireEvent.click(screen.getByRole('button', { name: 'Speak' }))

    expect(screen.queryByText(/Speaking No/)).not.toBeInTheDocument()
    expect(screen.getByText('Speech could not start on this device. The words stay on the rail.')).toBeInTheDocument()
    // Nothing was ever invoked, so nothing may pretend it finished.
    expect(spokenTexts).toEqual([])
    expect(screen.getByRole('button', { name: 'Stop speaking' })).toBeDisabled()
  })

  it('shows Speaking only after a genuinely started utterance and ends honestly', async () => {
    installStub(true)
    await renderBoardWithWords()

    fireEvent.click(screen.getByRole('button', { name: 'Speak' }))
    expect(screen.getByText('Speaking No')).toBeInTheDocument()
    expect(endCb).toBeInstanceOf(Function)

    // Natural completion closes the cycle immediately.
    act(() => {
      endCb?.()
    })
    expect(screen.getByRole('button', { name: 'Stop speaking' })).toBeDisabled()
    expect(stopCalls).toBe(0)
  })

  it('the safety timeout cancels synthesis and leaves honest visible state', async () => {
    installStub(true)
    await renderBoardWithWords()

    fireEvent.click(screen.getByRole('button', { name: 'Speak' }))
    // Safety window for one word is min(12000, 700 + 700) ms.
    await screen.findByText('Speech may have stalled, so it was stopped.', {}, { timeout: 2500 })

    expect(stopCalls).toBe(1)
    expect(screen.getByRole('button', { name: 'Stop speaking' })).toBeDisabled()
    // A late end event from the cancelled attempt cannot resurrect anything.
    act(() => {
      endCb?.()
    })
    expect(screen.getByRole('button', { name: 'Stop speaking' })).toBeDisabled()
  }, 10_000)

  it('a stale callback from a prior Speak never clears a newer cycle', async () => {
    installStub(true)
    await renderBoardWithWords()

    // Cycle 1
    fireEvent.click(screen.getByRole('button', { name: 'Speak' }))
    const staleEnd = endCb
    // Cycle 1 invalidated by Stop…
    fireEvent.click(screen.getByRole('button', { name: 'Stop speaking' }))
    expect(screen.getByText('Speech stopped')).toBeInTheDocument()
    // …then cycle 2 begins.
    fireEvent.click(screen.getByRole('button', { name: 'Speak' }))
    const freshEnd = endCb
    expect(freshEnd).not.toBe(staleEnd)

    // The STALE callback arrives late and must do nothing at all.
    act(() => {
      staleEnd?.()
    })
    expect(screen.getByText('Speaking No')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Stop speaking' })).toBeEnabled()

    // The FRESH callback still owns the cycle and closes it cleanly.
    act(() => {
      freshEnd?.()
    })
    expect(screen.getByRole('button', { name: 'Stop speaking' })).toBeDisabled()
  })

  it('a synchronous failure callback never produces Speaking or an armed timeout', async () => {
    endCb = null
    spokenTexts = []
    stopCalls = 0
    setSpeechAdapter({
      speak: (_text, onEnd) => {
        // Degenerate engine: reports started=true yet ends synchronously.
        onEnd?.()
        return true
      },
      stop: () => {
        stopCalls += 1
      },
      speaking: () => false,
    })
    await renderBoardWithWords()

    fireEvent.click(screen.getByRole('button', { name: 'Speak' }))
    expect(screen.queryByText(/Speaking No/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Stop speaking' })).toBeDisabled()
    expect(stopCalls).toBe(0)

    // No timer was armed: waiting past the full safety window stays quiet.
    await new Promise((resolve) => setTimeout(resolve, 1_600))
    expect(screen.queryByText(/stalled/)).not.toBeInTheDocument()
  }, 10_000)

  it('Clear invalidates the active cycle and cancels synthesis', async () => {
    installStub(true)
    await renderBoardWithWords()

    fireEvent.click(screen.getByRole('button', { name: 'Speak' }))
    expect(screen.getByText('Speaking No')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    expect(screen.getByText('Message cleared')).toBeInTheDocument()
    expect(stopCalls).toBe(1)
    expect(screen.getByRole('button', { name: 'Stop speaking' })).toBeDisabled()

    // Neither the stale end nor the abandoned safety timer may act.
    act(() => {
      endCb?.()
    })
    await new Promise((resolve) => setTimeout(resolve, 1_600))
    expect(screen.queryByText(/stalled/)).not.toBeInTheDocument()
  }, 10_000)

  it('add, delete, chip removal and suggestion append cancel before changing the rail', async () => {
    installStub(true)
    await renderBoardWithWords()

    fireEvent.click(screen.getByRole('button', { name: 'Speak' }))
    fireEvent.click(screen.getByRole('button', { name: 'Yes, Core' }))
    expect(stopCalls).toBe(1)

    fireEvent.click(screen.getByRole('button', { name: 'Speak' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete last' }))
    expect(stopCalls).toBe(2)

    fireEvent.click(screen.getByRole('button', { name: 'Speak' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove No, Core' }))
    expect(stopCalls).toBe(3)

    fireEvent.click(screen.getByRole('button', { name: 'No, Core' }))
    fireEvent.click(screen.getByRole('button', { name: 'Speak' }))
    const dock = screen.getByLabelText('Optional local suggestions')
    fireEvent.click(dock.querySelector('button') as HTMLButtonElement)
    expect(stopCalls).toBe(4)
    expect(screen.getByRole('button', { name: 'Stop speaking' })).toBeDisabled()
  })

  it('hiding the page cancels the active cycle', async () => {
    installStub(true)
    await renderBoardWithWords()

    fireEvent.click(screen.getByRole('button', { name: 'Speak' }))
    expect(screen.getByText('Speaking No')).toBeInTheDocument()

    const previousHidden = Object.getOwnPropertyDescriptor(document, 'hidden')
    Object.defineProperty(document, 'hidden', { value: true, configurable: true })
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(stopCalls).toBe(1)
    expect(screen.getByRole('button', { name: 'Stop speaking' })).toBeDisabled()
    if (previousHidden) Object.defineProperty(document, 'hidden', previousHidden)
  })

  it('rapid Speak/Stop/Speak keeps every cycle correctly ordered', async () => {
    installStub(true)
    await renderBoardWithWords()

    fireEvent.click(screen.getByRole('button', { name: 'Speak' }))
    const firstEnd = endCb
    fireEvent.click(screen.getByRole('button', { name: 'Stop speaking' }))
    fireEvent.click(screen.getByRole('button', { name: 'Speak' }))
    const secondEnd = endCb
    expect(screen.getByText('Speaking No')).toBeInTheDocument()

    // Only the newest callback may act.
    act(() => {
      firstEnd?.()
    })
    expect(screen.getByRole('button', { name: 'Stop speaking' })).toBeEnabled()
    act(() => {
      secondEnd?.()
    })
    expect(screen.getByRole('button', { name: 'Stop speaking' })).toBeDisabled()
    // Exactly one utterance per Speak press, guarded cancellations recorded.
    expect(spokenTexts).toEqual(['No', 'No'])
    expect(stopCalls).toBeGreaterThanOrEqual(1)
  })
})
