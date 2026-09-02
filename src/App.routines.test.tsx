import 'fake-indexeddb/auto'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from './App'
import { ROUTINE_LABELS } from './domain/types'
import { clearLocalData } from './persistence/store'
import { seedProfile } from './test/seedProfile'

beforeEach(async () => {
  await clearLocalData()
  await seedProfile()
})

type SpeechMock = { speak: { mock: { calls: unknown[] } }; stop: { mock: { calls: unknown[] } } }

function speechMock(): SpeechMock {
  return (globalThis as unknown as { __speechMock: SpeechMock }).__speechMock
}

async function openBoardWords() {
  return screen.getByRole('region', { name: /Anytime words/ })
}

function boardWordLabels(): string[] {
  const now = within(screen.getByRole('region', { name: /Right now/ })).queryAllByRole('listitem')
  const anytime = within(screen.getByRole('region', { name: /Anytime words/ })).queryAllByRole('listitem')
  return [...now, ...anytime].map((item) => item.querySelector('button')?.getAttribute('data-tile-id') ?? '')
}

function dockWords(): string[] {
  const dock = screen.getByLabelText('Optional local suggestions')
  return within(dock)
    .getAllByRole('button')
    .map((button) => button.textContent ?? '')
}

describe('routine worlds in the composed app', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('switching world changes board words and every starter suggestion without speaking', async () => {
    const user = userEvent.setup()
    render(<App />)

    await screen.findByRole('navigation', { name: 'Routine' })
    const before = { words: boardWordLabels(), suggestions: dockWords() }
    expect(before.suggestions).toHaveLength(4)

    const nav = screen.getByRole('navigation', { name: 'Routine' })
    await user.click(within(nav).getByRole('button', { name: 'Food' }))

    // Selected state moved with shape + pressed state.
    expect(within(nav).getByRole('button', { name: 'Food' })).toHaveAttribute('aria-pressed', 'true')
    expect(within(nav).getByRole('button', { name: 'Play' })).toHaveAttribute('aria-pressed', 'false')

    const after = { words: boardWordLabels(), suggestions: dockWords() }
    const removedWords = before.words.filter((id) => !after.words.includes(id))
    expect(removedWords.length, 'board must visibly change').toBeGreaterThan(0)
    const contextRegion = screen.getByRole('region', { name: /Right now/ })
    expect(within(contextRegion).getAllByRole('listitem').length).toBeGreaterThanOrEqual(6)
    expect(after.suggestions).toHaveLength(4)
    expect(after.suggestions.some((label) => label.includes('Hungry'))).toBe(true)

    // Every routine swap keeps all four starters present and distinct.
    for (const label of Object.values(ROUTINE_LABELS)) {
      await user.click(within(nav).getByRole('button', { name: label }))
      expect(dockWords()).toHaveLength(4)
      expect(new Set(dockWords()).size).toBe(4)
      expect(boardWordLabels().length).toBeGreaterThan(0)
    }
    expect(speechMock().speak.mock.calls).toHaveLength(0)
  })

  it('preserves the authored rail across a routine change', async () => {
    const user = userEvent.setup()
    render(<App />)
    await screen.findByRole('navigation', { name: 'Routine' })

    await user.click(screen.getByRole('button', { name: 'Help, Core' }))
    const nav = screen.getByRole('navigation', { name: 'Routine' })
    await user.click(within(nav).getByRole('button', { name: 'School' }))
    await user.click(screen.getByRole('button', { name: 'Teacher' }))

    const rail = screen.getByRole('region', { name: 'Authorship rail' })
    expect(within(rail).getByRole('button', { name: 'Remove Help, Core' })).toBeInTheDocument()
    expect(within(rail).getByRole('button', { name: 'Remove Teacher, Board' })).toBeInTheDocument()
    expect(speechMock().speak.mock.calls).toHaveLength(0)
  })

  it('announces the new world politely on change', async () => {
    const user = userEvent.setup()
    render(<App />)
    await screen.findByRole('navigation', { name: 'Routine' })
    const nav = screen.getByRole('navigation', { name: 'Routine' })
    await user.click(within(nav).getByRole('button', { name: 'Outside' }))
    expect(document.querySelector('[aria-live="polite"]')?.textContent).toMatch(/Out & about/)
  })

  it('keeps a changed board usable while clearly warning a carer when it cannot be saved', async () => {
    const user = userEvent.setup()
    render(<App />)
    const nav = await screen.findByRole('navigation', { name: 'Routine' })

    const request = {} as IDBOpenDBRequest
    vi.spyOn(indexedDB, 'open').mockImplementationOnce(() => {
      queueMicrotask(() => request.onblocked?.(new Event('blocked') as IDBVersionChangeEvent))
      return request
    })

    await user.click(within(nav).getByRole('button', { name: 'Food' }))

    expect(within(nav).getByRole('button', { name: 'Food' })).toHaveAttribute('aria-pressed', 'true')
    const warning = await screen.findByRole('alert')
    expect(warning).toHaveTextContent(/device could not save the last change/i)
    expect(warning).toHaveTextContent(/current board still works/i)

    await user.click(within(warning).getByRole('button', { name: 'Dismiss storage warning' }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

export { openBoardWords }
