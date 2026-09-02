import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  ACCESS_DENSITIES,
  ACCESS_DENSITY_LABELS,
  AGE_BANDS,
  AGE_BAND_LABELS,
  INTERESTS,
  INTEREST_LABELS,
  ROUTINES,
  ROUTINE_LABELS,
  type AccessDensity,
  type AgeBand,
  type ChildProfile,
  type Interest,
  type Routine,
} from '../../domain/types'
import {
  EXTRA_WORD_LABEL_LIMIT,
  NICKNAME_LIMIT,
  normaliseExtraWord,
  normaliseNickname,
} from '../../domain/profile-text'
import { PROTECTED_CORE_ENTRIES } from '../../domain/protected-core'
import type { HelperStatus } from '../../domain/types'
import type { ImportPreview } from '../../persistence/store'
import { EXTRA_WORD_LIMIT, isPlausibleBackupSize } from '../../persistence/store'
import {
  collectDeviceCheck,
  runSpeechTest,
  type DeviceCheckReport,
  type SpeechTestOutcome,
} from '../../domain/device-check'
import { speakAuthoredMessage, stopSpeaking, type VoiceOption } from '../../speech/adapter'
import styles from './CarerDrawer.module.css'

export interface ImportRequestState {
  status: 'idle' | 'preview' | 'error'
  fileName?: string
  preview?: ImportPreview
  message?: string
}

/** A destructive store operation in flight; the drawer locks while one runs. */
export type CarerBusyOp = 'restoring' | 'erasing' | 'deleting'

interface CarerDrawerProps {
  open: boolean
  profile: ChildProfile
  /** While set, every mutating control is disabled and the operation is announced. */
  busy?: CarerBusyOp | null
  helperStatus: HelperStatus
  helperProgress?: string
  onSetupHelper: () => void
  onCancelHelperDownload: () => void
  onDisableHelper: () => void
  onRetryHelper: () => void
  profiles: ChildProfile[]
  voices: VoiceOption[]
  importRequest: ImportRequestState
  onClose: () => void
  onChangeProfile: (next: ChildProfile) => void
  onSwitchProfile: (profileId: string) => void
  onAddProfile: (input: { nickname: string; ageBand: AgeBand }) => void
  onRemoveProfile: (profileId: string) => void
  onRestoreDemoProfiles: () => void
  onExport: () => void
  onImportFile: (file: File, fileName: string, oversized?: boolean) => void
  onImportConfirm: () => void
  onImportCancel: () => void
  onClear: () => void
}

