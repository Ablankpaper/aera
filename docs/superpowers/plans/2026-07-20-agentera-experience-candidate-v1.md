# AgentEra ExperienceCandidate V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user explicitly submit one Hermes agent-created Skill from an installed Workspace Agent for Owner/Admin review and local draft import without uploading or changing private Hermes adaptive state.

**Architecture:** Add a canonical text-only Skill candidate and dual DLP contract to the existing Agent control plane. The cloud stores immutable Workspace-scoped candidates plus one terminal review row; the desktop reads one trusted Installation Profile through a narrow read-only adapter, keeps retryable snapshots outside `HERMES_HOME`, and imports approved content into a new local Workspace Agent draft. Hermes learning, Profiles, Installations, RuntimeBindings, and publication remain independent.

**Tech Stack:** Go 1.26, chi, pgx/PostgreSQL 17, OpenAPI 3.1, Electron 39, TypeScript 5.9, React 19, `better-sqlite3`, Vitest 4, Playwright 1.60, and the unchanged Hermes Runtime.

## Global Constraints

- The authoritative design is `docs/superpowers/specs/2026-07-20-agentera-experience-candidate-v1-design.md`.
- Execute in the current main Codex session without subagents unless the user explicitly overrides that operating rule.
- Desktop work continues on `aera/experience-candidate-v1`, based on design commit `509d560`; cloud work starts from `aera/workspace-agent-v1` commit `7d39a28` and uses a new local `aera/experience-candidate-v1` branch.
- Before implementation, invoke `superpowers:using-git-worktrees` and follow its environment decision. Never discard or overwrite an unrelated dirty worktree.
- Do not edit, branch, package, or publish `/Users/zizimutou/Desktop/aera/aera-runtime`.
- Do not merge, push, deploy, publish a Runtime, modify production data, or change production configuration.
- V1 accepts exactly one Hermes agent-created Skill package. Knowledge, SOP, Memory, USER, conversations, sessions, arbitrary files, full Profiles, model weights, and automatic monitoring/upload are out of scope.
- The only accepted provenance markers are a persisted `.usage.json` record with `created_by: "agent"` or legacy-compatible `agent_created: true`; the sidecar itself and all counters remain local.
- Candidate packages require `SKILL.md`, allow at most 32 regular UTF-8 text files, allow at most 256 KiB per file, and allow at most 1 MiB total candidate content.
- Symlinks, aliases, path escape, binary/NUL content, invalid UTF-8, hidden metadata, dependency/cache trees, credentials, absolute private paths, and Memory/USER/session/conversation/Curator payloads fail closed.
- Local states are exactly `PREPARED`, `UPLOAD_FAILED`, and `SUBMITTED`. Cloud status is derived as `PENDING_REVIEW`, `APPROVED`, or `REJECTED`; approved and rejected decisions are terminal.
- Missing or invalid Hermes provenance returns `candidate_source_ineligible`; offline submission returns `online_required` while preserving `PREPARED`; a transient network/service failure returns `cloud_unavailable` and records `UPLOAD_FAILED` for manual retry.
- Every submission requires an active USER-owned Installation for the exact current device, Workspace Agent definition, and selected source version. Owner/Admin/Member may submit; only Owner/Admin may enumerate all candidates, review, or import.
- Approval never publishes. Import creates a new local Workspace draft from the latest immutable version, and the existing explicit publication flow remains the only way to release a version.
- V1 adds no cloud candidate-to-version lineage table; the existing immutable AgentVersion publication audit remains authoritative after local draft import.
- No error path rewrites or deletes the original source Skill, candidate snapshot, current draft, Installation, Profile binding, RuntimeBinding, or local adaptive state.
- No candidate code may write to a Hermes Profile or import mutating helpers from `memory.ts`, `skills.ts`, sessions, Curator, legacy `agent-sync.ts`, or Runtime distribution.
- Renderer IPC never accepts actor identity, role, owner scope, tenant/user ID, Workspace ID, cloud origin, token, Profile path, source path, database path, DLP override, or audit metadata.
- Every production change follows RED, verified RED, minimal GREEN, verified GREEN, then refactor. Do not write implementation before observing the focused test fail for the intended reason.
- Before each commit run `git diff --check`, the focused GREEN command, and `git status --short`; stage only the task's declared files.
- Update `lat.md/agentera-self-evolution.md`, `lat.md/agentera-agent-control-plane.md`, and the boundary evidence in the final test task; finish every desktop task with `npx --yes lat.md check` as required by `AGENTS.md`.

---

### Task 1: Define the Cloud Candidate and DLP Contract

**Repository:** `/Users/zizimutou/Desktop/aera/aera-cloud`

**Files:**

- Create: `api/experience-candidate-v1-vectors.json`
- Create: `internal/agentcontrol/experience_candidate_model.go`
- Create: `internal/agentcontrol/experience_candidate_model_test.go`
- Create: `internal/agentcontrol/experience_candidate_dlp.go`
- Create: `internal/agentcontrol/experience_candidate_dlp_test.go`

**Interfaces:**

- Produces the canonical bundle, digest, finding codes, and shared fixture contract consumed by every later cloud and desktop task.
- Does not accept Workspace, actor, device, review, Profile, or source-path fields in the candidate bundle.

```go
const (
	ExperienceCandidateSchemaVersion = 1
	ExperienceCandidateDLPVersion    = "experience-candidate-dlp-v1"
	MaxExperienceCandidateFiles      = 32
	MaxExperienceCandidateFileBytes  = 256 * 1024
	MaxExperienceCandidateBytes      = 1024 * 1024
)

type ExperienceCandidateAssetV1 struct {
	Path      string    `json:"path"`
	MediaType MediaType `json:"media_type"`
	Content   string    `json:"content"`
}

type ExperienceCandidateBundleV1 struct {
	SchemaVersion int                          `json:"schema_version"`
	SkillName     string                       `json:"skill_name"`
	Assets        []ExperienceCandidateAssetV1 `json:"assets"`
}

type CanonicalExperienceCandidate struct {
	Bundle        ExperienceCandidateBundleV1
	CanonicalJSON []byte
	ContentDigest [32]byte
}

type ExperienceCandidateFinding struct {
	Code string `json:"code"`
	Path string `json:"path"`
	Line int    `json:"line,omitempty"`
}

type ExperienceCandidateDecision string

const (
	ExperienceCandidateApproved ExperienceCandidateDecision = "APPROVED"
	ExperienceCandidateRejected ExperienceCandidateDecision = "REJECTED"
)

type ExperienceCandidateReview struct {
	ID               uuid.UUID
	ReviewedByUserID *uuid.UUID
	Decision         ExperienceCandidateDecision
	ReasonCode       string
	SafeNote         string
	ReviewedAt       time.Time
}

type ExperienceCandidate struct {
	ID                  uuid.UUID
	WorkspaceID         uuid.UUID
	AgentDefinitionID   uuid.UUID
	SourceAgentVersionID uuid.UUID
	SubmittedByUserID   *uuid.UUID
	SubmittedFromDeviceID *uuid.UUID
	SkillName           string
	DLPContractVersion  string
	ContentDigest       [32]byte
	Bundle              ExperienceCandidateBundleV1
	CreatedAt           time.Time
	Review              *ExperienceCandidateReview
}

var ErrInvalidExperienceCandidate = errors.New("ExperienceCandidate content is invalid")

func CanonicalizeExperienceCandidate(ExperienceCandidateBundleV1) (CanonicalExperienceCandidate, error)
func ScanExperienceCandidate(CanonicalExperienceCandidate) []ExperienceCandidateFinding
```

- [ ] **Step 1: Write the failing canonicalization and vector tests**

Create table tests that require normalized Skill name/path agreement, `SKILL.md`, lexicographic asset order, unique normalized paths, exact media types, the three size limits, and deterministic JSON/digest output.

The positive vector must lock this exact canonical JSON and digest:

```json
{
  "canonical_json": "{\"schema_version\":1,\"skill_name\":\"weekly-summary\",\"assets\":[{\"path\":\"skills/weekly-summary/SKILL.md\",\"media_type\":\"text/markdown\",\"content\":\"---\\nname: weekly-summary\\n---\\n# Weekly summary\\n\"}]}",
  "content_digest": "6fa5c97e58ee22e623505c2c80c7d1b0dd998c81a87bdadc317275e8165f91a2"
}
```

