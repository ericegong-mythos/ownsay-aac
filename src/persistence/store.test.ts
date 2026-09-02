import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_PERSISTENT_EVENTS,
  applyImportedBundle,
  clearLocalData,
  createProfile,
  deleteProfile,
  exportBackup,
  loadLocalState,
  logEvent,
  previewImport,
  sanitiseNickname,
  saveProfile,
  setActiveProfileId,
  type BackupBundle,
} from './store'
import { DEFAULT_PREFERENCES, type ChildProfile, type EventLogEntry } from '../domain/types'
import { EXTRA_WORD_LABEL_LIMIT } from '../domain/profile-text'
import { DEMO_PROFILES, createDemoProfile } from '../domain/demo-profiles'

/** A well-formed event that `parseEvent` must accept, at a chosen instant. */
function event(index: number, overrides: Partial<EventLogEntry> = {}): EventLogEntry {
  return {
    id: `evt-${String(index).padStart(4, '0')}`,
    timestamp: new Date(Date.UTC(2026, 7, 21, 0, 0, 0) + index * 1000).toISOString(),
    mode: 'child',
    status: 'tile',
    ...overrides,
  }
}

function rejectedRequest<T>(error: DOMException): IDBRequest<T> {
  const request = { error, onerror: null } as unknown as IDBRequest<T>
  queueMicrotask(() => request.onerror?.(new Event('error')))
  return request
}

function delayedSuccessfulRequest<T>(result: T): {
  request: IDBRequest<T>
  release: () => void
} {
  const request = { result, onsuccess: null, onerror: null } as unknown as IDBRequest<T>
  return {
    request,
    release: () => request.onsuccess?.(new Event('success')),
  }
}

function validBundle(overrides: Record<string, unknown> = {}): string {
  const profile = createProfile({ nickname: 'Maya', ageBand: '7-9' })
  return JSON.stringify({
    app: 'ownsay-aac',
    schema: 2,
    exportedAt: '2026-08-22T09:00:00.000Z',
    disclaimer: 'test bundle',
    profiles: [profile],
    events: [{ id: 'evt-1', timestamp: '2026-08-21T10:00:00.000Z', mode: 'child', status: 'tile', tileId: 'no' }],
    ...overrides,
  })
}

