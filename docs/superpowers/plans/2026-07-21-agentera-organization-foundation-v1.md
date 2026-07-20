# AgentEra Organization Foundation V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver Organization Foundation V1 across `aera-cloud` and the AgentEra desktop: enterprise lifecycle, Owner/Admin/Auditor/Member authorization, one-level departments, one-time invitations, immutable signed policy snapshots, scoped audit, an account-isolated offline cache, and a single Personal/Workspace/Organization product-space switcher that never changes Hermes runtime state.

**Architecture:** `aera-cloud/internal/organization` is an independent control-plane bounded context beside `internal/workspace` and `internal/agentcontrol`. It reuses authenticated principals, PostgreSQL, Redis, Ed25519 key material, strict JSON, idempotency, and bounded audit primitives without reusing Workspace business tables. `aera/src/main/agentera-organization` owns cloud transport, contract validation, policy verification, and an account-partitioned cache. `aera/src/main/agentera-product-space` becomes the sole selected product-context owner. Personal and Workspace keep their existing Agent contexts; Organization deliberately maps to `organization_agent_not_enabled` until Organization Agent V1. Hermes Profile, RuntimeBinding, Memory, sessions, files, credentials, Curator, and private learning stay outside both new domains.

**Tech Stack:** Go 1.24, PostgreSQL 16, Redis, chi, pgx, Ed25519, OpenAPI 3.0.3, Electron, TypeScript, React, SQLite (`better-sqlite3`), Vitest, Playwright/Electron E2E, `lat.md`.

## Global Constraints

- Treat `/Users/zizimutou/Desktop/aera/aera-cloud` and `/Users/zizimutou/Desktop/aera/aera` as separate Git repositories. `/Users/zizimutou/Desktop/aera/aera-runtime` is a read-only compatibility witness.
- Work on local branches named `aera/organization-foundation-v1`; do not push, deploy, publish a release, or change DNS.
- Follow red-green-refactor. Every behavior task starts with the smallest failing test, records the expected failure, adds the minimum implementation, reruns the focused test, then runs the affected package suite.
- Use the authenticated access-token principal for actor identity. No renderer or request body may assert actor, role, tenant, Organization ownership, signing key, local path, Profile, RuntimeBinding, or Hermes state.
- Organization tables, JSON, cache, IPC, logs, audit, and E2E fixtures must not contain `MEMORY.md`, `USER.md`, conversations, sessions, files, credentials, Profile IDs/paths, RuntimeBinding payloads, Curator state, private Skills, or invitation token digests.
- A successful Organization action may change only Organization control-plane state and the selected product-space record. It must never call Profile selection, Runtime bootstrap, Gateway restart, session migration, Memory mutation, Skill mutation, or RuntimeBinding mutation.
- One Installation remains one independent USER-owned Hermes Profile. This slice creates no Organization-owned Installation, Profile, or RuntimeBinding.
- Update `/Users/zizimutou/Desktop/aera/aera/lat.md/agentera-organizations.md` after every implementation task that changes functionality, architecture, or test coverage, then run `npx --yes lat.md check`.
- Preserve strict distinction among local implementation, local validation, local merge, GitHub push, deployment, and release. This plan ends at a verified local merge.

## Repository and Branch Map

| Responsibility | Repository | Locked starting point | Feature branch |
| --- | --- | --- | --- |
| Organization schema, service, HTTP, OpenAPI, account lifecycle | `/Users/zizimutou/Desktop/aera/aera-cloud` | clean local `main` at `4870fdb`, 37 commits ahead of `origin/main` | `aera/organization-foundation-v1` |
| Desktop Organization cache, product-space coordinator, IPC, UI, E2E | `/Users/zizimutou/Desktop/aera/aera` | clean local `main` after this plan commit, based on design commit `a65cb29` | `aera/organization-foundation-v1` |
| Hermes execution and self-learning | `/Users/zizimutou/Desktop/aera/aera-runtime` | clean `main` at `c0439e1e3e5f`, equal to `origin/main` | no branch and no edit |

Create both feature branches only after committing this plan:

```bash
git -C /Users/zizimutou/Desktop/aera/aera-cloud switch -c aera/organization-foundation-v1
git -C /Users/zizimutou/Desktop/aera/aera switch -c aera/organization-foundation-v1
```

Expected: each repository reports the new local branch; the Runtime repository remains on clean `main`.

## Planned File Structure

### Cloud domain

```text
aera-cloud/
  migrations/000012_organization_foundation.sql
  internal/organization/
    model.go
    model_test.go
    token.go
    token_test.go
    limiter.go
    limiter_test.go
    policy.go
    policy_test.go
    signing.go
    signing_test.go
    repository.go
    repository_test.go
    service.go
    service_test.go
    http.go
    http_test.go
```

Existing cloud files changed by the slice:

```text
.env.example
migrations/embed.go
internal/store/migrate_test.go
internal/config/config.go
internal/config/config_test.go
internal/audit/service.go
internal/audit/service_test.go
internal/account/model.go
internal/account/lifecycle.go
internal/account/lifecycle_test.go
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
```

### Desktop domains

```text
aera/
  src/shared/agentera-organization.ts
  src/shared/agentera-product-space.ts
  src/main/agentera-organization/
    client.ts
    client.test.ts
    db.ts
    db.test.ts
    policy-verifier.ts
    policy-verifier.test.ts
    deep-link.ts
    deep-link.test.ts
    manager.ts
    manager.test.ts
    ipc-contract.ts
    ipc-contract.test.ts
  src/main/agentera-product-space/
    db.ts
    db.test.ts
    manager.ts
    manager.test.ts
    ipc-contract.ts
    ipc-contract.test.ts
  src/renderer/src/components/
    OrganizationInvitationGate.tsx
    OrganizationInvitationGate.test.tsx
  src/renderer/src/screens/Layout/
    ProductSpaceSwitcher.tsx
    ProductSpaceSwitcher.test.tsx
    OrganizationManagementDialog.tsx
    OrganizationManagementDialog.test.tsx
  src/shared/i18n/locales/organization.ts
  tests/agentera-organization-boundary.test.ts
  tests/agentera-product-space-boundary.test.ts
  tests/e2e/agentera-organization.e2e.ts
```

