# AgentEra Workspace Foundation V1 Design

**Status:** Approved for implementation planning on 2026-07-20
**Repositories:** `aera-cloud` and `aera`
**Runtime repository:** `aera-runtime` remains unchanged

## Purpose

Workspace Foundation V1 adds the collaborative ownership and authorization boundary required by the user's AgentEra/Hermes architecture diagram without enabling workspace-owned Agent publication yet.

The release lets an authenticated AgentEra user create and archive workspaces, invite members with a one-time link, manage Owner/Admin/Member roles, switch the desktop's active product scope, and continue local Hermes operation while the workspace control plane is offline.

## Existing Baseline

The current cloud creates exactly one `personal_space` for every registered user. Authentication and offline entitlement claims carry that personal space identifier. The USER Agent control plane already implements AgentDefinition, immutable AgentVersion, Installation, policy snapshots, RuntimeBinding metadata, and audit while keeping Hermes private runtime data local.

Workspace V1 builds beside those systems:

- it does not rename or generalize `personal_spaces`;
- it does not place membership or invitation behavior in `internal/agentcontrol`;
- it does not change the meaning of existing authentication or offline entitlement claims;
- it does not enable `owner_scope=WORKSPACE` in Agent publication yet.

## Non-Negotiable Architecture Boundary

The user's architecture diagram remains the source of truth.

- AgentEra Workspace is a cloud identity, membership, authorization, metadata, and audit boundary.
- Agent execution remains on the user's computer in Hermes.
- Workspace switching must not switch, clone, migrate, merge, or delete a Hermes Profile.
- Workspace APIs and caches must not read or store `MEMORY.md`, `USER.md`, conversations, files, credentials, local paths, Curator state, or unpublished local skills.
- A running RuntimeBinding remains fixed for its conversation or isolated job when the selected product space changes.
- Hermes background review, Memory updates, Skill learning, and Curator continue independently of workspace cloud availability.
- Cross-scope Agent publication remains unavailable until the separate Workspace Agent slice adds explicit policy, audit, version, installation, and read-only asset rules.

## Scope

Workspace Foundation V1 includes:

- workspace creation, rename, archive, and restore;
- one fixed Owner per workspace;
- Owner, Admin, and Member memberships;
- one-time invitation links with seven-day expiry;
- member list, role changes, removal, and voluntary leave;
- workspace operation audit;
- cloud OpenAPI contracts and desktop-generated types;
- an account-scoped desktop cache;
- a global space switcher below the AgentEra brand and above primary navigation;
- workspace management UI;
- offline read-only workspace metadata;
- account-switch and cross-workspace isolation tests.

## Explicit Non-Goals

V1 does not include:

- workspace-owned AgentDefinition, AgentDraft, AgentVersion, Installation, or RuntimeBinding creation;
- shared Knowledge, Skill, SOP, Prompt, or Artifact publication;
- ExperienceCandidate generation, DLP, review queues, or evolution publication;
- organization or department models;
- official managed Agents;
- Owner transfer, multiple Owners, or permanent workspace deletion through a workspace API;
- automatic email or SMS invitation delivery;
- a public user directory or identity lookup endpoint;
- Memory, session, file, credential, or Profile backup;
- production deployment, domain changes, GitHub push, or Runtime release.

## Selected Architecture

Workspace is a dedicated cloud and desktop domain.

### Cloud

`aera-cloud/internal/workspace` owns workspace models, repository transactions, authorization, HTTP handlers, quotas, invitation token processing, and workspace audit commands. It consumes the authenticated account/session principal but never accepts actor identity from a request payload.

The existing `internal/space` package remains the narrow personal-space registration helper. The existing `internal/agentcontrol` package remains USER-only in this slice.

### Desktop

`aera/src/main/agentera-workspace` owns the trusted cloud client, local cache, selected space context, account-change handling, and exact IPC serializers. The renderer consumes only the public workspace contract through a namespaced preload API.

Workspace code never imports or calls Hermes Memory, Profile cloning, session storage, Skill mutation, Curator, or Runtime distribution mutation APIs.

