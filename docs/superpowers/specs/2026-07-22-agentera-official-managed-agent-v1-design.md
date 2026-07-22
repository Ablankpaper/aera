# AgentEra Official Managed Agent V1 Design

**Status:** Written specification awaiting final user review on 2026-07-22

**Repositories:** `aera-admin`, `aera-cloud`, and `aera`

**Runtime repository:** `aera-runtime` remains unchanged

## Purpose

Official Managed Agent V1 adds PLATFORM-owned Agent definitions, employee-administered review, staged release, rollback, and desktop installation to the existing AgentEra control plane without moving Hermes execution or private learning into the cloud.

The feature completes the approved ownership sequence from USER to WORKSPACE to ORGANIZATION to PLATFORM. It reuses the existing canonical AgentDefinition, immutable AgentVersion, USER-owned Installation, policy snapshot, RuntimeBinding, signing, audit, and read-only projection contracts rather than creating a second official-Agent runtime.

## Position in the Delivery Sequence

The approved sequence remains:

1. USER Agent control plane;
2. Workspace Foundation and Workspace Agent;
3. ExperienceCandidate controlled promotion;
4. Organization Foundation and Organization Agent;
5. **Official Managed Agent V1** — this design.

The Aera Admin security foundation and real Cloud Internal Admin API are prerequisites. This document is design evidence only. It is not feature implementation, merge, remote push, production deployment, or release evidence.

## Existing Baseline

The product already provides:

- USER-, WORKSPACE-, and ORGANIZATION-owned AgentDefinition and immutable AgentVersion assets;
- canonical Manifest and Bundle validation, content digests, platform Ed25519 signatures, policy snapshots, idempotency, and audit;
- USER-owned per-device Installations and sanitized RuntimeBinding metadata;
- a fresh or explicitly claimed physical Hermes Profile for existing Agent kinds;
- immutable verified version caches and read-only Knowledge, Skill, and SOP projection outside `HERMES_HOME`;
- new-conversation RuntimeBinding pinning and old-conversation version stability;
- seven-day signed offline entitlement and account-partitioned desktop state;
- Organization policy capable of allowing or blocking future official-Agent installation;
- a separate Aera Admin application with six fixed employee roles, TOTP, append-only audit, dual approval, outbox/reconciliation, and a fail-closed mTLS plus service-JWT Cloud channel.

Official Managed Agent V1 extends those contracts. It does not replace them.

## Non-Negotiable Architecture Boundary

PLATFORM owns the official Agent asset and its publication state. The installing user owns every runnable local instance.

- `owner_scope=PLATFORM` applies only to official AgentDefinition, review evidence, immutable AgentVersion, and OfficialRelease.
- A stable configured `platform_id` identifies the platform asset owner. It is not a user, Workspace, Organization, or employee account.
- Every Installation remains `owner_scope=USER` and belongs to one personal space, user, device, and opaque Runtime Profile.
- Every official Installation maps to one new independently writable physical `HERMES_HOME`.
- Every new conversation receives one immutable USER-owned RuntimeBinding.
- Official Knowledge, Skill, and SOP bytes are signed, verified, cached outside `HERMES_HOME`, and projected read-only.
- Hermes remains the only writer to Memory, USER data, sessions, private files, learned Skills, Curator state, and other adaptive Profile state.
- A publish, gray-release, pause, update, rollback, Cloud failure, or review rejection never deletes, rewrites, uploads, moves, or unbinds local adaptive state.
- An ordinary version update or rollback affects only conversations created after the replacement version has been fully verified and locally committed.
- A running conversation retains its original prompt, tool schema, Skill index, policy, Profile, AgentVersion, and RuntimeBinding.

The ownership split is:

```text
platform asset: owner_scope=PLATFORM / platform_id
                agent_definition_id / agent_version_id
                official_release_id / release_revision_id

user runtime:   owner_scope=USER / personal_space_id / user_id
                device_installation_id / agent_installation_id
                runtime_profile_id / runtime_binding_id
```

## Scope

Official Managed Agent V1 includes:

- `owner_scope=PLATFORM` for AgentDefinition and AgentVersion;
- Cloud-backed platform drafts edited only through Aera Admin;
- immutable review submissions and mandatory role-separated approval;
- signed immutable AgentVersion creation only after approval;
- `internal` and `stable` release channels;
- deterministic percentage rollout, explicit user allowlists, and minimum desktop version gates;
- append-only release revisions for activation, rollout changes, pause, resume, and rollback;
- employee-role RBAC, Admin BFF, Internal Admin API, outbox execution, reconciliation, and audit;
- authenticated desktop official-Agent catalog and policy-aware visibility;
- USER-owned installation into a fresh isolated Hermes Profile;
- managed version preparation for later conversations;
- cached offline use under the existing signed entitlement;
- strict public and internal OpenAPI contracts, generated desktop types, database invariants, boundary tests, and real cross-repository E2E.

