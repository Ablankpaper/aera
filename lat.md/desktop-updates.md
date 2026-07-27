# Desktop Updates

Desktop updates use GitHub releases and expose both a startup upgrade action and a Settings auto-upgrade preference.

The Electron main process configures `electron-updater` against the repository publisher metadata from `electron-builder.yml`, which points at `bignormal/aera`. [[src/main/app/updater.ts#setupUpdater]] registers update IPC handlers, persists the auto-upgrade preference under Electron `userData`, and applies that preference to `autoUpdater.autoDownload`. Versions matching `-internal-beta.N` expose safe no-op update handlers and never contact the private GitHub Releases feed; public update checks begin only after promotion to a supported release channel.

The production dependency gate runs `npm audit --omit=dev --audit-level=high`. The shipped update path therefore stays on `electron-updater` 6.8.9 or newer (including the redirect-credential fix from its runtime utility), and shipped archive handling stays on `tar` 7.5.22 or newer (including the recursion-denial-of-service fix). Candidate packaging and exact-byte verification remain unchanged by these minimum dependency floors.

When GitHub reports a newer release, [[src/renderer/src/screens/Layout/Layout.tsx#Layout]] shows an upgrade button in the sidebar footer as soon as the app reaches the main layout. The button downloads the update when needed, shows download progress, and changes into a restart action after the update is ready.

[[src/renderer/src/components/settings/AboutPane.tsx#AboutPane]] (the About & Updates pane of the settings page) presents the desktop app as its own card, separate from the Hermes Agent engine card — the two update on independent channels. The card shows the app version, the auto-upgrade toggle, and an explicit update action: [[src/renderer/src/components/settings/useSettingsData.ts#useSettingsData]] subscribes to the same `onUpdateAvailable`/`onUpdateDownloadProgress`/`onUpdateDownloaded`/`onUpdateError` events as the footer button and adds a manual `checkDesktopUpdate` (via `checkForUpdates`) plus a `handleDesktopUpdate` that downloads, then restarts via `installUpdate`. When auto-upgrade is enabled the startup release check downloads automatically; when disabled, downloading waits for the user's click (footer button or this card's action).

## Immutable signed candidates

`.github/workflows/release-candidate.yml` is the only workflow that builds distributable Desktop bytes. It requires an exact source SHA and successful same-SHA CI before either signing job starts.

The protected `staging` jobs produce only macOS arm64 and Windows x64 candidates. macOS requires Developer ID signing, accepted notarization IDs for the final DMG and ZIP, stapled app and DMG tickets, Gatekeeper acceptance, and an arm64 native module. Windows requires Authenticode and trusted timestamp verification for both NSIS and portable executables plus an x64 native module. Both platforms embed and independently verify the exact locked Runtime Seed.

`scripts/release/candidate-manifest.mjs` generates electron-updater metadata with base64 SHA-512, an SPDX 2.3 dependency/Runtime Seed SBOM, and a canonical manifest binding artifact names, sizes, SHA-256/SHA-512 values, source/version, signing identities, notarization IDs, Runtime Seed manifests, CI, and provenance. `scripts/release/verify-candidate.mjs` rejects any mismatch or releasable Linux artifact before GitHub attests and stores the candidate.

`.github/workflows/release.yml` and `.github/workflows/beta-release.yml` are manual compatibility entrypoints that can only invoke the candidate workflow. They have read-only repository permissions, cannot tag, publish, or create a GitHub Release, and contain no packaging path. Public prerelease/stable promotion remains a separate not-yet-enabled exact-byte gate; the existing updater can consume a future stable GitHub Release but no current candidate workflow can create one.
