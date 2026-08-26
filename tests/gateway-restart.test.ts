import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { ChildProcess, spawn as spawnChild } from "child_process";
const {
  TEST_HOME,
  TEST_REPO,
  connModeRef,
  healthStatuses,
  aliveGatewayPids,
  realGatewayPids,
  pidAliveProbeRef,
  ensureLocalApiServerKeySpy,
  healthRequests,
  restartScript,
  hermesCliArgsSpy,
  prepareGatewayManagedConfigurationSpy,
  processEvidenceRef,
} = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require("path");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require("os");

  const script =
    "const fs=require('fs'),path=require('path');" +
    "fs.writeFileSync(path.join(process.env.HERMES_HOME,'restart-env.json')," +
    "JSON.stringify({api:process.env.API_SERVER_ENABLED,key:process.env.TEST_PROFILE_KEY}));" +
    "const profile=process.env.TEST_PROFILE_KEY||'default';" +
    "const home=profile==='default'?process.env.HERMES_HOME:path.join(process.env.HERMES_HOME,'profiles',profile);" +
    "fs.mkdirSync(home,{recursive:true});" +
    "fs.writeFileSync(path.join(home,'gateway.pid'),String(process.pid));" +
    "setInterval(()=>{},1000)";

  return {
    TEST_HOME: path.join(os.tmpdir(), `hermes-gateway-restart-${Date.now()}`),
    TEST_REPO: path.join(os.tmpdir(), `hermes-gateway-repo-${Date.now()}`),
    connModeRef: { mode: "local" as "local" | "remote" | "ssh" },
    healthStatuses: [] as number[],
    aliveGatewayPids: new Set<number>(),
    realGatewayPids: new Set<number>(),
  pidAliveProbeRef: {
    onProbe: null as ((pid: number) => void) | null,
  },
    ensureLocalApiServerKeySpy: vi.fn(() => ({
      generated: false,
      key: "unit-test-internal-token",
    })),
    healthRequests: [] as Array<{
      headers?: Record<string, string>;
      url: string;
    }>,
    restartScript: script,
    hermesCliArgsSpy: vi.fn(),
    prepareGatewayManagedConfigurationSpy: vi.fn(async (_profile?: string) => ({
      key: "unit-test-internal-token",
      port: 8642,
    })),
    // Gateway lifecycle tests use real child processes for a few scenarios,
    // but must not consult the host `ps` table. Keep process identity/image
    // evidence deterministic and overridable per PID instead.
    processEvidenceRef: {
      byPid: new Map<number, { identity: string; image: string }>(),
    },
  };
});

vi.mock("../src/main/installer", () => ({
  HERMES_HOME: TEST_HOME,
  getEnhancedPath: () => process.env.PATH || "",
}));

vi.mock("../src/main/agentera-runtime-distribution/invocation", () => ({
  getRuntimeInvocation: () => ({
    source: "external",
    version: null,
    sourceCommit: null,
    root: TEST_REPO,
    python: process.execPath,
    workingDirectory: TEST_REPO,
    bundledSkillsDirectory: `${TEST_REPO}/skills`,
    webDistDirectory: `${TEST_REPO}/hermes_cli/web_dist`,
    cliArgs: hermesCliArgsSpy,
    environment: (base: Record<string, string> = {}) => ({ ...base }),
  }),
}));

vi.mock("../src/main/config", () => ({
  ensureLocalApiServerKey: ensureLocalApiServerKeySpy,
  getModelConfig: () => ({ model: "test-model", provider: "openrouter" }),
  getApiServerKey: () => "unit-test-internal-token",
  readEnv: (profile?: string) => ({ TEST_PROFILE_KEY: profile || "default" }),
  getConnectionConfig: () => ({ mode: connModeRef.mode }),
  getConfigValue: () => "",
  setConfigValue: vi.fn(),
}));

vi.mock("../src/main/gateway-managed-config", () => ({
  prepareGatewayManagedConfiguration: prepareGatewayManagedConfigurationSpy,
}));

vi.mock("../src/main/gateway-ports", () => ({
  getProfilePort: vi.fn(() => 8642),
  isLoopbackPortReleased: vi.fn(async () => true),
}));

vi.mock("../src/main/ssh-tunnel", () => ({
  getSshTunnelUrl: () => null,
  isSshTunnelActive: () => false,
  isSshTunnelHealthy: () => Promise.resolve(false),
  startSshTunnel: () => Promise.resolve(),
}));

vi.mock("../src/main/utils", () => ({
  stripAnsi: (s: string) => s,
  pidIsAliveAs: (pid: number) => {
    pidAliveProbeRef.onProbe?.(pid);
    if (aliveGatewayPids.has(pid)) {
      if (!realGatewayPids.has(pid)) return true;
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        aliveGatewayPids.delete(pid);
        return false;
      }
    }
    // Real child processes used by the fixture are still deterministic: the
    // identity/image seam above, rather than host `ps`, supplies evidence.
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  },
  getActiveProfileNameSync: () => "default",
  normalizeProfileName: (profile?: string) =>
    !profile || profile === "default" ? undefined : profile,
  profileHome: (profile?: string) =>
    profile ? join(TEST_HOME, "profiles", profile) : TEST_HOME,
  profilePaths: (profile?: string) => {
    const home = profile ? join(TEST_HOME, "profiles", profile) : TEST_HOME;
    return {
      home,
      configFile: join(home, "config.yaml"),
      envFile: join(home, ".env"),
      authFile: join(home, "auth.json"),
    };
  },
}));

vi.mock("../src/main/models", () => ({
  readModels: () => [],
}));

vi.mock("../src/main/process-options", () => ({
  HIDDEN_SUBPROCESS_OPTIONS: {},
}));

