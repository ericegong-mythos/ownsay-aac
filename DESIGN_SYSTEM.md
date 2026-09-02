# DESIGN_SYSTEM.md

Read this file before any UI work. The product brief wins on identity; this file wins on craft. Do not restyle the protected core or authorship rail to chase novelty.

## One-line brief

OwnSay is a calm communication board where each daily routine is a distinct, welcoming "world", and the screen's job is to let a child author a message and speak it on purpose.

## Design thesis

Five warm worlds around one stable voice. The signature surfaces are the **voice canvas** (authored words wait here as removable chips) and the **right-now panel** (the selected routine's own words, tinted by that world's accent). Everything else — core words, anytime grammar words, suggestions — stays quieter than those two.

## Tokens

Use `src/styles/tokens.css`. Do not introduce a second palette.

### Paper & ink

| Token | Value | Role |
| --- | --- | --- |
| `--canvas` | `#EDEFEB` | Sage-mist page |
| `--canvas-deep` | `#E3E6DF` | Inset wells |
| `--tile` | `#FFFFFF` | Panels and tiles |
| `--ink` | `#0B1F3A` | Text, core badges, Speak |
| `--muted` | `#44546A` | Secondary copy (AA on canvas and tints) |
| `--line-strong` | `#AEB9B1` | Edges |

### World accents

Each routine owns one accent + one tint. Every accent passes WCAG AA against white and ink in both directions; never use them below AA.

| World | Routine | Accent | Tint |
| --- | --- | --- | --- |
| Playtime | play | `#A34E06` marigold | `--routine-play-tint` |
| Meals & snacks | food | `#AE3543` berry | `--routine-food-tint` |
| School day | school | `#52447C` indigo | `--routine-school-tint` |
| At home | home | `#0D685F` pine | `--routine-home-tint` |
| Out & about | outside | `#215E9E` sky | `--routine-outside-tint` |

The active world sets `--world` on the shell root; components inherit it for badges, tints, chip dots and hover washes.

### Shape, elevation, motion

- Radius: panels 22, tiles 18, controls 14, icon badges 13, chips pill.
- Elevation: `--shadow-tile` hairline lift for tiles; `--shadow-raised` only for the voice canvas; Speak carries a flat 3px press edge (`--shadow-speak`). No glass, no gradients.
- Targets: controls 44px+, primary tiles 64px+.
- Motion: 120–220ms ease transitions on press/hover/world change only, all killed under `prefers-reduced-motion`. No decorative loops.

Typeface: system UI stack only. Sentence case except small uppercase section labels.

## Layout rules

1. Default route is the board. No marketing homepage. A first-run setup creates one local child profile (nickname optional, age band required) before the board appears.
2. Protected core is always visible, first, in this order: No, Stop, Help, Hurts, Break, Yes, More, Finished. Mobile shows it as a fixed 4×2 grid; desktop an eight-column row. It never changes with context, profile, age band or density.
3. Below the core the fringe splits into two labelled zones:
   - **Right now · {World}** — routine-relevant and interest words, larger accent tiles inside a softly tinted panel. Density quotas guarantee them space: Large ≥ 4, Standard ≥ 8, More ≥ 12 slots.
   - **Anytime words** — universal sentence-building words, quieter white tiles with neutral outline badges.
4. The world switcher sits above the voice canvas: icon + label pills, the selected world fills with its accent, gains a checkmark and `aria-pressed`, and a cue line names the world ("Meals & snacks · Eating, drinking and trying tastes").
5. Voice canvas above the board. Empty copy is exactly "Tap a word. Then press Speak." Chips show a world-coloured dot, the word, and an ✕; activating a chip removes only that token, never speaks.
6. **OwnSay Intelligence** sits between the board and the suggestions as a slim status strip: sparkle badge, name + honest state pill (`Not set up`, `Downloading`, `Ready`, `Trouble`, `Unavailable`, or `Paused` when installed but not woken), one line of plain copy, and at most one primary action plus Cancel/Try again. The strip is read-only for the child: **every action that sets up, downloads, wakes, retries or turns off the local helper is carer-only and lives behind the carer hold.** A child tapping the strip must never start a download, wake a model or change the opt-in. An ordinary page load never fetches the model. `Trouble` is the recoverable degraded state after a failed generation — it never describes instant fallback phrases as on-device output.
7. Suggestions sit last, separated by the intelligence strip, with plus icons and no fill. They must never look like board tiles. Instant chips are unadorned; on-device phrases carry a small ink `OwnSay` tag and `(OwnSay phrase)` accessible name. The note line states the current source honestly.
8. Consumer identity only: the header is the wordmark plus the active child's name tag and offline status when relevant. No research, clinical, demo or synthetic-data framing anywhere in the UI.
9. Desktop composes the two zones side by side (world zone wider); mobile stacks voice canvas → worlds → core → right now → anytime → intelligence → suggestions with no clipped carousels.
10. A rare local-storage failure appears as a compact, dismissible carer alert above the worlds. It states that the current board still works and that the unsaved visible change may revert; it never replaces or covers the communication surface.

