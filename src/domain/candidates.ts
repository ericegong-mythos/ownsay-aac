import { hasRepeatedTokens, passesSuggestionQualityGate } from './phrase-quality'
import type { ModelInput } from './policy'
import { MAX_SUGGESTIONS } from './policy'
import type { SuggestionToken } from './types'
import { getVocabLabel } from './vocabulary'

/**
 * Bounded rank-and-select architecture for the optional on-device model.
 *
 * A 360M model cannot reliably compose natural token sequences. Instead the
 * app builds a CURATED CANDIDATE POOL of complete, natural phrases from the
 * words actually visible to this child (routine, interests, age band) plus
 * useful suffix continuations of what they have already authored. The model's
 * entire job is contextual ranking: choose up to four candidate IDs. Language
 * never leaves the pool, so every accepted suggestion is guaranteed natural,
 * allowlisted and protected-free — while still being genuinely chosen by an
 * on-device LLM for this moment.
 */

export interface PhraseCandidate {
  /** Stable opaque ID within one pool: "c1", "c2", … */
  id: string
  tokens: SuggestionToken[]
}

export interface CandidatePool {
  candidates: PhraseCandidate[]
  byId: Map<string, PhraseCandidate>
}

/** Full natural openers per routine, ordered most-useful first. */
const ROUTINE_OPENERS: Record<ModelInput['routine'], readonly (readonly string[])[]> = {
  play: [
    ['i', 'want', 'game'],
    ['i', 'like', 'toy'],
    ['your-turn'],
    ['again'],
    ['look', 'ball'],
    ['i', 'want', 'blocks'],
    ['i', 'want', 'ball'],
    ['blocks', 'please'],
  ],
  food: [
    ['i', 'hungry'],
    ['drink', 'water'],
    ['i', 'want', 'snack'],
    ['i', 'like', 'fruit'],
    ['fruit', 'please'],
    ['i', 'thirsty'],
  ],
  school: [
    ['i', 'need', 'work'],
    ['i', 'need', 'teacher'],
    ['i', 'want', 'backpack'],
    ['i', 'need', 'notebook'],
    ['where', 'teacher'],
    ['break-time', 'please'],
    ['i', 'want', 'toilet'],
    ['quiet', 'please'],
  ],
  home: [
    ['i', 'tired'],
    ['i', 'want', 'bed'],
    ['i', 'want', 'dinner'],
    ['i', 'want', 'tv'],
    ['i', 'need', 'family'],
    ['read', 'story'],
    ['dinner', 'please'],
    ['tv', 'please'],
  ],
  outside: [
    ['go', 'park'],
    ['go', 'outside'],
    ['i', 'want', 'bike'],
    ['i', 'want', 'park'],
    ['look', 'animal'],
    ['look', 'bird'],
    ['i', 'hot'],
    ['bike', 'please'],
  ],
}

/** Nouns that make useful objects once the child has said want/need. */
const OBJECT_PREFERENCE: Record<ModelInput['routine'], readonly string[]> = {
  play: ['game', 'toy', 'blocks', 'ball', 'music', 'bike'],
  food: ['snack', 'water', 'fruit', 'milk', 'egg', 'pizza', 'ice-cream'],
  school: ['work', 'teacher', 'notebook', 'backpack', 'craft'],
  home: ['tv', 'bed', 'dinner', 'story', 'sofa'],
  outside: ['park', 'bike', 'bird', 'animal', 'bus', 'garden'],
}

/** Verbs that can follow a bare pronoun opening ("I …"). */
const FOLLOW_PRONOUN_VERBS = ['want', 'need', 'like', 'feel', 'go', 'look'] as const

const FEELING_WORDS = [
  'happy',
  'sad',
  'angry',
  'tired',
  'scared',
  'hungry',
  'thirsty',
  'calm',
  'worried',
  'proud',
] as const

