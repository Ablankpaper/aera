# Desktop Updates

Packaged Desktop updates use a version-selected public or signed Internal Beta channel. Development and Windows portable builds stay offline.

Public releases continue to use `electron-updater` with the GitHub publisher metadata from `electron-builder.yml`. Versions matching `-internal-beta.N` use the separately signed Internal Beta channel at the baked Aera Cloud Origin under `/desktop-updates/internal-beta`.

[[src/main/app/updater.ts#setupUpdater]] registers one IPC contract for both channels, persists the auto-upgrade preference under Electron `userData`, performs the first packaged-app check after five seconds, and repeats checks every six hours. It also retains a current snapshot so a renderer created after a background check can recover the `available`, `downloading`, `ready`, or `error` state through `getDesktopUpdateState`.

The production dependency gate runs `npm audit --omit=dev --audit-level=high`. Electron is pinned to 41.10.5, the first reviewed maintained line that uses the hardened `@electron-internal/extract-zip` installer dependency and clears the sandboxed-iframe advisory. Desktop ZIP extraction also calls that hardened implementation directly. The public update path stays on `electron-updater` 6.8.9 or newer, and shipped archive handling stays on `tar` 7.5.22 or newer.

When a newer release is available, [[src/renderer/src/screens/Layout/Layout.tsx#Layout]] shows an upgrade button in the sidebar footer. The button downloads the update when needed, shows progress, and becomes a restart action after verified bytes are ready.

An authoritative up-to-date result clears any transient download progress in both the sidebar and About settings. Metadata verification without a target remains a checking state until that result arrives, so an already-current client cannot stay labeled as downloading at zero percent.

[[src/renderer/src/components/settings/AboutPane.tsx#AboutPane]] presents the desktop app as its own card, separate from the Hermes Agent engine card. [[src/renderer/src/components/settings/useSettingsData.ts#useSettingsData]] subscribes to the same lifecycle events, restores the main-process snapshot, exposes a manual check, and honors the same auto-upgrade preference.

## Internal Beta signed update channel

Internal Beta update trust is independent from GitHub and offline entitlements. The app bundles only a reviewed Ed25519 public key; private signing material never enters source or artifacts.

The current release integration identity is `0.7.4-internal-beta.38`; Beta.31, Beta.32, Beta.33, Beta.34, Beta.35, Beta.36, and Beta.37 remain explicit source versions for supported update and rollback scenarios, while Beta.29 remains a manual-DMG bridge only.

[[src/main/app/update-channel.ts#INTERNAL_BETA_UPDATE_PUBLIC_KEYS]] is the application trust root. Private signing material also stays out of update metadata and logs.

[[src/main/app/internal-beta-updater.ts#verifyDesktopUpdateMetadata]] accepts only canonical JSON with the exact channel, key ID, monotonically increasing `X.Y.Z-internal-beta.N` version, HTTPS Origin, immutable versioned artifact URLs, and the complete Darwin arm64 ZIP plus Windows x64 app-directory ZIP pair. It verifies the detached Ed25519 signature before selecting an artifact. Downloads do not follow redirects and must match the signed byte size, SHA-256, and SHA-512 values before becoming pending.

On macOS, the verified ZIP must contain exactly one app with bundle ID `com.bignormal.agentera.studio`, the signed manifest version, an arm64 executable, the packaged Main/Preload/Renderer entries, and the native module inventory. Restart launches a detached helper that moves the current app to a version-specific backup, swaps in the staged app, and opens it. A trusted main-window IPC writes the private healthy-start marker only after React commits. On failure the helper terminates the candidate, restores the backup, and reopens the old app; it deletes the backup only after health succeeds.

On Windows, online update accepts a verified x64 app-directory ZIP rather than executing the separately delivered NSIS installer. The helper waits for the old process tree, swaps whole directories, launches `Aera.exe`, and waits for the same Renderer health handshake. A launch failure or health timeout terminates the failed candidate tree, restores the old directory, and relaunches the old executable. Pending metadata and bytes survive an ordinary application restart; stale or invalid pending state is discarded.

Windows install preflight checks both the install directory and its parent because the swap creates a sibling backup. If validation fails after the old process has exited but before the directory swap, the helper removes only transient attempt markers and relaunches the unchanged old executable; a relaunch failure remains an explicit rollback failure.

macOS extraction temporarily disables Electron's process-wide ASAR path interception while the hardened ZIP extractor writes the staged bundle, then restores the previous setting on both success and failure. Without that boundary, writing the staged `Contents/Resources/app.asar` can stall after a fully verified download. The Runtime ZIP path uses `yauzl` for a no-write inventory pass and a separate streamed extraction pass, validating each destination and symlink target before writing and re-hashing the complete extracted tree afterward. No untrusted ZIP is handled by the vulnerable legacy implementation.

The unsigned `0.7.4-internal-beta.6` package predates this client, while Beta.7 and Beta.8 can verify and download updates but stall when Electron intercepts the staged `app.asar` path. Those versions require one manual installation of the corrected bridge (`0.7.4-internal-beta.9`). Beta.9 restored online updates after the earlier ASAR-interception bridge. Beta.29 and Beta.30 introduced a separate packaged-module regression: they download and verify correctly, but their CommonJS output binds the ESM extractor namespace object as a callable default. Those macOS versions require one manual installation of Beta.31, which binds the named `extract` export. Beta.31 then introduced a startup regression when its second main-process entry moved lifecycle code into nested Rollup chunks while renderer and preload paths still depended on that module's `__dirname`; affected packages open a blank window before the update UI can render. Beta.31 users require one manual installation of Beta.32, which anchors packaged assets at `app.getAppPath()` and restores startup plus later online transitions. Beta.20 was a one-version Developer ID exception that explicitly recorded deferred Apple notarization, stapling, and Gatekeeper acceptance. Beta.21 restored accepted Apple notarization, application and DMG stapling, and Gatekeeper acceptance before publication. Beta.23 remains the published immutable predecessor; later Internal Beta candidates keep unsigned Windows x64 setup and portable artifacts for manual installation and add a separately verified app-directory ZIP as the only Windows online-update payload. The channel signature authenticates the exact online-update bytes independently from platform signing, while production candidates remain Authenticode fail-closed.

The Windows internal-Beta job requires setup and portable bytes to remain explicitly `NotSigned`, records `unsigned_internal_beta` evidence, runs a disposable setup/portable start smoke, and exercises the compiled app-directory helper through a synthetic healthy swap and broken-candidate rollback. These CI gates validate packaging mechanics only; they are not evidence of a physical Beta.28/Beta.29 user upgrade.

### Beta.33 physical update acceptance

Beta.33 acceptance distinguishes the Beta.29 manual bridge from supported online updates and requires a completed rollback drill on both platforms.

Beta.29 cannot claim an online transition because its installed extractor is already broken; the affected macOS machine must use the exact Beta.33 DMG as an in-place manual bridge while preserving the protected `userData` digest. Beta.31 and Beta.32 installed clients must each complete the full metadata, verification, download, extraction, staging, swap, launch, Renderer health, and finalize sequence to Beta.33 on macOS arm64 and Windows x64. A separately injected post-swap health failure on each platform must terminate the failed candidate, restore and relaunch the previous application, and preserve the same protected-data digest.

`scripts/internal-beta/verify-beta33-acceptance.mjs` accepts only one canonical, exact-field ledger bound to the schema-3 candidate manifest and its artifact hashes. It requires the Beta.29 manual bridge, all four supported Beta.31/Beta.32 online transitions, both rollback drills, startup and model-save success, executable hashes, monotonic updater events, operation and diagnostic IDs, and redacted evidence-file digests. Screenshots and free-form notes are not primary proof. `scripts/internal-beta/verify-live-evidence.mjs` and `scripts/release/verify-device-evidence.mjs` require that dedicated ledger before a Beta.33 acceptance claim can pass.

Both Internal Beta Electron Builder overlays run `scripts/internal-beta/verify-built-auth-config.mjs` before packaging. The verifier recursively reads the compiled main-process JavaScript, including Rollup shared chunks created by multiple entrypoints, and requires one canonical HTTPS IP Cloud Origin plus one valid offline entitlement key for that exact issuer. It also requires the project `better-sqlite3` binary to match the checked-in Electron ABI, so missing authentication inputs or a Node-built native module fail before `app.asar` or an installer can be created. The shared `afterPack` hook inventories every packaged `.node` and rejects missing, unreadable, symlinked, wrong-ABI, wrong-architecture, or unrecognized modules before recording deterministic SHA-256 evidence. The final macOS ZIP and Windows app ZIP verifiers reopen packaged `app.asar`, read every compiled Main chunk, and require its baked Cloud Origin and offline trust to equal the protected candidate Origin. Final containers still require independent extracted-artifact binding.

The packaged startup verifier uses isolated user data, target-platform ASAR entry separators, and bounded recursive-cleanup retries after terminating the application. This supports Windows archive lookup and briefly busy handles without weakening startup, Renderer-health, or evidence validation.

The macOS candidate also loads the stable compiled updater entry from candidate `app.asar` under Electron 41.10.5 and invokes its default production extractor against the exact final ZIP before container submission. This gate detects ESM/CommonJS call-shape drift that source transforms or injected extractors cannot exercise.

`.github/workflows/internal-beta.yml` builds both targets from one exact successful-CI source. Since Beta.21 its macOS job fails closed without protected Developer ID and App Store Connect credentials. It records each signed payload or container together with the Apple submission ID before waiting on that same ID, staples the accepted application before producing the final containers, staples the accepted DMG, and verifies both distributed application copies with strict `codesign`, Gatekeeper, stapler, architecture, and Runtime Seed checks through `scripts/release/verify-macos.mjs`. The Beta.38 Windows boundary disables signing discovery, requires setup and portable artifacts to verify as `NotSigned`, and records that explicit internal-Beta status in `windows-evidence.json`; production candidates remain Authenticode fail-closed. The schema-3 canonical manifest hash-binds both platform evidence documents, two packaged Main/Preload/Renderer startup documents, and five independently extracted final-container native inventories; missing, unhealthy, wrong-source, wrong-version, or byte-mismatched evidence stops candidate creation. The assemble job creates and locally verifies canonical update metadata with the protected offline signing key, records those metadata bytes in `SHA256SUMS`, uploads one immutable 30-day candidate, and has no update-server credential. A separate manual `.github/workflows/internal-beta-promote.yml` run accepts only the recorded successful candidate run and exact source, downloads that artifact without rebuilding or resigning, rechecks its checksums, canonical identity, and signed update metadata, then streams only the macOS ZIP and Windows app ZIP plus metadata to the dedicated `aera-updates` SSH principal. The forced server command `scripts/internal-beta/publish-desktop-update.sh` rejects extra paths, unsafe archive entries, invalid signatures, changed hashes, downgrades, and replacement bytes under an existing version. A channel-wide file lock serializes version checks and publication; promotion compares live metadata byte-for-byte and probes both live versioned artifacts.

Desktop packaging uses an explicit application allowlist: compiled `out`, package metadata, the application icon, and Runtime trust. Runtime Seed remains a separately verified `extraResources` payload. Developer worktrees, source, tests, caches, release evidence, and local build output must not enter `app.asar`.

The Cloud Caddy route serves current metadata with `Cache-Control: no-store` and immutable versioned artifacts with a one-year cache. The general Cloud reverse proxy cannot shadow these paths.

### Test specifications

The release contract covers signed metadata, exact artifact bytes, persisted state, trust roots, and atomic publication.

- Metadata changed after signing and artifacts changed after manifest creation are rejected.
- A completed download restores to `ready` after process restart and invokes only the reviewed platform swap helper.
- A macOS swap without a healthy-start marker restores the previous application; a restarted app revalidates the journal binding before acknowledging health and finalizes any already-healthy journal left by a crashed helper.
- A failed macOS candidate is terminated before its directory is replaced, and backup-creation failure keeps and relaunches the old app.
- A Windows health failure terminates the candidate process tree before restoring the old app directory and relaunching the restored executable.
- Only the live main window may acknowledge Renderer readiness; secondary or destroyed-window senders cannot mark an install healthy.
- Script and application trust roots must remain byte-identical.
- Server publication is atomic and idempotent only for the exact same signed bytes.
- Promotion workflow inline Node modules must pass a real syntax check before publication can be accepted.
- Login/render timing cannot hide an already available or downloaded update.
- macOS extraction writes the staged `app.asar` with Electron ASAR interception disabled and restores the previous process setting after success or failure.
- The compiled updater entry inside candidate `app.asar` must use its default production extractor to unpack the exact final macOS ZIP before container submission; source-transform or injected-extractor success is insufficient.
- Packaged `app.asar` is produced from an explicit application allowlist and excludes local source, tests, worktrees, caches, evidence, and build output.
- Internal Beta packaging recursively validates top-level main entries and nested Rollup chunks, and rejects a compiled main process with a missing Cloud Origin, missing offline trust, invalid trust key, or an issuer that differs from the Cloud Origin.
- Native packaging rejects a project whose `better-sqlite3` ABI differs from Electron and rejects a packaged application containing any uninspectable, wrong-ABI, or wrong-architecture `.node`; DMG and ZIP proof remains a final-artifact gate.
- Beta.21 and later macOS evidence is hash-bound to the canonical manifest, rejects unsigned, ad-hoc, unnotarized, unstapled, or Gatekeeper-rejected bytes, and binds the accepted final DMG and ZIP submission IDs.
- Beta.38 Internal Beta Windows setup and portable artifacts must verify as explicitly unsigned; their exact bytes, the x64 app ZIP, locked Runtime Seed, packaged startup proof, final native inventories, unsigned-status evidence, and signed update metadata are all bound to the canonical manifest.

## Immutable signed production candidates

`.github/workflows/release-candidate.yml` is the only workflow that builds distributable production Desktop bytes. It requires an exact source SHA and successful same-SHA CI before either signing job starts.

[[release-source-governance#Release Source Governance]] defines the fail-closed repository, workflow, checkout, and remote identity boundary that must precede candidate or promotion operations.

The candidate `validate` job runs that source verifier before the macOS or Windows build job becomes eligible, and rejects replacement objects, index trust flags, fsmonitor shortcuts, and ignored untracked inputs.

The protected `staging` jobs produce only macOS arm64 and Windows x64 candidates. macOS requires Developer ID signing, accepted notarization IDs for the final DMG and ZIP, stapled app and DMG tickets, Gatekeeper acceptance, and an arm64 native module. Windows requires Authenticode and trusted timestamp verification for both NSIS and portable executables plus an x64 native module. Both platforms embed and independently verify the exact locked Runtime Seed.

`scripts/release/candidate-manifest.mjs` generates public updater metadata with base64 SHA-512, an SPDX 2.3 dependency/Runtime Seed SBOM, and a canonical manifest binding artifact names, sizes, SHA-256/SHA-512 values, source/version, signing identities, notarization IDs, Runtime Seed manifests, CI, and provenance. `scripts/release/verify-candidate.mjs` rejects any mismatch or releasable Linux artifact before GitHub attests and stores the candidate.

`.github/workflows/release.yml` and `.github/workflows/beta-release.yml` are manual compatibility entrypoints that can only invoke the candidate workflow. They have read-only repository permissions, cannot tag, publish, or create a GitHub Release, and contain no packaging path. Public prerelease/stable promotion remains a separate not-yet-enabled exact-byte gate.
