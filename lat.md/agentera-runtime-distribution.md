# AgentEra Runtime distribution

AgentEra Studio ships a signed, platform-specific Runtime seed so first launch works without GitHub while Hermes Profile data and self-learning remain isolated.

## Distribution boundary

The public `Ablankpaper/aera-runtime` repository produces versioned Runtime artifacts, while the desktop validates, packages, installs, updates, and rolls them back.

The cloud account service does not distribute Runtime binaries or expose GitHub credentials. Desktop application updates remain a separate channel described by [[desktop-updates|Desktop Updates]].

## Runtime seed

A seed contains runnable Python, locked core dependencies, AgentEra Runtime, CLI, Dashboard assets, base tools, a manifest, and an Ed25519 signature.

The seed excludes Git history, tests, caches, credentials, Profiles, Memory, sessions, Chromium, speech models, and local model weights. macOS ARM64 and Windows x64 are the first supported seed targets.

The source-controlled staging directory may retain its regular-file `.gitkeep` sentinel. Runtime preparation and final-package verification ignore only that exact sentinel; every other extra entry still fails closed.

## Offline first installation

After product authentication, the main process verifies the packaged seed, installs it into a versioned application-data directory, and atomically selects it without network access.

When the local Runtime is missing, [[src/renderer/src/App.tsx#App]] routes straight to [[src/renderer/src/screens/Install/Install.tsx#Install]]. Preparation starts once per attempt, does not restart on locale or callback rerenders, and successful activation continues automatically into Profile ownership and setup; no welcome, source selection, path selection, prepare, cancel, or continue action is shown.

A missing or invalid seed enters a repair state. Only then may the desktop show bounded repair guidance. It never falls back to cloning upstream `main`, executing a remote install script, choosing an external Runtime, or downloading an unsigned Runtime.

## Offline Seed installation and repair

Packaged Seed installation is verified, transactional, local-only, and isolated from Hermes-owned adaptive state.

[[src/main/agentera-runtime-distribution/extractor.ts#extractRuntimeArchive]] accepts only the signed platform format: TAR/Zstandard for macOS ARM64 and ZIP for Windows x64. Archive paths, normalized metadata, case-folded Windows duplicates, symlink targets, entry types, modes, sizes, and the decompression budget are checked against the signed inventory before a version can be published. The extracted tree is then walked without following links, re-hashed, and compared path-for-path with the manifest. POSIX hosts normalize and recheck non-Windows filesystem modes; Windows hosts skip that unrepresentable post-extraction check while retaining the signed archive-mode validation.

Extraction occurs only below a fresh `userData/runtime/staging/seed-*` transaction. Failure or cancellation deletes the destination owned by that transaction; it cannot clean another staging child, a current version, or `HERMES_HOME`.

[[src/main/agentera-runtime-distribution/seed-installer.ts#installPackagedSeed]] discovers exactly one packaged archive, canonical manifest, and signature, verifies them with the production trust set, and checks free space for archive bytes plus extracted bytes plus one rollback-version reserve plus a ten-percent margin. It health-checks the candidate in staging, stores the verified manifest and signature as managed sidecars, renames the verified payload into `versions`, writes `current.json` atomically, selects managed mode, and refreshes the live invocation. The sidecars let every later startup re-hash the full signed inventory before selecting that managed version.

The welcome installer and Runtime distribution manager may remain alive in the same main process. After a packaged Seed install atomically replaces `current.json`, the manager compares the exact current pointer with the one it observed at startup, discards any stale update offer, and republishes journal-derived state before activation is reported. A same-version repair directory is also detected, and that launch remains offline-only until the next startup restores normal update checks.

[[src/main/agentera-runtime-distribution/health.ts#runIsolatedRuntimeHealthCheck]] runs version, server-help, and core-import probes with Python isolation plus `-B`, a disposable fake HOME and HERMES_HOME, an allowlisted environment, no inherited credentials, and offline package-manager flags. Disabling bytecode writes keeps the verified signed inventory immutable even when Python's isolated mode ignores environment configuration. A corrupt same-version current Runtime is repaired into a new version directory, leaving the old directory and every Hermes-owned Profile, Memory, session, learned Skill, and Curator file untouched.

The authenticated `start-install` IPC path is invoked automatically and calls only the packaged Seed installer. Missing or corrupt packaged resources return `repair-required` with reinstall-desktop guidance; low disk returns a retryable free-space action. No remote shell or PowerShell installer is shipped as a first-install fallback.

## Version state journal

Mutable Runtime versions and current, previous, and candidate pointers live only below Electron `userData/runtime`. Each pointer update fsyncs a temp file, renames it atomically, then fsyncs the parent directory where supported.

Recovery removes only pointer temp files and stale transactions proven to be under Runtime staging or downloads. Version cleanup keeps every referenced directory and rejects lexical or real-path escape, including parent symlinks.

Startup recovery reads current, previous, and candidate pointers independently. A malformed or missing-directory pointer is removed without exposing its contents, while an operational file-read failure stops recovery without deleting a pointer that could not be validated. A valid previous Runtime becomes current when the current pointer or required program layout is unusable. If neither is usable, startup continues into the packaged-Seed repair state rather than selecting an online or system Runtime.

## Program and Profile isolation

Runtime program versions live below Electron `userData`, while Hermes-owned state remains in its physically isolated `HERMES_HOME`.

Installation, update, rollback, and cleanup never overwrite or traverse private Memory, USER data, sessions, learned Skills, Curator state, credentials, Gateway state, Cron state, logs, or workspace files. This is governed by [[agentera-self-evolution|AgentEra self-evolution compatibility]].

## Live Runtime invocation

Every local Runtime operation resolves the currently selected managed or explicit external installation at call time through one main-process abstraction.

[[src/main/agentera-runtime-distribution/invocation.ts#getRuntimeInvocation]] returns one immutable invocation snapshot containing the interpreter, working directory, bundled Skills, Dashboard assets, module CLI builder, and environment builder. A spawn uses that same snapshot throughout so a concurrent version switch cannot mix files from two Runtime versions.

Both managed and external modes launch `python -m hermes_cli.main`. Managed mode points into the installed seed, removes inherited `PYTHONHOME` and `PYTHONPATH`, and forces `PYTHONNOUSERSITE=1` plus `PYTHONDONTWRITEBYTECODE=1` so ordinary Runtime calls cannot mutate the signed program tree; explicit external mode keeps the existing `HERMES_HOME/hermes-agent` compatibility layout.

Callers continue to supply the existing physical `HERMES_HOME` or Profile home. Runtime selection never redirects, migrates, copies, or deletes Memory, Profiles, sessions, learned Skills, credentials, or other adaptive state. Missing or stale selections return a bounded "Runtime is not prepared" result instead of invoking a fallback executable.

Chat and Gateway, Dashboard, Skills, Profiles, Cron, model discovery, MCP, account authentication, Kanban, compatibility probing, and startup preflight all consume the live invocation rather than module-level executable paths. [[src/main/agentera-runtime-distribution/invocation.ts#refreshRuntimeInvocation]] re-resolves the selection after seed installation or activation.

## Desktop TUI backend lifecycle

Desktop owns every local headless TUI backend independently from the ordinary Gateway ownership ledger, including backends warmed only by a named Profile switch.

### Runtime 0.20 headless contract

The Desktop TUI transport launches Runtime through `hermes serve` with `HERMES_DESKTOP=1`, retaining per-Profile state and JSON-RPC/WebSocket support without machine-dashboard routing or a browser SPA.

### Exact process-tree shutdown

Desktop starts each POSIX TUI child as a dedicated process-group leader and records that exact PGID. The shared Electron process group is never signalled.

Shutdown targets only that dedicated group. Windows instead captures the exact root and child tree with invariant UTC file-time identities. No path selects processes by name, port, Profile label, command line, or environment.

### Bounded force escalation

SIGTERM receives a fixed grace window. A still-live owned group or verified Windows tree is force-stopped only after that window; missing or changed ownership evidence fails closed.

POSIX force targets only the same dedicated PGID, including when its leader already exited. Windows refreshes invariant process identities before escalation. Query timeout, parse failure, or identity mismatch never falls back to a positive PID kill.

Windows uses an exact-root tree kill while the root remains alive and individually terminates captured descendants when the root exits before escalation.

### Cancelled startup cannot outlive Desktop

Every asynchronous TUI start belongs to one generation. Stop invalidates that generation before releasing ownership, so a pending port or readiness continuation cannot publish a late process.

### Pool-wide App shutdown

Pool shutdown closes admission before it awaits every mapped or in-flight TUI client. App quit closes admission permanently; ordinary Runtime cleanup reopens it only after a clean drain.

Failed clients retain their exact child ownership for a later bounded retry. Concurrent cleanup requests serialize, wait for all clients with `allSettled`, and propagate any remaining process or termination error instead of reporting a clean drain.

### Awaited Electron quit barrier

The first quit request pauses Electron and retries only after bounded Runtime cleanup succeeds. Cleanup awaits the TUI pool and every Aera-owned ordinary Gateway process tree.

Repeated in-flight requests reuse one cleanup; unresolved ownership or termination keeps Electron open and a later explicit quit may retry.

## Explicit external compatibility

External Runtime use is retained only as a legacy persisted compatibility mode for existing developer installations; packaged managed mode is the only first-install product path.

[[src/main/agentera-runtime-distribution/selection-store.ts#readRuntimeSelection]] migrates only the exact legacy `{ hermesHome }` record to external mode. New product installations do not expose that selection in startup UI. Existing records retain an exact schema, selection mode, and physical Hermes home; compatibility never moves, rewrites, or deletes the external checkout or its adaptive data.

[[src/main/installer.ts#runHermesUpdate]] rejects managed mode and, in explicit external mode, invokes only the selected checkout's interpreter with `python -m hermes_cli.main update` from that checkout. The Settings card labels this path unmanaged and offers a separate switch to the signed managed Runtime. The welcome and repair surfaces no longer expose upstream `curl`, PowerShell, Git clone, or remote-script commands.

## Update policy

The desktop checks for stable Runtime updates automatically but downloads only after explicit user confirmation and switches only after the user restarts.

Downloads are resumable and must pass repository, platform, architecture, compatibility, Ed25519 signature, and SHA-256 checks. A candidate is staged outside the current Runtime and failed health checks restore the previous version.

[[src/main/agentera-runtime-distribution/update-client.ts#checkStableRuntimeUpdate]] obtains only the reviewed stable index, its signature, and the selected target's manifest and signature. The configured Aera Cloud origin's exact `/runtime-updates/stable/` route is the primary transport, with the public GitHub stable channel retained as a fallback only when the complete primary-source attempt has a transport failure. A signature, schema, URL, or cross-check failure is terminal and never triggers source fallback; metadata from two sources is never mixed. The client verifies both signed layers against the production trust set, cross-checks repository, full commit, version, target, names, and archive hash, and returns an offer without requesting archive bytes. Older, equal, or desktop-incompatible versions produce no offer; failure of every available transport leaves the current Runtime usable with a bounded public error code.

Logical update URLs are restricted to either the configured HTTPS Aera origin's exact stable metadata and immutable `releases/<tag>/<asset>` paths or the public `Ablankpaper/aera-runtime` GitHub stable-index redirect and immutable release-asset paths. Loopback HTTP remains available only for isolated development. Redirect hostnames are transport only: signatures and hashes remain the trust boundary, and no GitHub token is stored or exposed by the desktop. Main-process diagnostics record only the source, bounded request/verification stage, and stable failure class; they never include redirect URLs, response bodies, local paths, credentials, or raw exceptions.

Runtime metadata and archive traffic use Electron's Chromium network stack so the updater honors the operating system's proxy configuration. First-party metadata is requested directly; GitHub fallback metadata follows the reviewed redirect inside Chromium. Before an archive stream starts, [[src/main/agentera-runtime-distribution/electron-transport.ts#createElectronRuntimeDownloadUrlResolver]] uses `net.request` to validate every redirect synchronously, enforce the redirect limit and HTTPS anti-downgrade rule, and resolve the final transport URL; [[src/main/agentera-runtime-distribution/downloader.ts#downloadWithResume]] then streams that exact URL through `net.fetch` with further redirects disabled. The final signed manifest, expected size, and SHA-256 remain authoritative even when GitHub's transport hostname changes.

[[src/main/agentera-runtime-distribution/downloader.ts#downloadWithResume]] writes only to a destination `.part` plus `.part.json` below the caller-owned Runtime downloads directory. Resume requires the same URL, expected size, expected SHA-256, unexpired metadata, exact local byte count, valid `Content-Range`, and matching ETag and Last-Modified validators when present. A server that ignores Range safely restarts from byte zero.

Connect, idle-read, overall, and redirect limits are bounded. Cancellation and transport interruption retain a verified-length partial for retry; stale or mismatched metadata and completed wrong-size or wrong-hash bytes are deleted. Only a complete streaming SHA-256 match is atomically renamed to the requested destination.

The cancellation regression aborts only after observed download progress, proving resumable partial retention without depending on operating-system scheduler timing.

[[src/main/agentera-runtime-distribution/manager.ts#createRuntimeDistributionManager]] is the only archive-download entrypoint. After explicit confirmation it independently re-verifies the downloaded artifact, extracts into a fresh Runtime-owned transaction, adds the signed manifest sidecars, publishes a version directory, and writes a non-active candidate pointer. Cancellation or any verification/extraction failure leaves `current.json` unchanged. [[src/main/runtime-activity.ts#RuntimeActivityCoordinator]] reserves each chat before gateway or transport setup begins and atomically excludes new runs once a Runtime transition is reserved; stale completion callbacks cannot remove a replacement run with the same ID. Restart is refused while a task is active; otherwise the transition reservation is acquired before Runtime-owned processes stop, the candidate is marked for next-launch activation, and the app requests relaunch. A failed restart preparation releases the reservation without changing the running Runtime.

[[src/main/app/start.ts#startMainProcess]] creates the lifecycle manager from the same trust and target context as startup bootstrap. Once the authenticated online main window is available it performs a non-blocking metadata-only check once per signed-in user; offline sessions do not check. Failed candidates are discarded before returning to a healthy current version, while a missing Runtime can be repaired only through the signed packaged Seed installer.

The launch that installs or repairs from the exact packaged Seed does not immediately contact the public stable channel. The manager marks that in-memory state as not checkable for the remainder of the launch; a later app launch reconstructs the journal with normal stable-update checks enabled. This keeps first installation local-only without permanently disabling reviewed updates.

[[src/shared/agentera-runtime-distribution.ts#serializeRuntimeDistributionPublicState]] rebuilds every renderer-visible lifecycle state from an exact field allowlist and accepts only bounded Runtime error codes. The authenticated `window.agenteraRuntimeDistribution` preload namespace exposes state, check, explicit download, cancellation, restart, repair, and state-change events without URLs, paths, signatures, keys, tokens, or owner identifiers.

[[src/renderer/src/components/settings/RuntimeDistributionCard.tsx#RuntimeDistributionCard]] gives Runtime updates their own About card, separate from the desktop app updater. It shows managed status, version, and short source commit; download requires a modal that names the version, trusted `Ablankpaper/aera-runtime` source, and size. The checkout-local unmanaged updater appears only in explicit external mode.

The card claims “up to date” only after a successful metadata check with no offer. If the stable channel cannot be reached or its metadata is rejected, the current signed Runtime remains active but is labeled only as usable; the bounded update error remains visible so transport failure cannot be mistaken for freshness proof.

[[src/main/agentera-runtime-distribution/bootstrap.ts#bootstrapRuntimeDistribution]] runs before `app/start` is dynamically imported. An approved candidate's signature, pointer binding, complete extracted inventory, and isolated offline health are checked again below `userData/runtime/health`; only then does the journal move current to previous and candidate to current. Failure keeps the existing current version, records only an error code, numeric exit code, version, short commit, and timestamp, and durably suppresses the failed candidate until a newer staging action replaces it. No path, credential, Profile, Memory, session, learned Skill, or raw exception enters the diagnostic.

The crash-recovery test preserves all real temporary-file and pointer assertions while allowing a Windows-specific I/O budget; other platforms retain the default five-second bound.

### Stable update test specifications

These focused tests lock the source-authority and supported-platform behavior of signed stable Runtime update checks.

#### Primary stable source

The configured Aera stable origin can produce a verified offer without consulting GitHub, so GitHub availability is not required for the primary update path.

#### Transport-only fallback

A complete first-party transport failure may restart metadata retrieval from GitHub while recording a bounded diagnostic and never mixing metadata across sources.

#### Invalid metadata fails closed

Invalid first-party signatures or metadata terminate the check without consulting GitHub, preventing an authority downgrade after verification failure.

#### Seed point-one to stable point-three

macOS ARM64 and Windows x64 both offer the signed Runtime `.3` release when the installed packaged Seed is `.1`.

## Release gate

Every seed must pass the native Hermes compatibility gate and a clean extracted-artifact smoke test before publication or desktop packaging.

The gate proves stable conversations, background learning, next-conversation recall, Curator behavior, Profile isolation, offline use, migration, update, and rollback without changing private adaptive state.

[[tests/runtime-data-boundary.test.ts]] hashes realistic default and named Profiles, modes, symlink targets, sessions, Memory, learned Skills, Curator state, Gateway/Cron state, logs, attachments, and workspaces after every install/update/activation/rollback/cleanup/selection/repair transition. [[tests/e2e/agentera-runtime-seed.e2e.ts]] adds the product-level proof: enter through the account-required product, complete explicit online browser authentication, automatically prepare and invoke the native packaged Seed with public Runtime HTTP blocked and no Runtime-choice controls, stop the control plane, restart under the signed offline entitlement, and confirm the same Runtime version plus every pre-existing Hermes-owned entry survives unchanged. Runtime-owned logs may append while their original prefix and permissions remain intact; other pre-existing entries remain byte-identical. The E2E command rebuilds first so stale `out/` assets cannot reintroduce removed startup screens.

## Independent verification

The main process verifies canonical manifest bytes, Ed25519 trust, signed context, archive size, and SHA-256 before accepting a Runtime artifact.

A separate build-time MJS verifier repeats the checks without importing desktop TypeScript. Packaging reads an exact repository, tag, full commit, and target asset lock; it never resolves `latest`.

## Native packaging gate

Native packaging embeds one exact verified Seed and fails closed if any required artifact or proof is missing.

`scripts/prepare-agentera-runtime-seed.mjs` selects exactly one locked native target, obtains only its archive, manifest, and signature, runs the independent verifier, compares the verified repository, Runtime version, and full source commit with the lock, then atomically replaces the ignored build-staging directory. An explicit `AGENTERA_RUNTIME_SEED_DIR` is development-only; CI rejects it, and failed verification leaves the previous stage unchanged. Both importable Runtime packaging CLI modules are pinned to LF checkout bytes so their hashbang lines remain parseable under Windows Git configurations that otherwise convert text files to CRLF.

Electron Builder excludes the staging directory from `app.asar`, then copies only the three verified files from `resources/agentera-runtime-seed` into the application `Resources/agentera-runtime-seed` directory. `scripts/verify-packaged-runtime-seed.mjs` rejects partial, mixed-target, or extra contents and can prove every packaged byte matches the verified staging reference.

[[src/main/agentera-runtime-distribution/seed-path.ts#resolvePackagedRuntimeSeedDirectory]] resolves packaged resources from Electron `resourcesPath`. Development and native E2E resolve the same verified staging directory, with an absolute explicit override allowed only outside packaged builds, so source runs exercise the real local installer instead of reporting a false missing-Seed failure.

Stable and beta release workflows currently build only macOS ARM64 and Windows x64. Each native job prepares the exact Seed before packaging and verifies the unpacked application plus final DMG, ZIP, NSIS, and portable artifacts. CI may use its workflow token while fetching the public locked Release, but no token enters the desktop package. Linux and macOS x64 publishing remain disabled until signed native Seed targets and the same final-artifact proof exist.

## Later delivery

After Runtime distribution is stable, delivery continues with workspace cloud foundations and then desktop workspace adoption.

The cloud phase adds membership, invitations, Owner/Admin/Member policy, and audit. The desktop then adds personal/workspace switching plus Agent definition, draft, immutable-version, and permission sync. Organization and official Agent management follow separately.

Neither later project may reintroduce whole-file Memory sync or make local Hermes learning depend on the control plane.
