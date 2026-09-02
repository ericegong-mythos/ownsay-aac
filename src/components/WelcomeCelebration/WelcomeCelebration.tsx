import { useEffect, useMemo, useState } from 'react'
import { isWelcomeSpriteKey, type WelcomeSpriteKey } from '../../domain/welcome-sprites'
import styles from './WelcomeCelebration.module.css'

type Rect = readonly [x: number, y: number, w: number, h: number, fill: string]

/**
 * Original generic pixel art drawn on a 16 by 16 grid. The examples contain
 * no characters, logos, or imagery derived from a real child's profile.
 */
const SPRITES: Record<WelcomeSpriteKey, readonly Rect[]> = {
  apple: [
    [7, 1, 2, 3, '#5b4934'],
    [9, 2, 3, 2, '#4f8f54'],
    [4, 4, 8, 2, '#d94b45'],
    [3, 6, 10, 6, '#e2554f'],
    [4, 12, 8, 2, '#c63e3a'],
    [5, 6, 2, 2, '#f17b70'],
  ],
  blocks: [
    [2, 8, 5, 6, '#4479bf'],
    [8, 7, 6, 7, '#e2a33b'],
    [4, 2, 7, 5, '#58a873'],
    [5, 3, 2, 2, '#7bc191'],
    [9, 8, 2, 2, '#f1c267'],
  ],
  train: [
    [3, 3, 8, 2, '#487bb5'],
    [2, 5, 10, 6, '#5591d0'],
    [10, 7, 3, 4, '#3f76ad'],
    [4, 6, 3, 3, '#dcecf7'],
    [3, 11, 4, 3, '#29384a'],
    [9, 11, 4, 3, '#29384a'],
    [4, 12, 2, 1, '#93a3b3'],
    [10, 12, 2, 1, '#93a3b3'],
  ],
  drawing: [
    [3, 11, 9, 3, '#f1c44c'],
    [5, 8, 7, 3, '#e5af3e'],
    [7, 5, 5, 3, '#4b83c2'],
    [9, 2, 4, 3, '#dc5d57'],
    [12, 1, 2, 2, '#353f4b'],
  ],
  toast: [
    [3, 3, 10, 2, '#c98b48'],
    [2, 5, 12, 7, '#dfaa63'],
    [4, 6, 8, 5, '#f0c98e'],
    [3, 12, 10, 2, '#b8793c'],
  ],
  water: [
    [4, 2, 8, 2, '#8ba4b7'],
    [4, 4, 8, 9, '#d9eef7'],
    [5, 7, 6, 5, '#55a9d6'],
    [5, 5, 2, 1, '#ffffff'],
    [5, 13, 6, 1, '#7894a8'],
  ],
  bubbles: [
    [3, 8, 5, 5, '#6fc3dd'],
    [8, 3, 4, 4, '#9adbea'],
    [10, 9, 3, 3, '#bce9f2'],
    [4, 9, 2, 2, '#dff7fb'],
    [9, 4, 1, 1, '#e9fbfd'],
  ],
  puzzle: [
    [3, 3, 5, 5, '#6f63b6'],
    [8, 3, 5, 5, '#e1a33f'],
    [3, 8, 5, 5, '#4d9e74'],
    [8, 8, 5, 5, '#d85b58'],
    [7, 5, 2, 2, '#6f63b6'],
    [5, 7, 2, 2, '#4d9e74'],
    [9, 7, 2, 2, '#d85b58'],
  ],
}

const CONFETTI_COLOURS = ['#ae3543', '#a34e06', '#52447c', '#0d685f', '#215e9e', '#f6c453']
const CONFETTI_PIECES = 14
/** Motion celebration target window; the brief allows 1.4–1.8s. */
/** Motion celebration finishes and every node is removed within 1.5 s. */
const MOTION_MS = 1500
/** Calm static welcome under prefers-reduced-motion. */
const STATIC_MS = 700

/**
 * Each sprite's rects consolidated into one <path> per colour, precomputed
 * once at module load. The drawn pixels are identical to the original rect
 * list; consolidating keeps the overlay's mount cost (which lands in the same
 * commit as the freshly chosen board) down to a handful of nodes instead of
 * dozens of individual <rect> elements.
 */