## Cloud Data Model

The migration adds four workspace-owned tables. All timestamps are UTC `TIMESTAMPTZ`. UUIDs are server-generated.

### `workspaces`

Fields:

- `id UUID PRIMARY KEY`
- `owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT`
- `display_name TEXT NOT NULL`
- `status TEXT NOT NULL` constrained to `active|archived`
- `revision BIGINT NOT NULL DEFAULT 1` and greater than zero
- `created_at TIMESTAMPTZ NOT NULL`
- `updated_at TIMESTAMPTZ NOT NULL`
- `archived_at TIMESTAMPTZ`

Constraints:

- a trimmed display name is 1 through 80 Unicode scalar values;
- control characters are rejected;
- active workspaces require `archived_at IS NULL`;
- archived workspaces require `archived_at IS NOT NULL`;
- `owner_user_id` never changes in V1.

The migration installs deferred constraint triggers that require exactly one `owner` membership whose `user_id` equals `workspaces.owner_user_id` at transaction commit. The partial unique index still prevents a second Owner row. Workspace creation therefore cannot commit a workspace and membership set with a missing or mismatched Owner.

Account finalization is the only path that may permanently remove an owned workspace. Because Owner transfer is out of scope, the seven-day account-deletion cooling period makes every owned workspace read-only while the Owner is `pending_deletion`. Reads remain available to existing members, but all mutations fail with `409 workspace_owner_unavailable`; invitation acceptance uses the generic unavailable result. Account recovery unfreezes the workspaces without changing their lifecycle status.

At finalization, the account lifecycle transaction explicitly deletes every workspace owned by the account and every non-Owner membership or idempotency record held by it. It also nulls invitation creator/acceptor references to that account before anonymizing retained audit rows and disabling the user. Workspace foreign-key cascades remove its membership, invitation, and idempotency rows; deleting a `users` row is not relied upon because finalized accounts remain as disabled, anonymized principals. The account deletion confirmation and API response disclose the number of owned workspaces that will be removed.

### `workspace_memberships`

Fields:

- `workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE`
- `user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE`
- `role TEXT NOT NULL` constrained to `owner|admin|member`
- `revision BIGINT NOT NULL DEFAULT 1` and greater than zero
- `joined_at TIMESTAMPTZ NOT NULL`
- `updated_at TIMESTAMPTZ NOT NULL`
- primary key `(workspace_id, user_id)`

A partial unique index permits at most one `owner` row per workspace. Workspace creation inserts the workspace and its Owner membership in one transaction. No V1 command can update or delete the Owner membership. The deferred Owner invariant rejects an invalid commit; repository reads additionally treat a workspace without the matching Owner membership as corrupt and unavailable.

### `workspace_invitations`

Fields:

- `id UUID PRIMARY KEY`
- `workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE`
- `token_digest BYTEA NOT NULL UNIQUE` with exactly 32 bytes
- `created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL`
- `status TEXT NOT NULL` constrained to `pending|accepted|revoked|expired`
- `accepted_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL`
- `created_at TIMESTAMPTZ NOT NULL`
- `expires_at TIMESTAMPTZ NOT NULL`
- `accepted_at TIMESTAMPTZ`
- `revoked_at TIMESTAMPTZ`

Database checks require `expires_at = created_at + interval '7 days'`, acceptance fields only for `accepted`, and `revoked_at` only for `revoked`; terminal invitation states cannot transition again.

The raw invitation token is exactly 32 cryptographically random bytes encoded as unpadded base64url. It is returned once by the creation API and is never persisted, logged, audited, cached, or returned by a list endpoint. The database stores `SHA-256(raw_token)` only. The copyable browser/deep link places the token in a URL fragment rather than a query string so it is not sent in the initial HTTP request, access log, or Referer; the authenticated accept surface extracts it locally and submits it in the accept request body. If sign-in is required, the original tab or desktop process holds the token in volatile memory while authentication completes; it is not copied into OAuth state, `localStorage`, or `sessionStorage`.

Every invitation grants `member`. V1 intentionally has no invitation role column. Admin promotion is a separate Owner-only audited command after acceptance.