describe('local profile persistence', () => {
  beforeEach(async () => {
    await clearLocalData()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('creates a first profile with sane defaults and keeps it isolated per id', async () => {
    const maya = await seedAndActivate('Maya')
    const theo = await seedAndActivate('Theo')
    const state = await loadLocalState()
    expect(state.profiles).toHaveLength(2)
    expect(state.profiles.map((profile) => profile.nickname).sort()).toEqual(['Maya', 'Theo'])
    expect(state.activeProfileId).toBe(theo.id)
    expect(maya.id).not.toBe(theo.id)
    expect(maya.ageBand).toBe(DEFAULT_PREFERENCES.ageBand)
  })

  it('switches the active profile deliberately and remembers it after reload', async () => {
    const maya = await seedAndActivate('Maya')
    const theo = await seedAndActivate('Theo')
    await setActiveProfileId(maya.id)
    const state = await loadLocalState()
    expect(state.activeProfileId).toBe(maya.id)
    expect(state.profiles.find((profile) => profile.id === theo.id)?.nickname).toBe('Theo')
  })

  it('remembers an intelligence opt-in without starting the model on load', async () => {
    const profile = await seedAndActivate('Maya')
    await saveProfile({ ...profile, helperEnabled: true })

    const state = await loadLocalState()
    expect(state.profiles.find((row) => row.id === profile.id)?.helperEnabled).toBe(true)
  })

  it('falls back to the first profile when the stored active id disappears', async () => {
    const maya = await seedAndActivate('Maya')
    const theo = await seedAndActivate('Theo')
    await deleteProfile(theo.id)
    const state = await loadLocalState()
    expect(state.profiles).toHaveLength(1)
    expect(state.activeProfileId).toBe(maya.id)
  })

  it('sanitises nicknames to safe display text with a fallback', () => {
    expect(sanitiseNickname('  Ana-María   O’Neil ')).toBe('Ana-María O’Neil')
    expect(sanitiseNickname('')).toBe('')
    expect(sanitiseNickname('x'.repeat(60))).toBe('')
    expect(createProfile({ nickname: '' }).nickname).toBe('Child')
  })

  it('round-trips accepted Unicode nickname and personal-word text without losing the profile', async () => {
    const profile = createProfile({ nickname: 'Sam 😊' })
    await saveProfile({ ...profile, extraWords: [{ id: 'teddy', label: '🧸' }] })
    await setActiveProfileId(profile.id)

    const state = await loadLocalState()
    expect(state.profiles).toEqual([
      expect.objectContaining({
        id: profile.id,
        nickname: 'Sam 😊',
        extraWords: [{ id: 'teddy', label: '🧸' }],
      }),
    ])
  })

  it('rejects unsafe text before it can replace the in-memory or IndexedDB profile', async () => {
    const profile = await seedAndActivate('Sam 😊')
    await expect(saveProfile({ ...profile, nickname: 'Sam\u202eJones' })).rejects.toThrow(/invalid local data/)
    await expect(
      saveProfile({ ...profile, extraWords: [{ id: 'bad', label: 'line\nbreak' }] }),
    ).rejects.toThrow(/invalid local data/)

    const state = await loadLocalState()
    expect(state.profiles).toEqual([expect.objectContaining({ id: profile.id, nickname: 'Sam 😊', extraWords: [] })])
  })

  it('reports a quota failure while keeping the edited board usable for this session', async () => {
    const profile = await seedAndActivate('Maya')
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementationOnce(() =>
      rejectedRequest<IDBValidKey>(new DOMException('Profile quota exceeded', 'QuotaExceededError')),
    )

    await expect(saveProfile({ ...profile, nickname: 'Maya-Updated' })).rejects.toMatchObject({
      name: 'QuotaExceededError',
    })

    // The UI's optimistic board remains represented in memory even though a
    // reload would recover the last committed version from IndexedDB.
    const sessionBackup = await exportBackup()
    expect(sessionBackup.profiles).toEqual([
      expect.objectContaining({ id: profile.id, nickname: 'Maya-Updated' }),
    ])
  })

  it('reports a blocked database open instead of pretending a profile write succeeded', async () => {
    const profile = await seedAndActivate('Maya')
    const request = {} as IDBOpenDBRequest
    vi.spyOn(indexedDB, 'open').mockImplementation(() => {
      queueMicrotask(() => request.onblocked?.(new Event('blocked') as IDBVersionChangeEvent))
      return request
    })

    await expect(saveProfile({ ...profile, routine: 'food' })).rejects.toThrow(/open blocked/)
  })

  it('reports a failed profile deletion and retains the current board', async () => {
    const maya = await seedAndActivate('Maya')
    const theo = await seedAndActivate('Theo')
    vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementationOnce(() =>
      rejectedRequest<undefined>(new DOMException('Delete failed', 'AbortError')),
    )

    await expect(deleteProfile(theo.id)).rejects.toMatchObject({ name: 'AbortError' })
    const sessionBackup = await exportBackup()
    expect(sessionBackup.profiles.map((row) => row.id)).toEqual([maya.id, theo.id])
  })

  it('reports an active-profile metadata failure while preserving the last committed choice', async () => {
    const maya = await seedAndActivate('Maya')
    const theo = createProfile({ nickname: 'Theo' })
    await saveProfile(theo)
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementationOnce(() =>
      rejectedRequest<IDBValidKey>(new DOMException('Active profile write failed', 'QuotaExceededError')),
    )

    await expect(setActiveProfileId(theo.id)).rejects.toMatchObject({ name: 'QuotaExceededError' })
    vi.restoreAllMocks()

    const reloaded = await loadLocalState()
    expect(reloaded.activeProfileId).toBe(maya.id)
  })
})

async function seedAndActivate(nickname: string): Promise<ChildProfile> {
  const profile = createProfile({ nickname })
  await saveProfile(profile)
  await setActiveProfileId(profile.id)
  return profile
}

describe('backup export and validated import', () => {
  beforeEach(async () => {
    await clearLocalData()
  })

  it('exports profiles and events under the documented schema', async () => {
    await seedAndActivate('Maya')
    const bundle = await exportBackup()
    expect(bundle.app).toBe('ownsay-aac')
    // Schema 3 carries personal-word metadata; schema 2 imports still migrate.
    expect(bundle.schema).toBe(3)
    expect(bundle.profiles).toHaveLength(1)
    expect(bundle.disclaimer).toMatch(/OwnSay/i)
  })

  it('previews a valid backup with counts before anything changes', () => {
    const preview = previewImport(validBundle())
    expect(preview.profileCount).toBe(1)
    expect(preview.nicknames).toEqual(['Maya'])
    expect(preview.eventCount).toBe(1)
  })

  it('accepts and canonicalises Unicode nickname and personal-word text during import', () => {
    const profile = createProfile({ nickname: 'Sam 😊' })
    const preview = previewImport(
      validBundle({ profiles: [{ ...profile, nickname: '  Sam\u00a0😊 ', extraWords: [{ id: 'teddy', label: ' 🧸 ' }] }] }),
    )

    expect(preview.bundle.profiles[0]).toEqual(
      expect.objectContaining({ nickname: 'Sam 😊', extraWords: [{ id: 'teddy', label: '🧸' }] }),
    )
  })

  it('rejects corrupt, foreign, future-schema and malformed backups without applying them', () => {
    expect(() => previewImport('{not json')).toThrow(/could not be read/)
    expect(() => previewImport(JSON.stringify({ hello: true }))).toThrow(/not made by this app/)
    expect(() =>
      previewImport(JSON.stringify({ ...JSON.parse(validBundle()), schema: 99 })),
    ).toThrow(/different format version/)
    expect(() =>
      previewImport(
        validBundle({
          profiles: [
            {
              id: 'prf-x',
              nickname: '<script>alert(1)</script>',
              createdAt: '2026-01-01T00:00:00.000Z',
              ageBand: '7-9',
              accessDensity: 'standard',
              routine: 'play',
              interests: [],
              helperEnabled: false,
              welcomeCelebration: false,
              extraWords: [],
            },
          ],
        }),
      ),
    ).toThrow(/unexpected content/)
    // Decorative sprite names are an own allowlist. Prototype-chain keys
    // must fail during import rather than reaching a renderer lookup.
    for (const inheritedKey of ['__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty']) {
      expect(() =>
        previewImport(
          validBundle({
            profiles: [
              {
                ...createProfile({ nickname: 'Maya' }),
                welcomeCelebration: true,
                welcomeSprites: [inheritedKey],
              },
            ],
          }),
        ),
      ).toThrow(/unexpected content/)
    }
    // Duplicate profile ids fail closed.
    const duplicated = JSON.parse(validBundle()) as BackupBundle
    duplicated.profiles.push({ ...duplicated.profiles[0] })
    expect(() => previewImport(JSON.stringify(duplicated))).toThrow(/unexpected content/)
    // Unsafe extra words fail closed.
    expect(() =>
      previewImport(
        validBundle({
          profiles: [
            {
              ...createProfile({ nickname: 'Maya' }),
              extraWords: [{ id: 'w1', label: 'x'.repeat(EXTRA_WORD_LABEL_LIMIT + 1) }],
            },
          ],
        }),
      ),
    ).toThrow(/unexpected content/)
    // Malformed personal-word metadata fails closed.
    expect(() =>
      previewImport(
        validBundle({
          profiles: [
            {
              ...createProfile({ nickname: 'Maya' }),
              extraWords: [{ id: 'w1', label: 'Snacks', routine: 'brunch' as unknown as 'food' }],
            },
          ],
        }),
      ),
    ).toThrow(/unexpected content/)
  })

  it('applies a confirmed backup by replacing boards and restoring the tally', async () => {
    await seedAndActivate('Existing')
    const source = JSON.parse(validBundle()) as BackupBundle
    await applyImportedBundle(source)
    const state = await loadLocalState()
    expect(state.profiles.map((profile) => profile.nickname)).toEqual(['Maya'])
    expect(state.activeProfileId).toBe(source.profiles[0].id)
  })

  it('clearing local data returns to first-run state', async () => {
    await seedAndActivate('Maya')
    await clearLocalData()
    const state = await loadLocalState()
    expect(state.profiles).toHaveLength(0)
    expect(state.activeProfileId).toBeNull()
  })

  it('rejects a blocked IndexedDB deletion and retains the current local profile', async () => {
    const profile = await seedAndActivate('Sam 😊')
    const request = {} as IDBOpenDBRequest
    const deletion = vi.spyOn(indexedDB, 'deleteDatabase').mockImplementation(() => {
      queueMicrotask(() => request.onblocked?.(new Event('blocked') as IDBVersionChangeEvent))
      return request
    })

    await expect(clearLocalData()).rejects.toThrow(/delete blocked/)
    deletion.mockRestore()

    const state = await loadLocalState()
    expect(state.profiles).toEqual([expect.objectContaining({ id: profile.id, nickname: 'Sam 😊' })])
  })

})

// ---------------------------------------------------------------------------
// Reload / raw-storage helpers
//
// A page reload gives the store a fresh module with an empty in-memory mirror
// while IndexedDB keeps its contents. `reloadStore()` reproduces exactly that,
// so "after reload" in these tests means what it means on the tablet.
// ---------------------------------------------------------------------------

type Store = typeof import('./store')

async function reloadStore(): Promise<Store> {
  vi.resetModules()
  return import('./store')
}

const DB_NAME = 'ownsay-aac'
const DB_VERSION = 2
const EVENT_STORE = 'events'

function openRawDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('open failed'))
  })
}

