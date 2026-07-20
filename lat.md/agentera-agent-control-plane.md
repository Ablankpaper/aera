# AgentEra Agent control plane V1

The first AgentEra control-plane slice publishes USER-owned stable Agent versions without turning drafts or Hermes private runtime state into cloud data.

## First-release boundary

The original V1 slice implements `owner_scope=USER`; the approved Workspace Agent extension now adds WORKSPACE-owned definitions and versions without expanding runtime-data ownership.

The cloud is an identity, version, policy, installation, binding-metadata, and audit control plane. Agent execution and model access stay on the user's computer.

## Approved Workspace Agent extension

The next approved slice adds Workspace ownership only to published AgentDefinition and AgentVersion assets while keeping each member's Installation, RuntimeBinding, physical Hermes Profile, and adaptive state USER-owned.

Owner and Admin may publish immutable Workspace versions, and active Members may discover and install them. The desktop derives the target from the trusted global Workspace context rather than renderer-supplied ownership fields. Shared Knowledge, Skill, and SOP assets enter Hermes only through the existing verified read-only projection. The locked design is `docs/superpowers/specs/2026-07-20-agentera-workspace-agent-v1-design.md`.

## Approved Organization foundation boundary

The approved enterprise foundation adds Organization identity, transferable ownership, roles, Departments, signed policy, audit, lifecycle, and trusted product context before Agent control accepts Organization-owned assets.

[[agentera-organizations|Organization Foundation V1]] deliberately exposes an explicit unavailable Agent state while an Organization is selected. It does not map Organization navigation to USER ownership, add `owner_scope=ORGANIZATION`, create an Installation, or touch a Hermes Profile. The next separate Agent slice consumes the foundation's authorization and policy contracts.

## Trusted Workspace Agent context

The main process derives one exact USER or WORKSPACE asset context from product navigation and never accepts ownership fields through Agent IPC.

### Nested Workspace routes

Workspace discovery and immutable publication use the exact nested Workspace API paths while USER requests retain their existing routes.

