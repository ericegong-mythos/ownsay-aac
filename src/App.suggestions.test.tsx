import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from './App'
import type { ModelInput } from './domain/policy'
import { createProfile } from './persistence/store'
import type { AuthoredToken, DemoPreferences, HelperStatus, Suggestion } from './domain/types'
import type { InferenceResult } from './inference/adapter'
import { seedProfile } from './test/seedProfile'

const deferreds: Array<{ resolve: (value: unknown) => void }> = []
const activationDeferreds: Array<{ resolve: (value: HelperStatus) => void }> = []

const activateMock = vi.fn<(onProgress?: (text: string) => void) => Promise<HelperStatus>>()
const generateMock = vi.fn<
  (
    prefs: DemoPreferences,
    message: readonly AuthoredToken[],
    input: ModelInput,
    status: HelperStatus,
  ) => Promise<InferenceResult>
>()
const probeMock = vi.fn<() => Promise<'absent' | 'failed' | 'ok'>>()

vi.mock('./inference/adapter', async (importOriginal) => {
  const original = await importOriginal<typeof import('./inference/adapter')>()
  return {
    ...original,
    probeWebGpuSupport: () => probeMock(),
    activateLocalHelper: (onProgress?: (text: string) => void) => activateMock(onProgress),
    deactivateLocalHelper: () => {},
    generateSuggestions: (
      prefs: DemoPreferences,
      message: readonly AuthoredToken[],
      input: ModelInput,
      status: HelperStatus,
    ) => generateMock(prefs, message, input, status),
  }
})

function pendingActivation(): Promise<HelperStatus> {
  return new Promise((resolve) => {
    activationDeferreds.push({ resolve })
  })
}

type SpeechMock = { speak: { mock: { calls: unknown[] } }; stop: { mock: { calls: unknown[] } } }

function speechMock(): SpeechMock {
  return (globalThis as unknown as { __speechMock: SpeechMock }).__speechMock
}

/**
 * Model setup lives behind the held carer drawer — never one tap from the
 * child surface.
 */