const PLACE_WORDS = ['park', 'outside', 'home', 'school'] as const
const VIEWABLE_WORDS = ['bird', 'that', 'game', 'ball', 'animal'] as const
const ACTION_VERBS = ['go', 'look', 'eat', 'drink', 'play', 'read', 'walk'] as const
const EATABLE_WORDS = ['snack', 'fruit', 'egg', 'pizza', 'ice-cream'] as const
const DRINKABLE_WORDS = ['water', 'milk'] as const

function messageKeyOf(ids: readonly string[]): string {
  return ids.join(' ')
}

/** Polite tails usable after nearly any authored message. */
const POLITE_TAILS: readonly (readonly string[])[] = [['please'], ['thanks'], ['again']]

function tokensFor(ids: readonly string[], personalLabels?: Record<string, string>): SuggestionToken[] | null {
  const tokens: SuggestionToken[] = []
  const seen = new Set<string>()
  for (const id of ids) {
    if (seen.has(id)) return null
    seen.add(id)
    const label = getVocabLabel(id) ?? personalLabels?.[id]
    if (!label) return null
    tokens.push({ id, label })
  }
  return tokens
}

function pushCandidate(
  out: string[],
  seenKeys: Set<string>,
  ids: readonly string[],
  personalLabels?: Record<string, string>,
): void {
  const key = ids.join(' ')
  if (key.length === 0 || seenKeys.has(key)) return
  if (!passesSuggestionQualityGate(ids)) return
  if (!tokensFor(ids, personalLabels)) return
  seenKeys.add(key)
  out.push(key)
}

/**
 * Builds the ranked-choice candidate pool for one model input:
 *
 * - empty message → full natural opener phrases for this routine/age/interests;
 * - authored message → useful suffix continuations (objects after want/need,
 *   verbs after pronouns, polite tails), never repeating the child's last word.
 *
 * Every candidate is filtered through vocabulary existence, the quality gate
 * and duplicate detection BEFORE IDs are assigned, so IDs map 1:1 to rows the
 * child may legitimately see.
 */