## Explicit Non-Goals

V1 does not include:

- telemetry-based model training, automatic quality learning, or automatic experience return;
- raw conversation, Memory, USER, session, file, credential, API-key, private Skill, Curator, or Profile upload;
- automatic conversion of Hermes local learning into a platform draft;
- emergency remote termination of active local conversations;
- a platform pause that remotely disables an already installed Agent;
- shared writable Profiles, PLATFORM-owned Installations, or PLATFORM-owned RuntimeBindings;
- installing an official Agent into or claiming an existing Profile;
- a fourth global product space named Official or Platform;
- treating the platform as a special Organization;
- public employee-management APIs or platform publishing controls in the ordinary desktop client;
- arbitrary audience targeting based on Memory, conversation content, Workspace contents, Profile state, or private learning;
- production deployment, production signing-key ceremony, release publication, or changes to `aera-runtime`.

## Selected Architecture

### Chosen: extend the unified Agent control plane

`aera-cloud/internal/agentcontrol` remains the canonical implementation of Agent definitions, immutable versions, signatures, installation selection, policy snapshots, RuntimeBinding metadata, idempotency, audit, and API serialization.

The package gains a strict PLATFORM asset variant plus a bounded official-release subdomain. Release state chooses which existing immutable AgentVersion is offered to an eligible user; it does not create a second version format or runtime.

`aera-admin` owns employee workflow and presentation. It calls Cloud only through the existing fail-closed Internal Admin channel. The browser never receives Cloud service credentials or calls the internal listener directly.

`aera` owns user catalog, installation materialization, verified caching, managed version preparation, Profile creation, and RuntimeBinding creation. It exposes no employee publication action.

### Rejected: separate Official Agent service and version model

A parallel official-Agent Definition, Version, signature, Installation, and RuntimeBinding system would duplicate stable control-plane behavior, drift from the USER/WORKSPACE/ORGANIZATION formats, and require a bridge before Hermes could execute it.

### Rejected: special platform Organization

Using `owner_scope=ORGANIZATION` with a hidden platform Organization would mix employee roles with customer enterprise roles, make enterprise lifecycle affect platform assets, and contradict the explicit PLATFORM ownership model.

## Repository Boundaries

### Aera Cloud

`aera-cloud` owns:

- PLATFORM owner validation and persistence;
- platform drafts, submissions, reviews, policy snapshots, and immutable versions;
- release heads and immutable release revisions;
- deterministic audience eligibility;
- public official catalog and managed-installation APIs;
- internal employee-authorized commands;
- transactional domain audit and idempotency;
- policy composition and version signing.

Cloud never opens a physical Profile or stores a physical Profile path.

### Aera Admin

`aera-admin` owns:

- employee session, MFA, fixed-role RBAC, and renderer-safe UI state;
- draft editing, submission, review queue, release management, and audit pages;
- employee action reasons and ticket references;
- approval requests, immutable approval events, outbox execution, and reconciliation;
- the mTLS and short-lived service-JWT Cloud client.

Admin does not own canonical Agent versions, release truth, user Installations, or Hermes data. An Admin approval authorizes a Cloud execution attempt; only the reconciled Cloud result proves success.

### Aera Desktop

`aera` owns:

- authenticated catalog reads and safe renderer projections;
- current account, device, client version, channel, and selected product-context derivation;
- pending Installation orchestration and device proof;
- signed version download, verification, immutable cache, and read-only projection;
- fresh official-Agent Profile creation with `cloneFrom=null`;
- local managed-version preparation and atomic activation;
- immutable RuntimeBinding creation and sanitized metadata outbox;
- offline cached use and private-state boundary enforcement.

The desktop does not own or expose platform drafts, submissions, reviews, release authoring, employee roles, or Cloud internal credentials.

### Aera Runtime

`aera-runtime` remains unchanged. Hermes consumes the same Profile and read-only projection contracts already used by USER, Workspace, and Organization installations.

## PLATFORM Ownership Model

### Stable platform identity

Cloud adds a small `platforms` table with a stable UUID, bounded key, display metadata, lifecycle status, and timestamps. Configuration selects one active `platform_id` for the service process.

This table exists to provide a real relational owner for PLATFORM assets. It does not create a customer-selectable product space or an Admin login identity.

### Core Agent table extensions

The next Cloud migration adds nullable `platform_id` columns to:

- `agent_definitions`;
- `agent_versions`;
- `agent_control_idempotency_keys`.

Owner-variant constraints accept exactly one form:

```text
USER:         tenant_id + owner_id
WORKSPACE:    workspace_id
ORGANIZATION: organization_id
PLATFORM:     platform_id
```

