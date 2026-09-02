import {
  ACCESS_DENSITIES,
  AGE_BANDS,
  DEFAULT_PREFERENCES,
  INTERESTS,
  ROUTINES,
  TOKEN_CATEGORIES,
  type AccessDensity,
  type AgeBand,
  type AuthoredToken,
  type ChildProfile,
  type DemoPreferences,
  type EventLogEntry,
  type Interest,
  type Routine,
} from '../domain/types'
import { PROTECTED_CORE_ENTRIES } from '../domain/protected-core'
import { orderProfilesForDisplay } from '../domain/demo-profiles'
import {
  EXTRA_WORD_LABEL_LIMIT,
  NICKNAME_LIMIT,
  normaliseExtraWord,
  normaliseNickname,
} from '../domain/profile-text'
import { isKnownIconId } from '../icons/registry'
import { isWelcomeSpriteKey } from '../domain/welcome-sprites'
import { createId } from '../lib/id'

const DB_NAME = 'ownsay-aac'
const DB_VERSION = 2
const PROFILE_STORE = 'profiles'
const META_STORE = 'meta'
const EVENT_STORE = 'events'
const ACTIVE_PROFILE_KEY = 'activeProfileId'

export const EXTRA_WORD_LIMIT = 12
export { EXTRA_WORD_LABEL_LIMIT, NICKNAME_LIMIT }

/**
 * The only retention rule for interaction events, applied identically in
 * memory, in IndexedDB and in every export/import: keep the newest 400 and
 * discard the rest. Nothing else about an event is retained or derived.
 */
export const MAX_PERSISTENT_EVENTS = 400

/** Case-insensitive label key for personal-word collision checks. */
function labelKey(label: string): string {
  return label.trim().toLowerCase()
}

const PROTECTED_LABEL_KEYS = new Set(PROTECTED_CORE_ENTRIES.map((entry) => labelKey(entry.label)))

export interface LocalState {
  profiles: ChildProfile[]
  activeProfileId: string | null
  persistenceError?: boolean
}

type MemoryState = LocalState & {
  events: EventLogEntry[]
}

const memory: MemoryState = {
  profiles: [],
  activeProfileId: null,
  events: [],
}

function canUseIdb(): boolean {
  return typeof indexedDB !== 'undefined'
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    let settled = false
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(PROFILE_STORE)) db.createObjectStore(PROFILE_STORE, { keyPath: 'id' })
      if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE)
      if (!db.objectStoreNames.contains(EVENT_STORE)) db.createObjectStore(EVENT_STORE, { keyPath: 'id' })
    }
    request.onsuccess = () => {
      if (settled) {
        request.result.close()
        return
      }
      settled = true
      resolve(request.result)
    }
    request.onerror = () => {
      if (settled) return
      settled = true
      reject(request.error ?? new Error('IndexedDB open failed'))
    }
    request.onblocked = () => {
      if (settled) return
      settled = true
      reject(new Error('IndexedDB open blocked'))
    }
  })
}

function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'))
  })
}

function idbTransaction(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'))
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'))
  })
}

// ---------------------------------------------------------------------------
// Write serialization
//
// Every IndexedDB mutation and every destructive boundary (import, erase,
// delete) runs inside this one module-level FIFO. A fire-and-forget write
// therefore always finishes — commit or rejection — before a later import or
// erase begins, so a slow tap can never resurrect data those boundaries just
// removed. Operations never enqueue from inside a running operation, so nesting
// cannot deadlock, and a rejected operation is swallowed from the chain (while
// still rejecting its own caller) so the queue keeps flowing.
// ---------------------------------------------------------------------------

let queuedWrites: Promise<void> = Promise.resolve()
const queuedProfileWriteCounts = new Map<string, number>()

function enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
  const attempt = queuedWrites.then(operation)
  queuedWrites = attempt.then(
    () => undefined,
    () => undefined,
  )
  return attempt
}

/**
 * Tracks an accepted profile id from its synchronous call site until its FIFO
 * turn settles. A destructive boundary can therefore tombstone even a brand-
 * new profile whose save is still queued and not yet visible in memory.
 */
function enqueueProfileWrite<T>(profileId: string, operation: () => Promise<T>): Promise<T> {
  queuedProfileWriteCounts.set(profileId, (queuedProfileWriteCounts.get(profileId) ?? 0) + 1)
  const release = (): void => {
    const remaining = (queuedProfileWriteCounts.get(profileId) ?? 1) - 1
    if (remaining > 0) queuedProfileWriteCounts.set(profileId, remaining)
    else queuedProfileWriteCounts.delete(profileId)
  }
  return enqueueWrite(operation).then(
    (result) => {
      release()
      return result
    },
    (error: unknown) => {
      release()
      throw error
    },
  )
}

function profileIdsKnownBeforeBoundary(): string[] {
  return [...new Set([...memory.profiles.map((profile) => profile.id), ...queuedProfileWriteCounts.keys()])]
}

/** Resolves once every write enqueued before this call has settled. */
function waitForQueuedWrites(): Promise<void> {
  return queuedWrites
}

