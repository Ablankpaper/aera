# AgentEra Organization Foundation V1 Design

**Status:** Approved for implementation planning on 2026-07-21  
**Repositories:** `aera-cloud` and `aera`  
**Runtime repository:** `aera-runtime` remains unchanged

## Purpose

Organization Foundation V1 adds the enterprise identity, membership, department, policy, audit, lifecycle, and desktop product-context boundary required by the approved AgentEra/Hermes multi-tenant architecture.

This slice deliberately stops before enterprise-owned Agent publication. It establishes the authorization and policy foundation that the next Organization Agent V1 slice will consume without moving any employee runtime or adaptive state into the organization control plane.

## Position in the Delivery Sequence

The approved enterprise stage remains three continuous but independently gated slices:

1. **Organization Foundation V1** — this design;
2. **Organization Agent V1** — `owner_scope=ORGANIZATION`, enterprise Agent approval/publication, member discovery and installation;
3. **Official Managed Agent V1** — `owner_scope=PLATFORM`, platform review, staged release, rollback, and desktop installation.

Each slice receives its own design, implementation plan, migration, authorization tests, Hermes-isolation tests, end-to-end proof, and local merge checkpoint. They are not implemented as one large branch or one irreversible schema change.

## Existing Baseline

The current product already provides:

- one `personal_space` for each AgentEra account;
- Workspace Foundation with fixed Owner/Admin/Member roles, one-time seven-day invitations, lifecycle audit, desktop caching, and a USER/WORKSPACE switcher;
- USER- and WORKSPACE-owned AgentDefinition and immutable AgentVersion assets;
- USER-owned Installation, policy snapshot, RuntimeBinding, physical Hermes Profile, and adaptive state for every installed Agent;
- ExperienceCandidate promotion from an explicitly selected local Skill into a reviewed Workspace Agent draft;
- a seven-day offline product entitlement and account-partitioned desktop state.

Organization Foundation builds beside those domains. It does not convert Workspace into a generic tenant, reuse Workspace business tables, or extend the legacy Hermes One `/api/agents` protocol.

## Non-Negotiable Architecture Boundary

The user's multi-tenant architecture diagram and the Hermes compatibility design remain authoritative.

- AgentEra shares approved Agent capabilities and immutable versions, not user runtime data.
- An account answers **who the user is**.
- a Personal, Workspace, or Organization scope answers **who owns and may manage a control-plane asset**.
- an Installation answers **which user installed which immutable Agent version**.
- a Hermes Profile answers **where that installation runs and privately learns on one device**.
- a RuntimeBinding freezes the version, policy, Runtime, tools, Profile, and adaptive revision for one conversation or isolated job.
- switching the selected product space never selects, creates, clones, migrates, merges, rewrites, or deletes a Hermes Profile;
- Organization APIs and caches never read or store `MEMORY.md`, `USER.md`, conversations, sessions, files, credentials, Profile paths, Curator state, or unpublished local Skills;
- local Hermes Memory updates, background review, Skill learning, Curator, and offline operation continue independently of Organization cloud availability;
- cross-boundary experience promotion remains explicit, DLP-checked, authorized, reviewed, audited, and versioned;
- a policy or cloud failure never rolls back or deletes a local learning result.

## Scope

Organization Foundation V1 includes:

- organization creation, rename, archive, restore, safe dissolution, and Owner transfer;
- exactly one Owner plus Admin, Auditor, and Member roles;
- single-level departments used only for member grouping and later policy targeting;
- one-time seven-day Member invitation links;
- member listing, role changes, department assignment, removal, and voluntary departure;
- immutable, versioned, digest-bound, signed organization policy snapshots;
- organization-scoped audit queries and redacted mutation audit evidence;
- strict cloud OpenAPI contracts and generated desktop types;
- an account-partitioned desktop Organization cache;
- a single trusted product-space coordinator for Personal, Workspace, and Organization selection;
- a global top switcher below the AgentEra brand;
- organization overview, member, department, invitation, policy, and audit presentation;
- stale, clearly labeled, read-only offline Organization metadata;
- account-switch, cross-organization, invitation, policy, concurrency, and Hermes-isolation gates.

## Explicit Non-Goals

This slice does not include:

- `owner_scope=ORGANIZATION` on AgentDefinition or AgentVersion;
- enterprise Agent drafts, approval, publication, discovery, installation, update, or revocation;
- Workspace-to-Organization asset transfer;
- shared writable Hermes Profiles or Organization-owned RuntimeBindings;
- automatic ExperienceCandidate submission or publication;
- nested departments, department-scoped roles, or `owner_scope=DEPARTMENT`;
- SSO, SCIM, verified-domain auto-join, bulk import, or automatic email/SMS delivery;
- subscriptions, enterprise verification, billing, or platform approval to create an Organization;
- `owner_scope=PLATFORM`, official Agent review, staged release, or rollback;
- cloud backup of Memory, conversations, files, credentials, Profile state, or private learning;
- production deployment, GitHub push, domain changes, or Runtime release.

