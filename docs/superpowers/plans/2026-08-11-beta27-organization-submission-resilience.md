# Beta.27 Organization Submission Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep every trustworthy Organization submission visible when one local draft link drifts, show one typed item warning, and provide a safe confirmed way to disconnect an unrecoverable local link.

**Architecture:** Control-plane schema v12 adds bounded conflict quarantine plus the empty thread/segment foundation required by the next plan. The publication service reconciles each Cloud item independently and returns `{ submissions, issues }`; `AgentControlPanel` owns the one list request and passes data to a presentational `OrganizationSubmissionPanel`.

**Tech Stack:** Electron, TypeScript, better-sqlite3, React 19, Vitest, Testing Library, lat.md.

---

## File map

- Modify `src/main/agentera-agent-control/db.ts`, `src/main/agentera-agent-control/db.test.ts`, and `tests/agentera-agent-control-db.test.ts`: additive schema 11→12 with conflict, thread, and segment tables.
- Create `src/main/agentera-agent-control/organization-submission-reference-store.ts`: conflict quarantine, clear, detach, and safe metadata reads.
- Create `src/main/agentera-agent-control/organization-submission-reference-store.test.ts`: owner isolation, no-secret schema, CAS, and detach preservation.
- Modify `src/shared/agentera-agent-control.ts`: reference state, typed stages, list envelope, and confirmed detach request.
- Modify `src/main/agentera-agent-control/organization-publication-service.ts` and tests: per-item Cloud validation/reconciliation and exact repair rules.
- Modify `src/main/agentera-agent-control/manager.ts`, `ipc-contract.ts`, and tests: expose list envelope and detach mutation with bounded errors.
- Modify `src/preload/index.ts` and `index.d.ts`: add the envelope and detach bridges while preserving the Beta.26 array bridge.
- Modify `src/renderer/src/screens/Agents/AgentControlPanel.tsx` and tests: own exactly one request and issue state.
- Modify `src/renderer/src/screens/Agents/OrganizationSubmissionPanel.tsx` and tests: present data, issue warning, refresh, and detach confirmation without listing independently.
- Modify `src/shared/i18n/locales/en/agents.ts` and `src/shared/i18n/locales/zh-CN/agents.ts`: item conflict and detach messages.
- Modify `lat.md/agentera-organizations.md` and `lat.md/agentera-agent-control-plane.md`: record per-item isolation and schema privacy boundaries.

### Task 1: Add the additive schema-v12 foundation

**Files:**

- Modify: `src/main/agentera-agent-control/db.ts`
- Modify: `src/main/agentera-agent-control/db.test.ts`
- Modify: `tests/agentera-agent-control-db.test.ts`

- [ ] **Step 1: Write failing fresh and v11 migration tests**

Add one table-driven assertion for a fresh database and a synthetic v11 database:

```ts
it.each(["fresh", "v11"] as const)(
  "creates Beta.27 local reliability tables from %s",
  (source) => {
    const database = openFixture(source);
    expect(database.sqlite.prepare("PRAGMA user_version").get()).toEqual({
      user_version: 12,
    });
    expect(tableNames(database.sqlite)).toEqual(
      expect.arrayContaining([
        "organization_agent_submission_ref_conflicts",
        "conversation_threads",
        "conversation_segments",
      ]),
    );
    for (const table of [
      "organization_agent_submission_ref_conflicts",
      "conversation_threads",
      "conversation_segments",
    ]) {
      expect(tableColumns(database.sqlite, table).join(" ")).not.toMatch(
        /api_key|secret_value|prompt|message_body|profile_path/i,
      );
    }
  },
);
```

- [ ] **Step 2: Run and verify RED**

Run: `npx vitest run src/main/agentera-agent-control/db.test.ts -t "Beta.27 local reliability"`

Expected: FAIL because schema version remains 11 and the tables are absent.

- [ ] **Step 3: Add exact schema definitions and migrate once**

