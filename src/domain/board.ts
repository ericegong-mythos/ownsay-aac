import { getProtectedCore, PROTECTED_CORE_IDS, PROTECTED_CORE_ENTRIES } from './protected-core'
import type { AgeBand, BoardSelection, Complexity, DemoPreferences, ExtraWord, VocabEntry } from './types'
import type { Routine } from './types'
import { VOCABULARY } from './vocabulary'

export const EXTRA_WORD_PREFIX = 'extra:'
const EXTRA_WORD_LIMIT = 12

/** Board-facing ID for a carer-managed extra word. */
export function extraWordId(wordId: string): string {
  return `${EXTRA_WORD_PREFIX}${wordId}`
}

/** Case-insensitive display-label key used for all label collision checks. */
function labelKey(label: string): string {
  return label.trim().toLowerCase()
}

const PROTECTED_LABEL_KEYS = new Set(PROTECTED_CORE_ENTRIES.map((entry) => labelKey(entry.label)))

/**
 * Validates carer-managed words against the stored contract: bounded count,
 * no duplicate labels, never a protected-core label. Returns the clean prefix
 * so nothing is silently truncated beyond the documented limit.
 */
export function validPersonalWords(extraWords: readonly ExtraWord[]): ExtraWord[] {
  const seen = new Set<string>()
  const out: ExtraWord[] = []
  for (const word of extraWords) {
    if (out.length >= EXTRA_WORD_LIMIT) break
    const key = labelKey(word.label)
    if (!key || seen.has(key) || PROTECTED_LABEL_KEYS.has(key)) continue
    seen.add(key)
    out.push(word)
  }
  return out
}

/**
 * Carer-managed non-core words become ordinary fringe tiles. A word tagged
 * with the active routine joins that routine's right-now zone; untagged words
 * join the anytime zone. They never enter the protected core or the model's
 * own catalogue allowlist; only this mapping turns them into tiles.
 */
export function extraWordEntries(extraWords: readonly ExtraWord[]): VocabEntry[] {
  return extraWords.map((word) => ({
    id: extraWordId(word.id),
    label: word.label,
    category: 'routine' as const,
    icon: word.icon ?? 'circle-dot',
    functions: ['comment'] as const,
    complexity: 'early' as const,
    ...(word.routine ? { routines: [word.routine] } : {}),
    personalTone: word.tone ?? 'context',
  }))
}

const DENSITY_LIMITS: Record<DemoPreferences['accessDensity'], number> = {
  large: 10,
  standard: 20,
  more: 36,
}

/**
 * How many fringe slots each density reserves for routine-relevant ("right
 * now") words. The remainder goes to universal sentence-building words.
 * Guarantees are tested in src/domain/board.test.ts.
 */
export const CONTEXT_QUOTA: Record<DemoPreferences['accessDensity'], number> = {
  large: 5,
  standard: 10,
  more: 15,
}

/** Context slots held for the child's selected interests, when available. */
const INTEREST_RESERVE: Record<DemoPreferences['accessDensity'], number> = {
  large: 1,
  standard: 2,
  more: 3,
}

/**
 * Minimum contextual slots that must survive at each density whenever the
 * routine's own vocabulary can supply them (it always can; every routine has
 * at least ten tagged entries). Tested per routine and age band.
 */
export const MIN_CONTEXT_SLOTS: Record<DemoPreferences['accessDensity'], number> = {
  large: 4,
  standard: 8,
  more: 12,
}

/**
 * Curated lead order for each routine world: the words a child is most likely
 * to need first in that context. Entries not listed here follow alphabetically
 * after the curated ones — curation, never incidental sort order, decides what
 * a child sees first.
 */