## Selected Architecture

### Chosen: independent Organization domain with reused security primitives

Organization is a separate bounded context. It reuses proven authentication, cryptographic randomness, invitation-token hashing, idempotency, audit recording, rate limiting, strict JSON parsing, signature verification, and optimistic-concurrency utilities without sharing Workspace business tables or handlers.

This preserves clear enterprise semantics while minimizing risk to the already verified Workspace and Hermes paths.

### Rejected: generalized Tenant refactor first

Replacing Personal, Workspace, and Organization with a new generic Tenant abstraction would migrate stable authentication, Workspace, Agent ownership, cache, and account-deletion behavior in one step. It has a larger failure radius than the feature requires and risks weakening established Hermes boundaries.

### Rejected: Organization as a Workspace type

Adding `type=ORGANIZATION` to Workspace tables would mix transferable enterprise ownership, Auditor access, departments, signed organization policy, and dissolution with fixed-owner Workspace semantics. Later enterprise Agent approval and official policy composition would require another schema split.

## Component Boundaries

### Cloud Organization domain

`aera-cloud/internal/organization` owns:

- Organization lifecycle and quotas;
- Membership, role, and Owner-transfer transactions;
- Department lifecycle and member assignment;
- invitation creation, acceptance, revocation, and expiry;
- organization policy validation, canonicalization, signing, and version selection;
- organization authorization decisions;
- Organization HTTP handlers and response serialization;
- Organization mutation audit commands and Organization-scoped audit queries;
- dissolution precondition checks through a narrow asset-guard interface.

It consumes the authenticated account/session principal. No Organization request body may supply or override the actor user, device, role, tenant, or authorization decision.

The existing `internal/workspace`, `internal/agentcontrol`, `internal/account`, and `internal/space` packages retain their meanings. Foundation does not add Organization ownership to `internal/agentcontrol`.

### Desktop Organization domain

`aera/src/main/agentera-organization` owns:

- the trusted Organization cloud client;
- strict generated-contract validation;
- the account-partitioned Organization SQLite cache;
- policy signature verification and verified-policy caching;
- Organization refresh, mutation, and stale-state rules;
- volatile Organization invitation acceptance;
- exact Organization IPC serializers.

The renderer reaches it only through an exact `window.agenteraOrganization` preload namespace. Renderer payloads never include authorization headers, cloud origins, actor identity, role assertions, signing keys, database paths, Profile paths, or Hermes data.

### Product-space coordinator

A narrow `aera/src/main/agentera-product-space` coordinator becomes the only owner of the selected product context:

```text
PERSONAL
WORKSPACE / workspace_id / current role
ORGANIZATION / organization_id / current role
```

It composes summaries from the independent Workspace and Organization managers, validates selection against the authenticated account's active cached memberships, persists one account-scoped selection, rejects obsolete asynchronous results after account changes, and emits one trusted selection signal.

The current Workspace selection is migrated once into the new product-space store. After migration, the Workspace cache is no longer a second writable selection source. Compatibility adapters may forward old internal calls to the coordinator, but there is no dual write.

The global renderer switcher uses `window.agenteraProductSpace`; Workspace and Organization management continue through their independent preload namespaces.

### Foundation behavior on the Agent screen

The Agent control adapter maps PERSONAL and WORKSPACE selections to their existing trusted Agent contexts. An ORGANIZATION selection in Foundation maps to an explicit `organization_agent_not_enabled` presentation state, not to USER and not to WORKSPACE.

The Agent screen may explain that enterprise Agent management arrives in the next slice. It must not display personal Agent drafts as if they were Organization assets or accept an Organization ownership field from the renderer.

Organization Agent V1 will later replace this explicit unavailable state with a trusted `ORGANIZATION` asset context.

### Runtime boundary

Neither the Organization manager nor the product-space coordinator imports or invokes Runtime bootstrap, Profile selection or mutation, session storage, Memory, local Skill mutation, Curator, Runtime distribution, or RuntimeBinding mutation.

`aera-runtime` remains byte-for-byte unchanged in this slice.

## Cloud Data Model

The Organization migration adds six Organization-owned tables and one Organization scope on the existing audit table. All timestamps are UTC `TIMESTAMPTZ`. UUIDs are server-generated.

### `organizations`

Fields:

- `id UUID PRIMARY KEY`
- `display_name TEXT NOT NULL`
- `status TEXT NOT NULL` constrained to `active|archived|dissolved`
- `revision BIGINT NOT NULL DEFAULT 1` and greater than zero
- `current_policy_snapshot_id UUID`
- `created_at TIMESTAMPTZ NOT NULL`
- `updated_at TIMESTAMPTZ NOT NULL`
- `archived_at TIMESTAMPTZ`
- `dissolved_at TIMESTAMPTZ`

