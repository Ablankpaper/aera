# AgentEra Official Managed Agent V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add PLATFORM-owned official Agent authoring, independent employee review, deterministic staged release, rollback, and USER-owned desktop installation without moving Hermes execution or private learning into Cloud.

**Architecture:** Extend the existing `aera-cloud/internal/agentcontrol` Definition, immutable Version, Installation, policy, signature, audit, and RuntimeBinding contracts with a strict PLATFORM asset variant and append-only OfficialRelease revisions. `aera-admin` remains the only employee surface and crosses the existing fail-closed mTLS plus service-JWT boundary; `aera` exposes only eligible catalog, fresh Profile installation, and locally verified managed selection for later conversations.

**Tech Stack:** Go 1.26.5, PostgreSQL/pgx, chi, OpenAPI 3.0, Ed25519, HMAC-SHA256, TypeScript 5.9, Electron 39, React 19, SQLite/better-sqlite3, Vitest 4, Playwright 1.60, npm for Desktop, and pnpm 11 for Admin web.

## Global Constraints

- The approved design at `docs/superpowers/specs/2026-07-22-agentera-official-managed-agent-v1-design.md` is authoritative.
- Implementation order is Cloud, then Admin, then Desktop, then one cross-repository acceptance gate.
- `owner_scope=PLATFORM` applies only to official Definition, review evidence, immutable Version, policy, and release records.
- Every Installation, physical Hermes Profile, policy overlay, RuntimeBinding, and adaptive state remains USER-owned.
- Every official Installation creates one new independently writable physical `HERMES_HOME` with `cloneFrom=null`; existing Profile claim is forbidden.
- Signed Knowledge, Skill, and SOP assets remain immutable, digest-verified, read-only, and outside `HERMES_HOME`.
- Memory, USER, sessions, conversations, credentials, private files, learned Skills, Curator, Profile paths, and local learning never enter Cloud or Admin.
- Developer submits; a different Super Admin reviews; Operator activates, changes rollout, pauses, resumes, and requests rollback; a different Super Admin approves rollback; Auditor is read-only; Support and Finance have no permission.
- Release channels are exactly `internal` and `stable`.
- Eligibility uses a versioned HMAC-SHA256 bucket, explicit allowlist, minimum desktop SemVer, and narrowing platform/context policy.
- Approval of v2 or later never mutates the current release head; Operator activation is required.
- Pause blocks new exposure, Installation, rollout expansion, and adoption by not-yet-installed users; it does not remotely disable an existing Installation.
- Managed update and rollback become usable only after local signature, digest, policy, cache, and projection verification and affect only later RuntimeBindings.
- Active conversations retain their original Version, Profile, policy, tools, and RuntimeBinding.
- Offline use continues from the last verified local version under the existing seven-day entitlement and never claims current Cloud rollout state.
- The public desktop API and Internal Admin API remain on different listeners and different OpenAPI documents.
- `aera-runtime` remains unchanged.
- V1 excludes telemetry training, automatic experience return, remote conversation termination, production deployment, production signing ceremony, and release publication.
- Work uses `aera/official-managed-agent-v1` in `aera-cloud`, `aera-admin`, and `aera`. Local merge, GitHub push, deployment, and release remain separate user-approved states.

---

## Repository and File Responsibility Map

### Cloud repository: `/Users/zizimutou/Desktop/aera/aera-cloud`

- `migrations/000016_official_managed_agent_v1.sql`: PLATFORM owner variant, draft/submission/review/policy/release tables, USER Installation provenance, managed selection, immutable guards, indexes, and Cloud Admin operation extensions.
- `internal/config/official_agent.go`: configured platform identity and rollout HMAC key ring.
- `internal/config/official_agent_test.go`: complete/partial/invalid official-Agent configuration tests.
- `internal/agentcontrol/model.go`: `OwnerScopePlatform` and exact `AssetOwner` variant.
- `internal/agentcontrol/platform_model.go`: official draft, submission, review, policy, release, audience, catalog, managed-target, actor, command, and error types.
- `internal/agentcontrol/platform_repository.go`: transactional PLATFORM persistence, immutable publication, release revisions, eligibility, and audit.
- `internal/agentcontrol/platform_service.go`: role gates, canonicalization, DLP, policy, signing, deterministic bucket, and command orchestration.
- `internal/agentcontrol/platform_http.go`: authenticated public catalog and managed-selection handlers.
- `internal/agentcontrol/repository.go`: PLATFORM-source USER Installation and RuntimeBinding provenance extensions.
- `internal/agentcontrol/service.go`: strict official Installation and effective-policy composition.
- `internal/agentcontrol/http.go`: public route registration and exact request/response union parsing.
- `internal/adminapi/auth.go`: signed employee actor claims and official action scopes.
- `internal/adminapi/official_agent.go`: Internal Admin route registration, strict DTOs, and operation responses.
- `cmd/aera-cloud/main.go` and `cmd/aera-cloud/internal_admin.go`: one shared Agent repository/service wired to both public and internal listeners.
- `api/openapi.yaml`: public official catalog, official Installation variant, and managed-update contract.
- `api/openapi/internal-admin.yaml`: employee draft/review/release/audit contract.
- `api/openapi_test.go` and `api/internal_admin_openapi_test.go`: public/internal separation and strict schema assertions.

### Admin repository: `/Users/zizimutou/Desktop/aera/aera-admin`

- `internal/store/migrations/000007_official_managed_agent_v1.sql`: official rollback approval/events plus typed outbox payload/digest, reason usage, and action constraints.
- `internal/rbac/rbac.go`: fixed official-Agent permissions for the six existing roles.
- `internal/cloudadmin/token.go`: short-lived service JWT with signed per-request employee actor claims.
- `internal/cloudadmin/official_agent.go`: strict internal Cloud official-Agent domain and client interface.
- `internal/cloudadmin/http_client.go`: exact Internal Admin routes and actor-bound requests.
- `internal/operations/model.go`, `repository.go`, `service.go`, and `worker.go`: typed canonical payload, official actions, dispatch, idempotency, and reconciliation.
- `internal/officialagent/model.go`: Admin-safe commands, pages, release forms, and rollback approval state.
- `internal/officialagent/repository.go`: rollback request/event persistence and execution status sink.
- `internal/officialagent/service.go`: Admin RBAC, safe Cloud reads, mutation enqueue, review separation, and rollback dual control.
- `internal/officialagent/http.go`: browser BFF routes and strict DTO/error mapping.
- `cmd/aera-admin/main.go`: service, handler, outbox worker, and route composition.
- `api/openapi/admin.yaml`: browser-facing official-Agent contract.
- `api/openapi/cloud-admin-client.yaml`: pinned Internal Admin client contract.
- `web/src/api/contracts.ts` and `web/src/api/client.ts`: safe official DTOs and methods.
- `web/src/pages/OfficialAgentsPage.tsx`: definitions, drafts, versions, and role-safe navigation.
- `web/src/pages/OfficialAgentEditorPage.tsx`: Developer draft editor, validation, submit, and withdrawal.
- `web/src/pages/OfficialAgentReviewsPage.tsx`: immutable submission review for Super Admin and read-only Auditor view.
- `web/src/pages/OfficialAgentReleasesPage.tsx`: Operator activation, rollout, pause/resume, rollback request, and Super Admin rollback approval.
- `web/src/app/router.tsx` and `web/src/layout/AdminLayout.tsx`: permission-gated routes/navigation.
- `e2e/official-agent.spec.ts`: real Admin process plus real Cloud Internal Admin acceptance.

### Desktop repository: `/Users/zizimutou/Desktop/aera/aera`

- `contracts/agentera-cloud.openapi.yaml`: pinned reviewed public Cloud contract.
- `src/shared/agentera-cloud-api.generated.ts`: deterministic generated TypeScript.
- `src/shared/agentera-agent-control.ts`: safe official catalog, Installation, managed-update, and error types.
- `src/main/agentera-agent-control/official-channel.ts`: packaged `stable` and development/test `internal` channel derivation.
- `src/main/agentera-agent-control/official-agent-service.ts`: catalog, one-use install handle, refresh, and managed-update orchestration.
- `src/main/agentera-agent-control/db.ts`: SQLite schema version 6 and strict PLATFORM-source USER Installation columns.
- `src/main/agentera-agent-control/client.ts`: strict public official catalog and managed-update client.
- `src/main/agentera-agent-control/installation-manager.ts`: fresh-only official materialization and idempotent managed selection.
- `src/main/agentera-agent-control/runtime-binding-store.ts`: optional official release-revision provenance in sanitized binding records.
- `src/main/agentera-agent-control/hermes-adapter.ts`: verified PLATFORM source resolution with unchanged local learning behavior.
- `src/main/agentera-agent-control/manager.ts`: trusted account/device/context/channel orchestration and offline fallback.
- `src/main/agentera-agent-control/ipc-contract.ts`, `src/main/ipc/register.ts`, `src/main/ipc/auth-guard.ts`, `src/preload/index.ts`, and `src/preload/index.d.ts`: renderer-safe official operations.
- `src/renderer/src/screens/Agents/OfficialAgentSection.tsx`: catalog, installed state, update readiness, channel, and safe denial reasons.
- `src/renderer/src/screens/Agents/OfficialAgentInstallDialog.tsx`: fresh Profile confirmation only.
- `src/renderer/src/screens/Agents/AgentControlPanel.tsx`: official section in Personal/Workspace/Organization contexts without a fourth product space.
- `src/shared/i18n/locales/ar/agents.ts`, `en/agents.ts`, `es/agents.ts`, `he/agents.ts`, `id/agents.ts`, `ja/agents.ts`, `pl/agents.ts`, `pt-BR/agents.ts`, `pt-PT/agents.ts`, `tr/agents.ts`, `zh-CN/agents.ts`, and `zh-TW/agents.ts`: complete localized copy.
- `tests/agentera-official-agent-boundary.test.ts`: static privacy, ownership, IPC, and legacy-sync isolation.
- `tests/e2e/agentera-official-managed-agent.e2e.ts`: v1, v2, rollback, pause, offline, Profile, RuntimeBinding, and privacy proof.
- `lat.md/agentera-agent-control-plane.md` and `lat.md/agentera-self-evolution.md`: implemented architecture and executable evidence.

## Cross-Task Interfaces and Invariants

Use these names and wire values exactly throughout the plan:

```text
PLATFORM AssetOwner:
  scope = PLATFORM
  platform_id = UUID
  personal_space_id = null
  user_id = null
  workspace_id = null
  organization_id = null

Official release:
  channel = internal | stable
  state = active | paused
  action = initial | activate | rollout_update | pause | resume | rollback
  rollout_basis_points = integer 0..10000
  bucket_algorithm_version = 1

User runtime:
  Installation owner_scope = USER
  source_scope = PLATFORM (derived from the referenced Definition/Version; not a second owner)
  update_policy = managed
  official_release_id and selected_release_revision_id are non-null
  RuntimeBinding owner_scope = USER

Official request context (trusted main-process input, Cloud-authorized):
  channel = internal | stable
  desktop_version = strict SemVer
  product_context = personal | workspace | organization
  product_context_id = null for personal; authorized Workspace/Organization UUID otherwise
```

The deterministic audience function is fixed:

```go
bucket := binary.BigEndian.Uint64(hmacSHA256(
    rolloutKey,
    []byte("1\x00"+releaseID.String()+"\x00"+userID.String()),
)[:8]) % 10000
```

All public Cloud wire states and error codes are lower-case. Admin browser errors remain the existing upper-case BFF form and are mapped explicitly.

---

## Pre-flight: Create clean, synchronized feature branches

Current planning evidence is Cloud `main=85f67e7`, Admin `main=3c02614`, both exactly equal to `origin/main`, and Desktop `aera/official-managed-agent-v1` containing the approved design. At execution time, re-check rather than assuming those hashes are still current:

```bash
git -C /Users/zizimutou/Desktop/aera/aera-cloud status --short --branch
git -C /Users/zizimutou/Desktop/aera/aera-admin status --short --branch
git -C /Users/zizimutou/Desktop/aera/aera status --short --branch
git -C /Users/zizimutou/Desktop/aera/aera-cloud rev-list --left-right --count origin/main...main
git -C /Users/zizimutou/Desktop/aera/aera-admin rev-list --left-right --count origin/main...main
```

Require both count commands to print `0 0`, both main worktrees to be clean, and Desktop to contain only the committed design/plan baseline. Then create or switch the two missing branches without merging or pushing:

```bash
git -C /Users/zizimutou/Desktop/aera/aera-cloud switch -c aera/official-managed-agent-v1 main
git -C /Users/zizimutou/Desktop/aera/aera-admin switch -c aera/official-managed-agent-v1 main
git -C /Users/zizimutou/Desktop/aera/aera switch aera/official-managed-agent-v1
```

If either feature branch already exists, replace `switch -c` with `switch` and verify its recorded base before continuing. Stop on a dirty worktree, divergent main, unexpected branch range, or overlapping user changes.

---

### Task 1: Add the Cloud PLATFORM and OfficialRelease schema

**Files:**

- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/migrations/000016_official_managed_agent_v1.sql`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/store/migrate_test.go`
- Test: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/store/migrate_test.go`

**Interfaces:**

- Consumes: migrations 000007, 000008, 000010, 000014, and 000015.
- Produces: all PLATFORM relational invariants used by Tasks 2–8.

- [ ] **Step 1: Write the failing migration assertions**

Update the one embedded-migration count assertion to expect version 16 and add real PostgreSQL assertions for these tables and constraints:

```go
for _, table := range []string{
    "platforms", "platform_agent_drafts", "platform_agent_policy_snapshots",
    "platform_agent_submissions", "platform_agent_reviews", "official_releases",
    "official_release_revisions", "official_release_audience_accounts",
} {
    assertTableExists(t, ctx, postgres, table)
}
assertCheckConstraintContains(t, ctx, postgres, "agent_definitions", "agent_definitions_owner_variant_check", "PLATFORM")
assertCheckConstraintContains(t, ctx, postgres, "agent_versions", "agent_versions_owner_variant_check", "platform_submission_id")
assertCheckConstraintContains(t, ctx, postgres, "installations", "installations_official_source_check", "selected_release_revision_id")
assertCheckConstraintContains(t, ctx, postgres, "official_release_revisions", "official_release_revisions_rollout_check", "10000")
assertUniqueConstraint(t, ctx, postgres, "platform_agent_reviews", "platform_agent_reviews_submission_key", []string{"submission_id"})
```

- [ ] **Step 2: Run the focused migration tests and confirm RED**

Run:

```bash
cd /Users/zizimutou/Desktop/aera/aera-cloud
go test ./internal/store -run 'TestEmbeddedMigrations|TestApplyMigrationsCreatesAuthSchemaAndIsIdempotent' -count=1
```

Expected: FAIL because migration 000016 and PLATFORM tables/constraints do not exist.

- [ ] **Step 3: Add the exact PLATFORM owner variants and official tables**

Create migration 000016. Preserve all existing USER/WORKSPACE/ORGANIZATION arms and add a fourth exact arm with `platform_id`. Define these columns and keys exactly:

```sql
CREATE TABLE platforms (
    id UUID PRIMARY KEY,
    platform_key TEXT NOT NULL UNIQUE CHECK (platform_key ~ '^[a-z][a-z0-9_-]{2,63}$'),
    display_name TEXT NOT NULL CHECK (display_name = btrim(display_name) AND char_length(display_name) BETWEEN 1 AND 100),
    status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL CHECK (updated_at >= created_at)
);

