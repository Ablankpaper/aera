# AgentEra USER Agent Control Plane V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Deliver the first real `owner_scope=USER` AgentEra Agent flow: local-only drafts, explicit immutable publication, per-device/Profile installation, and a conversation-stable RuntimeBinding that runs through the real Hermes engine without changing or intercepting Hermes self-learning.

**Architecture:** `aera-cloud` is the authenticated control plane for definitions, immutable versions, policy, installations, sanitized binding records, and audit. The desktop owns drafts, verified version caches, physical Profile paths, and complete RuntimeBindings. Hermes remains the only execution and adaptive-state engine; AgentEra supplies a signed read-only base and a fixed conversation envelope around the existing Hermes API transport.

**Tech Stack:** Go 1.26, chi, pgx/PostgreSQL, Redis, Ed25519, OpenAPI 3.1, Electron, TypeScript, React, `better-sqlite3`, Vitest, Playwright, and the existing Python Hermes Runtime.

## Global Constraints

- The approved design at `docs/superpowers/specs/2026-07-19-agentera-user-agent-control-plane-v1-design.md` is authoritative.
- V1 accepts only `tenant_id=personal_space_id`, `owner_scope=USER`, and `owner_id=user_id`, all derived from validated access claims.
- Drafts and draft assets remain under Electron `userData`; there is no cloud draft table or endpoint.
- Never upload or hash for upload `MEMORY.md`, `USER.md`, sessions, prompts, local files, credentials, environment values, Curator data, archives, or unpromoted learned Skills.
- Never clone a Profile during Agent installation. Fresh installation must call Profile creation with `cloneFrom=null`; an existing Profile is usable only through the explicit same-owner claim flow.
- `device_installation_id` is the existing product/device identity. `agent_installation_id` is a new per-Agent/per-device/per-Profile identity. They are never interchangeable.
- Published versions, policy snapshots, revocations, and runtime binding records are append-only or immutable. Definitions and installations may change only through explicit lifecycle operations.
- The AgentEra path must not silently fall back to a transport that omits the RuntimeBinding envelope. Existing uninstalled/local Profiles retain their current Hermes behavior.
- V1 installations bind only to physical local Runtime Profiles. Remote and SSH Hermes connections keep their existing behavior but return `local_runtime_required` when used for a new AgentEra installation or installed-Agent binding.
- No production deployment, cloud configuration, domain change, Runtime release, workspace feature, organization feature, official Agent feature, ExperienceCandidate flow, or private-state backup is authorized by this plan.
- Every task starts with a failing focused test, makes the smallest implementation needed, reruns that test, runs the stated regression gate, and creates one focused local commit. Do not push or merge unless a task explicitly reaches an authorization checkpoint and the user separately authorizes it.

## Repository and Branch Map

| Responsibility | Repository | Starting state | Feature branch after the prerequisite gate |
|---|---|---|---|
| Desktop product, local control plane, UI, Hermes adapter | `/Users/zizimutou/Desktop/aera/aera` | `main` plus approved documentation commits | `aera/user-agent-control-plane-v1` |
| Cloud authentication and Agent control plane | `/Users/zizimutou/Desktop/aera/aera-cloud` | `aera/app-auth-service` until explicitly merged | `aera/user-agent-control-plane-v1` |
| Hermes execution and self-learning compatibility evidence | `/Users/zizimutou/Desktop/aera/aera-runtime` | clean `main` | no feature branch and no production edit |

## Locked Cloud API Surface

The OpenAPI contract exposes exactly these new control-plane operations:

```text
GET  /api/v1/agent-definitions
POST /api/v1/agent-definitions
GET  /api/v1/agent-definitions/{definitionID}
GET  /api/v1/agent-definitions/{definitionID}/versions
POST /api/v1/agent-definitions/{definitionID}/versions
GET  /api/v1/agent-versions/{versionID}
POST /api/v1/agent-versions/{versionID}/revocations
GET  /api/v1/agent-installations
POST /api/v1/agent-installations
POST /api/v1/agent-installations/{installationID}/activate
POST /api/v1/agent-installations/{installationID}/select-version
POST /api/v1/agent-installations/{installationID}/archive
GET  /api/v1/policy-snapshots/{snapshotID}
POST /api/v1/runtime-binding-records
GET  /.well-known/agentera-signing-keys.json  (extended purposes only)
```

All POST operations require `Authorization: Bearer ...`; publication, installation creation, version selection, and archive also require `Idempotency-Key`. Activation additionally requires a device-key signature over the exact activation tuple. Request schemas reject unknown properties. No request accepts an owner tuple, physical Profile path, product token, provider credential, Memory field, USER field, prompt, session body, or arbitrary remote URL.

## Locked Manifest Shape

Both Go and TypeScript implement this logical V1 shape and serialize it as canonical JSON with sorted object keys and assets sorted by normalized path:

```ts
interface AgentManifestV1 {
  schema_version: 1;
  identity: {
    system_prompt: string;
  };
  assets: Array<{
    path: string;
    kind: "skill" | "sop" | "knowledge";
    media_type: "text/markdown" | "text/plain";
    sha256: string;
  }>;
  model_constraints: {
    allowed_providers: string[];
    allowed_models: string[];
  };
  tools: {
    allowed: string[];
    denied: string[];
  };
  dependencies: Array<{
    agent_definition_id: string;
    agent_version_id: string;
  }>;
  runtime_compatibility: {
    minimum_version: string;
    maximum_version_exclusive: string | null;
  };
}
```

The signed payload is domain separated:

```text
agentera-agent-version-v1\0<definition-id>\0<version-id>\0<version-number>\0<manifest-sha256>\0<bundle-sha256>
agentera-agent-policy-v1\0<policy-id>\0<policy-version>\0<policy-document-sha256>
```

## Task 1: Repair and Prove the Authentication Baseline

**Repository:** `/Users/zizimutou/Desktop/aera/aera-cloud`

**Files:**

- Modify: `internal/session/revocation_test.go`
- Verify: every file changed on `aera/app-auth-service` relative to `main`

**Steps:**

- [ ] Run the uncached focused tests before editing:

  ```bash
  go test -count=1 ./internal/session -run 'TestAccessAuthentication(FailsClosedWhenRedisIsUnavailable|RejectsCachedRevocationWithoutDatabaseRead)|TestPostgresRemainsAuthoritativeOverCachedActiveState'
  ```

  Expected: FAIL because the fixed 2026-07-18 claims are expired under the wall clock, producing `ErrInvalidAccessToken` before the intended cache/repository assertion.

- [ ] Add a controlled clock helper and pass it to every unit-test authenticator that uses `validAccessClaims()`:

  ```go
  func clockInsideAccessWindow(claims AccessClaims) func() time.Time {
      return func() time.Time { return claims.IssuedAt.Add(time.Minute) }
  }
  ```

  Every affected `AccessAuthenticatorConfig` must set:

  ```go
  Clock: clockInsideAccessWindow(claims),
  ```

  Do not change production expiry validation and do not replace the fixture with `time.Now()`.

- [ ] Rerun the focused command. Expected: PASS.

- [ ] Run the complete suite without cache:

  ```bash
  go test -count=1 ./...
  ```

  Expected: PASS with no package relying on a cached result.

- [ ] Review the complete authentication branch before any merge:

  ```bash
  git status --short --branch
  git diff --check
  git log --oneline --decorate main..aera/app-auth-service
  git diff --stat main...aera/app-auth-service
  ```