Checks require:

- a trimmed NFC display name from 1 through 120 Unicode scalar values;
- no control characters;
- `active` with no archive or dissolution time;
- `archived` with `archived_at` and no dissolution time;
- `dissolved` with both archive and dissolution times;
- a non-null current signed policy for every active or archived Organization at transaction commit.

There is intentionally no `owner_user_id` column. The unique Owner Membership is the single ownership source, so transfer never updates two independently meaningful owner records.

### `organization_memberships`

Fields:

- `organization_id UUID NOT NULL REFERENCES organizations(id)`
- `user_id UUID NOT NULL REFERENCES users(id)`
- `role TEXT NOT NULL` constrained to `owner|admin|auditor|member`
- `department_id UUID`
- `revision BIGINT NOT NULL DEFAULT 1` and greater than zero
- `joined_at TIMESTAMPTZ NOT NULL`
- `updated_at TIMESTAMPTZ NOT NULL`
- primary key `(organization_id, user_id)`

A partial unique index allows at most one Owner. Deferred constraint triggers require exactly one Owner for every active or archived Organization and zero Memberships for a dissolved Organization.

A composite foreign key from `(organization_id, department_id)` to the Department table prevents cross-Organization assignment. One Membership may belong to zero or one Department; department membership never changes the Organization-wide role.

### `organization_departments`

Fields:

- `organization_id UUID NOT NULL REFERENCES organizations(id)`
- `id UUID NOT NULL`
- `display_name TEXT NOT NULL`
- `name_key TEXT NOT NULL`
- `status TEXT NOT NULL` constrained to `active|archived`
- `revision BIGINT NOT NULL DEFAULT 1` and greater than zero
- `created_at TIMESTAMPTZ NOT NULL`
- `updated_at TIMESTAMPTZ NOT NULL`
- `archived_at TIMESTAMPTZ`
- primary key `(organization_id, id)`

The service derives `name_key` from the trimmed NFC, case-folded display name. A unique Organization/name-key index prevents visually equivalent active Department duplicates.

Departments are one level only and contain no `parent_id`. A Department must have no assigned Memberships before archive. Restore rechecks the Department quota and active-name uniqueness.

### `organization_invitations`

Fields:

- `id UUID PRIMARY KEY`
- `organization_id UUID NOT NULL REFERENCES organizations(id)`
- `token_digest BYTEA NOT NULL UNIQUE` with exactly 32 bytes
- `created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL`
- `status TEXT NOT NULL` constrained to `pending|accepted|revoked|expired`
- `accepted_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL`
- `created_at TIMESTAMPTZ NOT NULL`
- `expires_at TIMESTAMPTZ NOT NULL`
- `accepted_at TIMESTAMPTZ`
- `revoked_at TIMESTAMPTZ`

The raw invitation is 32 cryptographically random bytes encoded as unpadded base64url. Only `SHA-256(raw_token)` is stored. The raw token is returned once, held only in volatile UI/main-process state, and never logged, audited, cached, listed, or placed in query parameters.

Every invitation grants Member. It carries neither role nor Department. The accepted Member may be assigned later by Owner or Admin.

Checks require exactly seven days between creation and expiry, lifecycle-consistent terminal fields, and transitions only from `pending` to one terminal state.

### `organization_policy_snapshots`

Fields:

- `id UUID PRIMARY KEY`
- `organization_id UUID NOT NULL REFERENCES organizations(id)`
- `policy_version BIGINT NOT NULL` and greater than zero
- `schema_version INTEGER NOT NULL` and equal to `1` in this slice
- `policy_document JSONB NOT NULL`
- `content_digest BYTEA NOT NULL` with exactly 32 bytes
- `issuer TEXT NOT NULL`
- `signing_key_id TEXT NOT NULL`
- `signature BYTEA NOT NULL` with exactly 64 bytes
- `issued_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL`
- `created_at TIMESTAMPTZ NOT NULL`

`(organization_id, policy_version)` is unique. A deferred composite foreign key ensures `organizations.current_policy_snapshot_id` points to a snapshot owned by that exact Organization.

A trigger rejects every update and delete. New policy becomes current only in the same transaction that inserts the immutable snapshot and success audit.

### `organization_idempotency_records`

Fields:

- `actor_user_id UUID NOT NULL REFERENCES users(id)`
- `organization_id UUID NOT NULL REFERENCES organizations(id)`
- `operation TEXT NOT NULL`
- `key_digest BYTEA NOT NULL` with exactly 32 bytes
- `request_digest BYTEA NOT NULL` with exactly 32 bytes
- `resource_type TEXT NOT NULL`
- `resource_id UUID NOT NULL`
- `created_at TIMESTAMPTZ NOT NULL`
- `expires_at TIMESTAMPTZ NOT NULL`
- primary key `(actor_user_id, operation, key_digest)`

