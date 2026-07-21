# AgentEra Organization Agent V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add governed Organization-owned Agent definitions and immutable versions, mandatory two-person publication review, and USER-owned local installation without changing Hermes runtime or self-learning ownership.

**Architecture:** Extend the existing Agent control plane with `owner_scope=ORGANIZATION` for published assets only. Cloud approval packages are immutable and produce a signed version only inside a different-current-Owner/Admin approval transaction; desktop drafts remain local, while every installation, policy overlay, RuntimeBinding, physical Hermes Profile, and adaptive state stays USER-owned.

**Tech Stack:** Go 1.26.5, PostgreSQL/pgx, chi, OpenAPI 3.0, TypeScript, Electron main/preload/renderer, React, SQLite/better-sqlite3, Vitest, Playwright, Ed25519, SHA-256.

## Global Constraints

- The approved design at `docs/superpowers/specs/2026-07-21-agentera-organization-agent-v1-design.md` is authoritative.
- `aera-runtime` remains unchanged.
- Organization owns only AgentDefinition, approval evidence, and immutable AgentVersion.
- Installation, policy overlay, RuntimeBinding, physical Hermes Profile, Memory, USER, sessions, conversations, credentials, Curator, and private learned Skills remain USER-owned and local.
- Every runnable Installation maps to one independently writable physical `HERMES_HOME`.
- Knowledge, Skill, and SOP projections are immutable, digest-verified, read-only, and outside `HERMES_HOME`.
- Owner/Admin submission and a different current Owner/Admin approval are mandatory; self-review cannot be enabled by policy.
- There is no direct Organization publish API.
- Organization ExperienceCandidate, automatic publication, automatic version selection, live Organization revocation, asset transfer, PLATFORM ownership, push, deployment, and release are outside this plan.
- Every protected cloud transaction rechecks active Organization lifecycle, current Membership, current role, and current policy.
- Renderer inputs never carry Organization identity, role, owner scope, actor identity, cloud origin, credentials, Profile paths, or Hermes content.
- Existing USER and WORKSPACE behavior and stored data must remain byte- and contract-compatible.
- Work is implemented on `aera/organization-agent-v1` in both `aera-cloud` and `aera`, reviewed per task, then merged locally only after the final gate.

---

## Repository and File Responsibility Map

The plan spans two repositories but keeps each task independently reviewable.

### Cloud repository: `/Users/zizimutou/Desktop/aera/aera-cloud`

- `migrations/000014_organization_agent_scope.sql`: Organization owner variants, immutable submission/review schema, approval linkage, indexes, and triggers.
- `internal/agentcontrol/model.go`: shared `OwnerScopeOrganization` and exact `AssetOwner` variant.
- `internal/agentcontrol/organization_submission_model.go`: submission/review enums, canonical payload, summaries, commands, and cloning.
- `internal/agentcontrol/dlp.go`: reusable safe-text DLP scanner used by ExperienceCandidate and Organization submissions.
- `internal/agentcontrol/organization_access.go`: transactional Organization lifecycle, membership, role, and current-policy checks.
- `internal/agentcontrol/organization_submission_repository.go`: submit, list, read, withdraw, reject, approve, supersede, audit, and idempotency persistence.
- `internal/agentcontrol/organization_submission_service.go`: canonicalization, policy/DLP validation, request hashing, review rules, and detached return values.
- `internal/agentcontrol/organization_submission_http.go`: nested strict HTTP DTOs and handlers.
- `internal/agentcontrol/repository.go`: Organization discovery, Organization-source USER installation, selection, and version visibility.
- `internal/agentcontrol/service.go`: narrow Organization discovery/install interfaces and effective-policy composition.
- `internal/agentcontrol/organization_asset_guard.go`: real Organization dissolution blocker backed by Agent assets.
- `internal/organization/repository.go`: consumes the real Agent asset guard without taking Agent-domain ownership.
- `cmd/aera-cloud/main.go`: constructs one shared Agent repository and wires it into both handlers.
- `api/openapi.yaml`: public Organization Agent contract.
- `api/openapi_test.go`: route, schema, strict-union, role-safe, and error-code assertions.

### Desktop repository: `/Users/zizimutou/Desktop/aera/aera`

- `src/shared/agentera-agent-control.ts`: renderer-safe Organization context, submission, review, installation, and error types.
- `src/shared/agentera-product-space.ts` and `src/main/agentera-product-space/manager.ts`: trusted selected Organization and verified role supplied to Agent control.
- `src/main/agentera-agent-control/db.ts`: SQLite schema version 5 and exact USER/WORKSPACE/ORGANIZATION row variants.
- `src/main/agentera-agent-control/draft-store.ts`: Organization-targeted local drafts.
- `src/main/agentera-agent-control/installation-manager.ts`: Organization-source USER installations.
- `src/main/agentera-agent-control/client.ts`: strict OpenAPI-backed Organization Agent client.
- `src/main/agentera-agent-control/organization-publication-service.ts`: one-use preview/submit/review handles and context invalidation.
- `src/main/agentera-agent-control/manager.ts`: trusted Organization context, role gates, discovery, submission, review, install, and selection orchestration.
- `src/main/agentera-agent-control/ipc-contract.ts`: exact renderer input parsing and safe serialization.
- `src/main/ipc/register.ts` and `src/preload/index.ts`: explicit Organization Agent IPC/preload methods.
- `src/renderer/src/screens/Agents/OrganizationSubmissionPanel.tsx`: author/history/review-queue presentation.
- `src/renderer/src/screens/Agents/OrganizationReviewDialog.tsx`: immutable package review and terminal confirmation.
- `src/renderer/src/screens/Agents/AgentControlPanel.tsx`: role-specific Organization catalog integration.
- `src/shared/i18n/locales/*/agents.ts`: complete localized copy for every supported locale.
- `contracts/agentera-cloud.openapi.yaml`: pinned cloud contract consumed by the desktop generator.
- `src/shared/agentera-cloud-api.generated.ts`: generated typed client surface.
- `tests/agentera-organization-agent-boundary.test.ts`: static privacy and ownership boundary checks.
- `tests/e2e/agentera-organization-agent.e2e.ts`: deterministic multi-account flow.
- `lat.md/agentera-organizations.md` and `lat.md/agentera-agent-control-plane.md`: implemented architecture and verification evidence.

## Cross-Task Invariants

Use these exact domain shapes throughout the plan:

```text
AssetOwner ORGANIZATION variant:
  scope = ORGANIZATION
  organization_id = UUID
  personal_space_id = null
  user_id = null
  workspace_id = null

Organization runtime source:
  Installation owner_scope = USER
  Installation tenant_id = employee personal_space_id
  Installation owner_id = employee user_id
  source organization_id is authorization/provenance only

Submission terminal states:
  approved | rejected | withdrawn | superseded
```

The cloud API uses lower-case wire states. The desktop maps those values without inventing uppercase aliases.

---

### Task 1: Add the Organization Agent ownership and immutable approval schema

**Files:**
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/migrations/000014_organization_agent_scope.sql`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/store/migrate_test.go`
- Test: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/store/migrate_test.go`

**Interfaces:**
- Consumes: existing USER/WORKSPACE owner constraints from migration 000010 and Organization tables from migrations 000012–000013.
- Produces: `organization_id` owner variants, `organization_agent_submissions`, `organization_agent_reviews`, and approval linkage columns used by Tasks 2–8.

- [ ] **Step 1: Write the failing migration assertions**

Rename the existing `TestEmbeddedMigrationsIncludeOrganizationFoundation` test and replace its count/last-migration assertions so there is only one migration-count test. Then add assertions that the new tables exist, the three owner-variant constraints contain `ORGANIZATION`, review uniqueness is enforced, and Version approval linkage is exact:

```go
func TestEmbeddedMigrationsIncludeOrganizationAgentV1(t *testing.T) {
	loaded, err := loadMigrations(migrations.FS)
	if err != nil {
		t.Fatalf("loadMigrations() error = %v", err)
	}
	if len(loaded) != 14 {
		t.Fatalf("embedded migration count = %d, want 14", len(loaded))
	}
	last := loaded[len(loaded)-1]
	if last.version != 14 || last.name != "000014_organization_agent_scope.sql" {
		t.Fatalf("last embedded migration = %d/%s", last.version, last.name)
	}
}
```

Extend the integration assertion lists with:

```go
tables := []string{
	"organization_agent_submissions",
	"organization_agent_reviews",
}
assertUniqueConstraint(t, ctx, postgres, "organization_agent_reviews",
	"organization_agent_reviews_submission_key", []string{"submission_id"})
assertCheckConstraintContains(t, ctx, postgres, "agent_definitions",
	"agent_definitions_owner_variant_check", "ORGANIZATION")
assertCheckConstraintContains(t, ctx, postgres, "agent_versions",
	"agent_versions_owner_variant_check", "organization_submission_id")
assertCheckConstraintContains(t, ctx, postgres, "organization_agent_submissions",
	"organization_agent_submissions_status_check", "superseded")
assertForeignKeyConstraintContains(t, ctx, postgres, "organization_agent_reviews",
	"organization_agent_reviews_policy_fk", "FOREIGN KEY (organization_id, organization_policy_snapshot_id)")
```

- [ ] **Step 2: Run the focused test and observe the missing migration**

Run:

```bash
go test ./internal/store -run 'TestEmbeddedMigrationsIncludeOrganizationAgentV1|TestApplyMigrationsCreatesAuthSchemaAndIsIdempotent' -count=1
```

Expected: FAIL because 13 migrations are embedded and the Organization Agent tables and constraints do not exist.

- [ ] **Step 3: Add migration 000014 with exact tagged variants and immutability**

Create the migration with these complete ownership checks and tables:

```sql
ALTER TABLE agent_definitions
    ADD COLUMN organization_id UUID REFERENCES organizations(id) ON DELETE RESTRICT,
    DROP CONSTRAINT agent_definitions_owner_variant_check,
    ADD CONSTRAINT agent_definitions_owner_variant_check CHECK (
        (owner_scope = 'USER' AND tenant_id IS NOT NULL AND owner_id IS NOT NULL
            AND workspace_id IS NULL AND organization_id IS NULL)
        OR (owner_scope = 'WORKSPACE' AND tenant_id IS NULL AND owner_id IS NULL
            AND workspace_id IS NOT NULL AND organization_id IS NULL)
        OR (owner_scope = 'ORGANIZATION' AND tenant_id IS NULL AND owner_id IS NULL
            AND workspace_id IS NULL AND organization_id IS NOT NULL)
    );

ALTER TABLE agent_versions
    ADD COLUMN organization_id UUID REFERENCES organizations(id) ON DELETE RESTRICT,
    ADD COLUMN organization_submission_id UUID,
    ADD COLUMN organization_policy_snapshot_id UUID,
    DROP CONSTRAINT agent_versions_owner_variant_check,
    ADD CONSTRAINT agent_versions_owner_variant_check CHECK (
        (owner_scope = 'USER' AND tenant_id IS NOT NULL AND owner_id IS NOT NULL
            AND workspace_id IS NULL AND organization_id IS NULL
            AND organization_submission_id IS NULL AND organization_policy_snapshot_id IS NULL)
        OR (owner_scope = 'WORKSPACE' AND tenant_id IS NULL AND owner_id IS NULL
            AND workspace_id IS NOT NULL AND organization_id IS NULL
            AND organization_submission_id IS NULL AND organization_policy_snapshot_id IS NULL)
        OR (owner_scope = 'ORGANIZATION' AND tenant_id IS NULL AND owner_id IS NULL
            AND workspace_id IS NULL AND organization_id IS NOT NULL
            AND organization_submission_id IS NOT NULL AND organization_policy_snapshot_id IS NOT NULL)
    ),
    ADD CONSTRAINT agent_versions_organization_policy_fk
        FOREIGN KEY (organization_id, organization_policy_snapshot_id)
        REFERENCES organization_policy_snapshots(organization_id, id) ON DELETE RESTRICT;

ALTER TABLE agent_control_idempotency_keys
    ADD COLUMN organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    DROP CONSTRAINT agent_control_idempotency_owner_variant_check,
    ADD CONSTRAINT agent_control_idempotency_owner_variant_check CHECK (
        (owner_scope = 'USER' AND tenant_id IS NOT NULL AND owner_id IS NOT NULL
            AND workspace_id IS NULL AND organization_id IS NULL)
        OR (owner_scope = 'WORKSPACE' AND tenant_id IS NULL AND owner_id IS NULL
            AND workspace_id IS NOT NULL AND organization_id IS NULL)
        OR (owner_scope = 'ORGANIZATION' AND tenant_id IS NULL AND owner_id IS NULL
            AND workspace_id IS NULL AND organization_id IS NOT NULL)
    );

CREATE TABLE organization_agent_submissions (
    id UUID PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    kind TEXT NOT NULL CHECK (kind IN ('initial', 'next')),
    definition_id UUID NOT NULL,
    base_version_id UUID REFERENCES agent_versions(id) ON DELETE RESTRICT,
    display_name TEXT,
    icon_media_type TEXT,
    icon_data BYTEA,
    canonical_manifest JSONB NOT NULL CHECK (jsonb_typeof(canonical_manifest) = 'object'),
    bundle JSONB NOT NULL CHECK (jsonb_typeof(bundle) = 'object'),
    manifest_digest BYTEA NOT NULL CHECK (octet_length(manifest_digest) = 32),
    bundle_digest BYTEA NOT NULL CHECK (octet_length(bundle_digest) = 32),
    content_digest BYTEA NOT NULL CHECK (octet_length(content_digest) = 32),
    submitted_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','withdrawn','superseded')),
    revision BIGINT NOT NULL CHECK (revision > 0),
    submitted_at TIMESTAMPTZ NOT NULL,
    terminal_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT organization_agent_submissions_kind_check CHECK (
        (kind = 'initial' AND base_version_id IS NULL AND display_name IS NOT NULL)
        OR (kind = 'next' AND base_version_id IS NOT NULL AND display_name IS NULL
            AND icon_media_type IS NULL AND icon_data IS NULL)
    ),
    CONSTRAINT organization_agent_submissions_terminal_check CHECK (
        (status = 'pending' AND terminal_at IS NULL)
        OR (status <> 'pending' AND terminal_at IS NOT NULL)
    ),
    CONSTRAINT organization_agent_submissions_org_id_key
        UNIQUE (organization_id, id)
);

CREATE TABLE organization_agent_reviews (
    id UUID PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    submission_id UUID NOT NULL,
    reviewer_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    decision TEXT NOT NULL CHECK (decision IN ('approve','reject')),
    reason_code TEXT,
    safe_note TEXT,
    organization_policy_snapshot_id UUID NOT NULL,
    organization_policy_version BIGINT NOT NULL CHECK (organization_policy_version > 0),
    reviewed_content_digest BYTEA NOT NULL CHECK (octet_length(reviewed_content_digest) = 32),
    reviewed_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT organization_agent_reviews_submission_key UNIQUE (submission_id),
    CONSTRAINT organization_agent_reviews_submission_fk
        FOREIGN KEY (organization_id, submission_id)
        REFERENCES organization_agent_submissions(organization_id, id) ON DELETE RESTRICT,
    CONSTRAINT organization_agent_reviews_policy_fk
        FOREIGN KEY (organization_id, organization_policy_snapshot_id)
        REFERENCES organization_policy_snapshots(organization_id, id) ON DELETE RESTRICT,
    CONSTRAINT organization_agent_reviews_reason_check CHECK (
        (decision = 'approve' AND reason_code IS NULL AND safe_note IS NULL)
        OR (decision = 'reject' AND char_length(reason_code) BETWEEN 1 AND 64
            AND (safe_note IS NULL OR char_length(safe_note) BETWEEN 1 AND 500))
    )
);

