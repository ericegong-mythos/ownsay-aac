import 'fake-indexeddb/auto'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { App } from './App'
import {
  clearLocalData,
  createProfile,
  saveProfile,
  setActiveProfileId,
} from './persistence/store'

type SpeechMock = { speak: { mock: { calls: unknown[] } }; stop: { mock: { calls: unknown[] }; mockClear: () => void } }

function speechMock(): SpeechMock {
  return (globalThis as unknown as { __speechMock: SpeechMock }).__speechMock
}

async function seedTwoProfiles() {
  const maya = createProfile({ nickname: 'Maya', ageBand: '7-9' })
  const theo = createProfile({ nickname: 'Theo', ageBand: '7-9' })
  await saveProfile(maya)
  await saveProfile(theo)
  await setActiveProfileId(maya.id)
  return { maya, theo }
}

async function beginUtterance(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Yes, Core' }))
  await user.click(screen.getByRole('button', { name: 'Speak' }))
  expect(screen.getByRole('button', { name: 'Stop speaking' })).toBeEnabled()
  expect(screen.getByRole('button', { name: 'Speak' })).toBeDisabled()
  speechMock().stop.mockClear()
}

async function openCarer() {
  fireEvent.click(await screen.findByRole('button', { name: 'Open carer settings' }), { detail: 0 })
  return screen.findByRole('dialog', { name: 'Carer settings' })
}

function expectSpeechReset() {
  expect(speechMock().stop.mock.calls).toHaveLength(1)
  expect(screen.getByRole('button', { name: 'Stop speaking' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Speak' })).toBeDisabled()
}

beforeEach(async () => {
  await clearLocalData()
})

describe('speech cancellation at child and data boundaries', () => {
  it('cancels the prior utterance and resets speaking state before a profile switch', async () => {
    await seedTwoProfiles()
    const user = userEvent.setup()
    render(<App />)
    await beginUtterance(user)

    const dialog = await openCarer()
    await user.click(within(dialog).getByRole('button', { name: /Theo/ }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(await screen.findByLabelText('This is Theo’s board')).toBeInTheDocument()
    expectSpeechReset()
  })

  it('cancels the prior utterance before removing the active child and selecting the sibling', async () => {
    await seedTwoProfiles()
    const user = userEvent.setup()
    render(<App />)
    await beginUtterance(user)

    const dialog = await openCarer()
    await user.click(within(dialog).getByRole('button', { name: 'Remove this board' }))
    await user.click(within(dialog).getByRole('button', { name: /Really remove Maya’s board/ }))
    await user.click(within(screen.getByRole('dialog', { name: 'Carer settings' })).getByRole('button', { name: 'Close carer settings' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(await screen.findByLabelText('This is Theo’s board')).toBeInTheDocument()
    expectSpeechReset()
  })

  it('cancels the prior utterance before applying a backup and replacing the rail/profile', async () => {
    const current = createProfile({ nickname: 'Maya', ageBand: '7-9' })
    await saveProfile(current)
    await setActiveProfileId(current.id)
    const restored = createProfile({ nickname: 'Rowan', ageBand: '10-12' })
    const backup = {
      app: 'ownsay-aac',
      schema: 2,
      exportedAt: '2026-08-22T09:00:00.000Z',
      disclaimer: 'test',
      profiles: [restored],
      events: [],
    }
    const user = userEvent.setup()
    render(<App />)
    await beginUtterance(user)

    const dialog = await openCarer()
    const input = dialog.querySelector<HTMLInputElement>('input[type="file"]')
    expect(input).not.toBeNull()
    const file = new File([JSON.stringify(backup)], 'ownsay-backup.json', { type: 'application/json' })
    Object.defineProperty(file, 'text', { value: async () => JSON.stringify(backup) })
    await user.upload(input as HTMLInputElement, file)
    await user.click(await within(dialog).findByRole('button', { name: 'Restore backup' }))
    await user.click(within(screen.getByRole('dialog', { name: 'Carer settings' })).getByRole('button', { name: 'Close carer settings' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(await screen.findByLabelText('This is Rowan’s board')).toBeInTheDocument()
    expectSpeechReset()
  })

  it('cancels the prior utterance before clear-data enters first-run onboarding', async () => {
    const profile = createProfile({ nickname: 'Maya', ageBand: '7-9' })
    await saveProfile(profile)
    await setActiveProfileId(profile.id)
    const user = userEvent.setup()
    render(<App />)
    await beginUtterance(user)

    const dialog = await openCarer()
    await user.click(within(dialog).getByRole('button', { name: 'Clear local data' }))
    await user.click(within(dialog).getByRole('button', { name: /Erase everything on this device/ }))

    expect(await screen.findByText('Who is this board for?')).toBeInTheDocument()
    expect(speechMock().stop.mock.calls).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Stop speaking' })).not.toBeInTheDocument()
  })
})
