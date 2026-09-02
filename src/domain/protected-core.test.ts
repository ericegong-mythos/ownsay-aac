import { describe, expect, it } from 'vitest'
import { selectBoard, boardContainsProtectedOrder } from './board'
import { assertProtectedCoreOrder, PROTECTED_CORE_IDS } from './protected-core'
import { ACCESS_DENSITIES, AGE_BANDS, DEFAULT_PREFERENCES, ROUTINES } from './types'

describe('protected core', () => {
  it('keeps a stable immutable order', () => {
    expect([...PROTECTED_CORE_IDS]).toEqual([
      'no',
      'stop',
      'help',
      'hurts',
      'break',
      'yes',
      'more',
      'finished',
    ])
    expect(assertProtectedCoreOrder(PROTECTED_CORE_IDS)).toBe(true)
  })

  it('stays first and unchanged across age, density and routine', () => {
    for (const ageBand of AGE_BANDS) {
      for (const accessDensity of ACCESS_DENSITIES) {
        for (const routine of ROUTINES) {
          const board = selectBoard({
            ...DEFAULT_PREFERENCES,
            ageBand,
            accessDensity,
            routine,
          })
          expect(board.core.map((entry) => entry.id)).toEqual([...PROTECTED_CORE_IDS])
          expect(boardContainsProtectedOrder(board)).toBe(true)
          expect(board.fringe.some((entry) => entry.protected)).toBe(false)
        }
      }
    }
  })
})
