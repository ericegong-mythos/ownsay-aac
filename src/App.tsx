import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Board } from './components/Board/Board'
import { CarerDrawer, type ImportRequestState } from './components/CarerDrawer/CarerDrawer'
import { AppShell } from './components/AppShell/AppShell'
import { IntelligencePanel } from './components/IntelligencePanel/IntelligencePanel'
import { MessageRail } from './components/MessageRail/MessageRail'
import { Onboarding } from './components/Onboarding/Onboarding'
import { SuggestionDock } from './components/SuggestionDock/SuggestionDock'
import { WelcomeCelebration } from './components/WelcomeCelebration/WelcomeCelebration'
import { EXTRA_WORD_PREFIX, extraWordEntries, personalFavouriteTokens, selectBoard } from './domain/board'
import { appendSuggestionTokens, buildModelInput, cloneMessage } from './domain/policy'
import { buildDeterministicSuggestions } from './domain/suggestions'
import {
  DEMO_PROFILES,
  DEMO_PROFILE_KEYS,
  createDemoProfile,
  findMissingDemoProfiles,
  orderProfilesForDisplay,
  type DemoProfileKey,
} from './domain/demo-profiles'
import {
  DEFAULT_PREFERENCES,
  ROUTINE_LABELS,
  ROUTINE_META,
  type AuthoredToken,
  type AgeBand,
  type ChildProfile,
  type HelperStatus,
  type Provenance,
  type Routine,
  type Suggestion,
} from './domain/types'
import { getVocabById } from './domain/vocabulary'
import {
  cancelActiveGeneration,
  deactivateLocalHelper,
  generateSuggestions,
  probeWebGpuSupport,
  activateLocalHelper,
} from './inference/adapter'
import { createId } from './lib/id'
import {
  applyImportedBundle,
  clearAllDrafts,
  clearDraft,
  clearLocalData,
  createProfile,
  deleteProfile,
  downloadBackup,
  exportBackup,
  loadDraft,
  loadLocalState,
  logEvent,
  previewImport,
  saveDraft,
  saveProfile,
  setActiveProfileId,
} from './persistence/store'
import {
  listSpeechVoices,
  setPreferredVoice,
  speakAuthoredMessage,
  stopSpeaking,
  warmSpeechVoices,
} from './speech/adapter'