Set `AGENTERA_CONTROL_PLANE_SCHEMA_VERSION = 12`. Add these constraints, preserving all existing migrations:

```sql
CREATE TABLE IF NOT EXISTS organization_agent_submission_ref_conflicts (
  tenant_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  cloud_submission_id TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN (
    'reference_shape', 'content_digest', 'definition',
    'published_version', 'draft_publication', 'compare_and_set'
  )),
  state TEXT NOT NULL CHECK (state IN ('quarantined', 'detached')),
  reference_revision INTEGER NOT NULL CHECK (reference_revision >= 1),
  first_observed_at TEXT NOT NULL,
  last_observed_at TEXT NOT NULL,
  resolved_at TEXT,
  PRIMARY KEY (
    tenant_id, owner_id, organization_id, cloud_submission_id
  )
);

CREATE TABLE IF NOT EXISTS conversation_threads (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  device_installation_id TEXT NOT NULL,
  root_conversation_key TEXT NOT NULL,
  active_segment_id TEXT,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (active_segment_id)
    REFERENCES conversation_segments(id) ON DELETE RESTRICT,
  UNIQUE (
    tenant_id, owner_id, device_installation_id, root_conversation_key
  )
);

CREATE TABLE IF NOT EXISTS conversation_segments (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES conversation_threads(id) ON DELETE RESTRICT,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
  segment_conversation_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN ('preparing', 'active', 'superseded', 'failed')
  ),
  route_json TEXT NOT NULL CHECK (length(route_json) BETWEEN 2 AND 8192),
  source_profile_id TEXT CHECK (
    source_profile_id IS NULL
    OR length(source_profile_id) BETWEEN 1 AND 64
  ),
  source_model_id TEXT CHECK (
    source_model_id IS NULL
    OR length(source_model_id) BETWEEN 1 AND 512
  ),
  runtime_binding_id TEXT NOT NULL REFERENCES runtime_bindings(id) ON DELETE RESTRICT,
  conversation_boundary_id TEXT NOT NULL REFERENCES conversation_boundaries(id) ON DELETE RESTRICT,
  hermes_session_id TEXT,
  history_boundary_count INTEGER NOT NULL CHECK (history_boundary_count >= 0),
  created_at TEXT NOT NULL,
  activated_at TEXT,
  failed_at TEXT,
  failure_code TEXT,
  CHECK (
    (source_profile_id IS NULL AND source_model_id IS NULL)
    OR (source_profile_id IS NOT NULL AND source_model_id IS NOT NULL)
  ),
  UNIQUE (thread_id, ordinal),
  UNIQUE (segment_conversation_key),
  UNIQUE (hermes_session_id)
);

CREATE UNIQUE INDEX conversation_segments_one_active_per_thread
  ON conversation_segments(thread_id)
  WHERE state = 'active';
```

Add indexes for conflict lookup, thread active segment, and segment thread/session, including the partial unique index that permits at most one active segment per thread. `route_json` is local-only and must later be written and parsed only as the exact `FrozenAgentModelRoute` shape; it may contain the non-secret credential reference required for Main re-resolution, but never a credential value, absolute path, prompt, or message body. Legacy adopted segments use both source fields as `NULL`; every new catalog-resolved segment uses both as non-`NULL`. Public serializers never return `route_json` or `credentialRef`.

Interpolate the same schema string into the fresh `currentVersion === 0` schema and into one additive v12 migration block. Run that migration block only when `currentVersion >= 1 && currentVersion <= 11`, then set `PRAGMA user_version = 12` inside the existing transaction.

- [ ] **Step 4: Verify GREEN and old migrations**

Run: `npx vitest run src/main/agentera-agent-control/db.test.ts tests/agentera-agent-control-db.test.ts`

Expected: PASS for fresh, v6-v11, and unsupported-version tests.

- [ ] **Step 5: Commit**