/** Writes event rows straight past the store's validation, as an older build would. */
async function writeRawEvents(rows: readonly unknown[]): Promise<void> {
  const db = await openRawDb()
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(EVENT_STORE, 'readwrite')
    const store = transaction.objectStore(EVENT_STORE)
    for (const row of rows) store.put(row)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('raw write failed'))
  })
  db.close()
}

async function countStoredEvents(): Promise<number> {
  const db = await openRawDb()
  const count = await new Promise<number>((resolve, reject) => {
    const request = db.transaction(EVENT_STORE, 'readonly').objectStore(EVENT_STORE).count()
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('count failed'))
  })
  db.close()
  return count
}

/** Reads the raw profile keys straight from storage, past the memory mirror. */
async function listStoredProfileIds(): Promise<string[]> {
  const db = await openRawDb()
  const rows = await new Promise<unknown[]>((resolve, reject) => {
    const request = db.transaction('profiles', 'readonly').objectStore('profiles').getAll()
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('profile read failed'))
  })
  db.close()
  return rows.map((row) => (row as { id?: unknown }).id as string)
}

describe('interaction event persistence', () => {
  beforeEach(async () => {
    await clearLocalData()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('restores logged events after a reload, not just profiles and settings', async () => {
    const profile = await seedAndActivate('Maya')
    await logEvent({ mode: 'child', status: 'session-start' })
    // A caller-supplied tile identifier is accepted for compatibility but
    // never recorded: nothing word-derived enters the log.
    await logEvent({ mode: 'child', status: 'tile', tileId: 'pizza' })
    await logEvent({ mode: 'carer', status: 'open' })

    const store = await reloadStore()
    const reloaded = await store.loadLocalState()
    expect(reloaded.profiles.map((row) => row.id)).toEqual([profile.id])

    const bundle = await store.exportBackup()
    expect(bundle.events.map((row) => row.status)).toEqual(['session-start', 'tile', 'open'])
    // Fresh logging carries no tile identifier at all — coded or otherwise.
    expect(bundle.events.some((row) => 'tileId' in row)).toBe(false)
  })

  it('reports a write as successful only once the transaction has committed', async () => {
    await seedAndActivate('Maya')
    let committed = false
    const openTransaction = IDBDatabase.prototype.transaction
    vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (
      this: IDBDatabase,
      ...args: Parameters<IDBDatabase['transaction']>
    ): IDBTransaction {
      const transaction = openTransaction.apply(this, args)
      transaction.addEventListener('complete', () => {
        committed = true
      })
      return transaction
    })

    const pending = logEvent({ mode: 'child', status: 'speak' })
    expect(committed, 'must not have committed before the await resolves').toBe(false)
    await pending
    // Awaiting only the put request would resolve here with committed false.
    expect(committed).toBe(true)
    vi.restoreAllMocks()

    const store = await reloadStore()
    await store.loadLocalState()
    expect((await store.exportBackup()).events.map((row) => row.status)).toEqual(['speak'])
  })

  it('keeps a burst of same-millisecond events in the order they were tapped', async () => {
    await seedAndActivate('Maya')
    const stamp = '2026-08-21T10:00:00.000Z'
    const order = ['session-start', 'tile', 'speak', 'stop-speech', 'open']
    for (const status of order) {
      await logEvent({ mode: 'child', status, timestamp: stamp })
    }

    // Identical timestamps mean the id decides the order. A random id would
    // shuffle a fast child's taps on every reload and make the cut at 400
    // depend on UUID luck.
    const store = await reloadStore()
    await store.loadLocalState()
    expect((await store.exportBackup()).events.map((row) => row.status)).toEqual(order)
  })

  it('keeps only the newest 400 events in memory and in storage, pruning deterministically', async () => {
    await seedAndActivate('Maya')
    const total = MAX_PERSISTENT_EVENTS + 25
    for (let index = 0; index < total; index += 1) {
      await logEvent({ mode: 'child', status: 'tile', timestamp: event(index).timestamp })
    }

    const inMemory = await exportBackup()
    expect(inMemory.events).toHaveLength(MAX_PERSISTENT_EVENTS)
    // Storage is pruned too, not just the in-memory mirror.
    expect(await countStoredEvents()).toBe(MAX_PERSISTENT_EVENTS)

    const store = await reloadStore()
    await store.loadLocalState()
    const persisted = await store.exportBackup()
    expect(persisted.events).toHaveLength(MAX_PERSISTENT_EVENTS)
    expect(persisted.events.map((row) => row.id)).toEqual(inMemory.events.map((row) => row.id))
    // The survivors are the newest 400, oldest first.
    expect(persisted.events[0].timestamp).toBe(event(25).timestamp)
    expect(persisted.events.at(-1)?.timestamp).toBe(event(total - 1).timestamp)
    const timestamps = persisted.events.map((row) => row.timestamp)
    expect([...timestamps].sort()).toEqual(timestamps)
  })

  it('compacts an over-full or corrupt legacy event store down to the retention limit on load', async () => {
    await seedAndActivate('Maya')
    // An older build wrote without pruning, and left one unparseable row.
    const rows: unknown[] = Array.from({ length: MAX_PERSISTENT_EVENTS + 40 }, (_, index) => event(index))
    rows.push({ id: 'evt-corrupt', timestamp: 'not-a-date', mode: 'child', status: 'tile' })
    await writeRawEvents(rows)

    const store = await reloadStore()
    await store.loadLocalState()
    const bundle = await store.exportBackup()
    expect(bundle.events).toHaveLength(MAX_PERSISTENT_EVENTS)
    expect(bundle.events[0].id).toBe(event(40).id)
    expect(bundle.events.some((row) => row.id === 'evt-corrupt')).toBe(false)
    // The compaction is written back, so the store cannot grow again.
    expect(await countStoredEvents()).toBe(MAX_PERSISTENT_EVENTS)
  })

  it('round-trips its own export through import with nothing added or lost', async () => {
    const alex = createDemoProfile(DEMO_PROFILES.alex)
    const sam = createDemoProfile(DEMO_PROFILES.sam)
    await saveProfile(alex)
    await saveProfile(sam)
    await setActiveProfileId(alex.id)
    await logEvent({ mode: 'child', status: 'tile', tileId: 'extra:sam-water' })
    await logEvent({ mode: 'carer', status: 'export' })

    const exported = await exportBackup()
    const preview = previewImport(JSON.stringify(exported))
    expect(preview.profileCount).toBe(2)
    expect(preview.eventCount).toBe(exported.events.length)
    expect(preview.nicknames).toEqual(['Alex', 'Sam'])
    expect(preview.bundle.profiles).toEqual(exported.profiles)
    expect(preview.bundle.events).toEqual(exported.events)

    await applyImportedBundle(preview.bundle)
    const store = await reloadStore()
    const reloaded = await store.loadLocalState()
    expect(reloaded.profiles).toEqual(exported.profiles)
    expect((await store.exportBackup()).events).toEqual(exported.events)
    // A fictional demo label survives the whole round trip untruncated.
    const word = reloaded.profiles[1].extraWords.find((item) => item.id === 'sam-water')
    expect(word?.label).toBe('Water')
  })

  it('orders built-in boards Alex then Sam after import and after reload', async () => {
    const alex = createDemoProfile(DEMO_PROFILES.alex)
    const sam = createDemoProfile(DEMO_PROFILES.sam)
    const maya = createProfile({ nickname: 'Maya' })
    // Arrive in the wrong order, with a custom board wedged in the middle.
    const bundle = previewImport(
      JSON.stringify({
        app: 'ownsay-aac',
        schema: 3,
        exportedAt: '2026-08-22T09:00:00.000Z',
        disclaimer: 'test bundle',
        profiles: [sam, maya, alex],
        events: [],
      }),
    ).bundle
    expect(bundle.profiles.map((row) => row.nickname)).toEqual(['Alex', 'Sam', 'Maya'])

    await applyImportedBundle(bundle)
    const store = await reloadStore()
    const reloaded = await store.loadLocalState()
    expect(reloaded.profiles.map((row) => row.nickname)).toEqual(['Alex', 'Sam', 'Maya'])
    expect(reloaded.activeProfileId).toBe(alex.id)
  })

  it('exports only what the carer drawer describes, with an honest disclaimer', async () => {
    await seedAndActivate('Maya')
    await logEvent({ mode: 'child', status: 'tile' })
    const bundle = await exportBackup()

    expect(Object.keys(bundle).sort()).toEqual([
      'app',
      'disclaimer',
      'events',
      'exportedAt',
      'profiles',
      'schema',
    ])
    expect(bundle.schema).toBe(3)
    for (const entry of bundle.events) {
      // Nothing beyond the documented event fields is ever written out, and
      // nothing word-derived (no tile id, coded or plain) is among them.
      expect(Object.keys(entry).sort()).toEqual(['id', 'mode', 'status', 'timestamp'])
    }
    // A file the carer chose to save is not a promise about where it then goes.
    expect(bundle.disclaimer).not.toMatch(/nothing is sent anywhere/i)
    expect(bundle.disclaimer).toMatch(/you chose to save this file/i)
    expect(bundle.disclaimer).toMatch(/timestamped interaction events/i)
  })

  it('validates a legacy tile code on import but strips it before memory and re-export', async () => {
    await seedAndActivate('Existing')
    // A schema-2 backup written by an older build carries the reversible
    // DJB2-style tile code. It must pass validation (the file is not hostile)
    // yet never reach memory, storage or any later export.
    const legacy = validBundle({
      events: [{ id: 'evt-1', timestamp: '2026-08-21T10:00:00.000Z', mode: 'child', status: 'tile', tileId: 'no' }],
    })
    const preview = previewImport(legacy)
    expect(preview.eventCount).toBe(1)
    expect('tileId' in preview.bundle.events[0]).toBe(false)

    await applyImportedBundle(preview.bundle)
    const store = await reloadStore()
    await store.loadLocalState()
    const exported = await store.exportBackup()
    expect(exported.events.map((row) => row.status)).toEqual(['tile'])
    // Old local events are not re-exported with the identifier either.
    expect(exported.events.some((row) => 'tileId' in row)).toBe(false)
    const rawRows = await (async () => {
      const db = await openRawDb()
      const rows = await new Promise<unknown[]>((resolve, reject) => {
        const request = db.transaction(EVENT_STORE, 'readonly').objectStore(EVENT_STORE).getAll()
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error ?? new Error('read failed'))
      })
      db.close()
      return rows
    })()
    expect(rawRows.some((row) => typeof row === 'object' && row !== null && 'tileId' in row)).toBe(false)
  })
})

