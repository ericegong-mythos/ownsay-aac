export const AGE_BANDS = ['4-6', '7-9', '10-12'] as const
export type AgeBand = (typeof AGE_BANDS)[number]

export const ACCESS_DENSITIES = ['large', 'standard', 'more'] as const
export type AccessDensity = (typeof ACCESS_DENSITIES)[number]

export const ROUTINES = ['play', 'food', 'school', 'home', 'outside'] as const
export type Routine = (typeof ROUTINES)[number]

export const INTERESTS = [
  'animals',
  'vehicles',
  'music',
  'sport',
  'art',
  'stories',
  'outdoors',
  'food',
] as const
export type Interest = (typeof INTERESTS)[number]

export const COMMUNICATIVE_FUNCTIONS = [
  'reject',
  'request',
  'ask',
  'comment',
  'repair',
  'feeling',
  'body',
  'people',
  'place',
  'action',
  'describe',
] as const
export type CommunicativeFunction = (typeof COMMUNICATIVE_FUNCTIONS)[number]

export const TOKEN_CATEGORIES = [
  'safety',
  'core',
  'feeling',
  'body',
  'people',
  'place',
  'action',
  'describe',
  'ask',
  'routine',
] as const
export type TokenCategory = (typeof TOKEN_CATEGORIES)[number]

export type Provenance = 'core' | 'fringe' | 'suggestion'

export type HelperStatus = 'off' | 'downloading' | 'ready' | 'degraded' | 'unavailable' | 'unsupported'

export type SuggestionSource = 'deterministic' | 'local-model'

export type Complexity = 'early' | 'mid' | 'later'

export interface VocabEntry {
  id: string
  label: string
  category: TokenCategory
  icon: string
  functions: CommunicativeFunction[]
  protected?: boolean
  complexity: Complexity
  routines?: Routine[]
  interests?: Interest[]
  /**
   * Present only on carer-managed personal tiles: `context` words are never
   * eligible for any suggestion row, deterministic or model-ranked.
   */
  personalTone?: 'favourite' | 'context'
}

export interface AuthoredToken {
  instanceId: string
  tokenId: string
  label: string
  provenance: Provenance
  category: TokenCategory
}

export interface SuggestionToken {
  id: string
  label: string
}

export interface Suggestion {
  id: string
  tokens: SuggestionToken[]
  source: SuggestionSource
}

export interface DemoPreferences {
  ageBand: AgeBand
  accessDensity: AccessDensity
  routine: Routine
  interests: Interest[]
  helperEnabled: boolean
}

/**
 * One carer-managed non-core word. Words tagged with a routine join that
 * routine's right-now zone; untagged words stay in the anytime zone. They
 * always occupy bounded slots inside the selected density.
 */
export interface ExtraWord {
  id: string
  label: string
  routine?: Routine
  /** Optional icon id; must exist in the icon registry (validated on save). */
  icon?: string
  /**
   * `favourite` words may seed personalised suggestion candidates;
   * `context` words (aversions, difficult contexts) never do. Absent means
   * the carer added this word without classifying it, and it is treated
   * conservatively as context-only.
   */
  tone?: 'favourite' | 'context'
}

/** A device-local profile; speech can use only a browser-verified local voice. */
export interface ChildProfile extends DemoPreferences {
  id: string
  nickname: string
  createdAt: string
  /** Preference URI; honoured only while it resolves to a verified-local voice. */
  voiceURI?: string
  extraWords: ExtraWord[]
  /**
   * Carer toggle for the brief silent welcome when this child is deliberately
   * chosen. Fictional demo profiles default it on; other profiles opt in.
   */
  welcomeCelebration: boolean
  /** Original sprite keys for this child's welcome moment (never branded art). */
  welcomeSprites?: string[]
  /**
   * Stable demo identity, independent of the editable nickname, so a renamed
   * example can never be duplicated by a restore.
   */
  starterKey?: 'alex' | 'sam'
}

export interface EventLogEntry {
  id: string
  timestamp: string
  tileId?: string
  mode: 'child' | 'carer'
  status: string
}

export interface BoardSelection {
  core: VocabEntry[]
  fringe: VocabEntry[]
}

export const DEFAULT_PREFERENCES: DemoPreferences = {
  ageBand: '7-9',
  accessDensity: 'standard',
  routine: 'play',
  interests: ['animals', 'stories'],
  helperEnabled: false,
}

export const ACCESS_DENSITY_LABELS: Record<AccessDensity, string> = {
  large: 'Large',
  standard: 'Standard',
  more: 'More words',
}

export const ROUTINE_LABELS: Record<Routine, string> = {
  play: 'Play',
  food: 'Food',
  school: 'School',
  home: 'Home',
  outside: 'Outside',
}

/** Per-routine identity: Lucide icon id (see src/icons/registry.ts), short cue line and spoken-style world name. */
export const ROUTINE_META: Record<
  Routine,
  { icon: string; cue: string; world: string; accentVar: string }
> = {
  play: { icon: 'puzzle', cue: 'Games, toys and taking turns', world: 'Playtime', accentVar: '--routine-play' },
  food: { icon: 'utensils', cue: 'Eating, drinking and trying tastes', world: 'Meals & snacks', accentVar: '--routine-food' },
  school: { icon: 'graduation-cap', cue: 'Class work, asks and breaks', world: 'School day', accentVar: '--routine-school' },
  home: { icon: 'house', cue: 'Family, resting and home things', world: 'At home', accentVar: '--routine-home' },
  outside: { icon: 'trees', cue: 'Parks, weather and going places', world: 'Out & about', accentVar: '--routine-outside' },
}

export const INTEREST_LABELS: Record<Interest, string> = {
  animals: 'Animals',
  vehicles: 'Vehicles',
  music: 'Music',
  sport: 'Sport',
  art: 'Art',
  stories: 'Stories',
  outdoors: 'Outdoors',
  food: 'Food',
}

export const AGE_BAND_LABELS: Record<AgeBand, string> = {
  '4-6': '4–6',
  '7-9': '7–9',
  '10-12': '10–12',
}