The fixture file also includes named rejection cases for `../escape`, duplicate normalized paths, absent `SKILL.md`, NUL content, private-key blocks, bearer/JWT values, URL credentials, `.env` assignments, `/Users/alice/.hermes/profiles/work`, `C:\\Users\\Alice\\.hermes\\profiles\\work`, `MEMORY.md`, `USER.md`, `sessions/`, conversation exports, and Curator state. Each case contains only expected finding codes and relative line numbers, never the matched secret in expected output.

- [ ] **Step 2: Run canonicalization RED**

Run:

```bash
go test -count=1 ./internal/agentcontrol -run 'TestCanonicalizeExperienceCandidate|TestExperienceCandidateVectors'
```

Expected: FAIL because the candidate types, fixture file, and canonicalizer do not exist.

- [ ] **Step 3: Implement the canonicalizer**

Implement one strict path and serialization pipeline:

```go
func CanonicalizeExperienceCandidate(input ExperienceCandidateBundleV1) (CanonicalExperienceCandidate, error) {
	if input.SchemaVersion != ExperienceCandidateSchemaVersion || !validExperienceSkillName(input.SkillName) {
		return CanonicalExperienceCandidate{}, ErrInvalidExperienceCandidate
	}
	assets, total, err := normalizeExperienceCandidateAssets(input.SkillName, input.Assets)
	if err != nil || total > MaxExperienceCandidateBytes {
		return CanonicalExperienceCandidate{}, ErrInvalidExperienceCandidate
	}
	bundle := ExperienceCandidateBundleV1{SchemaVersion: 1, SkillName: input.SkillName, Assets: assets}
	raw, err := marshalCanonicalExperienceCandidate(bundle)
	if err != nil {
		return CanonicalExperienceCandidate{}, ErrInvalidExperienceCandidate
	}
	return CanonicalExperienceCandidate{Bundle: bundle, CanonicalJSON: raw, ContentDigest: sha256.Sum256(raw)}, nil
}
```

`normalizeExperienceCandidateAssets` must reject non-canonical media types, empty/absolute/dot/hidden/cache/dependency segments, path length above 512 bytes, mismatched `skills/<skill-name>/` prefixes, duplicate normalized paths, invalid UTF-8, NUL, more than 32 assets, or more than 256 KiB per asset. It maps no content and performs no redaction.

- [ ] **Step 4: Write and run DLP RED**

Add tests that call `ScanExperienceCandidate` for every locked fixture, assert stable sorted `{code,path,line}` values, and assert that serialized findings contain none of the supplied secret strings.

Run:

```bash
go test -count=1 ./internal/agentcontrol -run 'TestScanExperienceCandidate|TestExperienceCandidateFindingsDoNotLeakEvidence'
```

Expected: FAIL because the scanner does not yet return the required findings.

- [ ] **Step 5: Implement minimal DLP and run GREEN**

Use precompiled bounded regular expressions and line-by-line scanning. Sort/deduplicate findings by `code\x00path\x00line`; return finding metadata only. The scanner must cover the exact vector cases and must not log source content.

Run:

```bash
gofmt -w internal/agentcontrol/experience_candidate_model.go internal/agentcontrol/experience_candidate_model_test.go internal/agentcontrol/experience_candidate_dlp.go internal/agentcontrol/experience_candidate_dlp_test.go
go test -count=1 ./internal/agentcontrol -run 'ExperienceCandidate'
git diff --check
```

Expected: PASS with the locked canonical digest and every DLP vector.

- [ ] **Step 6: Commit**

```bash
git add api/experience-candidate-v1-vectors.json internal/agentcontrol/experience_candidate_model.go internal/agentcontrol/experience_candidate_model_test.go internal/agentcontrol/experience_candidate_dlp.go internal/agentcontrol/experience_candidate_dlp_test.go
git commit -m "feat: define ExperienceCandidate contract"
```

### Task 2: Persist Immutable Candidates and Terminal Reviews

**Repository:** `/Users/zizimutou/Desktop/aera/aera-cloud`

**Files:**

- Create: `migrations/000011_experience_candidates.sql`
- Modify: `internal/store/migrate_test.go`
- Create: `internal/agentcontrol/experience_candidate_repository.go`
- Create: `internal/agentcontrol/experience_candidate_repository_test.go`
- Modify: `internal/agentcontrol/repository.go`
- Modify: `internal/agentcontrol/workspace_access_test.go`
- Modify: `internal/audit/service.go`
- Modify: `internal/audit/service_test.go`
- Modify: `internal/account/lifecycle_repository.go`

**Interfaces:**

```go
type SubmitExperienceCandidateCommand struct {
	CandidateID     uuid.UUID
	WorkspaceID     uuid.UUID
	DefinitionID    uuid.UUID
	SourceVersionID uuid.UUID
	SkillName       string
	Canonical       CanonicalExperienceCandidate
	DLPVersion      string
	Idempotency     IdempotencyEvidence
	Audit           AuditEvidence
	CreatedAt       time.Time
}

type ReviewExperienceCandidateCommand struct {
	ReviewID      uuid.UUID
	WorkspaceID   uuid.UUID
	CandidateID   uuid.UUID
	Decision      ExperienceCandidateDecision
	ReasonCode    string
	SafeNote      string
	Idempotency   IdempotencyEvidence
	Audit         AuditEvidence
	ReviewedAt    time.Time
}

var ErrExperienceCandidateAlreadyReviewed = errors.New("ExperienceCandidate review is terminal")

func (r *Repository) SubmitExperienceCandidate(context.Context, Principal, SubmitExperienceCandidateCommand) (ExperienceCandidate, bool, error)
func (r *Repository) ListOwnExperienceCandidates(context.Context, Principal, uuid.UUID) ([]ExperienceCandidate, error)
func (r *Repository) ListWorkspaceExperienceCandidates(context.Context, Principal, uuid.UUID) ([]ExperienceCandidate, error)
func (r *Repository) FindExperienceCandidate(context.Context, Principal, uuid.UUID, uuid.UUID, AuditEvidence, time.Time) (ExperienceCandidate, bool, error)
func (r *Repository) ReviewExperienceCandidate(context.Context, Principal, ReviewExperienceCandidateCommand) (ExperienceCandidate, bool, error)
```

- [ ] **Step 1: Write the failing migration assertions**

Extend `internal/store/migrate_test.go` to require eleven migrations, exact columns, constraints, indexes, foreign keys, and immutability triggers for both tables.

The migration creates these core tables:

```sql
CREATE TABLE experience_candidates (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  agent_definition_id UUID NOT NULL REFERENCES agent_definitions(id) ON DELETE RESTRICT,
  source_agent_version_id UUID NOT NULL REFERENCES agent_versions(id) ON DELETE RESTRICT,
  submitted_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  submitted_from_device_id UUID REFERENCES devices(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind = 'SKILL'),
  skill_name TEXT NOT NULL CHECK (char_length(skill_name) BETWEEN 1 AND 100),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  dlp_contract_version TEXT NOT NULL CHECK (dlp_contract_version = 'experience-candidate-dlp-v1'),
  content_digest BYTEA NOT NULL CHECK (octet_length(content_digest) = 32),
  bundle_document JSONB NOT NULL CHECK (jsonb_typeof(bundle_document) = 'object'),
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (id, workspace_id)
);

CREATE TABLE experience_candidate_reviews (
  id UUID PRIMARY KEY,
  candidate_id UUID NOT NULL UNIQUE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  decision TEXT NOT NULL CHECK (decision IN ('APPROVED', 'REJECTED')),
  reviewed_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  reason_code TEXT,
  safe_note TEXT,
  reviewed_at TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (candidate_id, workspace_id)
    REFERENCES experience_candidates(id, workspace_id) ON DELETE RESTRICT,
  CHECK (
    (decision = 'APPROVED' AND reason_code IS NULL AND safe_note IS NULL)
    OR
    (decision = 'REJECTED' AND char_length(reason_code) BETWEEN 1 AND 64
      AND (safe_note IS NULL OR char_length(safe_note) BETWEEN 1 AND 240))
  )
);
```

Add indexes for Workspace/time, submitter/time, definition/time, and pending review lookup. Add triggers that reject changes to schema, destination, decision, digest, or bundle while allowing only account/device deletion to null actor references.

- [ ] **Step 2: Run migration RED**

Run:

```bash
set -a
source .env.example
set +a
AERA_INTEGRATION_TESTS=1 go test -p 1 -count=1 ./internal/store -run '^TestApplyMigrationsCreatesAuthSchemaAndIsIdempotent$'
```

Expected: FAIL because migration 11 and candidate tables are absent.

- [ ] **Step 3: Implement migration 11 and run migration GREEN**

