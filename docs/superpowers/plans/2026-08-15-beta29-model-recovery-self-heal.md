# Beta.29 Model Recovery Self-Heal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make model-configuration rollback read fresh disk state and automatically reconcile exact Beta.28 `recovery_required` rows without weakening fail-closed protection.

**Architecture:** Add one narrow fresh model-config read in `config.ts` and use it only at the transactional active-route boundary. Change cold recovery to classify exact after/new and before/old states before attempting backup restore; all mixed or unverifiable states continue to lock the Profile.

**Tech Stack:** TypeScript, Electron Main process, Node filesystem and SQLite, Vitest, `lat.md`.

---

## File map

- `src/main/config.ts`: own the five-second model-config cache and expose a narrow fresh read.
- `tests/config-model-block.test.ts`: prove fresh reads bypass a primed cache after an external/raw file replacement.
- `src/main/model-configuration-runtime.ts`: make coordinator route verification use the fresh config boundary.
- `src/main/model-configuration-runtime.test.ts`: exercise real config files, cache, coordinator rollback, and journal together.
- `src/main/model-configuration-coordinator.ts`: reconcile existing exact terminal states before backup restore.
- `src/main/model-configuration-coordinator.test.ts`: cover exact before/old, exact after/new, and ambiguous fail-closed recovery rows.
- `lat.md/beta27-reliability-plan.md`: record cache-independent rollback and deterministic recovery reconciliation.

### Task 1: Fresh model-config read boundary

**Files:**

- Modify: `tests/config-model-block.test.ts`
- Modify: `src/main/config.ts:236-259,771-799,1013-1032`

- [ ] **Step 1: Write the failing cache-bypass test**

Add this test under `describe("getModelConfig — scoped to model: block", ...)`:

```ts
// @lat: [[beta27-reliability-plan#Recoverable model configuration#Transactional route reads bypass cache]]
it("reads restored model bytes without waiting for the presentation cache", async () => {
  const configPath = join(TEST_DIR, "config.yaml");
  writeFileSync(
    configPath,
    ["model:", '  default: "attempted"', '  provider: "custom:new"', ""].join(
      "\n",
    ),
  );

  const { getModelConfig, getModelConfigFresh } =
    await importConfigWithHome(TEST_DIR);
  expect(getModelConfig().model).toBe("attempted");

  writeFileSync(
    configPath,
    ["model:", '  default: "restored"', '  provider: "custom:old"', ""].join(
      "\n",
    ),
  );

  expect(getModelConfig().model).toBe("attempted");
  expect(getModelConfigFresh()).toEqual({
    provider: "custom:old",
    model: "restored",
    baseUrl: "",
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
npx vitest run tests/config-model-block.test.ts -t "reads restored model bytes" --reporter=dot
```

Expected: FAIL because `getModelConfigFresh` does not exist.

- [ ] **Step 3: Implement the narrow fresh-read API**

In `src/main/config.ts`, keep the generic cache private and add:

```ts
export function invalidateModelConfigCache(profile?: string): void {
  invalidateCache(`mc:${profile || "default"}`);
}

export function getModelConfigFresh(profile?: string): {
  provider: string;
  model: string;
  baseUrl: string;
} {
  invalidateModelConfigCache(profile);
  return getModelConfig(profile);
}
```