export function buildCandidatePool(input: ModelInput): CandidatePool {
  const allow = new Set(input.allowlist)
  const personalLabels = input.tokenLabels
  const available = (id: string): boolean =>
    allow.has(id) && (Boolean(getVocabLabel(id)) || Boolean(personalLabels?.[id]))
  const firstAvailable = (ids: readonly string[]): boolean => Boolean(ids[0] && available(ids[0]))

  const keys: string[] = []
  const seenKeys = new Set<string>()

  if (input.currentTokenIds.length === 0) {
    // ---- Full-phrase mode -------------------------------------------------
    // The child's own classified favourites lead the pool as complete,
    // natural phrases ("I want Apple") before generic routine openers.
    if (personalLabels) {
      const personalIds = Object.keys(personalLabels)
      for (const id of personalIds.slice(0, 2)) {
        pushCandidate(keys, seenKeys, ['i', 'want', id], personalLabels)
      }
    }
    for (const row of ROUTINE_OPENERS[input.routine]) {
      if (row.every(available)) pushCandidate(keys, seenKeys, row)
    }
    // Generic sentence starters remain available through the deterministic
    // instant backup. Keep the model's ranked pool routine-specific so its
    // contribution is visibly contextual rather than another generic row.
    // Sparse boards (Large density, youngest bands) keep real choice through
    // single meaningful routine words — natural one-word AAC utterances.
    // Only words VISIBLE to this child may enter the pool.
    if (keys.length < 4) {
      for (const id of OBJECT_PREFERENCE[input.routine]) {
        if (keys.length >= 6) break
        if (!available(id)) continue
        pushCandidate(keys, seenKeys, [id], personalLabels)
      }
    }
  } else {
    // ---- Continuation mode -----------------------------------------------
    const last = input.currentTokenIds[input.currentTokenIds.length - 1]
    const messageKey = messageKeyOf(input.currentTokenIds)

    /**
     * Suffix pools are CONTEXT-SPECIFIC: what may follow "I want" must not
     * follow "I feel". Every candidate is validated on the COMBINED
     * authored-message-plus-suffix sequence, so seams stay natural too.
     */
    const addSuffixes = (suffixes: Iterable<readonly string[]>) => {
      for (const suffix of suffixes) {
        if (!firstAvailable(suffix)) continue
        if (suffix[0] === last) continue // no repeated word at the seam
        const combined = [...input.currentTokenIds, ...suffix]
        if (hasRepeatedTokens(combined)) continue
        if (!passesSuggestionQualityGate(combined)) continue
        const key = suffix.join(' ')
        if (key.length === 0 || seenKeys.has(key)) continue
        if (messageKey.endsWith(key)) continue // never parrot the authored tail
        if (!tokensFor(suffix, personalLabels)) continue
        seenKeys.add(key)
        keys.push(key)
      }
    }

    const objectsFor = (routine: ModelInput['routine']) => OBJECT_PREFERENCE[routine].map((id) => [id])

    if (last === 'want' || last === 'need' || last === 'like') {
      addSuffixes(objectsFor(input.routine))
    } else if (last === 'feel') {
      addSuffixes(FEELING_WORDS.map((id) => [id]))
    } else if (last === 'go') {
      addSuffixes(PLACE_WORDS.map((id) => [id]))
    } else if (last === 'look') {
      addSuffixes(VIEWABLE_WORDS.map((id) => [id]))
    } else if (last === 'read') {
      addSuffixes([['story'], ['notebook']])
    } else if (last === 'eat') {
      addSuffixes(EATABLE_WORDS.map((id) => [id]))
    } else if (last === 'drink') {
      addSuffixes(DRINKABLE_WORDS.map((id) => [id]))
    } else if (last === 'i' && messageKey === 'i') {
      addSuffixes(FOLLOW_PRONOUN_VERBS.map((id) => [id]))
    } else if (last === 'you' && messageKey === 'you') {
      addSuffixes(['look', 'want'].map((id) => [id]))
    } else if (last === 'we' && messageKey === 'we') {
      addSuffixes(['go'].map((id) => [id]))
    } else if (
      input.currentTokenIds.length === 2 &&
      input.currentTokenIds[0] === 'can' &&
      last === 'i'
    ) {
      addSuffixes(ACTION_VERBS.map((id) => [id]))
    } else {
      // Complete thought so far: polite tails are almost always useful.
      addSuffixes(POLITE_TAILS)
    }
  }

  const candidates: PhraseCandidate[] = []
  const byId = new Map<string, PhraseCandidate>()
  for (const key of keys.slice(0, 24)) {
    const id = `c${candidates.length + 1}`
    const tokens = tokensFor(key.split(' '), personalLabels)
    if (!tokens) continue
    const candidate: PhraseCandidate = { id, tokens }
    candidates.push(candidate)
    byId.set(id, candidate)
  }

  return { candidates, byId }
}

export interface ChosenParseResult {
  chosen: PhraseCandidate[]
  rejectedUnknownIds: string[]
}

/**
 * Maps raw model output (`{"chosen":["c3","c1"]}`) back onto pool entries.
 * Unknown IDs, duplicates and over-length answers are dropped; anything left
 * is exactly the bounded phrase text — no free-token composition exists.
 */
export function parseChosenCandidates(raw: unknown, pool: CandidatePool): ChosenParseResult {
  const rejectedUnknownIds: string[] = []
  if (!raw || typeof raw !== 'object') return { chosen: [], rejectedUnknownIds }
  const record = raw as { chosen?: unknown }
  if (!Array.isArray(record.chosen)) return { chosen: [], rejectedUnknownIds }

  const chosen: PhraseCandidate[] = []
  const picked = new Set<string>()
  for (const item of record.chosen) {
    if (chosen.length >= MAX_SUGGESTIONS) break
    if (typeof item !== 'string') continue
    const candidate = pool.byId.get(item.trim())
    if (!candidate) {
      rejectedUnknownIds.push(item)
      continue
    }
    if (picked.has(candidate.id)) continue
    picked.add(candidate.id)
    chosen.push(candidate)
  }
  return { chosen, rejectedUnknownIds }
}
