# AgentEra Workspace Agent V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Workspace Owner/Admin publish immutable Workspace Agent versions and let every active member install them into a distinct USER-owned local Hermes Profile without sharing runtime or adaptive data.

**Architecture:** Extend the existing cloud Agent control plane with a Workspace asset-owner context and nested Workspace Agent routes. Keep installations, policy snapshots, RuntimeBindings, physical Profiles, and Hermes learning USER-owned. On desktop, derive the Agent context from the trusted Workspace manager, partition local drafts/installations/version cache by account and Workspace source, and reuse the verified read-only version projection.

**Tech Stack:** Go 1.26, chi, pgx/PostgreSQL 17, OpenAPI 3.1, Electron 39, TypeScript 5.9, React 19, `better-sqlite3`, Vitest 4, Playwright 1.60, and the existing Hermes Runtime.

## Global Constraints

- The authoritative design is `docs/superpowers/specs/2026-07-20-agentera-workspace-agent-v1-design.md`.
- Execute in the current main Codex session without subagents.
- Cloud branch is `aera/workspace-agent-v1` based on Workspace Foundation commit `34b5f6e`; desktop branch is `aera/workspace-agent-v1` based on Foundation commit `793db33` plus design commits `906d0de` and `c7d36f8`.
- Do not edit or branch `/Users/zizimutou/Desktop/aera/aera-runtime`.
- Do not merge, push, deploy, publish a Runtime, or alter production configuration.
- `owner_scope=WORKSPACE` applies only to AgentDefinition and AgentVersion assets. Installation, policy, RuntimeBinding, Profile binding, and private adaptive state stay USER-owned.
- No Workspace Agent code may read, upload, cache, enumerate, or mutate `MEMORY.md`, `USER.md`, conversations, credentials, local files, writable local Skills, Curator state, or physical Profile paths.
- Renderer IPC never accepts an actor, role, `owner_scope`, `tenant_id`, `owner_id`, Workspace ID for Agent operations, cloud URL, token, database path, or Profile path.
- Existing USER Agent API behavior and existing installed USER Agents remain compatible.
- Every production change follows RED, verified RED, minimal GREEN, verified GREEN, then refactor.
- Before each commit run `git diff --check` and inspect `git status --short`.
- Update `lat.md/agentera-agent-control-plane.md`, `lat.md/agentera-workspaces.md`, and the matching test-spec sections; finish with `npx --yes lat.md check`.

---

### Task 1: Add Scope-Aware Cloud Persistence

**Repository:** `/Users/zizimutou/Desktop/aera/aera-cloud`

**Files:**

- Create: `migrations/000010_workspace_agent_scope.sql`
- Modify: `internal/store/migrate_test.go`
- Modify: `internal/agentcontrol/model.go`
- Create: `internal/agentcontrol/model_test.go`

**Interfaces:**

- Produces `OwnerScopeWorkspace` and `AssetOwner` for later repository/service tasks.
- Preserves every USER-only installation/policy/runtime-binding table and constraint.

```go
type OwnerScope string

const (
    OwnerScopeUser      OwnerScope = "USER"
    OwnerScopeWorkspace OwnerScope = "WORKSPACE"
)

type AssetOwner struct {
    Scope           OwnerScope
    PersonalSpaceID uuid.UUID
    UserID          uuid.UUID
    WorkspaceID     uuid.UUID
}
```

- [ ] **Step 1: Write the failing migration/model tests**

Extend the migration assertions to require ten migrations, `workspace_id` on `agent_definitions`, `agent_versions`, and `agent_control_idempotency_keys`, nullable USER owner columns on those tables, scope-variant checks, Workspace foreign keys, and separate USER/WORKSPACE idempotency unique indexes. Add model cases for valid USER and WORKSPACE owners plus invalid mixed/nil variants.

```go
func TestAssetOwnerValidation(t *testing.T) {
    workspaceID := uuid.New()
    if err := (AssetOwner{Scope: OwnerScopeWorkspace, WorkspaceID: workspaceID}).Validate(); err != nil {
        t.Fatalf("workspace owner: %v", err)
    }
    if err := (AssetOwner{Scope: OwnerScopeWorkspace, WorkspaceID: workspaceID, UserID: uuid.New()}).Validate(); err == nil {
        t.Fatal("mixed owner was accepted")
    }
}
```

