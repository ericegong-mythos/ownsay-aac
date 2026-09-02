import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { act, useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { CarerDrawer } from './CarerDrawer'
import type { ChildProfile } from '../../domain/types'
import { createProfile, previewImport } from '../../persistence/store'
import type { ImportRequestState } from './CarerDrawer'
import { collectDeviceCheck, runSpeechTest } from '../../domain/device-check'

vi.mock('../../domain/device-check', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../domain/device-check')>()
  return {
    ...actual,
    collectDeviceCheck: vi.fn(),
    runSpeechTest: vi.fn(),
  }
})

const profile: ChildProfile = createProfile({ nickname: 'Maya', ageBand: '7-9' })

const idleImport: ImportRequestState = { status: 'idle' }

function renderDrawer(overrides: Partial<Parameters<typeof CarerDrawer>[0]> = {}) {
  const props = {
    open: true,
    profile,
    helperStatus: 'off' as const,
    onSetupHelper: vi.fn(),
    onCancelHelperDownload: vi.fn(),
    onDisableHelper: vi.fn(),
    onRetryHelper: vi.fn(),
    profiles: [profile],
    voices: [
      { uri: 'v-uk', name: 'Sonia', lang: 'en-GB', localService: true },
      { uri: 'v-us', name: 'Aria', lang: 'en-US', localService: true },
    ],
    importRequest: idleImport,
    onClose: vi.fn(),
    onChangeProfile: vi.fn(),
    onSwitchProfile: vi.fn(),
    onAddProfile: vi.fn(),
    onRemoveProfile: vi.fn(),
    onRestoreDemoProfiles: vi.fn(),
    onExport: vi.fn(),
    onImportFile: vi.fn(),
    onImportConfirm: vi.fn(),
    onImportCancel: vi.fn(),
    onClear: vi.fn(),
    ...overrides,
  }
  render(<CarerDrawer {...props} />)
  return props
}

