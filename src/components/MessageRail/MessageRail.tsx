import { getIcon } from '../../icons/registry'
import type { AuthoredToken } from '../../domain/types'
import styles from './MessageRail.module.css'

const PROVENANCE_LABEL = {
  core: 'Core',
  fringe: 'Board',
  suggestion: 'Local suggestion',
} as const

interface MessageRailProps {
  tokens: AuthoredToken[]
  speaking: boolean
  onSpeak: () => void
  onStop: () => void
  onDeleteLast: () => void
  onClear: () => void
  onRemove: (instanceId: string) => void
}

export function MessageRail({
  tokens,
  speaking,
  onSpeak,
  onStop,
  onDeleteLast,
  onClear,
  onRemove,
}: MessageRailProps) {
  const Volume = getIcon('volume-2')
  return (
    <section className={styles.rail} aria-label="Authorship rail">
      <div className={styles.canvas}>
        <div className={styles.strip} role={tokens.length > 0 ? 'list' : undefined}>
          {tokens.length === 0 ? (
            <p className={styles.empty}>
              Tap a word. Then press Speak.
            </p>
          ) : (
            tokens.map((token) => (
              <div role="listitem" key={token.instanceId}>
                <button
                  type="button"
                  className={styles.chip}
                  data-category={token.category}
                  aria-label={`Remove ${token.label}, ${PROVENANCE_LABEL[token.provenance]}`}
                  onClick={() => onRemove(token.instanceId)}
                >
                  <span className={styles.chipDot} aria-hidden="true" />
                  <span className={styles.chipLabel}>{token.label}</span>
                  <svg className={styles.chipX} viewBox="0 0 16 16" aria-hidden="true">
                    <path d="M4.5 4.5l7 7m0-7-7 7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                </button>
              </div>
            ))
          )}
        </div>
        {tokens.length > 0 ? (
          <p className={styles.hint} aria-hidden="true">
            Tap a chip to take it back
          </p>
        ) : null}
      </div>
      <div className={styles.controls}>
        <button type="button" className={styles.speak} onClick={onSpeak} disabled={tokens.length === 0 || speaking}>
          <Volume className={styles.speakIcon} aria-hidden="true" />
          Speak
        </button>
        <div className={styles.minorRow}>
          <button type="button" className={styles.control} onClick={onStop} disabled={!speaking}>
            Stop speaking
          </button>
          <button type="button" className={styles.control} onClick={onDeleteLast} disabled={tokens.length === 0}>
            Delete last
          </button>
          <button type="button" className={styles.control} onClick={onClear} disabled={tokens.length === 0}>
            Clear
          </button>
        </div>
      </div>
    </section>
  )
}