All unrelated owner columns must be null. PLATFORM versions additionally require their platform submission and platform policy snapshot linkage. PLATFORM-specific partial indexes preserve scoped list and idempotency behavior.

Installations, policy snapshots, and RuntimeBinding records remain USER-owned. Their source Definition and Version may be PLATFORM-owned.

## Platform Draft, Submission, and Review Data

### Platform drafts

`platform_agent_drafts` stores the Admin-edited mutable working state:

- `platform_id`, reserved `definition_id`, and optional `base_version_id`;
- initial or next-version kind;
- bounded display name and optional icon;
- canonical Manifest and Bundle;
- manifest, bundle, and content digests;
- positive `revision`;
- active or archived status;
- last editor Admin ID and role;
- creation and update times.

Every update requires `expected_revision` and a request idempotency key. Draft editing never mutates a published version or release.

### Immutable submissions

`platform_agent_submissions` freezes one exact draft revision. It stores the canonical content, digests, submitter Admin ID and role, base version, submission revision, and status.

Statuses are exactly:

- `pending`;
- `approved`;
- `rejected`;
- `withdrawn`;
- `superseded`.

Content and actor fields are immutable. Only the one allowed terminal transition may update a pending row, incrementing its revision exactly once. A newer submission for the same draft supersedes an older pending submission.

### Immutable reviews

`platform_agent_reviews` stores at most one terminal review per submission:

- reviewer Admin ID and role;
- approve or reject decision;
- bounded reason code and safe note;
- reviewed content digest;
- platform policy snapshot ID and version;
- review time.

The database and service both reject self-review. The reviewed digest must equal the frozen submission digest.

### Platform policy snapshots

`platform_agent_policy_snapshots` stores immutable signed policy used for review and release. It captures the canonical rules for Manifest shape, model and tool allowance, Runtime compatibility, content limits, DLP version, permitted channels, and rollout bounds.

The AgentVersion records the exact policy snapshot that authorized it. Later policy changes do not rewrite an old version or review.

## Employee Roles and Permissions

The existing six fixed roles remain. V1 adds bounded official-Agent permissions without adding custom roles.

### Developer

Developer may:

- read official Agent definitions, drafts, safe validation results, versions, and release summaries;
- create a Definition reservation;
- create and edit a draft;
- submit or withdraw the Developer's own pending submission.

Developer may not review, publish, activate rollout, change rollout, pause, resume, or request/approve rollback.

### Super Admin

Super Admin may:

- read the complete official-Agent management history;
- approve or reject another employee's submission;
- atomically create an immutable AgentVersion and, only for a Definition/channel with no release yet, its initial paused release;
- approve a rollback requested by an Operator.

Super Admin may not approve a submission or rollback request created by the same Admin ID. Super Admin does not silently edit the Developer's frozen submission.

### Operator

Operator may:

- read approved versions and release history;
- activate an approved AgentVersion by appending a new active release revision;
- change channel rollout percentage, allowlist, and minimum desktop version within platform policy;
- pause or resume rollout;
- request rollback to an already approved immutable version.

Operator may not edit Agent content, create an AgentVersion, or approve a rollback.

### Auditor

Auditor has read-only access to drafts, frozen submissions, reviews, versions, release revisions, approval history, and complete safe audit records.

### Support and Finance

Support and Finance receive no Official Managed Agent permission in V1.

## Publication State Machine

The publication workflow is:

```text
draft revision
   -> pending submission
      -> withdrawn | superseded | rejected
      -> approved
         -> immutable AgentVersion
         -> initial paused OfficialRelease revision, only when no channel release exists
         -> otherwise the current OfficialRelease remains unchanged
```

Approval repeats canonicalization, DLP, Manifest, Bundle, model/tool, dependency, Runtime compatibility, base-version, policy, and digest validation inside the Cloud transaction that creates the version.

The approve-and-publish transaction inserts:

- one immutable review;
- the terminal submission transition;
- one immutable signed AgentVersion;
- an initial paused release revision only when the Definition/channel has no release;
- Cloud domain audit;
- idempotency response evidence.

Signer, policy, review, release, audit, or idempotency failure rolls back the entire transaction.

Approving v2 or any later AgentVersion never changes, pauses, or advances an existing release head. The new version remains approved but undistributed until an Operator explicitly activates it with the release's expected head revision and audience configuration.

## Official Release Model

### Release head

`official_releases` provides one stable release identity per PLATFORM Definition and channel.

It stores:

- `platform_id` and `definition_id`;
- channel: `internal` or `stable`;
- current release-revision ID;
- positive head revision;
- timestamps.

