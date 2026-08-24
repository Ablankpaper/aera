import { beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

const { TEST_HOME } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require("os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require("path");
  return {
    TEST_HOME: path.join(os.tmpdir(), `aera-gateway-managed-${Date.now()}`),
  };
});

vi.mock("../src/main/installer", () => ({
  HERMES_HOME: TEST_HOME,
  expectedEnvKeyForModel: () => null,
}));

type GatewayPlan = {
  credentialPlan: { after: Buffer | null; value: { key: string } };
  configPlan: { after: Buffer | null } | null;
};

type PlanGatewayManagedConfiguration = (
  profile: string | undefined,
  port: number,
) => GatewayPlan;

type PrepareGatewayManagedConfiguration = (
  profile: string | undefined,
  dependencies: {
    modelMutationPort: { mutate: ReturnType<typeof vi.fn> };
    resolvePort?: (profile?: string) => Promise<number>;
  },
) => Promise<{ key: string; port: number }>;

async function loadGatewayManagedConfig(): Promise<Record<string, unknown>> {
  try {
    return (await import(
      "../src/main/gateway-managed-config"
    )) as unknown as Record<string, unknown>;
  } catch {
    return {};
  }
}

beforeEach(() => {
  if (existsSync(TEST_HOME)) rmSync(TEST_HOME, { recursive: true, force: true });
  mkdirSync(TEST_HOME, { recursive: true });
  writeFileSync(join(TEST_HOME, ".env"), "API_SERVER_KEY=existing-key\n");
  writeFileSync(join(TEST_HOME, "config.yaml"), "model:\n  default: test\n");
});

