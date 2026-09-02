import { isProtectedTokenId, PROTECTED_CORE_SET } from './protected-core'
import type { AuthoredToken, ChildProfile, DemoPreferences, ExtraWord, Suggestion } from './types'
import { getModelAllowlist, getVocabById } from './vocabulary'
import { personalFavouriteTokens, selectBoard } from './board'

export const MAX_SUGGESTIONS = 4
export const MAX_TOKENS_PER_SUGGESTION = 5
export const GENERATION_TIMEOUT_MS = 25_000

export interface ModelInput {
  ageBand: DemoPreferences['ageBand']
  routine: DemoPreferences['routine']
  interests: DemoPreferences['interests']
  currentTokenIds: string[]
  allowlist: string[]
  /**
   * Label resolution for personal words that sit outside the global
   * vocabulary. Only IDs already inside `allowlist` can ever be used; this
   * map only supplies their display text for prompt/pool construction.
   */
  tokenLabels?: Record<string, string>
}

export function buildModelInput(
  prefs: DemoPreferences,
  message: readonly AuthoredToken[],
  personalWords: readonly ExtraWord[] = (prefs as Partial<ChildProfile>).extraWords ?? [],
): ModelInput {
  const modelAllowlist = getModelAllowlist()
  const visibleBoard = selectBoard(prefs, personalWords)
  const personalFavourites = personalFavouriteTokens(prefs, personalWords, {
    visibleBoard,
  })
  const personalById = new Map(personalFavourites.map((token) => [token.id, token.label]))
  return {
    ageBand: prefs.ageBand,
    routine: prefs.routine,
    interests: [...prefs.interests],
    currentTokenIds: message.map((token) => token.tokenId),
    // Keep the tiny local model focused on words the communicator can
    // currently see. Protected core words are excluded by modelAllowlist;
    // classified favourite words may be ranked but never invented.
    allowlist: [
      ...visibleBoard.fringe.map((entry) => entry.id).filter((id) => modelAllowlist.has(id)),
      ...personalById.keys(),
    ].sort(),
    ...(personalById.size > 0
      ? { tokenLabels: Object.fromEntries(personalById) }
      : {}),
  }
}

export function isSafeSuggestionSequence(
  ids: readonly string[],
  allowlist: ReadonlySet<string> = getModelAllowlist(),
  tokenExists: (id: string) => boolean = (id) => Boolean(getVocabById(id)),
): boolean {
  if (ids.length === 0 || ids.length > MAX_TOKENS_PER_SUGGESTION) return false
  return ids.every((id) => allowlist.has(id) && !isProtectedTokenId(id) && tokenExists(id))
}

export function suggestionTouchesProtected(ids: readonly string[]): boolean {
  return ids.some((id) => PROTECTED_CORE_SET.has(id))
}

export function cloneMessage(message: readonly AuthoredToken[]): AuthoredToken[] {
  return message.map((token) => ({ ...token }))
}

/**
 * Appends suggestion tokens to the authored rail. Every token must resolve to
 * a real entry — global vocabulary by default, or the caller-supplied board
 * resolver (which knows the child's personal words). Protected core words are
 * refused unconditionally.
 */
export function appendSuggestionTokens(
  message: readonly AuthoredToken[],
  suggestion: Suggestion,
  makeId: () => string,
  resolveEntry: (id: string) => { label: string; category: AuthoredToken['category'] } | undefined = (id) => {
    const entry = getVocabById(id)
    return entry ? { label: entry.label, category: entry.category } : undefined
  },
): AuthoredToken[] {
  const next = cloneMessage(message)
  for (const token of suggestion.tokens) {
    if (isProtectedTokenId(token.id)) continue
    const entry = resolveEntry(token.id)
    if (!entry) continue
    next.push({
      instanceId: makeId(),
      tokenId: token.id,
      label: entry.label,
      provenance: 'suggestion',
      category: entry.category,
    })
  }
  return next
}
