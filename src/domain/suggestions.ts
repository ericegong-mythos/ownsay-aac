import { MAX_SUGGESTIONS, MAX_TOKENS_PER_SUGGESTION } from './policy'
import { sanitizeSuggestions } from './sanitizer'
import { isContextualFringe, selectBoard } from './board'
import type { AuthoredToken, BoardSelection, DemoPreferences, Routine, Suggestion } from './types'

type RoutinePref = DemoPreferences['routine']

/** Visible favourite terms that may seed personalised continuations. */
export interface FavouriteSeed {
  id: string
  label: string
}

/** Composed-board context a caller may supply instead of reselecting. */
export interface SuggestionContext {
  board: BoardSelection
  favourites?: readonly FavouriteSeed[]
}

interface Pattern {
  /** Lower sorts earlier. Routine rows must never be hidden behind generic ones. */
  priority: number
  when: (ids: readonly string[], routine: RoutinePref) => boolean
  tokens: readonly string[]
}

/** What "want" reaches for in each world; keeps continuations routine-aware. */
const ROUTINE_OBJECTS: Record<Routine, readonly (readonly string[])[]> = {
  play: [
    ['game'],
    ['toy'],
    ['blocks'],
  ],
  food: [
    ['snack'],
    ['water'],
    ['fruit'],
  ],
  school: [
    ['work'],
    ['break-time'],
    ['notebook'],
  ],
  home: [
    ['tv'],
    ['bed'],
    ['dinner'],
  ],
  outside: [
    ['park'],
    ['walk'],
    ['bike'],
  ],
}

/** Empty-message starters per world: four distinct, immediately useful openers. */
const ROUTINE_STARTERS: Record<Routine, readonly (readonly string[])[]> = {
  play: [
    ['i', 'want', 'play'],
    ['turn'],
    ['game'],
    ['your-turn'],
  ],
  food: [
    ['i', 'hungry'],
    ['i', 'thirsty'],
    ['i', 'want', 'snack'],
    ['i', 'want', 'water'],
  ],
  school: [
    ['i', 'need', 'break-time'],
    ['i', 'want', 'toilet'],
    ['turn'],
    ['quiet'],
  ],
  home: [
    ['i', 'tired'],
    ['i', 'want', 'bed'],
    ['i', 'want', 'tv'],
    ['read', 'story'],
  ],
  outside: [
    ['go', 'outside'],
    ['i', 'want', 'park'],
    ['look', 'bird'],
    ['i', 'hot'],
  ],
}

/** Last-resort fillers used only to top up to MAX_SUGGESTIONS distinct rows. */
const GENERIC_STARTERS: readonly (readonly string[])[] = [
  ['i', 'want'],
  ['i', 'feel'],
  ['can', 'i'],
  ['what', 'that'],
]

function buildPatterns(): Pattern[] {
  const patterns: Pattern[] = []

  // Tier 0 — routine starters win first, always.
  for (const [routine, starters] of Object.entries(ROUTINE_STARTERS) as [Routine, readonly (readonly string[])[]][]) {
    starters.forEach((tokens, index) => {
      patterns.push({
        priority: index,
        when: (ids, current) => ids.length === 0 && current === routine,
        tokens,
      })
    })
  }

  // Tier 1 — routine-aware continuations.
  for (const [routine, objects] of Object.entries(ROUTINE_OBJECTS) as [Routine, readonly (readonly string[])[]][]) {
    objects.forEach((tokens, index) => {
      patterns.push({
        priority: 10 + index,
        when: (ids, current) => ids.at(-1) === 'want' && current === routine,
        tokens,
      })
    })
  }
  patterns.push({ priority: 10, when: (ids, r) => r === 'school' && ids.at(-1) === 'need', tokens: ['toilet'] })
  patterns.push({ priority: 11, when: (ids, r) => r === 'home' && ids.at(-1) === 'need', tokens: ['bed'] })
  patterns.push({ priority: 12, when: (ids, r) => r === 'outside' && ids.at(-1) === 'go', tokens: ['park'] })
  patterns.push({ priority: 13, when: (ids, r) => r === 'food' && ids.at(-1) === 'eat', tokens: ['fruit'] })
  patterns.push({
    priority: 14,
    when: (ids, r) => r === 'play' && ids.includes('dont-like'),
    tokens: ['different', 'game'],
  })

  // Tier 2 — universal scaffolding, only after every routine row had its turn.
  patterns.push(
    { priority: 30, when: (ids) => ids.at(-1) === 'want', tokens: ['to', 'go'] },
    { priority: 31, when: (ids) => ids.at(-1) === 'feel', tokens: ['happy'] },
    { priority: 32, when: (ids) => ids.at(-1) === 'feel', tokens: ['tired'] },
    { priority: 33, when: (ids) => ids.at(-1) === 'i', tokens: ['need'] },
    { priority: 34, when: (ids) => ids.at(-1) === 'can', tokens: ['we', 'go'] },
    { priority: 35, when: (ids) => ids.includes('dont-like'), tokens: ['different'] },
    { priority: 36, when: (ids) => ids.includes('say-again'), tokens: ['please'] },
  )

  return patterns
}

