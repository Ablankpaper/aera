# AgentEra Workspace Foundation V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the Workspace Foundation V1 vertical slice across `aera-cloud` and the AgentEra desktop: fixed-Owner workspaces, Owner/Admin/Member authorization, single-use invitations, audited lifecycle operations, an account-isolated offline cache, and a global personal/workspace switcher that never changes Hermes runtime state.

**Architecture:** `aera-cloud/internal/workspace` is a new authenticated control-plane domain beside `internal/agentcontrol`; it owns workspace persistence, role enforcement, invitation secrets, idempotency, quotas, rate limits, and audit. `aera/src/main/agentera-workspace` is a separate trusted desktop domain beside `agentera-agent-control`; it owns the strict cloud client, account-partitioned SQLite cache, product-space selection, and exact IPC serializers. The renderer receives only safe workspace summaries. Hermes remains the sole runtime and self-learning engine, and existing USER Agent ownership remains unchanged.

**Tech Stack:** Go 1.26, chi, pgx/PostgreSQL 17, Redis 7, OpenAPI 3.1, Electron 39, TypeScript 5.9, React 19, `better-sqlite3`, Vitest 4, Playwright 1.60, and the existing Hermes Runtime.

## Global Constraints

- The approved design at `docs/superpowers/specs/2026-07-20-agentera-workspace-foundation-v1-design.md` is authoritative.
- Execute this plan in the current main Codex session. Do not dispatch subagents. Use `superpowers:executing-plans`, `superpowers:test-driven-development`, and the verification skill at the applicable execution checkpoints.
- Start both product repositories from their clean local `main` branches: desktop `main` at the implementation-plan commit based on design commit `397696a`, and cloud `main` at `c76d83c`. Create `aera/workspace-foundation-v1` independently in each repository. Do not edit or branch `aera-runtime`.
- Do not push, deploy, publish a Runtime, merge back to `main`, or alter production configuration without a separate user authorization.
- Workspace is a cloud identity, membership, authorization, metadata, and audit boundary. Runtime execution remains local.
- Workspace code must not read, upload, cache, enumerate, or mutate `MEMORY.md`, `USER.md`, conversations, files, credentials, local Profile paths, Curator state, unpublished Skills, or any Hermes adaptive state.
- Selecting a product space must not create, clone, select, rename, move, or delete a Hermes Profile. It must not mutate an active session or RuntimeBinding.
- `internal/agentcontrol` and `src/main/agentera-agent-control` remain USER-only. This slice must not add `owner_scope=WORKSPACE`, workspace Agent publication, shared assets, ExperienceCandidate, organizations, or official Agents.
- Every successful security or lifecycle mutation writes sanitized audit evidence in the same PostgreSQL transaction. Denied and failed attempts use the bounded audit recorder and never include invitation tokens.
- The raw invitation token is exactly 32 random bytes encoded as 43-character unpadded base64url. Only its SHA-256 digest is persisted. A first creation response may expose the token and fragment link once; replays and list responses never do.
- Required idempotency retention is 24 hours. Required invitation lifetime is exactly seven days.
- Default quotas are 10 active workspaces per Owner, 100 members per workspace including Owner, and 20 pending invitations per workspace.
- Default rate limits are configurable and fail closed: 10 workspace creations per actor per hour, 20 invitation creations per actor/workspace per hour, and 30 invitation acceptance attempts per actor/device per ten minutes. Redis keys contain SHA-256 scope digests, never raw invitation tokens or IP addresses.
- Request actors always come from validated access claims. No Workspace request accepts an actor, tenant, personal-space, or owner tuple from JSON.
- Every task begins with a failing focused test, makes the smallest production change, reruns the focused test, runs the stated regression gate, and creates only the stated local commit.
- Preserve all unrelated local state. Before each commit run `git diff --check` and inspect `git status --short`.
- When behavior, architecture, or test coverage changes in the desktop repository, update `lat.md/agentera-workspaces.md` and run `npx --yes lat.md check`.

## Repository and Branch Map

| Responsibility                                      | Repository                                   | Starting branch and commit                                                  | Implementation branch          |
| --------------------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------ |
| Workspace cloud control plane and account lifecycle | `/Users/zizimutou/Desktop/aera/aera-cloud`   | clean local `main` at `c76d83c`, 20 commits ahead of `origin/main`          | `aera/workspace-foundation-v1` |
| Desktop cache, IPC, switcher, and management UI     | `/Users/zizimutou/Desktop/aera/aera`         | clean local `main` after this plan commit, based on design commit `397696a` | `aera/workspace-foundation-v1` |
| Hermes execution and self-learning                  | `/Users/zizimutou/Desktop/aera/aera-runtime` | clean `main` at `c0439e1e3e`, equal to `origin/main`                        | no branch and no edit          |

Create the two feature branches only when Task 1 starts:

```bash
git -C /Users/zizimutou/Desktop/aera/aera-cloud switch -c aera/workspace-foundation-v1
git -C /Users/zizimutou/Desktop/aera/aera switch -c aera/workspace-foundation-v1
```

Expected: each command reports a new branch from the stated local `main`; neither command fetches, pushes, or changes the Runtime repository.

## Planned File Structure

### Cloud domain

```text
aera-cloud/
  migrations/000009_workspace_foundation.sql       # tables, checks, indexes, deferred Owner invariant
  internal/workspace/
    model.go                                        # strict domain values, errors, DTOs, commands
    model_test.go
    token.go                                        # raw-token generation and SHA-256 digesting
    token_test.go
    limiter.go                                      # Redis-backed creation/acceptance limits
    limiter_test.go
    repository.go                                   # transactional lifecycle, membership, invitation operations
    repository_test.go
    service.go                                      # role matrix, quotas, mutation orchestration
    service_test.go
    http.go                                         # bearer-authenticated strict JSON routes
    http_test.go
```

Existing cloud files changed by the slice:

```text
internal/config/config.go
internal/config/config_test.go
internal/store/migrate_test.go
internal/audit/service.go
internal/audit/service_test.go
internal/account/model.go
internal/account/repository.go
internal/account/repository_test.go
internal/account/lifecycle_repository.go
internal/account/lifecycle_repository_test.go
internal/account/http.go
internal/account/http_test.go
internal/jobs/postgres.go
internal/jobs/postgres_test.go
internal/httpapi/server.go
internal/httpapi/server_test.go
cmd/aera-cloud/main.go
cmd/aera-cloud/main_test.go
api/openapi.yaml
api/openapi_test.go
.env.example
web/src/api/client.ts
web/src/pages/DeleteAccountPage.tsx
web/src/pages/DeleteAccountPage.test.tsx
web/src/i18n/en.ts
web/src/i18n/zh-CN.ts
web/tests/account-center.spec.ts
```

### Desktop domain

```text
aera/
  src/shared/agentera-workspace.ts                  # renderer-safe public contract
  src/main/agentera-workspace/
    client.ts                                       # strict generated-contract HTTP client
    client.test.ts
    db.ts                                           # isolated userData/agentera-workspace/workspace.db
    deep-link.ts                                    # exact custom-protocol parser and volatile inbox
    deep-link.test.ts
    manager.ts                                      # cache refresh, account partition, selected product space
    manager.test.ts
    ipc-contract.ts                                 # exact request validation and safe result envelope
  src/renderer/src/screens/Layout/
    WorkspaceSwitcher.tsx                          # global switcher below brand
    WorkspaceSwitcher.test.tsx
    WorkspaceManagementDialog.tsx                  # lifecycle, roles, invitations
    WorkspaceManagementDialog.test.tsx
  src/renderer/src/components/
    WorkspaceInvitationGate.tsx                    # volatile sign-in-to-accept handoff
    WorkspaceInvitationGate.test.tsx
  src/shared/i18n/locales/workspace.ts              # English, Simplified Chinese, Traditional Chinese text
  tests/agentera-workspace-db.test.ts
  tests/agentera-workspace-ipc.test.ts
  tests/agentera-workspace-boundary.test.ts
  tests/e2e/agentera-workspace.e2e.ts
```

Existing desktop files changed by the slice:

