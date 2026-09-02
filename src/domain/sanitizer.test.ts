import { describe, expect, it } from 'vitest'
import { PROTECTED_CORE_IDS } from './protected-core'
import { sanitizeSuggestions } from './sanitizer'
import { getModelAllowlist } from './vocabulary'

describe('suggestion sanitizer', () => {
  const allowlist = getModelAllowlist()

  it('keeps only allowlisted sequences', () => {
    const result = sanitizeSuggestions({
      suggestions: [{ tokens: ['i', 'want'] }, { tokens: ['made-up-word'] }],
    })
    expect(result).toHaveLength(1)
    expect(result[0]?.tokens.map((token) => token.id)).toEqual(['i', 'want'])
    expect(result[0]?.tokens.every((token) => allowlist.has(token.id))).toBe(true)
  })

  it('rejects protected safety tokens', () => {
    const result = sanitizeSuggestions({
      suggestions: PROTECTED_CORE_IDS.map((id) => ({ tokens: [id] })),
    })
    expect(result).toEqual([])
  })

  it('rejects out-of-vocabulary tokens mixed with valid ones', () => {
    const result = sanitizeSuggestions({
      suggestions: [{ tokens: ['i', 'unknown-child-name'] }],
    })
    expect(result).toEqual([])
  })

  it('rejects duplicates, overlong phrases and unparseable text', () => {
    const result = sanitizeSuggestions(`
      here is junk
      {"suggestions":[
        {"tokens":["i","want"]},
        {"tokens":["i","want"]},
        {"tokens":["i","want","to","go","outside","later"]},
        {"tokens":[1,2]}
      ]}
    `)
    expect(result).toHaveLength(1)
    expect(result[0]?.tokens.map((token) => token.id)).toEqual(['i', 'want'])
  })

  it('caps output at four suggestions', () => {
    const result = sanitizeSuggestions({
      suggestions: [
        { tokens: ['i'] },
        { tokens: ['you'] },
        { tokens: ['want'] },
        { tokens: ['need'] },
        { tokens: ['look'] },
      ],
    })
    expect(result).toHaveLength(4)
  })

  it('does not mutate the current message tokens', () => {
    const message = [{ tokenId: 'i', label: 'I' }]
    const copy = structuredClone(message)
    sanitizeSuggestions({ suggestions: [{ tokens: ['want'] }] })
    expect(message).toEqual(copy)
  })
})
