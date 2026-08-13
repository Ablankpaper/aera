import { EventEmitter } from "node:events";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { activeProfileRef, invocation } = vi.hoisted(() => ({
  activeProfileRef: { value: undefined as string | undefined },
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
}));

vi.mock("./installer", () => ({
  HERMES_HOME: "/tmp/hermes-test-home",
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
  startSshTunnel: vi.fn(),
}));
vi.mock("./utils", () => ({
  pidIsAliveAs: vi.fn(() => false),
  stripAnsi: (value: string) => value,
  profileHome: vi.fn((profile?: string) =>
    profile
      ? `/tmp/hermes-test-home/profiles/${profile}`
      : "/tmp/hermes-test-home",
  ),
  profilePaths: vi.fn(() => ({
    configFile: "/nonexistent/hermes-test/config.yaml",
  })),
  normalizeProfileName: (profile?: string) =>
    profile === "default" ? undefined : profile,
  getActiveProfileNameSync: vi.fn(() => activeProfileRef.value),
}));
vi.mock("./gateway-ports", () => ({
  ensureProfilePortAvailable: vi.fn(async () => 8642),
  getProfilePort: vi.fn(() => 8642),
}));
vi.mock("./models", () => ({ readModels: vi.fn(() => []) }));
vi.mock("./secrets", () => ({ providerListSafe: vi.fn(() => ({})) }));

import {
  TuiGatewayClient,
  getTuiGatewayClient,
  retireTuiGatewayClient,
  stopGateway,
  stopAllTuiGatewayClients,
  type TuiGatewayClientDependencies,
} from "./hermes";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function fakeChildProcess(pid: number): ChildProcess {
  const proc = new EventEmitter() as ChildProcess;
  Object.assign(proc, {
    pid,
    exitCode: null,
    signalCode: null,
    killed: false,
    kill: vi.fn(() => true),
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  });
  return proc;
}

function lifecycleDependencies(
  overrides: Partial<TuiGatewayClientDependencies> = {},
): {
  dependencies: TuiGatewayClientDependencies;
  spawnBackend: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
  child: ChildProcess;
} {
  const child = fakeChildProcess(4120);
  const spawnBackend = vi.fn(() => child);
  const terminate = vi.fn(async (proc: ChildProcess) => {
    proc.emit("exit", 0, "SIGTERM");
    return { forced: false, remainingPids: [] };
  });
  return {
    child,
    spawnBackend,
    terminate,
    dependencies: {
      pickDashboardPort: vi.fn(async () => 9120),
      spawnBackend:
        spawnBackend as TuiGatewayClientDependencies["spawnBackend"],
      waitForDashboardReady: vi.fn(() => new Promise<void>(() => undefined)),
      terminateProcessTree:
        terminate as TuiGatewayClientDependencies["terminateProcessTree"],
      ...overrides,
    },
  };
}

