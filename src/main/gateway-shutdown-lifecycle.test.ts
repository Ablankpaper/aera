// @vitest-environment node

import { EventEmitter } from "node:events";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { ChildProcess } from "node:child_process";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const {
  TEST_HOME,
  TEST_OWNERSHIP_ROOT,
  invocation,
  spawnRef,
  terminateRef,
  terminatePidRef,
  pidAliveRef,
  apiKeyRef,
  agentDestroyCalls,
  agentInstances,
} = vi.hoisted(() => ({
  TEST_HOME: "/tmp/aera-gateway-drain-lifecycle-test",
  TEST_OWNERSHIP_ROOT: "/tmp/aera-gateway-drain-lifecycle-test/user-data",
  invocation: {
    source: "managed" as const,
    version: "0.20.0-agentera.1",
    sourceCommit: "a".repeat(40),
    root: "/tmp/runtime/test",
    python: "/tmp/runtime/test/python/bin/python3",
    workingDirectory: "/tmp/runtime/test/python/lib/python3.11/site-packages",
    bundledSkillsDirectory: "/tmp/runtime/test/python/skills",
    webDistDirectory:
      "/tmp/runtime/test/python/lib/python3.11/site-packages/hermes_cli/web_dist",
    cliArgs: (args: string[] = []) => ["-m", "hermes_cli.main", ...args],
    environment: (base: Record<string, string> = {}) => ({ ...base }),
  },
  spawnRef: { value: vi.fn() },
  agentDestroyCalls: { value: 0 },
  terminateRef: {
    value: vi.fn(),
  },
  terminatePidRef: {
    value: vi.fn(),
  },
  pidAliveRef: {
    value: vi.fn((..._args: unknown[]) => false),
  },
  apiKeyRef: { value: "generated-internal-token" },
  agentInstances: { value: [] as Array<{ destroyed: boolean }> },
}));

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) =>
      spawnRef.value(...args),
  };
});
vi.mock("http", () => {
  const request = vi.fn(
    (
      _url: string,
      options: Record<string, unknown>,
      callback: (response: {
        statusCode: number;
        destroy: () => void;
        resume: () => void;
      }) => void,
    ) => {
      const req = new EventEmitter() as EventEmitter & {
        end: () => void;
        destroy: () => void;
      };
      req.end = () => {
        queueMicrotask(() =>
          callback({
            statusCode:
              typeof options.headers === "object" &&
              options.headers !== null &&
              "Authorization" in options.headers
                ? 200
                : 401,
            destroy: () => {},
            resume: () => {},
          }),
        );
      };
      req.destroy = () => {};
      return req;
    },
  );
  // hermes.ts keeps dedicated keep-alive agents for loopback gateway calls so
  // it can drop those sockets before SIGTERM. Track destroy() to assert the
  // drain happens while the gateway is still listening.
  class Agent {
    private readonly instance = { destroyed: false };

    constructor() {
      agentInstances.value.push(this.instance);
    }

    destroy(): void {
      this.instance.destroyed = true;
      agentDestroyCalls.value += 1;
    }
  }
  return { default: { request, Agent }, request, Agent };
});
vi.mock("./installer", () => ({
  HERMES_HOME: TEST_HOME,
  getEnhancedPath: vi.fn(() => "/usr/bin"),
}));
vi.mock("./agentera-runtime-distribution/invocation", () => ({
  getRuntimeInvocation: vi.fn(() => invocation),
}));
vi.mock("./config", () => ({
  ensureLocalApiServerKey: vi.fn(() => ({
    generated: true,
    key: "generated-internal-token",
  })),
  // Direct startGatewayDetailed() tests model a credential that was already
  // prepared by the managed bootstrap transaction. The launch path must not
  // create or persist credentials itself.
  getApiServerKey: vi.fn(() => apiKeyRef.value),
  getConnectionConfig: vi.fn(() => ({ mode: "local" })),
  getConfigValue: vi.fn(() => null),
  getModelConfig: vi.fn(() => ({ provider: "auto", model: "", baseUrl: "" })),
  readEnv: vi.fn(() => ({})),
}));
vi.mock("./ssh-tunnel", () => ({
  getSshTunnelUrl: vi.fn(() => null),
  isSshTunnelActive: vi.fn(() => false),
  isSshTunnelHealthy: vi.fn(() => false),
  ensureSshTunnel: vi.fn(),
}));
vi.mock("./utils", () => ({
  pidIsAliveAs: (...args: unknown[]) => pidAliveRef.value(...args),
  stripAnsi: (value: string) => value,
  profileHome: vi.fn((profile?: string) =>
    profile ? `${TEST_HOME}/profiles/${profile}` : TEST_HOME,
  ),
  profilePaths: vi.fn((profile?: string) => ({
    configFile: profile
      ? `${TEST_HOME}/profiles/${profile}/config.yaml`
      : `${TEST_HOME}/config.yaml`,
    envFile: profile
      ? `${TEST_HOME}/profiles/${profile}/.env`
      : `${TEST_HOME}/.env`,
    home: profile ? `${TEST_HOME}/profiles/${profile}` : TEST_HOME,
  })),
  normalizeProfileName: (profile?: string) =>
    profile === "default" ? undefined : profile,
  getActiveProfileNameSync: vi.fn(() => undefined),
}));
vi.mock("./gateway-ports", () => ({
  ensureProfilePortAvailable: vi.fn(async () => 8642),
  getProfilePort: vi.fn(() => 8642),
  canBindLoopbackPort: vi.fn(async () => true),
  isLoopbackPortAccepting: vi.fn(async () => false),
  isLoopbackPortReleased: vi.fn(async () => true),
}));
vi.mock("./models", () => ({ readModels: vi.fn(() => []) }));
vi.mock("./secrets", () => ({
  getSecret: vi.fn(() => null),
  providerListSafe: vi.fn(() => ({})),
}));
vi.mock("./gatewayPrompt", () => ({
  promptSudoPassword: vi.fn(),
  promptSecretValue: vi.fn(),
}));
vi.mock("./process-tree", () => ({
  terminateProcessTree: (...args: unknown[]) => terminateRef.value(...args),
  terminateProcessTreeByPid: (...args: unknown[]) =>
    terminatePidRef.value(...args),
}));
vi.mock("./gateway-managed-config", () => ({
  prepareGatewayManagedConfiguration: vi.fn(async () => ({
    key: "generated-internal-token",
    port: 8642,
  })),
}));

