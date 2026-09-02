import { describe, expect, it } from 'vitest'
import { buildCandidatePool, parseChosenCandidates } from './candidates'
import { buildModelInput } from './policy'
import { hasRepeatedTokens, passesSuggestionQualityGate } from './phrase-quality'
import { isProtectedTokenId } from './protected-core'
import { DEFAULT_PREFERENCES, ROUTINES, type AgeBand } from './types'
import { getVocabLabel } from './vocabulary'

const BANNED_PHRASES = new Set([
  'fruit good',
  'dinner good',
  'walk bike',
  'park good',
])

const ALL_DENSITIES = ['large', 'standard', 'more'] as const
const AGE_BANDS: AgeBand[] = ['4-6', '7-9', '10-12']

function inputFor(overrides: Partial<Parameters<typeof buildModelInput>[0]> & { currentTokenIds?: string[] }) {
  const prefs = { ...DEFAULT_PREFERENCES, ...overrides }
  const message = (overrides.currentTokenIds ?? []).map((id, index) => ({
    instanceId: `t-${index}`,
    tokenId: id,
    label: getVocabLabel(id) ?? id,
    provenance: 'fringe' as const,
    category: 'people' as const,
  }))
  return buildModelInput(prefs, message)
}

describe('candidate pool', () => {
  it('offers natural, allowlisted, protected-free phrases for every routine, age band and density', () => {
    for (const routine of ROUTINES) {
      for (const ageBand of AGE_BANDS) {
        for (const accessDensity of ALL_DENSITIES) {
          const input = inputFor({ routine, ageBand, accessDensity })
          const pool = buildCandidatePool(input)
          // Two model-ranked rows plus two deterministic instant rows fill the
          // four-slot dock even on the youngest, sparsest board.
          expect(pool.candidates.length, `${routine}/${ageBand}/${accessDensity}`).toBeGreaterThanOrEqual(2)

          // The binding contract is THIS child's visible vocabulary, not a
          // global list: sparse boards must never expose invisible words.
          const visible = new Set(input.allowlist)
          const keys = new Set<string>()
          for (const candidate of pool.candidates) {
            const ids = candidate.tokens.map((token) => token.id)
            expect(passesSuggestionQualityGate(ids), `${ids.join(' ')} must read naturally`).toBe(true)
            for (const id of ids) {
              expect(getVocabLabel(id), `${id} must be real vocabulary`).toBeTruthy()
              expect(visible.has(id), `${id} must be visible on this board`).toBe(true)
              expect(isProtectedTokenId(id), 'protected core never enters the pool').toBe(false)
            }
            keys.add(ids.join(' '))
          }
          expect(keys.size).toBe(pool.candidates.length)
        }
      }
    }
  })

  it('excludes known-unnatural phrasings from every pool', () => {
    for (const routine of ROUTINES) {
      for (const currentTokenIds of [[], ['i'], ['i', 'want'], ['i', 'feel']]) {
        const input = inputFor({ routine, currentTokenIds })
        for (const candidate of buildCandidatePool(input).candidates) {
          const text = candidate.tokens.map((token) => token.id).join(' ')
          expect(BANNED_PHRASES.has(text), `${text} must never be offered`).toBe(false)
        }
      }
    }
  })

  it('suffix pools are context-specific and validated on the COMBINED sequence', () => {
    const contexts: Array<{ current: string[]; allowedFirst: string[]; label: string }> = [
      { current: ['i', 'feel'], allowedFirst: ['happy', 'sad', 'angry', 'tired', 'scared', 'hungry', 'thirsty', 'calm', 'worried', 'proud'], label: 'feel → feelings/states only' },
      { current: ['go'], allowedFirst: ['park', 'outside', 'home', 'school'], label: 'go → places only' },
      { current: ['read'], allowedFirst: ['story', 'notebook'], label: 'read → readable things only' },
      { current: ['can', 'i'], allowedFirst: ['go', 'look', 'eat', 'drink', 'play', 'read', 'walk'], label: 'can i → action verbs only' },
    ]
    for (const routine of ROUTINES) {
      for (const { current, allowedFirst, label } of contexts) {
        const input = inputFor({ routine, currentTokenIds: current })
        const pool = buildCandidatePool(input)
        for (const candidate of pool.candidates) {
          const first = candidate.tokens[0]?.id
          expect(allowedFirst).toContain(first)
          // Combined sequence stays natural, repetition-free and non-parroting.
          const combined = [...current, ...candidate.tokens.map((token) => token.id)]
          expect(hasRepeatedTokens(combined), `${label}: ${combined.join(' ')}`).toBe(false)
          expect(passesSuggestionQualityGate(combined), `${label}: ${combined.join(' ')}`).toBe(true)
          expect(combined.slice(0, current.length).join(' ')).not.toBe(
            candidate.tokens.map((token) => token.id).join(' '),
          )
        }
      }
    }

    // Eat and drink are separated: no liquids after eat, no foods after drink.
    const eatIds = buildCandidatePool(inputFor({ routine: 'food', currentTokenIds: ['eat'] }))
      .candidates.map((c) => c.tokens[0]?.id)
    expect(eatIds).not.toContain('water')
    expect(eatIds).not.toContain('milk')
    const drinkIds = buildCandidatePool(inputFor({ routine: 'food', currentTokenIds: ['drink'] }))
      .candidates.map((c) => c.tokens[0]?.id)
    expect(drinkIds).not.toContain('snack')
    expect(drinkIds).not.toContain('pizza')
  })

  it('gives every candidate a stable opaque ID that maps back exactly', () => {
    const input = inputFor({ routine: 'food', currentTokenIds: [] })
    const first = buildCandidatePool(input)
    const second = buildCandidatePool(input)

    expect(first.candidates.map((c) => c.id)).toEqual(second.candidates.map((c) => c.id))
    for (const candidate of first.candidates) {
      expect(candidate.id).toMatch(/^c\d+$/)
      const mapped = second.byId.get(candidate.id)
      expect(mapped?.tokens).toEqual(candidate.tokens)
    }
  })

  it('empty messages produce FULL openers; authored messages produce suffix continuations', () => {
    const empty = buildCandidatePool(inputFor({ routine: 'play', currentTokenIds: [] }))
    const emptyShapes = empty.candidates.map((c) => c.tokens.map((t) => t.label).join(' '))
    expect(emptyShapes.some((text) => /^I want/i.test(text))).toBe(true)

    // After "I want" the pool offers concrete objects — single next words.
    const afterWant = buildCandidatePool(inputFor({ routine: 'food', currentTokenIds: ['i', 'want'] }))
    const afterWantKeys = afterWant.candidates.map((c) => c.tokens.map((t) => t.id).join(' '))
    expect(afterWantKeys.length).toBeGreaterThan(0)
    for (const key of afterWantKeys) {
      expect(['i want', 'want']).not.toContain(key)
    }
    expect(afterWantKeys.some((key) => ['snack', 'water', 'fruit'].includes(key))).toBe(true)

    // After a bare pronoun, verbs come next.
    const afterPronoun = buildCandidatePool(inputFor({ routine: 'home', currentTokenIds: ['i'] }))
    const pronounKeys = afterPronoun.candidates.map((c) => c.tokens.map((t) => t.id).join(' '))
    expect(pronounKeys.some((key) => ['want', 'need', 'feel', 'like'].includes(key))).toBe(true)
  })

  it('works even on sparse large-density boards for the youngest band', () => {
    for (const routine of ROUTINES) {
      const input = inputFor({ routine, ageBand: '4-6', accessDensity: 'large', interests: [] })
      const pool = buildCandidatePool(input)
      expect(pool.candidates.length, `${routine}: sparse boards still need choice`).toBeGreaterThanOrEqual(2)
    }
  })

  describe('selection parsing', () => {
    it('maps chosen IDs back onto exact pool phrases and drops unknown ones', () => {
      const input = inputFor({ routine: 'food', currentTokenIds: [] })
      const pool = buildCandidatePool(input)
      expect(pool.candidates.length).toBeGreaterThanOrEqual(2)

      const rogue = `zz-${pool.candidates.length + 50}`
      const { chosen, rejectedUnknownIds } = parseChosenCandidates(
        { chosen: [rogue, pool.candidates[1].id, pool.candidates[0].id] },
        pool,
      )
      expect(rejectedUnknownIds).toEqual([rogue])
      expect(chosen.map((c) => c.id)).toEqual([pool.candidates[1].id, pool.candidates[0].id])
      // Order follows the model's ranking.
      expect(chosen[0]?.tokens).toEqual(pool.candidates[1].tokens)
    })

    it('caps selections at four and ignores duplicates or malformed entries', () => {
      const input = inputFor({ routine: 'play', accessDensity: 'more', currentTokenIds: [] })
      const pool = buildCandidatePool(input)
      expect(pool.candidates.length).toBeGreaterThanOrEqual(5)

      const ids = pool.candidates.map((c) => c.id)
      const payload = { chosen: [ids[0], 42, ids[1], null, ids[0], ids[2], ids[3], ids[4]] }
      const { chosen } = parseChosenCandidates(payload, pool)
      expect(chosen.map((c) => c.id)).toEqual([ids[0], ids[1], ids[2], ids[3]])
    })

    it('returns nothing for shapes that are not ID selections', () => {
      const pool = buildCandidatePool(inputFor({ routine: 'food', currentTokenIds: [] }))
      // Legacy free-token output can never map back — by design.
      for (const bad of [
        null,
        'hello',
        { suggestions: [{ tokens: ['i', 'look'] }] },
        { tokens: ['water'] },
        { chosen: 'c1' },
        {},
      ]) {
        const { chosen } = parseChosenCandidates(bad, pool)
        expect(chosen).toEqual([])
      }
    })
  })

  it('documents age bands as layout-only while pools adapt vocabulary', () => {
    // The youngest band's pool stays inside early/mid words via board
    // visibility; the oldest band gains later words. Neither moves the core.
    const young = buildCandidatePool(inputFor({ routine: 'school', ageBand: '4-6', currentTokenIds: [] }))
    const older = buildCandidatePool(inputFor({ routine: 'school', ageBand: '10-12', currentTokenIds: [] }))
    expect(young.candidates.length).toBeGreaterThan(0)
    expect(older.candidates.length).toBeGreaterThan(0)
  })
})
