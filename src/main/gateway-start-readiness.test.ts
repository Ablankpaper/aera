// @vitest-environment node

import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { ChildProcess } from "node:child_process";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const {
  TEST_HOME,
  TEST_OWNERSHIP_ROOT,
  invocation,
  spawnRef,
  execFileRef,
  pidAliveRef,
  processEvidenceRef,
  processEvidenceAsyncRef,
  apiKeyRef,
  httpState,
  terminateRef,
  terminatePidRef,
} = vi.hoisted(() => ({
  TEST_HOME: "/tmp/aera-gateway-start-readiness-test",
  TEST_OWNERSHIP_ROOT: "/tmp/aera-gateway-start-readiness-test/user-data",
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
  execFileRef: { value: vi.fn() },
  pidAliveRef: {
    value: vi.fn((..._args: unknown[]) => false),
  },
  processEvidenceRef: {
    value: vi.fn((pid: number) => ({
      identity: `test-created-${pid}`,
      image: "python3",
    })),
  },
  processEvidenceAsyncRef: {
    value: vi.fn(async (pid: number) => ({
      identity: `test-created-${pid}`,
      image: "python3",
    })),
  },
  apiKeyRef: { value: "generated-internal-token" },
  httpState: {
    statusCode: { value: 200 },
    // When set, the probe answers 200 only for this exact Authorization
    // header value; anything else (or a missing header) gets 401.
    authorizeWith: { value: null as string | null },
    // Optional response body (e.g. a /v1/capabilities JSON document).
    body: { value: "" },
    requests: [] as Array<{ url: string; authorization?: string }>,
  },
  terminateRef: {
    value: vi.fn(
      (
        ..._args: unknown[]
      ): Promise<{
        forced: boolean;
        remainingPids: number[];
      }> => Promise.resolve({ forced: false, remainingPids: [] }),
    ),
  },
  terminatePidRef: {
    value: vi.fn(
      (
        ..._args: unknown[]
      ): Promise<{
        forced: boolean;
        remainingPids: number[];
      }> => Promise.resolve({ forced: false, remainingPids: [] }),
    ),
  },
}));

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) =>
      spawnRef.value(...args),
    execFile: (...args: unknown[]) => execFileRef.value(...args),
  };
});
vi.mock("http", () => {
  const request = vi.fn(
    (
      url: string,
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
        queueMicrotask(() => {
          const headers = options.headers as Record<string, string> | undefined;
          httpState.requests.push({
            url: String(url),
            authorization: headers?.Authorization,
          });
          const res = new EventEmitter() as EventEmitter & {
            statusCode: number;
            destroy: () => void;
            resume: () => void;
          };
          res.statusCode =
            httpState.authorizeWith.value !== null
              ? headers?.Authorization === httpState.authorizeWith.value
                ? 200
                : 401
              : httpState.statusCode.value;
          res.destroy = () => {};
          res.resume = () => {};
          callback(res);
          if (httpState.body.value) {
            res.emit("data", Buffer.from(httpState.body.value));
          }
          res.emit("end");
        });
      };
      req.destroy = () => {};
      return req;
    },
  );
  class Agent {
    destroy(): void {
      // Readiness probes in this suite never leave sockets to drain.
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
vi.mock("./process-identity", () => ({
  normalizeProcessImage: (value: unknown) =>
    typeof value === "string" && value.trim()
      ? value.trim().replaceAll("\\", "/").split("/").at(-1)!.toLowerCase()
      : null,
  processImageMatchesExecutable: (observed: string, expected: string) =>
    typeof observed === "string" &&
    typeof expected === "string" &&
    observed.toLowerCase().replaceAll("\\", "/").split("/").at(-1) ===
      expected.toLowerCase().replaceAll("\\", "/").split("/").at(-1),
  processEvidenceMatches: (
    actual: { identity: string; image: string } | null,
    expected: { identity: string; image: string } | null,
  ) =>
    actual?.identity === expected?.identity &&
    actual?.image === expected?.image,
  readProcessIdentityEvidence: (pid: number) => processEvidenceRef.value(pid),
  readProcessIdentityEvidenceAsync: (pid: number) =>
    processEvidenceAsyncRef.value(pid),
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
  retryCapturedProcessTermination: async () => ({
    forced: false,
    remainingPids: [],
  }),
}));
vi.mock("./gateway-managed-config", () => ({
  prepareGatewayManagedConfiguration: vi.fn(async () => ({
    key: "generated-internal-token",
    port: 8642,
  })),
}));

import {
  configureGatewayProcessOwnership,
  isGatewayRunning,
  startGatewayWithReadiness,
  stopAeraOwnedGateways,
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
  const emit = proc.emit.bind(proc);
  proc.emit = ((event: string | symbol, ...args: unknown[]) => {
    if (event === "close") {
      const [code, signal] = args as [number | null, NodeJS.Signals | null];
      Object.defineProperty(proc, "exitCode", {
        configurable: true,
        value: code,
      });
      Object.defineProperty(proc, "signalCode", {
        configurable: true,
        value: signal,
      });
    }
    return emit(event, ...args);
  }) as ChildProcess["emit"];
  return proc;
}

describe("startGatewayWithReadiness", () => {
  const children: ChildProcess[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    rmSync(TEST_HOME, { recursive: true, force: true });
    mkdirSync(TEST_OWNERSHIP_ROOT, { recursive: true });
    spawnRef.value.mockReset();
    execFileRef.value.mockReset();
    pidAliveRef.value.mockReset();
    pidAliveRef.value.mockReturnValue(false);
    processEvidenceRef.value.mockReset();
    processEvidenceRef.value.mockImplementation((pid: number) => ({
      identity: `test-created-${pid}`,
      image: "python3",
    }));
    processEvidenceAsyncRef.value.mockReset();
    processEvidenceAsyncRef.value.mockImplementation(async (pid: number) =>
      processEvidenceRef.value(pid),
    );
    apiKeyRef.value = "generated-internal-token";
    httpState.statusCode.value = 200;
    httpState.authorizeWith.value = null;
    httpState.body.value = "";
    httpState.requests.length = 0;
    terminateRef.value.mockClear();
    terminateRef.value.mockResolvedValue({ forced: false, remainingPids: [] });
    terminatePidRef.value.mockClear();
    terminatePidRef.value.mockResolvedValue({
      forced: false,
      remainingPids: [],
    });
    children.length = 0;
    process.env.NODE_ENV = "test";
    delete process.env.AGENTERA_E2E_DIAGNOSTICS;
  });

  afterEach(() => {
    for (const child of children) {
      child.emit("close", 0, null);
    }
    stopHealthPolling();
    vi.clearAllTimers();
    vi.useRealTimers();
    delete process.env.AGENTERA_E2E_DIAGNOSTICS;
    rmSync(TEST_HOME, { recursive: true, force: true });
  });

  function spawnNext(pid: number): ChildProcess {
    const child = fakeChildProcess(pid);
    children.push(child);
    spawnRef.value.mockReturnValue(child);
    return child;
  }

  // The daemonized listener must pass identity proof: alive AND a Python
  // image. The suite's fake listener PIDs are not real processes, so tests
  // that reach readiness must make the identity probe truthy.
  function expectListenerAlive(): void {
    pidAliveRef.value.mockReturnValue(true);
  }

  // The daemonized listener writes gateway.pid after the wrapper spawns; the
  // readiness gate must observe that file, not just a live API socket.
  function spawnNextWithPidFile(
    spawnPid: number,
    listenerPid: number,
  ): ChildProcess {
    const child = fakeChildProcess(spawnPid);
    children.push(child);
    spawnRef.value.mockImplementation(() => {
      writeFileSync(
        `${TEST_HOME}/gateway.pid`,
        JSON.stringify({ pid: listenerPid }),
      );
      return child;
    });
    return child;
  }

  // @lat: [[agentera-runtime-distribution#Desktop TUI backend lifecycle#Runtime 0.20 headless contract]]
  it("returns ready=true only after the API answers and gateway.pid exists", async () => {
    spawnNextWithPidFile(4321, 9876);
    expectListenerAlive();
    configureGatewayProcessOwnership(TEST_OWNERSHIP_ROOT);

    const result = await startGatewayWithReadiness(undefined, {
      key: "generated-internal-token",
      port: 8642,
    });

    expect(result.success).toBe(true);
    expect(result.running).toBe(true);
    expect(result.ready).toBe(true);
    // The listener PID from gateway.pid — not the spawn wrapper's 4321 —
    // because the gateway daemonizes and the wrapper can exit immediately.
    expect(result.diagnostics?.pid).toBe(9876);
    expect(result.diagnostics?.command).toBe(invocation.python);
    expect(result.diagnostics?.args).toEqual(
      expect.arrayContaining(["gateway"]),
    );
    // The readiness proof is the Bearer-protected capabilities route on the
    // prepared port — not the mere existence of a spawned process.
    expect(
      httpState.requests.some(
        (request) =>
          request.url === "http://127.0.0.1:8642/v1/capabilities" &&
          request.authorization === "Bearer generated-internal-token",
      ),
    ).toBe(true);
  });

  it("uses the asynchronous process-evidence reader when the synchronous probe is unavailable", async () => {
    spawnNextWithPidFile(4321, 9876);
    expectListenerAlive();
    // Reproduce the packaged cold-start boundary: the synchronous PowerShell
    // query misses its bounded window, while the non-blocking query completes
    // once the process table provider is ready.
    processEvidenceRef.value.mockReturnValue(null as never);
    processEvidenceAsyncRef.value.mockResolvedValue({
      identity: "test-created-9876",
      image: "python3",
    });
    configureGatewayProcessOwnership(TEST_OWNERSHIP_ROOT);

    const promise = startGatewayWithReadiness(
      undefined,
      { key: "generated-internal-token", port: 8642 },
      { readyTimeoutMs: 100, pollMs: 20 },
    );
    await vi.advanceTimersByTimeAsync(500);
    const result = await promise;

    expect(result.success).toBe(true);
    expect(result.running).toBe(true);
    expect(result.ready).toBe(true);
    expect(result.diagnostics?.pid).toBe(9876);
    expect(processEvidenceAsyncRef.value).toHaveBeenCalledWith(9876);
  });

  it("does not synchronously query the wrapper during a readiness-gated launch", async () => {
    spawnNextWithPidFile(4321, 9876);
    expectListenerAlive();
    processEvidenceRef.value.mockImplementation(() => {
      throw new Error("synchronous process evidence must not run");
    });
    processEvidenceAsyncRef.value.mockImplementation(async (pid: number) => ({
      identity: `test-created-${pid}`,
      image: "python3",
    }));
    configureGatewayProcessOwnership(TEST_OWNERSHIP_ROOT);

    const result = await startGatewayWithReadiness(undefined, {
      key: "generated-internal-token",
      port: 8642,
    });

    expect(result.ready).toBe(true);
    expect(processEvidenceRef.value).not.toHaveBeenCalled();
    expect(processEvidenceAsyncRef.value).toHaveBeenCalledWith(9876);
  });

  it("persists listener identity and executable image with readiness evidence", async () => {
    spawnNextWithPidFile(4320, 9875);
    expectListenerAlive();
    configureGatewayProcessOwnership(TEST_OWNERSHIP_ROOT);

    const result = await startGatewayWithReadiness(undefined, {
      key: "generated-internal-token",
      port: 8642,
    });

    expect(result.ready).toBe(true);
    const entries = JSON.parse(
      readFileSync(
        `${TEST_OWNERSHIP_ROOT}/gateway-process-ownership.json`,
        "utf8",
      ),
    ).entries;
    expect(entries).toEqual([
      expect.objectContaining({
        profileId: "default",
        spawnedPid: 4320,
        spawnedIdentity: "test-created-4320",
        spawnedImage: "python3",
        listenerPid: 9875,
        listenerIdentity: "test-created-9875",
        listenerImage: "python3",
      }),
    ]);
  });

  it("uses later same-PID listener proof to close a launch whose spawn proof was temporarily unavailable", async () => {
    const child = spawnNextWithPidFile(process.pid, process.pid);
    expectListenerAlive();
    let evidenceReads = 0;
    processEvidenceRef.value.mockImplementation((pid: number) => {
      evidenceReads += 1;
      return evidenceReads === 1
        ? (null as never)
        : { identity: `test-created-${pid}`, image: "python3" };
    });
    configureGatewayProcessOwnership(TEST_OWNERSHIP_ROOT);

    const started = await startGatewayWithReadiness(undefined, {
      key: "generated-internal-token",
      port: 8642,
    });

    expect(started.ready).toBe(true);
    expect(
      JSON.parse(
        readFileSync(
          `${TEST_OWNERSHIP_ROOT}/gateway-process-ownership.json`,
          "utf8",
        ),
      ).entries,
    ).toEqual([
      expect.objectContaining({
        spawnedPid: process.pid,
        spawnedIdentity: null,
        spawnedImage: null,
        listenerPid: process.pid,
        listenerIdentity: `test-created-${process.pid}`,
        listenerImage: "python3",
      }),
    ]);

    terminateRef.value.mockImplementationOnce(async () => {
      pidAliveRef.value.mockReturnValue(false);
      Object.defineProperty(child, "exitCode", {
        configurable: true,
        value: 0,
      });
      return { forced: false, remainingPids: [] };
    });

    await expect(stopAeraOwnedGateways()).resolves.toBeUndefined();
    expect(terminateRef.value).toHaveBeenCalledWith(
      child,
      expect.objectContaining({ verifyRootOwnership: expect.any(Function) }),
    );
    expect(existsSync(`${TEST_HOME}/gateway.pid`)).toBe(false);
    expect(
      JSON.parse(
        readFileSync(
          `${TEST_OWNERSHIP_ROOT}/gateway-process-ownership.json`,
          "utf8",
        ),
      ).entries,
    ).toEqual([]);
  });

  it("uses later same-PID listener proof to clean a launch whose API never becomes ready", async () => {
    httpState.statusCode.value = 503;
    const child = spawnNextWithPidFile(process.pid, process.pid);
    expectListenerAlive();
    let evidenceReads = 0;
    processEvidenceRef.value.mockImplementation((pid: number) => {
      evidenceReads += 1;
      return evidenceReads === 1
        ? (null as never)
        : { identity: `test-created-${pid}`, image: "python3" };
    });
    configureGatewayProcessOwnership(TEST_OWNERSHIP_ROOT);
    terminateRef.value.mockImplementationOnce(async () => {
      pidAliveRef.value.mockReturnValue(false);
      Object.defineProperty(child, "exitCode", {
        configurable: true,
        value: 0,
      });
      return { forced: false, remainingPids: [] };
    });

    const promise = startGatewayWithReadiness(
      undefined,
      { key: "generated-internal-token", port: 8642 },
      { readyTimeoutMs: 200, pollMs: 20 },
    );
    await vi.advanceTimersByTimeAsync(500);
    const result = await promise;

    expect(result.success).toBe(false);
    expect(result.ready).toBe(false);
    expect(result.running).toBe(false);
    expect(result.diagnostics?.termination).toEqual({
      forced: false,
      remainingPids: [],
    });
    expect(terminateRef.value).toHaveBeenCalledWith(
      child,
      expect.objectContaining({ verifyRootOwnership: expect.any(Function) }),
    );
    expect(terminatePidRef.value).not.toHaveBeenCalled();
  });

  it("warms the dashboard gateway only after the primary gateway is ready", async () => {
    spawnNextWithPidFile(4322, 9877);
    expectListenerAlive();
    configureGatewayProcessOwnership(TEST_OWNERSHIP_ROOT);
    const probesBeforeWarm = { value: -1 };
    const warmDashboard = vi.fn(() => {
      probesBeforeWarm.value = httpState.requests.length;
    });

    const result = await startGatewayWithReadiness(
      undefined,
      { key: "generated-internal-token", port: 8642 },
      { warmDashboard },
    );

    expect(result.ready).toBe(true);
    expect(warmDashboard).toHaveBeenCalledTimes(1);
    // The warm-up must observe at least one completed readiness probe,
    // proving the dashboard Python process never cold-starts concurrently
    // with the primary gateway.
    expect(probesBeforeWarm.value).toBeGreaterThan(0);
  });

  it("fails with process diagnostics when readiness times out", async () => {
    const marker = "GATEWAY_STDERR_TAIL_MARKER";
    mkdirSync(TEST_HOME, { recursive: true });
    writeFileSync(
      `${TEST_HOME}/gateway-stderr.log`,
      `${"x".repeat(8192)}\n${marker}\n`,
    );
    httpState.statusCode.value = 503;
    // The tracked child must look alive for the cleanup gate; use this
    // process's own (running) PID like the shutdown-lifecycle suite does.
    const child = spawnNext(process.pid);
    configureGatewayProcessOwnership(TEST_OWNERSHIP_ROOT);
    const warmDashboard = vi.fn();
    const ownershipChecks: boolean[] = [];
    terminateRef.value.mockImplementationOnce(async (...args: unknown[]) => {
      const options = args[1];
      const verifyRootOwnership = (
        options as { verifyRootOwnership: (pid: number) => boolean }
      ).verifyRootOwnership;
      ownershipChecks.push(verifyRootOwnership(process.pid));
      processEvidenceRef.value.mockReturnValueOnce({
        identity: `test-created-${process.pid}`,
        image: "node",
      });
      ownershipChecks.push(verifyRootOwnership(process.pid));
      return { forced: false, remainingPids: [] };
    });

    const promise = startGatewayWithReadiness(
      undefined,
      { key: "generated-internal-token", port: 8642 },
      { readyTimeoutMs: 200, pollMs: 20, warmDashboard },
    );
    await vi.advanceTimersByTimeAsync(500);
    const result = await promise;

    // A slow spawn must not be reported as a running, usable gateway.
    expect(result.ready).toBe(false);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/did not become ready/);
    expect(result.diagnostics?.pid).toBe(process.pid);
    expect(result.diagnostics?.command).toBe(invocation.python);
    expect(result.diagnostics?.exitCode).toBeNull();
    expect(result.diagnostics?.stderrTail).toContain(marker);
    expect(result.diagnostics?.stderrTail?.length).toBeLessThanOrEqual(4096);
    expect(warmDashboard).not.toHaveBeenCalled();
    // The never-ready process we spawned must be terminated with a bound —
    // leaving it alive is exactly the EBUSY / quit-timeout residue.
    expect(terminateRef.value).toHaveBeenCalledWith(
      child,
      expect.objectContaining({
        forceAfterMs: 3000,
        verifyRootOwnership: expect.any(Function),
      }),
    );
    expect(ownershipChecks).toEqual([true, false]);
    expect(result.diagnostics?.termination).toEqual({
      forced: false,
      remainingPids: [],
    });
    expect(result.running).toBe(false);
    expect(child.exitCode).toBeNull();
  });

  it("emits path-free stages before and during timeout cleanup", async () => {
    process.env.AGENTERA_E2E_DIAGNOSTICS = "1";
    httpState.statusCode.value = 503;
    spawnNext(process.pid);
    configureGatewayProcessOwnership(TEST_OWNERSHIP_ROOT);
    const diagnostics: string[] = [];
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation((...args: unknown[]) => {
        const line = args.map(String).join(" ");
        if (line.includes("[gateway-readiness]")) diagnostics.push(line);
      });

    try {
      const promise = startGatewayWithReadiness(
        undefined,
        { key: "generated-internal-token", port: 8642 },
        { readyTimeoutMs: 200, pollMs: 20 },
      );
      await vi.advanceTimersByTimeAsync(500);
      await promise;
    } finally {
      consoleError.mockRestore();
    }

    const events = diagnostics.join("\n");
    for (const event of [
      "wait-start",
      "poll",
      "wait-complete",
      "cleanup-plan",
      "cleanup-target-start",
      "cleanup-target-complete",
    ]) {
      expect(events).toContain(`"event":"${event}"`);
    }
    expect(events).not.toContain(TEST_HOME);
    expect(events).not.toContain(invocation.python);
    expect(events).not.toContain("generated-internal-token");
    expect(events).toContain('"identityAvailable":false');
    expect(events).toContain('"apiProbeAttempted":false');
    // The wrapper liveness/CPU curve is part of every poll so a stalled
    // packaged launch can be told apart (busy cold-start vs hung wrapper).
    expect(events).toContain(`"wrapperPid":${process.pid}`);
    expect(events).toContain('"wrapperAlive":false');
    if (process.platform === "win32") {
      // Windows samples the wrapper's real CPU seconds via PowerShell.
      expect(events).toMatch(/"wrapperCpuSeconds":(?:\d+(?:\.\d+)?|null)/u);
      expect(events).toMatch(
        /"wrapperCpuSampleState":"(?:pending|value|missing|error)"/u,
      );
    } else {
      expect(events).toContain('"wrapperCpuSeconds":null');
      expect(events).toContain('"wrapperCpuSampleState":"unsupported"');
    }
  });

  it("does not let a slow Windows CPU sample extend the readiness deadline", async () => {
    const platform = vi
      .spyOn(process, "platform", "get")
      .mockReturnValue("win32");
    process.env.AGENTERA_E2E_DIAGNOSTICS = "1";
    httpState.statusCode.value = 503;
    spawnNext(process.pid);
    configureGatewayProcessOwnership(TEST_OWNERSHIP_ROOT);

    let releaseCpuSample:
      | ((error: Error | null, stdout: string) => void)
      | undefined;
    execFileRef.value.mockImplementation(
      (
        _command: string,
        _args: string[],
        _options: { timeout: number },
        callback: (error: Error | null, stdout: string) => void,
      ) => {
        releaseCpuSample = callback;
        return {};
      },
    );

    let settled = false;
    const promise = startGatewayWithReadiness(
      undefined,
      { key: "generated-internal-token", port: 8642 },
      { readyTimeoutMs: 100, pollMs: 20 },
    );
    void promise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await vi.advanceTimersByTimeAsync(250);
    const settledBeforeCpuCallback = settled;

    // Release the intentionally delayed callback so a broken implementation
    // can finish before this test asserts the deadline behavior.
    releaseCpuSample?.(null, "12.5\n");
    await vi.advanceTimersByTimeAsync(250);
    const result = await promise;
    platform.mockRestore();

    expect(settledBeforeCpuCallback).toBe(true);
    expect(result.ready).toBe(false);
    expect(result.success).toBe(false);
    expect(result.diagnostics?.termination).toEqual({
      forced: false,
      remainingPids: [],
    });
  });

  it("still cleans up the listener when the wrapper exits before the deadline", async () => {
    // The short-lived CLI wrapper exits while readiness is still waiting:
    // the Map entry is gone, so cleanup must fall back to the verified
    // listener PID from gateway.pid instead of skipping termination. The API
    // never answers — the listener is alive but not serving.
    httpState.statusCode.value = 503;
    const child = spawnNext(process.pid);
    const warmDashboard = vi.fn();
    configureGatewayProcessOwnership(TEST_OWNERSHIP_ROOT);

    const promise = startGatewayWithReadiness(
      undefined,
      { key: "generated-internal-token", port: 8642 },
      { readyTimeoutMs: 400, pollMs: 20, warmDashboard },
    );
    // The wrapper reports its real exit mid-wait and leaves a live listener.
    queueMicrotask(() => {
      writeFileSync(`${TEST_HOME}/gateway.pid`, JSON.stringify({ pid: 9880 }));
      pidAliveRef.value.mockImplementation(
        (pid: unknown) => pid === 9880 || pid === process.pid,
      );
      Object.defineProperty(child, "exitCode", { value: 0 });
      child.emit("close", 0, null);
    });
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await promise;

    expect(result.ready).toBe(false);
    expect(result.success).toBe(false);
    expect(result.running).toBe(false);
    // The wrapper's real exit evidence survives the Map eviction.
    expect(result.diagnostics?.exitCode).toBe(0);
    // Termination targets the verified listener PID, not the dead wrapper.
    expect(terminatePidRef.value).toHaveBeenCalledWith(
      9880,
      expect.objectContaining({ forceAfterMs: 3000 }),
    );
    expect(terminateRef.value).not.toHaveBeenCalled();
    expect(warmDashboard).not.toHaveBeenCalled();
  });

  it("cleans a listener published after the final readiness poll but before cleanup", async () => {
    process.env.AGENTERA_E2E_DIAGNOSTICS = "1";
    httpState.statusCode.value = 503;
    const child = spawnNext(process.pid);
    configureGatewayProcessOwnership(TEST_OWNERSHIP_ROOT);
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation((...args: unknown[]) => {
        const line = args.map(String).join(" ");
        if (!line.includes('"event":"wait-complete"')) return;
        writeFileSync(
          `${TEST_HOME}/gateway.pid`,
          JSON.stringify({ pid: 9884 }),
        );
        pidAliveRef.value.mockImplementation(
          (pid: unknown) => pid === 9884 || pid === process.pid,
        );
        Object.defineProperty(child, "exitCode", {
          configurable: true,
          value: 0,
        });
        child.emit("close", 0, null);
      });

    try {
      const promise = startGatewayWithReadiness(
        undefined,
        { key: "generated-internal-token", port: 8642 },
        { readyTimeoutMs: 200, pollMs: 20 },
      );
      await vi.advanceTimersByTimeAsync(500);
      const result = await promise;

      expect(result.ready).toBe(false);
      expect(result.running).toBe(false);
      expect(terminatePidRef.value).toHaveBeenCalledWith(
        9884,
        expect.objectContaining({ forceAfterMs: 3000 }),
      );
      expect(result.diagnostics?.termination).toEqual({
        forced: false,
        remainingPids: [],
      });
    } finally {
      consoleError.mockRestore();
    }
  });

  it("reports stopped when the wrapper exits without publishing a listener pid", async () => {
    httpState.statusCode.value = 503;
    const child = spawnNext(process.pid);
    configureGatewayProcessOwnership(TEST_OWNERSHIP_ROOT);

    const promise = startGatewayWithReadiness(
      undefined,
      { key: "generated-internal-token", port: 8642 },
      { readyTimeoutMs: 400, pollMs: 20 },
    );
    queueMicrotask(() => {
      Object.defineProperty(child, "exitCode", { value: 1 });
      child.emit("close", 1, null);
    });
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await promise;

    expect(result.ready).toBe(false);
    expect(result.success).toBe(false);
    expect(result.running).toBe(false);
    expect(result.diagnostics?.termination).toEqual({
      forced: false,
      remainingPids: [],
    });
    expect(terminateRef.value).not.toHaveBeenCalled();
  });

  it("keeps the launch ambiguous when a live wrapper has no identity evidence", async () => {
    httpState.statusCode.value = 503;
    spawnNext(process.pid);
    processEvidenceRef.value.mockImplementation(() => null as never);
    configureGatewayProcessOwnership(TEST_OWNERSHIP_ROOT);

    const promise = startGatewayWithReadiness(
      undefined,
      { key: "generated-internal-token", port: 8642 },
      { readyTimeoutMs: 200, pollMs: 20 },
    );
    await vi.advanceTimersByTimeAsync(500);
    const result = await promise;

    expect(result.success).toBe(false);
    expect(result.ready).toBe(false);
    expect(result.running).toBe(true);
    expect(result.diagnostics?.termination).toEqual({
      forced: false,
      remainingPids: [process.pid],
    });
    expect(terminateRef.value).not.toHaveBeenCalled();
    expect(
      JSON.parse(
        readFileSync(
          `${TEST_OWNERSHIP_ROOT}/gateway-process-ownership.json`,
          "utf8",
        ),
      ).entries,
    ).toHaveLength(1);
  });

  it("keeps a live pid-file listener ambiguous when its evidence is unavailable", async () => {
    httpState.statusCode.value = 503;
    const child = spawnNext(process.pid);
    configureGatewayProcessOwnership(TEST_OWNERSHIP_ROOT);

    const promise = startGatewayWithReadiness(
      undefined,
      { key: "generated-internal-token", port: 8642 },
      { readyTimeoutMs: 300, pollMs: 20 },
    );
    queueMicrotask(() => {
      writeFileSync(`${TEST_HOME}/gateway.pid`, JSON.stringify({ pid: 9882 }));
      pidAliveRef.value.mockImplementation(
        (pid: unknown) => pid === 9882 || pid === process.pid,
      );
      processEvidenceRef.value.mockImplementation((pid: number) =>
        pid === 9882
          ? (null as never)
          : { identity: `test-created-${pid}`, image: "python3" },
      );
      Object.defineProperty(child, "exitCode", { value: 0 });
      child.emit("close", 0, null);
    });
    await vi.advanceTimersByTimeAsync(700);
    const result = await promise;

    expect(result.success).toBe(false);
    expect(result.ready).toBe(false);
    expect(result.running).toBe(true);
    expect(result.diagnostics?.termination).toEqual({
      forced: false,
      remainingPids: [9882],
    });
    expect(terminatePidRef.value).not.toHaveBeenCalled();
  });

  it("keeps running=true when timeout cleanup cannot be verified", async () => {
    httpState.statusCode.value = 503;
    spawnNext(process.pid);
    configureGatewayProcessOwnership(TEST_OWNERSHIP_ROOT);
    terminateRef.value.mockRejectedValueOnce(new Error("snapshot unavailable"));

    const promise = startGatewayWithReadiness(
      undefined,
      { key: "generated-internal-token", port: 8642 },
      { readyTimeoutMs: 200, pollMs: 20 },
    );
    await vi.advanceTimersByTimeAsync(500);
    const result = await promise;

    expect(result.ready).toBe(false);
    expect(result.success).toBe(false);
    expect(result.running).toBe(true);
    expect(result.diagnostics?.termination).toEqual({
      forced: false,
      remainingPids: [process.pid],
    });
  });

  it("rejects a stale pre-launch pid file as readiness evidence", async () => {
    // A stale pid file whose number later resolves to a live Python process
    // (PID reuse) must still fail: the pid was never re-published by THIS
    // launch's listener. The file starts dead so the launch proceeds, then
    // appears alive mid-flight — the pre-launch identity still rejects it.
    mkdirSync(TEST_HOME, { recursive: true });
    writeFileSync(`${TEST_HOME}/gateway.pid`, JSON.stringify({ pid: 5555 }));
    pidAliveRef.value.mockReturnValue(false);
    const child = spawnNext(process.pid);
    configureGatewayProcessOwnership(TEST_OWNERSHIP_ROOT);

    const promise = startGatewayWithReadiness(
      undefined,
      { key: "generated-internal-token", port: 8642 },
      { readyTimeoutMs: 200, pollMs: 20 },
    );
    queueMicrotask(() => {
      pidAliveRef.value.mockImplementation(
        (pid: unknown) => pid === 5555 || pid === process.pid,
      );
    });
    await vi.advanceTimersByTimeAsync(500);
    const result = await promise;

    expect(result.ready).toBe(false);
    expect(terminateRef.value).toHaveBeenCalledWith(
      child,
      expect.objectContaining({ forceAfterMs: 3000 }),
    );
  });

  it("rejects a pid file whose process is not a live Python listener", async () => {
    // The pid file exists but the identity probe says it is dead or not
    // Python — pidIsAliveAs stays false, so readiness never trusts it.
    spawnNextWithPidFile(process.pid, 4327);
    processEvidenceRef.value.mockImplementation((pid: number) =>
      pid === 4327
        ? (null as never)
        : { identity: `test-created-${pid}`, image: "python3" },
    );
    configureGatewayProcessOwnership(TEST_OWNERSHIP_ROOT);

    const promise = startGatewayWithReadiness(
      undefined,
      { key: "generated-internal-token", port: 8642 },
      { readyTimeoutMs: 200, pollMs: 20 },
    );
    await vi.advanceTimersByTimeAsync(500);
    const result = await promise;

    expect(result.ready).toBe(false);
    expect(result.running).toBe(false);
  });

  it("probes readiness for an already-running gateway instead of trusting running=true", async () => {
    mkdirSync(TEST_HOME, { recursive: true });
    writeFileSync(`${TEST_HOME}/gateway.pid`, JSON.stringify({ pid: 9876 }));
    pidAliveRef.value.mockReturnValue(true);
    configureGatewayProcessOwnership(TEST_OWNERSHIP_ROOT);

    const result = await startGatewayWithReadiness(undefined, undefined, {
      readyTimeoutMs: 200,
      pollMs: 20,
    });

    expect(result.alreadyRunning).toBe(true);
    expect(result.running).toBe(true);
    expect(result.ready).toBe(true);
    expect(spawnRef.value).not.toHaveBeenCalled();
    expect(httpState.requests.length).toBeGreaterThan(0);
  });

  it("never reports ready when gateway.pid never appears", async () => {
    // The API socket answers but the daemonized listener never wrote its
    // pid file: readiness must stay false and the spawned process must be
    // cleaned up, otherwise the acceptance's "pid file exists" check fails.
    const child = spawnNext(process.pid);
    configureGatewayProcessOwnership(TEST_OWNERSHIP_ROOT);

    const promise = startGatewayWithReadiness(
      undefined,
      { key: "generated-internal-token", port: 8642 },
      { readyTimeoutMs: 200, pollMs: 20 },
    );
    await vi.advanceTimersByTimeAsync(500);
    const result = await promise;

    expect(result.ready).toBe(false);
    expect(result.success).toBe(false);
    expect(result.running).toBe(false);
    // The gate checks the pid file first and short-circuits: without the
    // listener's durable identity, no API answer counts as serving.
    expect(terminateRef.value).toHaveBeenCalledWith(
      child,
      expect.objectContaining({ forceAfterMs: 3000 }),
    );
  });

  it("carries the parsed capabilities document into diagnostics", async () => {
    httpState.body.value = JSON.stringify({
      features: { request_tool_policy: true, request_model_route: true },
    });
    spawnNextWithPidFile(4326, 9878);
    expectListenerAlive();
    configureGatewayProcessOwnership(TEST_OWNERSHIP_ROOT);

    const result = await startGatewayWithReadiness(undefined, {
      key: "generated-internal-token",
      port: 8642,
    });

    expect(result.ready).toBe(true);
    expect(result.diagnostics?.capabilities).toEqual({
      requestToolPolicy: true,
      requestModelRoute: true,
    });
  });

  it("uses the prepared credential for the readiness probe", async () => {
    // The persisted stores stay empty in this fixture; only the freshly
    // prepared credential may authenticate the probe.
    apiKeyRef.value = "";
    httpState.authorizeWith.value = "Bearer prepared-launch-key";
    spawnNextWithPidFile(4324, 9879);
    expectListenerAlive();
    configureGatewayProcessOwnership(TEST_OWNERSHIP_ROOT);
    const warmDashboard = vi.fn();

    const result = await startGatewayWithReadiness(
      undefined,
      { key: "prepared-launch-key", port: 8642 },
      { warmDashboard },
    );

    expect(result.ready).toBe(true);
    expect(httpState.requests.length).toBeGreaterThan(0);
    expect(
      httpState.requests.every(
        (request) => request.authorization === "Bearer prepared-launch-key",
      ),
    ).toBe(true);
    expect(warmDashboard).toHaveBeenCalledTimes(1);
  });

  it("fails closed for an ambiguous migrated ownership record even when its PID is live", () => {
    writeFileSync(
      `${TEST_OWNERSHIP_ROOT}/gateway-process-ownership.json`,
      JSON.stringify({
        version: 1,
        entries: [
          {
            launchId: "10000000-0000-4000-8000-000000000001",
            desktopInstanceId: "10000000-0000-4000-8000-000000000002",
            desktopPid: 100,
            profileId: "default",
            preLaunchPid: null,
            spawnedPid: 9876,
            createdAt: "2026-08-03T10:00:00.000Z",
          },
        ],
      }),
      "utf8",
    );
    writeFileSync(`${TEST_HOME}/gateway.pid`, JSON.stringify({ pid: 9876 }));
    pidAliveRef.value.mockReturnValue(true);
    configureGatewayProcessOwnership(TEST_OWNERSHIP_ROOT);

    expect(isGatewayRunning()).toBe(false);
    expect(spawnRef.value).not.toHaveBeenCalled();
  });

  it("cleans both wrapper and listener when ownership adoption fails after readiness", async () => {
    const wrapper = spawnNextWithPidFile(process.pid, 9881);
    expectListenerAlive();
    configureGatewayProcessOwnership(TEST_OWNERSHIP_ROOT);
    const adoptSpy = vi
      .spyOn(GatewayProcessOwnershipLedger.prototype, "adoptSpawnedPid")
      .mockImplementation(() => {
        throw new Error("injected adoption persistence failure");
      });

    try {
      const result = await startGatewayWithReadiness(
        undefined,
        { key: "generated-internal-token", port: 8642 },
        { warmDashboard: vi.fn() },
      );

      expect(result.success).toBe(false);
      expect(result.ready).toBe(false);
      expect(terminateRef.value).toHaveBeenCalledWith(
        wrapper,
        expect.objectContaining({ forceAfterMs: 3000 }),
      );
      expect(terminatePidRef.value).toHaveBeenCalledWith(
        9881,
        expect.objectContaining({ forceAfterMs: 3000 }),
      );
    } finally {
      adoptSpy.mockRestore();
    }
  });

  it("releases durable ownership after a verified timeout cleanup", async () => {
    httpState.statusCode.value = 503;
    const child = spawnNext(process.pid);
    configureGatewayProcessOwnership(TEST_OWNERSHIP_ROOT);

    const promise = startGatewayWithReadiness(
      undefined,
      { key: "generated-internal-token", port: 8642 },
      { readyTimeoutMs: 300, pollMs: 20 },
    );
    queueMicrotask(() => {
      writeFileSync(`${TEST_HOME}/gateway.pid`, JSON.stringify({ pid: 9883 }));
      pidAliveRef.value.mockImplementation(
        (pid: unknown) => pid === 9883 || pid === process.pid,
      );
      Object.defineProperty(child, "exitCode", { value: 0 });
      child.emit("close", 0, null);
    });
    await vi.advanceTimersByTimeAsync(700);
    const result = await promise;

    expect(result.running).toBe(false);
    expect(result.diagnostics?.termination).toEqual({
      forced: false,
      remainingPids: [],
    });
    expect(
      JSON.parse(
        readFileSync(
          `${TEST_OWNERSHIP_ROOT}/gateway-process-ownership.json`,
          "utf8",
        ),
      ).entries,
    ).toEqual([]);
    expect(existsSync(`${TEST_HOME}/gateway.pid`)).toBe(false);
  });
});
