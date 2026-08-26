// @vitest-environment node

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";

const {
  TEST_HOME,
  TEST_RUNTIME,
  httpRequestSpy,
  killProcessTreeSpy,
  terminateProcessTreeSpy,
  retryCapturedProcessTerminationSpy,
  spawnSpy,
  isGatewayHealthySpy,
  startGatewayWithRecoverySpy,
  pidAliveRef,
  modelConfig,
  profileEnv,
  modelRows,
  providerSecrets,
  activeProfileRef,
  activeProfileNameSpy,
} = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require("path");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require("os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require("events");
  const home = path.join(os.tmpdir(), `dashboard-runtime-${Date.now()}`);
  const runtime = path.join(home, "runtime");
  const killProcessTreeSpy = vi.fn();
  const terminateProcessTreeSpy = vi.fn(async () => ({
    forced: false,
    remainingPids: [],
  }));
  const retryCapturedProcessTerminationSpy = vi.fn(async () => ({
    forced: false,
    remainingPids: [],
  }));
  const isGatewayHealthySpy = vi.fn(async () => true);
  const startGatewayWithRecoverySpy = vi.fn(async () => true);
  const activeProfileRef = { value: undefined as string | undefined };
  const activeProfileNameSpy = vi.fn(() => activeProfileRef.value);

  const spawnSpy = vi.fn(() => {
    const proc = new EventEmitter();
    Object.assign(proc, {
      pid: 4242,
      exitCode: null,
      signalCode: null,
      killed: false,
      kill: vi.fn(() => {
        proc.killed = true;
      }),
    });
    return proc;
  });

  const httpRequestSpy = vi.fn((...args: unknown[]) => {
    const callback =
      typeof args[1] === "function"
        ? args[1]
        : typeof args[2] === "function"
          ? args[2]
          : null;
    const req = new EventEmitter();
    Object.assign(req, {
      destroy: vi.fn(),
      setTimeout: vi.fn(),
      end: () => {
        if (callback) {
          const response = new EventEmitter();
          Object.assign(response, { statusCode: 200, statusMessage: "OK" });
          callback(response);
          queueMicrotask(() => {
            response.emit("data", Buffer.from("{}"));
            response.emit("end");
          });
          return;
        }
        queueMicrotask(() => {
          req.emit("upgrade", {}, { destroy: vi.fn() });
        });
      },
    });
    return req;
  });

  return {
    TEST_HOME: home,
    TEST_RUNTIME: runtime,
    httpRequestSpy,
    killProcessTreeSpy,
    terminateProcessTreeSpy,
    retryCapturedProcessTerminationSpy,
    spawnSpy,
    isGatewayHealthySpy,
    startGatewayWithRecoverySpy,
    pidAliveRef: { value: true },
    modelConfig: {
      provider: "auto",
      model: "",
      baseUrl: "",
    },
    profileEnv: {} as Record<string, string>,
    modelRows: [] as Array<{
      id: string;
      name: string;
      provider: string;
      model: string;
      baseUrl: string;
      providerLabel?: string;
      createdAt: number;
    }>,
    providerSecrets: {} as Record<string, string>,
    activeProfileRef,
    activeProfileNameSpy,
  };
});

vi.mock("child_process", () => ({
  spawn: spawnSpy,
  default: { spawn: spawnSpy },
}));

vi.mock("../src/main/process-tree", () => ({
  killProcessTree: killProcessTreeSpy,
  // dashboard.ts reaches hermes.ts for the shared readiness gate; hermes
  // references this export when wiring its default TUI client dependencies.
  terminateProcessTree: terminateProcessTreeSpy,
  retryCapturedProcessTermination: retryCapturedProcessTerminationSpy,
}));

vi.mock("http", () => ({
  request: httpRequestSpy,
  default: { request: httpRequestSpy },
}));

vi.mock("https", () => ({
  request: httpRequestSpy,
  default: { request: httpRequestSpy },
}));

vi.mock("../src/main/config", () => ({
  getConnectionConfig: () => ({ mode: "local" }),
  getModelConfig: () => modelConfig,
  readEnv: () => profileEnv,
}));

vi.mock("../src/main/models", () => ({
  readModels: () => modelRows,
}));

vi.mock("../src/main/secrets", () => ({
  providerListSafe: () => providerSecrets,
}));

vi.mock("../src/main/installer", () => ({
  HERMES_HOME: TEST_HOME,
  getEnhancedPath: () => process.env.PATH || "",
}));