ALTER TABLE agent_versions
    ADD CONSTRAINT agent_versions_organization_submission_fk
    FOREIGN KEY (organization_id, organization_submission_id)
    REFERENCES organization_agent_submissions(organization_id, id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX agent_control_idempotency_organization_operation_key
    ON agent_control_idempotency_keys (organization_id, operation, key_hash)
    WHERE owner_scope = 'ORGANIZATION';
CREATE INDEX agent_definitions_organization_list_idx
    ON agent_definitions (organization_id, updated_at DESC)
    WHERE owner_scope = 'ORGANIZATION';
CREATE INDEX agent_versions_organization_time_idx
    ON agent_versions (organization_id, published_at DESC)
    WHERE owner_scope = 'ORGANIZATION';
CREATE INDEX organization_agent_submissions_queue_idx
    ON organization_agent_submissions (organization_id, status, submitted_at DESC);

CREATE FUNCTION enforce_organization_agent_submission_variant()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.kind = 'initial' THEN
        IF EXISTS (
            SELECT 1 FROM agent_definitions WHERE id = NEW.definition_id
        ) THEN
            RAISE EXCEPTION 'reserved Organization Agent Definition already exists'
                USING ERRCODE = '23514';
        END IF;
    ELSE
        IF NOT EXISTS (
            SELECT 1
            FROM agent_definitions definition
            JOIN agent_versions version ON version.id = NEW.base_version_id
            WHERE definition.id = NEW.definition_id
              AND definition.owner_scope = 'ORGANIZATION'
              AND definition.organization_id = NEW.organization_id
              AND definition.latest_version_id = NEW.base_version_id
              AND version.definition_id = definition.id
              AND version.organization_id = NEW.organization_id
        ) THEN
            RAISE EXCEPTION 'next Organization Agent submission base is invalid'
                USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER organization_agent_submission_variant_trigger
    AFTER INSERT OR UPDATE ON organization_agent_submissions
    DEFERRABLE INITIALLY IMMEDIATE
    FOR EACH ROW EXECUTE FUNCTION enforce_organization_agent_submission_variant();

CREATE FUNCTION guard_organization_agent_submission_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Organization Agent submission cannot be deleted'
            USING ERRCODE = '55000';
    END IF;
    IF OLD.status <> 'pending'
       OR NEW.id IS DISTINCT FROM OLD.id
       OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
       OR NEW.kind IS DISTINCT FROM OLD.kind
       OR NEW.definition_id IS DISTINCT FROM OLD.definition_id
       OR NEW.base_version_id IS DISTINCT FROM OLD.base_version_id
       OR NEW.display_name IS DISTINCT FROM OLD.display_name
       OR NEW.icon_media_type IS DISTINCT FROM OLD.icon_media_type
       OR NEW.icon_data IS DISTINCT FROM OLD.icon_data
       OR NEW.canonical_manifest IS DISTINCT FROM OLD.canonical_manifest
       OR NEW.bundle IS DISTINCT FROM OLD.bundle
       OR NEW.manifest_digest IS DISTINCT FROM OLD.manifest_digest
       OR NEW.bundle_digest IS DISTINCT FROM OLD.bundle_digest
       OR NEW.content_digest IS DISTINCT FROM OLD.content_digest
       OR NEW.submitted_by_user_id IS DISTINCT FROM OLD.submitted_by_user_id
       OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
       OR NEW.status NOT IN ('approved','rejected','withdrawn','superseded')
       OR NEW.revision <> OLD.revision + 1
       OR NEW.terminal_at IS NULL
       OR NEW.updated_at <> NEW.terminal_at THEN
        RAISE EXCEPTION 'Organization Agent submission mutation is invalid'
            USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER organization_agent_submission_immutable_trigger
    BEFORE UPDATE OR DELETE ON organization_agent_submissions
    FOR EACH ROW EXECUTE FUNCTION guard_organization_agent_submission_mutation();

CREATE FUNCTION guard_organization_agent_review_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'Organization Agent review is immutable'
        USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER organization_agent_review_immutable_trigger
    BEFORE UPDATE OR DELETE ON organization_agent_reviews
    FOR EACH ROW EXECUTE FUNCTION guard_organization_agent_review_mutation();

CREATE FUNCTION enforce_organization_agent_review_separation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    submitter UUID;
BEGIN
    SELECT submitted_by_user_id INTO submitter
    FROM organization_agent_submissions
    WHERE id = NEW.submission_id AND organization_id = NEW.organization_id;
    IF submitter IS NULL OR submitter = NEW.reviewer_user_id THEN
        RAISE EXCEPTION 'Organization Agent review requires another actor'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER organization_agent_review_separation_trigger
    AFTER INSERT ON organization_agent_reviews
    DEFERRABLE INITIALLY IMMEDIATE
    FOR EACH ROW EXECUTE FUNCTION enforce_organization_agent_review_separation();
```

The repository still rechecks current roles and actor separation transactionally; the database triggers provide an independent invariant against malformed internal writes.

- [ ] **Step 4: Run migration tests twice**

Run:

```bash
go test ./internal/store -run 'TestEmbeddedMigrationsIncludeOrganizationAgentV1|TestApplyMigrationsCreatesAuthSchemaAndIsIdempotent' -count=1
go test ./internal/store -run TestApplyMigrationsCreatesAuthSchemaAndIsIdempotent -count=1
```

Expected: both commands PASS; the second command proves a fresh repeat application remains idempotent.

- [ ] **Step 5: Commit the schema**

```bash
git add migrations/000014_organization_agent_scope.sql internal/store/migrate_test.go
git commit -m "feat: add organization agent approval schema"
```

---

### Task 2: Add the Organization owner model and reusable publication DLP

**Files:**
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/agentcontrol/model.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/agentcontrol/model_test.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/agentcontrol/dlp.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/agentcontrol/experience_candidate_dlp.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/agentcontrol/organization_submission_model.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/agentcontrol/organization_submission_model_test.go`
- Test: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/agentcontrol/experience_candidate_dlp_test.go`

**Interfaces:**
- Consumes: `CanonicalizeVersion(AgentManifestV1, VersionBundleV1)` and existing DLP vectors.
- Produces: `OwnerScopeOrganization`, `OrganizationSubmissionPackage`, `CanonicalizeOrganizationSubmission`, and `ScanAgentPublication` for Tasks 3–7.

- [ ] **Step 1: Write failing owner-variant, canonicalization, and DLP tests**

```go
func TestAssetOwnerAcceptsOnlyExactOrganizationVariant(t *testing.T) {
	organizationID := uuid.New()
	valid := AssetOwner{Scope: OwnerScopeOrganization, OrganizationID: organizationID}
	if err := valid.Validate(); err != nil {
		t.Fatalf("Validate() error = %v", err)
	}
	invalid := valid
	invalid.UserID = uuid.New()
	if err := invalid.Validate(); !errors.Is(err, ErrInvalidAgentContent) {
		t.Fatalf("Validate() error = %v, want ErrInvalidAgentContent", err)
	}
}

func TestCanonicalizeOrganizationSubmissionIsStableAndDetached(t *testing.T) {
	input := lockedOrganizationInitialPackage(t)
	first, err := CanonicalizeOrganizationSubmission(input)
	if err != nil {
		t.Fatalf("CanonicalizeOrganizationSubmission() error = %v", err)
	}
	input.Bundle.Assets[0].Content = "changed after call"
	second, err := CanonicalizeOrganizationSubmission(lockedOrganizationInitialPackage(t))
	if err != nil {
		t.Fatalf("second canonicalization error = %v", err)
	}
	if first.ContentDigest != second.ContentDigest {
		t.Fatal("canonical content digest is not stable")
	}
	if first.Package.Bundle.Assets[0].Content == "changed after call" {
		t.Fatal("canonical package aliases caller memory")
	}
}

func TestScanAgentPublicationBlocksHermesPrivateState(t *testing.T) {
	findings := ScanAgentPublication([]PublicationTextAsset{{
		Path: "knowledge/private.md",
		Content: "copy ~/.hermes/MEMORY.md and API_KEY=secret",
	}})
	if len(findings) != 2 {
		t.Fatalf("findings = %v, want private path and credential", findings)
	}
}
```

- [ ] **Step 2: Run the model tests and verify missing symbols**

Run:

```bash
go test ./internal/agentcontrol -run 'TestAssetOwnerAcceptsOnlyExactOrganizationVariant|TestCanonicalizeOrganizationSubmission|TestScanAgentPublication' -count=1
```

Expected: FAIL because the Organization owner, package canonicalizer, and shared publication scanner do not exist.

- [ ] **Step 3: Implement exact variants and canonical package types**

Extend the owner model:

```go
const (
	OwnerScopeUser         OwnerScope = "USER"
	OwnerScopeWorkspace    OwnerScope = "WORKSPACE"
	OwnerScopeOrganization OwnerScope = "ORGANIZATION"
)

type AssetOwner struct {
	Scope           OwnerScope
	PersonalSpaceID uuid.UUID
	UserID          uuid.UUID
	WorkspaceID     uuid.UUID
	OrganizationID  uuid.UUID
}

func (owner AssetOwner) Validate() error {
	switch owner.Scope {
	case OwnerScopeUser:
		if owner.PersonalSpaceID == uuid.Nil || owner.UserID == uuid.Nil ||
			owner.WorkspaceID != uuid.Nil || owner.OrganizationID != uuid.Nil {
			return ErrInvalidAgentContent
		}
	case OwnerScopeWorkspace:
		if owner.PersonalSpaceID != uuid.Nil || owner.UserID != uuid.Nil ||
			owner.WorkspaceID == uuid.Nil || owner.OrganizationID != uuid.Nil {
			return ErrInvalidAgentContent
		}
	case OwnerScopeOrganization:
		if owner.PersonalSpaceID != uuid.Nil || owner.UserID != uuid.Nil ||
			owner.WorkspaceID != uuid.Nil || owner.OrganizationID == uuid.Nil {
			return ErrInvalidAgentContent
		}
	default:
		return ErrInvalidAgentContent
	}
	return nil
}

func (owner AssetOwner) Key() uuid.UUID {
	switch owner.Scope {
	case OwnerScopeWorkspace:
		return owner.WorkspaceID
	case OwnerScopeOrganization:
		return owner.OrganizationID
	default:
		return owner.UserID
	}
}
```

Define the immutable package:

```go
type OrganizationSubmissionKind string
type OrganizationSubmissionStatus string

const (
	OrganizationSubmissionInitial OrganizationSubmissionKind = "initial"
	OrganizationSubmissionNext    OrganizationSubmissionKind = "next"
	OrganizationSubmissionPending OrganizationSubmissionStatus = "pending"
	OrganizationSubmissionApproved OrganizationSubmissionStatus = "approved"
	OrganizationSubmissionRejected OrganizationSubmissionStatus = "rejected"
	OrganizationSubmissionWithdrawn OrganizationSubmissionStatus = "withdrawn"
	OrganizationSubmissionSuperseded OrganizationSubmissionStatus = "superseded"
)

type OrganizationSubmissionPackage struct {
	Kind          OrganizationSubmissionKind
	DefinitionID  uuid.UUID
	BaseVersionID uuid.UUID
	DisplayName   string
	IconMediaType string
	IconData      []byte
	Manifest      AgentManifestV1
	Bundle        VersionBundleV1
}

type CanonicalOrganizationSubmission struct {
	Package        OrganizationSubmissionPackage
	ManifestDigest [sha256.Size]byte
	BundleDigest   [sha256.Size]byte
	ContentDigest  [sha256.Size]byte
}
```

Implement canonicalization by rebuilding the package from the existing canonical Version bytes:

```go
func CanonicalizeOrganizationSubmission(
	input OrganizationSubmissionPackage,
) (CanonicalOrganizationSubmission, error) {
	if input.DefinitionID == uuid.Nil ||
		(input.Kind == OrganizationSubmissionInitial &&
			(input.BaseVersionID != uuid.Nil || strings.TrimSpace(input.DisplayName) == "")) ||
		(input.Kind == OrganizationSubmissionNext &&
			(input.BaseVersionID == uuid.Nil || input.DisplayName != "" ||
				input.IconMediaType != "" || len(input.IconData) != 0)) {
		return CanonicalOrganizationSubmission{}, ErrInvalidAgentContent
	}
	version, err := CanonicalizeVersion(input.Manifest, input.Bundle)
	if err != nil {
		return CanonicalOrganizationSubmission{}, err
	}
	var manifest AgentManifestV1
	var bundle VersionBundleV1
	if err := decodeStrictJSON(version.ManifestJSON, &manifest); err != nil {
		return CanonicalOrganizationSubmission{}, ErrInvalidAgentContent
	}
	if err := decodeStrictJSON(version.BundleJSON, &bundle); err != nil {
		return CanonicalOrganizationSubmission{}, ErrInvalidAgentContent
	}
	output := OrganizationSubmissionPackage{
		Kind: input.Kind,
		DefinitionID: input.DefinitionID,
		BaseVersionID: input.BaseVersionID,
		DisplayName: strings.TrimSpace(input.DisplayName),
		IconMediaType: input.IconMediaType,
		IconData: bytes.Clone(input.IconData),
		Manifest: manifest,
		Bundle: bundle,
	}
	return CanonicalOrganizationSubmission{
		Package: output,
		ManifestDigest: version.ManifestDigest,
		BundleDigest: version.BundleDigest,
		ContentDigest: version.ContentDigest,
	}, nil
}
```

Move common rules into:

```go
type PublicationTextAsset struct {
	Path    string
	Content string
}

func ScanAgentPublication(assets []PublicationTextAsset) []ExperienceCandidateFinding {
	return scanTextAssets("agent-publication-dlp-v1", assets)
}
```

Keep `ScanExperienceCandidate` as a compatibility wrapper over the same rules and preserve every existing finding code and redaction guarantee.

- [ ] **Step 4: Run owner, canonicalization, DLP, manifest, and signing tests**

Run:

```bash
go test ./internal/agentcontrol -run 'TestAssetOwner|TestCanonicalizeOrganizationSubmission|TestScanAgentPublication|TestScanExperienceCandidate|TestCanonicalizeVersion|TestVersionAttestation' -count=1
```

Expected: PASS with no change to existing ExperienceCandidate vectors.

- [ ] **Step 5: Commit the model boundary**

```bash
git add internal/agentcontrol/model.go internal/agentcontrol/model_test.go internal/agentcontrol/dlp.go internal/agentcontrol/experience_candidate_dlp.go internal/agentcontrol/experience_candidate_dlp_test.go internal/agentcontrol/organization_submission_model.go internal/agentcontrol/organization_submission_model_test.go
git commit -m "feat: model organization agent submissions"
```

---

### Task 3: Add transactional Organization authorization and policy evaluation

**Files:**
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/agentcontrol/organization_access.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/agentcontrol/organization_access_test.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/agentcontrol/service.go`
- Test: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/organization/policy_test.go`

**Interfaces:**
- Consumes: `Principal`, Organization Foundation schema, and canonical Organization policy snapshots.
- Produces: `requireOrganizationAgentAccess`, `OrganizationAgentAccess`, and `IntersectOrganizationAgentPolicy` for submission, review, install, and selection transactions.

- [ ] **Step 1: Write failing table-driven access and policy tests**

```go
func TestRequireOrganizationAgentAccessUsesCurrentLifecycleRoleAndPolicy(t *testing.T) {
	fixture := newOrganizationAccessFixture(t)
	tests := []struct {
		name string
		user uuid.UUID
		mode OrganizationAgentAccessMode
		wantRole string
		wantErr error
	}{
		{"owner publishes", fixture.ownerID, organizationAgentPublish, "owner", nil},
		{"admin reviews", fixture.adminID, organizationAgentReview, "admin", nil},
		{"auditor reads history", fixture.auditorID, organizationAgentReviewRead, "auditor", nil},
		{"member installs", fixture.memberID, organizationAgentInstall, "member", nil},
		{"auditor cannot install", fixture.auditorID, organizationAgentInstall, "", ErrOrganizationAgentForbidden},
		{"member cannot review", fixture.memberID, organizationAgentReview, "", ErrOrganizationAgentForbidden},
		{"outsider is hidden", uuid.New(), organizationAgentRead, "", ErrOrganizationAgentNotFound},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			access, err := requireOrganizationAgentAccess(
				context.Background(), fixture.db, Principal{UserID: test.user},
				fixture.organizationID, test.mode, false,
			)
			if !errors.Is(err, test.wantErr) {
				t.Fatalf("error = %v, want %v", err, test.wantErr)
			}
			if access.Role != test.wantRole {
				t.Fatalf("role = %q, want %q", access.Role, test.wantRole)
			}
		})
	}
}