Only the head pointer and head revision are mutable. Every change requires `expected_revision` and is atomic with its new immutable revision and audit record. Operator activation names one approved AgentVersion for the same PLATFORM Definition; Cloud rejects an unapproved, foreign-definition, or arbitrary version.

### Immutable release revisions

`official_release_revisions` stores:

- release ID and monotonically increasing revision number;
- exact AgentVersion ID;
- state: `active` or `paused`;
- rollout basis points from 0 through 10000;
- minimum desktop version;
- bucket algorithm version and rollout-key ID;
- action: `initial`, `activate`, `rollout_update`, `pause`, `resume`, or `rollback`;
- previous revision ID;
- optional rollback target revision ID;
- actor Admin ID and role;
- bounded reason code and ticket reference;
- creation time.

Revision rows and their audience rows are append-only. Pause, resume, rollout changes, and rollback never update an old row.

### Audience allowlist

`official_release_audience_accounts` binds an immutable release revision to explicit Cloud user IDs. The Admin UI locates an account through the existing exact masked lookup, but the audit stream stores only the allowlist count and digest.

Allowlisting overrides percentage bucketing only. It never overrides channel, minimum client version, account/device validity, version integrity, or effective installation policy.

## Deterministic Rollout Eligibility

Cloud is authoritative for catalog and installation eligibility.

The eligibility sequence is:

1. authenticate the active user and device;
2. resolve the active PLATFORM and requested `internal` or `stable` channel;
3. require an `active` release head and current immutable revision;
4. parse and enforce `minimum_desktop_version` using strict supported SemVer;
5. apply platform policy and the selected product context's current policy, including Organization `official_agents.installation` when applicable;
6. if the user is explicitly allowlisted, accept the audience gate;
7. otherwise compute a stable bucket and compare it with `rollout_basis_points`;
8. return only the safe catalog projection and exact release revision;
9. repeat the authorization and eligibility checks inside Installation creation or managed selection.

The stable bucket is:

```text
bucket = uint64(HMAC-SHA256(rollout_key,
         algorithm_version || release_id || user_id)[0:8]) mod 10000

eligible when bucket < rollout_basis_points
```

The release ID stays stable across version changes and rollback, so increasing 1% to 10% to 50% preserves the earlier cohort. The secret rollout key never enters the database, audit, Admin browser, desktop, or repository; revisions store only its key ID and algorithm version.

Eligibility does not inspect Profile state, Memory, sessions, files, private Skills, Workspace contents, conversation content, or local learning.

## Pause and Rollback Semantics

### Pause

Platform pause stops:

- new catalog exposure;
- new Installation creation;
- rollout expansion;
- managed adoption by users who have not already installed the Agent.

Pause does not remotely disable an existing Installation, end a conversation, delete a cache, or alter a RuntimeBinding. An installed Agent continues using its last locally verified version.

### Rollback

An Operator requests rollback to an already approved immutable version. A different Super Admin approves it through the existing approval and outbox flow.

Cloud then appends a new active or paused release revision pointing at the selected old AgentVersion and advances the head. It does not copy or change the old version.

An online desktop treats rollback as another managed target. It verifies and atomically commits the target before later conversations use it. Active conversations remain bound to their original versions.

## USER Installation Extensions

Official Installations remain in the existing `installations` table with `owner_scope=USER`.

PLATFORM-source rows add:

- `official_release_id`;
- `selected_release_revision_id`;
- `update_policy='managed'`.

Owner-variant and source-variant constraints require those fields only when the referenced Definition and Version are PLATFORM-owned. USER, WORKSPACE, and ORGANIZATION Installations retain their existing manual policy and null official-release fields.

The selected AgentVersion must equal the version referenced by the selected release revision. Policy snapshot issuance binds the user, device, Installation, version, release revision, current product context, and effective model/tool restrictions.

Sanitized `runtime_binding_records` may add nullable `official_release_revision_id`. They still contain no Profile path, prompt content, adaptive content, local file path, credentials, or environment values.

## Effective Policy

Official installation policy is a narrowing composition:

```text
platform Agent policy
intersection platform release policy
intersection selected Workspace or Organization policy when present
intersection user/device permission
= signed USER Installation policy snapshot
```

No layer can expand model or tool access granted by a stricter layer. Missing, invalid, stale, or unverifiable policy fails closed for new Installation or managed selection and leaves the last verified local version intact.

Organization policy may block installation while the user is in an Organization context. The desktop may show the official Agent disabled with a safe policy reason, but it cannot bypass the Cloud decision by switching renderer fields.

## Admin Workflow and Fail-Closed Execution

The Admin browser calls only the Admin backend. The backend authorizes the employee session and sends protected operations through its outbox.

Every high-risk operation binds:

- actor Admin ID and role;
- action and target;
- reason code and optional ticket reference;
- request, operation, approval, and idempotency IDs;
- expected draft, submission, or release revision;
- expected content or rollout digest.

