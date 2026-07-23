# Official Agent Privacy Quality Feedback V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in, content-free quality signal path for platform-owned official Agents, with rotating pseudonyms, k-anonymous Admin reporting, human-created proposals, dual-control approval, and an explicit clone into the existing official draft pipeline.

**Architecture:** The desktop main process derives bounded result metadata from a fixed official `RuntimeBinding`, stores only a minimized local envelope, and uploads it independently of chat success. Cloud authenticates the request, replaces account and device identity with a purpose-separated daily HMAC pseudonym, then stores only the sanitized event. A separate Cloud quality domain aggregates and expires events. Aera Admin reads only k-anonymous aggregates and implements proposal review; an approved proposal can be cloned into an editable platform draft, after which the existing immutable official publication workflow remains authoritative.

**Tech Stack:** Electron 39, TypeScript 5.9, React 19, better-sqlite3, Node crypto; Go 1.26, chi, pgx/PostgreSQL, Redis; Aera Admin Go BFF and React/Vite; OpenAPI; Vitest, Go tests, Playwright.

## Global Constraints

- Consent defaults to off. Passive metrics and explicit feedback have separate switches.
- Only sessions whose fixed `RuntimeBinding.officialReleaseRevisionId` is non-null are eligible.
- Never collect prompt, response, reasoning, tool payload, raw error, stack, log, file, Memory, USER, Session content, private Skill, Curator state, credential, Profile path, or free-form user text.
- Cloud event rows must not contain user, device, installation, Profile, session, conversation, or RuntimeBinding identifiers.
- Quality processing must never block, cancel, retry, or mutate a Hermes conversation or local learning.
- Raw sanitized events expire after 30 days; daily aggregates expire after 180 days; Admin output requires at least 10 distinct rotating subjects.
- Developer creates a proposal; a different Super Admin approves it. Approval never publishes and never creates content automatically. Developer explicitly clones an approved proposal into a normal editable official draft.
- `aera-runtime` is read-only and receives no changes.

## File Structure

### Cloud: `/Users/zizimutou/Desktop/aera/aera-cloud`

- Create `migrations/000017_official_quality_feedback_v1.sql` for consent receipts, purge requests, raw events, aggregates, proposals, reviews, and retention constraints.
- Create `internal/officialquality/model.go`, `repository.go`, `service.go`, `http.go`, `pseudonym.go`, and focused tests.
- Modify `internal/config/config.go` and add `internal/config/official_quality.go` for independent HMAC key rings and retention settings.
- Modify `internal/httpapi/server.go` and `cmd/aera-cloud/main.go` to mount the public ingestion handler.
- Modify `internal/adminapi/handler.go`, `internal/adminapi/official_agent.go`, and tests to expose internal aggregate/proposal operations.
- Modify `internal/jobs/postgres.go` and tests for aggregation and retention.
- Modify `api/openapi.yaml`, `api/openapi/internal-admin.yaml`, generated/contract tests, and `internal/store/migrate_test.go`.

### Desktop: `/Users/zizimutou/Desktop/aera/aera`

- Create `src/shared/agentera-official-quality.ts` for renderer-safe consent and feedback contracts.
- Create `src/main/agentera-official-quality/{db,model,minimizer,collector,client,manager,ipc-contract}.ts` and focused tests.
- Modify `src/main/app/start.ts`, `src/main/ipc/register.ts`, `src/main/ipc/auth-guard.ts`, `src/preload/index.ts`, and `src/preload/index.d.ts`.
- Modify `src/renderer/src/components/settings/PrivacyPane.tsx` and add tests for the two independent consent controls.
- Modify `src/renderer/src/screens/Chat/hooks/useDashboardChatTransport.ts` only for the fixed-code helpful/not-helpful control; no chat body crosses the quality IPC.
- Add `tests/e2e/agentera-official-quality.e2e.ts` and package script `test:e2e:official-quality`.

### Admin: `/Users/zizimutou/Desktop/aera/aera-admin`

- Create `internal/officialquality/{model,service,http}.go` and tests.
- Modify `internal/cloudadmin/{client,contract,http_client,official_agent}.go` and tests.
- Modify `internal/rbac/rbac.go`, `cmd/aera-admin/main.go`, Admin OpenAPI contracts, and audit reason settings.
- Create `web/src/pages/OfficialAgentQualityPage.tsx` plus tests; modify router, layout, contracts, and API client.
- Extend `e2e/official-agent.spec.ts` with aggregate, proposal, dual-control approval, and clone coverage.

