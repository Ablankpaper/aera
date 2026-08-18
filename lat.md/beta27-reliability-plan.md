# Beta.27 Reliability Plan

Beta.27 is an approved Desktop implementation plan; this section records its intended boundaries without claiming that the product code, Electron gate, release, or updater rollout already exists.

## Owner model-route authority

Main will provide one owner-scoped catalog for [[provider-setup]], Agent installation, and installed-Agent chat so those surfaces cannot select different Profile sets.

The public selection is an opaque source Profile/model handle plus catalog revision. Canonical provider, endpoint, API mode, and credential availability are revalidated in Main, while credential references and values remain outside public catalog output.

Credential-free catalog routes are limited by [[src/shared/url-key-map.ts#isLocalBaseUrl]] to the explicit loopback/private-host policy. A numeric public IP is still remote and remains unavailable without same-Profile credential evidence.

### Owner transition and bounded authentication recovery

Owner changes drain the old Runtime and invalidate its leases before another owner can mount; provider authentication may refresh only a Runtime-owned OAuth credential once and retry one idempotent request.

[[src/main/agentera-connection-owner.ts#createAgenteraOwnerSwitchCoordinator]] serializes owner transitions, aborts the previous epoch, waits for [[src/main/runtime-activity.ts#RuntimeActivityCoordinator#waitForIdle]], and fails closed with a bounded timeout or stable failure code. [[src/main/agent-model-execution-lease.ts#createAgentModelExecutionLease]] upgrades a three-field legacy route only through one same-owner catalog match and checks the owner epoch around transport setup and completion; missing or ambiguous matches never execute anonymously.

[[src/main/provider-credential-refresh.ts#createProviderCredentialRefreshPort]] is the only Desktop-to-Runtime refresh boundary. It admits only `source=runtime_pool`, OAuth, refresh-token-bearing credentials, passes a provider name to Runtime's own pool implementation, bounds process time/output, and returns status words without secrets. [[src/main/provider-authentication-recovery.ts#runProviderAuthenticationRecovery]] caps recovery at one refresh and one retry; static keys, rejected refreshes, owner changes, and a second 401 remain fail-closed.

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

### Sanitized Beta.29 dirty-route fixture

The fixture preserves the capture's counts, duplicate endpoints, one unrelated route, managed roles, and journal states; it excludes credentials, identities, domains, paths, logs, and database pages.

Git keeps the fixture's reviewed bytes LF-stable on every CI platform.

### Strict route repair planning

[[src/main/model-configuration-reconciler.ts#planModelRouteDirectoryRepair]] parses one in-memory five-file snapshot and either returns deterministic patches or a fail-closed repair code; it never reads disk, resolves secret values, writes files, or opens the operation journal.

### Stable provider endpoint updates

[[src/main/models.ts#planAddModel]] retains Hermes endpoint-distinct append behavior for legacy rows, while a stable provider id makes the endpoint mutable within one provider, model, and protocol group so endpoint changes replace and converge only that owned group.

### Config-only active route reconstruction

A uniquely resolved config route keeps an existing model-row id or receives one deterministic V2-derived row; missing credential, protocol, provider, or model-definition evidence leaves every managed byte unchanged and requires repair.

### Managed lock order is deterministic

Mixed model mutations acquire the global catalog before stable-sorted, unique Profile locks, and a nested Profile-to-global acquisition fails before its callback runs.

### Opaque permits fence managed files

Low-level writes to the five managed roles require an active permit whose global and Profile scope exactly covers the resolved target.

The permit exists only inside the ordered write-authority callback; callers cannot construct, retain, or reuse it to bypass the transaction journal.

### Platform-specific durable replacement

Temporary bytes are flushed before same-volume replacement, then the replaced target is reopened and flushed before the parent directory where supported.

[[src/main/utils.ts#flushDurableFileTarget]] opens the target with write access on Windows because `FlushFileBuffers` requires `GENERIC_WRITE`. POSIX keeps a read-only flush handle and parent-directory fsync; Windows relies on the journal instead of claiming unsupported directory fsync.

### Rollback refresh follows terminal recovery

A verified rollback reaches its terminal journal state before provider, model, config, and model-definition consumers are notified.

Notification failure returns a refresh warning without changing restored bytes, relocking the Profile, or rewriting the terminal recovery decision.

### Managed writer inventory rejects bypasses

The release verifier rejects raw writes, removals, aliased wrappers, and Profile lifecycle subprocesses unless the exact function is registered at the managed transaction boundary.

### Windows process-crash recovery gate

Real Windows CI terminates a child mutation at every modeled journal window and requires deterministic recovery plus bounded evidence rooted only in a generated temporary directory.

### Model reads are byte side-effect free

Model/config list and get functions never seed, migrate, or rewrite managed files; startup maintenance is planned separately from ordinary reads.

### Explicit model catalog initialization

[[src/main/models.ts#planModelCatalogInitialization]] computes a read-only plan, and [[src/main/model-configuration-coordinator.ts#ModelConfigurationCoordinator#initializeManagedModelFiles]] applies needed changes through the five-file journal. A verified no-op takes the same ordered locks but writes no journal row.

### Indirect feature writers use the managed boundary

Agent Sync, auxiliary tasks, toolsets, image generation, registry, messaging, Gateway, wallet sync, and Agent Profile seeding submit changes through [[src/main/model-configuration-mutation-port.ts#createManagedModelMutationPort]].

A recovery or ownership refusal occurs before the feature write callback and therefore leaves `.env`, `providers.json`, `models.json`, `model-definitions.json`, and `config.yaml` unchanged.

### Hermes projection config activation is transactional

[[src/main/agentera-agent-control/hermes-projection.ts#HermesProjectionManager#activateForProfile]] waits for managed admission before switching the active Skill projection or updating Profile `config.yaml`.

Installation, managed update, restore, and rollback paths await activation; an asynchronous projection failure cannot be recorded as a successful installation or update.

### Staged Profile activation protects live state

Profile lifecycle operations materialize in app-owned same-volume staging and activate only after validation.

[[src/main/model-configuration-staged-profile.ts#createStagedProfileCandidate]] stages Runtime clones, fresh Agent Profiles, and encrypted-backup restores. It strictly parses every present managed role, rejects escaping links, rechecks the owner reservation and destination collision under the ordered write authority, then publishes the candidate with one directory rename.

The activation journal records only a random transaction id, Profile id, source kind, and terminal state; it stores no filesystem path or file body. A refused candidate removes only its own staging directory, while a committed candidate dynamically registers its live Profile root so later managed writes still require a coordinator permit.

[[src/main/profiles.ts#prepareProfile]] keeps the Runtime subprocess on the staged `HERMES_HOME`. [[src/main/agentera-agent-control/installation-manager.ts#AgentInstallationManager#activateVerifiedRestore]] merges decrypted backup bytes into that candidate and revalidates it before activation, rather than copying files into an already-live Profile.

### Profile clone snapshots preserve provider identity

Profile clones read one stable source snapshot before Runtime materialization begins.

[[src/main/profiles.ts#prepareProfile]] copies the global catalog and the source Profile under the ordered write authority. The staged snapshot includes `providers.json` alongside credentials and route configuration, so cloning a named custom provider cannot lose its provider identity or observe a cross-file save in progress.

### Profile deletion shares the managed write authority

Profile deletion waits behind every managed write targeting that Profile.

[[src/main/profiles.ts#deleteProfile]] preserves the existing Runtime deletion command but executes it only after acquiring the ordered write authority. The structural writer gate treats raw remove APIs and every `profile delete` subprocess as managed mutations; only the explicitly registered serialized deletion function is accepted.

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

Darwin inventory accepts only validated 64-bit Mach-O bundles and slices. Every `LC_SEGMENT_64` has an exact section-table size and a safe in-slice file range, non-empty mapped segments cannot overlap, and exactly one readable/executable `__TEXT` segment starts at file offset zero and covers the header plus load commands. Win32 accepts only PE32+ executable DLL images with power-of-two file and section alignment, bounded aligned headers and image size, non-overlapping aligned raw and virtual section ranges, and at least one non-empty readable executable code section. ABI markers are read only from validated mapped segment or section ranges, and every in-memory and persisted module record includes the stable `mach-o` or `pe` format.

The unpacked root and every descendant are checked with `lstat`, and every resolved path must remain inside the canonical root. Each traversed directory snapshot retains device, inode, type, size, canonical path and identity, plus its sorted direct child name/type surface, then revalidates those observations bottom-up with `lstat`, `realpath`, and `readdir`.

Collection retains each file's device, inode, type, and size; reading opens that path with no-follow where available, matches `fstat` on the same handle, reads that handle once, and then closes it. After every native module has been read and inspected, the verifier performs a second complete stable scan and compares the entire relative-path surface by device, inode, type, and size before it writes the inventory.

Every shipped native module is inspected through `scripts/release/native-module-abi.mjs` and `scripts/release/verify-packaged-native-module.mjs`.

This source-stage inventory is not final-artifact binding; DMG, updater ZIP, setup, and portable bytes still require independent extraction and binding before a candidate can be accepted.