- [ ] Commit only the clock-controlled test repair:

  ```bash
  git add internal/session/revocation_test.go
  git commit -m "test: control access revocation clocks"
  ```

- [ ] Stop and present the branch diff, uncached test result, and clean worktree to the user. The current design approval is not authorization to merge. After separate approval, merge locally with `git switch main && git merge --ff-only aera/app-auth-service`; do not push. Then create `aera/user-agent-control-plane-v1` from that local `main`.

## Task 2: Add the Cloud Persistence Model and Database Invariants

**Repository:** `/Users/zizimutou/Desktop/aera/aera-cloud`

**Files:**

- Create: `migrations/000007_agent_control_plane.sql`
- Modify: `internal/store/migrate_test.go`
- Modify: `internal/account/lifecycle_repository.go`
- Modify: `internal/account/lifecycle_repository_test.go`

**Steps:**

- [ ] Extend `TestApplyMigrationsCreatesAuthSchemaAndIsIdempotent` first. Assert migration count `7`, the seven new tables, the uniqueness constraints, digest/signature lengths, lifecycle checks, and immutability triggers. Add an account-finalization test proving USER Agent rows are deleted while retained audit rows no longer carry owner metadata.

- [ ] Run:

  ```bash
  docker compose up -d postgres redis
  set -a
  source .env.example
  set +a
  AERA_INTEGRATION_TESTS=1 go test -p 1 -count=1 ./internal/store ./internal/account
  ```

  Expected: FAIL because migration 7 and lifecycle cleanup do not exist.

- [ ] Implement these tables in one forward-only migration:

  ```sql
  CREATE TABLE agent_definitions (
      id UUID PRIMARY KEY,
      tenant_id UUID NOT NULL REFERENCES personal_spaces(id) ON DELETE CASCADE,
      owner_scope TEXT NOT NULL CHECK (owner_scope = 'USER'),
      owner_id UUID NOT NULL REFERENCES users(id),
      display_name TEXT NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 100),
      icon_media_type TEXT CHECK (icon_media_type IN ('image/png', 'image/webp')),
      icon_data BYTEA,
      status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
      latest_version_id UUID,
      created_by UUID NOT NULL REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      CHECK ((icon_media_type IS NULL) = (icon_data IS NULL)),
      CHECK (icon_data IS NULL OR octet_length(icon_data) <= 524288)
  );

  CREATE TABLE agent_versions (
      id UUID PRIMARY KEY,
      definition_id UUID NOT NULL REFERENCES agent_definitions(id) ON DELETE CASCADE,
      tenant_id UUID NOT NULL REFERENCES personal_spaces(id) ON DELETE CASCADE,
      owner_scope TEXT NOT NULL CHECK (owner_scope = 'USER'),
      owner_id UUID NOT NULL REFERENCES users(id),
      version_number BIGINT NOT NULL CHECK (version_number > 0),
      canonical_manifest JSONB NOT NULL,
      bundle JSONB NOT NULL,
      content_digest BYTEA NOT NULL CHECK (octet_length(content_digest) = 32),
      signing_key_id TEXT NOT NULL,
      signature BYTEA NOT NULL CHECK (octet_length(signature) = 64),
      runtime_minimum_version TEXT NOT NULL,
      runtime_maximum_version_exclusive TEXT,
      published_by UUID NOT NULL REFERENCES users(id),
      published_at TIMESTAMPTZ NOT NULL,
      UNIQUE (definition_id, version_number)
  );
  ```

  Add `agent_version_revocations`, `installations`, `policy_snapshots`, `runtime_binding_records`, and `agent_control_idempotency_keys` with the exact fields from the approved design. `installations.status` is exactly `pending|active|archived`, `update_policy` is exactly `manual`, `runtime_profile_id` is nullable only before activation, and `device_installation_id` is copied from the authenticated `devices` row rather than supplied by the client.

- [ ] Add foreign keys after both sides exist, including `agent_definitions.latest_version_id`, and indexes for owner listing, definition/version ordering, active installations, revocation lookup, and binding lookup.

- [ ] Add database triggers that reject UPDATE/DELETE on `agent_versions`, UPDATE/DELETE on `policy_snapshots`, UPDATE/DELETE on `agent_version_revocations`, and UPDATE/DELETE on `runtime_binding_records`. A DELETE caused by final account erasure is allowed only while the row's owner is already `pending_deletion`; the application API still exposes no delete operation for immutable rows.

- [ ] Update `FinalizeDeletion` to remove Agent control-plane rows before deleting `personal_spaces`/`devices`, and replace Agent control-plane audit metadata with `{}` when `metadata->>'owner_id'` matches the deleted user. Do not retain a personal-space ID or content digest that can relink the deleted account.

- [ ] Rerun the focused tests. Expected: PASS.

- [ ] Run `go test -count=1 ./...` and `git diff --check`. Expected: PASS.

- [ ] Commit:

  ```bash
  git add migrations/000007_agent_control_plane.sql internal/store/migrate_test.go internal/account/lifecycle_repository.go internal/account/lifecycle_repository_test.go
  git commit -m "feat: add USER Agent control plane schema"
  ```

## Task 3: Implement Canonical Manifests, Limits, and Agent-Control Signing

**Repository:** `/Users/zizimutou/Desktop/aera/aera-cloud`

**Files:**

- Create: `internal/agentcontrol/model.go`
- Create: `internal/agentcontrol/manifest.go`
- Create: `internal/agentcontrol/manifest_test.go`
- Create: `internal/agentcontrol/signing.go`
- Create: `internal/agentcontrol/signing_test.go`
- Modify: `internal/config/config.go`
- Modify: `internal/config/config_test.go`
- Modify: `.env.example`
- Modify: `internal/oauth/http.go`
- Modify: `internal/oauth/http_test.go`
- Modify: `cmd/aera-cloud/main.go`
- Modify: `cmd/aera-cloud/main_test.go`

**Steps:**

- [ ] Write table-driven manifest tests covering canonical ordering, duplicate normalized paths, `..`, absolute paths, backslashes, NUL, symlink-shaped metadata, remote URLs, executable dependencies, unknown JSON fields, invalid UTF-8, 129 assets, a 256 KiB+1 asset, 2 MiB+1 total assets, and a 256 KiB+1 manifest. Add PNG/WebP dimension and animation rejection tests.

- [ ] Write signing tests that prove an altered definition ID, version ID, version number, manifest, bundle, policy ID, unknown key ID, wrong purpose, or wrong issuer fails verification.

- [ ] Run:

  ```bash
  go test -count=1 ./internal/agentcontrol ./internal/config ./internal/oauth ./cmd/aera-cloud
  ```

  Expected: FAIL because the package and agent-control key ring do not exist.

- [ ] Implement strict domain types. Keep request decoding separate from canonical types so unknown input fields cannot survive into a signed value. The core limits are constants, not handler literals:

  ```go
  const (
      MaxAssetCount       = 128
      MaxAssetBytes       = 256 * 1024
      MaxBundleBytes      = 2 * 1024 * 1024
      MaxManifestBytes    = 256 * 1024
      MaxIconBytes        = 512 * 1024
      MaxIconDimension    = 1024
  )
  ```

- [ ] Canonicalize through typed structs, sort every set-like string slice, sort dependencies by `(agent_definition_id, agent_version_id)`, sort assets by normalized path, reject duplicate keys at the HTTP decoder, and hash the exact canonical UTF-8 bytes. Never canonicalize arbitrary `map[string]any` input.

