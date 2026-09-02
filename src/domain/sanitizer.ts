import { MAX_SUGGESTIONS, MAX_TOKENS_PER_SUGGESTION, isSafeSuggestionSequence } from './policy'
import { passesSuggestionQualityGate } from './phrase-quality'
import { isProtectedTokenId } from './protected-core'
import type { Suggestion, SuggestionSource, SuggestionToken } from './types'
import { getModelAllowlist, getVocabById, getVocabLabel } from './vocabulary'

export interface SanitizerOptions {
  allowlist?: ReadonlySet<string>
  source?: SuggestionSource
  /** Current message token IDs: rows that parrot it are rejected. */
  currentTokenIds?: readonly string[]
  /**
   * Existence + label resolution for words outside the global vocabulary
   * (the child's personal board words). When absent, only global catalogue
   * vocabulary can pass.
   */
  tokenExists?: (id: string) => boolean
  labelFor?: (id: string) => string | undefined
  /**
   * The strict quality gate (repeats, message parroting, implausible order)
   * applies to model output. Curated deterministic rows are authored by hand
   * and skip it.
   */
  applyQualityGate?: boolean
}

function extractJsonCandidate(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw
  const trimmed = raw.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced?.[1]?.trim() ?? trimmed
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as unknown
  } catch {
    return null
  }
}

function asTokenIds(value: unknown): string[] | null {
  if (!value || typeof value !== 'object') return null
  const record = value as { tokens?: unknown; words?: unknown }
  const rawTokens = record.tokens ?? record.words
  if (!Array.isArray(rawTokens)) return null

  const ids: string[] = []
  for (const item of rawTokens) {
    if (typeof item === 'string') {
      ids.push(item.trim().toLowerCase().replace(/\s+/g, '-'))
      continue
    }
    if (item && typeof item === 'object' && 'id' in item && typeof item.id === 'string') {
      ids.push(item.id.trim().toLowerCase().replace(/\s+/g, '-'))
      continue
    }
    return null
  }
  return ids
}

function toSuggestionTokens(
  ids: readonly string[],
  labelFor: (id: string) => string | undefined,
): SuggestionToken[] | null {
  const tokens: SuggestionToken[] = []
  for (const id of ids) {
    const label = labelFor(id)
    if (!label) return null
    tokens.push({ id, label })
  }
  return tokens
}

export function coerceSuggestionPayload(raw: unknown): unknown[] | null {
  const parsed = extractJsonCandidate(raw)
  if (!parsed || typeof parsed !== 'object') return null
  if (Array.isArray(parsed)) return parsed
  const record = parsed as { suggestions?: unknown }
  if (!Array.isArray(record.suggestions)) return null
  return record.suggestions
}

export function sanitizeSuggestions(raw: unknown, options: SanitizerOptions = {}): Suggestion[] {
  const allowlist = options.allowlist ?? getModelAllowlist()
  const source = options.source ?? 'local-model'
  const tokenExists = options.tokenExists ?? ((id: string) => Boolean(getVocabById(id)))
  const labelFor = options.labelFor ?? getVocabLabel
  const rows = coerceSuggestionPayload(raw)
  if (!rows) return []

  const seen = new Set<string>()
  const out: Suggestion[] = []

  for (const row of rows) {
    if (out.length >= MAX_SUGGESTIONS) break
    const ids = asTokenIds(row)
    if (!ids) continue
    if (ids.some((id) => isProtectedTokenId(id))) continue
    if (!isSafeSuggestionSequence(ids, allowlist, tokenExists)) continue
    if (ids.length > MAX_TOKENS_PER_SUGGESTION) continue
    const key = ids.join(' ')
    if (seen.has(key)) continue
    if (options.applyQualityGate && !passesSuggestionQualityGate(ids, { currentTokenIds: options.currentTokenIds })) {
      continue
    }
    const tokens = toSuggestionTokens(ids, labelFor)
    if (!tokens) continue
    seen.add(key)
    out.push({
      id: `${source}:${key}`,
      tokens,
      source,
    })
  }

  return out
}