describe("managed gateway bootstrap", () => {
  it("plans the API server block and credential without changing live files", async () => {
    const gatewayManagedConfig = await loadGatewayManagedConfig();
    const planner = (
      gatewayManagedConfig as unknown as {
        planGatewayManagedConfiguration?: PlanGatewayManagedConfiguration;
      }
    ).planGatewayManagedConfiguration;
    expect(planner).toBeTypeOf("function");
    if (!planner) return;
    const configPath = join(TEST_HOME, "config.yaml");
    const envPath = join(TEST_HOME, ".env");
    const configBefore = readFileSync(configPath);
    const envBefore = readFileSync(envPath);

    const plan = planner(undefined, 8642);

    expect(readFileSync(configPath)).toEqual(configBefore);
    expect(readFileSync(envPath)).toEqual(envBefore);
    expect(plan.credentialPlan.value.key).toBe("existing-key");
    const configAfter = plan.configPlan?.after?.toString("utf-8") ?? "";
    expect(configAfter).toContain("api_server:");
    expect(configAfter).toContain("port: 8642");
    expect(configAfter).toContain('host: "127.0.0.1"');
  });

  it("repairs an existing API server block that omits its managed port", async () => {
    writeFileSync(
      join(TEST_HOME, "config.yaml"),
      [
        "platforms:",
        "  api_server:",
        "    enabled: true",
        "    extra:",
        '      host: "127.0.0.1"',
        "",
      ].join("\n"),
    );
    const gatewayManagedConfig = await loadGatewayManagedConfig();
    const planner = (
      gatewayManagedConfig as unknown as {
        planGatewayManagedConfiguration?: PlanGatewayManagedConfiguration;
      }
    ).planGatewayManagedConfiguration;
    expect(planner).toBeTypeOf("function");
    if (!planner) return;

    const plan = planner(undefined, 9123);
    const configAfter = plan.configPlan?.after?.toString("utf-8") ?? "";

    expect(plan.configPlan).not.toBeNull();
    expect(configAfter).toContain("port: 9123");
    expect(configAfter).toContain('host: "127.0.0.1"');
  });

  it("migrates a legacy openai-compatible model route before Gateway startup", async () => {
    writeFileSync(
      join(TEST_HOME, "config.yaml"),
      [
        "model:",
        "  provider: openai",
        "  default: fixture-model",
        '  base_url: "http://127.0.0.1:19001/v1"',
        "",
      ].join("\n"),
    );
    const gatewayManagedConfig = await loadGatewayManagedConfig();
    const planner = (
      gatewayManagedConfig as unknown as {
        planGatewayManagedConfiguration?: PlanGatewayManagedConfiguration;
      }
    ).planGatewayManagedConfiguration;
    expect(planner).toBeTypeOf("function");
    if (!planner) return;

    const plan = planner(undefined, 8642);
    const configAfter = plan.configPlan?.after?.toString("utf-8") ?? "";

    expect(configAfter).toContain('provider: "custom"');
    expect(configAfter).toContain('base_url: "http://127.0.0.1:19001/v1"');
    expect(configAfter).toContain("api_server:");
  });

  it("keeps an explicit default target on default files when another profile is active", async () => {
    mkdirSync(join(TEST_HOME, "profiles", "active-space"), { recursive: true });
    writeFileSync(join(TEST_HOME, "active_profile"), "active-space\n");
    writeFileSync(
      join(TEST_HOME, "profiles", "active-space", ".env"),
      "API_SERVER_KEY=active-key\n",
    );
    writeFileSync(
      join(TEST_HOME, "profiles", "active-space", "config.yaml"),
      "model:\n  default: active\n",
    );
    const gatewayManagedConfig = await loadGatewayManagedConfig();
    const planner = (
      gatewayManagedConfig as unknown as {
        planGatewayManagedConfiguration?: PlanGatewayManagedConfiguration;
      }
    ).planGatewayManagedConfiguration;
    expect(planner).toBeTypeOf("function");
    if (!planner) return;

    const plan = planner("default", 8642);

    expect(plan.credentialPlan.profileId).toBe("default");
    expect(plan.credentialPlan.target).toBe(join(TEST_HOME, ".env"));
    expect(plan.credentialPlan.value.key).toBe("existing-key");
    expect(plan.configPlan?.target).toBe(join(TEST_HOME, "config.yaml"));
    expect(plan.configPlan?.after?.toString("utf-8")).toContain("port: 8642");
  });

  it("uses one managed mutation and leaves both files unchanged on recovery refusal", async () => {
    const gatewayManagedConfig = await loadGatewayManagedConfig();
    const prepare = (
      gatewayManagedConfig as unknown as {
        prepareGatewayManagedConfiguration?: PrepareGatewayManagedConfiguration;
      }
    ).prepareGatewayManagedConfiguration;
    expect(prepare).toBeTypeOf("function");
    if (!prepare) return;
    const configPath = join(TEST_HOME, "config.yaml");
    const envPath = join(TEST_HOME, ".env");
    const configBefore = readFileSync(configPath);
    const envBefore = readFileSync(envPath);
    const mutationPort = {
      mutate: vi.fn(async () => ({
        status: "rejected" as const,
        stage: "recovery" as const,
        code: "model_configuration_recovery_required" as const,
        rollback: "recovery_required" as const,
        diagnosticId: "0123456789ab",
      })),
    };

    await expect(
      prepare(undefined, {
        modelMutationPort: mutationPort,
        resolvePort: async () => 8642,
      }),
    ).rejects.toThrow("model_configuration_recovery_required");
    expect(mutationPort.mutate).toHaveBeenCalledTimes(1);
    expect(readFileSync(configPath)).toEqual(configBefore);
    expect(readFileSync(envPath)).toEqual(envBefore);
  });

  it("plans from the locked bytes when config changes before mutation admission", async () => {
    const gatewayManagedConfig = await loadGatewayManagedConfig();
    const prepare = (
      gatewayManagedConfig as unknown as {
        prepareGatewayManagedConfiguration?: PrepareGatewayManagedConfiguration;
      }
    ).prepareGatewayManagedConfiguration;
    expect(prepare).toBeTypeOf("function");
    if (!prepare) return;

    const authorityModule = await import(
      "../src/main/model-configuration-write-authority"
    );
    const authority = new authorityModule.ModelConfigurationWriteAuthority();
    authorityModule.registerManagedModelFileRoots({
      globalRoot: TEST_HOME,
      profiles: { default: TEST_HOME },
    });
    const configPath = join(TEST_HOME, "config.yaml");
    const mutationPort = {
      mutate: vi.fn(async (input: { prepare: () => PromiseLike<unknown> | unknown }) => {
        writeFileSync(
          configPath,
          [
            "model:",
            "  provider: openai",
            "  default: fixture-model",
            '  base_url: "http://127.0.0.1:19001/v1"',
            "feature_flag: true",
            "",
          ].join("\n"),
        );
        const planned = (await input.prepare()) as {
          write: (permit: unknown) => unknown;
        };
        return authority.run(
          { globalCatalog: false, profileIds: ["default"] },
          async (permit) => ({
            status: "executed" as const,
            value: await planned.write(permit),
            catalog: {
              revision: "0".repeat(64),
              targetProfileId: "default",
              routes: [],
            },
          }),
        );
      }),
    };

    try {
      await expect(
        prepare("default", {
          modelMutationPort: mutationPort,
          resolvePort: async () => 8642,
        }),
      ).resolves.toMatchObject({ port: 8642 });
      const finalConfig = readFileSync(configPath, "utf8");
      expect(finalConfig).toContain("feature_flag: true");
      expect(finalConfig).toContain('provider: "custom"');
      expect(finalConfig).toContain("api_server:");
    } finally {
      authorityModule.clearManagedModelFileRoots();
    }
  });
});
