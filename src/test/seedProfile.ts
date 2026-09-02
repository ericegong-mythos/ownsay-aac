import { createProfile, saveProfile } from '../persistence/store'
import type { AgeBand } from '../domain/types'

/**
 * Seeds one local child profile so component tests start on the board rather
 * than the first-run onboarding. Uses the real persistence layer in memory.
 */
export async function seedProfile(input: { nickname?: string; ageBand?: AgeBand } = {}) {
  const profile = createProfile({ nickname: input.nickname ?? 'Test', ageBand: input.ageBand ?? '7-9' })
  await saveProfile(profile)
  return profile
}
