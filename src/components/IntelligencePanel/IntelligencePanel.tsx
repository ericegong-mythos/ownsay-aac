import { getIcon } from '../../icons/registry'
import type { HelperStatus } from '../../domain/types'
import styles from './IntelligencePanel.module.css'

interface IntelligencePanelProps {
  status: HelperStatus
  helperEnabled: boolean
  progress?: string
}

const PANEL_LABEL = 'OwnSay Intelligence'

/**
 * Read-only, honest status for the child surface. Every control that can
 * begin or stop a model download lives behind the held carer drawer — a child
 * must never be one tap away from a 200 MB fetch.
 */
export function IntelligencePanel({ status, helperEnabled, progress }: IntelligencePanelProps) {
  const Sparkles = getIcon('sparkles')

  let stateName: string
  let copy: string

  if (status === 'downloading') {
    stateName = 'Downloading'
    copy = `A carer is loading the optional helper on this device. The board and instant phrases stay ready.${progress ? ` ${progress}` : ''}`
  } else if (status === 'ready') {
    stateName = 'Ready'
    copy =
      'On and running on this device. It can keep working if the connection drops; suggestions below are chosen for this moment.'
  } else if (status === 'degraded') {
    stateName = 'Trouble'
    copy =
      'It could not finish just now, so instant phrases are being used. The board works exactly as before — a carer can try again.'
  } else if (status === 'unavailable') {
    stateName = 'Unavailable'
    copy =
      'This browser cannot run the on-device model right now. The board and instant phrases still work offline.'
  } else if (status === 'unsupported') {
    stateName = 'Not on this tablet'
    copy =
      'For a carer: this tablet does not support the technology the optional helper needs, so nothing was downloaded. The board and instant phrases below stay exactly as they are.'
  } else if (helperEnabled) {
    stateName = 'Paused'
    copy =
      'OwnSay Intelligence is paused. A carer can wake it; waking may need internet if its runtime files are not already in this browser.'
  } else {
    stateName = 'Not set up'
    copy =
      'Phrases that fit this routine, this message and the words on screen — chosen on this tablet. A carer can turn on the optional language helper from Carer settings.'
  }

  return (
    <aside className={styles.panel} aria-label={PANEL_LABEL} data-status={status}>
      <span className={styles.badge} aria-hidden="true">
        <Sparkles className={styles.icon} />
      </span>
      <div className={styles.body}>
        <h2 className={styles.title}>
          {PANEL_LABEL}
          <span className={styles.state}>{stateName}</span>
        </h2>
        <p className={styles.copy}>{copy}</p>
      </div>
    </aside>
  )
}