The Internal Admin listener authenticates mTLS and the short-lived service JWT before routing, including before 404 and 405 responses. It independently validates the signed actor context and action-specific scope.

Admin execution status remains distinct from approval status:

- `not_started`;
- `queued`;
- `executing`;
- `reconciling`;
- `succeeded`;
- `failed`;
- `conflict`.

Approval never implies Cloud success. A timeout or ambiguous response enters reconciliation. Admin queries Cloud by operation/idempotency identity and shows unavailable rather than fabricating state.

## API Boundaries

### Public desktop API

The public OpenAPI adds exactly these bounded routes:

- `GET /api/v1/official-agents`;
- `GET /api/v1/official-agents/{definition_id}`;
- `GET /api/v1/official-agents/{definition_id}/release`;
- the existing `POST /api/v1/agent-installations`, extended with an official release-revision source;
- `GET /api/v1/agent-installations/{installation_id}/managed-update`;
- `POST /api/v1/agent-installations/{installation_id}/apply-managed-update`.

The existing Installation-create request gains a strict source variant. A normal USER, WORKSPACE, or ORGANIZATION request supplies `definition_id` and `version_id`; an official request supplies `definition_id` and `official_release_revision_id` and must omit `version_id`. The server derives actor, USER ownership, device, PLATFORM, channel eligibility, policy, and target version. The client cannot select arbitrary PLATFORM ownership or an arbitrary official AgentVersion.

Public catalog responses expose only:

- Definition ID, display name, icon, and official marker;
- safe version and Runtime compatibility metadata;
- release channel and revision;
- installed/update state when authorized;
- bounded eligibility or policy-denial codes.

They exclude drafts, submissions, reviews, employee identities, rollout keys, full allowlists, internal notes, and private runtime data.

### Internal Admin API

The Internal Admin OpenAPI adds exactly these bounded routes:

- `GET|POST /internal/admin/v1/official-agent-definitions`;
- `GET /internal/admin/v1/official-agent-definitions/{definitionID}`;
- `GET|POST /internal/admin/v1/official-agent-drafts`;
- `GET|PATCH /internal/admin/v1/official-agent-drafts/{draftID}`;
- `POST /internal/admin/v1/official-agent-drafts/{draftID}/validate`;
- `POST /internal/admin/v1/official-agent-drafts/{draftID}/submissions`;
- `GET /internal/admin/v1/official-agent-submissions`;
- `GET /internal/admin/v1/official-agent-submissions/{submissionID}`;
- `POST /internal/admin/v1/official-agent-submissions/{submissionID}/withdraw`;
- `POST /internal/admin/v1/official-agent-submissions/{submissionID}/reviews`;
- `GET /internal/admin/v1/official-agent-versions`;
- `GET /internal/admin/v1/official-agent-versions/{versionID}`;
- `GET /internal/admin/v1/official-agent-releases`;
- `GET /internal/admin/v1/official-agent-releases/{releaseID}`;
- `POST /internal/admin/v1/official-agent-releases/{releaseID}/activate`;
- `POST /internal/admin/v1/official-agent-releases/{releaseID}/rollout`;
- `POST /internal/admin/v1/official-agent-releases/{releaseID}/pause`;
- `POST /internal/admin/v1/official-agent-releases/{releaseID}/resume`;
- `POST /internal/admin/v1/official-agent-releases/{releaseID}/rollback`;
- `GET /internal/admin/v1/official-agent-audit-events`.

The existing `GET /internal/admin/v1/operations/{operationID}` remains the only reconciliation read. Each protected mutation requires the existing actor, operation, approval when applicable, expected revision or digest, and idempotency envelope. A review route accepts one terminal approve-or-reject decision; a rollback route accepts only a different Super Admin's approved Operator request.

No Internal Admin route is mounted on the public listener or included in the public desktop OpenAPI.

### Admin BFF and browser API

The Admin BFF exposes only employee-authorized DTOs. It never proxies raw Cloud bodies, service tokens, certificates, signing material, rollout secrets, or unmasked allowlist identities to the browser.

### Desktop IPC

The existing `window.agenteraAgents` boundary gains only safe official-catalog and Installation operations.

Renderer calls may carry bounded Definition, Installation, and opaque one-use operation handles. They never carry:

- `owner_scope`, `platform_id`, personal-space ID, user ID, device ID, role, or employee identity;
- arbitrary AgentVersion or release targets;
- Cloud origin, token, key, certificate, or device proof;
- Profile name or path, `HERMES_HOME`, version-cache path, or projection path;
- Manifest or Bundle bytes, private learning, or policy overrides.

The main process derives and revalidates trusted state for every call. Account, device, selected-space, authentication, or online-state changes invalidate pending handles and stale asynchronous results.

