# Beta.27 Model Configuration Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Model Center, Agent installation, and Agent chat one owner-scoped model-route catalog and make provider/model mutations commit, roll back, and report their actual stage reliably.

**Architecture:** Main owns a deterministic `OwnerModelRouteCatalog` and a serialized `ModelConfigurationCoordinator`. Renderer sends one typed mutation and consumes the returned authoritative catalog; legacy installed-Profile routes remain readable and converge non-destructively into the canonical account Profile.

**Tech Stack:** Electron, TypeScript, React 19, better-sqlite3, Vitest, Testing Library, YAML, lat.md.

---

## File map

- Create `src/shared/model-configuration.ts`: public catalog, selection, mutation, and result contracts with no secret-reference field.
- Create `src/main/agentera-agent-control/owner-model-route-catalog.ts`: same-owner Profile ordering, canonical route deduplication, catalog revision, and private route resolution.
- Create `src/main/agentera-agent-control/owner-model-route-catalog.test.ts`: Profile split, stale revision, credential, custom-provider, and legacy-source tests.
- Create `src/main/model-configuration-database.ts` and tests: stable versioned journal database below Electron `userData`, outside every Hermes Profile, with `0700`/`0600` permissions where supported.
- Create `src/main/model-configuration-operation-store.ts`: injected non-secret mutation journal plus exact allowlisted sibling-backup lifecycle.
- Create `src/main/model-configuration-coordinator.ts`: prepare/commit/rollback/recovery orchestration.
- Create `src/main/model-configuration-coordinator.test.ts`: stage failure injection, rollback, recovery, concurrency, and refresh-warning tests.
- Modify `src/main/agentera-agent-control/runtime-model-routes.ts`: include canonical API mode and private credential reference in Main-only resolution.
- Modify `src/main/models.ts`, `src/main/providers-store.ts`, and `src/main/config.ts`: expose exact snapshot paths/readback helpers without weakening tolerant public reads.
- Modify `src/main/ipc/register.ts`, `src/main/ipc/auth-guard.ts`, `src/preload/index.ts`, `src/preload/index.d.ts`, and their static surface tests: add bound-profile catalog and single-mutation bridges while preserving legacy bridges for unrelated callers.
- Modify `src/main/app/start.ts`: open/close the independent journal database and finish startup recovery before registering mutation IPC.
- Modify `src/renderer/src/screens/Providers/ModelCenter.tsx`: replace the multi-call save/delete sequence and distinguish committed refresh warnings from rejection.
- Modify `src/renderer/src/screens/Providers/ModelCenter.test.tsx`: prove one mutation call and accurate result rendering.
- Modify `src/renderer/src/screens/Agents/Agents.tsx` and `Agents.test.tsx`: consume one Main catalog snapshot instead of constructing a different Profile set.
- Modify `src/shared/i18n/locales/en/providers.ts`, `src/shared/i18n/locales/zh-CN/providers.ts`, `src/shared/i18n/locales/en/agents.ts`, and `src/shared/i18n/locales/zh-CN/agents.ts`: localized stage/recovery/legacy-source guidance.
- Modify `lat.md/provider-setup.md`, `lat.md/model-selection.md`, and `lat.md/agentera-agent-control-plane.md`: record the authoritative catalog and transactional save boundaries.

### Task 1: Add the public model-configuration contract

**Files:**

- Create: `src/shared/model-configuration.ts`
- Test: `src/shared/model-configuration.test.ts`

- [ ] **Step 1: Write the failing contract test**

Create a test that imports `canonicalPublicRouteKey` and proves API mode participates in identity while secrets cannot appear in serialized public output:

```ts
import { describe, expect, it } from "vitest";
import {
  canonicalPublicRouteKey,
  type OwnerModelRouteCatalogSnapshot,
} from "./model-configuration";

describe("model configuration contract", () => {
  it("uses API mode in public identity without exposing credentials", () => {
    expect(
      canonicalPublicRouteKey({
        provider: "custom:petoi",
        model: "gpt-5.6-sol",
        baseUrl: "https://api.petoi.cn/v1/",
        apiMode: "codex_responses",
      }),
    ).not.toBe(
      canonicalPublicRouteKey({
        provider: "custom:petoi",
        model: "gpt-5.6-sol",
        baseUrl: "https://api.petoi.cn/v1",
        apiMode: "chat_completions",
      }),
    );
    const snapshot: OwnerModelRouteCatalogSnapshot = {
      revision: "revision-1",
      targetProfileId: "default",
      routes: [],
    };
    expect(JSON.stringify(snapshot)).not.toMatch(
      /apiKey|credentialRef|secret/i,
    );
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `npx vitest run src/shared/model-configuration.test.ts`

Expected: FAIL because `model-configuration.ts` does not exist.

- [ ] **Step 3: Add the complete shared types and normalizer**

Define these exact public shapes and keep the existing `SessionModelOverride` unchanged:

```ts
export interface PublicModelRouteIdentity {
  provider: string;
  model: string;
  baseUrl: string;
  apiMode: string | null;
}

export interface OwnerModelRouteSelection {
  sourceProfileId: string;
  modelLibraryId: string;
  catalogRevision: string;
}

export interface OwnerModelRouteSummary extends PublicModelRouteIdentity {
  id: string;
  providerLabel: string;
  displayName: string;
  sourceProfileId: string;
  sourceKind: "account" | "legacy_agent";
  selection: OwnerModelRouteSelection;
}

export interface OwnerModelRouteCatalogSnapshot {
  revision: string;
  targetProfileId: string;
  routes: OwnerModelRouteSummary[];
}

export type ModelConfigurationStage =
  | "validation"
  | "credential"
  | "provider"
  | "model_library"
  | "native_route"
  | "activation"
  | "verification"
  | "rollback"
  | "recovery";

export interface UpsertModelServiceRequest {
  intent: "upsert";
  expectedCatalogRevision: string;
  requestedProfileId: string;
  provider: string;
  providerLabel: string;
  baseUrl: string;
  apiMode: string | null;
  apiKey: string;
  models: Array<{ model: string; displayName: string; contextLength?: number }>;
  activeModel: string;
}

export interface DeleteModelServiceRequest {
  intent: "delete";
  expectedCatalogRevision: string;
  requestedProfileId: string;
  providerLabel: string;
  replacement: OwnerModelRouteSelection | null;
}

export type ModelConfigurationMutationRequest =
  | UpsertModelServiceRequest
  | DeleteModelServiceRequest;

export type ModelConfigurationMutationResult =
  | { status: "committed"; catalog: OwnerModelRouteCatalogSnapshot }
  | {
      status: "committed_refresh_warning";
      catalog: OwnerModelRouteCatalogSnapshot;
      warning: "model_save_refresh_failed";
    }
  | {
      status: "rejected";
      stage: ModelConfigurationStage;
      code:
        | `model_save_${ModelConfigurationStage}_failed`
        | "model_configuration_recovery_required";
      rollback: "not_needed" | "restored" | "recovery_required";
    };

export function canonicalPublicRouteKey(
  route: PublicModelRouteIdentity,
): string {
  return [
    route.provider.trim().toLocaleLowerCase(),
    route.model.trim(),
    route.baseUrl.trim().replace(/\/+$/, "").toLocaleLowerCase(),
    route.apiMode?.trim().toLocaleLowerCase() || "",
  ].join("\0");
}
```

Do not change the existing `AgentRuntimeModelSelection` in this task. It is still a two-field Beta.26 compatibility input used by installation and repair callers. Export `OwnerModelRouteSelection` as the new revision-bearing shape, and keep the two types separate until Task 7 migrates every installation, repair, IPC parser, renderer, and fixture caller in one compile-safe change.

- [ ] **Step 4: Verify GREEN and type consistency**

Run: `npx vitest run src/shared/model-configuration.test.ts && npm run typecheck:node`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/model-configuration.ts src/shared/model-configuration.test.ts
git commit -m "feat(models): define authoritative route contracts"
```

### Task 2: Build the owner-scoped route catalog

**Files:**

- Create: `src/main/agentera-agent-control/owner-model-route-catalog.ts`
- Create: `src/main/agentera-agent-control/owner-model-route-catalog.test.ts`
- Modify: `src/main/agentera-agent-control/runtime-model-routes.ts`
- Modify: `src/main/agentera-agent-control/runtime-model-routes.test.ts`