func TestIntersectOrganizationAgentPolicyOnlyNarrows(t *testing.T) {
	effective, err := IntersectOrganizationAgentPolicy(
		lockedPlatformAgentPolicy(), lockedOrganizationAgentPolicy(), lockedVersionConstraints(),
	)
	if err != nil {
		t.Fatalf("IntersectOrganizationAgentPolicy() error = %v", err)
	}
	if diff := cmp.Diff([]string{"openai"}, effective.AllowedProviders); diff != "" {
		t.Fatalf("providers mismatch (-want +got):\n%s", diff)
	}
	if slices.Contains(effective.AllowedTools, "shell") {
		t.Fatal("Organization denial was broadened")
	}
}
```

- [ ] **Step 2: Run focused tests and observe the missing access layer**

Run:

```bash
go test ./internal/agentcontrol -run 'TestRequireOrganizationAgentAccess|TestIntersectOrganizationAgentPolicy' -count=1
```

Expected: FAIL because the access modes and policy intersection are undefined.

- [ ] **Step 3: Implement narrow access snapshots and fail-closed modes**

```go
type OrganizationAgentAccessMode uint8

const (
	organizationAgentRead OrganizationAgentAccessMode = iota + 1
	organizationAgentReviewRead
	organizationAgentPublish
	organizationAgentReview
	organizationAgentInstall
)

type OrganizationAgentAccess struct {
	OrganizationID uuid.UUID
	Role string
	Status string
	PolicySnapshotID uuid.UUID
	PolicyVersion int64
	PolicyDocument organization.PolicyDocument
}

func requireOrganizationAgentAccess(
	ctx context.Context,
	queryer interface {
		QueryRow(context.Context, string, ...any) pgx.Row
	},
	principal Principal,
	organizationID uuid.UUID,
	mode OrganizationAgentAccessMode,
	allowArchived bool,
) (OrganizationAgentAccess, error) {
	if principal.UserID == uuid.Nil || organizationID == uuid.Nil {
		return OrganizationAgentAccess{}, ErrOrganizationAgentNotFound
	}
	var access OrganizationAgentAccess
	var policyBytes []byte
	err := queryer.QueryRow(ctx, organizationAgentAccessQuery,
		organizationID, principal.UserID,
	).Scan(&access.OrganizationID, &access.Status, &access.Role,
		&access.PolicySnapshotID, &access.PolicyVersion, &policyBytes)
	if errors.Is(err, pgx.ErrNoRows) {
		return OrganizationAgentAccess{}, ErrOrganizationAgentNotFound
	}
	if err != nil {
		return OrganizationAgentAccess{}, ErrServiceUnavailable
	}
	if access.Status == "archived" && !allowArchived {
		return OrganizationAgentAccess{}, ErrOrganizationArchived
	}
	if access.Status != "active" && !(allowArchived && access.Status == "archived") {
		return OrganizationAgentAccess{}, ErrOrganizationAgentNotFound
	}
	if !organizationRoleAllows(access.Role, mode) {
		return OrganizationAgentAccess{}, ErrOrganizationAgentForbidden
	}
	policy, err := organization.DecodePolicyDocument(policyBytes)
	if err != nil {
		return OrganizationAgentAccess{}, ErrServiceUnavailable
	}
	access.PolicyDocument = policy
	return access, nil
}

func organizationRoleAllows(role string, mode OrganizationAgentAccessMode) bool {
	switch mode {
	case organizationAgentRead:
		return role == "owner" || role == "admin" || role == "auditor" || role == "member"
	case organizationAgentReviewRead:
		return role == "owner" || role == "admin" || role == "auditor"
	case organizationAgentPublish, organizationAgentReview:
		return role == "owner" || role == "admin"
	case organizationAgentInstall:
		return role == "owner" || role == "admin" || role == "member"
	default:
		return false
	}
}
```

Implement `organizationAgentAccessQuery` as one join across `organizations`, active `organization_memberships`, and `organization_policy_snapshots`. Repository mutation callers must invoke it after opening their transaction so policy and role are checked in the same transaction as the protected write.

Add these stable errors to `repository.go` and map them later in Task 7:

```go
var (
	ErrOrganizationAgentNotFound = errors.New("organization agent not found")
	ErrOrganizationAgentForbidden = errors.New("organization agent forbidden")
	ErrOrganizationArchived = errors.New("organization archived")
	ErrOrganizationPublicationPolicyBlocked = errors.New("organization publication policy blocked")
	ErrOrganizationPublicationDLPBlocked = errors.New("organization publication dlp blocked")
)
```

`IntersectOrganizationAgentPolicy` must call the existing set-intersection helpers, reject a version whose model/provider/tool constraints produce an empty required set, and return an immutable detached policy document.

- [ ] **Step 4: Run authorization, Organization policy, and Workspace regression tests**

Run:

```bash
go test ./internal/agentcontrol -run 'TestRequireOrganizationAgentAccess|TestIntersectOrganizationAgentPolicy|TestRequireWorkspaceAgentAccess' -count=1
go test ./internal/organization -run 'TestCanonicalizePolicy|TestPolicyAllowlistIntersection' -count=1
```

Expected: PASS; Workspace access behavior remains unchanged.

- [ ] **Step 5: Commit the authorization boundary**

```bash
git add internal/agentcontrol/organization_access.go internal/agentcontrol/organization_access_test.go internal/agentcontrol/repository.go internal/agentcontrol/service.go
git commit -m "feat: authorize organization agent operations"
```

---

### Task 4: Persist immutable submissions, history, withdrawal, and rejection

**Files:**
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/agentcontrol/organization_submission_repository.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/agentcontrol/organization_submission_repository_test.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/agentcontrol/organization_submission_service.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/agentcontrol/organization_submission_service_test.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/agentcontrol/service.go`

**Interfaces:**
- Consumes: Task 2 canonical packages/DLP and Task 3 access snapshots.
- Produces: `SubmitOrganizationAgent`, `ListOrganizationAgentSubmissions`, `GetOrganizationAgentSubmission`, `WithdrawOrganizationAgentSubmission`, and rejection half of `ReviewOrganizationAgentSubmission`.

- [ ] **Step 1: Write failing service and PostgreSQL repository tests**

```go
func TestSubmitOrganizationAgentCanonicalizesAuthorizesAndReplays(t *testing.T) {
	repository := newRecordingOrganizationSubmissionRepository()
	service := newOrganizationSubmissionServiceForTest(t, repository)
	request := lockedSubmitOrganizationInitialRequest()
	first, err := service.SubmitOrganizationAgent(context.Background(),
		lockedPrincipal(), lockedOrganizationID(), request)
	if err != nil {
		t.Fatalf("SubmitOrganizationAgent() error = %v", err)
	}
	second, err := service.SubmitOrganizationAgent(context.Background(),
		lockedPrincipal(), lockedOrganizationID(), request)
	if err != nil {
		t.Fatalf("replay error = %v", err)
	}
	if first.ID != second.ID || first.ContentDigest != second.ContentDigest {
		t.Fatal("idempotent replay changed authoritative result")
	}
	if repository.lastCommand.Actor.UserID != lockedPrincipal().UserID {
		t.Fatal("actor was not derived from access claims")
	}
}

func TestOrganizationSubmissionRepositoryVisibilityWithdrawalAndRejection(t *testing.T) {
	fixture := newOrganizationSubmissionRepositoryFixture(t)
	submission := fixture.submitInitial(t, fixture.owner)
	fixture.assertHistoryVisible(t, submission.ID, fixture.owner, fixture.admin, fixture.auditor)
	fixture.assertHistoryHidden(t, submission.ID, fixture.member, fixture.outsider)
	fixture.reject(t, submission.ID, fixture.admin, submission.Revision, "policy_mismatch")
	fixture.assertTerminal(t, submission.ID, OrganizationSubmissionRejected, 2)
	fixture.assertNoDefinitionOrVersion(t, submission.DefinitionID)
}
```

Also test: only original current Owner/Admin may withdraw, changed idempotent bodies conflict, Member/Auditor cannot submit, archived Organizations reject mutation, and list/detail results are detached.

- [ ] **Step 2: Run the focused tests and observe missing service methods**

Run:

```bash
go test ./internal/agentcontrol -run 'TestSubmitOrganizationAgent|TestOrganizationSubmissionRepositoryVisibilityWithdrawalAndRejection' -count=1
```

Expected: FAIL because the Organization submission repository and service do not exist.

- [ ] **Step 3: Implement commands, service validation, and repository transitions**

Expose exact service requests:

```go
type SubmitOrganizationAgentRequest struct {
	Package OrganizationSubmissionPackage
	IdempotencyKey string
	RequestID string
}

type WithdrawOrganizationAgentRequest struct {
	SubmissionID uuid.UUID
	ExpectedRevision int64
	IdempotencyKey string
	RequestID string
}

type ReviewOrganizationAgentRequest struct {
	SubmissionID uuid.UUID
	ExpectedRevision int64
	Decision OrganizationReviewDecision
	ReasonCode string
	SafeNote string
	IdempotencyKey string
	RequestID string
}
```

The service method must perform pre-persistence validation in this order:

```go
func (s *Service) SubmitOrganizationAgent(
	ctx context.Context,
	principal Principal,
	organizationID uuid.UUID,
	request SubmitOrganizationAgentRequest,
) (OrganizationAgentSubmission, error) {
	canonical, err := CanonicalizeOrganizationSubmission(request.Package)
	if err != nil {
		return OrganizationAgentSubmission{}, ErrInvalidAgentContent
	}
	findings := ScanAgentPublication(publicationTextAssets(canonical.Package.Bundle))
	if len(findings) != 0 {
		return OrganizationAgentSubmission{}, &OrganizationPublicationDLPError{Findings: findings}
	}
	if err := validateOrganizationPublicationPolicy(
		canonical.Package.Manifest, canonical.Package.Bundle,
	); err != nil {
		return OrganizationAgentSubmission{}, ErrOrganizationPublicationPolicyBlocked
	}
	command, err := buildOrganizationSubmitCommand(
		principal, organizationID, canonical, request,
	)
	if err != nil {
		return OrganizationAgentSubmission{}, ErrInvalidRequest
	}
	result, err := s.repository.SubmitOrganizationAgent(ctx, command)
	if err != nil {
		return OrganizationAgentSubmission{}, err
	}
	return cloneOrganizationAgentSubmission(result), nil
}
```

Repository submission must:

1. begin a PostgreSQL transaction;
2. call `requireOrganizationAgentAccess(..., organizationAgentPublish, false)`;
3. lock Organization-scoped idempotency;
4. for `initial`, reserve the server-generated Definition ID without inserting a Definition;
5. for `next`, lock the exact active Definition and require `base_version_id = latest_version_id`;
6. insert the canonical package and safe audit metadata;
7. commit and return a detached authoritative summary.

Immediately after the access check, validate the canonical package against the transactionally current Organization policy:

```go
if err := validateAgainstCurrentOrganizationPolicy(
	command.Canonical, access.PolicyDocument,
); err != nil {
	return OrganizationAgentSubmission{}, err
}
```

Terminal rejection and withdrawal use this compare-and-transition statement:

```sql
UPDATE organization_agent_submissions
SET status = $4, revision = revision + 1, terminal_at = $5, updated_at = $5
WHERE id = $1 AND organization_id = $2
  AND revision = $3 AND status = 'pending'
RETURNING revision, status, terminal_at, updated_at;
```

Rejection inserts one immutable Review with the transactionally current policy snapshot; withdrawal inserts no Review. Both insert bounded audit and idempotency evidence before commit.

- [ ] **Step 4: Run service and real PostgreSQL repository tests**

Run:

```bash
go test ./internal/agentcontrol -run 'TestSubmitOrganizationAgent|TestOrganizationSubmissionRepositoryVisibilityWithdrawalAndRejection|TestOrganizationSubmission' -count=1
```

Expected: PASS, including idempotency replay and cross-Organization non-disclosure.

- [ ] **Step 5: Commit the non-approval workflow**

```bash
git add internal/agentcontrol/organization_submission_repository.go internal/agentcontrol/organization_submission_repository_test.go internal/agentcontrol/organization_submission_service.go internal/agentcontrol/organization_submission_service_test.go internal/agentcontrol/service.go
git commit -m "feat: persist organization agent submissions"
```

---

### Task 5: Implement mandatory two-person approval and atomic signed publication

**Files:**
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/agentcontrol/organization_submission_repository.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/agentcontrol/organization_submission_repository_test.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/agentcontrol/organization_submission_service.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/agentcontrol/organization_submission_service_test.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/agentcontrol/signing_test.go`

**Interfaces:**
- Consumes: Task 4 pending submissions, Task 3 current policy, and existing `VersionSigner.SignVersion`.
- Produces: approval results with exactly one signed Version, one Review, one Definition update, and a committed `superseded` result for stale bases.

- [ ] **Step 1: Write failing self-review, rollback, and concurrency tests**

```go
func TestOrganizationApprovalRequiresDifferentCurrentPublisher(t *testing.T) {
	fixture := newOrganizationSubmissionRepositoryFixture(t)
	submission := fixture.submitInitial(t, fixture.owner)
	_, err := fixture.review(t, submission.ID, fixture.owner, ReviewOrganizationAgentRequest{
		SubmissionID: submission.ID,
		ExpectedRevision: submission.Revision,
		Decision: OrganizationReviewApprove,
		IdempotencyKey: "self-review-key",
		RequestID: "request-self-review",
	})
	if !errors.Is(err, ErrOrganizationSubmissionSelfReview) {
		t.Fatalf("error = %v, want self-review rejection", err)
	}
	fixture.assertPending(t, submission.ID)
	fixture.assertNoDefinitionOrVersion(t, submission.DefinitionID)
}