const PATTERNS = buildPatterns()

/**
 * Deterministic, profile-aware suggestions.
 *
 * Every row — routine starters, continuations and personalised favourite
 * phrases alike — is composed only from tokens on the child's CURRENTLY
 * composed board (core excluded downstream by the sanitizer boundary), is
 * bounded in count and length, and appends only after an explicit tap.
 * Personal aversion/context words can never enter: callers pass favourites
 * resolved from `tone: 'favourite'` words alone.
 */
export function buildDeterministicSuggestions(
  prefs: DemoPreferences,
  message: readonly AuthoredToken[],
  context?: SuggestionContext,
): Suggestion[] {
  const ids = message.map((token) => token.tokenId)
  const board = context?.board ?? selectBoard(prefs)
  const visibleIds = new Set(
    [...board.core, ...board.fringe].map((entry) => entry.id),
  )
  const isVisibleSequence = (tokens: readonly string[]) =>
    tokens.length > 0 && tokens.every((id) => visibleIds.has(id))
  // Aversion/context words are choices to tap directly; they must never be
  // suggested back, not even as one-word fillers.
  const suggestible = (id: string): boolean => {
    const entry = board.fringe.find((tile) => tile.id === id)
    return !entry || entry.personalTone !== 'context'
  }

  const matched = PATTERNS
    .filter((pattern) => pattern.when(ids, prefs.routine))
    .sort((a, b) => a.priority - b.priority)
    .map((pattern) => ({ tokens: pattern.tokens.slice(0, MAX_TOKENS_PER_SUGGESTION) }))
    .filter((row) => isVisibleSequence(row.tokens))

  const seen = new Set(matched.map((row) => row.tokens.join(' ')))

  // Personalised tier: a small, stable set of favourite continuations that
  // keeps the dock genuinely this-child-aware on every device, including the
  // Fire tablet where the optional model never loads.
  const personalised: Array<{ tokens: readonly string[] }> = []
  if (context?.favourites?.length) {
    const favourites = context.favourites.filter((seed) => visibleIds.has(seed.id))
    const pushPersonal = (tokens: readonly string[]) => {
      if (personalised.length >= 2) return
      const clipped = tokens.slice(0, MAX_TOKENS_PER_SUGGESTION)
      const key = clipped.join(' ')
      if (!isVisibleSequence(clipped) || seen.has(key)) return
      seen.add(key)
      personalised.push({ tokens: [...clipped] })
    }
    if (ids.length === 0) {
      for (const seed of favourites) {
        if (personalised.length >= 2) break
        pushPersonal(['i', 'want', seed.id])
      }
    } else {
      const last = ids[ids.length - 1]
      if (last === 'want' || last === 'more') {
        for (const seed of favourites) {
          if (personalised.length >= 1) break
          pushPersonal([seed.id])
        }
      }
    }
  }

  const filler = GENERIC_STARTERS.filter(
    (tokens) =>
      isVisibleSequence(tokens) &&
      !seen.has(tokens.join(' ')) &&
      tokens.every((id) => suggestible(id)),
  )
    .map((tokens) => ({ tokens: [...tokens] }))

  for (const row of filler) seen.add(row.tokens.join(' '))

  // Small boards deliberately expose fewer grammar words, so some curated
  // multi-token phrases will not fit their exact visible vocabulary. Keep the
  // dock useful by filling any remaining slots with meaningful one-word AAC
  // utterances from the selected board itself: contextual words first, then
  // other visible fringe words. Protected core remains excluded downstream.
  const visibleSingles = [
    ...board.fringe.filter((entry) => isContextualFringe(entry, prefs)),
    ...board.fringe.filter((entry) => !isContextualFringe(entry, prefs)),
  ]
    .filter((row) => suggestible(row.id))
    .map((entry) => ({ tokens: [entry.id] }))
    .filter((row) => {
      const key = row.tokens.join(' ')
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })

  const rows = [...matched, ...personalised, ...filler, ...visibleSingles].slice(0, MAX_SUGGESTIONS)

  // Passing the exact visible-board set into the sanitizer makes the boundary
  // defensive: future patterns cannot accidentally reintroduce global
  // vocabulary that this child cannot currently see. The board-scoped
  // resolvers let personal words resolve without ever widening the allowlist.
  const boardEntries = new Map([...board.core, ...board.fringe].map((entry) => [entry.id, entry]))
  return sanitizeSuggestions(
    { suggestions: rows },
    {
      source: 'deterministic',
      allowlist: visibleIds,
      tokenExists: (id) => boardEntries.has(id),
      labelFor: (id) => boardEntries.get(id)?.label,
    },
  )
}

export function suggestionsEqual(a: readonly Suggestion[], b: readonly Suggestion[]): boolean {
  if (a.length !== b.length) return false
  return a.every((item, index) => item.id === b[index]?.id)
}