- [ ] **Step 1: Write failing catalog tests**

Use injected Profile/route dependencies and cover the screenshot regression:

```ts
it("keeps an active installed-Profile route visible beside account Profiles", () => {
  const catalog = subject({
    activeProfileId: "installed",
    profiles: [
      profile("account", { isDefault: true, agentInstallationId: null }),
      profile("installed", { agentInstallationId: INSTALLATION_ID }),
    ],
    routes: {
      account: [route("account", "old-model")],
      installed: [route("installed", "new-model")],
    },
  }).snapshot();

  expect(catalog.targetProfileId).toBe("account");
  expect(catalog.routes.map((route) => route.model)).toEqual([
    "old-model",
    "new-model",
  ]);
  expect(catalog.routes[1].sourceKind).toBe("legacy_agent");
});

it("rejects a stale catalog selection before credential access", () => {
  const service = subject();
  const snapshot = service.snapshot();
  expect(() =>
    service.resolve({
      ...snapshot.routes[0].selection,
      catalogRevision: "old",
    }),
  ).toThrowErrorMatchingObject({ code: "model_switch_route_stale" });
  expect(dependencies.getSecret).not.toHaveBeenCalled();
});
```

Add tests for account precedence, canonical API-mode dedupe, same-owner enforcement, missing credentials, local endpoints, OAuth-only routes, and renamed custom providers.

- [ ] **Step 2: Run and verify RED**

Run: `npx vitest run src/main/agentera-agent-control/owner-model-route-catalog.test.ts src/main/agentera-agent-control/runtime-model-routes.test.ts`

Expected: FAIL because the catalog and API-mode/credential-reference resolution are absent.

- [ ] **Step 3: Implement the catalog boundary**

Create a focused class with these public methods:

```ts
export interface ResolvedOwnerModelRoute extends PublicModelRouteIdentity {
  sourceProfileId: string;
  modelLibraryId: string;
  credentialRef: string | null;
  sourceKind: "account" | "legacy_agent";
}

export class OwnerModelRouteCatalog {
  snapshot(requestedProfileId?: string): OwnerModelRouteCatalogSnapshot;
  resolve(selection: OwnerModelRouteSelection): ResolvedOwnerModelRoute;
  canonicalTargetProfileId(requestedProfileId?: string): string;
}
```

Compute `revision` as SHA-256 over sorted non-secret route identities, source handles, Profile ownership metadata, and target Profile. `resolve()` recomputes the snapshot, compares the revision, then re-reads provider/model/credential state before returning. Never cache a secret value.

Extend the Main-only runtime route reader to derive `apiMode` from the model row and `credentialRef` from `customProviderEnvKey()` or `expectedEnvKeyForModel()`. Strip `credentialRef` when mapping to `OwnerModelRouteSummary`.

- [ ] **Step 4: Verify GREEN**

Run: `npx vitest run src/main/agentera-agent-control/owner-model-route-catalog.test.ts src/main/agentera-agent-control/runtime-model-routes.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/agentera-agent-control/owner-model-route-catalog.ts src/main/agentera-agent-control/owner-model-route-catalog.test.ts src/main/agentera-agent-control/runtime-model-routes.ts src/main/agentera-agent-control/runtime-model-routes.test.ts
git commit -m "feat(models): centralize owner route catalog"
```

### Task 3: Add exact file snapshots and the non-secret operation journal

**Files:**

- Create: `src/main/model-configuration-database.ts`
- Create: `src/main/model-configuration-database.test.ts`
- Create: `src/main/model-configuration-operation-store.ts`
- Create: `src/main/model-configuration-operation-store.test.ts`
- Modify: `src/main/models.ts`
- Modify: `src/main/providers-store.ts`
- Modify: `src/main/config.ts`

- [ ] **Step 1: Write failing journal and snapshot tests**

Prove the journal database is stable below Electron `userData`, is outside `HERMES_HOME`, excludes secrets/paths, and restores exact bytes, including comments and line endings:

```ts
it("opens a restrictive journal database outside every Hermes Profile", () => {
  const paths = resolveModelConfigurationDatabasePaths(USER_DATA);
  expect(paths.databasePath).toBe(
    join(USER_DATA, "model-configuration", "model-configuration.db"),
  );
  process.env.HERMES_HOME = paths.rootPath;
  expect(() => openModelConfigurationDatabase(USER_DATA)).toThrow(
    "outside HERMES_HOME",
  );
  delete process.env.HERMES_HOME;
  const database = openModelConfigurationDatabase(USER_DATA);
  if (process.platform !== "win32") {
    expect(statSync(database.paths.rootPath).mode & 0o777).toBe(0o700);
    expect(statSync(database.paths.databasePath).mode & 0o777).toBe(0o600);
  }
});

it("journals only bounded non-secret operation metadata", () => {
  const record = store.begin({
    operationId: OPERATION_ID,
    ownerHandle: "owner-hash",
    profileId: "default",
    routeKey: "custom:petoi\0gpt-5.6\0https://api.petoi.cn/v1\0codex_responses",
    fileDigests: { env: "a".repeat(64), providers: "b".repeat(64) },
  });
  expect(JSON.stringify(record)).not.toMatch(/api[_-]?key|secret|fileBody/i);
  const columns = tableColumns(
    database.sqlite,
    "desktop_model_configuration_operations",
  );
  expect(columns).not.toContain("api_key");
  expect(columns).not.toContain("absolute_path");
});

it("restores the exact pre-operation bytes from durable sibling backups", () => {
  const snapshot = captureModelConfigurationFiles("default", OPERATION_ID);
  persistModelConfigurationBackups(snapshot);
  writeFileSync(snapshot.files.config.path, "model:\n  provider: broken\n");
  restoreModelConfigurationFiles(snapshot);
  expect(readFileSync(snapshot.files.config.path)).toEqual(
    snapshot.files.config.bytes,
  );
});
```

- [ ] **Step 2: Run and verify RED**

Run: `npx vitest run src/main/model-configuration-operation-store.test.ts`

Expected: FAIL because the stable database, store, and snapshot exports do not exist.

- [ ] **Step 3: Implement bounded journal states and snapshot exports**

Create a version-1 `ModelConfigurationDatabase` at the exact `userData/model-configuration/model-configuration.db` path. Follow the existing Desktop database pattern: require an absolute path outside `HERMES_HOME`, create the directory with mode `0700`, use `better-sqlite3` with WAL, foreign keys, busy timeout, and full synchronous durability, initialize the schema in one transaction, reject future schema versions, and repair the database mode to `0600` where POSIX modes apply. Do not import or call `getDbConnection`; that connection follows the active Profile's `state.db` and is not a stable recovery authority.

Inject `ModelConfigurationDatabase` into `ModelConfigurationOperationStore`. Use `prepared`, each named commit stage, `committed`, `rolled_back`, and `recovery_required` states and validate every read. The journal stores symbolic file roles, existed flags, and SHA-256 before/after digests, never absolute paths, bytes, API keys, or credential values. Export only path helpers needed by `captureModelConfigurationFiles`; keep tolerant renderer reads unchanged.

The file snapshot helper must record `{ role, path, backupPath, existed, mode, bytes, digest }` for the target Profile `.env`, `providers.json`, and `config.yaml`, plus global `models.json` and `model-definitions.json`. Before the first product write, persist each existing snapshot with exclusive creation to the sibling path `<original>.aera-model-config-backup.<operationUuid>` and mode `0600`; absence is represented only by the journal's `existed=false`. Restore with `safeWriteFile`; delete only a file that did not exist in the captured snapshot and is one of those five re-derived exact paths. Verify all before-digests and the old active route before marking `rolled_back`, and remove backup siblings only after a verified terminal state. A missing or mismatched backup for a changed file must preserve remaining evidence and mark `recovery_required`.

- [ ] **Step 4: Verify GREEN**

Run: `npx vitest run src/main/model-configuration-database.test.ts src/main/model-configuration-operation-store.test.ts src/main/providers-store.test.ts src/main/models.provider-removal.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/model-configuration-database.ts src/main/model-configuration-database.test.ts src/main/model-configuration-operation-store.ts src/main/model-configuration-operation-store.test.ts src/main/models.ts src/main/providers-store.ts src/main/config.ts
git commit -m "feat(models): journal recoverable configuration writes"
```