func TestOrganizationApprovalRaceCreatesAtMostOneVersion(t *testing.T) {
	fixture := newOrganizationSubmissionRepositoryFixture(t)
	submission := fixture.submitInitial(t, fixture.owner)
	results := fixture.concurrentApprove(t, submission, fixture.admin, fixture.secondAdmin)
	if got := results.approvedCount(); got != 1 {
		t.Fatalf("approved results = %d, want 1", got)
	}
	fixture.assertVersionCount(t, submission.DefinitionID, 1)
	fixture.assertReviewCount(t, submission.ID, 1)
}

func TestOrganizationNextApprovalCommitsSupersededWithoutVersion(t *testing.T) {
	fixture := newOrganizationSubmissionRepositoryFixture(t)
	base := fixture.publishInitial(t)
	first := fixture.submitNext(t, base)
	second := fixture.submitNext(t, base)
	fixture.approve(t, first, fixture.admin)
	result := fixture.approve(t, second, fixture.secondAdmin)
	if result.Status != OrganizationSubmissionSuperseded {
		t.Fatalf("status = %q, want superseded", result.Status)
	}
	fixture.assertVersionCount(t, base.DefinitionID, 2)
}
```

Add rollback subtests for signer failure, DLP rule change, current-policy denial, audit insertion failure, submitter demotion, reviewer removal, archived Organization, and digest mismatch. Every failure must leave the submission pending and create no partial Version or Review.

- [ ] **Step 2: Run approval tests and verify no approval transaction exists**

Run:

```bash
go test ./internal/agentcontrol -run 'TestOrganizationApproval|TestOrganizationNextApproval' -count=1
```

Expected: FAIL because approval and its stable errors are not implemented.

- [ ] **Step 3: Implement one serializable approval transaction**

Add stable errors:

```go
var (
	ErrOrganizationSubmissionSelfReview = errors.New("organization submission self review")
	ErrOrganizationSubmissionConflict = errors.New("organization submission conflict")
	ErrOrganizationSubmissionSuperseded = errors.New("organization submission superseded")
)

type OrganizationSubmissionSupersededError struct {
	Submission OrganizationAgentSubmission
}

func (err *OrganizationSubmissionSupersededError) Error() string {
	return ErrOrganizationSubmissionSuperseded.Error()
}

func (err *OrganizationSubmissionSupersededError) Unwrap() error {
	return ErrOrganizationSubmissionSuperseded
}
```

Approval must execute this exact order in one transaction:

```go
func (r *PostgresRepository) approveOrganizationSubmission(
	ctx context.Context,
	command ReviewOrganizationAgentCommand,
) (OrganizationAgentSubmission, error) {
	tx, err := r.postgres.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return OrganizationAgentSubmission{}, ErrServiceUnavailable
	}
	defer rollbackAgentTransaction(tx)
	reviewer, err := requireOrganizationAgentAccess(
		ctx, tx, command.Principal, command.OrganizationID, organizationAgentReview, false,
	)
	if err != nil {
		return OrganizationAgentSubmission{}, err
	}
	submission, err := lockOrganizationSubmission(ctx, tx,
		command.OrganizationID, command.SubmissionID, command.ExpectedRevision)
	if err != nil {
		return OrganizationAgentSubmission{}, err
	}
	if submission.SubmittedByUserID == command.Principal.UserID {
		return OrganizationAgentSubmission{}, ErrOrganizationSubmissionSelfReview
	}
	if err := requireCurrentOrganizationPublisher(
		ctx, tx, command.OrganizationID, submission.SubmittedByUserID,
	); err != nil {
		return OrganizationAgentSubmission{}, err
	}
	canonical, err := recanonicalizeStoredOrganizationSubmission(submission)
	if err != nil || canonical.ContentDigest != submission.ContentDigest {
		return OrganizationAgentSubmission{}, ErrInvalidAgentContent
	}
	if findings := ScanAgentPublication(
		publicationTextAssets(canonical.Package.Bundle),
	); len(findings) != 0 {
		return OrganizationAgentSubmission{}, &OrganizationPublicationDLPError{Findings: findings}
	}
	if err := validateAgainstCurrentOrganizationPolicy(
		canonical, reviewer.PolicyDocument,
	); err != nil {
		return OrganizationAgentSubmission{}, err
	}
	if submission.Kind == OrganizationSubmissionNext {
		currentVersionID, err := lockOrganizationDefinitionVersion(
			ctx, tx, command.OrganizationID, submission.DefinitionID,
		)
		if err != nil {
			return OrganizationAgentSubmission{}, err
		}
		if currentVersionID != submission.BaseVersionID {
			result, err := markOrganizationSubmissionSuperseded(ctx, tx, submission, command)
			if err != nil {
				return OrganizationAgentSubmission{}, err
			}
			if err := tx.Commit(ctx); err != nil {
				return OrganizationAgentSubmission{}, ErrServiceUnavailable
			}
			return OrganizationAgentSubmission{}, &OrganizationSubmissionSupersededError{
				Submission: cloneOrganizationAgentSubmission(result),
			}
		}
	}
	version, err := r.buildAndSignOrganizationVersion(
		submission, canonical, reviewer, command.Principal.UserID, command.ReviewedAt,
	)
	if err != nil {
		return OrganizationAgentSubmission{}, err
	}
	if err := persistApprovedOrganizationPublication(
		ctx, tx, submission, version, reviewer, command,
	); err != nil {
		return OrganizationAgentSubmission{}, err
	}
	result, err := loadOrganizationSubmission(ctx, tx,
		command.OrganizationID, command.SubmissionID)
	if err != nil {
		return OrganizationAgentSubmission{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return OrganizationAgentSubmission{}, ErrServiceUnavailable
	}
	return result, nil
}
```

`persistApprovedOrganizationPublication` inserts the initial Definition when needed, inserts one immutable signed Version linked to the submission and current Organization policy snapshot, advances `latest_version_id`, transitions the submission to `approved`, inserts one Review, writes idempotency evidence, and records safe audit. It must never sign before all rechecks pass.

- [ ] **Step 4: Run approval tests repeatedly to exercise races**

Run:

```bash
go test ./internal/agentcontrol -run 'TestOrganizationApproval|TestOrganizationNextApproval' -count=10
go test ./internal/agentcontrol -run 'TestVersionAttestation|TestServicePublish' -count=1
```

Expected: PASS for ten race repetitions; existing USER/WORKSPACE signatures and publication remain unchanged.

- [ ] **Step 5: Commit two-person publication**

```bash
git add internal/agentcontrol/organization_submission_repository.go internal/agentcontrol/organization_submission_repository_test.go internal/agentcontrol/organization_submission_service.go internal/agentcontrol/organization_submission_service_test.go internal/agentcontrol/signing_test.go
git commit -m "feat: approve organization agents atomically"
```

---

### Task 6: Add Organization discovery, USER installation, selection, and dissolution guard

**Files:**
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/agentcontrol/organization_asset_guard.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/agentcontrol/organization_asset_guard_test.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/agentcontrol/repository.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/agentcontrol/service.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/agentcontrol/organization_repository_test.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/agentcontrol/organization_service_test.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/organization/asset_guard_test.go`

**Interfaces:**
- Consumes: approved Organization Definitions/Versions and current access/policy from Tasks 3–5.
- Produces: Organization catalog reads, `CreateInstallationRequest.OrganizationID`, Organization-aware manual selection, signed USER policy snapshots, and a real `organization.AssetGuard`.

- [ ] **Step 1: Write failing discovery, role, installation, and guard tests**

```go
func TestOrganizationCatalogRolesAndNonDisclosure(t *testing.T) {
	fixture := newOrganizationAgentRepositoryFixture(t)
	published := fixture.publishApprovedVersion(t)
	for _, actor := range []Principal{
		fixture.owner, fixture.admin, fixture.auditor, fixture.member,
	} {
		got, err := fixture.repository.ListOrganizationDefinitions(
			context.Background(), actor, fixture.organizationID,
		)
		if err != nil || len(got) != 1 || got[0].ID != published.Definition.ID {
			t.Fatalf("catalog for %v = %v, %v", actor.UserID, got, err)
		}
	}
	_, err := fixture.repository.GetOrganizationDefinition(
		context.Background(), fixture.outsider, fixture.organizationID,
		published.Definition.ID, "request-outsider",
	)
	if !errors.Is(err, ErrOrganizationAgentNotFound) {
		t.Fatalf("outsider error = %v", err)
	}
}

func TestOrganizationVersionCreatesOnlyUserOwnedInstallation(t *testing.T) {
	fixture := newOrganizationAgentRepositoryFixture(t)
	published := fixture.publishApprovedVersion(t)
	creation, err := fixture.service.CreateInstallation(context.Background(),
		fixture.member, CreateInstallationRequest{
			VersionID: published.Version.ID,
			OrganizationID: &fixture.organizationID,
			DeviceID: fixture.member.DeviceID,
			DeviceInstallationID: fixture.member.DeviceInstallationID,
			RuntimeVersion: "1.0.0",
			IdempotencyKey: "organization-install-key",
			RequestID: "request-organization-install",
		})
	if err != nil {
		t.Fatalf("CreateInstallation() error = %v", err)
	}
	storedOwner := fixture.loadInstallationOwner(t, creation.Installation.ID)
	if storedOwner.Scope != OwnerScopeUser {
		t.Fatalf("installation owner = %q, want USER", storedOwner.Scope)
	}
	if storedOwner.UserID != fixture.member.UserID ||
		storedOwner.PersonalSpaceID != fixture.member.PersonalSpaceID {
		t.Fatal("installation does not belong to installing employee")
	}
}

func TestOrganizationAgentAssetGuardBlocksDissolution(t *testing.T) {
	guard := NewOrganizationAssetGuard(lockedAssetBlockerReader(
		[]string{"pending_submissions", "published_agents", "employee_installations"},
	))
	blockers, err := guard.DissolutionBlockers(context.Background(), lockedOrganizationID())
	if err != nil {
		t.Fatalf("DissolutionBlockers() error = %v", err)
	}
	if diff := cmp.Diff(
		[]string{"employee_installations", "pending_submissions", "published_agents"}, blockers,
	); diff != "" {
		t.Fatalf("blockers mismatch (-want +got):\n%s", diff)
	}
}
```

- [ ] **Step 2: Run focused tests and observe Organization routing gaps**

Run:

```bash
go test ./internal/agentcontrol -run 'TestOrganizationCatalog|TestOrganizationVersionCreatesOnlyUserOwnedInstallation|TestOrganizationAgentAssetGuard' -count=1
```

Expected: FAIL because discovery, Organization installation source, and the real guard do not exist.

- [ ] **Step 3: Extend repository and service with explicit Organization branches**

Extend the request without changing Installation ownership:

```go
type CreateInstallationRequest struct {
	VersionID uuid.UUID
	WorkspaceID *uuid.UUID
	OrganizationID *uuid.UUID
	DeviceID uuid.UUID
	DeviceInstallationID uuid.UUID
	RuntimeVersion string
	IdempotencyKey string
	RequestID string
}

func validateInstallationSource(request CreateInstallationRequest) error {
	if request.WorkspaceID != nil && request.OrganizationID != nil {
		return ErrInvalidRequest
	}
	return nil
}
```

Add repository queries that select only `owner_scope='ORGANIZATION'` and exact `organization_id`. `versionQuery` must permit an Organization Version only after `requireOrganizationAgentAccess(..., organizationAgentRead, true)`; installation and selection must use `organizationAgentInstall` with `allowArchived=false`.

The service effective-policy branch must be:

```go
case request.OrganizationID != nil:
	access, version, err := s.repository.AuthorizeOrganizationInstallation(
		ctx, principal, *request.OrganizationID, request.VersionID,
	)
	if err != nil {
		return InstallationCreation{}, err
	}
	policy, err = buildOrganizationInstallationPolicy(
		version, access.PolicyDocument, s.platformPolicy, s.localSafetyPolicy,
	)
	if err != nil {
		return InstallationCreation{}, err
	}
	command.SourceOrganizationID = request.OrganizationID
```

Create a guard whose query returns only bounded categories:

```go
func (g OrganizationAssetGuard) DissolutionBlockers(
	ctx context.Context,
	organizationID uuid.UUID,
) ([]string, error) {
	if organizationID == uuid.Nil {
		return nil, ErrInvalidRequest
	}
	blockers, err := g.reader.OrganizationAssetBlockers(ctx, organizationID)
	if err != nil {
		return nil, ErrServiceUnavailable
	}
	slices.Sort(blockers)
	return slices.Compact(blockers), nil
}
```

The SQL counts pending submissions, any Organization Definition/Version, and any USER Installation joined to an Organization Version. Archive remains allowed; dissolution remains blocked while any category exists.

- [ ] **Step 4: Run catalog, install, policy, selection, and Organization lifecycle tests**

Run:

```bash
go test ./internal/agentcontrol -run 'TestOrganizationCatalog|TestOrganizationVersionCreatesOnlyUserOwnedInstallation|TestOrganizationAgentAssetGuard|TestServiceCreateInstallation|TestServiceSelection' -count=1
go test ./internal/organization -run 'TestServiceOrganizationDissolution|TestFoundationAssetGuard' -count=1
```

Expected: PASS; Auditor cannot install, archived Organization blocks install/selection, and USER ownership assertions hold.

- [ ] **Step 5: Commit catalog, runtime-source authorization, and guard**

```bash
git add internal/agentcontrol/organization_asset_guard.go internal/agentcontrol/organization_asset_guard_test.go internal/agentcontrol/repository.go internal/agentcontrol/service.go internal/agentcontrol/organization_repository_test.go internal/agentcontrol/organization_service_test.go internal/organization/asset_guard_test.go
git commit -m "feat: install approved organization agents"
```

---

### Task 7: Expose strict nested HTTP routes, OpenAPI, errors, and shared wiring

**Files:**
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/agentcontrol/organization_submission_http.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/agentcontrol/organization_submission_http_test.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/agentcontrol/http.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/agentcontrol/http_test.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/cmd/aera-cloud/main.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/api/openapi.yaml`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/api/openapi_test.go`

**Interfaces:**
- Consumes: all cloud service methods from Tasks 4–6.
- Produces: nested Organization Agent API, strict tagged request union, stable public errors, and one shared Agent repository used by the Organization dissolution guard.

- [ ] **Step 1: Write failing route, body, error, OpenAPI, and wiring tests**