describe('hostile and duplicate imported event records', () => {
  beforeEach(async () => {
    await clearLocalData()
  })

  it('rejects out-of-contract event fields without applying any part of the file', async () => {
    await seedAndActivate('Existing')
    const hostile: unknown[] = [
      { ...event(1), id: 'x'.repeat(65) },
      { ...event(1), id: '' },
      { ...event(1), id: 'evt‮-1' },
      { ...event(1), id: 42 },
      { ...event(1), timestamp: 'yesterday' },
      { ...event(1), timestamp: '2026-08-21T10:00:00.000Z'.repeat(40) },
      { ...event(1), timestamp: 12345 },
      { ...event(1), status: 'x'.repeat(49) },
      { ...event(1), status: 'spoke: I want pizza' },
      { ...event(1), status: 'tile ' },
      { ...event(1), status: '' },
      { ...event(1), mode: 'admin' },
      { ...event(1), tileId: 'x'.repeat(49) },
      { ...event(1), tileId: 'tile id' },
      { ...event(1), tileId: 42 },
      'not-an-object',
      null,
    ]
    for (const record of hostile) {
      expect(
        () => previewImport(validBundle({ events: [record] })),
        `${JSON.stringify(record)} must fail closed`,
      ).toThrow(/unexpected content/)
    }
    // More events than the retention limit is invalid content, not a trim.
    expect(() =>
      previewImport(
        validBundle({
          events: Array.from({ length: MAX_PERSISTENT_EVENTS + 1 }, (_, index) => event(index)),
        }),
      ),
    ).toThrow(/unexpected content/)

    // Nothing was applied: the existing board is untouched.
    const state = await loadLocalState()
    expect(state.profiles.map((row) => row.nickname)).toEqual(['Existing'])
  })

  it('resolves duplicate event ids deterministically and counts them honestly', async () => {
    const duplicated = [
      event(5, { status: 'first' }),
      event(9, { id: event(5).id, status: 'second' }),
      event(9, { id: event(5).id, status: 'third' }),
      event(7, { status: 'other' }),
    ]
    const preview = previewImport(validBundle({ events: duplicated }))

    // The events store is keyed by id, so duplicates can only ever collapse.
    // The earliest record for an id wins, and the count the carer confirms is
    // the count they actually receive.
    expect(preview.eventCount).toBe(2)
    expect(preview.bundle.events.map((row) => row.status)).toEqual(['first', 'other'])
    // Deterministic: the same file always yields the same result.
    expect(previewImport(validBundle({ events: duplicated })).bundle.events).toEqual(
      preview.bundle.events,
    )

    await applyImportedBundle(preview.bundle)
    const store = await reloadStore()
    await store.loadLocalState()
    expect((await store.exportBackup()).events.map((row) => row.status)).toEqual(['first', 'other'])
    expect(await countStoredEvents()).toBe(2)
  })

  it('canonicalises accepted timestamps and strips hostile disclaimer text', () => {
    const preview = previewImport(
      validBundle({
        disclaimer: 'Made ‮by  OwnSay  today',
        events: [event(1, { timestamp: '2026-08-21T10:00:00+02:00' })],
      }),
    )
    // Offsets are canonicalised to UTC so retention sorts identically anywhere.
    expect(preview.bundle.events[0].timestamp).toBe('2026-08-21T08:00:00.000Z')
    // Bidi and control scalars never reach the carer's screen.
    expect(preview.bundle.disclaimer).toBe('Made by OwnSay today')

    expect(previewImport(validBundle({ disclaimer: 'x'.repeat(5000) })).bundle.disclaimer).toBe('')
    expect(previewImport(validBundle({ disclaimer: 42 })).bundle.disclaimer).toBe('')
  })
})