// ---------------------------------------------------------------------------
// Destructive-boundary exclusion
//
// The FIFO alone cannot stop resurrection: a restore/erase/delete only removes
// rows when its turn comes, so a write INVOKED after the boundary was
// scheduled would queue behind it and re-commit stale data afterwards. Two
// synchronous invariants close that hole:
//
// 1. Exclusion window — from the moment a boundary is called until it settles,
//    ordinary writes invoked by any code path are refused on the spot instead
//    of being enqueued, and a second boundary is rejected outright.
// 2. Delete tombstones — profile ids removed by a completed delete, erase or
//    import are remembered for the rest of the session; writes carrying such
//    an id are refused even long after the boundary finished. A failed
//    boundary releases exactly the tombstones it added (the boards demonstrably
//    remain), and a successful import un-tombstones ids it brought back.
//
// New profiles always receive fresh random ids, so normal creation after a
// completed erase is untouched.
// ---------------------------------------------------------------------------

type BoundaryKind = 'restore' | 'erase' | 'delete'

let activeBoundary: BoundaryKind | null = null
const tombstonedProfileIds = new Set<string>()

/**
 * Runs one destructive boundary with the exclusion window held from the
 * synchronous call site to settlement. Returns a rejected promise if another
 * boundary already owns the stores. On success, `onCommit` may adjust
 * tombstones (e.g. release ids an import legitimately restored); on failure,
 * `rollbackIds` releases exactly the ids this boundary had tombstoned.
 */
function runBoundary(
  kind: BoundaryKind,
  operation: () => Promise<void>,
  hooks: { tombstone?: readonly string[]; restore?: readonly string[] } = {},
): Promise<void> {
  if (activeBoundary !== null) {
    return Promise.reject(new Error(`A ${activeBoundary} is already in progress`))
  }
  activeBoundary = kind
  for (const id of hooks.tombstone ?? []) tombstonedProfileIds.add(id)
  const release = (failed: boolean): void => {
    activeBoundary = null
    if (failed) for (const id of hooks.tombstone ?? []) tombstonedProfileIds.delete(id)
    else for (const id of hooks.restore ?? []) tombstonedProfileIds.delete(id)
  }
  return enqueueWrite(operation).then(
    () => {
      release(false)
    },
    (error: unknown) => {
      release(true)
      throw error
    },
  )
}

/**
 * Synchronous gate for ordinary writes: refused while any boundary owns the
 * stores, or when the target profile id has been deleted this session.
 */
function writeAllowed(profileId?: string): boolean {
  if (activeBoundary !== null) return false
  return profileId === undefined || !tombstonedProfileIds.has(profileId)
}

/** Overlapping boundaries fail loudly so no caller can believe two happened. */
export function isBoundaryActive(): boolean {
  return activeBoundary !== null
}

// ---------------------------------------------------------------------------
// Interaction events
//
// An event records only that *something* happened: a canonical UTC timestamp,
// whether the tap came from the child or carer board, and a short fixed status
// slug. No child text, no phrase, no word-derived code and no free text is
// ever stored. Every event that enters this module — written locally, read
// back from IndexedDB, or arriving inside an imported file — passes through
// `parseEvent`, so hostile input cannot reach memory, storage or an export.
// ---------------------------------------------------------------------------

/** Event and tile ids: ASCII slugs only, so no bidi or control text survives. */
const EVENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/
const EVENT_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,47}$/
/** ISO-8601 instants only; anything else is not a timestamp we wrote. */
const EVENT_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/

/**
 * Strict contract for one interaction event. Returns null — never a repaired
 * record — for anything that is not exactly the documented shape.
 *
 * A `tileId` carrying a word-derived code is accepted for compatibility with
 * backups written by older builds, but it is validated and then STRIPPED: the
 * DJB2-style code is reversible against the finite public vocabulary, so a
 * determined reader of a backup file could recover which public word was
 * tapped. Nothing that re-enters memory, storage or an export keeps one.
 */
function parseEvent(raw: unknown): EventLogEntry | null {
  if (typeof raw !== 'object' || raw === null) return null
  const entry = raw as Record<string, unknown>
  if (typeof entry.id !== 'string' || !EVENT_ID_PATTERN.test(entry.id)) return null
  if (entry.mode !== 'child' && entry.mode !== 'carer') return null
  if (typeof entry.status !== 'string' || !EVENT_TOKEN_PATTERN.test(entry.status)) return null
  if (typeof entry.timestamp !== 'string' || !EVENT_TIMESTAMP_PATTERN.test(entry.timestamp)) return null
  const parsedTime = Date.parse(entry.timestamp)
  if (!Number.isFinite(parsedTime)) return null
  if (entry.tileId !== undefined && entry.tileId !== null) {
    // Legacy field: same strict slug contract as before, but never kept.
    if (typeof entry.tileId !== 'string' || !EVENT_TOKEN_PATTERN.test(entry.tileId)) return null
  }
  return {
    id: entry.id,
    // Canonical UTC so the retention sort is a plain lexicographic compare and
    // two devices in different time zones prune identically.
    timestamp: new Date(parsedTime).toISOString(),
    mode: entry.mode,
    status: entry.status,
  }
}

/**
 * Monotonic per-session counter folded into every generated event id.
 *
 * A burst of taps inside one millisecond shares a timestamp, so the id is what
 * orders them — and a random id orders them arbitrarily, which would make both
 * the restored log and the retention cut at 400 depend on UUID luck. The
 * counter makes the total order the order the taps actually happened in.
 */
