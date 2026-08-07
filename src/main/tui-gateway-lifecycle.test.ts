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

    const stopped = client.stop();
    await expect(started).rejects.toThrow("stopped");
    await stopped;
    expect(terminate).toHaveBeenCalledOnce();
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
});
