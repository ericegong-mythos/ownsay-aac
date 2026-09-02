import { describe, expect, it } from 'vitest'
import { CONTEXT_QUOTA, MIN_CONTEXT_SLOTS, isContextualFringe, selectBoard } from './board'
import { boardContainsProtectedOrder } from './board'
import { PROTECTED_CORE_IDS } from './protected-core'
import { DEFAULT_PREFERENCES, ROUTINES, type DemoPreferences } from './types'
import { VOCABULARY } from './vocabulary'

const DENSITIES = ['large', 'standard', 'more'] as const
const AGE_BANDS = ['4-6', '7-9', '10-12'] as const

function prefsWith(overrides: Partial<DemoPreferences>): DemoPreferences {
  return { ...DEFAULT_PREFERENCES, ...overrides }
}

function routineTagged(prefs: DemoPreferences): string[] {
  return selectBoard(prefs)
    .fringe.filter((entry) => entry.routines?.includes(prefs.routine))
    .map((entry) => entry.id)
}

describe('routine worlds change the visible fringe', () => {
  it('produces a distinct contextual set for every routine at every density', () => {
    for (const ageBand of AGE_BANDS) {
      for (const accessDensity of DENSITIES) {
        const fringes = new Map(
          ROUTINES.map((routine) => [
            routine,
            routineTagged({ ...DEFAULT_PREFERENCES, ageBand, accessDensity, interests: [], routine }),
          ]),
        )
        for (const routine of ROUTINES) {
          const ids = fringes.get(routine) ?? []
          expect(
            ids.length,
            `${routine}/${accessDensity}/${ageBand} must expose routine-tagged words`,
          ).toBeGreaterThanOrEqual(MIN_CONTEXT_SLOTS[accessDensity])
        }
        // Every pair of routines must differ materially in what they surface.
        for (let a = 0; a < ROUTINES.length; a += 1) {
          for (let b = a + 1; b < ROUTINES.length; b += 1) {
            const setA = new Set(fringes.get(ROUTINES[a]) ?? [])
            const setB = new Set(fringes.get(ROUTINES[b]) ?? [])
            const shared = [...setB].filter((id) => setA.has(id)).length
            expect(
              shared,
              `${ROUTINES[a]} vs ${ROUTINES[b]} at ${accessDensity}/${ageBand} share too many context words`,
            ).toBeLessThan(Math.min(setA.size, setB.size))
            expect(setA.size > 0 || setB.size > 0).toBe(true)
          }
        }
      }
    }
  })

  it('reserves at least the guaranteed quota of right-now slots per density', () => {
    for (const routine of ROUTINES) {
      for (const accessDensity of DENSITIES) {
        const prefs = prefsWith({ routine, accessDensity })
        const board = selectBoard(prefs)
        expect(board.fringe.length).toBe(Math.min(DENSITY_LIMIT_FOR(accessDensity), VOCABULARY.length))
        const contextual = board.fringe.filter((entry) => isContextualFringe(entry, prefs))
        expect(contextual.length).toBeGreaterThanOrEqual(MIN_CONTEXT_SLOTS[accessDensity])
        expect(CONTEXT_QUOTA[accessDensity]).toBeGreaterThanOrEqual(MIN_CONTEXT_SLOTS[accessDensity])
      }
    }
  })

  it('never lets universal words crowd context out of the initial viewport', () => {
    for (const routine of ROUTINES) {
      const board = selectBoard(prefsWith({ routine, accessDensity: 'standard' }))
      const firstEight = board.fringe.slice(0, 8)
      const contextualLead = firstEight.filter((entry) => isContextualFringe(entry, prefsWith({ routine })))
      expect(contextualLead.length).toBeGreaterThanOrEqual(6)
    }
  })

  it('curates each world so its most useful words lead the board', () => {
    const leads = (routine: DemoPreferences['routine'], id: string) => {
      const board = selectBoard(prefsWith({ routine }))
      return board.fringe.slice(0, 6).some((entry) => entry.id === id)
    }
    expect(leads('play', 'game')).toBe(true)
    expect(leads('food', 'snack')).toBe(true)
    expect(leads('school', 'teacher')).toBe(true)
    expect(leads('home', 'family')).toBe(true)
    expect(leads('outside', 'park')).toBe(true)
  })
})