```go
func TestHTTPOrganizationAgentRoutesUseClaimsAndNeverDirectPublish(t *testing.T) {
	service := &recordingHTTPService{}
	handler := NewHandler(HTTPConfig{Service: service, AccessTokens: lockedAccessAuthenticator()})
	routes := []struct {
		method string
		path string
		wantStatus int
	}{
		{http.MethodGet, "/api/v1/organizations/" + lockedOrganizationID().String() + "/agent-definitions", http.StatusOK},
		{http.MethodPost, "/api/v1/organizations/" + lockedOrganizationID().String() + "/agent-publication-submissions", http.StatusCreated},
		{http.MethodGet, "/api/v1/organizations/" + lockedOrganizationID().String() + "/agent-publication-submissions", http.StatusOK},
		{http.MethodPost, "/api/v1/organizations/" + lockedOrganizationID().String() + "/agent-definitions", http.StatusMethodNotAllowed},
	}
	for _, route := range routes {
		t.Run(route.method+" "+route.path, func(t *testing.T) {
			response := performAgentRequest(t, handler, route.method, route.path,
				lockedOrganizationAgentBody(route.method, route.path))
			if response.Code != route.wantStatus {
				t.Fatalf("status = %d, want %d; body=%s",
					response.Code, route.wantStatus, response.Body.String())
			}
		})
	}
}

func TestHTTPOrganizationSubmissionRejectsOwnershipAndAmbiguousUnionFields(t *testing.T) {
	handler := newLockedAgentHTTPHandler()
	body := `{"kind":"initial","organization_id":"` +
		lockedOrganizationID().String() +
		`","display_name":"Bad","base_version_id":"` +
		uuid.NewString() + `","manifest":{},"bundle":{}}`
	response := performAgentRequest(t, handler, http.MethodPost,
		"/api/v1/organizations/"+lockedOrganizationID().String()+
			"/agent-publication-submissions", body)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", response.Code)
	}
}

func TestOpenAPIContainsOrganizationAgentApprovalContract(t *testing.T) {
	document := loadOpenAPI(t)
	requirePathMethod(t, document,
		"/api/v1/organizations/{organization_id}/agent-publication-submissions", "post")
	requirePathMethod(t, document,
		"/api/v1/organizations/{organization_id}/agent-publication-submissions/{submission_id}/reviews", "post")
	requireSchemaRequired(t, document, "OrganizationAgentSubmission",
		"id", "organization_id", "kind", "definition_id", "content_digest", "status", "revision")
	requireMutuallyExclusiveProperties(t, document, "CreateAgentInstallationRequest",
		"workspace_id", "organization_id")
}
```

- [ ] **Step 2: Run HTTP and OpenAPI tests and observe missing routes**

Run:

```bash
go test ./internal/agentcontrol -run 'TestHTTPOrganization|TestHTTPAgentControl' -count=1
go test ./api -run 'TestOpenAPIContainsOrganizationAgentApprovalContract|TestOpenAPI' -count=1
```

Expected: FAIL because Organization Agent paths and schemas are absent.

- [ ] **Step 3: Add exact routes, DTOs, public errors, and dependency wiring**

Mount only these routes:

```go
router.Get("/api/v1/organizations/{organizationID}/agent-definitions",
	handler.listOrganizationDefinitions)
router.Get("/api/v1/organizations/{organizationID}/agent-definitions/{definitionID}",
	handler.getOrganizationDefinition)
router.Get("/api/v1/organizations/{organizationID}/agent-definitions/{definitionID}/versions",
	handler.listOrganizationVersions)
router.Post("/api/v1/organizations/{organizationID}/agent-publication-submissions",
	handler.submitOrganizationAgent)
router.Get("/api/v1/organizations/{organizationID}/agent-publication-submissions",
	handler.listOrganizationAgentSubmissions)
router.Get("/api/v1/organizations/{organizationID}/agent-publication-submissions/{submissionID}",
	handler.getOrganizationAgentSubmission)
router.Post("/api/v1/organizations/{organizationID}/agent-publication-submissions/{submissionID}/withdraw",
	handler.withdrawOrganizationAgentSubmission)
router.Post("/api/v1/organizations/{organizationID}/agent-publication-submissions/{submissionID}/reviews",
	handler.reviewOrganizationAgentSubmission)
```

Decode the tagged request into explicit DTOs:

```go
type organizationInitialSubmissionRequest struct {
	Kind string `json:"kind"`
	DisplayName string `json:"display_name"`
	IconMediaType string `json:"icon_media_type,omitempty"`
	IconData string `json:"icon_data,omitempty"`
	Manifest AgentManifestV1 `json:"manifest"`
	Bundle VersionBundleV1 `json:"bundle"`
}

type organizationNextSubmissionRequest struct {
	Kind string `json:"kind"`
	DefinitionID uuid.UUID `json:"definition_id"`
	BaseVersionID uuid.UUID `json:"base_version_id"`
	Manifest AgentManifestV1 `json:"manifest"`
	Bundle VersionBundleV1 `json:"bundle"`
}

type organizationReviewRequest struct {
	ExpectedRevision int64 `json:"expected_revision"`
	Decision OrganizationReviewDecision `json:"decision"`
	ReasonCode string `json:"reason_code,omitempty"`
	SafeNote string `json:"safe_note,omitempty"`
}
```

Use the existing strict JSON decoder so duplicate/unknown fields, extra union fields, oversized bodies, non-canonical UUIDs, and missing `Idempotency-Key` fail before service dispatch. Path Organization ID is the only Organization identity.

Map stable errors without object enumeration:

```go
case errors.Is(err, ErrOrganizationAgentNotFound):
	writeAgentError(response, http.StatusNotFound, "organization_agent_not_found")
case errors.Is(err, ErrOrganizationAgentForbidden):
	writeAgentError(response, http.StatusForbidden, "organization_agent_forbidden")
case errors.Is(err, ErrOrganizationArchived):
	writeAgentError(response, http.StatusConflict, "organization_archived")
case errors.Is(err, ErrOrganizationSubmissionSelfReview):
	writeAgentError(response, http.StatusForbidden, "organization_submission_self_review")
case errors.Is(err, ErrOrganizationSubmissionConflict):
	writeAgentError(response, http.StatusConflict, "organization_submission_conflict")
case errors.Is(err, ErrOrganizationPublicationPolicyBlocked):
	writeAgentError(response, http.StatusUnprocessableEntity, "organization_publication_policy_blocked")
```

Handle the committed superseded result before the switch:

```go
type organizationAgentErrorBody struct {
	Code string `json:"code"`
	Message string `json:"message"`
	RequestID string `json:"request_id"`
}

var superseded *OrganizationSubmissionSupersededError
if errors.As(err, &superseded) {
	writeAgentJSON(response, http.StatusConflict, struct {
		Error organizationAgentErrorBody `json:"error"`
		Submission organizationAgentSubmissionResponse `json:"submission"`
	}{
		Error: organizationAgentErrorBody{
			Code: "organization_submission_superseded",
			Message: "localized by the client",
			RequestID: requestID,
		},
		Submission: publicOrganizationAgentSubmission(superseded.Submission),
	})
	return
}
```

DLP errors return only finding code/path/category metadata, never matched evidence.

Refactor startup signatures so one repository instance is shared:

```go
agentRepository := agentcontrol.NewPostgresRepository(postgres)
agentControlHandler, err := buildAgentControlHandler(
	cfg, postgres, redisStore.Client(), agentRepository,
)
if err != nil {
	return err
}
organizationHandler, err := buildOrganizationHandler(
	cfg, postgres, redisStore.Client(),
	agentcontrol.NewOrganizationAssetGuard(agentRepository),
)
if err != nil {
	return err
}
```

Add OpenAPI `oneOf` schemas `SubmitInitialOrganizationAgentRequest` and `SubmitNextOrganizationAgentRequest`, submission/review responses, all eight routes, stable errors, and mutual exclusion between `workspace_id` and `organization_id` in `CreateAgentInstallationRequest`.

- [ ] **Step 4: Run cloud HTTP, OpenAPI, startup, and full tests**

Run:

```bash
go test ./internal/agentcontrol -run 'TestHTTPOrganization|TestHTTPAgentControl' -count=1
go test ./api -count=1
go test ./cmd/aera-cloud -count=1
go test ./... -count=1
```

Expected: all commands PASS; no direct Organization publish route exists.

- [ ] **Step 5: Commit the public cloud contract**

```bash
git add internal/agentcontrol/organization_submission_http.go internal/agentcontrol/organization_submission_http_test.go internal/agentcontrol/http.go internal/agentcontrol/http_test.go cmd/aera-cloud/main.go api/openapi.yaml api/openapi_test.go
git commit -m "feat: expose organization agent approval api"
```

---

### Task 8: Pin the cloud contract and add renderer-safe Organization Agent types

**Files:**
- Modify: `/Users/zizimutou/Desktop/aera/aera/contracts/agentera-cloud.openapi.yaml`
- Modify: `/Users/zizimutou/Desktop/aera/aera/scripts/check-agentera-cloud-contract.mjs`
- Regenerate: `/Users/zizimutou/Desktop/aera/aera/src/shared/agentera-cloud-api.generated.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/shared/agentera-agent-control.ts`
- Test: `/Users/zizimutou/Desktop/aera/aera/tests/agentera-cloud-contract.test.ts`

**Interfaces:**
- Consumes: Task 7 cloud OpenAPI.
- Produces: generated operation/schema types plus renderer-safe `ORGANIZATION`, submission, review, and error unions for all desktop tasks.

- [ ] **Step 1: Write failing contract and public-type assertions**

Add required paths and schemas to the contract checker:

```js
const ORGANIZATION_AGENT_PATHS = [
  "/api/v1/organizations/{organization_id}/agent-definitions",
  "/api/v1/organizations/{organization_id}/agent-definitions/{definition_id}",
  "/api/v1/organizations/{organization_id}/agent-definitions/{definition_id}/versions",
  "/api/v1/organizations/{organization_id}/agent-publication-submissions",
  "/api/v1/organizations/{organization_id}/agent-publication-submissions/{submission_id}",
  "/api/v1/organizations/{organization_id}/agent-publication-submissions/{submission_id}/withdraw",
  "/api/v1/organizations/{organization_id}/agent-publication-submissions/{submission_id}/reviews",
];

const ORGANIZATION_AGENT_SCHEMAS = [
  "OrganizationAgentSubmission",
  "OrganizationAgentSubmissionDetail",
  "OrganizationAgentReview",
  "SubmitInitialOrganizationAgentRequest",
  "SubmitNextOrganizationAgentRequest",
  "ReviewOrganizationAgentRequest",
];
```

In the Vitest contract test, assert the generated `paths` exposes the review operation and the installation request accepts exactly one optional source:

```ts
type ReviewPath =
  paths["/api/v1/organizations/{organization_id}/agent-publication-submissions/{submission_id}/reviews"];
type InstallationRequest = components["schemas"]["CreateAgentInstallationRequest"];

expectTypeOf<ReviewPath["post"]>().not.toEqualTypeOf<never>();
expectTypeOf<InstallationRequest["organization_id"]>().toEqualTypeOf<
  string | undefined
>();
```

- [ ] **Step 2: Run the contract checker and observe missing paths**

Run:

```bash
npm run check:agentera-cloud-contract
npx vitest run tests/agentera-cloud-contract.test.ts
```

Expected: FAIL because the pinned contract and generated types predate Task 7.

- [ ] **Step 3: Copy, generate, and define safe desktop types**

Copy the exact reviewed cloud contract and regenerate:

```bash
cp /Users/zizimutou/Desktop/aera/aera-cloud/api/openapi.yaml contracts/agentera-cloud.openapi.yaml
npm run generate:agentera-cloud
```

Extend the context union:

```ts
export type AgenteraAgentControlContext =
  | { scope: "USER" }
  | {
      scope: "WORKSPACE";
      workspaceId: string;
      role: "owner" | "admin" | "member";
    }
  | {
      scope: "ORGANIZATION";
      organizationId: string;
      role: "owner" | "admin" | "auditor" | "member";
    };
```

Add safe public shapes:

```ts
export type OrganizationAgentSubmissionStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "withdrawn"
  | "superseded";

export interface OrganizationAgentReview {
  id: string;
  reviewerUserId: string;
  decision: "approve" | "reject";
  reasonCode: string | null;
  safeNote: string | null;
  organizationPolicySnapshotId: string;
  organizationPolicyVersion: number;
  reviewedContentDigest: string;
  reviewedAt: string;
}

export interface OrganizationAgentSubmissionSummary {
  id: string;
  organizationId: string;
  kind: "initial" | "next";
  definitionId: string;
  baseVersionId: string | null;
  submittedByUserId: string;
  contentDigest: string;
  status: OrganizationAgentSubmissionStatus;
  revision: number;
  submittedAt: string;
  terminalAt: string | null;
  review: OrganizationAgentReview | null;
}
```

Add exact handle inputs:

```ts
export interface ConfirmOrganizationSubmissionInput {
  publicationHandle: string;
  confirmation: "submit-organization-agent";
}

export interface PrepareOrganizationReviewInput {
  submissionId: string;
  decision: "approve" | "reject";
  reasonCode: string | null;
  safeNote: string | null;
}

export interface ConfirmOrganizationReviewInput {
  reviewHandle: string;
  confirmation:
    | "approve-organization-agent"
    | "reject-organization-agent";
}

export interface ConfirmOrganizationWithdrawalInput {
  withdrawalHandle: string;
  confirmation: "withdraw-organization-agent";
}
```

Prepare calls accept only a local draft ID or cloud submission ID. Confirm calls accept only a one-use handle and exact phrase; none contains Organization ID, role, owner scope, actor identity, revision, credentials, Profile paths, or private Hermes state.

Add the stable errors from Task 7. Retain `organization_agent_not_enabled` through this task so the pre-Task-11 manager still typechecks; Task 11 removes that legacy stop when it switches to the trusted `ORGANIZATION` context.

```ts
| "organization_agent_not_found"
| "organization_agent_forbidden"
| "organization_archived"
| "organization_submission_self_review"
| "organization_submission_conflict"
| "organization_submission_superseded"
| "organization_publication_policy_blocked"
| "organization_publication_dlp_blocked"
```

- [ ] **Step 4: Verify pin, generated types, and both TypeScript projects**

Run:

```bash
npm run check:agentera-cloud-contract
npx vitest run tests/agentera-cloud-contract.test.ts
npm run typecheck
```

Expected: PASS; generated header hash matches the pinned OpenAPI bytes.

- [ ] **Step 5: Commit the deterministic desktop contract**

```bash
git add contracts/agentera-cloud.openapi.yaml scripts/check-agentera-cloud-contract.mjs src/shared/agentera-cloud-api.generated.ts src/shared/agentera-agent-control.ts tests/agentera-cloud-contract.test.ts
git commit -m "feat: pin organization agent cloud contract"
```

---

### Task 9: Migrate local drafts and installations to exact Organization variants

**Files:**
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-agent-control/db.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/tests/agentera-agent-control-db.test.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-agent-control/draft-store.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/tests/agentera-agent-drafts.test.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-agent-control/installation-manager.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-agent-control/installation-manager.test.ts`

**Interfaces:**
- Consumes: Task 8 `ORGANIZATION` context and public source types.
- Produces: SQLite schema version 5, Organization local draft targeting, Organization installation provenance, and `organization_agent_submission_refs`.

- [ ] **Step 1: Write failing migration-preservation and exact-variant tests**

```ts
it("migrates v4 rows and enforces exact v5 organization variants", () => {
  const database = openVersion4Fixture();
  const before = snapshotVersion4Rows(database.sqlite);
  migrateAgentControlDatabase(database.sqlite);
  expect(readSchemaVersion(database.sqlite)).toBe(5);
  expect(snapshotLegacyRows(database.sqlite)).toEqual(before);
  expect(() =>
    database.sqlite
      .prepare(
        `INSERT INTO agent_drafts (
          id, personal_space_id, user_id, target_scope, workspace_id,
          organization_id, display_name, manifest_json, revision, created_at, updated_at
        ) VALUES (?, ?, ?, 'ORGANIZATION', ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(
        uuid(), uuid(), uuid(), uuid(), uuid(), "ambiguous",
        lockedManifestJSON(), lockedTime(), lockedTime(),
      ),
  ).toThrow();
});

