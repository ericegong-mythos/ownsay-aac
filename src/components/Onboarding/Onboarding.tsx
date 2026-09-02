import { useState } from 'react'
import { AGE_BANDS, AGE_BAND_LABELS, type AgeBand } from '../../domain/types'
import { NICKNAME_LIMIT } from '../../domain/profile-text'
import { DEMO_PROFILE_LIST, type DemoProfileKey } from '../../domain/demo-profiles'
import styles from './Onboarding.module.css'

const AGE_BAND_NOTES: Record<AgeBand, string> = {
  '4-6': 'Starts with first words and short phrases',
  '7-9': 'Everyday words for school, home and play',
  '10-12': 'A fuller word set, including feelings and opinions',
}

interface OnboardingProps {
  onCreate: (input: { nickname: string; ageBand: AgeBand }) => void
  onSelectDemoProfile: (key: DemoProfileKey) => void
}

/**
 * First-run setup. Fictional examples demonstrate profile isolation before
 * any typing; everything else runs through the ordinary
 * one-local-profile-per-child path. No account; authored speech is available
 * only through a voice the browser explicitly reports as on-device.
 */
export function Onboarding({ onCreate, onSelectDemoProfile }: OnboardingProps) {
  const [nickname, setNickname] = useState('')
  const [ageBand, setAgeBand] = useState<AgeBand | null>(null)
  const [customOpen, setCustomOpen] = useState(false)

  return (
    <div className={styles.backdrop}>
      <main className={styles.card} aria-labelledby="onboarding-title">
        <h1 id="onboarding-title" className={styles.wordmark}>
          OwnSay
        </h1>
        <p className={styles.lede}>Who is this board for?</p>

        <section className={styles.demoProfiles} aria-labelledby="demo-profiles-title">
          <h2 id="demo-profiles-title" className={styles.sectionLabel}>
            Try a fictional example
          </h2>
          <div className={styles.demoChoices}>
            {DEMO_PROFILE_LIST.map((starter) => (
              <button
                key={starter.key}
                type="button"
                className={styles.demoChoice}
                onClick={() => onSelectDemoProfile(starter.key)}
              >
                <span className={styles.demoName}>{starter.nickname}</span>
                <span className={styles.demoMeta}>Fictional · Ages 4–6 · {starter.blurb}</span>
              </button>
            ))}
          </div>
          {!customOpen ? (
            <button
              type="button"
              className={styles.customToggle}
              onClick={() => setCustomOpen(true)}
            >
              Set up a different way
            </button>
          ) : null}
        </section>

        {customOpen ? (
          <form
            className={styles.form}
            onSubmit={(event) => {
              event.preventDefault()
              if (!ageBand) return
              onCreate({ nickname, ageBand })
            }}
          >
            <div className={styles.field}>
              <label htmlFor="nickname-input" className={styles.label}>
                Nickname <span className={styles.optional}>(optional)</span>
              </label>
              <input
                id="nickname-input"
                className={styles.input}
                value={nickname}
                maxLength={NICKNAME_LIMIT}
                autoComplete="off"
                spellCheck={false}
                placeholder="What should we call them?"
                onChange={(event) => setNickname(event.target.value)}
              />
            </div>
            <fieldset className={styles.bandField}>
              <legend className={styles.label}>Age group</legend>
              <p className={styles.note}>Sets the starting words only. Every core word stays the same.</p>
              <div className={styles.bands}>
                {AGE_BANDS.map((band) => (
                  <button
                    key={band}
                    type="button"
                    className={styles.band}
                    data-selected={ageBand === band}
                    aria-pressed={ageBand === band}
                    onClick={() => setAgeBand(band)}
                  >
                    <span className={styles.bandAge}>{AGE_BAND_LABELS[band]}</span>
                    <span className={styles.bandNote}>{AGE_BAND_NOTES[band]}</span>
                  </button>
                ))}
              </div>
            </fieldset>
            <button type="submit" className={styles.continue} disabled={!ageBand}>
              Make this board ready
            </button>
            <p className={styles.privacy}>
              Your board and words stay on this device. Speech uses verified on-device voices only. No account needed.
            </p>
          </form>
        ) : null}
      </main>
    </div>
  )
}