const SPRITE_PATHS = (Object.keys(SPRITES) as WelcomeSpriteKey[]).reduce(
  (paths, key) => {
    const byFill = new Map<string, string[]>()
    for (const [x, y, w, h, fill] of SPRITES[key]) {
      const parts = byFill.get(fill) ?? []
      parts.push(`M${x} ${y}h${w}v${h}h${-w}z`)
      byFill.set(fill, parts)
    }
    paths[key] = [...byFill.entries()].map(([fill, parts]) => ({ d: parts.join(''), fill }))
    return paths
  },
  {} as Record<WelcomeSpriteKey, { d: string; fill: string }[]>,
)

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

function seeded(seed: number): number {
  const value = Math.sin(seed * 127.1 + 311.7) * 43758.5453
  return value - Math.floor(value)
}

interface WelcomeCelebrationProps {
  childName: string
  spriteKeys: readonly string[]
  onComplete: () => void
}

/**
 * A brief, silent, pointer-transparent hello after this child's board is
 * chosen on purpose. It renders above the ready-to-use board, never speaks,
 * never appends words, and collapses to a calm static version when the user
 * prefers reduced motion.
 */
export function WelcomeCelebration({ childName, spriteKeys, onComplete }: WelcomeCelebrationProps) {
  const [staticWelcome] = useState(prefersReducedMotion)
  // The overlay joins one painted frame after the board commit that chose
  // this child, so mounting the celebration never lengthens the frame that
  // has to render the ready-to-use board itself. The lifetime timer is not
  // delayed: the moment still ends within its brief window.
  const [overlayMounted, setOverlayMounted] = useState(false)
  // The pixel-art stage and confetti follow one frame after the overlay
  // shell, keeping every individual commit small.
  const [stageMounted, setStageMounted] = useState(false)

  useEffect(() => {
    if (typeof requestAnimationFrame !== 'function') {
      setOverlayMounted(true)
      setStageMounted(true)
      return undefined
    }
    let inner = 0
    const outer = requestAnimationFrame(() => {
      setOverlayMounted(true)
      inner = requestAnimationFrame(() => setStageMounted(true))
    })
    return () => {
      cancelAnimationFrame(outer)
      cancelAnimationFrame(inner)
    }
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(onComplete, staticWelcome ? STATIC_MS : MOTION_MS)
    // A hidden tab must never keep the moment running: finish immediately.
    const onHide = () => {
      if (document.hidden) onComplete()
    }
    document.addEventListener('visibilitychange', onHide)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', onHide)
    }
  }, [onComplete, staticWelcome])

  const sprites = useMemo(
    () => spriteKeys.filter(isWelcomeSpriteKey).slice(0, 6),
    [spriteKeys],
  )
  const confetti = useMemo(
    () =>
      Array.from({ length: CONFETTI_PIECES }, (_, index) => ({
        colour: CONFETTI_COLOURS[index % CONFETTI_COLOURS.length],
        dx: `${Math.round((seeded(index * 2 + 1) - 0.5) * 260)}px`,
        dy: `${Math.round(-(60 + seeded(index * 2 + 2) * 170))}px`,
        r: `${Math.round((seeded(index * 3 + 5) - 0.5) * 320)}deg`,
        size: 6 + Math.round(seeded(index * 5 + 7) * 5),
      })),
    [],
  )

  if (!overlayMounted) return null

  return (
    <div
      className={styles.overlay}
      data-testid="welcome-celebration"
      data-static={staticWelcome || undefined}
      aria-hidden="true"
      style={{ pointerEvents: 'none' }}
    >
      <p className={styles.greeting}>Hello {childName}</p>
      {stageMounted ? (
        <>
          <div className={styles.stage}>
            {sprites.map((key, index) => (
              <span
                key={`${key}-${index}`}
                className={styles.sprite}
                style={{ '--sprite-index': index } as React.CSSProperties}
              >
                <svg viewBox="0 0 16 16" shapeRendering="crispEdges" role="presentation">
                  {SPRITE_PATHS[key].map(({ d, fill }) => (
                    <path key={fill} d={d} fill={fill} />
                  ))}
                </svg>
              </span>
            ))}
          </div>
          {!staticWelcome ? (
            <div className={styles.confetti}>
              {confetti.map((piece, index) => (
                <i
                  key={index}
                  style={
                    {
                      '--piece-delay': `${120 + (index % 6) * 45}ms`,
                      '--dx': piece.dx,
                      '--dy': piece.dy,
                      '--r': piece.r,
                      width: `${piece.size}px`,
                      height: `${piece.size}px`,
                      background: piece.colour,
                    } as React.CSSProperties
                  }
                />
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  )
}
