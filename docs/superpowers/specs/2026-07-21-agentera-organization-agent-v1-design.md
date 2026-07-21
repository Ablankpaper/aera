# AgentEra Organization Agent V1 Design

**Status:** Written specification approved for implementation planning on 2026-07-21

**Repositories:** `aera-cloud` and `aera`

**Runtime repository:** `aera-runtime` remains unchanged

## Purpose

Organization Agent V1 adds enterprise-owned Agent definitions, immutable approval submissions, two-person publication, member discovery, and USER-owned local installation to the existing AgentEra control plane.

This is the second independently gated enterprise slice. It consumes Organization Foundation V1 without converting an Organization into a Workspace, moving employee runtime data to the cloud, or changing Hermes's native self-learning loop.

## Position in the Delivery Sequence

The approved enterprise sequence remains:

1. **Organization Foundation V1** — implemented locally and merged to local `main` before this design;
2. **Organization Agent V1** — this design;
3. **Official Managed Agent V1** — `owner_scope=PLATFORM`, platform review, staged release, rollback, and desktop installation.

This document is approved for implementation planning. It is not product implementation, GitHub publication, production deployment, or release evidence.

## Existing Baseline

The product already provides:

- USER- and WORKSPACE-owned AgentDefinition and immutable AgentVersion assets;
- canonical manifests, version bundles, Ed25519 version signatures, policy snapshots, installation activation, RuntimeBinding metadata, and audit;
- local USER and WORKSPACE Agent drafts outside `HERMES_HOME`;
- one USER-owned Installation and one independently writable physical Hermes Profile per installed Agent;
- verified read-only Knowledge, Skill, and SOP projection;
- manual version selection that affects later conversations only;
- Organization lifecycle, transferable Owner, Admin/Auditor/Member roles, Departments, invitations, signed policy, audit, and trusted product-space selection;
- an explicit `ORGANIZATION_UNAVAILABLE` Agent state that prevents Foundation from falling through to personal ownership;
- a seven-day product offline entitlement and account-partitioned desktop state.

Organization Agent V1 replaces only the explicit unavailable Agent state for an active verified Organization. It does not replace the Organization, Workspace, Agent, Profile, or Runtime bounded contexts.

## Non-Negotiable Architecture Boundary

The multi-tenant architecture diagram and Hermes compatibility design remain authoritative.

- `owner_scope=ORGANIZATION` identifies ownership of a published enterprise Agent asset.
- An Organization owns the Definition, approval evidence, and immutable Version.
- The installing employee owns the Installation, policy overlay, RuntimeBinding, physical Profile, and local adaptive state.
- Every runnable Installation maps to one independently writable physical `HERMES_HOME`.
- Selecting an Organization changes control-plane navigation only; it does not select or mutate a Profile.
- Departments remain member groups and never become product spaces, Agent owners, or Profile selectors.
- Enterprise Knowledge, Skill, and SOP assets are verified, immutable, and read-only to Hermes.
- `MEMORY.md`, `USER.md`, sessions, conversations, files, credentials, API keys, local learned Skills, Curator state, and private learning remain local.
- Hermes Memory writes, background review, Skill learning, and Curator continue without cloud approval.
- A submission rejection, cloud failure, membership change, or policy denial never deletes or rolls back local learning.
- A newer Agent version or ordinary policy applies to a new conversation only. An active conversation retains its frozen RuntimeBinding.

The ownership split is deliberate:

```text
enterprise asset: owner_scope=ORGANIZATION / organization_id
                  agent_definition_id / agent_version_id

employee runtime: owner_scope=USER / personal_space_id / user_id
                  device_installation_id / agent_installation_id
                  runtime_profile_id / runtime_binding_id
```

## Scope

Organization Agent V1 includes:

- `owner_scope=ORGANIZATION` for AgentDefinition and AgentVersion;
- Owner/Admin local Organization-targeted drafts;
- immutable cloud publication submissions;
- mandatory two-person Owner/Admin approval;
- policy, content, capacity, and DLP validation at submission and approval;
- immutable signed initial and next versions created only by approval;
- Owner/Admin/Auditor review and publication history;
- active Owner/Admin/Member discovery and installation;
- read-only Knowledge, Skill, and SOP projection outside `HERMES_HOME`;
- USER-owned Installation, policy overlay, Profile, and RuntimeBinding;
- manual version selection for later conversations;
- Organization lifecycle, membership, policy, audit, account, device, and context race protection;
- Organization-asset dissolution blockers;
- strict OpenAPI, desktop IPC, local-store, end-to-end, and Hermes-isolation gates.

## Explicit Non-Goals

This slice does not include:

- cloud collaborative draft editing;
- Member or Auditor draft authoring;
- self-approval or a policy switch that disables two-person approval;
- Organization ExperienceCandidate promotion;
- automatic publication, automatic version selection, or automatic local-learning upload;
- Department-owned or Department-restricted Agent assets;
- Organization-wide live version revocation;
- Organization Agent asset transfer or disposal;
- shared writable Profiles, Organization-owned RuntimeBindings, or cloud-hosted execution;
- `owner_scope=PLATFORM`, official Agent review, staged release, rollback, or quality telemetry;
- encrypted private backup;
- changes to `aera-runtime`;
- production deployment, GitHub push, or release publication.

## Selected Architecture

### Chosen: extend the existing Agent control plane

`aera-cloud/internal/agentcontrol` remains the single implementation of canonical manifests, immutable Agent versions, version signatures, policy overlays, USER installations, RuntimeBinding metadata, audit, and API serialization.

It gains a strict Organization asset owner and a separate immutable approval workflow. Organization Foundation remains authoritative for lifecycle, membership, role, current policy, and audit visibility.

The desktop keeps one `agentera-agent-control` domain. Its main process derives the selected Organization and current verified role from the product-space coordinator. Renderer calls never submit `owner_scope`, Organization ID, role, actor identity, cloud origin, credentials, Profile path, or Hermes content.

### Rejected: separate Organization Agent tables and service

A second Definition, Version, signature, policy, installation, and audit implementation would duplicate stable control-plane behavior. It would drift from USER and WORKSPACE assets and require another bridge before Official Managed Agent V1.

### Rejected: generalized multi-tenant engine refactor first

Rewriting USER, WORKSPACE, and ORGANIZATION ownership behind a new generic tenant engine would touch stable personal and Workspace publication paths before enterprise behavior exists. The failure radius is larger than this slice requires.

## Component Boundaries

### Cloud Agent control

`internal/agentcontrol` owns:

- Organization Agent canonicalization and payload limits;
- publication-submission persistence and state transitions;
- DLP and policy enforcement for Agent content;
- approval-time signing and immutable publication;
- Organization Agent discovery and signed-version reads;
- USER installation creation from an Organization source;
- installation policy composition and version selection;
- Organization Agent audit evidence;
- an asset-backed Organization dissolution guard.

It consumes Organization authorization through narrow repository checks performed inside the same PostgreSQL transaction as each protected read or mutation. A Foundation summary or desktop-cached role is never sufficient cloud authorization.

### Cloud Organization domain

`internal/organization` retains ownership of Organization lifecycle, Membership, role, policy, policy history, and Organization audit queries.

Its existing `AssetGuard` interface remains narrow. The process wiring replaces `FoundationAssetGuard` with an `internal/agentcontrol` implementation before any ORGANIZATION asset can be created. This avoids a package cycle while making dissolution fail closed on real enterprise Agent relationships.

### Desktop Agent control

`aera/src/main/agentera-agent-control` owns:

- Organization-targeted local drafts;
- the strict Organization Agent cloud client;
- submission summaries and local draft-to-submission references;
- publication review orchestration and bounded errors;
- Organization-source installation and version selection;
- verified version cache, read-only projection, Profile binding, and RuntimeBinding creation.

Runtime components remain keyed only by authenticated USER, device, and Runtime version. Context-specific publication and review components are additionally keyed by the selected Organization and verified role.

### Renderer

The existing Agent screen gains role-aware Organization presentation through the exact `window.agenteraAgents` namespace.