let eventSequence = 0

function createEventId(): string {
  eventSequence += 1
  // Base-36 and zero-padded so the ids sort lexicographically, which is how
  // `compareEvents` compares them.
  const sequence = eventSequence.toString(36).padStart(4, '0')
  const unique = createId('evt')
  return `evt-${sequence}-${unique.slice('evt-'.length)}`
}

/** Total order over events: oldest first, ties broken by id. */
function compareEvents(a: EventLogEntry, b: EventLogEntry): number {
  return a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id)
}

/**
 * The single retention rule. Sorts into the total order above, keeps the first
 * record for any repeated id (earlier wins, deterministically) and returns at
 * most the newest `MAX_PERSISTENT_EVENTS`.
 */
function retainNewestEvents(events: readonly EventLogEntry[]): EventLogEntry[] {
  const seen = new Set<string>()
  const unique: EventLogEntry[] = []
  for (const event of [...events].sort(compareEvents)) {
    if (seen.has(event.id)) continue
    seen.add(event.id)
    unique.push(event)
  }
  return unique.slice(-MAX_PERSISTENT_EVENTS)
}

/**
 * Reads back the persisted events, dropping any record that no longer meets
 * the contract, and compacts the store when an older build left more than the
 * retention limit behind. Compaction is best-effort: a failure here must never
 * stop a household's boards from loading.
 */
async function readAllEvents(): Promise<EventLogEntry[]> {
  if (!canUseIdb()) return [...memory.events]
  let rows: unknown[]
  try {
    const db = await openDb()
    try {
      rows = await idbRequest<unknown[]>(
        db.transaction(EVENT_STORE, 'readonly').objectStore(EVENT_STORE).getAll(),
      )
    } finally {
      db.close()
    }
  } catch {
    return [...memory.events]
  }
  const parsed = rows.map(parseEvent).filter((row): row is EventLogEntry => row !== null)
  const retained = retainNewestEvents(parsed)
  if (parsed.length !== rows.length || retained.length !== parsed.length) {
    const keep = new Set(retained.map((event) => event.id))
    const stale: unknown[] = rows.filter((row) => {
      const event = parseEvent(row)
      return event === null || !keep.has(event.id)
    })
    await pruneStoredEvents(stale)
  }
  return retained
}

/** Deletes specific stored event rows by key. Best-effort by design. */
async function pruneStoredEvents(rows: readonly unknown[]): Promise<void> {
  if (rows.length === 0 || !canUseIdb()) return
  await enqueueWrite(async () => {
    try {
      const db = await openDb()
      try {
        const transaction = db.transaction(EVENT_STORE, 'readwrite')
        const store = transaction.objectStore(EVENT_STORE)
        for (const row of rows) {
          const id = (row as Record<string, unknown> | null)?.id
          if (typeof id === 'string') store.delete(id)
        }
        await idbTransaction(transaction)
      } finally {
        db.close()
      }
    } catch {
      // A device that will not let us prune still has a bounded in-memory log.
    }
  })
}

async function readAllProfiles(): Promise<ChildProfile[]> {
  if (!canUseIdb()) return [...memory.profiles]
  try {
    const db = await openDb()
    const rows = await idbRequest<unknown[]>(db.transaction(PROFILE_STORE, 'readonly').objectStore(PROFILE_STORE).getAll())
    db.close()
    if (rows.length > 0) {
      // Creation order keeps sibling listings stable regardless of storage
      // keys; same-millisecond ties fall back to nickname for determinism.
      // The fictional demo boards are then lifted to the front in their fixed
      // key order, so Alex and Sam never reorder because two profiles were
      // written in the same millisecond.
      const parsed = rows
        .map((row) => parseProfile(row, BACKUP_SCHEMA))
        .filter((row): row is ChildProfile => row !== null)
        .sort(
          (a, b) => a.createdAt.localeCompare(b.createdAt) || a.nickname.localeCompare(b.nickname),
        )
      return orderProfilesForDisplay(parsed)
    }
    // An empty database must not shadow profiles saved this session.
    return [...memory.profiles]
  } catch {
    return [...memory.profiles]
  }
}

export async function loadLocalState(): Promise<LocalState> {
  // A load observes every write issued so far, including fire-and-forget ones,
  // so it can never report stale storage behind a queued tap.
  await waitForQueuedWrites()
  const profiles = await readAllProfiles()
  // Interaction events are part of the local record, not a session-only tally:
  // a reload (or a Fire tablet evicting the tab) must not silently empty the
  // log that the next backup will export.
  memory.events = await readAllEvents()
  let activeProfileId: string | null = memory.activeProfileId
  if (canUseIdb() && profiles.length > 0) {
    try {
      const db = await openDb()
      activeProfileId = (await idbRequest<string | undefined>(
        db.transaction(META_STORE, 'readonly').objectStore(META_STORE).get(ACTIVE_PROFILE_KEY),
      )) ?? memory.activeProfileId
      db.close()
    } catch {
      activeProfileId = memory.activeProfileId
    }
  }

  const validActive = activeProfileId && profiles.some((profile) => profile.id === activeProfileId)
  memory.profiles = profiles
  memory.activeProfileId = validActive ? activeProfileId : (profiles[0]?.id ?? null)
  return { profiles, activeProfileId: memory.activeProfileId }
}

