// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";

const { TEST_HOME, TEST_RUNTIME, httpRequestSpy, spawnSpy } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require("path");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require("os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require("events");
  const home = path.join(os.tmpdir(), `dashboard-runtime-${Date.now()}`);
  const runtime = path.join(home, "runtime");

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

  return { TEST_HOME: home, TEST_RUNTIME: runtime, httpRequestSpy, spawnSpy };
});

vi.mock("child_process", () => ({
  spawn: spawnSpy,
  default: { spawn: spawnSpy },
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

vi.mock("../src/main/ssh-tunnel", () => ({
  ensureSshTunnel: vi.fn(),
  getSshTunnelUrl: vi.fn(),
}));

vi.mock("../src/main/ssh-remote", () => ({
  sshEnsureDashboard: vi.fn(),
}));

vi.mock("../src/main/utils", () => ({
  getActiveProfileNameSync: () => undefined,
  normalizeProfileName: (profile?: string) =>
    !profile || profile === "default" ? undefined : profile,
  profileHome: () => TEST_HOME,
}));

import { startDashboard, stopAllDashboards } from "../src/main/dashboard";

describe("Dashboard Runtime invocation", () => {
  beforeEach(() => {
    spawnSpy.mockClear();
    httpRequestSpy.mockClear();
    mkdirSync(
      `${TEST_RUNTIME}/python/lib/python3.11/site-packages/hermes_cli/web_dist`,
      { recursive: true },
    );
    writeFileSync(
      `${TEST_RUNTIME}/python/lib/python3.11/site-packages/hermes_cli/web_dist/index.html`,
      "dashboard",
    );
  });

  afterEach(() => {
    stopAllDashboards();
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
});