```text
contracts/agentera-cloud.openapi.yaml
src/shared/agentera-cloud-api.generated.ts
scripts/check-agentera-cloud-contract.mjs
tests/agentera-cloud-contract.test.ts
src/main/app/start.ts
src/main/index.ts
src/main/ipc/register.ts
src/main/ipc/auth-guard.ts
src/preload/index.ts
src/preload/index.d.ts
src/renderer/src/App.tsx
src/renderer/src/App.test.tsx
src/renderer/src/screens/Layout/Layout.tsx
src/renderer/src/assets/main.css
src/shared/i18n/locales/{en,ar,es,he,id,ja,pl,pt-BR,pt-PT,tr,zh-CN,zh-TW}/navigation.ts
package.json
electron-builder.yml
lat.md/agentera-workspaces.md
```

## Locked Cloud API Surface

```text
GET    /api/v1/workspaces
POST   /api/v1/workspaces
PATCH  /api/v1/workspaces/{workspace_id}
POST   /api/v1/workspaces/{workspace_id}/archive
POST   /api/v1/workspaces/{workspace_id}/restore
GET    /api/v1/workspaces/{workspace_id}/members
PATCH  /api/v1/workspaces/{workspace_id}/members/{user_id}
DELETE /api/v1/workspaces/{workspace_id}/members/{user_id}?expected_revision={revision}
POST   /api/v1/workspaces/{workspace_id}/leave
GET    /api/v1/workspaces/{workspace_id}/invitations
POST   /api/v1/workspaces/{workspace_id}/invitations
DELETE /api/v1/workspaces/{workspace_id}/invitations/{invitation_id}
POST   /api/v1/workspace-invitations/accept
```

`POST /api/v1/workspaces`, `POST /api/v1/workspaces/{workspace_id}/invitations`, and `POST /api/v1/workspace-invitations/accept` require `Idempotency-Key`. The personal-space option is composed from existing authentication state and is never returned by these routes.

## Task 1: Add Workspace Persistence, Database Invariants, and Configuration

**Repository:** `/Users/zizimutou/Desktop/aera/aera-cloud`

**Files:**

- Create: `migrations/000009_workspace_foundation.sql`
- Modify: `internal/store/migrate_test.go`
- Modify: `internal/config/config.go`
- Modify: `internal/config/config_test.go`
- Modify: `.env.example`

**Interfaces and invariants:**

```sql
CREATE TABLE workspaces (
    id UUID PRIMARY KEY,
    owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    display_name TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
    revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    archived_at TIMESTAMPTZ,
    CHECK ((status = 'active' AND archived_at IS NULL) OR
           (status = 'archived' AND archived_at IS NOT NULL))
);

CREATE TABLE workspace_memberships (
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
    revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
    joined_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (workspace_id, user_id)
);
```

The same migration creates `workspace_invitations` and `workspace_idempotency_records` with the exact fields and checks from the approved design. It also creates:

- a partial unique index for one Owner membership per workspace;
- an immutable `owner_user_id` trigger;
- deferred constraint triggers on both `workspaces` and `workspace_memberships` that require exactly one matching Owner at commit;
- lookup indexes for member listing, pending invitations, owned active quota, token digest, and idempotency expiry;
- invitation state checks requiring exactly seven-day expiry and consistent acceptance/revocation timestamps;
- an invitation lifecycle trigger permitting only `pending` to `accepted|revoked|expired` and rejecting every transition from a terminal state;
- 32-byte checks for token, key, and request digests.

The configuration additions are exact:

```go
WorkspaceActiveOwnedLimit       int
WorkspaceMemberLimit            int
WorkspacePendingInviteLimit     int
WorkspaceCreateRateLimit        int64
WorkspaceCreateRateWindow       time.Duration
WorkspaceInviteRateLimit        int64
WorkspaceInviteRateWindow       time.Duration
WorkspaceAcceptRateLimit        int64
WorkspaceAcceptRateWindow       time.Duration
```

with `.env.example` values:

```text
AGENTERA_CLOUD_WORKSPACE_ACTIVE_OWNED_LIMIT=10
AGENTERA_CLOUD_WORKSPACE_MEMBER_LIMIT=100
AGENTERA_CLOUD_WORKSPACE_PENDING_INVITE_LIMIT=20
AGENTERA_CLOUD_WORKSPACE_CREATE_RATE_LIMIT=10
AGENTERA_CLOUD_WORKSPACE_CREATE_RATE_WINDOW=1h
AGENTERA_CLOUD_WORKSPACE_INVITE_RATE_LIMIT=20
AGENTERA_CLOUD_WORKSPACE_INVITE_RATE_WINDOW=1h
AGENTERA_CLOUD_WORKSPACE_ACCEPT_RATE_LIMIT=30
AGENTERA_CLOUD_WORKSPACE_ACCEPT_RATE_WINDOW=10m
```

**Steps:**

- [ ] Create both feature branches using the commands in the repository map. Confirm both worktrees are clean before editing.

- [ ] Extend `TestApplyMigrationsCreatesAuthSchemaAndIsIdempotent` to expect nine applied migrations and assert all four tables, exact columns, check constraints, indexes, foreign-key actions, and both deferred Owner-invariant triggers. Add an integration test that attempts to commit a workspace with no Owner membership and a workspace with a mismatched Owner; both commits must fail.

- [ ] Extend config tests for all nine exact environment variables, zero/negative rejection, invalid durations, and the expected typed values.

- [ ] Run the red tests:

  ```bash
  cd /Users/zizimutou/Desktop/aera/aera-cloud
  docker compose up -d postgres redis
  set -a
  source .env.example
  set +a
  AERA_INTEGRATION_TESTS=1 go test -p 1 -count=1 ./internal/store ./internal/config
  ```

  Expected: FAIL because migration 9 and Workspace config fields do not exist.

- [ ] Implement the forward-only migration and strict configuration parsing. Validate names in Go later; the database still rejects empty/whitespace-only values, control characters, and values above 80 characters so direct writes cannot bypass the boundary.

- [ ] Rerun the focused command. Expected: PASS with migration count 9 and deferred constraints enforced at commit.

- [ ] Run `go test -count=1 ./internal/config ./internal/store` and `git diff --check`. Expected: unit tests PASS; integration-only cases may skip unless `AERA_INTEGRATION_TESTS=1` remains set.

- [ ] Commit:

  ```bash
  git add migrations/000009_workspace_foundation.sql internal/store/migrate_test.go internal/config/config.go internal/config/config_test.go .env.example
  git commit -m "feat: add workspace persistence invariants"
  ```

## Task 2: Define Strict Workspace Values, Invitation Secrets, and Redis Limits

**Repository:** `/Users/zizimutou/Desktop/aera/aera-cloud`

**Files:**

- Create: `internal/workspace/model.go`
- Create: `internal/workspace/model_test.go`
- Create: `internal/workspace/token.go`
- Create: `internal/workspace/token_test.go`
- Create: `internal/workspace/limiter.go`
- Create: `internal/workspace/limiter_test.go`

**Interfaces:**

```go
type Role string
const (
    RoleOwner  Role = "owner"
    RoleAdmin  Role = "admin"
    RoleMember Role = "member"
)

type WorkspaceStatus string
type MutationState string

type Actor struct {
    UserID   uuid.UUID
    DeviceID uuid.UUID
}

type Workspace struct {
    ID            uuid.UUID
    DisplayName   string
    Status        WorkspaceStatus
    Revision      int64
    MutationState MutationState
    ActorRole     Role
    MemberCount   int
    CreatedAt     time.Time
    UpdatedAt     time.Time
    ArchivedAt    *time.Time
}

type InvitationSecret struct {
    RawToken string
    Digest   [32]byte
}

type LimitAction string
const (
    LimitWorkspaceCreate LimitAction = "workspace_create"
    LimitInvitationCreate LimitAction = "invitation_create"
    LimitInvitationAccept LimitAction = "invitation_accept"
)

type Limiter interface {
    Allow(context.Context, LimitAction, Actor, *uuid.UUID) (time.Duration, error)
}
```

Public stable errors are declared once in `model.go`, including `ErrInvalidRequest`, `ErrSessionRevoked`, `ErrWorkspaceForbidden`, `ErrWorkspaceNotFound`, `ErrInvitationUnavailable`, `ErrWorkspaceConflict`, `ErrWorkspaceArchived`, `ErrWorkspaceOwnerUnavailable`, `ErrMembershipConflict`, all three quota errors, `ErrIdempotencyConflict`, `ErrRateLimited`, and `ErrServiceUnavailable`. HTTP maps `ErrWorkspaceOwnerUnavailable` to exact code `workspace_owner_unavailable`.

**Steps:**