Create the tables, checks, indexes, and immutable-field trigger functions. Preserve all ten existing migrations byte-for-byte.

Run:

```bash
go test -count=1 ./internal/store -run '^TestApplyMigrationsCreatesAuthSchemaAndIsIdempotent$'
set -a
source .env.example
set +a
AERA_INTEGRATION_TESTS=1 go test -p 1 -count=1 ./internal/store -run '^TestApplyMigrationsCreatesAuthSchemaAndIsIdempotent$'
```

Expected: PASS with exactly eleven applied migrations.

- [ ] **Step 4: Write repository and authorization RED**

Add real PostgreSQL tests proving:

- active Owner/Admin/Member with a matching active USER Installation may submit;
- submission fails if the current device, definition, source version, Workspace, Installation status, or owner tuple differs;
- Owner/Admin may list all and review; Member may list/get only their own; outsider cannot enumerate;
- removed membership, archived Workspace, Owner-unavailable Workspace, and racing membership changes fail closed;
- candidate content remains immutable; a single unique review is terminal;
- authorized reviewer detail access records a bounded audit event without bundle content or DLP evidence;
- identical idempotency replay returns the original candidate/review and changed content returns `ErrIdempotencyConflict`;
- account deletion nulls actor references without changing content, decision, digest, or bundle.

Extend access modes explicitly:

```go
const (
	workspaceAgentRead workspaceAgentAccessMode = iota
	workspaceAgentPublish
	workspaceAgentInstall
	workspaceAgentContribute
	workspaceAgentReview
)
```

`workspaceAgentContribute` permits all active roles; `workspaceAgentReview` permits only Owner/Admin.

- [ ] **Step 5: Run repository RED**

Run:

```bash
set -a
source .env.example
set +a
AERA_INTEGRATION_TESTS=1 go test -p 1 -count=1 ./internal/agentcontrol -run 'ExperienceCandidate|WorkspaceAgentAccess'
```

Expected: FAIL because repository methods, contribution/review access modes, and SQL commands do not exist.

- [ ] **Step 6: Implement transactional repository behavior**

Submission must, in one transaction:

1. lock Workspace and actor membership through `requireWorkspaceAgentAccess(ctx, tx, principal, command.WorkspaceID, workspaceAgentContribute, true)`;
2. lock and verify the WORKSPACE-owned definition and source version;
3. require an active USER-owned Installation for `principal.UserID`, `principal.DeviceID`, the exact definition, and source version;
4. resolve/replay the authenticated USER-scoped idempotency record;
5. insert the immutable candidate and bounded audit event;
6. commit before returning detached values.

Review must lock the candidate, use `workspaceAgentReview`, insert one terminal review row and audit event, and resolve uniqueness races by returning the committed identical decision or `ErrExperienceCandidateAlreadyReviewed`. Reviewer detail reads record a separate allowlisted access audit; own-candidate reads never expose other actors and never audit bundle bytes.

- [ ] **Step 7: Run repository GREEN and commit**

Run:

```bash
gofmt -w internal/agentcontrol/experience_candidate_repository.go internal/agentcontrol/experience_candidate_repository_test.go internal/agentcontrol/repository.go internal/agentcontrol/workspace_access_test.go
go test -count=1 ./internal/store ./internal/agentcontrol
set -a
source .env.example
set +a
AERA_INTEGRATION_TESTS=1 go test -p 1 -count=1 ./internal/store ./internal/agentcontrol
git diff --check
```

Expected: PASS without changing USER Agent or Workspace Agent ownership behavior.

Commit:

```bash
git add migrations/000011_experience_candidates.sql internal/store/migrate_test.go internal/agentcontrol/experience_candidate_repository.go internal/agentcontrol/experience_candidate_repository_test.go internal/agentcontrol/repository.go internal/agentcontrol/workspace_access_test.go internal/audit/service.go internal/audit/service_test.go internal/account/lifecycle_repository.go
git commit -m "feat: persist reviewed experience candidates"
```

### Task 3: Expose the Candidate Service and Workspace API

**Repository:** `/Users/zizimutou/Desktop/aera/aera-cloud`

**Files:**

- Create: `internal/agentcontrol/experience_candidate_service.go`
- Create: `internal/agentcontrol/experience_candidate_service_test.go`
- Create: `internal/agentcontrol/experience_candidate_http.go`
- Create: `internal/agentcontrol/experience_candidate_http_test.go`
- Modify: `internal/agentcontrol/service.go`
- Modify: `internal/agentcontrol/http.go`
- Modify: `internal/agentcontrol/http_test.go`
- Modify: `api/openapi.yaml`
- Modify: `api/openapi_test.go`

**Interfaces:**

```go
type SubmitExperienceCandidateRequest struct {
	DefinitionID    uuid.UUID
	SourceVersionID uuid.UUID
	Bundle          ExperienceCandidateBundleV1
	ContentDigest   string
	IdempotencyKey  string
	RequestID       string
}

type ReviewExperienceCandidateRequest struct {
	CandidateID   uuid.UUID
	Decision      ExperienceCandidateDecision
	ReasonCode    string
	SafeNote      string
	IdempotencyKey string
	RequestID     string
}

func (s *Service) SubmitExperienceCandidate(context.Context, Principal, uuid.UUID, SubmitExperienceCandidateRequest) (ExperienceCandidate, error)
func (s *Service) ListOwnExperienceCandidates(context.Context, Principal, uuid.UUID) ([]ExperienceCandidate, error)
func (s *Service) ListWorkspaceExperienceCandidates(context.Context, Principal, uuid.UUID) ([]ExperienceCandidate, error)
func (s *Service) GetExperienceCandidate(context.Context, Principal, uuid.UUID, uuid.UUID) (ExperienceCandidate, error)
func (s *Service) ReviewExperienceCandidate(context.Context, Principal, uuid.UUID, ReviewExperienceCandidateRequest) (ExperienceCandidate, error)
```

- [ ] **Step 1: Write service RED**

Tests require strict canonicalization, client/cloud digest equality, cloud DLP before repository insertion, bounded rejection notes, deterministic request hashes, fresh IDs/audit evidence, and no repository call when validation/DLP fails.

Use a typed blocking error that carries findings without evidence text:

```go
type ExperienceCandidateDLPError struct {
	Findings []ExperienceCandidateFinding
}

func (e *ExperienceCandidateDLPError) Error() string {
	return "ExperienceCandidate content was blocked"
}
```

- [ ] **Step 2: Run service RED**

Run:

```bash
go test -count=1 ./internal/agentcontrol -run 'TestService.*ExperienceCandidate'
```

Expected: FAIL on missing service methods and DLP error.

- [ ] **Step 3: Implement service validation and run GREEN**

Canonicalize the submitted bundle, compare the lowercase 64-character digest in constant time, run cloud DLP, and build repository commands only after all validation succeeds. Rejection notes must be single-line UTF-8 without control characters or secret-like scanner matches. Approved reviews require empty reason/note.

Run:

```bash
gofmt -w internal/agentcontrol/experience_candidate_service.go internal/agentcontrol/experience_candidate_service_test.go internal/agentcontrol/service.go
go test -count=1 ./internal/agentcontrol -run 'TestService.*ExperienceCandidate'
```

Expected: PASS; blocked candidates never reach the repository fake.

- [ ] **Step 4: Write HTTP/OpenAPI RED**

Register and test exactly:

```text
POST /api/v1/workspaces/{workspaceID}/agent-definitions/{definitionID}/experience-candidates
GET  /api/v1/workspaces/{workspaceID}/experience-candidates/mine
GET  /api/v1/workspaces/{workspaceID}/experience-candidates
GET  /api/v1/workspaces/{workspaceID}/experience-candidates/{candidateID}
POST /api/v1/workspaces/{workspaceID}/experience-candidates/{candidateID}/review
```

HTTP tests must prove access-token-derived principal/device, strict JSON with duplicate-key rejection, 1.25 MiB body cap, required idempotency on both POST routes, no ownership/path fields, submitter-vs-reviewer detail dispatch, stable non-enumerating errors, and no candidate content in errors.

The candidate DLP response is exact:

```json
{
  "error": {
    "code": "candidate_dlp_blocked",
    "message": "localized by the client",
    "request_id": "request-id",
    "findings": [
      {"code": "credential_private_key", "path": "skills/weekly-summary/SKILL.md", "line": 4}
    ]
  }
}
```

OpenAPI adds candidate bundle, summary/detail, review request, list response, finding, and candidate-error schemas plus `candidate_dlp_blocked` and `candidate_already_reviewed` error codes.