it("stores organization draft and installation provenance without changing USER owner", async () => {
  const context = {
    scope: "ORGANIZATION" as const,
    organizationId: organizationId,
    role: "owner" as const,
  };
  const draftStore = new AgentDraftStore({
    ...lockedDraftStoreOptions(),
    context,
  });
  const draft = draftStore.createDraft(lockedCreateDraftInput());
  expect(
    database.sqlite
      .prepare(
        "SELECT target_scope, workspace_id, organization_id FROM agent_drafts WHERE id = ?",
      )
      .get(draft.id),
  ).toEqual({
    target_scope: "ORGANIZATION",
    workspace_id: null,
    organization_id: organizationId,
  });
  const installation = await installationManager.install({
    source: context,
    definitionId,
    versionId,
    profile: { kind: "fresh", name: "org-agent-profile" },
  });
  expect(installation).toMatchObject({
    sourceScope: "ORGANIZATION",
    sourceWorkspaceId: null,
    sourceOrganizationId: organizationId,
  });
  expect(
    database.sqlite
      .prepare(
        "SELECT tenant_id, owner_id FROM local_agent_installations WHERE agent_installation_id = ?",
      )
      .get(installation.agentInstallationId),
  ).toEqual({ tenant_id: tenantId, owner_id: userId });
});
```

- [ ] **Step 2: Run local-store tests and observe schema/type failures**

Run:

```bash
npx vitest run tests/agentera-agent-control-db.test.ts tests/agentera-agent-drafts.test.ts src/main/agentera-agent-control/installation-manager.test.ts
```

Expected: FAIL because schema version 4 and source unions accept only USER/WORKSPACE.

- [ ] **Step 3: Implement schema version 5 and exact source unions**

Use this exact local context:

```ts
export type AgentAssetContext =
  | { scope: "USER" }
  | {
      scope: "WORKSPACE";
      workspaceId: string;
      role: "owner" | "admin" | "member";
    }
  | {
      scope: "ORGANIZATION";
      organizationId: string;
      role: "owner" | "admin" | "auditor" | "member";
    };
```

Normalize draft and installation contexts separately:

```ts
function normalizeDraftContext(context: AgentAssetContext | undefined): {
  scope: "USER" | "WORKSPACE" | "ORGANIZATION";
  workspaceId: string | null;
  organizationId: string | null;
} {
  if (context === undefined || context.scope === "USER") {
    return { scope: "USER", workspaceId: null, organizationId: null };
  }
  if (context.scope === "WORKSPACE") {
    if (
      context.role !== "owner" &&
      context.role !== "admin" &&
      context.role !== "member"
    ) {
      throw new AgentDraftStoreError("invalid_draft");
    }
    return {
      scope: "WORKSPACE",
      workspaceId: requireUuid(context.workspaceId),
      organizationId: null,
    };
  }
  if (context.role !== "owner" && context.role !== "admin") {
    throw new AgentDraftStoreError("invalid_draft");
  }
  return {
    scope: "ORGANIZATION",
    workspaceId: null,
    organizationId: requireUuid(context.organizationId),
  };
}

function normalizeInstallationSource(context: AgentAssetContext | undefined): {
  scope: "USER" | "WORKSPACE" | "ORGANIZATION";
  workspaceId: string | null;
  organizationId: string | null;
} {
  if (context === undefined || context.scope === "USER") {
    return { scope: "USER", workspaceId: null, organizationId: null };
  }
  if (context.scope === "WORKSPACE") {
    return {
      scope: "WORKSPACE",
      workspaceId: uuid(context.workspaceId),
      organizationId: null,
    };
  }
  if (context.role === "auditor") {
    throw new AgentInstallationManagerError("invalid_installation_request");
  }
  return {
    scope: "ORGANIZATION",
    workspaceId: null,
    organizationId: uuid(context.organizationId),
  };
}
```

The migration recreates affected SQLite tables inside one transaction and adds:

```sql
organization_id TEXT,
CHECK (
  (target_scope = 'USER' AND workspace_id IS NULL AND organization_id IS NULL)
  OR (target_scope = 'WORKSPACE' AND workspace_id IS NOT NULL AND organization_id IS NULL)
  OR (target_scope = 'ORGANIZATION' AND workspace_id IS NULL AND organization_id IS NOT NULL)
)
```

For `local_agent_installations`, add `source_organization_id TEXT` and the corresponding exact source check while retaining `owner_scope='USER'`.

Create the reference table:

```sql
CREATE TABLE organization_agent_submission_refs (
  local_draft_id TEXT NOT NULL,
  local_draft_revision INTEGER NOT NULL CHECK (local_draft_revision > 0),
  organization_id TEXT NOT NULL,
  cloud_submission_id TEXT NOT NULL UNIQUE,
  content_digest TEXT NOT NULL CHECK (length(content_digest) = 64),
  cloud_status TEXT NOT NULL CHECK (
    cloud_status IN ('pending','approved','rejected','withdrawn','superseded')
  ),
  cloud_revision INTEGER NOT NULL CHECK (cloud_revision > 0),
  submitted_at TEXT NOT NULL,
  last_verified_at TEXT NOT NULL,
  PRIMARY KEY (local_draft_id, local_draft_revision, organization_id)
);
```

Update parsers and SQL predicates so USER uses both null source IDs, WORKSPACE uses only `source_workspace_id`, and ORGANIZATION uses only `source_organization_id`. Installation list and conflict checks compare both nullable IDs:

```sql
WHERE tenant_id = ? AND owner_id = ? AND device_installation_id = ?
  AND source_scope = ?
  AND source_workspace_id IS ?
  AND source_organization_id IS ?
```

Do not add tokens, review payloads, Profile paths, or content bytes to the reference table.

- [ ] **Step 4: Run migration twice and all local store regressions**

Run:

```bash
npx vitest run tests/agentera-agent-control-db.test.ts tests/agentera-agent-drafts.test.ts src/main/agentera-agent-control/installation-manager.test.ts
npx vitest run src/main/agentera-agent-control/experience-candidate-store.test.ts src/main/agentera-agent-control/runtime-binding-store.test.ts
```

Expected: PASS; legacy USER/WORKSPACE/candidate/binding rows are unchanged.

- [ ] **Step 5: Commit local ownership variants**

```bash
git add src/main/agentera-agent-control/db.ts tests/agentera-agent-control-db.test.ts src/main/agentera-agent-control/draft-store.ts tests/agentera-agent-drafts.test.ts src/main/agentera-agent-control/installation-manager.ts src/main/agentera-agent-control/installation-manager.test.ts
git commit -m "feat: store organization agent local state"
```

---

### Task 10: Add the strict cloud client and one-use Organization publication service

**Files:**
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-agent-control/client.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-agent-control/client.test.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-agent-control/organization-publication-service.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-agent-control/organization-publication-service.test.ts`

**Interfaces:**
- Consumes: generated Task 8 types and Task 9 local draft/reference storage.
- Produces: strict client methods and context-bound one-use publication/review handles for the manager and IPC.

- [ ] **Step 1: Write failing client parser and handle-invalidation tests**

```ts
it("uses the selected organization path and rejects extra response fields", async () => {
  const transport = lockedTransport({
    status: 201,
    json: { ...lockedSubmissionResponse(), access_token: "must-not-cross" },
  });
  const client = new AgenteraAgentControlClient(lockedClientOptions(transport));
  await expect(
    client.submitOrganizationAgent(
      organizationId,
      lockedInitialSubmissionRequest(),
      "submission-key",
    ),
  ).rejects.toMatchObject({ code: "invalid_response" });
  expect(transport).toHaveBeenCalledWith(
    `/api/v1/organizations/${organizationId}/agent-publication-submissions`,
    expect.objectContaining({ method: "POST" }),
  );
});

it("invalidates submit and review handles when trusted context changes", async () => {
  const service = new OrganizationPublicationService(lockedPublicationOptions());
  const preview = await service.prepareSubmission(draftId);
  lockedContext.set({ scope: "ORGANIZATION", organizationId: otherOrganizationId, role: "owner" });
  await expect(
    service.submitPrepared({
      publicationHandle: preview.publicationHandle,
      confirmation: "submit-organization-agent",
    }),
  ).rejects.toMatchObject({ code: "conflict" });
  expect(lockedClient.submitOrganizationAgent).not.toHaveBeenCalled();
});

it("binds withdrawal to the fetched pending revision", async () => {
  const service = new OrganizationPublicationService(lockedPublicationOptions());
  const preview = await service.prepareWithdrawal(submissionId);
  await service.confirmWithdrawal({
    withdrawalHandle: preview.withdrawalHandle,
    confirmation: "withdraw-organization-agent",
  });
  expect(lockedClient.withdrawOrganizationAgentSubmission).toHaveBeenCalledWith(
    organizationId,
    submissionId,
    preview.revision,
    expect.any(String),
  );
});
```

Add tests for exact response fields, canonical UUID/digest/time/status validation, self-review controls absent for the submitter, one-use handles, stale draft revision, stale cloud revision, offline failure before mutation, and safe DLP findings only.

- [ ] **Step 2: Run focused tests and observe missing client/service**

Run:

```bash
npx vitest run src/main/agentera-agent-control/client.test.ts src/main/agentera-agent-control/organization-publication-service.test.ts
```

Expected: FAIL because Organization client methods and publication service do not exist.

- [ ] **Step 3: Implement exact client operations and context-bound handles**

Add client methods with generated request/response types:

```ts
export type SubmitOrganizationAgentRequest =
  | components["schemas"]["SubmitInitialOrganizationAgentRequest"]
  | components["schemas"]["SubmitNextOrganizationAgentRequest"];
export type ReviewOrganizationAgentRequest =
  components["schemas"]["ReviewOrganizationAgentRequest"];

listOrganizationDefinitions(organizationId: string): Promise<AgentDefinitionRecord[]>;
getOrganizationDefinition(
  organizationId: string,
  definitionId: string,
): Promise<AgentDefinitionRecord>;
listOrganizationVersions(
  organizationId: string,
  definitionId: string,
): Promise<AgentVersionRecord[]>;
submitOrganizationAgent(
  organizationId: string,
  body: SubmitOrganizationAgentRequest,
  idempotencyKey: string,
): Promise<OrganizationAgentSubmissionDetailRecord>;
listOrganizationAgentSubmissions(
  organizationId: string,
): Promise<OrganizationAgentSubmissionRecord[]>;
getOrganizationAgentSubmission(
  organizationId: string,
  submissionId: string,
): Promise<OrganizationAgentSubmissionDetailRecord>;
withdrawOrganizationAgentSubmission(
  organizationId: string,
  submissionId: string,
  expectedRevision: number,
  idempotencyKey: string,
): Promise<OrganizationAgentSubmissionDetailRecord>;
reviewOrganizationAgentSubmission(
  organizationId: string,
  submissionId: string,
  body: ReviewOrganizationAgentRequest,
  idempotencyKey: string,
): Promise<OrganizationAgentSubmissionDetailRecord>;
```

Every method validates canonical identifiers before URL construction, uses the access-token transport, accepts only the generated exact schema, and maps only stable public errors.

Implement handle state without exposing Organization identity to the renderer:

```ts
interface PreparedSubmission {
  handle: string;
  contextKey: string;
  draftId: string;
  draftRevision: number;
  expiresAt: number;
}

interface PreparedReview {
  handle: string;
  contextKey: string;
  submissionId: string;
  submissionRevision: number;
  decision: "approve" | "reject";
  reasonCode: string | null;
  safeNote: string | null;
  expiresAt: number;
}

interface PreparedWithdrawal {
  handle: string;
  contextKey: string;
  submissionId: string;
  submissionRevision: number;
  expiresAt: number;
}

private consumeHandle<T extends { contextKey: string; expiresAt: number }>(
  map: Map<string, T>,
  handle: string,
): T {
  const value = map.get(handle);
  map.delete(handle);
  if (
    value === undefined ||
    value.expiresAt < this.now().getTime() ||
    value.contextKey !== this.contextKey()
  ) {
    throw codedError("conflict");
  }
  return value;
}
```

`prepareSubmission` reads one immutable local draft revision, computes counts/bytes/digest, and returns safe preview metadata. `submitPrepared` sends that exact revision and stores only the cloud reference. `prepareReview` fetches the current immutable package online and omits approve controls for the submitter; `reviewPrepared` consumes the exact cloud revision. `prepareWithdrawal` fetches the actor's pending package and captures its revision; `confirmWithdrawal` consumes that handle and dispatches the captured revision.

- [ ] **Step 4: Run client, publication, draft, and contract tests**

Run:

```bash
npx vitest run src/main/agentera-agent-control/client.test.ts src/main/agentera-agent-control/organization-publication-service.test.ts tests/agentera-agent-drafts.test.ts
npm run check:agentera-cloud-contract
```

Expected: PASS; stale or cross-context handles never dispatch a network mutation.

- [ ] **Step 5: Commit the desktop publication boundary**

```bash
git add src/main/agentera-agent-control/client.ts src/main/agentera-agent-control/client.test.ts src/main/agentera-agent-control/organization-publication-service.ts src/main/agentera-agent-control/organization-publication-service.test.ts
git commit -m "feat: add organization agent publication client"
```

---

### Task 11: Replace the unavailable stop with trusted Organization context and role gates

**Files:**
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/shared/agentera-product-space.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-product-space/manager.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-product-space/manager.test.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-agent-control/manager.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-agent-control/manager.test.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/main/app/start.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/tests/agentera-product-space-boundary.test.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/tests/agentera-organization-boundary.test.ts`

**Interfaces:**
- Consumes: trusted product-space coordinator context and Task 10 publication service.
- Produces: Organization-aware manager methods, role-specific capability gates, context invalidation, and runtime components still keyed only by authenticated USER/device.

- [ ] **Step 1: Write failing trusted-context and role-matrix tests**

```ts
it("derives organization behavior from the trusted coordinator only", async () => {
  selectedContext.set({
    scope: "ORGANIZATION",
    organizationId,
    role: "admin",
  });
  const manager = new AgenteraAgentControlManager(lockedManagerOptions());
  await manager.listDefinitions();
  expect(client.listOrganizationDefinitions).toHaveBeenCalledWith(organizationId);
  expect(client.listDefinitions).not.toHaveBeenCalled();
  expect(client.listWorkspaceDefinitions).not.toHaveBeenCalled();
});

it.each([
  ["owner", true, true, true],
  ["admin", true, true, true],
  ["auditor", false, false, false],
  ["member", false, false, true],
] as const)(
  "gates organization role %s without renderer assertions",
  async (role, canSubmit, canReview, canInstall) => {
    selectedContext.set({ scope: "ORGANIZATION", organizationId, role });
    const manager = new AgenteraAgentControlManager(lockedManagerOptions());
    await expectCapability(manager.prepareOrganizationSubmission(draftId), canSubmit);
    await expectCapability(manager.prepareOrganizationReview(submissionId), canReview);
    await expectCapability(manager.installVersion(lockedInstallInput()), canInstall);
  },
);

