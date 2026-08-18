// @vitest-environment node

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
const originalApiServerKey = process.env.API_SERVER_KEY;

function snapshot(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (directory: string): void => {
    if (!existsSync(directory)) return;
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) walk(path);
      else result[path.slice(root.length)] = readFileSync(path, "hex");
    }
  };
  walk(root);
  return result;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "aera-core-managed-writers-"));
  vi.stubEnv("HERMES_HOME", home);
  delete process.env.API_SERVER_KEY;
  writeFileSync(
    join(home, "desktop.json"),
    JSON.stringify({
      connectionContextId: "11111111-1111-4111-8111-111111111111",
      connectionMode: "local",
    }),
  );
  writeFileSync(join(home, ".env"), "EXISTING_KEY=value\n");
  writeFileSync(
    join(home, "providers.json"),
    JSON.stringify({
      version: 1,
      providers: [
        {
          id: "provider-1",
          name: "Existing",
          baseUrl: "https://existing.invalid/v1",
          createdAt: 1,
        },
      ],
    }),
  );
  writeFileSync(
    join(home, "models.json"),
    JSON.stringify([
      {
        id: "model-1",
        name: "Existing",
        provider: "custom",
        model: "existing-model",
        baseUrl: "https://existing.invalid/v1",
        createdAt: 1,
      },
    ]),
  );
  writeFileSync(
    join(home, "model-definitions.json"),
    JSON.stringify({
      "existing-model": {
        model: "existing-model",
        contextLength: 8192,
        createdAt: 1,
        updatedAt: 1,
      },
    }),
  );
  writeFileSync(
    join(home, "config.yaml"),
    [
      "model:",
      "  provider: custom:existing",
      "  default: existing-model",
      "  base_url: https://existing.invalid/v1",
      "providers:",
      "  existing:",
      "    name: Existing",
      "    api: https://existing.invalid/v1",
      "    key_env: CUSTOM_PROVIDER_EXISTING_KEY",
      "",
    ].join("\n"),
  );
});

afterEach(async () => {
  const { clearManagedModelFileRoots } =
    await import("./model-configuration-managed-files");
  clearManagedModelFileRoots();
  vi.unstubAllEnvs();
  vi.resetModules();
  if (originalApiServerKey === undefined) delete process.env.API_SERVER_KEY;
  else process.env.API_SERVER_KEY = originalApiServerKey;
  rmSync(home, { recursive: true, force: true });
});