describe("TuiGatewayClient lifecycle", () => {
  beforeEach(async () => {
    activeProfileRef.value = undefined;
    await stopAllTuiGatewayClients();
  });

  afterEach(async () => {
    await stopAllTuiGatewayClients();
  });

  // @lat: [[agentera-runtime-distribution#Desktop TUI backend lifecycle#Runtime 0.20 headless contract]]
  it("uses the Runtime 0.20 headless Desktop launch contract", async () => {
    const { dependencies, spawnBackend, terminate } = lifecycleDependencies();
    const client = new TuiGatewayClient(
      "work",
      { HERMES_HOME: "/tmp/hermes-test-home/profiles/work" },
      dependencies,
    );

    const started = client.start();
    await vi.waitFor(() => expect(spawnBackend).toHaveBeenCalledOnce());

    const [python, args, options] = spawnBackend.mock.calls[0] as [
      string,
      string[],
      SpawnOptions,
    ];
    expect(python).toBe(invocation.python);
    expect(args).toEqual([
      "-m",
      "hermes_cli.main",
      "serve",
      "--no-open",
      "--host",
      "127.0.0.1",
      "--port",
      "9120",
    ]);
    expect(options.env).toMatchObject({
      HERMES_DASHBOARD_TUI: "1",
      HERMES_DESKTOP: "1",
      HERMES_HOME: "/tmp/hermes-test-home/profiles/work",
    });
    expect(options.detached).toBe(process.platform !== "win32");

    const stopped = client.stop();
    await expect(started).rejects.toThrow("stopped");
    await stopped;
    expect(terminate).toHaveBeenCalledOnce();
    expect(terminate.mock.calls[0]?.[1]).toMatchObject({
      detachedProcessGroup: process.platform !== "win32",
    });
  });

  // @lat: [[agentera-runtime-distribution#Desktop TUI backend lifecycle#Cancelled startup cannot outlive Desktop]]
  it("does not spawn after stop invalidates pending port selection", async () => {
    const port = deferred<number>();
    const { dependencies, spawnBackend } = lifecycleDependencies({
      pickDashboardPort: vi.fn(() => port.promise),
    });
    const client = new TuiGatewayClient("work", {}, dependencies);

    const started = client.start();
    const stopped = client.stop();
    port.resolve(9120);

    await expect(started).rejects.toThrow("stopped");
    await stopped;
    await Promise.resolve();
    expect(spawnBackend).not.toHaveBeenCalled();
  });

  // @lat: [[agentera-runtime-distribution#Desktop TUI backend lifecycle#Cancelled startup cannot outlive Desktop]]
  it("keeps Runtime process errors handled after readiness", async () => {
    const { dependencies, child, terminate } = lifecycleDependencies({
      waitForDashboardReady: vi.fn(async () => undefined),
    });
    const client = new TuiGatewayClient("work", {}, dependencies);
    (
      client as unknown as {
        connectWebSocket: () => Promise<void>;
      }
    ).connectWebSocket = vi.fn(async () => undefined);

    await client.start();

    expect(child.listenerCount("error")).toBeGreaterThan(0);
    expect(() =>
      child.emit("error", new Error("Runtime pipe failed")),
    ).not.toThrow();
    await vi.waitFor(() => expect(terminate).toHaveBeenCalledOnce());
  });

  // @lat: [[agentera-runtime-distribution#Desktop TUI backend lifecycle#Cancelled startup cannot outlive Desktop]]
  it("does not spawn when admission closes while waiting for an older stop", async () => {
    const stopGate = deferred<void>();
    const child = fakeChildProcess(4130);
    const spawnBackend = vi.fn(() => child);
    const terminate = vi.fn(async () => {
      await stopGate.promise;
      return { forced: false, remainingPids: [] };
    });
    const client = new TuiGatewayClient(
      "work",
      {},
      {
        pickDashboardPort: vi.fn(async () => 9120),
        spawnBackend:
          spawnBackend as TuiGatewayClientDependencies["spawnBackend"],
        waitForDashboardReady: vi.fn(async () => {
          throw new Error("late spawn");
        }),
        terminateProcessTree:
          terminate as TuiGatewayClientDependencies["terminateProcessTree"],
      },
    );

    (client as unknown as { proc: ChildProcess | null }).proc = child;
    const stopping = client.stop();
    const starting = client.start();
    client.closeAdmission();
    stopGate.resolve();

    await expect(starting).rejects.toThrow(/shutting down|stopped/i);
    await stopping;
    expect(spawnBackend).not.toHaveBeenCalled();
  });

  // @lat: [[agentera-runtime-distribution#Desktop TUI backend lifecycle#Exact process-tree shutdown]]
  it("rejects a stop with a remaining owned process and retries the exact child", async () => {
    const { dependencies, spawnBackend, child } = lifecycleDependencies({
      terminateProcessTree: vi
        .fn()
        .mockResolvedValueOnce({ forced: false, remainingPids: [4120] })
        .mockResolvedValueOnce({
          forced: false,
          remainingPids: [],
        }) as TuiGatewayClientDependencies["terminateProcessTree"],
    });
    const client = new TuiGatewayClient("work", {}, dependencies);

    const started = client.start();
    await vi.waitFor(() => expect(spawnBackend).toHaveBeenCalledOnce());
    const firstStop = client.stop();

    await expect(started).rejects.toThrow("stopped");
    await expect(firstStop).rejects.toThrow(/did not fully exit/i);
    await expect(client.stop()).resolves.toBeUndefined();
    expect(dependencies.terminateProcessTree).toHaveBeenCalledTimes(2);
    expect(child.pid).toBe(4120);
  });

  // @lat: [[agentera-runtime-distribution#Desktop TUI backend lifecycle#Pool-wide App shutdown]]
  it("stops every TUI-only Profile independently of Gateway ownership", async () => {
    const first = getTuiGatewayClient("default");
    const second = getTuiGatewayClient("work");
    const stopFirst = vi.spyOn(first, "stop").mockResolvedValue();
    const stopSecond = vi.spyOn(second, "stop").mockResolvedValue();

    await stopAllTuiGatewayClients();

    expect(stopFirst).toHaveBeenCalledOnce();
    expect(stopSecond).toHaveBeenCalledOnce();
    await stopAllTuiGatewayClients();
    expect(stopFirst).toHaveBeenCalledOnce();
    expect(stopSecond).toHaveBeenCalledOnce();
  });

  it("retires only the requested Profile so its next turn gets a fresh Runtime client", async () => {
    const work = getTuiGatewayClient("work");
    const personal = getTuiGatewayClient("personal");
    const stopWork = vi.spyOn(work, "stop").mockResolvedValue();
    const stopPersonal = vi.spyOn(personal, "stop").mockResolvedValue();

    await retireTuiGatewayClient("work");

    expect(stopWork).toHaveBeenCalledOnce();
    expect(stopPersonal).not.toHaveBeenCalled();
    expect(getTuiGatewayClient("work")).not.toBe(work);
    expect(getTuiGatewayClient("personal")).toBe(personal);
  });

  // @lat: [[agentera-runtime-distribution#Desktop TUI backend lifecycle#Pool-wide App shutdown]]
  it("serializes pool cleanup and temporarily blocks late TUI admission", async () => {
    const existing = getTuiGatewayClient("existing");
    const stopGate = deferred<void>();
    vi.spyOn(existing, "stop").mockImplementation(() => stopGate.promise);

    const first = stopAllTuiGatewayClients();
    await Promise.resolve();
    expect(() => getTuiGatewayClient("late")).toThrow(/shutting down/i);

    let secondFinished = false;
    const second = stopAllTuiGatewayClients().then(() => {
      secondFinished = true;
    });
    await Promise.resolve();
    expect(secondFinished).toBe(false);

    stopGate.resolve();
    await first;
    await second;
    expect(() => getTuiGatewayClient("after-cleanup")).not.toThrow();
  });

  // @lat: [[agentera-runtime-distribution#Desktop TUI backend lifecycle#Pool-wide App shutdown]]
  it("drains a profile stop registered while pool shutdown is already waiting", async () => {
    const existing = getTuiGatewayClient("existing");
    const late = getTuiGatewayClient("late");
    const firstGate = deferred<void>();
    const lateGate = deferred<void>();
    vi.spyOn(existing, "stop").mockImplementation(() => firstGate.promise);
    vi.spyOn(late, "stop").mockImplementation(() => lateGate.promise);

    stopGateway("existing", true);
    await Promise.resolve();
    let settled = false;
    const shutdown = stopAllTuiGatewayClients().then(() => {
      settled = true;
    });
    await Promise.resolve();

    stopGateway("late", true);
    firstGate.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    lateGate.resolve();
    await shutdown;
    expect(settled).toBe(true);
  });

  // @lat: [[agentera-runtime-distribution#Desktop TUI backend lifecycle#Pool-wide App shutdown]]
  it("retains a failed TUI stop for a later fail-closed retry", async () => {
    const existing = getTuiGatewayClient("retry");
    const stop = vi
      .spyOn(existing, "stop")
      .mockRejectedValueOnce(new Error("owned Runtime remained"))
      .mockResolvedValueOnce();

    await expect(stopAllTuiGatewayClients()).rejects.toThrow(
      "owned Runtime remained",
    );
    await stopAllTuiGatewayClients();
    expect(stop).toHaveBeenCalledTimes(2);
  });

  // @lat: [[agentera-runtime-distribution#Desktop TUI backend lifecycle#Pool-wide App shutdown]]
  it("closes TUI admission before App shutdown snapshots the pool", async () => {
    vi.resetModules();
    const freshHermes = await import("./hermes");
    const existing = freshHermes.getTuiGatewayClient("existing");
    await freshHermes.stopAllTuiGatewayClients({ closePool: true });

    await expect(existing.start()).rejects.toThrow(
      "dashboard gateway pool is shutting down",
    );
    expect(() => freshHermes.getTuiGatewayClient("late")).toThrow(
      "dashboard gateway pool is shutting down",
    );
  });
});