- [ ] **Step 5: Run HTTP/OpenAPI RED**

Run:

```bash
go test -count=1 ./internal/agentcontrol ./api -run 'ExperienceCandidate|OpenAPI'
```

Expected: FAIL because routes, handlers, and schemas are absent.

- [ ] **Step 6: Implement HTTP/OpenAPI and run full cloud GREEN**

Add candidate methods to `HTTPService`, keep route registration in `NewHandler`, and place candidate response serialization in `experience_candidate_http.go`. General candidate lists omit bundle content; detail responses include the canonical bundle only after service authorization.

Run:

```bash
gofmt -w internal/agentcontrol/experience_candidate_http.go internal/agentcontrol/experience_candidate_http_test.go internal/agentcontrol/http.go internal/agentcontrol/http_test.go api/openapi_test.go
go test -count=1 ./...
set -a
source .env.example
set +a
AERA_INTEGRATION_TESTS=1 go test -p 1 -count=1 ./internal/agentcontrol ./internal/store
git diff --check
```

Expected: PASS with existing API behavior unchanged.

- [ ] **Step 7: Commit**

```bash
git add internal/agentcontrol/experience_candidate_service.go internal/agentcontrol/experience_candidate_service_test.go internal/agentcontrol/experience_candidate_http.go internal/agentcontrol/experience_candidate_http_test.go internal/agentcontrol/service.go internal/agentcontrol/http.go internal/agentcontrol/http_test.go api/openapi.yaml api/openapi_test.go
git commit -m "feat: expose ExperienceCandidate review API"
```

### Task 4: Pin the Desktop Contract and Match Candidate DLP

**Repository:** `/Users/zizimutou/Desktop/aera/aera`

**Files:**

- Modify: `contracts/agentera-cloud.openapi.yaml`
- Create: `contracts/experience-candidate-v1-vectors.json`
- Modify: `scripts/check-agentera-cloud-contract.mjs`
- Modify: `src/shared/agentera-cloud-api.generated.ts`
- Modify: `src/shared/agentera-agent-control.ts`
- Create: `src/main/agentera-agent-control/experience-candidate-contract.ts`
- Create: `src/main/agentera-agent-control/experience-candidate-contract.test.ts`

**Interfaces:**

```ts
export type ExperienceCandidateLocalStatus =
  | "PREPARED"
  | "UPLOAD_FAILED"
  | "SUBMITTED";

export interface ExperienceCandidateAssetV1 {
  path: string;
  mediaType: "text/markdown" | "text/plain";
  content: string;
}

export interface ExperienceCandidateBundleV1 {
  schemaVersion: 1;
  skillName: string;
  assets: ExperienceCandidateAssetV1[];
}

export interface CanonicalExperienceCandidate {
  bundle: ExperienceCandidateBundleV1;
  canonicalJson: string;
  contentDigest: string;
}

export interface ExperienceCandidateFinding {
  code: string;
  path: string;
  line: number | null;
}

export type ExperienceCandidateReviewStatus =
  | "PENDING_REVIEW"
  | "APPROVED"
  | "REJECTED";

export interface ExperienceCandidatePreview {
  localCandidateId: string;
  installationId: string;
  sourceAgentVersionId: string;
  skillName: string;
  assets: Array<{
    path: string;
    mediaType: "text/markdown" | "text/plain";
    sizeBytes: number;
  }>;
  fileCount: number;
  totalBytes: number;
  contentDigest: string;
  findings: ExperienceCandidateFinding[];
}

export interface ExperienceCandidateSummary {
  localCandidateId: string | null;
  cloudCandidateId: string | null;
  agentDefinitionId: string;
  sourceAgentVersionId: string;
  skillName: string;
  contentDigest: string;
  localStatus: ExperienceCandidateLocalStatus | null;
  reviewStatus: ExperienceCandidateReviewStatus | null;
  lastErrorCode: string | null;
  createdAt: string;
  reviewedAt: string | null;
}

export interface ExperienceCandidateDetail extends ExperienceCandidateSummary {
  bundle: ExperienceCandidateBundleV1;
  decisionReasonCode: string | null;
  safeNote: string | null;
}

export function canonicalizeExperienceCandidate(bundle: ExperienceCandidateBundleV1): CanonicalExperienceCandidate;
export function scanExperienceCandidate(candidate: CanonicalExperienceCandidate): ExperienceCandidateFinding[];
```

- [ ] **Step 1: Pin cloud artifacts and write contract RED**

Copy `aera-cloud/api/openapi.yaml` and `aera-cloud/api/experience-candidate-v1-vectors.json` byte-for-byte into the desktop contract paths. Extend the contract checker to require all five routes, candidate schemas/error codes, and exact fixture contract version.

Run:

```bash
npm run generate:agentera-cloud
npm run check:agentera-cloud-contract
```

Expected before checker changes: FAIL because the checker does not yet assert the new contract and the generated type snapshot is stale.

- [ ] **Step 2: Write TypeScript canonical/DLP RED**

Load every copied fixture and assert the same accepted canonical JSON, digest, rejection code, path, and line values as Go. Add explicit tests that findings and thrown error messages contain none of the fixture secrets.

Run:

```bash
npx vitest run src/main/agentera-agent-control/experience-candidate-contract.test.ts
```

Expected: FAIL because the desktop canonicalizer and scanner do not exist.

- [ ] **Step 3: Implement the matching desktop contract**

Use the same field order and UTF-8 byte limits as Go:

```ts
const canonicalDocument = {
  schema_version: 1,
  skill_name: normalizedSkillName,
  assets: normalizedAssets.map((asset) => ({
    path: asset.path,
    media_type: asset.mediaType,
    content: asset.content,
  })),
};
const canonicalJson = JSON.stringify(canonicalDocument);
const contentDigest = createHash("sha256")
  .update(canonicalJson, "utf8")
  .digest("hex");
```

Keep DLP findings code/path/line-only and deterministically sorted. Do not import renderer, Runtime, Profile mutation, Memory, session, or legacy-sync modules.

- [ ] **Step 4: Run GREEN, generated contract, and LAT gate**

Run:

```bash
npm run generate:agentera-cloud
npm run check:agentera-cloud-contract
npx vitest run src/main/agentera-agent-control/experience-candidate-contract.test.ts tests/agentera-cloud-contract.test.ts
npx --yes lat.md check
git diff --check
```

Expected: PASS; the fixture digest is `6fa5c97e58ee22e623505c2c80c7d1b0dd998c81a87bdadc317275e8165f91a2` in both languages.

- [ ] **Step 5: Commit**

```bash
git add contracts/agentera-cloud.openapi.yaml contracts/experience-candidate-v1-vectors.json scripts/check-agentera-cloud-contract.mjs src/shared/agentera-cloud-api.generated.ts src/shared/agentera-agent-control.ts src/main/agentera-agent-control/experience-candidate-contract.ts src/main/agentera-agent-control/experience-candidate-contract.test.ts
git commit -m "feat: pin ExperienceCandidate contract"
```

### Task 5: Store Local Snapshots and Read Hermes Skills Safely

**Repository:** `/Users/zizimutou/Desktop/aera/aera`

**Files:**

- Modify: `src/main/agentera-agent-control/db.ts`
- Modify: `tests/agentera-agent-control-db.test.ts`
- Create: `src/main/agentera-agent-control/experience-candidate-store.ts`
- Create: `src/main/agentera-agent-control/experience-candidate-store.test.ts`
- Create: `src/main/agentera-agent-control/hermes-skill-candidate-source.ts`
- Create: `src/main/agentera-agent-control/hermes-skill-candidate-source.test.ts`

**Interfaces:**

