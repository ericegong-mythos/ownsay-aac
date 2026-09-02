# Privacy model

OwnSay is designed as a local-first static web application. This document describes the code in this repository; a downstream host must publish privacy information for its own deployment and any modifications.

## What the application stores

In the browser, OwnSay can store:

- local profile nicknames and settings;
- interests and carer-added vocabulary;
- a preferred browser speech-voice URI;
- whether the optional helper was configured;
- a bounded operational event log without message or tile content;
- a short, profile-scoped draft of the current message for reload recovery.

The application has no first-party account, analytics, advertising, message, or cloud-inference service. Full composed messages are not included in the JSON backup, but a valid draft may remain in local browser storage until cleared, its profile is removed, or local data is erased.

## Network boundaries

The deterministic AAC board needs only the static application files supplied by its host. The service worker can cache that shell after a successful online visit.

The optional WebLLM helper is a separate, carer-initiated path. Its runtime and model files are downloaded from third-party distribution locations configured by the WebLLM dependency. Those providers can receive ordinary request metadata such as IP address, browser details, timing, and the requested asset names. OwnSay does not put a nickname, authored phrase, or model prompt in those asset URLs and has no remote inference API; ranking occurs in the browser after download. Review the upstream locations and policies before deploying the helper in a new jurisdiction or organisation.

Before every spoken utterance, OwnSay asks the browser for its current speech voices and accepts only a voice whose `localService` property is exactly `true`. The carer selector applies the same rule. A remote voice or a voice with missing or unknown locality never receives the authored phrase. A stale preference is ignored in favour of another verified-local voice when one exists. With a remote-only, unknown-locality, or empty voice list, no `speechSynthesis.speak()` call is made and the board remains usable as text-only AAC. OwnSay relies on the browser to report `localService` accurately, so downstream deployers must still verify the real browser and operating-system behaviour of every supported device.

## Backups

A backup is created only after a carer requests it. The JSON file can contain identifying nicknames and personal vocabulary. It is readable by anyone who receives it and is not encrypted by OwnSay. The user controls where the browser saves or shares it.

Never attach a real backup, recording, identifying screenshot, or child-specific vocabulary list to a public GitHub issue.

The press-and-hold gesture for carer settings is an accidental-activation guard, not authentication. Anyone with access to the unlocked browser or device can open the settings and create a readable backup. A downstream deployment that needs access control must add an appropriate authentication and recovery mechanism.

## Downstream obligations

Forks that add analytics, accounts, cloud inference, remote sync, error reporting, authentication, or any other network service materially change this privacy model. They should obtain appropriate consent, minimise collection, document retention and recipients, secure data in transit and at rest, and comply with applicable child-data, health-data, accessibility, and safeguarding requirements.