- [ ] **Step 2: Run RED**

Run: `go test -count=1 ./internal/agentcontrol ./internal/store`

Expected: FAIL because migration 10 and `AssetOwner` do not exist.

- [ ] **Step 3: Implement the migration and model**

The migration must:

```sql
ALTER TABLE agent_definitions ADD COLUMN workspace_id UUID REFERENCES workspaces(id) ON DELETE RESTRICT;
ALTER TABLE agent_definitions ALTER COLUMN tenant_id DROP NOT NULL;
ALTER TABLE agent_definitions ALTER COLUMN owner_id DROP NOT NULL;
ALTER TABLE agent_definitions DROP CONSTRAINT agent_definitions_owner_scope_check;
ALTER TABLE agent_definitions ADD CONSTRAINT agent_definitions_owner_variant_check CHECK (
  (owner_scope = 'USER' AND tenant_id IS NOT NULL AND owner_id IS NOT NULL AND workspace_id IS NULL)
  OR
  (owner_scope = 'WORKSPACE' AND tenant_id IS NULL AND owner_id IS NULL AND workspace_id IS NOT NULL)
);
```

Apply the same ownership variant to `agent_versions` and `agent_control_idempotency_keys`. Replace the old idempotency unique constraint with partial USER and WORKSPACE unique indexes. Keep `agent_version_revocations`, `installations`, `policy_snapshots`, and `runtime_binding_records` USER-only.

- [ ] **Step 4: Run GREEN and integration migration gate**

Run:

```bash
go test -count=1 ./internal/agentcontrol ./internal/store
set -a; source .env.example; set +a
AERA_INTEGRATION_TESTS=1 go test -p 1 -count=1 ./internal/store
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add migrations/000010_workspace_agent_scope.sql internal/store/migrate_test.go internal/agentcontrol/model.go internal/agentcontrol/model_test.go
git commit -m "feat: add Workspace Agent asset ownership"
```

### Task 2: Enforce Workspace Publication and Installation Authorization

**Repository:** `/Users/zizimutou/Desktop/aera/aera-cloud`

**Files:**

- Modify: `internal/agentcontrol/repository.go`
- Modify: `internal/agentcontrol/repository_test.go`
- Modify: `internal/agentcontrol/service.go`
- Modify: `internal/agentcontrol/service_test.go`

**Interfaces:**

```go
type WorkspacePublicationRequest struct {
    WorkspaceID uuid.UUID
    PublishInitialRequest
}

type WorkspaceNextPublicationRequest struct {
    WorkspaceID uuid.UUID
    PublishNextRequest
}

type CreateInstallationRequest struct {
    DefinitionID     uuid.UUID
    VersionID        uuid.UUID
    SourceWorkspaceID *uuid.UUID
    IdempotencyKey   string
    RequestID        string
}
```

Repository additions expose Workspace-specific list/read/publish methods while existing USER methods keep their signatures. Shared private helpers accept `AssetOwner` and an exact access mode (`read`, `publish`, or `install`).

- [ ] **Step 1: Write failing service tests**

Add table tests proving Owner/Admin publish, Member receives `ErrWorkspaceForbidden`, outsider receives `ErrNotFound`, archived returns `ErrWorkspaceArchived`, and Owner-unavailable returns `ErrWorkspaceOwnerUnavailable`. Add installation cases requiring exact `SourceWorkspaceID` for a Workspace definition.

```go
func TestPublishWorkspaceInitialRequiresAuthorRole(t *testing.T) {
    for _, role := range []string{"owner", "admin"} {
        t.Run(role, func(t *testing.T) {
            repository := newWorkspaceAgentRepository(role)
            service := newAgentService(t, repository)
            _, err := service.PublishWorkspaceInitial(context.Background(), principal(), workspaceID, validInitialRequest())
            if err != nil { t.Fatal(err) }
        })
    }
}
```

- [ ] **Step 2: Run RED**

Run: `go test -count=1 ./internal/agentcontrol`

Expected: FAIL on missing Workspace methods and source binding.

- [ ] **Step 3: Implement transactional authorization**

Every Workspace repository transaction locks the Workspace and actor membership, then enforces:

```sql
SELECT w.status,
       CASE WHEN owner.status = 'active' THEN 'writable' ELSE 'owner_unavailable' END,
       membership.role
FROM workspaces w
JOIN workspace_memberships membership
  ON membership.workspace_id = w.id AND membership.user_id = $actor_user_id
JOIN users owner ON owner.id = w.owner_user_id
WHERE w.id = $workspace_id
FOR UPDATE OF w, membership;
```

Publish accepts only `owner|admin`; discovery and installation accept all three roles. USER installations are inserted with the principal's existing USER tuple even when their definition/version rows have WORKSPACE ownership. Version selection must join through the installation's definition and re-check current Workspace access when the definition is Workspace-owned.

- [ ] **Step 4: Run GREEN plus PostgreSQL integration cases**

Run:

```bash
go test -count=1 ./internal/agentcontrol
set -a; source .env.example; set +a
AERA_INTEGRATION_TESTS=1 go test -p 1 -count=1 ./internal/agentcontrol
```

Expected: PASS, including two users installing the same Workspace version into distinct USER installations.

- [ ] **Step 5: Commit**

```bash
git add internal/agentcontrol/repository.go internal/agentcontrol/repository_test.go internal/agentcontrol/service.go internal/agentcontrol/service_test.go
git commit -m "feat: authorize Workspace Agent publication"
```

### Task 3: Publish the Workspace Agent HTTP Contract

**Repository:** `/Users/zizimutou/Desktop/aera/aera-cloud`

**Files:**

- Modify: `internal/agentcontrol/http.go`
- Modify: `internal/agentcontrol/http_test.go`
- Modify: `internal/httpapi/server.go`
- Modify: `internal/httpapi/server_test.go`
- Modify: `api/openapi.yaml`
- Modify: `api/openapi_test.go`

**Produces:** the five nested routes in the design and optional `workspace_id` on `CreateAgentInstallationRequest`.

- [ ] **Step 1: Write failing HTTP and routing tests**

Tests must prove exact path parsing, auth-derived actor, no JSON ownership fields, Owner/Admin service dispatch, strict request decoding, error mapping, and that nested Agent paths reach AgentControl instead of the general Workspace handler.

```go
request := httptest.NewRequest(http.MethodGet,
    "/api/v1/workspaces/"+workspaceID.String()+"/agent-definitions", nil)
handler.ServeHTTP(response, request)
if agentCalls != 1 || workspaceCalls != 0 { t.Fatal("nested route misrouted") }
```

- [ ] **Step 2: Run RED**

Run: `go test -count=1 ./internal/agentcontrol ./internal/httpapi ./api`

Expected: FAIL because nested routes are not mounted or documented.

- [ ] **Step 3: Implement routes and OpenAPI**

Mount before the general Workspace wildcard:

```go
router.Handle("/api/v1/workspaces/{workspaceID}/agent-definitions", dependencies.AgentControl)
router.Handle("/api/v1/workspaces/{workspaceID}/agent-definitions/*", dependencies.AgentControl)
```

Add the exact nested operations and extend installation JSON with only:

```yaml
workspace_id:
  type: string
  format: uuid
  description: Exact source Workspace for a WORKSPACE-owned definition; omitted for USER-owned definitions.
```

- [ ] **Step 4: Run GREEN and full cloud unit gate**

Run: `go test -count=1 ./...`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/agentcontrol/http.go internal/agentcontrol/http_test.go internal/httpapi/server.go internal/httpapi/server_test.go api/openapi.yaml api/openapi_test.go
git commit -m "feat: expose Workspace Agent API"
```

### Task 4: Migrate Desktop Context and Version Cache Storage

**Repository:** `/Users/zizimutou/Desktop/aera/aera`

**Files:**

- Modify: `contracts/agentera-cloud.openapi.yaml`
- Modify: `src/shared/agentera-cloud-api.generated.ts`
- Modify: `scripts/check-agentera-cloud-contract.mjs`
- Modify: `src/main/agentera-agent-control/db.ts`
- Modify: `tests/agentera-agent-control-db.test.ts`
- Modify: `src/main/agentera-agent-control/version-cache.ts`
- Modify: `src/main/agentera-agent-control/version-cache.test.ts`
- Modify: `src/main/agentera-agent-control/draft-store.ts`
- Modify: `tests/agentera-agent-drafts.test.ts`
- Modify: `src/main/agentera-agent-control/installation-manager.ts`
- Modify: `src/main/agentera-agent-control/installation-manager.test.ts`

**Interfaces:**

```ts
export type AgentAssetContext =
  | { scope: "USER" }
  | { scope: "WORKSPACE"; workspaceId: string; role: "owner" | "admin" | "member" };