it("keeps runtime components stable when navigation context changes", async () => {
  const owner = lockedRuntimeOwner();
  const personal = runtimeComponentKey(owner);
  selectedContext.set({ scope: "ORGANIZATION", organizationId, role: "member" });
  const organization = runtimeComponentKey(owner);
  expect(organization).toBe(personal);
  expect(organization).toBe(
    [tenantId, userId, deviceInstallationId].join("\u0000"),
  );
});
```

Boundary tests must prove renderer messages contain no accepted `organizationId`, `role`, `scope`, `ownerId`, or Profile path for Agent operations.

- [ ] **Step 2: Run manager and product-space tests and observe unavailable behavior**

Run:

```bash
npx vitest run src/main/agentera-product-space/manager.test.ts src/main/agentera-agent-control/manager.test.ts tests/agentera-product-space-boundary.test.ts tests/agentera-organization-boundary.test.ts
```

Expected: FAIL because the manager still maps Organization to `ORGANIZATION_UNAVAILABLE`.

- [ ] **Step 3: Implement normalized Organization context and capability methods**

Replace the unavailable branch with:

```ts
if (context.scope === "ORGANIZATION") {
  if (
    !UUID_PATTERN.test(context.organizationId) ||
    !["owner", "admin", "auditor", "member"].includes(context.role)
  ) {
    throw codedError("invalid_request");
  }
  return {
    scope: "ORGANIZATION",
    organizationId: context.organizationId.toLowerCase(),
    role: context.role,
  };
}
```

Change `ProductSpaceAgentContext` and both online/offline verified mapping branches to return the same `ORGANIZATION` shape only when the selected Organization remains present with its verified role. A disappeared or unverified selection still fails closed to PERSONAL/selection-unavailable behavior; it never falls through to Organization Agent access.

Add the exact context key and asset context:

```ts
case "ORGANIZATION":
  return `ORGANIZATION\0${context.organizationId}\0${context.role}`;
```

```ts
case "ORGANIZATION":
  return {
    scope: "ORGANIZATION",
    organizationId: context.organizationId,
    role: context.role,
  };
```

Manager behavior must branch explicitly:

```ts
if (context.scope === "ORGANIZATION") {
  return this.options.client.listOrganizationDefinitions(
    context.organizationId,
  );
}
```

Owner/Admin get local draft and submission/review mutations; Auditor gets published catalog and history reads only; Member gets published catalog and install/select only. Each manager method calls `this.assertOnline()`, checks the trusted current role, then invokes Task 10. On account/device/context/role changes, call `organizationPublication.invalidate()` before notifying renderer state.

Keep:

```ts
export function runtimeComponentKey(owner: AgenteraRuntimeOwner): string {
  return [
    owner.tenantId,
    owner.ownerId,
    owner.deviceInstallationId,
  ].join("\u0000");
}
```

Replace existing internal `ownerKey` calls with `runtimeComponentKey`; do not include product context in that key. Once all unavailable branches are gone, remove `organization_agent_not_enabled` from the shared error union and IPC error mapper.

- [ ] **Step 4: Run manager, USER, WORKSPACE, and context regression tests**

Run:

```bash
npx vitest run src/main/agentera-product-space/manager.test.ts src/main/agentera-agent-control/manager.test.ts tests/agentera-product-space-boundary.test.ts tests/agentera-organization-boundary.test.ts
npx vitest run tests/agentera-workspace-agent-boundary.test.ts src/main/agentera-agent-control/publisher.test.ts
```

Expected: PASS; USER/WORKSPACE publication remains direct, while Organization uses submission/review only.

- [ ] **Step 5: Commit trusted Organization orchestration**

```bash
git add src/shared/agentera-product-space.ts src/main/agentera-product-space/manager.ts src/main/agentera-product-space/manager.test.ts src/main/agentera-agent-control/manager.ts src/main/agentera-agent-control/manager.test.ts src/main/app/start.ts tests/agentera-product-space-boundary.test.ts tests/agentera-organization-boundary.test.ts
git commit -m "feat: enable trusted organization agent context"
```

---

### Task 12: Add exact IPC and preload surfaces without renderer ownership inputs

**Files:**
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-agent-control/ipc-contract.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/tests/agentera-agent-control-ipc.test.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/main/ipc/register.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/tests/ipc-handlers.test.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/preload/index.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/preload/index.d.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera/tests/agentera-organization-agent-boundary.test.ts`

**Interfaces:**
- Consumes: Task 8 safe types and Task 11 manager methods.
- Produces: explicit renderer APIs for Organization submission/history/review with exact parsing and safe serialization.

- [ ] **Step 1: Write failing exact-object and channel-surface tests**

```ts
it("rejects organization identity and role on submission confirmation", () => {
  expect(() =>
    parseConfirmOrganizationSubmissionInput({
      publicationHandle: uuid(),
      confirmation: "submit-organization-agent",
      organizationId: uuid(),
      role: "owner",
    }),
  ).toThrowError(expect.objectContaining({ code: "invalid_request" }));
});

it("accepts only one bounded terminal review command", () => {
  expect(
    parseConfirmOrganizationReviewInput({
      reviewHandle: uuid(),
      confirmation: "approve-organization-agent",
    }),
  ).toEqual({
    reviewHandle: expect.any(String),
    confirmation: "approve-organization-agent",
  });
  expect(() =>
    parseConfirmOrganizationReviewInput({
      reviewHandle: uuid(),
      confirmation: "approve-organization-agent",
      submissionRevision: 4,
    }),
  ).toThrow();
});

it("registers only handle-based organization mutation channels", () => {
  registerIpcHandlers(lockedIPCOptions());
  expect(registeredChannels()).toEqual(
    expect.arrayContaining([
      "agentera-agents-prepare-organization-submission",
      "agentera-agents-confirm-organization-submission",
      "agentera-agents-list-organization-submissions",
      "agentera-agents-get-organization-submission",
      "agentera-agents-prepare-organization-review",
      "agentera-agents-confirm-organization-review",
      "agentera-agents-prepare-organization-withdrawal",
      "agentera-agents-confirm-organization-withdrawal",
    ]),
  );
});
```

- [ ] **Step 2: Run IPC/preload tests and observe missing symbols**

Run:

```bash
npx vitest run tests/agentera-agent-control-ipc.test.ts tests/ipc-handlers.test.ts tests/agentera-organization-agent-boundary.test.ts
```

Expected: FAIL because parsers, channels, and preload methods are absent.

- [ ] **Step 3: Implement handle-only parsers, handlers, declarations, and serialization**

Use exact parser forms:

```ts
export function parseConfirmOrganizationSubmissionInput(
  value: unknown,
): ConfirmOrganizationSubmissionInput {
  if (
    !exactObject(value, ["publicationHandle", "confirmation"]) ||
    value.confirmation !== "submit-organization-agent"
  ) {
    return invalidRequest();
  }
  return {
    publicationHandle: parseAgentControlId(value.publicationHandle),
    confirmation: "submit-organization-agent",
  };
}

export function parseConfirmOrganizationReviewInput(
  value: unknown,
): ConfirmOrganizationReviewInput {
  if (
    !exactObject(value, ["reviewHandle", "confirmation"]) ||
    (value.confirmation !== "approve-organization-agent" &&
      value.confirmation !== "reject-organization-agent")
  ) {
    return invalidRequest();
  }
  return {
    reviewHandle: parseAgentControlId(value.reviewHandle),
    confirmation: value.confirmation,
  };
}

export function parseConfirmOrganizationWithdrawalInput(
  value: unknown,
): ConfirmOrganizationWithdrawalInput {
  if (
    !exactObject(value, ["withdrawalHandle", "confirmation"]) ||
    value.confirmation !== "withdraw-organization-agent"
  ) {
    return invalidRequest();
  }
  return {
    withdrawalHandle: parseAgentControlId(value.withdrawalHandle),
    confirmation: "withdraw-organization-agent",
  };
}
```

Register each channel through `registerAgentControlHandler`; pass only parsed draft ID, submission ID, or one-use handle to manager methods. The preload API mirrors those calls and `index.d.ts` exposes the exact Promise result types.

`serializeOrganizationAgentSubmission` must construct a new object field by field. It may expose immutable review metadata and approved package assets only through the explicit detail call; it must omit access tokens, raw errors, author email, Organization policy bytes, signing material, Profile paths, Memory, sessions, local Skills, and filesystem paths.

- [ ] **Step 4: Run IPC, preload declarations, static boundary, and typechecks**

Run:

```bash
npx vitest run tests/agentera-agent-control-ipc.test.ts tests/ipc-handlers.test.ts tests/agentera-organization-agent-boundary.test.ts
npm run typecheck
```

Expected: PASS; forged ownership fields fail before manager dispatch.

- [ ] **Step 5: Commit the renderer boundary**

```bash
git add src/main/agentera-agent-control/ipc-contract.ts tests/agentera-agent-control-ipc.test.ts src/main/ipc/register.ts tests/ipc-handlers.test.ts src/preload/index.ts src/preload/index.d.ts tests/agentera-organization-agent-boundary.test.ts
git commit -m "feat: expose organization agent review ipc"
```

---

### Task 13: Build role-specific Organization submission, review, catalog, and offline UI

**Files:**
- Create: `/Users/zizimutou/Desktop/aera/aera/src/renderer/src/screens/Agents/OrganizationSubmissionPanel.tsx`
- Create: `/Users/zizimutou/Desktop/aera/aera/src/renderer/src/screens/Agents/OrganizationSubmissionPanel.test.tsx`
- Create: `/Users/zizimutou/Desktop/aera/aera/src/renderer/src/screens/Agents/OrganizationReviewDialog.tsx`
- Create: `/Users/zizimutou/Desktop/aera/aera/src/renderer/src/screens/Agents/OrganizationReviewDialog.test.tsx`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/renderer/src/screens/Agents/AgentControlPanel.tsx`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/renderer/src/screens/Agents/AgentControlPanel.test.tsx`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/renderer/src/screens/Agents/AgentDraftEditor.tsx`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/renderer/src/screens/Agents/AgentDraftEditor.test.tsx`
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
- Consumes: Task 12 preload API and safe role/context state.
- Produces: visible two-person workflow and role-correct Organization catalog without implying cloud runtime or shared Memory.

- [ ] **Step 1: Write failing role and offline presentation tests**

```tsx
it.each([
  ["owner", true, true, true],
  ["admin", true, true, true],
  ["auditor", false, true, false],
  ["member", false, false, true],
] as const)(
  "renders role %s with author=%s history=%s install=%s",
  async (role, author, history, install) => {
    mockAgentState({
      context: { scope: "ORGANIZATION", organizationId, role },
      access: "online",
    });
    render(<AgentControlPanel profiles={[]} />);
    expect(screen.queryByRole("button", { name: "New enterprise draft" }) !== null)
      .toBe(author);
    expect(screen.queryByText("Publication review") !== null).toBe(history);
    expect(screen.queryAllByRole("button", { name: "Install" }).length > 0)
      .toBe(install);
  },
);

it("never renders approve for the submission author", async () => {
  render(
    <OrganizationReviewDialog
      detail={lockedOwnSubmissionDetail()}
      preview={lockedReviewPreview({ selfReview: true })}
      onClose={vi.fn()}
      onCompleted={vi.fn()}
    />,
  );
  expect(screen.queryByRole("button", { name: "Approve version" })).toBeNull();
  expect(screen.getByText("A different Owner or Admin must review this submission."))
    .toBeVisible();
});

it("shows cached organization content read-only while offline", () => {
  mockAgentState({
    context: { scope: "ORGANIZATION", organizationId, role: "owner" },
    access: "offline",
  });
  render(<AgentControlPanel profiles={[]} />);
  expect(screen.getByText("Cached enterprise data")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Submit for review" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
});
```

- [ ] **Step 2: Run focused React tests and observe missing components**

Run:

```bash
npx vitest run src/renderer/src/screens/Agents/OrganizationSubmissionPanel.test.tsx src/renderer/src/screens/Agents/OrganizationReviewDialog.test.tsx src/renderer/src/screens/Agents/AgentControlPanel.test.tsx src/renderer/src/screens/Agents/AgentDraftEditor.test.tsx
```

Expected: FAIL because the Organization UI does not exist and the panel still shows unavailable state.

- [ ] **Step 3: Implement explicit author/reviewer/member/auditor presentation**

`AgentControlPanel` computes capabilities only from the trusted public context:

```ts
const capabilities =
  state.context.scope === "ORGANIZATION"
    ? {
        canAuthor:
          state.access === "online" &&
          (state.context.role === "owner" || state.context.role === "admin"),
        canReadReview:
          state.context.role !== "member",
        canReview:
          state.access === "online" &&
          (state.context.role === "owner" || state.context.role === "admin"),
        canInstall:
          state.access === "online" &&
          state.context.role !== "auditor",
      }
    : null;
```

`OrganizationSubmissionPanel` shows status, immutable digest, author, timestamps, current revision, and terminal review metadata. It gives Owner/Admin explicit `Prepare submission` and `Submit for review` steps; an authorized author can separately prepare and confirm withdrawal of their own pending submission. No button says `Publish`.

`OrganizationReviewDialog` first opens the immutable online detail, shows display name, exact asset list, counts, byte total, digest, base Version, policy/DLP outcome, and safe diff. Approval requires the exact `approve-organization-agent` confirmation; rejection requires a bounded reason and optional safe note before preparing the one-use handle.

Auditor sees catalog/history/policy/audit links only. Member sees catalog/install/select only. Offline shows verified cache age and removes every cloud mutation control.

Add the same complete key shape to all twelve locale files:

```ts
organization: {
  title: "Enterprise Agents",
  cachedReadOnly: "Cached enterprise data",
  newDraft: "New enterprise draft",
  prepareSubmission: "Prepare submission",
  submitForReview: "Submit for review",
  reviewTitle: "Publication review",
  approve: "Approve version",
  reject: "Reject submission",
  differentReviewerRequired:
    "A different Owner or Admin must review this submission.",
  submittedNotPublished:
    "Submitted for review. No Agent version was published or installed.",
  approvedNotInstalled:
    "Version approved. No employee Profile or Memory was changed.",
  runtimeBoundary:
    "Enterprise assets are read-only; your Agent still runs and learns locally.",
},
```

Use accurate translations per locale and keep the English object as the structural type source so missing keys fail TypeScript.

- [ ] **Step 4: Run component, all-locale, type, and renderer regressions**

Run:

```bash
npx vitest run src/renderer/src/screens/Agents/OrganizationSubmissionPanel.test.tsx src/renderer/src/screens/Agents/OrganizationReviewDialog.test.tsx src/renderer/src/screens/Agents/AgentControlPanel.test.tsx src/renderer/src/screens/Agents/AgentDraftEditor.test.tsx
npm run typecheck:web
```

Expected: PASS for all four roles and offline state; no UI implies cloud execution or shared Memory.

- [ ] **Step 5: Commit the Organization Agent experience**

```bash
git add src/renderer/src/screens/Agents/OrganizationSubmissionPanel.tsx src/renderer/src/screens/Agents/OrganizationSubmissionPanel.test.tsx src/renderer/src/screens/Agents/OrganizationReviewDialog.tsx src/renderer/src/screens/Agents/OrganizationReviewDialog.test.tsx src/renderer/src/screens/Agents/AgentControlPanel.tsx src/renderer/src/screens/Agents/AgentControlPanel.test.tsx src/renderer/src/screens/Agents/AgentDraftEditor.tsx src/renderer/src/screens/Agents/AgentDraftEditor.test.tsx src/shared/i18n/locales
git commit -m "feat: add organization agent review experience"
```

---

### Task 14: Prove Organization installation preserves Profile, projection, learning, and RuntimeBinding boundaries

