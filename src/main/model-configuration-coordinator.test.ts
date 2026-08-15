// @vitest-environment node

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  isSafeToRetryStaleRevision,
  type ModelConfigurationMutationRequest,
  type OwnerModelRouteCatalogSnapshot,
} from "../shared/model-configuration";
import {
  ModelConfigurationCoordinator,
  type ModelConfigurationCoordinatorDependencies,
  type ModelConfigurationCommitStage,
  type PreparedModelConfigurationMutation,
} from "./model-configuration-coordinator";
import {
  captureModelConfigurationFiles,
  persistModelConfigurationBackups,
  readModelConfigurationFileDigests,
  removeModelConfigurationBackups,
  type ModelConfigurationFilePaths,
  ModelConfigurationOperationStore,
} from "./model-configuration-operation-store";
import {
  openModelConfigurationDatabase,
  type ModelConfigurationDatabase,
  type ModelConfigurationSqliteDatabase,
} from "./model-configuration-database";

const REVISION = "a".repeat(64);
const OWNER = "owner-hash";
const OLD_ROUTE =
  "custom:fixture\0old-model\0https://fixture.invalid/v1\0chat_completions";
const NEW_ROUTE =
  "custom:fixture\0new-model\0https://fixture.invalid/v1\0chat_completions";
const SECRET = "fixture-super-secret-api-key";
const roots: string[] = [];
const databases: ModelConfigurationDatabase[] = [];

type FailureStage = ModelConfigurationCommitStage | "verification" | null;

interface Fixture {
  root: string;
  paths: ModelConfigurationFilePaths;
  store: ModelConfigurationOperationStore;
  catalog: {
    snapshot: Mock<
      (requestedProfileId?: string) => OwnerModelRouteCatalogSnapshot
    >;
    canonicalTargetProfileId: Mock<(requestedProfileId?: string) => string>;
  };
  adapter: {
    prepare: Mock<
      ModelConfigurationCoordinatorDependencies["mutationAdapter"]["prepare"]
    >;
    getActiveRouteKey: Mock<
      ModelConfigurationCoordinatorDependencies["mutationAdapter"]["getActiveRouteKey"]
    >;
    stageLog: string[];
    failAt: FailureStage;
    failPresentationRefresh: boolean;
    preparedTargets: string[];
  };
  snapshotBytes(): Record<string, string | null>;
}

function routeSnapshot(revision = REVISION): OwnerModelRouteCatalogSnapshot {
  return {
    revision,
    targetProfileId: "account",
    routes: [
      {
        id: "account\0new-model",
        provider: "custom:fixture",
        model: "new-model",
        baseUrl: "https://fixture.invalid/v1",
        apiMode: "chat_completions",
        providerLabel: "Fixture",
        displayName: "new-model",
        sourceProfileId: "account",
        sourceKind: "account",
        selection: {
          sourceProfileId: "account",
          modelLibraryId: "model-new",
          catalogRevision: revision,
        },
      },
    ],
  };
}

