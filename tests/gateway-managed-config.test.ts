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
});