export function App() {
  const [profiles, setProfiles] = useState<ChildProfile[] | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [message, setMessage] = useState<AuthoredToken[]>([])
  const [speaking, setSpeaking] = useState(false)
  const [carerOpen, setCarerOpen] = useState(false)
  const [helperStatus, setHelperStatus] = useState<HelperStatus>('off')
  const [downloadProgress, setDownloadProgress] = useState<string | undefined>(undefined)
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [usedModel, setUsedModel] = useState(false)
  const [suggestionContextKey, setSuggestionContextKey] = useState<string | null>(null)
  const [offline, setOffline] = useState(() =>
    typeof navigator !== 'undefined' ? navigator.onLine === false : false,
  )
  const [voices, setVoices] = useState(listSpeechVoices())
  const [retryNonce, setRetryNonce] = useState(0)
  const [importRequest, setImportRequest] = useState<ImportRequestState>({ status: 'idle' })
  /**
   * The destructive store operation currently in flight, if any. While one is
   * pending the carer drawer locks its controls (visible disabled busy UI), so
   * a restore, erase or delete can never overlap another mutating action.
   */
  const [busyOp, setBusyOp] = useState<'restoring' | 'erasing' | 'deleting' | null>(null)
  const [liveText, setLiveText] = useState('Board ready. Tap a word. Then press Speak.')
  const [storageWarning, setStorageWarning] = useState<string | null>(null)
  const [welcome, setWelcome] = useState<{ name: string; sprites: readonly string[]; nonce: number } | null>(
    null,
  )

  const messageRef = useRef<AuthoredToken[]>([])
  messageRef.current = message
  const generationSeq = useRef(0)
  const helperActionSeq = useRef(0)
  const speakTimer = useRef<number | null>(null)
  /** Monotonic identity of the current speech cycle; stale callbacks compare against it. */
  const speakCycle = useRef(0)
  /** Exact joined text of the utterance belonging to the active cycle. */
  const spokenText = useRef<string | null>(null)
  const sessionLogged = useRef(false)
  const welcomeSeq = useRef(0)
  const profilesRef = useRef<ChildProfile[] | null>(null)
  const activeIdRef = useRef<string | null>(null)

  const reportPersistenceFailure = useCallback(() => {
    const notice =
      'For a carer: this device could not save the last change. The current board still works; anything that changed on screen may revert after closing or reloading. Please try again.'
    setStorageWarning(notice)
    setLiveText(notice)
  }, [])

  const profile = useMemo(
    () => profiles?.find((row) => row.id === activeId) ?? null,
    [profiles, activeId],
  )
  profilesRef.current = profiles
  activeIdRef.current = activeId

  const deterministicContext = useMemo(
    () =>
      profile
        ? {
            board: selectBoard(profile, profile.extraWords),
            favourites: personalFavouriteTokens(profile, profile.extraWords, {
              visibleBoard: selectBoard(profile, profile.extraWords),
            }),
          }
        : null,
    [profile],
  )
  const deterministicSuggestions = useMemo(
    () =>
      profile && deterministicContext
        ? buildDeterministicSuggestions(profile, message, deterministicContext)
        : [],
    [profile, deterministicContext, message],
  )
  const currentSuggestionContextKey = useMemo(
    () => (profile ? getSuggestionContextKey(profile, message) : null),
    [profile, message],
  )

  // Model rows belong to exactly one child/routine/message context. If that
  // context changes, render the newly computed instant phrases immediately;
  // the previous model rows must not remain tappable for even one refresh.
  const presentedSuggestions =
    helperStatus === 'ready' && suggestionContextKey === currentSuggestionContextKey
      ? suggestions
      : deterministicSuggestions
  const presentedUsedModel =
    helperStatus === 'ready' &&
    suggestionContextKey === currentSuggestionContextKey &&
    usedModel

  const board = useMemo(
    () => (profile ? selectBoard(profile, profile.extraWords) : null),
    [profile],
  )
  const extraEntriesById = useMemo(() => {
    const map = new Map<string, ReturnType<typeof getVocabById>>()
    for (const entry of extraWordEntries(profile?.extraWords ?? [])) map.set(entry.id, entry)
    return map
  }, [profile])

  // Deterministic suggestions are recomputed synchronously whenever the board
  // context moves and the model is not in charge; they are also the honest
  // fallback while downloading, degraded, unavailable or switched off.
  useEffect(() => {
    if (!profile || helperStatus === 'ready') return
    setSuggestions(deterministicSuggestions)
    setSuggestionContextKey(currentSuggestionContextKey)
    setUsedModel(false)
  }, [profile, helperStatus, deterministicSuggestions, currentSuggestionContextKey])

  const contextFor = useCallback((active: ChildProfile) => {
    const board = selectBoard(active, active.extraWords)
    return {
      board,
      favourites: personalFavouriteTokens(active, active.extraWords, { visibleBoard: board }),
    }
  }, [])

  const refreshSuggestions = useCallback(
    async (active: ChildProfile, nextMessage: AuthoredToken[], status: HelperStatus) => {
      const seq = ++generationSeq.current
      const contextKey = getSuggestionContextKey(active, nextMessage)
      const fallback = buildDeterministicSuggestions(
        active,
        nextMessage,
        contextFor(active),
      )
      // Safe since the streaming lifecycle fix: interrupts an in-flight request
      // only; idle engines are untouched, so the next first generation cannot
      // hit the runtime's stale-interrupt abort.
      cancelActiveGeneration()
      // Never leave a model-ranked row from the previous context active while
      // the next bounded ranking request is in flight. Instant phrases remain
      // fully available throughout the (up to 25 second) refresh.
      setSuggestions(fallback)
      setSuggestionContextKey(contextKey)
      setUsedModel(false)
      if (status !== 'ready') {
        return
      }
      const result = await generateSuggestions(
        active,
        nextMessage,
        buildModelInput(active, nextMessage, active.extraWords),
        status,
        fallback,
      )
      // Discard stale responses: the context moved on while the model was
      // thinking, so its output must never reach the dock.
      if (seq !== generationSeq.current) return
      if (!messagesMatch(cloneMessage(nextMessage), messageRef.current)) return
      setSuggestions(result.suggestions)
      setSuggestionContextKey(contextKey)
      setUsedModel(result.usedModel)
      if (result.status !== status) {
        setHelperStatus(result.status)
        // The live region must never keep claiming on-device suggestions
        // after a degraded or unavailable round.
        if (result.status === 'degraded') {
          setLiveText('OwnSay Intelligence had trouble. Instant phrases are being used.')
        } else if (result.status === 'unavailable') {
          setLiveText('OwnSay Intelligence is unavailable. Instant phrases are being used.')
        }
      }
    },
    [],
  )

  useEffect(() => {
    const refreshVoices = () => setVoices(listSpeechVoices())
    // Delayed voice lists announce themselves on speechSynthesis — never on
    // window — so subscribe there with guarded add/remove.
    const synth = typeof window !== 'undefined' ? window.speechSynthesis : null
    const subscribeVoices = () => {
      try {
        synth?.addEventListener('voiceschanged', refreshVoices)
      } catch {
        // Absent listener support is fine; warm-up already covered it.
      }
    }
    const unsubscribeVoices = () => {
      try {
        synth?.removeEventListener('voiceschanged', refreshVoices)
      } catch {
        // Best-effort cleanup.
      }
    }
    subscribeVoices()
    // Close the render-to-effect race: a voice may become available after the
    // state initializer but before this listener is attached. Subscribe first,
    // then take a fresh snapshot so carer UI and speak-time resolution agree.
    refreshVoices()
    warmSpeechVoices()
    let cancelled = false
    void loadLocalState().then((state) => {
      if (cancelled) return
      // The on-device model is never loaded by an ordinary page load; if it was
      // enabled before, the panel offers one deliberate wake instead.
      setProfiles(state.profiles)
      setActiveId(state.activeProfileId)
      setHelperStatus('off')
      setDownloadProgress(undefined)
      if (state.persistenceError) reportPersistenceFailure()
      const active = state.profiles.find((row) => row.id === state.activeProfileId) ?? null
      setSuggestions(
        buildDeterministicSuggestions(
          active ?? { ...DEFAULT_PREFERENCES, interests: [...DEFAULT_PREFERENCES.interests] },
          [],
        ),
      )
      // Genuine-session welcome: the stored active profile greets its
      // child once per tab session. Reloads, routine changes, rotation and
      // resume never replay it.
      if (active?.welcomeCelebration) celebrateIfEnabled(active)
      // Phrase recovery: an evicted renderer restores this child's composed
      // words through the canonical resolver — stale or tampered tokens are
      // dropped before they could ever be spoken.
      if (active) {
        const extrasById = new Map(
          extraWordEntries(active.extraWords).map((entry) => [
            entry.id.replace(EXTRA_WORD_PREFIX, ''),
            entry,
          ]),
        )
        setMessage(
          loadDraft(active.id, (tokenId) => {
            const entry =
              getVocabById(tokenId) ??
              (tokenId.startsWith('extra:')
                ? extrasById.get(tokenId.slice(EXTRA_WORD_PREFIX.length))
                : undefined)
            return entry ? { label: entry.label, category: entry.category } : undefined
          }),
        )
      }
      if (!sessionLogged.current) {
        sessionLogged.current = true
        void logEvent({ mode: 'child', status: 'session-start' })
      }
    })
    const goOnline = () => setOffline(false)
    const goOffline = () => setOffline(true)
    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)
    return () => {
      cancelled = true
      unsubscribeVoices()
      window.removeEventListener('online', goOnline)
      window.removeEventListener('offline', goOffline)
    }
  }, [reportPersistenceFailure])

  useEffect(() => {
    setPreferredVoice(profile?.voiceURI ?? null)
  }, [profile])

  // Persist the composed phrase the moment it changes — never only at unload —
  // so process eviction cannot lose a child's words.
  useEffect(() => {
    if (!activeId) return
    saveDraft(activeId, message)
  }, [activeId, message])

  useEffect(() => {
    if (!profile) return
    void refreshSuggestions(profile, message, helperStatus)
  }, [profile, message, helperStatus, retryNonce, refreshSuggestions])

  const clearSpeakTimer = useCallback(() => {
    if (speakTimer.current !== null) {
      window.clearTimeout(speakTimer.current)
      speakTimer.current = null
    }
  }, [])

  /**
   * Invalidates the active speech cycle, cancels synthesis and leaves honest
   * visible state. Used by Stop, profile switch, page hide, pagehide,
   * teardown, rail mutations and the safety timer — every boundary that must
   * not leave a stale callback able to flip the UI back to "speaking".
   */
  const resetSpeechAtBoundary = useCallback(() => {
    speakCycle.current += 1
    spokenText.current = null
    stopSpeaking()
    clearSpeakTimer()
    setSpeaking(false)
  }, [clearSpeakTimer])

  /**
   * Cancels an active utterance inside the user-action handler, before the
   * rail mutation is enqueued. The passive rail watcher below remains a
   * backstop for restored/programmatic changes, but a child must never hear
   * stale words for even one browser turn after changing the visible phrase.
   */
  const cancelSpeechForRailMutation = useCallback(() => {
    if (spokenText.current !== null) resetSpeechAtBoundary()
  }, [resetSpeechAtBoundary])

  useEffect(() => clearSpeakTimer, [clearSpeakTimer])

  // A hidden tab, backgrounded renderer or closed page must never leave
  // speech running or resumable.
  useEffect(() => {
    const cancelSpeech = () => resetSpeechAtBoundary()
    const onHide = () => {
      if (document.hidden) cancelSpeech()
    }
    window.addEventListener('pagehide', cancelSpeech)
    document.addEventListener('visibilitychange', onHide)
    return () => {
      window.removeEventListener('pagehide', cancelSpeech)
      document.removeEventListener('visibilitychange', onHide)
    }
  }, [resetSpeechAtBoundary])

  // Any mutation that would make the visible rail differ from the text being
  // spoken (add, remove, delete-last, Clear, suggestion append, draft restore)
  // invalidates and cancels the active cycle instead of speaking stale words.
  useEffect(() => {
    if (!speaking || spokenText.current === null) return
    if (messageRef.current.map((token) => token.label).join(' ') !== spokenText.current) {
      resetSpeechAtBoundary()
    }
  }, [message, speaking, resetSpeechAtBoundary])

  useEffect(
    () => () => {
      resetSpeechAtBoundary()
      helperActionSeq.current += 1
      generationSeq.current += 1
      cancelActiveGeneration()
      deactivateLocalHelper()
    },
    [resetSpeechAtBoundary],
  )

  const addToken = useCallback(
    (tokenId: string, provenance: Provenance) => {
      const entry = getVocabById(tokenId) ?? extraEntriesById.get(tokenId)
      if (!entry) return
      cancelSpeechForRailMutation()
      setMessage((current) => [
        ...current,
        {
          instanceId: createId('tok'),
          tokenId: entry.id,
          label: entry.label,
          provenance,
          category: entry.category,
        },
      ])
      setLiveText(`${entry.label} added`)
      void logEvent({ mode: 'child', status: 'tile' })
    },
    [cancelSpeechForRailMutation, extraEntriesById],
  )

  const speak = useCallback(() => {
    const labels = message.map((token) => token.label)
    if (labels.length === 0) return
    clearSpeakTimer()
    const text = labels.join(' ')
    const cycle = ++speakCycle.current
    let started = false
    try {
      started = speakAuthoredMessage(labels, () => {
        // Stale callback from a prior (or already-invalidated) cycle: ignored.
        if (speakCycle.current !== cycle) return
        // Close this cycle first so a synchronous end can never be followed
        // by "Speaking …" or a freshly armed timeout.
        speakCycle.current += 1
        spokenText.current = null
        clearSpeakTimer()
        setSpeaking(false)
      })
    } catch {
      started = false
    }
    if (!started || speakCycle.current !== cycle) {
      if (speakCycle.current === cycle) {
        speakCycle.current += 1
        spokenText.current = null
      }
      setSpeaking(false)
      setLiveText('Speech could not start on this device. The words stay on the rail.')
      void logEvent({ mode: 'child', status: 'speak-not-started' })
      return
    }
    spokenText.current = text
    setSpeaking(true)
    setLiveText(`Speaking ${text}`)
    void logEvent({ mode: 'child', status: 'speak' })
    // Safety net: if the synthesiser never fires its end event, genuinely
    // cancel it (guarded by cycle identity) and leave an honest visible state
    // instead of a UI that claims speech while silence runs.
    speakTimer.current = window.setTimeout(() => {
      if (speakCycle.current !== cycle) return
      resetSpeechAtBoundary()
      setLiveText('Speech may have stalled, so it was stopped.')
    }, Math.min(12000, 700 + labels.length * 700))
  }, [message, clearSpeakTimer, resetSpeechAtBoundary])

  const stop = useCallback(() => {
    resetSpeechAtBoundary()
    setLiveText('Speech stopped')
    void logEvent({ mode: 'child', status: 'stop-speech' })
  }, [resetSpeechAtBoundary])

  const closeCarer = useCallback(() => setCarerOpen(false), [])

  const updateProfile = useCallback(
    (next: ChildProfile) => {
      setProfiles((current) =>
        current ? current.map((row) => (row.id === next.id ? next : row)) : current,
      )
      void saveProfile(next).catch(reportPersistenceFailure)
      void logEvent({ mode: 'carer', status: 'profile-update' })
    },
    [reportPersistenceFailure],
  )

  /**
   * Merges a partial profile update into the LATEST state of the given child.
   * Async helper lifecycle events must never resurrect a captured snapshot
   * over edits a carer made while a download was in flight.
   */
  const patchProfileById = useCallback(
    (id: string | null, patch: Partial<ChildProfile>) => {
      if (!id) return
      const current = profilesRef.current?.find((row) => row.id === id)
      if (!current) return
      const next = { ...current, ...patch }
      setProfiles((rows) => (rows ? rows.map((row) => (row.id === next.id ? next : row)) : null))
      void saveProfile(next).catch(reportPersistenceFailure)
    },
    [reportPersistenceFailure],
  )

  /**
   * The welcome moment runs only after this child's board was chosen on
   * purpose (fresh demo setup or a deliberate switch). It is visual only:
   * it never speaks, appends words or changes routine.
   */
  const celebrateIfEnabled = useCallback((target: ChildProfile | null | undefined) => {
    if (!target?.welcomeCelebration) return
    // One welcome per tab session per child, recorded at the single choke
    // point so deliberate choices and session loads share the same rule.
    if (typeof sessionStorage !== 'undefined') {
      const key = `ownsay-welcomed:${target.id}`
      if (sessionStorage.getItem(key)) return
      try {
        sessionStorage.setItem(key, '1')
      } catch {
        // Storage may be unavailable; still greet this once now.
      }
    }
    setWelcome({
      name: target.nickname,
      sprites: target.welcomeSprites ?? [],
      nonce: ++welcomeSeq.current,
    })
  }, [])

  const dismissWelcome = useCallback(() => setWelcome(null), [])

  const commitProfileSwitch = useCallback(
    (nextId: string, childName?: string, celebrate?: ChildProfile | null) => {
      generationSeq.current += 1
      helperActionSeq.current += 1
      deactivateLocalHelper()
      // A deliberate switch clears the outgoing child's draft with their rail:
      // the next child must never see it, and returning starts fresh.
      if (activeId) clearDraft(activeId)
      setActiveId(nextId)
      void setActiveProfileId(nextId).catch(reportPersistenceFailure)
      setMessage([])
      setHelperStatus('off')
      setUsedModel(false)
      setDownloadProgress(undefined)
      celebrateIfEnabled(celebrate)

      setLiveText(childName ? `This is ${childName}’s board now.` : 'Switched board. Words and settings updated.')
    },
    [activeId, celebrateIfEnabled, reportPersistenceFailure],
  )

  const switchProfile = useCallback(
    (nextId: string, childName?: string, celebrate?: ChildProfile | null) => {
      resetSpeechAtBoundary()
      commitProfileSwitch(nextId, childName, celebrate)
    },
    [commitProfileSwitch, resetSpeechAtBoundary],
  )

  const addProfile = useCallback(
    (input: { nickname: string; ageBand: AgeBand }) => {
      resetSpeechAtBoundary()
      const created = createProfile(input)
      void saveProfile(created).catch(reportPersistenceFailure)
      setProfiles((current) => orderProfilesForDisplay(current ? [...current, created] : [created]))
      commitProfileSwitch(created.id, created.nickname)
      void logEvent({ mode: 'carer', status: 'profile-added' })
    },
    [commitProfileSwitch, reportPersistenceFailure, resetSpeechAtBoundary],
  )

  const removeProfile = useCallback(
    (profileId: string) => {
      const remaining = (profiles ?? []).filter((row) => row.id !== profileId)
      const removingActiveProfile = profileId === activeId
      if (removingActiveProfile) resetSpeechAtBoundary()
      setBusyOp('deleting')
      void deleteProfile(profileId)
        .then(() => {
          setProfiles(remaining)
          if (removingActiveProfile) {
            if (remaining.length > 0) {
              commitProfileSwitch(remaining[0].id, remaining[0].nickname)
            } else {
              helperActionSeq.current += 1
              generationSeq.current += 1
              deactivateLocalHelper()
              setActiveId(null)
              setMessage([])
              setSuggestions([])
              setHelperStatus('off')
              setUsedModel(false)
              setDownloadProgress(undefined)
            }
          }
          setLiveText('Board removed.')
          void logEvent({ mode: 'carer', status: 'profile-removed' })
        })
        .catch(reportPersistenceFailure)
        .finally(() => setBusyOp(null))
    },
    [activeId, commitProfileSwitch, profiles, reportPersistenceFailure, resetSpeechAtBoundary],
  )

  const handleCreateFirstProfile = useCallback((input: { nickname: string; ageBand: AgeBand }) => {
    resetSpeechAtBoundary()
    const created = createProfile(input)
    void saveProfile(created)
      .then(() => setActiveProfileId(created.id))
      .catch(reportPersistenceFailure)
    setProfiles([created])
    setActiveId(created.id)
    setSuggestions([])
    setLiveText(`Welcome, ${created.nickname}. Tap a word. Then press Speak.`)
    void logEvent({ mode: 'carer', status: 'first-profile' })
  }, [reportPersistenceFailure, resetSpeechAtBoundary])

  /**
   * Fresh-install demo entry: creates both fictional boards as ordinary local
   * profiles (never overwriting anything — this path only runs with zero
   * profiles) and hands the chosen child their board immediately.
   */
  const handleSelectDemoProfile = useCallback(
    (key: DemoProfileKey) => {
      resetSpeechAtBoundary()
      const created = DEMO_PROFILE_KEYS.map((starterKey) => createDemoProfile(DEMO_PROFILES[starterKey]))
      const chosen = created.find((profile) => profile.nickname === DEMO_PROFILES[key].nickname)
      if (!chosen) return
      void Promise.all(created.map((profile) => saveProfile(profile)))
        .then(() => setActiveProfileId(chosen.id))
        .catch(reportPersistenceFailure)
      setProfiles(orderProfilesForDisplay(created))
      setActiveId(chosen.id)
      setMessage([])
      setHelperStatus('off')
      setUsedModel(false)
      setSuggestions(buildDeterministicSuggestions(chosen, []))
      celebrateIfEnabled(chosen)
      setLiveText(`Hello ${chosen.nickname}. Tap a word. Then press Speak.`)
      void logEvent({ mode: 'carer', status: 'demo-profile' })
    },
    [celebrateIfEnabled, reportPersistenceFailure, resetSpeechAtBoundary],
  )

  /** Deliberate, idempotent restore of the two fictional demo boards. */
  const restoreDemoProfiles = useCallback(() => {
    const missing = findMissingDemoProfiles(profiles ?? [])
    if (missing.length === 0) {
      setLiveText('Alex’s and Sam’s boards are already here.')
      return
    }
    const created = missing.map((spec) => createDemoProfile(spec))
    void Promise.all(created.map((profile) => saveProfile(profile))).catch(reportPersistenceFailure)
    setProfiles((current) => orderProfilesForDisplay([...(current ?? []), ...created]))
    const names = missing.map((spec) => spec.nickname)
    setLiveText(
      missing.length > 1
        ? `${names[0]} and ${names[1]}’s boards are ready. Switch boards to open them.`
        : `${names[0]}’s board is ready.`,
    )
    void logEvent({ mode: 'carer', status: 'demo-restored' })
  }, [profiles, reportPersistenceFailure])

  const setupIntelligence = useCallback(() => {
    // Read the LATEST active child through refs: this callback must stay
    // stable yet never act on a stale (or boot-time null) profile snapshot.
    const active = profilesRef.current?.find((row) => row.id === activeIdRef.current)
    if (!active) return
    const action = ++helperActionSeq.current
    // Capability preflight runs BEFORE any runtime import or model download:
    // on unsupported hardware (Fire tablets without WebGPU) nothing is ever
    // fetched and the carer sees one honest, concise result.
    setLiveText('Checking this device for OwnSay Intelligence…')
    void probeWebGpuSupport().then((probe) => {
      if (action !== helperActionSeq.current) return
      if (probe !== 'ok') {
        patchProfileById(activeIdRef.current, { helperEnabled: false })
        setHelperStatus('unsupported')
        setDownloadProgress(undefined)
        setLiveText(
          probe === 'device-policy'
            ? 'This Fire tablet cannot run the optional helper. Instant phrases stay ready.'
            : 'This tablet does not support the on-device helper. Instant phrases stay ready.',
        )
        void logEvent({ mode: 'carer', status: `intelligence-unsupported-${probe}` })
        return
      }
      setHelperStatus('downloading')
      setDownloadProgress('Preparing download…')
      setLiveText('OwnSay Intelligence downloading')
      patchProfileById(activeIdRef.current, { helperEnabled: true })
      void activateLocalHelper((text) => {
        if (action === helperActionSeq.current) setDownloadProgress(text)
      }).then((status) => {
        if (action !== helperActionSeq.current) return
        setDownloadProgress(undefined)
        // Merge into the LATEST profile: a carer may have edited settings
        // while the download ran.
        if (status !== 'ready') {
          setHelperStatus(status === 'off' ? 'off' : 'unavailable')
          patchProfileById(activeIdRef.current, { helperEnabled: false })
          setLiveText('OwnSay Intelligence unavailable. Instant phrases are still ready.')
        } else {
          setHelperStatus('ready')
          setLiveText('OwnSay Intelligence ready. Suggestions are chosen on this device.')
        }
        void logEvent({ mode: 'carer', status: `intelligence-${status}` })
      })
    })
  }, [patchProfileById])

  const cancelIntelligenceDownload = useCallback(() => {
    helperActionSeq.current += 1
    deactivateLocalHelper()
    setHelperStatus('off')
    setDownloadProgress(undefined)
    // A cancelled first download also reverts the opt-in choice.
    patchProfileById(activeIdRef.current, { helperEnabled: false })
    setLiveText('Download cancelled. Instant phrases are still ready.')
    void logEvent({ mode: 'carer', status: 'intelligence-cancelled' })
  }, [patchProfileById])

  const disableIntelligence = useCallback(() => {
    helperActionSeq.current += 1
    generationSeq.current += 1
    deactivateLocalHelper()
    setHelperStatus('off')
    setUsedModel(false)
    patchProfileById(activeIdRef.current, { helperEnabled: false })
    setLiveText('OwnSay Intelligence off. Instant phrases are still ready.')
    void logEvent({ mode: 'carer', status: 'intelligence-off' })
  }, [patchProfileById])

  const retryIntelligence = useCallback(() => {
    if (helperStatus === 'unavailable' || helperStatus === 'unsupported') {
      // Unsupported hardware may gain support via a system update: re-probe.
      setHelperStatus('off')
      setupIntelligence()
      return
    }
    // Degraded: the engine exists; give generation another chance immediately.
    setHelperStatus('ready')
    setRetryNonce((nonce) => nonce + 1)
    setLiveText('Trying OwnSay Intelligence again.')
  }, [helperStatus, setupIntelligence])

  if (!profiles) {
    return (
      <div className="boot-splash" role="status" aria-live="polite">
        Getting your words ready…
      </div>
    )
  }

  if (!profile || !board) {
    return <Onboarding onCreate={handleCreateFirstProfile} onSelectDemoProfile={handleSelectDemoProfile} />
  }

  return (
    <>
      {welcome ? (
        <WelcomeCelebration
          key={welcome.nonce}
          childName={welcome.name}
          spriteKeys={welcome.sprites}
          onComplete={dismissWelcome}
        />
      ) : null}
      <AppShell
        prefs={profile}
        childName={profile.nickname}
        offline={offline}
        liveText={liveText}
        storageWarning={storageWarning}
        isolatedFromAT={carerOpen}
        onDismissStorageWarning={() => setStorageWarning(null)}
        onOpenCarer={() => {
          setCarerOpen(true)
          void logEvent({ mode: 'carer', status: 'open' })
        }}
        onRoutine={(routine: Routine) => {
          updateProfile({ ...profile, routine })
          const world = ROUTINE_META[routine]
          setLiveText(`${world.world}. ${ROUTINE_LABELS[routine]} words ready.`)
        }}
      >
        <MessageRail
          tokens={message}
          speaking={speaking}
          onSpeak={speak}
          onStop={stop}
          onDeleteLast={() => {
            cancelSpeechForRailMutation()
            setMessage((current) => current.slice(0, -1))
            setLiveText('Last word removed')
          }}
          onClear={() => {
            cancelSpeechForRailMutation()
            setMessage([])
            setLiveText('Message cleared')
          }}
          onRemove={(instanceId) => {
            cancelSpeechForRailMutation()
            setMessage((current) => current.filter((token) => token.instanceId !== instanceId))
            setLiveText('Word removed')
          }}
        />
        <Board
          board={board}
          density={profile.accessDensity}
          prefs={profile}
          onSelect={(id, source) => addToken(id, source)}
        />
        <IntelligencePanel
          status={helperStatus}
          helperEnabled={profile.helperEnabled}
          progress={downloadProgress}
        />
        <SuggestionDock
          suggestions={presentedSuggestions}
          usedModel={presentedUsedModel}
          onChoose={(suggestion) => {
            cancelSpeechForRailMutation()
            setMessage((current) =>
              appendSuggestionTokens(current, suggestion, () => createId('tok'), (id) => {
                const entry =
                  getVocabById(id) ??
                  board?.core.find((tile) => tile.id === id) ??
                  board?.fringe.find((tile) => tile.id === id)
                return entry ? { label: entry.label, category: entry.category } : undefined
              }),
            )
            setLiveText(`Suggestion added: ${suggestion.tokens.map((token) => token.label).join(' ')}`)
            void logEvent({ mode: 'child', status: 'suggestion' })
          }}
        />
      </AppShell>
      <CarerDrawer
        open={carerOpen}
        profile={profile}
        busy={busyOp}
        helperStatus={helperStatus}
        helperProgress={downloadProgress}
        onSetupHelper={setupIntelligence}
        onCancelHelperDownload={cancelIntelligenceDownload}
        onDisableHelper={disableIntelligence}
        onRetryHelper={retryIntelligence}
        profiles={profiles}
        voices={voices}
        importRequest={importRequest}
        onClose={closeCarer}
        onChangeProfile={updateProfile}
        onSwitchProfile={(nextId) => {
          const next = profiles.find((row) => row.id === nextId)
          switchProfile(nextId, next?.nickname, next)
          setCarerOpen(false)
        }}
        onAddProfile={addProfile}
        onRemoveProfile={removeProfile}
        onRestoreDemoProfiles={restoreDemoProfiles}
        onExport={() => {
          void exportBackup()
            .then((bundle) => {
              downloadBackup(bundle)
              setLiveText('Backup downloaded')
            })
            .catch(() => setLiveText('Backup could not be created'))
          void logEvent({ mode: 'carer', status: 'export' })
        }}
        onImportFile={(file, fileName, oversized) => {
          if (oversized) {
            setImportRequest({
              status: 'error',
              fileName,
              message: 'That file is too large to be an OwnSay backup.',
            })
            void logEvent({ mode: 'carer', status: 'import-rejected' })
            return
          }
          void file.text().then((text) => {
            try {
              const preview = previewImport(text)
              setImportRequest({ status: 'preview', fileName, preview })
              void logEvent({ mode: 'carer', status: 'import-preview' })
            } catch (error) {
              setImportRequest({
                status: 'error',
                fileName,
                message: error instanceof Error ? error.message : undefined,
              })
              void logEvent({ mode: 'carer', status: 'import-rejected' })
            }
          })
        }}
        onImportConfirm={() => {
          if (importRequest.status !== 'preview' || !importRequest.preview) return
          if (busyOp) return
          const bundle = importRequest.preview.bundle
          const orderedProfiles = orderProfilesForDisplay(bundle.profiles)
          resetSpeechAtBoundary()
          helperActionSeq.current += 1
          generationSeq.current += 1
          deactivateLocalHelper()
          setHelperStatus('off')
          setUsedModel(false)
          setMessage([])
          setBusyOp('restoring')
          void applyImportedBundle(bundle).then(() => {
            // Imported profile ids replace the old ones: no draft can survive.
            clearAllDrafts()
            setProfiles(orderedProfiles)
            commitProfileSwitch(orderedProfiles[0].id, orderedProfiles[0].nickname)
            setImportRequest({ status: 'idle' })
            setLiveText('Backup restored. Boards replaced.')
            void logEvent({ mode: 'carer', status: 'import-applied' })
          }).catch(() => {
            setImportRequest({
              status: 'error',
              fileName: importRequest.fileName,
              message: 'The backup could not be restored.',
            })
          }).finally(() => setBusyOp(null))
        }}
        onImportCancel={() => setImportRequest({ status: 'idle' })}
        onClear={() => {
          if (busyOp) return
          resetSpeechAtBoundary()
          helperActionSeq.current += 1
          generationSeq.current += 1
          deactivateLocalHelper()
          setHelperStatus('off')
          setUsedModel(false)
          setDownloadProgress(undefined)
          setImportRequest({ status: 'idle' })
          setMessage([])
          setLiveText('Clearing local data')
          setBusyOp('erasing')
          void clearLocalData()
            .then(() => {
              setProfiles([])
              setActiveId(null)
              setCarerOpen(false)
              setLiveText('This device has been cleared. Set up a board to start again.')
            })
            .catch(() => setLiveText('Local data could not be fully erased. Close other OwnSay tabs and try again.'))
            .finally(() => setBusyOp(null))
        }}
      />
    </>
  )
}

function messagesMatch(a: readonly AuthoredToken[], b: readonly AuthoredToken[]): boolean {
  if (a.length !== b.length) return false
  return a.every((token, index) => token.instanceId === b[index]?.instanceId && token.tokenId === b[index]?.tokenId)
}

function getSuggestionContextKey(
  active: ChildProfile,
  nextMessage: readonly AuthoredToken[],
): string {
  const input = buildModelInput(active, nextMessage, active.extraWords)
  return JSON.stringify([
    active.id,
    input.ageBand,
    input.routine,
    input.interests,
    input.currentTokenIds,
    input.allowlist,
  ])
}