Replace the direct `invalidateCache` call at the start of `setModelConfig()` with `invalidateModelConfigCache(profile)` so all model-cache invalidation uses the same boundary.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
npx vitest run tests/config-model-block.test.ts --reporter=dot
```

Expected: the file passes, including the new immediate fresh-read test.

- [ ] **Step 5: Commit Task 1**

```bash
git add src/main/config.ts tests/config-model-block.test.ts
git commit -m "fix(models): expose fresh transactional config reads"
```

### Task 2: Cache-safe real rollback verification

**Files:**

- Modify: `src/main/model-configuration-runtime.test.ts`
- Modify: `src/main/model-configuration-runtime.ts:20-28,214-235,295-302`

- [ ] **Step 1: Write the failing runtime rollback regression**

Add this runtime test, which uses a temporary `HERMES_HOME`, real binding store, real config writers, real journal, and a mocked route-list read returning no new route so final verification fails after activation:

```ts
// @lat: [[beta27-reliability-plan#Recoverable model configuration#Rollback verification reads restored route]]
it("verifies the restored route instead of the attempted cached route", async () => {
  const root = mkdtempSync(join(tmpdir(), "aera-model-runtime-rollback-"));
  roots.push(root);
  const hermesHome = join(root, "hermes");
  const userData = join(root, "user-data");
  mkdirSync(hermesHome, { recursive: true });
  process.env.HERMES_HOME = hermesHome;
  vi.resetModules();
  vi.doUnmock("./installer");
  const actualInstaller =
    await vi.importActual<typeof import("./installer")>("./installer");
  vi.doMock("./installer", () => actualInstaller);
  const actualRoutes = await vi.importActual<
    typeof import("./agentera-agent-control/runtime-model-routes")
  >("./agentera-agent-control/runtime-model-routes");
  vi.doMock("./agentera-agent-control/runtime-model-routes", () => ({
    ...actualRoutes,
    listResolvedAgentRuntimeModelRoutes: vi.fn(() => []),
  }));

  const [{ AgenteraProfileBindingStore }, runtime, config, modelDatabase] =
    await Promise.all([
      import("./agentera-profile-binding"),
      import("./model-configuration-runtime"),
      import("./config"),
      import("./model-configuration-database"),
    ]);
  config.setModelConfig(
    "custom:old",
    "old-model",
    "https://old.invalid/v1",
    "default",
    null,
    "chat_completions",
  );
  const beforeConfig = readFileSync(join(hermesHome, "config.yaml"), "utf8");
  const bindings = new AgenteraProfileBindingStore({
    userDataPath: userData,
    secureStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => Buffer.from(value, "utf8"),
      decryptString: (value: Buffer) => value.toString("utf8"),
    },
  });
  bindings.bindExistingProfile(hermesHome, OWNER);
  const handle = await runtime.prepareModelConfigurationRuntime({
    userDataPath: userData,
    getOwner: () => OWNER,
    profileBindings: bindings,
    getConnectionConfig: () => ({ mode: "local" }),
    openDatabase: (path) =>
      modelDatabase.openModelConfigurationDatabase(path, {
        databaseFactory: (databasePath) =>
          new DatabaseSync(
            databasePath,
          ) as unknown as ModelConfigurationSqliteDatabase,
      }),
  });

  try {
    const before = handle.catalog!.snapshot("default");
    const result = await handle.coordinator!.mutate({
      intent: "upsert",
      expectedCatalogRevision: before.revision,
      requestedProfileId: "default",
      provider: "custom",
      providerLabel: "New",
      baseUrl: "https://new.invalid/v1",
      apiMode: "chat_completions",
      apiKey: SECRET,
      models: [{ model: "new-model", displayName: "New Model" }],
      activeModel: "new-model",
    });

    expect(result).toMatchObject({
      status: "rejected",
      stage: "verification",
      rollback: "restored",
    });
    expect(readFileSync(join(hermesHome, "config.yaml"), "utf8")).toBe(
      beforeConfig,
    );
    expect(config.getModelConfigFresh("default")).toMatchObject({
      provider: "custom:old",
      model: "old-model",
    });
    expect(handle.operationStore!.listIncomplete()).toEqual([]);
  } finally {
    handle.close();
    vi.doUnmock("./agentera-agent-control/runtime-model-routes");
  }
});
```

Use `vi.doMock("./agentera-agent-control/runtime-model-routes", ...)` before dynamically importing `model-configuration-runtime`, and restore module mocks in the existing `afterEach`. Populate the old route with `setModelConfig`; the mutation request supplies its own credential so no real key is used.

- [ ] **Step 2: Run the runtime test and verify RED**

Run:

```bash
npx vitest run src/main/model-configuration-runtime.test.ts -t "verifies the restored route" --reporter=dot
```

Expected: FAIL with `stage: "recovery"` / `rollback: "recovery_required"`, proving the stale attempted route is read after disk restoration.

- [ ] **Step 3: Use fresh configuration at the transaction boundary**

Import `getModelConfigFresh` and allow `activeRouteIdentity` to choose the reader:

```ts
function activeRouteIdentity(
  profileId: string,
  fresh = false,
): PublicModelRouteIdentity {
  const config = fresh
    ? getModelConfigFresh(profileId)
    : getModelConfig(profileId);
  // existing route resolution remains unchanged
}
```

Make the coordinator adapter fresh on every correctness read:

```ts
getActiveRouteKey: (profileId) =>
  canonicalPublicRouteKey(activeRouteIdentity(profileId, true)),
