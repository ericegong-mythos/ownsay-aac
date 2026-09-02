import type { VocabEntry } from './types'

export const PROTECTED_CORE_IDS = [
  'no',
  'stop',
  'help',
  'hurts',
  'break',
  'yes',
  'more',
  'finished',
] as const

export type ProtectedCoreId = (typeof PROTECTED_CORE_IDS)[number]

export const PROTECTED_CORE_SET: ReadonlySet<string> = new Set(PROTECTED_CORE_IDS)

export const PROTECTED_CORE_ENTRIES: readonly VocabEntry[] = [
  {
    id: 'no',
    label: 'No',
    category: 'safety',
    icon: 'ban',
    functions: ['reject'],
    protected: true,
    complexity: 'early',
  },
  {
    id: 'stop',
    label: 'Stop',
    category: 'safety',
    icon: 'octagon',
    functions: ['reject'],
    protected: true,
    complexity: 'early',
  },
  {
    id: 'help',
    label: 'Help',
    category: 'safety',
    icon: 'lifebuoy',
    functions: ['request', 'repair'],
    protected: true,
    complexity: 'early',
  },
  {
    id: 'hurts',
    label: 'Hurts',
    category: 'safety',
    icon: 'heart-crack',
    functions: ['feeling', 'body'],
    protected: true,
    complexity: 'early',
  },
  {
    id: 'break',
    label: 'Break',
    category: 'safety',
    icon: 'pause',
    functions: ['reject', 'request'],
    protected: true,
    complexity: 'early',
  },
  {
    id: 'yes',
    label: 'Yes',
    category: 'safety',
    icon: 'check',
    functions: ['comment'],
    protected: true,
    complexity: 'early',
  },
  {
    id: 'more',
    label: 'More',
    category: 'safety',
    icon: 'plus',
    functions: ['request'],
    protected: true,
    complexity: 'early',
  },
  {
    id: 'finished',
    label: 'Finished',
    category: 'safety',
    icon: 'circle-check',
    functions: ['comment', 'reject'],
    protected: true,
    complexity: 'early',
  },
] as const

export function isProtectedTokenId(id: string): boolean {
  return PROTECTED_CORE_SET.has(id)
}

export function getProtectedCore(): VocabEntry[] {
  return PROTECTED_CORE_ENTRIES.map((entry) => ({ ...entry }))
}

export function assertProtectedCoreOrder(ids: readonly string[]): boolean {
  if (ids.length !== PROTECTED_CORE_IDS.length) return false
  return PROTECTED_CORE_IDS.every((id, index) => ids[index] === id)
}
