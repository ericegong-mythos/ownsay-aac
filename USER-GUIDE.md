# Using OwnSay

OwnSay is a communication board that runs in a web browser on phones, tablets, computers, and Chromebooks. Open the HTTPS address supplied by the person or organisation hosting your copy.

You do not need an App Store or Google Play download. Installing OwnSay as an app icon is optional.

## Before the first visit

- Connect to the internet and wait until the whole board appears.
- Avoid Private Browsing, Incognito, or Guest mode; local profiles may disappear when that session closes.
- Return through the same browser or installed icon. Boards do not automatically move between browsers or devices.
- If you intend to install the PWA, install it before creating or restoring profiles. Some platforms keep installed-app storage separate from ordinary browser tabs.

## Create or choose a board

On a fresh installation you can:

1. choose `Alex` or `Sam`, the two fictional sample profiles; or
2. enter a nickname, choose a starting age band, and press **Make this board ready**.

The age band selects a starter vocabulary. It is not a judgement about communication ability. Access density is a separate setting.

All profile information stays in that browser or installed PWA. There is no OwnSay account.

## Communicate

1. Choose the current routine: **Play**, **Food**, **School**, **Home**, or **Outside**.
2. Tap individual word tiles or deliberately choose a visible suggestion.
3. Check the message rail. Tap a token to remove it, or use **Delete last** and **Clear**.
4. Press **Speak** only when the message is ready. Speech starts only if the browser reports a verified on-device voice; otherwise the words remain visible for text-only use.
5. Press **Stop speaking** to stop the voice.

Changing routine changes the contextual words and suggestions but does not remove the message already being composed. The protected core remains in a stable order:

**No, Stop, Help, Hurts, Break, Yes, More, Finished**

OwnSay never speaks from a tile, profile change, routine change, model response, or suggestion by itself.

## Carer settings

With touch or a pointer, press and hold **Hold for carer** for just over one second. Keyboard, switch-control, voice-control, and screen-reader users can activate it normally.

The hold is an accessible guard against accidental opening, not a password or identity check. Anyone using an unlocked device can reach these settings. Downstream deployments that require authenticated carer access must add and evaluate a suitable authentication and recovery design.

Carer settings can:

- edit a nickname, age band, and access density;
- select interests;
- add, classify, or remove personal words;
- enable or disable the welcome celebration;
- choose from voices the browser explicitly reports as on-device;
- add, remove, and switch profiles;
- run a local device or speech check;
- set up the optional on-device language helper;
- download or restore a backup;
- erase OwnSay data from that browser.

Switching profiles stops current speech and clears the temporary message before the next board appears.

## Backups

OwnSay does not automatically sync through iCloud, Google, Microsoft, or an OwnSay service. To move a board between devices:

1. Open **Carer settings**.
2. Choose **Download backup** and store the JSON file safely.
3. On the destination browser, choose **Restore backup**.
4. Review the preview and confirm only if the profile and event counts are expected.

A backup contains profile nicknames, settings, personal words, and a bounded operational event log. It does not contain composed or spoken messages. Anyone who receives the file can read its profile content, so treat it as private.

## Draft recovery

OwnSay keeps a short draft of the current message in local browser storage so an accidental reload does not immediately discard it. The draft is scoped to its profile, limited to valid board tokens, and cleared by profile removal or full local-data erasure. Clear the message and erase local data before transferring a device if the draft itself could be sensitive.

## Optional OwnSay Intelligence

The ordinary board and instant phrases do not require a language model.

On a compatible WebGPU device, a carer can deliberately start OwnSay Intelligence. The first setup may download roughly 200 MB plus runtime files from third-party distribution services configured by WebLLM. Those services receive ordinary connection metadata such as an IP address and browser details. After download, ranking happens in the browser; OwnSay does not send the composed message to a remote inference API. The helper ranks a finite collection of phrases made from words already available on the active board; it cannot directly write or speak a message.

If the device is unsupported, storage is low, or model setup fails, keep using the deterministic board and instant suggestions. This is expected fail-soft behaviour.

## Install as an app icon

### iPhone or iPad

Open OwnSay in Safari, choose **Share**, then **Add to Home Screen**.

### Android or Chromebook

Open OwnSay in Chrome. Use **Install app** or **Add to Home screen** from the browser menu when offered.

### Windows or macOS

Use the install control offered by Chrome or Edge. Safari on macOS can use **Add to Dock** on supported versions.

### Amazon Fire tablet

Approve the exact HTTPS address under the Amazon Kids web-content controls, then open and bookmark it in Kids Browser or Silk as appropriate for the profile. Installation and offline capabilities vary by Fire OS/Silk version. Use the in-app Device Check and verify speech, rotation, storage persistence, and offline reload on the real tablet.

## If something is wrong

- **No sound:** open Carer settings and check whether a verified on-device voice is listed. If none is listed, OwnSay deliberately stays text-only and sends no speech request. Otherwise increase media volume, check Bluetooth, headphones, hearing devices, or television output, and try the speech check.
- **A board disappeared:** reopen the same browser/profile or installed icon. Private mode and browser-data clearing remove local storage. Restore a backup if available.
- **Offline reload fails:** reconnect once and allow the page to finish loading so the service worker can update.
- **The local helper will not start:** continue with instant phrases; then check WebGPU support, storage, memory, and network access.
- **A change reverts after reload:** the browser could not commit local storage. Make a backup, check free space and storage permissions, and avoid private mode.

## Important boundary

This open-source implementation does not substitute for individual AAC assessment, co-design, communication-partner training, safeguarding, or device-specific accessibility testing. A deployment should be tailored with the communicator and their support team.