- [ ] Write table-driven model tests for Unicode trimming, 1 and 80 scalar boundaries, 81 scalars, NUL/newline/control characters, invalid roles, invalid positive revisions, nil UUIDs, and UTC timestamp normalization.

- [ ] Write token tests that inject deterministic entropy, require exactly 32 read bytes, assert a 43-character base64url value, verify `SHA-256(raw token)`, and prove logs/struct formatting do not expose the raw token. Reject truncated, padded, non-base64url, and decoded-length-not-32 tokens.

- [ ] Write Redis integration tests that prove each action has an independent counter/window, all counters fail closed when Redis is unavailable, and every Redis key contains only the prefix plus a 64-character lowercase SHA-256 scope digest. Search all Redis keys and assert no raw token, user UUID, device UUID, workspace UUID, or IP literal appears.

- [ ] Run:

  ```bash
  cd /Users/zizimutou/Desktop/aera/aera-cloud
  go test -count=1 ./internal/workspace
  AERA_INTEGRATION_TESTS=1 go test -count=1 ./internal/workspace -run TestRedisWorkspaceLimiter
  ```

  Expected: FAIL because the package does not exist.

- [ ] Implement strict values with `utf8.RuneCountInString`, `unicode.IsControl`, and defensive copies. Implement token generation with `crypto/rand.Reader`, `base64.RawURLEncoding`, and `sha256.Sum256`.

- [ ] Implement one atomic Redis increment/expiry script. Derive the scope bytes as domain-separated action, actor ID, device ID, and optional workspace ID; hash the scope before building the Redis key. Never include an invitation token in the limiter scope.

- [ ] Rerun focused tests, then `go test -count=1 ./internal/workspace ./internal/config` and `git diff --check`. Expected: PASS.

- [ ] Commit:

  ```bash
  git add internal/workspace/model.go internal/workspace/model_test.go internal/workspace/token.go internal/workspace/token_test.go internal/workspace/limiter.go internal/workspace/limiter_test.go
  git commit -m "feat: define secure workspace domain values"
  ```

## Task 3: Implement Transactional Workspace Lifecycle and Audit

**Repository:** `/Users/zizimutou/Desktop/aera/aera-cloud`

**Files:**

- Create: `internal/workspace/repository.go`
- Create: `internal/workspace/repository_test.go`
- Modify: `internal/audit/service.go`
- Modify: `internal/audit/service_test.go`

**Repository surface:**

```go
type Repository interface {
    Create(context.Context, Actor, CreateCommand) (Workspace, IdempotencyReplay, error)
    List(context.Context, Actor) ([]Workspace, error)
    Rename(context.Context, Actor, RenameCommand) (Workspace, error)
    Archive(context.Context, Actor, RevisionCommand) (Workspace, error)
    Restore(context.Context, Actor, RevisionCommand) (Workspace, error)
    ListMembers(context.Context, Actor, uuid.UUID) ([]Member, error)
    ChangeMemberRole(context.Context, Actor, ChangeRoleCommand) (Member, error)
    RemoveMember(context.Context, Actor, RemoveMemberCommand) error
    Leave(context.Context, Actor, uuid.UUID) error
    ListInvitations(context.Context, Actor, uuid.UUID) ([]Invitation, error)
    CreateInvitation(context.Context, Actor, CreateInvitationCommand) (InvitationCreation, IdempotencyReplay, error)
    RevokeInvitation(context.Context, Actor, RevokeInvitationCommand) error
    AcceptInvitation(context.Context, Actor, AcceptInvitationCommand) (Acceptance, error)
}
```

`IdempotencyReplay` is exactly `fresh|replayed`. `CreateInvitation` returns a raw secret only for `fresh`; the repository never persists it. All transaction methods accept already-validated domain commands and still re-check authoritative account/workspace state under lock.

Workspace audit metadata permits only these keys:

```text
workspace_id
membership_user_id
invitation_id
role
previous_role
```

UUID fields must parse as UUIDs. `role` and `previous_role` accept only `owner|admin|member`. Workspace event types must begin `workspace_`. No name, nickname, token, digest, idempotency key, URL, email, phone, path, or request body is allowed in metadata.

**Steps:**

- [ ] Extend audit tests first for valid workspace metadata and rejections of raw tokens, URLs, emails, paths, display names, unknown keys, oversized values, and workspace metadata on non-workspace events.

- [ ] Add repository integration tests for atomic create plus Owner membership plus success audit; exact idempotent replay; conflicting idempotency body; actor membership listing; rename revision conflicts; archive revoking pending invitations; restore quota checks; missing/mismatched Owner corruption; pending-deletion Owner freeze; non-member 404 isolation; and same-transaction rollback when audit insertion fails.

- [ ] Run:

  ```bash
  cd /Users/zizimutou/Desktop/aera/aera-cloud
  AERA_INTEGRATION_TESTS=1 go test -p 1 -count=1 ./internal/audit ./internal/workspace -run 'Test(PostgresRecorder.*Workspace|WorkspaceRepository.*Lifecycle)'
  ```

  Expected: FAIL because Workspace audit metadata and the repository are missing.

- [ ] Extend `audit.validMetadata` with a separate workspace allowlist. Keep the existing USER Agent allowlist and semantics byte-for-byte compatible.

- [ ] Implement lifecycle transactions with row locks and `audit.NewRecorder(tx)` for success evidence. Create inserts workspace, Owner membership, 24-hour idempotency record, and `workspace_created` audit before commit. Rename, archive, and restore require exact positive `expected_revision`; archive atomically revokes every pending invitation; restore rechecks active-owned quota.

- [ ] Compute `mutation_state` from workspace status plus fixed Owner account status. A missing matching Owner membership is treated as unavailable/corrupt and never returned as writable.

- [ ] Implement safe PostgreSQL error mapping inside the repository. Do not return SQL strings, constraint names, token digests, or raw driver errors to HTTP callers.

- [ ] Rerun focused tests. Then run `go test -count=1 ./internal/audit ./internal/workspace` and `git diff --check`. Expected: PASS.

- [ ] Commit:

  ```bash
  git add internal/audit/service.go internal/audit/service_test.go internal/workspace/repository.go internal/workspace/repository_test.go
  git commit -m "feat: persist audited workspace lifecycle"
  ```

## Task 4: Enforce Roles, Memberships, Quotas, and One-Time Invitations

**Repository:** `/Users/zizimutou/Desktop/aera/aera-cloud`

**Files:**

- Create: `internal/workspace/service.go`
- Create: `internal/workspace/service_test.go`
- Modify: `internal/workspace/repository.go`
- Modify: `internal/workspace/repository_test.go`

**Authorization matrix:**

```go
var permissions = map[Operation]map[Role]bool{
    OperationRead:             {RoleOwner: true, RoleAdmin: true, RoleMember: true},
    OperationRename:           {RoleOwner: true, RoleAdmin: true},
    OperationInvite:           {RoleOwner: true, RoleAdmin: true},
    OperationRemoveMember:     {RoleOwner: true, RoleAdmin: true},
    OperationManageAdmin:      {RoleOwner: true},
    OperationArchiveRestore:   {RoleOwner: true},
    OperationLeave:            {RoleAdmin: true, RoleMember: true},
}
```

The service applies target-sensitive rules after this coarse matrix: Admin may remove only Member; Owner may promote Member, demote Admin, and remove Admin/Member; nobody may change/remove the Owner; Owner cannot leave.

**Steps:**

- [ ] Write service tests for every actor/target combination, archived and Owner-unavailable workspaces, stale member revisions, duplicate membership, quota boundaries under concurrency, and limiter denial/unavailability. Assert denied operations call the audit recorder with `denied` but never call a mutation method.

- [ ] Add repository integration tests for 100th/101st member races, 20th/21st pending invitation races, Member-to-Admin promotion, Admin-to-Member demotion, Admin attempting to manage Admin, voluntary leave, removed access, and concurrent invitation acceptance with one winner.

- [ ] Add invitation tests for exact seven-day expiry, generic `invitation_unavailable` across unknown/expired/revoked/accepted tokens, existing-member acceptance that consumes the invite without changing the role, and acceptance replay lookup before token availability.

- [ ] Run:

  ```bash
  cd /Users/zizimutou/Desktop/aera/aera-cloud
  go test -count=1 ./internal/workspace -run 'TestWorkspaceService'
  AERA_INTEGRATION_TESTS=1 go test -p 1 -count=1 ./internal/workspace -run 'TestWorkspaceRepository.*(Member|Invitation|Quota)'
  ```

  Expected: FAIL because service orchestration and complete member/invitation transactions do not exist.