export function saveProfile(profile: ChildProfile): Promise<void> {
  // Validated at call time so invalid input never reaches memory or storage.
  const normalised = parseProfile(profile)
  if (!normalised) return Promise.reject(new Error('Profile contains invalid local data'))
  // A write invoked while a restore/erase/delete owns the stores — or for a
  // profile this session already deleted — is refused here, synchronously,
  // instead of being queued behind the boundary it would resurrect through.
  if (!writeAllowed(normalised.id)) return Promise.resolve()
  return enqueueProfileWrite(normalised.id, async () => {
    const index = memory.profiles.findIndex((row) => row.id === normalised.id)
    if (index >= 0) memory.profiles[index] = normalised
    else memory.profiles = [...memory.profiles, normalised]
    if (!canUseIdb()) return
    const db = await openDb()
    try {
      const transaction = db.transaction(PROFILE_STORE, 'readwrite')
      const request = transaction.objectStore(PROFILE_STORE).put(normalised)
      await Promise.all([idbRequest(request), idbTransaction(transaction)])
    } finally {
      db.close()
    }
  })
}

export function deleteProfile(profileId: string): Promise<void> {
  // Destructive boundary: the exclusion window opens at this synchronous call
  // and the id is tombstoned immediately, so writes invoked from now on can
  // neither queue behind the deletion nor resurrect the board afterwards. If
  // the deletion fails, the tombstone is released again — the board remains.
  return runBoundary(
    'delete',
    async () => {
      const remaining = memory.profiles.filter((profile) => profile.id !== profileId)
      const nextActiveProfileId =
        memory.activeProfileId === profileId ? (remaining[0]?.id ?? null) : memory.activeProfileId
      if (!canUseIdb()) {
        memory.profiles = remaining
        memory.activeProfileId = nextActiveProfileId
        return
      }
      const db = await openDb()
      try {
        const transaction = db.transaction(PROFILE_STORE, 'readwrite')
        const request = transaction.objectStore(PROFILE_STORE).delete(profileId)
        await Promise.all([idbRequest(request), idbTransaction(transaction)])
        // A rejected delete leaves both the current board and session state intact.
        memory.profiles = remaining
        memory.activeProfileId = nextActiveProfileId
      } finally {
        db.close()
      }
    },
    { tombstone: [profileId] },
  )
}

export function setActiveProfileId(profileId: string): Promise<void> {
  // Same refusal contract as saveProfile: a pointer into a deleted or being-
  // replaced profile collection must never be written.
  if (!writeAllowed(profileId)) return Promise.resolve()
  return enqueueWrite(async () => {
    // Checked inside the turn so a profile saved by an earlier queued write is
    // visible here and the active pointer cannot be silently dropped.
    if (!memory.profiles.some((profile) => profile.id === profileId)) return
    memory.activeProfileId = profileId
    if (!canUseIdb()) return
    const db = await openDb()
    try {
      const transaction = db.transaction(META_STORE, 'readwrite')
      const request = transaction.objectStore(META_STORE).put(profileId, ACTIVE_PROFILE_KEY)
      await Promise.all([idbRequest(request), idbTransaction(transaction)])
    } finally {
      db.close()
    }
  })
}

export function logEvent(entry: Omit<EventLogEntry, 'id' | 'timestamp'> & { timestamp?: string }): Promise<void> {
  // Bounded and sanitised at write time so every export stays importable and
  // the same contract governs local writes and imported files alike. The id
  // and timestamp are fixed at call time — the moment of the tap — while the
  // memory and storage application below waits for its turn in the queue.
  // No tile identifier is recorded, not even in coded form: a code derived
  // from a word is reversible against the finite public vocabulary, and the
  // backup promises times and status only. Any `tileId` a caller still passes
  // is dropped here.
  const record = parseEvent({
    id: createEventId(),
    timestamp: entry.timestamp ?? new Date().toISOString(),
    mode: entry.mode,
    status: entry.status,
  })
  if (!record) return Promise.resolve()
  if (!writeAllowed()) return Promise.resolve()

  return enqueueWrite(async () => {
    const previous = memory.events
    const retained = retainNewestEvents([...previous, record])
    memory.events = retained
    if (!canUseIdb()) return

    // Memory mirrors storage (events are read back on load), so whatever fell
    // out of the retention window here is exactly what storage should drop.
    const keep = new Set(retained.map((event) => event.id))
    const dropped = [...previous, record].filter((event) => !keep.has(event.id))
    try {
      const db = await openDb()
      try {
        const transaction = db.transaction(EVENT_STORE, 'readwrite')
        const store = transaction.objectStore(EVENT_STORE)
        store.put(record)
        for (const event of dropped) store.delete(event.id)
        // Report success only once the browser has committed the transaction —
        // a resolved put request alone does not mean the write survived.
        await idbTransaction(transaction)
      } finally {
        db.close()
      }
    } catch {
      // Diagnostics must never break a child's board; the in-memory log stands.
    }
  })
}

// ---------------------------------------------------------------------------
// Export / import backup
// ---------------------------------------------------------------------------