---

### Task 1: Cloud schema and privacy invariants

**Consumes:** Approved quality design, existing platform definition/version/release foreign keys, migration 16.

**Produces:** Forward-only migration 17 and database tests proving forbidden identifiers cannot enter quality storage.

**Files:**

- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/migrations/000017_official_quality_feedback_v1.sql`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/store/migrate_test.go`
- Test: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/officialquality/repository_test.go`

- [ ] Write a failing migration test expecting migration 17 and these tables: `official_quality_consent_receipts`, `official_quality_purge_requests`, `official_quality_events`, `official_quality_daily_aggregates`, `official_quality_proposals`, `official_quality_proposal_aggregates`, `official_quality_proposal_reviews`.
- [ ] Run `go test ./internal/store -run 'TestEmbeddedMigrations|TestApplyMigrations' -count=1`; expect the migration-count/table assertions to fail.
- [ ] Add migration 17. `official_quality_events` contains only protocol/consent versions, canonical event UUID, platform/definition/version/release/release-revision foreign keys, bounded Desktop/Runtime versions, UTC event day, 32-byte daily subject pseudonym, 32-byte rotating binding-proof digest, event kind, terminal result code, latency bucket, total-token bucket, optional whitelisted crash code, optional explicit rating/fixed reason-code array, 64-byte device signature, and server timestamp. It has no columns named or semantically equivalent to user, account, device, installation, Profile, session, conversation, raw RuntimeBinding, IP, user agent, or request body.
- [ ] Add user-scoped purpose-specific consent receipts and purge requests in separate tables; event rows never reference those rows or a user/device identifier. Add check constraints for exact enums, metric-versus-explicit rating rules, UTC-day retention indexes, and an immutable trigger on raw events.
- [ ] Add aggregate rows keyed by platform/definition/version/release revision/day/result/latency/token/crash/rating/reason with `event_count`, `distinct_subject_count`, and explicit suppression state/threshold; add proposal, normalized immutable proposal-to-aggregate references, and proposal-review rows with immutable source filters and a reviewer-not-creator constraint.
- [ ] Add a repository privacy test that inspects `information_schema.columns`, fails on forbidden names, rejects invalid enum values, and proves event update/delete is blocked except through the retention function executed by the maintenance role.
- [ ] Run `AERA_INTEGRATION_TESTS=1 go test ./internal/store ./internal/officialquality -count=1`; expect pass.
- [ ] Commit in Cloud: `git add migrations/000017_official_quality_feedback_v1.sql internal/store/migrate_test.go internal/officialquality/repository_test.go && git commit -m "feat: add official quality privacy schema"`.

### Task 2: Cloud minimization, rotating pseudonyms, and ingestion

**Consumes:** Authenticated access claims, official release provenance, migration 17.

**Produces:** Public ingestion endpoint that stores only canonical, content-free events.

**Files:**

- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/officialquality/model.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/officialquality/pseudonym.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/officialquality/repository.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/officialquality/service.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/officialquality/http.go`
- Test: matching `*_test.go` files in the same package
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/config/config.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/config/official_quality.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/httpapi/server.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/cmd/aera-cloud/main.go`

- [ ] Write model tests for the exact accepted public envelope: protocol/consent versions, canonical UUIDv7 `event_id`, official platform/definition/version/release/release-revision IDs, bounded Desktop/Runtime versions, UTC day, `kind`, terminal result code, latency bucket, total-token bucket, optional whitelisted crash code, optional `helpful|not_helpful` rating and fixed reason-code array, rotating binding proof, and device signature.
- [ ] Add negative tests containing each forbidden field name and oversize/unknown keys; expect `invalid_request` before repository invocation.
- [ ] Write pseudonym tests proving `HMAC-SHA256(key, "official-quality-v1\x00" || user_id || "\x00" || YYYY-MM-DD)` is stable within one UTC day, changes across days, changes when the purpose label changes, and supports active/previous key verification without exposing the key ID to Admin.
- [ ] Run `go test ./internal/officialquality -count=1`; expect compile or assertion failure.
- [ ] Implement strict JSON decoding with a 16 KiB body limit, canonical enum validation, access-token authentication, release/version consistency lookup, daily HMAC derivation, and repository insertion. Do not persist request headers, remote address, access claims, or raw payload bytes.
- [ ] Add `OfficialQuality http.Handler` to `httpapi.Dependencies`; mount purpose-specific consent grant/revoke plus `POST /api/v1/official-agent-quality/events`, and compose it in `cmd/aera-cloud/main.go` with an independent configured HMAC key ring.
- [ ] Configure defaults `enabled=false`, raw retention 30 days, aggregate retention 180 days, minimum subjects 10, and fail startup if enabled without a 32-byte active key.
- [ ] Run `go test ./internal/officialquality ./internal/httpapi ./internal/config ./cmd/aera-cloud -count=1`; expect pass.
- [ ] Commit in Cloud: `git add internal/officialquality internal/config internal/httpapi/server.go cmd/aera-cloud/main.go && git commit -m "feat: ingest minimized official quality events"`.

### Task 3: Cloud aggregation, retention, and k-anonymous reads

**Consumes:** Sanitized raw events from Task 2.

**Produces:** Idempotent daily aggregation, bounded retention, and queries that suppress low-cardinality cells.

**Files:**

- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/officialquality/repository.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/officialquality/service.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/jobs/postgres.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/jobs/postgres_test.go`
- Test: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/officialquality/aggregation_test.go`

- [ ] Write integration tests with 9, 10, and 11 distinct pseudonyms. Assert 9 is absent, 10 and 11 return only aggregate dimensions/counts, and no pseudonym is returned.
- [ ] Write retention tests at exact 30-day and 180-day boundaries and a replay test proving the same aggregation window can run twice without double-counting.
- [ ] Run `AERA_INTEGRATION_TESTS=1 go test ./internal/officialquality ./internal/jobs -count=1`; expect failure.
- [ ] Implement one PostgreSQL transaction that upserts closed UTC-day aggregates, deletes raw rows older than 30 days through the controlled retention function, and deletes aggregates older than 180 days.
- [ ] Add the operation to `PostgresMaintenance.Run` after existing security maintenance. A failure is logged and retried by the existing lease runner; it never affects public request readiness.
- [ ] Implement aggregate listing that applies `distinct_subject_count >= configured minimum` in SQL, returns empty arrays rather than null, and uses opaque bounded cursors.
- [ ] Run the focused integration tests; expect pass.
- [ ] Commit in Cloud: `git add internal/officialquality internal/jobs && git commit -m "feat: aggregate and expire official quality signals"`.

### Task 4: Cloud internal proposal and dual-control API

**Consumes:** K-anonymous aggregate filters and existing platform draft service.

**Produces:** Internal Admin endpoints for read, proposal creation, separate approval, rejection, and explicit draft clone.

**Files:**

- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/adminapi/handler.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/adminapi/official_quality.go`
- Test: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/adminapi/official_quality_test.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/agentcontrol/platform_service.go`
- Test: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/agentcontrol/platform_service_test.go`

