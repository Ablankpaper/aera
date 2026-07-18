# AgentEra Runtime distribution

AgentEra Studio ships a signed, platform-specific Runtime seed so first launch works without GitHub while Hermes Profile data and self-learning remain isolated.

## Distribution boundary

The public `bignormal/aera-runtime` repository produces versioned Runtime artifacts, while the desktop validates, packages, installs, updates, and rolls them back.

The cloud account service does not distribute Runtime binaries or expose GitHub credentials. Desktop application updates remain a separate channel described by [[desktop-updates|Desktop Updates]].

## Runtime seed

A seed contains runnable Python, locked core dependencies, AgentEra Runtime, CLI, Dashboard assets, base tools, a manifest, and an Ed25519 signature.

The seed excludes Git history, tests, caches, credentials, Profiles, Memory, sessions, Chromium, speech models, and local model weights. macOS ARM64 and Windows x64 are the first supported seed targets.

## Offline first installation

After product authentication, the main process verifies the packaged seed, installs it into a versioned application-data directory, and atomically selects it without network access.

A missing or invalid seed enters a repair state. The desktop never falls back to cloning upstream `main`, executing a remote install script, or downloading an unsigned Runtime.

## Offline Seed installation and repair

Packaged Seed installation is verified, transactional, local-only, and isolated from Hermes-owned adaptive state.