- [ ] Implement `Service` with repository, limiter, clock, random reader, quota configuration, and an out-of-transaction bounded audit recorder for denial/failure evidence. Apply the Redis limiter before storage mutation and fail closed as `service_unavailable` on Redis errors.

- [ ] Canonical idempotency request digests exactly as:

  ```text
  sha256("workspace-create-v1" || NUL || UTF8(command.DisplayName))
  sha256("workspace-invitation-create-v1" || NUL || workspaceID[:])
  sha256("workspace-invitation-accept-v1" || NUL || UTF8(rawToken))
  ```

  Persist only SHA-256 digests of the opaque idempotency key and canonical input. First invitation creation returns token/link; same-key replay returns the same safe summary with `secret_replayable=false` and no secret.

- [ ] Construct the invite URL exactly as `agentera://workspace-invitation#` plus the 43-character raw token. The token is in the fragment, never the authority, path, or query. The desktop custom-protocol parser in Task 11 is the only consumer. Never log the URL.

- [ ] Rerun focused tests, then `go test -count=1 ./internal/workspace ./internal/audit` and `git diff --check`. Expected: PASS.

- [ ] Commit:

  ```bash
  git add internal/workspace/service.go internal/workspace/service_test.go internal/workspace/repository.go internal/workspace/repository_test.go
  git commit -m "feat: enforce workspace roles and invitations"
  ```

## Task 5: Expose the Authenticated Workspace HTTP API

**Repository:** `/Users/zizimutou/Desktop/aera/aera-cloud`

**Files:**

- Create: `internal/workspace/http.go`
- Create: `internal/workspace/http_test.go`
- Modify: `internal/httpapi/server.go`
- Modify: `internal/httpapi/server_test.go`
- Modify: `cmd/aera-cloud/main.go`
- Modify: `cmd/aera-cloud/main_test.go`

**HTTP contract rules:**

```go
const (
    maxWorkspaceBodyBytes = 16 * 1024
    maxIdempotencyKeyBytes = 128
)
```

Every JSON decoder uses `DisallowUnknownFields`, requires one JSON value followed by EOF, and applies the byte limit before decoding. `Idempotency-Key` is trimmed only to validate non-empty boundaries; its exact opaque bytes are hashed. IDs must be canonical UUID strings. Delete-member parses one positive `expected_revision` query value and rejects duplicates.

**Steps:**

- [ ] Write handler tests for all 13 routes, status codes, exact JSON shapes, bearer-derived actors, unknown fields, oversized bodies, malformed UUIDs, missing/oversized idempotency keys, stale revisions, non-member 404 behavior, role 403 behavior, conflicts, 429 `Retry-After`, and 503. Assert error envelopes contain only stable code and request ID.

- [ ] Extend router tests to prove `/api/v1/workspaces`, nested workspace routes, and `/api/v1/workspace-invitations/accept` reach only the Workspace handler; health/auth/Agent routes remain unchanged.

- [ ] Add `buildWorkspaceHandler` wiring tests proving the existing access authenticator, PostgreSQL pool, Redis client, product origin, quotas, clock, and random source are supplied once. The handler must fail closed when a dependency cannot be constructed.

- [ ] Run:

  ```bash
  cd /Users/zizimutou/Desktop/aera/aera-cloud
  go test -count=1 ./internal/workspace ./internal/httpapi ./cmd/aera-cloud -run 'Test(WorkspaceHTTP|Router.*Workspace|BuildWorkspace)'
  ```

  Expected: FAIL because handlers and router wiring do not exist.

- [ ] Implement all locked routes. Map domain errors to the exact public codes and statuses from the design. Return `201` only for fresh workspace/invitation creation, `200` for creation replay, normal reads, rename/archive/restore/accept, and `204` for leave/remove/revoke.

- [ ] In `cmd/aera-cloud/main.go`, construct one Workspace repository, Redis limiter, service, and handler. Add `Workspace http.Handler` to `httpapi.Dependencies` and mount only the locked paths.

- [ ] Rerun focused tests, then `go test -count=1 ./internal/workspace ./internal/httpapi ./cmd/aera-cloud` and `git diff --check`. Expected: PASS.

- [ ] Commit:

  ```bash
  git add internal/workspace/http.go internal/workspace/http_test.go internal/httpapi/server.go internal/httpapi/server_test.go cmd/aera-cloud/main.go cmd/aera-cloud/main_test.go
  git commit -m "feat: expose workspace control API"
  ```

## Task 6: Integrate Account Deletion and Bounded Maintenance

**Repository:** `/Users/zizimutou/Desktop/aera/aera-cloud`

**Files:**

- Modify: `internal/account/model.go`
- Modify: `internal/account/repository.go`
- Modify: `internal/account/repository_test.go`
- Modify: `internal/account/lifecycle_repository.go`
- Modify: `internal/account/lifecycle_repository_test.go`
- Modify: `internal/account/http.go`
- Modify: `internal/account/http_test.go`
- Modify: `internal/jobs/postgres.go`
- Create: `internal/jobs/postgres_test.go`
- Modify: `web/src/api/client.ts`
- Modify: `web/src/pages/DeleteAccountPage.tsx`
- Create: `web/src/pages/DeleteAccountPage.test.tsx`
- Modify: `web/src/i18n/en.ts`
- Modify: `web/src/i18n/zh-CN.ts`
- Modify: `web/tests/account-center.spec.ts`

**Account response addition:**

```go
type Profile struct {
    UserID                   uuid.UUID             `json:"user_id"`
    PersonalSpaceID          uuid.UUID             `json:"personal_space_id"`
    Nickname                 string                `json:"nickname,omitempty"`
    Status                   string                `json:"status"`
    IdentityKinds            []secure.IdentityKind `json:"identity_kinds"`
    OwnedWorkspaceCount      int                    `json:"owned_workspace_count"`
}
```

`GET /api/v1/accounts/me` supplies the count used by the deletion confirmation. `POST /api/v1/accounts/deletion` remains `204` and keeps its existing session-revocation behavior. While the Owner user status is `pending_deletion`, owned workspace reads remain available and every mutation maps to `workspace_owner_unavailable`.

**Steps:**

- [ ] Add account repository/HTTP tests proving active and archived owned workspaces are both counted, ordinary memberships are not counted, and the profile contains no workspace names or member data.

- [ ] Add lifecycle integration tests for the seven-day freeze and finalization order. Before finalization, every owned workspace read remains available and mutation state is `owner_unavailable`. At finalization, owned workspaces cascade away, non-Owner memberships/idempotency rows for the user are deleted, invitation creator/acceptor references are nulled, retained audit rows are anonymized, and unrelated workspaces/members remain intact.

- [ ] Add maintenance tests that atomically materialize due pending invitations as `expired` and delete only idempotency rows whose `expires_at <= now`; prove a bounded pass does not touch valid invitations or Hermes/local state.

- [ ] Add web unit and Playwright tests that load `/api/v1/accounts/me`, display the exact owned count beside the final confirmation, keep the Hermes-local-data warning, and still send the existing verified deletion request only after the user checks the confirmation.

- [ ] Run the red tests:

  ```bash
  cd /Users/zizimutou/Desktop/aera/aera-cloud
  AERA_INTEGRATION_TESTS=1 go test -p 1 -count=1 ./internal/account ./internal/jobs
  cd /Users/zizimutou/Desktop/aera/aera-cloud/web
  npm test -- --run src/pages/DeleteAccountPage.test.tsx
  npx playwright test tests/account-center.spec.ts
  ```

  Expected: FAIL because account profiles do not count workspaces and cleanup/UI integration is absent.

- [ ] Implement the profile count as one bounded aggregate query. In `FinalizeDeletion`, lock the user, collect owned workspace IDs, anonymize relevant audit links, null invitation actor references, delete non-owner membership/idempotency rows, delete owned workspaces, then continue existing Agent/auth deletion and disable the user. Do not depend on deleting the user row.

- [ ] Extend the existing maintenance transaction with expiration and idempotency cleanup. Keep the Redis lease and account-finalization loop unchanged.

- [ ] Update the account-center client type and deletion page. The count is presentation-only and must not be included in the deletion request body.

- [ ] Rerun focused tests. Then run `go test -count=1 ./internal/account ./internal/jobs`, `npm test -- --run`, `npm run typecheck`, and `git diff --check`. Expected: PASS.