```ts
export interface EligibleExperienceSkill {
  skillName: string;
  description: string;
}

export interface HermesSkillCandidateRead {
  sourceRelativePath: string;
  bundle: ExperienceCandidateBundleV1;
}

export interface HermesSkillCandidateSource {
  listEligible(profilePath: string): EligibleExperienceSkill[];
  readCandidate(profilePath: string, skillName: string): HermesSkillCandidateRead;
}

export class ReadOnlyHermesSkillCandidateSource implements HermesSkillCandidateSource {
  constructor(io?: HermesSkillCandidateFileIO);
  listEligible(profilePath: string): EligibleExperienceSkill[];
  readCandidate(profilePath: string, skillName: string): HermesSkillCandidateRead;
}

export interface PrepareLocalExperienceCandidate {
  id: string;
  agentInstallationId: string;
  workspaceId: string;
  agentDefinitionId: string;
  sourceAgentVersionId: string;
  runtimeProfileId: string;
  skillName: string;
  sourceRelativePath: string;
  canonical: CanonicalExperienceCandidate;
}

export interface LocalExperienceCandidateImport {
  candidateId: string;
  workspaceId: string;
  agentDefinitionId: string;
  baseAgentVersionId: string;
  candidateContentDigest: string;
  draftId: string;
  importedAt: string;
}

export interface LocalExperienceCandidate {
  id: string;
  agentInstallationId: string;
  workspaceId: string;
  agentDefinitionId: string;
  sourceAgentVersionId: string;
  skillName: string;
  contentDigest: string;
  status: ExperienceCandidateLocalStatus;
  cloudCandidateId: string | null;
  lastErrorCode: string | null;
  createdAt: string;
  updatedAt: string;
  submittedAt: string | null;
}

export interface ExperienceCandidateStoreOptions {
  database: AgenteraControlPlaneDatabase;
  owner: AgenteraRuntimeOwner;
  now?: () => Date;
  randomUUID?: () => string;
}

export interface ExperienceCandidateMutationIntent {
  idempotencyKey: string;
  operation: "SUBMIT" | "REVIEW";
  candidateId: string;
  requestHash: string;
}

export class ExperienceCandidateStore {
  constructor(options: ExperienceCandidateStoreOptions);
  prepare(input: PrepareLocalExperienceCandidate): LocalExperienceCandidate;
  listForContext(workspaceId: string): LocalExperienceCandidate[];
  get(id: string): LocalExperienceCandidate;
  readSnapshot(id: string): CanonicalExperienceCandidate;
  markUploadFailed(id: string, errorCode: string): LocalExperienceCandidate;
  markPreparedWithError(id: string, errorCode: string): LocalExperienceCandidate;
  markSubmitted(id: string, cloudCandidateId: string): LocalExperienceCandidate;
  findImport(candidateId: string): LocalExperienceCandidateImport | null;
  getOrCreateMutationIntent(
    operation: "SUBMIT" | "REVIEW",
    candidateId: string,
    requestHash: string,
  ): ExperienceCandidateMutationIntent;
  completeMutationIntent(idempotencyKey: string): void;
}
```

- [ ] **Step 1: Write SQLite v4 and path RED**

Require schema version 4, preserved v3 rows/files, `candidatesPath`, both candidate tables, account/device/context checks, status checks, candidate digest uniqueness within one local owner/device, and a foreign key from import receipt to `agent_drafts`. Reuse `pending_sanitized_records` for explicit candidate mutation intents with record types `experience_candidate_submit` and `experience_candidate_review`; its payload contains only candidate ID and request hash, never bundle content, findings, paths, or notes.

The new local tables are exact:

```sql
CREATE TABLE local_experience_candidates (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  device_installation_id TEXT NOT NULL,
  agent_installation_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  agent_definition_id TEXT NOT NULL,
  source_agent_version_id TEXT NOT NULL,
  runtime_profile_id TEXT NOT NULL,
  skill_name TEXT NOT NULL,
  source_relative_path TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  dlp_contract_version TEXT NOT NULL,
  snapshot_relative_path TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PREPARED', 'UPLOAD_FAILED', 'SUBMITTED')),
  cloud_candidate_id TEXT,
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  submitted_at TEXT,
  UNIQUE (
    tenant_id, owner_id, device_installation_id,
    workspace_id, agent_definition_id, content_digest
  ),
  CHECK (
    (status IN ('PREPARED', 'UPLOAD_FAILED')
      AND cloud_candidate_id IS NULL AND submitted_at IS NULL)
    OR
    (status = 'SUBMITTED'
      AND cloud_candidate_id IS NOT NULL AND submitted_at IS NOT NULL)
  )
);

CREATE TABLE local_experience_candidate_imports (
  tenant_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  device_installation_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  agent_definition_id TEXT NOT NULL,
  base_agent_version_id TEXT NOT NULL,
  candidate_content_digest TEXT NOT NULL,
  draft_id TEXT NOT NULL REFERENCES agent_drafts(id) ON DELETE CASCADE,
  imported_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, owner_id, device_installation_id, candidate_id)
);
```

- [ ] **Step 2: Run schema/store RED**

Run:

```bash
npx vitest run tests/agentera-agent-control-db.test.ts src/main/agentera-agent-control/experience-candidate-store.test.ts
```

Expected: FAIL on schema v3 and missing candidate store/path.

- [ ] **Step 3: Implement SQLite v4 and immutable snapshot storage**

Add `candidatesPath` below `agentera-control-plane/candidates`. Write prepared snapshots with a staging directory, `0600` files, canonical JSON re-read/digest verification, atomic rename, then insert metadata. Database failure removes only the new staging/final candidate path.

Every store query binds the current `(tenant_id, owner_id, device_installation_id)` from the trusted owner provider. Renderer DTO conversion omits runtime/source/snapshot fields. `markSubmitted` commits the cloud ID first and then best-effort removes only the verified candidate snapshot path. Mutation intents use the pending-record ID as the idempotency key, reuse it only when operation, candidate, and canonical request hash all match, and reject a changed request until cloud state is refreshed.

- [ ] **Step 4: Write Hermes source adapter RED**

Use injected filesystem operations and fixtures to prove:

- only persisted agent-created records are listed;
- both accepted provenance markers work;
- archived, bundled, hub, external, projected, duplicate-name, or missing-`SKILL.md` Skills are excluded;
- flat and category/Skill layouts resolve only beneath the exact selected Profile's `skills` root;
- links, special files, path escape, hidden/cache/dependency trees, binaries, invalid UTF-8, and limits fail before candidate creation;
- `.usage.json`, usage counters, absolute paths, and unrelated Skills never enter the returned bundle;
- all source files remain byte-identical after success and every injected failure.

Run:

```bash
npx vitest run src/main/agentera-agent-control/hermes-skill-candidate-source.test.ts
```

Expected: FAIL because the read-only source adapter does not exist.

- [ ] **Step 5: Implement the read-only adapter and run GREEN**

The adapter receives a main-process-resolved absolute Profile path. It canonicalizes the Profile/skills root once, parses `.usage.json` defensively, recursively locates an exact unique agent-created Skill by name, uses `lstat` plus `realpath` containment for every entry, and maps `.md` to `text/markdown` and other UTF-8 regular text to `text/plain`.

It must use only read operations:

```ts
export interface HermesSkillCandidateFileIO {
  lstat(path: string): { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean; size: number };
  realpath(path: string): string;
  readdir(path: string): string[];
  readFile(path: string): Buffer;
}
```

Run:

```bash
npx vitest run tests/agentera-agent-control-db.test.ts src/main/agentera-agent-control/experience-candidate-store.test.ts src/main/agentera-agent-control/hermes-skill-candidate-source.test.ts src/main/agentera-agent-control/experience-candidate-contract.test.ts
npx --yes lat.md check
git diff --check
```

Expected: PASS with source fixture hashes unchanged.

- [ ] **Step 6: Commit**

```bash
git add src/main/agentera-agent-control/db.ts tests/agentera-agent-control-db.test.ts src/main/agentera-agent-control/experience-candidate-store.ts src/main/agentera-agent-control/experience-candidate-store.test.ts src/main/agentera-agent-control/hermes-skill-candidate-source.ts src/main/agentera-agent-control/hermes-skill-candidate-source.test.ts
git commit -m "feat: snapshot local Hermes experience"
```

### Task 6: Connect Trusted Submission and Review IPC

**Repository:** `/Users/zizimutou/Desktop/aera/aera`

**Files:**

- Create: `src/main/agentera-agent-control/experience-candidate-service.ts`
- Create: `src/main/agentera-agent-control/experience-candidate-service.test.ts`
- Modify: `src/main/agentera-agent-control/client.ts`
- Modify: `src/main/agentera-agent-control/client.test.ts`
- Modify: `src/main/agentera-agent-control/manager.ts`
- Modify: `src/main/agentera-agent-control/ipc-contract.ts`
- Modify: `src/main/ipc/auth-guard.ts`
- Modify: `src/main/ipc/register.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/preload/index.d.ts`
- Modify: `tests/agentera-agent-control-ipc.test.ts`
- Modify: `tests/preload-api-surface.test.ts`

**Interfaces:**

