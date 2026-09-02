import 'fake-indexeddb/auto'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { App } from './App'
import { PROTECTED_CORE_IDS } from './domain/protected-core'
import { ROUTINE_LABELS, type Routine } from './domain/types'
import { clearLocalData, loadLocalState } from './persistence/store'
import { seedProfile } from './test/seedProfile'

type SpeechMock = { speak: { mock: { calls: unknown[] } }; stop: { mock: { calls: unknown[] } } }

function speechMock(): SpeechMock {
  return (globalThis as unknown as { __speechMock: SpeechMock }).__speechMock
}

beforeEach(async () => {
  await clearLocalData()
  window.localStorage.clear()
})

async function openCarerDrawer() {
  const hold = await screen.findByRole('button', { name: 'Open carer settings' })
  fireEvent.click(hold, { detail: 0 })
  await screen.findByRole('dialog', { name: 'Carer settings' }, { timeout: 2000 })
}

function coreTileIds(): string[] {
  const coreSection = Array.from(document.querySelectorAll('section')).find((node) =>
    node.querySelector('#core-heading'),
  )
  if (!coreSection) throw new Error('core section missing')
  return Array.from(coreSection.querySelectorAll('[data-tile-id]')).map(
    (tile) => tile.getAttribute('data-tile-id') ?? '',
  )
}