The fixed replay window is 24 hours. Same key plus same canonical request returns the original safe result; same key plus different content returns `409 idempotency_conflict`.

Secret-once invitation creation never replays a raw token. If the initial secret response is lost, the caller revokes the safe invitation summary and creates a new invitation.

### Organization-scoped audit

`audit_events` gains nullable `organization_id UUID REFERENCES organizations(id)` and an index on `(organization_id, created_at DESC, id DESC)`.

Organization audit queries require active Membership and Owner/Admin/Auditor role. The Organization row remains as a non-selectable tombstone after dissolution, so retained audit evidence never depends on an orphaned mutable object.

Audit rows are append-only through the existing recorder. Account finalization may anonymize actor or subject identities under the existing privacy contract without changing event type, outcome, reason code, Organization ID, or timestamp.

## Database and Transaction Invariants

The database and repository transactions jointly guarantee:

1. every active or archived Organization has exactly one Owner;
2. a dissolved Organization has no Memberships and can never return to active or archived;
3. Owner transfer promotes one existing Admin and demotes the old Owner in one transaction;
4. no Membership may reference a Department in another Organization;
5. no archived Department may receive a new assignment;
6. invitation tokens are globally single-use and terminal states cannot transition;
7. policy versions are immutable and monotonically increasing within an Organization;
8. the current policy pointer belongs to the same Organization;
9. every mutable aggregate uses a positive revision and compare-and-swap update;
10. a successful high-risk mutation and its audit event commit together;
11. Organization tables contain no Runtime Profile, Memory, session, file, credential, or local-learning fields.

## Roles and Authorization

The authenticated access token supplies the actor user and device. Cloud authorization is recomputed inside the mutation transaction.

| Operation | Owner | Admin | Auditor | Member |
| --- | ---: | ---: | ---: | ---: |
| Read Organization basics, member directory, and Departments | yes | yes | yes | yes |
| Read current safe policy summary | yes | yes | yes | yes |
| Read full policy history and audit | yes | yes | yes | no |
| Rename Organization | yes | yes | no | no |
| Create, rename, archive, or restore Department | yes | yes | no | no |
| Create, list, or revoke invitations | yes | yes | no | no |
| Assign Member Departments | yes | yes | no | no |
| Promote/demote/remove Member or Auditor | yes | yes | no | no |
| Promote/demote/remove Admin | yes | no | no | no |
| Publish a new Organization policy snapshot | yes | yes | no | no |
| Transfer ownership | yes | no | no | no |
| Archive, restore, or dissolve Organization | yes | no | no | no |
| Leave Organization | no | yes | yes | yes |

Additional rules:

- Admin cannot modify Owner or another Admin and cannot promote anyone to Admin;
- Auditor is read-only and cannot create invitations or mutate Organization state;
- Member receives only safe directory and current-policy summary fields;
- Owner cannot leave, remove, or demote self outside the transfer transaction;
- archived Organizations are read-only except Owner restore, Owner transfer, and safe dissolution;
- non-members receive a non-enumerating not-found response;
- members without sufficient role receive an explicit bounded forbidden result;
- role, membership, policy, transfer, archive, restore, and dissolution outcomes are audited.

## Organization Lifecycle

### Create

Any active authenticated account may create an Organization within quota. One transaction inserts the Organization, Owner Membership, signed default policy snapshot, current-policy pointer, idempotency result, and success audit.

No partially initialized Organization may commit.

### Rename

Owner or Admin may rename an active Organization using the current Organization revision. Archived Organizations are not renamed in V1.

### Owner transfer

Only the current Owner may transfer to an existing active Admin. The request includes the Organization revision, target Membership revision, and exact transfer confirmation.

One transaction locks the Organization and both Memberships, promotes the target to Owner, demotes the prior Owner to Admin, increments affected revisions, writes idempotency evidence, and records audit. Deferred constraints reject zero or two Owners at commit.

### Archive

Only Owner may archive an active Organization. One transaction changes the status, increments revision, revokes all pending invitations, invalidates mutable desktop state on the next refresh, and records audit.

Memberships, Departments, policy history, and audit remain readable. Revoked invitations never revive on restore.

### Restore

Only Owner may restore an archived Organization. Restore rechecks Organization quota, clears the archived state, increments revision, and records audit. New invitations must be created explicitly.

### Dissolve

Only Owner may dissolve an archived Organization. The request must include the exact current display name, current revision, and explicit dissolution confirmation.

The transaction requires:

- no Membership other than Owner;
- no pending invitation;
- no assigned Department member;
- no blocker returned by the Organization asset guard.