### `workspace_idempotency_records`

Fields:

- `actor_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE`
- `workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE`
- `operation TEXT NOT NULL`
- `key_digest BYTEA NOT NULL` with exactly 32 bytes
- `request_digest BYTEA NOT NULL` with exactly 32 bytes
- `resource_type TEXT NOT NULL`
- `resource_id UUID NOT NULL`
- `created_at TIMESTAMPTZ NOT NULL`
- `expires_at TIMESTAMPTZ NOT NULL`
- primary key `(actor_user_id, operation, key_digest)`

Creating a workspace, creating an invitation, and accepting an invitation require an `Idempotency-Key`. Reusing a key with the same canonical request returns the original resource identifier and current safe representation without performing the mutation again. Reusing it with different request content returns `409 idempotency_conflict`.

Invitation creation is deliberately secret-once: its first successful response contains the raw token/link, but an idempotent replay returns only the same invitation summary with `secret_replayable=false`. It never creates a duplicate and never reissues the token. If the first response was lost before the token was copied, the user must revoke that invitation and create a new one. For invitation acceptance, the service checks a matching idempotency record before token availability: the original accepting actor can replay the same key and receive the membership result, while a different actor or key sees the generic unavailable response after the token is consumed.

The replay guarantee lasts for the record's fixed 24-hour retention window. Cleanup may remove an expired record; a later create request is treated as new, while a later invitation acceptance still sees the already-consumed token as unavailable.

## Roles and Authorization

The authenticated access token supplies the actor user and device. Request payloads never supply or override the actor.

| Operation | Owner | Admin | Member |
| --- | ---: | ---: | ---: |
| Read workspace and member list | yes | yes | yes |
| Rename workspace | yes | yes | no |
| Create, list, and revoke invitations | yes | yes | no |
| Remove a Member | yes | yes | no |
| Promote Member to Admin | yes | no | no |
| Demote or remove Admin | yes | no | no |
| Leave workspace | no | yes | yes |
| Archive or restore workspace | yes | no | no |

Additional rules:

- one workspace has exactly one fixed Owner;
- Owner transfer and multiple Owners are rejected;
- every mutation also requires the fixed Owner account to remain `active`;
- Admin cannot modify or remove Owner or another Admin;
- Member and Admin may leave voluntarily;
- a removed or departed user immediately loses cloud access;
- every privilege or membership mutation records success, denial, or failure audit evidence.

## Workspace Lifecycle

### Create

Any active authenticated user may create a workspace within quota. One transaction inserts the workspace, Owner membership, idempotency result, and success audit event. The creator becomes the immutable Owner.

### Rename

Owner or Admin may rename an active workspace using the current workspace `revision`. A stale revision returns `409 workspace_conflict`. Rename is unavailable while archived.

### Archive

Only Owner may archive an active workspace. One transaction:

1. locks the workspace;
2. changes status to `archived` and increments revision;
3. marks every pending invitation `revoked`;
4. retains every membership;
5. writes audit events without token values.

Archived workspaces are read-only. Invitation creation, rename, membership, and role mutations are rejected with `409 workspace_archived`.

### Restore

Only Owner may restore an archived workspace. Restore changes status to `active`, clears `archived_at`, increments revision, and records audit. Previously revoked invitations do not become usable again.

## Invitation Lifecycle

### Create

Owner or Admin creates a Member invitation for an active, unfrozen workspace. The service enforces the pending-invitation quota, generates a raw token, persists only its digest, and returns the raw token and a fragment-based deep link exactly once.

### Accept

An authenticated active account submits the raw token and an idempotency key. One transaction locks the invitation and workspace, validates the seven-day deadline, verifies the workspace and its Owner are active, creates or returns the accepting account's Member row, marks the invitation accepted, stores the idempotency result, and writes audit.

Acceptance is globally single-use. A concurrent loser receives the same generic unavailable response. If the accepting account is already a member, the invitation is consumed and the existing membership is returned without changing its role.

### Revoke and Expire