import {
  configureGatewayManagedConfiguration,
  configureGatewayProcessOwnership,
  isGatewayHealthy,
  startGatewayDetailed,
  startGatewayWithRecovery,
  stopAeraOwnedGateways,
  stopGateway,
  stopHealthPolling,
} from "./hermes";
import { GatewayProcessOwnershipLedger } from "./gateway-process-ownership";

function fakeChildProcess(pid: number): ChildProcess {
  const proc = new EventEmitter() as ChildProcess;
  Object.assign(proc, {
    pid,
    exitCode: null,
    signalCode: null,
    killed: false,
    kill: vi.fn(() => true),
    unref: vi.fn(),
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  });
  return proc;
}

describe("ordinary gateway shutdown lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    rmSync(TEST_HOME, { recursive: true, force: true });
    mkdirSync(TEST_OWNERSHIP_ROOT, { recursive: true });
    spawnRef.value.mockReset();
    terminateRef.value.mockReset();
    terminatePidRef.value.mockReset();
    terminatePidRef.value.mockResolvedValue({
      forced: false,
      remainingPids: [],
    });
    pidAliveRef.value.mockReset();
    pidAliveRef.value.mockReturnValue(false);
    apiKeyRef.value = "generated-internal-token";
    agentDestroyCalls.value = 0;
    agentInstances.value = [];
    process.env.NODE_ENV = "test";
  });

  it("releases a stale durable launch before starting recovery", async () => {
    const prior = new GatewayProcessOwnershipLedger({
      userDataPath: TEST_OWNERSHIP_ROOT,
      desktopPid: process.pid + 1,
    });
    const launch = prior.beginLaunch({
      profileId: "recovery",
      preLaunchPid: null,
    });
    prior.markSpawned({
      profileId: "recovery",
      launchId: launch.launchId,
      spawnedPid: process.pid + 2,
    });

    const child = fakeChildProcess(process.pid);
    spawnRef.value.mockReturnValue(child);
    configureGatewayManagedConfiguration({
      modelMutationPort: { mutate: vi.fn() },
    });
    configureGatewayProcessOwnership(TEST_OWNERSHIP_ROOT);

    const result = await startGatewayWithRecovery(
      "recovery",
      100,
      50,
      0,
      100,
      100,
    );

    expect(spawnRef.value).toHaveBeenCalledTimes(1);
    expect(result).toBe(true);
    child.emit("close", 0, null);
  });

  it("serializes concurrent recovery starts for one profile", async () => {
    const child = fakeChildProcess(process.pid);
    spawnRef.value.mockReturnValue(child);
    configureGatewayManagedConfiguration({
      modelMutationPort: { mutate: vi.fn() },
    });
    configureGatewayProcessOwnership(TEST_OWNERSHIP_ROOT);

    const first = startGatewayWithRecovery("default", 100, 50, 0, 100, 100);
    const second = startGatewayWithRecovery("default", 100, 50, 0, 100, 100);
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(spawnRef.value).toHaveBeenCalledTimes(1);
    child.emit("close", 0, null);
  });

  it("uses the freshly prepared credential for the readiness probe", async () => {
    const child = fakeChildProcess(process.pid);
    spawnRef.value.mockReturnValue(child);
    apiKeyRef.value = "";
    configureGatewayManagedConfiguration({
      modelMutationPort: { mutate: vi.fn() },
    });
    configureGatewayProcessOwnership(TEST_OWNERSHIP_ROOT);

    const result = await startGatewayWithRecovery(
      "default",
      100,
      50,
      0,
      100,
      100,
    );

    expect(result).toBe(true);
    expect(spawnRef.value).toHaveBeenCalledTimes(1);
    child.emit("close", 0, null);
  });

  it("reuses the prepared credential for a later health check", async () => {
    const child = fakeChildProcess(process.pid);
    spawnRef.value.mockReturnValue(child);
    apiKeyRef.value = "";
    configureGatewayManagedConfiguration({
      modelMutationPort: { mutate: vi.fn() },
    });
    configureGatewayProcessOwnership(TEST_OWNERSHIP_ROOT);

    await expect(
      startGatewayWithRecovery("default", 100, 50, 0, 100, 100),
    ).resolves.toBe(true);
    // The persisted config reader remains empty in this fixture. A second
    // readiness check must still authenticate with the value returned by the
    // first managed prepare transaction instead of restarting the Gateway.
    await expect(
      startGatewayWithRecovery("default", 100, 50, 0, 100, 100),
    ).resolves.toBe(true);
    expect(spawnRef.value).toHaveBeenCalledTimes(1);
    child.emit("close", 0, null);
  });

  afterEach(() => {
    configureGatewayManagedConfiguration(null);
    stopHealthPolling();
    vi.clearAllTimers();
    vi.useRealTimers();
    rmSync(TEST_HOME, { recursive: true, force: true });
  });

  // @lat: [[agentera-runtime-distribution#Desktop TUI backend lifecycle#Exact process-tree shutdown]]
  it("keeps the Windows root attached for exact captured-tree shutdown", () => {
    const platform = vi
      .spyOn(process, "platform", "get")
      .mockReturnValue("win32");
    const child = fakeChildProcess(process.pid);
    spawnRef.value.mockReturnValue(child);

    try {
      configureGatewayProcessOwnership(TEST_OWNERSHIP_ROOT);
      expect(startGatewayDetailed("research").success).toBe(true);
      expect(spawnRef.value).toHaveBeenCalledWith(
        invocation.python,
        expect.any(Array),
        expect.objectContaining({ detached: false }),
      );
    } finally {
      child.emit("close", 0, null);
      platform.mockRestore();
    }
  });

  // @lat: [[agentera-runtime-distribution#Desktop TUI backend lifecycle#Awaited Electron quit barrier]]
  it("awaits exact ordinary gateway process-tree termination before resolving", async () => {
    const child = fakeChildProcess(process.pid);
    const termination = {
      promise: null as Promise<{
        forced: boolean;
        remainingPids: number[];
      }> | null,
      resolve: null as
        | ((value: { forced: boolean; remainingPids: number[] }) => void)
        | null,
    };
    termination.promise = new Promise((resolve) => {
      termination.resolve = resolve;
    });
    spawnRef.value.mockReturnValue(child);
    terminateRef.value.mockReturnValue(termination.promise);

    configureGatewayProcessOwnership(TEST_OWNERSHIP_ROOT);
    expect(startGatewayDetailed("research").success).toBe(true);

    const shutdown = stopAeraOwnedGateways();
    expect(shutdown).toBeInstanceOf(Promise);
    await Promise.resolve();
    expect(terminateRef.value).toHaveBeenCalledWith(
      child,
      expect.objectContaining({
        detachedProcessGroup: process.platform !== "win32",
      }),
    );

    let settled = false;
    void shutdown.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    termination.resolve?.({ forced: false, remainingPids: [] });
    child.emit("close", 0, null);
    await shutdown;
    expect(settled).toBe(true);
  });

  it("adopts and terminates the daemon listener after its wrapper exits", async () => {
    const wrapper = fakeChildProcess(process.pid);
    spawnRef.value.mockReturnValue(wrapper);
    let listenerAlive = true;
    pidAliveRef.value.mockImplementation(
      (pid: unknown) => pid === 9876 && listenerAlive,
    );
    terminatePidRef.value.mockImplementation(async (pid: number) => {
      if (pid === 9876) listenerAlive = false;
      return { forced: false, remainingPids: [] };
    });
    configureGatewayProcessOwnership(TEST_OWNERSHIP_ROOT);
    expect(startGatewayDetailed("research").success).toBe(true);

    mkdirSync(`${TEST_HOME}/profiles/research`, { recursive: true });
    writeFileSync(
      `${TEST_HOME}/profiles/research/gateway.pid`,
      JSON.stringify({ pid: 9876 }),
    );
    Object.defineProperty(wrapper, "exitCode", {
      configurable: true,
      value: 0,
    });
    wrapper.emit("close", 0, null);
    await vi.advanceTimersByTimeAsync(50);

    const shutdown = stopAeraOwnedGateways();
    await vi.runAllTimersAsync();
    await shutdown;

    expect(terminatePidRef.value).toHaveBeenCalledWith(
      9876,
      expect.objectContaining({
        detachedProcessGroup: false,
        forceAfterMs: 3_000,
      }),
    );
    expect(listenerAlive).toBe(false);
  });

  // @lat: [[agentera-runtime-distribution#Desktop TUI backend lifecycle#Port reuse across restarts]]
  it("drops pooled gateway sockets before signalling shutdown", async () => {
    const child = fakeChildProcess(process.pid);
    spawnRef.value.mockReturnValue(child);
    terminateRef.value.mockResolvedValue({ forced: false, remainingPids: [] });
    configureGatewayProcessOwnership(TEST_OWNERSHIP_ROOT);
    expect(startGatewayDetailed("research").success).toBe(true);
    // Prime the same loopback readiness path used by restartGateway. This
    // creates a socket on the dedicated keep-alive Agent, so the assertion is
    // self-contained and does not depend on another test having run first.
    await expect(
      startGatewayWithRecovery("research", 100, 50, 0, 100, 100),
    ).resolves.toBe(true);

    const order: string[] = [];
    agentDestroyCalls.value = 0;
    const kill = child.kill as unknown as ReturnType<typeof vi.fn>;
    kill.mockImplementation(() => {
      // Record the pool state as observed at signal time: the desktop must
      // already have closed its sockets so the gateway is not the peer that
      // closes first, which is what parks TIME_WAIT on the gateway's port.
      order.push(agentDestroyCalls.value > 0 ? "drained" : "not-drained");
      return true;
    });

    stopGateway("research");

    expect(order).toEqual(["drained"]);

    // stopGateway may schedule an ownership termination; let it settle so the
    // shared shutdown queue is idle for the following tests.
    child.emit("close", 0, null);
    await vi.runAllTimersAsync();
  });

  it("drains pooled gateway sockets before app shutdown tree termination", async () => {
    const child = fakeChildProcess(process.pid);
    spawnRef.value.mockReturnValue(child);
    const order: string[] = [];
    terminateRef.value.mockImplementation(async () => {
      order.push(
        agentInstances.value.some((instance) => instance.destroyed)
          ? "drained"
          : "not-drained",
      );
      return { forced: false, remainingPids: [] };
    });
    configureGatewayProcessOwnership(TEST_OWNERSHIP_ROOT);
    expect(startGatewayDetailed("research").success).toBe(true);
    await expect(
      startGatewayWithRecovery("research", 100, 50, 0, 100, 100),
    ).resolves.toBe(true);

    agentDestroyCalls.value = 0;
    await stopAeraOwnedGateways();

    expect(agentDestroyCalls.value).toBeGreaterThan(0);
    expect(order).toEqual(["drained"]);
    child.emit("close", 0, null);
  });

  it("does not drain another profile's pooled gateway sockets", async () => {
    const child = fakeChildProcess(process.pid);
    spawnRef.value.mockReturnValue(child);
    configureGatewayManagedConfiguration({
      modelMutationPort: { mutate: vi.fn() },
    });
    configureGatewayProcessOwnership(TEST_OWNERSHIP_ROOT);

    expect(startGatewayDetailed("cross-profile-a").success).toBe(true);
    await expect(isGatewayHealthy("cross-profile-a")).resolves.toBe(true);
    expect(startGatewayDetailed("cross-profile-b").success).toBe(true);
    await expect(isGatewayHealthy("cross-profile-b")).resolves.toBe(true);
    expect(agentInstances.value).toHaveLength(2);

    stopGateway("cross-profile-a");

    expect(agentInstances.value[0]?.destroyed).toBe(true);
    expect(agentInstances.value[1]?.destroyed).toBe(false);
    stopGateway("cross-profile-b", true);
    child.emit("close", 0, null);
  });

  // @lat: [[agentera-runtime-distribution#Desktop TUI backend lifecycle#Exact process-tree shutdown]]
  it("allows the bounded Windows process query to outlive the default command budget", async () => {
    const platform = vi
      .spyOn(process, "platform", "get")
      .mockReturnValue("win32");
    const child = fakeChildProcess(process.pid);
    spawnRef.value.mockReturnValue(child);
    terminateRef.value.mockImplementation(async () => {
      child.emit("close", 0, null);
      return { forced: false, remainingPids: [] };
    });

    try {
      configureGatewayProcessOwnership(TEST_OWNERSHIP_ROOT);
      expect(startGatewayDetailed("research").success).toBe(true);

      await stopAeraOwnedGateways();

      expect(terminateRef.value).toHaveBeenCalledWith(
        child,
        expect.objectContaining({
          commandTimeoutMs: 3_000,
          detachedProcessGroup: false,
          snapshotTimeoutMs: 3_000,
        }),
      );
    } finally {
      platform.mockRestore();
    }
  });

  // @lat: [[agentera-runtime-distribution#Desktop TUI backend lifecycle#Exact process-tree shutdown]]
  it("serializes Windows process snapshots across owned Profiles", async () => {
    const platform = vi
      .spyOn(process, "platform", "get")
      .mockReturnValue("win32");
    const defaultChild = fakeChildProcess(process.pid);
    const researchChild = fakeChildProcess(process.pid);
    const releases: Array<() => void> = [];
    spawnRef.value
      .mockReturnValueOnce(defaultChild)
      .mockReturnValueOnce(researchChild);
    terminateRef.value.mockImplementation(
      (child: ChildProcess) =>
        new Promise((resolve) => {
          releases.push(() => {
            child.emit("close", 0, null);
            resolve({ forced: false, remainingPids: [] });
          });
        }),
    );

    try {
      configureGatewayProcessOwnership(TEST_OWNERSHIP_ROOT);
      expect(startGatewayDetailed().success).toBe(true);
      expect(startGatewayDetailed("research").success).toBe(true);

      const shutdown = stopAeraOwnedGateways();
      await Promise.resolve();
      expect(terminateRef.value).toHaveBeenCalledTimes(1);

      releases.shift()?.();
      await vi.waitFor(() => {
        expect(terminateRef.value).toHaveBeenCalledTimes(2);
      });

      releases.shift()?.();
      await shutdown;
    } finally {
      platform.mockRestore();
    }
  });
});