- [ ] Commit cloud and embedded web changes together because they form one account-lifecycle contract:

  ```bash
  git add internal/account internal/jobs web/src/api/client.ts web/src/pages/DeleteAccountPage.tsx web/src/pages/DeleteAccountPage.test.tsx web/src/i18n/en.ts web/src/i18n/zh-CN.ts web/tests/account-center.spec.ts
  git commit -m "feat: integrate workspaces with account lifecycle"
  ```

## Task 7: Publish OpenAPI 0.3.0 and Pin the Desktop Contract

**Repositories:** `/Users/zizimutou/Desktop/aera/aera-cloud` and `/Users/zizimutou/Desktop/aera/aera`

**Cloud files:**

- Modify: `api/openapi.yaml`
- Modify: `api/openapi_test.go`

**Desktop files:**

- Modify: `contracts/agentera-cloud.openapi.yaml`
- Regenerate: `src/shared/agentera-cloud-api.generated.ts`
- Modify: `scripts/check-agentera-cloud-contract.mjs`
- Modify: `tests/agentera-cloud-contract.test.ts`

**Required schemas:**

```text
WorkspaceSummary
WorkspaceMember
WorkspaceInvitation
WorkspaceInvitationCreation
WorkspaceInvitationAcceptance
WorkspaceListResponse
WorkspaceMemberListResponse
WorkspaceInvitationListResponse
CreateWorkspaceRequest
RenameWorkspaceRequest
WorkspaceRevisionRequest
ChangeWorkspaceMemberRoleRequest
AcceptWorkspaceInvitationRequest
```

All object schemas set `additionalProperties: false`. `WorkspaceInvitationCreation.token` is length 43 with a base64url pattern; `invite_url` matches `^agentera://workspace-invitation#[A-Za-z0-9_-]{43}$` and is present only on the first `201`. Identity values and local/private Hermes fields are absent.

**Steps:**

- [ ] Extend the cloud OpenAPI test first to require version `0.3.0`, every locked Workspace route/schema/error code, `Idempotency-Key`, exact role/status/mutation enums, `owned_workspace_count`, and explicit absence of `owner_scope`, `MEMORY`, `USER`, `profile_path`, `session`, `credential`, `api_key`, and `raw_token` persistence fields.

- [ ] Extend the desktop contract checker/tests first with the same paths, schemas, and stable error enum. Keep token/auth and Agent schemas exact; the checker must still reject a cloud `AgentDraft`.

- [ ] Run:

  ```bash
  cd /Users/zizimutou/Desktop/aera/aera-cloud
  go test -count=1 ./api
  cd /Users/zizimutou/Desktop/aera/aera
  npm run check:agentera-cloud-contract
  npx vitest run tests/agentera-cloud-contract.test.ts
  ```

  Expected: FAIL because OpenAPI remains 0.2.0 and Workspace paths are absent.

- [ ] Update cloud OpenAPI to 0.3.0 with the exact routes, response statuses, request bounds, schemas, and stable codes. Add `owned_workspace_count` to the existing account profile schema.

- [ ] Copy the reviewed cloud file byte-for-byte into `contracts/agentera-cloud.openapi.yaml`, then regenerate:

  ```bash
  cp /Users/zizimutou/Desktop/aera/aera-cloud/api/openapi.yaml /Users/zizimutou/Desktop/aera/aera/contracts/agentera-cloud.openapi.yaml
  cd /Users/zizimutou/Desktop/aera/aera
  npm run generate:agentera-cloud
  ```

- [ ] Rerun both contract commands. Expected: PASS with identical SHA-256 values and deterministic generated TypeScript.

- [ ] Commit the cloud contract:

  ```bash
  cd /Users/zizimutou/Desktop/aera/aera-cloud
  git add api/openapi.yaml api/openapi_test.go
  git commit -m "docs: publish Workspace API contract"
  ```

- [ ] Commit the desktop pin separately:

  ```bash
  cd /Users/zizimutou/Desktop/aera/aera
  git add contracts/agentera-cloud.openapi.yaml src/shared/agentera-cloud-api.generated.ts scripts/check-agentera-cloud-contract.mjs tests/agentera-cloud-contract.test.ts
  git commit -m "chore: pin Workspace cloud contract"
  ```

## Task 8: Build the Strict Desktop Workspace Client and Public Contract

**Repository:** `/Users/zizimutou/Desktop/aera/aera`

**Files:**

- Create: `src/shared/agentera-workspace.ts`
- Create: `src/main/agentera-workspace/client.ts`
- Create: `src/main/agentera-workspace/client.test.ts`

**Public desktop types:**

```ts
export type WorkspaceRole = "owner" | "admin" | "member";
export type WorkspaceStatus = "active" | "archived";
export type WorkspaceMutationState =
  | "writable"
  | "archived"
  | "owner_unavailable";

export type AgenteraSpaceContext =
  | { kind: "personal"; userId: string; personalSpaceId: string }
  | {
      kind: "workspace";
      userId: string;
      workspaceId: string;
      role: WorkspaceRole;
    };

export interface WorkspacePublicState {
  access: "online" | "offline";
  cloudAvailable: boolean;
  stale: boolean;
  selected: AgenteraSpaceContext;
  workspaces: readonly WorkspaceSummary[];
}
```

`WorkspaceSummary`, `WorkspaceMember`, and `WorkspaceInvitation` are renderer-safe camel-case copies of generated cloud schemas. The secret creation result is a separate type whose `token` and `inviteUrl` are optional and cannot be part of `WorkspacePublicState`.

**Steps:**

- [ ] Write client tests for each route using a fake `fetch`: exact method/path/query/body/headers, 15-second timeout, 256 KiB response limit, bearer retrieval at request time, 401/403/404/409/429/503 mapping, missing token, unknown JSON fields, invalid UUID/timestamp/role/status, duplicate response fields, oversized responses, and aborted requests.

- [ ] Write strict parser tests proving list/create replay never accepts token fields, first invitation creation requires both token and fragment URL, acceptance never returns a token, and no response accepts email/phone/path/Memory/Profile/session fields.

- [ ] Run:

  ```bash
  cd /Users/zizimutou/Desktop/aera/aera
  npx vitest run src/main/agentera-workspace/client.test.ts
  ```

  Expected: FAIL because the shared contract and client do not exist.

- [ ] Implement aliases from `components["schemas"]` for every raw server type, then copy through exact runtime validators into renderer-safe types. Do not cast unvalidated JSON and do not expose generated snake-case objects directly to the renderer.

- [ ] Implement all 13 methods. Use the existing AgentEra origin parser and `getAccessTokenForCloudRequest`; never read credentials from the renderer. Parse `Retry-After` into a bounded error property without returning response bodies.

- [ ] Rerun focused tests, then `npm run typecheck:node`, `npm run check:agentera-cloud-contract`, and `git diff --check`. Expected: PASS.

- [ ] Commit:

  ```bash
  git add src/shared/agentera-workspace.ts src/main/agentera-workspace/client.ts src/main/agentera-workspace/client.test.ts
  git commit -m "feat: add strict Workspace desktop client"
  ```

## Task 9: Add the Account-Partitioned Offline Workspace Cache

**Repository:** `/Users/zizimutou/Desktop/aera/aera`

**Files:**

- Create: `src/main/agentera-workspace/db.ts`
- Create: `tests/agentera-workspace-db.test.ts`

**SQLite schema version 1:**

```sql
CREATE TABLE workspace_cache (
  account_user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  refreshed_at TEXT NOT NULL,
  PRIMARY KEY (account_user_id, workspace_id)
);

CREATE TABLE workspace_member_cache (
  account_user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  member_user_id TEXT NOT NULL,
  member_json TEXT NOT NULL,
  refreshed_at TEXT NOT NULL,
  PRIMARY KEY (account_user_id, workspace_id, member_user_id)
);

CREATE TABLE workspace_invitation_cache (
  account_user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  invitation_id TEXT NOT NULL,
  invitation_json TEXT NOT NULL,
  refreshed_at TEXT NOT NULL,
  PRIMARY KEY (account_user_id, workspace_id, invitation_id)
);

CREATE TABLE workspace_selection (
  account_user_id TEXT PRIMARY KEY,
  selected_workspace_id TEXT,
  updated_at TEXT NOT NULL
);
```

The database path is exactly `userData/agentera-workspace/workspace.db`, never `HERMES_HOME`. JSON is accepted only after strict client/public validation. No schema column or JSON value may contain raw invitation tokens, invite URLs, access/refresh tokens, local paths, Profile identifiers, session IDs, Memory, USER, Skill, or Curator state.