Existing desktop files changed by the slice:

```text
contracts/agentera-cloud.openapi.yaml
src/shared/agentera-cloud-api.generated.ts
src/shared/agentera-agent-control.ts
src/main/agentera-agent-control/manager.ts
src/main/agentera-agent-control/manager.test.ts
src/main/agentera-workspace/db.ts
src/main/agentera-workspace/manager.ts
src/main/agentera-workspace/manager.test.ts
src/main/app/start.ts
src/main/index.ts
src/main/ipc/register.ts
src/preload/index.ts
src/preload/index.d.ts
src/renderer/src/App.tsx
src/renderer/src/App.test.tsx
src/renderer/src/screens/Layout/Layout.tsx
src/renderer/src/screens/Layout/WorkspaceSwitcher.tsx       # removed after migration
src/renderer/src/screens/Layout/WorkspaceSwitcher.test.tsx  # replaced
src/renderer/src/screens/Agents/AgentControlPanel.tsx
src/renderer/src/screens/Agents/AgentControlPanel.test.tsx
src/shared/i18n/locales/{en,ar,es,he,id,ja,pl,pt-BR,pt-PT,tr,zh-CN,zh-TW}/navigation.ts
scripts/check-agentera-cloud-contract.mjs
tests/agentera-cloud-contract.test.ts
tests/preload-api-surface.test.ts
tests/agentera-workspace-boundary.test.ts
tests/agentera-agent-control-ipc.test.ts
package.json
lat.md/agentera-organizations.md
lat.md/agentera-workspaces.md
```

## Locked Cloud API Surface

```text
GET    /api/v1/organizations
POST   /api/v1/organizations
GET    /api/v1/organizations/{organization_id}
PATCH  /api/v1/organizations/{organization_id}
POST   /api/v1/organizations/{organization_id}/archive
POST   /api/v1/organizations/{organization_id}/restore
POST   /api/v1/organizations/{organization_id}/owner-transfer
POST   /api/v1/organizations/{organization_id}/dissolve
GET    /api/v1/organizations/{organization_id}/members
PATCH  /api/v1/organizations/{organization_id}/members/{user_id}
DELETE /api/v1/organizations/{organization_id}/members/{user_id}
POST   /api/v1/organizations/{organization_id}/leave
GET    /api/v1/organizations/{organization_id}/departments
POST   /api/v1/organizations/{organization_id}/departments
PATCH  /api/v1/organizations/{organization_id}/departments/{department_id}
POST   /api/v1/organizations/{organization_id}/departments/{department_id}/archive
POST   /api/v1/organizations/{organization_id}/departments/{department_id}/restore
GET    /api/v1/organizations/{organization_id}/invitations
POST   /api/v1/organizations/{organization_id}/invitations
DELETE /api/v1/organizations/{organization_id}/invitations/{invitation_id}
POST   /api/v1/organization-invitations/accept
GET    /api/v1/organizations/{organization_id}/policy
GET    /api/v1/organizations/{organization_id}/policy-snapshots
POST   /api/v1/organizations/{organization_id}/policy-snapshots
GET    /api/v1/organization-policy-snapshots/{policy_snapshot_id}
GET    /api/v1/organizations/{organization_id}/audit-events
```

Create, invite creation/acceptance, policy publication, Owner transfer, archive, restore, and dissolution require `Idempotency-Key`. Mutable aggregate commands carry exact expected revisions or versions. `/.well-known/agentera-signing-keys.json` adds purpose `organization_policy` using the same configured key ring but the independent signature domain `agentera-organization-policy-v1`.

## Task 1: Add Organization Persistence, Deferred Invariants, and Configuration

**Repository:** `/Users/zizimutou/Desktop/aera/aera-cloud`

**Consumes:** approved schema and quota defaults.

**Produces:** migration 12, database-enforced ownership/lifecycle/policy invariants, typed configuration.

**Files:**

- Create: `migrations/000012_organization_foundation.sql`
- Modify: `internal/store/migrate_test.go`
- Modify: `internal/config/config.go`
- Modify: `internal/config/config_test.go`
- Modify: `.env.example`

**Schema contract:**

```sql
CREATE TABLE organizations (
    id UUID PRIMARY KEY,
    display_name TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active','archived','dissolved')),
    revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
    current_policy_snapshot_id UUID,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    archived_at TIMESTAMPTZ,
    dissolved_at TIMESTAMPTZ
);
CREATE TABLE organization_departments (
    organization_id UUID NOT NULL REFERENCES organizations(id),
    id UUID NOT NULL,
    display_name TEXT NOT NULL,
    name_key TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active','archived')),
    revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    archived_at TIMESTAMPTZ,
    PRIMARY KEY (organization_id, id)
);
CREATE TABLE organization_memberships (
    organization_id UUID NOT NULL REFERENCES organizations(id),
    user_id UUID NOT NULL REFERENCES users(id),
    role TEXT NOT NULL CHECK (role IN ('owner','admin','auditor','member')),
    department_id UUID,
    revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
    joined_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (organization_id, user_id),
    FOREIGN KEY (organization_id, department_id)
        REFERENCES organization_departments(organization_id, id)
);
CREATE TABLE organization_invitations (
    id UUID PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES organizations(id),
    token_digest BYTEA NOT NULL UNIQUE CHECK (octet_length(token_digest)=32),
    created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    status TEXT NOT NULL CHECK (status IN ('pending','accepted','revoked','expired')),
    accepted_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    accepted_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ
);
CREATE TABLE organization_policy_snapshots (
    id UUID PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES organizations(id),
    policy_version BIGINT NOT NULL CHECK (policy_version > 0),
    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
    policy_document JSONB NOT NULL,
    content_digest BYTEA NOT NULL CHECK (octet_length(content_digest)=32),
    issuer TEXT NOT NULL,
    signing_key_id TEXT NOT NULL,
    signature BYTEA NOT NULL CHECK (octet_length(signature)=64),
    issued_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL,
    UNIQUE (organization_id, policy_version)
);
CREATE TABLE organization_idempotency_records (
    actor_user_id UUID NOT NULL REFERENCES users(id),
    organization_id UUID NOT NULL REFERENCES organizations(id),
    operation TEXT NOT NULL,
    key_digest BYTEA NOT NULL CHECK (octet_length(key_digest)=32),
    request_digest BYTEA NOT NULL CHECK (octet_length(request_digest)=32),
    resource_type TEXT NOT NULL,
    resource_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (actor_user_id, operation, key_digest)
);
ALTER TABLE audit_events ADD COLUMN organization_id UUID REFERENCES organizations(id);
```