### Task 4: Implement the serialized configuration coordinator

**Files:**

- Create: `src/main/model-configuration-coordinator.ts`
- Create: `src/main/model-configuration-coordinator.test.ts`

- [ ] **Step 1: Write table-driven failure-injection tests**

Inject one failure at each stage and assert exact restoration:

```ts
it.each([
  "credential",
  "provider",
  "model_library",
  "native_route",
  "activation",
  "verification",
] as const)("rolls back a %s failure", async (stage) => {
  const before = fixture.snapshotBytes();
  fixture.failAt(stage);
  await expect(subject.mutate(upsertRequest())).resolves.toMatchObject({
    status: "rejected",
    stage,
    rollback: stage === "credential" ? "not_needed" : "restored",
  });
  expect(fixture.snapshotBytes()).toEqual(before);
  expect(fixture.activeRoute()).toEqual(OLD_ROUTE);
});

it("reports committed_refresh_warning after authoritative commit", async () => {
  fixture.failPresentationRefresh();
  const result = await subject.mutate(upsertRequest());
  expect(result).toMatchObject({ status: "committed_refresh_warning" });
  expect(fixture.activeRoute()).toEqual(NEW_ROUTE);
});
```

Also test stale revisions, two concurrent mutations, installed-only legacy convergence, active-route delete protection, remote legacy rejection before any write, and recovery for journals before/after activation.

- [ ] **Step 2: Run and verify RED**

Run: `npx vitest run src/main/model-configuration-coordinator.test.ts`

Expected: FAIL because the coordinator does not exist.

- [ ] **Step 3: Implement prepare, commit, rollback, and recovery**

Expose only:

```ts
export class ModelConfigurationCoordinator {
  mutate(
    request: ModelConfigurationMutationRequest,
  ): Promise<ModelConfigurationMutationResult>;
  recoverIncompleteOperations(): Promise<void>;
}
```

Use one promise mutex per owner/target Profile. Validate, capture, persist all sibling backups, and journal `prepared` before the first product write. Commit credential → provider → model library/definition → native route → active model. After each successful stage, persist its after-digest and advance the journal. Read back through the catalog and require the requested canonical route before returning `committed`; only then remove the backups. On an in-process error, restore exact bytes in reverse dependency order, verify every before-digest and the old active route, and return the failed stage. If restore verification fails, mark `recovery_required` and return `model_configuration_recovery_required`.

`recoverIncompleteOperations()` must derive all five allowlisted paths from the validated Profile handle rather than trust a stored path. For a non-terminal row, it may mark `committed` only when the requested route is active and every recorded after-digest matches. Otherwise it restores from the verified sibling backups (and removes an originally absent file only at its exact derived path), verifies the before-digests and previous active route, then marks `rolled_back`. Missing/tampered evidence or an unrecognized active route marks `recovery_required` and blocks later mutations for that Profile. It must never activate an incomplete request or infer a credential.

For remote/SSH dashboard mode, use an injected adapter that captures the remote model/config snapshot before writes and compensates from that snapshot. If the connection uses legacy transport or cannot provide a complete snapshot, reject at `validation` before a credential/provider/model write.

- [ ] **Step 4: Verify GREEN and no secret leakage**

Run: `npx vitest run src/main/model-configuration-coordinator.test.ts`

Expected: PASS, and the test scans serialized journal/results/log spies without finding the fixture API key.

- [ ] **Step 5: Commit**

```bash
git add src/main/model-configuration-coordinator.ts src/main/model-configuration-coordinator.test.ts
git commit -m "feat(models): coordinate atomic model mutations"
```

### Task 5: Expose one guarded IPC boundary

**Files:**

- Modify: `src/main/ipc/register.ts`
- Create: `src/main/ipc/register.model-configuration.test.ts`
- Modify: `src/main/app/start.ts`
- Modify: `src/main/ipc/auth-guard.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/preload/index.d.ts`
- Modify: `tests/agentera-ipc-auth-guard.test.ts`
- Modify: `tests/ipc-handlers.test.ts`
- Modify: `tests/preload-api-surface.test.ts`

- [ ] **Step 1: Write failing IPC tests**

Register a fake coordinator/catalog and prove the renderer cannot choose a foreign target or receive a credential reference:

```ts
it("returns a redacted owner catalog and delegates one mutation", async () => {
  const snapshot = await invoke("get-owner-model-route-catalog", "installed");
  expect(JSON.stringify(snapshot)).not.toMatch(/credentialRef|apiKey|secret/i);
  await invoke("mutate-model-configuration", upsertRequest());
  expect(coordinator.mutate).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run and verify RED**

Run: `npx vitest run src/main/ipc/register.model-configuration.test.ts`

Expected: FAIL because both channels are unregistered.

- [ ] **Step 3: Register typed bridges and startup recovery**

Add `getOwnerModelRouteCatalog(requestedProfileId?)` and `mutateModelConfiguration(request)` to `window.hermesAPI`. Register both channels as `bound-profile` in `src/main/ipc/auth-guard.ts`; only the optional catalog profile occupies argument index 0, while the mutation's nested `requestedProfileId` is re-resolved and owner-checked inside Main rather than trusted by the generic guard.

In `src/main/app/start.ts`, open `ModelConfigurationDatabase` directly from `app.getPath("userData")`, construct the operation store/coordinator independently of Agent-control Cloud availability, and await `recoverIncompleteOperations()` before `registerIpcHandlers()` exposes mutation. Close the database in the quit barrier. A database or recovery startup failure leaves the legacy read-only model surfaces available but makes the coordinated mutation return the bounded `model_configuration_recovery_required`; it must not fall through to active-Profile `state.db` or log a path/secret. Derive the current owner inside Main for every call. Notify model/provider/config listeners only after a committed result and include the new catalog revision in the event payload while retaining the no-argument listener callback compatibility.

Keep old low-level channels for existing internal callers, but Model Center and Agents must stop using them for the combined flow.

- [ ] **Step 4: Verify GREEN and typecheck**

Run: `npx vitest run src/main/ipc/register.model-configuration.test.ts tests/agentera-ipc-auth-guard.test.ts tests/ipc-handlers.test.ts tests/preload-api-surface.test.ts && npm run typecheck:node`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/app/start.ts src/main/ipc/register.ts src/main/ipc/register.model-configuration.test.ts src/main/ipc/auth-guard.ts src/preload/index.ts src/preload/index.d.ts tests/agentera-ipc-auth-guard.test.ts tests/ipc-handlers.test.ts tests/preload-api-surface.test.ts
git commit -m "feat(models): expose coordinated model configuration"
```

### Task 6: Move Model Center to authoritative results

**Files:**

- Modify: `src/renderer/src/screens/Providers/ModelCenter.tsx`
- Modify: `src/renderer/src/screens/Providers/ModelCenter.test.tsx`
- Modify: `src/shared/i18n/locales/en/providers.ts`
- Modify: `src/shared/i18n/locales/zh-CN/providers.ts`

- [ ] **Step 1: Replace existing expectations with failing one-call tests**

Add tests for successful save, committed refresh warning, rejected provider stage, and delete protection:

```ts
it("saves through one coordinator call and trusts its catalog", async () => {
  mutateModelConfiguration.mockResolvedValue({
    status: "committed",
    catalog: catalog({ activeModel: "gpt-5.6-sol" }),
  });
  await completePetoiForm();
  expect(mutateModelConfiguration).toHaveBeenCalledTimes(1);
  expect(addModel).not.toHaveBeenCalled();
  expect(setModelConfig).not.toHaveBeenCalled();
  expect(upsertCustomProvider).not.toHaveBeenCalled();
  expect(onActivated).toHaveBeenCalledWith(
    expect.objectContaining({ model: "gpt-5.6-sol" }),
  );
});

it("does not call a committed refresh warning a save failure", async () => {
  mutateModelConfiguration.mockResolvedValue({
    status: "committed_refresh_warning",
    catalog: catalog({ activeModel: "gpt-5.6-sol" }),
    warning: "model_save_refresh_failed",
  });
  await completePetoiForm();
  expect(screen.getByText("providers.center.warnings.refresh")).toBeVisible();
  expect(screen.queryByText("providers.center.errors.save")).toBeNull();
});
```

- [ ] **Step 2: Run and verify RED**

Run: `npx vitest run src/renderer/src/screens/Providers/ModelCenter.test.tsx`

