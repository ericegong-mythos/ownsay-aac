import { describe, expect, it } from 'vitest'
import { selectBoard } from './board'
import { buildDeterministicSuggestions, suggestionsEqual } from './suggestions'
import { PROTECTED_CORE_IDS } from './protected-core'
import {
  ACCESS_DENSITIES,
  AGE_BANDS,
  DEFAULT_PREFERENCES,
  INTERESTS,
  ROUTINES,
  type AuthoredToken,
  type DemoPreferences,
  type Interest,
} from './types'

function prefsWith(overrides: Partial<DemoPreferences>): DemoPreferences {
  return { ...DEFAULT_PREFERENCES, ...overrides }
}

function token(id: string): AuthoredToken {
  const entry = { instanceId: `inst-${id}`, tokenId: id, label: id, provenance: 'fringe' as const, category: 'core' as const }
  return entry
}

/** Distinctive ids that only make sense inside one world. */
const WORLD_SIGNATURES: Record<(typeof ROUTINES)[number], string[]> = {
  play: ['game', 'toy', 'blocks', 'play', 'turn', 'your-turn'],
  food: ['snack', 'water', 'fruit', 'hungry', 'thirsty'],
  school: ['teacher', 'break-time', 'work', 'read', 'write', 'notebook', 'quiet', 'toilet'],
  home: ['tv', 'bed', 'dinner', 'tired'],
  outside: ['park', 'walk', 'bird', 'outside', 'hot'],
}

const INTEREST_VARIANTS: readonly (readonly Interest[])[] = [
  [],
  ...INTERESTS.map((interest) => [interest] as const),
  [...INTERESTS],
]

const REPRESENTATIVE_MESSAGE_IDS: readonly (readonly string[])[] = [
  [],
  ['want'],
  ['i', 'want'],
  ['need'],
  ['i', 'need'],
  ['feel'],
  ['go'],
  ['eat'],
  ['dont-like'],
  ['say-again'],
  ['i'],
  ['can'],
]

describe('empty-message starters are routine-specific', () => {
  it('returns four distinct allowlisted suggestions for all five routines', () => {
    for (const routine of ROUTINES) {
      const suggestions = buildDeterministicSuggestions(prefsWith({ routine }), [])
      expect(suggestions, `${routine} must offer four starters`).toHaveLength(4)
      const keys = new Set(suggestions.map((row) => row.tokens.map((token) => token.id).join(' ')))
      expect(keys.size, `${routine} starters must be distinct`).toBe(4)
      for (const row of suggestions) {
        for (const token of row.tokens) {
          expect(PROTECTED_CORE_IDS).not.toContain(token.id)
        }
      }
    }
  })

  it('makes every routine’s starters materially different from every other’s', () => {
    for (const routine of ROUTINES) {
      const suggestions = buildDeterministicSuggestions(prefsWith({ routine }), [])
      const signature = new Set(suggestions.flatMap((row) => row.tokens.map((token) => token.id)))
      const hits = WORLD_SIGNATURES[routine].filter((id) => signature.has(id))
      expect(hits.length, `${routine} starters must carry world vocabulary`).toBeGreaterThanOrEqual(2)

      // The generic default set must not survive untouched in any world.
      const generic = ['want', 'feel', 'can', 'that']
      const genericOnly = suggestions.every((row) => row.tokens.every((token) => generic.includes(token.id)))
      expect(genericOnly, `${routine} must not fall back to the generic starter set`).toBe(false)
    }
  })

  it('never suggests protected core tokens and stays deterministic', () => {
    const a = buildDeterministicSuggestions(DEFAULT_PREFERENCES, [])
    const b = buildDeterministicSuggestions(DEFAULT_PREFERENCES, [])
    expect(suggestionsEqual(a, b)).toBe(true)
    const allIds = a.flatMap((row) => row.tokens.map((token) => token.id))
    for (const id of PROTECTED_CORE_IDS) expect(allIds).not.toContain(id)
  })
})