```bash
git add src/main/agentera-agent-control/db.ts src/main/agentera-agent-control/db.test.ts tests/agentera-agent-control-db.test.ts
git commit -m "feat(agent-control): add Beta.27 reliability schema"
```

### Task 2: Define typed list and local-reference contracts

**Files:**

- Modify: `src/shared/agentera-agent-control.ts`
- Modify: `src/main/agentera-agent-control/ipc-contract.ts`
- Modify: `src/main/agentera-agent-control/ipc-contract.test.ts`

- [ ] **Step 1: Write failing serialization tests**

```ts
it("serializes a quarantined reference without conflicting local bytes", () => {
  const output = publicOrganizationSubmissionList({
    submissions: [
      summary({
        referenceState: { kind: "quarantined", stage: "content_digest" },
      }),
    ],
    issues: [],
  });
  expect(output.submissions[0].referenceState).toEqual({
    kind: "quarantined",
    stage: "content_digest",
  });
  expect(JSON.stringify(output)).not.toContain(LOCAL_DIGEST);
  expect(JSON.stringify(output)).not.toContain(DATABASE_PATH);
});
```

- [ ] **Step 2: Run and verify RED**

Run: `npx vitest run src/main/agentera-agent-control/ipc-contract.test.ts -t "quarantined reference"`

Expected: FAIL because the list envelope and reference state do not exist.

- [ ] **Step 3: Add exact shared shapes**

```ts
export type SubmissionReferenceConflictStage =
  | "reference_shape"
  | "content_digest"
  | "definition"
  | "published_version"
  | "draft_publication"
  | "compare_and_set";

export type SubmissionReferenceState =
  | { kind: "verified"; draftId: string; draftRevision: number }
  | { kind: "remote_only" }
  | { kind: "quarantined"; stage: SubmissionReferenceConflictStage };

export interface OrganizationSubmissionListIssue {
  submissionId: string | null;
  code: "cloud_record_invalid";
}

export interface OrganizationAgentSubmissionList {
  submissions: OrganizationAgentSubmissionListItem[];
  issues: OrganizationSubmissionListIssue[];
}

export interface OrganizationAgentSubmissionListItem extends OrganizationAgentSubmissionSummary {
  referenceState: SubmissionReferenceState;
}

export interface DisconnectOrganizationSubmissionReferenceInput {
  submissionId: string;
  confirmation: "disconnect-local-draft-link";
}
```

Add a new `OrganizationAgentSubmissionListItem` that extends the existing `OrganizationAgentSubmissionSummary` with required `referenceState`. Preserve the existing summary shape for submit/review/withdraw responses and the legacy `listOrganizationSubmissions()` bridge. Map `localDraftId` and `localDraftRevision` only from `verified`; set both legacy fields to `null` for `remote_only` and `quarantined`. Add `publicOrganizationSubmissionList()` to rebuild the envelope from Main-owned values without changing the old array serializer.

- [ ] **Step 4: Verify GREEN without breaking Beta.26 callers**

Run: `npx vitest run src/main/agentera-agent-control/ipc-contract.test.ts && npm run typecheck:node`

Expected: the focused test and Node typecheck both pass. The old `listOrganizationSubmissions()` array contract remains unchanged; the new envelope is not exposed through preload until Task 6 adds its separate compatibility-safe bridge.

- [ ] **Step 5: Commit the contract boundary**

```bash
git add src/shared/agentera-agent-control.ts src/main/agentera-agent-control/ipc-contract.ts src/main/agentera-agent-control/ipc-contract.test.ts
git commit -m "feat(organizations): type submission reference drift"
```

### Task 3: Implement conflict quarantine storage

**Files:**

- Create: `src/main/agentera-agent-control/organization-submission-reference-store.ts`
- Create: `src/main/agentera-agent-control/organization-submission-reference-store.test.ts`

- [ ] **Step 1: Write failing store tests**