## Desktop Presentation

Official Agent is a source type, not a product space.

The global product switch remains:

- Personal Space;
- Workspace;
- Organization.

The existing Agent screen displays an official section or official badge within the selected context. It shows current version, update readiness, channel, installation status, and safe policy-denial reasons. It contains no draft, review, rollout, pause, or rollback controls.

Offline mode shows installed official Agents from verified local state. It does not show a fresh Cloud catalog or pretend that rollout state is current.

## Installation Flow

The official-Agent installation flow extends the existing `AgentInstallationManager`:

1. the desktop lists the safe eligible catalog;
2. the user explicitly chooses Install;
3. the main process re-fetches and revalidates the exact release revision;
4. Cloud creates an idempotent pending USER Installation bound to user, device, PLATFORM Definition, AgentVersion, and release revision;
5. the desktop downloads the signed canonical Manifest and Bundle;
6. it validates strict fields, signature, digests, Runtime compatibility, and signed policy;
7. it stages the immutable version under Electron `userData`, never under `HERMES_HOME`;
8. it creates a fresh Hermes Profile with `cloneFrom=null`;
9. it materializes approved Knowledge, Skill, and SOP through the verified read-only projection outside the writable Profile;
10. it atomically binds the opaque Runtime Profile ID to the USER Installation;
11. it activates the Cloud Installation with device proof and verified digests;
12. it publishes a safe installed state to the renderer.

Official V1 does not offer an existing-Profile claim. A failed materialization leaves the pending Installation retryable and never deletes a created Profile or private data.

## Managed Update and Rollback Flow

The desktop checks managed targets in the background and on explicit refresh. Conversation start never requires a live Cloud request.

For a new target:

1. Cloud returns the authoritative current eligible release revision and exact AgentVersion;
2. the desktop verifies and stages the immutable version and policy;
3. Cloud atomically rechecks eligibility, release head, policy, and expected selected revision;
4. the desktop commits the selected release revision, policy, and read-only projection only after every verification succeeds;
5. later conversations use the new selected version;
6. active RuntimeBindings remain unchanged.

If Cloud changes between preparation and commit, the operation returns a bounded conflict and discards or retains only safe staged cache material. It does not partially activate the version.

If Cloud records the managed selection but the desktop fails before local projection activation, the local Installation remains on its prior verified version and no conversation uses the unactivated target. The desktop retries the same idempotent operation, reconciles the authoritative Cloud selection, re-verifies the signed version and policy, and only then atomically advances local state. Cloud selection alone is never execution authorization for an unverified local target.

Network, policy, signature, digest, filesystem, Profile, cache, projection, activation, or audit failure preserves the last selected version and every private Profile byte.

## RuntimeBinding and Hermes Integration

Each new official-Agent conversation commits one local RuntimeBinding containing:

- USER owner tuple and device identity;
- Agent Installation ID;
- AgentDefinition and AgentVersion IDs;
- OfficialRelease and release-revision IDs;
- opaque Runtime Profile ID;
- Runtime distribution version;
- signed policy snapshot ID;
- tool-permission digest;
- local adaptive-state revision used at start;
- creation time.

The local binding is authoritative for execution. Its sanitized Cloud projection is best-effort and cannot delay or roll back Hermes.

The Hermes adapter resolves the physical Profile only through the encrypted Profile binding store. It combines the selected immutable read-only base, signed policy, and current local adaptive state without writing the base assets into private paths.

Hermes Memory, background review, agent-created Skill learning, Curator, session storage, credentials, and local files continue normally inside that Profile. Official managed update does not intercept or replace those mechanisms.

## Offline Behavior

A valid seven-day offline entitlement permits:

- use of the last locally verified official Agent version;
- new local RuntimeBindings from the cached version and policy;
- native Hermes Memory, background review, Skill learning, and Curator behavior when the configured model endpoint is reachable.

Offline mode pauses:

- fresh catalog discovery;
- new official Installation;
- managed update and rollback discovery;
- rollout eligibility refresh;
- Admin and Cloud publication operations.

An offline client cannot know that the platform paused or rolled back. The product must not claim immediate remote control. Entitlement expiry may gate new work but never deletes, rewrites, uploads, or unbinds Profile data.

## Failure and Error Contract

Feature-specific stable bounded error codes are exactly:

- `official_agent_not_eligible`;
- `official_release_paused`;
- `official_release_revision_conflict`;
- `official_client_version_unsupported`;
- `official_installation_policy_blocked`;
- `official_submission_self_review`;
- `official_submission_conflict`;
- `official_rollout_invalid`;
- `official_version_integrity_failed`;
- `official_managed_update_conflict`;
- `cloud_unavailable`.

