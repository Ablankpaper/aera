# Durable Agent Version Cache Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the account-scoped verified Agent version cache automatically converge after filesystem/SQLite interruption and expose bounded actionable cache failures through publication, IPC, and UI.

**Architecture:** Treat the signed version JSON and immutable directory as two independently recoverable durable representations. Reverify either surviving side before rebuilding the other, retain a verified destination after database failure, and serialize adoption through atomic rename plus `BEGIN IMMEDIATE` without adding a general saga framework.

**Tech Stack:** Electron main process, TypeScript, Node filesystem APIs, Node `DatabaseSync` SQLite, Vitest, existing Ed25519 trust/canonicalization code, LAT.

---

### Task 1: Prove row-only and directory-only crash recovery

**Files:**

- Modify: `src/main/agentera-agent-control/version-cache.test.ts`
- Modify: `src/main/agentera-agent-control/version-cache.ts`

- [ ] **Step 1: Add failure-first tests for both asymmetric states**

Add two tests beside the existing immutable-cache tests. The first caches a signed version, deletes its SQLite row, creates a new cache instance, and expects `getVerifiedVersion` to recreate exactly one row from the immutable directory. The second caches a version, removes only the immutable directory, creates a new cache instance, and expects `getVerifiedVersion` to rebuild read-only files while preserving the row.

Use the real database and trust fixture. Derive the directory from the persisted `cache_relative_path`; never hard-code a private absolute path in an assertion.

```ts
it("recovers a verified directory that has no SQLite row after cold restart", () => {
  const { version } = signedFixture();
  cache.cacheVerifiedVersion(version);
  database.sqlite
    .prepare("DELETE FROM cached_agent_versions WHERE version_id = ?")
    .run(version.id);

  const restarted = makeCache();
  expect(restarted.getVerifiedVersion(version.id)).toEqual(version);
  expect(
    database.sqlite
      .prepare(
        "SELECT count(*) AS count FROM cached_agent_versions WHERE version_id = ?",
      )
      .get(version.id),
  ).toEqual({ count: 1 });
});

it("rebuilds a missing immutable directory from a verified SQLite row", () => {
  const { version } = signedFixture();
  cache.cacheVerifiedVersion(version);
  const row = database.sqlite
    .prepare(
      "SELECT cache_relative_path FROM cached_agent_versions WHERE version_id = ?",
    )
    .get(version.id) as { cache_relative_path: string };
  const directory = join(
    database.paths.versionsPath,
    ...row.cache_relative_path.split("/"),
  );
  makeTreeWritable(directory);
  rmSync(directory, { recursive: true, force: true });

  const restarted = makeCache();
  expect(restarted.getVerifiedVersion(version.id)).toEqual(version);
  expect(lstatSync(directory).mode & 0o222).toBe(0);
});
```

- [ ] **Step 2: Run the new tests and verify the intended failures**

Run:

```bash
npx vitest run src/main/agentera-agent-control/version-cache.test.ts
```

Expected: the directory-only test fails with `cache_not_found`; the row-only test fails with `cache_corrupt` or `ENOENT` because recovery is not implemented.

- [ ] **Step 3: Extract validated row and path helpers**

In `version-cache.ts`, add a private validated representation and helpers that preserve legacy paths but generate only account-scoped new paths:

```ts
interface ValidatedCachedVersionRow {
  relativePath: string;
  version: AgentVersion;
  verifiedAt: string;
  policySnapshotJson: string | null;
}

private readRow(versionId: string): ValidatedCachedVersionRow | null;
private accountVersionRoot(versionId: string): string;
private relativePath(version: AgentVersion): string;
```

`readRow` must validate every existing column, parse `version_json` through `parseStoredVersion`, verify row/version ID, definition, number, digest, and JSON equality, then re-run the trust and canonical digest checks. It throws `cache_corrupt` for invalid stored data and maps SQLite failures to `cache_database_failed`.

- [ ] **Step 4: Implement on-demand reconstruction**