describe("core managed model writers", () => {
  it("keeps core config planners byte-pure and requires an explicit permit to persist", async () => {
    const [managed, authority, config] = await Promise.all([
      import("./model-configuration-managed-files"),
      import("./model-configuration-write-authority"),
      import("./config"),
    ]);
    managed.registerManagedModelFileRoots({
      globalRoot: home,
      profiles: { default: home },
    });
    const planners = [
      () => config.planEnvValueWrite("NEW_KEY", "value", "default"),
      () => config.planConfigValueWrite("timezone", "UTC", "default"),
      () =>
        config.planModelConfigWrite(
          "custom:new",
          "new-model",
          "https://new.invalid/v1",
          "default",
        ),
      () => config.planLocalApiServerKeyWrite("default"),
      () => config.planPlatformEnabledWrite("telegram", false, "default"),
    ];

    for (const createPlan of planners) {
      const before = snapshot(home);
      const plan = createPlan();
      expect(snapshot(home)).toEqual(before);
      expect(() => config.persistConfigWritePlan<unknown>(null, plan)).toThrow(
        expect.objectContaining({
          code: "model_configuration_write_permit_required",
        }),
      );
      expect(snapshot(home)).toEqual(before);
    }

    const plan = config.planEnvValueWrite(
      "EXPLICIT_PERMIT_KEY",
      "saved",
      "default",
    );
    const writeAuthority = new authority.ModelConfigurationWriteAuthority();
    await writeAuthority.run(
      { globalCatalog: false, profileIds: ["default"] },
      (permit) => config.persistConfigWritePlan(permit, plan),
    );
    expect(readFileSync(join(home, ".env"), "utf8")).toContain(
      "EXPLICIT_PERMIT_KEY=saved",
    );
  });

  it("composes multiple credential edits into one stale-safe env plan", async () => {
    const [managed, authority, config] = await Promise.all([
      import("./model-configuration-managed-files"),
      import("./model-configuration-write-authority"),
      import("./config"),
    ]);
    managed.registerManagedModelFileRoots({
      globalRoot: home,
      profiles: { default: home },
    });

    const original = readFileSync(join(home, ".env"));
    const first = config.planEnvValueWrite(
      "CUSTOM_PROVIDER_NEW_KEY",
      "new-secret",
      "default",
    );
    const combined = config.planEnvValueWrite(
      "CUSTOM_PROVIDER_OLD_KEY",
      "",
      "default",
      first,
    );

    expect(readFileSync(join(home, ".env"))).toEqual(original);
    expect(combined.before).toEqual(original);
    expect(combined.after?.toString("utf8")).toContain(
      "CUSTOM_PROVIDER_NEW_KEY=new-secret",
    );
    expect(combined.after?.toString("utf8")).toContain(
      "CUSTOM_PROVIDER_OLD_KEY=",
    );

    const writeAuthority = new authority.ModelConfigurationWriteAuthority();
    await writeAuthority.run(
      { globalCatalog: false, profileIds: ["default"] },
      (permit) => config.persistConfigWritePlan(permit, combined),
    );
    const persisted = readFileSync(join(home, ".env"), "utf8");
    expect(persisted).toContain("CUSTOM_PROVIDER_NEW_KEY=new-secret");
    expect(persisted).toContain("CUSTOM_PROVIDER_OLD_KEY=");
  });

  it("keeps model catalog planners byte-pure and requires the global permit", async () => {
    const [managed, authority, models] = await Promise.all([
      import("./model-configuration-managed-files"),
      import("./model-configuration-write-authority"),
      import("./models"),
    ]);
    managed.registerManagedModelFileRoots({
      globalRoot: home,
      profiles: { default: home },
    });
    const planners = [
      () =>
        models.planAddModel(
          "New",
          "custom",
          "new-model",
          "https://new.invalid/v1",
          16384,
        ),
      () => models.planUpdateModel("model-1", { name: "Renamed" }),
      () => models.planRemoveModel("model-1"),
      () =>
        models.planSetModelDefinition("new-model", {
          contextLength: 16384,
        }),
      () => models.planRemoveModelDefinition("existing-model"),
    ];

    for (const createPlan of planners) {
      const before = snapshot(home);
      const plan = createPlan();
      expect(snapshot(home)).toEqual(before);
      expect(() =>
        models.persistModelCatalogWritePlan<unknown>(null, plan),
      ).toThrow(
        expect.objectContaining({
          code: "model_configuration_write_permit_required",
        }),
      );
      expect(snapshot(home)).toEqual(before);
    }

    const plan = models.planAddModel(
      "Explicit",
      "custom",
      "explicit-model",
      "https://explicit.invalid/v1",
    );
    const writeAuthority = new authority.ModelConfigurationWriteAuthority();
    await writeAuthority.run(
      { globalCatalog: true, profileIds: ["default"] },
      (permit) => models.persistModelCatalogWritePlan(permit, plan),
    );
    expect(
      models.listModels().some((model) => model.model === "explicit-model"),
    ).toBe(true);
  });

  it("reject every uncoordinated core writer before managed bytes change", async () => {
    const [managed, config, models, providers, native, health] =
      await Promise.all([
        import("./model-configuration-managed-files"),
        import("./config"),
        import("./models"),
        import("./providers-store"),
        import("./native-custom-provider"),
        import("./config-health"),
      ]);
    managed.registerManagedModelFileRoots({
      globalRoot: home,
      profiles: { default: home },
    });

    const cases: Array<{ name: string; run(): unknown }> = [
      {
        name: "setEnvValue",
        run: () => config.setEnvValue("NEW_KEY", "value", "default"),
      },
      {
        name: "setConfigValue",
        run: () => config.setConfigValue("timezone", "UTC", "default"),
      },
      {
        name: "setModelConfig",
        run: () =>
          config.setModelConfig(
            "custom:new",
            "new-model",
            "https://new.invalid/v1",
            "default",
          ),
      },
      {
        name: "ensureLocalApiServerKey",
        run: () => config.ensureLocalApiServerKey("default"),
      },
      {
        name: "setPlatformEnabled",
        run: () => config.setPlatformEnabled("telegram", false, "default"),
      },
      {
        name: "addModel",
        run: () =>
          models.addModel(
            "New",
            "custom",
            "new-model",
            "https://new.invalid/v1",
          ),
      },
      {
        name: "updateModel",
        run: () => models.updateModel("model-1", { name: "Renamed" }),
      },
      { name: "removeModel", run: () => models.removeModel("model-1") },
      {
        name: "setModelDefinition",
        run: () =>
          models.setModelDefinition("new-model", { contextLength: 16384 }),
      },
      {
        name: "removeModelDefinition",
        run: () => models.removeModelDefinition("existing-model"),
      },
      {
        name: "upsertCustomProvider",
        run: () =>
          providers.upsertCustomProvider("default", {
            name: "New",
            baseUrl: "https://new.invalid/v1",
          }),
      },
      {
        name: "removeCustomProvider",
        run: () => providers.removeCustomProvider("default", "Existing"),
      },
      {
        name: "upsertNativeCustomProvider",
        run: () =>
          native.upsertNativeCustomProvider("default", {
            name: "New",
            baseUrl: "https://new.invalid/v1",
          }),
      },
      {
        name: "removeNativeCustomProvider",
        run: () => native.removeNativeCustomProvider("default", "Existing"),
      },
    ];

    for (const entry of cases) {
      const before = snapshot(home);
      expect(entry.run, entry.name).toThrow(
        expect.objectContaining({
          code: "model_configuration_write_permit_required",
        }),
      );
      expect(snapshot(home), entry.name).toEqual(before);
    }

    writeFileSync(
      join(home, "config.yaml"),
      ["api_server:", "  token: legacy-server-key", ""].join("\n"),
    );
    const beforeHealthFix = snapshot(home);
    expect(
      health.autoFixIssue("API_SERVER_KEY_NON_CANONICAL", "default"),
    ).toMatchObject({ ok: false, message: expect.stringMatching(/permit/i) });
    expect(snapshot(home)).toEqual(beforeHealthFix);
  });
});
