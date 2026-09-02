import 'fake-indexeddb/auto'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { App } from './App'
import { clearLocalData } from './persistence/store'
import { seedProfile } from './test/seedProfile'

/**
 * True modal isolation: while carer settings is open the entire child shell
 * subtree is inert and absent from the accessibility tree, and BOTH
 * properties are removed again on every close path. Focus recovery pulls a
 * stray caret back into the dialog on the next Tab in either direction.
 */

function appShellRoot(): HTMLElement {
  // The child surface root carries the world data attribute.
  return document.querySelector('[data-routine]') as HTMLElement
}

function isInert(el: Element): boolean {
  return el.hasAttribute('inert')
}

async function renderBoard(): Promise<void> {
  await seedProfile()
  render(<App />)
  await screen.findByRole('navigation', { name: 'Routine' })
}

function openCarer(): void {
  const hold = screen.getByRole('button', { name: 'Open carer settings' })
  // A real activation moves focus to the trigger first (click/tap focus);
  // assistive-tech style activation (click detail 0) then opens directly.
  hold.focus()
  fireEvent.click(hold)
}

/**
 * Erases local state, tolerating the brief window where a previous test's
 * fire-and-forget write still holds an open IndexedDB connection (delete is
 * "blocked" only while such a connection exists).
 */
async function eraseLocalState(): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await clearLocalData()
      window.localStorage.clear()
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 40))
    }
  }
  window.localStorage.clear()
}

beforeEach(async () => {
  await eraseLocalState()
})

afterEach(async () => {
  await eraseLocalState()
})

describe('true modal isolation', () => {
  it('removes the child subtree from the accessibility tree while settings is open', async () => {
    await renderBoard()
    expect(appShellRoot()).not.toHaveAttribute('aria-hidden')
    expect(isInert(appShellRoot())).toBe(false)

    openCarer()
    const dialog = screen.getByRole('dialog', { name: 'Carer settings' })
    expect(dialog).toBeInTheDocument()

    const shell = appShellRoot()
    expect(shell).toHaveAttribute('aria-hidden', 'true')
    expect(isInert(shell)).toBe(true)
    // Every interactive child sits inside the isolated subtree.
    for (const button of shell.querySelectorAll('button')) {
      expect(button.closest('[inert]')).not.toBeNull()
    }
    // The dialog itself must stay outside any inert ancestor: operable.
    expect(dialog.closest('[inert]')).toBeNull()
    expect(dialog.contains(document.activeElement)).toBe(true)
  })

  it('restores both properties, body scroll and focus on the Escape close path', async () => {
    await renderBoard()
    openCarer()
    expect(isInert(appShellRoot())).toBe(true)
    expect(document.body.style.overflow).toBe('hidden')

    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' })
    })
    expect(screen.queryByRole('dialog', { name: 'Carer settings' })).not.toBeInTheDocument()
    const shell = appShellRoot()
    expect(shell).not.toHaveAttribute('aria-hidden')
    expect(isInert(shell)).toBe(false)
    expect(document.body.style.overflow).not.toBe('hidden')
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open carer settings' }))
  })

  it('restores everything on the explicit Close-button close path too', async () => {
    await renderBoard()
    openCarer()
    fireEvent.click(screen.getByRole('button', { name: 'Close carer settings' }))
    expect(screen.queryByRole('dialog', { name: 'Carer settings' })).not.toBeInTheDocument()
    const shell = appShellRoot()
    expect(shell).not.toHaveAttribute('aria-hidden')
    expect(isInert(shell)).toBe(false)
    expect(document.body.style.overflow).not.toBe('hidden')
  })

  it('recovers stray focus into the dialog on the next Tab', async () => {
    await renderBoard()
    openCarer()
    const dialog = screen.getByRole('dialog', { name: 'Carer settings' })

    // Simulate focus escaping the dialog entirely.
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    expect(dialog.contains(document.activeElement)).toBe(false)
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(dialog.contains(document.activeElement)).toBe(true)

    // And on Shift+Tab from outside.
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(dialog.contains(document.activeElement)).toBe(true)
  })

  it('keeps bidirectional Tab wrap working inside the dialog alongside recovery', async () => {
    await renderBoard()
    openCarer()
    const dialog = screen.getByRole('dialog', { name: 'Carer settings' })
    const focusables = Array.from(dialog.querySelectorAll<HTMLElement>('button'))
    expect(focusables.length).toBeGreaterThan(2)

    focusables[0]?.focus()
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(focusables[focusables.length - 1])

    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(focusables[0])
  })

  it('re-isolates cleanly across repeated open/close cycles', async () => {
    await renderBoard()
    for (let cycle = 0; cycle < 3; cycle += 1) {
      openCarer()
      expect(isInert(appShellRoot())).toBe(true)
      expect(appShellRoot()).toHaveAttribute('aria-hidden', 'true')
      act(() => {
        fireEvent.keyDown(document, { key: 'Escape' })
      })
      expect(isInert(appShellRoot())).toBe(false)
      expect(appShellRoot()).not.toHaveAttribute('aria-hidden')
    }
  })
})
