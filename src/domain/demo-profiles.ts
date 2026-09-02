import type { AccessDensity, AgeBand, ChildProfile, Interest, Routine } from './types'
import { createId } from '../lib/id'

/**
 * Fictional demo profiles for fresh installs and carer restore. Everything
 * becomes ordinary, editable local profile data on the device. These examples
 * demonstrate profile isolation without representing any real child.
 */
export const DEMO_PROFILE_KEYS = ['alex', 'sam'] as const
export type DemoProfileKey = (typeof DEMO_PROFILE_KEYS)[number]

export interface DemoExtraWord {
  label: string
  /** Routine whose right-now zone hosts the word; omit for the anytime zone. */
  routine?: Routine
  icon: string
  /** `favourite` words may seed suggestion candidates; `context` never do. */
  tone: 'favourite' | 'context'
  /** Stable identity that may be supplied independently of the visible label. */
  id?: string
}

export interface DemoProfileSpec {
  key: DemoProfileKey
  nickname: string
  ageBand: AgeBand
  accessDensity: AccessDensity
  routine: Routine
  interests: Interest[]
  extraWords: readonly DemoExtraWord[]
  /** Original, generic sprite keys for the welcome moment. */
  welcomeSprites: readonly string[]
  /** Short plain-language line for the fresh-install choice cards. */
  blurb: string
}

export const DEMO_PROFILES: Record<DemoProfileKey, DemoProfileSpec> = {
  alex: {
    key: 'alex',
    nickname: 'Alex',
    ageBand: '4-6',
    accessDensity: 'standard',
    routine: 'play',
    interests: ['vehicles', 'art', 'food'],
    extraWords: [
      { label: 'Apple', routine: 'food', icon: 'apple', tone: 'favourite' },
      { label: 'Sandwich', routine: 'food', icon: 'sandwich', tone: 'favourite' },
      { label: 'Building blocks', routine: 'play', icon: 'blocks', tone: 'favourite' },
      { label: 'Train', routine: 'play', icon: 'train-front', tone: 'favourite' },
      { label: 'Drawing', routine: 'play', icon: 'pencil', tone: 'favourite' },
      { label: 'Loud noise', icon: 'volume-2', tone: 'context' },
      { label: 'Different texture', icon: 'hand', tone: 'context' },
    ],
    welcomeSprites: ['apple', 'blocks', 'train', 'drawing'],
    blurb: 'Building, drawing and trains',
  },
  sam: {
    key: 'sam',
    nickname: 'Sam',
    ageBand: '4-6',
    accessDensity: 'standard',
    routine: 'food',
    interests: ['food', 'music', 'vehicles'],
    extraWords: [
      { label: 'Pasta', routine: 'food', icon: 'utensils', tone: 'favourite' },
      { label: 'Toast', routine: 'food', icon: 'sandwich', tone: 'favourite' },
      { label: 'Water', routine: 'food', icon: 'glass-water', tone: 'favourite' },
      { label: 'Crackers', routine: 'food', icon: 'cookie', tone: 'favourite' },
      { label: 'Bubbles', routine: 'play', icon: 'droplets', tone: 'favourite' },
      { label: 'Puzzle', routine: 'play', icon: 'puzzle', tone: 'favourite' },
      { label: 'Music', routine: 'play', icon: 'music', tone: 'favourite' },
      { label: 'Bike', routine: 'outside', icon: 'bike', tone: 'favourite' },
      { label: 'Not that', icon: 'circle-slash', tone: 'context' },
    ],
    welcomeSprites: ['toast', 'water', 'bubbles', 'puzzle'],
    blurb: 'Puzzles, music and outdoor play',
  },
}

export const DEMO_PROFILE_LIST: readonly DemoProfileSpec[] = [DEMO_PROFILES.alex, DEMO_PROFILES.sam]

function slug(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

/** Builds a normal local child profile from a fictional demo spec. */
export function createDemoProfile(spec: DemoProfileSpec): ChildProfile {
  return {
    id: createId('prf'),
    nickname: spec.nickname,
    createdAt: new Date().toISOString(),
    ageBand: spec.ageBand,
    accessDensity: spec.accessDensity,
    routine: spec.routine,
    interests: [...spec.interests],
    helperEnabled: false,
    welcomeCelebration: true,
    welcomeSprites: [...spec.welcomeSprites],
    starterKey: spec.key,
    extraWords: spec.extraWords.map((word) => ({
      id: word.id ?? `${spec.key}-${slug(word.label)}`,
      label: word.label,
      ...(word.routine ? { routine: word.routine } : {}),
      icon: word.icon,
      tone: word.tone,
    })),
  }
}

/** Return fictional starters not already present on this device. */
export function findMissingDemoProfiles(
  existing: readonly Pick<ChildProfile, 'nickname' | 'starterKey'>[],
): DemoProfileSpec[] {
  const keys = new Set(existing.map((profile) => profile.starterKey).filter(Boolean))
  const names = new Set(
    existing.filter((profile) => !profile.starterKey).map((profile) => profile.nickname.trim().toLowerCase()),
  )
  return DEMO_PROFILE_LIST.filter(
    (spec) => !keys.has(spec.key) && !(names.size > 0 && names.has(spec.nickname.toLowerCase())),
  )
}

/**
 * Deterministic display order: built-in examples first, followed by locally
 * created profiles in storage order. Renaming an example does not change its
 * position because ordering uses the stable starter key.
 */
export function orderProfilesForDisplay<T extends Pick<ChildProfile, 'starterKey'>>(
  profiles: readonly T[],
): T[] {
  const rank = (profile: T): number => {
    const index = DEMO_PROFILE_KEYS.indexOf(profile.starterKey as DemoProfileKey)
    return index === -1 ? DEMO_PROFILE_KEYS.length : index
  }
  return profiles
    .map((profile, index) => ({ profile, index }))
    .sort((a, b) => rank(a.profile) - rank(b.profile) || a.index - b.index)
    .map((row) => row.profile)
}