- [ ] Validate Runtime compatibility as semantic versions by normalizing `0.18.2-agentera.1` to `v0.18.2-agentera.1` for comparison. Reject invalid or empty ranges and require `maximum_version_exclusive > minimum_version` when the maximum exists.

- [ ] Add a key ring that is independent from access, offline-entitlement, verification, and Runtime-release keys:

  ```go
  AgentControlSigningKeyRing KeyRing
  ```

  with environment names:

  ```text
  AGENTERA_CLOUD_AGENT_CONTROL_SIGNING_ACTIVE_KEY_ID
  AGENTERA_CLOUD_AGENT_CONTROL_SIGNING_KEYS
  ```

  Include the active private key in `requireIndependentKeys` and document development-only example material in `.env.example`.

- [ ] Extend the existing well-known key document with public entries whose purposes are exactly `agent_version` and `agent_policy`. Keep access and offline purposes unchanged. Use one agent-control ring with purpose-specific signature domain separation.

- [ ] Rerun focused tests and then `go test -count=1 ./...`. Expected: PASS.

- [ ] Commit:

  ```bash
  git add internal/agentcontrol internal/config/config.go internal/config/config_test.go .env.example internal/oauth/http.go internal/oauth/http_test.go cmd/aera-cloud/main.go cmd/aera-cloud/main_test.go
  git commit -m "feat: validate and sign Agent versions"
  ```

## Task 4: Extend Structured Audit and Build the Transactional Repository

**Repository:** `/Users/zizimutou/Desktop/aera/aera-cloud`

**Files:**

- Modify: `internal/audit/service.go`
- Modify: `internal/audit/service_test.go`
- Create: `internal/agentcontrol/repository.go`
- Create: `internal/agentcontrol/repository_test.go`

**Steps:**

- [ ] Add failing audit tests for bounded metadata and a failing repository integration test for first publication, next-version serialization, idempotency replay, stale idempotency payload rejection, cross-owner lookup, pending installation, activation, selection, archive, policy persistence, binding insertion, and append-only revocation.

- [ ] Run:

  ```bash
  docker compose up -d postgres redis
  set -a
  source .env.example
  set +a
  AERA_INTEGRATION_TESTS=1 go test -p 1 -count=1 ./internal/audit ./internal/agentcontrol
  ```

  Expected: FAIL because metadata is always `{}` and the repository is absent.

- [ ] Extend `audit.Event` with `Metadata map[string]string`. Permit at most 12 entries, keys matching `^[a-z][a-z0-9_]{0,63}$`, values of at most 128 UTF-8 bytes, and only the allowlist below for Agent events:

  ```go
  var agentMetadataKeys = map[string]struct{}{
      "tenant_id": {}, "owner_scope": {}, "owner_id": {},
      "agent_definition_id": {}, "agent_version_id": {},
      "agent_installation_id": {}, "policy_snapshot_id": {},
      "content_digest": {},
  }
  ```

  Reject email-like values, bearer/JWT shapes, line breaks, paths, and raw request bodies. Marshal metadata deterministically.

- [ ] Make the recorder usable inside an existing pgx transaction without breaking current callers:

  ```go
  type Executor interface {
      Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
  }

  func NewRecorder(executor Executor) (*PostgresRecorder, error)
  ```

  `NewPostgresRecorder(pool)` remains as a compatibility wrapper.

- [ ] Implement repository transaction methods that take a claim-derived `Principal` and generated IDs. The idempotency row is inserted in the same transaction as the business rows and audit event. Store only SHA-256 hashes of idempotency keys and canonical requests.

- [ ] Lock a definition row `FOR UPDATE` before assigning the next `version_number`. Initial publication atomically inserts definition, version 1, latest-version pointer, idempotency evidence, and success audit. A subsequent publication atomically verifies the submitted base version and appends exactly one new version.

- [ ] Query every object with the complete owner predicate:

  ```sql
  WHERE tenant_id = $1 AND owner_scope = 'USER' AND owner_id = $2
  ```

  Never fetch by object ID and authorize afterward.

- [ ] Rerun focused tests and `go test -count=1 ./...`. Expected: PASS.

- [ ] Commit:

  ```bash
  git add internal/audit/service.go internal/audit/service_test.go internal/agentcontrol/repository.go internal/agentcontrol/repository_test.go
  git commit -m "feat: persist audited Agent control operations"
  ```

## Task 5: Implement USER Publication and Discovery Services

**Repository:** `/Users/zizimutou/Desktop/aera/aera-cloud`

**Files:**

- Create: `internal/agentcontrol/service.go`
- Create: `internal/agentcontrol/service_test.go`

**Steps:**

- [ ] Write service tests first for initial publication, later publication, transaction rollback, stale base, identical idempotency replay, reused key with a different request, cross-user non-disclosure, archived definition rejection, icon validation, immutable returned DTOs, and revocation.

- [ ] Run:

  ```bash
  go test -count=1 ./internal/agentcontrol -run 'TestService(Publish|List|Get|Revoke)'
  ```

  Expected: FAIL because the service is absent.

- [ ] Implement a principal that can only be constructed from authenticated claims:

  ```go
  type Principal struct {
      UserID          uuid.UUID
      DeviceID        uuid.UUID
      PersonalSpaceID uuid.UUID
  }

  func (p Principal) Owner() Owner {
      return Owner{TenantID: p.PersonalSpaceID, Scope: OwnerScopeUser, OwnerID: p.UserID}
  }
  ```

- [ ] Make `PublishInitial` and `PublishNext` validate/canonicalize first, sign only after authorization succeeds, and pass canonical bytes to the repository. The client never submits a digest or signature as authority; returned values are server-generated.

- [ ] Return one stable conflict code per case: `version_conflict`, `idempotency_conflict`, `definition_archived`, `version_revoked`, `invalid_agent_content`, and `runtime_incompatible`. Cross-owner reads and writes return `not_found` and append a bounded denied audit event without exposing the other owner.

- [ ] Implement list/get responses with no physical path, no owner ID fields, no audit internals, and no unpublished object. Version retrieval includes the signed immutable bundle required for desktop verification.

- [ ] Implement revocation as an append-only record. A repeat of the same idempotent revocation returns the existing record; a different reason for an already revoked version returns `version_revoked`.

- [ ] Rerun focused tests and `go test -count=1 ./...`. Expected: PASS.

- [ ] Commit:

  ```bash
  git add internal/agentcontrol/service.go internal/agentcontrol/service_test.go
  git commit -m "feat: publish immutable USER Agent versions"
  ```

## Task 6: Implement Policy, Installation, Activation, Version Selection, and Binding Metadata

**Repository:** `/Users/zizimutou/Desktop/aera/aera-cloud`

**Files:**

- Modify: `internal/agentcontrol/model.go`
- Modify: `internal/agentcontrol/repository.go`
- Modify: `internal/agentcontrol/repository_test.go`
- Modify: `internal/agentcontrol/service.go`
- Modify: `internal/agentcontrol/service_test.go`
- Create: `internal/agentcontrol/device_proof.go`
- Create: `internal/agentcontrol/device_proof_test.go`

**Steps:**

- [ ] Add failing tests for server-derived device installation ID, pending creation, same-idempotency replay, activation signature, wrong device key, wrong version digest, wrong Runtime Profile ID, expired proof timestamp, activation replay, manual version selection, last-version preservation on failure, archive non-deletion semantics, policy signature, sanitized binding records, and forbidden binding fields.