```ts
export interface PrepareExperienceCandidateInput {
  installationId: string;
  skillName: string;
}

export interface SubmitExperienceCandidateInput {
  candidateId: string;
  confirmation: "submit-selected-skill";
}

export interface ReviewExperienceCandidateInput {
  candidateId: string;
  decision: "APPROVED" | "REJECTED";
  reasonCode: string | null;
  safeNote: string | null;
}

export interface ExperienceCandidateServiceOptions {
  client: AgenteraAgentControlClient;
  store: ExperienceCandidateStore;
  source: HermesSkillCandidateSource;
  getInstallation: (id: string) => LocalAgentInstallation;
  resolveProfilePath: (profileId: string) => string;
  getContext: () => AgenteraAgentControlContext;
  getAuthState: () => AgenteraAuthPublicState;
  now?: () => Date;
  randomUUID?: () => string;
}

export class ExperienceCandidateService {
  constructor(options: ExperienceCandidateServiceOptions);
  listEligibleSkills(installationId: string): EligibleExperienceSkill[];
  prepare(input: PrepareExperienceCandidateInput): ExperienceCandidatePreview;
  submit(input: SubmitExperienceCandidateInput): Promise<ExperienceCandidateSummary>;
  listMine(): Promise<ExperienceCandidateSummary[]>;
  listReviewQueue(): Promise<ExperienceCandidateSummary[]>;
  get(candidateId: string): Promise<ExperienceCandidateDetail>;
  review(input: ReviewExperienceCandidateInput): Promise<ExperienceCandidateDetail>;
}
```

The renderer API adds exactly:

```ts
listEligibleExperienceSkills(installationId: string)
prepareExperienceCandidate(input: PrepareExperienceCandidateInput)
submitExperienceCandidate(input: SubmitExperienceCandidateInput)
listMyExperienceCandidates()
listExperienceReviewQueue()
getExperienceCandidate(candidateId: string)
reviewExperienceCandidate(input: ReviewExperienceCandidateInput)
```

- [ ] **Step 1: Write cloud client RED**

Tests must prove exact nested URLs, strict DTO parsing, `Idempotency-Key`, canonical snake-case request serialization, DLP finding parsing without raw body leakage, and stable mapping for `candidate_dlp_blocked`, `candidate_already_reviewed`, Workspace lifecycle, not-found, and service-unavailable responses.

Run:

```bash
npx vitest run src/main/agentera-agent-control/client.test.ts -t ExperienceCandidate
```

Expected: FAIL because candidate client methods do not exist.

- [ ] **Step 2: Implement client methods and run client GREEN**

Add methods that receive trusted Workspace/definition IDs from main-process callers. Never accept origin/token from method inputs. Strictly detach returned bundle/finding arrays before returning.

Run:

```bash
npx vitest run src/main/agentera-agent-control/client.test.ts -t ExperienceCandidate
```

Expected: PASS.

- [ ] **Step 3: Write service/manager RED**

Tests must prove:

- the local Installation is active, USER-owned by current account/device, sourced from the selected Workspace, and has a bound runtime Profile;
- Profile path is resolved only after those checks and never returned;
- local DLP runs before `ExperienceCandidateStore.prepare`;
- missing or invalid agent-created provenance returns `candidate_source_ineligible` before snapshot creation;
- PREPARED submission requires online access and explicit confirmation; offline submit returns `online_required` without changing candidate bytes or status;
- a transient network/service failure returns `cloud_unavailable` and becomes UPLOAD_FAILED; deterministic cloud denial stays PREPARED with a bounded error; accepted submission becomes SUBMITTED;
- there is no timer, watcher, startup upload, or automatic retry;
- “My candidates” always includes local PREPARED/UPLOAD_FAILED metadata; while online it merges cloud review status by cloud candidate ID, and while offline submitted items show their last local state without inventing a fresh review status;
- Member sees own list but receives local `workspace_forbidden` for review queue/review; Owner/Admin may review;
- context switch, logout, and account switch invalidate in-memory handles and prevent cross-context reads.

- [ ] **Step 4: Run service/manager RED**

Run:

```bash
npx vitest run src/main/agentera-agent-control/experience-candidate-service.test.ts tests/agentera-agent-owner-isolation.test.ts
```

Expected: FAIL because orchestration methods are absent.

- [ ] **Step 5: Implement trusted orchestration**

Construct the candidate service inside `AgenteraAgentControlManager` after the existing USER/device runtime components are available:

```ts
const experienceCandidates = new ExperienceCandidateService({
  client: this.options.client,
  store: new ExperienceCandidateStore({
    database: this.options.database,
    owner,
    now: this.options.now,
    randomUUID: this.options.randomUUID,
  }),
  source: new ReadOnlyHermesSkillCandidateSource(),
  getInstallation: (id) => installations.getLocalInstallation(id),
  resolveProfilePath: this.options.profiles.resolveProfilePath,
  getContext: this.options.getAgentContext,
  getAuthState: this.options.getAuthState,
  now: this.options.now,
  randomUUID: this.options.randomUUID,
});
```

The service resolves Installation records through the existing manager/store boundary, not a renderer-provided path. Before the first submission/review, canonicalize the cloud request fields, SHA-256 hash them, and call `getOrCreateMutationIntent`; pass its persisted ID as `Idempotency-Key`. Delete the intent only after a definite cloud response. After an ambiguous transport/service failure, keep it for an exact manual retry; before accepting a changed review request, fetch cloud detail and either adopt the terminal result or require retry of the original request.

- [ ] **Step 6: Write IPC/preload RED**

Extend exact-object parsers and tests so candidate mutations accept only the fields shown above. Use `authenticated` policy for local eligibility, preparation, and “My candidates”; use `online` policy for submit, review queue, cloud detail, and review. Assert every preload method and channel exists exactly once and no Workspace/Profile/owner field crosses IPC.

Run:

```bash
npx vitest run tests/agentera-agent-control-ipc.test.ts tests/preload-api-surface.test.ts
```

Expected: FAIL on missing channels, parsers, policy, and preload methods.

- [ ] **Step 7: Implement IPC/preload and run focused GREEN**

Register channels under `agentera-agents-*`, serialize renderer-safe DTOs by construction, and reuse `executeAgentControlIpc` for bounded error codes/findings. Do not use object spread to remove secrets at the IPC edge.

Run:

```bash
npx vitest run src/main/agentera-agent-control/client.test.ts src/main/agentera-agent-control/experience-candidate-service.test.ts tests/agentera-agent-owner-isolation.test.ts tests/agentera-agent-control-ipc.test.ts tests/preload-api-surface.test.ts tests/agentera-ipc-auth-guard.test.ts
npx --yes lat.md check
git diff --check
```

Expected: PASS with no Profile path or ownership field in renderer calls.

- [ ] **Step 8: Commit**

```bash
git add src/main/agentera-agent-control/experience-candidate-service.ts src/main/agentera-agent-control/experience-candidate-service.test.ts src/main/agentera-agent-control/client.ts src/main/agentera-agent-control/client.test.ts src/main/agentera-agent-control/manager.ts src/main/agentera-agent-control/ipc-contract.ts src/main/ipc/auth-guard.ts src/main/ipc/register.ts src/preload/index.ts src/preload/index.d.ts tests/agentera-agent-control-ipc.test.ts tests/preload-api-surface.test.ts
git commit -m "feat: connect ExperienceCandidate control flow"
```

### Task 7: Import Approved Skills into an Idempotent Local Draft

**Repository:** `/Users/zizimutou/Desktop/aera/aera`

**Files:**

- Create: `src/main/agentera-agent-control/experience-candidate-importer.ts`
- Create: `src/main/agentera-agent-control/experience-candidate-importer.test.ts`
- Modify: `src/main/agentera-agent-control/draft-store.ts`
- Modify: `tests/agentera-agent-drafts.test.ts`
- Modify: `src/main/agentera-agent-control/experience-candidate-store.ts`
- Modify: `src/main/agentera-agent-control/experience-candidate-store.test.ts`
- Modify: `src/main/agentera-agent-control/experience-candidate-service.ts`
- Modify: `src/main/agentera-agent-control/experience-candidate-service.test.ts`
- Modify: `src/main/agentera-agent-control/manager.ts`
- Modify: `src/main/agentera-agent-control/ipc-contract.ts`
- Modify: `src/main/ipc/auth-guard.ts`
- Modify: `src/main/ipc/register.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/preload/index.d.ts`
- Modify: `tests/agentera-agent-control-ipc.test.ts`
- Modify: `tests/preload-api-surface.test.ts`

**Interfaces:**

