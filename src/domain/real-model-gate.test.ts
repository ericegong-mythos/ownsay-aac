import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { extraWordId, personalFavouriteTokens, selectBoard, validPersonalWords } from './board'
import { buildCandidatePool } from './candidates'
import { buildModelInput } from './policy'
import { passesSuggestionQualityGate } from './phrase-quality'
import { isProtectedTokenId } from './protected-core'
import { DEFAULT_PREFERENCES, ROUTINES, type Interest, type Routine } from './types'
import { getModelAllowlist, VOCABULARY } from './vocabulary'

/**
 * Independent verification of the REAL WebGPU probe. The probe drives the
 * production app against the pinned SmolLM2 model and records exactly which
 * phrases reached the dock labelled as made on this device. This suite
 * re-validates every captured phrase through the real production gate:
 *
 * - rebuilt from the same persisted profile prefs, the carer-configured
 *   personal word metadata (identity, label, routine tag, eligibility tone)
 *   and the visible fringe vocabulary — never from authored messages/events;
 * - the live board must equal the board selectBoard composes for this child,
 *   whose personal tiles displace default universal ones;
 * - a member of the candidate pool that the production adapter offered;
 * - natural word order under passesSuggestionQualityGate;
 * - allowlisted in the EXACT combined model input (visible global vocabulary
 *   plus eligible favourite personal IDs; context-only personal words are
 *   tappable on the board but never suggestible), real vocabulary or validated
 *   personal metadata, and never protected core.
 */

const EVIDENCE_PATH = 'artifacts/real-model-evidence.json'

interface CapturedPhrase {
  text: string
  ariaLabel: string
}

/** Privacy-bounded carer-configured word fields recorded by the probe. */
interface RecordedExtraWord {
  id: string
  label: string
  routine?: Routine
  tone?: 'favourite' | 'context'
}

interface EvidenceRoutine {
  routine: string
  ownsayPhrases: CapturedPhrase[]
  instantPhrases: string[]
  boardFringeIds: string[]
  profilePrefs?: {
    ageBand: '4-6' | '7-9' | '10-12'
    accessDensity: 'large' | 'standard' | 'more'
    interests: Interest[]
    extraWords?: RecordedExtraWord[]
  } | null
}

/** Longest-first label index over global vocabulary plus this child's personal labels. */
function labelIndex(tokenLabels?: Record<string, string>): Array<{ id: string; label: string }> {
  return [
    ...VOCABULARY.map((entry) => ({ id: entry.id, label: entry.label.toLowerCase() })),
    ...Object.entries(tokenLabels ?? {}).map(([id, label]) => ({ id, label: label.toLowerCase() })),
  ].sort((a, b) => b.label.length - a.label.length)
}

/** Greedy longest-label match so multi-word tiles ("Break time", "Building blocks") resolve. */
function idsForText(text: string, labels: Array<{ id: string; label: string }>): string[] | null {
  let rest = text.toLowerCase()
  const ids: string[] = []
  while (rest.length > 0) {
    rest = rest.replace(/^\s+/, '')
    if (rest.length === 0) break
    const hit = labels.find((entry) => rest === entry.label || rest.startsWith(`${entry.label} `))
    if (!hit) return null
    ids.push(hit.id)
    rest = rest.slice(hit.label.length)
  }
  return ids.length > 0 ? ids : null
}

