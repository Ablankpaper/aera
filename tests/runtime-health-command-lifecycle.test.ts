// @vitest-environment node

import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile: execFileMock,
}));

import {
  RuntimeHealthError,
  runIsolatedRuntimeHealthCheck,
} from "../src/main/agentera-runtime-distribution/health";
import { parseRuntimeManifest } from "../src/main/agentera-runtime-distribution/manifest";
import {
  createFixtureManifest,
  fixtureCanonicalBytes,
} from "./fixtures/runtime-distribution/fixture";

class FakeStream extends EventEmitter {}

class FakeChild extends EventEmitter {
  readonly pid = process.pid;
  readonly stdout = new FakeStream();
  readonly stderr = new FakeStream();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
}

const roots: string[] = [];

afterEach(async () => {
  execFileMock.mockReset();
  delete process.env.AGENTERA_E2E_DIAGNOSTICS;
  delete process.env.AGENTERA_E2E_RUNTIME_CONTRACT_DIAGNOSTIC_OUTPUT;
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function healthHarness(): Promise<{
  runtimeRoot: string;
  manifest: ReturnType<typeof parseRuntimeManifest>;
  output: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "aera-runtime-health-lifecycle-"));
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

function finishChild(
  child: FakeChild,
  callback: (error: Error | null, stdout: string, stderr: string) => void,
  error: Error | null,
): void {
  if (error) {
    child.killed = true;
    child.signalCode = "SIGTERM";
  } else {
    child.exitCode = 0;
  }
  child.emit("exit", error ? null : 0, error ? "SIGTERM" : null);
  child.stdout.emit("close");
  child.stderr.emit("close");
  child.emit("close", error ? null : 0, error ? "SIGTERM" : null);
  callback(error, error ? "" : "0.20.0-agentera.5\n", "");
}

// @lat: [[agentera-runtime-distribution#Release gate#Packaged live Runtime contract#Health child-process lifecycle evidence]]
it("observes the real execFile runner when a stream delays its callback", async () => {
  const setup = await healthHarness();
  process.env.AGENTERA_E2E_DIAGNOSTICS = "1";
  process.env.AGENTERA_E2E_RUNTIME_CONTRACT_DIAGNOSTIC_OUTPUT = setup.output;

  let invocation = 0;
  execFileMock.mockImplementation(
    (
      _executable: string,
      _args: readonly string[],
      options: { timeout: number },
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      invocation += 1;
      const child = new FakeChild();
      if (invocation === 2) {
        const error = Object.assign(new Error("health probe timed out"), {
          code: "ETIMEDOUT",
          killed: true,
          signal: "SIGTERM",
        });
        setTimeout(
          () => finishChild(child, callback, error),
          options.timeout + 15,
        );
      } else {
        setTimeout(() => finishChild(child, callback, null), 1);
      }
      return child;
    },
  );

  await expect(
    runIsolatedRuntimeHealthCheck({
      runtimeRoot: setup.runtimeRoot,
      manifest: setup.manifest,
      timeoutMs: 20,
    }),
  ).rejects.toBeInstanceOf(RuntimeHealthError);

  const events = await diagnosticEvents(setup.output);
  const childEvents = events.filter(
    (entry) =>
      entry.event && String(entry.event).startsWith("health-probe-child-"),
  );
  const probeTwo = childEvents.filter((entry) => entry.probe === 2);
  expect(probeTwo.map((entry) => entry.event)).toEqual([
    "health-probe-child-spawn",
    "health-probe-child-timeout",
    "health-probe-child-exit",
    "health-probe-child-stdout-close",
    "health-probe-child-stderr-close",
    "health-probe-child-close",
    "health-probe-child-callback",
  ]);
  expect(probeTwo[1]).toMatchObject({
    childPid: process.pid,
    childAlive: true,
    timedOut: true,
  });
  expect(probeTwo.at(-1)).toMatchObject({
    childPid: process.pid,
    callbackErrorCode: "ETIMEDOUT",
    childAlive: false,
    childExited: true,
    childClosed: true,
    stdoutClosed: true,
    stderrClosed: true,
  });
  expect(probeTwo.at(-1)?.callbackDelayAfterTimeoutMs).toEqual(
    expect.any(Number),
  );
  expect(probeTwo.at(-1)?.callbackDelayAfterTimeoutMs).toBeGreaterThanOrEqual(
    0,
  );
});
