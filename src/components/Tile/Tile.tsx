import { getIcon } from '../../icons/registry'
import type { Provenance, TokenCategory } from '../../domain/types'
import styles from './Tile.module.css'

interface TileProps {
  id: string
  label: string
  icon: string
  category: TokenCategory
  provenance?: Provenance
  /** `core` = protected band, `context` = right-now world words, `standard` = universal board. */
  size?: 'core' | 'context' | 'standard' | 'large'
  onSelect: (id: string) => void
}

const PROVENANCE_LABEL: Record<Provenance, string> = {
  core: 'Core',
  fringe: 'Board',
  suggestion: 'Local suggestion',
}

export function Tile({ id, label, icon, category, provenance, size = 'standard', onSelect }: TileProps) {
  const Icon = getIcon(icon)
  const variant =
    size === 'core' ? styles.core : size === 'context' || size === 'large' ? styles.context : styles.standard
  const classes = [styles.tile, variant].filter(Boolean).join(' ')

  return (
    <button
      type="button"
      className={classes}
      data-category={category}
      data-tile-id={id}
      aria-label={`${label}${provenance ? `, ${PROVENANCE_LABEL[provenance]}` : ''}`}
      onClick={() => onSelect(id)}
    >
      <span className={styles.badge} aria-hidden="true">
        <Icon className={styles.icon} />
      </span>
      <span className={styles.label}>{label}</span>
      {provenance === 'core' ? <span className={styles.provenance}>Core</span> : null}
    </button>
  )
}