- [ ] Run:

  ```bash
  go test -count=1 ./internal/agentcontrol -run 'Test(Service|DeviceProof).*(Installation|Policy|Binding|Activation|Selection)'
  ```

  Expected: FAIL.

- [ ] On installation creation, load the authenticated device row and copy its `installation_id` into `device_installation_id`. Create a signed policy snapshot from the selected version's model/tool/runtime constraints. Return one new `agent_installation_id` and leave `runtime_profile_id` null/status pending.

- [ ] Define the activation proof bytes exactly:

  ```text
  agentera-agent-installation-activate-v1\0<agent-installation-id>\0<runtime-profile-id>\0<version-digest-hex>\0<unix-seconds>
  ```

  Require Ed25519 verification against the public key of `Principal.DeviceID`, a timestamp within five minutes, and an exact digest match. Activation is idempotent only when every activated value matches; it never accepts `device_installation_id` from the request.

- [ ] Implement manual version selection as cache-first on the desktop and commit-last in cloud: the service verifies the new version and signs a new policy snapshot, then atomically updates `installations.selected_version_id` and `policy_snapshot_id`. If the cloud operation fails, the installation remains on its previous version.

- [ ] Archive by changing only the installation lifecycle and audit evidence. Do not delete a Runtime Profile, binding record, version cache, or version.

- [ ] Accept runtime binding records only through a typed command containing:

  ```go
  type RuntimeBindingRecordCommand struct {
      BindingID             uuid.UUID
      AgentInstallationID   uuid.UUID
      AgentVersionID        uuid.UUID
      RuntimeProfileID      uuid.UUID
      RuntimeVersion        string
      PolicySnapshotID      uuid.UUID
      ToolPermissionDigest  [32]byte
  }
  ```

  Unknown JSON fields make `adaptive_state`, `memory`, `user`, `prompt`, `conversation`, `profile_path`, `file_path`, `credential`, and `environment` impossible to submit.

- [ ] Rerun focused tests and `go test -count=1 ./...`. Expected: PASS.

- [ ] Commit:

  ```bash
  git add internal/agentcontrol
  git commit -m "feat: manage Agent installations and bindings"
  ```

## Task 7: Expose the Strict HTTP and OpenAPI Contract

**Repository:** `/Users/zizimutou/Desktop/aera/aera-cloud`

**Files:**

- Create: `internal/agentcontrol/http.go`
- Create: `internal/agentcontrol/http_test.go`
- Modify: `internal/httpapi/server.go`
- Modify: `internal/httpapi/server_test.go`
- Modify: `cmd/aera-cloud/main.go`
- Modify: `cmd/aera-cloud/main_test.go`
- Modify: `api/openapi.yaml`

**Steps:**

- [ ] Write handler tests for every locked route, method, status, error envelope, body limit, duplicate key, unknown property, malformed bearer, revoked session, cross-owner non-disclosure, missing idempotency key, and activation proof. Add a router test proving the Agent handler cannot receive browser-session authorization.

- [ ] Run:

  ```bash
  go test -count=1 ./internal/agentcontrol ./internal/httpapi ./cmd/aera-cloud
  ```

  Expected: FAIL because the routes and dependency are absent.

- [ ] Add `AgentControl http.Handler` to `httpapi.Dependencies` and mount only `/api/v1/agent-*`, `/api/v1/policy-snapshots/*`, and `/api/v1/runtime-binding-records` to it. Keep existing auth/device/browser routes unchanged.

- [ ] Use a `2.5 MiB` request ceiling for version publication and `64 KiB` for metadata-only mutations. Decode through `json.Decoder.DisallowUnknownFields()`, reject a second JSON value, require `Content-Type: application/json`, and send `Cache-Control: no-store` on authenticated responses.

- [ ] Authenticate once per request through `session.AccessAuthenticator`. Build `agentcontrol.Principal` only from `AccessClaims`; never parse owner identity from JSON or query parameters.

- [ ] Wire the repository, service, audit transaction factory, access authenticator, agent-control signing ring, and clock in `cmd/aera-cloud/main.go` through a `buildAgentControlHandler` function.

- [ ] Update OpenAPI `info.version` to `0.2.0`. Define strict schemas with `additionalProperties: false`, bearer security, required `Idempotency-Key`, response size expectations, the two new key purposes, and every stable error code. Do not add `AgentDraft` or any private runtime field.

- [ ] Rerun focused tests, then:

  ```bash
  gofmt -w internal/agentcontrol/*.go internal/audit/service.go internal/audit/service_test.go internal/config/config.go internal/config/config_test.go internal/httpapi/server.go internal/httpapi/server_test.go cmd/aera-cloud/main.go cmd/aera-cloud/main_test.go
  go test -count=1 ./...
  git diff --check
  ```

  Expected: PASS.

- [ ] Commit:

  ```bash
  git add internal/agentcontrol internal/httpapi cmd/aera-cloud api/openapi.yaml
  git commit -m "feat: expose USER Agent control API"
  ```

## Task 8: Pin the Cloud Contract and Build a Separate Desktop Client and Trust Store

**Repository:** `/Users/zizimutou/Desktop/aera/aera`

**Files:**

- Modify: `contracts/agentera-cloud.openapi.yaml`
- Modify: `src/shared/agentera-cloud-api.generated.ts`
- Modify: `tests/agentera-cloud-contract.test.ts`
- Modify: `src/main/agentera-auth/controller.ts`
- Create: `src/main/agentera-agent-control/client.ts`
- Create: `src/main/agentera-agent-control/client.test.ts`
- Create: `src/main/agentera-agent-control/trust.ts`
- Create: `src/main/agentera-agent-control/trust.test.ts`

**Steps:**

- [ ] Copy the reviewed cloud OpenAPI file byte-for-byte into `contracts/agentera-cloud.openapi.yaml`, run the generator, and first extend the contract test to require generated Agent schemas and to reject any generated `AgentDraft` schema.

- [ ] Run:

  ```bash
  npm test -- tests/agentera-cloud-contract.test.ts
  ```

  Expected: FAIL until the pinned contract and generated output are current.

- [ ] Add focused client tests for bearer use, one request timeout, response-size bounds, strict response keys, safe error codes, idempotency headers, activation proof, no Hermes One token use, and no response-body echo in errors. Add trust tests for issuer/purpose/key ID/digest/signature/runtime compatibility and offline cached verification.

- [ ] Add the main-process-only method to the `AgenteraAuthController` interface that the implementation already provides:

  ```ts
  getAccessTokenForCloudRequest(): string | null;
  ```

  Do not expose it through preload or renderer types.

- [ ] Implement `AgenteraAgentControlClient` as a separate module. It receives a token callback and `InstallationIdentity` callback; it must not import `src/main/agent-sync.ts`, Hermes One account storage, or legacy `/api/agents` DTOs.

- [ ] Sign activation using the existing device private key and the exact cloud domain string. The client sends `runtime_profile_id`, `version_digest`, `timestamp`, and `device_proof`; it never sends the physical Profile path or private key.

- [ ] Implement an issuer-scoped trust store keyed by `(origin, purpose, key_id)`. Cache only public keys and fetch time. Require `agent_version` for versions and `agent_policy` for policy snapshots. Unknown or cross-purpose keys fail closed even if the raw Ed25519 public bytes match.

- [ ] Run:

  ```bash
  npm run generate:agentera-cloud
  npm run check:agentera-cloud-contract
  npm test -- tests/agentera-cloud-contract.test.ts src/main/agentera-agent-control/client.test.ts src/main/agentera-agent-control/trust.test.ts
  npm run typecheck:node
  ```

  Expected: PASS.