const ROUTINE_CONTEXT_ORDER: Record<Routine, readonly string[]> = {
  play: [
    'play',
    'game',
    'toy',
    'blocks',
    'turn',
    'your-turn',
    'hide-seek',
    'ball',
    'friend',
    'video-game',
    'fun',
    'bike',
    'outside',
    'again',
  ],
  food: [
    'eat',
    'drink',
    'hungry',
    'thirsty',
    'snack',
    'water',
    'fruit',
    'milk',
    'egg',
    'pizza',
    'sweet',
    'ice-cream',
    'tastes',
    'dinner',
  ],
  school: [
    'teacher',
    'work',
    'read',
    'write',
    'break-time',
    'backpack',
    'notebook',
    'bell',
    'craft',
    'turn',
    'your-turn',
    'quiet',
    'toilet',
    'friend',
    'school',
  ],
  home: [
    'family',
    'home',
    'bed',
    'tv',
    'dinner',
    'sofa',
    'wash',
    'shower',
    'read',
    'quiet',
    'toilet',
    'garden',
  ],
  outside: [
    'outside',
    'park',
    'walk',
    'bike',
    'sunny',
    'rain',
    'windy',
    'weather',
    'bird',
    'animal',
    'bus',
    'garden',
    'rabbit',
    'ball',
  ],
}

/**
 * Universal sentence-building words, in curated power order. These are stable
 * across routines so children keep a constant grammar scaffold; they only ever
 * fill slots after the routine's "right now" words have claimed theirs.
 */
const UNIVERSAL_ORDER: readonly string[] = [
  'i',
  'you',
  'want',
  'need',
  'like',
  'dont-like',
  'feel',
  'go',
  'look',
  'this',
  'that',
  'please',
  'what',
  'where',
  'can',
  'again',
  'wait',
  'we',
  'happy',
  'sad',
  'angry',
  'tired',
  'scared',
  'hot',
  'cold',
  'big',
  'little',
  'good',
  'bad',
  'not',
  'and',
  'to',
  'who',
  'why',
  'when',
  'different',
  'same',
  'thanks',
  'friend',
  'family',
  'grown-up',
  'head',
  'tummy',
  'ear',
  'too-loud',
  'too-bright',
  'calm',
  'worried',
  'proud',
  'later',
  'because',
  'choice',
  'explain',
  'say-again',
  'try',
  'privacy',
  'unfair',
  'confused',
  'boring',
]

function allowedComplexities(ageBand: AgeBand): ReadonlySet<Complexity> {
  if (ageBand === '4-6') return new Set(['early', 'mid'])
  if (ageBand === '7-9') return new Set(['early', 'mid'])
  return new Set(['early', 'mid', 'later'])
}

/**
 * Words the oldest band is ready for. They stay out of younger boards
 * entirely, and for 10–12 they are promoted just past the grammar scaffold so
 * they are actually reachable at More density instead of rotting at the tail.
 */
const OLDER_BAND_PROMOTIONS: readonly string[] = [
  'why',
  'when',
  'because',
  'proud',
  'unfair',
  'confused',
  'boring',
  'privacy',
  'choice',
  'explain',
]

const SCAFFOLD_HEAD = 17 // UNIVERSAL_ORDER entries through 'wait'

const universalOrderCache = new Map<AgeBand, readonly string[]>()

function effectiveUniversalOrder(ageBand: AgeBand): readonly string[] {
  const cached = universalOrderCache.get(ageBand)
  if (cached) return cached
  let order: readonly string[]
  if (ageBand === '10-12') {
    const head = UNIVERSAL_ORDER.slice(0, SCAFFOLD_HEAD)
    const rest = UNIVERSAL_ORDER.slice(SCAFFOLD_HEAD)
    const promoted = OLDER_BAND_PROMOTIONS.filter((id) => !head.includes(id))
    order = [...head, ...promoted, ...rest.filter((id) => !promoted.includes(id))]
  } else {
    order = UNIVERSAL_ORDER
  }
  universalOrderCache.set(ageBand, order)
  return order
}

