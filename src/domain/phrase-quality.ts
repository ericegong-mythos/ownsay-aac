import type { SuggestionToken } from './types'

/**
 * Strict quality gate for MODEL-PROPOSED suggestion rows. The grammar
 * constraint guarantees vocabulary membership; this gate guarantees the row is
 * something a child could plausibly want to say: no repeated tokens, no
 * parroting of the current message, and a word order that reads naturally in
 * English. Everything here is pure and independently testable.
 */

type WordClass =
  | 'question'
  | 'pronoun'
  | 'negation'
  | 'verb'
  | 'adjective'
  | 'noun'
  | 'wildcard'

const QUESTION_IDS = new Set(['what', 'where', 'who', 'why', 'when', 'can'])
const PRONOUN_IDS = new Set(['i', 'you', 'we'])
const NEGATION_IDS = new Set(['not', 'dont-like'])
const VERB_IDS = new Set([
  'want',
  'need',
  'like',
  'feel',
  'go',
  'look',
  'eat',
  'drink',
  'read',
  'write',
  'draw',
  'sing',
  'wash',
  'walk',
  'try',
  'say-again',
  'explain',
])
const ADJECTIVE_IDS = new Set([
  'happy',
  'sad',
  'angry',
  'tired',
  'scared',
  'hot',
  'cold',
  'hungry',
  'thirsty',
  'big',
  'little',
  'good',
  'bad',
  'calm',
  'worried',
  'proud',
  'confused',
  'boring',
  'unfair',
  'quiet',
  'fun',
  'sunny',
  'windy',
  'sweet',
  'different',
  'same',
  'too-loud',
  'too-bright',
])

/** please/thanks/again/wait/later/because/and/to may appear anywhere. */
const WILDCARD_IDS = new Set(['please', 'thanks', 'again', 'wait', 'later', 'because', 'and', 'to'])

/** Activity words read naturally as "play game"-style compounds. */
const ACTIVITY_LEAD_IDS = new Set(['play'])

// Relative English ordering; lower sorts earlier. "Want Snack Please" ✓,
// "Snack Want" ✗, "I Happy" ✓, "Happy I" ✗.
const CLASS_RANK: Record<Exclude<WordClass, 'wildcard'>, number> = {
  question: 0,
  pronoun: 1,
  negation: 2,
  verb: 3,
  adjective: 4,
  noun: 5,
}

function classify(tokenId: string): WordClass {
  if (WILDCARD_IDS.has(tokenId)) return 'wildcard'
  if (QUESTION_IDS.has(tokenId)) return 'question'
  if (PRONOUN_IDS.has(tokenId)) return 'pronoun'
  if (NEGATION_IDS.has(tokenId)) return 'negation'
  if (VERB_IDS.has(tokenId)) return 'verb'
  if (ADJECTIVE_IDS.has(tokenId)) return 'adjective'
  return 'noun'
}

export function hasRepeatedTokens(ids: readonly string[]): boolean {
  return new Set(ids).size !== ids.length
}

export function duplicatesCurrentMessage(
  ids: readonly string[],
  currentTokenIds?: readonly string[],
): boolean {
  if (!currentTokenIds || currentTokenIds.length === 0) return false
  const matchesAt = (offset: number) =>
    ids.every((id, index) => currentTokenIds[offset + index] === id)
  // The whole message parroted back, or its tail repeated unchanged.
  if (ids.length === currentTokenIds.length && matchesAt(0)) return true
  if (ids.length >= 2 && ids.length <= currentTokenIds.length) {
    if (matchesAt(currentTokenIds.length - ids.length)) return true
  }
  return false
}

/** True when every adjacent content-word pair respects natural English order. */
export function hasPlausibleOrder(ids: readonly string[]): boolean {
  // Wildcards ("please", "to", "again"…) may sit anywhere and bridge phrases,
  // so order is judged within each wildcard-delimited segment. Alignment
  // between ids and their classes is kept by pairing them up front.
  const segments: Array<Array<{ id: string; cls: Exclude<WordClass, 'wildcard'> }>> = [[]]
  for (const id of ids) {
    const cls = classify(id)
    if (cls === 'wildcard') segments.push([])
    else segments[segments.length - 1].push({ id, cls })
  }

  for (const segment of segments) {
    for (let index = 1; index < segment.length; index += 1) {
      const previous = segment[index - 1]
      const current = segment[index]
      if (CLASS_RANK[current.cls] < CLASS_RANK[previous.cls]) return false
      // Telegraphic AAC allows noun compounds ("play game"); repeated verbs
      // ("look look") or pronouns still read as noise.
      if (current.cls === previous.cls && current.cls !== 'noun' && !ACTIVITY_LEAD_IDS.has(previous.id)) {
        return false
      }
    }
  }
  return true
}

export interface RowQualityContext {
  currentTokenIds?: readonly string[]
}

/** Single authoritative predicate applied to every model-sourced row. */
export function passesSuggestionQualityGate(ids: readonly string[], context: RowQualityContext = {}): boolean {
  if (ids.length === 0) return false
  if (hasRepeatedTokens(ids)) return false
  if (duplicatesCurrentMessage(ids, context.currentTokenIds)) return false
  if (!hasPlausibleOrder(ids)) return false
  return true
}

/** Filters already-sanitised suggestions down to rows that pass the gate. */
export function applyQualityGate(
  suggestions: readonly { tokens: SuggestionToken[] }[],
  context: RowQualityContext = {},
): number[] {
  const keep: number[] = []
  suggestions.forEach((suggestion, index) => {
    if (passesSuggestionQualityGate(suggestion.tokens.map((token) => token.id), context)) keep.push(index)
  })
  return keep
}