[[src/main/agentera-agent-control/client.ts#AgenteraAgentControlClient#listWorkspaceDefinitions]] validates Workspace identifiers, strict response DTOs, bearer authentication, and stable authorization errors without exposing response bodies.

### Role-gated publication

Owner and Admin can prepare and confirm Workspace publication, while Member is rejected locally before signing-key refresh or upload.

[[src/main/agentera-agent-control/publisher.ts#AgentPublisher]] binds each one-use preview to its target scope and dispatches initial and next immutable versions through the corresponding USER or Workspace client method.

### Local context partitions

Draft and Installation presentation is filtered by the exact selected context while the underlying Installation owner and device tuple remain USER-owned.

[[src/main/agentera-agent-control/manager.ts#AgenteraAgentControlManager]] supplies the trusted context to draft, discovery, publication, and install-source operations. Version cache, Profile binding, Hermes adapter, and RuntimeBinding components remain keyed only by USER, device, and Runtime version.

### Context-only refresh

Changing the selected product space invalidates publication handles and refreshes Agent control state without selecting, reading, creating, or mutating a Profile or RuntimeBinding.

The startup composition subscribes the Agent manager only to [[src/main/agentera-workspace/manager.ts#AgenteraWorkspaceManager#subscribeSelectedAgentContext]] and calls its context refresh hook. Runtime lifecycle remains outside that bridge.

### Role-aware presentation

The main process returns the trusted USER or WORKSPACE context with Agent control state. The Agent screen follows that state instead of reading Workspace authorization independently or accepting scope fields in mutation calls.

Personal behavior remains unchanged. Workspace Owner and Admin can view and author their account-local Workspace drafts while online; Member receives an install-only view and the renderer does not enumerate drafts. Offline Workspace drafts remain visible to their Owner or Admin but every field and author action is read-only.

[[src/renderer/src/screens/Agents/AgentControlPanel.tsx#AgentControlPanel]] closes context-bound dialogs when the selected scope, Workspace, or role changes and pauses Workspace discovery, installation, publication, and updates offline. [[src/renderer/src/screens/Agents/AgentDraftEditor.tsx#AgentDraftEditor]] renders the publication target from the one-use preview returned by main and never submits a Workspace ID, owner scope, or role.

Lifecycle denials preserve the stable `workspace_forbidden`, `workspace_archived`, and `workspace_owner_unavailable` codes while discarding raw cloud bodies and private error details.

### ExperienceCandidate authorization surface

The Workspace promotion surface keeps local preparation available with authenticated or valid offline access while requiring online access for every cloud submission, review-queue read, detail read, and terminal review.

Active Workspace Members may list eligible Skills, prepare one detached snapshot, submit it explicitly, and read their own candidate status. Owner and Admin additionally receive the review queue and may approve or reject once; Member review calls fail locally before cloud access.

The Agent-control preload exposes only candidate and Installation identifiers, the selected Skill name, the exact submit confirmation, and bounded review fields. Trusted Workspace context, account/device ownership, role, Profile resolution, candidate source path, mutation intent, and cloud credentials remain main-process state.

Account, device, or selected-space changes discard the cached candidate service before later reads. The local store and cloud requests remain partitioned by the newly derived owner/context, preventing a long-lived desktop manager from carrying candidate handles across sessions.

### Approved candidate draft import

Owner and Admin can turn one terminally approved candidate into a new local Workspace Agent draft without granting the renderer ownership or filesystem control.

The renderer first requests a preview by candidate ID, then confirms only a one-use import handle with the exact `apply-approved-skill-to-latest` phrase. Workspace ID, role, account/device identity, cloud origin, Profile paths, source paths, version bytes, and draft contents remain derived in the main process.

Import always starts from the currently published, signature- and digest-verified Workspace version. If the definition advances between preview and confirmation, `candidate_base_advanced` is returned before SQLite mutation so the UI can request a fresh diff.

The local draft and import receipt commit together. Approval itself remains cloud state, import remains device-local and idempotent per account/device, and publication remains the existing separate explicit action.

### Role-aware experience presentation

The renderer keeps promotion, review, draft import, and publication as separate visible actions without accepting ownership or Profile data.

[[src/renderer/src/screens/Agents/ExperiencePromotionDialog.tsx#ExperiencePromotionDialog]] exposes preparation and upload as separate user actions. It renders eligible names and safe preview metadata but never receives a Profile path, source path, Workspace ID, owner tuple, bundle bytes, DLP override, or cloud origin. Offline preparation remains available; upload failure remains an explicit manual retry with no background timer.

[[src/renderer/src/screens/Agents/ExperienceCandidatePanel.tsx#ExperienceCandidatePanel]] calls the own-status list for every Workspace role and does not call review-list or review-detail methods for Member. [[src/renderer/src/screens/Agents/ExperienceReviewDialog.tsx#ExperienceReviewDialog]] commits a bounded terminal decision before requesting an approved import preview, confirms same-name replacement, refreshes a stale base without a draft mutation, and passes only the returned draft to the existing editor.

Agent-control state invalidation closes promotion, review, installation, publication, and archive dialogs and refreshes the candidate panel even when the visible Workspace scope key is unchanged. This fail-closed renderer rule complements the main process clearing one-use handles on account, device, and selected-context changes.

## Owner identity

The USER owner tuple is derived from the authenticated product session and cannot be selected by request payloads.

`tenant_id` is the account's `personal_space_id`, `owner_scope` is `USER`, and `owner_id` is the AgentEra `user_id`. The existing device-installation identity remains separate from a new per-Agent Installation ID and opaque Runtime Profile ID.

## Local drafts

Personal Agent drafts stay in an AgentEra-owned application database under Electron userData and do not synchronize to the cloud.

Draft editing does not mutate a running Profile. Importing selected Persona or Skill content is explicit and never scans or uploads Memory, USER, sessions, credentials, files, or the complete Profile.

## Local account isolation

One Electron userData root may outlive several product logins, so every local Agent record is scoped again inside the main process.

[[src/main/agentera-agent-control/db.ts#AGENTERA_CONTROL_PLANE_SCHEMA_VERSION]] schema v3 adds account ownership plus exact draft target and installation source variants. Verified versions use account-partitioned rows and paths, while migrated v2 USER rows retain their legacy cache paths.

[[src/main/agentera-agent-control/manager.ts#AgenteraAgentControlManager]] resolves the current owner for each local operation and rebuilds Runtime components after an owner change. [[tests/agentera-agent-owner-isolation.test.ts]] proves that one long-lived manager cannot list, count, or open the previous account's draft; store-level tests cover versions, installations, bindings, and pending delivery.

## Immutable publication

An explicit publish action turns one local draft revision into an immutable cloud AgentVersion under a stable AgentDefinition.

Publication uses an allowlisted canonical manifest, content digest, platform Ed25519 attestation, policy checks, idempotency, ownership authorization, and audit. A failure leaves the local draft and Hermes Profile unchanged; published versions never use last-writer-wins reconciliation.

## Installation and binding

An Agent Installation selects one immutable version for one device/Profile pair and maps to one physically isolated writable `HERMES_HOME` through the existing encrypted Profile binding store.

The authentication installation ID is not reused as the Agent Installation ID. New Agent installations create a fresh Profile with `cloneFrom=null`; existing learned Profiles require explicit same-owner claim. A RuntimeBinding freezes version, Profile, Runtime, policy, and tools for one conversation.

Manual selection downloads and verifies the immutable version, calls the cloud selection transaction, retrieves the newly signed policy through `GET /api/v1/policy-snapshots/{policy_snapshot_id}`, and only then atomically activates the read-only projection for later conversations. A missing or invalid policy leaves the last local version selected.

[[src/main/agentera-agent-control/runtime-binding-store.ts#RuntimeBindingStore]] commits a complete local binding before queuing its sanitized cloud record. [[src/main/agentera-agent-control/manager.ts#AgenteraAgentControlManager]] retries that outbox after installed turns, session attachment, and authentication changes, but delivery failure cannot delay or roll back Hermes.

## Hermes integration

Hermes remains the sole execution and self-learning engine while AgentEra supplies read-only version assets and policy at conversation start.

Published assets never overwrite private Profile paths. Native Memory, USER, background review, agent-created Skill learning, Curator, sessions, files, and credentials continue under [[agentera-self-evolution|the Hermes compatibility contract]].

## Cloud boundary

Cloud data is limited to Agent definitions, immutable versions, installations, policy snapshots, sanitized binding metadata, and audit evidence.

API keys, tokens, Base URLs, Profile paths, Memory, USER, conversations, files, credentials, unpromoted Skills, and Curator state remain local and are rejected by control-plane endpoints.

## Legacy sync separation

The imported Hermes One `/api/agents` reconciler remains a transitional compatibility feature and is not extended into the AgentEra control plane.

AgentEra uses a separate product account, cloud API, main-process module, local store, IPC namespace, and renderer state. Existing Memory exclusion remains intact, and legacy IDs are not migrated automatically.

## Offline and failure behavior

A valid offline entitlement allows cached installed versions, local RuntimeBindings, personal drafts, read-only Workspace drafts, and native Hermes learning whenever the configured model endpoint remains reachable.

Publication and discovery pause offline. Cloud, publication, installation, and audit failures never delete or roll back a draft, installed version, completed turn, Profile binding, or private adaptive state.

## Release gate

The feature cannot begin from or ship with a falsely green authentication or compatibility baseline.

Cloud tests run without cache, version immutability and owner isolation are proven, private Profile fixtures remain byte-identical through install/update failures, and active conversations keep a stable binding. The detailed approved design is `docs/superpowers/specs/2026-07-19-agentera-user-agent-control-plane-v1-design.md`.

### ExperienceCandidate boundary

The candidate gate exercises the complete selected-Skill promotion path while keeping every Installation, physical Profile, and RuntimeBinding USER-owned.

[[src/main/agentera-profile-binding.ts#AgenteraProfileBindingStore#resolveAttachedProfilePath]] resolves the candidate source only from the trusted runtime Profile ID, Agent Installation ID, and current owner. A renderer-provided Profile name or path cannot select the source.

[[tests/agentera-experience-candidate-boundary.test.ts]] locks exact renderer mutation fields and forbids candidate coupling to Hermes private-state mutation, Runtime distribution, legacy sync, or Workspace-owned runtime state.

[[tests/e2e/agentera-experience-candidate.e2e.ts]] proves Owner v1 publication, distinct Member installation, selected and unselected private learning, local secret blocking with no POST, manual retry, own-status isolation, Admin terminal review, atomic draft import, explicit v2 publication, and old/new conversation version pinning.

The harness also injects upload, review, and SQLite import failures and verifies every private fixture hash afterward. Run the executable proof with `npm run test:e2e:experience-candidate`.

### Workspace Agent isolation

The Workspace Agent gate extends the release proof from USER assets to WORKSPACE-owned definitions and versions without changing USER ownership of installations, Profiles, RuntimeBindings, or adaptive data.

[[tests/agentera-workspace-agent-boundary.test.ts]] allowlists Workspace ownership vocabulary only in Agent asset/context modules and rejects it from Hermes, RuntimeBinding, Profile binding, sessions, Skills, Curator, Runtime distribution, and legacy sync. It also locks the exact renderer mutation boundary and read-only projection path.

[[tests/e2e/agentera-workspace-agent.e2e.ts]] runs two real product accounts against the local cloud and desktop: Owner publishes v1, Member installs into a separate Profile and learns privately, Owner publishes v2, and Member selects it manually. The v1 conversation remains bound to v1, the new conversation binds v2, both bindings remain USER-owned, account caches remain distinct, published assets are read-only, and captured cloud requests contain no private learning data.

Run the executable proof with `npm run test:e2e:workspace-agent`.

### Two-device boundary

The end-to-end gate exercises one USER account through two physically isolated local device contexts.

[[tests/e2e/agentera-agent-control.e2e.ts]] launches two isolated Electron devices against a real local PostgreSQL/Redis-backed cloud. It proves draft-zero-cloud behavior, v1 publish and distinct installation, A-only Memory/Skill learning, v2 manual selection, old-conversation v1 stability, new-conversation v2 binding, sanitized requests, failure non-destruction, and absence of `/api/agents` calls.

The executable gate is `npm run test:e2e:agent-control`; contract drift is blocked by `npm run check:agentera-cloud-contract`. The test harness owns and removes only its temporary userData, `HERMES_HOME`, device keys, Runtime Seed copy, cloud process, containers, and database volume.