Renderer role checks are presentation only. The main process and cloud independently enforce every operation. Context changes close dialogs, invalidate one-use handles, discard stale async results, and refresh state.

## Cloud Ownership Model

### Published assets

The next cloud migration extends only published assets and publication evidence:

- `agent_definitions` gains nullable `organization_id`;
- `agent_versions` gains nullable `organization_id` plus approval linkage;
- `agent_control_idempotency_keys` gains nullable `organization_id`;
- Organization-specific partial indexes preserve scope-local list and idempotency behavior.

Database constraints allow exactly one ownership variant:

```text
USER:
  tenant_id != null / owner_id != null
  workspace_id = null / organization_id = null

WORKSPACE:
  workspace_id != null
  tenant_id = null / owner_id = null / organization_id = null

ORGANIZATION:
  organization_id != null
  tenant_id = null / owner_id = null / workspace_id = null
```

Organization foreign keys use `ON DELETE RESTRICT`. Existing USER and WORKSPACE rows, indexes, and account lifecycle retain their current behavior.

### Runtime records remain USER-owned

The following tables retain the authenticated employee's USER owner tuple:

- `installations`;
- `policy_snapshots`;
- `runtime_binding_records`;
- USER version-revocation records.

An Organization source is authorization and provenance metadata, not runtime ownership. The cloud derives it from the referenced Definition and Version and records the Organization ID in bounded audit metadata.

A sanitized RuntimeBinding may include the source asset scope and Organization ID, but its owner scope remains USER. It never contains Profile paths, Memory, USER content, conversations, credentials, local Skill content, or Curator data.

## Immutable Publication Submissions

### `organization_agent_submissions`

One row represents one immutable approval package. Database and wire status values are lower-case.

Required fields include:

- `id UUID PRIMARY KEY`;
- `organization_id UUID NOT NULL`;
- `kind TEXT NOT NULL` constrained to `initial|next`;
- `definition_id UUID NOT NULL`;
- nullable `base_version_id UUID`;
- initial-only display name and optional icon;
- canonical manifest and bundle JSON;
- manifest, bundle, and combined content digests;
- `submitted_by_user_id UUID NOT NULL`;
- `status TEXT NOT NULL` constrained to `pending|approved|rejected|withdrawn|superseded`;
- `revision BIGINT NOT NULL` and greater than zero;
- submission, terminal-decision, and update timestamps.

An initial submission receives a server-generated reserved Definition ID. No Definition row becomes discoverable until approval creates it.

A next-version submission must reference an existing active Definition in the same Organization and its exact latest Version as `base_version_id`.

The submission's Definition ID deliberately cannot use one unconditional foreign key: an initial reserved ID has no Definition row yet, while a next submission must reference one. A constraint trigger enforces the tagged variant, requires the next Definition to exist in the same Organization, and requires an initial reserved ID not to collide with any existing Definition.

Triggers reject payload updates and every delete. Only the bounded status, revision, and terminal timestamp may change through reviewed repository transitions.

### `organization_agent_reviews`

One append-only row records the terminal review:

- review and Organization IDs;
- submission ID;
- reviewer user ID;
- decision `approve|reject`;
- bounded reason code and optional secret-scanned note;
- current Organization policy snapshot ID and version;
- reviewed content digest;
- review timestamp.

The submission has at most one terminal Review. Update and delete are rejected. A constraint trigger plus repository transaction requires reviewer and submitter to be different current Owner/Admin users.

### Approval linkage on AgentVersion

Every ORGANIZATION AgentVersion references its approved submission and the Organization policy snapshot used by the approval. These fields are null for USER and WORKSPACE versions and non-null for ORGANIZATION versions.

The first approved submission creates the Definition and Version together. A later approval creates the next Version and advances `latest_version_id`. The Definition's `created_by` records the original submitter; the Version's publication actor records the approver. The Review preserves both identities.

## Submission State Machine

The only valid transitions are:

```text
pending -> approved
pending -> rejected
pending -> withdrawn
pending -> superseded
```

- `approved` atomically creates one immutable signed Version;
- `rejected` creates no Definition or Version;
- `withdrawn` is available only to the original submitter while still authorized;
- `superseded` means a next-version base is no longer current;
- every terminal state is immutable;
- revising content always creates a new local draft revision and a new submission.