export interface LocalAgentInstallation {
  sourceScope: "USER" | "WORKSPACE";
  sourceWorkspaceId: string | null;
  // existing fields unchanged
}
```

- [ ] **Step 1: Pin/regenerate the cloud contract and write RED schema/cache tests**

Copy the exact cloud OpenAPI document, run `npm run generate:agentera-cloud`, then add tests that expect schema version 3, preserved v2 rows, target/source columns, composite cached-version ownership, and distinct filesystem paths for two owners caching one version ID.

- [ ] **Step 2: Run RED**

Run:

```bash
npx vitest run tests/agentera-agent-control-db.test.ts src/main/agentera-agent-control/version-cache.test.ts tests/agentera-agent-drafts.test.ts src/main/agentera-agent-control/installation-manager.test.ts
```

Expected: FAIL on schema v2/global cache path/missing context fields.

- [ ] **Step 3: Implement SQLite v3 and account paths**

Rebuild `cached_agent_versions` with primary key `(tenant_id, owner_id, version_id)`. Preserve old relative paths and write new entries as:

```text
accounts/<tenant_id>/<owner_id>/<version_id>/<content_digest>
```

Add exact variant checks:

```sql
CHECK ((target_scope = 'USER' AND workspace_id IS NULL)
    OR (target_scope = 'WORKSPACE' AND workspace_id IS NOT NULL))