function matchesFringe(entry: VocabEntry, prefs: DemoPreferences): boolean {
  if (entry.protected) return false
  if (!allowedComplexities(prefs.ageBand).has(entry.complexity)) return false

  const routineHit = !entry.routines || entry.routines.includes(prefs.routine)
  const interestHit = !entry.interests || entry.interests.some((item) => prefs.interests.includes(item))

  if (entry.routines && entry.interests) return routineHit || interestHit
  if (entry.routines) return routineHit
  if (entry.interests) return interestHit
  return true
}

/** True when this fringe word belongs to the selected routine or the child's interests. */
export function isContextualFringe(
  entry: VocabEntry,
  prefs: Pick<DemoPreferences, 'routine' | 'interests'>,
): boolean {
  if (entry.routines?.includes(prefs.routine)) return true
  return Boolean(entry.interests?.some((item) => prefs.interests.includes(item)))
}

function complexityRank(entry: VocabEntry, ageBand: AgeBand): number {
  // For our youngest profile the simplest words always lead their group.
  if (ageBand === '4-6') return entry.complexity === 'early' ? 0 : 1
  return 0
}

function contextComparator(a: VocabEntry, b: VocabEntry, prefs: DemoPreferences): number {
  const order = ROUTINE_CONTEXT_ORDER[prefs.routine]
  const rankA = complexityRank(a, prefs.ageBand)
  const rankB = complexityRank(b, prefs.ageBand)
  if (rankA !== rankB) return rankA - rankB

  const curatedA = order.indexOf(a.id)
  const curatedB = order.indexOf(b.id)
  const posA = curatedA === -1 ? Number.MAX_SAFE_INTEGER : curatedA
  const posB = curatedB === -1 ? Number.MAX_SAFE_INTEGER : curatedB
  if (posA !== posB) return posA - posB

  // Personal-interest words follow the curated routine leads.
  const tagA = a.routines?.includes(prefs.routine) ? 0 : 1
  const tagB = b.routines?.includes(prefs.routine) ? 0 : 1
  if (tagA !== tagB) return tagA - tagB

  return a.label.localeCompare(b.label)
}

function universalComparator(a: VocabEntry, b: VocabEntry, prefs: DemoPreferences): number {
  const rankA = complexityRank(a, prefs.ageBand)
  const rankB = complexityRank(b, prefs.ageBand)
  if (rankA !== rankB) return rankA - rankB
  const order = effectiveUniversalOrder(prefs.ageBand)
  const posA = order.indexOf(a.id)
  const posB = order.indexOf(b.id)
  const normA = posA === -1 ? Number.MAX_SAFE_INTEGER : posA
  const normB = posB === -1 ? Number.MAX_SAFE_INTEGER : posB
  if (normA !== normB) return normA - normB
  return a.label.localeCompare(b.label)
}

export function selectBoard(
  prefs: DemoPreferences,
  personalWords: readonly ExtraWord[] = [],
  catalog: readonly VocabEntry[] = VOCABULARY,
): BoardSelection {
  const core = getProtectedCore()
  const limit = DENSITY_LIMITS[prefs.accessDensity]
  const quota = Math.min(CONTEXT_QUOTA[prefs.accessDensity], limit)

  const candidates = catalog.filter((entry) => matchesFringe(entry, prefs))
  const contextPool = candidates.filter((entry) => isContextualFringe(entry, prefs))
  const universalPool = candidates.filter((entry) => !isContextualFringe(entry, prefs))

  const sortedContext = [...contextPool].sort((a, b) => contextComparator(a, b, prefs))
  const interestMatches = sortedContext.filter((entry) =>
    entry.interests?.some((interest) => prefs.interests.includes(interest)),
  )
  const reservedInterests = interestMatches.slice(0, INTEREST_RESERVE[prefs.accessDensity])
  const reservedIds = new Set(reservedInterests.map((entry) => entry.id))
  const contextualLeads = sortedContext
    .filter((entry) => !reservedIds.has(entry.id))
    .slice(0, quota - reservedInterests.length)
  // Routine leads remain first for motor stability; selected-interest words
  // are nevertheless guaranteed a visible place instead of being crowded out.
  let context: VocabEntry[] = [...contextualLeads, ...reservedInterests]
  let universal = [...universalPool].sort((a, b) => universalComparator(a, b, prefs))

  const personal = validPersonalWords(personalWords)
  if (personal.length > 0) {
    const composed = composePersonalBoard({
      prefs,
      limit,
      quota,
      catalogCandidates: [...contextPool, ...universalPool],
      baseContext: context,
      baseUniversal: universal,
      personal,
    })
    context = composed.context
    universal = composed.universal
  }

  const remainingSlots = Math.max(0, limit - context.length)
  universal = universal.slice(0, remainingSlots)

  const fringe = [...context, ...universal].map((entry) => ({ ...entry }))
  return { core, fringe }
}