- [ ] Write handler tests for scopes `official_quality:read`, `official_quality:propose`, `official_quality:review`, and `official_quality:clone`; unknown/wildcard scopes fail closed.
- [ ] Write service tests proving a Developer may create a proposal from an exact aggregate filter, the same admin cannot approve it, only a Super Admin can approve/reject it, and approval alone creates no draft.
- [ ] Write clone tests proving only an approved proposal can be cloned, the clone actor is a Developer, and the new normal platform draft contains only a human-entered title/summary plus an immutable proposal reference—not generated prompt, Skill, Knowledge, or SOP bytes.
- [ ] Run `go test ./internal/adminapi ./internal/agentcontrol ./internal/officialquality -count=1`; expect failure.
- [ ] Implement internal routes under `/internal/admin/v1/official-quality/*` with existing mTLS plus service-JWT middleware and append-only admin operations/audit records.
- [ ] Add a narrow `PlatformDraftCloner` interface in `officialquality` and an adapter to the existing platform service; do not import quality aggregates into agent version content.
- [ ] Run focused tests; expect pass.
- [ ] Commit in Cloud: `git add internal/adminapi internal/agentcontrol internal/officialquality && git commit -m "feat: govern official quality proposals"`.

### Task 5: Cloud OpenAPI and contract closure

**Consumes:** Public and internal endpoints from Tasks 2–4.

**Produces:** Versioned contracts used by Desktop and Admin.

**Files:**

- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/api/openapi.yaml`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/api/openapi/internal-admin.yaml`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/api/openapi_test.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/api/internal_admin_openapi_test.go`

- [ ] Add contract tests asserting additional properties are rejected, no forbidden privacy property exists, all arrays are non-null, and every mutation carries idempotency/revision/reason metadata where applicable.
- [ ] Run `go test ./api -count=1`; expect failure.
- [ ] Add exact public ingestion and internal aggregate/proposal schemas, including fixed enums and no free-text feedback field.
- [ ] Run `go test ./api -count=1`; expect pass.
- [ ] Commit in Cloud: `git add api && git commit -m "docs: publish official quality contracts"`.

### Task 6: Desktop local privacy store and minimizer

**Consumes:** Fixed official RuntimeBinding and bounded chat terminal metadata.

**Produces:** Separate local SQLite privacy domain with default-off consent and a forbidden-content guard.

**Files:**

- Create: `/Users/zizimutou/Desktop/aera/aera/src/shared/agentera-official-quality.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-official-quality/db.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-official-quality/model.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-official-quality/minimizer.ts`
- Test: corresponding `*.test.ts` files

- [ ] Write tests that resolve an absolute `userData/agentera-official-quality/quality.db` outside `HERMES_HOME`, mode-restrict the directory, and initialize versioned consent as `{passive:false, explicitFeedback:false}`.
- [ ] Write table-shape tests proving the local outbox contains no prompt/response/error text/path/session/conversation/Profile/installation fields.
- [ ] Write minimizer table tests for latency buckets (`lt_1s`, `1s_5s`, `5s_15s`, `15s_60s`, `60s_180s`, `gte_180s`) and total-token buckets (`0`, `1_1k`, `1k_4k`, `4k_16k`, `16k_64k`, `gte_64k`), the exact terminal result codes, and the crash-code allowlist.
- [ ] Run `npm test -- src/main/agentera-official-quality`; expect failure.
- [ ] Implement schema version 1, strict exact-object parsers, bounded timestamps, and an outbox that stores only the public quality envelope. Reject unknown fields before serialization.
- [ ] Run focused tests; expect pass.
- [ ] Commit in Desktop: `git add src/shared/agentera-official-quality.ts src/main/agentera-official-quality && git commit -m "feat: add local official quality privacy domain"`.

### Task 7: Desktop trusted main-process collection and independent upload

**Consumes:** `preparedAgentTurn.binding`, chat start/done/error/usage callbacks, consent store, Cloud contract.

**Produces:** Content-free terminal signals and an offline-safe uploader.

**Files:**

- Create: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-official-quality/collector.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-official-quality/client.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-official-quality/manager.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/main/app/start.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/main/ipc/register.ts`
- Test: matching focused tests and `/Users/zizimutou/Desktop/aera/aera/src/main/ipc/register.official-quality.test.ts`

- [ ] Write collector tests proving non-official bindings, disabled consent, missing release provenance, and malformed usage produce no row.
- [ ] Write tests proving `onUsage` retains only total tokens, `onDone` records success and latency, `onError` maps only whitelisted local codes, and full response/error strings never reach the manager mock.
- [ ] Write uploader tests for authenticated POST, exponential retry with jitter, 1,000-event capacity that drops oldest passive metrics before explicit feedback, 30-day local expiry, logout isolation, consent revocation/purge, and server rejection without chat failure.
- [ ] Run `npm test -- src/main/agentera-official-quality src/main/ipc/register.official-quality.test.ts`; expect failure.
- [ ] Compose the manager in `app/start.ts` from auth access-token getter and separate DB. Pass it into `registerIpcHandlers`.
- [ ] In `ipc/register.ts`, capture `chatStartTime`, bounded usage total, and the trusted `preparedAgentTurn.binding` already fixed before execution. On terminal callback, enqueue an event only when `officialReleaseRevisionId` is present. Never pass `fullResponse`, raw `error`, attachments, history, or tool data.
- [ ] Trigger best-effort upload after enqueue and authenticated startup. Catch/log only a constant code; never include event payload or identity in logs.
- [ ] Run focused tests; expect pass.
- [ ] Commit in Desktop: `git add src/main/agentera-official-quality src/main/app/start.ts src/main/ipc/register.ts && git commit -m "feat: collect official quality signals in main process"`.

### Task 8: Desktop consent and fixed-code explicit feedback UI