Expected: FAIL because Model Center still calls the low-level bridges.

- [ ] **Step 3: Implement the renderer change**

Load the catalog once with service data, display `targetProfileId`, create one `UpsertModelServiceRequest`, and map `ModelConfigurationMutationResult`. Keep the key only in form state and clear it after any committed result. Keep the dialog open for `rejected`. Convert delete to `DeleteModelServiceRequest` and require a replacement selection when Main reports an active/reference dependency.

- [ ] **Step 4: Verify GREEN**

Run: `npx vitest run src/renderer/src/screens/Providers/ModelCenter.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/screens/Providers/ModelCenter.tsx src/renderer/src/screens/Providers/ModelCenter.test.tsx src/shared/i18n/locales/en/providers.ts src/shared/i18n/locales/zh-CN/providers.ts
git commit -m "fix(models): report authoritative save outcomes"
```

### Task 7: Make Agents and installation flows consume the same catalog

**Files:**

- Modify: `src/renderer/src/screens/Agents/Agents.tsx`
- Modify: `src/renderer/src/screens/Agents/Agents.test.tsx`
- Modify: `src/renderer/src/screens/Agents/AgentControlPanel.tsx`
- Modify: `src/renderer/src/screens/Agents/AgentControlPanel.test.tsx`
- Modify: `src/shared/agentera-agent-control.ts`
- Modify: `src/main/agentera-agent-control/manager.ts`
- Modify: `src/main/agentera-agent-control/installation-manager.ts`
- Modify: `src/main/agentera-agent-control/ipc-contract.ts`
- Modify: `src/main/agentera-agent-control/ipc-contract.test.ts`
- Modify: `src/main/agentera-agent-control/installation-manager.test.ts`
- Modify: `src/shared/i18n/locales/en/agents.ts`
- Modify: `src/shared/i18n/locales/zh-CN/agents.ts`

- [ ] **Step 1: Add the Profile split regression test**

Use one account Profile plus an active installed Profile whose route exists only in the returned catalog:

```ts
it("offers the model saved while an installed Agent is active", async () => {
  listProfiles.mockResolvedValue([
    profile("account", { agentInstallationId: null, model: "old-model" }),
    profile("installed", { agentInstallationId: INSTALLATION_ID, model: "new-model" }),
  ]);
  getOwnerModelRouteCatalog.mockResolvedValue(
    catalogWith(route("installed", "new-model", "legacy_agent")),
  );
  render(<Agents activeProfile="installed" onChatWith={vi.fn()} />);
  expect(await screen.findByText("new-model")).toBeVisible();
  expect(screen.queryByText("agents.control.modelRequired")).toBeNull();
});
```

- [ ] **Step 2: Run and verify RED**

Run: `npx vitest run src/renderer/src/screens/Agents/Agents.test.tsx src/renderer/src/screens/Agents/AgentControlPanel.test.tsx`

Expected: FAIL because `Agents` still filters Profile IDs and batches the legacy route bridge itself.

- [ ] **Step 3: Remove renderer Profile-source arbitration**

Delete `modelSourceProfileIds` and its `Promise.all` route batching. Load one `OwnerModelRouteCatalogSnapshot` from Main and pass `catalog.routes` to `AgentControlPanel`. Keep `selectAgentModelProfileId` only for legacy low-level fallback callers, not for normal catalog selection. On model/provider/config events, reload Profiles first and then fetch one new catalog snapshot so the revision and Profile metadata are coherent.

In the same change, make `AgentRuntimeModelSelection` an alias of `OwnerModelRouteSelection` and migrate every normal installation/repair path to carry `catalogRevision`. `parseRuntimeModelSelection` must accept exactly `sourceProfileId`, `modelLibraryId`, and `catalogRevision`; Main resolves that selection through `OwnerModelRouteCatalog` before `AgentInstallationManager.install`, `retryPendingInstallation`, or `repairInstallationModel` writes a Profile. Keep the old two-field shape only in an explicitly named Beta.26 compatibility parser used to read already-persisted pending rows; it must be converted to a fresh catalog selection before a new write. Update the installation and IPC tests in this task so no intermediate commit has a required field with stale callers.

