import type { ModelInput } from '../domain/policy'
import { buildCandidatePool, type CandidatePool } from '../domain/candidates'

export const MODEL_ID = 'SmolLM2-360M-Instruct-q4f32_1-MLC'

/**
 * The model RANKS a curated candidate pool; it never composes language. The
 * grammar therefore enumerates ONLY pool IDs — free-token output is physically
 * impossible, so every accepted suggestion is guaranteed natural vocabulary.
 */
export function buildSuggestionSchema(pool: CandidatePool): string {
  return JSON.stringify({
    type: 'object',
    properties: {
      chosen: {
        type: 'array',
        minItems: 1,
        maxItems: 4,
        items: { type: 'string', enum: pool.candidates.map((candidate) => candidate.id) },
      },
    },
    required: ['chosen'],
    additionalProperties: false,
  })
}

const ROUTINE_THEMES: Record<ModelInput['routine'], string> = {
  play: 'games, toys, taking turns and playing together',
  food: 'eating, drinking, hunger, thirst and trying tastes',
  school: 'class work, asking for help or a break, and school things',
  home: 'resting, family, dinner, television and bedtime',
  outside: 'going out, parks, bikes, weather and animals outside',
}

/**
 * Builds the ranking prompt for the pinned 360M model. The candidate list is
 * the only language the model sees; its answer is a set of IDs.
 */
export function buildSuggestionPrompt(input: ModelInput, pool: CandidatePool): string {
  const current = input.currentTokenIds.join(' ')
  const lines = [
    `Choose phrases for a child's AAC board.`,
    `Theme now: ${ROUTINE_THEMES[input.routine]}.`,
    current ? `Child already said: ${current}` : 'The child has not said anything yet.',
    '',
    'Candidates:',
    ...pool.candidates.map((candidate) => `${candidate.id} = ${candidate.tokens.map((token) => token.label).join(' ')}`),
    '',
    'Pick up to 4 candidate IDs that fit best right now.',
    'Prefer varied, useful choices for this moment.',
    current ? 'Do not just repeat what the child already said.' : 'Prefer the most useful openers first.',
    '',
    'Answer with JSON only:',
    '{"chosen":["c1","c2"]}',
    'Only use candidate IDs from the list above.',
  ]
  return lines.join('\n')
}

/**
 * Convenience wrapper used by the inference adapter: builds the pool for an
 * input and returns it together with prompt/schema strings.
 */
export function buildRankingContext(input: ModelInput): {
  pool: CandidatePool
  prompt: string
  schema: string
} {
  const pool = buildCandidatePool(input)
  return { pool, prompt: buildSuggestionPrompt(input, pool), schema: buildSuggestionSchema(pool) }
}
