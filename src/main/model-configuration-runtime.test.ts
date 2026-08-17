// @vitest-environment node

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UpsertModelServiceRequest } from "../shared/model-configuration";
import type { ModelConfigurationSqliteDatabase } from "./model-configuration-database";

// This suite dynamically imports modules that transitively use installer.
// Clear any worker-level installer mock left by another test file before the
// import graph is evaluated.
vi.unmock("./installer");

const OWNER = {
  tenantId: "10000000-0000-4000-8000-000000000001",
  ownerId: "20000000-0000-4000-8000-000000000002",
  deviceInstallationId: "30000000-0000-4000-8000-000000000003",
};
const SECRET = "runtime-fixture-private-key";
const roots: string[] = [];
const originalHermesHome = process.env.HERMES_HOME;

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock("./agentera-agent-control/runtime-model-routes");
  vi.resetModules();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
  if (originalHermesHome === undefined) delete process.env.HERMES_HOME;
  else process.env.HERMES_HOME = originalHermesHome;
});

describe("model-configuration runtime", () => {
  it("does not treat a different named provider at the same endpoint as active", async () => {
    const { isActiveProviderRoute } =
      await import("./model-configuration-runtime");

    expect(
      isActiveProviderRoute(
        {
          provider: "custom:petoi.cn",
          model: "gpt-5.6-sol",
          baseUrl: "https://www.api-codex.cn",
          apiMode: "chat_completions",
        },
        "123456",
        "https://www.api-codex.cn",
      ),
    ).toBe(false);
  });

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
      expect(handle.recoveryError).toBeNull();
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
    }
  });

  it("commits one real local mutation through the owner catalog and journal", async () => {
    const root = mkdtempSync(join(tmpdir(), "aera-model-runtime-"));
    roots.push(root);
    const hermesHome = join(root, "hermes");
    const userData = join(root, "user-data");
    mkdirSync(hermesHome, { recursive: true });
    process.env.HERMES_HOME = hermesHome;
    vi.resetModules();
    // The dynamic graph imports installer after another worker-local suite may
    // have registered a mock; clear that registry at the actual import boundary.
    vi.doUnmock("./installer");
    const actualInstaller =
      await vi.importActual<typeof import("./installer")>("./installer");
    vi.doMock("./installer", () => actualInstaller);

    const [
      { AgenteraProfileBindingStore },
      runtime,
      config,
      routeReader,
      modelDatabase,
    ] = await Promise.all([
      import("./agentera-profile-binding"),
      import("./model-configuration-runtime"),
      import("./config"),
      import("./agentera-agent-control/runtime-model-routes"),
      import("./model-configuration-database"),
    ]);
    const bindings = new AgenteraProfileBindingStore({
      userDataPath: userData,
      secureStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (value: string) => Buffer.from(value, "utf8"),
        decryptString: (value: Buffer) => value.toString("utf8"),
      },
    });
    bindings.bindExistingProfile(hermesHome, OWNER);
    const notifyModelLibraryChanged = vi.fn();
    const notifyCustomProvidersChanged = vi.fn();
    const notifyConnectionConfigChanged = vi.fn();
    const notifyRuntimeSnapshotChanged = vi.fn();
    const handle = await runtime.prepareModelConfigurationRuntime({
      userDataPath: userData,
      getOwner: () => OWNER,
      profileBindings: bindings,
      getConnectionConfig: () => ({ mode: "local" }),
      notifyModelLibraryChanged,
      notifyCustomProvidersChanged,
      notifyConnectionConfigChanged,
      notifyRuntimeSnapshotChanged,
      openDatabase: (path) =>
        modelDatabase.openModelConfigurationDatabase(path, {
          databaseFactory: (databasePath) =>
            new DatabaseSync(
              databasePath,
            ) as unknown as ModelConfigurationSqliteDatabase,
        }),
    });

    try {
      expect(handle.recoveryError).toBeNull();
      const before = handle.catalog!.snapshot("default");
      const request: UpsertModelServiceRequest = {
        intent: "upsert",
        expectedCatalogRevision: before.revision,
        requestedProfileId: "default",
        provider: "custom",
        providerLabel: "Fixture",
        baseUrl: "https://fixture.invalid/v1",
        apiMode: "chat_completions",
        apiKey: SECRET,
        models: [
          {
            model: "fixture-model",
            displayName: "Fixture Model",
            contextLength: 65_536,
          },
        ],
        activeModel: "fixture-model",
      };
      const result = await handle.coordinator!.mutate(request);
      expect(result).toMatchObject({ status: "committed" });
      expect(JSON.stringify(result)).not.toContain(SECRET);
      expect(config.getModelConfig("default")).toEqual({
        provider: "custom:fixture",
        model: "fixture-model",
        baseUrl: "https://fixture.invalid/v1",
      });
      expect(
        routeReader.listResolvedAgentRuntimeModelRoutes("default"),
      ).toEqual([
        expect.objectContaining({
          provider: "custom:fixture",
          model: "fixture-model",
          apiMode: "chat_completions",
          credentialRef: "CUSTOM_PROVIDER_FIXTURE_KEY",
        }),
      ]);
      expect(readFileSync(join(hermesHome, ".env"), "utf8")).toContain(
        "CUSTOM_PROVIDER_FIXTURE_KEY=",
      );
      expect(handle.operationStore!.listIncomplete()).toEqual([]);
      for (const listener of [
        notifyModelLibraryChanged,
        notifyCustomProvidersChanged,
        notifyConnectionConfigChanged,
        notifyRuntimeSnapshotChanged,
      ]) {
        expect(listener).toHaveBeenCalledOnce();
        expect(listener).toHaveBeenCalledWith(
          expect.stringMatching(/^[0-9a-f]{64}$/),
        );
        listener.mockClear();
      }

      const [
        { listCustomProviders },
        { readModels },
        { getSecret },
        { parse: parseYaml },
      ] = await Promise.all([
        import("./providers-store"),
        import("./models"),
        import("./secrets"),
        import("yaml"),
      ]);
      const originalProvider = listCustomProviders("default")[0];
      expect(originalProvider).toMatchObject({ name: "Fixture" });

      const duplicateProvider = listCustomProviders("default").length
        ? (await import("./providers-store")).upsertCustomProvider("default", {
            name: "123456",
            baseUrl: request.baseUrl,
          })
        : null;
      expect(duplicateProvider).toBeTruthy();
      const { addModel, readModelsRaw } = await import("./models");
      addModel(
        "Fixture Model",
        "custom",
        "fixture-model",
        request.baseUrl,
        undefined,
        "123456",
        request.apiMode,
        duplicateProvider!.id,
      );
      const deleteCatalog = handle.catalog!.snapshot("default");
      const deleteResult = await handle.coordinator!.mutate({
        intent: "delete",
        expectedCatalogRevision: deleteCatalog.revision,
        requestedProfileId: "default",
        providerLabel: "123456",
        replacement: null,
      });
      expect(deleteResult).toMatchObject({ status: "committed" });
      expect(listCustomProviders("default")).toEqual([
        expect.objectContaining({ id: originalProvider.id, name: "Fixture" }),
      ]);
      expect(readModelsRaw()).toHaveLength(1);
      expect(config.getModelConfig("default")).toMatchObject({
        provider: "custom:fixture",
      });
      for (const listener of [
        notifyModelLibraryChanged,
        notifyCustomProvidersChanged,
        notifyConnectionConfigChanged,
        notifyRuntimeSnapshotChanged,
      ]) {
        listener.mockClear();
      }

      const renameCatalog = handle.catalog!.snapshot("default");
      const renameResult = await handle.coordinator!.mutate({
        ...request,
        expectedCatalogRevision: renameCatalog.revision,
        providerId: originalProvider.id,
        providerLabel: "123456",
        baseUrl: "https://renamed.invalid/v1",
        apiKey: "",
      });

      expect(renameResult).toMatchObject({ status: "committed" });
      expect(listCustomProviders("default")).toEqual([
        expect.objectContaining({
          id: originalProvider.id,
          name: "123456",
          baseUrl: "https://renamed.invalid/v1",
        }),
      ]);
      expect(readModels()).toEqual([
        expect.objectContaining({
          providerId: originalProvider.id,
          providerLabel: "123456",
          baseUrl: "https://renamed.invalid/v1",
        }),
      ]);
      expect(getSecret("CUSTOM_PROVIDER_123456_KEY", "default")).toBe(SECRET);
      expect(getSecret("CUSTOM_PROVIDER_FIXTURE_KEY", "default")).toBeNull();
      expect(config.getModelConfig("default")).toEqual({
        provider: "custom:123456",
        model: "fixture-model",
        baseUrl: "https://renamed.invalid/v1",
      });
      const nativeConfig = parseYaml(
        readFileSync(join(hermesHome, "config.yaml"), "utf8"),
      ) as { providers?: Record<string, unknown> };
      expect(nativeConfig.providers).toHaveProperty("123456");
      expect(nativeConfig.providers).not.toHaveProperty("fixture");
      for (const listener of [
        notifyModelLibraryChanged,
        notifyCustomProvidersChanged,
        notifyConnectionConfigChanged,
        notifyRuntimeSnapshotChanged,
      ]) {
        expect(listener).toHaveBeenCalledOnce();
      }
    } finally {
      handle.close();
    }
  });

  it.each([
    "native_module_abi_mismatch",
    "native_module_architecture_mismatch",
    "native_module_dependency_missing",
    "native_module_load_denied",
    "native_module_load_failed",
    "model_configuration_database_unavailable",
    "model_configuration_schema_unsupported",
  ] as const)(
    "preserves the %s startup cause with one redacted diagnostic id",
    async (code) => {
      const root = mkdtempSync(join(tmpdir(), "aera-model-runtime-startup-"));
      roots.push(root);
      const runtime = await import("./model-configuration-runtime");
      const { ModelConfigurationRuntimeError } =
        await import("./model-configuration-database");
      const databaseError = new ModelConfigurationRuntimeError(code, {
        status: "failed",
        platform: process.platform,
        processArchitecture: process.arch,
        electronAbi: process.versions.modules ?? null,
        detectedNativeAbi: null,
        failureClass: code,
      });
      const log = vi.spyOn(console, "error").mockImplementation(() => {});

      const handle = await runtime.prepareModelConfigurationRuntime({
        userDataPath: join(root, "user-data"),
        getOwner: () => OWNER,
        profileBindings: {
          verifyProfileBinding: () => {
            throw new Error("not used during startup classification");
          },
        },
        getConnectionConfig: () => ({ mode: "local" }),
        openDatabase: () => {
          throw databaseError;
        },
      });

      expect(handle.coordinator).toBeNull();
      expect(handle.startupFailure).toEqual({
        code,
        diagnosticId: expect.stringMatching(/^[0-9a-f]{12}$/u),
      });
      expect(log).toHaveBeenCalledOnce();
      expect(log).toHaveBeenCalledWith(
        "[MODEL_CONFIGURATION] unavailable",
        handle.startupFailure!.diagnosticId,
        code,
      );
      expect(JSON.stringify(handle.startupFailure)).not.toMatch(
        /path|\.node|detail|message/iu,
      );
      handle.close();
    },
  );

  it("classifies a post-open cold recovery failure separately", async () => {
    const root = mkdtempSync(join(tmpdir(), "aera-model-runtime-recovery-"));
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
    const [
      { AgenteraProfileBindingStore },
      runtime,
      modelDatabase,
      coordinator,
    ] = await Promise.all([
      import("./agentera-profile-binding"),
      import("./model-configuration-runtime"),
      import("./model-configuration-database"),
      import("./model-configuration-coordinator"),
    ]);
    const bindings = new AgenteraProfileBindingStore({
      userDataPath: userData,
      secureStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (value: string) => Buffer.from(value, "utf8"),
        decryptString: (value: Buffer) => value.toString("utf8"),
      },
    });
    bindings.bindExistingProfile(hermesHome, OWNER);
    const recover = vi
      .spyOn(
        coordinator.ModelConfigurationCoordinator.prototype,
        "recoverIncompleteOperations",
      )
      .mockRejectedValue(new Error("private journal read failure"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

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
    recover.mockRestore();

    expect(handle.coordinator).toBeNull();
    expect(handle.startupFailure).toEqual({
      code: "model_configuration_recovery_required",
      diagnosticId: expect.stringMatching(/^[0-9a-f]{12}$/u),
    });
    expect(log).toHaveBeenCalledWith(
      "[MODEL_CONFIGURATION] unavailable",
      handle.startupFailure!.diagnosticId,
      "model_configuration_recovery_required",
    );
    expect(JSON.stringify(handle.startupFailure)).not.toContain("journal");
    handle.close();
  });
});