async function confirmIntelligenceSetup(
  user: ReturnType<typeof userEvent.setup>,
  keepDrawerOpen = false,
): Promise<void> {
  // The board must have loaded before carer controls exist.
  await screen.findByText(/Phrases that fit this routine|Paused/)
  const hold = screen.getByRole('button', { name: 'Open carer settings' })
  fireEvent.click(hold, { detail: 0 })
  const dialog = await screen.findByRole('dialog', { name: 'Carer settings' }, { timeout: 2000 })
  expect(within(dialog).getByText(/about 200 MB/)).toBeInTheDocument()
  const button = within(dialog).getByRole('button', { name: 'Download on this device' })
  await user.click(button)
  if (!keepDrawerOpen) {
    await user.click(within(dialog).getByRole('button', { name: 'Close carer settings' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Carer settings' })).not.toBeInTheDocument())
  }
}

beforeEach(async () => {
  const { clearLocalData } = await import('./persistence/store')
  await clearLocalData()
  await seedProfile()
  deferreds.length = 0
  activationDeferreds.length = 0
  activateMock.mockReset().mockImplementation(() => pendingActivation())
  generateMock.mockReset().mockImplementation(() => new Promise<InferenceResult>(() => {}))
  probeMock.mockReset().mockResolvedValue('ok')
})

async function openCarerDialog(): Promise<void> {
  await screen.findByRole('navigation', { name: 'Routine' })
  const hold = screen.getByRole('button', { name: 'Open carer settings' })
  fireEvent.click(hold, { detail: 0 })
  await screen.findByRole('dialog', { name: 'Carer settings' }, { timeout: 2000 })
}

describe('OwnSay Intelligence state machine', () => {
  it('stops at an honest unsupported state on hardware without WebGPU and downloads nothing', async () => {
    const user = userEvent.setup()
    // Fire-class device: no gpu property at all.
    probeMock.mockResolvedValue('absent')
    render(<App />)

    await confirmIntelligenceSetup(user)
    const panel = await screen.findByLabelText('OwnSay Intelligence')
    await within(panel).findByText('Not on this tablet')
    expect(within(panel).getByText(/nothing was downloaded/)).toBeInTheDocument()
    expect(activateMock).not.toHaveBeenCalled()
    expect(generateMock).not.toHaveBeenCalled()

    // The opt-in is reverted and the dock stays fully useful.
    expect(within(panel).queryByRole('button', { name: 'Try again' })).toBeNull()
    expect(screen.getByText(/Instant phrases for this routine/)).toBeInTheDocument()
    expect(speechMock().speak.mock.calls).toHaveLength(0)

    // The carer opt-in was reverted so a reload never auto-retries.
    const store = await import('./persistence/store')
    const persisted = await store.loadLocalState()
    expect(persisted.profiles.every((row) => row.helperEnabled === false)).toBe(true)
  })

  it('never lets a delayed model response change what the child sees', async () => {
    const user = userEvent.setup()
    activateMock.mockResolvedValue('ready')
    // Generation hangs until the test resolves it, mimicking a slow model.
    generateMock.mockImplementation(
      () =>
        new Promise<InferenceResult>((resolve) => {
          deferreds.push({ resolve: resolve as (value: unknown) => void })
        }),
    )
    render(<App />)

    // Setup is visible, but the download still requires an explicit carer warning.
    await confirmIntelligenceSetup(user)
    await waitFor(() => expect(activateMock).toHaveBeenCalledTimes(1))

    await waitFor(() => expect(generateMock).toHaveBeenCalled(), { timeout: 2000 })

    // First generation request is pending. The child keeps authoring anyway.
    await user.click(screen.getByRole('button', { name: 'Yes, Core' }))
    await user.click(screen.getByRole('button', { name: 'Delete last' }))

    // The slow response lands late carrying model output for a stale state.
    expect(deferreds.length).toBeGreaterThan(0)
    const modelRow: Suggestion = {
      id: 'local-model:want play',
      tokens: [
        { id: 'want', label: 'Want' },
        { id: 'play', label: 'Play' },
      ],
      source: 'local-model',
    }
    deferreds.forEach((entry) =>
      entry.resolve({
        suggestions: [modelRow],
        status: 'ready',
        usedModel: true,
      }),
    )

    // The dock must stay deterministic: stale model output never reaches the child.
    expect(screen.queryByText('Want Play')).not.toBeInTheDocument()
    expect(screen.getByText(/Instant phrases for this routine/)).toBeInTheDocument()
    expect(speechMock().speak.mock.calls).toHaveLength(0)
  })

  it('stays off when loading finishes after the download was cancelled', async () => {
    const user = userEvent.setup()
    render(<App />)

    await confirmIntelligenceSetup(user, true)
    expect(screen.getByText('Downloading')).toBeInTheDocument()

    // Cancel lives behind the carer-only drawer.
    await user.click(screen.getByRole('button', { name: 'Cancel download' }))
    expect(within(screen.getByLabelText('OwnSay Intelligence')).getByText('Not set up')).toBeInTheDocument()

    await act(async () => {
      activationDeferreds.forEach((entry) => entry.resolve('ready'))
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(within(screen.getByLabelText('OwnSay Intelligence')).getByText('Not set up')).toBeInTheDocument()
      expect(within(screen.getByLabelText('OwnSay Intelligence')).queryByText('Ready')).not.toBeInTheDocument()
      // Re-enabling stays a deliberate carer action in the still-open drawer.
      expect(screen.getByRole('button', { name: 'Download on this device' })).toBeInTheDocument()
    })
    expect(speechMock().speak.mock.calls).toHaveLength(0)
  })

  it('reaches Ready through the visible setup and labels model phrases honestly', async () => {
    const user = userEvent.setup()
    generateMock.mockResolvedValue({
      suggestions: [
        {
          id: 'local-model:i want game',
          tokens: [
            { id: 'i', label: 'I' },
            { id: 'want', label: 'Want' },
            { id: 'game', label: 'Game' },
          ],
          source: 'local-model',
        },
      ],
      status: 'ready',
      usedModel: true,
    })
    activateMock.mockResolvedValue('ready')
    render(<App />)

    await confirmIntelligenceSetup(user)
    await waitFor(
      () => {
        const panel = screen.getByLabelText('OwnSay Intelligence')
        expect(within(panel).getByText('Ready')).toBeInTheDocument()
      },
      { timeout: 2000 },
    )

    const dock = screen.getByLabelText('Optional local suggestions')
    await waitFor(() => {
      const chips = Array.from(dock.querySelectorAll('button'))
      expect(chips.length).toBeGreaterThan(0)
      const labelled = chips.filter((chip) => chip.textContent?.includes('OwnSay'))
      expect(labelled.length).toBeGreaterThan(0)
      expect(labelled[0]?.getAttribute('aria-label')).toContain('(OwnSay phrase)')
    })
    expect(within(dock).getByText(/chosen on this device/)).toBeInTheDocument()

    // Routine changes keep flowing to generation while ready.
    await user.click(
      within(screen.getByRole('navigation', { name: 'Routine' })).getByRole('button', { name: 'Food' }),
    )
    await waitFor(() => expect(generateMock.mock.calls.length).toBeGreaterThan(1))
    const latestCall = generateMock.mock.calls.at(-1)
    expect(latestCall?.[0].routine).toBe('food')

    // Turning off returns to instant phrases honestly (carer-only control).
    await openCarerDialog()
    await user.click(screen.getByRole('button', { name: 'Turn off' }))
    await waitFor(() => expect(screen.getByText(/Instant phrases for this routine/)).toBeInTheDocument())
    expect(speechMock().speak.mock.calls).toHaveLength(0)
  })

  it('removes stale model rows immediately while a new routine refresh is pending', async () => {
    const user = userEvent.setup()
    activateMock.mockResolvedValue('ready')
    generateMock
      .mockResolvedValueOnce({
        suggestions: [
          {
            id: 'local-model:i want game',
            tokens: [
              { id: 'i', label: 'I' },
              { id: 'want', label: 'Want' },
              { id: 'game', label: 'Game' },
            ],
            source: 'local-model',
          },
        ],
        status: 'ready',
        usedModel: true,
      })
      .mockImplementation(
        () =>
          new Promise<InferenceResult>((resolve) => {
            deferreds.push({ resolve: resolve as (value: unknown) => void })
          }),
      )
    render(<App />)

    await confirmIntelligenceSetup(user)
    const dock = await screen.findByLabelText('Optional local suggestions')
    expect(
      await within(dock).findByRole('button', {
        name: 'Add suggestion: I Want Game (OwnSay phrase)',
      }),
    ).toBeEnabled()

    const nav = screen.getByRole('navigation', { name: 'Routine' })
    await user.click(within(nav).getByRole('button', { name: 'Food' }))

    // The old model row is invalid as soon as the routine changes. The next
    // model ranking remains pending, but the new routine's instant phrases are
    // visible, enabled and usable throughout the refresh.
    expect(
      within(dock).queryByRole('button', {
        name: 'Add suggestion: I Want Game (OwnSay phrase)',
      }),
    ).not.toBeInTheDocument()
    expect(within(dock).getByText(/Instant phrases for this routine/)).toBeInTheDocument()
    const instant = within(dock).getByRole('button', {
      name: 'Add suggestion: I Hungry (instant phrase)',
    })
    expect(instant).toBeEnabled()
    await waitFor(() => expect(generateMock.mock.calls.length).toBeGreaterThanOrEqual(2))

    await user.click(instant)
    const rail = screen.getByRole('region', { name: 'Authorship rail' })
    expect(within(rail).getByRole('button', { name: 'Remove I, Local suggestion' })).toBeInTheDocument()
    expect(within(rail).getByRole('button', { name: 'Remove Hungry, Local suggestion' })).toBeInTheDocument()
    expect(speechMock().speak.mock.calls).toHaveLength(0)
  })

  it('enters a calm recoverable degraded state when generation fails instead of claiming on-device output', async () => {
    const user = userEvent.setup()
    let callCount = 0
    activateMock.mockResolvedValue('ready')
    generateMock.mockImplementation(() => {
      callCount += 1
      if (callCount === 1) {
        return Promise.resolve({ suggestions: [], status: 'degraded' as HelperStatus, usedModel: false })
      }
      return Promise.resolve({
        suggestions: [
          {
            id: 'local-model:i want game',
            tokens: [
              { id: 'i', label: 'I' },
              { id: 'want', label: 'Want' },
              { id: 'game', label: 'Game' },
            ],
            source: 'local-model',
          },
        ],
        status: 'ready' as HelperStatus,
        usedModel: true,
      })
    })
    render(<App />)

    await confirmIntelligenceSetup(user)
    const panel = await screen.findByLabelText('OwnSay Intelligence')
    await within(panel).findByText('Trouble')
    expect(within(panel).getByText(/could not finish just now/)).toBeInTheDocument()
    // The dock must NOT claim the instant fallback was chosen on-device.
    const dock = screen.getByLabelText('Optional local suggestions')
    expect(within(dock).getByText(/Instant phrases for this routine/)).toBeInTheDocument()
    expect(within(dock).queryByText(/chosen on this device/)).not.toBeInTheDocument()

    // Try again recovers to Ready with honest model labelling (carer-only).
    await openCarerDialog()
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(
      () => {
        expect(within(panel).getByText('Ready')).toBeInTheDocument()
      },
      { timeout: 2000 },
    )
    expect(generateMock.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(speechMock().speak.mock.calls).toHaveLength(0)
  })

  it('explains unavailability honestly and keeps instant phrases working', async () => {
    const user = userEvent.setup()
    activateMock.mockResolvedValue('unavailable')
    render(<App />)

    await confirmIntelligenceSetup(user)
    await waitFor(
      () => {
        const panel = screen.getByLabelText('OwnSay Intelligence')
        expect(within(panel).getByText('Unavailable')).toBeInTheDocument()
      },
      { timeout: 2000 },
    )
    expect(
      screen.getByText(/cannot run the on-device model right now. The board and instant phrases still work offline/),
    ).toBeInTheDocument()
    await openCarerDialog()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled()
    const dialog = screen.getByRole('dialog', { name: 'Carer settings' })
    await user.click(within(dialog).getByRole('button', { name: 'Close carer settings' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Carer settings' })).not.toBeInTheDocument())

    // The board keeps working: deterministic suggestions remain.
    await user.click(screen.getByRole('button', { name: 'Yes, Core' }))
    expect(await screen.findByText(/Instant phrases for this routine/)).toBeInTheDocument()
    expect(speechMock().speak.mock.calls).toHaveLength(0)
  })

  it('offers an explicit wake after reload without eager model loading', async () => {
    const store = await import('./persistence/store')
    // The boards on this device were left with intelligence enabled before
    // the reload; the model itself must still wait for an explicit wake.
    const state = await store.loadLocalState()
    for (const row of state.profiles) await store.saveProfile({ ...row, helperEnabled: true })

    const user = userEvent.setup()
    activateMock.mockResolvedValue('ready')
    render(<App />)

    const panel = await screen.findByLabelText('OwnSay Intelligence')
    expect(await within(panel).findByText('Paused')).toBeInTheDocument()
    expect(activateMock).not.toHaveBeenCalled()
    expect(
      screen.getByText(/a carer can wake it; waking may need internet/i),
    ).toBeInTheDocument()

    await openCarerDialog()
    await user.click(screen.getByRole('button', { name: 'Wake OwnSay Intelligence' }))
    await waitFor(
      () => {
        const panel = screen.getByLabelText('OwnSay Intelligence')
        expect(within(panel).getByText('Ready')).toBeInTheDocument()
      },
      { timeout: 2000 },
    )
    expect(activateMock).toHaveBeenCalledTimes(1)
    expect(speechMock().speak.mock.calls).toHaveLength(0)
  })

  it('keeps sibling boards isolated when switching profiles', async () => {
    const { saveProfile, setActiveProfileId } = await import('./persistence/store')
    const maya = createProfile({ nickname: 'Maya', ageBand: '4-6', routine: 'home' })
    const theo = createProfile({ nickname: 'Theo', ageBand: '10-12', routine: 'school' })
    await saveProfile(maya)
    await saveProfile(theo)
    await setActiveProfileId(maya.id)

    const user = userEvent.setup()
    render(<App />)
    await screen.findByRole('navigation', { name: 'Routine' })
    expect(screen.getAllByText('Maya').length).toBeGreaterThan(0)

    // Deliberate protected switch lives behind the carer hold.
    const hold = screen.getByRole('button', { name: 'Open carer settings' })
    hold.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    const dialog = await screen.findByRole('dialog', { name: 'Carer settings' }, { timeout: 3000 })
    hold.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    await user.click(within(dialog).getByRole('button', { name: /Theo/ }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    expect(await screen.findAllByText('Theo').then((rows) => rows.length)).toBeGreaterThan(0)
    // Theo's own default routine applies, never Maya's.
    const nav = screen.getByRole('navigation', { name: 'Routine' })
    expect(within(nav).getByRole('button', { name: 'School' })).toHaveAttribute('aria-pressed', 'true')
    expect(speechMock().speak.mock.calls).toHaveLength(0)
  })
})
