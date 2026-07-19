# AgentEra USER Agent Control Plane V1 Design

## Status

Approved by the user on 2026-07-19. This specification is the implementation source of truth for the first vertical slice of the AgentEra Agent control plane.

## Goal

Build the first real AgentEra Agent product flow for `owner_scope=USER`: keep drafts local, explicitly publish immutable stable versions, install a selected version into an isolated Hermes Runtime Profile, and freeze a RuntimeBinding when a new conversation starts.

This project follows the architecture in `2026-07-17-agentera-hermes-compatible-self-evolution-architecture-design.md`. Hermes remains the execution and self-learning engine. AgentEra adds identity, ownership, policy, versioning, installation, binding, and audit around it.

## Approved Product Boundary

The user's architecture diagram is the source of truth for this project:

- Agent capabilities and immutable versions may cross an authorized owner boundary.
- Private runtime data does not cross that boundary by default.
- Every cross-boundary publication passes authorization, policy checks, audit, and explicit version publication.
- Every runnable installation has its own physical writable Hermes Profile.
- A RuntimeBinding is fixed for one conversation or isolated job.
- Hermes local learning happens before and independently of any optional AgentEra publication workflow.

The first release implements only the USER column of that model. Workspace, organization, official Agent, and experience-promotion workflows build on the same entities later.

## Non-Negotiable Hermes Compatibility Contract

Hermes is the sole writer and authority for the private adaptive state inside a Runtime Profile, including:

- `MEMORY.md` and `USER.md`;
- sessions and local files;
- credentials and provider configuration;
- agent-created skills and provenance;
- Curator state and archives;
- background review output and other native self-learning state.

AgentEra must not replace, intercept, delay, merge, upload, reset, or roll back that state. A cloud outage, failed publication, rejected version, failed installation, or policy error must not undo learning that Hermes has already persisted locally.

The integration is adapter-first. The desktop continues to invoke the real `hermes_cli.main` with the selected physical `HERMES_HOME`. No new cloud learning engine is introduced, and no Runtime core change is allowed unless a later implementation task proves that an adapter cannot meet the contract and adds a compatibility regression test first.

## Prerequisite Gate

Agent control-plane implementation starts from a green, reviewed authentication baseline.

The current `aera-cloud` authentication branch contains a time-dependent test fixture in `internal/session/revocation_test.go`: several tests use claims issued at a fixed date without injecting the matching clock. A forced non-cached `go test -count=1 ./...` therefore fails after those claims expire even though a cached run appears green.

Before feature implementation:

1. repair the test fixture so every time-sensitive test controls its clock;
2. run the complete cloud test suite without cache;
3. review the authentication branch diff and verify the worktree is clean;
4. merge the authentication baseline into `main` only with explicit user authorization;
5. create new feature branches from the resulting desktop and cloud baselines.

This gate fixes development evidence only. It does not authorize deployment or production configuration.

## Architecture Overview

The V1 product consists of a cloud control plane and a local execution plane.

```text
Desktop-local Agent draft
        |
        | explicit Publish Stable Version
        v
AgentEra Cloud
  AgentDefinition -> immutable AgentVersion
        |                    |
        +---- Installation --+
                  |
                  v
Desktop version cache + isolated Runtime Profile
                  |
                  | new conversation
                  v
immutable local RuntimeBinding -> real Hermes runtime
                  |
                  v
private local learning remains in that HERMES_HOME
```

The cloud is a control plane, not a hosted Runtime and not a cloud drive. Model calls and Hermes execution continue from the user's computer through the locally configured provider.

## Ownership Identity

V1 uses one exact owner interpretation:

```text
tenant_id   = personal_space_id
owner_scope = USER
owner_id    = user_id
```

Every authorized cloud query derives this tuple from the validated AgentEra product session. The client may submit object identifiers but may not choose another `tenant_id`, `owner_scope`, or `owner_id`.

The local installation identity extends the tuple:

```text
tenant_id / owner_scope / owner_id
device_installation_id / agent_installation_id / runtime_profile_id
```

The two installation identifiers have different meanings and must never be conflated:

- `device_installation_id` is the existing application-installation identity used by authentication, device proof, and offline entitlement;
- `agent_installation_id` is a new control-plane identity for one Agent installed on one device into one Runtime Profile.

The existing encrypted Profile binding store remains authoritative for the mapping from an opaque `runtime_profile_id` to a canonical physical Profile path. Its schema evolves without rewriting Profile contents: the existing `installationId` field migrates to `deviceInstallationId`, and an `agentInstallationId` is added only when the user explicitly installs or claims an Agent. A cloud record never contains the physical path.

## Desktop-Local Drafts

V1 deliberately has no cloud `agent_drafts` table and no draft-sync endpoint.

Drafts live in an AgentEra-owned application database under Electron `app.getPath("userData")`, outside every `HERMES_HOME`. The desktop already packages `better-sqlite3`, so the design uses a separate `agentera-control-plane/control-plane.db` rather than adding draft tables to the Hermes session database.

A local draft records:

- a local draft ID;
- an optional source `agent_definition_id` and base `agent_version_id`;
- display name and approved icon data;
- the editable Agent manifest;
- a monotonically increasing local revision;
- creation and update timestamps;
- the last publication attempt and error summary, without tokens or response bodies.

Draft assets live under `agentera-control-plane/drafts/<draft-id>/` and are referenced only through normalized relative paths. Absolute paths, parent traversal, symlinks, device files, credentials, and files discovered automatically from a Hermes Profile are forbidden.

Editing a draft does not mutate a running Profile, active conversation, published version, or installation. Importing a Persona or Skill from a local Profile is an explicit user action that copies only the selected content into the draft; the publisher never scans Memory, sessions, credentials, or the complete Profile.

## Cloud Data Model

The cloud migration adds the following USER-scoped entities.

### `agent_definitions`

An AgentDefinition is the stable catalog identity for a published Agent.

It stores its ID, owner tuple, display metadata, lifecycle status, latest published version ID, creator, and timestamps. Display metadata may change without changing the runtime behavior of an existing AgentVersion. Runtime identity and executable assets always come from the bound version manifest.

V1 accepts only PNG or WebP icon data up to 512 KiB and 1024 by 1024 pixels. SVG, HTML, scripts, remote icon URLs, animated images, and other binary data are rejected.

### `agent_versions`

An AgentVersion is an immutable published snapshot.

It stores the definition ID, server-assigned monotonically increasing version number, canonical manifest, bounded version bundle, SHA-256 content digest, platform-attestation key ID and Ed25519 signature, Runtime compatibility range, publisher, and publication timestamp. The bundle may contain approved identity text, Skill/SOP/knowledge Markdown, model constraints, default tool declarations, and dependency metadata.

V1 bundles are UTF-8 text only: at most 128 assets, 256 KiB per asset, 2 MiB total asset content, and a 256 KiB canonical manifest. Dependency metadata may name versioned Agent assets or required Runtime capabilities; it cannot request an executable package, shell command, plugin installation, or arbitrary remote URL.

The cloud signs the canonical manifest and content digest after authorization and validation. The signing key is separate from authentication, offline-entitlement, and Runtime-release keys. The desktop verifies the issuer-scoped key ID, signature, digest, and compatibility range before staging or running the version, including offline use.

API and database permissions reject update or delete operations on a published version. Archiving a definition or revoking a version adds lifecycle state and audit evidence without rewriting the immutable content.

Version revocation is represented by a separate append-only revocation record. It never updates the version manifest, bundle, digest, publisher, or publication timestamp.

### `agent_version_revocations`

An AgentVersionRevocation is an append-only deny record for a published version.

It stores the version ID, bounded reason code, actor, policy reference, creation time, and optional superseding version ID. Revocation may prevent a new binding or trigger the emergency live-deny behavior, but it never rewrites or deletes the signed version.

### `installations`

An Installation connects one AgentDefinition and selected AgentVersion to one device and one Runtime Profile owned by the USER.

It stores a new `agent_installation_id`, owner tuple, AgentEra device ID, existing `device_installation_id`, selected version, opaque Runtime Profile ID after activation, manual update policy, lifecycle status, and timestamps. Lifecycle status is exactly `pending`, `active`, or `archived`. Each device/Profile pair receives a distinct Agent Installation. V1 supports manual version selection only. Automatic update policies are deferred until rollback and workspace policy behavior are proven.