interface PersonalCompositionInput {
  prefs: DemoPreferences
  limit: number
  quota: number
  /** Every catalogue entry that matches this profile/routine (both zones). */
  catalogCandidates: readonly VocabEntry[]
  /** The quota-shaped catalogue context zone before personalisation. */
  baseContext: readonly VocabEntry[]
  /** The ordered catalogue universal pool before slicing to the limit. */
  baseUniversal: readonly VocabEntry[]
  personal: readonly ExtraWord[]
}

interface PersonalComposition {
  context: VocabEntry[]
  universal: VocabEntry[]
}

/** How many anytime slots may be reserved for untagged personal words. */
const ANYTIME_PERSONAL_RESERVE: Record<DemoPreferences['accessDensity'], number> = {
  large: 3,
  standard: 5,
  more: 6,
}

/**
 * Layers the child's own words into the board WITHOUT growing it:
 *
 * - a personal word never duplicates the protected core or another personal
 *   word (guarded in validPersonalWords);
 * - when a personal label matches an existing catalogue tile for this
 *   profile/routine, the CATALOGUE token is preferred and promoted into the
 *   first contextual row — no `extra:` duplicate is created;
 * - routine-tagged personal words join that same first contextual row,
 *   interleaved with essential action/need language;
 * - untagged personal words take a bounded number of reserved anytime slots;
 * - every personal slot comes out of the existing density quota, so the
 *   total board size never exceeds the selected density.
 */