CREATE TABLE platform_agent_drafts (
    id UUID PRIMARY KEY,
    platform_id UUID NOT NULL REFERENCES platforms(id) ON DELETE RESTRICT,
    definition_id UUID NOT NULL,
    base_version_id UUID REFERENCES agent_versions(id) ON DELETE RESTRICT,
    kind TEXT NOT NULL CHECK (kind IN ('initial', 'next')),
    display_name TEXT NOT NULL CHECK (
        display_name = btrim(display_name)
        AND char_length(display_name) BETWEEN 1 AND 100
        AND display_name !~ '[[:cntrl:]]'
    ),
    icon_media_type TEXT CHECK (icon_media_type IS NULL OR icon_media_type IN ('image/png','image/webp')),
    icon_data BYTEA CHECK (icon_data IS NULL OR octet_length(icon_data) <= 524288),
    canonical_manifest JSONB NOT NULL CHECK (jsonb_typeof(canonical_manifest) = 'object'),
    bundle JSONB NOT NULL CHECK (jsonb_typeof(bundle) = 'object'),
    manifest_digest BYTEA NOT NULL CHECK (octet_length(manifest_digest) = 32),
    bundle_digest BYTEA NOT NULL CHECK (octet_length(bundle_digest) = 32),
    content_digest BYTEA NOT NULL CHECK (octet_length(content_digest) = 32),
    revision BIGINT NOT NULL CHECK (revision > 0),
    status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
    last_editor_admin_id UUID NOT NULL,
    last_editor_role TEXT NOT NULL CHECK (last_editor_role = 'developer'),
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL CHECK (updated_at >= created_at),
    CHECK ((icon_media_type IS NULL) = (icon_data IS NULL)),
    CHECK ((kind = 'initial' AND base_version_id IS NULL) OR (kind = 'next' AND base_version_id IS NOT NULL)),
    UNIQUE (platform_id, id),
    UNIQUE (platform_id, definition_id)
);

CREATE TABLE platform_agent_policy_snapshots (
    id UUID PRIMARY KEY,
    platform_id UUID NOT NULL REFERENCES platforms(id) ON DELETE RESTRICT,
    version BIGINT NOT NULL CHECK (version > 0),
    canonical_policy JSONB NOT NULL CHECK (jsonb_typeof(canonical_policy) = 'object'),
    policy_digest BYTEA NOT NULL CHECK (octet_length(policy_digest) = 32),
    signature_key_id TEXT NOT NULL,
    signature BYTEA NOT NULL CHECK (octet_length(signature) = 64),
    created_at TIMESTAMPTZ NOT NULL,
    UNIQUE (platform_id, id),
    UNIQUE (platform_id, version),
    UNIQUE (platform_id, id, version)
);

CREATE TABLE platform_agent_submissions (
    id UUID PRIMARY KEY,
    platform_id UUID NOT NULL REFERENCES platforms(id) ON DELETE RESTRICT,
    draft_id UUID NOT NULL,
    draft_revision BIGINT NOT NULL CHECK (draft_revision > 0),
    definition_id UUID NOT NULL,
    base_version_id UUID REFERENCES agent_versions(id) ON DELETE RESTRICT,
    kind TEXT NOT NULL CHECK (kind IN ('initial', 'next')),
    display_name TEXT NOT NULL CHECK (
        display_name = btrim(display_name)
        AND char_length(display_name) BETWEEN 1 AND 100
        AND display_name !~ '[[:cntrl:]]'
    ),
    icon_media_type TEXT CHECK (icon_media_type IS NULL OR icon_media_type IN ('image/png','image/webp')),
    icon_data BYTEA CHECK (icon_data IS NULL OR octet_length(icon_data) <= 524288),
    canonical_manifest JSONB NOT NULL,
    bundle JSONB NOT NULL,
    manifest_digest BYTEA NOT NULL CHECK (octet_length(manifest_digest) = 32),
    bundle_digest BYTEA NOT NULL CHECK (octet_length(bundle_digest) = 32),
    content_digest BYTEA NOT NULL CHECK (octet_length(content_digest) = 32),
    submitted_by_admin_id UUID NOT NULL,
    submitted_by_role TEXT NOT NULL CHECK (submitted_by_role = 'developer'),
    status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn', 'superseded')),
    revision BIGINT NOT NULL CHECK (revision > 0),
    submitted_at TIMESTAMPTZ NOT NULL,
    terminal_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL,
    CHECK ((icon_media_type IS NULL) = (icon_data IS NULL)),
    CHECK ((kind = 'initial' AND base_version_id IS NULL) OR (kind = 'next' AND base_version_id IS NOT NULL)),
    CHECK (
        (status = 'pending' AND terminal_at IS NULL)
        OR (status <> 'pending' AND terminal_at IS NOT NULL)
    ),
    CHECK (updated_at >= submitted_at AND (terminal_at IS NULL OR terminal_at >= submitted_at)),
    UNIQUE (platform_id, id),
    FOREIGN KEY (platform_id, draft_id) REFERENCES platform_agent_drafts(platform_id, id) ON DELETE RESTRICT
);

