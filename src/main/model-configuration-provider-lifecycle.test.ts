// @vitest-environment node

import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UpsertModelServiceRequest } from "../shared/model-configuration";
import type { ModelConfigurationSqliteDatabase } from "./model-configuration-database";

const OWNER = {
  tenantId: "10000000-0000-4000-8000-000000000001",
  ownerId: "20000000-0000-4000-8000-000000000002",
  deviceInstallationId: "30000000-0000-4000-8000-000000000003",
};
const roots: string[] = [];
const originalHermesHome = process.env.HERMES_HOME;

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (originalHermesHome === undefined) delete process.env.HERMES_HOME;
  else process.env.HERMES_HOME = originalHermesHome;
});

async function makeRuntime(
  active: "petoi" | "codex",
): Promise<{
  handle: import("./model-configuration-runtime").ModelConfigurationRuntimeHandle;
  config: typeof import("./config");
}> {
  const root = mkdtempSync(join(tmpdir(), "aera-provider-lifecycle-"));
  roots.push(root);
  const hermesHome = join(root, "hermes");
  const userData = join(root, "user-data");
  mkdirSync(join(hermesHome, "profiles"), { recursive: true });
  process.env.HERMES_HOME = hermesHome;
  const providers = [
    {
      id: "petoi-provider",
      name: "petoi.cn",
      baseUrl: "https://petoi.cn/v1",
      createdAt: 1,
    },
    {
      id: "codex-provider",
      name: "www.api-codex.cn",
      baseUrl: "https://www.api-codex.cn/v1",
      createdAt: 2,
    },
  ];
  writeFileSync(join(hermesHome, ".env"), [
    "CUSTOM_PROVIDER_PETOI_CN_KEY=petoi-secret",
    "CUSTOM_PROVIDER_WWW_API_CODEX_CN_KEY=codex-secret",
    "",
  ].join("\n"));
  writeFileSync(join(hermesHome, "providers.json"), `${JSON.stringify({ version: 1, providers }, null, 2)}\n`);
  writeFileSync(join(hermesHome, "models.json"), `${JSON.stringify([
    {
      id: "petoi-model",
      name: "gpt-5.6-sol",
      provider: "custom",
      providerId: "petoi-provider",
      providerLabel: "petoi.cn",
      model: "gpt-5.6-sol",
      baseUrl: "https://petoi.cn/v1",
      apiMode: "chat_completions",
      createdAt: 1,
    },
    {
      id: "codex-model",
      name: "gpt-5.6-sol",
      provider: "custom",
      providerId: "codex-provider",
      providerLabel: "www.api-codex.cn",
      model: "gpt-5.6-sol",
      baseUrl: "https://www.api-codex.cn/v1",
      apiMode: "chat_completions",
      createdAt: 2,
    },
  ], null, 2)}\n`);
  writeFileSync(join(hermesHome, "model-definitions.json"), `${JSON.stringify({
    "gpt-5.6-sol": { model: "gpt-5.6-sol", name: "gpt-5.6-sol", createdAt: 1, updatedAt: 1 },
  }, null, 2)}\n`);
  const activeRoute = active === "petoi" ? "petoi.cn" : "www.api-codex.cn";
  const activeUrl = active === "petoi" ? "https://petoi.cn/v1" : "https://www.api-codex.cn/v1";
  writeFileSync(join(hermesHome, "config.yaml"), [
    "model:",
    `  provider: "custom:${activeRoute}"`,
    '  default: "gpt-5.6-sol"',
    `  base_url: "${activeUrl}"`,
    '  api_mode: "chat_completions"',
    "providers:",
    "  petoi.cn:",
    '    name: "petoi.cn"',
    '    api: "https://petoi.cn/v1"',
    '    key_env: "CUSTOM_PROVIDER_PETOI_CN_KEY"',
    '    default_model: "gpt-5.6-sol"',
    "  www.api-codex.cn:",
    '    name: "www.api-codex.cn"',
    '    api: "https://www.api-codex.cn/v1"',
    '    key_env: "CUSTOM_PROVIDER_WWW_API_CODEX_CN_KEY"',
    '    default_model: "gpt-5.6-sol"',
    "",
  ].join("\n"));

  vi.doUnmock("./installer");
  const actualInstaller = await vi.importActual<typeof import("./installer")>("./installer");
  vi.doMock("./installer", () => actualInstaller);
  const [{ AgenteraProfileBindingStore }, runtime, modelDatabase, config] = await Promise.all([
    import("./agentera-profile-binding"),
    import("./model-configuration-runtime"),
    import("./model-configuration-database"),
    import("./config"),
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
  const handle = await runtime.prepareModelConfigurationRuntime({
    userDataPath: userData,
    getOwner: () => OWNER,
    profileBindings: bindings,
    getConnectionConfig: () => ({ mode: "local" }),
    openDatabase: (path) => modelDatabase.openModelConfigurationDatabase(path, {
      databaseFactory: (databasePath) => new DatabaseSync(databasePath) as unknown as ModelConfigurationSqliteDatabase,
    }),
  });
  return { handle, config };
}

function updateRequest(
  revision: string,
  providerId: string,
  providerLabel: string,
  baseUrl: string,
): UpsertModelServiceRequest & { activate?: boolean } {
  return {
    intent: "upsert",
    expectedCatalogRevision: revision,
    requestedProfileId: "default",
    providerId,
    provider: "custom",
    providerLabel,
    baseUrl,
    apiMode: "chat_completions",
    apiKey: "",
    models: [{ model: "gpt-5.6-sol", displayName: "gpt-5.6-sol" }],
    activeModel: "gpt-5.6-sol",
    activate: false,
  };
}

describe("multiple custom provider lifecycle", () => {
  it("saves a second provider without changing the active route", async () => {
    const { handle, config } = await makeRuntime("petoi");
    try {
      const catalog = handle.catalog!.snapshot("default");
      const result = await handle.coordinator!.mutate(
        updateRequest(
          catalog.revision,
          "codex-provider",
          "www.api-codex.cn",
          "https://www.api-codex.cn/v1",
        ),
      );
      expect(result).toMatchObject({ status: "committed" });
      expect(config.getModelConfigFresh("default")).toMatchObject({
        provider: "custom:petoi.cn",
        baseUrl: "https://petoi.cn/v1",
      });
    } finally {
      handle.close();
    }
  });

  it("edits an inactive provider without changing the active route", async () => {
    const { handle, config } = await makeRuntime("codex");
    try {
      const catalog = handle.catalog!.snapshot("default");
      const result = await handle.coordinator!.mutate(
        updateRequest(
          catalog.revision,
          "petoi-provider",
          "petoi.cn",
          "https://petoi.cn/v1",
        ),
      );
      expect(result).toMatchObject({ status: "committed" });
      expect(config.getModelConfigFresh("default")).toMatchObject({
        provider: "custom:www.api-codex.cn",
        baseUrl: "https://www.api-codex.cn/v1",
      });
    } finally {
      handle.close();
    }
  });

  it("adds a new provider without changing the active route", async () => {
    const { handle, config } = await makeRuntime("petoi");
    try {
      const catalog = handle.catalog!.snapshot("default");
      const result = await handle.coordinator!.mutate({
        ...updateRequest(
          catalog.revision,
          "",
          "new-provider.example",
          "https://new-provider.example/v1",
        ),
        providerId: undefined,
        apiKey: "new-provider-secret",
        activate: false,
      });
      expect(result).toMatchObject({ status: "committed" });
      expect(config.getModelConfigFresh("default")).toMatchObject({
        provider: "custom:petoi.cn",
        baseUrl: "https://petoi.cn/v1",
      });
    } finally {
      handle.close();
    }
  });

  it("edits the active provider and keeps its route active", async () => {
    const { handle, config } = await makeRuntime("petoi");
    try {
      const catalog = handle.catalog!.snapshot("default");
      const result = await handle.coordinator!.mutate({
        ...updateRequest(
          catalog.revision,
          "petoi-provider",
          "petoi.cn",
          "https://petoi.cn/v2",
        ),
        activate: true,
      });
      expect(result).toMatchObject({ status: "committed" });
      expect(config.getModelConfigFresh("default")).toMatchObject({
        provider: "custom:petoi.cn",
        baseUrl: "https://petoi.cn/v2",
      });
    } finally {
      handle.close();
    }
  });

  it("activates a named provider through the coordinated card path", async () => {
    const { handle, config } = await makeRuntime("codex");
    try {
      const catalog = handle.catalog!.snapshot("default");
      const result = await handle.coordinator!.mutate({
        ...updateRequest(
          catalog.revision,
          "petoi-provider",
          "petoi.cn",
          "https://petoi.cn/v1",
        ),
        activate: true,
      });
      expect(result).toMatchObject({ status: "committed" });
      expect(config.getModelConfigFresh("default")).toMatchObject({
        provider: "custom:petoi.cn",
        baseUrl: "https://petoi.cn/v1",
      });
    } finally {
      handle.close();
    }
  });
});