Add localized text for a legacy installed-Profile source and for a catalog revision that became stale between selection and install. Do not use the legacy-source label as an identifier or expose a Profile path.

- [ ] **Step 4: Verify GREEN**

Run: `npx vitest run src/renderer/src/screens/Agents/Agents.test.tsx src/renderer/src/screens/Agents/AgentControlPanel.test.tsx src/main/agentera-agent-control/ipc-contract.test.ts src/main/agentera-agent-control/installation-manager.test.ts tests/agentera-agent-control-ipc.test.ts tests/ipc-handlers.test.ts tests/preload-api-surface.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/screens/Agents/Agents.tsx src/renderer/src/screens/Agents/Agents.test.tsx src/renderer/src/screens/Agents/AgentControlPanel.tsx src/renderer/src/screens/Agents/AgentControlPanel.test.tsx
git add src/shared/agentera-agent-control.ts src/main/agentera-agent-control/manager.ts src/main/agentera-agent-control/installation-manager.ts src/main/agentera-agent-control/ipc-contract.ts src/main/agentera-agent-control/ipc-contract.test.ts src/main/agentera-agent-control/installation-manager.test.ts
git add src/shared/i18n/locales/en/agents.ts src/shared/i18n/locales/zh-CN/agents.ts tests/agentera-agent-control-ipc.test.ts tests/ipc-handlers.test.ts tests/preload-api-surface.test.ts
git commit -m "fix(agents): share the owner model catalog"
```

### Task 8: Document and verify the slice

**Files:**

- Modify: `lat.md/provider-setup.md`
- Modify: `lat.md/model-selection.md`
- Modify: `lat.md/agentera-agent-control-plane.md`

- [ ] **Step 1: Add behavior sections and code references**

Document the canonical owner catalog, legacy convergence, dependency-first commit with active config last, exact result semantics, and the installed-Profile/account-Profile regression. Add one `@lat:` reference beside each key test; do not duplicate verification keys.

- [ ] **Step 2: Run focused and static gates**

```bash
npx vitest run \
  src/shared/model-configuration.test.ts \
  src/main/agentera-agent-control/runtime-model-routes.test.ts \
  src/main/agentera-agent-control/owner-model-route-catalog.test.ts \
  src/main/model-configuration-database.test.ts \
  src/main/model-configuration-operation-store.test.ts \
  src/main/model-configuration-coordinator.test.ts \
  src/main/ipc/register.model-configuration.test.ts \
  src/renderer/src/screens/Providers/ModelCenter.test.tsx \
  src/renderer/src/screens/Agents/Agents.test.tsx \
  src/renderer/src/screens/Agents/AgentControlPanel.test.tsx
npm run typecheck
npx prettier --check \
  src/shared/model-configuration.ts \
  src/main/model-configuration-*.ts \
  src/main/agentera-agent-control/owner-model-route-catalog*.ts \
  src/renderer/src/screens/Providers/ModelCenter.tsx \
  src/renderer/src/screens/Agents/Agents.tsx \
  src/renderer/src/screens/Agents/AgentControlPanel.tsx \
  src/shared/agentera-agent-control.ts \
  src/main/agentera-agent-control/manager.ts \
  src/main/agentera-agent-control/installation-manager.ts \
  src/main/agentera-agent-control/ipc-contract.ts \
  src/shared/i18n/locales/en/providers.ts \
  src/shared/i18n/locales/zh-CN/providers.ts \
  src/shared/i18n/locales/en/agents.ts \
  src/shared/i18n/locales/zh-CN/agents.ts \
  lat.md/provider-setup.md lat.md/model-selection.md \
  lat.md/agentera-agent-control-plane.md
npm exec --yes --package=lat.md@0.12.1 -- lat check
git diff --check
```

Expected: every command exits 0.

- [ ] **Step 3: Commit documentation**

```bash
git add lat.md/provider-setup.md lat.md/model-selection.md lat.md/agentera-agent-control-plane.md
git commit -m "docs(models): record reliable route ownership"
```

- [ ] **Step 4: Record the exact slice head**

Run: `git status --short --branch && git rev-parse HEAD`

Expected: clean working tree on `aera/beta27-model-enterprise-reliability`; retain the SHA for the later integration ledger without claiming Electron or release completion.