describe('real WebGPU evidence (artifacts/real-model-evidence.json)', () => {
  it('exists and covers all five routines', () => {
    expect(existsSync(EVIDENCE_PATH), 'run scripts/probe-real-intelligence.mjs first').toBe(true)
    const evidence = JSON.parse(readFileSync(EVIDENCE_PATH, 'utf8')) as { evidence: EvidenceRoutine[] }
    const capturedRoutines = evidence.evidence.map((row) => row.routine.toLowerCase()).sort()
    expect(capturedRoutines).toEqual([...ROUTINES].sort())
  })

  it('every OwnSay-labelled phrase passes the real production quality gate', () => {
    const globalAllow = getModelAllowlist()
    const evidence = JSON.parse(readFileSync(EVIDENCE_PATH, 'utf8')) as { evidence: EvidenceRoutine[] }

    for (const rawRow of evidence.evidence) {
      const row: EvidenceRoutine & { routine: ReturnType<typeof String> } = { ...rawRow, routine: rawRow.routine.toLowerCase() }
      expect(row.ownsayPhrases.length, `${row.routine}: probe must capture on-device phrases`).toBeGreaterThan(0)

      // Deterministic reconstruction of the exact live buildModelInput call:
      // App.tsx passes the child profile's own carer-configured extraWords,
      // which displace default universal tiles and seed personal favourites.
      const personalWords: RecordedExtraWord[] = row.profilePrefs?.extraWords ?? []
      const prefs = {
        ...DEFAULT_PREFERENCES,
        routine: row.routine as typeof DEFAULT_PREFERENCES.routine,
        ageBand: row.profilePrefs?.ageBand ?? DEFAULT_PREFERENCES.ageBand,
        accessDensity: row.profilePrefs?.accessDensity ?? DEFAULT_PREFERENCES.accessDensity,
        interests: (row.profilePrefs?.interests as typeof DEFAULT_PREFERENCES.interests) ?? [
          ...DEFAULT_PREFERENCES.interests,
        ],
      }
      const input = buildModelInput(prefs, [], personalWords)
      const allowSet = new Set(input.allowlist)

      // The probe recorded the live board; it must be exactly what selectBoard
      // composes for these profile fields — the child-specific board, not a
      // generic default one.
      const derivedBoardIds = selectBoard(prefs, personalWords)
        .fringe.map((entry) => entry.id)
        .sort()
      expect([...row.boardFringeIds].sort(), `${row.routine}: live board must equal the composed child board`).toEqual(
        derivedBoardIds,
      )

      // The combined model allowlist is exact. Production appends favourite
      // tokens after the visible fringe, so catalogue-promoted favourites
      // (e.g. Pizza) legitimately occupy both segments; rebuilding that exact
      // composition from the CAPTURED board must reproduce the array 1:1.
      const rebuiltAllowlist = [
        ...row.boardFringeIds.filter((id) => globalAllow.has(id)),
        ...personalFavouriteTokens(prefs, personalWords, {
          visibleBoard: selectBoard(prefs, personalWords),
        }).map((token) => token.id),
      ].sort()
      expect(rebuiltAllowlist, `${row.routine}: allowlist must be exactly the production composition`).toEqual(
        input.allowlist,
      )
      // Its global half is precisely the live board's global vocabulary…
      expect(
        row.boardFringeIds.filter((id) => globalAllow.has(id)).sort(),
        `${row.routine}: board must match derived input`,
      ).toEqual([...new Set(input.allowlist.filter((id) => globalAllow.has(id)))].sort())
      // …its personal half contains only eligible favourites that really are
      // visible on that board, each resolvable through tokenLabels…
      for (const id of input.allowlist) {
        if (globalAllow.has(id)) continue
        expect(row.boardFringeIds, `${row.routine}: eligible personal ${id} must be on the live board`).toContain(id)
        expect(input.tokenLabels?.[id], `${row.routine}: personal ${id} must carry a label`).toBeTruthy()
      }
      // …and context-only personal words (aversions, difficult contexts) stay
      // tappable on the board yet can never be suggested by the model.
      for (const word of validPersonalWords(personalWords)) {
        if (word.tone === 'favourite') continue
        expect(allowSet.has(extraWordId(word.id)), `${row.routine}: context-only "${word.label}" must never be suggested`).toBe(false)
      }

      const pool = buildCandidatePool(input)
      const poolKeys = new Set(pool.candidates.map((candidate) => candidate.tokens.map((token) => token.id).join(' ')))
      const labels = labelIndex(input.tokenLabels)

      for (const phrase of row.ownsayPhrases) {
        const ids = idsForText(phrase.text, labels)
        expect(ids, `"${phrase.text}" must map onto real or personal vocabulary`).toBeTruthy()
        const key = ids!.join(' ')
        // Exactly the bounded architecture: the phrase IS a pool entry.
        expect(poolKeys.has(key), `"${phrase.text}" must be a curated pool member`).toBe(true)
        expect(passesSuggestionQualityGate(ids!), `"${phrase.text}" must read naturally`).toBe(true)
        for (const id of ids!) {
          expect(isProtectedTokenId(id), `"${id}" protected core leak`).toBe(false)
          expect(allowSet.has(id), `"${id}" must sit inside the exact combined model allowlist`).toBe(true)
        }
        expect(phrase.ariaLabel).toContain('(OwnSay phrase)')
      }
    }
  })

  it('instant fallback rows are present and never carry OwnSay labelling', () => {
    const evidence = JSON.parse(readFileSync(EVIDENCE_PATH, 'utf8')) as { evidence: EvidenceRoutine[] }
    for (const row of evidence.evidence) {
      for (const label of row.instantPhrases) {
        expect(label.includes('OwnSay')).toBe(false)
      }
    }
  })
})
