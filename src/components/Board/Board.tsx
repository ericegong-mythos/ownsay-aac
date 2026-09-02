import type { AccessDensity, BoardSelection, DemoPreferences } from '../../domain/types'
import { ROUTINE_META } from '../../domain/types'
import { isContextualFringe } from '../../domain/board'
import { Tile } from '../Tile/Tile'
import styles from './Board.module.css'

interface BoardProps {
  board: BoardSelection
  density: AccessDensity
  prefs: DemoPreferences
  onSelect: (id: string, source: 'core' | 'fringe') => void
}

export function Board({ board, density, prefs, onSelect }: BoardProps) {
  const world = ROUTINE_META[prefs.routine]
  const context = board.fringe.filter((entry) => isContextualFringe(entry, prefs))
  const universal = board.fringe.filter((entry) => !isContextualFringe(entry, prefs))

  return (
    <div className={`${styles.board} ${styles[density]}`} data-routine={prefs.routine}>
      <section aria-labelledby="core-heading" className={styles.coreSection}>
        <h2 id="core-heading" className={styles.heading}>
          <span className={styles.coreMark} aria-hidden="true" />
          Core words
        </h2>
        <div className={styles.coreGrid} role="list">
          {board.core.map((entry) => (
            <div role="listitem" key={entry.id}>
              <Tile
                id={entry.id}
                label={entry.label}
                icon={entry.icon}
                category={entry.category}
                provenance="core"
                size="core"
                onSelect={(id) => onSelect(id, 'core')}
              />
            </div>
          ))}
        </div>
      </section>
      {/* Keyed by routine so the world change gets one quiet settle animation. */}
      <div className={styles.workspace} key={prefs.routine}>
        <section aria-labelledby="now-heading" className={styles.nowSection}>
          <h2 id="now-heading" className={styles.heading}>
            <span className={styles.nowMark} aria-hidden="true" />
            Right now · {world.world}
          </h2>
          <div className={styles.nowGrid} role="list">
            {context.map((entry) => (
              <div role="listitem" key={entry.id}>
                <Tile
                  id={entry.id}
                  label={entry.label}
                  icon={entry.icon}
                  category={entry.category}
                  size="context"
                  onSelect={(id) => onSelect(id, 'fringe')}
                />
              </div>
            ))}
          </div>
        </section>
        <section aria-labelledby="words-heading" className={styles.wordsSection}>
          <h2 id="words-heading" className={styles.heading}>
            <span className={styles.wordsMark} aria-hidden="true" />
            Anytime words
          </h2>
          <div className={styles.wordsGrid} role="list">
            {universal.map((entry) => (
              <div role="listitem" key={entry.id}>
                <Tile
                  id={entry.id}
                  label={entry.label}
                  icon={entry.icon}
                  category={entry.category}
                  size="standard"
                  onSelect={(id) => onSelect(id, 'fringe')}
                />
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}