function request(
  overrides: Partial<
    Extract<ModelConfigurationMutationRequest, { intent: "upsert" }>
  > = {},
): Extract<ModelConfigurationMutationRequest, { intent: "upsert" }> {
  return {
    intent: "upsert",
    expectedCatalogRevision: REVISION,
    requestedProfileId: "account",
    provider: "custom:fixture",
    providerLabel: "Fixture",
    baseUrl: "https://fixture.invalid/v1",
    apiMode: "chat_completions",
    apiKey: SECRET,
    models: [{ model: "new-model", displayName: "new-model" }],
    activeModel: "new-model",
    ...overrides,
  };
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "aera-model-coordinator-"));
  roots.push(root);
  const userData = join(root, "user-data");
  const profileHome = join(root, "hermes", "profiles", "account");
  const hermesHome = join(root, "hermes");
  mkdirSync(profileHome, { recursive: true });
  mkdirSync(hermesHome, { recursive: true });
  const paths: ModelConfigurationFilePaths = {
    env: join(profileHome, ".env"),
    providers: join(profileHome, "providers.json"),
    config: join(profileHome, "config.yaml"),
    models: join(hermesHome, "models.json"),
    modelDefinitions: join(hermesHome, "model-definitions.json"),
  };
  writeFileSync(paths.env, "OLD_KEY=old\n");
  writeFileSync(paths.providers, '{"version":1,"providers":["old"]}\n');
  writeFileSync(paths.models, '[{"model":"old-model"}]\n');
  writeFileSync(paths.modelDefinitions, '{"old-model":{"name":"old"}}\n');
  writeFileSync(paths.config, `route=${OLD_ROUTE}\n# keep me\r\n`);

  const database = openModelConfigurationDatabase(userData, {
    databaseFactory: (path) =>
      new DatabaseSync(path) as unknown as ModelConfigurationSqliteDatabase,
  });
  databases.push(database);
  const store = new ModelConfigurationOperationStore(database);
  const stageLog: string[] = [];
  const preparedTargets: string[] = [];

  const catalog = {
    snapshot: vi.fn<
      (requestedProfileId?: string) => OwnerModelRouteCatalogSnapshot
    >(() => routeSnapshot()),
    canonicalTargetProfileId: vi.fn<(requested?: string) => string>(
      (requested?: string) =>
        requested === "installed" ? "account" : "account",
    ),
  };

  const getActiveRouteKey = vi.fn<() => string>(() => {
    const content = readFileSync(paths.config, "utf8");
    return /^route=(.*)$/m.exec(content)?.[1] || "none";
  });

  const adapter = {
    stageLog,
    failAt: null as FailureStage,
    failPresentationRefresh: false,
    preparedTargets,
    getActiveRouteKey,
    prepare: vi.fn<
      ModelConfigurationCoordinatorDependencies["mutationAdapter"]["prepare"]
    >(
      async (
        input: ModelConfigurationMutationRequest,
        context: { targetProfileId: string },
      ): Promise<PreparedModelConfigurationMutation> => {
        preparedTargets.push(context.targetProfileId);
        if (input.intent === "delete") {
          throw Object.assign(new Error("active route requires replacement"), {
            code: "active_route_requires_replacement",
          });
        }
        const writeStage = (stage: ModelConfigurationCommitStage): void => {
          if (stage === "credential")
            writeFileSync(paths.env, `NEW_KEY=${SECRET}\n`);
          if (stage === "provider")
            writeFileSync(
              paths.providers,
              '{"version":1,"providers":["new"]}\n',
            );
          if (stage === "model_library")
            writeFileSync(paths.models, '[{"model":"new-model"}]\n');
          if (stage === "native_route")
            writeFileSync(
              paths.modelDefinitions,
              '{"new-model":{"name":"new"}}\n',
            );
          if (stage === "activation")
            writeFileSync(paths.config, `route=${NEW_ROUTE}\n# keep me\r\n`);
        };
        return {
          targetProfileId: context.targetProfileId,
          oldRouteKey: OLD_ROUTE,
          newRouteKey: NEW_ROUTE,
          location: { kind: "local" },
          applyStage: async (stage) => {
            stageLog.push(stage);
            if (adapter.failAt === stage) {
              if (stage !== "credential") writeStage(stage);
              throw new Error(`injected ${stage} failure`);
            }
            writeStage(stage);
          },
          verify: async () => {
            if (adapter.failAt === "verification") {
              throw new Error("injected verification failure");
            }
            return getActiveRouteKey() === NEW_ROUTE;
          },
          refreshPresentation: async () => {
            if (adapter.failPresentationRefresh) {
              throw new Error("presentation refresh failed");
            }
          },
        };
      },
    ),
  };

  return {
    root,
    paths,
    store,
    catalog,
    adapter,
    snapshotBytes: () =>
      Object.fromEntries(
        Object.entries(paths).map(([role, path]) => [
          role,
          existsSync(path) ? readFileSync(path).toString("base64") : null,
        ]),
      ),
  };
}

