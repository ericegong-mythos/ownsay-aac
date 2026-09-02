# OwnSay AAC

**Their words. Their way.**

[![CI](https://github.com/ericegong-mythos/ownsay-aac/actions/workflows/ci.yml/badge.svg)](https://github.com/ericegong-mythos/ownsay-aac/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-0b685f.svg)](LICENSE)

OwnSay is an open-source, local-first augmentative and alternative communication (AAC) web app for children aged 4–12 and their communication partners. It combines a stable offline communication board, separate local profiles, five routine-aware vocabulary worlds, verified on-device browser speech when available, and an optional on-device language-model ranker.

This public edition contains **no real child profiles, family preferences, production user data, private deployment identifiers, or inherited Git history**. `Alex` and `Sam` are fictional examples supplied only to demonstrate independent profiles and editable starter vocabulary.

## Why this implementation is different

- **Communication works without AI.** The complete deterministic board is available without an account, backend, model, WebGPU, or network inference.
- **The user remains the author.** Tiles and suggestions append visible tokens; nothing silently rewrites a message. Speech starts only after an explicit **Speak** action.
- **Core words stay stable.** `No`, `Stop`, `Help`, `Hurts`, `Break`, `Yes`, `More`, and `Finished` never move or disappear.
- **Profiles remain separate.** Switching profiles stops speech, clears the temporary message, and releases the optional model before showing the next board.
- **Personalisation stays local.** Nicknames, settings, and carer-added words are stored in IndexedDB on the device. There is no OwnSay account or application analytics service.
- **AI is bounded.** The optional model ranks a finite list of already-approved phrase IDs. Free-form model text never reaches the AAC message rail.

The press-and-hold gesture for carer settings prevents accidental opening; it is not authentication. Anyone with access to an unlocked device can open those settings.

## Try it locally

Requirements: Node.js 22, npm, and a current browser.

```bash
git clone https://github.com/ericegong-mythos/ownsay-aac.git
cd ownsay-aac
npm ci
npm run dev
```

Open the local address printed by Vite. On first run, either choose one of the two fictional sample boards or make a new profile.

For day-to-day operation, installation, backups, and device guidance, read [Using OwnSay](USER-GUIDE.md).

## Deploy your own copy

OwnSay builds to a static PWA in `dist/client`. It can be served by any HTTPS host that provides an `index.html` fallback for client-side routes.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fericegong-mythos%2Fownsay-aac)

Or build it yourself:

```bash
npm ci
npm run build
npm run assert:bundle
```

The included `vercel.json` supplies the SPA fallback and service-worker cache headers. For another host, reproduce those behaviours and serve the site from the root of an HTTPS origin.

## Tailor it

Carers can personalise a deployed copy without changing code:

- create multiple local profiles;
- choose an age-band starter set and independent access density;
- switch among Play, Food, School, Home, and Outside;
- select interests and add up to 12 personal words;
- choose from voices that the browser explicitly reports as on-device;
- export and restore a validated JSON backup.

Developers can replace the fictional starter boards in `src/domain/demo-profiles.ts`, extend the typed vocabulary in `src/domain/vocabulary.ts`, and change presentation through the shared design tokens. Do not remove the protected-core, authorship, import-validation, or explicit-speech safeguards without treating that as an architecture change and adding corresponding tests.

## Optional local intelligence

The optional helper uses WebLLM with the pinned model:

```text
SmolLM2-360M-Instruct-q4f32_1-MLC
```

OwnSay first constructs a curated pool of complete phrases from words visible on the active board. The model receives only that finite pool and may return only enumerated IDs such as `c1` or `c4`:

```text
local board state
  -> curated candidate pool
  -> on-device model ranks candidate IDs
  -> strict schema and ID parser
  -> optional suggestion dock
  -> user taps a phrase
  -> visible message rail
  -> user presses Speak
```

The helper is loaded only after a carer explicitly starts it. Its model is roughly 200 MB, requires compatible WebGPU hardware, and may need an internet connection for the initial runtime/model download. The locked npm package is reproducible through `package-lock.json`, but this release still relies on WebLLM's configured upstream model and WebAssembly locations rather than a repository-owned, content-addressed model bundle. Review and pin those artefacts for deployments that require a stronger software-supply-chain guarantee. Unsupported or low-memory devices continue using deterministic instant phrases.

## Privacy model

OwnSay has no application-owned authentication, message API, inference API, advertising SDK, or analytics pipeline. IndexedDB stores local profiles, settings, personal words, and a bounded operational event log that does not contain message or tile content. A short draft of the current message is kept in the browser's local storage for crash/reload recovery and is scoped to the active profile; carers should erase local data before transferring a device.

The optional local model downloads runtime/model files from its configured third-party distribution hosts. Those hosts receive ordinary connection metadata, while ranking itself happens in the browser; OwnSay has no remote inference API. Speech uses the browser's Web Speech API only when the selected current voice has `localService === true`; that condition is rechecked on every utterance. A stale preference can fall back to another verified-local voice, but remote and unknown-locality voices are never passed an authored phrase. If the current list has no verified-local voice, OwnSay makes no speech request and remains text-only. This boundary relies on the browser reporting `localService` accurately, so downstream deployments must still verify speech on their real target devices. A user-triggered backup is an ordinary file; where the carer later stores or sends that file is outside the app's control.

See [PRIVACY.md](PRIVACY.md) for the complete boundary and obligations for downstream deployments.

## Architecture

| Area | Source of truth |
| --- | --- |
| Application state and orchestration | `src/App.tsx` |
| Fictional sample profiles | `src/domain/demo-profiles.ts` |
| Vocabulary and protected core | `src/domain/vocabulary.ts`, `src/domain/protected-core.ts` |
| Routine, density, and interest selection | `src/domain/board.ts` |
| Deterministic suggestions | `src/domain/suggestions.ts` |
| Curated model candidate pool | `src/domain/candidates.ts` |
| Model prompt, schema, and lifecycle | `src/inference/` |
| IndexedDB, backup, and migration | `src/persistence/store.ts` |
| Verified-local browser speech | `src/speech/adapter.ts` |
| Accessible interface | `src/components/`, `src/styles/` |
| PWA and build configuration | `vite.config.ts`, `vercel.json` |
| Unit and component tests | `src/**/*.test.ts`, `src/**/*.test.tsx` |
| Browser acceptance tests | `e2e/`, `playwright.config.ts` |

## Verification

```bash
npm run test:run
npm run build
npm run assert:bundle
npx playwright install chromium webkit
npx playwright test --reporter=line
npm audit --omit=dev --audit-level=high
```

The browser suite covers desktop, mobile, tablet, Chromium, and WebKit profiles. Chromium automation is muted. The deterministic suite does not download model weights; the separately invoked real-model gate requires suitable WebGPU hardware and a local model cache.

## Accessibility and responsible use

The implementation includes large touch targets, keyboard and assistive activation, focus containment, live announcements, reduced-motion behaviour, high-contrast/forced-colour support, responsive reflow, and explicit control of speech. These controls still require verification on the devices, browsers, access methods, and languages used by a downstream deployment.

This repository is an implementation and research artefact. It does not transfer clinical certification, regulatory approval, professional assessment, symbol licensing, or suitability for a particular communicator. Deployers are responsible for co-design, vocabulary selection, safeguarding, accessibility testing, privacy information, and applicable clinical or regulatory obligations.

## Contributing

Contributions are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md), preserve the communication invariants above, and never submit real child data, private backups, recordings, or identifying screenshots. Security issues should follow [SECURITY.md](SECURITY.md), not a public issue.

## Licence and patent notice

Copyright © 2026 Eric Egong. Source code and included original assets are available under the [MIT License](LICENSE).

Eric Egong has filed a patent application that may relate to aspects of this work. The MIT License contains no express patent licence; read [PATENT-NOTICE.md](PATENT-NOTICE.md) and obtain independent legal advice if patent rights matter to your intended use.

## Author

Created by **Eric Egong**. Academic citation metadata is provided in [CITATION.cff](CITATION.cff).