Those codes are shared consistently across Cloud Go, public OpenAPI, Internal Admin OpenAPI, Admin Go, generated TypeScript, desktop client, IPC, renderer, and tests.
Existing common authentication, authorization, invalid-request, not-found, conflict, rate-limit, and service-unavailable codes retain their current meanings.

All endpoints reject duplicate JSON keys, unknown fields, non-canonical UUIDs, ambiguous headers, unsupported queries, invalid revisions, oversized bodies, and unsafe text. Raw server bodies and secret-matched evidence never cross the Admin or desktop renderer boundary.

## Audit Model

Admin and Cloud retain separate append-only evidence for their own trust boundaries.

Official-Agent audit covers:

- Definition reservation and draft mutation digest;
- validation and submission;
- withdrawal, supersede, rejection, and approval;
- immutable version creation;
- release creation and activation;
- percentage, allowlist, and minimum-version changes;
- pause and resume;
- rollback request, approval, and execution;
- catalog eligibility denial category;
- Installation and managed-version selection outcome.

Records bind actor, role, service identity, action, target, before/after revision, reason code, ticket reference, request/operation/approval/idempotency IDs, and outcome.

Audit excludes passwords, TOTP values, tokens, cookies, certificates, signing keys, rollout secrets, email, phone, search input, allowlist identity lists, Agent prompt or Bundle content, Profile paths, Memory, USER, conversations, sessions, credentials, private Skills, and Curator state.

Cloud publication and release mutations commit domain state, idempotency evidence, and audit in one PostgreSQL transaction. Audit failure rolls back the mutation.

## Security and Privacy Gates

- Employee operations require Admin session, role permission, action reason, and step-up controls already defined by Aera Admin.
- Internal Cloud routes require mTLS and short-lived service JWT before route disclosure.
- Cloud independently enforces role/action combinations and self-review separation from signed actor context.
- PLATFORM content passes canonicalization, DLP, model/tool, dependency, Runtime, size, signature, and policy gates.
- Rollout HMAC secrets and version-signing private keys remain injected outside Git and separate from one another.
- Public and internal contracts use explicit allowlists; DTOs are rebuilt rather than spread from internal models.
- Renderer input never selects ownership, employee authority, Profile, filesystem, Cloud origin, or arbitrary managed version.
- Database triggers and constraints preserve immutable submissions, reviews, policy snapshots, versions, and release revisions.
- Strict context and account generation checks discard stale async results after login, device, space, role, or connectivity change.
- Static boundary tests reject PLATFORM vocabulary from Memory, session, private Skill mutation, Curator, Runtime distribution, legacy sync, and Profile-ownership modules except the narrow installation provenance and binding metadata contracts.

## Testing Strategy

### Cloud unit and model tests

Tests cover:

- strict PLATFORM owner variants and cross-owner rejection;
- canonical submission and policy validation;
- role matrix and self-review denial;
- allowed state transitions and stale revision conflicts;
- deterministic HMAC buckets, monotonic percentage expansion, allowlist precedence, and SemVer gates;
- pause and rollback semantics;
- effective policy narrowing;
- safe serialization and bounded errors.

### Cloud PostgreSQL integration tests

Real database tests prove:

- PLATFORM relational ownership;
- immutable submissions, reviews, policies, versions, and release revisions;
- exactly one release head per Definition/channel;
- head and revision atomicity under concurrent Operators;
- idempotent same-request replay and conflicting-request denial;
- self-review and rollback separation at the database and service layers;
- signer, policy, release, audit, or idempotency failure rolls back every row;
- USER Installation ownership and PLATFORM source/version consistency;
- account and Organization policy changes cannot widen platform permissions.

### Admin tests

Admin tests cover:

- exact six-role permission matrix;
- Developer submit, Super Admin review, Operator rollout, Auditor read-only, Support/Finance denial;
- self-review and self-rollback-approval denial;
- approval/outbox/reconciliation lifecycle;
- stale revision and ambiguous Cloud response handling;
- secret and personal-data redaction;
- route and UI fail-closed behavior when Cloud is unavailable.

### Contract tests

Contract gates prove:

- public and Internal Admin OpenAPI remain separate;
- every official route, strict schema, response, and error is documented;
- Internal Admin dual authentication is mandatory;
- generated desktop TypeScript is deterministic and matches the pinned Cloud document;
- Admin DTOs and desktop DTOs contain no private Profile, Memory, session, credential, employee-secret, or rollout-secret field;
- unsupported direct publish and arbitrary-version-selection routes do not exist.

### Desktop unit and boundary tests

Desktop tests prove:

- trusted account, device, channel, client version, and selected-context derivation;
- Renderer cannot supply PLATFORM owner, user, role, Profile, path, or arbitrary version;
- official installation always creates a fresh Profile with `cloneFrom=null`;
- immutable cache and read-only projection stay outside `HERMES_HOME`;
- managed update commits only after signature, digest, policy, and Cloud selection succeed;
- every update failure preserves the prior version and Profile bytes;
- active RuntimeBindings never change;
- pause preserves installed use;
- valid offline entitlement permits cached use without claiming current Cloud state;
- captured requests exclude private learning and legacy `/api/agents` calls.

### Real cross-repository E2E

The deterministic acceptance scenario is:

1. Developer creates and submits official Agent v1.
2. A different Super Admin approves it, creating immutable v1 and a paused release.
3. Operator enables a bounded rollout; an eligible user sees v1 and an ineligible user does not.
4. The eligible user installs v1 into a new USER-owned Installation and new physical Hermes Profile.
5. A v1 conversation starts and Hermes creates private Memory or learned-Skill markers.
6. Developer submits v2 and another Super Admin approves it.
7. Operator rolls v2 to that user's cohort; after verified synchronization a new conversation uses v2 while the existing v1 conversation remains v1.
8. Operator requests rollback and a different Super Admin approves it; after synchronization a later conversation uses v1 while the running v2 conversation remains v2.
9. Operator pauses the release; a new user cannot discover or install it, while the installed user continues from the local verified version.
10. The installed user goes offline and starts a cached conversation under valid entitlement.
11. Hashes prove Memory, USER, sessions, private Skills, credentials, Curator state, and unrelated Profile files remain byte-identical across every Admin and Cloud operation except native Hermes writes performed by the test itself.
12. Request capture proves no private data or legacy `/api/agents` traffic entered the new protocol.

Failure injection covers Admin outbox loss, ambiguous Cloud response, signer failure, audit failure, stale release revision, download interruption, digest mismatch, policy rejection, cache failure, Profile creation failure, activation failure, managed-selection conflict, rollback materialization failure, and reconnect after offline use.

## Verification Commands and Evidence Boundary

Implementation planning must preserve separate evidence for each repository and state transition.

Cloud verification includes at least:

```bash
go test ./... -count=1
go vet ./...
```

Admin verification includes its full local gate and real Cloud E2E:

```bash
make verify
AERA_ADMIN_E2E_CLOUD_REPO=/Users/zizimutou/Desktop/aera/aera-cloud make e2e
```

Desktop verification includes at least:

```bash
npm run typecheck
npm test
npm run check:agentera-cloud-contract
```

The desktop repository adds and runs the cross-repository proof as `npm run test:e2e:official-managed-agent`. `lat check` must pass when the local `lat` tool is available. `aera-runtime` must remain unchanged.

Passing local tests is not evidence of merge, GitHub push, deployment, production key readiness, or release. Each state is reported separately.

## Implementation Slices

The implementation plan should divide the work into these independently reviewable slices:

1. Cloud PLATFORM ownership, policy, draft/submission/review persistence, and invariants;
2. Cloud immutable publication, release revisions, eligibility, public/Internal API, and audit;
3. Admin RBAC, Cloud client, approval/outbox actions, management UI, and real-Cloud E2E;
4. Desktop contract pin, catalog, fresh Installation, managed selection, renderer presentation, and boundary tests;
5. three-repository acceptance E2E, failure injection, privacy hashes, documentation, and full verification.

Each slice begins with failing tests, retains a focused commit boundary, and does not broaden into telemetry, production deployment, or Runtime changes.

## Final Acceptance

Official Managed Agent V1 is implemented only when all of the following are proven on the actual target commits:

- PLATFORM assets cannot be confused with USER, WORKSPACE, or ORGANIZATION assets;
- Developer, Super Admin, Operator, Auditor, Support, and Finance permissions match the approved matrix;
- no submitter can approve the same submission and no rollback requester can approve the same rollback;
- every published AgentVersion and release revision is immutable and signed or digest-bound as specified;
- deterministic rollout, allowlist, minimum-version, pause, resume, and rollback behavior is proven;
- public desktop and Internal Admin APIs are strictly separated and fail closed;
- every official Installation is USER-owned and maps to a new independent Profile;
- managed updates and rollback affect only later conversations;
- valid offline use continues from verified cache without false remote-control claims;
- Admin, Cloud, and desktop failures preserve prior usable state and private Profile bytes;
- no Memory, USER, conversation, session, credential, private Skill, Curator, Profile path, or unapproved local file enters Cloud or Admin;
- Hermes local Memory, background review, Skill learning, and Curator continue through the complete v1/v2/rollback flow;
- `aera-runtime` is unchanged;
- local verification, merge, push, deployment, and release states are reported separately.

Until those gates pass, the correct status is design, planned, implemented, or locally verified as supported by evidence—never deployed or released.
