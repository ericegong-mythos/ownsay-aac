import 'fake-indexeddb/auto'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from './App'
import { generateSuggestions } from './inference/adapter'
import { buildModelInput } from './domain/policy'
import { DEFAULT_PREFERENCES, type AuthoredToken } from './domain/types'
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

afterEach(() => {
  vi.useRealTimers()
})

describe('child authorship', () => {
  it('does not speak when a tile or suggestion is selected', async () => {
    const user = userEvent.setup()
    render(<App />)

    await user.click(await screen.findByRole('button', { name: 'No, Core' }))
    await user.click(screen.getByRole('button', { name: 'Want' }))
    const dock = screen.getByLabelText('Optional local suggestions')
    const suggestion = await waitFor(() => {
      const button = within(dock).queryAllByRole('button')[0]
      if (!button) throw new Error('waiting for a local suggestion')
      return button
    })
    await user.click(suggestion)
    expect(screen.getByRole('button', { name: 'Remove No, Core' })).toBeInTheDocument()
    expect(speechMock().speak.mock.calls).toHaveLength(0)
  })

  it('speaks only after the Speak control is pressed', async () => {
    const user = userEvent.setup()
    render(<App />)

    await user.click(await screen.findByRole('button', { name: 'Yes, Core' }))
    await user.click(screen.getByRole('button', { name: 'Speak' }))
    expect((speechMock().speak.mock.calls[0] as unknown[] | undefined)?.[0]).toBe('Yes')
  })

  it('does not let generation change current message tokens', async () => {
    const current: AuthoredToken[] = [
      {
        instanceId: 'keep',
        tokenId: 'i',
        label: 'I',
        provenance: 'fringe',
        category: 'people',
      },
    ]
    const frozen = structuredClone(current)
    await generateSuggestions(DEFAULT_PREFERENCES, current, buildModelInput(DEFAULT_PREFERENCES, current), 'off')
    expect(current).toEqual(frozen)
  })

  it('opens carer settings from standard assistive activation without speaking', async () => {
    render(<App />)
    const hold = await screen.findByRole('button', { name: 'Open carer settings' })
    fireEvent.click(hold, { detail: 0 })
    expect(await screen.findByRole('dialog', { name: 'Carer settings' }, { timeout: 2000 })).toBeInTheDocument()
    expect(speechMock().speak.mock.calls).toHaveLength(0)
  })

  it('does not announce successful erasure when IndexedDB deletion is blocked', async () => {
    const user = userEvent.setup()
    const request = {} as IDBOpenDBRequest
    const deletion = vi.spyOn(indexedDB, 'deleteDatabase').mockImplementation(() => {
      queueMicrotask(() => request.onblocked?.(new Event('blocked') as IDBVersionChangeEvent))
      return request
    })
    render(<App />)

    const hold = await screen.findByRole('button', { name: 'Open carer settings' })
    fireEvent.click(hold, { detail: 0 })
    await user.click(await screen.findByRole('button', { name: 'Clear local data' }))
    await user.click(screen.getByRole('button', { name: /Erase everything on this device/ }))

    await waitFor(() =>
      expect(document.querySelector('[aria-live="polite"]')).toHaveTextContent(
        'Local data could not be fully erased',
      ),
    )
    expect(document.querySelector('[aria-live="polite"]')).not.toHaveTextContent('This device has been cleared')
    expect(screen.getByLabelText('This is Test’s board')).toBeInTheDocument()
    deletion.mockRestore()
  })
})