The migration adds a partial unique Owner index; deferred constraint triggers for exactly one Owner while active/archived and zero memberships while dissolved; an immutable policy trigger; a deferred same-Organization current-policy foreign key; invitation terminal-transition and exact-seven-day checks; Department assignment and active-name indexes; audit keyset index; idempotency expiry index; and no runtime/private-data columns.

Configuration fields and defaults are exact:

```text
AGENTERA_CLOUD_ORGANIZATION_OWNED_LIMIT=3
AGENTERA_CLOUD_ORGANIZATION_MEMBER_LIMIT=500
AGENTERA_CLOUD_ORGANIZATION_DEPARTMENT_LIMIT=50
AGENTERA_CLOUD_ORGANIZATION_PENDING_INVITE_LIMIT=100
AGENTERA_CLOUD_ORGANIZATION_CREATE_RATE_LIMIT=6
AGENTERA_CLOUD_ORGANIZATION_CREATE_RATE_WINDOW=1h
AGENTERA_CLOUD_ORGANIZATION_INVITE_RATE_LIMIT=30
AGENTERA_CLOUD_ORGANIZATION_INVITE_RATE_WINDOW=1h
AGENTERA_CLOUD_ORGANIZATION_ACCEPT_RATE_LIMIT=30
AGENTERA_CLOUD_ORGANIZATION_ACCEPT_RATE_WINDOW=10m
AGENTERA_CLOUD_ORGANIZATION_MUTATION_RATE_LIMIT=120
AGENTERA_CLOUD_ORGANIZATION_MUTATION_RATE_WINDOW=1h
AGENTERA_CLOUD_ORGANIZATION_HIGH_RISK_RATE_LIMIT=20
AGENTERA_CLOUD_ORGANIZATION_HIGH_RISK_RATE_WINDOW=1h
```

**Steps:**

- [ ] Create both feature branches and record clean baselines.
- [ ] Extend migration tests to expect 12 migrations and assert every table, column, check, foreign key, index, immutable trigger, and deferred trigger.
- [ ] Add integration tests that attempt commits with zero Owners, two Owners, a cross-Organization Department, a cross-Organization current policy, a dissolved Organization with Memberships, terminal invitation mutation, and policy update/delete. Confirm every test fails before the migration exists.
- [ ] Add config tests for all 14 values, missing values, zero/negative integer rejection, invalid duration rejection, and typed values.
- [ ] Add the migration and configuration implementation.
- [ ] Run:

```bash
go test ./internal/store ./internal/config
```

Expected red: migration count/table and new config field assertions fail. Expected green: both packages pass against PostgreSQL integration when available; absence of required integration services is reported as a skip only by existing testkit behavior.

- [ ] Update LAT Organization source/test references; run `npx --yes lat.md check` in the desktop repository.
- [ ] Commit cloud changes: `feat: add organization foundation schema`.

## Task 2: Define Strict Domain Values, Secret Tokens, and Redis Limits

**Repository:** `/Users/zizimutou/Desktop/aera/aera-cloud`

**Consumes:** Task 1 schema/config.

**Produces:** safe domain types, stable errors, normalization, invitation token utilities, rate-limit policies.

**Files:**

- Create: `internal/organization/model.go`
- Create: `internal/organization/model_test.go`
- Create: `internal/organization/token.go`
- Create: `internal/organization/token_test.go`
- Create: `internal/organization/limiter.go`
- Create: `internal/organization/limiter_test.go`

**Interfaces:**

```go
type Role string
const (RoleOwner Role = "owner"; RoleAdmin Role = "admin"; RoleAuditor Role = "auditor"; RoleMember Role = "member")
type Status string
const (StatusActive Status = "active"; StatusArchived Status = "archived"; StatusDissolved Status = "dissolved")
type Actor struct { UserID uuid.UUID; DeviceID uuid.UUID }
type Quotas struct { Owned, Members, Departments, PendingInvitations int }
type LimitOperation string
const (
    LimitCreate       LimitOperation = "create"
    LimitInviteCreate LimitOperation = "invitation_create"
    LimitInviteAccept LimitOperation = "invitation_accept"
    LimitMutation     LimitOperation = "mutation"
    LimitHighRisk     LimitOperation = "high_risk"
)
```

Public structs contain only the exact approved summary fields. Stable sentinel errors map one-to-one to the approved API codes. `NormalizeOrganizationName` and `NormalizeDepartmentName` trim, NFC-normalize, reject controls, and count Unicode scalar values. Department `name_key` is Unicode case-folded normalized text. The token generator returns exactly 32 random bytes as canonical unpadded base64url and stores only SHA-256.

**Steps:**