Add focused helpers:

```ts
private ensureImmutableDirectory(
  version: AgentVersion,
  relativePath: string,
  replaceInvalid: boolean,
): AgentVersion;

private recoverDirectoryOnly(versionId: string): AgentVersion;

private persistVersionRow(
  version: AgentVersion,
  relativePath: string,
  policySnapshotJson?: string | null,
): void;
```

`getVerifiedVersion` uses `readRow`. With a row, it calls `ensureImmutableDirectory` using the row JSON. Without a row, it removes only recognized staging trees, accepts exactly one digest-named read-only directory that passes `verifyDirectory`, inserts the row, and re-reads normally.

- [ ] **Step 5: Run focused and existing policy tests**

Run:

```bash
npx vitest run src/main/agentera-agent-control/version-cache.test.ts
```

Expected: all version-cache tests pass, including account isolation, permission rejection, signature/digest checks, and policy snapshot retention.

- [ ] **Step 6: Commit the first recovery slice**

```bash
git add src/main/agentera-agent-control/version-cache.ts src/main/agentera-agent-control/version-cache.test.ts
git commit -m "fix: recover interrupted Agent version caches"
```

### Task 2: Retain verified bytes across SQLite failure and converge under races

**Files:**

- Modify: `src/main/agentera-agent-control/version-cache.test.ts`
- Modify: `src/main/agentera-agent-control/version-cache.ts`

- [ ] **Step 1: Add a real deferred-commit failure test**

Create temporary parent/child tables with a deferred foreign key and an `AFTER INSERT` trigger on `cached_agent_versions`. The cache rename and insert succeed, but `COMMIT` fails. Assert the result is `cache_database_failed`, the row is absent after rollback, the verified immutable directory remains, and a retry after dropping the trigger recovers without a second Cloud publication.

```sql
CREATE TABLE cache_commit_parent (id INTEGER PRIMARY KEY);
CREATE TABLE cache_commit_child (
  id INTEGER,
  FOREIGN KEY (id) REFERENCES cache_commit_parent(id)
    DEFERRABLE INITIALLY DEFERRED
);
CREATE TRIGGER fail_cache_commit
AFTER INSERT ON cached_agent_versions
BEGIN
  INSERT INTO cache_commit_child (id) VALUES (1);
END;
```

- [ ] **Step 2: Verify the current implementation fails the postcondition**

Run the single test with Vitest `-t`.

Expected: current code removes the renamed destination or leaks a raw SQLite error instead of retaining a recoverable directory with `cache_database_failed`.

- [ ] **Step 3: Add stale staging and rename-race tests**

Add tests that:

- create `.staging-<uuid>` under the exact account/version root and verify the next operation removes it;
- inject `EACCES` and `EPERM` from `rename` and expect `cache_filesystem_denied` with no database row;
- interleave two cache instances by letting the injected rename callback complete the winning cache operation before the losing rename returns `EEXIST`; both calls must return the same version and leave one row/directory;
- create a second digest-named directory and expect `cache_conflict` rather than deletion or adoption.

- [ ] **Step 4: Verify every new test fails for the intended reason**

Run:

```bash
npx vitest run src/main/agentera-agent-control/version-cache.test.ts
```

Expected: failures identify missing stable system-error mapping, destination retention, staging cleanup, and rename-loser convergence.

- [ ] **Step 5: Implement bounded failure mapping and idempotent adoption**

Add these lower-level codes:

```ts
| "cache_filesystem_denied"
| "cache_filesystem_failed"
| "cache_database_failed"
| "cache_recovery_failed"
```

Add one mapper that never includes the original message or path:

```ts
function cacheFailure(
  error: unknown,
  fallback: AgentVersionCacheErrorCode,
): AgentVersionCacheError {
  if (error instanceof AgentVersionCacheError) return error;
  const code = systemErrorCode(error);
  if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
    return new AgentVersionCacheError("cache_filesystem_denied");
  }
  if (code === "EEXIST" || code === "ENOTEMPTY") {
    return new AgentVersionCacheError("cache_conflict");
  }
  if (code.startsWith("ERR_SQLITE_") || code.startsWith("SQLITE_")) {
    return new AgentVersionCacheError("cache_database_failed");
  }
  if (code.length > 0)
    return new AgentVersionCacheError("cache_filesystem_failed");
  return new AgentVersionCacheError(fallback);
}
```

After a successful final-directory verification, database failure must not remove that destination. A rename collision must clean only the caller's staging path, verify the winning destination, and continue to `persistVersionRow`.

- [ ] **Step 6: Run the full cache suite and repeat the failure regression**

Run:

```bash
npx vitest run src/main/agentera-agent-control/version-cache.test.ts
```

Expected: all tests pass. Temporarily reverting destination retention must make the deferred-commit regression fail; restore the fix and rerun to green before committing.

- [ ] **Step 7: Commit concurrency and failure recovery**

```bash
git add src/main/agentera-agent-control/version-cache.ts src/main/agentera-agent-control/version-cache.test.ts
git commit -m "fix: converge Agent cache filesystem and database state"
```

### Task 3: Preserve exact safe cache failures through publication and IPC

**Files:**

- Modify: `src/main/agentera-agent-control/publisher.test.ts`
- Modify: `src/main/agentera-agent-control/publisher.ts`
- Modify: `src/main/agentera-agent-control/ipc-contract.test.ts`
- Modify: `src/main/agentera-agent-control/ipc-contract.ts`
- Modify: `src/shared/agentera-agent-control.ts`
- Modify: `src/shared/i18n/locales/zh-CN/agents.ts`
- Modify: `src/shared/i18n/locales/en/agents.ts`

- [ ] **Step 1: Add publisher and IPC failure-first tables**

For every lower cache failure, assert the publisher throws the corresponding public code and the draft stores the lower stable code with a fixed summary:

```ts
const cacheFailures = [
  ["cache_conflict", "publication_cache_conflict"],
  ["cache_corrupt", "publication_cache_corrupt"],
  ["cache_permissions_invalid", "publication_cache_permissions_invalid"],
  ["cache_filesystem_denied", "publication_cache_filesystem_denied"],
  ["cache_filesystem_failed", "publication_cache_filesystem_failed"],
  ["cache_database_failed", "publication_cache_database_failed"],
  ["cache_recovery_failed", "publication_cache_recovery_failed"],
] as const;
```

Use the same table in `ipc-contract.test.ts` to ensure `executeAgentControlIpc` returns the exact public code and omits the private exception message.

- [ ] **Step 2: Run publisher and IPC tests and verify generic-code failures**

Run:

```bash
npx vitest run src/main/agentera-agent-control/publisher.test.ts src/main/agentera-agent-control/ipc-contract.test.ts
```

Expected: the existing code returns `publication_cache_failed` or generic `conflict` instead of the expected exact codes.

- [ ] **Step 3: Implement the explicit public mapping**

Add the seven `publication_cache_*` codes to `AgenteraAgentControlErrorCode`. In `publisher.ts`, translate only recognized lower cache codes; unknown exceptions remain `publication_cache_failed`. Update `stableFailureSummary` with fixed summaries and keep `recordFailure` on the lower code.

In `mappedCode`, handle exact public and lower cache codes before the general `code.includes("conflict")` branch. Do not return raw platform codes.

- [ ] **Step 4: Add localized bounded guidance**

Add Chinese and English messages for conflict, corruption, immutable-permission failure, OS denial, filesystem failure, SQLite failure, and incomplete recovery. Messages may advise retry/restart but must not expose or ask the user to delete a path or cache.

- [ ] **Step 5: Verify tests and type coverage**

Run:

```bash
npx vitest run src/main/agentera-agent-control/publisher.test.ts src/main/agentera-agent-control/ipc-contract.test.ts
npm run typecheck
```