Owner or Admin may revoke a pending invitation. Expiry is enforced at read and acceptance time; a bounded maintenance job may materialize `expired` status for listing and audit. Invalid, expired, revoked, accepted, or unknown tokens return the same `404 invitation_unavailable` result.

## Quotas and Validation

Server configuration controls quotas. V1 defaults are:

- 10 active workspaces owned by one user;
- 100 memberships per workspace, including Owner;
- 20 pending invitations per workspace;
- one invitation valid for exactly seven days;
- workspace display name from 1 through 80 Unicode scalar values after trimming.

Quota conflicts return stable `409` error codes. Quota checks and writes occur under the same transaction lock so concurrent requests cannot exceed the limit.

Archived workspaces do not consume the active-workspace quota. Restore rechecks that quota and remains archived with `409 workspace_limit_reached` if the Owner is already at the limit. Workspace creation and invitation operations are also rate-limited independently of these storage quotas.

## HTTP API

All routes require the existing desktop bearer access token unless stated otherwise.

### Workspace collection

- `GET /api/v1/workspaces` lists active and archived workspace memberships for the actor. The desktop composes the personal option from the existing authenticated personal-space state; the Workspace API does not redefine it.
- `POST /api/v1/workspaces` accepts `{display_name}`, creates a workspace, returns `201`, and requires `Idempotency-Key`.

### Workspace resource

- `PATCH /api/v1/workspaces/{workspace_id}` accepts `{display_name, expected_revision}` and returns the updated workspace summary.
- `POST /api/v1/workspaces/{workspace_id}/archive` accepts `{expected_revision}` and returns the archived workspace summary.
- `POST /api/v1/workspaces/{workspace_id}/restore` accepts `{expected_revision}` and returns the restored workspace summary.

### Memberships

- `GET /api/v1/workspaces/{workspace_id}/members` lists safe member metadata.
- `PATCH /api/v1/workspaces/{workspace_id}/members/{user_id}` accepts `{role: "member"|"admin", expected_revision}` and returns the updated member summary.
- `DELETE /api/v1/workspaces/{workspace_id}/members/{user_id}?expected_revision={revision}` removes an authorized non-Owner target without racing a role change.
- `POST /api/v1/workspaces/{workspace_id}/leave` lets Admin or Member leave.

### Invitations

- `GET /api/v1/workspaces/{workspace_id}/invitations` lists invitation metadata without raw tokens.
- `POST /api/v1/workspaces/{workspace_id}/invitations` accepts an empty object, returns `201` with one raw token/link on the first success, and requires `Idempotency-Key`; an idempotent replay returns `200` without the secret.
- `DELETE /api/v1/workspaces/{workspace_id}/invitations/{invitation_id}` revokes a pending invitation.
- `POST /api/v1/workspace-invitations/accept` accepts `{token}`, returns the workspace and accepting member summaries, and requires `Idempotency-Key`.

Successful delete, revoke, and leave operations return `204`. Collection reads return `200`. JSON bodies reject unknown fields, all mutation body sizes are bounded, and `Idempotency-Key` is treated as an opaque bounded value whose digest, not raw value, is persisted.

### Public response shapes

A workspace summary contains only:

- `id`, `display_name`, `status`, `revision`, and derived `mutation_state` (`writable|archived|owner_unavailable`);
- actor `role`;
- `member_count`;
- `created_at`, `updated_at`, and optional `archived_at`.

A member summary contains only:

- `user_id`, optional `nickname`, `role`, `revision`, `joined_at`.

An invitation summary contains only:

- `id`, `status`, optional `created_by_user_id`, and optional `accepted_by_user_id`;
- `created_at`, `expires_at`, optional `accepted_at`, and optional `revoked_at`.

Only the first invitation-creation response additionally contains the 43-character base64url `token`, fragment-based `invite_url`, and `secret_replayable=false`. A replay contains the same invitation summary and `secret_replayable=false` but omits `token` and `invite_url`. The accept response contains no raw token.

Email addresses, phone numbers, encrypted identity fields, credentials, and authentication token data never appear in Workspace responses.

## Error Semantics