- [ ] Write table-driven model tests for every enum, name boundary, control character, normalization collision, public mutation state, and error code.
- [ ] Write token tests for entropy length, canonical encoding, digest length, malformed token rejection, and non-aliasing buffers.
- [ ] Write limiter tests proving operation-specific Redis keys are actor/Organization scoped, windows are bounded, secrets never enter keys, and backend failures return `service_unavailable`.
- [ ] Run focused tests and confirm missing-symbol compile failures.
- [ ] Implement the minimum domain/token/limiter code and rerun:

```bash
go test ./internal/organization -run 'Test(.*Name|.*Token|.*Limiter|.*Public)'
```

- [ ] Run `go test ./internal/organization`; update LAT; commit `feat: define organization domain values`.

## Task 3: Canonicalize and Sign Immutable Organization Policy V1

**Repository:** `/Users/zizimutou/Desktop/aera/aera-cloud`

**Consumes:** configured Agent-control key ring, Organization model.

**Produces:** strict typed policy document, deterministic canonical JSON/digest, domain-separated attestation.

**Files:**

- Create: `internal/organization/policy.go`
- Create: `internal/organization/policy_test.go`
- Create: `internal/organization/signing.go`
- Create: `internal/organization/signing_test.go`

**Policy contract:**

```go
type PolicyDocument struct {
    SchemaVersion int                       `json:"schema_version"`
    Models        AllowlistPolicy[ModelRef] `json:"models"`
    Tools         AllowlistPolicy[string]   `json:"tools"`
    Experience    ExperiencePolicy          `json:"experience_candidates"`
    Official      OfficialAgentPolicy       `json:"official_agents"`
}
```

Canonical JSON contains only approved keys, sorts unique allowlists, uses schema version 1, and remains at most 64 KiB. Identifier pattern is `[A-Za-z0-9._:/-]{1,128}`. Signature payload is:

```text
"agentera-organization-policy-v1" + NUL + OrganizationID.String() + NUL + SnapshotID.String() + NUL + base10(PolicyVersion) + NUL + lowerHex(ContentDigest)
```

`PurposeOrganizationPolicy` is `organization_policy`. Signer copies Ed25519 private keys, validates canonical keys, exposes public keys, and never serializes private material.

**Steps:**

- [ ] Add failing tests for default policy, inherit/deny/restrict semantics, unknown keys, duplicate logical entries, invalid identifiers, wrong schema, over-128 entries, over-64-KiB output, deterministic ordering, and mutation after canonicalization.
- [ ] Add RFC-style signing tests for domain separation, issuer/key ID, wrong Organization/snapshot/version/digest, malformed key, and public-key verification.
- [ ] Implement strict decoding with duplicate-key rejection before typed validation, canonical encoding, SHA-256, signer, and verifier.
- [ ] Run:

```bash
go test ./internal/organization -run 'Test(Policy|Signer|Verifier)'
```

Expected: every policy/signature test passes and `go test ./internal/agentcontrol` remains green.

- [ ] Update LAT; commit `feat: sign organization policy snapshots`.

## Task 4: Implement Transactional Creation, Read Models, and Policy Persistence

**Repository:** `/Users/zizimutou/Desktop/aera/aera-cloud`

**Consumes:** Tasks 1–3.

**Produces:** PostgreSQL repository transactions for atomic Organization creation/default policy and safe reads.

**Files:**

- Create: `internal/organization/repository.go`
- Create: `internal/organization/repository_test.go`
- Modify: `internal/audit/service.go`
- Modify: `internal/audit/service_test.go`

**Repository ports:**

```go
type Repository interface {
    Create(context.Context, CreateTransaction) (OrganizationSummary, error)
    ListForActor(context.Context, uuid.UUID, Page) (OrganizationPage, error)
    GetForActor(context.Context, uuid.UUID, uuid.UUID) (OrganizationSummary, error)
    ListMembers(context.Context, uuid.UUID, uuid.UUID, Page) (MemberPage, error)
    ListDepartments(context.Context, uuid.UUID, uuid.UUID, Page) (DepartmentPage, error)
    CurrentPolicy(context.Context, uuid.UUID, uuid.UUID, bool) (PolicySnapshot, error)
}
```

`Create` locks the actor quota key, inserts Organization, Owner membership, default signed policy snapshot, current pointer, idempotency record, and success audit in one transaction. A signing or audit failure rolls everything back. Outsider reads return `organization_not_found`. Member current-policy reads omit document/signature; Owner/Admin/Auditor detail reads include them.

Audit `Event` gains optional `OrganizationID`; recorder inserts it directly and allows only bounded `organization_*` metadata keys. It rejects tokens, digests of invitations, full policy bodies, local paths, Profile/Memory/session/Skill fields, and arbitrary nested JSON.

**Steps:**

- [ ] Add PostgreSQL integration tests for atomic create, replay, conflicting idempotency payload, ownership quota including archived, safe list/get, role-specific policy projection, and rollback on signer/audit failure.
- [ ] Add audit recorder unit/integration tests for `organization_id`, deterministic bounded metadata, query index availability, and forbidden secret/private keys.
- [ ] Confirm repository/audit tests fail before implementation.
- [ ] Implement transactions with `SELECT ... FOR UPDATE`, compare-and-swap revisions, canonical request digests, and keyset cursors.
- [ ] Run `go test ./internal/organization ./internal/audit`; update LAT; commit `feat: persist organization control plane`.

## Task 5: Enforce Membership, Department, and Owner-Transfer Authorization

**Repository:** `/Users/zizimutou/Desktop/aera/aera-cloud`

**Consumes:** transactional repository primitives.

**Produces:** complete Owner/Admin/Auditor/Member/outsider matrix for membership and Departments.

**Files:**