**Steps:**

- [ ] Write tests using `node:sqlite` for path safety, `PRAGMA journal_mode=WAL`, `foreign_keys=ON`, `user_version=1`, idempotent open, exact tables/columns, atomic replace per account, member/invitation replace per workspace, account partition isolation, selection persistence, archived/missing selection cleanup, and close behavior.

- [ ] Add a database-file content test: store safe summaries, close the database, read its bytes, and assert known raw token/link/private-state sentinels are absent. Attempting to cache an invitation object containing `token` or `inviteUrl` must throw before SQL execution.

- [ ] Run:

  ```bash
  cd /Users/zizimutou/Desktop/aera/aera
  npx vitest run tests/agentera-workspace-db.test.ts
  ```

  Expected: FAIL because `db.ts` does not exist.

- [ ] Implement `resolveAgenteraWorkspacePaths`, `openAgenteraWorkspaceDatabase`, schema migration, transactions, defensive JSON decoding, and explicit partitioned read/write methods. Reject a `userData` path at or below resolved `HERMES_HOME` before opening SQLite.

- [ ] Rerun focused tests, then `npm run typecheck:node` and `git diff --check`. Expected: PASS.

- [ ] Commit:

  ```bash
  git add src/main/agentera-workspace/db.ts tests/agentera-workspace-db.test.ts
  git commit -m "feat: cache Workspace metadata by account"
  ```

## Task 10: Implement Offline State, Selection, and Account Switching

**Repository:** `/Users/zizimutou/Desktop/aera/aera`

**Files:**

- Create: `src/main/agentera-workspace/manager.ts`
- Create: `src/main/agentera-workspace/manager.test.ts`

**Manager surface:**

```ts
export interface AgenteraWorkspaceManager {
  getState(): Promise<WorkspacePublicState>;
  refresh(): Promise<WorkspacePublicState>;
  select(input: { workspaceId: string | null }): Promise<WorkspacePublicState>;
  create(input: CreateWorkspaceInput): Promise<WorkspaceSummary>;
  rename(input: RenameWorkspaceInput): Promise<WorkspaceSummary>;
  archive(input: WorkspaceRevisionInput): Promise<WorkspaceSummary>;
  restore(input: WorkspaceRevisionInput): Promise<WorkspaceSummary>;
  listMembers(input: WorkspaceIDInput): Promise<readonly WorkspaceMember[]>;
  changeMemberRole(
    input: ChangeWorkspaceMemberRoleInput,
  ): Promise<WorkspaceMember>;
  removeMember(input: RemoveWorkspaceMemberInput): Promise<void>;
  leave(input: WorkspaceIDInput): Promise<void>;
  listInvitations(
    input: WorkspaceIDInput,
  ): Promise<readonly WorkspaceInvitation[]>;
  createInvitation(
    input: WorkspaceIDInput,
  ): Promise<WorkspaceInvitationCreation>;
  revokeInvitation(input: RevokeWorkspaceInvitationInput): Promise<void>;
  acceptInvitation(
    input: AcceptWorkspaceInvitationInput,
  ): Promise<WorkspaceInvitationAcceptance>;
  notifyAccessStateChanged(): Promise<void>;
  close(): void;
}
```

The implementation class may have a concrete name; the callable surface and result types remain exact.

**Steps:**

- [ ] Write manager tests for personal default, online authoritative refresh with atomic cache replacement, offline cached stale state, no-cache offline personal fallback, active workspace selection, archived/missing selection fallback, persisted selection after restart, account A/B isolation, logout, re-login, membership removal, workspace archive, concurrent refresh coalescing, and client failure preserving last safe cache.

- [ ] Add spies proving `select()` calls only the Workspace database/state emitter. It must never import or invoke Profile manager, Hermes client, session store, RuntimeBinding, Agent control manager, Memory, Skill, Curator, or Runtime distribution.

- [ ] Test every mutation online and offline. Offline calls fail `online_required` before a client call. Successful mutations refresh the affected safe cache; there is no mutation queue or optimistic cloud write.

- [ ] Test invitation secret lifetime: `createInvitation()` may return the secret to its immediate caller, but manager state, cache writes, later `getState()`, and emitted state never contain it.

- [ ] Run:

  ```bash
  cd /Users/zizimutou/Desktop/aera/aera
  npx vitest run src/main/agentera-workspace/manager.test.ts
  ```

  Expected: FAIL because the manager does not exist.

- [ ] Implement one manager bound to existing auth public state. `personalSpaceId` and `userId` come only from that state. Null selected workspace means personal. Only an active cached membership may become selected. All account transitions discard in-memory state and reopen the correct logical partition without deleting another account's cache.

- [ ] Coalesce duplicate refreshes and discard late results if the authenticated user changes while a request is in flight. Do not automatically refresh while cloud access is unavailable.

- [ ] Rerun focused tests, then `npm run typecheck:node` and `git diff --check`. Expected: PASS.

- [ ] Commit:

  ```bash
  git add src/main/agentera-workspace/manager.ts src/main/agentera-workspace/manager.test.ts
  git commit -m "feat: manage offline Workspace selection"
  ```

## Task 11: Wire Exact IPC, Preload, Startup, and Product Access Guards

**Repository:** `/Users/zizimutou/Desktop/aera/aera`

**Files:**

- Create: `src/main/agentera-workspace/ipc-contract.ts`
- Create: `src/main/agentera-workspace/deep-link.ts`
- Create: `src/main/agentera-workspace/deep-link.test.ts`
- Create: `tests/agentera-workspace-ipc.test.ts`
- Modify: `src/main/ipc/register.ts`
- Modify: `src/main/ipc/auth-guard.ts`
- Modify: `src/main/app/start.ts`
- Modify: `src/main/index.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/preload/index.d.ts`
- Modify: `electron-builder.yml`

**IPC channels:**

```text
agentera-workspace-get-state
agentera-workspace-refresh
agentera-workspace-select
agentera-workspace-create
agentera-workspace-rename
agentera-workspace-archive
agentera-workspace-restore
agentera-workspace-list-members
agentera-workspace-change-member-role
agentera-workspace-remove-member
agentera-workspace-leave
agentera-workspace-list-invitations
agentera-workspace-create-invitation
agentera-workspace-revoke-invitation
agentera-workspace-accept-invitation
agentera-workspace-get-pending-invitation
agentera-workspace-dismiss-pending-invitation
agentera-workspace-invitation-received
agentera-workspace-state-changed
```

`window.agenteraWorkspace` exposes one method per request channel plus `onStateChanged(listener): () => void` and `onInvitationReceived(listener): () => void`. Every method returns a stable `{ok: true, value}` or `{ok: false, errorCode}` envelope. Error codes are the desktop-safe set: `unauthenticated`, `online_required`, `forbidden`, `not_found`, `conflict`, `archived`, `owner_unavailable`, `limit_reached`, `rate_limited`, `cloud_unavailable`, and `invalid_request`.

**Steps:**

- [ ] Write exact input parser tests for missing/extra keys, invalid UUIDs, names, roles, revisions, tokens, and idempotency generation. Renderer input never supplies actor IDs or idempotency keys; the main process generates a new UUID idempotency key for each user action and retains it only for the duration of retrying that action.

- [ ] Write source/integration tests proving every channel uses the central auth guard and safe executor, state delivery skips destroyed windows, listeners are removable, startup constructs one workspace database/client/manager, auth changes call `notifyAccessStateChanged`, and shutdown closes the database.

- [ ] Write `deep-link.test.ts` first. Accept only `agentera://workspace-invitation#TOKEN` with no username, password, port, query, or non-empty path; require a decoded 32-byte base64url token; reject every other scheme, host, and shape. Test initial process arguments, macOS `open-url`, and Windows/Linux `second-instance` delivery without logging the URL.

- [ ] Test a one-item volatile invitation inbox. A newly received valid link replaces an older unaccepted link, survives renderer reload within the same main process, emits only to a live window, and is cleared only by exact-token dismissal or successful acceptance. It never touches SQLite, local/session storage, OAuth state, command telemetry, or a log.

- [ ] Prove access modes: state/cache/select require a valid authenticated or offline-entitled product state; refresh and every cloud mutation require `online`. A Workspace role never bypasses product authentication.