/**
 * Backup schema 3 adds personal-word routine tags, registry icons and
 * favourite/context tone. Schema 2 backups (no per-word metadata) are still
 * accepted and migrate by the same strict field parser; anything newer is
 * rejected rather than guessed at.
 */
export const BACKUP_SCHEMA = 3 as const

/**
 * A generous ceiling for a valid backup file (20 boards + `MAX_PERSISTENT_EVENTS`
 * bounded events). Anything larger is rejected BEFORE its bytes are read — a
 * cheap guard for a 2 GB Fire tablet.
 */
export const MAX_BACKUP_BYTES = 256 * 1024

export function isPlausibleBackupSize(bytes: number): boolean {
  return Number.isFinite(bytes) && bytes > 2 && bytes <= MAX_BACKUP_BYTES
}

const ACCEPTED_BACKUP_SCHEMAS = new Set([2, 3])

export interface BackupBundle {
  app: 'ownsay-aac'
  schema: typeof BACKUP_SCHEMA
  exportedAt: string
  disclaimer: string
  profiles: ChildProfile[]
  events: EventLogEntry[]
}

export type ImportFailureReason =
  | 'unreadable'
  | 'wrong-product'
  | 'unsupported-schema'
  | 'invalid-content'

export interface ImportPreview {
  bundle: BackupBundle
  profileCount: number
  eventCount: number
  exportedAt: string
  nicknames: string[]
}

/**
 * Builds the backup bundle. It contains exactly what the carer drawer says it
 * contains and nothing more: each child's board settings and personal words,
 * plus the bounded interaction-event log. Both are re-validated on the way out
 * so an export of this device's data is always importable by this build.
 *
 * The file itself is created only when a carer presses Download backup, and
 * where it then goes is entirely their choice — so the disclaimer describes
 * the file's contents and does not promise anything about where it travels.
 */
export async function exportBackup(): Promise<BackupBundle> {
  // The backup must never snapshot half-applied writes: wait for everything
  // enqueued so far to settle, then read memory.
  await waitForQueuedWrites()
  const profiles = memory.profiles.length > 0 ? [...memory.profiles] : await readAllProfiles()
  return {
    app: 'ownsay-aac',
    schema: BACKUP_SCHEMA,
    exportedAt: new Date().toISOString(),
    disclaimer:
      'Created with OwnSay. This file holds this device’s local boards and a bounded log of timestamped interaction events (time, child or carer board, and a short status word — never the words used). You chose to save this file; keep it somewhere private.',
    profiles: orderProfilesForDisplay(profiles),
    events: retainNewestEvents(
      memory.events.map(parseEvent).filter((event): event is EventLogEntry => event !== null),
    ),
  }
}