describe('fictional demo profiles', () => {
  it('offers Alex and Sam on a fresh install and creates both age 4–6 boards', async () => {
    const user = userEvent.setup()
    render(<App />)

    expect(await screen.findByText('Who is this board for?')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Alex/ })).toBeVisible()
    expect(screen.getByRole('button', { name: /Sam/ })).toBeVisible()

    await user.click(screen.getByRole('button', { name: /Alex/ }))

    // The chosen child lands straight on their own board.
    expect(await screen.findByLabelText('This is Alex’s board')).toBeInTheDocument()
    const state = await loadLocalState()
    expect(state.profiles.map((profile) => profile.nickname)).toEqual(['Alex', 'Sam'])
    for (const profile of state.profiles) {
      expect(profile.ageBand).toBe('4-6')
      expect(profile.helperEnabled).toBe(false)
    }
    expect(state.activeProfileId).toBe(state.profiles.find((profile) => profile.nickname === 'Alex')?.id)

    // The welcome moment runs once after the explicit choice, then leaves.
    expect(await screen.findByTestId('welcome-celebration')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByTestId('welcome-celebration')).not.toBeInTheDocument(), {
      timeout: 3000,
    })
  })

  it('gives each child genuinely distinct favourites and never speaks during setup', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.click(await screen.findByRole('button', { name: /Sam/ }))
    await screen.findByTestId('welcome-celebration')
    await screen.findByLabelText('This is Sam’s board')

    const samTiles = () =>
      Array.from(document.querySelectorAll('[data-tile-id]')).map((tile) => tile.getAttribute('data-tile-id'))
    expect(samTiles()).toContain('extra:sam-toast')
    // A personal label that matches a catalogue word is deliberately
    // promoted as the stable catalogue token instead of duplicated as an
    // `extra:` token.
    expect(samTiles()).toContain('water')
    expect(samTiles()).not.toContain('extra:sam-water')

    await openCarerDrawer()
    const dialog = screen.getByRole('dialog', { name: 'Carer settings' })
    await user.click(within(dialog).getByRole('button', { name: /^Alex/ }))
    // The deliberate switch celebrates the newly chosen child only.
    const celebration = await screen.findByTestId('welcome-celebration')
    expect(celebration).toHaveTextContent('Hello Alex')
    expect(celebration).not.toHaveTextContent('Hello Sam')

    const alexTiles = Array.from(document.querySelectorAll('[data-tile-id]')).map((tile) =>
      tile.getAttribute('data-tile-id'),
    )
    expect(alexTiles).toContain('extra:alex-building-blocks')
    expect(alexTiles).not.toContain('extra:sam-toast')
    expect(speechMock().speak.mock.calls).toHaveLength(0)
  })

  it('keeps the protected core fixed and ordered for both starters across routines', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.click(await screen.findByRole('button', { name: /Alex/ }))
    await screen.findByLabelText('This is Alex’s board')

    for (const nickname of ['Alex', 'Sam']) {
      if (nickname !== 'Alex') {
        await openCarerDrawer()
        await user.click(
          within(screen.getByRole('dialog', { name: 'Carer settings' })).getByRole('button', {
            name: new RegExp(`^${nickname}`),
          }),
        )
      }
      for (const routine of Object.keys(ROUTINE_LABELS) as Routine[]) {
        const nav = screen.getByRole('navigation', { name: 'Routine' })
        await user.click(within(nav).getByRole('button', { name: ROUTINE_LABELS[routine] }))
        expect(coreTileIds()).toEqual([...PROTECTED_CORE_IDS])
      }
    }
  })

  it('welcome is non-blocking: the board stays usable underneath and no word is added', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.click(await screen.findByRole('button', { name: /Alex/ }))
    await screen.findByTestId('welcome-celebration')

    // While the celebration is up, the protected core already works.
    await user.click(screen.getByRole('button', { name: 'More, Core' }))
    expect(screen.getByRole('button', { name: 'Remove More, Core' })).toBeInTheDocument()

    // The overlay itself adds nothing to the authored message.
    expect(screen.queryByRole('button', { name: 'Remove Hello, Board' })).not.toBeInTheDocument()
    expect(speechMock().speak.mock.calls).toHaveLength(0)
    await waitFor(() => expect(screen.queryByTestId('welcome-celebration')).not.toBeInTheDocument(), { timeout: 3000 })
  })

  it('celebrates once per genuine new session with a stored active board', async () => {
    // Session one: choose Alex (deliberate), celebration shown and consumed.
    const user = userEvent.setup()
    const first = render(<App />)
    await user.click(await screen.findByRole('button', { name: /Alex/ }))
    await screen.findByTestId('welcome-celebration')
    await waitFor(() => expect(screen.queryByTestId('welcome-celebration')).not.toBeInTheDocument(), {
      timeout: 3000,
    })
    first.unmount()

    // Same session (reload): suppressed by the per-session marker.
    const second = render(<App />)
    await screen.findByRole('navigation', { name: 'Routine' })
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(screen.queryByTestId('welcome-celebration')).not.toBeInTheDocument()
    second.unmount()

    // A genuine NEW session (fresh sessionStorage): greets again exactly once.
    window.sessionStorage.clear()
    render(<App />)
    expect(await screen.findByTestId('welcome-celebration')).toHaveTextContent('Hello Alex')
    await waitFor(() => expect(screen.queryByTestId('welcome-celebration')).not.toBeInTheDocument(), {
      timeout: 3000,
    })
    // Routine changes and resume never replay it inside the same session.
    const nav = screen.getByRole('navigation', { name: 'Routine' })
    await user.click(within(nav).getByRole('button', { name: 'Food' }))
    expect(screen.queryByTestId('welcome-celebration')).not.toBeInTheDocument()
  })

  it('does not celebrate an incidental reload of the last active board', async () => {
    const user = userEvent.setup()
    const first = render(<App />)
    await user.click(await screen.findByRole('button', { name: /Sam/ }))
    await waitFor(() => expect(screen.queryByTestId('welcome-celebration')).not.toBeInTheDocument(), { timeout: 3000 })
    first.unmount()

    render(<App />)
    await screen.findByLabelText('This is Sam’s board')
    // Give any wrongly-scheduled celebration time to appear; none may.
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(screen.queryByTestId('welcome-celebration')).not.toBeInTheDocument()
  })

  it('lets a carer disable the celebration per child, and that persists locally', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.click(await screen.findByRole('button', { name: /Alex/ }))
    await screen.findByTestId('welcome-celebration')
    await waitFor(() => expect(screen.queryByTestId('welcome-celebration')).not.toBeInTheDocument(), { timeout: 3000 })

    await openCarerDrawer()
    const dialog = screen.getByRole('dialog', { name: 'Carer settings' })
    await user.click(within(dialog).getByRole('button', { name: 'Celebration off' }))
    await user.keyboard('{Escape}')

    // Switch away and back: no welcome this time.
    await openCarerDrawer()
    await user.click(within(screen.getByRole('dialog', { name: 'Carer settings' })).getByRole('button', { name: /^Sam/ }))
    expect(await screen.findByTestId('welcome-celebration')).toHaveTextContent('Hello Sam')
    await waitFor(() => expect(screen.queryByTestId('welcome-celebration')).not.toBeInTheDocument(), { timeout: 3000 })

    // A fresh tab session would normally make a profile welcome eligible again.
    // Alex's persisted preference—not the per-session marker—must suppress it.
    window.sessionStorage.clear()
    await openCarerDrawer()
    await user.click(within(screen.getByRole('dialog', { name: 'Carer settings' })).getByRole('button', { name: /^Alex/ }))
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(screen.queryByTestId('welcome-celebration')).not.toBeInTheDocument()

    // The carer's choice reaches local storage, not just the screen.
    await waitFor(async () => {
      const state = await loadLocalState()
      const alex = state.profiles.find((row) => row.nickname === 'Alex')
      expect(alex?.welcomeCelebration).toBe(false)
    })
  })

  it('restores missing starter boards idempotently without touching other profiles', async () => {
    const user = userEvent.setup()
    await seedProfile({ nickname: 'Cousin Ada', ageBand: '7-9' })
    render(<App />)
    await screen.findByLabelText('This is Cousin Ada’s board')

    await openCarerDrawer()
    await user.click(screen.getByRole('button', { name: 'Restore fictional demo boards' }))
    expect(await screen.findByText('Alex and Sam’s boards are ready. Switch boards to open them.')).toBeInTheDocument()

    let state = await loadLocalState()
    expect(state.profiles.map((profile) => profile.nickname)).toEqual(['Alex', 'Sam', 'Cousin Ada'])
    const ada = state.profiles.find((profile) => profile.nickname === 'Cousin Ada')
    expect(ada).toBeDefined()
    if (!ada) throw new Error('Cousin Ada profile missing after demo restore')
    expect(ada.extraWords).toEqual([])
    expect(ada.ageBand).toBe('7-9')

    // Second press changes nothing.
    await user.click(screen.getByRole('button', { name: 'Restore fictional demo boards' }))
    expect(await screen.findByText('Alex’s and Sam’s boards are already here.')).toBeInTheDocument()
    state = await loadLocalState()
    expect(state.profiles).toHaveLength(3)
    // No silent takeover: Cousin Ada keeps the active board.
    expect(state.activeProfileId).toBe(ada.id)
  })
})