describe('serialized writes against destructive boundaries', () => {
  beforeEach(async () => {
    await clearLocalData()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('a fire-and-forget profile write cannot commit after an import replaces the boards', async () => {
    const stale = await seedAndActivate('Stale')
    const late = createProfile({ nickname: 'Late' })
    void saveProfile(late)
    const bundle = JSON.parse(validBundle()) as BackupBundle
    await applyImportedBundle(bundle)

    // Raw storage holds exactly the imported profile collection — neither the pre-import
    // board nor the write that was still pending when the import ran.
    expect(await listStoredProfileIds()).toEqual([bundle.profiles[0].id])

    const store = await reloadStore()
    const state = await store.loadLocalState()
    expect(state.profiles.map((row) => row.nickname)).toEqual(['Maya'])
    expect(state.profiles.some((row) => row.id === late.id || row.id === stale.id)).toBe(false)
  })

  it('a fire-and-forget event write cannot resurface after an import restores history', async () => {
    await seedAndActivate('Existing')
    void logEvent({ mode: 'child', status: 'stale' })
    const bundle = JSON.parse(validBundle()) as BackupBundle
    await applyImportedBundle(bundle)

    expect(await countStoredEvents()).toBe(1)

    // A tap issued after the import is a new event and must survive normally.
    await logEvent({ mode: 'carer', status: 'fresh' })

    const store = await reloadStore()
    await store.loadLocalState()
    expect((await store.exportBackup()).events.map((row) => row.status)).toEqual(['tile', 'fresh'])
    expect(await countStoredEvents()).toBe(2)
  })

  it('pending profile and event writes cannot reintroduce data after erasure', async () => {
    const profile = await seedAndActivate('Maya')
    void saveProfile({ ...profile, nickname: 'Maya-Revived' })
    void logEvent({ mode: 'child', status: 'revived' })
    await clearLocalData()

    const store = await reloadStore()
    const state = await store.loadLocalState()
    expect(state.profiles).toHaveLength(0)
    expect(state.activeProfileId).toBeNull()
    expect(await listStoredProfileIds()).toHaveLength(0)
    expect(await countStoredEvents()).toBe(0)
  })

  it('erase tombstones a newly queued profile id before that write reaches memory', async () => {
    const existing = await seedAndActivate('Existing')
    const delayed = delayedSuccessfulRequest<IDBValidKey>(existing.id)
    let releaseDelayedWrite: (() => void) | undefined
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementationOnce(() => {
      releaseDelayedWrite = delayed.release
      return delayed.request
    })

    // Hold the queue inside IndexedDB, then enqueue a brand-new id behind it.
    // At the erase call below, that second save has not had a turn and therefore
    // cannot yet be present in `memory.profiles`.
    const blockingWrite = saveProfile({ ...existing, nickname: 'Existing delayed' })
    await vi.waitFor(() => expect(releaseDelayedWrite).toBeTypeOf('function'))
    const newlyQueued = createProfile({ nickname: 'Newly queued' })
    const queuedWrite = saveProfile(newlyQueued)
    let queuedWriteSettled = false
    void queuedWrite.then(() => {
      queuedWriteSettled = true
    })
    await Promise.resolve()
    expect(queuedWriteSettled).toBe(false)

    const erasing = clearLocalData()
    releaseDelayedWrite?.()
    await Promise.all([blockingWrite, queuedWrite, erasing])

    // A captured pre-erase snapshot with the queued id must stay refused after
    // erasure, just like a profile that was already visible in memory.
    await saveProfile(newlyQueued)
    const store = await reloadStore()
    const state = await store.loadLocalState()
    expect(state.profiles).toHaveLength(0)
    expect(await listStoredProfileIds()).toHaveLength(0)
  })

  it('restore tombstones a newly queued profile id before that write reaches memory', async () => {
    const existing = await seedAndActivate('Existing')
    const delayed = delayedSuccessfulRequest<IDBValidKey>(existing.id)
    let releaseDelayedWrite: (() => void) | undefined
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementationOnce(() => {
      releaseDelayedWrite = delayed.release
      return delayed.request
    })

    const blockingWrite = saveProfile({ ...existing, nickname: 'Existing delayed' })
    await vi.waitFor(() => expect(releaseDelayedWrite).toBeTypeOf('function'))
    const newlyQueued = createProfile({ nickname: 'Newly queued' })
    const queuedWrite = saveProfile(newlyQueued)
    let queuedWriteSettled = false
    void queuedWrite.then(() => {
      queuedWriteSettled = true
    })
    await Promise.resolve()
    expect(queuedWriteSettled).toBe(false)

    const bundle = JSON.parse(validBundle()) as BackupBundle
    const restoring = applyImportedBundle(bundle)
    releaseDelayedWrite?.()
    await Promise.all([blockingWrite, queuedWrite, restoring])

    // A stale snapshot carrying the pre-restore queued id stays refused, while
    // the profile deliberately restored from the bundle remains writable.
    await saveProfile(newlyQueued)
    await saveProfile({ ...bundle.profiles[0], nickname: 'Maya restored' })
    const store = await reloadStore()
    const state = await store.loadLocalState()
    expect(state.profiles).toEqual([
      expect.objectContaining({ id: bundle.profiles[0].id, nickname: 'Maya restored' }),
    ])
    expect(await listStoredProfileIds()).toEqual([bundle.profiles[0].id])
  })

  it('a rejected write leaves the queue usable for the next write', async () => {
    const maya = await seedAndActivate('Maya')
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementationOnce(() =>
      rejectedRequest<IDBValidKey>(new DOMException('First write failed', 'QuotaExceededError')),
    )
    const rejected = saveProfile({ ...maya, nickname: 'Rejected-Nick' })
    const theo = createProfile({ nickname: 'Theo' })
    const accepted = saveProfile(theo)
    await expect(rejected).rejects.toMatchObject({ name: 'QuotaExceededError' })
    await accepted

    // The failed write left storage untouched; the write behind it committed.
    const store = await reloadStore()
    const state = await store.loadLocalState()
    expect(state.profiles.map((row) => row.nickname)).toEqual(['Maya', 'Theo'])
  })

  it('exportBackup waits for queued writes before snapshotting', async () => {
    await seedAndActivate('Maya')
    void logEvent({ mode: 'child', status: 'queued-a' })
    void saveProfile(createProfile({ nickname: 'Queued' }))

    const bundle = await exportBackup()
    expect(bundle.events.map((row) => row.status)).toEqual(['queued-a'])
    expect(bundle.profiles.map((row) => row.nickname)).toEqual(['Maya', 'Queued'])
  })

  it('writes invoked after erase is scheduled cannot resurrect the erased profile after reload', async () => {
    const profile = await seedAndActivate('Maya')
    const erasing = clearLocalData()
    // Invoked while the erase is still pending — exactly the straggler a slow
    // tap or an async callback can produce. Refused, never enqueued.
    void saveProfile({ ...profile, nickname: 'Maya-Revived' })
    void setActiveProfileId(profile.id)
    await erasing

    const store = await reloadStore()
    const state = await store.loadLocalState()
    expect(state.profiles).toHaveLength(0)
    expect(state.activeProfileId).toBeNull()
    expect(await listStoredProfileIds()).toHaveLength(0)
  })

  it('a write for a deleted profile id stays refused after the delete completes', async () => {
    const maya = await seedAndActivate('Maya')
    const theo = createProfile({ nickname: 'Theo' })
    await saveProfile(theo)
    await setActiveProfileId(theo.id)
    await deleteProfile(theo.id)

    // Long after the deletion committed, a captured snapshot of the deleted
    // board must not resurrect it.
    await expect(saveProfile(theo).then(() => undefined)).resolves.toBeUndefined()
    await setActiveProfileId(theo.id)

    const state = await loadLocalState()
    expect(state.profiles.map((row) => row.id)).toEqual([maya.id])
    expect(await listStoredProfileIds()).toEqual([maya.id])
  })

  it('writes invoked after restore is scheduled cannot bring back boards the backup lacks', async () => {
    const stale = await seedAndActivate('Stale')
    const bundle = JSON.parse(validBundle()) as BackupBundle
    const restoring = applyImportedBundle(bundle)
    // A stale write racing the restore must not re-add the replaced board.
    void saveProfile({ ...stale, nickname: 'Stale-Revived' })
    await restoring

    const store = await reloadStore()
    const state = await store.loadLocalState()
    expect(state.profiles.map((row) => row.nickname)).toEqual(['Maya'])
    expect(await listStoredProfileIds()).toEqual([bundle.profiles[0].id])
  })

  it('normal new-profile creation works after a completed erase', async () => {
    await seedAndActivate('Old')
    await clearLocalData()

    const fresh = createProfile({ nickname: 'Fresh' })
    await saveProfile(fresh)
    await setActiveProfileId(fresh.id)

    const store = await reloadStore()
    const state = await store.loadLocalState()
    expect(state.profiles.map((row) => row.nickname)).toEqual(['Fresh'])
    expect(state.activeProfileId).toBe(fresh.id)
    expect(await listStoredProfileIds()).toEqual([fresh.id])
  })

  it('a failed erase releases its tombstones so retained boards stay writable', async () => {
    const profile = await seedAndActivate('Sam 😊')
    const request = {} as IDBOpenDBRequest
    vi.spyOn(indexedDB, 'deleteDatabase').mockImplementation(() => {
      queueMicrotask(() => request.onblocked?.(new Event('blocked') as IDBVersionChangeEvent))
      return request
    })

    await expect(clearLocalData()).rejects.toThrow(/delete blocked/)
    vi.restoreAllMocks()

    // The erasure did not happen, so the surviving board must remain editable.
    await saveProfile({ ...profile, nickname: 'Sam Edited' })
    const state = await loadLocalState()
    expect(state.profiles).toEqual([expect.objectContaining({ id: profile.id, nickname: 'Sam Edited' })])
  })

  it('refuses a second destructive boundary while one is already in progress', async () => {
    await seedAndActivate('Maya')
    const bundle = JSON.parse(validBundle()) as BackupBundle
    const restoring = applyImportedBundle(bundle)
    await expect(clearLocalData()).rejects.toThrow(/already in progress/)
    await expect(deleteProfile('whatever-id')).rejects.toThrow(/already in progress/)
    await restoring

    // After the boundary settles the stores are usable again.
    const state = await loadLocalState()
    expect(state.profiles.map((row) => row.nickname)).toEqual(['Maya'])
  })
})
