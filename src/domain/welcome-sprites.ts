export const WELCOME_SPRITE_KEYS = [
  'apple',
  'blocks',
  'train',
  'drawing',
  'toast',
  'water',
  'bubbles',
  'puzzle',
] as const

export type WelcomeSpriteKey = (typeof WELCOME_SPRITE_KEYS)[number]

const WELCOME_SPRITE_KEY_SET = new Set<string>(WELCOME_SPRITE_KEYS)

/** Own allowlist shared by profile import and decorative rendering. */
export function isWelcomeSpriteKey(value: unknown): value is WelcomeSpriteKey {
  return typeof value === 'string' && WELCOME_SPRITE_KEY_SET.has(value)
}