function subject(
  fixture: Fixture,
  overrides: Partial<ModelConfigurationCoordinatorDependencies> = {},
): ModelConfigurationCoordinator {
  const dependencies: ModelConfigurationCoordinatorDependencies = {
    catalog: fixture.catalog,
    ownerHandle: () => OWNER,
    operationStore: fixture.store,
    fileAdapter: {
      paths: () => fixture.paths,
      capture: captureModelConfigurationFiles,
      persistBackups: persistModelConfigurationBackups,
      restore: (snapshot) => {
        // The coordinator's default adapter is responsible for exact byte
        // restoration; this indirection keeps the fixture on real files.
        return import("./model-configuration-operation-store").then(
          ({ restoreModelConfigurationFiles }) =>
            restoreModelConfigurationFiles(snapshot),
        );
      },
      removeBackups: (snapshot) => {
        return import("./model-configuration-operation-store").then(
          ({ removeModelConfigurationBackups }) =>
            removeModelConfigurationBackups(snapshot),
        );
      },
      readDigests: readModelConfigurationFileDigests,
    },
    mutationAdapter: fixture.adapter,
    operationId: (() => {
      let n = 0;
      return () => `10000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
    })(),
    isProfileOwned: () => true,
    ...overrides,
  };
  return new ModelConfigurationCoordinator(dependencies);
}

function writeAttemptedState(fixture: Fixture): void {
  writeFileSync(fixture.paths.env, `NEW_KEY=${SECRET}\n`);
  writeFileSync(fixture.paths.providers, '{"version":1,"providers":["new"]}\n');
  writeFileSync(fixture.paths.models, '[{"model":"new-model"}]\n');
  writeFileSync(
    fixture.paths.modelDefinitions,
    '{"new-model":{"name":"new"}}\n',
  );
  writeFileSync(fixture.paths.config, `route=${NEW_ROUTE}\n# keep me\r\n`);
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("ModelConfigurationCoordinator", () => {
  it("accepts opaque owner handles with NUL separators", async () => {
    const fixture = makeFixture();
    const ownerHandle = "tenant\0owner\0device";
    const dependencies: ModelConfigurationCoordinatorDependencies = {
      catalog: fixture.catalog,
      ownerHandle: () => ownerHandle,
      operationStore: fixture.store,
      fileAdapter: {
        paths: () => fixture.paths,
        capture: captureModelConfigurationFiles,
        persistBackups: persistModelConfigurationBackups,
        restore: (snapshot) => {
          return import("./model-configuration-operation-store").then(
            ({ restoreModelConfigurationFiles }) =>
              restoreModelConfigurationFiles(snapshot),
          );
        },
        removeBackups: (snapshot) => {
          return import("./model-configuration-operation-store").then(
            ({ removeModelConfigurationBackups }) =>
              removeModelConfigurationBackups(snapshot),
          );
        },
        readDigests: readModelConfigurationFileDigests,
      },
      mutationAdapter: fixture.adapter,
      isProfileOwned: () => true,
    };

    await expect(
      new ModelConfigurationCoordinator(dependencies).mutate(request()),
    ).resolves.toMatchObject({ status: "committed" });
  });

  it.each([
    "credential",
    "provider",
    "model_library",
    "native_route",
    "activation",
    "verification",
  ] as const)("rolls back a %s failure", async (stage) => {
    const fixture = makeFixture();
    const before = fixture.snapshotBytes();
    fixture.adapter.failAt = stage;

    const result = await subject(fixture).mutate(request());

    expect(result).toMatchObject({
      status: "rejected",
      stage,
      rollback: stage === "credential" ? "not_needed" : "restored",
    });
    expect(fixture.snapshotBytes()).toEqual(before);
    expect(fixture.adapter.getActiveRouteKey("account")).toBe(OLD_ROUTE);
  });

  it("reports committed_refresh_warning after authoritative commit", async () => {
    const fixture = makeFixture();
    const before = fixture.snapshotBytes();
    fixture.adapter.failPresentationRefresh = true;

    const result = await subject(fixture).mutate(request());

    expect(result).toMatchObject({
      status: "committed_refresh_warning",
      warning: "model_save_refresh_failed",
    });
    expect(fixture.adapter.getActiveRouteKey("account")).toBe(NEW_ROUTE);
    expect(fixture.snapshotBytes()).not.toEqual(before);
  });

  it("rejects a stale revision before any write", async () => {
    const fixture = makeFixture();
    const before = fixture.snapshotBytes();

    const result = await subject(fixture).mutate(
      request({ expectedCatalogRevision: "b".repeat(64) }),
    );

    expect(result).toMatchObject({
      status: "rejected",
      stage: "validation",
      rollback: "not_needed",
      reason: "stale_catalog_revision",
    });
    // The reason is what licenses the caller's single replay.
    expect(isSafeToRetryStaleRevision(result)).toBe(true);
    expect(fixture.snapshotBytes()).toEqual(before);
    expect(fixture.adapter.prepare).not.toHaveBeenCalled();
  });

  // @lat: [[legacy-model-config-migration#Stale catalog retry policy#Withholds the retry reason from every other refusal]]
  it("withholds the stale-revision reason from other validation refusals", async () => {
    // Each of these refusals used to be indistinguishable from a stale
    // revision — same stage, same rollback — so a caller replaying on that pair
    // alone would reissue a request that must fail again.
    const unownedProfile = makeFixture();
    const foreign = subject(unownedProfile, {
      isProfileOwned: async () => false,
    });

    const illegalParams = makeFixture();
    const noReplacement = makeFixture();
    const movedActiveRoute = makeFixture();
    movedActiveRoute.adapter.getActiveRouteKey.mockReturnValue(
      "custom:fixture\0someone-elses-model\0https://fixture.invalid/v1\0chat_completions",
    );

    const refusals = [
      { name: "unowned profile", result: await foreign.mutate(request()) },
      {
        name: "illegal parameters",
        result: await subject(illegalParams).mutate(
          request({ baseUrl: "file:///etc/passwd" }),
        ),
      },
      {
        name: "delete with no legal replacement",
        result: await subject(noReplacement).mutate({
          intent: "delete",
          expectedCatalogRevision: REVISION,
          requestedProfileId: "account",
          providerLabel: "Fixture",
          replacement: null,
        }),
      },
      {
        name: "active route moved",
        result: await subject(movedActiveRoute).mutate(request()),
      },
    ];

    for (const { name, result } of refusals) {
      expect(result, name).toMatchObject({
        status: "rejected",
        stage: "validation",
        rollback: "not_needed",
      });
      expect(
        "reason" in result ? result.reason : undefined,
        name,
      ).toBeUndefined();
      expect(isSafeToRetryStaleRevision(result), name).toBe(false);
    }
  });

  it("serializes concurrent mutations for one owner and target Profile", async () => {
    const fixture = makeFixture();
    const originalPrepare = fixture.adapter.prepare.getMockImplementation()!;
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    let first = true;
    fixture.adapter.prepare.mockImplementation(async (input, context) => {
      const prepared = await originalPrepare(input, context);
      if (first) {
        first = false;
        const applyStage = prepared.applyStage;
        prepared.applyStage = async (stage) => {
          if (stage === "credential") {
            firstStarted();
            await firstGate;
          }
          return applyStage(stage);
        };
      }
      return prepared;
    });

    const coordinator = subject(fixture);
    const firstMutation = coordinator.mutate(
      request({ providerLabel: "first" }),
    );
    await started;
    const secondMutation = coordinator.mutate(
      request({ providerLabel: "second" }),
    );
    await Promise.resolve();
    expect(fixture.adapter.prepare).toHaveBeenCalledTimes(1);

    releaseFirst();
    await firstMutation;
    const secondResult = await secondMutation;
    expect(fixture.adapter.prepare).toHaveBeenCalledTimes(2);
    expect(fixture.adapter.stageLog).toEqual([
      "credential",
      "provider",
      "model_library",
      "native_route",
      "activation",
    ]);
    expect(secondResult).toMatchObject({
      status: "rejected",
      stage: "validation",
    });
  });

  it("converges an installed-only request onto the account Profile", async () => {
    const fixture = makeFixture();

    const result = await subject(fixture).mutate(
      request({ requestedProfileId: "installed" }),
    );

    expect(result.status).toMatch(/^committed/);
    expect(fixture.adapter.preparedTargets).toEqual(["account"]);
  });

  it("rejects active-route deletion without touching files", async () => {
    const fixture = makeFixture();
    const before = fixture.snapshotBytes();
    const deleteRequest: ModelConfigurationMutationRequest = {
      intent: "delete",
      expectedCatalogRevision: REVISION,
      requestedProfileId: "account",
      providerLabel: "Fixture",
      replacement: null,
    };

    const result = await subject(fixture).mutate(deleteRequest);

    expect(result).toMatchObject({
      status: "rejected",
      stage: "validation",
      rollback: "not_needed",
    });
    expect(fixture.snapshotBytes()).toEqual(before);
  });

  it("rejects a legacy remote target without a complete snapshot", async () => {
    const fixture = makeFixture();
    fixture.adapter.prepare.mockResolvedValueOnce({
      targetProfileId: "account",
      oldRouteKey: OLD_ROUTE,
      newRouteKey: NEW_ROUTE,
      location: {
        kind: "remote",
        transport: "legacy",
        snapshotComplete: false,
        restore: vi.fn(),
        verifyRestore: vi.fn(),
      },
      applyStage: vi.fn(),
      verify: vi.fn(),
    });

    const result = await subject(fixture).mutate(request());

    expect(result).toMatchObject({
      status: "rejected",
      stage: "validation",
      rollback: "not_needed",
    });
    expect(fixture.adapter.prepare.mock.results[0]?.value).toBeDefined();
    expect(fixture.adapter.stageLog).toEqual([]);
  });

  it("does not serialize the API key in the result or journal", async () => {
    const fixture = makeFixture();
    const result = await subject(fixture).mutate(request());

    expect(JSON.stringify(result)).not.toContain(SECRET);
    const raw = fixture.store.get(
      // The operation id is deterministic for the fixture.
      "10000000-0000-4000-8000-000000000001",
    );
    expect(JSON.stringify(raw)).not.toContain(SECRET);
  });

  it("rolls back an incomplete operation during cold recovery", async () => {
    const fixture = makeFixture();
    const before = fixture.snapshotBytes();
    const operationId = "10000000-0000-4000-8000-000000000099";
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
    writeFileSync(fixture.paths.env, "NEW_KEY=partial\n");
    fixture.store.advance({
      operationId,
      state: "credential",
      stage: "credential",
      afterDigests: readModelConfigurationFileDigests(fixture.paths),
    });

    await subject(fixture).recoverIncompleteOperations();

    expect(fixture.snapshotBytes()).toEqual(before);
    expect(fixture.store.listIncomplete()).toEqual([]);
  });

  it("recognizes a fully committed operation during cold recovery", async () => {
    const fixture = makeFixture();
    const operationId = "10000000-0000-4000-8000-000000000100";
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
    writeFileSync(fixture.paths.env, `NEW_KEY=${SECRET}\n`);
    writeFileSync(
      fixture.paths.providers,
      '{"version":1,"providers":["new"]}\n',
    );
    writeFileSync(fixture.paths.models, '[{"model":"new-model"}]\n');
    writeFileSync(
      fixture.paths.modelDefinitions,
      '{"new-model":{"name":"new"}}\n',
    );
    writeFileSync(fixture.paths.config, `route=${NEW_ROUTE}\n# keep me\r\n`);
    fixture.store.advance({
      operationId,
      state: "verification",
      stage: "verification",
      afterDigests: readModelConfigurationFileDigests(fixture.paths),
    });

    await subject(fixture).recoverIncompleteOperations();

    expect(fixture.store.listIncomplete()).toEqual([]);
    expect(
      Object.values(snapshot.files).some(({ backupPath }) =>
        existsSync(backupPath),
      ),
    ).toBe(false);
    expect(readFileSync(fixture.paths.config, "utf8")).toContain(
      `route=${NEW_ROUTE}`,
    );
  });

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
    removeModelConfigurationBackups(snapshot);

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
    removeModelConfigurationBackups(snapshot);

    await subject(fixture).recoverIncompleteOperations();

    expect(fixture.store.require(operationId).state).toBe("committed");
    expect(fixture.store.listIncomplete()).toEqual([]);
  });

  it("blocks later mutations when recovery evidence is tampered", async () => {
    const fixture = makeFixture();
    const operationId = "10000000-0000-4000-8000-000000000101";
    const snapshot = captureModelConfigurationFiles({
      profileId: "account",
      operationId,
      paths: fixture.paths,
    });
    persistModelConfigurationBackups(snapshot);
    writeFileSync(snapshot.files.config.backupPath, "tampered\n");
    fixture.store.begin({
      operationId,
      ownerHandle: OWNER,
      profileId: "account",
      oldRouteKey: OLD_ROUTE,
      newRouteKey: NEW_ROUTE,
      snapshot,
    });
    writeFileSync(fixture.paths.config, `route=${NEW_ROUTE}\n`);

    await subject(fixture).recoverIncompleteOperations();
    await subject(fixture).recoverIncompleteOperations();

    expect(fixture.store.listIncomplete()).toHaveLength(1);
    expect(fixture.store.listIncomplete()[0].state).toBe("recovery_required");
    const result = await subject(fixture).mutate(request());
    expect(result).toMatchObject({
      status: "rejected",
      stage: "recovery",
      code: "model_configuration_recovery_required",
      rollback: "recovery_required",
    });
  });
});