**Consumes:** Quality manager and strict IPC contracts.

**Produces:** Two independent privacy switches and helpful/not-helpful feedback with fixed reasons only.

**Files:**

- Create: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-official-quality/ipc-contract.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/main/ipc/register.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/main/ipc/auth-guard.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/preload/index.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/preload/index.d.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/renderer/src/components/settings/PrivacyPane.tsx`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/renderer/src/screens/Chat/hooks/useDashboardChatTransport.ts`
- Test: colocated renderer and IPC tests

- [ ] Write IPC tests rejecting extra properties, free-text notes, raw error, response, session ID, and arbitrary reason codes.
- [ ] Write PrivacyPane tests for default-off rendering, separate confirmation copy, persistence, and disabled feedback when not authenticated.
- [ ] Write chat hook tests showing controls only for a completed official-bound turn and sending only `{eventId, rating, reasonCodes}` where rating is `helpful|not_helpful` and every reason is one of `incorrect`, `incomplete`, `tool_failed`, `too_slow`, `unsafe_or_inappropriate`, `other_without_text`.
- [ ] Run focused Vitest files; expect failure.
- [ ] Implement `agenteraOfficialQuality` preload API with `getConsent`, `setPassiveConsent`, `setExplicitFeedbackConsent`, and `submitFeedback`. Keep the API absent from generic chat message payloads.
- [ ] Add auth-guard classifications so reads are local and mutations require an authenticated/offline owner but queue without cloud availability.
- [ ] Implement accessible UI copy explicitly stating no conversation content is sent and that disabling consent purges unsent matching outbox rows.
- [ ] Run focused tests plus `npm run typecheck`; expect pass.
- [ ] Commit in Desktop: `git add src/main/agentera-official-quality src/main/ipc src/preload src/renderer/src/components/settings/PrivacyPane.tsx src/renderer/src/screens/Chat/hooks/useDashboardChatTransport.ts && git commit -m "feat: add official quality consent and feedback UI"`.

### Task 9: Admin RBAC, Cloud client, and BFF

**Consumes:** Cloud internal quality contract.

**Produces:** Fail-closed Admin API with role separation and audit.

**Files:**

- Modify: `/Users/zizimutou/Desktop/aera/aera-admin/internal/rbac/rbac.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-admin/internal/cloudadmin/client.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-admin/internal/cloudadmin/contract.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-admin/internal/cloudadmin/http_client.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-admin/internal/cloudadmin/official_agent.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-admin/internal/officialquality/model.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-admin/internal/officialquality/service.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-admin/internal/officialquality/http.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-admin/cmd/aera-admin/main.go`
- Test: corresponding package tests

- [ ] Add failing RBAC tests for permissions `official_quality.read`, `official_quality.propose`, `official_quality.review`, and `official_quality.clone`: Developer gets read/propose/clone, Super Admin gets read/review, Operator gets release-health read only, Auditor gets aggregate/audit read only, Support and Finance get none.
- [ ] Add DisabledClient tests proving every new method returns `ErrNotConfigured` and never fabricates aggregate or proposal state.
- [ ] Add service tests for role enforcement, creator/reviewer separation, reason validation, idempotency, expected revision, and audit records.
- [ ] Run `go test ./internal/rbac ./internal/cloudadmin ./internal/officialquality ./cmd/aera-admin -count=1`; expect failure.
- [ ] Implement exact contract types and the Cloud client methods. Map disconnected/unknown Cloud state to unavailable/pending, never success.
- [ ] Mount `/official-quality/aggregates`, `/official-quality/proposals`, review endpoints, and clone endpoint in the existing Admin router.
- [ ] Run focused tests; expect pass.
- [ ] Commit in Admin: `git add internal/rbac internal/cloudadmin internal/officialquality cmd/aera-admin/main.go && git commit -m "feat: govern official quality proposals in admin"`.

### Task 10: Admin quality page and end-to-end governance proof

**Consumes:** Admin BFF from Task 9.

**Produces:** K-anonymous dashboard, proposal workflow, and cross-repo E2E evidence.

**Files:**