It then records the final audit, removes Membership, Department, invitation, and live idempotency rows, marks the Organization `dissolved`, redacts its display name to a non-identifying tombstone label, retains immutable policy and audit evidence, and clears selection on authoritative desktop refresh.

Dissolution is terminal and never deletes, edits, or claims a local Hermes Profile. Organization Agent V1 will register enterprise definitions, versions, and protected installation relationships with the asset guard before those assets exist.

### Account deletion

An account cannot enter pending deletion while it owns a non-dissolved Organization. The account lifecycle returns `409 organization_owner_transfer_required` with a safe count and requires transfer or dissolution first.

Finalizing a non-Owner account removes its Organization Membership and Department assignment, nulls nullable invitation actor references, and anonymizes retained audit identity under the existing account-deletion rules. It never deletes the Organization or another member's access.

## Departments

Departments are Organization-internal member groups, not product spaces and not asset owners.

- one Organization may have multiple one-level Departments;
- a Membership may have zero or one Department;
- a Department has no nested parent and no independent role matrix;
- Organization roles apply across all Departments;
- Department selection never appears in the global product-space switcher;
- assigning or removing a Department never selects or mutates a Hermes Profile;
- archiving a Department requires it to be empty;
- future policy targeting may reference Department IDs, but `owner_scope=DEPARTMENT` is explicitly unsupported.

## Organization Policy V1

### Document schema

The canonical policy document is strict and bounded to 64 KiB:

```json
{
  "schema_version": 1,
  "models": {
    "allowlist": null
  },
  "tools": {
    "allowlist": null
  },
  "experience_candidates": {
    "mode": "manual_review"
  },
  "official_agents": {
    "installation": "allowed"
  }
}
```

Semantics:

- `models.allowlist` is `null` to inherit platform allowance, an empty list to deny every cloud-managed model choice, or a sorted unique list of `{provider, model}` identifiers to restrict;
- `tools.allowlist` follows the same inherit/deny/restrict rule for canonical tool identifiers;
- `experience_candidates.mode` is `disabled` or `manual_review`; automatic submission, approval, or publication has no schema value;
- `official_agents.installation` is `allowed` or `blocked`;
- unknown keys, duplicate logical entries, secrets, credentials, Profile paths, or private Hermes content are rejected;
- enterprise Agent publication review by Owner/Admin is a mandatory product invariant and cannot be disabled by policy.

The default V1 snapshot inherits platform model/tool allowance, requires manual ExperienceCandidate review, and permits future official Agent installation.

### Canonicalization and signing

The service validates the typed document, normalizes strings to NFC, sorts allowlists deterministically, serializes canonical JSON, computes SHA-256, and signs the digest with the existing platform Ed25519 policy-signing service.

The desktop verifies schema, digest, key ID, and signature before caching. A missing key, unknown schema, digest mismatch, or invalid signature cannot replace the last verified snapshot.

### Effective-policy composition

Later runtime enforcement uses:

```text
effective policy = platform policy ∩ organization policy ∩ user/local safety restriction
```

An Organization may narrow but never broaden platform or local safety constraints.

Foundation implements policy creation, immutable storage, current selection, verification, caching, presentation, and audit only. Organization Agent V1 connects model, tool, publication, and installation enforcement to the enterprise Agent flow. Official Managed Agent V1 consumes the official-installation rule.

## Quotas and Validation

Server configuration controls quotas. Foundation defaults are:

- 3 non-dissolved Organizations owned by one account;
- 500 Memberships per Organization, including Owner;
- 50 active Departments per Organization;
- 100 pending invitations per Organization;
- one invitation valid for exactly seven days;
- Organization name from 1 through 120 Unicode scalar values after trimming;
- Department name from 1 through 80 Unicode scalar values after trimming;
- policy document no larger than 64 KiB after canonicalization.

Archived Organizations continue to consume the ownership quota so create/archive cannot bypass the limit. A dissolved Organization does not consume it.

Quota checks and writes occur under the same transaction lock. Rate limits are independent of storage quotas and cover creation, invitation creation/acceptance, role changes, Owner transfer, policy publication, archive/restore, and dissolution.

## Cloud HTTP API

Every route requires the existing desktop bearer access token unless the description explicitly refers to the invitation token inside the authenticated request body.

### Organization collection and resource

```text
GET   /api/v1/organizations
POST  /api/v1/organizations
GET   /api/v1/organizations/{organization_id}
PATCH /api/v1/organizations/{organization_id}
POST  /api/v1/organizations/{organization_id}/archive
POST  /api/v1/organizations/{organization_id}/restore
POST  /api/v1/organizations/{organization_id}/owner-transfer
POST  /api/v1/organizations/{organization_id}/dissolve
```

Create accepts `{display_name}`. Rename accepts `{display_name, expected_revision}`. Lifecycle and transfer commands include the exact expected revisions and explicit confirmation fields defined above.

### Memberships