CREATE TABLE platform_agent_reviews (
    id UUID PRIMARY KEY,
    platform_id UUID NOT NULL REFERENCES platforms(id) ON DELETE RESTRICT,
    submission_id UUID NOT NULL UNIQUE,
    reviewer_admin_id UUID NOT NULL,
    reviewer_role TEXT NOT NULL CHECK (reviewer_role = 'super_admin'),
    decision TEXT NOT NULL CHECK (decision IN ('approve', 'reject')),
    reason_code TEXT NOT NULL CHECK (reason_code ~ '^[a-z][a-z0-9_]{2,63}$'),
    safe_note TEXT CHECK (
        safe_note IS NULL
        OR (safe_note = btrim(safe_note) AND char_length(safe_note) BETWEEN 1 AND 500 AND safe_note !~ '[[:cntrl:]]')
    ),
    reviewed_content_digest BYTEA NOT NULL CHECK (octet_length(reviewed_content_digest) = 32),
    platform_policy_snapshot_id UUID NOT NULL,
    platform_policy_version BIGINT NOT NULL CHECK (platform_policy_version > 0),
    reviewed_at TIMESTAMPTZ NOT NULL,
    FOREIGN KEY (platform_id, submission_id) REFERENCES platform_agent_submissions(platform_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (platform_id, platform_policy_snapshot_id, platform_policy_version)
        REFERENCES platform_agent_policy_snapshots(platform_id, id, version) ON DELETE RESTRICT
);
```

Extend the shared owner tables without overloading Cloud user IDs with employee IDs:

```sql
ALTER TABLE agent_definitions
    ADD COLUMN platform_id UUID REFERENCES platforms(id) ON DELETE RESTRICT,
    ADD COLUMN created_by_admin_id UUID,
    ALTER COLUMN created_by DROP NOT NULL;

ALTER TABLE agent_versions
    ADD COLUMN platform_id UUID REFERENCES platforms(id) ON DELETE RESTRICT,
    ADD COLUMN platform_submission_id UUID,
    ADD COLUMN platform_policy_snapshot_id UUID,
    ADD COLUMN published_by_admin_id UUID,
    ALTER COLUMN published_by DROP NOT NULL;

ALTER TABLE agent_control_idempotency_keys
    ADD COLUMN platform_id UUID REFERENCES platforms(id) ON DELETE RESTRICT;
```

Replace, rather than stack, the three owner-variant checks. Preserve the existing arms exactly and add:

```text
Definition PLATFORM: tenant_id/owner_id/workspace_id/organization_id null;
                     platform_id and created_by_admin_id non-null; created_by null.
Version PLATFORM:    tenant_id/owner_id/workspace_id/organization_id null;
                     platform_id, platform_submission_id,
                     platform_policy_snapshot_id, published_by_admin_id non-null;
                     published_by null.
Idempotency PLATFORM: tenant_id/owner_id/workspace_id/organization_id null;
                      platform_id non-null.
```

Every non-PLATFORM row keeps its current user creator/publisher and has null employee provenance. Add composite foreign keys from the PLATFORM Version to its same-platform submission and policy snapshot, `UNIQUE (platform_id, id)` support keys on PLATFORM source tables, and the partial idempotency key `(platform_id, operation, key_hash) WHERE owner_scope = 'PLATFORM'`.

Create the release tables with these exact invariants:

```sql
CREATE TABLE official_releases (
    id UUID PRIMARY KEY,
    platform_id UUID NOT NULL REFERENCES platforms(id) ON DELETE RESTRICT,
    definition_id UUID NOT NULL,
    channel TEXT NOT NULL CHECK (channel IN ('internal', 'stable')),
    current_release_revision_id UUID NOT NULL,
    head_revision BIGINT NOT NULL CHECK (head_revision > 0),
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL CHECK (updated_at >= created_at),
    UNIQUE (platform_id, definition_id, channel),
    FOREIGN KEY (platform_id, definition_id)
        REFERENCES agent_definitions(platform_id, id) ON DELETE RESTRICT
);

CREATE TABLE official_release_revisions (
    id UUID PRIMARY KEY,
    release_id UUID NOT NULL REFERENCES official_releases(id) ON DELETE RESTRICT,
    revision_number BIGINT NOT NULL CHECK (revision_number > 0),
    agent_version_id UUID NOT NULL REFERENCES agent_versions(id) ON DELETE RESTRICT,
    state TEXT NOT NULL CHECK (state IN ('active', 'paused')),
    rollout_basis_points INTEGER NOT NULL CHECK (rollout_basis_points BETWEEN 0 AND 10000),
    minimum_desktop_version TEXT NOT NULL CHECK (char_length(minimum_desktop_version) BETWEEN 1 AND 128),
    bucket_algorithm_version TEXT NOT NULL CHECK (bucket_algorithm_version = '1'),
    rollout_key_id TEXT NOT NULL CHECK (char_length(rollout_key_id) BETWEEN 1 AND 64),
    action TEXT NOT NULL CHECK (action IN ('initial','activate','rollout_update','pause','resume','rollback')),
    previous_revision_id UUID,
    rollback_target_revision_id UUID,
    actor_admin_id UUID NOT NULL,
    actor_admin_role TEXT NOT NULL CHECK (actor_admin_role IN ('super_admin','developer','operator','support','finance','auditor')),
    reason_code TEXT NOT NULL CHECK (reason_code ~ '^[a-z][a-z0-9_]{2,63}$'),
    ticket_reference TEXT CHECK (ticket_reference IS NULL OR char_length(ticket_reference) BETWEEN 1 AND 128),
    created_at TIMESTAMPTZ NOT NULL,
    UNIQUE (release_id, revision_number),
    UNIQUE (release_id, id),
    UNIQUE (release_id, id, revision_number),
    UNIQUE (release_id, id, agent_version_id),
    CHECK (
        (action = 'initial' AND revision_number = 1 AND state = 'paused'
            AND rollout_basis_points = 0 AND previous_revision_id IS NULL
            AND rollback_target_revision_id IS NULL)
        OR
        (action <> 'initial' AND revision_number > 1 AND previous_revision_id IS NOT NULL)
    ),
    CHECK ((action = 'rollback') = (rollback_target_revision_id IS NOT NULL)),
    CHECK (action <> 'pause' OR state = 'paused'),
    CHECK (action <> 'resume' OR state = 'active'),
    FOREIGN KEY (release_id, previous_revision_id)
        REFERENCES official_release_revisions(release_id, id) DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (release_id, rollback_target_revision_id)
        REFERENCES official_release_revisions(release_id, id) DEFERRABLE INITIALLY DEFERRED
);

ALTER TABLE official_releases
    ADD CONSTRAINT official_releases_current_revision_fk
    FOREIGN KEY (id, current_release_revision_id, head_revision)
    REFERENCES official_release_revisions(release_id, id, revision_number)
    DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE official_release_audience_accounts (
    release_revision_id UUID NOT NULL REFERENCES official_release_revisions(id) ON DELETE RESTRICT,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    PRIMARY KEY (release_revision_id, user_id)
);
```

The self-references allow the initial Release and revision to be inserted in one transaction. Add a deferred constraint trigger rejecting any release revision whose AgentVersion is not PLATFORM-owned by the release's exact `platform_id` and `definition_id`. Service and repository tests must prove the release head always matches the referenced immutable revision and that each transition preserves the required previous/rollback chain.

Extend the existing USER-owned Installation and sanitized RuntimeBinding tables:

```sql
ALTER TABLE installations
    ADD COLUMN official_release_id UUID REFERENCES official_releases(id) ON DELETE RESTRICT,
    ADD COLUMN selected_release_revision_id UUID,
    DROP CONSTRAINT installations_update_policy_check,
    ADD CONSTRAINT installations_update_policy_check CHECK (update_policy IN ('manual', 'managed')),
    ADD CONSTRAINT installations_official_source_check CHECK (
        (update_policy = 'manual' AND official_release_id IS NULL AND selected_release_revision_id IS NULL)
        OR
        (update_policy = 'managed' AND official_release_id IS NOT NULL AND selected_release_revision_id IS NOT NULL)
    ),
    ADD CONSTRAINT installations_official_selection_fk
        FOREIGN KEY (official_release_id, selected_release_revision_id, selected_version_id)
        REFERENCES official_release_revisions(release_id, id, agent_version_id)
        DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE runtime_binding_records
    ADD COLUMN official_release_revision_id UUID
        REFERENCES official_release_revisions(id) ON DELETE RESTRICT;
```

Add a constraint trigger that rejects a managed Installation unless its Definition and selected Version are PLATFORM-owned and match the referenced release revision; it rejects a manual Installation if either official field is present. A RuntimeBinding trigger requires the official revision exactly when its Installation is managed and requires it to equal that Installation's selected revision. These checks never change USER ownership of the Installation, policy snapshot, or RuntimeBinding.

Extend `admin_operations` with nullable `actor_admin_role` for legacy compatibility, the eleven official actions, and target types `platform_definition`, `platform_draft`, `platform_submission`, and `official_release`. Add exact action-to-target checks; official mutations require a fixed actor role, and `official_release_rollback` additionally requires `approval_id`. Existing account/device/session rows remain valid unchanged.

Add dedicated immutable-mutation triggers that reject UPDATE/DELETE for reviews, policy snapshots, AgentVersions, release revisions, and audience rows. The submission trigger permits only `pending -> approved|rejected|withdrawn|superseded`, increments `revision` by exactly one, sets terminal timestamps, and proves every frozen content, digest, and actor column is unchanged.

- [ ] **Step 4: Run migration tests and confirm GREEN**

Run:

```bash
AERA_INTEGRATION_TESTS=1 go test -p 1 ./internal/store -count=1
```

Expected: PASS with migration 16 applied twice idempotently and every PLATFORM constraint present.

- [ ] **Step 5: Commit the schema checkpoint**

```bash
git add migrations/000016_official_managed_agent_v1.sql internal/store/migrate_test.go
git commit -m "feat: add official managed agent schema"
```

### Task 2: Add configured platform identity, rollout keys, and exact owner types

**Files:**

- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/config/official_agent.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/config/official_agent_test.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/agentcontrol/platform_model.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/agentcontrol/platform_model_test.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/config/config.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/config/config_test.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/agentcontrol/model.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/.env.example`

**Interfaces:**

- Consumes: Task 1 `platforms` and owner columns.
- Produces: `OfficialAgentConfig`, `OwnerScopePlatform`, `PlatformAdminActor`, release types, and fixed error values for later Cloud tasks.

- [ ] **Step 1: Write failing configuration and owner-variant tests**

Cover missing/false as disabled in every environment, complete configuration, partial configuration rejection, non-UUID platform ID, invalid key, duplicate rollout keys, missing active key, and PLATFORM exclusivity:

```go
func TestPlatformOwnerRequiresOnlyPlatformID(t *testing.T) {
    owner := AssetOwner{Scope: OwnerScopePlatform, PlatformID: uuid.New()}
    if err := owner.Validate(); err != nil { t.Fatalf("Validate() = %v", err) }
    owner.UserID = uuid.New()
    if err := owner.Validate(); !errors.Is(err, ErrInvalidAgentContent) {
        t.Fatalf("mixed PLATFORM owner error = %v", err)
    }
}
```

- [ ] **Step 2: Run focused tests and confirm RED**

```bash
go test ./internal/config ./internal/agentcontrol -run 'OfficialAgent|PlatformOwner' -count=1
```

Expected: FAIL because the config and PLATFORM types do not exist.

- [ ] **Step 3: Implement exact configuration and domain constants**

Use these environment names and Go shapes:

```go
type OfficialAgentConfig struct {
    Enabled              bool
    PlatformID           uuid.UUID
    PlatformKey          string
    PlatformDisplayName  string
    RolloutHMACActiveKey string
    RolloutHMACKeys      map[string][]byte
}

const OwnerScopePlatform OwnerScope = "PLATFORM"

type PlatformAdminActor struct {
    AdminID  uuid.UUID
    Role     string
    RequestID string
}

type OfficialChannel string
const (
    OfficialChannelInternal OfficialChannel = "internal"
    OfficialChannelStable   OfficialChannel = "stable"
)
```

The exact environment variables are:

```text
AGENTERA_CLOUD_OFFICIAL_AGENTS_ENABLED
AGENTERA_CLOUD_PLATFORM_ID
AGENTERA_CLOUD_PLATFORM_KEY
AGENTERA_CLOUD_PLATFORM_DISPLAY_NAME
AGENTERA_CLOUD_OFFICIAL_ROLLOUT_HMAC_ACTIVE_KEY_ID
AGENTERA_CLOUD_OFFICIAL_ROLLOUT_HMAC_KEYS
```

Default the feature to disabled in every environment so merging code cannot silently expose official Agents. When explicitly enabled, require every value, canonical UUID, bounded key/display name, one active 32-byte HMAC key, and no material reuse with any existing key ring.

- [ ] **Step 4: Run config and owner tests**

```bash
go test ./internal/config ./internal/agentcontrol -run 'OfficialAgent|PlatformOwner' -count=1
```

Expected: PASS.

- [ ] **Step 5: Commit the configured owner model**

```bash
git add internal/config/official_agent.go internal/config/official_agent_test.go internal/config/config.go internal/config/config_test.go internal/agentcontrol/model.go internal/agentcontrol/platform_model.go internal/agentcontrol/platform_model_test.go .env.example
git commit -m "feat: define official platform ownership"
```

### Task 3: Implement Cloud drafts, submissions, role separation, and immutable publication

**Files:**

- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/agentcontrol/platform_repository.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/agentcontrol/platform_repository_test.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/agentcontrol/platform_service.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/agentcontrol/platform_service_test.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/agentcontrol/service.go`

**Interfaces:**

- Consumes: Tasks 1–2 schema/config/types plus existing `CanonicalizeVersion`, DLP, signer, idempotency, and audit patterns.
- Produces: `PlatformService` draft/submission/review/version methods used by Internal Admin Task 7 and release Task 4.

- [ ] **Step 1: Write failing service tests for the complete role matrix**

Create table-driven tests asserting Developer create/edit/validate/submit/withdraw, different Super Admin approve/reject, Operator denial for content, Auditor read-only, Support/Finance denial, stale revision conflict, self-review rejection, digest mismatch, DLP rejection, signer rollback, audit rollback, and v2 approval leaving the current release head unchanged.

```go
tests := []struct{ role, action string; allowed bool }{
    {"developer", "draft_write", true}, {"developer", "review", false},
    {"super_admin", "review", true}, {"super_admin", "draft_write", false},
    {"operator", "release_write", true}, {"operator", "review", false},
    {"auditor", "read", true}, {"auditor", "draft_write", false},
    {"support", "read", false}, {"finance", "read", false},
}
```

- [ ] **Step 2: Run focused tests and confirm RED**

```bash
go test ./internal/agentcontrol -run 'PlatformDraft|PlatformSubmission|PlatformReview|PlatformPublication' -count=1
```

Expected: FAIL because `PlatformService` and repository methods do not exist.

- [ ] **Step 3: Implement strict commands and detached return values**

Expose these exact methods:

```go
type PlatformService interface {
    ReserveDefinition(context.Context, PlatformAdminActor, ReservePlatformDefinitionCommand) (PlatformDefinitionReservation, error)
    CreateDraft(context.Context, PlatformAdminActor, CreatePlatformDraftCommand) (PlatformAgentDraft, error)
    UpdateDraft(context.Context, PlatformAdminActor, UpdatePlatformDraftCommand) (PlatformAgentDraft, error)
    ValidateDraft(context.Context, PlatformAdminActor, uuid.UUID) (PlatformDraftValidation, error)
    SubmitDraft(context.Context, PlatformAdminActor, SubmitPlatformDraftCommand) (PlatformAgentSubmission, error)
    WithdrawSubmission(context.Context, PlatformAdminActor, TerminalPlatformSubmissionCommand) (PlatformAgentSubmission, error)
    ReviewSubmission(context.Context, PlatformAdminActor, ReviewPlatformSubmissionCommand) (PlatformAgentSubmission, error)
    ListDefinitions(context.Context, PlatformAdminActor, PageRequest) (PlatformDefinitionPage, error)
    GetDefinition(context.Context, PlatformAdminActor, uuid.UUID) (PlatformDefinitionDetail, error)
    ListDrafts(context.Context, PlatformAdminActor, PageRequest) (PlatformDraftPage, error)
    GetDraft(context.Context, PlatformAdminActor, uuid.UUID) (PlatformAgentDraft, error)
    ListSubmissions(context.Context, PlatformAdminActor, PlatformSubmissionFilter) (PlatformSubmissionPage, error)
    GetSubmission(context.Context, PlatformAdminActor, uuid.UUID) (PlatformAgentSubmission, error)
    ListVersions(context.Context, PlatformAdminActor, PageRequest) (PlatformVersionPage, error)
    GetVersion(context.Context, PlatformAdminActor, uuid.UUID) (Version, error)
}
```

Canonicalize every draft before storage, hash canonical Manifest/Bundle/content, reject private-data patterns with the shared DLP scanner, enforce `expected_revision`, freeze an exact submission copy, and supersede only an older pending submission for the same draft in one transaction.

On enabled startup, idempotently ensure the configured `platforms` row and one signed immutable platform policy snapshot whose canonical document comes from `DefaultPlatformAgentPolicyV1()`. That compiled V1 policy is the only policy source in this plan; changing it creates a new snapshot and never rewrites an old review or Version.

- [ ] **Step 4: Implement atomic approve/reject publication**

On approval, lock submission, platform, draft, base Version, and current policy snapshot. Re-run canonicalization, DLP, policy, base-Version, Runtime compatibility, and digest checks. Reject `actor.AdminID == submission.SubmittedByAdminID`. `ReviewPlatformSubmissionCommand` carries one bounded, deduplicated `InitialChannels []OfficialChannel`; approval requires at least one policy-permitted channel. In one transaction insert the terminal review, terminal submission state, signed immutable PLATFORM Version, Definition head, one initial paused revision for each named channel that has no release, idempotency evidence, and audit. A named channel that already has a release remains unchanged, and later-version approval must never advance an existing release head.

- [ ] **Step 5: Run unit and PostgreSQL integration tests**

```bash
go test ./internal/agentcontrol -run 'PlatformDraft|PlatformSubmission|PlatformReview|PlatformPublication' -count=1
AERA_INTEGRATION_TESTS=1 go test -p 1 ./internal/agentcontrol -run 'PlatformRepository|PlatformPublication' -count=1
```

Expected: PASS with signer/audit/idempotency failure leaving zero partial publication rows.

- [ ] **Step 6: Commit the governed publication slice**

```bash
git add internal/agentcontrol/platform_repository.go internal/agentcontrol/platform_repository_test.go internal/agentcontrol/platform_service.go internal/agentcontrol/platform_service_test.go internal/agentcontrol/service.go
git commit -m "feat: govern official agent publication"
```

### Task 4: Implement append-only releases and deterministic eligibility

**Files:**

- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/agentcontrol/platform_release_test.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/agentcontrol/platform_model.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/agentcontrol/platform_repository.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/agentcontrol/platform_service.go`

**Interfaces:**

- Consumes: approved immutable PLATFORM Versions from Task 3 and rollout keys from Task 2.
- Produces: release commands, immutable revisions, eligibility decisions, and current managed target used by Tasks 5–7.

- [ ] **Step 1: Write failing rollout property and transition tests**

Test stable deterministic buckets, monotonic 1%→10%→50% cohorts, allowlist percentage override only, minimum SemVer, channel mismatch, paused behavior, foreign/unapproved Version rejection, stale head conflicts, resume preserving audience, and rollback preserving active/paused state.

```go
func TestOfficialBucketIsStableAndBounded(t *testing.T) {
    first := officialBucket(key, 1, releaseID, userID)
    second := officialBucket(key, 1, releaseID, userID)
    if first != second || first < 0 || first >= 10000 {
        t.Fatalf("bucket = %d/%d", first, second)
    }
}
```

- [ ] **Step 2: Run rollout tests and confirm RED**

```bash
go test ./internal/agentcontrol -run 'OfficialRelease|OfficialBucket|OfficialEligibility|OfficialRollback' -count=1
```

Expected: FAIL because release operations and bucket evaluation do not exist.

- [ ] **Step 3: Implement exact release commands**

Add:

```go
type ActivateOfficialReleaseCommand struct {
    ReleaseID uuid.UUID; VersionID uuid.UUID; ExpectedHeadRevision int64
    RolloutBasisPoints int; MinimumDesktopVersion string
    AllowlistedUserIDs []uuid.UUID; Evidence PlatformOperationEvidence
}
type UpdateOfficialRolloutCommand struct {
    ReleaseID uuid.UUID; ExpectedHeadRevision int64
    RolloutBasisPoints int; MinimumDesktopVersion string
    AllowlistedUserIDs []uuid.UUID; Evidence PlatformOperationEvidence
}
type RollbackOfficialReleaseCommand struct {
    ReleaseID uuid.UUID; TargetVersionID uuid.UUID; TargetReleaseRevisionID uuid.UUID
    ExpectedHeadRevision int64
    ApprovalID uuid.UUID; Evidence PlatformOperationEvidence
}
type ChangeOfficialReleaseStateCommand struct {
    ReleaseID uuid.UUID; ExpectedHeadRevision int64
    Evidence PlatformOperationEvidence
}
```

Every mutation locks the release head, validates the exact expected revision, inserts one immutable revision plus immutable sorted audience rows, updates only the head pointer/revision, and appends audit/idempotency in the same transaction. Audit records only the audience count and digest. Pause copies Version and audience with `state=paused`; resume copies them with `state=active`; rollback requires the target revision to belong to the same release and reference the named already approved Version, then retains the prior active/paused state.

- [ ] **Step 4: Implement deterministic eligibility**

Compute HMAC over `algorithm_version + NUL + release_id + NUL + user_id`, use the configured key ID from the immutable revision, and parse strict SemVer. Accept one `OfficialEligibilityContext` containing channel, desktop version, and the current personal/workspace/organization selector. Validate the selector's exact shape and authorize the current user against the named Workspace/Organization before loading policy; the selector never changes asset or Installation ownership. Evaluate in this order: authenticated account/device, platform active, channel entitlement, release active, minimum version, authorized product-context policy, explicit allowlist, bucket. Return a bounded denial code without exposing bucket, key, allowlist, or policy internals.

- [ ] **Step 5: Run unit and integration tests**

```bash
go test ./internal/agentcontrol -run 'OfficialRelease|OfficialBucket|OfficialEligibility|OfficialRollback' -count=1
AERA_INTEGRATION_TESTS=1 go test -p 1 ./internal/agentcontrol -run 'OfficialReleaseRepository' -count=1
```

Expected: PASS, including concurrent Operator updates producing one success and one revision conflict.

- [ ] **Step 6: Commit the release slice**

```bash
git add internal/agentcontrol/platform_model.go internal/agentcontrol/platform_repository.go internal/agentcontrol/platform_service.go internal/agentcontrol/platform_release_test.go
git commit -m "feat: add deterministic official agent releases"
```

### Task 5: Extend USER Installations with managed PLATFORM provenance

**Files:**

- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/agentcontrol/platform_installation_test.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/agentcontrol/model.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/agentcontrol/repository.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/agentcontrol/service.go`

**Interfaces:**

- Consumes: current eligible release revisions from Task 4 and existing USER Installation/device-proof/policy code.
- Produces: official Installation creation, managed-target read/apply, and release-revision RuntimeBinding provenance used by public API and Desktop.

- [ ] **Step 1: Write failing exact-source and managed-selection tests**

Cover normal request compatibility, official request with no `version_id`, rejection of mixed `version_id` plus release revision, USER ownership, PLATFORM source, current eligibility recheck, manual `select-version` denial for managed Installation, pause behavior for installed/not-installed users, v2/rollback selection, stale revision conflict, and sanitized RuntimeBinding fields.

```go
func TestOfficialInstallationRemainsUserOwned(t *testing.T) {
    created := createOfficialInstallation(t, fixture.releaseRevisionID)
    if created.Installation.UpdatePolicy != UpdatePolicyManaged ||
        created.Installation.OfficialReleaseID == nil ||
        created.Installation.SelectedReleaseRevisionID == nil {
        t.Fatalf("installation managed provenance = %#v", created.Installation)
    }
    assertInstallationOwnerRow(t, created.Installation.ID, OwnerScopeUser)
    assertVersionOwner(t, created.Installation.SelectedVersionID, OwnerScopePlatform)
}
```

- [ ] **Step 2: Run focused tests and confirm RED**

```bash
go test ./internal/agentcontrol -run 'OfficialInstallation|ManagedSelection|OfficialRuntimeBinding' -count=1
```

Expected: FAIL because PLATFORM-source Installation and managed target operations do not exist.

- [ ] **Step 3: Add strict request variants and model fields**

Use these exact request types:

```go
type CreateInstallationRequest struct {
    DefinitionID             uuid.UUID
    VersionID                uuid.UUID
    SourceWorkspaceID        *uuid.UUID
    OrganizationID           *uuid.UUID
    OfficialReleaseRevisionID *uuid.UUID
    OfficialContext          *OfficialEligibilityContext
    IdempotencyKey           string
    RequestID                string
}

type ManagedUpdateRequest struct {
    InstallationID               uuid.UUID
    ExpectedSelectedRevisionID   uuid.UUID
    TargetReleaseRevisionID      uuid.UUID
    OfficialContext              OfficialEligibilityContext
    RequestID                    string
}
```

Add `OfficialReleaseID *uuid.UUID` and `SelectedReleaseRevisionID *uuid.UUID` to the internal Installation model. Normal USER/WORKSPACE/ORGANIZATION requests require `VersionID`, null official revision/context, and preserve their current source fields. Official requests require `DefinitionID`, `OfficialReleaseRevisionID`, and an exact `OfficialContext`, require zero `VersionID`, derive the target Version in Cloud, and reject Workspace/Organization ownership-source fields. Context Workspace/Organization IDs are policy selectors only and are independently membership-authorized.

- [ ] **Step 4: Implement transactional create and managed selection**

During create and apply, re-evaluate user/device/channel/client version/product-context policy/audience and lock the release head. Persist one USER-owned Installation with `update_policy=managed`, exact release/revision, derived PLATFORM Version, and signed USER policy snapshot. The policy document binds the authorized context scope/ID used for that selection; the Installation remains globally USER-owned and does not gain Workspace/Organization ownership columns. PLATFORM is derived from the referenced Definition/Version and enforced by the schema trigger; no second ownership or source-scope column is introduced. The existing manual select endpoint returns `official_managed_update_conflict` for these rows.

The managed apply transaction requires both the local expected selected revision and target release revision. It updates Version, selected release revision, and policy snapshot atomically. Idempotent retry returns the same result. A changed release head or policy returns conflict and preserves the prior selection.

- [ ] **Step 5: Extend sanitized RuntimeBinding persistence**

Permit `official_release_revision_id` only when the Installation source is PLATFORM and ensure it equals the Installation's selected release revision at binding creation. Continue rejecting Profile path, prompt, asset bytes, Memory, USER, session, credentials, private Skills, Curator, and local filesystem fields.

- [ ] **Step 6: Run focused and PostgreSQL tests**

```bash
go test ./internal/agentcontrol -run 'OfficialInstallation|ManagedSelection|OfficialRuntimeBinding' -count=1
AERA_INTEGRATION_TESTS=1 go test -p 1 ./internal/agentcontrol -run 'OfficialInstallationRepository|ManagedSelectionRepository' -count=1
```

Expected: PASS with USER ownership and prior selection preserved across every injected failure.

- [ ] **Step 7: Commit managed Installation support**

```bash
git add internal/agentcontrol/model.go internal/agentcontrol/repository.go internal/agentcontrol/service.go internal/agentcontrol/platform_installation_test.go
git commit -m "feat: add managed official agent installations"
```

### Task 6: Expose the strict public official catalog and managed-update API

**Files:**

- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/agentcontrol/platform_http.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/agentcontrol/platform_http_test.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/agentcontrol/http.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/httpapi/server.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/httpapi/server_test.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/api/openapi.yaml`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/api/openapi_test.go`

**Interfaces:**

- Consumes: Tasks 4–5 catalog, eligibility, Installation, and managed-target methods.
- Produces: the exact public OpenAPI pinned by Desktop Task 15.

- [ ] **Step 1: Write failing route and strict-union tests**

Add exact success/denial tests for:

```text
GET  /api/v1/official-agents
GET  /api/v1/official-agents/{definition_id}
GET  /api/v1/official-agents/{definition_id}/release
POST /api/v1/agent-installations
GET  /api/v1/agent-installations/{installation_id}/managed-update
POST /api/v1/agent-installations/{installation_id}/apply-managed-update
```

Assert duplicate keys, unknown fields/query parameters, non-canonical UUIDs, oversized bodies, renderer-selected owner/platform/version, mixed normal/official create fields, and public access to drafts/reviews/releases are rejected.

- [ ] **Step 2: Run HTTP/OpenAPI tests and confirm RED**

```bash
go test ./internal/agentcontrol ./internal/httpapi ./api -run 'Official|OpenAPIContract' -count=1
```

Expected: FAIL because public routes and schemas are absent.

- [ ] **Step 3: Implement exact public DTOs and route handlers**

Return only these catalog fields:

```go
type officialAgentSummaryResponse struct {
    DefinitionID string `json:"definition_id"`
    DisplayName string `json:"display_name"`
    IconMediaType string `json:"icon_media_type,omitempty"`
    IconData string `json:"icon_data,omitempty"`
    Official bool `json:"official"`
    VersionID string `json:"version_id"`
    VersionNumber int64 `json:"version_number"`
    ReleaseID string `json:"release_id"`
    ReleaseRevisionID string `json:"release_revision_id"`
    Channel string `json:"channel"`
    RuntimeMinimumVersion string `json:"runtime_minimum_version"`
    RuntimeMaximumVersionExclusive string `json:"runtime_maximum_version_exclusive,omitempty"`
    InstallationState string `json:"installation_state"`
    UpdateState string `json:"update_state"`
}
```

The main authenticated principal supplies user/device identity. The desktop main process, never the renderer, supplies exact headers `X-AgentEra-Official-Channel`, `X-AgentEra-Desktop-Version`, `X-AgentEra-Product-Context`, and optional `X-AgentEra-Product-Context-ID`. Cloud requires personal context to omit the ID and workspace/organization context to carry one canonical UUID, then re-authorizes membership and current policy. It validates channel/version but never treats a header as authorization: `internal` additionally requires the server-side internal-channel entitlement, while account/device state, policy, allowlist, rollout bucket, and release state remain Cloud-derived. Unknown context or duplicate headers fail closed. Denials use the fixed lower-case feature codes and expose no bucket or allowlist data.

- [ ] **Step 4: Add the strict Installation source union**

In OpenAPI, define `CreateAgentInstallationRequest` as `oneOf` two `additionalProperties: false` schemas:

```yaml
NormalAgentInstallationSource:
  required: [definition_id, version_id]
OfficialAgentInstallationSource:
  required: [definition_id, official_release_revision_id]
```

The official arm has no `version_id`, `workspace_id`, `organization_id`, `owner_scope`, `platform_id`, user, device, or policy field.

- [ ] **Step 5: Implement managed-target read/apply handlers**

The read returns either `{"update_available":false}` or one exact target with release revision, Version ID, safe compatibility data, and signed policy snapshot ID. Apply accepts only `expected_selected_release_revision_id` and `target_release_revision_id`; Cloud derives every other field and repeats eligibility under lock.

- [ ] **Step 6: Run public contract tests**

```bash
go test ./internal/agentcontrol ./internal/httpapi ./api -run 'Official|OpenAPIContract' -count=1
```

Expected: PASS, with no Internal Admin path in `api/openapi.yaml`.

- [ ] **Step 7: Commit the public API**

```bash
git add internal/agentcontrol/platform_http.go internal/agentcontrol/platform_http_test.go internal/agentcontrol/http.go internal/httpapi/server.go internal/httpapi/server_test.go api/openapi.yaml api/openapi_test.go
git commit -m "feat: expose official agent catalog"
```

### Task 7: Add actor-bound Internal Admin API and Cloud operation reconciliation

**Files:**

- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/adminapi/official_agent.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/adminapi/official_agent_test.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/adminapi/auth.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/adminapi/auth_test.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/adminapi/handler.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/adminapi/handler_test.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/admin/control_model.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/admin/control_model_test.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/admin/control_repository.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/admin/control_repository_test.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/admin/control_service.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/admin/control_service_test.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/api/openapi/internal-admin.yaml`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/api/internal_admin_openapi_test.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/cmd/aera-cloud/internal_admin.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/cmd/aera-cloud/main.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/cmd/aera-cloud/internal_admin_test.go`

**Interfaces:**

- Consumes: PlatformService Tasks 3–4 and current mTLS/service-JWT/admin-operation infrastructure.
- Produces: exact Internal Admin contract and actor-bound operation status used by Admin Tasks 9–14.

- [ ] **Step 1: Write failing auth and listener-separation tests**

Add scopes exactly:

```go
const (
    ScopeOfficialAgentsRead    = "official_agents:read"
    ScopeOfficialDraftsWrite  = "official_agent_drafts:write"
    ScopeOfficialReviewsWrite = "official_agent_reviews:write"
    ScopeOfficialReleaseWrite = "official_agent_releases:write"
    ScopeOfficialAuditRead     = "official_agent_audit:read"
)
```

Test missing/expired actor claims, invalid role, body actor mismatch, self-review, self-rollback approval, wrong scope, unauthenticated 404/405, public-listener absence, operation idempotency replay, and ambiguous-result reconciliation.

- [ ] **Step 2: Run Internal Admin tests and confirm RED**

```bash
go test ./internal/adminapi ./cmd/aera-cloud ./api -run 'Official|InternalAdmin' -count=1
```

Expected: FAIL because actor claims, routes, scopes, and service wiring are absent.

- [ ] **Step 3: Extend service JWT claims with signed employee identity**

Require official-route tokens to contain:

```go
type ServiceActorClaims struct {
    AdminID string `json:"admin_id"`
    Role string `json:"admin_role"`
    OperationID string `json:"operation_id,omitempty"`
    ApprovalID string `json:"approval_id,omitempty"`
    RequesterAdminID string `json:"requester_admin_id,omitempty"`
}
```

Validate canonical non-nil actor UUID and one of the six fixed role strings. Read tokens omit operation/approval/requester. Mutation tokens sign the operation ID; rollback tokens additionally sign approval ID and requester Admin ID. Store the verified values in request context and cross-check them against the body. Existing user/device/account routes continue accepting service-only claims; official routes require actor claims plus action-specific scope.

- [ ] **Step 4: Implement exact Internal Admin routes**

Register every approved route from the spec under `/internal/admin/v1` only. Read routes return strict safe pages/details. Mutation routes require one `PlatformOperationEvidence` body containing operation ID, expected revision/digest, reason, optional ticket, optional approval ID, and typed payload. Use `Idempotency-Key == operation_id` and persist a Cloud `admin_operations` row atomically with domain mutation and audit.

The review handler calls `ReviewSubmission`; the rollback handler requires a non-null approval ID and rejects actor equality with the Operator requester recorded in the signed payload and Admin approval evidence.

- [ ] **Step 5: Wire one shared Agent repository/service to both listeners**

Refactor construction so `agentcontrol.NewPostgresRepository(postgres)` and one `agentcontrol.Service`/`PlatformService` instance are created once. The public handler receives public methods; `buildInternalAdmin` receives the same PlatformService. If the enabled internal listener or Platform configuration cannot initialize, startup fails before either listener is considered ready.

- [ ] **Step 6: Add the exact Internal Admin OpenAPI**

Document all 20 approved routes, strict bodies, actor-auth requirements, operation responses, pages, revision conflicts, feature-specific errors, and reconciliation. Assert the internal document contains no public login/desktop route and the public document contains no `/internal/` path.

- [ ] **Step 7: Run Internal Admin and real database tests**

```bash
go test ./internal/adminapi ./cmd/aera-cloud ./api -run 'Official|InternalAdmin' -count=1
AERA_INTEGRATION_TESTS=1 go test -p 1 ./internal/admin ./internal/agentcontrol ./internal/adminapi -run 'Official|AdminOperation' -count=1
```

Expected: PASS, including authenticated-before-404/405 and atomic domain/idempotency/audit behavior.

- [ ] **Step 8: Commit the Internal Admin API**

```bash
git add internal/adminapi internal/admin/control_model.go internal/admin/control_model_test.go internal/admin/control_repository.go internal/admin/control_repository_test.go internal/admin/control_service.go internal/admin/control_service_test.go api/openapi/internal-admin.yaml api/internal_admin_openapi_test.go cmd/aera-cloud/internal_admin.go cmd/aera-cloud/main.go cmd/aera-cloud/internal_admin_test.go
git commit -m "feat: add official agent admin api"
```

### Task 8: Close the Cloud checkpoint before Admin integration

**Files:**

- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/README.md`
- Test: all Cloud files changed in Tasks 1–7

**Interfaces:**

- Consumes: complete Cloud PLATFORM/public/internal implementation.
- Produces: one reviewed Cloud commit range and exact OpenAPI documents for Admin/Desktop.

- [ ] **Step 1: Add failure-matrix and privacy boundary tests**

Extend focused tests to inject signer, policy, DLP, audit, idempotency, stale revision, concurrent Operator, disabled platform, unavailable rollout key, and database commit failures. Hash representative forbidden Profile/Memory/session/private-Skill fixtures outside the repository and assert no request/row contains them.

- [ ] **Step 2: Run the full Cloud verification gate**

```bash
cd /Users/zizimutou/Desktop/aera/aera-cloud
gofmt -w internal/config/official_agent*.go internal/agentcontrol/platform_*.go internal/adminapi/official_agent*.go
go test ./... -count=1
go vet ./...
AERA_INTEGRATION_TESTS=1 go test -p 1 ./... -count=1
```

Expected: all commands exit 0. If Docker-backed integration prerequisites are unavailable, stop and report that gate as unverified; do not substitute unit tests.

- [ ] **Step 3: Review the Cloud diff against the approved spec**

Run:

```bash
git diff main...HEAD --check
git diff main...HEAD --name-only
git status --short
```

Expected: only Cloud/config/docs/test files in scope, no `aera-runtime`, no secrets, and a clean worktree after commits.

- [ ] **Step 4: Commit Cloud operational documentation**

Document only development/test configuration and verification; do not add production keys or deployment steps.

```bash
git add README.md
git commit -m "docs: document official agent cloud verification"
```

### Task 9: Extend Admin RBAC, typed outbox payloads, and rollback dual control

**Files:**

- Create: `/Users/zizimutou/Desktop/aera/aera-admin/internal/store/migrations/000007_official_managed_agent_v1.sql`
- Modify: `/Users/zizimutou/Desktop/aera/aera-admin/internal/store/migrate_test.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-admin/internal/rbac/rbac.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-admin/internal/rbac/rbac_test.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-admin/internal/operations/model.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-admin/internal/operations/repository.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-admin/internal/operations/repository_test.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-admin/internal/operations/service.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-admin/internal/operations/service_test.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-admin/internal/settings/model.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-admin/internal/settings/model_test.go`

**Interfaces:**

- Consumes: existing six-role RBAC, append-only audit, idempotency, and outbox schema.
- Produces: fixed official permissions, typed command payload storage, and rollback approval tables used by Tasks 10–14.

- [ ] **Step 1: Write failing role and migration tests**

Assert this exact permission matrix:

```go
const (
    ReadOfficialAgents       Permission = "official_agent.read"
    ManageOfficialDrafts     Permission = "official_agent.draft.manage"
    ReviewOfficialAgents     Permission = "official_agent.review"
    ManageOfficialReleases   Permission = "official_agent.release.manage"
    RequestOfficialRollback  Permission = "official_agent.rollback.request"
    ApproveOfficialRollback  Permission = "official_agent.rollback.approve"
    ReadOfficialAgentAudit   Permission = "official_agent.audit.read"
)
```

Developer receives read+draft; Super Admin receives read+review+rollback approval+audit; Operator receives read+release+rollback request; Auditor receives read+audit; Support and Finance receive none.

Add migration assertions for `official_agent_rollback_requests`, `official_agent_rollback_events`, `command_payload`, `command_payload_digest`, and every new action constraint.

- [ ] **Step 2: Run focused tests and confirm RED**

```bash
cd /Users/zizimutou/Desktop/aera/aera-admin
go test ./internal/rbac ./internal/store ./internal/operations ./internal/settings -run 'Official|Migration|Outbox|Reason' -count=1
```

Expected: FAIL because permissions/schema/payload fields do not exist.

- [ ] **Step 3: Add backward-compatible typed outbox storage**

Migration 000007 adds `command_payload BYTEA NOT NULL DEFAULT decode('7b7d', 'hex')` and a 32-byte `command_payload_digest` to `admin_idempotency_records` and `admin_outbox`. BYTEA intentionally preserves the exact rebuilt canonical bytes across PostgreSQL round trips; do not use JSONB and then compare a digest of differently serialized text. Add payload length checks from 2 through 131072 bytes and digest-length checks. Backfill the digest with SHA-256 of canonical `{}`:

```sql
decode('44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a', 'hex')
```

Extend action constraints with the exact official actions:

```text
official_definition_reserve
official_draft_create
official_draft_update
official_draft_submit
official_submission_withdraw
official_submission_review
official_release_activate
official_release_rollout
official_release_pause
official_release_resume
official_release_rollback
```

Existing account/device/session rows retain `{}` and the fixed empty-object digest.

Drop and recreate `reason_codes_category_check` to add `official_agent`, seed active codes `official_content_review`, `official_rollout_change`, `official_release_pause`, and `official_release_rollback`, and add `UsageOfficialAgent`/`CategoryOfficialAgent` to the settings compatibility matrix. Official mutations validate only that usage or the existing `security` category.

- [ ] **Step 4: Add rollback request/event tables**

Use a domain-specific table so account lifecycle snapshots remain unchanged:

```sql
CREATE TABLE official_agent_rollback_requests (
    id UUID PRIMARY KEY,
    release_id UUID NOT NULL,
    target_version_id UUID NOT NULL,
    target_release_revision_id UUID NOT NULL,
    expected_head_revision BIGINT NOT NULL CHECK (expected_head_revision > 0),
    target_digest BYTEA NOT NULL CHECK (octet_length(target_digest) = 32),
    requested_by_admin_id UUID NOT NULL REFERENCES admin_users(id) ON DELETE RESTRICT,
    reviewed_by_admin_id UUID REFERENCES admin_users(id) ON DELETE RESTRICT,
    reason_code TEXT NOT NULL REFERENCES reason_codes(code) ON DELETE RESTRICT,
    ticket_reference TEXT,
    safe_note TEXT,
    approval_status TEXT NOT NULL CHECK (approval_status IN ('pending_review','approved','rejected','cancelled','expired')),
    execution_status TEXT NOT NULL CHECK (execution_status IN ('not_started','queued','executing','reconciling','succeeded','failed','conflict')),
    operation_id UUID UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    reviewed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    version BIGINT NOT NULL CHECK (version > 0),
    CHECK (reviewed_by_admin_id IS NULL OR reviewed_by_admin_id <> requested_by_admin_id)
);
```

Add append-only events with the existing approval/execution state vocabulary:

```sql
CREATE TABLE official_agent_rollback_events (
    id UUID PRIMARY KEY,
    rollback_request_id UUID NOT NULL
        REFERENCES official_agent_rollback_requests(id) ON DELETE RESTRICT,
    event_type TEXT NOT NULL CHECK (event_type IN (
        'requested','approved','rejected','cancelled','expired',
        'queued','executing','reconciling','succeeded','failed','conflict'
    )),
    actor_admin_id UUID NOT NULL REFERENCES admin_users(id) ON DELETE RESTRICT,
    actor_role TEXT NOT NULL CHECK (actor_role IN ('super_admin','developer','operator','support','finance','auditor')),
    approval_status TEXT NOT NULL CHECK (approval_status IN ('pending_review','approved','rejected','cancelled','expired')),
    execution_status TEXT NOT NULL CHECK (execution_status IN ('not_started','queued','executing','reconciling','succeeded','failed','conflict')),
    operation_id UUID,
    error_code TEXT CHECK (error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{2,99}$'),
    created_at TIMESTAMPTZ NOT NULL
);
```

Add an index on `(rollback_request_id, created_at, id)` and a trigger rejecting UPDATE/DELETE. The service appends an event in the same transaction as every approval/execution state change; it never rewrites prior events.

- [ ] **Step 5: Extend operations with canonical payloads**

Add:

```go
type EnqueueRequest struct {
    Actor admin.Actor
    Action Action
    TargetID uuid.UUID
    ExpectedRevision int64
    Payload json.RawMessage
    Reason admin.ActionReason
    BrowserIdempotencyKey string
    ApprovalID *uuid.UUID
}

type Job struct {
    OperationID uuid.UUID
    Action Action
    TargetID uuid.UUID
    ApprovalID *uuid.UUID
    ActorAdminID uuid.UUID
    ActorRole rbac.Role
    ExpectedRevision int64
    Payload json.RawMessage
    PayloadDigest [sha256.Size]byte
    ReasonCode string
    TicketReference string
    Note string
    RequestID string
    Attempts int
    State State
}
```

For each official action, decode with `json.Decoder.DisallowUnknownFields`, reject duplicate keys and trailing values, validate the typed command, and `json.Marshal` that fixed-field struct back to deterministic bytes before enqueue. Hash those exact rebuilt bytes into both the idempotency fingerprint and outbox row, and recheck the digest when claiming. Never call `json.Compact` on untrusted raw JSON and label it canonical. Existing actions accept only the exact `{}` payload.

- [ ] **Step 6: Run RBAC/schema/outbox tests**

```bash
go test ./internal/rbac ./internal/store ./internal/operations ./internal/settings -run 'Official|Migration|Outbox|Reason' -count=1
AERA_ADMIN_TEST_DATABASE_URL='postgres://aera_admin:aera-admin-dev-only@127.0.0.1:55435/aera_admin?sslmode=disable' go test ./internal/store ./internal/operations ./internal/settings -count=1
```

Expected: PASS with same-key/same-payload replay and same-key/different-payload conflict.

- [ ] **Step 7: Commit the Admin foundation extension**

```bash
git add internal/store/migrations/000007_official_managed_agent_v1.sql internal/store/migrate_test.go internal/rbac internal/operations internal/settings/model.go internal/settings/model_test.go
git commit -m "feat: extend admin controls for official agents"
```

### Task 10: Add actor-bound service JWT and strict Official Cloud client

**Files:**

- Create: `/Users/zizimutou/Desktop/aera/aera-admin/internal/cloudadmin/official_agent.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-admin/internal/cloudadmin/official_agent_test.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-admin/internal/cloudadmin/token.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-admin/internal/cloudadmin/token_test.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-admin/internal/cloudadmin/http_client.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-admin/internal/cloudadmin/http_client_test.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-admin/internal/cloudadmin/client.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-admin/internal/config/config_test.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-admin/.env.example`
- Modify: `/Users/zizimutou/Desktop/aera/aera-admin/README.md`
- Modify: `/Users/zizimutou/Desktop/aera/aera-admin/api/openapi/cloud-admin-client.yaml`
- Modify: `/Users/zizimutou/Desktop/aera/aera-admin/api/openapi_test.go`

**Interfaces:**

- Consumes: Cloud Task 7 Internal Admin OpenAPI and Admin fixed roles.
- Produces: strict `OfficialAgentClient`, signed actor claims, DTO validation, and operation dispatch used by Admin services/worker.

- [ ] **Step 1: Pin the exact Cloud Internal Admin document and write failing contract tests**

Copy the reviewed `aera-cloud/api/openapi/internal-admin.yaml` bytes into `api/openapi/cloud-admin-client.yaml`. Add a byte/hash contract assertion and tests that every listed official route exists, unknown fields are rejected, and the public desktop contract is absent.

- [ ] **Step 2: Write failing configuration and actor-token tests**

Update the enabled Cloud fixture, `.env.example`, and `README.md` with all five exact official scopes. The Admin client may hold only explicitly configured scopes; wildcard scopes still fail startup. Cloud's own `AGENTERA_CLOUD_OFFICIAL_AGENTS_ENABLED=false` remains the authoritative feature gate, so a disabled or unavailable Cloud produces an unavailable Official surface rather than mock data.

Define:

```go
type ActorContext struct {
    AdminID uuid.UUID
    Role rbac.Role
    OperationID *uuid.UUID
    ApprovalID *uuid.UUID
    RequesterAdminID *uuid.UUID
}
```

Test official requests fail locally without actor, nil UUID, invalid role, or mismatched response identity. Decode test JWTs and assert exact `admin_id`/`admin_role` claims, five-minute maximum lifetime, random JTI, and no reason, note, Manifest, Bundle, rollout list, or secret in claims.

- [ ] **Step 3: Run Cloud client tests and confirm RED**

```bash
go test ./internal/config ./internal/cloudadmin ./api -run 'Official|Actor|OpenAPI' -count=1
```

Expected: FAIL because actor-aware token issuance and official DTOs are absent.

- [ ] **Step 4: Implement actor-aware token issuance**

Change the private token source to:

```go
type tokenSource interface {
    Token(context.Context, *ActorContext) (string, error)
}
```

Existing Cloud user/device/account methods pass nil. Official reads pass actor ID/role only. Official mutations also sign operation ID; rollback signs approval ID and requester Admin ID. The Cloud cross-checks those signed claims against action scope and command body.

The example Cloud scope set becomes:

```json
[
  "users:read",
  "devices:write",
  "sessions:write",
  "accounts:write",
  "operations:read",
  "official_agents:read",
  "official_agent_drafts:write",
  "official_agent_reviews:write",
  "official_agent_releases:write",
  "official_agent_audit:read"
]
```

- [ ] **Step 5: Implement strict official DTOs and client methods**

Define `OfficialAgentClient` with read/validation methods and one command method:

```go
type OfficialAgentClient interface {
    ListOfficialDefinitions(context.Context, ActorContext, PageRequest) (Page[OfficialDefinition], error)
    GetOfficialDefinition(context.Context, ActorContext, uuid.UUID) (OfficialDefinitionDetail, error)
    ListOfficialDrafts(context.Context, ActorContext, PageRequest) (Page[OfficialDraft], error)
    GetOfficialDraft(context.Context, ActorContext, uuid.UUID) (OfficialDraft, error)
    ValidateOfficialDraft(context.Context, ActorContext, uuid.UUID) (OfficialDraftValidation, error)
    ListOfficialSubmissions(context.Context, ActorContext, OfficialSubmissionFilter) (Page[OfficialSubmission], error)
    GetOfficialSubmission(context.Context, ActorContext, uuid.UUID) (OfficialSubmission, error)
    ListOfficialVersions(context.Context, ActorContext, PageRequest) (Page[OfficialVersion], error)
    GetOfficialVersion(context.Context, ActorContext, uuid.UUID) (OfficialVersion, error)
    ListOfficialReleases(context.Context, ActorContext, PageRequest) (Page[OfficialRelease], error)
    GetOfficialRelease(context.Context, ActorContext, uuid.UUID) (OfficialReleaseDetail, error)
    ListOfficialAudit(context.Context, ActorContext, PageRequest) (Page[OfficialAuditEvent], error)
    ExecuteOfficialCommand(context.Context, ActorContext, OfficialCommand) (Operation, error)
}
```

Validate non-null arrays, canonical UUIDs, bounded strings, exact enums, digests, timestamps, revisions, and response target identity. Rebuild safe DTOs rather than decoding internal maps.

- [ ] **Step 6: Run client/contract tests**

```bash
go test ./internal/config ./internal/cloudadmin ./api -run 'Official|Actor|OpenAPI' -count=1
```

Expected: PASS, including mTLS/JWT/contract-stage error classification.

- [ ] **Step 7: Commit the Internal Admin client**

```bash
git add internal/cloudadmin internal/config/config_test.go .env.example README.md api/openapi/cloud-admin-client.yaml api/openapi_test.go
git commit -m "feat: add official agent cloud client"
```

### Task 11: Implement Admin official workflow, outbox dispatch, and rollback approval

**Files:**

- Create: `/Users/zizimutou/Desktop/aera/aera-admin/internal/officialagent/model.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-admin/internal/officialagent/model_test.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-admin/internal/officialagent/repository.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-admin/internal/officialagent/repository_test.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-admin/internal/officialagent/service.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-admin/internal/officialagent/service_test.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-admin/internal/operations/worker.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-admin/internal/operations/worker_test.go`

**Interfaces:**

- Consumes: Tasks 9–10 permissions, typed outbox, official Cloud client, and rollback schema.
- Produces: one Admin domain service for browser BFF and worker execution.

- [ ] **Step 1: Write failing service matrix and fail-closed tests**

Cover every role/action pair, Cloud unavailable reads, draft mutation enqueue, review self-separation, review timeout→reconciling, Operator rollback request, same-admin rollback approval denial, Super Admin approval enqueue, rejection/cancellation, stale target digest, and Cloud success as the only source of `succeeded`.

- [ ] **Step 2: Run official service tests and confirm RED**

```bash
go test ./internal/officialagent ./internal/operations -run 'Official|Rollback' -count=1
```

Expected: FAIL because the service and worker dispatch do not exist.

- [ ] **Step 3: Implement safe reads and mutation enqueue**

Expose:

```go
type Service struct { /* Cloud, Operations, Repository, Audit, Reasons, Clock */ }

func (s *Service) ListDefinitions(context.Context, admin.Actor, cloudadmin.PageRequest) (cloudadmin.Page[cloudadmin.OfficialDefinition], error)
func (s *Service) GetDraft(context.Context, admin.Actor, uuid.UUID) (cloudadmin.OfficialDraft, error)
func (s *Service) ValidateDraft(context.Context, admin.Actor, uuid.UUID) (cloudadmin.OfficialDraftValidation, error)
func (s *Service) Enqueue(context.Context, admin.Actor, MutationRequest) (operations.Result, error)
func (s *Service) RequestRollback(context.Context, admin.Actor, RollbackRequest) (RollbackApproval, error)
func (s *Service) ApproveRollback(context.Context, admin.Actor, uuid.UUID, string) (RollbackApproval, error)
func (s *Service) RejectRollback(context.Context, admin.Actor, uuid.UUID) (RollbackApproval, error)
func (s *Service) CancelRollback(context.Context, admin.Actor, uuid.UUID) (RollbackApproval, error)
```

Reads call Cloud with signed actor and return unavailable on missing/unknown Cloud state. Mutations validate exact permission, typed payload, reason catalog, expected revision/digest, canonical JSON, and browser idempotency before enqueue. An approve-review command requires a non-empty, deduplicated subset of `internal|stable` as `initial_channels`; reject and withdraw carry no channels. No mutation returns a fabricated resource state.

- [ ] **Step 4: Implement rollback dual-control transaction**

Operator request fetches the release and target approved Version, stores their IDs/revisions/digest, and appends local audit/event. A different Super Admin approval locks the request, rechecks expiry/version/digest through Cloud, enqueues `official_release_rollback` in the same PostgreSQL transaction, then marks approval queued. The outbox payload includes release, target Version, target release revision, expected head, request Admin ID, and approval ID.

- [ ] **Step 5: Dispatch official jobs in the existing worker**

For each official Action, decode the exact payload type with `DisallowUnknownFields`, re-hash canonical bytes, construct `cloudadmin.OfficialCommand`, and call `ExecuteOfficialCommand(ctx, actor, command)`. On unavailable/timeout transition to reconciling and use existing `GetOperation` with the same operation ID. On conflict/failure update both operation and rollback execution sink atomically.

- [ ] **Step 6: Run unit and PostgreSQL tests**

```bash
go test ./internal/officialagent ./internal/operations -run 'Official|Rollback' -count=1
AERA_ADMIN_TEST_DATABASE_URL='postgres://aera_admin:aera-admin-dev-only@127.0.0.1:55435/aera_admin?sslmode=disable' go test ./internal/officialagent ./internal/operations -count=1
```

Expected: PASS with one rollback approval, one outbox row, one operation ID, and no state marked succeeded before reconciled Cloud success.

- [ ] **Step 7: Commit the Admin domain workflow**

```bash
git add internal/officialagent internal/operations/worker.go internal/operations/worker_test.go
git commit -m "feat: govern official agent admin workflow"
```

### Task 12: Expose the strict Admin BFF and browser OpenAPI

**Files:**

- Create: `/Users/zizimutou/Desktop/aera/aera-admin/internal/officialagent/http.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-admin/internal/officialagent/http_test.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-admin/cmd/aera-admin/main.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-admin/cmd/aera-admin/main_test.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-admin/api/openapi/admin.yaml`
- Modify: `/Users/zizimutou/Desktop/aera/aera-admin/api/openapi_test.go`

**Interfaces:**

- Consumes: Admin Task 11 Service and fixed permissions.
- Produces: safe browser routes consumed by React Task 13.

- [ ] **Step 1: Write failing six-role HTTP matrix tests**

Test every route with all six roles, recent-TOTP requirements for reviews/releases/rollback, strict JSON/query parsing, safe error mapping, idempotency header, CSRF/session middleware, Cloud unavailable, and no raw Cloud body/token/certificate/key exposure.

- [ ] **Step 2: Run BFF/OpenAPI tests and confirm RED**

```bash
go test ./internal/officialagent ./cmd/aera-admin ./api -run 'Official|OpenAPIContract|RoleMatrix' -count=1
```

Expected: FAIL because browser routes and schemas are absent.

- [ ] **Step 3: Register permission-gated browser routes**

Mount under the authenticated Admin router:

```text
GET|POST /official-agents
GET      /official-agents/{definitionID}
GET|POST /official-agent-drafts
GET|PATCH /official-agent-drafts/{draftID}
POST     /official-agent-drafts/{draftID}/validate
POST     /official-agent-drafts/{draftID}/submit
GET      /official-agent-submissions
GET      /official-agent-submissions/{submissionID}
POST     /official-agent-submissions/{submissionID}/withdraw
POST     /official-agent-submissions/{submissionID}/review
GET      /official-agent-versions
GET      /official-agent-releases
GET      /official-agent-releases/{releaseID}
POST     /official-agent-releases/{releaseID}/activate
POST     /official-agent-releases/{releaseID}/rollout
POST     /official-agent-releases/{releaseID}/pause
POST     /official-agent-releases/{releaseID}/resume
POST     /official-agent-releases/{releaseID}/rollback-requests
GET      /official-agent-rollback-requests
POST     /official-agent-rollback-requests/{approvalID}/approve
POST     /official-agent-rollback-requests/{approvalID}/reject
POST     /official-agent-rollback-requests/{approvalID}/cancel
GET      /official-agent-audit-events
```

All mutations return local operation or approval state, never a false final Cloud resource.

- [ ] **Step 4: Add strict Admin OpenAPI and runtime composition**

Document `additionalProperties:false`, exact enums, non-null arrays, bounded strings, revision/digest requirements, review `initial_channels`, idempotency headers, permission/step-up errors, unavailable state, and safe operation/approval DTOs. Construct the official service once in `buildAdminRuntime`, pass it to both handler and worker, and fail startup when dependencies are partially configured.

- [ ] **Step 5: Run BFF/OpenAPI tests**

```bash
go test ./internal/officialagent ./cmd/aera-admin ./api -run 'Official|OpenAPIContract|RoleMatrix' -count=1
```

Expected: PASS with all route permissions server-enforced.

- [ ] **Step 6: Commit the browser API**

```bash
git add internal/officialagent/http.go internal/officialagent/http_test.go cmd/aera-admin/main.go cmd/aera-admin/main_test.go api/openapi/admin.yaml api/openapi_test.go
git commit -m "feat: expose official agent admin api"
```

### Task 13: Build the role-specific Admin official-Agent UI

**Files:**

- Create: `/Users/zizimutou/Desktop/aera/aera-admin/web/src/pages/OfficialAgentsPage.tsx`
- Create: `/Users/zizimutou/Desktop/aera/aera-admin/web/src/pages/OfficialAgentsPage.test.tsx`
- Create: `/Users/zizimutou/Desktop/aera/aera-admin/web/src/pages/OfficialAgentEditorPage.tsx`
- Create: `/Users/zizimutou/Desktop/aera/aera-admin/web/src/pages/OfficialAgentEditorPage.test.tsx`
- Create: `/Users/zizimutou/Desktop/aera/aera-admin/web/src/pages/OfficialAgentReviewsPage.tsx`
- Create: `/Users/zizimutou/Desktop/aera/aera-admin/web/src/pages/OfficialAgentReviewsPage.test.tsx`
- Create: `/Users/zizimutou/Desktop/aera/aera-admin/web/src/pages/OfficialAgentReleasesPage.tsx`
- Create: `/Users/zizimutou/Desktop/aera/aera-admin/web/src/pages/OfficialAgentReleasesPage.test.tsx`
- Modify: `/Users/zizimutou/Desktop/aera/aera-admin/web/src/api/contracts.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera-admin/web/src/api/client.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera-admin/web/src/api/client.test.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera-admin/web/src/app/router.tsx`
- Modify: `/Users/zizimutou/Desktop/aera/aera-admin/web/src/app/router.test.tsx`
- Modify: `/Users/zizimutou/Desktop/aera/aera-admin/web/src/layout/AdminLayout.tsx`
- Modify: `/Users/zizimutou/Desktop/aera/aera-admin/web/src/layout/AdminLayout.test.tsx`

**Interfaces:**

- Consumes: Task 12 Admin OpenAPI/DTOs.
- Produces: complete employee management workflow without direct Cloud access.

- [ ] **Step 1: Write failing UI permission and state tests**

Assert Developer editor/submit, Super Admin immutable review, Operator release controls, Auditor read-only history, Support/Finance no navigation, step-up prompts, operation state progression, unavailable Cloud banner, stale revision refresh, no raw identity/allowlist list in audit, and no mutation presented as successful while queued/reconciling.

- [ ] **Step 2: Run focused UI tests and confirm RED**

```bash
cd /Users/zizimutou/Desktop/aera/aera-admin
pnpm --filter @aera/admin-web test --run Official
```

Expected: FAIL because official pages/contracts/routes are absent.

- [ ] **Step 3: Add strict browser contracts and client methods**

Define explicit Zod schemas/types for Definition, Draft, Validation, Submission, Version, Release, ReleaseRevision, Operation, RollbackApproval, and AuditPage. Reject nullable arrays where the contract requires `[]`, unknown enum values, non-canonical IDs, invalid digests, and unbounded strings. Client mutation methods always send an `Idempotency-Key` and never accept Cloud origin/token from components.

- [ ] **Step 4: Build Developer and review screens**

The editor uses controlled Manifest/Bundle fields, expected revision, safe validation findings, and explicit submit confirmation. The review page renders the frozen content digest and policy version, disables self-review, requires recent TOTP, requires an explicit non-empty selection of policy-permitted initial channels on approval, sends no channel on rejection, and distinguishes queued/reconciling/succeeded/failed/conflict.

- [ ] **Step 5: Build release and rollback screens**

Operator selects one approved Version, channel, 0–100% converted to integer basis points, strict minimum SemVer, and exact masked-account allowlist lookup. Pause/resume and rollout changes require reason/ticket. Rollback creates a pending request; only a different Super Admin sees approve/reject. Auditor sees immutable history without controls.

- [ ] **Step 6: Wire routes and navigation**

Use permission gates for `/official-agents`, `/official-agents/:definitionID/edit`, `/official-agent-reviews`, and `/official-agent-releases`. Do not add an Official product space or any Desktop/Hermes controls to Admin.

- [ ] **Step 7: Run full web checks**

```bash
pnpm --filter @aera/admin-web lint
pnpm --filter @aera/admin-web test --run
pnpm --filter @aera/admin-web typecheck
pnpm --filter @aera/admin-web build
```

Expected: all commands exit 0.

- [ ] **Step 8: Commit the Admin UI**

```bash
git add web/src/api web/src/pages/OfficialAgent* web/src/app/router.tsx web/src/app/router.test.tsx web/src/layout/AdminLayout.tsx web/src/layout/AdminLayout.test.tsx
git commit -m "feat: add official agent admin console"
```

### Task 14: Prove Admin against the real Cloud Internal Admin API

**Files:**

- Create: `/Users/zizimutou/Desktop/aera/aera-admin/e2e/official-agent.spec.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera-admin/e2e/support.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera-admin/scripts/run-e2e.sh`
- Modify: `/Users/zizimutou/Desktop/aera/aera-admin/scripts/tests/run-e2e-contract.test.sh`
- Modify: `/Users/zizimutou/Desktop/aera/aera-admin/Makefile`
- Modify: `/Users/zizimutou/Desktop/aera/aera-admin/README.md`

**Interfaces:**

- Consumes: complete Cloud Tasks 1–8 and Admin Tasks 9–13.
- Produces: real mTLS/service-JWT/outbox/reconciliation evidence before Desktop integration.

- [ ] **Step 1: Extend the E2E runner contract**

Require `AERA_ADMIN_E2E_CLOUD_REPO` to resolve exactly one clean Cloud checkout, build Cloud from that path, generate ephemeral CA/server/client certificates and Ed25519 service keys, configure official platform/rollout keys only inside the temp directory, and remove every temp secret on teardown.

- [ ] **Step 2: Write the real-process E2E**

Exercise Developer draft+submit, different Super Admin approval, Operator v1 activation at an allowlisted account, v2 approval leaving v1 head unchanged, v2 rollout, pause/resume, rollback request, different Super Admin approval, Auditor history, Support/Finance denial, and Admin unavailable when Cloud is stopped. Assert approval state and Cloud execution state remain separate throughout.

- [ ] **Step 3: Run real Cloud E2E**

```bash
cd /Users/zizimutou/Desktop/aera/aera-admin
AERA_ADMIN_E2E_CLOUD_REPO=/Users/zizimutou/Desktop/aera/aera-cloud make e2e
```

Expected: PASS against the actual local Cloud Internal Admin listener; no mock success path is accepted.

- [ ] **Step 4: Run the complete Admin gate**

Before running it, extend the `test-integration` and `race` package lists in `Makefile` to include `./internal/officialagent`; do not rely on the package being covered incidentally by the unit target.

```bash
make verify
```

Expected: format, vet, unit, integration, race, web, OpenAPI, E2E typecheck, and release build all exit 0.

- [ ] **Step 5: Commit E2E and documentation**

```bash
git add e2e/official-agent.spec.ts e2e/support.ts scripts/run-e2e.sh scripts/tests/run-e2e-contract.test.sh Makefile README.md
git commit -m "test: prove official agent admin workflow"
```

### Task 15: Pin the public contract and add renderer-safe official catalog types

**Files:**

- Create: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-agent-control/official-channel.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-agent-control/official-channel.test.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/contracts/agentera-cloud.openapi.yaml`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/shared/agentera-cloud-api.generated.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/shared/agentera-agent-control.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-agent-control/client.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-agent-control/client.test.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/scripts/check-agentera-cloud-contract.mjs`

**Interfaces:**

- Consumes: Cloud Task 6 public OpenAPI.
- Produces: generated official API types, strict client methods, and trusted channel derivation used by all Desktop tasks.

- [ ] **Step 1: Replace the pinned Cloud contract and confirm deterministic generation fails**

Update `contracts/agentera-cloud.openapi.yaml` byte-for-byte from the reviewed Cloud public document, then run:

```bash
cd /Users/zizimutou/Desktop/aera/aera
npm run check:agentera-cloud-contract
```

Expected: FAIL because generated TypeScript and the pinned hash are stale.

- [ ] **Step 2: Generate types and write failing client/channel tests**

```bash
npm run generate:agentera-cloud
```

Add tests that packaged builds always use `stable`, unpackaged development/test accepts only `internal|stable` through the main-process environment and defaults to `internal`, renderer input cannot choose channel, catalog DTOs reject extra/private fields, and managed apply cannot carry arbitrary Version or ownership.

- [ ] **Step 3: Implement trusted channel derivation**

Use this exact function:

```ts
export type OfficialAgentChannel = "internal" | "stable";

export function resolveOfficialAgentChannel(input: {
  isPackaged: boolean;
  environment: NodeJS.ProcessEnv;
}): OfficialAgentChannel {
  if (input.isPackaged) return "stable";
  const configured = input.environment.AGENTERA_OFFICIAL_AGENT_CHANNEL;
  if (configured === undefined || configured === "") return "internal";
  if (configured === "internal" || configured === "stable") return configured;
  throw new Error("Invalid official Agent channel.");
}
```

Do not expose the environment value to preload/renderer.

- [ ] **Step 4: Add exact shared safe types**

Define:

```ts
export interface OfficialAgentSummary {
  definitionId: string;
  displayName: string;
  iconMediaType: "image/png" | "image/webp" | null;
  iconDataBase64Url: string | null;
  versionId: string;
  versionNumber: number;
  releaseId: string;
  releaseRevisionId: string;
  channel: OfficialAgentChannel;
  runtimeMinimumVersion: string;
  runtimeMaximumVersionExclusive: string | null;
  installationState: "not_installed" | "installed";
  updateState: "current" | "update_available";
}

export interface OfficialManagedUpdate {
  installationId: string;
  expectedSelectedReleaseRevisionId: string;
  targetReleaseRevisionId: string;
  targetVersionId: string;
}
```

Renderer-safe types contain no platform ID, user/device ID, rollout bucket/key, allowlist, policy internals, Profile/path, prompt/Bundle bytes, credentials, or private learning.

- [ ] **Step 5: Implement strict client methods**

Add `listOfficialAgents`, `getOfficialAgent`, `getOfficialRelease`, `getManagedUpdate`, and `applyManagedUpdate`. The client derives channel, current desktop version, and selected personal/workspace/organization context in main; it serializes only the four bounded headers above and never accepts them from renderer input. Apply body sends only expected/target release revisions. Parse with exact field allowlists and detach all arrays/objects.

- [ ] **Step 6: Run contract, client, and channel tests**

```bash
npm run check:agentera-cloud-contract
npx vitest run src/main/agentera-agent-control/client.test.ts src/main/agentera-agent-control/official-channel.test.ts
npm run typecheck
```

Expected: all commands exit 0.

- [ ] **Step 7: Commit the Desktop contract slice**

```bash
git add contracts/agentera-cloud.openapi.yaml src/shared/agentera-cloud-api.generated.ts src/shared/agentera-agent-control.ts src/main/agentera-agent-control/client.ts src/main/agentera-agent-control/client.test.ts src/main/agentera-agent-control/official-channel.ts src/main/agentera-agent-control/official-channel.test.ts scripts/check-agentera-cloud-contract.mjs
git commit -m "feat: add official agent desktop contract"
```

### Task 16: Add fresh-only official Installation and PLATFORM-source local schema

**Files:**

- Create: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-agent-control/official-agent-service.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-agent-control/official-agent-service.test.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-agent-control/db.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/tests/agentera-agent-control-db.test.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-agent-control/installation-manager.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-agent-control/installation-manager.test.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-agent-control/manager.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-agent-control/manager.test.ts`

**Interfaces:**

- Consumes: Task 15 client/types and existing Version cache, trust, projection, Profile adapter, and USER owner derivation.
- Produces: local schema v6, official catalog service, one-use install handle, and fresh isolated Installation.

- [ ] **Step 1: Write failing schema and fresh-only installation tests**

Cover v5→v6 migration, exact PLATFORM source check, legacy row preservation, catalog generation invalidation, renderer handle misuse, account/device/context changes, Profile claim denial, Cloud conflict, signature/digest/policy/cache/projection/Profile/activation failure, and retry without deleting created Profile.

- [ ] **Step 2: Run focused tests and confirm RED**

```bash
npx vitest run tests/agentera-agent-control-db.test.ts src/main/agentera-agent-control/official-agent-service.test.ts src/main/agentera-agent-control/installation-manager.test.ts
```

Expected: FAIL because schema v6 and official service do not exist.

- [ ] **Step 3: Add exact SQLite v6 columns and checks**

Raise `AGENTERA_CONTROL_PLANE_SCHEMA_VERSION` from 5 to 6 and rebuild `local_agent_installations` with:

```text
source_scope: USER | WORKSPACE | ORGANIZATION | PLATFORM
source_workspace_id: non-null only for WORKSPACE
source_organization_id: non-null only for ORGANIZATION
official_release_id: non-null only for PLATFORM
selected_release_revision_id: non-null only for PLATFORM
update_policy: manual for USER/WORKSPACE/ORGANIZATION, managed for PLATFORM
```

Preserve every existing ID, owner tuple, selected Version, Runtime Profile, policy, status, retry code, and timestamp. No migration reads or writes `HERMES_HOME`.

- [ ] **Step 4: Implement catalog and one-use install handles**

`OfficialAgentService.list()` requires authenticated online access and returns only safe summaries. `prepareInstall(definitionId)` re-fetches the exact release and returns a random opaque handle bound to owner generation, device, product context, channel, Definition, release revision, and expiry. `confirmInstall(handle, "install-official-agent")` consumes the handle once and never accepts Profile/path/Version/owner input.

- [ ] **Step 5: Extend InstallationManager with a PLATFORM source variant**

Add:

```ts
type AgentInstallationSource =
  | { scope: "USER" }
  | { scope: "WORKSPACE"; workspaceId: string }
  | { scope: "ORGANIZATION"; organizationId: string }
  | {
      scope: "PLATFORM";
      officialReleaseId: string;
      selectedReleaseRevisionId: string;
      updatePolicy: "managed";
    };
```

Official install calls Cloud with Definition+release revision, downloads the Cloud-derived Version and signed policy, caches and projects read-only assets outside `HERMES_HOME`, calls only `{kind:"fresh", name}`, creates Profile with `cloneFrom=null`, binds opaque Runtime Profile ID, activates with device proof, and commits local state atomically. Reject `{kind:"claim"}` before Cloud mutation.

- [ ] **Step 6: Run focused installation tests**

```bash
npx vitest run tests/agentera-agent-control-db.test.ts src/main/agentera-agent-control/official-agent-service.test.ts src/main/agentera-agent-control/installation-manager.test.ts src/main/agentera-agent-control/manager.test.ts
```

Expected: PASS with one USER-owned local Installation and one new Profile, and all failure injections preserving prior Profiles/private fixtures.

- [ ] **Step 7: Commit fresh official installation**

```bash
git add src/main/agentera-agent-control/db.ts tests/agentera-agent-control-db.test.ts src/main/agentera-agent-control/official-agent-service.ts src/main/agentera-agent-control/official-agent-service.test.ts src/main/agentera-agent-control/installation-manager.ts src/main/agentera-agent-control/installation-manager.test.ts src/main/agentera-agent-control/manager.ts src/main/agentera-agent-control/manager.test.ts
git commit -m "feat: install official agents in fresh profiles"
```

### Task 17: Implement managed update, rollback, and immutable RuntimeBinding provenance

**Files:**

- Modify: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-agent-control/official-agent-service.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-agent-control/official-agent-service.test.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-agent-control/installation-manager.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-agent-control/installation-manager.test.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-agent-control/runtime-binding-store.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-agent-control/runtime-binding-store.test.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-agent-control/hermes-adapter.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-agent-control/hermes-adapter.test.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-agent-control/manager.ts`

**Interfaces:**

- Consumes: PLATFORM Installation from Task 16 and Cloud managed-target API.
- Produces: atomic verified managed selection and release provenance for later conversations only.

- [ ] **Step 1: Write failing v1→v2→rollback binding tests**

Start one v1 binding, prepare v2, inject every failure before/after Cloud selection, assert v1 stays locally active until projection commit, then create a v2 binding while v1 binding remains unchanged. Repeat rollback to v1 while an active v2 binding remains v2. Include idempotent recovery when Cloud succeeded but local activation failed.

- [ ] **Step 2: Run focused tests and confirm RED**

```bash
npx vitest run src/main/agentera-agent-control/official-agent-service.test.ts src/main/agentera-agent-control/installation-manager.test.ts src/main/agentera-agent-control/runtime-binding-store.test.ts src/main/agentera-agent-control/hermes-adapter.test.ts
```

Expected: FAIL because managed selection/provenance are absent.

- [ ] **Step 3: Implement prepare/recheck/commit managed selection**

The exact order is:

```text
get authoritative managed target
download and verify immutable Version
stage verified cache and read-only projection
apply Cloud selection with expected and target release revisions
download and verify returned signed policy
atomically activate projection and local selected Version/revision/policy
emit state for later conversations
```

If Cloud records selection and local activation fails, retain the prior local selection, persist a retry code without private data, and retry the same idempotency key. On retry, reconcile Cloud selection, re-verify Version/policy, and only then advance local state. Conversation start never waits for a live Cloud call.

- [ ] **Step 4: Add immutable release provenance to RuntimeBinding**

Extend local binding and sanitized Cloud record with `officialReleaseRevisionId: string | null`. Require it for PLATFORM source, forbid it for other sources, and include it in canonical binding JSON. Existing binding rows migrate/read with null. `prepareInstalledTurn` reads the Installation's locally committed Version/revision once and never rewrites an existing binding.

- [ ] **Step 5: Prove Hermes private learning remains native**

Add fixtures for Memory, USER, session, local file, learned Skill, and Curator state. Update/rollback may change only version-cache/projection/local control-plane rows. The same physical Profile remains bound, and Hermes continues writing only its private Profile after each new turn.

- [ ] **Step 6: Run focused managed-selection tests**

```bash
npx vitest run src/main/agentera-agent-control/official-agent-service.test.ts src/main/agentera-agent-control/installation-manager.test.ts src/main/agentera-agent-control/runtime-binding-store.test.ts src/main/agentera-agent-control/hermes-adapter.test.ts
```

Expected: PASS with old/new bindings immutable and private fixtures unchanged except explicit native Hermes writes.

- [ ] **Step 7: Commit managed update and rollback**

```bash
git add src/main/agentera-agent-control/official-agent-service.ts src/main/agentera-agent-control/official-agent-service.test.ts src/main/agentera-agent-control/installation-manager.ts src/main/agentera-agent-control/installation-manager.test.ts src/main/agentera-agent-control/runtime-binding-store.ts src/main/agentera-agent-control/runtime-binding-store.test.ts src/main/agentera-agent-control/hermes-adapter.ts src/main/agentera-agent-control/hermes-adapter.test.ts src/main/agentera-agent-control/manager.ts
git commit -m "feat: manage official agent versions safely"
```

### Task 18: Add safe IPC, official catalog UI, pause, and offline behavior

**Files:**

- Create: `/Users/zizimutou/Desktop/aera/aera/src/renderer/src/screens/Agents/OfficialAgentSection.tsx`
- Create: `/Users/zizimutou/Desktop/aera/aera/src/renderer/src/screens/Agents/OfficialAgentSection.test.tsx`
- Create: `/Users/zizimutou/Desktop/aera/aera/src/renderer/src/screens/Agents/OfficialAgentInstallDialog.tsx`
- Create: `/Users/zizimutou/Desktop/aera/aera/src/renderer/src/screens/Agents/OfficialAgentInstallDialog.test.tsx`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-agent-control/ipc-contract.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/tests/agentera-agent-control-ipc.test.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/main/ipc/register.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/main/ipc/auth-guard.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/preload/index.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/preload/index.d.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/renderer/src/screens/Agents/AgentControlPanel.tsx`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/renderer/src/screens/Agents/AgentControlPanel.test.tsx`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/shared/i18n/locales/ar/agents.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/shared/i18n/locales/en/agents.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/shared/i18n/locales/es/agents.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/shared/i18n/locales/he/agents.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/shared/i18n/locales/id/agents.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/shared/i18n/locales/ja/agents.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/shared/i18n/locales/pl/agents.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/shared/i18n/locales/pt-BR/agents.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/shared/i18n/locales/pt-PT/agents.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/shared/i18n/locales/tr/agents.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/shared/i18n/locales/zh-CN/agents.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/shared/i18n/locales/zh-TW/agents.ts`

**Interfaces:**

- Consumes: Tasks 15–17 safe service methods.
- Produces: user-visible catalog/install/update surface within existing product spaces.

- [ ] **Step 1: Write failing IPC boundary tests**

Add exact channels:

```text
agentera-agents-list-official
agentera-agents-prepare-official-install
agentera-agents-confirm-official-install
agentera-agents-refresh-official-updates
agentera-agents-apply-official-update
```

Renderer inputs may contain only Definition ID, Installation ID, opaque handle, and fixed confirmation string. Reject owner scope, platform/user/device/role, channel, Version/release target, Profile name/path, Cloud origin/token/key, policy, Manifest/Bundle, Memory, session, private Skill, and local-learning fields.

- [ ] **Step 2: Run IPC/UI tests and confirm RED**

```bash
npx vitest run tests/agentera-agent-control-ipc.test.ts src/renderer/src/screens/Agents/OfficialAgentSection.test.tsx src/renderer/src/screens/Agents/OfficialAgentInstallDialog.test.tsx src/renderer/src/screens/Agents/AgentControlPanel.test.tsx
```

Expected: FAIL because official IPC/preload/UI do not exist.

- [ ] **Step 3: Register authenticated/online policies and preload surface**

List catalog, prepare install, confirm install, refresh updates, and apply update are online-authenticated. Existing installed official Agents remain readable through public state offline. Every pending handle binds account/device/context generation; auth, device, selected space, or connectivity changes invalidate it.

- [ ] **Step 4: Build official catalog and fresh-install dialog**

Show an Official badge/section inside Personal, Workspace, and Organization Agent views. Display name/icon, channel, installed Version, update readiness, and safe denial. The dialog only confirms creating a new isolated Profile; it never offers an existing Profile picker.

- [ ] **Step 5: Implement truthful pause and offline presentation**

When online pause removes a not-installed Agent from fresh catalog or returns the bounded paused state. Existing installed rows remain usable and show “using last verified local version” without remote-disable claims. Offline shows verified installed official Agents only, disables catalog/install/refresh/update, and keeps new local conversations available under valid entitlement.

- [ ] **Step 6: Add complete localized copy and tests**

Add keys to every existing locale file and extend locale completeness tests. Copy must distinguish “official source”, “installed locally”, “update ready for new conversations”, “existing conversations unchanged”, “release paused for new installs”, and “offline state may be stale”.

- [ ] **Step 7: Run IPC, renderer, type, and locale tests**

```bash
npx vitest run tests/agentera-agent-control-ipc.test.ts src/renderer/src/screens/Agents/OfficialAgentSection.test.tsx src/renderer/src/screens/Agents/OfficialAgentInstallDialog.test.tsx src/renderer/src/screens/Agents/AgentControlPanel.test.tsx src/shared/i18n
npm run typecheck
```

Expected: all commands exit 0.

- [ ] **Step 8: Commit IPC and UI**

```bash
git add src/main/agentera-agent-control/ipc-contract.ts tests/agentera-agent-control-ipc.test.ts src/main/ipc/register.ts src/main/ipc/auth-guard.ts src/preload/index.ts src/preload/index.d.ts src/renderer/src/screens/Agents/OfficialAgentSection.tsx src/renderer/src/screens/Agents/OfficialAgentSection.test.tsx src/renderer/src/screens/Agents/OfficialAgentInstallDialog.tsx src/renderer/src/screens/Agents/OfficialAgentInstallDialog.test.tsx src/renderer/src/screens/Agents/AgentControlPanel.tsx src/renderer/src/screens/Agents/AgentControlPanel.test.tsx src/shared/i18n/locales
git commit -m "feat: add official agent desktop experience"
```

### Task 19: Prove privacy boundaries and the complete v1/v2/rollback flow

**Files:**

- Create: `/Users/zizimutou/Desktop/aera/aera/tests/agentera-official-agent-boundary.test.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera/tests/e2e/agentera-official-managed-agent.e2e.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/tests/e2e/support/agentera-agent-control-harness.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/tests/e2e/support/agentera-product-auth-harness.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/package.json`
- Modify: `/Users/zizimutou/Desktop/aera/aera/AGENTS.md`

**Interfaces:**

- Consumes: complete Cloud/Admin/Desktop implementation.
- Produces: the approved deterministic acceptance proof and exact executable command.

- [ ] **Step 1: Write the static boundary test**

Allow `PLATFORM`, release, and official vocabulary only in contract, catalog, Installation provenance, policy, RuntimeBinding metadata, UI, and tests. Reject it from Hermes private-state mutation, Memory, USER, session storage, learned-Skill mutation, Curator, credentials, Runtime distribution, Profile ownership, and legacy `agent-sync.ts`. Assert no request to `/api/agents` occurs.

- [ ] **Step 2: Extend the real-process harness**

Require:

```text
AERA_OFFICIAL_AGENT_E2E_CLOUD_REPO=/Users/zizimutou/Desktop/aera/aera-cloud
AERA_OFFICIAL_AGENT_E2E_ADMIN_REPO=/Users/zizimutou/Desktop/aera/aera-admin
```

The harness validates both paths, launches isolated PostgreSQL/Redis, generates only temp mTLS/JWT/signing/HMAC material, starts Cloud public+internal listeners, starts Admin, launches two isolated Electron users, captures requests, and removes only its own temp data/containers.

- [ ] **Step 3: Implement the 12-step E2E scenario**

Prove exactly:

```text
Developer submits v1
different Super Admin approves v1
Operator activates bounded rollout
eligible user sees/installs v1; ineligible user does not
v1 conversation starts and writes private learning markers
Developer submits v2; different Super Admin approves without changing v1 head
Operator activates v2; new conversation uses v2; running v1 remains v1
Operator requests rollback; different Super Admin approves
later conversation uses v1; running v2 remains v2
Operator pauses; new user cannot discover/install; installed user continues
installed user starts cached offline conversation under valid entitlement
fixture hashes/request capture prove no private data or legacy protocol crossed the boundary
```

Inject Admin outbox loss, ambiguous Cloud response, signer/audit failure, stale release revision, interrupted download, digest mismatch, policy denial, cache/Profile/projection failure, managed-selection conflict, rollback materialization failure, and reconnect after offline use.

- [ ] **Step 4: Add and run the exact E2E command**

Add:

```json
"test:e2e:official-managed-agent": "npm run build && playwright test tests/e2e/agentera-official-managed-agent.e2e.ts"
```

Run:

```bash
AERA_OFFICIAL_AGENT_E2E_CLOUD_REPO=/Users/zizimutou/Desktop/aera/aera-cloud \
AERA_OFFICIAL_AGENT_E2E_ADMIN_REPO=/Users/zizimutou/Desktop/aera/aera-admin \
npm run test:e2e:official-managed-agent
```

Expected: PASS with v1/v2/rollback binding IDs, one unchanged physical Profile, and private fixture hashes reported.

- [ ] **Step 5: Commit the executable acceptance gate**

```bash
git add tests/agentera-official-agent-boundary.test.ts tests/e2e/agentera-official-managed-agent.e2e.ts tests/e2e/support/agentera-agent-control-harness.ts tests/e2e/support/agentera-product-auth-harness.ts package.json AGENTS.md
git commit -m "test: prove official managed agent flow"
```

### Task 20: Run full verification, document evidence, and prepare local integration

**Files:**

- Modify: `/Users/zizimutou/Desktop/aera/aera/lat.md/agentera-agent-control-plane.md`
- Modify: `/Users/zizimutou/Desktop/aera/aera/lat.md/agentera-self-evolution.md`
- Modify: `/Users/zizimutou/Desktop/aera/aera/README.md`
- Test: all three feature branches

**Interfaces:**

- Consumes: Tasks 1–19.
- Produces: evidence-backed implementation status and three clean feature branches ready for review; it does not itself authorize merge/push/deploy/release.

- [ ] **Step 1: Run Cloud full verification on its exact feature commit**

```bash
cd /Users/zizimutou/Desktop/aera/aera-cloud
go test ./... -count=1
go vet ./...
AERA_INTEGRATION_TESTS=1 go test -p 1 ./... -count=1
git diff main...HEAD --check
git status --short
```

Expected: every test exits 0 and the feature worktree is clean.

- [ ] **Step 2: Run Admin full verification and real Cloud E2E**

```bash
cd /Users/zizimutou/Desktop/aera/aera-admin
make verify
AERA_ADMIN_E2E_CLOUD_REPO=/Users/zizimutou/Desktop/aera/aera-cloud make e2e
git diff main...HEAD --check
git status --short
```

Expected: every gate exits 0 and the feature worktree is clean.

- [ ] **Step 3: Run Desktop full verification and cross-repository E2E**

```bash
cd /Users/zizimutou/Desktop/aera/aera
npm run typecheck
npm run lint
npm test
npm run check:agentera-cloud-contract
AERA_OFFICIAL_AGENT_E2E_CLOUD_REPO=/Users/zizimutou/Desktop/aera/aera-cloud \
AERA_OFFICIAL_AGENT_E2E_ADMIN_REPO=/Users/zizimutou/Desktop/aera/aera-admin \
npm run test:e2e:official-managed-agent
git diff main...HEAD --check
git status --short
```

Expected: every gate exits 0 and the feature worktree is clean.

- [ ] **Step 4: Verify Runtime and privacy boundaries**

```bash
git -C /Users/zizimutou/Desktop/aera/aera-runtime status --short
rg -n "Memory|HERMES_HOME|Curator|credentials|/api/agents" \
  /Users/zizimutou/Desktop/aera/aera-cloud/internal/agentcontrol/platform_* \
  /Users/zizimutou/Desktop/aera/aera-admin/internal/officialagent
```

Expected: `aera-runtime` has no change from this feature; matches in new control-plane code are only explicit rejection, boundary comments, or tests, never upload/storage fields.

- [ ] **Step 5: Update architecture evidence and run `lat check`**

Document implemented file anchors, exact commands, test counts, Profile/RuntimeBinding behavior, and privacy hashes. Then run:

```bash
cd /Users/zizimutou/Desktop/aera/aera
lat check
```

Expected: PASS. If `lat` is still unavailable, report this gate as blocked and do not claim full verification.

- [ ] **Step 6: Commit documentation and inspect all branch ranges**

```bash
git add lat.md/agentera-agent-control-plane.md lat.md/agentera-self-evolution.md README.md
git commit -m "docs: record official managed agent evidence"

git -C /Users/zizimutou/Desktop/aera/aera-cloud log --oneline main..aera/official-managed-agent-v1
git -C /Users/zizimutou/Desktop/aera/aera-admin log --oneline main..aera/official-managed-agent-v1
git -C /Users/zizimutou/Desktop/aera/aera log --oneline main..aera/official-managed-agent-v1
```

Expected: focused, reviewable commit series in all three repositories.

- [ ] **Step 7: Stop for explicit integration authority**

Report separately:

```text
implemented
locally verified
lat check status
locally merged or not merged
pushed or not pushed
deployed or not deployed
released or not released
```

Do not merge any feature branch into `main`, push GitHub, deploy, or publish an official release without the user's explicit approval for that exact state transition.

---

## Final Acceptance Checklist

- [ ] PLATFORM ownership cannot mix with USER, WORKSPACE, or ORGANIZATION fields.
- [ ] Developer, Super Admin, Operator, Auditor, Support, and Finance match the approved matrix in Cloud, Admin backend, and Admin UI.
- [ ] Submitter cannot review the same submission; rollback requester cannot approve the same rollback.
- [ ] Every review, Version, policy snapshot, release revision, audience row, and audit event is immutable as specified.
- [ ] v2 approval does not change the v1 release head.
- [ ] HMAC bucket, allowlist, minimum version, pause, resume, and rollback are deterministic and tested.
- [ ] Public desktop and Internal Admin APIs remain listener/OpenAPI separated and fail closed.
- [ ] Every official Installation is USER-owned, managed, and maps to a new independent Profile.
- [ ] Existing Profile claim is impossible for official V1.
- [ ] Knowledge, Skill, and SOP projection remains signed, verified, read-only, and outside `HERMES_HOME`.
- [ ] Managed update and rollback affect later RuntimeBindings only.
- [ ] Running v1 and v2 conversations keep their original bindings through rollout and rollback.
- [ ] Pause blocks new exposure/install/adoption without remotely disabling installed use.
- [ ] Valid offline entitlement uses the last verified version without false Cloud-state claims.
- [ ] Cloud/Admin/Desktop failures preserve the prior usable Version and every private Profile byte.
- [ ] No Memory, USER, conversation, session, credential, private Skill, Curator, Profile path, or unapproved local file enters Cloud or Admin.
- [ ] Hermes Memory, background review, learned Skills, and Curator continue across v1, v2, and rollback.
- [ ] No new request uses legacy `/api/agents`.
- [ ] `aera-runtime` remains unchanged.
- [ ] Cloud full unit/vet/integration gates pass.
- [ ] Admin `make verify` and real Cloud E2E pass.
- [ ] Desktop typecheck/lint/unit/contract/cross-repo E2E pass.
- [ ] `lat check` passes before claiming full verification.
- [ ] Local merge, GitHub push, deployment, and release states are reported separately.