Several next-version submissions may target the same current base. The first valid approval wins; later review attempts commit `superseded` without creating another Version. A superseded transition is a committed domain result, not an error that rolls back its transaction, and the HTTP layer returns its stable conflict code with the terminal summary.

Approval runs in one transaction:

1. lock the Organization, current Memberships, submission, and target Definition when present;
2. require an active Organization;
3. require both submitter and reviewer to remain Owner/Admin;
4. reject self-review;
5. re-canonicalize content and verify every stored digest;
6. run current platform publication rules, current Organization policy, DLP, and content limits;
7. compare `base_version_id` with the locked current version;
8. mark a stale package `superseded`, audit it, and create no Version;
9. sign and insert the immutable Version;
10. create or advance the Definition;
11. insert Review, idempotency result, and success audit;
12. commit all changes together.

Signing, policy, DLP, audit, or storage failure rolls back the entire publication. No unsigned or unapproved Version is visible.

## Authorization

Authorization is re-evaluated in every cloud transaction.

| Operation | Owner | Admin | Auditor | Member | Outsider |
| --- | --- | --- | --- | --- | --- |
| List/read published Agents | yes | yes | yes | yes | no |
| Read submissions and review history | yes | yes | yes | no | no |
| Create/edit local draft while online | yes | yes | no | no | no |
| Submit immutable package | yes | yes | no | no | no |
| Approve/reject another author | yes | yes | no | no | no |
| Withdraw own pending package | yes | yes | no | no | no |
| Install/use approved version | yes | yes | no | yes | no |
| Read full Organization policy/audit | yes | yes | yes | no | no |

An actor demoted or removed during a request fails closed. A submission whose author is no longer Owner/Admin cannot be approved. An authorized reviewer may reject it; the original content and audit remain retained.

Only an approval requires both author and reviewer to retain publishing roles. Rejection remains available to a current Owner/Admin so an ineligible author's immutable pending package can reach a terminal state. Withdrawal remains limited to the still-authorized original submitter.

Outsiders and cross-Organization identifiers receive non-enumerating not-found behavior. The renderer never supplies an asserted role.

## Policy and DLP

### Publication policy

Publication eligibility is:

```text
platform publication policy
intersection Organization current policy
```

The service validates model/provider constraints, tool allowlists, dependencies, Runtime compatibility, asset type, path, size, canonical form, and DLP findings.

Submission performs the first validation before persistence. Approval repeats validation under the current policy and DLP rules. A rule change cannot allow stale pre-validation to bypass current restrictions.

Two-person review is a product invariant and has no policy value that can disable it.

### Installation and runtime policy

Per-user effective policy is:

```text
approved version constraints
intersection platform policy
intersection Organization current policy
intersection user/local safety restriction
```

The resulting signed policy snapshot remains USER-owned and binds one Installation/version selection. A later Organization policy change does not mutate the immutable Version or private Profile.

Online refresh applies an eligible new policy to later installations, selections, and conversations. An active conversation retains its original policy and RuntimeBinding. V1 does not add an Organization-wide live revocation overlay.

## Organization Lifecycle and Asset Guard

An active Organization permits authorized submission, review, publication, discovery, installation, and manual update.

An archived Organization is read-only. It permits authorized history reads but rejects submission, withdrawal, review, publication, installation, and version selection.

Membership removal blocks future cloud discovery, installation, and selection. A previously verified local installation may continue during the remaining valid offline entitlement. Once authoritative online state confirms removal, no new Organization Agent conversation may be created through that context.

Neither archive nor membership removal deletes a local Profile, cached immutable version, completed conversation, Memory, USER data, learned Skill, or Curator state.

The Agent-backed `AssetGuard` reports bounded blocker categories for pending submissions, published definitions/versions, and USER installations referencing Organization assets. Organization Agent V1 has no transfer or disposal workflow, so an Organization with any such asset may be archived but cannot be dissolved.

## Cloud API

Organization Agent routes are nested beneath the trusted Organization owner:

```text
GET  /api/v1/organizations/{organization_id}/agent-definitions
GET  /api/v1/organizations/{organization_id}/agent-definitions/{definition_id}
GET  /api/v1/organizations/{organization_id}/agent-definitions/{definition_id}/versions

POST /api/v1/organizations/{organization_id}/agent-publication-submissions
GET  /api/v1/organizations/{organization_id}/agent-publication-submissions
GET  /api/v1/organizations/{organization_id}/agent-publication-submissions/{submission_id}
POST /api/v1/organizations/{organization_id}/agent-publication-submissions/{submission_id}/withdraw
POST /api/v1/organizations/{organization_id}/agent-publication-submissions/{submission_id}/reviews
```

There is no direct Organization publish route.

The submission request is a strict tagged union:

- `initial` accepts display name, optional icon, manifest, and bundle;
- `next` accepts Definition ID, exact base Version ID, manifest, and bundle.

The server canonicalizes bytes and returns the authoritative content digest. Request bodies never accept owner scope, tenant, actor, role, approval actor, policy snapshot override, signing material, Profile path, RuntimeBinding, or Hermes private data.

Submission, withdrawal, and review require `Idempotency-Key`. Withdrawal and review also require the current submission revision. Exact ambiguous retries return the original result; a changed request under the same key conflicts.

The existing signed-version route may return an ORGANIZATION Version only to an active authorized member:

```text
GET /api/v1/agent-versions/{version_id}
```

`POST /api/v1/agent-installations` adds optional `organization_id`, mutually exclusive with `workspace_id`. Its presence requires the Definition and Version to belong to that exact active Organization and the actor to have an install-capable role.

Activation, policy retrieval, Installation archive, and RuntimeBinding delivery remain USER-scoped. Manual version selection re-checks current Organization membership, lifecycle, policy, Definition, and Version lineage.

## Error Contract

Stable public errors include:

- authentication, online-entitlement, and service availability failures;
- non-enumerating Organization Agent not found;
- Organization Agent role forbidden;
- Organization archived;
- submission self-review forbidden;
- submission revision or terminal-state conflict;
- submission superseded by a newer base;
- publication policy blocked;
- publication DLP blocked;
- invalid content, signature, digest, dependency, or Runtime compatibility;
- dissolution blocked by Organization Agent assets.

Handlers preserve the existing strict JSON, canonical UUID, bounded body, duplicate-field, pagination, and header rules. Raw server bodies, SQL errors, content bytes, credentials, paths, and private data never cross desktop IPC.

## Audit

Successful and denied operations record:

- actor user and device;
- Organization ID and current role;
- submission, Definition, Version, Installation, and policy snapshot IDs when applicable;
- request ID and idempotency evidence;
- event type, outcome, content digest, version number, and bounded reason code;
- submitter and reviewer identities for terminal review.

Audit must not contain full Prompt, Manifest, Bundle, Knowledge, Skill, SOP, review note, credentials, API keys, Profile paths, Memory, USER, conversations, sessions, files, private learned Skills, or Curator state.

Owner, Admin, and Auditor may read full Organization Agent audit through the existing Organization audit boundary. Member receives only safe published Definition and Version summaries.

## Desktop Trusted Context

The product-space coordinator replaces `ORGANIZATION_UNAVAILABLE` with this exact Agent context only for an active verified selection:

```text
ORGANIZATION / organization_id / owner|admin|auditor|member
```

The main process normalizes and keys the context, invalidates one-use handles on every account/device/context/role change, and selects Organization-specific publication, review, discovery, and installation behavior.

USER and WORKSPACE behavior remains unchanged. Runtime components remain keyed to USER/device identity rather than the selected product context.

## Desktop Data Model

The next control-plane SQLite schema version extends local ownership variants:

```text
agent_drafts.target_scope = USER | WORKSPACE | ORGANIZATION
agent_drafts.workspace_id = null | UUID
agent_drafts.organization_id = null | UUID

local_agent_installations.source_scope = USER | WORKSPACE | ORGANIZATION
local_agent_installations.source_workspace_id = null | UUID
local_agent_installations.source_organization_id = null | UUID
```