```

Installation runtime lookup remains by USER/account/device and installation ID; only renderer list filtering uses the new source context.

- [ ] **Step 4: Run GREEN, contract hash, and owner-isolation regression**

Run:

```bash
npm run check:agentera-cloud-contract
npx vitest run tests/agentera-agent-control-db.test.ts src/main/agentera-agent-control/version-cache.test.ts tests/agentera-agent-drafts.test.ts src/main/agentera-agent-control/installation-manager.test.ts tests/agentera-agent-owner-isolation.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add contracts/agentera-cloud.openapi.yaml src/shared/agentera-cloud-api.generated.ts src/main/agentera-agent-control/db.ts tests/agentera-agent-control-db.test.ts src/main/agentera-agent-control/version-cache.ts src/main/agentera-agent-control/version-cache.test.ts src/main/agentera-agent-control/draft-store.ts tests/agentera-agent-drafts.test.ts src/main/agentera-agent-control/installation-manager.ts src/main/agentera-agent-control/installation-manager.test.ts scripts/check-agentera-cloud-contract.mjs
git commit -m "feat: partition Workspace Agent local state"
```

### Task 5: Connect Trusted Workspace Context to Agent Operations

**Repository:** `/Users/zizimutou/Desktop/aera/aera`

**Files:**

- Modify: `src/main/agentera-workspace/manager.ts`
- Modify: `src/main/agentera-workspace/manager.test.ts`
- Modify: `src/main/agentera-agent-control/client.ts`
- Modify: `src/main/agentera-agent-control/client.test.ts`
- Modify: `src/main/agentera-agent-control/publisher.ts`
- Modify: `src/main/agentera-agent-control/publisher.test.ts`
- Modify: `src/main/agentera-agent-control/manager.ts`
- Modify: `tests/agentera-agent-owner-isolation.test.ts`
- Modify: `src/main/app/start.ts`

**Interfaces:**

```ts
getSelectedAgentContext(): AgentAssetContext;
subscribeSelectedAgentContext(listener: () => void): () => void;
```

Workspace client methods use nested paths; publication preview target becomes `"USER" | "WORKSPACE"` but contains no Workspace ID. Installation client adds `workspace_id` only from trusted context.

- [ ] **Step 1: Write RED client/publisher/manager tests**

Prove nested path generation, Member publication denial before upload, Owner/Admin workspace publication, selected-context definition discovery, no renderer-supplied scope, context-keyed drafts, source-filtered installations, and selection-change refresh without Profile/RuntimeBinding calls.

- [ ] **Step 2: Run RED**

Run:

```bash
npx vitest run src/main/agentera-workspace/manager.test.ts src/main/agentera-agent-control/client.test.ts src/main/agentera-agent-control/publisher.test.ts tests/agentera-agent-owner-isolation.test.ts tests/agentera-agent-control-ipc.test.ts
```

Expected: FAIL on missing trusted context APIs.

- [ ] **Step 3: Implement minimal context components**

Keep runtime components keyed only by USER/device. Rebuild only draft/publisher/discovery context when the Workspace selection changes. Do not import Workspace context into `hermes-adapter.ts`, `runtime-binding-store.ts`, `hermes-projection.ts`, Profile binding, sessions, Skills, or Curator.

- [ ] **Step 4: Run GREEN and Hermes-focused regression**

Run:

```bash
npx vitest run src/main/agentera-workspace/manager.test.ts src/main/agentera-agent-control src/main/agentera-workspace tests/agentera-agent-owner-isolation.test.ts tests/agentera-agent-control-ipc.test.ts tests/agentera-runtime-binding.test.ts tests/agentera-hermes-control-plane-compat.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/agentera-workspace/manager.ts src/main/agentera-workspace/manager.test.ts src/main/agentera-agent-control/client.ts src/main/agentera-agent-control/client.test.ts src/main/agentera-agent-control/publisher.ts src/main/agentera-agent-control/publisher.test.ts src/main/agentera-agent-control/manager.ts tests/agentera-agent-owner-isolation.test.ts src/main/app/start.ts
git commit -m "feat: connect Workspace Agent context"
```

### Task 6: Add Role-Aware Workspace Agent UI

**Repository:** `/Users/zizimutou/Desktop/aera/aera`

**Files:**

- Modify: `src/shared/agentera-agent-control.ts`
- Modify: `src/renderer/src/screens/Agents/AgentControlPanel.tsx`
- Modify: `src/renderer/src/screens/Agents/AgentControlPanel.test.tsx`
- Modify: `src/renderer/src/screens/Agents/AgentDraftEditor.tsx`
- Modify: `src/renderer/src/screens/Agents/AgentDraftEditor.test.tsx`
- Modify: `src/shared/i18n/locales/en/agents.ts`
- Modify: `src/shared/i18n/locales/ar/agents.ts`
- Modify: `src/shared/i18n/locales/es/agents.ts`
- Modify: `src/shared/i18n/locales/he/agents.ts`
- Modify: `src/shared/i18n/locales/id/agents.ts`
- Modify: `src/shared/i18n/locales/ja/agents.ts`
- Modify: `src/shared/i18n/locales/pl/agents.ts`
- Modify: `src/shared/i18n/locales/pt-BR/agents.ts`
- Modify: `src/shared/i18n/locales/pt-PT/agents.ts`
- Modify: `src/shared/i18n/locales/tr/agents.ts`
- Modify: `src/shared/i18n/locales/zh-CN/agents.ts`
- Modify: `src/shared/i18n/locales/zh-TW/agents.ts`

**Produces:** Personal behavior unchanged; Workspace Owner/Admin author UI; Member install-only UI; offline Workspace drafts read-only.

- [ ] **Step 1: Write RED renderer tests**

Tests must cover Personal, Workspace Owner, Admin, Member, offline, archived/owner-unavailable errors, selection changes, and the absence of Workspace IDs in every `window.agenteraAgents` mutation call.

- [ ] **Step 2: Run RED**

Run:

```bash
npx vitest run src/renderer/src/screens/Agents/AgentControlPanel.test.tsx src/renderer/src/screens/Agents/AgentDraftEditor.test.tsx
```

Expected: FAIL on personal-only copy and unconditional author controls.

- [ ] **Step 3: Implement role-aware presentation**

Use `AgenteraAgentControlPublicState.context` returned by main. Do not read Workspace state independently in the Agent screen and do not make authorization decisions from renderer-only state. Cloud remains final authority.

- [ ] **Step 4: Run GREEN plus renderer regression**

Run:

```bash
npx vitest run src/renderer/src/screens/Agents/AgentControlPanel.test.tsx src/renderer/src/screens/Agents/AgentDraftEditor.test.tsx src/renderer/src/screens/Agents/Agents.test.tsx src/renderer/src/screens/Layout/WorkspaceSwitcher.test.tsx
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/agentera-agent-control.ts src/renderer/src/screens/Agents/AgentControlPanel.tsx src/renderer/src/screens/Agents/AgentControlPanel.test.tsx src/renderer/src/screens/Agents/AgentDraftEditor.tsx src/renderer/src/screens/Agents/AgentDraftEditor.test.tsx src/shared/i18n/locales/*/agents.ts
git commit -m "feat: present Workspace Agent roles"
```

### Task 7: Prove the Workspace Agent and Hermes Boundary

**Repositories:** both feature branches; no Runtime edit.

**Files:**

- Create: `tests/e2e/agentera-workspace-agent.e2e.ts`
- Create: `tests/agentera-workspace-agent-boundary.test.ts`
- Modify: `package.json`
- Modify: `lat.md/agentera-agent-control-plane.md`
- Modify: `lat.md/agentera-workspaces.md`

- [ ] **Step 1: Write the failing boundary and E2E tests**

The boundary test allows Workspace context only in Agent manager/client/draft/publisher/UI files and rejects it from Hermes adapter, RuntimeBinding store, Profile binding, projection writes into private paths, session handling, Skills, Curator, Runtime distribution, and legacy `agent-sync.ts`.

The E2E scenario proves Owner v1 publish, Member install into a distinct Profile, Member-private learning, Owner/Admin v2 publish, manual Member update, existing conversation v1 stability, new conversation v2, account-isolated cache, and no private payloads.

- [ ] **Step 2: Run RED**

Run:

```bash
npx vitest run tests/agentera-workspace-agent-boundary.test.ts
npm run test:e2e:workspace-agent
```

Expected: FAIL until the gate and package script are wired.

- [ ] **Step 3: Wire the executable gate and LAT references**

Add `"test:e2e:workspace-agent": "npm run build && playwright test tests/e2e/agentera-workspace-agent.e2e.ts"` to `package.json` and add exact `@lat` test references for the new boundary and E2E sections. Do not change production code in this task. If the gate exposes a defect, return to the responsible earlier task, add a focused failing regression test there, implement its minimal fix, and create a separate scoped commit before rerunning this task.

- [ ] **Step 4: Run focused release gate**

Run:

```bash
npx vitest run src/main/agentera-agent-control src/main/agentera-workspace tests/agentera-agent-control-db.test.ts tests/agentera-agent-owner-isolation.test.ts tests/agentera-workspace-boundary.test.ts tests/agentera-workspace-agent-boundary.test.ts tests/agentera-runtime-binding.test.ts tests/agentera-hermes-control-plane-compat.test.ts
npm run test:e2e:workspace-agent
npx --yes lat.md check
```

Expected: PASS with no orphan Electron/Runtime processes.

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/agentera-workspace-agent.e2e.ts tests/agentera-workspace-agent-boundary.test.ts package.json lat.md/agentera-agent-control-plane.md lat.md/agentera-workspaces.md
git commit -m "test: prove Workspace Agent isolation"
```

### Task 8: Run Full Local Release Gates

**Repositories:** both feature branches.

- [ ] **Step 1: Cloud full verification**

```bash
go test -count=1 ./...
set -a; source .env.example; set +a
AERA_INTEGRATION_TESTS=1 go test -p 1 -count=1 ./...
cd web && npm test -- --run && npm run build && npx playwright test
```

- [ ] **Step 2: Desktop full verification**

```bash
npm run check:agentera-cloud-contract
npm test
npm run typecheck
npm run build
npm run test:e2e:agent-control
npm run test:e2e:workspace
npm run test:e2e:workspace-agent
npx --yes lat.md check
```

- [ ] **Step 3: Inspect repository and process state**

Run `git status --short --branch`, `git diff --check`, and a bounded process search for only test-owned Electron/dashboard/Runtime commands. Stop only processes created by this task.

- [ ] **Step 4: Record exact local heads**

Report both feature HEADs, local-main divergence, clean/dirty state, and unchanged `aera-runtime/main`. Do not merge or push.