- [ ] Commit:

  ```bash
  git add contracts/agentera-cloud.openapi.yaml src/shared/agentera-cloud-api.generated.ts tests/agentera-cloud-contract.test.ts src/main/agentera-auth/controller.ts src/main/agentera-agent-control
  git commit -m "feat: add trusted Agent control client"
  ```

## Task 9: Create the Desktop-Local Database, Draft Store, and Asset Validator

**Repository:** `/Users/zizimutou/Desktop/aera/aera`

**Files:**

- Create: `src/shared/agentera-agent-control.ts`
- Create: `src/main/agentera-agent-control/db.ts`
- Create: `src/main/agentera-agent-control/draft-store.ts`
- Create: `src/main/agentera-agent-control/manifest.ts`
- Create: `tests/agentera-agent-control-db.test.ts`
- Create: `tests/agentera-agent-drafts.test.ts`
- Create: `tests/agentera-agent-manifest.test.ts`

**Steps:**

- [ ] Write tests first proving the database path is exactly `<userData>/agentera-control-plane/control-plane.db`, no database opens under `HERMES_HOME`, schema migration is idempotent, drafts survive restart, revision increments are monotonic, stale edits conflict, and failed writes do not corrupt the last draft.

- [ ] Add validator tests matching every cloud canonicalization and limit case, plus absolute Windows paths, UNC paths, Unicode-normalized duplicate paths, symlinks, device files, `.env`, `auth.json`, `MEMORY.md`, `USER.md`, sessions, Curator paths, high-confidence secret key names, PNG/WebP limits, and animation rejection.

- [ ] Run:

  ```bash
  npm test -- tests/agentera-agent-control-db.test.ts tests/agentera-agent-drafts.test.ts tests/agentera-agent-manifest.test.ts
  ```

  Expected: FAIL because the modules do not exist.

- [ ] Create the app-level SQLite schema with `PRAGMA journal_mode=WAL`, `PRAGMA foreign_keys=ON`, and an explicit `user_version`. Include `agent_drafts`, `draft_assets`, `cached_agent_versions`, `local_agent_installations`, `runtime_bindings`, `signing_key_cache`, and `pending_sanitized_records`. Do not import or reuse `src/main/db.ts`.

- [ ] Store draft assets only below:

  ```text
  <userData>/agentera-control-plane/drafts/<draft-id>/
  ```

  Store normalized relative paths in SQLite. On read, use `lstat`, reject symlinks, resolve the parent and child, and require containment before opening bytes.

- [ ] Define renderer-safe DTOs with no owner IDs, device IDs, physical paths, signatures, public keys, tokens, raw error bodies, or Profile content. Keep the editable manifest allowlisted and typed.

- [ ] Implement compare-and-swap updates:

  ```sql
  UPDATE agent_drafts
  SET display_name = ?, manifest_json = ?, revision = revision + 1, updated_at = ?
  WHERE id = ? AND revision = ?;
  ```

  A zero row count returns `draft_conflict` and does not merge last-writer-wins.

- [ ] Record publication attempt time, one UUID idempotency key, and a bounded error code/summary. Never record access tokens or response bodies.

- [ ] Rerun focused tests and `npm run typecheck:node`. Expected: PASS.

- [ ] Commit:

  ```bash
  git add src/shared/agentera-agent-control.ts src/main/agentera-agent-control/db.ts src/main/agentera-agent-control/draft-store.ts src/main/agentera-agent-control/manifest.ts tests/agentera-agent-control-db.test.ts tests/agentera-agent-drafts.test.ts tests/agentera-agent-manifest.test.ts
  git commit -m "feat: add local Agent drafts and validation"
  ```

## Task 10: Implement Explicit Publication and the Verified Immutable Version Cache

**Repository:** `/Users/zizimutou/Desktop/aera/aera`

**Files:**

- Create: `src/main/agentera-agent-control/publisher.ts`
- Create: `src/main/agentera-agent-control/publisher.test.ts`
- Create: `src/main/agentera-agent-control/version-cache.ts`
- Create: `src/main/agentera-agent-control/version-cache.test.ts`
- Create: `tests/agentera-agent-data-boundary.test.ts`

**Steps:**

- [ ] Write publication tests for preview-without-network, explicit confirmation, one-use confirmation handle, restart reconciliation by stored idempotency key, digest mismatch, network failure, authorization failure, stale base, and retry. Snapshot the draft directory and Hermes boundary fixture before/after every failure.

- [ ] Write cache tests for signature/digest/runtime-policy verification, staging, atomic rename, read-only application guard, re-verification before use, corrupted cache rejection, and last-good-version preservation.

- [ ] Run:

  ```bash
  npm test -- src/main/agentera-agent-control/publisher.test.ts src/main/agentera-agent-control/version-cache.test.ts tests/agentera-agent-data-boundary.test.ts
  ```

  Expected: FAIL.

- [ ] Implement a two-call publication API in the main process:

  ```ts
  interface PublicationPreview {
    publicationHandle: string;
    draftId: string;
    revision: number;
    targetScope: "USER";
    assetCounts: Record<"skill" | "sop" | "knowledge", number>;
    totalBytes: number;
  }

  preparePublication(draftId: string): PublicationPreview;
  confirmPublication(publicationHandle: string): Promise<PublishedRevision>;
  ```

  `preparePublication` performs no network write. `confirmPublication` consumes an in-memory handle tied to the exact revision and uses the persisted attempt idempotency key. A changed draft requires a new preview.

- [ ] On success, recompute the digest from the server-returned canonical manifest/bundle, verify the signature, and only then mark the local revision published. Publication never creates an installation.

- [ ] Stage version data under:

  ```text
  <userData>/agentera-control-plane/versions/<version-id>/<content-digest>/
  ```

  Write to a sibling `.staging-<uuid>` directory, fsync files and parent where supported, re-read/re-hash, rename atomically, and record verification in SQLite. File permissions are defense in depth; every later binding rechecks the digest.

- [ ] Ensure data-boundary tests inspect imports and mocked calls so the publisher cannot enumerate a Profile, call `agent-sync.ts`, read `MEMORY.md`/`USER.md`, or write any `HERMES_HOME` byte.

- [ ] Rerun focused tests and `npm run typecheck:node`. Expected: PASS.

- [ ] Commit:

  ```bash
  git add src/main/agentera-agent-control/publisher.ts src/main/agentera-agent-control/publisher.test.ts src/main/agentera-agent-control/version-cache.ts src/main/agentera-agent-control/version-cache.test.ts tests/agentera-agent-data-boundary.test.ts
  git commit -m "feat: publish and cache immutable Agent versions"
  ```

## Task 11: Migrate Profile Binding Identity and Materialize Agent Installations

**Repository:** `/Users/zizimutou/Desktop/aera/aera`

**Files:**

- Modify: `src/main/agentera-profile-binding.ts`
- Modify: `tests/agentera-profile-binding.test.ts`
- Modify: `src/main/app/start.ts`
- Create: `src/main/agentera-agent-control/hermes-projection.ts`
- Create: `src/main/agentera-agent-control/hermes-projection.test.ts`
- Create: `src/main/agentera-agent-control/installation-manager.ts`
- Create: `src/main/agentera-agent-control/installation-manager.test.ts`

**Steps:**