```ts
export interface ExperienceCandidateImportPreview {
  importHandle: string;
  candidateId: string;
  sourceVersionId: string;
  latestVersionId: string;
  latestVersionNumber: number;
  skillName: string;
  replacesExistingSkill: boolean;
  addedPaths: string[];
  replacedPaths: string[];
  removedPaths: string[];
}

export interface ConfirmExperienceCandidateImportInput {
  importHandle: string;
  confirmation: "apply-approved-skill-to-latest";
}

prepareExperienceCandidateImport(candidateId: string): Promise<ExperienceCandidateImportPreview>
confirmExperienceCandidateImport(input: ConfirmExperienceCandidateImportInput): Promise<AgentDraftDetail>
```

- [ ] **Step 1: Write importer RED**

Tests must cover:

- only an APPROVED candidate in the exact selected Workspace/definition may preview/import;
- the latest published Workspace version is downloaded and signature/digest verified before use;
- a candidate whose cloud bundle digest differs is rejected;
- preview identifies exact added/replaced/removed paths under only `skills/<skill-name>/`;
- an existing same-name base Skill requires the explicit confirmation string;
- every unrelated manifest field and asset remains byte-equivalent to the latest base;
- a version change between preview and confirm returns `candidate_base_advanced` before SQLite mutation;
- repeated import on one account/device returns the recorded draft; another authorized device may create its own draft;
- approved cloud state survives download, verification, transaction, and disk failures.

Run:

```bash
npx vitest run src/main/agentera-agent-control/experience-candidate-importer.test.ts
```

Expected: FAIL because the importer and preview handle do not exist.

- [ ] **Step 2: Add transaction-safe draft/import primitives**

Refactor `AgentDraftStore.createDraft` to call an internal row writer that can participate in a caller-owned SQLite transaction without changing normal draft behavior:

```ts
createDraft(input: CreateAgentDraftInput): AgentDraft {
  return this.inImmediateTransaction(() => this.createDraftRows(input));
}

createDraftRowsInCurrentTransaction(input: CreateAgentDraftInput): AgentDraft {
  return this.createDraftRows(input);
}
```

Add `ExperienceCandidateStore.recordImportInCurrentTransaction(receipt)` and one importer-owned `BEGIN IMMEDIATE` that writes draft rows plus receipt before COMMIT. Inject a failure after each write in tests and assert both tables roll back.

- [ ] **Step 3: Implement preview and confirmation**

Keep one-use preview handles only in main-process memory and bind each handle to owner, device, Workspace, candidate ID/digest, definition, and latest version ID/digest. At confirm, re-fetch latest version identity before any local transaction.

Build the new draft by:

1. converting the verified latest version manifest/bundle into editable draft inputs;
2. removing only assets with prefix `skills/<candidate-skill-name>/`;
3. adding the approved candidate assets as kind `skill` with their locked media types;
4. keeping display name, icon, identity, model constraints, tools, dependencies, Runtime compatibility, and all unrelated assets from the latest base;
5. writing `sourceAgentDefinitionId` and `baseAgentVersionId` from that latest base.

- [ ] **Step 4: Write IPC RED and implement the two import methods**

The renderer supplies only candidate ID for preview and `{importHandle, confirmation}` for confirm. Add authenticated/online policies, exact-object parsing, preload declarations, and surface tests. A context change or logout clears every import handle.

Run RED first:

```bash
npx vitest run tests/agentera-agent-control-ipc.test.ts tests/preload-api-surface.test.ts -t 'experience candidate import'
```

Expected: FAIL on missing methods/channels.

Then implement the methods and route them through `ExperienceCandidateService` and `AgenteraAgentControlManager`.

- [ ] **Step 5: Run focused GREEN and commit**

Run:

```bash
npx vitest run src/main/agentera-agent-control/experience-candidate-importer.test.ts src/main/agentera-agent-control/experience-candidate-service.test.ts src/main/agentera-agent-control/experience-candidate-store.test.ts tests/agentera-agent-drafts.test.ts tests/agentera-agent-control-ipc.test.ts tests/preload-api-surface.test.ts
npx --yes lat.md check
git diff --check
```

Expected: PASS, including transaction rollback, idempotent reopen, and stale-base protection.

Commit:

```bash
git add src/main/agentera-agent-control/experience-candidate-importer.ts src/main/agentera-agent-control/experience-candidate-importer.test.ts src/main/agentera-agent-control/draft-store.ts tests/agentera-agent-drafts.test.ts src/main/agentera-agent-control/experience-candidate-store.ts src/main/agentera-agent-control/experience-candidate-store.test.ts src/main/agentera-agent-control/experience-candidate-service.ts src/main/agentera-agent-control/experience-candidate-service.test.ts src/main/agentera-agent-control/manager.ts src/main/agentera-agent-control/ipc-contract.ts src/main/ipc/auth-guard.ts src/main/ipc/register.ts src/preload/index.ts src/preload/index.d.ts tests/agentera-agent-control-ipc.test.ts tests/preload-api-surface.test.ts
git commit -m "feat: import approved experience into drafts"
```

### Task 8: Add Promotion, My Candidates, and Review UI

**Repository:** `/Users/zizimutou/Desktop/aera/aera`

**Files:**

- Create: `src/renderer/src/screens/Agents/ExperiencePromotionDialog.tsx`
- Create: `src/renderer/src/screens/Agents/ExperiencePromotionDialog.test.tsx`
- Create: `src/renderer/src/screens/Agents/ExperienceCandidatePanel.tsx`
- Create: `src/renderer/src/screens/Agents/ExperienceCandidatePanel.test.tsx`
- Create: `src/renderer/src/screens/Agents/ExperienceReviewDialog.tsx`
- Create: `src/renderer/src/screens/Agents/ExperienceReviewDialog.test.tsx`
- Modify: `src/renderer/src/screens/Agents/AgentControlPanel.tsx`
- Modify: `src/renderer/src/screens/Agents/AgentControlPanel.test.tsx`
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

**Produces:** Explicit promotion from an active Workspace Installation, own-status visibility for every role, Owner/Admin review/import, and no automatic upload/publication.

- [ ] **Step 1: Write promotion dialog RED**

Renderer tests must prove:

- “Promote local experience” appears only on an active Installation sourced from the selected Workspace;
- opening the dialog lists eligible names without Profile paths or content;
- selecting one Skill displays source Agent/version, file list, counts, digest, local DLP pass, and the privacy statement;
- preparation can occur offline, but submit is disabled with online guidance;
- submit requires the exact confirmation and never starts on dialog open;
- blocked findings show localized code/path/line without evidence fragments;
- failed upload leaves an explicit manual retry button and no timer.

Run:

```bash
npx vitest run src/renderer/src/screens/Agents/ExperiencePromotionDialog.test.tsx
```

Expected: FAIL because the component does not exist.

- [ ] **Step 2: Implement the promotion dialog**

Keep local steps explicit: select Installation, choose one eligible Skill, prepare/preview, confirm submit. Call only the candidate preload methods; never call profile, memory, skill mutation, or legacy account APIs.

- [ ] **Step 3: Write candidate panel and review dialog RED**

Tests must prove:

- every role sees “My candidates” and only its returned items;
- only Owner/Admin sees “Experience review” and opens candidate details;
- Member never invokes review-list/detail-for-review methods;
- rejection requires a reason code, bounds the optional note, and sends no content replacement;
- approval commits review first, then prepares a latest-base import preview;
- same-name Skill replacement is visibly confirmed;
- `candidate_base_advanced` refreshes the preview rather than mutating a draft;
- approved-but-import-failed state exposes “Create draft” retry;
- successful import opens the existing `AgentDraftEditor`; publishing remains a separate existing action.

Run:

```bash
npx vitest run src/renderer/src/screens/Agents/ExperienceCandidatePanel.test.tsx src/renderer/src/screens/Agents/ExperienceReviewDialog.test.tsx
```

Expected: FAIL because the components do not exist.

- [ ] **Step 4: Implement panel/review integration and localized copy**

Add concise translations for promotion, privacy consent, DLP codes, local states, cloud states, review reasons, import diff, stale-base confirmation, and retry. Keep the complete English and Simplified Chinese copy; preserve the existing typed locale shape for all other locale files by providing equivalent keys.

`AgentControlPanel` owns refresh after submit/review/import and closes context-bound dialogs whenever scope, Workspace, role, or account changes.

- [ ] **Step 5: Run renderer GREEN, build, and commit**

Run:

```bash
npx vitest run src/renderer/src/screens/Agents/ExperiencePromotionDialog.test.tsx src/renderer/src/screens/Agents/ExperienceCandidatePanel.test.tsx src/renderer/src/screens/Agents/ExperienceReviewDialog.test.tsx src/renderer/src/screens/Agents/AgentControlPanel.test.tsx src/renderer/src/screens/Agents/AgentDraftEditor.test.tsx
npm run typecheck
npx --yes lat.md check
git diff --check
```