**Files:**
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-agent-control/hermes-projection.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-agent-control/hermes-projection.test.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-agent-control/hermes-adapter.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-agent-control/hermes-adapter.test.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-agent-control/runtime-binding-store.test.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-agent-control/installation-manager.test.ts`
- Test: `/Users/zizimutou/Desktop/aera/aera/tests/agentera-organization-agent-boundary.test.ts`

**Interfaces:**
- Consumes: Organization-source local installation from Task 9 and approved signed Version/policy from Task 6.
- Produces: read-only Organization base projection, independent USER Profile activation, and frozen USER RuntimeBinding for each new conversation.

- [ ] **Step 1: Write failing byte-isolation and conversation-stability tests**

```ts
it("installs organization assets outside HERMES_HOME and preserves private learning", async () => {
  const fixture = await createOrganizationHermesFixture();
  const privateBefore = await fixture.snapshotPrivateProfile();
  const installation = await fixture.installApprovedOrganizationVersion();
  expect(installation.sourceScope).toBe("ORGANIZATION");
  expect(installation.runtimeProfileId).not.toBeNull();
  expect(
    fixture.readInstallationOwner(installation.agentInstallationId),
  ).toEqual({ tenantId, ownerId, deviceInstallationId });
  expect(fixture.projectionRoot).not.toContain(fixture.hermesHome);
  await expectReadOnly(fixture.projectedSkillPath);
  expect(await fixture.snapshotPrivateProfile()).toEqual(privateBefore);
});

it("keeps an active conversation frozen across organization version selection", async () => {
  const fixture = await createOrganizationHermesFixture();
  await fixture.installApprovedOrganizationVersion();
  const first = await fixture.prepareTurn("conversation-a");
  await fixture.writePrivateLearnedSkill("local-only-skill");
  await fixture.selectNextApprovedVersion();
  const resumed = await fixture.prepareTurn("conversation-a");
  const second = await fixture.prepareTurn("conversation-b");
  expect(resumed.binding.agentVersionId).toBe(first.binding.agentVersionId);
  expect(resumed.binding.policySnapshotId).toBe(first.binding.policySnapshotId);
  expect(second.binding.agentVersionId).not.toBe(first.binding.agentVersionId);
  expect(await fixture.readPrivateLearnedSkill("local-only-skill")).toBeTruthy();
});

it("cloud RuntimeBinding metadata remains USER-scoped", () => {
  const record = bindingStore.create(lockedOrganizationSourceBindingInput());
  expect(record.ownerScope).toBe("USER");
  expect(bindingStore.listPendingCloudRecords()[0].body).toEqual({
    binding_id: record.id,
    agent_installation_id: record.agentInstallationId,
    agent_version_id: record.agentVersionId,
    runtime_profile_id: record.runtimeProfileId,
    runtime_version: record.runtimeVersion,
    policy_snapshot_id: record.policySnapshotId,
    tool_permission_digest: record.toolPermissionDigest,
  });
});
```

Add failure tests for signature mismatch, digest mismatch, runtime incompatibility, policy denial, partial download, membership removal, Organization archive, and RuntimeBinding upload failure. Each preserves the previous projection, Profile bytes, completed turns, and private Skill.

- [ ] **Step 2: Run focused Hermes tests and observe missing Organization source support**

Run:

```bash
npx vitest run src/main/agentera-agent-control/hermes-projection.test.ts src/main/agentera-agent-control/hermes-adapter.test.ts src/main/agentera-agent-control/runtime-binding-store.test.ts src/main/agentera-agent-control/installation-manager.test.ts tests/agentera-organization-agent-boundary.test.ts
```

Expected: FAIL where Organization source parsing/routing is not yet accepted.

- [ ] **Step 3: Route Organization through existing immutable projection without new writable paths**

Extend only the source discriminator:

```ts
function projectionSourceKey(installation: LocalAgentInstallation): string {
  switch (installation.sourceScope) {
    case "USER":
      return "USER";
    case "WORKSPACE":
      return ["WORKSPACE", installation.sourceWorkspaceId].join("\u0000");
    case "ORGANIZATION":
      return ["ORGANIZATION", installation.sourceOrganizationId].join("\u0000");
  }
}
```

Keep projection materialization rooted at the existing AgentEra control-plane cache. Verify the Version signature, content digest, asset digest, lineage, runtime range, and signed USER policy before atomically swapping the read-only projection pointer.

Keep local binding ownership fixed:

```ts
const binding = bindingStore.create({
  conversationKey,
  tenantId: owner.tenantId,
  ownerScope: "USER",
  ownerId: owner.ownerId,
  deviceId: owner.deviceId,
  agentDefinitionId: installation.definitionId,
  agentVersionId: installation.selectedVersionId,
  agentInstallationId: installation.id,
  runtimeProfileId: installation.runtimeProfileId,
  runtimeVersion,
  policySnapshotId: installation.policySnapshotId,
  toolPermissionDigest,
  publishedBaseDigest,
});
```

Do not copy enterprise assets into Memory, USER, session directories, writable learned-Skill directories, or Curator state. RuntimeBinding upload remains best-effort outbox delivery after local binding creation.

- [ ] **Step 4: Run Hermes compatibility tests repeatedly**

Run:

```bash
for run in 1 2 3; do
  npx vitest run src/main/agentera-agent-control/hermes-projection.test.ts src/main/agentera-agent-control/hermes-adapter.test.ts src/main/agentera-agent-control/runtime-binding-store.test.ts src/main/agentera-agent-control/installation-manager.test.ts tests/agentera-organization-agent-boundary.test.ts
done
npx vitest run tests/agentera-workspace-agent-boundary.test.ts
```

Expected: PASS on three repetitions; Workspace and USER projection semantics remain unchanged.

- [ ] **Step 5: Commit Organization runtime-source compatibility**

```bash
git add src/main/agentera-agent-control/hermes-projection.ts src/main/agentera-agent-control/hermes-projection.test.ts src/main/agentera-agent-control/hermes-adapter.ts src/main/agentera-agent-control/hermes-adapter.test.ts src/main/agentera-agent-control/runtime-binding-store.test.ts src/main/agentera-agent-control/installation-manager.test.ts tests/agentera-organization-agent-boundary.test.ts
git commit -m "test: protect organization agent hermes isolation"
```

---

### Task 15: Close multi-account E2E, architecture knowledge, and local merge gates

**Files:**
- Create: `/Users/zizimutou/Desktop/aera/aera/tests/e2e/agentera-organization-agent.e2e.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/tests/e2e/support/agentera-agent-control-harness.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/package.json`
- Modify: `/Users/zizimutou/Desktop/aera/aera/lat.md/agentera-organizations.md`
- Modify: `/Users/zizimutou/Desktop/aera/aera/lat.md/agentera-agent-control-plane.md`
- Test: all files changed by Tasks 1–14 in both repositories.

**Interfaces:**
- Consumes: complete cloud and desktop slices.
- Produces: deterministic Owner/Admin/Auditor/Member proof, architecture references, clean local feature branches, and an explicit local-merge decision.

- [ ] **Step 1: Write the failing deterministic multi-account E2E**

```ts
test("organization agent requires two people and keeps every employee runtime private", async ({
  browser,
}) => {
  const owner = await loginDesktopAccount(browser, "organization-owner");
  const admin = await loginDesktopAccount(browser, "organization-admin");
  const auditor = await loginDesktopAccount(browser, "organization-auditor");
  const member = await loginDesktopAccount(browser, "organization-member");

  const submission = await owner.organizationAgents.createDraftAndSubmit({
    displayName: "Enterprise Research",
    skill: lockedReadOnlySkill(),
  });
  await expect(owner.organizationAgents.approve(submission.id)).rejects.toMatchObject({
    errorCode: "organization_submission_self_review",
  });
  const approved = await admin.organizationAgents.approve(submission.id);
  expect(approved.status).toBe("approved");
  expect(approved.versionId).toBeTruthy();

  await expect(auditor.organizationAgents.install(approved.versionId))
    .rejects.toMatchObject({ errorCode: "organization_agent_forbidden" });
  const installation = await member.organizationAgents.install(approved.versionId);
  expect(await member.readInstallationOwner(installation.id)).toEqual({
    tenantId: member.personalSpaceId,
    ownerId: member.userId,
    deviceInstallationId: member.deviceInstallationId,
  });

  const memberBefore = await member.snapshotHermesPrivateState();
  await owner.organizationAgents.writePrivateLearning("owner-private");
  await member.organizationAgents.runConversation("member-conversation");
  expect(await member.snapshotHermesPrivateState()).toEqual(memberBefore);
  expect(await member.readOrganizationProjection()).toEqual(lockedReadOnlySkill());
  expect(await owner.readPrivateLearning("owner-private")).toBeTruthy();
  expect(await member.findPrivateLearning("owner-private")).toBeNull();
});
```

Extend the same E2E with: Member cannot submit/review, Auditor can read history but not install, only the current author can withdraw a pending submission, role demotion races fail closed, archived Organization rejects mutation, stale next submission becomes `superseded`, existing conversation keeps old binding, new conversation uses selected version, offline verified installation continues within entitlement, and reconnect after removal blocks new Organization Agent conversations without deleting the Profile.

- [ ] **Step 2: Run the E2E and verify the script is not yet wired**

Add the package command before running:

```json
"test:e2e:organization-agent": "npm run build && playwright test tests/e2e/agentera-organization-agent.e2e.ts"
```

Run:

```bash
npm run test:e2e:organization-agent
```

Expected before fixture/flow completion: FAIL at the first missing Organization Agent driver or assertion.

- [ ] **Step 3: Complete deterministic fixtures and update LAT implementation evidence**

Extend the existing local harness from two named device roots to four:

```ts
export type AgentControlDeviceName = "A" | "B" | "C" | "D";

export interface AgentControlDevice {
  name: AgentControlDeviceName;
  userData: string;
  hermesHome: string;
  app: ElectronApplication;
  page: Page;
  processOutput: string;
}

function createDeviceRoots(root: string): Record<
  AgentControlDeviceName,
  { userData: string; hermesHome: string }
> {
  return {
    A: { userData: join(root, "device-a"), hermesHome: join(root, "hermes-a") },
    B: { userData: join(root, "device-b"), hermesHome: join(root, "hermes-b") },
    C: { userData: join(root, "device-c"), hermesHome: join(root, "hermes-c") },
    D: { userData: join(root, "device-d"), hermesHome: join(root, "hermes-d") },
  };
}

export interface LocalInstallationOwnerRow {
  tenantId: string;
  ownerId: string;
  deviceInstallationId: string;
  sourceScope: "USER" | "WORKSPACE" | "ORGANIZATION";
  sourceWorkspaceId: string | null;
  sourceOrganizationId: string | null;
}

export function localInstallationOwner(
  device: AgentControlDevice,
  installationId: string,
): LocalInstallationOwnerRow {
  const database = new DatabaseSync(
    join(device.userData, "agentera-control-plane", "control-plane.db"),
    { readOnly: true },
  );
  try {
    const row = database.prepare(
      `SELECT tenant_id, owner_id, device_installation_id, source_scope,
              source_workspace_id, source_organization_id
       FROM local_agent_installations
       WHERE agent_installation_id = ?`,
    ).get(installationId) as Record<string, string | null> | undefined;
    if (!row) throw new Error("Organization Agent installation is missing.");
    return {
      tenantId: String(row.tenant_id),
      ownerId: String(row.owner_id),
      deviceInstallationId: String(row.device_installation_id),
      sourceScope: row.source_scope as LocalInstallationOwnerRow["sourceScope"],
      sourceWorkspaceId: row.source_workspace_id,
      sourceOrganizationId: row.source_organization_id,
    };
  } finally {
    database.close();
  }
}
```

The E2E uses the real local Cloud, four independent product accounts, Organization create/invite/accept/member-patch calls, `window.agenteraProductSpace.select({kind:"ORGANIZATION", organizationId})`, and handle-only `window.agenteraAgents` calls. Reuse `privateProfileSnapshot`, `startBoundConversation`, request capture, and process diagnostics. Do not use production accounts, external deployment, or shared Hermes directories.

Update `lat.md/agentera-organizations.md` with implemented submission/review state machine, role matrix, policy recheck, asset guard, and E2E references. Update `lat.md/agentera-agent-control-plane.md` with Organization asset ownership, USER installation, immutable projection, context invalidation, and RuntimeBinding stability.

Each new LAT section starts with a descriptive paragraph of 250 characters or fewer and links exact source symbols/tests, including:

```markdown
## Organization Agent approval

Organization publication uses immutable cloud submissions and a different current Owner/Admin reviewer; approval alone can create a signed Version.

The transaction is implemented by [[../aera-cloud/internal/agentcontrol/organization_submission_repository.go#PostgresRepository#approveOrganizationSubmission]] and proven by [[../aera-cloud/internal/agentcontrol/organization_submission_repository_test.go#TestOrganizationApprovalRaceCreatesAtMostOneVersion]].
```

- [ ] **Step 4: Run fresh full verification in both repositories**

Cloud:

```bash
go test ./... -count=1
git diff --check
git status --short --branch
```

Desktop:

```bash
npm run check:agentera-cloud-contract
npm run typecheck
npm run lint
npm test
npm run test:e2e:organization-agent
npm run test:e2e:workspace-agent
npm run test:e2e:experience-candidate
npx --no-install lat.md check
git diff --check
git status --short --branch
```

Expected: every command PASS; both feature worktrees are clean and `aera-runtime` has no changes.

- [ ] **Step 5: Commit closure evidence and request review before local merge**

Desktop:

```bash
git add tests/e2e/agentera-organization-agent.e2e.ts tests/e2e/support/agentera-agent-control-harness.ts package.json lat.md/agentera-organizations.md lat.md/agentera-agent-control-plane.md
git commit -m "test: verify organization agent v1"
```

Run `superpowers:requesting-code-review` against both feature-branch diffs. Resolve only evidence-backed findings, rerun Step 4, then use `superpowers:finishing-a-development-branch` to offer local merge. Do not push, deploy, or claim release completion.

## Final Acceptance Checklist

- [ ] Organization initial and next versions can be created only by different-current-publisher approval.
- [ ] Self-review, stale revisions, role changes, archive races, policy changes, DLP changes, signer failures, and audit failures fail closed.
- [ ] A stale next submission commits `superseded` without creating a Version.
- [ ] Owner/Admin/Auditor/Member/outsider permissions match the approved table.
- [ ] Organization Definition/Version ownership never propagates to Installation, policy overlay, RuntimeBinding, or Profile ownership.
- [ ] Each installed Agent has one independent physical Hermes Profile.
- [ ] Knowledge/Skill/SOP assets are immutable and read-only outside `HERMES_HOME`.
- [ ] Memory, USER, sessions, credentials, local Skills, Curator, and private learning never enter submission, API, IPC, audit, or projection storage.
- [ ] Existing conversations retain frozen Version and policy; later conversations use manual selection.
- [ ] Organization dissolution is blocked by pending submissions, published assets, or referencing USER installations.
- [ ] USER, WORKSPACE, ExperienceCandidate, auth, Organization Foundation, and Runtime regressions pass.
- [ ] OpenAPI bytes, generated types, contract checker, LAT references, and repository status are clean.
- [ ] Results are explicitly reported as local implementation/validation only until separate push, deployment, and release evidence exists.
