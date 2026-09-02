# Security policy

## Reporting a vulnerability

Please do not disclose a suspected vulnerability in a public issue or discussion. Use this repository's **Security** tab to submit a private vulnerability report through GitHub Security Advisories.

Include the affected commit, browser/device, preconditions, user-observable impact, and a minimal reproduction that contains no real child or family data. Do not upload live backups, recordings, identifying screenshots, tokens, or deployment credentials.

## Scope

Security-sensitive boundaries include:

- imported backup parsing and confirmation;
- IndexedDB profile isolation and destructive operations;
- local draft recovery and destructive-data boundaries;
- rendering of carer-supplied labels and imported metadata;
- service-worker cache and update behaviour;
- optional WebLLM runtime/model loading and strict candidate-ID parsing;
- dependency and build-pipeline integrity.

The repository is a client-side implementation. Security guarantees for a fork's hosting account, DNS, CDN, analytics, sync service, backend, or modified model endpoints belong to that downstream deployment.

## Known boundaries

- **Carer access is not authenticated.** Press-and-hold reduces accidental activation, but anyone using an unlocked device can open carer settings. Forks that need an access-control boundary must add an accessible authentication and recovery design.
- **Optional model assets come from upstream providers.** `package-lock.json` pins the WebLLM JavaScript package, but the default model/configuration/WebAssembly asset chain used by this release is not fully content-addressed by this repository. The helper is off until a carer starts it, and deterministic AAC does not depend on it. High-assurance deployments should pin immutable upstream revisions, verify supported integrity metadata, and consider self-hosting a versioned model bundle.
- **Local speech status is browser-reported.** OwnSay requires `SpeechSynthesisVoice.localService === true` before every utterance, but downstream testing must establish whether each supported browser and operating system reports this accurately.

## Supported version

Security fixes target the current `main` branch. Maintainers may ask reporters to verify whether an older deployment reproduces against the latest commit.