vi.mock("../src/main/agentera-runtime-distribution/invocation", () => ({
  getRuntimeInvocation: () => ({
    source: "managed",
    version: "test",
    sourceCommit: "0".repeat(40),
    root: TEST_RUNTIME,
    python: `${TEST_RUNTIME}/python/bin/python3`,
    workingDirectory: `${TEST_RUNTIME}/python/lib/python3.11/site-packages`,
    bundledSkillsDirectory: `${TEST_RUNTIME}/python/skills`,
    webDistDirectory: `${TEST_RUNTIME}/python/lib/python3.11/site-packages/hermes_cli/web_dist`,
    cliArgs: (args: string[] = []) => ["-m", "hermes_cli.main", ...args],
    environment: (base: Record<string, string> = {}) => ({
      ...base,
      PYTHONNOUSERSITE: "1",
    }),
  }),
}));

vi.mock("../src/main/hermes-agent-compat", () => ({
  ensureLocalDashboardCompatibility: () => ({
    ok: true,
    target: "local",
    compatible: true,
    applied: false,
    version: "test",
    detail: "compatible",
  }),
}));

vi.mock("../src/main/remote-oauth", () => ({
  buildRemoteOAuthWsUrl: vi.fn(),
  mintRemoteOAuthWsTicket: vi.fn(),
  probeRemoteAuthMode: vi.fn(),
  remoteOAuthSessionState: vi.fn(),
  requestRemoteOAuthJson: vi.fn(),
}));

// dashboard.ts gates its local spawn on the shared gateway readiness path.
// These tests exercise the dashboard invocation, not gateway recovery, so
// the gate observes an already-healthy gateway and passes straight through.
vi.mock("../src/main/hermes", () => ({
  isGatewayHealthy: isGatewayHealthySpy,
  startGatewayWithRecovery: startGatewayWithRecoverySpy,
}));

vi.mock("../src/main/ssh-tunnel", () => ({
  ensureSshTunnel: vi.fn(),
  getSshTunnelUrl: vi.fn(),
}));

vi.mock("../src/main/ssh-remote", () => ({
  sshEnsureDashboard: vi.fn(),
}));

vi.mock("../src/main/utils", () => ({
  getActiveProfileNameSync: activeProfileNameSpy,
  normalizeProfileName: (profile?: string) =>
    !profile || profile === "default" ? undefined : profile,
  pidIsAlive: () => pidAliveRef.value,
  profileHome: () => TEST_HOME,
}));

import {
  getDashboardStatus,
  startDashboard,
  stopAllDashboards,
  stopDashboard,
} from "../src/main/dashboard";

