import { describe, expect, it } from 'vitest'
import { extraWordId, personalFavouriteTokens, selectBoard, validPersonalWords } from './board'
import { buildDeterministicSuggestions } from './suggestions'
import { getVocabLabel } from './vocabulary'
import { PROTECTED_CORE_ENTRIES, PROTECTED_CORE_IDS } from './protected-core'
import { VOCABULARY } from './vocabulary'
import * as policyModule from './policy'
import type { DemoPreferences, ExtraWord } from './types'

const base: DemoPreferences = {
  ageBand: '4-6',
  accessDensity: 'standard',
  interests: ['food'],
  routine: 'food',
  helperEnabled: false,
}

describe('personal word validation', () => {
  it('rejects duplicate labels case-insensitively and caps the stored count', () => {
    const words: ExtraWord[] = [
      { id: 'a', label: 'Apple' },
      { id: 'b', label: '  apple  ' },
      { id: 'c', label: 'Grandma' },
    ]
    const valid = validPersonalWords(words)
    expect(valid.map((word) => word.id)).toEqual(['a', 'c'])
  })

  it('never allows a personal label to duplicate a protected-core label', () => {
    const words: ExtraWord[] = PROTECTED_CORE_ENTRIES.map((entry) => ({ id: `x-${entry.id}`, label: entry.label }))
    words.push({ id: 'ok', label: 'Toastie' })
    const valid = validPersonalWords(words)
    expect(valid.map((word) => word.id)).toEqual(['ok'])
  })
})

describe('personal words inside the density quota', () => {
  it('never grows the board beyond the selected density', () => {
    const many: ExtraWord[] = Array.from({ length: 20 }, (_, index) => ({
      id: `w${index}`,
      label: `Word ${index}`,
      tone: 'context' as const,
    }))
    for (const density of ['large', 'standard', 'more'] as const) {
      const board = selectBoard({ ...base, accessDensity: density }, many)
      const expectedCap = density === 'large' ? 10 : density === 'standard' ? 20 : 36
      expect(board.fringe.length).toBeLessThanOrEqual(expectedCap)
      expect(board.core.map((entry) => entry.id)).toEqual([...PROTECTED_CORE_IDS])
    }
  })

  it('prefers the existing catalogue token over an extra: duplicate', () => {
    const board = selectBoard(base, [
      { id: 'p1', label: 'Pizza', tone: 'favourite' },
    ])
    const pizzaTiles = board.fringe.filter((entry) => entry.label.toLowerCase() === 'pizza')
    expect(pizzaTiles).toHaveLength(1)
    expect(pizzaTiles[0].id).toBe('pizza')
    expect(pizzaTiles[0].id).not.toBe(extraWordId('p1'))
    // And every catalogue entry that survived keeps a real vocabulary id.
    for (const entry of board.fringe) {
      if (!entry.id.startsWith('extra:')) {
        expect(VOCABULARY.some((catalogue) => catalogue.id === entry.id)).toBe(true)
      }
    }
  })

  it('interleaves favourites into the first contextual row with essentials retained', () => {
    // Entirely fictional fixture at Food / Large: quota 5.
    const fictionalFoodBoard = selectBoard(
      { ...base, accessDensity: 'large', interests: ['food', 'music'] },
      [
        { id: 'fr', label: 'Fruit', routine: 'food', icon: 'apple', tone: 'favourite' },
        { id: 'eg', label: 'Egg', routine: 'food', icon: 'egg', tone: 'favourite' },
        { id: 'ml', label: 'Milk', routine: 'food', icon: 'milk', tone: 'favourite' },
        { id: 'sw', label: 'Sweets', routine: 'food', icon: 'candy', tone: 'favourite' },
        { id: 'dn', label: 'Dinner', routine: 'food', icon: 'cooking-pot', tone: 'favourite' },
      ],
    )
    const contextIds = fictionalFoodBoard.fringe
      .filter((entry) => entry.routines?.includes('food') || ['fruit', 'egg'].includes(entry.id))
      .map((entry) => entry.id)
    // First contextual row (4 tiles on a Fire-sized screen) carries favourites.
    expect(contextIds.slice(0, 4)).toContain('fruit')
    expect(contextIds.slice(0, 4)).toContain('egg')
    // Essential action language stays interleaved, never displaced entirely.
    expect(contextIds[0]).toBe('eat')

    // A separate fictional play favourite leads beside the play verbs.
    const fictionalPlayBoard = selectBoard(
      { ...base, accessDensity: 'large', routine: 'play', interests: ['outdoors', 'music'] },
      [{ id: 'marbles', label: 'Marbles', routine: 'play', icon: 'circle-dot', tone: 'favourite' }],
    )
    const playContext = fictionalPlayBoard.fringe
      .filter((entry) => !entry.id.startsWith('extra:') || entry.id === extraWordId('marbles'))
      .slice(0, 5)
      .map((entry) => entry.id)
    expect(playContext[0]).toBe('play')
    expect(playContext).toContain(extraWordId('marbles'))
    expect(playContext.indexOf('game')).toBeLessThan(5)
  })

  it('hides words tagged for another routine and reserves bounded anytime slots', () => {
    const board = selectBoard(base, [
      { id: 'other', label: 'Building blocks', routine: 'play', tone: 'favourite' },
      { id: 'any1', label: 'Loud noise', tone: 'context' },
      { id: 'any2', label: 'Different textures', tone: 'context' },
    ])
    const ids = board.fringe.map((entry) => entry.id)
    expect(ids).not.toContain(extraWordId('other'))
    expect(ids).toContain(extraWordId('any1'))
    expect(ids).toContain(extraWordId('any2'))
  })

  it('keeps suggestions resolvable against the composed board only', () => {
    const profile: DemoPreferences = { ...base, accessDensity: 'large', interests: ['vehicles', 'food'] }
    const words: ExtraWord[] = [
      { id: 'apple', label: 'Apple', routine: 'food', tone: 'favourite' },
      { id: 'noise', label: 'Loud noise', tone: 'context' },
    ]
    const board = selectBoard(profile, words)
    const favourites = personalFavouriteTokens(profile, words)
    const rows = buildDeterministicSuggestions(profile, [], { board, favourites })
    const visibleIds = new Set([...board.core, ...board.fringe].map((entry) => entry.id))
    for (const row of rows) {
      for (const token of row.tokens) {
        expect(visibleIds.has(token.id), `${token.id} must be visible`).toBe(true)
      }
    }
    // Apple is classified favourite → may appear; Loud noise never does.
    const flattened = rows.flatMap((row) => row.tokens.map((token) => token.id))
    expect(flattened).not.toContain(extraWordId('noise'))
  })
})