describe('access density broadens without hiding the world', () => {
  it('shows more fringe as density grows while keeping context guarantees', () => {
    for (const routine of ROUTINES) {
      const counts = DENSITIES.map((accessDensity) => selectBoard(prefsWith({ routine, accessDensity })).fringe.length)
      expect(counts[0]).toBeLessThan(counts[1])
      expect(counts[1]).toBeLessThan(counts[2])
      const large = selectBoard(prefsWith({ routine, accessDensity: 'large' }))
      const contextualLarge = large.fringe.filter((entry) => isContextualFringe(entry, prefsWith({ routine })))
      expect(contextualLarge.length, `large must still show ${routine} context`).toBeGreaterThanOrEqual(
        MIN_CONTEXT_SLOTS.large,
      )
    }
  })

  it('keeps universal grammar words available at every density', () => {
    for (const accessDensity of DENSITIES) {
      const board = selectBoard(prefsWith({ accessDensity, routine: 'school' }))
      const ids = new Set(board.fringe.map((entry) => entry.id))
      for (const scaffold of ['i', 'want', 'like']) {
        expect(ids.has(scaffold), `${scaffold} must survive at ${accessDensity}`).toBe(true)
      }
    }
  })

  it('reserves visible words for selected interests at every density', () => {
    for (const accessDensity of DENSITIES) {
      const vehicles = selectBoard(
        prefsWith({ routine: 'play', interests: ['vehicles'], accessDensity }),
      ).fringe.map((entry) => entry.id)
      const animals = selectBoard(
        prefsWith({ routine: 'school', interests: ['animals'], accessDensity }),
      ).fringe.map((entry) => entry.id)

      expect(
        vehicles.some((id) => ['bike', 'car', 'bus', 'train'].includes(id)),
        `vehicle interest must be visible at ${accessDensity}; got ${vehicles.join(', ')}`,
      ).toBe(true)
      expect(
        animals.some((id) => ['animal', 'dog', 'cat'].includes(id)),
        `animal interest must be visible at ${accessDensity}`,
      ).toBe(true)
    }
  })
})

describe('age band tunes abstraction, never function', () => {
  it('opens later-complexity words only to the oldest band', () => {
    const young = selectBoard(prefsWith({ ageBand: '4-6', accessDensity: 'more' })).fringe.map((entry) => entry.id)
    const mid = selectBoard(prefsWith({ ageBand: '7-9', accessDensity: 'more', interests: [] }))
    const oldest = selectBoard(prefsWith({ ageBand: '10-12', accessDensity: 'more', interests: [] }))
    expect(young).not.toContain('unfair')
    expect(mid.fringe.some((entry) => entry.complexity === 'later')).toBe(false)
    expect(oldest.fringe.some((entry) => entry.complexity === 'later')).toBe(true)
  })

  it('keeps the protected core identical across every band, density and routine', () => {
    for (const ageBand of AGE_BANDS) {
      for (const accessDensity of DENSITIES) {
        for (const routine of ROUTINES) {
          const board = selectBoard(prefsWith({ ageBand, accessDensity, routine }))
          expect(boardContainsProtectedOrder(board)).toBe(true)
          expect(board.core.map((entry) => entry.id)).toEqual([...PROTECTED_CORE_IDS])
          expect(board.fringe.some((entry) => entry.protected)).toBe(false)
        }
      }
    }
  })
})

function DENSITY_LIMIT_FOR(accessDensity: DemoPreferences['accessDensity']): number {
  if (accessDensity === 'large') return 10
  if (accessDensity === 'standard') return 20
  return 36
}
