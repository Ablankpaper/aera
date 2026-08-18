import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "path";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";

const { TEST_HOME } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require("path");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require("os");
  return {
    TEST_HOME: path.join(os.tmpdir(), `hermes-platform-state-${Date.now()}`),
  };
});

vi.mock("../src/main/installer", () => ({
  HERMES_HOME: TEST_HOME,
}));

vi.mock("../src/main/utils", async () => {
  const actual =
    await vi.importActual<typeof import("../src/main/utils")>(
      "../src/main/utils",
    );
  return {
    ...actual,
    profileHome: (profile?: string) =>
      profile && profile !== "default"
        ? join(TEST_HOME, "profiles", profile)
        : TEST_HOME,
  };
});

import * as messagingPlatforms from "../src/main/messaging-platforms";

type ManagedMessagingPlan = {
  envPlan: { before: Buffer | null; after: Buffer | null } | null;
  configPlan: { before: Buffer | null; after: Buffer | null } | null;
};

type PlanManagedMessagingPlatformUpdate = (
  platform: string,
  update: {
    clear_env?: string[];
    enabled?: boolean;
    env?: Record<string, string>;
    toolsets?: Record<string, boolean>;
  },
  profile?: string,
) => ManagedMessagingPlan;

type ApplyManagedMessagingPlatformUpdate = (
  platform: string,
  update: {
    clear_env?: string[];
    enabled?: boolean;
    env?: Record<string, string>;
    toolsets?: Record<string, boolean>;
  },
  profile: string | undefined,
  dependencies: { modelMutationPort: { mutate: ReturnType<typeof vi.fn> } },
) => Promise<{ ok: boolean; platform: string }>;

const readLocalGatewayPlatformStates =
  messagingPlatforms.readLocalGatewayPlatformStates;

beforeEach(() => {
  mkdirSync(TEST_HOME, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_HOME)) {
    rmSync(TEST_HOME, { recursive: true, force: true });
  }
});

describe("readLocalGatewayPlatformStates", () => {
  it("ignores stale gateway state when the gateway is not running", () => {
    writeFileSync(
      join(TEST_HOME, "gateway_state.json"),
      JSON.stringify({
        pid: 12345,
        gateway_state: "running",
        platforms: { telegram: { state: "connected" } },
      }),
    );

    expect(readLocalGatewayPlatformStates(undefined, false)).toEqual({});
  });

  it("trusts the caller-provided gateway liveness state", () => {
    writeFileSync(
      join(TEST_HOME, "gateway_state.json"),
      JSON.stringify({
        pid: 99999,
        gateway_state: "running",
        platforms: { telegram: { state: "connected" } },
      }),
    );

    expect(readLocalGatewayPlatformStates(undefined, true)).toMatchObject({
      telegram: { state: "connected" },
    });
  });

  it("returns live platform states and aliases known platform keys", () => {
    writeFileSync(
      join(TEST_HOME, "gateway_state.json"),
      JSON.stringify({
        pid: 12345,
        gateway_state: "running",
        platforms: {
          telegram: { state: "connected", updated_at: "now" },
          webhook: { state: "running" },
        },
      }),
    );

    expect(readLocalGatewayPlatformStates(undefined, true)).toMatchObject({
      telegram: { state: "connected", updated_at: "now" },
      webhook: { state: "running" },
      webhooks: { state: "running" },
    });
  });

  it("reads the root gateway state when the active profile is default", () => {
    writeFileSync(
      join(TEST_HOME, "gateway_state.json"),
      JSON.stringify({
        pid: 12345,
        gateway_state: "running",
        platforms: { telegram: { state: "connected" } },
      }),
    );

    expect(readLocalGatewayPlatformStates("default", true)).toMatchObject({
      telegram: { state: "connected" },
    });
  });
});

describe("managed local messaging updates", () => {
  it("plans env, enabled state, and toolsets without changing live bytes", () => {
    const configPath = join(TEST_HOME, "config.yaml");
    const envPath = join(TEST_HOME, ".env");
    const configBefore = [
      "telegram:",
      "  enabled: false",
      "platform_toolsets:",
      "  telegram:",
      "      - memory",
      "",
    ].join("\n");
    const envBefore = [
      "TELEGRAM_BOT_TOKEN=old-token",
      "TELEGRAM_PROXY=http://old-proxy",
      "",
    ].join("\n");
    writeFileSync(configPath, configBefore);
    writeFileSync(envPath, envBefore);

    const planner = (
      messagingPlatforms as unknown as {
        planManagedMessagingPlatformUpdate?: PlanManagedMessagingPlatformUpdate;
      }
    ).planManagedMessagingPlatformUpdate;

    expect(planner).toBeTypeOf("function");
    if (!planner) return;
    const plan = planner(
      "telegram",
      {
        clear_env: ["TELEGRAM_PROXY"],
        enabled: true,
        env: { TELEGRAM_BOT_TOKEN: "  replacement-token  " },
        toolsets: { browser: true, memory: false },
      },
      undefined,
    );

    expect(readFileSync(envPath, "utf-8")).toBe(envBefore);
    expect(readFileSync(configPath, "utf-8")).toBe(configBefore);
    expect(plan.envPlan?.after?.toString("utf-8")).toContain(
      "TELEGRAM_BOT_TOKEN=replacement-token",
    );
    expect(plan.envPlan?.after?.toString("utf-8")).toContain("TELEGRAM_PROXY=");
    const configAfter = plan.configPlan?.after?.toString("utf-8") ?? "";
    expect(configAfter).not.toContain("enabled: false");
    expect(configAfter).toContain("      - browser");
    expect(configAfter).not.toContain("      - memory");
  });

  it("uses one managed mutation and performs no write when recovery refuses it", async () => {
    const configPath = join(TEST_HOME, "config.yaml");
    const envPath = join(TEST_HOME, ".env");
    writeFileSync(configPath, "telegram:\n  enabled: false\n");
    writeFileSync(envPath, "TELEGRAM_BOT_TOKEN=old-token\n");
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
    const applyManaged = (
      messagingPlatforms as unknown as {
        applyManagedMessagingPlatformUpdate?: ApplyManagedMessagingPlatformUpdate;
      }
    ).applyManagedMessagingPlatformUpdate;

    expect(applyManaged).toBeTypeOf("function");
    if (!applyManaged) return;
    await expect(
      applyManaged(
        "telegram",
        {
          enabled: true,
          env: { TELEGRAM_BOT_TOKEN: "replacement-token" },
          toolsets: { browser: true },
        },
        undefined,
        { modelMutationPort: mutationPort },
      ),
    ).rejects.toThrow("model_configuration_recovery_required");

    expect(mutationPort.mutate).toHaveBeenCalledTimes(1);
    expect(readFileSync(configPath)).toEqual(configBefore);
    expect(readFileSync(envPath)).toEqual(envBefore);
  });
});