```

Do not change catalog/presentation reads that call `activeRouteIdentity(profileId)` without the fresh flag.

- [ ] **Step 4: Run config and runtime tests and verify GREEN**

Run:

```bash
npx vitest run tests/config-model-block.test.ts src/main/model-configuration-runtime.test.ts --reporter=dot
```

Expected: both files pass; the regression returns `verification/restored` immediately.

- [ ] **Step 5: Commit Task 2**

```bash
git add src/main/model-configuration-runtime.ts src/main/model-configuration-runtime.test.ts
git commit -m "fix(models): verify rollback routes from disk"
```

### Task 3: Reconcile existing recovery-required rows

**Files:**

- Modify: `src/main/model-configuration-coordinator.test.ts:569-680`
- Modify: `src/main/model-configuration-coordinator.ts:503-564`

- [ ] **Step 1: Write two failing legacy-row tests**

Add one helper in the test file to set every fixture file to the attempted state, then add these separate tests:

```ts
// @lat: [[beta27-reliability-plan#Recoverable model configuration#Exact restored recovery row self-heals]]
it("finishes an exact before/old recovery-required row as rolled back", async () => {
  const fixture = makeFixture();
  const operationId = "10000000-0000-4000-8000-000000000102";
  const snapshot = captureModelConfigurationFiles({
    profileId: "account",
    operationId,
    paths: fixture.paths,
  });
  persistModelConfigurationBackups(snapshot);
  fixture.store.begin({
    operationId,
    ownerHandle: OWNER,
    profileId: "account",
    oldRouteKey: OLD_ROUTE,
    newRouteKey: NEW_ROUTE,
    snapshot,
  });
  fixture.store.finish(operationId, "recovery_required");

  await subject(fixture).recoverIncompleteOperations();

  expect(fixture.store.require(operationId).state).toBe("rolled_back");
  expect(fixture.store.listIncomplete()).toEqual([]);
});

// @lat: [[beta27-reliability-plan#Recoverable model configuration#Exact committed recovery row self-heals]]
it("finishes an exact after/new recovery-required row as committed", async () => {
  const fixture = makeFixture();
  const operationId = "10000000-0000-4000-8000-000000000103";
  const snapshot = captureModelConfigurationFiles({
    profileId: "account",
    operationId,
    paths: fixture.paths,
  });
  persistModelConfigurationBackups(snapshot);
  fixture.store.begin({
    operationId,
    ownerHandle: OWNER,
    profileId: "account",
    oldRouteKey: OLD_ROUTE,
    newRouteKey: NEW_ROUTE,
    snapshot,
  });
  writeAttemptedState(fixture);
  fixture.store.advance({
    operationId,
    state: "verification",
    stage: "verification",
    afterDigests: readModelConfigurationFileDigests(fixture.paths),
  });
  fixture.store.finish(operationId, "recovery_required");

  await subject(fixture).recoverIncompleteOperations();

  expect(fixture.store.require(operationId).state).toBe("committed");
  expect(fixture.store.listIncomplete()).toEqual([]);
});
```

- [ ] **Step 2: Run both tests and verify RED**

Run:

```bash
npx vitest run src/main/model-configuration-coordinator.test.ts -t "recovery-required row" --reporter=dot
```

Expected: both tests FAIL because the existing `recovery_required` short-circuit leaves both rows incomplete.

- [ ] **Step 3: Implement deterministic terminal-state classification**

Remove the direct `record.state === "recovery_required"` return. After reading current digests and the fresh active route, classify exact terminal states before restore:

```ts
if (
  completeDigests(record.afterDigests) &&
  digestsEqual(currentDigests, record.afterDigests) &&
  activeRouteKey === record.newRouteKey
) {
  this.operationStore.finish(record.operationId, "committed");
  await this.removeBackupsSafely(snapshot);
  this.recoveryRequired.delete(lockKey);
  return;
}

