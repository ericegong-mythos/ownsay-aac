import { describe, expect, it } from 'vitest'
import {
  duplicatesCurrentMessage,
  hasPlausibleOrder,
  hasRepeatedTokens,
  passesSuggestionQualityGate,
} from './phrase-quality'
import { sanitizeSuggestions } from './sanitizer'
import { getModelAllowlist } from './vocabulary'

describe('suggestion quality gate', () => {
  describe('repeated tokens inside one row', () => {
    it('rejects the exact regression phrase "I Look Snack Look Look"', () => {
      expect(hasRepeatedTokens(['i', 'look', 'snack', 'look', 'look'])).toBe(true)
      expect(passesSuggestionQualityGate(['i', 'look', 'snack', 'look', 'look'])).toBe(false)
    })

    it('rejects any row with a repeated token ID and accepts unique rows', () => {
      expect(hasRepeatedTokens(['go', 'go'])).toBe(true)
      expect(hasRepeatedTokens(['i', 'want', 'game'])).toBe(false)
      // The gate strips such rows from real model output end-to-end.
      const rows = sanitizeSuggestions(
        {
          suggestions: [
            { tokens: ['i', 'look', 'snack', 'look', 'look'] },
            { tokens: ['i', 'want', 'snack'] },
          ],
        },
        { allowlist: new Set(['i', 'look', 'snack', 'want']), applyQualityGate: true, source: 'local-model' },
      )
      expect(rows.map((row) => row.tokens.map((token) => token.id))).toEqual([['i', 'want', 'snack']])
    })
  })

  describe('current-message duplication', () => {
    const message = ['i', 'want', 'game']

    it('rejects the whole message echoed back', () => {
      expect(duplicatesCurrentMessage(['i', 'want', 'game'], message)).toBe(true)
    })

    it('rejects an unchanged tail of the message repeated verbatim', () => {
      expect(duplicatesCurrentMessage(['want', 'game'], message)).toBe(true)
    })

    it('allows genuine continuations that extend what the child said', () => {
      expect(duplicatesCurrentMessage(['i', 'want', 'game', 'again'], ['i', 'want', 'game'], )).toBe(false)
      expect(duplicatesCurrentMessage(['game'], message)).toBe(false)
      expect(duplicatesCurrentMessage(['i', 'want', 'blocks'], message)).toBe(false)
    })

    it('is applied through the sanitiser with current token context', () => {
      const rows = sanitizeSuggestions(
        { suggestions: [{ tokens: ['i', 'want', 'game'] }, { tokens: ['play', 'game'] }] },
        {
          allowlist: new Set(['i', 'want', 'game', 'play']),
          currentTokenIds: ['i', 'want', 'game'],
          applyQualityGate: true,
          source: 'local-model',
        },
      )
      expect(rows.map((row) => row.tokens.map((token) => token.id))).toEqual([['play', 'game']])
    })
  })

  describe('plausible multi-token word order', () => {
    it.each([
      [['i', 'want', 'snack'], true],
      [['i', 'hungry'], true],
      [['drink', 'water'], true],
      [['what', 'that'], true],
      [['your-turn', 'please'], true],
      [['different', 'game'], true],
      [['can', 'we', 'go'], true],
      // Telegraphic but natural child speech that must NOT be policed away:
      [['i', 'want', 'to', 'go'], true],
      [['play', 'game'], true],
      [['want', 'water', 'please'], true],
      [['please', 'look', 'bird'], true],
      [['again', 'later'], true],
      // Inversions and noise:
      [['snack', 'want', 'i'], false],
      [['happy', 'i'], false],
      [['water', 'drink'], false],
      [['look', 'look'], false],
      [['i', 'you', 'want'], false],
      [['what', 'what', 'that'], false],
    ])('%j → %j', (ids, expected) => {
      expect(hasPlausibleOrder(ids)).toBe(expected)
    })

    it('wildcard words bridge segments without corrupting id/class alignment', () => {
      // "i want to go": the wildcard 'to' separates two verbs; without
      // segment-aware alignment this misread as verb+verb noise.
      expect(hasPlausibleOrder(['i', 'want', 'to', 'go'])).toBe(true)
      expect(hasPlausibleOrder(['go', 'to', 'park'])).toBe(true)
    })
  })

  describe('deterministic curated suggestions stay unaffected', () => {
    it('every routine starter passes the same gate it never needs to skip', () => {
      const starters = [
        ['i', 'want', 'play'],
        ['turn'],
        ['game'],
        ['your-turn'],
        ['i', 'hungry'],
        ['i', 'thirsty'],
        ['i', 'want', 'snack'],
        ['i', 'want', 'water'],
        ['i', 'need', 'break-time'],
        ['i', 'want', 'toilet'],
        ['quiet'],
        ['i', 'tired'],
        ['read', 'story'],
        ['go', 'outside'],
        ['look', 'bird'],
        ['i', 'hot'],
        ['i', 'want'],
        ['i', 'feel'],
        ['can', 'i'],
        ['what', 'that'],
        ['to', 'go'],
        ['feel', 'happy'],
        ['feel', 'tired'],
        ['need'],
        ['we', 'go'],
        ['different'],
        ['say-again', 'please'],
        ['different', 'game'],
      ]
      for (const ids of starters) {
        expect(passesSuggestionQualityGate(ids), `${ids.join(' ')} must stay valid`).toBe(true)
      }
    })
  })

  describe('low-quality rows are omitted and replaced honestly', () => {
    it('a fully rejected model answer leaves instant phrases, never a fake OwnSay label', () => {
      const allowlist = new Set([...getModelAllowlist()])
      const rows = sanitizeSuggestions(
        {
          suggestions: [
            { tokens: ['look', 'look', 'look'] },
            { tokens: ['snack', 'want', 'i'] },
            { tokens: ['water', 'milk', 'juice'] },
          ],
        },
        { allowlist, applyQualityGate: true, currentTokenIds: [], source: 'local-model' },
      )
      expect(rows).toEqual([])
    })

    it('keeps only gate-passing rows when the model mixes good and bad output', () => {
      const rows = sanitizeSuggestions(
        {
          suggestions: [
            { tokens: ['i', 'look', 'snack', 'look', 'look'] },
            { tokens: ['i', 'want', 'snack'] },
            { tokens: ['water', 'drink'] },
          ],
        },
        {
          // 'drink' IS allowlisted: rejection below is purely word-order.
          allowlist: new Set(['i', 'look', 'snack', 'want', 'water', 'fruit', 'drink']),
          applyQualityGate: true,
          currentTokenIds: [],
          source: 'local-model',
        },
      )
      // "Water Drink" is an inverted verb phrase; only the natural row stays.
      expect(rows.map((row) => row.id)).toEqual(['local-model:i want snack'])
    })
  })
})