vi.mock("../src/main/process-identity", () => ({
  normalizeProcessImage: (value: unknown) =>
    typeof value === "string" && value.trim()
      ? value.trim().replaceAll("\\", "/").split("/").at(-1)!.toLowerCase()
      : null,
  // The mocked Runtime invocation launches Node snippets as a stand-in for
  // Python. Treat that deterministic fixture image as the Runtime image;
  // image-mismatch cases can override `processEvidenceRef.byPid` below.
  processImageMatchesExecutable: (observed: string, _expected: string) =>
    /^python(?:w|\d(?:\.\d+)?)?$/i.test(observed),
  processEvidenceMatches: (
    actual: { identity: string; image: string } | null,
    expected: { identity: string; image: string } | null,
  ) =>
    actual?.identity === expected?.identity && actual?.image === expected?.image,
  readProcessIdentityEvidence: (pid: number) =>
    processEvidenceRef.byPid.get(pid) ?? {
      identity: `test-created-${pid}`,
      image: "python3",
    },
}));

vi.mock("http", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require("events");
  const request = vi.fn(
    (
      _url: string,
      _options: Record<string, unknown>,
      callback: (res: { statusCode: number; resume: () => void }) => void,
    ) => {
      healthRequests.push({
        headers: _options.headers as Record<string, string> | undefined,
        url: String(_url),
      });
      const req = new EventEmitter() as InstanceType<typeof EventEmitter> & {
        destroy: () => void;
        end: () => void;
      };
      req.destroy = vi.fn();
      req.end = (): void => {
        queueMicrotask(() => {
          const response = new EventEmitter() as InstanceType<
            typeof EventEmitter
          > & {
            statusCode: number;
            resume: () => void;
          };
          response.statusCode = healthStatuses.shift() ?? 503;
          response.resume = vi.fn();
          callback({
            statusCode: response.statusCode,
            resume: response.resume,
            on: response.on.bind(response),
          } as unknown as { statusCode: number; resume: () => void });
          queueMicrotask(() => response.emit("end"));
        });
      };
      return req;
    },
  );
  return { default: { request }, request };
});

import {
  configureGatewayManagedConfiguration,
  configureGatewayProcessOwnership,
  isGatewayHealthy,
  isGatewayRunning,
  recoverAeraOwnedGatewaysFromPreviousRun,
  restartGateway,
  restartGatewayViaCli,
  startGateway,
  startGatewayWithRecovery,
  stopAeraOwnedGateways,
  stopGateway,
  stopHealthPolling,
} from "../src/main/hermes";
import { GatewayProcessOwnershipLedger } from "../src/main/gateway-process-ownership";

const queuedRestartHealthTimeoutMs = process.platform === "win32" ? 1000 : 50;
const multiProfileShutdownTestTimeoutMs =
  process.platform === "win32" ? 15_000 : 5_000;

function profilePidFile(profile = "work"): string {
  return join(TEST_HOME, "profiles", profile, "gateway.pid");
}