```text
GET    /api/v1/organizations/{organization_id}/members
PATCH  /api/v1/organizations/{organization_id}/members/{user_id}
DELETE /api/v1/organizations/{organization_id}/members/{user_id}
POST   /api/v1/organizations/{organization_id}/leave
```

Membership patch accepts only `{role?, department_id?, expected_revision}` with at least one intended change. Owner assignment is rejected here and uses only the transfer route.

### Departments

```text
GET   /api/v1/organizations/{organization_id}/departments
POST  /api/v1/organizations/{organization_id}/departments
PATCH /api/v1/organizations/{organization_id}/departments/{department_id}
POST  /api/v1/organizations/{organization_id}/departments/{department_id}/archive
POST  /api/v1/organizations/{organization_id}/departments/{department_id}/restore
```

### Invitations

```text
GET    /api/v1/organizations/{organization_id}/invitations
POST   /api/v1/organizations/{organization_id}/invitations
DELETE /api/v1/organizations/{organization_id}/invitations/{invitation_id}
POST   /api/v1/organization-invitations/accept
```

Invitation creation returns a raw token and fragment deep link only on first success. Acceptance accepts `{token}` and never returns the token.

### Policies

```text
GET  /api/v1/organizations/{organization_id}/policy
GET  /api/v1/organizations/{organization_id}/policy-snapshots
POST /api/v1/organizations/{organization_id}/policy-snapshots
GET  /api/v1/organization-policy-snapshots/{policy_snapshot_id}
```

The current summary route is safe for every member. Full snapshot history and snapshot detail require Owner/Admin/Auditor. Publication requires Owner/Admin and accepts `{policy_document, expected_organization_revision, expected_policy_version}`.

### Audit

```text
GET /api/v1/organizations/{organization_id}/audit-events
```

Audit uses an opaque keyset cursor and `limit` from 1 through 100. It is online-only and role-gated to Owner/Admin/Auditor.

### Request and response rules

- JSON is strict; unknown fields, malformed UUIDs, duplicate keys, non-canonical enums, oversized bodies, and control characters are rejected;
- collection and audit routes use bounded keyset pagination where the quota exceeds one response page;
- public summaries expose only IDs, display names, lifecycle state, actor role, safe counts, revisions, timestamps, policy version/digest metadata, and mutation state;
- Member responses omit invitation metadata, full policy documents, audit, private account identifiers, and restricted actor data;
- no response exposes email, phone, credential, access token, invitation digest, signing private key, local path, Profile ID/path, Memory, conversation, or private Skill content;
- create, invitation creation/acceptance, policy publication, Owner transfer, archive/restore, and dissolution require `Idempotency-Key`;
- every mutable route uses expected revision or expected version compare-and-swap semantics.

## Error Semantics

The API returns the existing bounded error envelope with stable codes:

- `400 invalid_request` for malformed or unknown input;
- `401 authentication_required` for missing or invalid product authentication;
- `404 organization_not_found` for unknown Organization or outsider access;
- `403 organization_forbidden` for a known Member lacking role;
- `409 organization_conflict` for stale revision or competing mutation;
- `409 organization_archived` for a mutation unavailable while archived;
- `409 organization_dissolved` for a terminal lifecycle target known to an authorized tombstone lookup;
- `409 organization_limit_reached` for ownership quota;
- `409 organization_owner_transfer_required` when account deletion still owns an Organization;
- `409 owner_transfer_target_invalid` unless the target is a current Admin;
- `409 membership_conflict` for illegal role or Department mutation;
- `409 department_not_empty` for archive with assigned members;
- `409 policy_version_conflict` for stale policy publication;
- `409 idempotency_conflict` for key reuse with different content;
- `404 invitation_unavailable` for unknown, expired, revoked, accepted, or concurrently consumed token;
- `429 rate_limited` for bounded abuse controls;
- `503 service_unavailable` for database, signing, required audit, or policy-key dependency failure.

Errors never return raw database details, cloud response bodies, request bodies, token material, matched secrets, stack traces, or local filesystem details.

## Transaction, Failure, and Audit Rules

- high-risk state mutation, idempotency record, and success audit commit in one PostgreSQL transaction;
- any invariant, signing, persistence, or audit failure rolls the entire mutation back;
- a denied high-risk mutation records bounded denial evidence; if required denial audit cannot persist, the request remains denied and no state changes;
- ambiguous network retries reuse the same idempotency key and never create a second resource or policy version;
- concurrent invitation acceptance has exactly one winner;
- concurrent Owner transfer has exactly one legal commit;
- concurrent policy publication preserves one monotonic version sequence;
- cache or transport failure never mutates a Hermes Profile or active RuntimeBinding;
- failed Organization work creates no automatic private-data upload or offline mutation queue.

Audit records may contain:

- Organization ID;
- object type and object ID;
- actor and device identifiers subject to account anonymization;
- event type, outcome, bounded reason code, request ID, revisions, policy version, and content digest;
- changed role or Department IDs when needed for accountability.

Audit records must not contain raw invitation tokens or digests, full policy request bodies, credentials, API keys, Profile paths, Memory, USER, conversations, sessions, files, private Skill content, or Curator state.

## Desktop Data Model

The Organization cache lives below Electron `userData/agentera-organization/organization.db`. Every table is partitioned by authenticated `account_user_id`.

It stores:

- safe Organization summaries and actor role;
- safe Membership and Department summaries;
- invitation metadata without raw token or digest;
- verified current policy and authorized policy history;
- refresh timestamps and stale markers;
- durable non-secret mutation intents/idempotency keys needed to resolve ambiguous online results.

It does not cache Organization audit events in V1. Audit remains online-only to minimize sensitive local replication.

The separate product-space store lives below `userData/agentera-product-space/space.db` and stores one selected kind/ID per account. It imports a valid existing Workspace selection once, validates it against current cache, and then becomes the only writable selection source.

Account changes close and rebuild Organization and product-space state. Late results from an old account generation are discarded before cache or renderer publication. Two accounts using one Electron userData root cannot list, select, or mutate each other's Organization rows.

## Desktop Product Behavior

### Global switcher

The existing top switcher becomes a product-space switcher below the AgentEra brand. It presents:

1. Personal space;
2. active Workspace memberships;
3. active Organization memberships.

The categories are visually distinct and deterministically sorted by display name and ID. Archived Workspace and Organization entries remain available only inside their management surfaces and cannot become active product context.

Selecting a context validates the cached membership, persists the account-scoped selection, closes context-bound dialogs, and emits one trusted main-process event. It does not call Profile selection, Runtime bootstrap, Gateway restart, session migration, or RuntimeBinding mutation.

If authoritative refresh removes, archives, or dissolves the selected scope, selection falls back to Personal. The prior Hermes Profile and active conversation remain untouched.

### Organization management

The Organization management surface provides role-aware sections for:

- overview and lifecycle;
- members and roles;
- Departments and assignment;
- invitations;
- current policy and policy history;
- audit.

Member sees only safe overview, directory, own role/Department, and current policy summary. Auditor additionally sees full policy history and audit. Admin receives allowed Organization, Department, Member/Auditor, invitation, and policy mutations. Owner additionally receives Admin management, ownership transfer, archive/restore, and dissolution.

Renderer-side controls are presentation only. The cloud remains the final authorization authority for every request.

### Invitation handoff and single instance

The desktop accepts only the exact fragment link:

```text
agentera://organization-invitation#TOKEN
```

It rejects credentials, ports, paths, queries, percent-encoded non-canonical forms, malformed tokens, and every other host/scheme variant.

The existing single-instance invitation inbox becomes a tagged volatile union for Workspace or Organization invitation. Only one pending token is held; a newer valid link replaces the unaccepted entry. The token is never written to SQLite, logs, telemetry, OAuth state, local storage, or session storage.

If authentication is required, volatile main-process memory retains the tagged token until explicit acceptance or dismissal. A second desktop launch forwards the validated invitation to the existing instance and cannot start a second Runtime bootstrap.

### Offline behavior

With a valid product offline entitlement, the desktop may show last-verified Organization summaries, actor role, Departments, Member summaries, and current signed policy as stale and read-only.

- the UI displays the last successful refresh time;
- every Organization mutation and audit query is disabled;
- no offline mutation queue is created;
- no stale role is used to authorize a cloud mutation after reconnect;
- policy verification failure retains the previous valid snapshot and displays a bounded error;
- existing local Agent use, Memory, Skill learning, Curator, and active conversations continue independently.

## Organization-to-Hermes Relationship

Organization is a cloud asset and authorization boundary. Hermes Profile is a USER/device-local runtime and learning boundary.

The mapping remains indirect:

```text
Organization owns future AgentDefinition and immutable AgentVersion
User owns Installation
Installation maps to one independent Hermes Profile
New conversation receives one immutable USER-owned RuntimeBinding
```

The same future Organization Agent installed by 100 employees produces 100 USER-owned Installations and 100 independent writable Profiles. Organization policy may constrain future use but never grants Organization access to employee Memory, conversations, private learning, credentials, or Profile filesystem.

## Extension Contracts for Later Slices

Organization Foundation exposes only narrow, tested contracts:

- authorize Organization Membership and role inside a transaction;
- load the current verified Organization policy snapshot;
- identify Organization lifecycle and mutation state;
- list active Organizations for the authenticated user;
- register dissolution blockers through the asset guard;
- emit the trusted selected product context.

Organization Agent V1 will consume these contracts to add `owner_scope=ORGANIZATION` only to enterprise Agent assets. Member Installation, policy overlay, RuntimeBinding, physical Profile, and adaptive state remain USER-owned.