[[src/main/agentera-runtime-distribution/extractor.ts#extractRuntimeArchive]] accepts only the signed platform format: TAR/Zstandard for macOS ARM64 and ZIP for Windows x64. Archive paths, normalized metadata, case-folded Windows duplicates, symlink targets, entry types, sizes, and the decompression budget are checked against the signed inventory before a version can be published. The extracted tree is then walked without following links, re-hashed, permission-normalized, and compared path-for-path with the manifest.

Extraction occurs only below a fresh `userData/runtime/staging/seed-*` transaction. Failure or cancellation deletes the destination owned by that transaction; it cannot clean another staging child, a current version, or `HERMES_HOME`.

[[src/main/agentera-runtime-distribution/seed-installer.ts#installPackagedSeed]] discovers exactly one packaged archive, canonical manifest, and signature, verifies them with the production trust set, and checks free space for archive bytes plus extracted bytes plus one rollback-version reserve plus a ten-percent margin. It health-checks the candidate in staging, renames the verified payload into `versions`, writes `current.json` atomically, selects managed mode, and refreshes the live invocation.

[[src/main/agentera-runtime-distribution/health.ts#runIsolatedRuntimeHealthCheck]] runs version, server-help, and core-import probes with a disposable fake HOME and HERMES_HOME, an allowlisted environment, no inherited credentials, and offline package-manager flags. A corrupt same-version current Runtime is repaired into a new version directory, leaving the old directory and every Hermes-owned Profile, Memory, session, learned Skill, and Curator file untouched.

The authenticated `start-install` IPC path calls only the packaged Seed installer. Missing or corrupt packaged resources return `repair-required` with a reinstall-desktop action; low disk returns a free-space action. Neither result can reach the retained migration-only online installer.

## Version state journal

Mutable Runtime versions and current, previous, and candidate pointers live only below Electron `userData/runtime`. Each pointer update fsyncs a temp file, renames it atomically, then fsyncs the parent directory where supported.

Recovery removes only pointer temp files and stale transactions proven to be under Runtime staging or downloads. Version cleanup keeps every referenced directory and rejects lexical or real-path escape, including parent symlinks.

## Program and Profile isolation

Runtime program versions live below Electron `userData`, while Hermes-owned state remains in its physically isolated `HERMES_HOME`.

Installation, update, rollback, and cleanup never overwrite or traverse private Memory, USER data, sessions, learned Skills, Curator state, credentials, Gateway state, Cron state, logs, or workspace files. This is governed by [[agentera-self-evolution|AgentEra self-evolution compatibility]].

## Live Runtime invocation

Every local Runtime operation resolves the currently selected managed or explicit external installation at call time through one main-process abstraction.

[[src/main/agentera-runtime-distribution/invocation.ts#getRuntimeInvocation]] returns one immutable invocation snapshot containing the interpreter, working directory, bundled Skills, Dashboard assets, module CLI builder, and environment builder. A spawn uses that same snapshot throughout so a concurrent version switch cannot mix files from two Runtime versions.

Both managed and external modes launch `python -m hermes_cli.main`. Managed mode points into the installed seed, removes inherited `PYTHONHOME` and `PYTHONPATH`, and sets `PYTHONNOUSERSITE=1`; explicit external mode keeps the existing `HERMES_HOME/hermes-agent` compatibility layout.

Callers continue to supply the existing physical `HERMES_HOME` or Profile home. Runtime selection never redirects, migrates, copies, or deletes Memory, Profiles, sessions, learned Skills, credentials, or other adaptive state. Missing or stale selections return a bounded "Runtime is not prepared" result instead of invoking a fallback executable.

Chat and Gateway, Dashboard, Skills, Profiles, Cron, model discovery, MCP, account authentication, Kanban, compatibility probing, and startup preflight all consume the live invocation rather than module-level executable paths. [[src/main/agentera-runtime-distribution/invocation.ts#refreshRuntimeInvocation]] re-resolves the selection after seed installation or activation.

## Update policy

The desktop checks for stable Runtime updates automatically but downloads only after explicit user confirmation and switches only after the user restarts.

Downloads are resumable and must pass repository, platform, architecture, compatibility, Ed25519 signature, and SHA-256 checks. A candidate is staged outside the current Runtime and failed health checks restore the previous version.

[[src/main/agentera-runtime-distribution/update-client.ts#checkStableRuntimeUpdate]] obtains only the reviewed stable-index redirect, its signature, and the selected target's manifest and signature. It verifies both signed layers against the production trust set, cross-checks repository, full commit, version, target, names, and archive hash, and returns an offer without requesting archive bytes. Older, equal, or desktop-incompatible versions produce no offer; transport failure leaves the current Runtime usable with a bounded public error code.

Logical update URLs are restricted to the public `bignormal/aera-runtime` GitHub stable-index redirect and immutable release-asset paths. Redirect hostnames are transport only: signatures and hashes remain the trust boundary, and no GitHub token is stored or exposed by the desktop.

[[src/main/agentera-runtime-distribution/downloader.ts#downloadWithResume]] writes only to a destination `.part` plus `.part.json` below the caller-owned Runtime downloads directory. Resume requires the same URL, expected size, expected SHA-256, unexpired metadata, exact local byte count, valid `Content-Range`, and matching ETag and Last-Modified validators when present. A server that ignores Range safely restarts from byte zero.

Connect, idle-read, overall, and redirect limits are bounded. Cancellation and transport interruption retain a verified-length partial for retry; stale or mismatched metadata and completed wrong-size or wrong-hash bytes are deleted. Only a complete streaming SHA-256 match is atomically renamed to the requested destination.

## Release gate

Every seed must pass the native Hermes compatibility gate and a clean extracted-artifact smoke test before publication or desktop packaging.

The gate proves stable conversations, background learning, next-conversation recall, Curator behavior, Profile isolation, offline use, migration, update, and rollback without changing private adaptive state.

## Independent verification

The main process verifies canonical manifest bytes, Ed25519 trust, signed context, archive size, and SHA-256 before accepting a Runtime artifact.

A separate build-time MJS verifier repeats the checks without importing desktop TypeScript. Packaging reads an exact repository, tag, full commit, and target asset lock; it never resolves `latest`.

## Native packaging gate

Native packaging embeds one exact verified Seed and fails closed if any required artifact or proof is missing.

`scripts/prepare-agentera-runtime-seed.mjs` selects exactly one locked native target, obtains only its archive, manifest, and signature, runs the independent verifier, compares the verified repository, Runtime version, and full source commit with the lock, then atomically replaces the ignored build-staging directory. An explicit `AGENTERA_RUNTIME_SEED_DIR` is development-only; CI rejects it, and failed verification leaves the previous stage unchanged.

Electron Builder excludes the staging directory from `app.asar`, then copies only the three verified files from `resources/agentera-runtime-seed` into the application `Resources/agentera-runtime-seed` directory. `scripts/verify-packaged-runtime-seed.mjs` rejects partial, mixed-target, or extra contents and can prove every packaged byte matches the verified staging reference.

Stable and beta release workflows currently build only macOS ARM64 and Windows x64. Each native job prepares the exact Seed before packaging and verifies the unpacked application plus final DMG, ZIP, NSIS, and portable artifacts. CI may use its workflow token while fetching the public locked Release, but no token enters the desktop package. Linux and macOS x64 publishing remain disabled until signed native Seed targets and the same final-artifact proof exist.

## Later delivery

Cloud Agent definition and immutable-version sync starts only after Runtime distribution is stable, followed by a separate workspace and organization project.

Neither later project may reintroduce whole-file Memory sync or make local Hermes learning depend on the control plane.
