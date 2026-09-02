# Contributing to OwnSay

Thank you for helping improve an accessible, user-authored communication tool.

## Before opening a contribution

- Discuss large architecture or vocabulary changes in an issue first.
- Never submit real child data, backups, recordings, names, preferences, addresses, or identifying screenshots.
- Use fictional test fixtures and clearly label them as such.
- Report vulnerabilities privately through GitHub Security Advisories as described in `SECURITY.md`.

## Development setup

```bash
npm ci
npx playwright install chromium webkit
npm run dev
```

## Required checks

Run each gate directly so a failure cannot be hidden by a pipeline:

```bash
npm run test:run
npm run build
npm run assert:bundle
npx playwright test --reporter=line
npm audit --omit=dev --audit-level=high
git diff --check
```

The real-model gate is separate because it requires compatible WebGPU hardware and a model download. Do not describe a stubbed or deterministic browser test as real-model evidence.

## Communication invariants

Every contribution must preserve:

1. stable access to the protected core;
2. explicit user activation before speech;
3. visible, append-only authorship;
4. deterministic communication without a model;
5. profile isolation and speech cancellation at profile boundaries;
6. fail-closed import validation;
7. bounded candidate-ID model output rather than unrestricted generated AAC text;
8. accessible touch, keyboard, switch, screen-reader, zoom, contrast, and reduced-motion operation.

Changes that weaken an invariant require explicit design discussion, tests covering the new risk, and documentation of the trade-off.

## Pull requests

Keep each pull request focused. Explain the user-observable change, tests run, devices/browsers actually observed, privacy effects, and any evidence still missing. By contributing, you agree that your contribution is licensed under this repository's MIT License.