export function downloadBackup(bundle: BackupBundle): void {
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `ownsay-backup-${bundle.exportedAt.slice(0, 10)}.json`
  document.body.append(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

/** Cleans free-text input down to a safe stored label; empty input becomes ''. */
export function sanitiseNickname(input: string): string {
  return normaliseNickname(input) ?? ''
}

function parseProfile(raw: unknown, schema?: number): ChildProfile | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  if (typeof record.id !== 'string' || record.id.length === 0 || record.id.length > 64) return null
  const prefs = sanitisePreferences({
    ageBand: record.ageBand,
    accessDensity: record.accessDensity,
    routine: record.routine,
    interests: record.interests,
    helperEnabled: record.helperEnabled,
  })
  if (!prefs) return null
  const rawNickname = typeof record.nickname === 'string' ? record.nickname : ''
  const nickname = normaliseNickname(rawNickname)
  if (!nickname) return null
  if (typeof record.createdAt !== 'string') return null
  const extraWords: ChildProfile['extraWords'] = []
  if (record.extraWords !== undefined) {
    // New-format backups must never force silent truncation: more than the
    // documented 12 personal words is invalid content, not a migration case.
    if (!Array.isArray(record.extraWords)) return null
    const isLegacySchema = typeof schema === 'number' && schema < BACKUP_SCHEMA
    if (record.extraWords.length > EXTRA_WORD_LIMIT && !isLegacySchema) return null
    if (record.extraWords.length > EXTRA_WORD_LIMIT * 2) return null
    const seenIds = new Set<string>()
    for (const item of record.extraWords) {
      if (typeof item !== 'object' || item === null) return null
      const entry = item as Record<string, unknown>
      if (typeof entry.id !== 'string' || entry.id.length === 0 || entry.id.length > 64) return null
      // Duplicate personal IDs are ambiguous content, not a migration case.
      if (seenIds.has(entry.id)) return null
      seenIds.add(entry.id)
      if (typeof entry.label !== 'string') return null
      const label = normaliseExtraWord(entry.label)
      if (!label) return null
      let routine: Routine | undefined
      if (entry.routine !== undefined) {
        routine = ROUTINES.find((candidate) => candidate === entry.routine)
        // Fail closed: a routine tag must be an exact, known routine.
        if (!routine) return null
      }
      // Fail closed: the icon must exist in this build's explicit registry.
      if (entry.icon !== undefined && !isKnownIconId(entry.icon)) return null
      // Fail closed: tone is a strict enum; unclassified words stay context-only.
      if (
        entry.tone !== undefined &&
        entry.tone !== 'favourite' &&
        entry.tone !== 'context'
      ) {
        return null
      }
      // Migration tolerance: legacy duplicates and words that would shadow a
      // protected-core label are DROPPED rather than failing the whole
      // backup. Nothing else about them is unsafe.
      const key = labelKey(label)
      if (PROTECTED_LABEL_KEYS.has(key)) continue
      if (extraWords.some((existing) => labelKey(existing.label) === key)) continue
      extraWords.push({
        id: entry.id,
        label,
        ...(routine ? { routine } : {}),
        ...(isKnownIconId(entry.icon) ? { icon: entry.icon } : {}),
        ...(entry.tone === 'favourite' || entry.tone === 'context' ? { tone: entry.tone } : {}),
      })
    }
    // Legacy migrations may deduplicate down to the documented limit.
    if (extraWords.length > EXTRA_WORD_LIMIT) {
      if (!isLegacySchema) return null
      extraWords.length = EXTRA_WORD_LIMIT
    }
  }
  if (record.welcomeCelebration !== undefined && typeof record.welcomeCelebration !== 'boolean') return null
  let starterKey: ChildProfile['starterKey']
  if (record.starterKey !== undefined) {
    if (record.starterKey !== 'alex' && record.starterKey !== 'sam') return null
    starterKey = record.starterKey
  }
  let welcomeSprites: string[] | undefined
  if (record.welcomeSprites !== undefined) {
    if (!Array.isArray(record.welcomeSprites) || record.welcomeSprites.length > 8) return null
    welcomeSprites = []
    for (const item of record.welcomeSprites) {
      if (!isWelcomeSpriteKey(item)) return null
      welcomeSprites.push(item)
    }
  }
  const voiceURI =
    record.voiceURI === undefined
      ? undefined
      : typeof record.voiceURI === 'string' && record.voiceURI.length <= 256 && record.voiceURI.length > 0
        ? record.voiceURI
        : null
  if (voiceURI === null) return null
  return {
    id: record.id,
    nickname,
    createdAt: record.createdAt,
    voiceURI,
    extraWords,
    welcomeCelebration: record.welcomeCelebration === true,
    ...(welcomeSprites ? { welcomeSprites } : {}),
    ...(starterKey ? { starterKey } : {}),
    ageBand: prefs.ageBand,
    accessDensity: prefs.accessDensity,
    routine: prefs.routine,
    interests: prefs.interests,
    helperEnabled: prefs.helperEnabled,
  }
}

function sanitisePreferences(
  raw: Record<string, unknown>,
): Pick<DemoPreferences, 'ageBand' | 'accessDensity' | 'routine' | 'interests' | 'helperEnabled'> | null {
  const ageBand = AGE_BANDS.find((band) => band === raw.ageBand)
  const accessDensity = ACCESS_DENSITIES.find((density) => density === raw.accessDensity)
  const routine = ROUTINES.find((candidate) => candidate === raw.routine)
  if (!ageBand || !accessDensity || !routine) return null
  if (!Array.isArray(raw.interests)) return null
  if (raw.helperEnabled !== undefined && typeof raw.helperEnabled !== 'boolean') return null
  const interests = raw.interests.filter((item): item is Interest =>
    INTERESTS.some((candidate) => candidate === item),
  )
  return {
    ageBand: ageBand as AgeBand,
    accessDensity,
    routine,
    interests: [...new Set(interests)],
    helperEnabled: raw.helperEnabled === true,
  }
}

/**
 * Strict validation for an imported backup file. Anything unexpected — wrong
 * product, unknown schema version, malformed profile, unsafe text — fails
 * closed with a plain-language reason instead of being partially applied.
 */
export function previewImport(text: string): ImportPreview {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw failure('unreadable')
  }
  if (typeof parsed !== 'object' || parsed === null) throw failure('unreadable')
  const record = parsed as Record<string, unknown>
  if (record.app !== 'ownsay-aac') throw failure('wrong-product')
  // Schema 2 backups migrate forward; anything newer than this build is refused.
  if (typeof record.schema !== 'number' || !ACCEPTED_BACKUP_SCHEMAS.has(record.schema)) {
    throw failure('unsupported-schema')
  }
  if (typeof record.exportedAt !== 'string') throw failure('invalid-content')
  if (!Array.isArray(record.profiles) || record.profiles.length === 0 || record.profiles.length > 20) {
    throw failure('invalid-content')
  }
  const profiles: ChildProfile[] = []
  const seenIds = new Set<string>()
  for (const raw of record.profiles) {
    const profile = parseProfile(raw, typeof record.schema === 'number' ? record.schema : undefined)
    if (!profile || seenIds.has(profile.id)) throw failure('invalid-content')
    seenIds.add(profile.id)
    profiles.push(profile)
  }
  let events: EventLogEntry[] = []
  if (record.events !== undefined) {
    if (!Array.isArray(record.events) || record.events.length > MAX_PERSISTENT_EVENTS) {
      throw failure('invalid-content')
    }
    const parsed: EventLogEntry[] = []
    for (const raw of record.events) {
      // Every field is bounded by the same contract used for local writes:
      // an out-of-range id, non-ISO timestamp, unknown mode, overlong or
      // non-slug status, or a hostile tile id fails the whole file closed.
      const event = parseEvent(raw)
      if (!event) throw failure('invalid-content')
      parsed.push(event)
    }
    // Repeated ids are tolerated, not fatal: the events store is keyed by id,
    // so a duplicate can only ever collapse. `retainNewestEvents` resolves it
    // deterministically (earliest record for an id wins) and the preview count
    // the carer confirms is the deduplicated count they will actually get.
    events = retainNewestEvents(parsed)
  }
  const orderedProfiles = orderProfilesForDisplay(profiles)
  return {
    bundle: {
      app: 'ownsay-aac',
      schema: BACKUP_SCHEMA,
      exportedAt: record.exportedAt,
      disclaimer: sanitiseDisclaimer(record.disclaimer),
      profiles: orderedProfiles,
      events,
    },
    profileCount: orderedProfiles.length,
    eventCount: events.length,
    exportedAt: record.exportedAt,
    nicknames: orderedProfiles.map((profile) => profile.nickname),
  }
}