```ts
it("quarantines idempotently and clears only the current owner's conflict", () => {
  store.quarantine(input({ stage: "content_digest", revision: 2 }));
  store.quarantine(input({ stage: "content_digest", revision: 2 }));
  expect(store.get(ORGANIZATION_ID, SUBMISSION_ID)).toMatchObject({
    stage: "content_digest",
    state: "quarantined",
    referenceRevision: 2,
  });
  expect(store.clear(ORGANIZATION_ID, SUBMISSION_ID)).toBe(true);
  expect(otherOwnerStore.get(ORGANIZATION_ID, SUBMISSION_ID)).toBeNull();
});

it("detaches only the link and preserves draft/publication rows", () => {
  const before = snapshotBusinessRows(database);
  store.detach({
    organizationId: ORGANIZATION_ID,
    submissionId: SUBMISSION_ID,
    expectedReferenceRevision: 2,
  });
  expect(activeReference(database)).toBeUndefined();
  expect(snapshotBusinessRows(database)).toEqual(before);
  expect(store.get(ORGANIZATION_ID, SUBMISSION_ID)?.state).toBe("detached");
});
```

- [ ] **Step 2: Run and verify RED**

Run: `npx vitest run src/main/agentera-agent-control/organization-submission-reference-store.test.ts`

Expected: FAIL because the store is absent.

- [ ] **Step 3: Implement owner-scoped transactions**

Expose `get`, `quarantine`, `clear`, and `detach`. Resolve the reference through a join to `agent_drafts` with the current tenant/owner and Organization. `quarantine` upserts timestamps/stage without altering the reference. `detach` uses `BEGIN IMMEDIATE`, compares the expected Cloud/reference revision, marks conflict state `detached`, deletes exactly the matching link, and commits. Any missing/changed row rolls back with `organization_submission_reference_conflict`.

- [ ] **Step 4: Verify GREEN**

Run: `npx vitest run src/main/agentera-agent-control/organization-submission-reference-store.test.ts`

Expected: PASS with no draft, Version, Installation, Profile, or Runtime row changes.

- [ ] **Step 5: Commit**

```bash
git add src/main/agentera-agent-control/organization-submission-reference-store.ts src/main/agentera-agent-control/organization-submission-reference-store.test.ts
git commit -m "feat(organizations): quarantine submission link conflicts"
```

### Task 4: Reconcile every Cloud submission independently

**Files:**

- Modify: `src/main/agentera-agent-control/organization-publication-service.ts`
- Modify: `src/main/agentera-agent-control/organization-publication-service.test.ts`

- [ ] **Step 1: Replace the batch-fatal regression with failing isolation tests**

```ts
it("returns healthy and digest-conflicted submissions together", async () => {
  listSubmissions.mockResolvedValue([
    pendingDetail({ id: HEALTHY_SUBMISSION_ID }),
    approvedDetail({ id: SUBMISSION_ID, content_digest: WRONG_DIGEST }),
  ]);
  const result = await publication.listSubmissionList();
  expect(result.submissions).toHaveLength(2);
  expect(
    result.submissions.find((item) => item.id === SUBMISSION_ID),
  ).toMatchObject({
    localDraftId: null,
    referenceState: { kind: "quarantined", stage: "content_digest" },
  });
  expect(
    result.submissions.find((item) => item.id === HEALTHY_SUBMISSION_ID),
  ).toMatchObject({ referenceState: { kind: "remote_only" } });
});

it("omits one malformed Cloud row without hiding valid rows", async () => {
  listSubmissions.mockResolvedValue([approvedDetail(), malformedDetail()]);
  const result = await publication.listSubmissionList();
  expect(result.submissions).toHaveLength(1);
  expect(result.issues).toEqual([
    { submissionId: MALFORMED_SUBMISSION_ID, code: "cloud_record_invalid" },
  ]);
});
```

Use `it.each` for all six conflict stages and assert safe output.

- [ ] **Step 2: Run and verify RED**