- Modify: `internal/organization/repository.go`
- Modify: `internal/organization/repository_test.go`
- Create: `internal/organization/service.go`
- Create: `internal/organization/service_test.go`

**Service commands:**

```go
Rename(ctx, Actor, RenameCommand)
PatchMember(ctx, Actor, PatchMemberCommand)
RemoveMember(ctx, Actor, RemoveMemberCommand)
Leave(ctx, Actor, LeaveCommand)
CreateDepartment(ctx, Actor, CreateDepartmentCommand)
RenameDepartment(ctx, Actor, RenameDepartmentCommand)
ArchiveDepartment(ctx, Actor, DepartmentLifecycleCommand)
RestoreDepartment(ctx, Actor, DepartmentLifecycleCommand)
TransferOwner(ctx, Actor, OwnerTransferCommand)
```

The service recomputes role inside the same locked transaction. Admin cannot mutate Owner/Admin or promote to Admin. Owner assignment exists only through transfer. Transfer requires target current Admin, both expected revisions, Organization revision, and exact `transfer-organization-owner`. Department assignment uses same-Organization composite keys and refuses archived Departments. Department archive requires zero assignments.

**Steps:**

- [ ] Encode the complete permission matrix as table-driven service tests, including archived-state exceptions and outsider non-enumeration.
- [ ] Add race tests for stale Member revision, simultaneous role changes, and two concurrent Owner transfers with exactly one legal commit.
- [ ] Add Department quota, normalized-name uniqueness, cross-Organization assignment, empty-before-archive, and restore collision tests.
- [ ] Implement authorization decisions and transactional methods.
- [ ] Run `go test ./internal/organization -run 'Test(Service|Membership|Department|OwnerTransfer)'`, then the full package.
- [ ] Update LAT; commit `feat: enforce organization roles and departments`.

## Task 6: Add Invitations, Policy Publication, Lifecycle, Dissolution, and Audit Query

**Repository:** `/Users/zizimutou/Desktop/aera/aera-cloud`

**Consumes:** Tasks 2–5.

**Produces:** remaining high-risk service behavior and extension contracts.

**Files:**

- Modify: `internal/organization/model.go`
- Modify: `internal/organization/repository.go`
- Modify: `internal/organization/repository_test.go`
- Modify: `internal/organization/service.go`
- Modify: `internal/organization/service_test.go`

**Extension interfaces:**

```go
type AssetGuard interface { DissolutionBlockers(context.Context, uuid.UUID) ([]string, error) }
type PolicySigner interface { Sign(PolicySignatureInput) (PolicyAttestation, error) }
type Auditor interface { Record(context.Context, audit.Event) error }
```

Archive revokes pending invitations; restore rechecks quota; dissolve requires archived status, exact display name/revision/`dissolve-organization`, only Owner membership, no pending invitation, no assigned Department, and no asset blocker. It writes final audit, clears mutable rows, redacts the name, retains policy/audit and dissolution replay tombstone, then removes Owner membership. Dissolution replay resolves the retained idempotency record before current-membership authorization only for the original actor/key/request.

Policy publication requires Owner/Admin, active Organization, expected Organization revision, expected next policy version, canonical validation/signature, immutable insert/current-pointer update/audit in one transaction.

**Steps:**

- [ ] Add secret-once invitation tests for canonical fragment links, no query token, no stored raw token, replay without secret, expiry, revoke, already-member consume, concurrent acceptance winner, and actor-bound replay.
- [ ] Add lifecycle tests for archive/restore, revoked-invite non-revival, dissolve preconditions, asset guard denial, exact confirmations, irreversible terminal state, safe original replay, and outsider non-enumeration.
- [ ] Add policy publication race tests, monotonic version tests, rollback on signer/audit failure, and full-history authorization.
- [ ] Add audit query keyset pagination and Owner/Admin/Auditor-only tests.
- [ ] Implement minimum behavior and run `go test ./internal/organization`.
- [ ] Update LAT; commit `feat: complete organization lifecycle services`.

## Task 7: Expose Strict Authenticated HTTP and Wire the Cloud Process

**Repository:** `/Users/zizimutou/Desktop/aera/aera-cloud`

**Consumes:** complete Organization service.

**Produces:** locked REST surface, access-token enforcement, stable errors, rate-limit wiring, published verification key.

**Files:**

- Create: `internal/organization/http.go`
- Create: `internal/organization/http_test.go`
- Modify: `internal/httpapi/server.go`
- Modify: `internal/httpapi/server_test.go`
- Modify: `cmd/aera-cloud/main.go`
- Modify: `cmd/aera-cloud/main_test.go`
- Modify: `internal/oauth/http_test.go`

**Steps:**

- [ ] Add handler tests for every route/method, bearer principal extraction, strict JSON/duplicate keys, exact UUIDs, body limit, page limit/cursor, idempotency header, expected revision/version, response projection, cache-control, and stable status/error code.
- [ ] Add server routing tests proving Organization routes reach only Organization handlers and do not shadow Workspace Agent routes or SPA fallback.
- [ ] Add main wiring tests for quotas, five limiter policies, audit, asset guard, signer, and `organization_policy` key publication.
- [ ] Implement `NewHandler`, `buildOrganizationHandler`, route mounts, and well-known key publication using the configured Agent-control key ring with the independent Organization signing domain.
- [ ] Run:

```bash
go test ./internal/organization ./internal/httpapi ./internal/oauth ./cmd/aera-cloud
```

- [ ] Update LAT; commit `feat: expose organization foundation api`.

## Task 8: Integrate Account Deletion and Bounded Maintenance

**Repository:** `/Users/zizimutou/Desktop/aera/aera-cloud`

**Consumes:** Organization persistence/lifecycle.

**Produces:** Owner deletion block, non-Owner cleanup, invitation/idempotency maintenance.

**Files:**