/** Longest disclaimer this build will carry forward from a foreign file. */
const MAX_DISCLAIMER_LENGTH = 400

/**
 * A disclaimer arrives as free text from a file we did not write, and it is
 * shown to a carer. Anything that is not plain printable text — control
 * characters, bidi overrides, invisible format scalars — is dropped rather
 * than displayed, and the result is bounded.
 */
function sanitiseDisclaimer(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length > MAX_DISCLAIMER_LENGTH * 4) return ''
  let value: string
  try {
    value = raw.normalize('NFC')
  } catch {
    return ''
  }
  const cleaned = [...value]
    .filter((scalar) => !/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(scalar))
    .join('')
    .replace(/\p{Zs}+/gu, ' ')
    .trim()
  return cleaned.slice(0, MAX_DISCLAIMER_LENGTH)
}

function failure(reason: ImportFailureReason): Error {
  const message = {
    unreadable: 'That file could not be read as a backup.',
    'wrong-product': 'That file was not made by this app.',
    'unsupported-schema': 'That backup uses a different format version.',
    'invalid-content': 'That backup holds unexpected content, so nothing was changed.',
  }[reason]
  return new Error(message)
}

/** Applies a previewed import: replaces boards and restores bounded interaction events. */
export function applyImportedBundle(bundle: BackupBundle): Promise<void> {
  const nextProfiles = orderProfilesForDisplay(bundle.profiles)
  const nextEvents = retainNewestEvents(
    bundle.events.map(parseEvent).filter((event): event is EventLogEntry => event !== null),
  )
  const nextActiveProfileId = nextProfiles[0]?.id ?? null
  // Boards this device held or had already accepted for saving that the backup
  // does not contain are tombstoned at the synchronous call, so no stale write
  // can bring one back after the restore commits. Ids the import itself restores
  // become writable again.
  const replacedIds = profileIdsKnownBeforeBoundary()
    .filter((id) => !nextProfiles.some((profile) => profile.id === id))
  // Destructive boundary: runs as one queue turn, so every write issued before
  // the import has committed first and no later-enqueued write can interleave.
  return runBoundary(
    'restore',
    async () => {
      if (!canUseIdb()) {
        memory.profiles = nextProfiles
        memory.events = nextEvents
        memory.activeProfileId = nextActiveProfileId
        return
      }
      const db = await openDb()
      try {
        await new Promise<void>((resolve, reject) => {
          const transaction = db.transaction([PROFILE_STORE, EVENT_STORE, META_STORE], 'readwrite')
          const profileStore = transaction.objectStore(PROFILE_STORE)
          const eventStore = transaction.objectStore(EVENT_STORE)
          const metaStore = transaction.objectStore(META_STORE)
          profileStore.clear()
          eventStore.clear()
          metaStore.clear()
          for (const profile of nextProfiles) profileStore.put(profile)
          for (const event of nextEvents) eventStore.put(event)
          if (nextActiveProfileId) metaStore.put(nextActiveProfileId, ACTIVE_PROFILE_KEY)
          transaction.oncomplete = () => resolve()
          transaction.onerror = () => reject(transaction.error ?? new Error('Import transaction failed'))
          transaction.onabort = () => reject(transaction.error ?? new Error('Import transaction aborted'))
        })
        memory.profiles = nextProfiles
        memory.events = nextEvents
        memory.activeProfileId = nextActiveProfileId
      } finally {
        db.close()
      }
    },
    { tombstone: replacedIds, restore: nextProfiles.map((profile) => profile.id) },
  )
}

export function clearLocalData(): Promise<void> {
  // Destructive boundary: waits behind every pending write, so nothing can
  // commit into the databases after they have been deleted. Every profile id
  // present in memory or already accepted into the queue at the synchronous
  // call is tombstoned immediately; a failed erasure (e.g. a blocked database
  // deletion, which retains local data) releases exactly those tombstones again.
  return runBoundary(
    'erase',
    async () => {
      if (canUseIdb()) {
        // If deletion is blocked, retain the in-memory state and report failure
        // instead of claiming an erasure that the browser has not completed.
        await deleteDatabase(DB_NAME)
      }
      memory.profiles = []
      memory.activeProfileId = null
      memory.events = []
      clearAllDrafts()
    },
    { tombstone: profileIdsKnownBeforeBoundary() },
  )
}

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error ?? new Error(`IndexedDB delete failed for ${name}`))
    request.onblocked = () => reject(new Error(`IndexedDB delete blocked for ${name}`))
  })
}