- [ ] Extend Profile binding tests first with a real encrypted V1 fixture and assert lossless migration to V2. Assert `installationId` becomes `deviceInstallationId`, `agentInstallationId` starts null, physical path remains encrypted, Profile bytes remain identical, and a Profile can attach to at most one Agent Installation.

- [ ] Add installation tests for pending-before-materialization, fresh `cloneFrom=null`, explicit existing claim, failed download, failed activation, retry, manual version selection, archive, and never-delete behavior.

- [ ] Run:

  ```bash
  npm test -- tests/agentera-profile-binding.test.ts src/main/agentera-agent-control/hermes-projection.test.ts src/main/agentera-agent-control/installation-manager.test.ts
  ```

  Expected: FAIL.

- [ ] Evolve the binding types exactly:

  ```ts
  interface AgenteraRuntimeOwner {
    tenantId: string;
    ownerId: string;
    deviceInstallationId: string;
  }

  interface RuntimeOwnerBinding {
    tenantId: string;
    ownerScope: "USER";
    ownerId: string;
    deviceInstallationId: string;
    agentInstallationId: string | null;
    runtimeProfileId: string;
    boundAt: string;
  }
  ```

  Read V1 and V2 envelopes; write only V2 after successful decryption/validation. Never rewrite any file inside the Profile.

- [ ] Add `attachAgentInstallation(profilePath, owner, agentInstallationId)`. It is idempotent for the same value and rejects replacement, cross-owner attachment, or a missing base owner binding.

- [ ] Build a deterministic Hermes projection below userData, not inside `HERMES_HOME`:

  ```text
  agentera-control-plane/projections/<agent-installation-id>/
    versions/<version-id>/<digest>/skills/<version-scoped-name>/SKILL.md
    versions/<version-id>/<digest>/assets/...
  ```

  Version-scope derived Skill names as `agentera.<definition-prefix>.v<version-number>.<slug>`. Record the original name and signed source digest in generated frontmatter. Derived files are read-only and reproducible from the verified cache.

- [ ] Add the stable projection root once to the claimed Profile's `skills.external_dirs`. Implement a formatting-preserving YAML sequence patch that changes only this allowlisted field, keeps all credential/model/Memory/USER/local Skill bytes untouched, rejects YAML aliases/tags for this field, and is idempotent. Hermes already treats external directories as externally owned for autonomous lifecycle maintenance; application permissions and digest checks keep the projection read-only.

- [ ] Resolve local Skill collisions before projection activation. If a Profile-local Skill has the same original name, record `origin=local_override` in diagnostics and do not select the published wrapper for that binding. Never delete, rename, or overwrite the local Skill.

- [ ] Implement installation order exactly: create cloud pending record; fetch/verify/cache version and policy; build projection; create fresh Profile or complete explicit claim; attach Agent Installation; activate cloud using opaque Runtime Profile ID/device proof; record local active state. An activation failure leaves a retryable local/pending relationship and preserves the Profile.

- [ ] For manual update, fully verify/cache/project the new version first, then call cloud `select-version`, then update the local selected version. Keep the prior cache and bindings. Archive only local/control-plane metadata.

- [ ] Rerun focused tests and `npm run typecheck:node`. Expected: PASS.

- [ ] Commit:

  ```bash
  git add src/main/agentera-profile-binding.ts tests/agentera-profile-binding.test.ts src/main/app/start.ts src/main/agentera-agent-control/hermes-projection.ts src/main/agentera-agent-control/hermes-projection.test.ts src/main/agentera-agent-control/installation-manager.ts src/main/agentera-agent-control/installation-manager.test.ts
  git commit -m "feat: materialize Agent installations into Profiles"
  ```

## Task 12: Freeze RuntimeBindings and Connect Them to the Real Hermes Transport

**Repository:** `/Users/zizimutou/Desktop/aera/aera`

**Files:**

- Create: `src/main/agentera-agent-control/runtime-binding-store.ts`
- Create: `src/main/agentera-agent-control/runtime-binding-store.test.ts`
- Create: `src/main/agentera-agent-control/hermes-adapter.ts`
- Create: `src/main/agentera-agent-control/hermes-adapter.test.ts`
- Create: `src/main/agentera-agent-control/manager.ts`
- Modify: `src/main/hermes.ts`
- Modify: `src/main/hermes.test.ts`
- Modify: `src/main/ipc/register.ts`
- Create: `tests/agentera-runtime-binding.test.ts`
- Create: `tests/agentera-hermes-control-plane-compat.test.ts`

**Steps:**

- [ ] Write binding-store tests first for new conversation creation, `runId` idempotency, Hermes session attachment, resume lookup, immutable fields, opaque adaptive marker, offline creation, pending sanitized-record retry, and rejection of a resumed session without its original installed-Agent binding.

- [ ] Write Hermes adapter tests proving one binding composes one base instruction, selects one Profile, uses one Runtime distribution version, retains one version/policy/tool digest across turns, preserves the original session ID, rechecks cached bytes, and fails closed on Runtime/tool-policy drift or revocation.

- [ ] Run:

  ```bash
  npm test -- src/main/agentera-agent-control/runtime-binding-store.test.ts src/main/agentera-agent-control/hermes-adapter.test.ts tests/agentera-runtime-binding.test.ts tests/agentera-hermes-control-plane-compat.test.ts src/main/hermes.test.ts
  ```

  Expected: FAIL.

- [ ] Store the complete local binding with these immutable fields:

  ```ts
  interface LocalRuntimeBinding {
    id: string;
    conversationKey: string;
    hermesSessionId: string | null;
    tenantId: string;
    ownerScope: "USER";
    ownerId: string;
    deviceId: string;
    agentDefinitionId: string;
    agentVersionId: string;
    agentInstallationId: string;
    runtimeProfileId: string;
    runtimeVersion: string;
    policySnapshotId: string;
    toolPermissionDigest: string;
    publishedBaseDigest: string;
    localAdaptiveStateRevision: string;
    createdAt: string;
  }
  ```

  `localAdaptiveStateRevision` is a random UUID generated at binding creation. It is never a Memory/USER/Skill hash and is excluded from the cloud record.

- [ ] Compose AgentEra instructions from signed published identity, selected version-scoped Skills/assets, version identity, policy constraints, and the explicit rule that Profile-local SOUL/Skills win conflicts. Do not read or embed Memory, USER, sessions, credentials, or local Skill content. The instruction may name local read-only projection paths because it never leaves the machine.

- [ ] Add a generic optional conversation envelope to `sendMessage`, not an AgentEra dependency inside Hermes internals:

  ```ts
  interface HermesConversationEnvelope {
    instructions: string;
    requireBoundApiTransport: boolean;
  }
  ```

  When `requireBoundApiTransport` is true, use the existing `/v1/runs` path and its `/v1/chat/completions` fallback only when both carry the same instructions/session ID. Never fall through to TUI JSON-RPC or CLI paths that omit the envelope. Unbound Profiles keep the current transport selection unchanged.

- [ ] Combine context-folder instructions and AgentEra instructions in a deterministic order. Continue to send `X-Hermes-Session-Id`. Hermes already persists the rendered system prompt per session and restores it on later turns, so later draft/version/local-learning changes do not rebuild the installed base for that conversation.

- [ ] Before each installed-Agent turn, verify: entitlement permits start; Profile binding matches; version/policy signatures and cached digest still pass; Runtime version matches; current allowed tool declaration digest matches; version is not in the cached emergency deny set. On mismatch, fail before invoking Hermes and leave Profile state untouched.

