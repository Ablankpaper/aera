import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let home = "";

async function prepareManagedWrites(): Promise<
  import("../src/main/model-configuration-write-authority").ModelConfigurationWriteAuthority
> {
  const [managed, authority] = await Promise.all([
    import("../src/main/model-configuration-managed-files"),
    import("../src/main/model-configuration-write-authority"),
  ]);
  managed.registerManagedModelFileRoots({
    globalRoot: home,
    profiles: { default: home },
  });
  return new authority.ModelConfigurationWriteAuthority();
}

function snapshot(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (directory: string): void => {
    if (!existsSync(directory)) return;
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) walk(path);
      else result[path.slice(root.length)] = readFileSync(path, "hex");
    }
  };
  walk(root);
  return result;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "aera-model-read-side-effects-"));
  vi.stubEnv("HERMES_HOME", home);
});

afterEach(async () => {
  const { clearManagedModelFileRoots } =
    await import("../src/main/model-configuration-managed-files");
  clearManagedModelFileRoots();
  vi.unstubAllEnvs();
  vi.resetModules();
  rmSync(home, { recursive: true, force: true });
});

describe("model configuration reads", () => {
  // @lat: [[beta27-reliability-plan#Recoverable model configuration#Model reads are byte side-effect free]]
  it("leave absent and legacy model stores byte-for-byte unchanged", async () => {
    const models = await import("../src/main/models");
    const absent = snapshot(home);
    models.listModels();
    models.listModelDefinitions();
    expect(snapshot(home)).toEqual(absent);

    const rows = [
      {
        id: "legacy",
        name: "Legacy",
        provider: "custom",
        model: "legacy-model",
        baseUrl: "https://example.invalid/v1",
        contextLength: 32768,
        createdAt: 1,
      },
    ];
    writeFileSync(join(home, "models.json"), JSON.stringify(rows));
    const before = snapshot(home);

    models.listModels();
    models.listModelDefinitions();

    expect(snapshot(home)).toEqual(before);
  });

  it("does not migrate a non-canonical API key during a read", async () => {
    writeFileSync(
      join(home, "config.yaml"),
      'api_server:\n  token: "legacy-token"\n',
    );
    const config = await import("../src/main/config");
    const before = snapshot(home);

    expect(config.getApiServerKey("default")).toBe("legacy-token");
    config.getModelConfig("default");
    config.getModelContextLengthOverride("default");
    config.resolveApiServerKeyWithSource({
      configTopLevelProfile: null,
      configTopLevelDefault: null,
      envProfile: null,
      envDefault: null,
      apiServerTokenProfile: "legacy-token",
      apiServerTokenDefault: null,
    });

    expect(snapshot(home)).toEqual(before);
  });
});

