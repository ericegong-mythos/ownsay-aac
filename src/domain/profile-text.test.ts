import { describe, expect, it } from 'vitest'
import {
  EXTRA_WORD_LABEL_LIMIT,
  NICKNAME_LIMIT,
  normaliseExtraWord,
  normaliseNickname,
} from './profile-text'

describe('profile text contract', () => {
  it('normalises ordinary Unicode names, emoji, punctuation and spacing', () => {
    expect(normaliseNickname('  Sam\u00a0\u00a0😊  ')).toBe('Sam 😊')
    expect(normaliseNickname('Ana-Mari\u0301a O’Neil')).toBe('Ana-María O’Neil')
    expect(normaliseExtraWord('  🧸  ')).toBe('🧸')
    expect(normaliseExtraWord('Gran’s!')).toBe('Gran’s!')
  })

  it('rejects empty, control, bidi-dangerous, malformed, invisible and overlong text', () => {
    for (const value of ['', '   ', 'Sam\nJones', 'Sam\u202eJones', '\ud83d', '\u200d']) {
      expect(normaliseNickname(value)).toBeNull()
    }
    expect(normaliseNickname('x'.repeat(NICKNAME_LIMIT + 1))).toBeNull()
    expect(normaliseExtraWord('x'.repeat(EXTRA_WORD_LABEL_LIMIT + 1))).toBeNull()
  })

  it('stores useful multi-word labels in full without weakening sanitisation', () => {
    expect(EXTRA_WORD_LABEL_LIMIT).toBe(32)
    expect(normaliseExtraWord('A longer personal phrase')).toBe('A longer personal phrase')
    expect(normaliseExtraWord('x'.repeat(EXTRA_WORD_LABEL_LIMIT))).toHaveLength(EXTRA_WORD_LABEL_LIMIT)

    // Every rejection rule still applies at the new length: a longer budget is
    // not a licence for control, bidi or invisible text.
    for (const value of [
      'A personal\nword',
      'A \u202epersonal word',
      'A\u0000personal word',
      '\u200d'.repeat(20),
      ' '.repeat(EXTRA_WORD_LABEL_LIMIT),
    ]) {
      expect(normaliseExtraWord(value)).toBeNull()
    }
  })
})
