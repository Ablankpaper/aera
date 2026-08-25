// @vitest-environment node

import { describe, expect, it, vi, type MockedFunction } from "vitest";
import type { ConnectionConfig } from "../config";
import type { GatewayStartResult } from "../hermes";
import {
  ensureActivatedProfileGatewayReady,
  type ProfileGatewayReadinessDependencies,
} from "./profile-gateway-readiness";

const connection = (mode: ConnectionConfig["mode"]): ConnectionConfig => ({
  connectionContextId: "test",
  mode,
  remoteUrl: "",
  apiKey: "",
  remoteAuthMode: "auto",
  remoteChatTransport: "auto",
  sshChatTransport: "auto",
  ssh: {
    host: "example.test",
    port: 22,
    username: "aera",
    keyPath: "",
    remotePort: 8642,
    localPort: 18642,
  },
});

type TestDependencies = {
  [Key in keyof ProfileGatewayReadinessDependencies]: MockedFunction<
    ProfileGatewayReadinessDependencies[Key]
  >;
};

function dependencies(): TestDependencies {
  return {
    isGatewayRunning: vi.fn(() => false),
    prepareGatewayForLaunch: vi.fn(async () => ({
      key: "prepared-key",
      port: 9751,
    })),
    startGatewayWithReadiness: vi.fn(
      async (): Promise<GatewayStartResult> => ({
        success: true,
        running: true,
        ready: true,
      }),
    ),
    startGatewayWithRecovery: vi.fn(async () => true),
    sshStartGatewayAndWaitApiReady: vi.fn(async () => ({
      ready: true,
      port: 9751,
    })),
  };
}

describe("activated Profile Gateway readiness", () => {
  it("does not skip recovery when a local process is live but its API is unhealthy", async () => {
    const deps = dependencies();
    deps.isGatewayRunning.mockReturnValue(true);
    deps.startGatewayWithRecovery.mockResolvedValue(false);

    await expect(
      ensureActivatedProfileGatewayReady(connection("local"), "research", deps),
    ).resolves.toBe(false);

    expect(deps.startGatewayWithRecovery).toHaveBeenCalledWith("research");
    expect(deps.prepareGatewayForLaunch).not.toHaveBeenCalled();
    expect(deps.startGatewayWithReadiness).not.toHaveBeenCalled();
  });

  it("propagates a new local Gateway readiness failure", async () => {
    const deps = dependencies();
    deps.startGatewayWithReadiness.mockResolvedValue({
      success: false,
      running: false,
      ready: false,
      error: "not ready",
    });

    await expect(
      ensureActivatedProfileGatewayReady(connection("local"), "research", deps),
    ).resolves.toBe(false);

    expect(deps.startGatewayWithReadiness).toHaveBeenCalledWith("research", {
      key: "prepared-key",
      port: 9751,
    });
  });

  it("propagates SSH API readiness instead of remote PID liveness", async () => {
    const deps = dependencies();
    deps.sshStartGatewayAndWaitApiReady.mockResolvedValue({
      ready: false,
      port: 9751,
    });

    await expect(
      ensureActivatedProfileGatewayReady(connection("ssh"), "research", deps),
    ).resolves.toBe(false);

    expect(deps.sshStartGatewayAndWaitApiReady).toHaveBeenCalledWith(
      connection("ssh").ssh,
      "research",
      30_000,
    );
  });
});
