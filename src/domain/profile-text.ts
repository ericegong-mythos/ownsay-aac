/** Maximum stored nickname length, measured in UTF-16 code units like HTML maxlength. */
export const NICKNAME_LIMIT = 24

/**
 * Maximum stored label length for a personal board word. The ceiling supports
 * useful multi-word phrases while keeping imported and authored data bounded.
 * Sanitisation is unchanged: the limit only bounds length.
 */
export const EXTRA_WORD_LABEL_LIMIT = 32

const DISALLOWED_SCALAR = /[\p{Cc}\p{Cs}\p{Zl}\p{Zp}]/u
const FORMAT_SCALAR = /\p{Cf}/u
const VISIBLE_SCALAR = /[^\p{Zs}\p{Cf}\p{Mn}\p{Me}]/u

// ZWNJ and ZWJ are legitimate parts of several writing systems and emoji
// sequences. Other invisible format characters include the Unicode bidi
// controls used in text-spoofing attacks, so they are not stored.
const ALLOWED_FORMAT_SCALARS = new Set(['\u200c', '\u200d'])

function normaliseDisplayText(input: string, limit: number): string | null {
  let value: string
  try {
    value = input.normalize('NFC')
  } catch {
    return null
  }

  for (const scalar of value) {
    if (DISALLOWED_SCALAR.test(scalar)) return null
    if (FORMAT_SCALAR.test(scalar) && !ALLOWED_FORMAT_SCALARS.has(scalar)) return null
  }

  // Collapse printable Unicode spacing to one ordinary space. Control
  // whitespace (tabs/newlines) was rejected above instead of being hidden.
  value = value.replace(/\p{Zs}+/gu, ' ').trim()
  if (!value || value.length > limit || !VISIBLE_SCALAR.test(value)) return null
  return value
}

/**
 * Canonical contract for a stored child nickname. Returns null for empty,
 * malformed, invisible, control-containing, bidi-dangerous, or overlong text.
 */
export function normaliseNickname(input: string): string | null {
  return normaliseDisplayText(input, NICKNAME_LIMIT)
}

/**
 * Canonical contract for a stored personal board-word label. Printable Unicode
 * (including emoji and ordinary punctuation) is supported.
 */
export function normaliseExtraWord(input: string): string | null {
  return normaliseDisplayText(input, EXTRA_WORD_LABEL_LIMIT)
}
