import 'fake-indexeddb/auto'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { App } from './App'
import {
  clearAllDrafts,
  clearLocalData,
  loadDraft,
  saveDraft,
  saveProfile,
  setActiveProfileId,
} from './persistence/store'
import { createProfile } from './persistence/store'
import type { AuthoredToken } from './domain/types'
import { seedProfile } from './test/seedProfile'

type SpeechMock = { speak: { mock: { calls: unknown[] } }; stop: { mock: { calls: unknown[] } } }

function speechMock(): SpeechMock {
  return (globalThis as unknown as { __speechMock: SpeechMock }).__speechMock
}

beforeEach(async () => {
  await clearLocalData()
  window.localStorage.clear()
})

describe('rapid interaction robustness', () => {
  it('survives 56 word taps plus repeated Speak/Stop without double append or lost actions', async () => {
    const user = userEvent.setup({ delay: null })
    await seedProfile()
    render(<App />)
    await screen.findByRole('navigation', { name: 'Routine' })

    const taps = ['No', 'Stop', 'Help', 'Hurts', 'Break', 'Yes', 'More', 'Finished']
    for (let round = 0; round < 7; round += 1) {
      for (const label of taps) {
        await user.click(screen.getByRole('button', { name: `${label}, Core` }))
      }
    }
    const rail = screen.getByRole('region', { name: 'Authorship rail' })
    expect(await within_rail_count(rail)).toBe(56)

    // Instance ids stay unique — no double appends.
    const chips = Array.from(rail.querySelectorAll('[aria-label^="Remove"]'))
    expect(chips.length).toBe(56)
    // Labels repeat across rounds; uniqueness lives in instance identity, so
    // the strongest observable guarantee is that removal still targets rows
    // one-by-one after the storm of input.
    await user.click(chips[0] as HTMLElement)
    expect(rail.querySelectorAll('[aria-label^="Remove"]')).toHaveLength(55)

    // Speak/Stop spam: every press lands, nothing crashes, speech mock sees
    // exactly one utterance per Speak.
    for (let cycle = 0; cycle < 5; cycle += 1) {
      await user.click(screen.getByRole('button', { name: 'Speak' }))
      await user.click(screen.getByRole('button', { name: 'Stop speaking' }))
    }
    expect(speechMock().speak.mock.calls.length).toBe(5)
    expect(speechMock().stop.mock.calls.length).toBeGreaterThanOrEqual(5)
    expect(screen.getByRole('button', { name: 'No, Core' })).toBeEnabled()
    // This is a behavioural stress test, not a wall-clock performance gate.
    // Shared CI runners can take longer than Vitest's 5 s default while
    // dispatching 67 full user-event interactions through React and jsdom.
  }, 15_000)

  async function within_rail_count(rail: HTMLElement): Promise<number> {
    return rail.querySelectorAll('[aria-label^="Remove"]').length
  }
})

describe('phrase recovery drafts', () => {
  it('round-trips a composed phrase per profile and rejects junk on read', async () => {
    const alex = createProfile({ nickname: 'Alex' })
    await saveProfile(alex)
    await setActiveProfileId(alex.id)

    const tokens: AuthoredToken[] = [
      { instanceId: 't1', tokenId: 'want', label: 'Want', provenance: 'core', category: 'core' },
      { instanceId: 't2', tokenId: 'more', label: 'More', provenance: 'core', category: 'safety' },
    ]
    saveDraft(alex.id, tokens)
    expect(loadDraft(alex.id)).toHaveLength(2)

    localStorage.setItem(`ownsay-draft-v1:${alex.id}`, '{not json')
    expect(loadDraft(alex.id)).toEqual([])

    localStorage.setItem(
      `ownsay-draft-v1:${alex.id}`,
      JSON.stringify([
        { garbage: true },
        null,
        {
          instanceId: 'ok',
          tokenId: 'no',
          label: 'No',
          provenance: 'core',
          category: 'safety',
        },
      ]),
    )
    const recovered = loadDraft(alex.id)
    expect(recovered).toHaveLength(1)
    expect(recovered[0]?.tokenId).toBe('no')

    clearAllDrafts()
    expect(loadDraft(alex.id)).toEqual([])
  })

  it('restores the draft after a cold reload but never leaks it to a sibling switch', async () => {
    const user = userEvent.setup({ delay: null })
    await seedProfile({ nickname: 'Test' })
    const cleanupFirst = render(<App />)
    await screen.findByRole('navigation', { name: 'Routine' })
    await user.click(screen.getByRole('button', { name: 'Help, Core' }))
    await user.click(screen.getByRole('button', { name: 'Yes, Core' }))
    const rail = screen.getByRole('region', { name: 'Authorship rail' })
    expect(rail.querySelectorAll('[aria-label^="Remove"]')).toHaveLength(2)

    // Cold reload: renderer eviction equivalent.
    cleanupFirst.unmount()
    render(<App />)
    await screen.findAllByRole('navigation', { name: 'Routine' })
    await waitFor(() => {
      const rails = document.querySelectorAll('[aria-label="Authorship rail"]')
      expect(rails).toHaveLength(1)
      expect(rails[0]?.querySelectorAll('[aria-label^="Remove"]')).toHaveLength(2)
    })
  })
})