## Component states

### Tile

- **Core**: white face, filled ink badge with white pictogram, bold label, bordered "Core" pill top-right.
- **Context**: white face washed with `color-mix(--world 7%)`, filled `--world` badge, 1.5px world-tinted border, taller (96px desktop / 88px mobile).
- **Universal**: plain white, smaller neutral badge, softer label weight.
- Pressed: scale 0.96–0.98. Focus: 3px sky ring, 2px offset. Pictograms are Lucide icons only — never emoji or generated SVGs.

### Rail chip

- Pill with dot (world colour), word, ✕ glyph. Accessible name keeps provenance: "Remove {word}, Core|Board|Local suggestion". Removing never speaks.

### Speak

- Large ink control with volume glyph. Disabled when rail is empty or already speaking (40% opacity, no shadow). Stop speaking / Delete last / Clear stay secondary beneath it.

### Suggestion

- Opt-in only; tapping appends tokens without speech. Ghost pills with plus glyph; hover washes with the world tint.

### Carer drawer

- Pointer and touch activation requires a 1.2s press-and-hold; standard keyboard and assistive-technology click activation opens directly. No PIN. Modal focus trap, Escape closes, focus returns. Carer controls never invoke speech.
- The drawer owns profiles (switch/add/remove behind deliberate confirmation), nickname editing, word tailoring, extra personal words, per-profile voice selection, backup export/import with preview confirmation, local-data erasure with a two-step confirm, and **local-helper setup**. The status strip on the main screen reports the helper's state to everyone; only the carer can change it.

### OwnSay Intelligence

- **Carer-only control.** The local helper is a carer decision with a storage and download cost, so every control that changes its state sits behind the carer hold. The child-facing strip states the current state and nothing more. Setting the helper up, downloading it, waking it after a reload, retrying after trouble, and turning it off are all carer actions.
- One honest state at a time; the label is always visible in the state pill.
- `Not set up` → `Set up with a carer`, followed by an inline model-size/storage warning and explicit `Download on this device` confirmation, all reached through the carer hold. `Downloading` → progress line + Cancel (cancel also reverts the opt-in). `Ready` → green-tinted strip, Turn off. `Trouble` → calm amber strip, Try again + Turn off, instant phrases shown honestly. `Unavailable` → plain-language reason + Try again, instant phrases unaffected.
- After a reload with prior opt-in the panel shows `Paused` with a single carer-only Wake action — never an automatic model fetch.
- Copy may promise that the deterministic board and instant routine phrases work offline. It must never promise an offline helper cold start: waking or setup may need internet when runtime/model files are not already cached. An already-running helper may say it can continue if the connection drops.
- Model phrases are distinguishable from instant ones by tag, accessible name and note line; neither ever speaks or appends without a tap.

## Accessibility floor

- Differentiate without colour: sections carry shape markers (square = core, filled dot = right now, ring = anytime), the selected world gains a checkmark, chips gain ✕ glyphs.
- Live region announces additions, removals and world changes politely ("At home. Home words ready.").
- Keyboard operation everywhere, 44px minimum targets, no page-level horizontal overflow at 320–375px or at 200% zoom.
- All text/UI pairs meet WCAG AA, including accent-on-white and white-on-accent; forced-colors mode keeps every section distinguishable through shape and border alone.

## Forbidden

Gradients, glassmorphism, stock heroes, mascots, cream/terracotta AI palettes, purple-blue washes, floating metric cards, huge marketing headlines, rainbow category tabs, decorative looping animation.

## Future UI changes

Keep tokens, world accents, protected-core order, rail behaviour, right-now/anytime separation, quota guarantees and suggestion secondary-ness unchanged. Visual novelty is not allowed to move or hide safety vocabulary.