- [ ] Add compatibility assertions that startup still constructs exactly one Agent control manager, existing Profile/account controls remain wired, and workspace selection does not call `switchProfile`, `createProfile`, `createRuntimeBinding`, or a Hermes endpoint.

- [ ] Run:

  ```bash
  cd /Users/zizimutou/Desktop/aera/aera
  npx vitest run src/main/agentera-workspace/deep-link.test.ts tests/agentera-workspace-ipc.test.ts tests/agentera-ipc-auth-guard.test.ts tests/agentera-hermes-control-plane-compat.test.ts
  ```

  Expected: FAIL because the namespace, channels, and startup manager do not exist.

- [ ] Implement exact parsers/serializers and register all handlers through one Workspace registration helper. Never pass raw exceptions, response bodies, paths, or tokens through failure envelopes. The successful invitation-creation value and the explicit pending-invitation handoff are the only IPC payloads allowed to contain a one-time secret.

- [ ] Wire the manager in `start.ts` using `app.getPath("userData")`, the existing AgentEra origin, and `authController.getAccessTokenForCloudRequest()`. Subscribe to existing auth state; do not add a second login system.

- [ ] In `index.ts`, acquire Electron's single-instance lock before Runtime bootstrap, register the `agentera` protocol, inspect initial arguments, handle macOS `open-url`, and handle `second-instance`. Add the exact builder protocol declaration:

  ```yaml
  protocols:
    - name: AgentEra Workspace Invitation
      schemes:
        - agentera
  ```

  Development registration uses Electron's executable-plus-entry-argument form; packaged registration uses only the executable. If the lock is unavailable, quit without bootstrapping a second desktop process.

- [ ] Rerun focused tests, then `npm run typecheck`, `npm run build`, and `git diff --check`. Expected: PASS.

- [ ] Commit:

  ```bash
  git add src/main/agentera-workspace/ipc-contract.ts src/main/agentera-workspace/deep-link.ts src/main/agentera-workspace/deep-link.test.ts tests/agentera-workspace-ipc.test.ts src/main/ipc/register.ts src/main/ipc/auth-guard.ts src/main/app/start.ts src/main/index.ts src/preload/index.ts src/preload/index.d.ts electron-builder.yml
  git commit -m "feat: wire Workspace desktop control plane"
  ```

## Task 12: Add the Global Personal/Workspace Switcher Below the Brand

**Repository:** `/Users/zizimutou/Desktop/aera/aera`

**Files:**

- Create: `src/renderer/src/screens/Layout/WorkspaceSwitcher.tsx`
- Create: `src/renderer/src/screens/Layout/WorkspaceSwitcher.test.tsx`
- Modify: `src/renderer/src/screens/Layout/Layout.tsx`
- Modify: `src/renderer/src/assets/main.css`

**Layout invariant:**

```text
.sidebar-brand
WorkspaceSwitcher(authState, sidebarCollapsed)
.sidebar-nav.sidebar-nav-pinned
```

The footer keeps the existing account menu and `ProfileSwitcher`; neither moves into the product-space switcher.

**Steps:**

- [ ] Write component tests for personal-first ordering, active workspace selection, archived workspace exclusion from selectable choices, role badge, offline/stale badge, Owner-unavailable badge, loading/error state, collapsed icon/tooltip, keyboard navigation, outside/Escape close, and focus restoration.

- [ ] Add a source-order integration assertion that `WorkspaceSwitcher` appears after `.sidebar-brand` and before pinned navigation, while `ProfileSwitcher` remains inside `.sidebar-footer`.

- [ ] Add behavioral spies proving selecting personal or workspace calls only `window.agenteraWorkspace.select`; it does not navigate away from the current feature, change the account, or switch a Hermes Profile.

- [ ] Run:

  ```bash
  cd /Users/zizimutou/Desktop/aera/aera
  npx vitest run src/renderer/src/screens/Layout/WorkspaceSwitcher.test.tsx tests/agentera-workspace-ipc.test.ts
  ```

  Expected: FAIL because the component and layout insertion do not exist.

- [ ] Implement a compact, accessible menu using existing visual primitives. Personal is always first. Active workspaces follow by case-insensitive display name and UUID tie-break. Archived entries appear only behind the management action. Display the current role without implying a Hermes execution change.

- [ ] Add narrowly scoped CSS for expanded and collapsed sidebars, dark/light themes, truncation, focus-visible state, offline badges, and reduced motion. Do not restyle existing navigation, account, or Profile controls.

- [ ] Rerun focused tests, then `npm run typecheck:web` and `git diff --check`. Expected: PASS.

- [ ] Commit:

  ```bash
  git add src/renderer/src/screens/Layout/WorkspaceSwitcher.tsx src/renderer/src/screens/Layout/WorkspaceSwitcher.test.tsx src/renderer/src/screens/Layout/Layout.tsx src/renderer/src/assets/main.css
  git commit -m "feat: add global Workspace switcher"
  ```

## Task 13: Add Workspace Management, Role Controls, and Secret-Once Invite UX

**Repository:** `/Users/zizimutou/Desktop/aera/aera`

**Files:**

- Create: `src/renderer/src/screens/Layout/WorkspaceManagementDialog.tsx`
- Create: `src/renderer/src/screens/Layout/WorkspaceManagementDialog.test.tsx`
- Create: `src/renderer/src/components/WorkspaceInvitationGate.tsx`
- Create: `src/renderer/src/components/WorkspaceInvitationGate.test.tsx`
- Modify: `src/renderer/src/screens/Layout/WorkspaceSwitcher.tsx`
- Modify: `src/renderer/src/App.tsx`
- Modify: `src/renderer/src/App.test.tsx`
- Create: `src/shared/i18n/locales/workspace.ts`
- Modify: `src/shared/i18n/locales/en/navigation.ts`
- Modify: `src/shared/i18n/locales/ar/navigation.ts`
- Modify: `src/shared/i18n/locales/es/navigation.ts`
- Modify: `src/shared/i18n/locales/he/navigation.ts`
- Modify: `src/shared/i18n/locales/id/navigation.ts`
- Modify: `src/shared/i18n/locales/ja/navigation.ts`
- Modify: `src/shared/i18n/locales/pl/navigation.ts`
- Modify: `src/shared/i18n/locales/pt-BR/navigation.ts`
- Modify: `src/shared/i18n/locales/pt-PT/navigation.ts`
- Modify: `src/shared/i18n/locales/tr/navigation.ts`
- Modify: `src/shared/i18n/locales/zh-CN/navigation.ts`
- Modify: `src/shared/i18n/locales/zh-TW/navigation.ts`
- Modify: `src/renderer/src/assets/main.css`

**Translation strategy:** `workspace.ts` exports complete English, Simplified Chinese, and Traditional Chinese objects. English is the explicit fallback imported by Arabic, Spanish, Hebrew, Indonesian, Japanese, Polish, Brazilian Portuguese, European Portuguese, and Turkish navigation modules. No locale receives missing keys or untranslated sentinel text.

**Steps:**

- [ ] Write dialog tests for create, rename, archive, restore, member list, role-sensitive buttons, Owner promotion/demotion/removal, Admin ordinary-Member removal, voluntary leave, invitation list/revoke/create, archived read-only state, Owner-unavailable state, quota/conflict/rate-limit errors, destructive confirmations, and refresh after mutation.

- [ ] Write secret-once tests: first successful creation displays token/link with a copy action; close/unmount clears component state; reopening/listing never shows it; replay response with no token explains that a new invite must be created; neither DOM after close nor `WorkspacePublicState` retains the secret.

- [ ] Write invitation-gate tests for a link received before sign-in, successful online sign-in-to-accept handoff, explicit acceptance confirmation, offline pause, unavailable token, dismissal, account switching, and successful selection of the joined workspace. The raw token remains in a React ref or the main-process volatile inbox only; it is absent from component state snapshots, URLs, OAuth state, storage, cache, analytics, and logs.

- [ ] Write offline tests: cached workspace/member/invitation metadata may be viewed as stale, while every mutation control is disabled with an online-required explanation. There is no offline queue.

- [ ] Run:

  ```bash
  cd /Users/zizimutou/Desktop/aera/aera
  npx vitest run src/renderer/src/screens/Layout/WorkspaceManagementDialog.test.tsx src/renderer/src/screens/Layout/WorkspaceSwitcher.test.tsx src/renderer/src/components/WorkspaceInvitationGate.test.tsx src/renderer/src/App.test.tsx
  ```

  Expected: FAIL because the management dialog and translation keys do not exist.