describe('carer drawer', () => {
  it('shows whose board this is and its tailoring', () => {
    renderDrawer()
    expect(screen.getByText('Maya')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: '7–9' }).length).toBeGreaterThan(0)
  })

  it('provides a self-contained written quick guide', () => {
    renderDrawer()
    expect(screen.getByText('Quick guide')).toBeInTheDocument()
    expect(screen.getByText(/OwnSay never speaks by itself/)).toBeInTheDocument()
    expect(screen.getByText(/remain available offline/)).toBeInTheDocument()
    expect(document.querySelector('video')).toBeNull()
  })

  it('commits a nickname edit on blur with sanitising fallback', async () => {
    const user = userEvent.setup()
    const props = renderDrawer()
    const input = screen.getByLabelText(/Nickname/)
    await user.clear(input)
    await user.type(input, 'Theo')
    fireEvent.blur(input)
    expect(props.onChangeProfile).toHaveBeenCalledWith(expect.objectContaining({ nickname: 'Theo' }))
  })

  it('commits a Unicode nickname using the same stored-text contract', async () => {
    const user = userEvent.setup()
    const props = renderDrawer()
    const input = screen.getByLabelText(/Nickname/)
    await user.clear(input)
    await user.type(input, 'Sam 😊')
    fireEvent.blur(input)
    expect(props.onChangeProfile).toHaveBeenCalledWith(expect.objectContaining({ nickname: 'Sam 😊' }))
  })

  it('switches between sibling profiles only through the protected list', async () => {
    const user = userEvent.setup()
    const theo = createProfile({ nickname: 'Theo', ageBand: '4-6' })
    const props = renderDrawer({ profiles: [profile, theo] })
    await user.click(screen.getByRole('button', { name: /Theo/ }))
    expect(props.onSwitchProfile).toHaveBeenCalledWith(theo.id)
  })

  it('adds another child through the guarded two-step form', async () => {
    const user = userEvent.setup()
    const props = renderDrawer({ profiles: [profile] })
    await user.click(screen.getByRole('button', { name: 'Add another child' }))
    await user.type(screen.getByLabelText(/New child’s nickname/), 'Sam 😊')
    expect(screen.getByRole('button', { name: 'Create board' })).toBeDisabled()
    await user.click(
      within(screen.getByRole('group', { name: /New child’s age group/ })).getByRole('button', { name: '10–12' }),
    )
    await user.click(screen.getByRole('button', { name: 'Create board' }))
    expect(props.onAddProfile).toHaveBeenCalledWith({ nickname: 'Sam 😊', ageBand: '10-12' })
  })

  it('requires confirmation before removing the active board', async () => {
    const user = userEvent.setup()
    const theo = createProfile({ nickname: 'Theo', ageBand: '4-6' })
    const props = renderDrawer({ profiles: [profile, theo] })
    await user.click(screen.getByRole('button', { name: 'Remove this board' }))
    expect(props.onRemoveProfile).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: /Really remove Maya’s board/ }))
    expect(props.onRemoveProfile).toHaveBeenCalledWith(profile.id)
  })

  it('manages extra words with add and remove', async () => {
    const user = userEvent.setup()
    const withWords: ChildProfile = {
      ...profile,
      extraWords: [{ id: 'w1', label: 'Grandma' }],
    }
    const props = renderDrawer({ profile: withWords })
    expect(screen.getByText('Grandma')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Remove extra word Grandma' }))
    expect(props.onChangeProfile).toHaveBeenCalledWith(expect.objectContaining({ extraWords: [] }))
    await user.type(screen.getByLabelText(/New extra word/), 'Ollie')
    await user.click(screen.getByRole('button', { name: 'Add word' }))
    expect(props.onChangeProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        extraWords: [withWords.extraWords[0], { id: expect.any(String), label: 'Ollie', tone: 'context' }],
      }),
    )
  })

  it('adds an emoji as a personal word without later parser drift', async () => {
    const user = userEvent.setup()
    const props = renderDrawer()
    await user.type(screen.getByLabelText(/New extra word/), '🧸')
    await user.click(screen.getByRole('button', { name: 'Add word' }))
    expect(props.onChangeProfile).toHaveBeenCalledWith(
      expect.objectContaining({ extraWords: [{ id: expect.any(String), label: '🧸', tone: 'context' }] }),
    )
  })

  it('persists a per-profile voice choice', async () => {
    const user = userEvent.setup()
    const props = renderDrawer()
    const select = screen.getByLabelText(/^Spoken voice for Maya/) as HTMLSelectElement
    await user.selectOptions(select, 'v-uk')
    expect(props.onChangeProfile).toHaveBeenCalledWith(expect.objectContaining({ voiceURI: 'v-uk' }))
  })

  it('offers only voices explicitly verified as on-device', () => {
    renderDrawer({
      voices: [
        { uri: 'v-remote', name: 'Remote Voice', lang: 'en-GB', localService: false },
        { uri: 'v-local', name: 'Local Voice', lang: 'en-US', localService: true },
      ],
    })
    expect(screen.queryByRole('option', { name: /Remote Voice/ })).not.toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Local Voice · on-device (en-US)' })).toBeInTheDocument()
    expect(screen.getByText(/lists and uses only voices this browser explicitly reports as on-device/)).toBeInTheDocument()
  })

  it('shows an honest text-only state when no verified on-device voice exists', () => {
    const staleProfile = { ...profile, voiceURI: 'v-remote' }
    renderDrawer({
      profile: staleProfile,
      profiles: [staleProfile],
      voices: [{ uri: 'v-remote', name: 'Remote Voice', lang: 'en-GB', localService: false }],
    })
    const select = screen.getByLabelText(/^Spoken voice for Maya/) as HTMLSelectElement
    expect(select).toBeDisabled()
    expect(select).toHaveValue('')
    expect(screen.getByRole('option', { name: 'No verified on-device voice · text only' })).toBeInTheDocument()
  })

  it('previews an import and applies only after explicit confirmation', async () => {
    const user = userEvent.setup()
    const bundlePreview = previewImport(backupJson())
    const props = renderDrawer({
      importRequest: { status: 'preview', fileName: 'backup.json', preview: bundlePreview },
    })
    expect(screen.getByText(/Restore “backup.json”\?/)).toBeInTheDocument()
    expect(screen.getByText(/Contains 1 board \(Maya\)/)).toBeInTheDocument()
    expect(props.onImportConfirm).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Restore backup' }))
    expect(props.onImportConfirm).toHaveBeenCalledTimes(1)
  })

  it('can keep the current boards instead of restoring', async () => {
    const user = userEvent.setup()
    const props = renderDrawer({
      importRequest: { status: 'preview', fileName: 'backup.json', preview: previewImport(backupJson()) },
    })
    await user.click(screen.getByRole('button', { name: 'Keep current' }))
    expect(props.onImportCancel).toHaveBeenCalledTimes(1)
    expect(props.onImportConfirm).not.toHaveBeenCalled()
  })

  it('explains a rejected backup calmly without touching data', () => {
    renderDrawer({
      importRequest: { status: 'error', fileName: 'broken.json', message: 'That file could not be read as a backup.' },
    })
    expect(screen.getByRole('alert')).toHaveTextContent(/could not be read as a backup/i)
  })

  it('requires a deliberate second press before erasing local data', async () => {
    const user = userEvent.setup()
    const props = renderDrawer()
    await user.click(screen.getByRole('button', { name: 'Clear local data' }))
    expect(props.onClear).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: /Erase everything/ }))
    expect(props.onClear).toHaveBeenCalledTimes(1)
  })

  it('locks mutating controls and announces itself while a store operation runs', () => {
    renderDrawer({ busy: 'restoring' })
    expect(screen.getByRole('status')).toHaveTextContent(/Restoring backup/)
    expect(screen.getByLabelText(/Nickname/)).toBeDisabled()
    expect(screen.getByLabelText('New extra word')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Add another child' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Download backup' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Clear local data' })).toBeDisabled()
    // The escape hatch stays reachable.
    expect(screen.getByRole('button', { name: 'Close carer settings' })).toBeEnabled()
  })

  it('resets every profile-scoped transient when the drawer closes or changes child', async () => {
    const user = userEvent.setup()
    const sam = createProfile({ nickname: 'Sam', ageBand: '4-6' })
    const alex: ChildProfile = {
      ...createProfile({ nickname: 'Alex', ageBand: '4-6' }),
      extraWords: [{ id: 'w1', label: 'Grandma' }],
    }
    const changeSpy = vi.fn()

    function Harness() {
      // Mirrors App: one mounted drawer whose profile/open props move while
      // the component itself never unmounts.
      const [current, setCurrent] = useState(alex)
      const [open, setOpen] = useState(true)
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Reopen carer settings
          </button>
          <CarerDrawer
            open={open}
            profile={current}
            helperStatus="off"
            onSetupHelper={() => {}}
            onCancelHelperDownload={() => {}}
            onDisableHelper={() => {}}
            onRetryHelper={() => {}}
            profiles={[alex, sam]}
            voices={[]}
            importRequest={idleImport}
            onClose={() => setOpen(false)}
            onChangeProfile={changeSpy}
            onSwitchProfile={(id) => setCurrent(id === alex.id ? alex : sam)}
            onAddProfile={() => {}}
            onRemoveProfile={() => {}}
            onRestoreDemoProfiles={() => {}}
            onExport={() => {}}
            onImportFile={() => {}}
            onImportConfirm={() => {}}
            onImportCancel={() => {}}
            onClear={() => {}}
          />
        </>
      )
    }
    render(<Harness />)

    // Half-typed personal word for Alex, with a routine choice and a warning.
    const wordInput = screen.getByLabelText('New extra word')
    await user.type(wordInput, 'Grandma')
    await user.click(screen.getByRole('button', { name: 'Add word' }))
    expect(screen.getByRole('alert')).toHaveTextContent(/already on this board/)
    await user.type(wordInput, ' Gran')
    await user.click(
      within(screen.getByRole('group', { name: 'Where the new word shows' })).getByRole('button', {
        name: 'Food',
      }),
    )
    // A pending add-profile form and a pending removal confirmation too.
    await user.click(screen.getByRole('button', { name: 'Add another child' }))
    await user.type(screen.getByLabelText(/New child’s nickname/), 'Half')
    await user.click(screen.getByRole('button', { name: 'Remove this board' }))
    expect(screen.getByRole('button', { name: /Really remove Alex’s board/ })).toBeInTheDocument()

    // Switch to Sam: the drawer stays mounted, so only the reset stands
    // between Alex's drafts and Sam's drawer.
    await user.click(screen.getByRole('button', { name: /^Sam/ }))

    expect(screen.getByLabelText('New extra word')).toHaveValue('')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add another child' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Really remove/ })).not.toBeInTheDocument()
    expect(screen.getByText('Sam')).toBeInTheDocument()

    // Alex's half-typed word can never be saved onto Sam's board: the add
    // control is disabled until something new is typed for Sam.
    expect(changeSpy).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Add word' }))
    expect(changeSpy).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Add word' })).toBeDisabled()

    // Closing and reopening also starts clean, even for the same child.
    await user.type(screen.getByLabelText('New extra word'), 'Spare')
    await user.click(screen.getByRole('button', { name: 'Close carer settings' }))
    await user.click(screen.getByRole('button', { name: 'Reopen carer settings' }))
    expect(screen.getByLabelText('New extra word')).toHaveValue('')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('closes on Escape and restores focus to the trigger', async () => {
    function DrawerHarness() {
      const [open, setOpen] = useState(false)
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Hold for carer
          </button>
          <CarerDrawer
            open={open}
            profile={profile}
            helperStatus="off"
            onSetupHelper={() => {}}
            onCancelHelperDownload={() => {}}
            onDisableHelper={() => {}}
            onRetryHelper={() => {}}
            profiles={[profile]}
            voices={[]}
            importRequest={idleImport}
            onClose={() => setOpen(false)}
            onChangeProfile={() => {}}
            onSwitchProfile={() => {}}
            onAddProfile={() => {}}
            onRemoveProfile={() => {}}
            onRestoreDemoProfiles={() => {}}
            onExport={() => {}}
            onImportFile={() => {}}
            onImportConfirm={() => {}}
            onImportCancel={() => {}}
            onClear={() => {}}
          />
        </>
      )
    }
    const user = userEvent.setup()
    render(<DrawerHarness />)
    const trigger = screen.getByRole('button', { name: 'Hold for carer' })
    await user.click(trigger)

    await screen.findByRole('dialog', { name: 'Carer settings' })
    expect(document.activeElement).not.toBe(trigger)
    expect(screen.getByRole('dialog')).toContainElement(document.activeElement as HTMLElement | null)

    // The Escape handler is a native document listener; wrap so React flushes.
    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' })
    })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(document.activeElement).toBe(trigger)
  })

  it('keeps Tab cycling inside the dialog', () => {
    renderDrawer()
    const dialog = screen.getByRole('dialog', { name: 'Carer settings' })
    const focusables = Array.from(dialog.querySelectorAll<HTMLElement>('button'))
    expect(focusables.length).toBeGreaterThan(2)

    focusables[0]?.focus()
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(focusables[focusables.length - 1])

    focusables[focusables.length - 1]?.focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(focusables[0])
  })

  describe('device check audible proof', () => {
    function makeReport() {
      return {
        generatedAtUtc: new Date().toISOString(),
        appVersion: '1.1.1',
        summary: {
          core: 'ready',
          savedLocally: 'yes',
          offlineShell: 'shell-cached',
          speech: 'ready',
          localHelper: 'unavailable',
        },
        browser: { userAgent: 'test', platform: 'test', online: true, languages: [], secureContext: true, fireDevicePolicy: false },
        display: {
          screen: '', screenAvailable: null, innerViewport: '', visualViewport: null,
          visualViewportScale: null, orientationType: null, devicePixelRatio: 1,
          maxTouchPoints: null, reducedMotion: null, forcedColors: null,
        },
        hardware: { hardwareConcurrency: null, deviceMemoryGb: null },
        storage: {
          indexedDbRoundTrip: { value: true },
          serviceWorker: { value: 'registered · sw.js · scope / · controlled' },
          cacheStorageRoundTrip: { value: 'round-trip ok' },
          shellCaches: { value: 'none yet' },
          shellCacheVerified: { value: false },
          estimate: { value: 'x' },
          persisted: { value: false },
        },
        media: { mp3: '', wav: '' },
        graphics: { webgl2: false, webgl1: false, webgpuAdapterAndDevice: { value: 'absent' } },
        speechCapability: {
          synthesisPresent: true, localVoiceCount: 2, voiceCount: 2, enGbVoices: 1, englishVoices: 2,
          defaultVoiceLang: 'en-GB', defaultVoiceLocal: true,
        },
        resourceOrigins: [],
      } as Awaited<ReturnType<typeof collectDeviceCheck>>
    }

    async function openDeviceCheckSection(): Promise<HTMLElement> {
      vi.mocked(collectDeviceCheck).mockResolvedValue(makeReport())
      renderDrawer()
      await userEvent.setup().click(screen.getByRole('button', { name: 'Run device check' }))
      await screen.findByText(/Verified on-device speech:/)
      return screen.getByRole('dialog', { name: 'Carer settings' })
    }

    it('never runs the speech test by itself and keeps capability evidence separate', async () => {
      const dialog = await openDeviceCheckSection()
      expect(vi.mocked(runSpeechTest)).not.toHaveBeenCalled()
      // Capability line never claims "ready" as an audible fact.
      expect(dialog.textContent).not.toContain('Speech ready')
      expect(dialog.textContent).toContain('not yet a hearing check')
      expect(screen.getByRole('button', { name: 'Play test phrase' })).toBeEnabled()
    })

    it('asks the carer whether they heard a completed attempt and records the answer', async () => {
      vi.mocked(runSpeechTest).mockResolvedValue({
        started: true, ended: true, error: null, timedOut: false,
      })
      await openDeviceCheckSection()
      const user = userEvent.setup()
      await user.click(screen.getByRole('button', { name: 'Play test phrase' }))
      expect(await screen.findByText('Test phrase finished. Did you hear it?')).toBeInTheDocument()

      // No "ready" claim before the carer confirms hearing.
      expect(document.body.textContent).not.toContain('Speech ready')

      await user.click(screen.getByRole('button', { name: 'I heard it' }))
      expect(screen.getByText('Audible check: you heard the test phrase.')).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'I did not hear it' })).not.toBeInTheDocument()
    })

    it('records an honest not-heard answer when the carer says so', async () => {
      vi.mocked(runSpeechTest).mockResolvedValue({
        started: true, ended: true, error: null, timedOut: false,
      })
      await openDeviceCheckSection()
      const user = userEvent.setup()
      await user.click(screen.getByRole('button', { name: 'Play test phrase' }))
      await screen.findByText('Test phrase finished. Did you hear it?')
      await user.click(screen.getByRole('button', { name: 'I did not hear it' }))
      expect(
        screen.getByText('Audible check: recorded as not heard. Try another voice above.'),
      ).toBeInTheDocument()
    })

    it('shows a could-not-start outcome with no hearing prompt at all', async () => {
      vi.mocked(runSpeechTest).mockResolvedValue({
        started: false, ended: false, error: null, timedOut: false,
      })
      await openDeviceCheckSection()
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Play test phrase' }))
      })
      await screen.findByText(/could not start on this device/)
      expect(screen.queryByRole('button', { name: /I heard it/ })).not.toBeInTheDocument()
    })

    it('shows a stopped outcome after a timeout, again without any ready claim', async () => {
      vi.mocked(runSpeechTest).mockResolvedValue({
        started: true, ended: false, error: null, timedOut: true,
      })
      await openDeviceCheckSection()
      const user = userEvent.setup()
      await user.click(screen.getByRole('button', { name: 'Play test phrase' }))
      expect(await screen.findByText(/did not finish — it was stopped/)).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /I heard it/ })).not.toBeInTheDocument()
      expect(document.body.textContent).not.toContain('Speech ready')
    })

    it('disables Play while an attempt is running', async () => {
      let resolveAttempt: ((value: Awaited<ReturnType<typeof runSpeechTest>>) => void) | undefined
      vi.mocked(runSpeechTest).mockImplementation(
        () => new Promise((resolve) => { resolveAttempt = resolve }),
      )
      await openDeviceCheckSection()
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Play test phrase' }))
      })
      expect(screen.getByRole('button', { name: 'Playing…' })).toBeDisabled()
      await act(async () => {
        resolveAttempt?.({ started: true, ended: true, error: null, timedOut: false })
      })
      await screen.findByText('Test phrase finished. Did you hear it?')
    })
  })
})

function backupJson(): string {
  return JSON.stringify({
    app: 'ownsay-aac',
    schema: 2,
    exportedAt: '2026-08-22T09:00:00.000Z',
    disclaimer: 'test',
    profiles: [{ ...createProfile({ nickname: 'Maya', ageBand: '7-9' }), id: 'prf-fixed' }],
    events: [],
  })
}
