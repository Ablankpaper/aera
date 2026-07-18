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

## Program and Profile isolation

Runtime program versions live below Electron `userData`, while Hermes-owned state remains in its physically isolated `HERMES_HOME`.

Installation, update, rollback, and cleanup never overwrite or traverse private Memory, USER data, sessions, learned Skills, Curator state, credentials, Gateway state, Cron state, logs, or workspace files. This is governed by [[agentera-self-evolution|AgentEra self-evolution compatibility]].

## Update policy

The desktop checks for stable Runtime updates automatically but downloads only after explicit user confirmation and switches only after the user restarts.

Downloads are resumable and must pass repository, platform, architecture, compatibility, Ed25519 signature, and SHA-256 checks. A candidate is staged outside the current Runtime and failed health checks restore the previous version.

## Release gate

Every seed must pass the native Hermes compatibility gate and a clean extracted-artifact smoke test before publication or desktop packaging.

The gate proves stable conversations, background learning, next-conversation recall, Curator behavior, Profile isolation, offline use, migration, update, and rollback without changing private adaptive state.

## Independent verification

The main process verifies canonical manifest bytes, Ed25519 trust, signed context, archive size, and SHA-256 before accepting a Runtime artifact.

A separate build-time MJS verifier repeats the checks without importing desktop TypeScript. Packaging reads an exact repository, tag, full commit, and target asset lock; it never resolves `latest`.

## Later delivery

Cloud Agent definition and immutable-version sync starts only after Runtime distribution is stable, followed by a separate workspace and organization project.

Neither later project may reintroduce whole-file Memory sync or make local Hermes learning depend on the control plane.