- Create: `/Users/zizimutou/Desktop/aera/aera-admin/web/src/pages/OfficialAgentQualityPage.tsx`
- Create: `/Users/zizimutou/Desktop/aera/aera-admin/web/src/pages/OfficialAgentQualityPage.test.tsx`
- Modify: `/Users/zizimutou/Desktop/aera/aera-admin/web/src/app/router.tsx`
- Modify: `/Users/zizimutou/Desktop/aera/aera-admin/web/src/app/router.test.tsx`
- Modify: `/Users/zizimutou/Desktop/aera/aera-admin/web/src/layout/AdminLayout.tsx`
- Modify: `/Users/zizimutou/Desktop/aera/aera-admin/web/src/api/client.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera-admin/web/src/api/contracts.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera-admin/e2e/official-agent.spec.ts`

- [ ] Write component tests for suppressed cells, no identity drill-down, role-specific buttons, proposal source filter display, self-review rejection, and clone-after-approval.
- [ ] Run `pnpm --filter @aera/admin-web test --run OfficialAgentQualityPage`; expect failure.
- [ ] Implement aggregate cards/tables that display only Cloud-returned dimensions/counts; provide no raw-event route or pseudonym column.
- [ ] Implement proposal creation with fixed fields, Super Admin review with reason/ticket, and Developer clone with explicit editable title/summary confirmation.
- [ ] Extend Playwright E2E: seed 9 subjects and confirm hidden; seed the 10th and confirm aggregate; Developer proposes; same actor cannot approve; Super Admin approves; Developer clones; existing draft editor opens; no version/release exists until the established publication steps run.
- [ ] Run `AERA_ADMIN_E2E_CLOUD_REPO=/Users/zizimutou/Desktop/aera/aera-cloud make e2e`; expect pass.
- [ ] Commit in Admin: `git add web e2e/official-agent.spec.ts && git commit -m "feat: add official quality governance console"`.

### Task 11: Cross-repo privacy and regression gates

**Consumes:** Completed Cloud, Desktop, and Admin slices.

**Produces:** Reproducible proof that the feature is content-free, optional, isolated, and does not alter existing RuntimeBindings.

**Files:**

- Create: `/Users/zizimutou/Desktop/aera/aera/tests/e2e/agentera-official-quality.e2e.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/package.json`
- Create: `/Users/zizimutou/Desktop/aera/aera/scripts/check-official-quality-boundary.mjs`
- Modify: `/Users/zizimutou/Desktop/aera/aera/.github/workflows/ci.yml`
- Modify: `/Users/zizimutou/Desktop/aera/aera/lat.md/agentera-post-official-delivery.md`

- [ ] Write a boundary script that scans quality schemas/contracts/storage serializers for the forbidden vocabulary and verifies no import from Hermes Memory, Skill candidate, Curator, session-content, or attachment modules.
- [ ] Write Desktop E2E: consent off emits nothing; passive on sends minimized success; explicit feedback off blocks feedback; explicit on sends fixed code; network failure does not fail chat; v2/new RuntimeBinding produces v2 provenance while an existing v1 binding stays v1.
- [ ] Run `npm run test:e2e:official-quality`; expect failure before fixture support.
- [ ] Add deterministic fake Cloud fixtures without introducing production mock-success behavior.
- [ ] Run in Desktop: `npm test -- src/main/agentera-official-quality && npm run typecheck && npm run build && npm run test:e2e:official-quality && node scripts/check-official-quality-boundary.mjs`.
- [ ] Run in Cloud: `go test -count=1 ./... && AERA_INTEGRATION_TESTS=1 go test -count=1 -p 1 ./internal/officialquality ./internal/adminapi ./internal/jobs`.
- [ ] Run in Admin: `make verify && AERA_ADMIN_E2E_CLOUD_REPO=/Users/zizimutou/Desktop/aera/aera-cloud make e2e`.
- [ ] Run `npm exec --yes --package=lat.md@0.12.1 -- lat check` in Desktop and commit documentation/CI: `git add package.json .github tests scripts lat.md && git commit -m "test: prove official quality privacy boundary"`.

## Final Acceptance Evidence

- [ ] Record exact local commits separately for Desktop, Cloud, and Admin.
- [ ] Record local tests, local main merge, push, remote CI, deployment, and release as separate states.
- [ ] Capture one sanitized database schema dump proving forbidden identifiers are absent; do not capture event values.
- [ ] Capture the E2E sequence: official v1 run → 10-subject aggregate → Developer proposal → different Super Admin approval → Developer clone → normal draft only.
- [ ] Confirm `git -C /Users/zizimutou/Desktop/aera/aera-runtime status --short --branch` is unchanged.