Checks require one exact variant. Every row remains partitioned by authenticated personal space, user, and device where applicable.

A local submission-reference table binds:

- local draft ID and immutable revision;
- Organization ID;
- cloud submission ID;
- authoritative content digest;
- last verified cloud status and revision;
- submitted and last-verified timestamps.

It stores no authorization token, signing key, Profile path, Memory, session, private Skill, or cloud review payload. Full submission content is fetched online for authorized review and is not written into Hermes.

The migration preserves every existing USER and WORKSPACE draft, cached version, Installation, RuntimeBinding, candidate, and file path.

## Desktop Presentation

### Owner and Admin

Owner/Admin can create and edit an Organization-targeted local draft while online, preview its exact revision, asset counts, byte count, and content digest, then explicitly submit it.

They can list pending and terminal submissions, open a read-only review package, inspect policy/DLP status, and approve or reject another author. Self-review controls are absent and main/cloud calls still reject forged attempts.

### Auditor

Auditor receives published versions, submission history, review detail, policy history, and audit. Draft, submission, review mutation, installation, and version-selection controls are absent.

### Member

Member receives only the published catalog, immutable versions, and that user's own Organization-source Installations. Member can install and manually select an eligible Version.

### Offline

Organization drafts and cached summaries may be shown as stale and read-only. Submission, review, discovery refresh, new installation, and version selection require online authorization. No offline Organization Agent mutation queue exists.

An already verified local installation continues only within the product's valid offline entitlement and last verified policy. Cloud failure never deletes the local draft or Profile.

## Installation and Hermes Projection

The installation sequence is:

1. select one approved immutable Version;
2. derive Organization ID and role in the trusted main process;
3. create a USER-owned pending Installation after cloud membership, lifecycle, and policy checks;
4. download the signed Version and signed policy;
5. verify signature, digest, lineage, Runtime compatibility, and policy;
6. materialize read-only version assets below the AgentEra control-plane root outside `HERMES_HOME`;
7. create a fresh independent Profile by default, or explicitly claim one eligible unbound same-owner Profile under the existing confirmation rule;
8. activate the Profile projection and USER Installation;
9. create a frozen USER RuntimeBinding when a new conversation starts.

No Organization operation clones another employee's Profile or shares a writable Profile. A partial installation retains a bounded retry state and never presents an unverified Version as active.

Published Knowledge, Skill, and SOP files remain digest-verified and read-only. They are supplied to Hermes as immutable base assets and are not copied into writable Memory or local learned-Skill directories.

## Version Selection and Conversation Stability

Version selection is manual in V1.

The desktop stages and verifies the new Version and current policy before committing selection. Failure preserves the previous active local projection and selected Version.

An existing conversation retains its original AgentVersion, Prompt composition, tool schema, Skill index, policy, Runtime distribution, Profile, and local adaptive revision. A later conversation receives a new RuntimeBinding containing the newly selected immutable Version.

Hermes may continue learning inside the same Profile before, during, and after version selection. That private adaptive state is neither uploaded nor overwritten by the new base Version.

## Failure and Race Behavior

- a role removal racing submission, review, installation, or selection fails closed;
- archive racing any mutation fails closed;
- two reviewers racing one submission produce at most one terminal Review and one Version;
- a base-version race marks the losing submission `superseded` without publication;
- a policy update racing approval is resolved under the transactionally current policy;
- a signing, DLP, audit, or database failure creates no partial Version;
- an account or context change invalidates local handles and stale async responses;
- a renderer cannot use a stale dialog to mutate another Organization;
- a cloud or network failure preserves the local draft, cached verified Version, Profile binding, completed turns, and private learning;
- a RuntimeBinding delivery failure remains an outbox concern and never delays or rolls back Hermes.

## Verification Strategy

### Cloud migration and repository tests

Tests prove:

- all three owner variants and cross-scope rejections;
- Organization foreign-key and partial-index behavior;
- immutable payload, terminal Review, and Version rows;
- server-generated IDs, canonical digests, and request bounds;
- no direct ORGANIZATION Version insert outside approval;
- exact idempotent replay and conflict behavior;
- one Version under concurrent approval;
- self-review denial;
- stale-base `superseded` transition;
- role, membership, archive, policy, and DLP races;
- non-enumerating cross-Organization reads;
- asset-backed dissolution blockers;
- audit rollback and private-field rejection.

Real PostgreSQL tests cover constraint triggers and transaction races. Redis-backed limits remain independent from storage quotas.

### Cloud HTTP and OpenAPI tests

Tests cover every route, method, role, lifecycle, body bound, strict JSON shape, canonical UUID, cursor, idempotency header, status transition, stable error, and response projection.

OpenAPI is the authoritative wire contract. The desktop-pinned YAML, deterministic generated TypeScript, and contract hash must match exactly.

### Desktop unit and integration tests

Tests prove:

- SQLite migration preserves USER and WORKSPACE data;
- Organization context comes only from the trusted product-space coordinator;
- renderer calls cannot provide Organization ID, role, owner, actor, origin, path, Profile, or private data;
- role-aware presentation matches the cloud matrix;
- account, device, Organization, and context partitions do not leak;
- submission failure preserves the local draft;
- review handles cannot cross role or context changes;
- Organization-source Installations remain USER-owned;
- signature, digest, policy, and Runtime failures cannot activate;
- version selection affects later conversations only;
- offline state is stale, read-only, and mutation-free;
- raw cloud errors and private fields do not cross IPC.

### Hermes compatibility tests

Static and runtime gates prove:

- each Installation maps to one independent physical Profile;
- Organization ownership vocabulary does not enter Profile, Memory, session, Curator, local Skill mutation, Runtime distribution, or legacy sync ownership;
- read-only assets remain outside `HERMES_HOME`;
- Hermes Memory, USER, background review, Skill learning, and Curator continue on the native adapter path;
- private fixture bytes remain unchanged across successful and failed cloud operations;
- no captured request contains Memory, conversation, session, credential, Profile path, private Skill, or Curator content;
- old and new conversations keep independently frozen USER RuntimeBindings.

### Deterministic end-to-end flow

The main scenario uses distinct Owner, Admin, and Member accounts, plus Auditor coverage:

1. Owner creates a local Organization Agent draft and submits it;
2. Owner self-review is denied;
3. Admin approves and atomically publishes Version 1;
4. Member installs Version 1 into a distinct Profile;
5. Hermes creates Member-private Memory and learned Skill state;
6. Admin submits Version 2;
7. Owner approves Version 2;
8. Member manually selects Version 2;
9. an existing conversation remains on Version 1;
10. a new conversation binds Version 2;
11. Auditor reads review and audit history but cannot install or mutate;
12. member removal blocks later cloud access without deleting the Profile or private learning.

The harness hashes the populated Hermes tree and snapshots active Profile, session, RuntimeBinding, Memory, USER, learned Skills, Curator, Runtime, and Gateway identity before and after every control-plane action.

## Release Gate

Organization Agent V1 is locally complete only when all of the following pass on the exact target commits:

- cloud migration, repository, service, HTTP, OpenAPI, race, and vet gates;
- desktop unit, boundary, contract, build, and multi-account E2E gates;
- Organization Foundation and Workspace Agent regressions;
- Hermes compatibility and byte-identity gates;
- `lat check` with updated architecture records;
- clean desktop and cloud worktrees after intentional commits.

Local validation, merge, GitHub push, deployment, and release remain separate states. This design authorizes none of the latter three.

## Planned Implementation Order

The later implementation plan should decompose this design in this order:

1. cloud ownership migration and immutable submission schema;
2. Organization authorization, policy/DLP, approval, and asset guard;
3. nested HTTP API, strict OpenAPI, and deterministic client contract;
4. desktop SQLite variants, strict client, and trusted Organization context;
5. submission/review presentation and role gates;
6. Organization-source installation, policy, projection, and RuntimeBinding provenance;
7. multi-account E2E, Hermes isolation, full regression, and local merge checkpoints.

No implementation slice may bypass the two-person approval transaction or broaden Organization ownership into USER runtime state.
