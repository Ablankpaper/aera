import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import {
  RuntimeHealthError,
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

it("captures the serve-help import waterfall in diagnostic mode only", async () => {
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
  // Probe 2 (serve-help) carries the import waterfall so a stalled launch
  // shows the exact import it never completed; the other probes stay plain.
  expect(capturedArgs[1]).toEqual(expect.arrayContaining(["-X", "importtime"]));
  expect(capturedArgs[0]).not.toContain("-X");
  expect(capturedArgs[2]).not.toContain("-X");
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