Uninstalling archives the control-plane relationship but never deletes a physical Hermes Profile or its private data automatically.

### `policy_snapshots`

A PolicySnapshot freezes the policy used to authorize an installation or conversation.

It stores an immutable policy document, digest, policy version, owner tuple, issuer, signing key ID, Ed25519 signature, and creation time. V1 policy covers allowed model constraints, tool declarations, version compatibility, publication permissions, and explicit deny rules. It contains no model credentials or local paths, and the desktop verifies its issuer-scoped signature before online or cached use.

### `runtime_binding_records`

The cloud stores only sanitized RuntimeBinding metadata for synchronization and audit.

It may contain the binding ID, owner tuple, device ID, Agent Installation ID, AgentVersion ID, opaque Runtime Profile ID, Runtime distribution version, policy snapshot ID, tool-permission digest, and creation time. The complete local binding remains authoritative for execution.

It must not contain a physical Profile path, Memory or USER digest, local adaptive content, conversation text, prompt text, local file path, credential, or environment value.

### Existing `audit_events` extensions

The existing generic cloud `audit_events` table records Agent control-plane actions; V1 does not create a parallel audit store.

Agent event types use the existing actor, device, object type and ID, outcome, reason code, request ID, metadata, and timestamp fields. The bounded metadata adds the owner tuple and version or digest when relevant. Audit records do not duplicate private content or secret-bearing request bodies.

## Publication Flow

Publication is an explicit, user-initiated transition from local draft to immutable cloud version.

1. The desktop snapshots one local draft revision.
2. It canonicalizes the allowlisted manifest and version assets.
3. It rejects secrets, absolute paths, traversal, unsupported file types, oversized fields, and malformed dependencies.
4. It shows the exact asset categories that will cross the USER owner boundary.
5. User confirmation creates a one-use idempotency key.
6. For a new Agent, one cloud transaction creates the AgentDefinition, initial AgentVersion, and success audit event.
7. For an existing Agent, the transaction verifies ownership and the submitted base version, appends a new AgentVersion, and records audit evidence.
8. The desktop verifies the returned canonical digest before marking the local revision published.

Network failure, authorization failure, content rejection, version conflict, or digest mismatch leaves the local draft and Hermes Profile unchanged. Retrying the same idempotency key cannot create a duplicate version.

V1 does not publish Hermes learning automatically. ExperienceCandidate generation, DLP review queues, and workspace or organization approval are separate later projects.

## Installation and Version Materialization

Installing a version creates a device/Profile-specific control-plane Installation and a local immutable version cache.

1. The desktop creates an idempotent cloud Installation in `pending` state and receives a new `agent_installation_id`.
2. It fetches the selected version through the AgentEra product account.
3. It validates the schema, content digest, compatibility range, and policy snapshot.
4. It stages assets under `agentera-control-plane/versions/<version-id>/<digest>/`.
5. It marks the staged directory immutable to the application and rechecks the digest before use.
6. A new installation creates a fresh Hermes Profile with `cloneFrom=null`, then binds it to the owner, device installation, and Agent Installation.
7. An existing USER-owned Profile may be claimed in place only through the current explicit Profile-claim flow; it is never cloned or reassigned across owners.
8. The desktop activates the pending Installation with the opaque Runtime Profile ID and verified version digest using the current device proof.
9. The last verified installed version remains available if a later download or update fails.

A failed materialization leaves the Installation pending and retryable. Expiring or archiving a pending cloud record never deletes the local Profile. A combined “Publish and use” UI action is a visible sequence of publication followed by installation, not one hidden cross-system transaction.

Published assets are supplied to Hermes as read-only base inputs at conversation creation. They are not copied over writable `MEMORY.md`, `USER.md`, local Skill, session, credential, Curator, or workspace paths.

An existing local `SOUL.md` or locally learned Skill remains a Profile-local override and cannot mutate the published bundle. Collisions between a published asset and local override are deterministic and visible in diagnostics.

## RuntimeBinding and Conversation Start

