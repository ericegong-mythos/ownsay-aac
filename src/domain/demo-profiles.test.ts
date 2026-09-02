import { describe, expect, it } from 'vitest'
import {
  DEMO_PROFILES,
  DEMO_PROFILE_LIST,
  createDemoProfile,
  findMissingDemoProfiles,
  orderProfilesForDisplay,
} from './demo-profiles'
import { EXTRA_WORD_LABEL_LIMIT, normaliseExtraWord } from './profile-text'
import { personalFavouriteTokens, selectBoard } from './board'
import { PROTECTED_CORE_IDS } from './protected-core'
import type { ChildProfile } from './types'

describe('fictional demo profiles', () => {
  it('ships two distinct age 4–6 examples with editable favourites and welcome defaults', () => {
    expect(DEMO_PROFILE_LIST.map((spec) => spec.nickname)).toEqual(['Alex', 'Sam'])
    for (const spec of DEMO_PROFILE_LIST) {
      expect(spec.ageBand).toBe('4-6')
      // Favourites stay editable non-core words; the protected core is never touched.
      expect(spec.extraWords.length).toBeGreaterThan(0)
      expect(spec.extraWords.length).toBeLessThanOrEqual(12)
      expect(spec.welcomeSprites.length).toBeGreaterThan(2)
    }
    const alexWords = DEMO_PROFILES.alex.extraWords.map((word) => word.label)
    const samWords = DEMO_PROFILES.sam.extraWords.map((word) => word.label)
    // Exact fictional examples are pinned so accidental data drift is visible.
    expect(alexWords).toEqual([
      'Apple',
      'Sandwich',
      'Building blocks',
      'Train',
      'Drawing',
      'Loud noise',
      'Different texture',
    ])
    expect(samWords).toEqual([
      'Pasta',
      'Toast',
      'Water',
      'Crackers',
      'Bubbles',
      'Puzzle',
      'Music',
      'Bike',
      'Not that',
    ])
    // Distinct boards: each profile keeps words the other does not.
    expect(alexWords).toContain('Loud noise')
    expect(samWords).not.toContain('Loud noise')
    expect(samWords).not.toContain('Different texture')
    // Refusal/repair vocabulary is present without touching the core.
    expect(samWords).toContain('Not that')
  })

  it('keeps every built-in label storable at full length under the same sanitiser', () => {
    for (const spec of DEMO_PROFILE_LIST) {
      for (const word of spec.extraWords) {
        // No starter word may depend on truncation to be storable: the stored
        // label must come back identical, not shortened.
        expect(word.label.length, `${word.label} must fit the stored limit`).toBeLessThanOrEqual(
          EXTRA_WORD_LABEL_LIMIT,
        )
        expect(normaliseExtraWord(word.label)).toBe(word.label)
      }
    }
    expect(Math.max(...DEMO_PROFILE_LIST.flatMap((spec) => spec.extraWords.map((word) => word.label.length)))).toBeLessThanOrEqual(
      EXTRA_WORD_LABEL_LIMIT,
    )
  })

  it('creates ordinary local profiles with celebration on and no helper opt-in', () => {
    for (const spec of DEMO_PROFILE_LIST) {
      const profile = createDemoProfile(spec)
      expect(profile.nickname).toBe(spec.nickname)
      expect(profile.ageBand).toBe('4-6')
      expect(profile.helperEnabled).toBe(false)
      expect(profile.welcomeCelebration).toBe(true)
      expect(profile.welcomeSprites).toEqual([...spec.welcomeSprites])
      expect(profile.extraWords.map((word) => word.id)).toEqual([
        ...new Set(profile.extraWords.map((word) => word.id)),
      ])
      for (const word of profile.extraWords) {
        if (spec.extraWords.find((candidate) => candidate.label === word.label)?.routine) {
          expect(word.routine).toBeDefined()
        }
      }
    }
  })

  it('orders built-in boards Alex then Sam, with custom boards after in creation order', () => {
    const alex = createDemoProfile(DEMO_PROFILES.alex)
    const sam = createDemoProfile(DEMO_PROFILES.sam)
    const maya = { ...alex, id: 'prf-maya', nickname: 'Maya', starterKey: undefined }
    const theo = { ...alex, id: 'prf-theo', nickname: 'Theo', starterKey: undefined }

    // Wherever storage puts the built-ins, they lift to the front in key order.
    // Custom boards are never resorted: they keep the order they arrived in,
    // which is the creation order `readAllProfiles` sorts them into.
    for (const [input, expected] of [
      [[sam, maya, alex, theo], ['Alex', 'Sam', 'Maya', 'Theo']],
      [[alex, sam, maya, theo], ['Alex', 'Sam', 'Maya', 'Theo']],
      [[maya, theo, sam, alex], ['Alex', 'Sam', 'Maya', 'Theo']],
      [[theo, sam, alex, maya], ['Alex', 'Sam', 'Theo', 'Maya']],
    ] as const) {
      expect(orderProfilesForDisplay(input).map((profile) => profile.nickname)).toEqual([...expected])
    }

    // Custom-only and empty lists pass through untouched.
    expect(orderProfilesForDisplay([theo, maya]).map((row) => row.nickname)).toEqual(['Theo', 'Maya'])
    expect(orderProfilesForDisplay([])).toEqual([])
  })

  it('keeps a renamed built-in board in its demo position and never re-adds it', () => {
    const alex = createDemoProfile(DEMO_PROFILES.alex)
    const sam = createDemoProfile(DEMO_PROFILES.sam)
    // A carer renames Alex. Ordering keys on starterKey, never the nickname.
    const renamed = { ...alex, nickname: 'Lee' }
    expect(orderProfilesForDisplay([sam, renamed]).map((row) => row.nickname)).toEqual(['Lee', 'Sam'])
    // And the rename must not make the restore action offer a duplicate Alex.
    expect(findMissingDemoProfiles([renamed, sam])).toEqual([])
    expect(findMissingDemoProfiles([renamed]).map((spec) => spec.key)).toEqual(['sam'])
  })

  it('restores missing demo boards idempotently', () => {
    expect(findMissingDemoProfiles([])).toHaveLength(2)
    const alex = createDemoProfile(DEMO_PROFILES.alex)
    expect(findMissingDemoProfiles([alex]).map((spec) => spec.key)).toEqual(['sam'])
    const sam = createDemoProfile(DEMO_PROFILES.sam)
    expect(findMissingDemoProfiles([alex, sam])).toEqual([])
    // Case-insensitive match on existing nicknames prevents duplicates.
    expect(findMissingDemoProfiles([{ nickname: ' alex ' }]).map((spec) => spec.key)).toEqual(['sam'])
  })

  it('keeps every starter board on the fixed protected core in every routine', () => {
    for (const spec of DEMO_PROFILE_LIST) {
      const profile: ChildProfile = createDemoProfile(spec)
      for (const routine of ['play', 'food', 'school', 'home', 'outside'] as const) {
        const board = selectBoard({ ...profile, routine }, profile.extraWords)
        expect(board.core.map((entry) => entry.id)).toEqual([...PROTECTED_CORE_IDS])
        expect(board.fringe.length).toBeLessThanOrEqual(36)

        // Classified favourite words lead their own routine's first row.
        const contextLabels = board.fringe
          .filter((tile) => tile.routines?.includes(routine))
          .map((tile) => tile.label)
        if (routine === 'play' && spec.key === 'alex') {
          expect(contextLabels.slice(0, 4)).toContain('Building blocks')
        }
        if (routine === 'food') {
          const foodFavourites = profile.extraWords.filter(
            (word) => word.tone === 'favourite' && (!word.routine || word.routine === 'food'),
          )
          if (foodFavourites.length > 0 && board.fringe.length > 0) {
            const firstRow = contextLabels.slice(0, 4)
            expect(
              foodFavourites.filter((word) => firstRow.includes(word.label)).length,
              `first food row should carry favourites: ${firstRow.join(', ')}`,
            ).toBeGreaterThanOrEqual(2)
          }
        }

        // Aversion/context words stay tappable somewhere without ever leading
        // a contextual row.
        for (const word of profile.extraWords.filter((item) => item.tone === 'context')) {
          if (!board.fringe.some((tile) => tile.label === word.label)) continue
          const position = board.fringe.findIndex((tile) => tile.label === word.label)
          const contextPosition = board.fringe
            .slice(0, position + 1)
            .filter((tile) => tile.routines?.includes(routine) === true).length
          // Untagged words live in the anytime zone; they must never occupy a
          // right-now slot ahead of the routine's own vocabulary.
          expect(contextPosition).toBeGreaterThan(0)
        }
      }
    }
  })

  it('reaches every supplied like/context word in at least one appropriate routine at the default density', () => {
    for (const spec of DEMO_PROFILE_LIST) {
      const profile: ChildProfile = createDemoProfile(spec)
      const reachable = new Set<string>()
      for (const routine of ['play', 'food', 'school', 'home', 'outside'] as const) {
        const board = selectBoard({ ...profile, routine }, profile.extraWords)
        for (const tile of board.fringe) reachable.add(tile.label)
      }
      for (const word of profile.extraWords) {
        expect(
          reachable.has(word.label),
          `${spec.nickname}'s "${word.label}" must be reachable somewhere`,
        ).toBe(true)
      }
    }
    // The fictional sample has only its declared interests.
    const sam = createDemoProfile(DEMO_PROFILES.sam)
    expect(sam.interests).toEqual(['food', 'music', 'vehicles'])
  })

  it("surfaces Alex's aversion words only as tappable choices, never suggestions", async () => {
    const { buildDeterministicSuggestions } = await import('./suggestions')
    const profile = createDemoProfile(DEMO_PROFILES.alex)
    const board = selectBoard(profile, profile.extraWords)
    const visibleIds = new Set([...board.core, ...board.fringe].map((entry) => entry.id))
    for (const label of ['Loud noise', 'Different texture']) {
      const entry = board.fringe.find((tile) => tile.label === label)
      expect(entry, `${label} must be visible`).toBeTruthy()
    }
    const favourites = personalFavouriteTokens(profile, profile.extraWords)
    const rows = buildDeterministicSuggestions(profile, [], { board, favourites })
    expect(rows.length).toBeGreaterThan(0)
    for (const suggestion of rows) {
      for (const token of suggestion.tokens) {
        expect(visibleIds.has(token.id), `${token.id} must be visible`).toBe(true)
      }
    }
    const flat = rows.flatMap((row) => row.tokens.map((token) => token.id))
    for (const label of ['Loud noise', 'Different texture']) {
      const id = board.fringe.find((tile) => tile.label === label)?.id
      if (id) expect(flat).not.toContain(id)
    }
  })
})
