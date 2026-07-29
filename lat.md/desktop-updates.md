# Desktop Updates

Packaged Desktop updates use a version-selected public or signed Internal Beta channel. Development and Windows portable builds stay offline.

Public releases continue to use `electron-updater` with the GitHub publisher metadata from `electron-builder.yml`. Versions matching `-internal-beta.N` use the separately signed Internal Beta channel at the baked AgentEra Cloud Origin under `/desktop-updates/internal-beta`.

[[src/main/app/updater.ts#setupUpdater]] registers one IPC contract for both channels, persists the auto-upgrade preference under Electron `userData`, performs the first packaged-app check after five seconds, and repeats checks every six hours. It also retains a current snapshot so a renderer created after a background check can recover the `available`, `downloading`, `ready`, or `error` state through `getDesktopUpdateState`.

The production dependency gate runs `npm audit --omit=dev --audit-level=high`. The public update path therefore stays on `electron-updater` 6.8.9 or newer, and shipped archive handling stays on `tar` 7.5.22 or newer.

When a newer release is available, [[src/renderer/src/screens/Layout/Layout.tsx#Layout]] shows an upgrade button in the sidebar footer. The button downloads the update when needed, shows progress, and becomes a restart action after verified bytes are ready.

[[src/renderer/src/components/settings/AboutPane.tsx#AboutPane]] presents the desktop app as its own card, separate from the Hermes Agent engine card. [[src/renderer/src/components/settings/useSettingsData.ts#useSettingsData]] subscribes to the same lifecycle events, restores the main-process snapshot, exposes a manual check, and honors the same auto-upgrade preference.

## Internal Beta signed update channel

Internal Beta update trust is independent from GitHub and offline entitlements. The app bundles only a reviewed Ed25519 public key; private signing material never enters source or artifacts.

[[src/main/app/update-channel.ts#INTERNAL_BETA_UPDATE_PUBLIC_KEYS]] is the application trust root. Private signing material also stays out of update metadata and logs.

[[src/main/app/internal-beta-updater.ts#verifyDesktopUpdateMetadata]] accepts only canonical JSON with the exact channel, key ID, monotonically increasing `X.Y.Z-internal-beta.N` version, HTTPS Origin, immutable versioned artifact URLs, and the complete Darwin arm64 ZIP plus Windows x64 NSIS pair. It verifies the detached Ed25519 signature before selecting an artifact. Downloads do not follow redirects and must match the signed byte size, SHA-256, and SHA-512 values before becoming pending.

On macOS, the verified ZIP must contain exactly one app with bundle ID `com.bignormal.agentera.studio`, the signed manifest version, and an arm64 executable. Restart launches a detached helper that moves the current app to a version-specific backup, swaps in the staged app, opens it, and retains the backup until the new app writes the private healthy-start marker. On Windows, restart launches only the verified NSIS setup. Pending metadata and bytes survive an ordinary application restart; stale or invalid pending state is discarded.

The unsigned `0.7.4-internal-beta.6` packages predate this client and therefore require one final manual installation of the first update-capable bridge (`0.7.4-internal-beta.7`). Every later reviewed Internal Beta can use the online channel. OS-level Developer ID/notarization and Authenticode remain separate production gates; the channel signature authenticates exact update bytes but does not claim platform signing.

`.github/workflows/internal-beta.yml` builds both target packages from one exact successful-CI source, creates and locally verifies canonical update metadata with the protected offline signing key, records those metadata bytes in `SHA256SUMS`, and then streams only the two update artifacts plus metadata to the dedicated `aera-updates` SSH principal. The forced server command `scripts/internal-beta/publish-desktop-update.sh` rejects extra paths, unsafe archive entries, invalid signatures, changed hashes, downgrades, and replacement bytes under an existing version. It publishes immutable release directories before atomically switching the `current` metadata symlink. The workflow then compares live metadata byte-for-byte and probes both live versioned artifacts.

The Cloud Caddy route serves current metadata with `Cache-Control: no-store` and immutable versioned artifacts with a one-year cache. The general Cloud reverse proxy cannot shadow these paths.

### Test specifications

The release contract covers signed metadata, exact artifact bytes, persisted state, trust roots, and atomic publication.

- Metadata changed after signing and artifacts changed after manifest creation are rejected.
- A completed download restores to `ready` after process restart and invokes only the reviewed platform installer.
- Script and application trust roots must remain byte-identical.
- Server publication is atomic and idempotent only for the exact same signed bytes.
- Login/render timing cannot hide an already available or downloaded update.

## Immutable signed production candidates

`.github/workflows/release-candidate.yml` is the only workflow that builds distributable production Desktop bytes. It requires an exact source SHA and successful same-SHA CI before either signing job starts.

The protected `staging` jobs produce only macOS arm64 and Windows x64 candidates. macOS requires Developer ID signing, accepted notarization IDs for the final DMG and ZIP, stapled app and DMG tickets, Gatekeeper acceptance, and an arm64 native module. Windows requires Authenticode and trusted timestamp verification for both NSIS and portable executables plus an x64 native module. Both platforms embed and independently verify the exact locked Runtime Seed.

`scripts/release/candidate-manifest.mjs` generates public updater metadata with base64 SHA-512, an SPDX 2.3 dependency/Runtime Seed SBOM, and a canonical manifest binding artifact names, sizes, SHA-256/SHA-512 values, source/version, signing identities, notarization IDs, Runtime Seed manifests, CI, and provenance. `scripts/release/verify-candidate.mjs` rejects any mismatch or releasable Linux artifact before GitHub attests and stores the candidate.

`.github/workflows/release.yml` and `.github/workflows/beta-release.yml` are manual compatibility entrypoints that can only invoke the candidate workflow. They have read-only repository permissions, cannot tag, publish, or create a GitHub Release, and contain no packaging path. Public prerelease/stable promotion remains a separate not-yet-enabled exact-byte gate.
