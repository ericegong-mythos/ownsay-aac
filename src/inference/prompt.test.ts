import { describe, expect, it } from 'vitest'
import { buildModelInput } from '../domain/policy'
import { DEFAULT_PREFERENCES, ROUTINES } from '../domain/types'
import { buildCandidatePool } from '../domain/candidates'
import { passesSuggestionQualityGate } from '../domain/phrase-quality'
import { isProtectedTokenId } from '../domain/protected-core'
import { buildRankingContext, buildSuggestionPrompt } from './prompt'

describe('bounded ranking prompt', () => {
  it('builds a strict schema whose enum is ONLY candidate IDs', () => {
    const input = buildModelInput(DEFAULT_PREFERENCES, [])
    const { pool, schema } = buildRankingContext(input)
    const parsed = JSON.parse(schema) as {
      properties: { chosen: { items: { enum: string[] }; maxItems: number } }
      additionalProperties: boolean
    }

    expect(parsed.additionalProperties).toBe(false)
    expect(parsed.properties.chosen.items.enum).toEqual(pool.candidates.map((candidate) => candidate.id))
    expect(parsed.properties.chosen.maxItems).toBe(4)
    // The grammar contains no vocabulary words at all — only IDs.
    expect(schema).not.toMatch(/"(snack|game|water)"/)
  })

  it('lists every candidate phrase and the child’s current words in the prompt', () => {
    const input = buildModelInput({ ...DEFAULT_PREFERENCES, routine: 'outside' }, [
      { instanceId: 't1', tokenId: 'i', label: 'I', provenance: 'fringe', category: 'people' },
    ])
    const { pool, prompt } = buildRankingContext(input)

    for (const candidate of pool.candidates) {
      const line = `${candidate.id} = ${candidate.tokens.map((token) => token.label).join(' ')}`
      expect(prompt).toContain(line)
    }
    expect(prompt).toContain('Child already said: i')
    expect(prompt).toContain('{"chosen":["c1","c2"]}')
  })

  it('yields natural, allowlisted, protected-free pools across every routine and age band', () => {
    for (const routine of ROUTINES) {
      for (const ageBand of ['4-6', '7-9', '10-12'] as const) {
        const input = buildModelInput({ ...DEFAULT_PREFERENCES, routine, ageBand }, [])
        const pool = buildCandidatePool(input)
        const visible = new Set(input.allowlist)
        expect(
          pool.candidates.length,
          `${routine}/${ageBand}: pool must offer real choice`,
        ).toBeGreaterThanOrEqual(2)

        for (const candidate of pool.candidates) {
          const ids = candidate.tokens.map((token) => token.id)
          expect(passesSuggestionQualityGate(ids), `${routine}: ${ids.join(' ')} must read naturally`).toBe(true)
          for (const id of ids) {
            expect(visible.has(id), `${id} must be on the visible-board allowlist`).toBe(true)
            expect(isProtectedTokenId(id), `${id} must never be protected core`).toBe(false)
          }
        }
      }
    }
  })

  it('builds useful suffix continuations from authored messages without parroting', () => {
    // After "I want" the pool must offer concrete objects.
    const wantInput = buildModelInput(DEFAULT_PREFERENCES, message(['i', 'want']))
    const wantPool = buildCandidatePool(wantInput)
    const wantIds = wantPool.candidates.map((candidate) => candidate.tokens.map((token) => token.id))
    expect(wantIds.length).toBeGreaterThan(0)
    expect(wantIds.some(([id]) => id === 'snack' || id === 'water' || id === 'game')).toBe(true)

    // After "go" the pool must offer places.
    const goInput = buildModelInput({ ...DEFAULT_PREFERENCES, routine: 'outside' }, message(['go']))
    const goIds = buildCandidatePool(goInput).candidates.map((candidate) =>
      candidate.tokens.map((token) => token.id),
    )
    expect(goIds.some(([id]) => id === 'park' || id === 'outside')).toBe(true)

    // No continuation may merely repeat the authored tail.
    for (const [ids] of [wantIds, goIds].flat().map((ids) => [ids])) {
      expect(ids.join(' ')).not.toBe('i want')
      expect(ids.join(' ')).not.toBe('go')
    }

    function message(ids: string[]) {
      return ids.map((id, index) => ({
        instanceId: `t-${index}`,
        tokenId: id,
        label: id.toUpperCase(),
        provenance: 'fringe' as const,
        category: 'people' as const,
      }))
    }
  })

  it('keeps stable opaque IDs for identical inputs', () => {
    const input = buildModelInput(DEFAULT_PREFERENCES, [])
    const first = buildSuggestionPrompt(input, buildCandidatePool(input))
    const second = buildSuggestionPrompt(input, buildCandidatePool(input))
    expect(first).toBe(second)
  })
})