Run: `npx vitest run src/main/agentera-agent-control/organization-publication-service.test.ts -t "digest-conflicted|malformed Cloud row"`

Expected: FAIL because `values.map()` still throws on the first conflict.

- [ ] **Step 3: Split validation and reconciliation**

Replace `refreshSubmissionReference()` with `reconcileSubmissionReference()` returning `SubmissionReferenceState`. Add `listSubmissionList(): Promise<OrganizationAgentSubmissionList>` for the new envelope, while retaining `listSubmissions(): Promise<OrganizationAgentSubmissionSummary[]>` as a compatibility wrapper that returns `listSubmissionList().submissions`. Catch only the exact local-reference failure class per item, write its bounded quarantine stage, and continue. Keep authentication, Organization identity, top-level response, and request failures batch-fatal.

For a verified reference, execute `recordPublishedRevision` and the reference CAS in one per-item transaction, then clear a prior quarantine. A missing draft remains `remote_only`. Do not change stored digest/definition/revision to match Cloud.

- [ ] **Step 4: Verify GREEN and existing review flows**

Run: `npx vitest run src/main/agentera-agent-control/organization-publication-service.test.ts`

Expected: PASS, including submit, approve, reject, withdraw, superseded revision, and cross-account tests.

- [ ] **Step 5: Commit**

```bash
git add src/main/agentera-agent-control/organization-publication-service.ts src/main/agentera-agent-control/organization-publication-service.test.ts
git commit -m "fix(organizations): isolate submission reference drift"
```

### Task 5: Add confirmed detach through Manager and the strict IPC contract

**Files:**

- Modify: `src/main/agentera-agent-control/manager.ts`
- Modify: `src/main/agentera-agent-control/manager.test.ts`
- Modify: `src/main/agentera-agent-control/organization-submission-reference-store.ts`
- Modify: `src/main/agentera-agent-control/ipc-contract.ts`
- Modify: `src/main/agentera-agent-control/ipc-contract.test.ts`

- [ ] **Step 1: Write failing authorization and preservation tests**

```ts
it("requires exact confirmation and returns the Cloud row as remote-only", async () => {
  await expect(
    manager.disconnectOrganizationSubmissionReference({
      submissionId: SUBMISSION_ID,
      confirmation: "wrong" as never,
    }),
  ).rejects.toMatchObject({ code: "invalid_request" });

  const result = await manager.disconnectOrganizationSubmissionReference({
    submissionId: SUBMISSION_ID,
    confirmation: "disconnect-local-draft-link",
  });
  expect(result.referenceState).toEqual({ kind: "remote_only" });
  expect(drafts.getDraft(DRAFT_ID)).toEqual(BEFORE_DRAFT);
});
```

- [ ] **Step 2: Run and verify RED**

Run: `npx vitest run src/main/agentera-agent-control/manager.test.ts -t "disconnect.*submission"`

Expected: FAIL because the mutation does not exist.

- [ ] **Step 3: Implement guarded detach**

Require online Organization Owner/Admin access, canonical UUID, exact confirmation, and a fresh Cloud detail read. Reconcile once; allow detach only when that exact row is still quarantined. Call the store transaction, then return `summaryFromRecord()` with `referenceState: { kind: "remote_only" }` in the new list-item shape. Map stale/detach failures to `organization_submission_reference_detach_failed` without raw database details.

- [ ] **Step 4: Verify GREEN**

Run: `npx vitest run src/main/agentera-agent-control/manager.test.ts src/main/agentera-agent-control/ipc-contract.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/agentera-agent-control/manager.ts src/main/agentera-agent-control/manager.test.ts src/main/agentera-agent-control/organization-submission-reference-store.ts src/main/agentera-agent-control/ipc-contract.ts src/main/agentera-agent-control/ipc-contract.test.ts
git commit -m "feat(organizations): detach stale local submission links"
```

### Task 6: Expose the envelope compatibly and render one list and one item warning

**Files:**