async function waitForProcessExit(
  pid: number,
  timeoutMs = 1000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

async function waitForFile(
  filePath: string,
  timeoutMs = 1000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(filePath) && readFileSync(filePath).length > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

async function waitForPidFile(
  filePath: string,
  timeoutMs = 1000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) {
      const parsed = Number(readFileSync(filePath, "utf8").trim());
      if (Number.isInteger(parsed) && parsed > 0) return parsed;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("PID file did not contain a positive integer before timeout");
}

describe("restartGatewayViaCli", () => {
  beforeEach(() => {
    stopGateway(true);
    stopGateway("work", true);
    stopGateway("personal", true);
    stopHealthPolling();
    mkdirSync(TEST_HOME, { recursive: true });
    mkdirSync(join(TEST_HOME, "profiles", "work"), { recursive: true });
    mkdirSync(join(TEST_HOME, "profiles", "personal"), { recursive: true });
    mkdirSync(TEST_REPO, { recursive: true });
    configureGatewayProcessOwnership(TEST_HOME);
    connModeRef.mode = "local";
    healthStatuses.length = 0;
    healthRequests.length = 0;
    aliveGatewayPids.clear();
    realGatewayPids.clear();
    processEvidenceRef.byPid.clear();
    pidAliveProbeRef.onProbe = null;
    ensureLocalApiServerKeySpy.mockClear();
    prepareGatewayManagedConfigurationSpy.mockClear();
    configureGatewayManagedConfiguration({
      modelMutationPort: { mutate: vi.fn() },
    });
    hermesCliArgsSpy.mockReset();
    hermesCliArgsSpy.mockImplementation(() => ["-e", restartScript]);
  });

  afterEach(async () => {
    configureGatewayManagedConfiguration(null);
    await stopAeraOwnedGateways().catch(() => undefined);
    stopGateway(true);
    stopGateway("work", true);
    stopGateway("personal", true);
    stopHealthPolling();
    await new Promise((resolve) => setTimeout(resolve, 50));
    rmSync(TEST_HOME, { recursive: true, force: true });
    rmSync(TEST_REPO, { recursive: true, force: true });
  });

  it("uses the hermes gateway restart command with the profile env", async () => {
    healthStatuses.push(503, ...Array(20).fill(200));

    await expect(restartGatewayViaCli("work", 50, 1)).resolves.toBe(true);

    expect(hermesCliArgsSpy).toHaveBeenCalledWith([
      "--profile",
      "work",
      "gateway",
      "restart",
    ]);
    await vi.waitFor(() => {
      expect(
        JSON.parse(readFileSync(join(TEST_HOME, "restart-env.json"), "utf-8")),
      ).toEqual({
        api: "true",
        key: "work",
      });
    });
  });

  it("injects the prepared credential without writing from the spawn path", async () => {
    const authProofFile = join(TEST_HOME, "spawn-auth-proof.txt");
    hermesCliArgsSpy.mockImplementation(() => [
      "-e",
      `const fs=require("fs");fs.writeFileSync(${JSON.stringify(authProofFile)},"");setTimeout(()=>fs.writeFileSync(${JSON.stringify(authProofFile)},process.env.API_SERVER_KEY||""),50)`,
    ]);

    expect(startGateway("work")).toBe(true);
    expect(await waitForFile(authProofFile)).toBe(true);
    expect(readFileSync(authProofFile, "utf-8")).toBe(
      "unit-test-internal-token",
    );
    expect(ensureLocalApiServerKeySpy).not.toHaveBeenCalled();
  });

  it("spawns with the exact credential and port returned by managed preparation", async () => {
    const launchProofFile = join(TEST_HOME, "prepared-launch-proof.json");
    prepareGatewayManagedConfigurationSpy.mockResolvedValueOnce({
      key: "prepared-launch-key",
      port: 9123,
    });
    hermesCliArgsSpy.mockImplementation(() => [
      "-e",
      `const fs=require("fs"),path=require("path");fs.writeFileSync(${JSON.stringify(launchProofFile)},JSON.stringify({key:process.env.API_SERVER_KEY,port:process.env.API_SERVER_PORT}));fs.mkdirSync(path.join(process.env.HERMES_HOME,"profiles","work"),{recursive:true});fs.writeFileSync(path.join(process.env.HERMES_HOME,"profiles","work","gateway.pid"),String(process.pid));setInterval(()=>{},1000)`,
    ]);
    healthStatuses.push(200);

    await expect(startGatewayWithRecovery("work", 1000, 25)).resolves.toBe(
      true,
    );
    expect(await waitForFile(launchProofFile)).toBe(true);
    expect(JSON.parse(readFileSync(launchProofFile, "utf8"))).toEqual({
      key: "prepared-launch-key",
      port: "9123",
    });
  });

  it("restarts with the exact credential and port returned by managed preparation", async () => {
    const restartProofFile = join(TEST_HOME, "prepared-restart-proof.json");
    prepareGatewayManagedConfigurationSpy.mockResolvedValueOnce({
      key: "prepared-restart-key",
      port: 9124,
    });
    hermesCliArgsSpy.mockImplementation(() => [
      "-e",
      `const fs=require("fs"),path=require("path");fs.writeFileSync(${JSON.stringify(restartProofFile)},JSON.stringify({key:process.env.API_SERVER_KEY,port:process.env.API_SERVER_PORT}));fs.mkdirSync(path.join(process.env.HERMES_HOME,"profiles","work"),{recursive:true});fs.writeFileSync(path.join(process.env.HERMES_HOME,"profiles","work","gateway.pid"),String(process.pid));setInterval(()=>{},1000)`,
    ]);
    healthStatuses.push(503, 200);

    await expect(restartGatewayViaCli("work", 1000, 25)).resolves.toBe(true);
    expect(await waitForFile(restartProofFile)).toBe(true);
    expect(JSON.parse(readFileSync(restartProofFile, "utf8"))).toEqual({
      key: "prepared-restart-key",
      port: "9124",
    });
  });

  it("clears the durable launch intent when spawn setup fails", () => {
    hermesCliArgsSpy.mockImplementation(() => {
      throw new Error("injected spawn setup failure");
    });

    expect(startGateway("work")).toBe(false);
    expect(
      JSON.parse(
        readFileSync(join(TEST_HOME, "gateway-process-ownership.json"), "utf8"),
      ).entries,
    ).toEqual([]);
  });

  it("clears ownership when the spawned gateway exits before writing its PID", async () => {
    hermesCliArgsSpy.mockImplementation(() => ["-e", "process.exit(1)"]);

    expect(startGateway("work")).toBe(true);
    await vi.waitFor(() => {
      expect(
        JSON.parse(
          readFileSync(
            join(TEST_HOME, "gateway-process-ownership.json"),
            "utf8",
          ),
        ).entries,
      ).toEqual([]);
    });
  });

  it(
    "persists launch ownership and stops every Aera-started Profile",
    async () => {
      hermesCliArgsSpy.mockImplementation((args: string[]) => {
        const profile = args[0] === "--profile" ? args[1] : "default";
        const pidFile =
          profile === "default"
            ? join(TEST_HOME, "gateway.pid")
            : profilePidFile(profile);
        const writeDelayMs = profile === "work" ? 250 : 0;
        return [
          "-e",
          `setTimeout(() => require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)), ${writeDelayMs});setInterval(() => {}, 1000)`,
        ];
      });

      writeFileSync(profilePidFile("work"), "", "utf8");
      expect(startGateway()).toBe(true);
      expect(startGateway("work")).toBe(true);
      const defaultPid = await waitForPidFile(join(TEST_HOME, "gateway.pid"));
      const workPid = await waitForPidFile(profilePidFile("work"));
      expect(
        JSON.parse(
          readFileSync(
            join(TEST_HOME, "gateway-process-ownership.json"),
            "utf8",
          ),
        ).entries,
      ).toEqual([
        expect.objectContaining({
          profileId: "default",
          spawnedPid: defaultPid,
        }),
        expect.objectContaining({ profileId: "work", spawnedPid: workPid }),
      ]);

      await stopAeraOwnedGateways();

      expect(await waitForProcessExit(defaultPid, 3000)).toBe(true);
      expect(await waitForProcessExit(workPid, 3000)).toBe(true);
    },
    multiProfileShutdownTestTimeoutMs,
  );

  it("does not kill a changed PID that replaced an Aera-started Profile", async () => {
    hermesCliArgsSpy.mockImplementation(() => [
      "-e",
      `require("fs").writeFileSync(${JSON.stringify(profilePidFile("work"))}, String(process.pid));setInterval(() => {}, 1000)`,
    ]);
    expect(startGateway("work")).toBe(true);
    expect(await waitForFile(profilePidFile("work"))).toBe(true);
    const aeraPid = Number(readFileSync(profilePidFile("work"), "utf8"));
    const external = spawnChild(process.execPath, [
      "-e",
      "setInterval(() => {}, 1000)",
    ]);
    const externalPid = external.pid as number;
    writeFileSync(profilePidFile("work"), String(externalPid), "utf8");
    aliveGatewayPids.add(externalPid);

    try {
      await stopAeraOwnedGateways();

      expect(await waitForProcessExit(aeraPid, 3000)).toBe(true);
      expect(() => process.kill(externalPid, 0)).not.toThrow();
      expect(
        JSON.parse(
          readFileSync(
            join(TEST_HOME, "gateway-process-ownership.json"),
            "utf8",
          ),
        ).entries,
      ).toEqual([expect.objectContaining({ profileId: "work" })]);
    } finally {
      external.kill("SIGTERM");
      await waitForProcessExit(externalPid, 3000);
    }
  });

  it("does not let forced restart cleanup signal a replacement Profile PID", async () => {
    hermesCliArgsSpy.mockImplementation(() => [
      "-e",
      `require("fs").writeFileSync(${JSON.stringify(profilePidFile("work"))}, String(process.pid));setInterval(() => {}, 1000)`,
    ]);
    expect(startGateway("work")).toBe(true);
    expect(await waitForFile(profilePidFile("work"))).toBe(true);
    const aeraPid = Number(readFileSync(profilePidFile("work"), "utf8"));
    const replacement = spawnChild(process.execPath, [
      "-e",
      "setInterval(() => {}, 1000)",
    ]);
    const replacementPid = replacement.pid as number;
    writeFileSync(profilePidFile("work"), String(replacementPid), "utf8");
    aliveGatewayPids.add(replacementPid);

    try {
      stopGateway("work", true);

      expect(await waitForProcessExit(aeraPid, 3000)).toBe(true);
      expect(await waitForProcessExit(replacementPid, 200)).toBe(false);
    } finally {
      replacement.kill("SIGTERM");
      await waitForProcessExit(replacementPid, 3000);
    }
  });

  it("retains durable ownership until a SIGTERM-ignoring gateway is confirmed stopped", async () => {
    const readyFile = join(TEST_HOME, "work-ignore-sigterm-ready");
    hermesCliArgsSpy.mockImplementation(() => [
      "-e",
      `process.on("SIGTERM",()=>{});require("fs").writeFileSync(${JSON.stringify(profilePidFile("work"))},String(process.pid));require("fs").writeFileSync(${JSON.stringify(readyFile)},"ready");setInterval(()=>{},1000)`,
    ]);
    expect(startGateway("work")).toBe(true);
    expect(await waitForFile(readyFile)).toBe(true);
    const spawnedPid = Number(readFileSync(profilePidFile("work"), "utf8"));
    aliveGatewayPids.add(spawnedPid);
    realGatewayPids.add(spawnedPid);
    const originalChildKill = ChildProcess.prototype.kill;
    const childKillSpy = vi
      .spyOn(ChildProcess.prototype, "kill")
      .mockImplementation(function (
        this: ChildProcess,
        signal?: number | NodeJS.Signals,
      ): boolean {
        if (this.pid === spawnedPid && signal === "SIGTERM") return true;
        return originalChildKill.call(this, signal);
      });
    const originalKill = process.kill.bind(process);
    let forceAttempts = 0;
    const killSpy = vi
      .spyOn(process, "kill")
      .mockImplementation((pid, signal) => {
        if (pid === spawnedPid && signal === "SIGTERM") return true;
        if (pid === spawnedPid && signal === "SIGKILL") {
          forceAttempts += 1;
          if (forceAttempts === 1) {
            const error = new Error("injected transient force failure");
            Object.assign(error, { code: "EPERM" });
            throw error;
          }
        }
        return originalKill(pid, signal);
      });

    try {
      stopGateway("work", true);

      expect(() => process.kill(spawnedPid, 0)).not.toThrow();
      expect(
        JSON.parse(
          readFileSync(
            join(TEST_HOME, "gateway-process-ownership.json"),
            "utf8",
          ),
        ).entries,
      ).toEqual([expect.objectContaining({ profileId: "work", spawnedPid })]);
      expect(await waitForProcessExit(spawnedPid, 4000)).toBe(true);
      await vi.waitFor(() => {
        expect(
          JSON.parse(
            readFileSync(
              join(TEST_HOME, "gateway-process-ownership.json"),
              "utf8",
            ),
          ).entries,
        ).toEqual([]);
      });
      expect(forceAttempts).toBeGreaterThanOrEqual(2);
    } finally {
      childKillSpy.mockRestore();
      killSpy.mockRestore();
      try {
        process.kill(spawnedPid, "SIGKILL");
      } catch {
        // already stopped
      }
      await waitForProcessExit(spawnedPid, 3000);
    }
  });

  it("terminates and then clears a prior recorded gateway after cold recovery", async () => {
    hermesCliArgsSpy.mockImplementation(() => [
      "-e",
      `require("fs").writeFileSync(${JSON.stringify(profilePidFile("work"))}, String(process.pid));setInterval(() => {}, 1000)`,
    ]);
    expect(startGateway("work")).toBe(true);
    expect(await waitForFile(profilePidFile("work"))).toBe(true);
    const spawnedPid = Number(readFileSync(profilePidFile("work"), "utf8"));
    aliveGatewayPids.add(spawnedPid);
    realGatewayPids.add(spawnedPid);

    configureGatewayProcessOwnership(TEST_HOME);
    // Windows terminates a Node child synchronously for SIGTERM, so cold
    // recovery can finish and clear the durable record in the same call. POSIX
    // keeps the target alive until the bounded termination timer observes the
    // exit; both outcomes are safe, but only the latter remains ambiguous at
    // this API boundary.
    expect(recoverAeraOwnedGatewaysFromPreviousRun()).toEqual({
      reapedProfiles: [],
      ambiguousProfiles: process.platform === "win32" ? [] : ["work"],
    });

    expect(await waitForProcessExit(spawnedPid, 3000)).toBe(true);
    await vi.waitFor(() => {
      expect(
        JSON.parse(
          readFileSync(
            join(TEST_HOME, "gateway-process-ownership.json"),
            "utf8",
          ),
        ).entries,
      ).toEqual([]);
    });
  });

  it("keeps cold-recovery ownership until the recorded process actually exits", async () => {
    const readyFile = join(TEST_HOME, "cold-ignore-sigterm-ready");
    hermesCliArgsSpy.mockImplementation(() => [
      "-e",
      `process.on("SIGTERM",()=>{});require("fs").writeFileSync(${JSON.stringify(profilePidFile("work"))},String(process.pid));require("fs").writeFileSync(${JSON.stringify(readyFile)},"ready");setInterval(()=>{},1000)`,
    ]);
    expect(startGateway("work")).toBe(true);
    expect(await waitForFile(readyFile)).toBe(true);
    const spawnedPid = Number(readFileSync(profilePidFile("work"), "utf8"));
    aliveGatewayPids.add(spawnedPid);
    realGatewayPids.add(spawnedPid);
    configureGatewayProcessOwnership(TEST_HOME);
    const originalKill = process.kill.bind(process);
    let ignoredSigterm = false;
    const killSpy = vi
      .spyOn(process, "kill")
      .mockImplementation((pid, signal) => {
        if (pid === spawnedPid && signal === "SIGTERM") {
          ignoredSigterm = true;
          return true;
        }
        return originalKill(pid, signal);
      });

    try {
      expect(recoverAeraOwnedGatewaysFromPreviousRun()).toEqual({
        reapedProfiles: [],
        ambiguousProfiles: ["work"],
      });
      expect(() => process.kill(spawnedPid, 0)).not.toThrow();
      expect(
        JSON.parse(
          readFileSync(
            join(TEST_HOME, "gateway-process-ownership.json"),
            "utf8",
          ),
        ).entries,
      ).toEqual([expect.objectContaining({ profileId: "work", spawnedPid })]);
      expect(ignoredSigterm).toBe(true);
      expect(await waitForProcessExit(spawnedPid, 4000)).toBe(true);
      await vi.waitFor(() => {
        expect(
          JSON.parse(
            readFileSync(
              join(TEST_HOME, "gateway-process-ownership.json"),
              "utf8",
            ),
          ).entries,
        ).toEqual([]);
      });
    } finally {
      killSpy.mockRestore();
      try {
        process.kill(spawnedPid, "SIGKILL");
      } catch {
        // already stopped
      }
      await waitForProcessExit(spawnedPid, 3000);
    }
  });

  it("reports corrupt ownership state with a stable error code", () => {
    writeFileSync(
      join(TEST_HOME, "gateway-process-ownership.json"),
      "{not valid json",
      "utf8",
    );
    configureGatewayProcessOwnership(TEST_HOME);

    expect(recoverAeraOwnedGatewaysFromPreviousRun()).toEqual({
      reapedProfiles: [],
      ambiguousProfiles: [],
      errorCode: "invalid_ownership",
    });
  });

  it("keeps startup alive when ownership reconciliation cannot persist", () => {
    const previous = new GatewayProcessOwnershipLedger({
      userDataPath: TEST_HOME,
      desktopPid: 9001,
    });
    const intent = previous.beginLaunch({
      profileId: "work",
      preLaunchPid: null,
    });
    previous.markSpawned({
      profileId: "work",
      launchId: intent.launchId,
      spawnedPid: 987654,
    });
    configureGatewayProcessOwnership(TEST_HOME);
    mkdirSync(join(TEST_HOME, "gateway-process-ownership.pending.json"));

    expect(recoverAeraOwnedGatewaysFromPreviousRun()).toEqual({
      reapedProfiles: [],
      ambiguousProfiles: ["work"],
      errorCode: "ownership_persistence_failed",
    });
  });

  it("does not signal any process when the Profile PID changes during cold recovery", async () => {
    const recorded = spawnChild(process.execPath, [
      "-e",
      "setInterval(() => {}, 1000)",
    ]);
    const replacement = spawnChild(process.execPath, [
      "-e",
      "setInterval(() => {}, 1000)",
    ]);
    const recordedPid = recorded.pid as number;
    const replacementPid = replacement.pid as number;
    writeFileSync(profilePidFile("work"), String(recordedPid), "utf8");
    aliveGatewayPids.add(recordedPid);
    aliveGatewayPids.add(replacementPid);

    const previous = new GatewayProcessOwnershipLedger({
      userDataPath: TEST_HOME,
      desktopPid: 9001,
    });
    const intent = previous.beginLaunch({
      profileId: "work",
      preLaunchPid: null,
    });
    previous.markSpawned({
      profileId: "work",
      launchId: intent.launchId,
      spawnedPid: recordedPid,
    });
    configureGatewayProcessOwnership(TEST_HOME);
    let swapped = false;
    pidAliveProbeRef.onProbe = (pid) => {
      if (!swapped && pid === recordedPid) {
        swapped = true;
        writeFileSync(profilePidFile("work"), String(replacementPid), "utf8");
      }
    };

    try {
      expect(recoverAeraOwnedGatewaysFromPreviousRun()).toEqual({
        reapedProfiles: [],
        ambiguousProfiles: ["work"],
      });
      expect(await waitForProcessExit(recordedPid, 200)).toBe(false);
      expect(await waitForProcessExit(replacementPid, 200)).toBe(false);
    } finally {
      pidAliveProbeRef.onProbe = null;
      recorded.kill("SIGTERM");
      replacement.kill("SIGTERM");
      await waitForProcessExit(recordedPid, 3000);
      await waitForProcessExit(replacementPid, 3000);
    }
  });

  it("never stops an unrecorded pre-existing gateway during recovery", async () => {
    const external = spawnChild(process.execPath, [
      "-e",
      "setInterval(() => {}, 1000)",
    ]);
    const externalPid = external.pid;
    expect(externalPid).toBeTypeOf("number");
    writeFileSync(profilePidFile("personal"), String(externalPid), "utf8");
    aliveGatewayPids.add(externalPid as number);

    try {
      expect(recoverAeraOwnedGatewaysFromPreviousRun()).toEqual({
        reapedProfiles: [],
        ambiguousProfiles: [],
      });
      expect(() => process.kill(externalPid as number, 0)).not.toThrow();
    } finally {
      external.kill("SIGTERM");
      await waitForProcessExit(externalPid as number, 3000);
    }
  });

  // @lat: [[lat.md/agentera-app-authentication#AgentEra application authentication#Sessions and offline use#Runtime edge enforcement#Legacy Gateway takeover]]
  it("restarts a healthy unrecorded legacy gateway before Aera uses it", async () => {
    const legacy = spawnChild(process.execPath, [
      "-e",
      "setInterval(() => {}, 1000)",
    ]);
    const legacyPid = legacy.pid as number;
    expect(legacyPid).toBeTypeOf("number");
    writeFileSync(profilePidFile("work"), String(legacyPid), "utf8");
    aliveGatewayPids.add(legacyPid);
    realGatewayPids.add(legacyPid);

    hermesCliArgsSpy.mockImplementation(() => [
      "-e",
      `require("fs").writeFileSync(${JSON.stringify(profilePidFile("work"))},String(process.pid));setInterval(()=>{},1000)`,
    ]);
    healthStatuses.push(200, 503, 200);

    let replacementPid: number | null = null;
    try {
      await expect(
        startGatewayWithRecovery("work", 1000, 25, 15000, 1000, 1000),
      ).resolves.toBe(true);

      expect(await waitForProcessExit(legacyPid, 3000)).toBe(true);
      replacementPid = await waitForPidFile(profilePidFile("work"));
      expect(replacementPid).not.toBe(legacyPid);
      expect(
        JSON.parse(
          readFileSync(
            join(TEST_HOME, "gateway-process-ownership.json"),
            "utf8",
          ),
        ).entries,
      ).toEqual([
        expect.objectContaining({
          profileId: "work",
          preLaunchPid: null,
          spawnedPid: replacementPid,
        }),
      ]);

      await stopAeraOwnedGateways();
      expect(await waitForProcessExit(replacementPid, 3000)).toBe(true);
    } finally {
      legacy.kill("SIGTERM");
      if (replacementPid !== null) {
        try {
          process.kill(replacementPid, "SIGTERM");
        } catch {
          // already stopped
        }
      }
      await waitForProcessExit(legacyPid, 3000);
    }
  });

  // @lat: [[lat.md/agentera-app-authentication#AgentEra application authentication#Sessions and offline use#Runtime edge enforcement#Invalid ownership blocks takeover]]
  it("does not restart an unrecorded gateway when ownership state is corrupt", async () => {
    const external = spawnChild(process.execPath, [
      "-e",
      "setInterval(() => {}, 1000)",
    ]);
    const externalPid = external.pid as number;
    expect(externalPid).toBeTypeOf("number");
    writeFileSync(profilePidFile("work"), String(externalPid), "utf8");
    aliveGatewayPids.add(externalPid);
    realGatewayPids.add(externalPid);
    writeFileSync(
      join(TEST_HOME, "gateway-process-ownership.json"),
      "{not valid json",
      "utf8",
    );
    configureGatewayProcessOwnership(TEST_HOME);
    healthStatuses.push(200);

    try {
      await expect(startGatewayWithRecovery("work", 1000, 25)).resolves.toBe(
        false,
      );
      expect(hermesCliArgsSpy).not.toHaveBeenCalled();
      expect(() => process.kill(externalPid, 0)).not.toThrow();
    } finally {
      external.kill("SIGTERM");
      await waitForProcessExit(externalPid, 3000);
    }
  });

  it("configures cold recovery before IPC and stops all owned gateways on context teardown", () => {
    const start = readFileSync(
      join(__dirname, "../src/main/app/start.ts"),
      "utf8",
    );
    const configure = start.indexOf("configureGatewayProcessOwnership(");
    const recover = start.indexOf("recoverAeraOwnedGatewaysFromPreviousRun()");
    const register = start.indexOf("registerIpcHandlers({");
    expect(configure).toBeGreaterThan(-1);
    expect(recover).toBeGreaterThan(configure);
    expect(register).toBeGreaterThan(recover);

    const teardownStart = start.indexOf(
      "export async function stopActiveRuntimeContext",
    );
    expect(teardownStart).toBeGreaterThan(-1);
    const teardown = start.slice(
      teardownStart,
      start.indexOf("function notifyConnectionConfigChanged"),
    );
    expect(teardown).toContain("await settleRuntimeCleanup([");
    expect(teardown).toContain("return stopAeraOwnedGateways().then(");
    expect(teardown).not.toContain("stopGateway(undefined, true)");
  });

  it("completes model-configuration recovery before coordinated IPC registration", () => {
    const start = readFileSync(
      join(__dirname, "../src/main/app/start.ts"),
      "utf8",
    );
    const recovery = start.indexOf("await prepareModelConfigurationAfterAuth(");
    const register = start.indexOf("registerIpcHandlers({");
    expect(recovery).toBeGreaterThan(-1);
    expect(register).toBeGreaterThan(recovery);
  });

  it("uses a bearer-authenticated endpoint for local gateway readiness", async () => {
    healthStatuses.push(200);

    await expect(isGatewayHealthy("work")).resolves.toBe(true);

    expect(healthRequests.at(-1)).toEqual({
      headers: {
        Authorization: "Bearer unit-test-internal-token",
        Connection: "close",
      },
      url: expect.stringMatching(/\/v1\/capabilities$/),
    });
  });

  it("treats a long-running restart process as success once health is ready", async () => {
    const pidFile = join(TEST_HOME, "long-running-restart.pid");
    const longRunningRestartScript =
      "const fs=require('fs'),path=require('path');" +
      `fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));` +
      `fs.mkdirSync(path.join(process.env.HERMES_HOME,'profiles','work'),{recursive:true});` +
      `fs.writeFileSync(path.join(process.env.HERMES_HOME,'profiles','work','gateway.pid'),String(process.pid));` +
      "setInterval(() => {}, 1000);";

    hermesCliArgsSpy.mockImplementation(() => ["-e", longRunningRestartScript]);
    healthStatuses.push(200, 503, 200);

    await expect(restartGatewayViaCli("work", 50, 1)).resolves.toBe(true);

    const ownership = JSON.parse(
      readFileSync(
        join(TEST_HOME, "gateway-process-ownership.json"),
        "utf8",
      ),
    ).entries;
    expect(ownership).toEqual([
      expect.objectContaining({
        profileId: "work",
        spawnedIdentity: expect.any(String),
        spawnedImage: "python3",
        listenerPid: expect.any(Number),
        listenerIdentity: expect.any(String),
        listenerImage: "python3",
      }),
    ]);

    expect(isGatewayRunning("work")).toBe(true);
    expect(hermesCliArgsSpy).toHaveBeenCalledWith([
      "--profile",
      "work",
      "gateway",
      "restart",
    ]);

    expect(await waitForFile(pidFile)).toBe(true);
    const spawnedPid = Number(readFileSync(pidFile, "utf-8"));
    stopGateway("work", true);
    expect(await waitForProcessExit(spawnedPid, 3000)).toBe(true);
  });

  it("times out and stops a long-running restart process when health stays down", async () => {
    const pidFile = join(TEST_HOME, "unhealthy-restart.pid");
    const unhealthyRestartScript =
      "const fs=require('fs'),path=require('path');" +
      `fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));` +
      `fs.mkdirSync(path.join(process.env.HERMES_HOME,'profiles','work'),{recursive:true});` +
      `fs.writeFileSync(path.join(process.env.HERMES_HOME,'profiles','work','gateway.pid'),String(process.pid));` +
      "setInterval(() => {}, 1000);";

    hermesCliArgsSpy.mockImplementation(() => ["-e", unhealthyRestartScript]);

    const restart = restartGatewayViaCli("work", 500, 10);
    expect(await waitForFile(pidFile)).toBe(true);
    await expect(restart).resolves.toBe(false);

    const spawnedPid = Number(readFileSync(pidFile, "utf-8"));
    expect(await waitForProcessExit(spawnedPid, 3000)).toBe(true);
    expect(hermesCliArgsSpy).toHaveBeenCalledWith([
      "--profile",
      "work",
      "gateway",
      "restart",
    ]);
  });

  it("does not report success when the restart command exits but health stays down", async () => {
    await expect(restartGatewayViaCli("work", 5, 1)).resolves.toBe(false);

    expect(hermesCliArgsSpy).toHaveBeenCalledWith([
      "--profile",
      "work",
      "gateway",
      "restart",
    ]);
  });

  it("resolves false instead of rejecting when restart setup throws", async () => {
    hermesCliArgsSpy.mockImplementation(() => {
      throw new Error("boom");
    });

    await expect(restartGatewayViaCli("work", 5, 1)).resolves.toBe(false);
  });

  it("treats a throwing health probe as unhealthy", async () => {
    connModeRef.mode = "ssh";

    await expect(isGatewayHealthy()).resolves.toBe(false);
  });

  it("deduplicates concurrent restart requests", async () => {
    healthStatuses.push(503, 200, 503, 503, 503, 200, 200, 200);

    const first = restartGatewayViaCli("work", 1000, 1);
    const second = restartGatewayViaCli("work", 1000, 1);

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(hermesCliArgsSpy).toHaveBeenCalledTimes(1);
  });

  it("uses the native restart path only after the old gateway stops", async () => {
    hermesCliArgsSpy.mockImplementation(() => ["-e", restartScript]);
    healthStatuses.push(503, 200);

    await expect(restartGateway("work", 50, 1)).resolves.toBe(true);

    expect(hermesCliArgsSpy).toHaveBeenCalledTimes(1);
    expect(hermesCliArgsSpy).toHaveBeenCalledWith([
      "--profile",
      "work",
      "gateway",
    ]);
  });

  it("does not report native restart success when the old gateway never stops", async () => {
    const gatewayPid = 424242;
    aliveGatewayPids.add(gatewayPid);
    writeFileSync(profilePidFile(), String(gatewayPid), "utf-8");
    hermesCliArgsSpy.mockImplementation(() => ["-e", "process.exit(0)"]);

    healthStatuses.push(...Array(100).fill(200));

    await expect(restartGateway("work", 25, 1, 25)).resolves.toBe(false);

    expect(hermesCliArgsSpy).not.toHaveBeenCalled();
    expect(isGatewayRunning("work")).toBe(true);
    expect(readFileSync(profilePidFile(), "utf-8")).toBe(String(gatewayPid));
  });

  it("serializes restart requests for different profiles instead of reusing the first result", async () => {
    const first = restartGatewayViaCli("work", 5, 1);
    const second = restartGatewayViaCli("personal", 5, 1);

    await expect(Promise.all([first, second])).resolves.toEqual([false, false]);
    expect(hermesCliArgsSpy).toHaveBeenCalledTimes(2);
  });

  it("deduplicates queued restarts for the same profile", async () => {
    hermesCliArgsSpy
      .mockImplementationOnce(() => {
        throw new Error("first failed");
      })
      .mockImplementation(() => ["-e", restartScript]);
    healthStatuses.push(503, 200, 503, 503, 503, 200, 200, 200);

    const first = restartGatewayViaCli("work", queuedRestartHealthTimeoutMs, 1);
    const second = restartGatewayViaCli(
      "personal",
      queuedRestartHealthTimeoutMs,
      1,
    );
    const third = restartGatewayViaCli(
      "personal",
      queuedRestartHealthTimeoutMs,
      1,
    );

    await expect(Promise.all([first, second, third])).resolves.toEqual([
      false,
      true,
      true,
    ]);
    expect(hermesCliArgsSpy).toHaveBeenCalledTimes(2);
  });

  it("still runs a queued different-profile restart after the in-flight restart setup fails", async () => {
    hermesCliArgsSpy
      .mockImplementationOnce(() => {
        throw new Error("first failed");
      })
      .mockImplementation(() => ["-e", restartScript]);
    healthStatuses.push(503, 200, 503, 503, 503, 200, 200, 200);

    const first = restartGatewayViaCli("work", 5, 1);
    const second = restartGatewayViaCli(
      "personal",
      1000,
      1,
    );

    await expect(Promise.all([first, second])).resolves.toEqual([false, true]);
    expect(hermesCliArgsSpy).toHaveBeenCalledTimes(2);
  });

  it("keeps an existing tracked gateway when CLI restart setup fails", async () => {
    const pidFile = join(TEST_HOME, "tracked-gateway.pid");
    const startScript =
      "const fs=require('fs');" +
      `fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));` +
      "setInterval(() => {}, 1000);";

    hermesCliArgsSpy
      .mockImplementationOnce(() => ["-e", startScript])
      .mockImplementationOnce(() => {
        throw new Error("restart unavailable");
      });

    expect(startGateway("work")).toBe(true);
    expect(isGatewayRunning("work")).toBe(true);
    expect(await waitForFile(pidFile)).toBe(true);

    await expect(restartGatewayViaCli("work", 5, 1)).resolves.toBe(false);

    expect(isGatewayRunning("work")).toBe(true);
    stopGateway("work", true);
    stopGateway("work", true);

    const spawnedPid = Number(readFileSync(pidFile, "utf-8"));
    expect(await waitForProcessExit(spawnedPid, 3000)).toBe(true);
    expect(hermesCliArgsSpy).toHaveBeenNthCalledWith(1, [
      "--profile",
      "work",
      "gateway",
    ]);
    expect(hermesCliArgsSpy).toHaveBeenNthCalledWith(2, [
      "--profile",
      "work",
      "gateway",
      "restart",
    ]);
  });

  it("does not restore a tracked gateway that exited during a failed CLI restart", async () => {
    const pidFile = join(TEST_HOME, "tracked-gateway-exit.pid");
    const startScript =
      "const fs=require('fs');" +
      `fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));` +
      "setInterval(() => {}, 1000);";
    const restartScript =
      "const fs=require('fs');" +
      `const pid=Number(fs.readFileSync(${JSON.stringify(pidFile)},'utf-8'));` +
      "try{process.kill(pid,'SIGTERM')}catch{};" +
      "const done=Date.now()+1000;" +
      "function wait(){try{process.kill(pid,0);if(Date.now()<done)return setTimeout(wait,25)}catch{};process.exit(1)};" +
      "wait();";

    hermesCliArgsSpy
      .mockImplementationOnce(() => ["-e", startScript])
      .mockImplementationOnce(() => ["-e", restartScript]);

    expect(startGateway("work")).toBe(true);
    expect(await waitForFile(pidFile)).toBe(true);

    const spawnedPid = Number(readFileSync(pidFile, "utf-8"));
    await expect(restartGatewayViaCli("work", 2000, 25)).resolves.toBe(false);

    expect(await waitForProcessExit(spawnedPid, 3000)).toBe(true);
    expect(isGatewayRunning("work")).toBe(false);
    expect(hermesCliArgsSpy).toHaveBeenNthCalledWith(1, [
      "--profile",
      "work",
      "gateway",
    ]);
    expect(hermesCliArgsSpy).toHaveBeenNthCalledWith(2, [
      "--profile",
      "work",
      "gateway",
      "restart",
    ]);
  });

  it("falls back to a native restart when a normal start does not become healthy", async () => {
    hermesCliArgsSpy.mockImplementation(() => ["-e", restartScript]);
    healthStatuses.push(503, 503, 200);

    await expect(
      // This assertion covers the recovery transition, not host scheduler
      // latency. Give the real child-process fixture enough time to publish
      // gateway.pid when the full Vitest suite is running concurrently.
      startGatewayWithRecovery("work", 5, 50, 15000, 2000),
    ).resolves.toBe(true);

    expect(hermesCliArgsSpy).toHaveBeenNthCalledWith(1, [
      "--profile",
      "work",
      "gateway",
    ]);
    expect(hermesCliArgsSpy).toHaveBeenNthCalledWith(2, [
      "--profile",
      "work",
      "gateway",
    ]);
  });

  it("preserves the tracked PID entry when recovery cannot stop the gateway", async () => {
    const gatewayPid = 2147483647;
    aliveGatewayPids.add(gatewayPid);
    writeFileSync(profilePidFile(), String(gatewayPid), "utf-8");
    healthStatuses.push(...Array(100).fill(200));

    await expect(
      startGatewayWithRecovery("work", 50, 75, 15000, 25, 25),
    ).resolves.toBe(false);

    expect(isGatewayRunning("work")).toBe(true);
    expect(readFileSync(profilePidFile(), "utf-8")).toBe(String(gatewayPid));
    expect(hermesCliArgsSpy).not.toHaveBeenCalled();
  });

  it("stops a spawned gateway before native restart recovery", async () => {
    const pidFile = join(TEST_HOME, "spawned-gateway.pid");
    const startScript =
      "const fs=require('fs');" +
      `fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));` +
      "setInterval(() => {}, 1000);";

    hermesCliArgsSpy
      .mockImplementationOnce(() => ["-e", startScript])
      .mockImplementationOnce(() => {
        throw new Error("restart unavailable");
      });

    await expect(startGatewayWithRecovery("work", 1000, 25)).resolves.toBe(
      false,
    );

    const spawnedPid = Number(readFileSync(pidFile, "utf-8"));
    const exited = await waitForProcessExit(spawnedPid);
    if (!exited) {
      try {
        process.kill(spawnedPid, "SIGTERM");
      } catch {
        // already gone
      }
    }

    expect(exited).toBe(true);
    expect(hermesCliArgsSpy).toHaveBeenNthCalledWith(1, [
      "--profile",
      "work",
      "gateway",
    ]);
    expect(hermesCliArgsSpy).toHaveBeenNthCalledWith(2, [
      "--profile",
      "work",
      "gateway",
    ]);
  });
});