describe("Dashboard Runtime invocation", () => {
  beforeEach(() => {
    spawnSpy.mockClear();
    httpRequestSpy.mockClear();
    killProcessTreeSpy.mockClear();
    terminateProcessTreeSpy.mockClear();
    terminateProcessTreeSpy.mockResolvedValue({
      forced: false,
      remainingPids: [],
    });
    retryCapturedProcessTerminationSpy.mockClear();
    retryCapturedProcessTerminationSpy.mockResolvedValue({
      forced: false,
      remainingPids: [],
    });
    isGatewayHealthySpy.mockReset();
    isGatewayHealthySpy.mockResolvedValue(true);
    startGatewayWithRecoverySpy.mockReset();
    startGatewayWithRecoverySpy.mockResolvedValue(true);
    pidAliveRef.value = true;
    activeProfileRef.value = undefined;
    activeProfileNameSpy.mockReset();
    activeProfileNameSpy.mockImplementation(() => activeProfileRef.value);
    modelConfig.provider = "auto";
    modelConfig.model = "";
    modelConfig.baseUrl = "";
    for (const key of Object.keys(profileEnv)) delete profileEnv[key];
    for (const key of Object.keys(providerSecrets)) delete providerSecrets[key];
    modelRows.length = 0;
    mkdirSync(
      `${TEST_RUNTIME}/python/lib/python3.11/site-packages/hermes_cli/web_dist`,
      { recursive: true },
    );
    writeFileSync(
      `${TEST_RUNTIME}/python/lib/python3.11/site-packages/hermes_cli/web_dist/index.html`,
      "dashboard",
    );
  });

  afterEach(async () => {
    await stopAllDashboards().catch(() => undefined);
    rmSync(TEST_HOME, { recursive: true, force: true });
  });

  it("starts the local dashboard through the managed Runtime", async () => {
    const result = await startDashboard("work");

    expect(result.running).toBe(true);
    expect(spawnSpy).toHaveBeenCalledOnce();
    expect(spawnSpy).toHaveBeenCalledWith(
      `${TEST_RUNTIME}/python/bin/python3`,
      expect.arrayContaining(["-m", "hermes_cli.main", "dashboard"]),
      expect.objectContaining({
        cwd: `${TEST_RUNTIME}/python/lib/python3.11/site-packages`,
        env: expect.objectContaining({
          HERMES_HOME: TEST_HOME,
          HERMES_WEB_DIST: `${TEST_RUNTIME}/python/lib/python3.11/site-packages/hermes_cli/web_dist`,
          PYTHONNOUSERSITE: "1",
        }),
      }),
    );
  });

  it("does not spawn a Dashboard Runtime when Gateway recovery fails", async () => {
    isGatewayHealthySpy.mockResolvedValue(false);
    startGatewayWithRecoverySpy.mockResolvedValue(false);

    const result = await startDashboard("work");

    expect(startGatewayWithRecoverySpy).toHaveBeenCalledWith(
      "work",
      90_000,
      500,
    );
    expect(result).toEqual(
      expect.objectContaining({
        supported: true,
        running: false,
        error: expect.stringContaining("Gateway"),
      }),
    );
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  // @lat: [[agentera-runtime-distribution#Desktop TUI backend lifecycle#Cancelled startup cannot outlive Desktop]]
  it("does not spawn a Dashboard after a pending Gateway recovery is stopped", async () => {
    isGatewayHealthySpy.mockResolvedValue(false);
    let releaseRecovery!: (value: boolean) => void;
    const recovery = new Promise<boolean>((resolve) => {
      releaseRecovery = resolve;
    });
    startGatewayWithRecoverySpy.mockReturnValueOnce(recovery);

    const starting = startDashboard("work");
    await vi.waitFor(() =>
      expect(startGatewayWithRecoverySpy).toHaveBeenCalledOnce(),
    );

    const stopping = stopAllDashboards();
    let settled = false;
    void stopping.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseRecovery(true);
    await expect(starting).resolves.toMatchObject({
      supported: true,
      running: false,
    });
    await stopping;
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  // @lat: [[agentera-runtime-distribution#Desktop TUI backend lifecycle#Pool-wide App shutdown]]
  it("awaits an in-flight local Dashboard start before reporting shutdown", async () => {
    let releaseHealthy!: (value: boolean) => void;
    const healthy = new Promise<boolean>((resolve) => {
      releaseHealthy = resolve;
    });
    isGatewayHealthySpy.mockReturnValueOnce(healthy);
    startGatewayWithRecoverySpy.mockResolvedValue(true);

    const starting = startDashboard("work");
    await vi.waitFor(() => expect(isGatewayHealthySpy).toHaveBeenCalledOnce());

    const stopping = stopAllDashboards();
    let settled = false;
    void stopping.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);

    releaseHealthy(false);
    await expect(starting).resolves.toMatchObject({
      supported: true,
      running: false,
    });
    await stopping;
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it("does not signal a host process while disposing the mocked Runtime", async () => {
    const processKillSpy = vi.spyOn(process, "kill").mockReturnValue(true);
    try {
      const result = await startDashboard("work");

      expect(result.running).toBe(true);
      await stopAllDashboards();
      expect(terminateProcessTreeSpy).toHaveBeenCalledOnce();
      expect(processKillSpy).not.toHaveBeenCalled();
    } finally {
      processKillSpy.mockRestore();
    }
  });

  // @lat: [[agentera-runtime-distribution#Desktop TUI backend lifecycle#Awaited Electron quit barrier]]
  it("returns an awaited shutdown for the local Dashboard process tree", async () => {
    const result = await startDashboard("work");
    expect(result.running).toBe(true);

    let release!: () => void;
    const termination = new Promise<{
      forced: boolean;
      remainingPids: number[];
    }>((resolve) => {
      release = resolve;
    });
    terminateProcessTreeSpy.mockReturnValueOnce(termination);

    const stopping = stopAllDashboards();
    expect(stopping).toBeInstanceOf(Promise);
    if (!(stopping instanceof Promise)) return;

    let settled = false;
    void stopping.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    release({ forced: false, remainingPids: [] });
    await stopping;
    expect(settled).toBe(true);
  });

  // @lat: [[agentera-runtime-distribution#Desktop TUI backend lifecycle#Cancelled startup cannot outlive Desktop]]
  it("serializes a same-Profile restart behind an in-flight Dashboard stop", async () => {
    await expect(startDashboard("work")).resolves.toMatchObject({
      running: true,
    });

    let releaseTermination!: (value: {
      forced: boolean;
      remainingPids: number[];
    }) => void;
    const termination = new Promise<{
      forced: boolean;
      remainingPids: number[];
    }>((resolve) => {
      releaseTermination = resolve;
    });
    terminateProcessTreeSpy.mockReturnValueOnce(termination);

    const stopping = stopDashboard("work");
    await vi.waitFor(() =>
      expect(terminateProcessTreeSpy).toHaveBeenCalledOnce(),
    );

    const restarting = startDashboard("work");
    await Promise.resolve();
    expect(spawnSpy).toHaveBeenCalledOnce();

    releaseTermination({ forced: false, remainingPids: [] });
    await stopping;
    await expect(restarting).resolves.toMatchObject({
      supported: true,
      running: true,
    });
    expect(spawnSpy).toHaveBeenCalledTimes(2);
  });

  // @lat: [[agentera-runtime-distribution#Desktop TUI backend lifecycle#Pool-wide App shutdown]]
  it("rechecks pool admission after waiting for a same-Profile stop", async () => {
    await expect(startDashboard("work")).resolves.toMatchObject({
      running: true,
    });

    let releaseTermination!: (value: {
      forced: boolean;
      remainingPids: number[];
    }) => void;
    const termination = new Promise<{
      forced: boolean;
      remainingPids: number[];
    }>((resolve) => {
      releaseTermination = resolve;
    });
    terminateProcessTreeSpy.mockReturnValueOnce(termination);

    const profileStop = stopDashboard("work");
    await vi.waitFor(() =>
      expect(terminateProcessTreeSpy).toHaveBeenCalledOnce(),
    );
    const racingStart = startDashboard("work");
    const poolStop = stopAllDashboards();

    releaseTermination({ forced: false, remainingPids: [] });
    await profileStop;
    await poolStop;
    await expect(racingStart).resolves.toMatchObject({
      supported: true,
      running: false,
      error: expect.stringMatching(/pool is shutting down/i),
    });
    expect(spawnSpy).toHaveBeenCalledOnce();
  });

  it("bridges the active named custom-provider key into the Dashboard Runtime host slot", async () => {
    modelConfig.provider = "custom";
    modelConfig.model = "gpt-5.6-sol";
    modelConfig.baseUrl = "https://api.anhepro.com/v1";
    profileEnv.CUSTOM_PROVIDER_ANHEPRO_COM_KEY = "named-provider-secret";
    modelRows.push({
      id: "anhepro-gpt-5.6-sol",
      name: "gpt-5.6-sol",
      provider: "custom",
      model: "gpt-5.6-sol",
      baseUrl: "https://api.anhepro.com/v1",
      providerLabel: "anhepro.com",
      createdAt: 1,
    });

    const result = await startDashboard("work");

    expect(result.running).toBe(true);
    expect(spawnSpy.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({
        env: expect.objectContaining({
          ANHEPRO_API_KEY: "named-provider-secret",
        }),
      }),
    );
  });

  // @lat: [[agentera-runtime-distribution#Desktop TUI backend lifecycle#Pool-wide App shutdown]]
  it("rejects a Dashboard start admitted during pool shutdown", async () => {
    const initial = await startDashboard("work");
    expect(initial.running).toBe(true);

    let releaseTermination!: (value: {
      forced: boolean;
      remainingPids: number[];
    }) => void;
    const termination = new Promise<{
      forced: boolean;
      remainingPids: number[];
    }>((resolve) => {
      releaseTermination = resolve;
    });
    terminateProcessTreeSpy.mockReturnValueOnce(termination);

    const stopping = stopAllDashboards();
    await vi.waitFor(() =>
      expect(terminateProcessTreeSpy).toHaveBeenCalledOnce(),
    );

    const lateStart = startDashboard("work");
    await Promise.resolve();
    expect(spawnSpy).toHaveBeenCalledOnce();

    releaseTermination({ forced: false, remainingPids: [] });
    await stopping;
    await expect(lateStart).resolves.toMatchObject({
      supported: true,
      running: false,
    });
    expect(spawnSpy).toHaveBeenCalledOnce();
  });

  // @lat: [[agentera-runtime-distribution#Desktop TUI backend lifecycle#Pool-wide App shutdown]]
  it("drains the exact default Dashboard after the active Profile changes", async () => {
    await expect(startDashboard()).resolves.toMatchObject({ running: true });

    activeProfileNameSpy.mockReset();
    activeProfileNameSpy.mockReturnValueOnce("work").mockReturnValue(undefined);
    await stopAllDashboards();

    expect(activeProfileNameSpy).not.toHaveBeenCalled();
    expect(terminateProcessTreeSpy).toHaveBeenCalledOnce();
  });

  // @lat: [[agentera-runtime-distribution#Desktop TUI backend lifecycle#Pool-wide App shutdown]]
  it("attempts every Dashboard cleanup and retains only failed ownership for retry", async () => {
    await expect(startDashboard("work")).resolves.toMatchObject({
      running: true,
    });
    await expect(startDashboard("personal")).resolves.toMatchObject({
      running: true,
    });

    terminateProcessTreeSpy
      .mockResolvedValueOnce({ forced: false, remainingPids: [4242] })
      .mockResolvedValueOnce({ forced: false, remainingPids: [] })
      .mockResolvedValueOnce({ forced: false, remainingPids: [] });

    await expect(stopAllDashboards()).rejects.toThrow(
      /Aera Dashboard cleanup failed/i,
    );
    expect(terminateProcessTreeSpy).toHaveBeenCalledTimes(2);

    await expect(stopAllDashboards()).resolves.toBeUndefined();
    expect(terminateProcessTreeSpy).toHaveBeenCalledTimes(3);
  });

  // @lat: [[agentera-runtime-distribution#Desktop TUI backend lifecycle#Pool-wide App shutdown]]
  it("retains ownership when failed Dashboard startup cleanup needs a retry", async () => {
    let requestCount = 0;
    httpRequestSpy.mockImplementation((...args: unknown[]) => {
      const callback =
        typeof args[1] === "function"
          ? args[1]
          : typeof args[2] === "function"
            ? args[2]
            : null;
      const req = new EventEmitter();
      Object.assign(req, {
        destroy: vi.fn(),
        setTimeout: vi.fn(),
        end: () => {
          requestCount += 1;
          if (callback) {
            const response = new EventEmitter();
            Object.assign(response, { statusCode: 200, statusMessage: "OK" });
            callback(response);
            queueMicrotask(() => {
              response.emit("data", Buffer.from("{}"));
              response.emit("end");
            });
            return;
          }
          queueMicrotask(() => {
            if (requestCount === 2) {
              const response = new EventEmitter();
              Object.assign(response, { statusCode: 503 });
              req.emit("response", response);
              response.emit("end");
            } else {
              req.emit("upgrade", {}, { destroy: vi.fn() });
            }
          });
        },
      });
      return req;
    });
    terminateProcessTreeSpy
      .mockResolvedValueOnce({ forced: false, remainingPids: [4242] })
      .mockResolvedValueOnce({ forced: false, remainingPids: [] });

    const result = await startDashboard("work");
    expect(result).toMatchObject({ supported: true, running: false });
    expect(await getDashboardStatus("work")).toMatchObject({
      supported: true,
      running: false,
      error: expect.stringContaining("cleanup"),
    });
    expect(terminateProcessTreeSpy).toHaveBeenCalledOnce();

    await expect(stopDashboard("work")).resolves.toBe(true);
    expect(terminateProcessTreeSpy).toHaveBeenCalledTimes(2);
  });

  // @lat: [[agentera-runtime-distribution#Desktop TUI backend lifecycle#Pool-wide App shutdown]]
  it("retains startup ownership when the root exits but descendants remain", async () => {
    httpRequestSpy.mockImplementation((...args: unknown[]) => {
      const callback =
        typeof args[1] === "function"
          ? args[1]
          : typeof args[2] === "function"
            ? args[2]
            : null;
      const req = new EventEmitter();
      Object.assign(req, {
        destroy: vi.fn(),
        setTimeout: vi.fn(),
        end: () => {
          if (callback) {
            const response = new EventEmitter();
            Object.assign(response, { statusCode: 200, statusMessage: "OK" });
            callback(response);
            queueMicrotask(() => {
              response.emit("data", Buffer.from("{}"));
              response.emit("end");
            });
            return;
          }
          queueMicrotask(() => req.emit("error", new Error("ws failed")));
        },
      });
      return req;
    });
    const retryOwnership = {};
    terminateProcessTreeSpy.mockImplementationOnce(
      async (proc: EventEmitter) => {
        pidAliveRef.value = false;
        proc.emit("exit", 1, null);
        return {
          forced: false,
          remainingPids: [4343],
          retryOwnership,
        };
      },
    );

    await expect(startDashboard("work")).resolves.toMatchObject({
      supported: true,
      running: false,
      error: expect.stringContaining("cleanup"),
    });
    expect(terminateProcessTreeSpy).toHaveBeenCalledOnce();

    await expect(stopDashboard("work")).resolves.toBe(true);
    expect(terminateProcessTreeSpy).toHaveBeenCalledOnce();
    expect(retryCapturedProcessTerminationSpy).toHaveBeenCalledWith(
      retryOwnership,
      expect.objectContaining({ forceAfterMs: 3_000 }),
    );
  });
});