- Modify: `src/renderer/src/screens/Agents/AgentControlPanel.tsx`
- Modify: `src/renderer/src/screens/Agents/AgentControlPanel.test.tsx`
- Modify: `src/renderer/src/screens/Agents/OrganizationSubmissionPanel.tsx`
- Modify: `src/renderer/src/screens/Agents/OrganizationSubmissionPanel.test.tsx`
- Modify: `src/main/ipc/register.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/preload/index.d.ts`
- Modify: `src/main/agentera-agent-control/manager.ts`
- Modify: `src/main/agentera-agent-control/ipc-contract.ts`
- Modify: `src/main/agentera-agent-control/ipc-contract.test.ts`
- Modify: `src/main/ipc/auth-guard.ts`
- Modify: `tests/agentera-agent-control-ipc.test.ts`
- Modify: `tests/agentera-ipc-auth-guard.test.ts`
- Modify: `tests/ipc-handlers.test.ts`
- Modify: `tests/preload-api-surface.test.ts`
- Modify: `src/shared/i18n/locales/en/agents.ts`
- Modify: `src/shared/i18n/locales/zh-CN/agents.ts`

- [ ] **Step 1: Write failing single-request and warning tests**

```ts
it("lists once and renders one warning on only the quarantined card", async () => {
  api.listOrganizationSubmissionList.mockResolvedValue(
    success({
      submissions: [healthySubmission(), quarantinedSubmission()],
      issues: [],
    }),
  );
  render(<AgentControlPanel initialTab="enterprise" {...ownerProps()} />);
  expect(await screen.findByText(healthySubmission().contentDigest)).toBeVisible();
  expect(screen.getByText(quarantinedSubmission().contentDigest)).toBeVisible();
  expect(
    screen.getAllByText("agents.control.organization.referenceConflict"),
  ).toHaveLength(1);
  expect(api.listOrganizationSubmissionList).toHaveBeenCalledTimes(1);
});
```

Add a panel test that clicks disconnect, displays a confirmation dialog, sends the exact literal, and replaces the card state with `remote_only` without re-listing twice.

Add static bridge tests that prove the new list/detach channel names appear exactly once in Main and preload, the deprecated Beta.26 array channel remains present, the new envelope return is parsed through `publicOrganizationSubmissionList()`, and detach is guarded as an Organization Owner/Admin mutation rather than a renderer-only role check.

- [ ] **Step 2: Run and verify RED**

Run: `npx vitest run src/renderer/src/screens/Agents/AgentControlPanel.test.tsx src/renderer/src/screens/Agents/OrganizationSubmissionPanel.test.tsx tests/agentera-agent-control-ipc.test.ts tests/agentera-ipc-auth-guard.test.ts tests/ipc-handlers.test.ts tests/preload-api-surface.test.ts -t "lists once|disconnect|organization submission"`

Expected: FAIL because the child still calls `listOrganizationSubmissions()`.

- [ ] **Step 3: Lift list ownership and add card actions**

Add `listOrganizationSubmissionList()` to Manager, register a new `agentera-agents-list-organization-submission-list` channel, and add the matching preload method. Register `agentera-agents-disconnect-organization-submission-reference` with `parseDisconnectOrganizationSubmissionReferenceInput()` and expose `disconnectOrganizationSubmissionReference(input)` in preload. Register the read channel under the existing signed-in Organization read boundary and the detach channel under the Owner/Admin mutation boundary in `auth-guard.ts`; Main re-checks the live role before mutation. Keep the existing `listOrganizationSubmissions()` array channel as a deprecated Beta.26 compatibility bridge. `AgentControlPanel` calls only the new envelope method, stores `organizationSubmissionIssues` beside the parent submissions, and passes `submissions`, `issues`, `loading`, `onRefresh`, and `onDisconnect` to the child. Remove the child's `load()` callback/effect and every list bridge call. Continue submission-before-draft ordering in the parent. Render one warning on `quarantined`, keep review/withdraw controls governed by Cloud status, and show disconnect only to Owner/Admin after explicit confirmation.