- [ ] Reject AgentEra installation/binding in `remote` or `ssh` connection modes with `local_runtime_required`. This check is limited to the new control-plane path; it must not change existing remote/SSH chat or legacy Profile behavior.

- [ ] In `ipc/register.ts`, resolve the RuntimeBinding before `sendMessage`. Use `runId` as the pre-Hermes conversation key, attach the real Hermes session ID in `onSessionStarted`, and reuse the same binding on resume. For Profiles without `agentInstallationId`, pass no envelope and preserve current behavior.

- [ ] Queue only the sanitized cloud record after local binding creation. The queued JSON must match `RuntimeBindingRecordCommand` and exclude owner IDs from renderer-facing state, adaptive markers, prompt digests, paths, and private content. Cloud failure must not fail an already completed Hermes turn.

- [ ] Rerun the focused tests, `npm run typecheck`, and the existing Hermes regression suites affected by `sendMessage`. Expected: PASS.

- [ ] Verify Runtime compatibility without changing the Runtime repository:

  ```bash
  cd /Users/zizimutou/Desktop/aera/aera-runtime
  uv run pytest -q tests/agent/test_system_prompt_restore.py tests/agent/test_skill_utils.py tests/tools/test_skill_manager_tool.py
  git status --short --branch
  ```

  Expected: PASS and a clean Runtime worktree.

- [ ] Commit in the desktop repository:

  ```bash
  git add src/main/agentera-agent-control src/main/hermes.ts src/main/hermes.test.ts src/main/ipc/register.ts tests/agentera-runtime-binding.test.ts tests/agentera-hermes-control-plane-compat.test.ts
  git commit -m "feat: bind installed Agents to Hermes conversations"
  ```

## Task 13: Add the Reviewed IPC and Preload Boundary

**Repository:** `/Users/zizimutou/Desktop/aera/aera`

**Files:**

- Modify: `src/main/app/start.ts`
- Modify: `src/main/ipc/register.ts`
- Modify: `src/main/ipc/auth-guard.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/preload/index.d.ts`
- Modify: `tests/preload-api-surface.test.ts`
- Create: `tests/agentera-agent-control-ipc.test.ts`

**Steps:**

- [ ] Extend preload-surface tests first to require one separate `agenteraAgents` namespace with exactly these methods:

  ```text
  getState
  listDrafts
  getDraft
  createDraft
  updateDraft
  deleteDraft
  preparePublication
  confirmPublication
  listDefinitions
  listVersions
  listInstallations
  installVersion
  claimVersion
  retryPendingInstallation
  selectInstallationVersion
  archiveInstallation
  onStateChanged
  ```

  Assert its declaration contains none of: `accessToken`, `refreshToken`, `offlineEntitlement`, `privateKey`, `publicKey`, `signature`, `ownerId`, `tenantId`, `deviceId`, `profilePath`, `filePath`, `remoteUrl`, `environment`, or raw response text.

- [ ] Write IPC tests for input limits, UUID/revision validation, authentication/offline guard classification, one-use publication handle, Profile claim confirmation, safe error mapping, event cleanup, and renderer destruction.

- [ ] Run:

  ```bash
  npm test -- tests/preload-api-surface.test.ts tests/agentera-agent-control-ipc.test.ts
  ```

  Expected: FAIL.

- [ ] Construct one `AgenteraAgentControlManager` in `app/start.ts` from the app-level DB, auth controller/store, Profile binding store, Runtime distribution state, cloud client, and Profile operations. Pass it into `IpcContext`; do not create per-request stores.

- [ ] Classify local draft reads/writes as valid with online or unexpired offline product access. Classify discovery/publication/installation/reconciliation as online-only. Expired entitlement blocks new work but never deletes or rewrites local data.

- [ ] Validate IPC arguments again in main even though renderer types exist. Return serialized public DTOs and stable error codes. Never return a thrown cloud response body.

- [ ] Expose `window.agenteraAgents` separately from `window.hermesAPI`, `window.agenteraAuth`, and Runtime access/distribution namespaces. No new method is added to legacy Hermes One sync.

- [ ] Rerun focused tests and `npm run typecheck`. Expected: PASS.

- [ ] Commit:

  ```bash
  git add src/main/app/start.ts src/main/ipc/register.ts src/main/ipc/auth-guard.ts src/preload/index.ts src/preload/index.d.ts tests/preload-api-surface.test.ts tests/agentera-agent-control-ipc.test.ts
  git commit -m "feat: expose safe Agent control IPC"
  ```

## Task 14: Build the Agents UI Without Coupling Legacy Hermes One Sync

**Repository:** `/Users/zizimutou/Desktop/aera/aera`

**Files:**

- Create: `src/renderer/src/screens/Agents/AgentControlPanel.tsx`
- Create: `src/renderer/src/screens/Agents/AgentControlPanel.test.tsx`
- Create: `src/renderer/src/screens/Agents/AgentDraftEditor.tsx`
- Create: `src/renderer/src/screens/Agents/AgentDraftEditor.test.tsx`
- Create: `src/renderer/src/screens/Agents/AgentInstallDialog.tsx`
- Create: `src/renderer/src/screens/Agents/AgentInstallDialog.test.tsx`
- Modify: `src/renderer/src/screens/Agents/Agents.tsx`
- Modify: `src/renderer/src/screens/Agents/Agents.test.tsx`
- Modify: `src/renderer/src/assets/main.css`
- Modify: `src/shared/i18n/locales/en/agents.ts`
- Modify: `src/shared/i18n/locales/zh-CN/agents.ts`

**Steps:**

- [ ] Write component tests first for local-draft creation with zero cloud calls, stale revision, publication preview categories, explicit publish confirmation, publish-only success, visible separate “Publish and use” sequence, pending installation retry, fresh/claim choice, manual update affecting only later conversations, offline states, and safe error text.

- [ ] Add a regression test that every AgentEra action calls only `window.agenteraAgents` and never `window.hermesAPI.syncAgents`, `getAgentSyncStatus`, `getLinkedAgentId`, or `/api/agents` behavior.

- [ ] Run:

  ```bash
  npm test -- src/renderer/src/screens/Agents/AgentControlPanel.test.tsx src/renderer/src/screens/Agents/AgentDraftEditor.test.tsx src/renderer/src/screens/Agents/AgentInstallDialog.test.tsx src/renderer/src/screens/Agents/Agents.test.tsx
  ```

  Expected: FAIL.

- [ ] Make the AgentEra control panel the primary section. “New Agent” creates a local draft, not a Hermes Profile and not a cloud object. The editor shows local-only status until explicit publication.

- [ ] The publication dialog shows target “Personal space”, draft revision, Skill/SOP/knowledge counts, total bytes, and the statement that Memory, USER, sessions, files, credentials, and local learning are excluded. Confirm calls the one-use publication handle.

- [ ] Keep the existing local Profile list and Hermes One sync in a visually separate legacy section labeled “Local Runtime Profiles / legacy Hermes One sync”. Rename its create action to “New local Profile”. Preserve its behavior, but do not let its state drive the new panel.

- [ ] Installation UI requires either “Create fresh isolated Profile” or the existing explicit same-owner claim flow. Never present clone as an installation option. Show pending/retry without offering Profile deletion.

- [ ] Version update UI states that active conversations remain on their current binding and only a new conversation uses the newly selected version. Archive states that local Profile data remains on this computer.