Expected: PASS with Member review controls absent and no ownership/Profile fields in calls.

Commit:

```bash
git add src/renderer/src/screens/Agents/ExperiencePromotionDialog.tsx src/renderer/src/screens/Agents/ExperiencePromotionDialog.test.tsx src/renderer/src/screens/Agents/ExperienceCandidatePanel.tsx src/renderer/src/screens/Agents/ExperienceCandidatePanel.test.tsx src/renderer/src/screens/Agents/ExperienceReviewDialog.tsx src/renderer/src/screens/Agents/ExperienceReviewDialog.test.tsx src/renderer/src/screens/Agents/AgentControlPanel.tsx src/renderer/src/screens/Agents/AgentControlPanel.test.tsx src/shared/i18n/locales/*/agents.ts
git commit -m "feat: review promoted Agent experience"
```

### Task 9: Prove the Two-Account Evolution Boundary

**Repository:** `/Users/zizimutou/Desktop/aera/aera`

**Files:**

- Create: `tests/agentera-experience-candidate-boundary.test.ts`
- Create: `tests/e2e/agentera-experience-candidate.e2e.ts`
- Modify: `tests/e2e/support/agentera-agent-control-harness.ts`
- Modify: `package.json`
- Modify: `lat.md/agentera-self-evolution.md`
- Modify: `lat.md/agentera-agent-control-plane.md`

**Produces:** Executable proof that selected Skill promotion reaches a later Workspace Agent version while unselected private learning and running conversations remain unchanged.

- [ ] **Step 1: Write static boundary RED**

The boundary test must allow Profile reads only inside `hermes-skill-candidate-source.ts` and reject candidate-domain imports/references to:

```text
src/main/memory.ts
src/main/skills.ts mutation exports
src/main/agent-sync.ts
sessions
Curator
Runtime distribution mutation
RuntimeBinding ownership changes
Workspace-owned Installation/Profile vocabulary
```

It must also lock the exact candidate renderer mutation fields and verify no IPC surface accepts Workspace ID, owner scope, Profile path, source path, token, cloud origin, or DLP override.

Run:

```bash
npx vitest run tests/agentera-experience-candidate-boundary.test.ts
```

Expected: FAIL until the boundary file and exact allowlist exist.

- [ ] **Step 2: Extend the E2E harness and write scenario RED**

Add `test:e2e:experience-candidate`:

```json
"test:e2e:experience-candidate": "npm run build && playwright test tests/e2e/agentera-experience-candidate.e2e.ts"
```

The harness creates two isolated userData/Profile/device contexts and uses the real local PostgreSQL/Redis-backed cloud. It may create fixture Skill files and `.usage.json` directly inside its temporary Member Profile, but it must not invoke or modify `aera-runtime`.

The scenario is exact:

1. Owner publishes Workspace Agent v1.
2. Member installs v1 into a distinct physical Profile.
3. Fixture setup writes one selected agent-created Skill, one unselected private Skill, Memory, USER, session, Curator marker, credential marker, and local file.
4. A secret-bearing candidate is blocked locally and emits no candidate POST.
5. Member explicitly prepares/submits the safe selected Skill.
6. Captured HTTP requests contain only the canonical selected Skill package and allowlisted control metadata.
7. Member sees own status; another Member cannot enumerate it; Admin sees the review queue.
8. Admin approves, previews latest-base import, creates a local draft, and publishes v2 through the existing publication flow.
9. Member manually selects v2; an existing v1 conversation remains v1 and a new conversation binds v2.
10. Success and injected upload/review/import failures leave every private fixture hash unchanged.

- [ ] **Step 3: Run E2E RED**

Run:

```bash
npm run test:e2e:experience-candidate
```

Expected: FAIL on the first missing/incorrect candidate behavior, not on harness startup.

- [ ] **Step 4: Complete harness support and LAT evidence**

Add only the harness helpers needed to inspect candidate rows/requests, seed agent-created provenance, snapshot Profile hashes, and invoke the new preload methods. Cleanup must remove only harness-owned temporary userData, Profiles, Runtime Seed copy, cloud process, Compose project, and test database volume.

Update LAT sections with exact source/test references for the read-only adapter, dual DLP contract, terminal review, draft import, and two-account E2E. Every new section gets a leading paragraph under 250 characters.

- [ ] **Step 5: Run boundary/E2E GREEN and commit**

Run:

```bash
npx vitest run tests/agentera-experience-candidate-boundary.test.ts tests/agentera-workspace-agent-boundary.test.ts tests/agentera-agent-data-boundary.test.ts tests/agentera-hermes-control-plane-compat.test.ts
npm run test:e2e:experience-candidate
npx --yes lat.md check
git diff --check
```

Expected: PASS with all private fixture hashes unchanged and no `/api/agents` request.

Commit:

```bash
git add tests/agentera-experience-candidate-boundary.test.ts tests/e2e/agentera-experience-candidate.e2e.ts tests/e2e/support/agentera-agent-control-harness.ts package.json lat.md/agentera-self-evolution.md lat.md/agentera-agent-control-plane.md
git commit -m "test: prove controlled experience promotion"
```

### Task 10: Run Full Local Release Gates and Record Heads

**Repositories:**

- `/Users/zizimutou/Desktop/aera/aera-cloud`
- `/Users/zizimutou/Desktop/aera/aera`
- read-only status check: `/Users/zizimutou/Desktop/aera/aera-runtime`

**Files:**

- Modify only files required to correct failures caused by Tasks 1-9.
- Do not absorb pre-existing unrelated failures or generated/local residue into feature commits.

**Produces:** Fresh full-suite evidence, clean feature branches, unchanged Runtime, and exact local commit heads without merge/push/deploy.

- [ ] **Step 1: Run complete cloud unit and integration gates**

Run from `aera-cloud`:

```bash
gofmt -w internal/agentcontrol/*.go
go test -count=1 ./...
set -a
source .env.example
set +a
AERA_INTEGRATION_TESTS=1 go test -p 1 -count=1 ./...
git diff --check
```

Expected: every Go package passes with cache disabled, including migration 11 and real PostgreSQL/Redis candidate flows.

- [ ] **Step 2: Run cloud Web regression**

Run from `aera-cloud/web`:

```bash
npm test
npm run build
npm run test:browser
```

Expected: existing unit, typecheck/build, and browser tests pass; no candidate data is added to the account-center Web application.

- [ ] **Step 3: Run complete desktop unit, contract, lint, and build gates**

Run from `aera`:

```bash
npm run check:agentera-cloud-contract
npm test
npm run lint
npm run build
npx --yes lat.md check
git diff --check
```

Expected: all desktop unit tests, lint, typecheck/build, contract checks, and LAT checks pass.

- [ ] **Step 4: Run all related deterministic E2E gates**

Run from `aera`:

```bash
npm run test:e2e:agent-control
npm run test:e2e:workspace
npm run test:e2e:workspace-agent
npm run test:e2e:experience-candidate
```

Expected: all four suites pass against isolated local resources; the new suite proves candidate privacy and same-Profile learning preservation.

- [ ] **Step 5: Audit repository state and remove only verified test residue**

Run read-only status first in all three repositories. Remove only temporary processes, containers, volumes, userData, or logs whose ownership was recorded by the E2E harness. Do not delete broad directories, user Profiles, shared Docker resources, or unrelated untracked files.

Verify:

```bash
git -C /Users/zizimutou/Desktop/aera/aera-cloud status --short --branch
git -C /Users/zizimutou/Desktop/aera/aera status --short --branch
git -C /Users/zizimutou/Desktop/aera/aera-runtime status --short --branch
git -C /Users/zizimutou/Desktop/aera/aera-runtime log -1 --oneline
```

Expected: both feature worktrees contain only intentional task changes or are clean after their commits; `aera-runtime/main` remains unchanged.

- [ ] **Step 6: Route any gate failure back to its owning task**

If Tasks 1-9 caused a full-suite failure, return to that task's focused RED/GREEN command and declared file list, then repeat its exact staging and commit procedure. Do not make a catch-all commit or stage a path outside the owning task. If no correction is required, do not create an empty commit.

- [ ] **Step 7: Report exact local completion evidence**

Report cloud and desktop branch names/HEADs, divergence from `origin/main`, clean/dirty state, test counts, E2E results, and unchanged Runtime HEAD. Explicitly state that nothing was merged, pushed, deployed, or published.
