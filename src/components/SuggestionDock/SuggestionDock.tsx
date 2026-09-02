import { getIcon } from '../../icons/registry'
import type { Suggestion } from '../../domain/types'
import styles from './SuggestionDock.module.css'

interface SuggestionDockProps {
  suggestions: Suggestion[]
  usedModel: boolean
  onChoose: (suggestion: Suggestion) => void
}

export function SuggestionDock({ suggestions, usedModel, onChoose }: SuggestionDockProps) {
  const Plus = getIcon('plus')
  const modelPresent = usedModel || suggestions.some((suggestion) => suggestion.source === 'local-model')
  return (
    <aside className={styles.dock} aria-label="Optional local suggestions">
      <div className={styles.header}>
        <h2 className={styles.title}>Suggestions</h2>
        <p className={styles.note}>
          {modelPresent
            ? 'OwnSay phrases are chosen on this device for this moment. Instant phrases are prepared for this routine.'
            : 'Instant phrases for this routine. They are added only if you tap them.'}
        </p>
      </div>
      {suggestions.length === 0 ? (
        <p className={styles.empty}>No extra phrases right now.</p>
      ) : (
        <div className={styles.list}>
          {suggestions.map((suggestion) => {
            const words = suggestion.tokens.map((token) => token.label).join(' ')
            const fromModel = suggestion.source === 'local-model'
            return (
              <button
                key={suggestion.id}
                type="button"
                className={`${styles.item} ${fromModel ? styles.model : ''}`}
                aria-label={`Add suggestion: ${words}${fromModel ? ' (OwnSay phrase)' : ' (instant phrase)'}`}
                onClick={() => onChoose(suggestion)}
              >
                <Plus className={styles.itemIcon} aria-hidden="true" />
                <span className={styles.words}>{words}</span>
                {fromModel ? (
                  <span className={styles.ownsayTag} aria-hidden="true">
                    OwnSay
                  </span>
                ) : null}
              </button>
            )
          })}
        </div>
      )}
    </aside>
  )
}