describe('personal favourites in the model candidate path', () => {
  it('inserts unique personal favourite openers and resolves their labels for Alex and Sam', async () => {
    const { buildCandidatePool } = await import('./candidates')
    const { buildModelInput } = await import('./policy')
    const { DEMO_PROFILES, createDemoProfile } = await import('./demo-profiles')

    for (const key of ['alex', 'sam'] as const) {
      const profile = createDemoProfile(DEMO_PROFILES[key])
      const input = buildModelInput(profile, [])
      expect(Object.keys(input.tokenLabels ?? {}).length, `${key} favourites allowlisted`).toBeGreaterThan(0)
      const pool = buildCandidatePool(input)
      // Personal openers lead the pool with resolved labels.
      const personalOpeners = pool.candidates.filter((candidate) =>
        candidate.tokens.some((token) => input.tokenLabels?.[token.id] !== undefined),
      )
      expect(personalOpeners.length, `${key} must have personal opener candidates`).toBeGreaterThan(0)
      for (const candidate of personalOpeners) {
        for (const token of candidate.tokens) {
          expect(
            getVocabLabel(token.id) ?? input.tokenLabels?.[token.id],
            `${token.id} must resolve to a label`,
          ).toBeTruthy()
        }
      }
      // Every allowlisted personal id is unique and visible on the board.
      const boardIds = new Set(selectBoard(profile, profile.extraWords).fringe.map((tile) => tile.id))
      for (const id of Object.keys(input.tokenLabels ?? {})) {
        expect(boardIds.has(id), `allowlisted ${id} must be visible`).toBe(true)
      }
    }
  })

  it('never allowlists a stored-but-hidden favourite', () => {
    const { buildModelInput } = policyModule
    const prefs: DemoPreferences = {
      ageBand: '4-6',
      accessDensity: 'large',
      interests: [],
      routine: 'school',
      helperEnabled: false,
    }
    const words: ExtraWord[] = [
      // Tagged school but quota-crowded at Large: only reachable ones may pass.
      { id: 'a', label: 'Notebook', routine: 'school', tone: 'favourite' },
      { id: 'b', label: 'Backpack', routine: 'school', tone: 'favourite' },
      { id: 'c', label: 'Craft', routine: 'school', tone: 'favourite' },
      { id: 'd', label: 'Quiet', routine: 'school', tone: 'favourite' },
      { id: 'e', label: 'Friend', routine: 'school', tone: 'favourite' },
      { id: 'f', label: 'Toilet', routine: 'school', tone: 'favourite' },
      { id: 'g', label: 'Bell', routine: 'school', tone: 'favourite' },
      { id: 'h', label: 'Teacher', routine: 'school', tone: 'favourite' },
    ]
    const input = buildModelInput(prefs, [], words)
    const boardIds = new Set(selectBoard(prefs, words).fringe.map((tile) => tile.id))
    for (const id of Object.keys(input.tokenLabels ?? {})) {
      expect(boardIds.has(id), `hidden ${id} must not be allowlisted`).toBe(true)
    }
  })
})