function composePersonalBoard(input: PersonalCompositionInput): PersonalComposition {
  const { prefs, limit, quota, catalogCandidates, baseContext, baseUniversal, personal } = input

  const byLabel = new Map(catalogCandidates.map((entry) => [labelKey(entry.label), entry]))
  const promotedEntries: VocabEntry[] = []
  const promotedIds = new Set<string>()
  const taggedPersonal: VocabEntry[] = []
  const untaggedPersonal: VocabEntry[] = []

  for (const word of extraWordEntries(personal)) {
    const catalogueMatch = byLabel.get(labelKey(word.label))
    if (catalogueMatch && !promotedIds.has(catalogueMatch.id)) {
      // Prefer the existing catalogue token over an `extra:` duplicate.
      promotedEntries.push({ ...catalogueMatch })
      promotedIds.add(catalogueMatch.id)
      continue
    }
    if (word.routines) {
      if (word.routines.includes(prefs.routine)) taggedPersonal.push(word)
      // Words tagged for another routine surface when that routine is active.
      continue
    }
    untaggedPersonal.push(word)
  }

  // Favourites lead: promotions keep their stable stored order, then tagged
  // personal words follow in carer-managed order. EVERY supplied favourite
  // must be reachable: favourites claim up to quota − MIN_ESSENTIAL_SLOTS
  // context slots before essentials fill the rest.
  const favourites = [...promotedEntries, ...taggedPersonal]
  const favouriteIds = new Set(favourites.map((entry) => entry.id))

  const MIN_ESSENTIAL_SLOTS = 3
  const essentials = baseContext.filter((entry) => !favouriteIds.has(entry.id))
  const maxFavourites = Math.min(favourites.length, Math.max(0, quota - MIN_ESSENTIAL_SLOTS))
  const context: VocabEntry[] = []
  let e = 0
  let f = 0
  while (context.length < quota) {
    // First four slots alternate essential/favourite (a familiar, functional
    // opening row). After that, remaining favourites outrank further
    // essentials up to the favourites ceiling so no supplied word is left
    // unreachable at the default densities.
    const inFirstRow = context.length < 4
    const wantEssential =
      e < essentials.length &&
      (inFirstRow
        ? context.length % 2 === 0 || f >= favourites.length
        : f >= maxFavourites)
    if (wantEssential) {
      context.push(essentials[e])
      e += 1
    } else if (f < favourites.length && f < maxFavourites) {
      context.push(favourites[f])
      f += 1
    } else if (e < essentials.length) {
      context.push(essentials[e])
      e += 1
    } else if (f < favourites.length) {
      // Favourites beyond the ceiling may fill leftover slots only after the
      // essential minimum is satisfied.
      context.push(favourites[f])
      f += 1
    } else {
      break
    }
  }

  // Anytime zone: the grammar scaffold keeps its lead (at least the first
  // four scaffold words always survive), and a bounded number of untagged
  // personal words take reserved slots inside what remains.
  const universalCatalog = baseUniversal.filter((entry) => !promotedIds.has(entry.id))
  const remainingAfterContext = Math.max(0, limit - context.length)
  const MIN_SCAFFOLD = 4
  const reserve = Math.min(
    untaggedPersonal.length,
    ANYTIME_PERSONAL_RESERVE[prefs.accessDensity],
    Math.max(0, remainingAfterContext - MIN_SCAFFOLD),
  )
  const universal = [
    ...universalCatalog.slice(0, Math.max(0, remainingAfterContext - reserve)),
    ...untaggedPersonal.slice(0, reserve),
  ]

  return { context, universal }
}

/**
 * The personalised suggestion candidates for one profile/routine: favourite
 * words that are actually visible on the composed board, resolved to stable
 * tokens. Context-tone words (aversions, difficult contexts) never appear.
 */
export function personalFavouriteTokens(
  prefs: DemoPreferences,
  personalWords: readonly ExtraWord[],
  options: { catalog?: readonly VocabEntry[]; visibleBoard?: BoardSelection } = {},
): Array<{ id: string; label: string }> {
  const valid = validPersonalWords(personalWords)
  if (valid.length === 0) return []
  const catalog = options.catalog ?? VOCABULARY

  const candidates = catalog.filter((entry) => matchesFringe(entry, prefs))
  const byLabel = new Map(candidates.map((entry) => [labelKey(entry.label), entry]))
  // When the composed board is supplied, only favourites that are ACTUALLY
  // reachable on it may become candidates — never a stored-but-hidden word.
  const visibleIds = options.visibleBoard
    ? new Set([...options.visibleBoard.core, ...options.visibleBoard.fringe].map((entry) => entry.id))
    : null
  const tokens: Array<{ id: string; label: string }> = []
  for (const word of valid) {
    // Conservative default: unclassified carer words are context-only.
    if (word.tone !== 'favourite') continue
    const catalogueMatch = byLabel.get(labelKey(word.label))
    if (catalogueMatch) {
      if (!visibleIds || visibleIds.has(catalogueMatch.id)) {
        tokens.push({ id: catalogueMatch.id, label: catalogueMatch.label })
      }
      continue
    }
    if (word.routine && word.routine !== prefs.routine) continue
    const id = extraWordId(word.id)
    if (!visibleIds || visibleIds.has(id)) {
      tokens.push({ id, label: word.label })
    }
  }
  // Bound the candidate set; stability beats breadth here.
  return tokens.slice(0, 6)
}

export function boardContainsProtectedOrder(board: BoardSelection): boolean {
  return (
    board.core.length === PROTECTED_CORE_IDS.length &&
    board.core.every((entry, index) => entry.id === PROTECTED_CORE_IDS[index])
  )
}