describe("explicit model catalog initialization", () => {
  it("seeds the catalog and derived credentials once without restoring read side effects", async () => {
    writeFileSync(
      join(home, "config.yaml"),
      [
        "api_server:",
        "  token: legacy-token",
        "custom_providers:",
        '  - name: "InternalBetaRelay"',
        '    provider: "custom"',
        '    model: "gpt-5.6-sol"',
        '    base_url: "https://api.petoi.cn/v1"',
        '    api_key: "relay-key"',
        "",
      ].join("\n"),
    );
    const models = await import("../src/main/models");
    const writeAuthority = await prepareManagedWrites();
    let journalCount = 0;
    const coordinator = {
      initializeManagedModelFiles: async (input: {
        targetProfileId: string;
        changesRequired: boolean;
        applyStage(
          stage: string,
          permit: import("../src/main/model-configuration-managed-files").ModelConfigurationWritePermit,
        ): Promise<void> | void;
        verify(): Promise<boolean> | boolean;
      }) =>
        writeAuthority.run(
          {
            globalCatalog: true,
            profileIds: [input.targetProfileId],
          },
          async (permit) => {
            if (input.changesRequired) {
              journalCount += 1;
              for (const stage of [
                "credential",
                "provider",
                "model_library",
                "native_route",
                "activation",
              ]) {
                await input.applyStage(stage, permit);
              }
            }
            expect(await input.verify()).toBe(true);
            return {
              status: "committed" as const,
              catalog: {
                revision: "a".repeat(64),
                targetProfileId: "default",
                routes: [],
              },
            };
          },
        ),
    };

    const firstPlan = models.planModelCatalogInitialization(["default"]);
    expect(firstPlan).toMatchObject({
      seedDefaultModels: true,
      migrateModelDefinitions: false,
    });
    await models.initializeModelCatalog(coordinator, firstPlan);

    const env = readFileSync(join(home, ".env"), "utf8");
    expect(env).toMatch(/^API_SERVER_KEY=legacy-token$/m);
    expect(env).toMatch(/^CUSTOM_PROVIDER_INTERNALBETARELAY_KEY=relay-key$/m);
    expect(env).toMatch(/^PETOI_API_KEY=relay-key$/m);
    expect(models.listModels()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ model: "gpt-5.6-sol" }),
      ]),
    );
    expect(journalCount).toBe(1);

    const afterFirst = snapshot(home);
    const secondPlan = models.planModelCatalogInitialization(["default"]);
    await models.initializeModelCatalog(coordinator, secondPlan);
    expect(snapshot(home)).toEqual(afterFirst);
    expect(journalCount).toBe(1);
  });

  it("moves legacy model metadata only when the explicit command runs", async () => {
    const rows = [
      {
        id: "legacy",
        name: "Legacy",
        provider: "custom",
        model: "legacy-model",
        baseUrl: "https://example.invalid/v1",
        contextLength: 32768,
        createdAt: 1,
      },
    ];
    writeFileSync(join(home, "models.json"), JSON.stringify(rows));
    const models = await import("../src/main/models");
    const writeAuthority = await prepareManagedWrites();
    const before = snapshot(home);

    models.listModels();
    expect(snapshot(home)).toEqual(before);

    const plan = models.planModelCatalogInitialization(["default"]);
    expect(plan.migrateModelDefinitions).toBe(true);
    await models.initializeModelCatalog(
      {
        initializeManagedModelFiles: async (input) => {
          return writeAuthority.run(
            {
              globalCatalog: true,
              profileIds: [input.targetProfileId],
            },
            async (permit) => {
              for (const stage of [
                "credential",
                "provider",
                "model_library",
                "native_route",
                "activation",
              ] as const) {
                await input.applyStage(stage, permit);
              }
              expect(await input.verify()).toBe(true);
              return {
                status: "committed" as const,
                catalog: {
                  revision: "b".repeat(64),
                  targetProfileId: "default",
                  routes: [],
                },
              };
            },
          );
        },
      },
      plan,
    );

    expect(
      JSON.parse(readFileSync(join(home, "models.json"), "utf8"))[0],
    ).not.toHaveProperty("contextLength");
    expect(
      JSON.parse(readFileSync(join(home, "model-definitions.json"), "utf8"))[
        "legacy-model"
      ],
    ).toMatchObject({ contextLength: 32768 });
  });

  it("rejects a no-op plan when managed bytes change before admission", async () => {
    writeFileSync(join(home, "models.json"), "[]");
    const models = await import("../src/main/models");
    const plan = models.planModelCatalogInitialization(["default"]);
    expect(plan).toMatchObject({
      seedDefaultModels: false,
      migrateModelDefinitions: false,
      persistDerivedCredentials: [],
    });
    writeFileSync(
      join(home, "models.json"),
      '[{"id":"raced","model":"raced"}]',
    );

    await models.initializeModelCatalog(
      {
        initializeManagedModelFiles: async (input) => {
          expect(input.changesRequired).toBe(false);
          expect(await input.verify()).toBe(false);
          return {
            status: "rejected" as const,
            stage: "verification" as const,
            code: "model_save_verification_failed" as const,
            rollback: "not_needed" as const,
          };
        },
      },
      plan,
    );
  });
});
