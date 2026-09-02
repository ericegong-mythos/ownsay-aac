import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react'
import {
  ROUTINE_LABELS,
  ROUTINE_META,
  ROUTINES,
  type DemoPreferences,
  type Routine,
} from '../../domain/types'
import { getIcon } from '../../icons/registry'
import { useHoldToOpen } from '../../hooks/useHoldToOpen'
import styles from './AppShell.module.css'

interface AppShellProps {
  prefs: DemoPreferences
  childName: string
  offline?: boolean
  liveText: string
  storageWarning?: string | null
  children: ReactNode
  onOpenCarer: () => void
  onRoutine: (routine: Routine) => void
  onDismissStorageWarning?: () => void
  /**
   * True while a sibling modal (carer settings) is open: the whole child
   * subtree becomes inert and leaves the accessibility tree, so background
   * controls can neither take focus nor receive clicks. Derived purely from
   * the modal's open state, so every close path restores both properties.
   */
  isolatedFromAT?: boolean
}

export function AppShell({
  prefs,
  childName,
  offline = false,
  liveText,
  storageWarning,
  children,
  onOpenCarer,
  onRoutine,
  onDismissStorageWarning,
  isolatedFromAT = false,
}: AppShellProps) {
  const hold = useHoldToOpen(onOpenCarer)
  const world = ROUTINE_META[prefs.routine]
  const identity = {
    '--world': `var(${world.accentVar})`,
  } as CSSProperties
  const shellRef = useRef<HTMLDivElement | null>(null)

  // React 18 does not render the `inert` prop declaratively, so the isolation
  // attribute is applied imperatively and derived purely from the prop — every
  // open/close path flips it, and unmount takes the whole node with it. The
  // cleanup releases `inert` EARLY in the closing commit (sibling effects run
  // in tree order), so the drawer's focus restoration never targets a still-
  // isolated subtree.
  useEffect(() => {
    const el = shellRef.current
    if (!el) return
    if (isolatedFromAT) el.setAttribute('inert', '')
    else el.removeAttribute('inert')
    return () => el.removeAttribute('inert')
  }, [isolatedFromAT])

  return (
    <div
      ref={shellRef}
      className={styles.shell}
      data-routine={prefs.routine}
      style={identity}
      aria-hidden={isolatedFromAT || undefined}
    >
      <header className={styles.header}>
        <div className={styles.brand}>
          <h1 className={styles.title}>
            OwnSay
          </h1>
          {childName ? (
            <span className={styles.childTag} aria-label={`This is ${childName}’s board`}>
              {childName}
            </span>
          ) : null}
          {offline ? (
            <span className={styles.offlineTag} role="status">
              <span className={styles.offlineDot} aria-hidden="true" />
              Offline · board and instant phrases are ready
            </span>
          ) : null}
        </div>
        <button
          type="button"
          className={styles.hold}
          aria-label="Open carer settings"
          onContextMenu={(event) => event.preventDefault()}
          {...hold}
        >
          Hold for carer
        </button>
        {storageWarning ? (
          <div className={styles.storageWarning} role="alert">
            <span>{storageWarning}</span>
            {onDismissStorageWarning ? (
              <button
                type="button"
                className={styles.storageDismiss}
                onClick={onDismissStorageWarning}
                aria-label="Dismiss storage warning"
              >
                Dismiss
              </button>
            ) : null}
          </div>
        ) : null}
      </header>
      <div className={styles.worldBar}>
        <nav className={styles.routines} aria-label="Routine">
          {ROUTINES.map((routine) => {
            const meta = ROUTINE_META[routine]
            const Icon = getIcon(meta.icon)
            return (
              <button
                key={routine}
                type="button"
                className={styles.world}
                data-routine={routine}
                data-selected={prefs.routine === routine}
                aria-pressed={prefs.routine === routine}
                onClick={() => onRoutine(routine)}
              >
                <Icon className={styles.worldIcon} aria-hidden="true" />
                <span>{ROUTINE_LABELS[routine]}</span>
                <svg className={styles.worldCheck} viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M3 8.5 6.5 12 13 4.5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            )
          })}
        </nav>
        <p className={styles.cue}>
          <strong className={styles.cueWorld}>{world.world}</strong>
          <span className={styles.cueSep} aria-hidden="true">
            ·
          </span>
          {world.cue}
        </p>
      </div>
      <main className={styles.main}>{children}</main>
      <div className={styles.live} aria-live="polite">
        {liveText}
      </div>
    </div>
  )
}
