import { describe, expect, it } from 'vitest'
import { appendSuggestionTokens, buildModelInput, cloneMessage } from './policy'
import { DEFAULT_PREFERENCES, type AuthoredToken } from './types'

const message: AuthoredToken[] = [
  {
    instanceId: 'a',
    tokenId: 'i',
    label: 'I',
    provenance: 'fringe',
    category: 'people',
  },
]

describe('model policy', () => {
  it('sends only explicit current state', () => {
    const input = buildModelInput(DEFAULT_PREFERENCES, message)
    expect(Object.keys(input).sort()).toEqual(['ageBand', 'allowlist', 'currentTokenIds', 'interests', 'routine'])
    expect(input.ageBand).toBe('7-9')
    expect(input.routine).toBe('play')
    expect(input.interests).toEqual(['animals', 'stories'])
    expect(input.currentTokenIds).toEqual(['i'])
    expect(input.allowlist.includes('no')).toBe(false)
    expect(input.allowlist.includes('i')).toBe(true)
    expect(input.allowlist).toEqual(
      expect.arrayContaining(['play', 'game', 'toy', 'blocks']),
    )
  })

  it('changes the bounded visible allowlist with routine, interests and density', () => {
    const play = buildModelInput(
      { ...DEFAULT_PREFERENCES, routine: 'play', accessDensity: 'large', interests: [] },
      [],
    )
    const food = buildModelInput(
      { ...DEFAULT_PREFERENCES, routine: 'food', accessDensity: 'more', interests: ['food'] },
      [],
    )
    expect(play.allowlist).not.toEqual(food.allowlist)
    expect(play.allowlist).toContain('game')
    expect(food.allowlist).toContain('snack')
    expect(food.allowlist.length).toBeGreaterThan(play.allowlist.length)
  })

  it('appends suggestion tokens without rewriting the current message', () => {
    const before = cloneMessage(message)
    const next = appendSuggestionTokens(
      message,
      { id: 's', tokens: [{ id: 'want', label: 'Want' }], source: 'deterministic' },
      () => 'b',
    )
    expect(message).toEqual(before)
    expect(next.map((token) => token.tokenId)).toEqual(['i', 'want'])
    expect(next[1]?.provenance).toBe('suggestion')
  })
})