if (
  digestsEqual(currentDigests, record.beforeDigests) &&
  activeRouteKey === record.oldRouteKey
) {
  this.operationStore.finish(record.operationId, "rolled_back");
  await this.removeBackupsSafely(snapshot);
  this.recoveryRequired.delete(lockKey);
  return;
}
```

Leave the existing exact backup restore and catch-to-`recovery_required` path unchanged for mixed or unverifiable state.

- [ ] **Step 4: Strengthen the ambiguous-state regression**

Extend `blocks later mutations when recovery evidence is tampered` to call `recoverIncompleteOperations()` a second time after the row has become `recovery_required`, then assert it remains locked. This proves the new reconciliation does not clear a mixed/tampered state.

- [ ] **Step 5: Run coordinator and runtime tests and verify GREEN**

Run:

```bash
npx vitest run src/main/model-configuration-coordinator.test.ts src/main/model-configuration-runtime.test.ts --reporter=dot
```

Expected: both files pass; exact rows terminate and tampered evidence remains `recovery_required`.

- [ ] **Step 6: Commit Task 3**

```bash
git add src/main/model-configuration-coordinator.ts src/main/model-configuration-coordinator.test.ts
git commit -m "fix(models): reconcile exact recovery-required rows"
```

### Task 4: Architecture contract and complete verification

**Files:**

- Modify: `lat.md/beta27-reliability-plan.md`
- Verify: all changed production and test files

- [ ] **Step 1: Document the recovery invariant**

Under `## Recoverable model configuration`, add the four test-spec leaf sections referenced by the tests:

```markdown
### Transactional route reads bypass cache

Commit, rollback, and cold-recovery route comparisons read current Profile bytes rather than the five-second presentation cache.

### Rollback verification reads restored route

After exact snapshot restoration, route verification observes the restored route immediately and cannot misclassify it from an attempted cached route.

### Exact restored recovery row self-heals

An owned row whose five files and route exactly equal before/old becomes `rolled_back`; mixed or unverifiable evidence remains locked.

### Exact committed recovery row self-heals

An owned row whose complete files and route exactly equal after/new becomes `committed`; no partial after state is accepted.
```

- [ ] **Step 2: Run formatting and static checks**

Run:

```bash
npx prettier --check src/main/config.ts tests/config-model-block.test.ts src/main/model-configuration-runtime.ts src/main/model-configuration-runtime.test.ts src/main/model-configuration-coordinator.ts src/main/model-configuration-coordinator.test.ts docs/superpowers/specs/2026-08-15-beta29-model-recovery-self-heal-design.md docs/superpowers/plans/2026-08-15-beta29-model-recovery-self-heal.md lat.md/beta27-reliability-plan.md
npm run typecheck
git diff --check
lat check
```

Expected: every command exits zero.

- [ ] **Step 3: Run focused and full tests**

Run:

```bash
npx vitest run tests/config-model-block.test.ts src/main/model-configuration-coordinator.test.ts src/main/model-configuration-runtime.test.ts --reporter=dot
npm test -- --reporter=dot
```

Expected: focused tests pass and the full suite has no failures.

- [ ] **Step 4: Build the production application**

Run:

```bash
npm run build
```

Expected: renderer and Main production build completes with exit code zero.

- [ ] **Step 5: Review the final diff and privacy boundary**

Run:

```bash
git status --short
git diff origin/main...HEAD --stat
git diff origin/main...HEAD -- src/main/config.ts src/main/model-configuration-runtime.ts src/main/model-configuration-coordinator.ts lat.md/beta27-reliability-plan.md
rg -n "console\.|logger\.|routeKey|beforeDigests|afterDigests|ownerHandle" src/main/config.ts src/main/model-configuration-runtime.ts src/main/model-configuration-coordinator.ts
```

Expected: only planned files changed, no new secret/path/digest logging, and exact-state checks remain fail-closed.

- [ ] **Step 6: Commit the architecture contract**

```bash
git add lat.md/beta27-reliability-plan.md
git commit -m "docs: specify model recovery reconciliation"
```

The already committed design and implementation-plan documents remain part of the branch. Do not bump the release version, publish an updater, merge, push, or modify a physical user's journal in this implementation plan.