export interface NewProfileInput {
  nickname?: string
  ageBand?: AgeBand
  accessDensity?: AccessDensity
  routine?: Routine
  interests?: Interest[]
}

export function createProfile(input: NewProfileInput = {}): ChildProfile {
  const nickname = normaliseNickname(input.nickname ?? '') ?? 'Child'
  return {
    id: createId('prf'),
    nickname,
    createdAt: new Date().toISOString(),
    extraWords: [],
    ageBand: input.ageBand ?? DEFAULT_PREFERENCES.ageBand,
    accessDensity: input.accessDensity ?? DEFAULT_PREFERENCES.accessDensity,
    routine: input.routine ?? DEFAULT_PREFERENCES.routine,
    interests: input.interests ? [...input.interests] : [...DEFAULT_PREFERENCES.interests],
    helperEnabled: false,
    welcomeCelebration: false,
  }
}

// ---------------------------------------------------------------------------
// Phrase recovery (draft) storage
//
// The authored rail is persisted synchronously per profile so a renderer or
// process eviction never loses a child's composed words. Storage is local
// only, validated on read, and cleared deliberately on profile switch, import
// or full erasure — a sibling can never see the other child's draft.
// ---------------------------------------------------------------------------

const DRAFT_PREFIX = 'ownsay-draft-v1:'
const DRAFT_TOKEN_LIMIT = 40

const PROVENANCES = ['core', 'fringe', 'suggestion'] as const

function canUseLocalStorage(): boolean {
  return typeof localStorage !== 'undefined'
}

/** Persists the authored phrase for one profile. Best-effort and synchronous. */
export function saveDraft(profileId: string, tokens: readonly AuthoredToken[]): void {
  if (!canUseLocalStorage() || !profileId) return
  try {
    localStorage.setItem(
      `${DRAFT_PREFIX}${profileId}`,
      JSON.stringify(tokens.slice(0, DRAFT_TOKEN_LIMIT)),
    )
  } catch {
    // Quota or private-mode failures must never break authoring.
  }
}

/**
 * Restores one profile's saved phrase. Every token is resolved through the
 * caller-supplied canonical resolver (catalogue + this profile's personal
 * words): stale, tampered or cross-profile ids are dropped and labels are
 * always replaced with canonical ones before anything can be spoken.
 */
export function loadDraft(
  profileId: string,
  resolveCanonical?: (tokenId: string) => { label: string; category: AuthoredToken['category'] } | undefined,
): AuthoredToken[] {
  if (!canUseLocalStorage() || !profileId) return []
  let raw: string | null = null
  try {
    raw = localStorage.getItem(`${DRAFT_PREFIX}${profileId}`)
  } catch {
    return []
  }
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const tokens: AuthoredToken[] = []
    for (const item of parsed.slice(0, DRAFT_TOKEN_LIMIT)) {
      if (typeof item !== 'object' || item === null) continue
      const record = item as Record<string, unknown>
      if (
        typeof record.instanceId !== 'string' ||
        record.instanceId.length === 0 ||
        record.instanceId.length > 64 ||
        typeof record.tokenId !== 'string' ||
        record.tokenId.length === 0 ||
        record.tokenId.length > 64 ||
        !PROVENANCES.some((provenance) => provenance === record.provenance)
      ) {
        continue
      }
      if (resolveCanonical) {
        const canonical = resolveCanonical(record.tokenId)
        if (!canonical) continue
        tokens.push({
          instanceId: record.instanceId,
          tokenId: record.tokenId,
          label: canonical.label,
          category: canonical.category,
          provenance: record.provenance as AuthoredToken['provenance'],
        })
        continue
      }
      // No resolver supplied: only structurally valid records survive.
      if (
        typeof record.label !== 'string' ||
        record.label.length === 0 ||
        record.label.length > EXTRA_WORD_LABEL_LIMIT * 3 ||
        !TOKEN_CATEGORIES.some((category) => category === record.category)
      ) {
        continue
      }
      tokens.push({
        instanceId: record.instanceId,
        tokenId: record.tokenId,
        label: record.label,
        provenance: record.provenance as AuthoredToken['provenance'],
        category: record.category as AuthoredToken['category'],
      })
    }
    return tokens
  } catch {
    return []
  }
}

/** Removes one profile's draft (deliberate clear or switch). */
export function clearDraft(profileId: string): void {
  if (!canUseLocalStorage() || !profileId) return
  try {
    localStorage.removeItem(`${DRAFT_PREFIX}${profileId}`)
  } catch {
    // Best-effort.
  }
}

/** Removes every draft; used after import/erasure invalidates all profile ids. */
export function clearAllDrafts(): void {
  if (!canUseLocalStorage()) return
  try {
    const stale: string[] = []
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index)
      if (key?.startsWith(DRAFT_PREFIX)) stale.push(key)
    }
    for (const key of stale) localStorage.removeItem(key)
  } catch {
    // Best-effort.
  }
}