The desktop creates one immutable local RuntimeBinding for every new conversation or isolated job.

The binding freezes:

- owner tuple;
- AgentDefinition and AgentVersion IDs;
- Agent Installation ID and device identity;
- opaque Runtime Profile ID;
- Runtime distribution version;
- policy snapshot ID;
- tool-permission snapshot digest;
- local adaptive-state revision marker;
- creation time.

The local adaptive-state revision is an opaque locally generated marker, not a content hash. It is used only to explain which local snapshot boundary was visible at start; the marker, its content, and private-file digests are not uploaded.

The binding resolver selects the physical `HERMES_HOME`, version assets, and policy before invoking the existing Hermes entry point. The resulting system prompt, Skill index, version identity, and advertised tool schema stay stable for the conversation.

Ordinary cloud changes, local draft edits, new publications, local learning writes, and version updates affect only a later conversation. Emergency revocation may deny an action at execution time and must audit the original snapshot plus the revocation event without rebuilding the active prompt.

## Legacy Hermes One Sync Separation

The existing `src/main/agent-sync.ts` path is a transitional Hermes One feature, not the AgentEra control plane.

V1 follows these rules:

- do not add AgentEra workspace, version, installation, policy, or binding behavior to `/api/agents`;
- do not use last-writer-wins reconciliation for AgentVersion or local adaptive state;
- do not automatically migrate or link existing Hermes One cloud Agent IDs;
- do not use a Hermes One bearer token for AgentEra Cloud APIs;
- keep the existing Memory exclusion intact;
- expose new AgentEra functionality through a separate main-process module, API client, IPC namespace, local store, and renderer state.

The existing Agents screen may host the new product UI, but its AgentEra actions must call only the new control-plane interfaces. Legacy sync can be labeled and retired later without coupling its protocol to the new model.

## Offline Behavior

A valid seven-day offline entitlement permits local drafts, installed Agent use, new local RuntimeBindings derived from cached versions and policy, and native Hermes self-learning whenever the configured model endpoint is reachable.

Offline mode pauses publication, version discovery, installation creation, cloud audit delivery, and control-plane reconciliation. Draft content remains local; V1 does not queue an automatic content upload. A pending sanitized audit event may retry after authentication, but it cannot contain private content.

Expired entitlement may block starting new product work, but it never deletes, rewrites, uploads, or unbinds a Profile.

## Error and Conflict Handling

- Cross-owner object access fails closed and is audited.
- Published versions never use last-writer-wins updates.
- Publishing from a stale base returns a version conflict and leaves a new local draft revision for explicit rebase or publication against the latest version.
- Invalid or incompatible version data never activates; the last verified version remains selected.
- Installation materialization uses staging plus atomic activation.
- A partial publication transaction rolls back definition and version writes; a rejected attempt may append a bounded failure audit event without private content.
- A pending Installation is retryable and cannot cause local Profile deletion when it expires or is archived.
- A desktop crash during publication leaves the draft recoverable and reconciles by idempotency key after restart.
- A cloud failure never fails an already completed Hermes turn.
- Archiving a cloud Installation or definition never silently deletes local Profile data.

## Security and Privacy Boundary

The only V1 cloud payloads are allowlisted Agent definition metadata, explicitly published version assets, Installation and policy records, sanitized binding metadata, and audit metadata.

The following remain local and are rejected if submitted through a control-plane endpoint:

- API keys, access tokens, refresh tokens, OAuth credentials, Base URLs, and environment files;
- `MEMORY.md`, `USER.md`, raw sessions, prompts assembled for a conversation, and message bodies;
- local files, workspaces, absolute paths, and Profile paths;
- unpromoted learned Skills, provenance stores, Curator state, and archives;
- model outputs or telemetry containing user content.

V1 does not upload operational telemetry for self-created Agents. Official Agent telemetry and consent are later policy-governed work.

## Delivery Decomposition

Implementation is split into independently verifiable slices:

