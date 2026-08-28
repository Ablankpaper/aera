import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, expect, it } from "vitest";

import {
  RuntimeHealthError,
  type RuntimeHealthCommandLifecycleEvent,
  runIsolatedRuntimeHealthCheck,
} from "../src/main/agentera-runtime-distribution/health";
import {
  parseRuntimeManifest,
  type RuntimeManifest,
} from "../src/main/agentera-runtime-distribution/manifest";
import {
  createFixtureManifest,
  fixtureCanonicalBytes,
} from "./fixtures/runtime-distribution/fixture";

const roots: string[] = [];

afterEach(async () => {
  delete process.env.AGENTERA_E2E_DIAGNOSTICS;
  delete process.env.AGENTERA_E2E_IMPORTTIME;
  delete process.env.AGENTERA_E2E_RUNTIME_CONTRACT_DIAGNOSTIC_OUTPUT;
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function healthHarness(): Promise<{
  runtimeRoot: string;
  manifest: RuntimeManifest;
  output: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "aera-runtime-health-diagnostic-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime-root");
  await Promise.all([
    mkdir(join(runtimeRoot, "python", "bin"), { recursive: true }),
    mkdir(join(runtimeRoot, "runtime"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(runtimeRoot, "python", "bin", "python3"), "python"),
    writeFile(join(runtimeRoot, "runtime", "hermes"), "hermes"),
  ]);
  const output = join(root, "health-events.jsonl");
  await writeFile(output, "", { flag: "wx", mode: 0o600 });
  return {
    runtimeRoot,
    manifest: parseRuntimeManifest(
      fixtureCanonicalBytes(createFixtureManifest()),
    ),
    output,
  };
}

async function diagnosticEvents(
  output: string,
): Promise<Record<string, unknown>[]> {
  return (await readFile(output, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

it("records each packaged health probe and cleanup boundary only in diagnostic mode", async () => {
  const setup = await healthHarness();
  process.env.AGENTERA_E2E_DIAGNOSTICS = "1";
  process.env.AGENTERA_E2E_RUNTIME_CONTRACT_DIAGNOSTIC_OUTPUT = setup.output;

  await expect(
    runIsolatedRuntimeHealthCheck({
      runtimeRoot: setup.runtimeRoot,
      manifest: setup.manifest,
      runner: async () => ({ stdout: "0.20.0-agentera.5\n", stderr: "" }),
    }),
  ).resolves.toEqual({ probes: 3, versionOutput: "0.20.0-agentera.5" });

  const events = await diagnosticEvents(setup.output);
  expect(events.map((entry) => entry.event)).toEqual([
    "health-check-start",
    "health-sandbox-ready",
    "health-probe-start",
    "health-probe-complete",
    "health-probe-start",
    "health-probe-complete",
    "health-probe-start",
    "health-probe-complete",
    "health-sandbox-cleanup-start",
    "health-sandbox-cleanup-complete",
  ]);
  expect(
    events
      .filter((entry) => entry.event === "health-probe-start")
      .map((entry) => ({
        probe: entry.probe,
        name: entry.name,
        executable: entry.executable,
        timeoutMs: entry.timeoutMs,
      })),
  ).toEqual([
    { probe: 1, name: "version", executable: "python3", timeoutMs: 45_000 },
    {
      probe: 2,
      name: "serve-help",
      executable: "python3",
      timeoutMs: 45_000,
    },
    { probe: 3, name: "imports", executable: "python3", timeoutMs: 45_000 },
  ]);
});

it("captures the serve-help import waterfall only with explicit investigative opt-in", async () => {
  const setup = await healthHarness();
  process.env.AGENTERA_E2E_DIAGNOSTICS = "1";
  process.env.AGENTERA_E2E_IMPORTTIME = "1";
  process.env.AGENTERA_E2E_RUNTIME_CONTRACT_DIAGNOSTIC_OUTPUT = setup.output;
  const capturedArgs: string[][] = [];

  await runIsolatedRuntimeHealthCheck({
    runtimeRoot: setup.runtimeRoot,
    manifest: setup.manifest,
    runner: async (_executable, args) => {
      capturedArgs.push([...args]);
      return { stdout: "0.20.0-agentera.5\n", stderr: "" };
    },
  });

  expect(capturedArgs).toHaveLength(3);
  // The explicit investigative opt-in carries the import waterfall; the
  // other probes stay plain.
  expect(capturedArgs[1]).toEqual(expect.arrayContaining(["-X", "importtime"]));
  expect(capturedArgs[0]).not.toContain("-X");
  expect(capturedArgs[2]).not.toContain("-X");
});

it("keeps the gating serve-help command unchanged in diagnostic mode", async () => {
  const setup = await healthHarness();
  process.env.AGENTERA_E2E_DIAGNOSTICS = "1";
  process.env.AGENTERA_E2E_RUNTIME_CONTRACT_DIAGNOSTIC_OUTPUT = setup.output;
  const capturedArgs: string[][] = [];

  await runIsolatedRuntimeHealthCheck({
    runtimeRoot: setup.runtimeRoot,
    manifest: setup.manifest,
    runner: async (_executable, args) => {
      capturedArgs.push([...args]);
      return { stdout: "0.20.0-agentera.5\n", stderr: "" };
    },
  });

  expect(capturedArgs).toHaveLength(3);
  expect(capturedArgs[1]).not.toContain("-X");
  expect(capturedArgs[1]).not.toContain("importtime");
});

it("keeps the serve-help probe free of import tracing outside diagnostic mode", async () => {
  const setup = await healthHarness();
  const capturedArgs: string[][] = [];

  await runIsolatedRuntimeHealthCheck({
    runtimeRoot: setup.runtimeRoot,
    manifest: setup.manifest,
    runner: async (_executable, args) => {
      capturedArgs.push([...args]);
      return { stdout: "0.20.0-agentera.5\n", stderr: "" };
    },
  });

  expect(capturedArgs).toHaveLength(3);
  expect(capturedArgs[1]).not.toContain("-X");
  expect(capturedArgs[1]).not.toContain("importtime");
});

it("records a bounded redacted health failure without changing the public error", async () => {
  const setup = await healthHarness();
  process.env.AGENTERA_E2E_DIAGNOSTICS = "1";
  process.env.AGENTERA_E2E_RUNTIME_CONTRACT_DIAGNOSTIC_OUTPUT = setup.output;
  const privatePath = "C:\\Users\\alice\\private\\provider-key.txt";
  let probe = 0;

  const failure = new Error("health probe failed") as Error & {
    code: string;
    killed: boolean;
    signal: string;
    stdout: string;
    stderr: string;
  };
  failure.code = "ETIMEDOUT";
  failure.killed = true;
  failure.signal = "SIGTERM";
  failure.stdout = `loading ${privatePath} with sk-private-secret`;
  failure.stderr = [
    "Traceback (most recent call last):",
    `  File "${privatePath}", line 7, in <module>`,
    "Authorization: Bearer sk-private-secret",
    "ModuleNotFoundError: No module named 'tools.registry'",
  ].join("\n");

  await expect(
    runIsolatedRuntimeHealthCheck({
      runtimeRoot: setup.runtimeRoot,
      manifest: setup.manifest,
      runner: async () => {
        probe += 1;
        if (probe === 2) throw failure;
        return { stdout: "0.20.0-agentera.5\n", stderr: "" };
      },
    }),
  ).rejects.toBeInstanceOf(RuntimeHealthError);

  const serialized = await readFile(setup.output, "utf8");
  const failed = (await diagnosticEvents(setup.output)).find(
    (entry) => entry.event === "health-probe-failed",
  );
  expect(failed).toMatchObject({
    probe: 2,
    name: "serve-help",
    code: "ETIMEDOUT",
    killed: true,
    signal: "SIGTERM",
    timedOut: true,
    stderrClass: "module-not-found",
  });
  expect(typeof failed?.probeElapsedMs).toBe("number");
  expect(typeof failed?.stdoutTail).toBe("string");
  expect((failed?.stdoutTail as string).length).toBeLessThanOrEqual(512);
  expect(typeof failed?.stderrTail).toBe("string");
  expect((failed?.stderrTail as string).length).toBeLessThanOrEqual(512);
  expect(serialized).not.toContain(privatePath);
  expect(serialized).not.toContain("alice");
  expect(serialized).not.toContain("sk-private-secret");
  expect(serialized).not.toContain(setup.runtimeRoot);
});

// @lat: [[agentera-runtime-distribution#Release gate#Packaged live Runtime contract#Health child-process lifecycle evidence]]
it("records the child timeout, exit, stream close, and callback boundaries", async () => {
  const setup = await healthHarness();
  process.env.AGENTERA_E2E_DIAGNOSTICS = "1";
  process.env.AGENTERA_E2E_RUNTIME_CONTRACT_DIAGNOSTIC_OUTPUT = setup.output;

  const timeoutError = Object.assign(new Error("health probe timed out"), {
    code: "ETIMEDOUT",
    killed: true,
    signal: "SIGTERM",
    stdout: "",
    stderr: "",
  });
  let probe = 0;

  await expect(
    runIsolatedRuntimeHealthCheck({
      runtimeRoot: setup.runtimeRoot,
      manifest: setup.manifest,
      runner: async (_executable, _args, options) => {
        probe += 1;
        if (probe !== 2) {
          return { stdout: "0.20.0-agentera.5\n", stderr: "" };
        }
        const emit = (
          options as {
            onLifecycle?: (event: RuntimeHealthCommandLifecycleEvent) => void;
          }
        ).onLifecycle;
        emit?.({ type: "spawn", pid: 7002 });
        emit?.({ type: "timeout", pid: 7002, childAlive: true, killed: true });
        emit?.({ type: "exit", pid: 7002, code: null, signal: "SIGTERM" });
        emit?.({ type: "stderr-close", pid: 7002 });
        emit?.({ type: "close", pid: 7002, code: null, signal: "SIGTERM" });
        emit?.({
          type: "callback",
          pid: 7002,
          code: "ETIMEDOUT",
          signal: "SIGTERM",
          childAlive: false,
          childExited: true,
          childClosed: true,
          killed: true,
        });
        throw timeoutError;
      },
    }),
  ).rejects.toBeInstanceOf(RuntimeHealthError);

  const events = await diagnosticEvents(setup.output);
  const childEvents = events.filter((entry) =>
    String(entry.event).startsWith("health-probe-child-"),
  );
  expect(childEvents.map((entry) => entry.event)).toEqual([
    "health-probe-child-spawn",
    "health-probe-child-timeout",
    "health-probe-child-exit",
    "health-probe-child-stderr-close",
    "health-probe-child-close",
    "health-probe-child-callback",
  ]);
  expect(childEvents[0]).toMatchObject({
    probe: 2,
    name: "serve-help",
    childPid: 7002,
  });
  expect(childEvents[1]).toMatchObject({
    childPid: 7002,
    childAlive: true,
    timedOut: true,
  });
  expect(childEvents.at(-1)).toMatchObject({
    childPid: 7002,
    callbackErrorCode: "ETIMEDOUT",
    childAlive: false,
    childExited: true,
    childClosed: true,
  });
});

const realRuntimeRoot = process.env.AERA_RUNTIME_HEALTH_ROOT?.trim();
const realManifestPath = process.env.AERA_RUNTIME_HEALTH_MANIFEST?.trim();
const realDiagnosticOutput =
  process.env.AERA_RUNTIME_HEALTH_DIAGNOSTIC_OUTPUT?.trim();

if (realRuntimeRoot && realManifestPath && realDiagnosticOutput) {
  // @lat: [[agentera-runtime-distribution#Release gate#Packaged live Runtime contract#Health child-process lifecycle evidence#Windows real-runtime diagnostic]]
  it("records lifecycle evidence for the extracted Windows Runtime health path", async () => {
    process.env.AGENTERA_E2E_DIAGNOSTICS = "1";
    process.env.AGENTERA_E2E_RUNTIME_CONTRACT_DIAGNOSTIC_OUTPUT =
      realDiagnosticOutput;
    const manifest = parseRuntimeManifest(await readFile(realManifestPath));
    const timeoutValue = Number(
      process.env.AERA_RUNTIME_HEALTH_TIMEOUT_MS ?? 120_000,
    );
    const timeoutMs =
      Number.isSafeInteger(timeoutValue) && timeoutValue > 0
        ? timeoutValue
        : 120_000;
    let failureName: string | null = null;
    try {
      await runIsolatedRuntimeHealthCheck({
        runtimeRoot: realRuntimeRoot,
        manifest,
        sandboxParent: join(dirname(realDiagnosticOutput), "health-sandbox"),
        timeoutMs,
      });
    } catch (error) {
      // This is a diagnostic lane: preserve the probe timeline even when the
      // extracted Runtime reproduces the candidate failure.
      failureName = error instanceof Error ? error.name : "unknown";
    }

    const events = await diagnosticEvents(realDiagnosticOutput);
    const childEvents = events.filter((entry) =>
      String(entry.event).startsWith("health-probe-child-"),
    );
    expect(events.some((entry) => entry.event === "health-check-start")).toBe(
      true,
    );
    expect(childEvents.length).toBeGreaterThan(0);
    expect(
      childEvents.every(
        (entry) =>
          entry.childPid === null ||
          (typeof entry.childPid === "number" && entry.childPid > 0),
      ),
    ).toBe(true);
    console.log(
      `[runtime-health-diagnostic] ${JSON.stringify({
        outcome: failureName ?? "healthy",
        childEvents: childEvents.length,
      })}`,
    );
  });
}
