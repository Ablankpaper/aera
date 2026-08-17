# Beta.27 Reliability Plan

Beta.27 is an approved Desktop implementation plan; this section records its intended boundaries without claiming that the product code, Electron gate, release, or updater rollout already exists.

## Owner model-route authority

Main will provide one owner-scoped catalog for [[provider-setup]], Agent installation, and installed-Agent chat so those surfaces cannot select different Profile sets.

The public selection is an opaque source Profile/model handle plus catalog revision. Canonical provider, endpoint, API mode, and credential availability are revalidated in Main, while credential references and values remain outside public catalog output.

Credential-free catalog routes are limited by [[src/shared/url-key-map.ts#isLocalBaseUrl]] to the explicit loopback/private-host policy. A numeric public IP is still remote and remains unavailable without same-Profile credential evidence.

## Recoverable model configuration

Provider/model edits will cross one typed Main mutation instead of several independent renderer calls, with dependency writes committed before activation and exact stage-aware outcomes.

The non-secret operation journal will live at Electron `userData/model-configuration/model-configuration.db`, outside the active Profile `state.db`. Short-lived exact sibling backups enable verified crash rollback; the journal contains only symbolic roles and digests, never keys, paths, or raw bodies.

The implemented core [[src/main/model-configuration-coordinator.ts#ModelConfigurationCoordinator]] serializes one owner/target Profile, commits dependency stages before activation, returns a distinct post-commit refresh warning, and recognizes only a fully verified commit or an exact backup restore during cold recovery. [[src/main/model-configuration-runtime.ts#prepareModelConfigurationRuntime]] opens the independent journal and completes recovery before coordinated IPC registration; a recovery failure leaves mutation IPC fail-closed while read-only surfaces remain available.

Canonical route identities contain NUL separators, so [[src/main/model-configuration-operation-store.ts#ModelConfigurationOperationStore]] writes them as bounded `b64v1` text and reconstructs the exact UTF-8 identity through SQLite `hex()` reads. This avoids driver truncation without adding a credential, path, or file body to the journal.

The NUL-delimited owner handle and composite route ID are opaque Main-only identities. Their validation permits the delimiter while still bounding length and rejecting line controls, so a real runtime owner can reach the journal and an owner catalog can expose route selections without leaking credentials.

[[src/renderer/src/screens/Providers/ModelCenter.tsx#ModelCenter]] uses the coordinated mutation whenever the Beta.27 bridge is present: one request saves dependencies and activation, a rejected stage keeps the editor open, and a post-commit refresh warning is shown as a warning rather than a failed save. The returned catalog supplies the canonical active route and target Profile. A feature-detected Beta.26 low-level bridge remains only as an older-client compatibility fallback.

### Transactional route reads bypass cache

Commit, rollback, and cold-recovery route comparisons read current Profile bytes rather than the five-second presentation cache.

### Rollback verification reads restored route

After exact snapshot restoration, route verification observes the restored route immediately and cannot misclassify it from an attempted cached route.

### Exact restored recovery row self-heals

An owned row whose five files and route exactly equal before/old becomes `rolled_back`; mixed or unverifiable evidence remains locked.

### Exact committed recovery row self-heals

An owned row whose complete files and route exactly equal after/new becomes `committed`; no partial after state is accepted.

## Legacy installation recovery

Cold recovery accepts a fresh Installation operation that names only its source Profile and intentionally inherits that Profile's current or default model.

[[src/main/agentera-agent-control/installation-operation-store.ts#InstallationOperationStore]] parses the source Profile and optional model handle independently. A model handle still requires its source Profile, while a Profile-only legacy row no longer becomes `operation_corrupt` and then `installation_conflict` after restart.

## Organization submission isolation

One stale local draft reference will be quarantined per Cloud submission instead of failing the full [[agentera-organizations]] list.

The parent Agent control panel will own one list request, while the child panel becomes presentational. A confirmed Owner/Admin detach removes only the local link and preserves the Cloud submission, draft, Version, Installation, Profile, and Hermes state.

## Immutable Agent conversation segments

Installed-Agent model changes will keep one visible thread while creating immutable local segments in [[agentera-agent-control-plane]].

Each segment freezes one resolved route, RuntimeBinding, ConversationBoundary, and Hermes session. Activation occurs at the first output or tool event; a pre-output failure leaves the previous segment active, and a post-output failure is never replayed automatically.

### Cold projection and resume

Cold startup reconstructs one visible conversation from all owner-scoped immutable Hermes segments without exposing frozen-route or credential metadata.

[[src/main/agentera-agent-control/conversation-thread-session-projection.ts#ConversationThreadSessionProjection]] collapses activated segments onto the active session, hides preparing and failed candidates, and resolves any historical segment ID to the active session. [[src/renderer/src/screens/Chat/sessionHistory.ts#mergeConversationThreadMarkers]] rebuilds renderer-only model markers from persisted history boundaries.

### Whole-thread deletion

Deleting any session belonging to a projected Agent thread removes the whole local thread rather than leaving hidden immutable segments behind.

[[src/main/ipc/conversation-session-deletion.ts#deleteConversationSessions]] expands the request and deletes Hermes sessions before thread and boundary metadata. If the local Hermes database is unavailable, control metadata is retained so a partial cleanup cannot create an unrecoverable split state.

### Runtime capability negotiation

A dynamic provider or endpoint switch is admitted only when the connected Runtime explicitly supports request-scoped Agent routes.

[[src/main/hermes.ts#supportsHermesAgentModelRoute]] requires both `features.request_model_route=true` and the canonical `/v1/chat/completions` endpoint. [[src/main/hermes.ts#sendMessage]] rejects an unsupported dynamic route before serializing `aera_model_route`, while an already configured frozen route stays on the ordinary bound transport.

## Acceptance and release boundary

The planned gate uses fresh Electron/Hermes roots, fixture Cloud state, and two loopback providers to cover save/restart, catalog consistency, A-to-B switching, policy modes, attachments, remote failure, and one Organization conflict.

Focused tests, build, and isolated Electron evidence remain separate from exact-head CI, merged-main CI, artifact publication, updater delivery, and physical internal-client acceptance.

### Native startup failure classification

Native/database startup failures are classified by [[src/main/model-configuration-database.ts#classifyNativeLoadFailure]] into stable secret-free causes; only two distinct `NODE_MODULE_VERSION` values establish an ABI mismatch.

Repeated copies of one ABI value remain a generic native load failure. The journal reads and validates `user_version` before `journal_mode=WAL` or any write-oriented pragma, so a future DELETE-journal schema is rejected without changing bytes, hash, key file stat, journal mode, or directory entries.

Main emits structured `loading` then `loaded` or `failed` evidence around the database/native loading boundary. It records the process ABI, Electron version, platform and architecture, a package-relative native locator, the ABI marker read from the actual binary, and a stable failure class; raw errors and absolute paths remain Main-only causes.

### Database startup identity reaches IPC

[[src/main/model-configuration-runtime.ts#prepareModelConfigurationRuntime]] creates one opaque diagnostic ID and [[src/main/ipc/model-configuration-bridge.ts#coordinatorUnavailableMutation]] preserves the exact cause without exposing raw native or database errors.

The propagation keeps `model_configuration_schema_unsupported` distinct from a general database-unavailable failure while leaving the journal rejection itself fail-closed.

Only `model_configuration_recovery_required` projects to the recovery stage with recovery-required rollback. Native, database, and schema startup failures project to validation with no rollback needed while preserving the same code and diagnostic ID.

### Complete packaged native inventory

The afterPack gate rejects unreadable, structurally invalid, platform-incompatible, or ambiguous `.node` input and records deterministic ABI, architecture, and SHA-256 evidence.

Darwin inventory accepts only validated 64-bit Mach-O bundles and slices; win32 accepts only validated PE32+ executable DLL images. ABI markers are read only from those verified images or fat slices, and every in-memory and persisted module record includes the stable `mach-o` or `pe` format.

The unpacked root and every descendant are checked with `lstat`, and every resolved path must remain inside the canonical root. Root device, inode, type, and size must match after canonicalization and at traversal entry and completion.

Collection retains each file's device, inode, type, and size; reading opens that path with no-follow where available, matches `fstat` on the same handle, reads that handle once, and then closes it.

Every shipped native module is inspected through `scripts/release/native-module-abi.mjs` and `scripts/release/verify-packaged-native-module.mjs`.

This source-stage inventory is not final-artifact binding; DMG, updater ZIP, setup, and portable bytes still require independent extraction and binding before a candidate can be accepted.