- [ ] Implement one dialog launched from the switcher. Render controls from the current actor role and server `mutationState`, but continue relying on the cloud for authoritative permission enforcement.

- [ ] Mount `WorkspaceInvitationGate` at the App root so it remains alive while `AuthGate` completes browser authentication. It reads the pending token from the preload namespace, removes any renderer fragment with `history.replaceState`, waits for `authenticated` plus `cloudAvailable=true`, asks the user to confirm, accepts through the existing main-process method, then dismisses the exact inbox token. It never bypasses Profile ownership or Runtime startup gates.

- [ ] Keep the raw invitation secret only in component state. Copy via the Clipboard API on an explicit click. Clear it on close, account change, error, and successful navigation. Never place it in a toast payload that is persisted, URL query, local/session storage, log, analytics, or cache.

- [ ] Add complete locale keys through the locked translation strategy and style only Workspace dialog/switcher selectors.

- [ ] Rerun focused tests, then `npm run typecheck:web`, `npm run build`, and `git diff --check`. Expected: PASS.

- [ ] Commit:

  ```bash
  git add src/renderer/src/screens/Layout/WorkspaceManagementDialog.tsx src/renderer/src/screens/Layout/WorkspaceManagementDialog.test.tsx src/renderer/src/components/WorkspaceInvitationGate.tsx src/renderer/src/components/WorkspaceInvitationGate.test.tsx src/renderer/src/screens/Layout/WorkspaceSwitcher.tsx src/renderer/src/App.tsx src/renderer/src/App.test.tsx src/shared/i18n/locales/workspace.ts src/shared/i18n/locales/{en,ar,es,he,id,ja,pl,pt-BR,pt-PT,tr,zh-CN,zh-TW}/navigation.ts src/renderer/src/assets/main.css
  git commit -m "feat: manage Workspace roles and invitations"
  ```

## Task 14: Prove End-to-End Flow and the Hermes Compatibility Boundary

**Repositories:** `/Users/zizimutou/Desktop/aera/aera-cloud` and `/Users/zizimutou/Desktop/aera/aera`

**Files:**

- Create: `tests/e2e/agentera-workspace.e2e.ts`
- Create: `tests/agentera-workspace-boundary.test.ts`
- Modify: `package.json`
- Modify: `lat.md/agentera-workspaces.md`

**End-to-end scenarios:**

```text
1. Authenticated user starts in Personal Space.
2. User creates a workspace and sees Owner role in the global switcher.
3. Owner creates a one-time Member invitation; secret is visible once in an `agentera://` fragment link.
4. A second account opens the link before sign-in, completes sign-in, explicitly accepts it, and sees Member role.
5. Owner promotes the member to Admin; Admin cannot manage Owner or another Admin.
6. Workspace selection survives desktop reload for the same account.
7. Account switching never reveals the other account's cached selection or memberships.
8. Offline mode shows cached active workspaces as stale and blocks mutations.
9. Archive falls back selection to Personal; restore makes the workspace selectable again.
10. Product-space switching leaves the selected Hermes Profile and active RuntimeBinding unchanged.
```

**Steps:**

- [ ] Add `"test:e2e:workspace": "playwright test tests/e2e/agentera-workspace.e2e.ts"` to `package.json`.

- [ ] Build a deterministic Playwright route fixture for the locked OpenAPI responses and the two-account flow. Inject the custom-protocol URL through the tested volatile inbox. The fixture must reject any unexpected route/body/actor field and record whether a raw invite token appears outside the first creation response, protocol handoff, and accept request.

- [ ] Add boundary tests that scan/import graphs for forbidden Workspace dependencies on Hermes Memory, Profile mutation, sessions, Skill mutation, Curator, Runtime distribution mutation, and old `agent-sync.ts` `/api/agents`. Assert existing Agent control code remains USER-only and existing RuntimeBinding compatibility tests are unchanged.

- [ ] Run the red tests:

  ```bash
  cd /Users/zizimutou/Desktop/aera/aera
  npx vitest run tests/agentera-workspace-boundary.test.ts
  npm run test:e2e:workspace
  ```

  Expected: FAIL until the fixture, boundary assertions, and package script are complete.

- [ ] Complete the tests and add `@lat` source references plus behavior/test notes to `lat.md/agentera-workspaces.md`. Do not claim workspace-owned Agents are implemented.

- [ ] Run the focused desktop gate:

  ```bash
  cd /Users/zizimutou/Desktop/aera/aera
  npx vitest run tests/agentera-workspace-db.test.ts tests/agentera-workspace-ipc.test.ts tests/agentera-workspace-boundary.test.ts src/main/agentera-workspace/client.test.ts src/main/agentera-workspace/deep-link.test.ts src/main/agentera-workspace/manager.test.ts src/renderer/src/screens/Layout/WorkspaceSwitcher.test.tsx src/renderer/src/screens/Layout/WorkspaceManagementDialog.test.tsx src/renderer/src/components/WorkspaceInvitationGate.test.tsx tests/agentera-hermes-control-plane-compat.test.ts tests/hermes-agent-compat.test.ts
  npm run test:e2e:workspace
  npx --yes lat.md check
  ```

  Expected: PASS.

- [ ] Run the complete cloud gate:

  ```bash
  cd /Users/zizimutou/Desktop/aera/aera-cloud
  go test -count=1 ./...
  set -a
  source .env.example
  set +a
  AERA_INTEGRATION_TESTS=1 go test -p 1 -count=1 ./...
  cd /Users/zizimutou/Desktop/aera/aera-cloud/web
  npm test -- --run
  npm run build
  npx playwright test
  ```

  Expected: PASS without cached Go results.

- [ ] Run the complete desktop gate:

  ```bash
  cd /Users/zizimutou/Desktop/aera/aera
  npm run check:agentera-cloud-contract
  npm test
  npm run typecheck
  npm run build
  npm run test:e2e:agent-control
  npm run test:e2e:workspace
  npx --yes lat.md check
  ```

  Expected: PASS. There is no Runtime repository command because it has no diff.

- [ ] Commit test and documentation evidence:

  ```bash
  git add tests/e2e/agentera-workspace.e2e.ts tests/agentera-workspace-boundary.test.ts package.json lat.md/agentera-workspaces.md
  git commit -m "test: prove Workspace and Hermes boundaries"
  ```

- [ ] Inspect both branches without merging or pushing:

  ```bash
  git -C /Users/zizimutou/Desktop/aera/aera-cloud status --short --branch
  git -C /Users/zizimutou/Desktop/aera/aera-cloud diff --check main...HEAD
  git -C /Users/zizimutou/Desktop/aera/aera-cloud log --oneline --decorate main..HEAD
  git -C /Users/zizimutou/Desktop/aera/aera status --short --branch
  git -C /Users/zizimutou/Desktop/aera/aera diff --check main...HEAD
  git -C /Users/zizimutou/Desktop/aera/aera log --oneline --decorate main..HEAD
  git -C /Users/zizimutou/Desktop/aera/aera-runtime status --short --branch
  ```

  Expected: both feature worktrees are clean with only the planned local commits above `main`; Runtime remains clean at `c0439e1e3e`; no remote has changed.

## Completion Gate

Workspace Foundation V1 is complete only when all of the following are true:

- PostgreSQL enforces one fixed matching Owner at transaction commit.
- The complete role matrix, quotas, revisions, archive/restore behavior, invitation single-use behavior, idempotency replay, rate limits, and audit have passing unit and integration evidence.
- Account deletion freezes owned workspaces during cooling-off, discloses the owned count, and finalizes without leaving identifying Workspace links.
- OpenAPI 0.3.0 is byte-pinned and generated desktop types are current.
- Desktop cache partitions every row and selection by authenticated account and contains no raw invitation secret or Hermes-private data.
- Custom-protocol invitations use an exact fragment-only URL and a bounded volatile handoff that survives sign-in without persisting the token.
- Personal/workspace selection works online and offline without changing account, Profile, session, RuntimeBinding, or Hermes learning state.
- Workspace management controls match Owner/Admin/Member capabilities and remain server-authorized.
- Full cloud, account-center, desktop, contract, E2E, compatibility, build, and `lat.md` gates pass.
- Both feature branches are clean, local-only, unmerged, unpushed, and undeployed pending explicit user review.

The next separate product slice after this completion gate is `owner_scope=WORKSPACE` AgentDefinition/version/installation support. It is deliberately not part of this plan.