Official Managed Agent V1 later uses PLATFORM-owned assets and the Organization policy rule for official installation. Neither later slice may bypass the review, policy, audit, version, or Hermes-isolation contracts defined here.

## Verification Gate

### Cloud migration and repository tests

Tests must prove:

- every table, column, foreign key, partial unique index, check, immutable trigger, and deferred constraint exists;
- active/archived Organizations cannot commit with zero or two Owners;
- dissolved Organizations cannot retain Memberships or restore;
- cross-Organization Department assignment is impossible;
- invitation expiry and terminal transitions are database-enforced;
- policy snapshots reject update/delete, invalid signature shape, and duplicate version;
- current policy cannot point across Organizations;
- Organization-scoped audit queries use the exact Organization index and authorization;
- account finalization is blocked for Owner and preserves Organizations for non-Owner deletion.

### Cloud service, HTTP, and OpenAPI tests

Tests must cover:

- the complete Owner/Admin/Auditor/Member/outsider permission matrix;
- creation quotas and atomic default policy creation;
- one-time invitation creation, fragment-link safety, acceptance replay, expiry, revocation, and concurrent consumption;
- Department uniqueness, assignment, empty-before-archive, and restore;
- atomic Owner transfer and concurrent transfer races;
- policy canonicalization, digest, signature, monotonic version, and effective restriction semantics;
- archive, restore, dissolution, and asset-guard denial;
- strict JSON, UUID validation, body limits, pagination, rate limits, stable errors, and idempotency conflicts;
- audit success, denial, rollback, redaction, and query authorization;
- real PostgreSQL integration and generated OpenAPI contract compatibility.

### Desktop unit and integration tests

Tests must prove:

- Organization cloud responses and policy signatures are strictly validated;
- account-partitioned cache prevents cross-account reads and obsolete-result writes;
- product-space migration preserves a valid existing Personal/Workspace selection;
- one product-space coordinator is the only writable selection source;
- Personal, Workspace, and Organization render side by side in deterministic order;
- Department never appears as a global selection;
- role-specific UI hides and disables unauthorized actions;
- invalid policy never replaces the previous verified cache;
- offline state is visibly stale and mutation-free;
- raw invitation token appears only in first creation response, protocol handoff, and acceptance request;
- Organization selection produces `organization_agent_not_enabled` rather than silently using USER Agent scope;
- account, selection, membership, or role changes invalidate context-bound handles and dialogs.

### Deterministic end-to-end flow

The real desktop Organization client, manager, caches, product-space coordinator, preload API, renderer, and a strict local cloud run:

```text
Owner creates Organization
→ creates Department
→ creates one-time invitation
→ Member accepts under another account
→ Owner assigns Department
→ Owner promotes Member to Admin
→ Admin creates Auditor
→ Admin publishes policy V2
→ Auditor reads policy history and audit
→ Owner transfers ownership to Admin
→ new Owner archives and restores
→ all other members leave or are removed
→ Departments are emptied and archived
→ new Owner archives and safely dissolves
```

The fixture rejects unexpected routes, bodies, headers, actor fields, duplicate effects, secret persistence, or unauthorized calls.

### Hermes compatibility gate

Before and after every Organization action, the test hashes a populated Hermes Profile tree and snapshots:

- selected Profile identity;
- active conversation/session identity;
- active RuntimeBinding;
- native Memory and USER files;
- local learned Skills and Curator state;
- Runtime/Gateway process identity.

Every byte and identity remains unchanged. Static boundary tests reject Organization or product-space imports into Hermes Profile mutation, Memory, sessions, Skill mutation, Curator, Runtime distribution, RuntimeBinding ownership, legacy sync, or Gateway restart paths.

Existing authentication, Workspace Foundation, Workspace Agent, Agent control, ExperienceCandidate, self-evolution, Runtime compatibility, and complete desktop/cloud suites remain required.

`aera-runtime` must finish with no worktree diff.

## Delivery and Completion Rule

Implementation uses dedicated local `aera/organization-foundation-v1` branches/worktrees in `aera` and `aera-cloud`, follows test-driven development, and keeps cloud and desktop commits reviewable.

Completion requires:

1. cloud migration/domain/API/OpenAPI tests pass;
2. desktop contract/cache/coordinator/UI tests pass;
3. deterministic multi-account E2E passes;
4. Hermes compatibility gates pass;
5. complete existing cloud and desktop suites pass;
6. `lat.md` documentation and references validate;
7. both feature branches are locally merged into their clean local `main` branches;
8. `aera-runtime` remains unchanged.

Local validation or merge is not a GitHub push, production deployment, or release. No push or deployment occurs without separate user authorization.

After this slice is locally merged, development proceeds continuously to a separate Organization Agent V1 design and implementation checkpoint.