1. authentication baseline test repair and authorized merge;
2. cloud USER ownership, immutable version schema, per-device Agent Installation state, authorization, API, and audit;
3. desktop app-level control-plane database, version cache, generated API contract, and IPC boundary;
4. local draft editor and explicit publication flow;
5. Installation materialization and existing/fresh Profile binding;
6. conversation-start RuntimeBinding resolver and Hermes adapter;
7. legacy-sync separation in the Agents UI plus end-to-end verification.

Each slice gets a test-first implementation task and a focused commit. No slice deploys production infrastructure or expands to WORKSPACE, ORGANIZATION, or PLATFORM scope.

## Testing Strategy

### Cloud tests

- USER ownership is derived from authenticated claims and cannot be overridden by request data.
- Cross-user reads and writes return the documented denial without disclosing object existence.
- First publication is transactional and idempotent.
- Version rows and content are immutable after publication.
- Version and policy signatures fail closed for unknown keys, altered canonical content, and incompatible Runtime ranges.
- Stale-base publication returns a deterministic conflict.
- Pending/active Installation state, policy, binding-metadata, archive, append-only revocation, and audit rules are enforced.
- Endpoint schemas reject every forbidden private field and unknown property.
- `go test -count=1 ./...` passes from a clean worktree.

### Desktop tests

- Drafts and version caches are rooted under Electron userData, never `HERMES_HOME`.
- Draft validation rejects paths, secrets, unsupported files, and accidental Profile discovery.
- Publication failure leaves drafts and Profile fixtures byte-identical.
- Fresh installation calls Profile creation with `cloneFrom=null`.
- Existing Profile claim preserves all private markers and content.
- Version update preserves Memory, USER, sessions, files, credentials, learned Skills, and Curator state.
- A running conversation retains one RuntimeBinding, prompt fingerprint, Skill index, and tool schema.
- A later conversation sees both the latest allowed immutable base and Hermes's durable local learning.
- Legacy `/api/agents` code is never called by AgentEra control-plane actions.

### End-to-end proof

The acceptance scenario uses two devices for the same USER owner:

1. Device A creates a local draft with no network write.
2. Device A explicitly publishes version 1.
3. Device A explicitly claims its authoring Profile for one Agent Installation without copying or rewriting the Profile.
4. Device B discovers version 1 and creates a different Agent Installation in a fresh physical Profile.
5. Both devices run the same immutable base version with independent private adaptive state.
6. Device A learns locally through native Hermes mechanisms; Device B does not receive that private learning.
7. Device A publishes version 2 from an explicitly edited local draft.
8. An active Device B conversation stays on version 1; its next manually updated conversation may bind to version 2.
9. Hash checks prove that installation and update did not overwrite private Profile fixtures.

## Acceptance Criteria

- A local draft produces no cloud Agent object until the user explicitly publishes it.
- First publication creates one USER-owned AgentDefinition, one immutable AgentVersion, and complete audit evidence, but no hidden device installation.
- Explicit installation creates a distinct Agent Installation for each device/Profile pair and never reuses the authentication installation ID as that Agent Installation ID.
- A second device can discover and install the stable version without receiving Device A's private Runtime data.
- Every Installation maps to one physically isolated writable `HERMES_HOME`.
- The real Hermes CLI, Memory, background review, Skill learning, and Curator continue unchanged.
- A RuntimeBinding is immutable for an active conversation, and updates affect only later conversations.
- Cloud and desktop payloads contain none of the forbidden private fields.
- Legacy Hermes One sync and AgentEra product sync use separate accounts, endpoints, stores, IPC, and state.
- Offline use preserves installed Agents and native local learning within the valid entitlement window.
- Forced non-cached cloud, desktop compatibility, and end-to-end suites pass before the feature is called complete.

## Explicit Non-Goals

- cloud synchronization of personal drafts;
- workspace membership, invitations, roles, or shared Agents;
- organization departments, enterprise policy, or enterprise audit;
- official Agent review, telemetry, gray release, or rollback services;
- ExperienceCandidate extraction, DLP review queues, or automatic learning publication;
- synchronization of Memory, USER, sessions, files, credentials, or unpromoted Skills;
- encrypted private-state backup or restore;
- a new Runtime seed, Runtime release, or replacement learning engine;
- production deployment, domain configuration, SMS/email setup, or infrastructure procurement.