export function CarerDrawer({
  open,
  profile,
  busy,
  helperStatus,
  helperProgress,
  onSetupHelper,
  onCancelHelperDownload,
  onDisableHelper,
  onRetryHelper,
  profiles,
  voices,
  importRequest,
  onClose,
  onChangeProfile,
  onSwitchProfile,
  onAddProfile,
  onRemoveProfile,
  onRestoreDemoProfiles,
  onExport,
  onImportFile,
  onImportConfirm,
  onImportCancel,
  onClear,
}: CarerDrawerProps) {
  const panelRef = useRef<HTMLElement | null>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(null)

  // Capture the opener before AppShell's passive effect applies `inert` to
  // the child surface. Waiting for the ordinary focus-trap effect can be too
  // late: adding inert is allowed to move focus back to the document body.
  useLayoutEffect(() => {
    if (open) restoreFocusRef.current = document.activeElement as HTMLElement | null
  }, [open])

  useEffect(() => {
    if (!open) return undefined
    panelRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
    // Lock background scroll while the carer drawer is open.
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
        return
      }
      if (event.key !== 'Tab' || !panelRef.current) return
      const focusables = Array.from(
        panelRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => !el.hasAttribute('disabled'))
      if (focusables.length === 0) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      // Recovery: if focus somehow escaped the dialog (browser quirk, layout
      // shift), the next Tab in either direction must bring it back inside.
      if (!panelRef.current.contains(document.activeElement)) {
        event.preventDefault()
        if (event.shiftKey) last.focus()
        else first.focus()
        return
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = previousOverflow
    }
  }, [open, onClose])

  // Focus restoration runs as a SETUP effect on the closing commit — after
  // every cleanup has already released the shell's `inert` attribute — so the
  // restored target can never be rejected as part of an isolated subtree.
  useEffect(() => {
    if (open) return
    const target = restoreFocusRef.current
    restoreFocusRef.current = null
    target?.focus?.()
  }, [open])

  const [nicknameDraft, setNicknameDraft] = useState(profile.nickname)
  const [wordDraft, setWordDraft] = useState('')
  const [wordRoutine, setWordRoutine] = useState<Routine | ''>('')
  const [wordTone, setWordTone] = useState<'favourite' | 'context'>('context')
  const [addingProfile, setAddingProfile] = useState(false)
  const [newNickname, setNewNickname] = useState('')
  const [newAgeBand, setNewAgeBand] = useState<AgeBand | null>(null)
  const [confirmingRemove, setConfirmingRemove] = useState<string | null>(null)
  const [confirmingClear, setConfirmingClear] = useState(false)
  const [wordWarning, setWordWarning] = useState<string | null>(null)
  const [deviceCheckRunning, setDeviceCheckRunning] = useState(false)
  const [deviceCheck, setDeviceCheck] = useState<DeviceCheckReport | null>(null)
  const [speechTestRunning, setSpeechTestRunning] = useState(false)
  const [speechTest, setSpeechTest] = useState<SpeechTestOutcome | null>(null)
  /** The carer's own answer after a completed audible attempt: true/false/null (asked). */
  const [heardConfirmation, setHeardConfirmation] = useState<boolean | null>(null)

  // The component stays mounted while closed, so every profile-scoped
  // transient must be reset together whenever the drawer closes or its child
  // changes. Otherwise a half-typed personal word, its routine/tone choices,
  // a warning, an add-profile form mid-fill or a pending confirmation could
  // silently cross from one child's drawer into another's.
  useEffect(() => {
    setNicknameDraft(profile.nickname)
    setWordDraft('')
    setWordRoutine('')
    setWordTone('context')
    setWordWarning(null)
    setAddingProfile(false)
    setNewNickname('')
    setNewAgeBand(null)
    setConfirmingRemove(null)
    setConfirmingClear(false)
  }, [open, profile.id])

  if (!open) return null

  // One destructive store operation at a time: restore, erase, delete and the
  // writes they would race are mutually exclusive, visibly.
  const locked = busy !== undefined && busy !== null

  // Defence in depth: App supplies only verified-local choices, but this
  // component also refuses any option that does not explicitly carry that fact.
  const localVoices = voices.filter((voice) => voice.localService === true)
  const englishVoices = localVoices.filter((voice) => /^en/i.test(voice.lang))
  const otherVoices = localVoices.filter((voice) => !/^en/i.test(voice.lang))
  const selectedVoiceURI =
    profile.voiceURI && localVoices.some((voice) => voice.uri === profile.voiceURI)
      ? profile.voiceURI
      : ''

  const addExtraWord = () => {
    const label = normaliseExtraWord(wordDraft)
    if (!label) return
    const key = label.trim().toLowerCase()
    if (PROTECTED_CORE_ENTRIES.some((entry) => entry.label.trim().toLowerCase() === key)) {
      setWordWarning(`“${label}” is already a core word on every board.`)
      return
    }
    if (profile.extraWords.some((word) => word.label.trim().toLowerCase() === key)) {
      setWordWarning(`“${label}” is already on this board.`)
      return
    }
    setWordWarning(null)
    onChangeProfile({
      ...profile,
      extraWords: [
        ...profile.extraWords,
        {
          id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
          label,
          tone: wordTone,
          ...(wordRoutine ? { routine: wordRoutine } : {}),
        },
      ],
    })
    setWordDraft('')
    setWordRoutine('')
  }

  return (
    <>
      <div className={styles.backdrop} onClick={onClose} aria-hidden="true" />
      <aside className={styles.panel} role="dialog" aria-modal="true" aria-labelledby="carer-title" ref={panelRef}>
        <div className={styles.header}>
          <div>
            <h2 id="carer-title" className={styles.title}>
              Carer settings
            </h2>
            <p className={styles.note}>Boards and settings stay on this device.</p>
          </div>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close carer settings">
            Close
          </button>
        </div>
        {locked ? (
          <p className={`${styles.note} ${styles.busyNote}`} role="status">
            {busy === 'restoring'
              ? 'Restoring backup…'
              : busy === 'erasing'
                ? 'Erasing this device…'
                : 'Removing the board…'}
            {' '}Settings are locked until it finishes.
          </p>
        ) : null}

        <fieldset className={`${styles.fieldset} ${styles.guideCard}`}>
          <legend className={styles.legend}>Quick guide</legend>
          <ol className={styles.guideSteps}>
            <li>Choose a profile, then tap words to build a message.</li>
            <li>Press Speak when the message is ready. OwnSay never speaks by itself.</li>
            <li>Use the routine buttons to show words for the current activity.</li>
            <li>Add personal words here, and export a backup after making changes.</li>
          </ol>
          <p className={styles.note}>The communication board and its core words remain available offline.</p>
        </fieldset>

        <fieldset className={styles.fieldset}>
          <legend className={styles.legend}>This board belongs to</legend>
          <label className={styles.inputRow}>
            <span className={styles.fieldLabel}>Nickname</span>
            <input
              className={styles.textInput}
              value={nicknameDraft}
              maxLength={NICKNAME_LIMIT}
              autoComplete="off"
              spellCheck={false}
              aria-describedby="nickname-note"
              disabled={locked}
              onChange={(event) => setNicknameDraft(event.target.value)}
              onBlur={() => {
                const cleaned = normaliseNickname(nicknameDraft) ?? 'Child'
                setNicknameDraft(cleaned)
                if (cleaned !== profile.nickname) onChangeProfile({ ...profile, nickname: cleaned })
              }}
            />
          </label>
          <p id="nickname-note" className={styles.note}>
            Saved when you leave the box.
          </p>
        </fieldset>

        <fieldset className={styles.fieldset}>
          <legend className={styles.legend}>Profiles</legend>
          <p className={styles.note}>Each child keeps their own words and settings.</p>
          <ul className={styles.profileList}>
            {profiles.map((row) => (
              <li key={row.id}>
                <button
                  type="button"
                  className={styles.profileRow}
                  data-selected={row.id === profile.id}
                  aria-pressed={row.id === profile.id}
                  disabled={locked || row.id === profile.id}
                  onClick={() => {
                    if (row.id !== profile.id) onSwitchProfile(row.id)
                  }}
                >
                  <span className={styles.profileName}>{row.nickname}</span>
                  <span className={styles.profileMeta}>
                    {AGE_BAND_LABELS[row.ageBand]} · {ACCESS_DENSITY_LABELS[row.accessDensity]}
                  </span>
                </button>
                {profiles.length > 1 && row.id === profile.id ? (
                  confirmingRemove === row.id ? (
                    <button
                      type="button"
                      className={`${styles.button} ${styles.dangerButton}`}
                      disabled={locked}
                      onClick={() => {
                        onRemoveProfile(row.id)
                        setConfirmingRemove(null)
                      }}
                    >
                      Really remove {row.nickname}’s board?
                    </button>
                  ) : (
                    <button
                      type="button"
                      className={styles.quietButton}
                      disabled={locked}
                      onClick={() => setConfirmingRemove(row.id)}
                    >
                      Remove this board
                    </button>
                  )
                ) : null}
              </li>
            ))}
          </ul>
          {addingProfile ? (
            <div className={styles.addForm}>
              <input
                className={styles.textInput}
                value={newNickname}
                maxLength={NICKNAME_LIMIT}
                placeholder="New child’s nickname"
                aria-label="New child’s nickname"
                autoComplete="off"
                disabled={locked}
                onChange={(event) => setNewNickname(event.target.value)}
              />
              <div className={styles.choices} role="group" aria-label="New child’s age group">
                {AGE_BANDS.map((band) => (
                  <Choice
                    key={band}
                    selected={newAgeBand === band}
                    onSelect={() => setNewAgeBand(band)}
                    disabled={locked}
                  >
                    {AGE_BAND_LABELS[band]}
                  </Choice>
                ))}
              </div>
              <div className={styles.actions}>
                <button
                  type="button"
                  className={`${styles.button} ${styles.primaryButton}`}
                  disabled={!newAgeBand || locked}
                  onClick={() => {
                    if (!newAgeBand) return
                    onAddProfile({ nickname: normaliseNickname(newNickname) ?? 'Child', ageBand: newAgeBand })
                    setAddingProfile(false)
                    setNewNickname('')
                    setNewAgeBand(null)
                  }}
                >
                  Create board
                </button>
                <button
                  type="button"
                  className={styles.button}
                  disabled={locked}
                  onClick={() => {
                    setAddingProfile(false)
                    setNewAgeBand(null)
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button type="button" className={styles.button} disabled={locked} onClick={() => setAddingProfile(true)}>
              Add another child
            </button>
          )}
          <div className={`${styles.actions} ${styles.restoreRow}`}>
            <button type="button" className={styles.quietButton} disabled={locked} onClick={onRestoreDemoProfiles}>
              Restore fictional demo boards
            </button>
            <p className={styles.note}>Adds either example if it is missing. Nothing else changes.</p>
          </div>
        </fieldset>

        <fieldset className={styles.fieldset}>
          <legend className={styles.legend}>Words</legend>
          <div className={styles.choices} role="group" aria-label="Age group">
            {AGE_BANDS.map((band) => (
              <Choice
                key={band}
                selected={profile.ageBand === band}
                onSelect={() => onChangeProfile({ ...profile, ageBand: band satisfies AgeBand })}
                disabled={locked}
              >
                {AGE_BAND_LABELS[band]}
              </Choice>
            ))}
          </div>
          <div className={styles.choices} role="group" aria-label="Word density">
            {ACCESS_DENSITIES.map((density) => (
              <Choice
                key={density}
                selected={profile.accessDensity === density}
                onSelect={() => onChangeProfile({ ...profile, accessDensity: density satisfies AccessDensity })}
                disabled={locked}
              >
                {ACCESS_DENSITY_LABELS[density]}
              </Choice>
            ))}
          </div>
          <div className={styles.choices} role="group" aria-label="Current routine">
            {ROUTINES.map((routine) => (
              <Choice
                key={routine}
                selected={profile.routine === routine}
                onSelect={() => onChangeProfile({ ...profile, routine: routine satisfies Routine })}
                disabled={locked}
              >
                {ROUTINE_LABELS[routine]}
              </Choice>
            ))}
          </div>
          <div className={styles.choices} role="group" aria-label="Interests">
            {INTERESTS.map((interest) => {
              const selected = profile.interests.includes(interest)
              return (
                <Choice
                  key={interest}
                  selected={selected}
                  onSelect={() =>
                    onChangeProfile({
                      ...profile,
                      interests: toggleInterest(profile.interests, interest),
                    })
                  }
                  disabled={locked}
                >
                  {INTEREST_LABELS[interest]}
                </Choice>
              )
            })}
          </div>
        </fieldset>

        <fieldset className={styles.fieldset}>
          <legend className={styles.legend}>Welcome</legend>
          <div className={styles.choices}>
            <Choice
              selected={profile.welcomeCelebration}
              onSelect={() => onChangeProfile({ ...profile, welcomeCelebration: true })}
              disabled={locked}
            >
              Celebration on
            </Choice>
            <Choice
              selected={!profile.welcomeCelebration}
              onSelect={() => onChangeProfile({ ...profile, welcomeCelebration: false })}
              disabled={locked}
            >
              Celebration off
            </Choice>
          </div>
          <p className={styles.note}>
            A short silent “Hello {profile.nickname}” with their favourite things when their board is chosen. The
            board is ready underneath either way.
          </p>
        </fieldset>

        <fieldset className={styles.fieldset}>
          <legend className={styles.legend}>Extra words</legend>
          <p className={styles.note}>
            Up to {EXTRA_WORD_LIMIT} personal words join the anytime zone of {profile.nickname}’s board.
          </p>
          {profile.extraWords.length > 0 ? (
            <ul className={styles.wordList}>
              {profile.extraWords.map((word) => (
                <li key={word.id}>
                  <button
                    type="button"
                    className={styles.wordChip}
                    aria-label={`Remove extra word ${word.label}`}
                    disabled={locked}
                    onClick={() =>
                      onChangeProfile({
                        ...profile,
                        extraWords: profile.extraWords.filter((item) => item.id !== word.id),
                      })
                    }
                  >
                    {word.label}
                    {word.routine ? <span className={styles.wordRoutine}>{ROUTINE_LABELS[word.routine]}</span> : null}
                    <span aria-hidden="true">✕</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {profile.extraWords.length < EXTRA_WORD_LIMIT ? (
            <div className={styles.addWordRow}>
              {wordWarning ? (
                <p className={styles.errorNote} role="alert">
                  {wordWarning}
                </p>
              ) : null}
              <input
                className={styles.textInput}
                value={wordDraft}
                maxLength={EXTRA_WORD_LABEL_LIMIT}
                placeholder="One word, e.g. Grandma"
                aria-label="New extra word"
                autoComplete="off"
                disabled={locked}
                onChange={(event) => setWordDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    addExtraWord()
                  }
                }}
              />
              <div className={styles.choices} role="group" aria-label="Where the new word shows">
                <Choice selected={wordRoutine === ''} onSelect={() => setWordRoutine('')} disabled={locked}>
                  Anytime
                </Choice>
                {ROUTINES.map((routine) => (
                  <Choice
                    key={routine}
                    selected={wordRoutine === routine}
                    onSelect={() => setWordRoutine(routine)}
                    disabled={locked}
                  >
                    {ROUTINE_LABELS[routine]}
                  </Choice>
                ))}
              </div>
              <div className={styles.choices} role="group" aria-label="Suggestion eligibility">
                <Choice selected={wordTone === 'context'} onSelect={() => setWordTone('context')} disabled={locked}>
                  Never suggest
                </Choice>
                <Choice selected={wordTone === 'favourite'} onSelect={() => setWordTone('favourite')} disabled={locked}>
                  Smart phrases
                </Choice>
              </div>
              <button
                type="button"
                className={styles.button}
                onClick={addExtraWord}
                disabled={!normaliseExtraWord(wordDraft)}
              >
                Add word
              </button>
            </div>
          ) : null}
        </fieldset>

        <fieldset className={styles.fieldset}>
          <legend className={styles.legend}>Optional language helper</legend>
          {helperStatus === 'downloading' ? (
            <>
              <p className={styles.note}>
                {helperProgress ?? 'Downloading about 200 MB of model files.'} Internet may be needed.
              </p>
              <div className={styles.actions}>
                <button type="button" className={styles.button} disabled={locked} onClick={onCancelHelperDownload}>
                  Cancel download
                </button>
              </div>
            </>
          ) : helperStatus === 'ready' ? (
            <>
              <p className={styles.note}>On and running on this device.</p>
              <div className={styles.actions}>
                <button type="button" className={styles.button} disabled={locked} onClick={onDisableHelper}>
                  Turn off
                </button>
              </div>
            </>
          ) : helperStatus === 'degraded' || helperStatus === 'unavailable' ? (
            <>
              <p className={styles.note}>It could not finish just now. Instant phrases are being used.</p>
              <div className={styles.actions}>
                <button
                  type="button"
                  className={`${styles.button} ${styles.primaryButton}`}
                  disabled={locked}
                  onClick={onRetryHelper}
                >
                  Try again
                </button>
                <button type="button" className={styles.button} disabled={locked} onClick={onDisableHelper}>
                  Turn off
                </button>
              </div>
            </>
          ) : profile.helperEnabled && helperStatus === 'off' ? (
            <>
              <p className={styles.note}>Paused. Waking it may need internet to load runtime files.</p>
              <div className={styles.actions}>
                <button
                  type="button"
                  className={`${styles.button} ${styles.primaryButton}`}
                  disabled={locked}
                  onClick={onSetupHelper}
                >
                  Wake OwnSay Intelligence
                </button>
              </div>
            </>
          ) : helperStatus === 'unsupported' ? (
            <p className={styles.note}>
              This tablet does not support the optional helper, so nothing was downloaded. The boards work exactly
              as before.
            </p>
          ) : (
            <>
              <p className={styles.warningNote}>
                Setup downloads a language model of about 200 MB plus runtime files from WebLLM's configured
                providers. They receive ordinary connection details, not an OwnSay inference request. Ranking then
                runs in this browser and needs extra device memory.
              </p>
              <div className={styles.actions}>
                <button
                  type="button"
                  className={`${styles.button} ${styles.primaryButton}`}
                  disabled={locked}
                  onClick={onSetupHelper}
                >
                  Download on this device
                </button>
              </div>
            </>
          )}
        </fieldset>

        <fieldset className={styles.fieldset}>
          <legend className={styles.legend}>Voice</legend>
          <label className={styles.inputRow}>
            <span className={styles.fieldLabel}>Spoken voice for {profile.nickname}</span>
            <select
              className={styles.textInput}
              value={selectedVoiceURI}
              disabled={locked || localVoices.length === 0}
              onChange={(event) =>
                onChangeProfile({ ...profile, voiceURI: event.target.value || undefined })
              }
            >
              <option value="">
                {localVoices.length > 0
                  ? 'Automatic · verified on-device voice'
                  : 'No verified on-device voice · text only'}
              </option>
              {englishVoices.length > 0 ? (
                <optgroup label="On-device English voices">
                  {englishVoices.map((voice) => (
                    <option key={voice.uri} value={voice.uri}>
                      {voice.name} · on-device ({voice.lang})
                    </option>
                  ))}
                </optgroup>
              ) : null}
              {otherVoices.length > 0 ? (
                <optgroup label="Other on-device languages">
                  {otherVoices.map((voice) => (
                    <option key={voice.uri} value={voice.uri}>
                      {voice.name} · on-device ({voice.lang})
                    </option>
                  ))}
                </optgroup>
              ) : null}
            </select>
          </label>
          <p className={styles.note}>
            OwnSay lists and uses only voices this browser explicitly reports as on-device. If none is available,
            Speak keeps the words visible and sends no speech request.
          </p>
        </fieldset>

        <fieldset className={styles.fieldset}>
          <legend className={styles.legend}>Device check</legend>
          <p className={styles.note}>
            Runs once, here, when you press the button. Reports this tablet's capabilities only — never words,
            messages or usage.
          </p>
          {deviceCheck ? (
            <div className={styles.deviceCheck}>
              <ul className={styles.checkList}>
                <li>Core board: Ready</li>
                <li>
                  Saved locally:{' '}
                  {deviceCheck.summary.savedLocally === 'yes'
                    ? 'Yes'
                    : deviceCheck.summary.savedLocally === 'temporary-session'
                      ? 'Temporary session only'
                      : 'Failed'}
                </li>
                <li>
                  Offline shell:{' '}
                  {deviceCheck.summary.offlineShell === 'ready'
                    ? 'Ready'
                    : deviceCheck.summary.offlineShell === 'shell-cached'
                      ? 'Shell cached (airplane test pending)'
                      : deviceCheck.summary.offlineShell === 'online-only'
                        ? 'Online only'
                        : 'Unavailable'}
                </li>
                <li>
                  Verified on-device speech:{' '}
                  {deviceCheck.summary.speech === 'ready'
                    ? `Available · ${deviceCheck.speechCapability.localVoiceCount ?? 0} local voices (not yet a hearing check)`
                    : deviceCheck.summary.speech === 'api-present-no-local-voices'
                      ? 'Unavailable · browser reported no on-device voices'
                      : 'Text only'}
                </li>
                <li>
                  Local helper:{' '}
                  {deviceCheck.summary.localHelper === 'blocked-by-device-policy'
                    ? 'Blocked on this Fire model'
                    : deviceCheck.summary.localHelper === 'experimental'
                      ? 'Experimental (capability evidence only)'
                      : 'Unavailable'}
                </li>
              </ul>
              <div className={styles.actions}>
                <button
                  type="button"
                  className={styles.button}
                  disabled={speechTestRunning || localVoices.length === 0}
                  onClick={() => {
                    setHeardConfirmation(null)
                    setSpeechTestRunning(true)
                    // Deliberate only: this never runs by itself. The outcome
                    // reports what actually happened; a timeout also cancels.
                    void runSpeechTest({
                      speak: (text, onEnd) => speakAuthoredMessage([text], onEnd),
                      stop: stopSpeaking,
                    })
                      .then(setSpeechTest)
                      .finally(() => setSpeechTestRunning(false))
                  }}
                >
                  {speechTestRunning
                    ? 'Playing…'
                    : localVoices.length > 0
                      ? 'Play test phrase'
                      : 'No on-device voice to test'}
                </button>
              </div>
              {speechTest ? (
                speechTest.error ? (
                  <p className={styles.note} role="status">
                    Speech could not start ({speechTest.error}).
                  </p>
                ) : !speechTest.started ? (
                  <p className={styles.note} role="status">
                    The test phrase could not start on this device, so there is nothing to hear yet.
                  </p>
                ) : speechTest.timedOut ? (
                  <p className={styles.note} role="status">
                    The test phrase did not finish — it was stopped.
                  </p>
                ) : speechTest.ended && heardConfirmation === null ? (
                  <div className={styles.actions}>
                    <p className={styles.note}>Test phrase finished. Did you hear it?</p>
                    <button type="button" className={styles.button} onClick={() => setHeardConfirmation(true)}>
                      I heard it
                    </button>
                    <button type="button" className={styles.button} onClick={() => setHeardConfirmation(false)}>
                      I did not hear it
                    </button>
                  </div>
                ) : (
                  <p className={styles.note} role="status">
                    {heardConfirmation === true
                      ? 'Audible check: you heard the test phrase.'
                      : heardConfirmation === false
                        ? 'Audible check: recorded as not heard. Try another voice above.'
                        : 'Test phrase started.'}
                  </p>
                )
              ) : (
                <p className={styles.note}>The check never plays sound by itself.</p>
              )}
              <div className={styles.actions}>
                <button
                  type="button"
                  className={`${styles.button} ${styles.primaryButton}`}
                  onClick={async () => {
                    const json = JSON.stringify(deviceCheck, null, 2)
                    try {
                      await navigator.clipboard.writeText(json)
                    } catch {
                      window.prompt('Copy the device check report:', json)
                    }
                  }}
                >
                  Copy report
                </button>
                <button
                  type="button"
                  className={styles.button}
                  onClick={() => {
                    const blob = new Blob([JSON.stringify(deviceCheck, null, 2)], { type: 'application/json' })
                    const url = URL.createObjectURL(blob)
                    const link = document.createElement('a')
                    link.href = url
                    link.download = `ownsay-device-check-${new Date().toISOString().slice(0, 10)}.json`
                    document.body.append(link)
                    link.click()
                    link.remove()
                    URL.revokeObjectURL(url)
                  }}
                >
                  Download JSON
                </button>
                <button type="button" className={styles.button} onClick={() => setDeviceCheck(null)}>
                  Clear
                </button>
              </div>
              <details>
                <summary className={styles.summary}>Full technical result</summary>
                <pre className={styles.checkJson}>{JSON.stringify(deviceCheck, null, 2)}</pre>
              </details>
            </div>
          ) : (
            <div className={styles.actions}>
              <button
                type="button"
                className={styles.button}
                disabled={deviceCheckRunning}
                onClick={() => {
                  setDeviceCheckRunning(true)
                  void collectDeviceCheck()
                    .then(setDeviceCheck)
                    .finally(() => setDeviceCheckRunning(false))
                }}
              >
                {deviceCheckRunning ? 'Checking…' : 'Run device check'}
              </button>
            </div>
          )}
        </fieldset>

        <fieldset className={styles.fieldset}>
          <legend className={styles.legend}>Backup</legend>
          <p className={styles.note}>
            A backup file keeps each child’s boards, personal words and settings, plus up to 400 recent activity events (times and status only — never the words used). OwnSay does not upload it; you choose where the file goes, so keep it somewhere private.
          </p>
          <div className={styles.actions}>
            <button type="button" className={styles.button} disabled={locked} onClick={onExport}>
              Download backup
            </button>
            <label className={`${styles.button} ${styles.fileLabel} ${locked ? styles.fileLabelLocked : ''}`}>
              Choose backup file…
              <input
                type="file"
                accept="application/json,.json"
                className={styles.fileInput}
                disabled={locked}
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  event.target.value = ''
                  // Reject oversized files before reading any bytes.
                  if (file && !isPlausibleBackupSize(file.size)) {
                    onImportFile(file, file.name, true)
                    return
                  }
                  if (file) onImportFile(file, file.name)
                }}
              />
            </label>
          </div>
          {importRequest.status === 'preview' && importRequest.preview ? (
            <div className={styles.importBox} role="group" aria-label="Backup preview">
              <p className={styles.importTitle}>Restore “{importRequest.fileName}”?</p>
              <p className={styles.importLine}>
                Made by this app on {formatDate(importRequest.preview.exportedAt)}. Contains{' '}
                {plural(importRequest.preview.profileCount, 'board', 'boards')} (
                {importRequest.preview.nicknames.join(', ')}) and{' '}
                {importRequest.preview.eventCount === 0
                  ? 'no interaction events'
                  : plural(importRequest.preview.eventCount, 'timestamped interaction event', 'timestamped interaction events')}
                .
              </p>
              <p className={styles.importLine}>This replaces the boards saved on this device.</p>
              <div className={styles.actions}>
                <button
                  type="button"
                  className={`${styles.button} ${styles.primaryButton}`}
                  disabled={locked}
                  onClick={onImportConfirm}
                >
                  Restore backup
                </button>
                <button type="button" className={styles.button} disabled={locked} onClick={onImportCancel}>
                  Keep current
                </button>
              </div>
            </div>
          ) : null}
          {importRequest.status === 'error' ? (
            <p className={styles.errorNote} role="alert">
              {importRequest.message ?? 'That file could not be restored.'}
            </p>
          ) : null}
        </fieldset>

        <fieldset className={styles.fieldset}>
          <legend className={styles.legend}>Local data</legend>
          {confirmingClear ? (
            <div className={styles.actions}>
              <button
                type="button"
                className={`${styles.button} ${styles.dangerButton}`}
                disabled={locked}
                onClick={() => {
                  onClear()
                  setConfirmingClear(false)
                }}
              >
                Erase everything on this device?
              </button>
              <button type="button" className={styles.button} disabled={locked} onClick={() => setConfirmingClear(false)}>
                Keep data
              </button>
            </div>
          ) : (
            <div className={styles.actions}>
              <button type="button" className={styles.button} disabled={locked} onClick={() => setConfirmingClear(true)}>
                Clear local data
              </button>
            </div>
          )}
        </fieldset>
      </aside>
    </>
  )
}

function formatDate(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return 'an unknown date'
  return date.toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' })
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

function toggleInterest(current: Interest[], interest: Interest): Interest[] {
  return current.includes(interest) ? current.filter((item) => item !== interest) : [...current, interest]
}

function Choice({
  selected,
  onSelect,
  disabled = false,
  children,
}: {
  selected: boolean
  onSelect: () => void
  disabled?: boolean
  children: string
}) {
  return (
    <button
      type="button"
      className={styles.choice}
      data-selected={selected}
      aria-pressed={selected}
      disabled={disabled}
      onClick={onSelect}
    >
      {children}
    </button>
  )
}