- [ ] Rerun focused tests and the exact renderer gates:

  ```bash
  npm run typecheck:web
  npx eslint src/renderer/src/screens/Agents/AgentControlPanel.tsx src/renderer/src/screens/Agents/AgentControlPanel.test.tsx src/renderer/src/screens/Agents/AgentDraftEditor.tsx src/renderer/src/screens/Agents/AgentDraftEditor.test.tsx src/renderer/src/screens/Agents/AgentInstallDialog.tsx src/renderer/src/screens/Agents/AgentInstallDialog.test.tsx src/renderer/src/screens/Agents/Agents.tsx src/renderer/src/screens/Agents/Agents.test.tsx src/shared/i18n/locales/en/agents.ts src/shared/i18n/locales/zh-CN/agents.ts
  ```

  Expected: PASS.

- [ ] Commit:

  ```bash
  git add src/renderer/src/screens/Agents src/renderer/src/assets/main.css src/shared/i18n/locales/en/agents.ts src/shared/i18n/locales/zh-CN/agents.ts
  git commit -m "feat: add personal-space Agent control UI"
  ```

## Task 15: Prove the Two-Device Boundary and Finish All Gates

**Repositories:** `/Users/zizimutou/Desktop/aera/aera-cloud`, `/Users/zizimutou/Desktop/aera/aera`, and read-only `/Users/zizimutou/Desktop/aera/aera-runtime`

**Files:**

- Modify: `/Users/zizimutou/Desktop/aera/aera/package.json`
- Create: `/Users/zizimutou/Desktop/aera/aera/tests/e2e/support/agentera-agent-control-harness.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera/tests/e2e/agentera-agent-control.e2e.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/lat.md/agentera-agent-control-plane.md`
- Modify: `/Users/zizimutou/Desktop/aera/aera/lat.md/agentera-app-authentication.md`
- Modify: `/Users/zizimutou/Desktop/aera/aera/lat.md/agentera-self-evolution.md`

**Steps:**

- [ ] Add the E2E script first:

  ```json
  "test:e2e:agent-control": "playwright test tests/e2e/agentera-agent-control.e2e.ts"
  ```

- [ ] Build a two-device harness using two independent Electron `userData` roots and two independent Hermes Profile roots against one USER/personal-space cloud fixture. Never share local DBs, Profile paths, version projections, or device private keys between harnesses.

- [ ] Implement the approved acceptance scenario exactly:

  1. Device A creates a draft and the cloud has zero definitions.
  2. Device A publishes version 1 and the cloud has one definition/version and no installation.
  3. Device A explicitly claims its existing authoring Profile; its private tree hash is unchanged.
  4. Device B discovers version 1 and creates a distinct fresh Profile/Agent Installation.
  5. Both bind version 1 but have different physical Profiles, Runtime Profile IDs, Agent Installation IDs, and adaptive markers.
  6. Device A writes native Hermes Memory and a learned local Skill; Device B receives neither byte nor digest.
  7. Device A edits a local draft and publishes version 2.
  8. An already-started Device B conversation remains on version 1; after manual selection, a new conversation binds version 2.
  9. Installation/update/archive failure paths leave both private Profile fixture hashes unchanged except for the deliberate Device A Hermes learning writes.

- [ ] Assert captured HTTP request bodies never contain any forbidden key or Profile content and that new AgentEra actions never call the legacy Hermes One endpoint.

- [ ] Run cloud gates from a clean cloud worktree:

  ```bash
  cd /Users/zizimutou/Desktop/aera/aera-cloud
  gofmt -w internal/agentcontrol/*.go internal/audit/service.go internal/audit/service_test.go internal/config/config.go internal/config/config_test.go internal/httpapi/server.go internal/httpapi/server_test.go cmd/aera-cloud/main.go cmd/aera-cloud/main_test.go
  go test -count=1 ./...
  docker compose up -d postgres redis
  set -a
  source .env.example
  set +a
  AERA_INTEGRATION_TESTS=1 go test -p 1 -count=1 ./...
  go vet ./...
  git diff --check
  git status --short --branch
  ```

  Expected: all PASS; only intentional feature-branch commits and no untracked/generated state.

- [ ] Run desktop gates from a clean desktop worktree:

  ```bash
  cd /Users/zizimutou/Desktop/aera/aera
  npm run check:agentera-cloud-contract
  npm test -- tests/agentera-cloud-contract.test.ts tests/agentera-profile-binding.test.ts tests/agentera-agent-control-db.test.ts tests/agentera-agent-drafts.test.ts tests/agentera-agent-manifest.test.ts tests/agentera-agent-data-boundary.test.ts tests/agentera-runtime-binding.test.ts tests/agentera-hermes-control-plane-compat.test.ts tests/preload-api-surface.test.ts
  npm run typecheck
  npm run lint
  npm run build
  npm run test:e2e:auth
  npm run test:e2e:agent-control
  npx --yes lat.md check
  git diff --check
  git status --short --branch
  ```

  Expected: all PASS.

- [ ] Re-run Runtime compatibility evidence without editing it:

  ```bash
  cd /Users/zizimutou/Desktop/aera/aera-runtime
  uv run pytest -q tests/agent/test_system_prompt_restore.py tests/agent/test_skill_utils.py tests/tools/test_skill_manager_tool.py
  git status --short --branch
  ```

  Expected: PASS and clean.

- [ ] Start the verified local cloud in terminal A:

  ```bash
  cd /Users/zizimutou/Desktop/aera/aera-cloud
  docker compose up -d postgres redis
  set -a
  source .env.example
  set +a
  go run ./cmd/aera-cloud
  ```

  Verify `curl --fail http://127.0.0.1:8086/health/ready` in terminal B, then start the desktop there:

  ```bash
  cd /Users/zizimutou/Desktop/aera/aera
  npm run dev
  ```

  Inspect draft creation, publication preview, publish-only result, fresh install, existing claim, offline installed use, new-conversation update behavior, legacy separation, and restart recovery. Capture the exact ports, commit IDs, and observed state in the handoff.

- [ ] Update the three `lat.md` files with implemented file paths, API names, test commands, and the final Hermes boundary. Do not claim workspace/organization/official-Agent support.

- [ ] Commit the E2E proof and knowledge updates:

  ```bash
  cd /Users/zizimutou/Desktop/aera/aera
  git add package.json tests/e2e/agentera-agent-control.e2e.ts tests/e2e/support/agentera-agent-control-harness.ts lat.md/agentera-agent-control-plane.md lat.md/agentera-app-authentication.md lat.md/agentera-self-evolution.md
  git commit -m "test: prove USER Agent control plane boundary"
  ```

- [ ] Present both feature-branch commit lists, fresh gate output, worktree status, and any residual risk to the user. Merging either feature branch, pushing, releasing, or deploying requires separate explicit authorization.

## Completion Definition

The plan is complete only when all fifteen tasks pass their fresh gates and the E2E proof demonstrates all of the following at once:

- local draft creation creates no cloud object;
- explicit publication creates one immutable signed version and audit evidence but no hidden installation;
- two devices receive the same published base through different Agent Installations and different physical Profiles;
- Device A's Memory, USER, sessions, credentials, files, Curator data, and learned local Skills never reach Device B or cloud control-plane payloads;
- the active Hermes conversation keeps its original RuntimeBinding/version while a later conversation can use a manually selected update;
- the real Hermes session prompt persistence, Memory, background review, Skill learning, and Curator tests continue passing without a Runtime production edit;
- legacy Hermes One sync remains a separate account/protocol/store/UI path;
- no workspace, organization, official Agent, ExperienceCandidate, backup, Runtime release, push, merge, or deployment is claimed as part of V1.