- Modify: `internal/account/model.go`
- Modify: `internal/account/lifecycle.go`
- Modify: `internal/account/lifecycle_test.go`
- Modify: `internal/account/lifecycle_repository.go`
- Modify: `internal/account/lifecycle_repository_test.go`
- Modify: `internal/account/http.go`
- Modify: `internal/account/http_test.go`
- Modify: `internal/jobs/postgres.go`
- Modify: `internal/jobs/postgres_test.go`

**Steps:**

- [ ] Add failing tests that block deletion request with `409 organization_owner_transfer_required` and only a safe owned count.
- [ ] Add finalization tests that remove non-Owner Membership/Department assignment, null nullable invitation actor references, anonymize audit identities, and preserve the Organization and other Members.
- [ ] Add maintenance tests for pending-invitation expiry and 24-hour Organization idempotency cleanup while retaining active dissolution replay until expiry.
- [ ] Implement repository/lifecycle/jobs changes in existing transactions.
- [ ] Run `go test ./internal/account ./internal/jobs`; update LAT; commit `feat: protect organization ownership lifecycle`.

## Task 9: Publish OpenAPI 0.3.0 and Pin the Desktop Contract

**Repositories:** cloud, then desktop.

**Consumes:** final HTTP shapes/errors.

**Produces:** authoritative OpenAPI and regenerated exact TypeScript schemas.

**Files:**

- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/api/openapi.yaml`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/api/openapi_test.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera/contracts/agentera-cloud.openapi.yaml`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/shared/agentera-cloud-api.generated.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/scripts/check-agentera-cloud-contract.mjs`
- Modify: `/Users/zizimutou/Desktop/aera/aera/tests/agentera-cloud-contract.test.ts`

**Steps:**

- [ ] Add cloud OpenAPI tests requiring every route, schema, stable error, idempotency header, strict `additionalProperties: false`, cursor bound, and `organization_policy` signing purpose.
- [ ] Add all exact request/response schemas and examples; run `go test ./api`.
- [ ] Copy the byte-identical OpenAPI file into the desktop contract and run `npm run generate:agentera-cloud`.
- [ ] Add desktop drift tests for Organization operations, safe Member projections, policy signatures, audit summaries, and forbidden private/runtime fields.
- [ ] Run:

```bash
go test ./api
npm test -- tests/agentera-cloud-contract.test.ts
npm run typecheck
```

- [ ] Commit cloud `docs: publish organization foundation contract`; commit desktop `chore: pin organization cloud contract`.

## Task 10: Build the Strict Desktop Organization Client and Policy Verifier

**Repository:** `/Users/zizimutou/Desktop/aera/aera`

**Consumes:** generated OpenAPI schemas and well-known signing keys.

**Produces:** main-process-only cloud client and verified policy snapshots.

**Files:**

- Create: `src/shared/agentera-organization.ts`
- Create: `src/main/agentera-organization/client.ts`
- Create: `src/main/agentera-organization/client.test.ts`
- Create: `src/main/agentera-organization/policy-verifier.ts`
- Create: `src/main/agentera-organization/policy-verifier.test.ts`

**Client contract:** methods correspond one-to-one with the locked HTTP surface. It injects bearer and idempotency headers in main, never accepts them from the renderer, validates every response with generated schemas plus exact runtime checks, bounds error envelopes, and discards raw response bodies.

The verifier accepts only purpose `organization_policy`, issuer equal to configured cloud origin, Ed25519, schema 1, canonical document/digest match, exact Organization/snapshot/version signature payload, and a currently published key. Verification failure returns a bounded code and cannot produce a cacheable snapshot.

**Steps:**

- [ ] Write failing client tests for each method, exact route/body/header, pagination, unknown response keys, malformed UUID/time/digest/signature, oversized body, and redacted errors.
- [ ] Write failing verifier tests for valid fixture, wrong purpose/issuer/key/schema/digest/signature, stale key set, and canonicalization mismatch.
- [ ] Implement strict parsers/client/verifier and run focused Vitest files.
- [ ] Run `npm run typecheck`; update LAT; commit `feat: add strict organization cloud client`.

## Task 11: Add the Account-Partitioned Organization Cache

**Repository:** `/Users/zizimutou/Desktop/aera/aera`

**Consumes:** safe Organization DTOs and verified policies.

**Produces:** `userData/agentera-organization/organization.db` with account isolation and stale metadata.

**Files:**

- Create: `src/main/agentera-organization/db.ts`
- Create: `src/main/agentera-organization/db.test.ts`

**Cache contract:**

```text
organization_summaries(account_user_id, organization_id, json, refreshed_at)
organization_members(account_user_id, organization_id, user_id, json, refreshed_at)
organization_departments(account_user_id, organization_id, department_id, json, refreshed_at)
organization_invitations(account_user_id, organization_id, invitation_id, json, refreshed_at)
organization_policies(account_user_id, organization_id, snapshot_id, policy_version, json, verified_at, current)
organization_mutation_intents(account_user_id, operation, resource_id, idempotency_key, request_digest, created_at)
```

There is no audit table and no raw invitation token/digest column. The database path is absolute, mode-restricted, outside `HERMES_HOME`, and every query includes `account_user_id`.

**Steps:**

- [ ] Add failing path/schema tests, two-account isolation tests, replacement/pruning tests, verified-policy last-good retention tests, and forbidden-column/static-content tests.
- [ ] Implement schema version 1, exact readers/writers, transaction replacement, account purge, and close semantics.
- [ ] Run `npm test -- src/main/agentera-organization/db.test.ts`; update LAT; commit `feat: cache organization metadata safely`.

## Task 12: Implement Organization State, Invitation Handoff, and Offline Rules

**Repository:** `/Users/zizimutou/Desktop/aera/aera`

**Consumes:** Tasks 10–11 and existing auth public state.

**Produces:** Organization manager, role-aware state, online mutations, stale read-only offline state, tagged volatile invitation.

**Files:**

- Create: `src/main/agentera-organization/deep-link.ts`
- Create: `src/main/agentera-organization/deep-link.test.ts`
- Create: `src/main/agentera-organization/manager.ts`
- Create: `src/main/agentera-organization/manager.test.ts`
- Modify: `src/main/index.ts`

**Steps:**

- [ ] Add exact deep-link tests for only `agentera://organization-invitation#TOKEN`; reject credentials, ports, path/query, percent-encoded non-canonical forms, malformed base64url, and every alternate host/scheme.
- [ ] Generalize the existing single-instance invitation inbox into a tagged volatile `workspace|organization` union and prove newer valid input replaces an unaccepted token without disk/log persistence.
- [ ] Add manager tests for authenticated refresh, offline cache, stale label/time, no offline mutation queue, role-specific fetches, account generation cancellation, previous valid policy retention, authoritative removal, and safe idempotent retry.
- [ ] Implement state/mutations and run focused tests plus `tests/agentera-workspace-ipc.test.ts` to prove Workspace handoff remains intact.
- [ ] Update LAT; commit `feat: manage organization desktop state`.