Expected: both commands exit 0.

- [ ] **Step 6: Commit the public error boundary**

```bash
git add src/main/agentera-agent-control/publisher.ts src/main/agentera-agent-control/publisher.test.ts src/main/agentera-agent-control/ipc-contract.ts src/main/agentera-agent-control/ipc-contract.test.ts src/shared/agentera-agent-control.ts src/shared/i18n/locales/zh-CN/agents.ts src/shared/i18n/locales/en/agents.ts
git commit -m "fix: expose bounded Agent cache recovery failures"
```

### Task 4: Bind architecture and recovery tests into LAT

**Files:**

- Modify: `lat.md/agentera-agent-control-plane.md`
- Modify: `src/main/agentera-agent-control/version-cache.test.ts`

- [ ] **Step 1: Add a durable cache section**

Under `Immutable publication`, add `### Durable local version cache` with a concise leading paragraph. Document row-only/directory-only recovery, destination retention after SQLite failure, rename-winner convergence, account ownership, and fail-closed trust constraints.

- [ ] **Step 2: Add one exact `@lat` reference**

Attach the new section to the cold-restart recovery test:

```ts
// @lat: [[agentera-agent-control-plane#Immutable publication#Durable local version cache]]
```

- [ ] **Step 3: Run LAT and formatting checks**

Run:

```bash
lat check
npx prettier --check src/main/agentera-agent-control/version-cache.ts src/main/agentera-agent-control/version-cache.test.ts src/main/agentera-agent-control/publisher.ts src/main/agentera-agent-control/publisher.test.ts src/main/agentera-agent-control/ipc-contract.ts src/main/agentera-agent-control/ipc-contract.test.ts src/shared/agentera-agent-control.ts src/shared/i18n/locales/zh-CN/agents.ts src/shared/i18n/locales/en/agents.ts lat.md/agentera-agent-control-plane.md docs/superpowers/specs/2026-08-03-agent-version-cache-recovery-design.md docs/superpowers/plans/2026-08-03-agent-version-cache-recovery.md
```

Expected: both commands exit 0.

- [ ] **Step 4: Commit LAT evidence**

```bash
git add lat.md/agentera-agent-control-plane.md src/main/agentera-agent-control/version-cache.test.ts
git commit -m "docs: bind durable Agent cache recovery evidence"
```

### Task 5: Run the complete local Desktop gate

**Files:**

- Verify only; do not change unrelated failures without first proving they are caused by this branch.

- [ ] **Step 1: Run focused failure suites**

```bash
npx vitest run src/main/agentera-agent-control/version-cache.test.ts src/main/agentera-agent-control/publisher.test.ts src/main/agentera-agent-control/ipc-contract.test.ts src/main/agentera-agent-control/installation-manager.test.ts
```

- [ ] **Step 2: Run all unit tests, typecheck, lint, contract checks, and build**

```bash
npm test
npm run typecheck
npm run lint
npm run check:agentera-cloud-contract
npm run build
lat check
```

Every command must exit 0. Experimental Node SQLite warnings are baseline warnings, not test failures.

- [ ] **Step 3: Audit the final diff and repository state**

```bash
git diff origin/main...HEAD --check
git diff origin/main...HEAD --stat
git status --short --branch
```

Confirm that the branch changes only the cache, publication/IPC/UI error boundary, tests, specification, plan, and LAT section. Confirm package version and Runtime Seed locks remain unchanged.

- [ ] **Step 4: Commit any verified formatting-only corrections separately**

Use a scoped commit only if the full gate required formatting changes. Do not squash functional evidence into an unrelated file.

- [ ] **Step 5: Push the branch and open the Desktop cache-recovery PR**

Push `aera/agent-version-cache-recovery`, open a PR targeting `main`, wait for exact-head CI and review, address only evidence-backed findings, then merge. After merge, wait for merged-main CI on the resulting exact SHA before starting the Profile/Binding coordinator branch.
