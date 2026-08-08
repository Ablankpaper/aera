// @vitest-environment node

import { EventEmitter } from "node:events";
import { mkdirSync, rmSync } from "node:fs";
import type { ChildProcess } from "node:child_process";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const { TEST_HOME, TEST_OWNERSHIP_ROOT, invocation, spawnRef, terminateRef } =
  vi.hoisted(() => ({
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
    terminateRef: {
      value: vi.fn(),
    },
  }));

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) =>
      spawnRef.value(...args),
  };
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
  getApiServerKey: vi.fn(() => null),
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
  pidIsAliveAs: vi.fn(() => false),
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
}));

import {
  configureGatewayProcessOwnership,
  startGatewayDetailed,
  stopAeraOwnedGateways,
  stopHealthPolling,
} from "./hermes";

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
    process.env.NODE_ENV = "test";
  });

  afterEach(() => {
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