## Task 13: Make Product-Space Selection a Single Trusted Source

**Repository:** `/Users/zizimutou/Desktop/aera/aera`

**Consumes:** Workspace manager summaries, Organization manager summaries, authenticated account.

**Produces:** sole Personal/Workspace/Organization selection store and trusted Agent context adapter.

**Files:**

- Create: `src/shared/agentera-product-space.ts`
- Create: `src/main/agentera-product-space/db.ts`
- Create: `src/main/agentera-product-space/db.test.ts`
- Create: `src/main/agentera-product-space/manager.ts`
- Create: `src/main/agentera-product-space/manager.test.ts`
- Create: `src/main/agentera-product-space/ipc-contract.ts`
- Create: `src/main/agentera-product-space/ipc-contract.test.ts`
- Modify: `src/main/agentera-workspace/db.ts`
- Modify: `src/main/agentera-workspace/manager.ts`
- Modify: `src/main/agentera-workspace/manager.test.ts`
- Modify: `src/shared/agentera-agent-control.ts`
- Modify: `src/main/agentera-agent-control/manager.ts`
- Modify: `src/main/agentera-agent-control/manager.test.ts`

**Trusted context:**

```ts
type ProductSpaceSelection =
  | { kind: "PERSONAL" }
  | { kind: "WORKSPACE"; workspaceId: string; role: "owner" | "admin" | "member" }
  | { kind: "ORGANIZATION"; organizationId: string; role: "owner" | "admin" | "auditor" | "member" };
```

The store at `userData/agentera-product-space/space.db` imports one valid old Workspace selection once, then is the only writer. Archived/removed scope falls back to Personal. Department IDs are never selections. Adapter output is USER, WORKSPACE, or an explicit Organization-unavailable context that yields `organization_agent_not_enabled`; it never maps Organization to USER.

**Steps:**

- [ ] Write failing DB migration tests for Personal and valid/invalid old Workspace selections, account partition, one-time marker, and no dual write.
- [ ] Write manager tests for deterministic Personal → Workspace → Organization ordering, cached membership validation, stale async result rejection, selection fallback, one event, and no Department entries.
- [ ] Write AgentControl tests proving Organization context has zero personal/workspace drafts/installations and every Agent mutation returns `organization_agent_not_enabled` without touching draft/profile/runtime stores.
- [ ] Implement the coordinator and remove Workspace selection writes after migration.
- [ ] Run focused tests and existing Workspace/AgentControl suites; update LAT; commit `feat: centralize product space selection`.

## Task 14: Wire Exact IPC, Preload, Startup, and Access Guards

**Repository:** `/Users/zizimutou/Desktop/aera/aera`

**Consumes:** Organization and product-space managers.

**Produces:** renderer-safe `window.agenteraOrganization` and `window.agenteraProductSpace`, startup/account lifecycle integration.

**Files:**

- Create/modify: `src/main/agentera-organization/ipc-contract.ts`
- Create/modify: `src/main/agentera-organization/ipc-contract.test.ts`
- Modify: `src/main/app/start.ts`
- Modify: `src/main/ipc/register.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/preload/index.d.ts`
- Modify: `tests/preload-api-surface.test.ts`
- Modify: `tests/agentera-workspace-ipc.test.ts`
- Modify: `tests/agentera-agent-control-ipc.test.ts`

**Steps:**

- [ ] Add contract tests that reject unknown keys, actor/role/cloud/token/path/Profile fields, invalid revisions/enums/confirmations, and unsafe outputs.
- [ ] Add preload-surface tests for exact method allowlists and event unsubscribe semantics.
- [ ] Add startup tests proving Organization and product-space databases/managers open under `userData`, close on shutdown/account change, reject late results, and replace `getSelectedAgentContext` subscription with the coordinator.
- [ ] Add static guards proving Organization IPC never imports Profile, Memory, session, Skill mutation, Curator, Runtime distribution, RuntimeBinding ownership, legacy sync, or Gateway restart modules.
- [ ] Implement IPC/preload/start wiring and run:

```bash
npm test -- src/main/agentera-organization src/main/agentera-product-space tests/preload-api-surface.test.ts tests/agentera-workspace-ipc.test.ts tests/agentera-agent-control-ipc.test.ts
npm run typecheck
```

- [ ] Update LAT; commit `feat: expose trusted organization desktop bridge`.

## Task 15: Add Global Switcher, Organization Management, and Explicit Agent Unavailable UI

**Repository:** `/Users/zizimutou/Desktop/aera/aera`

**Consumes:** exact preload APIs and public state.

**Produces:** approved global top switcher and role-aware enterprise management surface.

**Files:**