- `400 invalid_request`: malformed identifiers, names, revisions, tokens, or unsupported payload fields.
- `401 session_revoked`: missing, expired, or revoked product authorization.
- `403 workspace_forbidden`: a known member lacks the required role.
- `404 workspace_not_found`: the workspace does not exist or the actor is not a member.
- `404 invitation_unavailable`: invitation token is unknown, expired, revoked, accepted, or otherwise unavailable.
- `409 workspace_conflict`: stale revision or incompatible lifecycle state.
- `409 workspace_archived`: mutation attempted against an archived workspace.
- `409 workspace_owner_unavailable`: a known member attempted a mutation while the fixed Owner account was pending deletion or disabled.
- `409 membership_conflict`: duplicate, protected Owner, or invalid role transition.
- `409 workspace_limit_reached`, `member_limit_reached`, or `invitation_limit_reached`.
- `409 idempotency_conflict`: one key was reused for different canonical input.
- `429 rate_limited`: invitation creation or acceptance rate exceeded.
- `503 service_unavailable`: storage or control-plane dependency unavailable.

Unknown/non-member workspace access uses `404` to avoid resource enumeration. Known members receive `403` for insufficient role so the desktop can present an accurate permission message.

## Audit

The existing `audit_events` table remains the audit sink. Successful security and lifecycle mutations append their sanitized success event in the same transaction. Denied or failed attempts use the existing bounded audit writer outside the rolled-back mutation transaction; a control-plane outage cannot justify logging secrets or falsely recording success. Events include:

- actor user and device from the authenticated principal;
- workspace, membership, or invitation object identifier;
- event type, outcome, stable reason code, request ID, and timestamp;
- role or lifecycle transition metadata when applicable.

Audit metadata excludes raw invitation tokens, token digests, contact identities, request authorization, Hermes paths, and runtime content.

Account finalization clears actor/subject links and object or metadata identifiers that could relink the disabled account or its deleted workspaces, while retaining only anonymous security evidence consistent with the existing deletion policy.

## Desktop Workspace Context

The trusted main process represents the selected product context as one of:

- personal: `kind=personal`, `personal_space_id`, `user_id`;
- workspace: `kind=workspace`, `workspace_id`, `user_id`, and actor role.

This is product-navigation state, not a Hermes Runtime owner binding in V1. It must not be passed to Hermes prompts, Memory, Profile configuration, or environment variables.

The local cache is stored under Electron `userData` in an AgentEra-owned SQLite database. Every row is scoped by authenticated `user_id`; selection is also stored per user. Legacy or unprovable rows remain unavailable rather than being adopted by a later login.

The cache stores only workspace summaries, member/invitation metadata visible to the actor, the last successful refresh time, and the selected workspace ID. It never stores raw invitation tokens.

## Desktop UI

The selected layout is the global top switcher:

- placed immediately below AgentEra branding and above primary navigation;
- personal space is always the first option;
- active joined workspaces show display name, role, offline state, and any `owner_unavailable` read-only state and are selectable;
- archived workspaces remain visible in the management surface for inspection or Owner restore but are not selectable as an active context;
- create and manage actions are available from the menu when online;
- collapsed sidebar shows the selected context icon and accessible tooltip;
- AgentEra account and Hermes Profile controls remain visually separate in the sidebar footer.

The management surface supports workspace create, rename, archive/restore, member list, invite creation/copy/revoke, role promotion/demotion, removal, and leave according to the actor role.

Raw invitation links appear only in the post-create confirmation. Closing that confirmation permanently removes the raw value from renderer state.

## Switching Semantics

Changing selected product space:

- changes Workspace UI and future asset-query context;
- does not change the active Hermes Profile;
- does not move existing chats or files;
- does not rewrite an active RuntimeBinding;
- does not activate a workspace Agent in V1;
- does not read or write Hermes adaptive state.

If a workspace disappears, becomes archived, or no longer contains the actor after online refresh, the desktop falls back to personal space. The fallback updates only AgentEra selection state.

## Offline and Account-Switch Behavior

When the cloud is unavailable but the existing product offline entitlement is valid:

- cached workspace summaries and roles remain visible as stale/read-only metadata;
- the user may inspect cached entries and select a cached workspace only if its last authoritative status was active;
- create, rename, archive, restore, invite, role, removal, and leave commands are disabled;
- local installed Agents, conversations, files, Memory, Skill learning, and Curator continue normally;
- no queued workspace mutation is created.

After reconnect, the client replaces its cache with the authoritative membership list. Removed or archived selection falls back to personal space without deleting local data.

On product account change, the main process clears in-memory Workspace state, resolves the new authenticated user, and opens only that user's cache partition. Renderer state cannot retain member or invitation records from the previous account.

## IPC Boundary

The preload API exposes exact Workspace commands and exact public response serializers. It does not accept arbitrary URLs, headers, bearer tokens, database paths, or generic request bodies.

Every IPC handler:

- validates sender authorization through the existing IPC guard;
- validates UUID, enum, revision, name, and token bounds in the main process;
- calls the trusted Workspace manager;
- returns sanitized stable success or error shapes;
- never logs raw invitation tokens or cloud authorization.

## Testing Strategy

### Cloud unit and integration tests

- migration constraints and rollback-safe forward migration;
- workspace creation plus immutable Owner membership;
- complete Owner/Admin/Member permission matrix;
- fixed Owner and prohibited transfer/removal;
- Owner pending-deletion freeze, recovery unfreeze, finalization cleanup, and audit anonymization;
- rename revision conflict;
- archive/restore and pending invitation revocation;
- invitation token entropy, digest-only storage, expiry, revoke, replay, and concurrent acceptance;
- membership quota and concurrent mutation safety;
- idempotency replay and mismatched-request conflict;
- secret-once invitation creation replay without token reissue;
- same-workspace and cross-workspace authorization isolation;
- sanitized success, denial, and failure audit events;
- HTTP/OpenAPI strict request and response contracts;
- PostgreSQL integration with real transactions.

### Desktop tests

- strict Workspace cloud client contract and no legacy `/api/agents` use;
- owner-scoped cache and account-switch isolation;
- safe IPC allowlist and serializer behavior;
- global switcher rendering, collapsed state, role labels, and fallback;
- role-sensitive management controls;
- offline read-only behavior and no mutation queue;
- raw invitation token exists only in the create-result interaction;
- fragment-only invitation handoff and volatile-memory preservation through sign-in.

### End-to-end scenario

A real local cloud and packaged desktop test uses separate authenticated accounts and isolated Electron/Hermes roots:

1. Owner creates a workspace and invitation.
2. Member accepts and appears in the workspace.
3. Owner promotes Member to Admin.
4. Admin creates an invitation and manages a normal Member.
5. Forbidden role operations return stable errors.
6. Owner archives and restores the workspace.
7. Offline desktop shows cached metadata and disables mutations.
8. Account switching proves local cache isolation.
9. Before and after hashes prove no change to Hermes Memory, USER, sessions, files, credentials, Skill learning, or Curator state caused by Workspace operations.

The Runtime compatibility suite is rerun without modifying `aera-runtime`.

## Delivery Sequence

1. Cloud schema and repository invariants.
2. Cloud service permission matrix, lifecycle, invitations, and audit.
3. Cloud HTTP/OpenAPI contract and real PostgreSQL integration.
4. Desktop pinned contract, trusted client, owner-scoped cache, and safe IPC.
5. Global switcher and management UI.
6. Offline/account-switch behavior.
7. Multi-account E2E plus Hermes boundary proof.
8. Full cloud, desktop, LAT, build, and Runtime compatibility gates.

Each step is committed locally on isolated feature branches. No push, production deployment, or Runtime release is part of this design.

## Next Slice

After Workspace Foundation V1 is merged and verified, Workspace Agent V1 may extend the proven membership boundary with `owner_scope=WORKSPACE`, workspace-owned drafts and immutable versions, Member installation, read-only approved Knowledge/Skill/SOP projections, and new-conversation-only version updates.

That later slice must reuse this authorization service and must not weaken any Hermes private-state boundary defined here.