- [ ] **Step 4: Verify GREEN and no duplicate request**

Run: `npx vitest run src/renderer/src/screens/Agents/AgentControlPanel.test.tsx src/renderer/src/screens/Agents/OrganizationSubmissionPanel.test.tsx src/main/agentera-agent-control/ipc-contract.test.ts tests/agentera-agent-control-ipc.test.ts tests/agentera-ipc-auth-guard.test.ts tests/ipc-handlers.test.ts tests/preload-api-surface.test.ts && npm run typecheck`

Expected: PASS; every initial load/refresh performs one list call.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/screens/Agents/AgentControlPanel.tsx src/renderer/src/screens/Agents/AgentControlPanel.test.tsx src/renderer/src/screens/Agents/OrganizationSubmissionPanel.tsx src/renderer/src/screens/Agents/OrganizationSubmissionPanel.test.tsx src/main/ipc/register.ts src/main/ipc/auth-guard.ts src/preload/index.ts src/preload/index.d.ts src/main/agentera-agent-control/manager.ts src/main/agentera-agent-control/ipc-contract.ts src/main/agentera-agent-control/ipc-contract.test.ts src/shared/i18n/locales/en/agents.ts src/shared/i18n/locales/zh-CN/agents.ts tests/agentera-agent-control-ipc.test.ts tests/agentera-ipc-auth-guard.test.ts tests/ipc-handlers.test.ts tests/preload-api-surface.test.ts
git commit -m "fix(organizations): show isolated submission conflicts once"
```

### Task 7: Document and verify the Organization slice

**Files:**

- Modify: `lat.md/agentera-organizations.md`
- Modify: `lat.md/agentera-agent-control-plane.md`

- [ ] **Step 1: Add exact behavior and test references**

Document per-item validation, quarantine stages, exact automatic repair, confirmed detach, one-list ownership, and schema privacy. Add one `@lat:` code reference beside each primary test.

- [ ] **Step 2: Run focused gates**

```bash
npx vitest run \
  src/main/agentera-agent-control/db.test.ts \
  tests/agentera-agent-control-db.test.ts \
  src/main/agentera-agent-control/organization-submission-reference-store.test.ts \
  src/main/agentera-agent-control/organization-publication-service.test.ts \
  src/main/agentera-agent-control/manager.test.ts \
  src/main/agentera-agent-control/ipc-contract.test.ts \
  src/renderer/src/screens/Agents/AgentControlPanel.test.tsx \
  src/renderer/src/screens/Agents/OrganizationSubmissionPanel.test.tsx \
  tests/agentera-agent-control-ipc.test.ts \
  tests/agentera-ipc-auth-guard.test.ts \
  tests/ipc-handlers.test.ts \
  tests/preload-api-surface.test.ts
npm run typecheck
npx prettier --check \
  src/main/agentera-agent-control/db.ts \
  src/main/agentera-agent-control/organization-submission-reference-store*.ts \
  src/main/agentera-agent-control/organization-publication-service*.ts \
  src/renderer/src/screens/Agents/AgentControlPanel.tsx \
  src/renderer/src/screens/Agents/OrganizationSubmissionPanel.tsx \
  lat.md/agentera-organizations.md lat.md/agentera-agent-control-plane.md
npm exec --yes --package=lat.md@0.12.1 -- lat check
git diff --check
```

Expected: every command exits 0.

- [ ] **Step 3: Commit documentation**

```bash
git add lat.md/agentera-organizations.md lat.md/agentera-agent-control-plane.md
git commit -m "docs(organizations): record submission conflict quarantine"
```

- [ ] **Step 4: Record the exact slice head**

Run: `git status --short --branch && git rev-parse HEAD`

Expected: clean worktree; retain the SHA for integration without claiming live Cloud repair or Beta.27 publication.