describe('continuations respect the selected routine', () => {
  it('sends “want” to different worlds: snack for food, game for play', () => {
    const message = [token('want')]
    const food = buildDeterministicSuggestions(prefsWith({ routine: 'food' }), message)
    const play = buildDeterministicSuggestions(prefsWith({ routine: 'play' }), message)
    const school = buildDeterministicSuggestions(prefsWith({ routine: 'school' }), message)
    const flat = (rows: ReturnType<typeof buildDeterministicSuggestions>) =>
      rows.flatMap((row) => row.tokens.map((token) => token.id))
    expect(flat(food)).toContain('snack')
    expect(flat(play)).toContain('game')
    expect(flat(school)).toContain('work')
    expect(flat(play)).not.toContain('snack')
    expect(flat(food)).not.toContain('game')
  })

  it('ranks routine rows ahead of generic ones after “want”', () => {
    const rows = buildDeterministicSuggestions(prefsWith({ routine: 'outside' }), [token('want')])
    expect(rows[0]?.tokens.map((token) => token.id)).toEqual(['park'])
  })

  it('keeps four distinct options once a continuation applies', () => {
    const rows = buildDeterministicSuggestions(prefsWith({ routine: 'home' }), [token('want')])
    expect(rows).toHaveLength(4)
    expect(new Set(rows.map((row) => row.id)).size).toBe(4)
  })

  it('offers repair and feeling continuations that stay useful per world', () => {
    const feelingHome = prefsWith({ routine: 'home', accessDensity: 'more' })
    const visibleHome = new Set(selectBoard(feelingHome).fringe.map((entry) => entry.id))
    const feelingRows = buildDeterministicSuggestions(feelingHome, [token('i'), token('feel')])
    const flat = feelingRows.flatMap((row) => row.tokens.map((entry) => entry.id))
    expect(flat).toContain('happy')
    expect(flat).not.toContain('tired')
    expect(visibleHome.has('happy')).toBe(true)
    expect(visibleHome.has('tired')).toBe(false)

    const schoolPrefs = prefsWith({ routine: 'school', accessDensity: 'more', interests: [] })
    const needSchool = buildDeterministicSuggestions(schoolPrefs, [
      token('i'),
      token('need'),
    ])
    const schoolIds = needSchool.flatMap((row) => row.tokens.map((token) => token.id))
    expect(schoolIds).toContain('toilet')
    expect(selectBoard(schoolPrefs).fringe.some((entry) => entry.id === 'toilet')).toBe(true)
  })
})

describe('visible-board suggestion boundary', () => {
  it('uses only currently visible vocabulary across every child-board dimension and representative message state', () => {
    for (const ageBand of AGE_BANDS) {
      for (const accessDensity of ACCESS_DENSITIES) {
        for (const routine of ROUTINES) {
          for (const interests of INTEREST_VARIANTS) {
            const prefs = prefsWith({
              ageBand,
              accessDensity,
              routine,
              interests: [...interests],
            })
            const board = selectBoard(prefs)
            const visibleIds = new Set(
              [...board.core, ...board.fringe].map((entry) => entry.id),
            )
            const context = `${ageBand}/${accessDensity}/${routine}/${interests.join('+') || 'none'}`

            expect(board.core.map((entry) => entry.id), context).toEqual([...PROTECTED_CORE_IDS])

            for (const messageIds of REPRESENTATIVE_MESSAGE_IDS) {
              const message = messageIds.map(token)
              const suggestions = buildDeterministicSuggestions(prefs, message)
              const state = `${context}/message:${messageIds.join('+') || 'empty'}`

              expect(suggestions, `${state} must keep four instant choices`).toHaveLength(4)
              expect(new Set(suggestions.map((row) => row.id)).size, state).toBe(4)

              for (const row of suggestions) {
                expect(row.source, state).toBe('deterministic')
                for (const suggested of row.tokens) {
                  expect(
                    visibleIds.has(suggested.id),
                    `${state} emitted hidden token ${suggested.id}; visible=${[...visibleIds].join(',')}`,
                  ).toBe(true)
                  expect(PROTECTED_CORE_IDS, `${state} emitted protected token ${suggested.id}`).not.toContain(
                    suggested.id,
                  )
                }
              }
            }
          }
        }
      }
    }
  })

  it('does not leak globally valid but hidden food words onto a small interest-tailored board', () => {
    const prefs = prefsWith({
      ageBand: '4-6',
      accessDensity: 'large',
      routine: 'food',
      interests: ['animals'],
    })
    const board = selectBoard(prefs)
    const visible = new Set([...board.core, ...board.fringe].map((entry) => entry.id))
    expect(visible.has('snack')).toBe(false)
    expect(visible.has('water')).toBe(false)

    const suggestions = buildDeterministicSuggestions(prefs, [])
    const suggested = suggestions.flatMap((row) => row.tokens.map((entry) => entry.id))
    expect(suggested).not.toContain('snack')
    expect(suggested).not.toContain('water')
    expect(suggested.every((id) => visible.has(id))).toBe(true)
  })
})