- Create: `src/renderer/src/screens/Layout/ProductSpaceSwitcher.tsx`
- Create: `src/renderer/src/screens/Layout/ProductSpaceSwitcher.test.tsx`
- Create: `src/renderer/src/screens/Layout/OrganizationManagementDialog.tsx`
- Create: `src/renderer/src/screens/Layout/OrganizationManagementDialog.test.tsx`
- Create: `src/renderer/src/components/OrganizationInvitationGate.tsx`
- Create: `src/renderer/src/components/OrganizationInvitationGate.test.tsx`
- Create: `src/shared/i18n/locales/organization.ts`
- Modify: `src/renderer/src/screens/Layout/Layout.tsx`
- Delete: `src/renderer/src/screens/Layout/WorkspaceSwitcher.tsx`
- Delete: `src/renderer/src/screens/Layout/WorkspaceSwitcher.test.tsx`
- Modify: `src/renderer/src/screens/Agents/AgentControlPanel.tsx`
- Modify: `src/renderer/src/screens/Agents/AgentControlPanel.test.tsx`
- Modify: `src/renderer/src/App.tsx`
- Modify: `src/renderer/src/App.test.tsx`
- Modify: `src/shared/i18n/locales/{en,ar,es,he,id,ja,pl,pt-BR,pt-PT,tr,zh-CN,zh-TW}/navigation.ts`

**Steps:**

- [ ] Add switcher tests for brand-adjacent placement, distinct Personal/Workspace/Organization groups, deterministic sort, archived exclusion, Department absence, offline stale display, selection errors, and management affordances.
- [ ] Add management tests for role matrix, overview/members/Departments/invitations/policy/audit, exact high-risk confirmations, secret-once copy, offline read-only behavior, dialog invalidation on selection/account/role changes, and no renderer authority fields.
- [ ] Add invitation-gate tests for sign-in/offline retention, accept/dismiss, token disappearance, and no DOM/local/session storage persistence after completion.
- [ ] Add Agent panel test for explicit `organization_agent_not_enabled` explanation and absence of personal/workspace draft/install controls while Organization is selected.
- [ ] Implement UI/i18n with renderer checks as presentation only; run focused component tests and typecheck.
- [ ] Update LAT; commit `feat: add organization product space experience`.

## Task 16: Prove Multi-Account E2E and the Hermes Compatibility Boundary

**Repositories:** desktop and cloud; Runtime read-only.

**Consumes:** completed vertical slice.

**Produces:** deterministic end-to-end evidence, static/dynamic isolation gates, full-suite evidence.

**Files:**

- Create: `tests/e2e/agentera-organization.e2e.ts`
- Create: `tests/agentera-organization-boundary.test.ts`
- Create: `tests/agentera-product-space-boundary.test.ts`
- Modify: `package.json`
- Modify: `lat.md/agentera-organizations.md`
- Modify: `lat.md/agentera-workspaces.md`

**Deterministic flow:**

```text
Owner creates Organization and Department
→ creates one-time invitation
→ second account accepts as Member
→ Owner assigns Department and promotes second account to Admin
→ Admin invites third account and changes it to Auditor
→ Admin publishes policy V2
→ Auditor reads policy history and audit
→ Owner transfers ownership to Admin
→ new Owner archives and restores
→ other members leave or are removed
→ Departments are emptied and archived
→ new Owner archives and safely dissolves
```

Before and after each action, hash a populated Hermes Profile tree and snapshot selected Profile, active conversation/session, RuntimeBinding, Memory/USER, learned Skills, Curator state, and Runtime/Gateway process identity. Every hash and identity must remain unchanged.

**Steps:**

- [ ] Build a strict local cloud fixture that rejects unexpected routes, headers, actor fields, duplicate effects, token persistence, unsafe policy, and unauthorized calls.
- [ ] Implement the three-account desktop E2E and assert exact control-plane results and role transitions.
- [ ] Implement boundary scans that forbid new Organization/product-space imports into Hermes/private/runtime mutation paths and forbid private/runtime identifiers in cloud/OpenAPI/cache/IPC.
- [ ] Run focused proof:

```bash
npm test -- tests/agentera-organization-boundary.test.ts tests/agentera-product-space-boundary.test.ts
npm run test:e2e:organization
```

- [ ] Run complete cloud verification:

```bash
go test ./...
```

- [ ] Run complete desktop verification:

```bash
npm test
npm run typecheck
npm run build
npx --yes lat.md check
```

- [ ] Verify Runtime immutability:

```bash
git -C /Users/zizimutou/Desktop/aera/aera-runtime status --short
git -C /Users/zizimutou/Desktop/aera/aera-runtime rev-parse HEAD
```

Expected: empty status and unchanged `c0439e1e3e5f` abbreviated commit identity.

- [ ] Commit final desktop proof/docs: `test: verify organization foundation isolation`.

## Final Local Integration and Completion Gate

- [ ] Invoke `superpowers:verification-before-completion`; rerun fresh full commands and retain exact outputs.
- [ ] Invoke `superpowers:requesting-code-review`; review both complete branch diffs against the approved design and this plan. Fix findings with red tests.
- [ ] Confirm both feature branches are clean and contain only Organization Foundation V1 changes.
- [ ] Merge cloud branch into local cloud `main` with a non-fast-forward local merge; rerun `go test ./...` on merged `main`.
- [ ] Merge desktop branch into local desktop `main` with a non-fast-forward local merge; rerun `npm test`, `npm run typecheck`, `npm run build`, and `npx --yes lat.md check` on merged `main`.
- [ ] Confirm `aera-runtime` remains clean and unchanged.
- [ ] Report exact local main commits, ahead counts, clean/dirty state, test evidence, and the explicit facts that nothing was pushed or deployed.
- [ ] Stop at this checkpoint. Organization Agent V1 receives a separate approved design/plan before adding `owner_scope=ORGANIZATION`.
