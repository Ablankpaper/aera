/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const HARNESS_FILE = fileURLToPath(import.meta.url);
const CRASH_STAGES = [
  "begin",
  "backup",
  "credential",
  "provider",
  "model_library",
  "native_route",
  "activation",
  "verification",
  "cleanup",
];
const FILES = ["env", "providers", "models", "modelDefinitions", "config"];
const MARKER_TIMEOUT_MS = 10_000;
const EXIT_TIMEOUT_MS = 5_000;
const CLI_MODE = process.argv.includes("--run-harness");

function assertHarnessRoot(root) {
  const resolved = resolve(root);
  const temp = resolve(tmpdir());
  if (
    !resolved.startsWith(`${temp}${process.platform === "win32" ? "\\" : "/"}`)
  ) {
    throw new Error(
      "Windows recovery harness root must be a generated temp child.",
    );
  }
  return resolved;
}

function paths(root) {
  return {
    env: join(root, ".env"),
    providers: join(root, "providers.json"),
    models: join(root, "models.json"),
    modelDefinitions: join(root, "model-definitions.json"),
    config: join(root, "config.yaml"),
  };
}

function beforeBytes(stage) {
  return Buffer.from(`before:${stage}\n`, "utf8");
}

function resetFixture(root, stage) {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const target = paths(root);
  for (const role of FILES)
    writeFileSync(target[role], beforeBytes(`${stage}:${role}`));
  writeFileSync(join(root, "journal.json"), "{}\n");
  return target;
}

function childSource() {
  // This child intentionally models only journal windows. It never receives a
  // developer HOME/Profile and writes exclusively below HARNESS_ROOT.
  return `
    import { existsSync, readFileSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    const root = process.env.HARNESS_ROOT;
    const stage = process.env.CRASH_STAGE;
    if (!root || !stage) throw new Error("harness child environment missing");
    const files = {
      env: join(root, ".env"),
      providers: join(root, "providers.json"),
      models: join(root, "models.json"),
      modelDefinitions: join(root, "model-definitions.json"),
      config: join(root, "config.yaml"),
    };
    const roles = Object.keys(files);
    const steps = [
      ["credential", "env"],
      ["provider", "providers"],
      ["model_library", "models"],
      ["native_route", "modelDefinitions"],
      ["activation", "config"],
    ];
    const journal = join(root, "journal.json");
    const before = Object.fromEntries(roles.map((role) => [role, readFileSync(files[role], "base64")]));
    const after = Object.fromEntries(roles.map((role) => [role, Buffer.from("after:" + stage + ":" + role + "\\n").toString("base64")]));
    const mark = (state) => writeFileSync(journal, JSON.stringify({ state, before, after }) + "\\n");
    const stopAt = async (current) => {
      if (stage !== current) return;
      writeFileSync(join(root, "marker"), current + "\\n");
      setInterval(() => {}, 1_000);
      await new Promise(() => {});
    };
    mark("begin");
    await stopAt("begin");
    for (const role of roles) writeFileSync(files[role] + ".backup", Buffer.from(before[role], "base64"));
    mark("backup");
    await stopAt("backup");
    for (const [state, role] of steps) {
      writeFileSync(files[role], Buffer.from(after[role], "base64"));
      mark(state);
      await stopAt(state);
    }
    mark("verification");
    await stopAt("verification");
    mark("cleanup");
    await stopAt("cleanup");
  `;
}

function ensureChild(root) {
  const child = join(root, "mutation-child.mjs");
  writeFileSync(child, childSource());
  return child;
}

function terminateChild(child, forceWindowsKill) {
  if (process.platform === "win32" && forceWindowsKill) {
    const result = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Stop-Process -Id ${child.pid} -Force`,
      ],
      { stdio: "pipe", windowsHide: true },
    );
    if (result.status !== 0) throw new Error(result.stderr.toString("utf8"));
    return;
  }
  if (!child.kill("SIGKILL")) {
    throw new Error(`Failed to terminate mutation child ${child.pid}.`);
  }
}

function trackChild(child) {
  let settled = null;
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk) => {
    stderr += chunk;
  });

  const completion = new Promise((resolvePromise) => {
    const finish = (result) => {
      if (settled) return;
      settled = result;
      resolvePromise(result);
    };
    child.once("error", (error) => finish({ kind: "error", error }));
    child.once("exit", (code, signal) =>
      finish({ kind: "exit", code, signal }),
    );
  });

  return {
    completion,
    get settled() {
      return settled;
    },
    diagnostics() {
      return { stdout: stdout.trim(), stderr: stderr.trim() };
    },
  };
}

function describeChildFailure(prefix, tracker) {
  const result = tracker.settled;
  const { stdout, stderr } = tracker.diagnostics();
  const status =
    result?.kind === "error"
      ? `spawn error: ${result.error?.message || result.error}`
      : result?.kind === "exit"
        ? `exit code=${String(result.code)} signal=${String(result.signal)}`
        : "still running";
  const details = [stderr && `stderr=${stderr}`, stdout && `stdout=${stdout}`]
    .filter(Boolean)
    .join("; ");
  return new Error(`${prefix}: ${status}${details ? `; ${details}` : ""}`);
}

async function waitForMarker(root, expected, tracker) {
  const marker = join(root, "marker");
  const deadline = Date.now() + MARKER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (existsSync(marker) && readFileSync(marker, "utf8").trim() === expected)
      return;
    if (tracker.settled) {
      throw describeChildFailure(
        `Mutation child exited before reaching ${expected}`,
        tracker,
      );
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw describeChildFailure(
    `Mutation child did not reach ${expected} within ${MARKER_TIMEOUT_MS}ms`,
    tracker,
  );
}

async function waitForChildExit(stage, tracker) {
  let timeout;
  try {
    return await Promise.race([
      tracker.completion,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              describeChildFailure(
                `Mutation child did not exit after forced termination at ${stage}`,
                tracker,
              ),
            ),
          EXIT_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function recover(root, stage) {
  const journal = JSON.parse(readFileSync(join(root, "journal.json"), "utf8"));
  const target = paths(root);
  const terminal = stage === "verification" || stage === "cleanup";
  const expected = terminal ? journal.after : journal.before;
  for (const role of FILES) {
    writeFileSync(target[role], Buffer.from(expected[role], "base64"));
    rmSync(`${target[role]}.backup`, { force: true });
    const actual = readFileSync(target[role], "base64");
    assert.equal(actual, expected[role], `${stage}:${role} bytes`);
  }
  journal.state = terminal ? "committed" : "rolled_back";
  writeFileSync(join(root, "journal.json"), JSON.stringify(journal) + "\n");
  return journal.state;
}

export async function runWindowsModelRecoveryHarness({
  root = mkdtempSync(join(tmpdir(), "aera-windows-model-recovery-")),
  forceWindowsKill = false,
  cleanup = true,
} = {}) {
  const harnessRoot = assertHarnessRoot(root);
  const outcomes = [];
  try {
    for (const stage of CRASH_STAGES) {
      resetFixture(harnessRoot, stage);
      const childFile = ensureChild(harnessRoot);
      const child = spawn(process.execPath, [childFile], {
        env: { ...process.env, HARNESS_ROOT: harnessRoot, CRASH_STAGE: stage },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      const tracker = trackChild(child);
      await waitForMarker(harnessRoot, stage, tracker);
      terminateChild(child, forceWindowsKill);
      await waitForChildExit(stage, tracker);
      const state = recover(harnessRoot, stage);
      outcomes.push({ stage, state });
    }
    return outcomes;
  } finally {
    if (cleanup) rmSync(harnessRoot, { recursive: true, force: true });
  }
}

export function powershellHarnessArguments(projectRoot, tempRoot) {
  const project = resolve(projectRoot);
  const temp = assertHarnessRoot(tempRoot);
  return [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    join(project, "scripts", "release", "windows-model-recovery-harness.ps1"),
    "-ProjectRoot",
    project,
    "-HarnessRoot",
    temp,
  ];
}

if (CLI_MODE) {
  const rootIndex = process.argv.indexOf("--root");
  const root = rootIndex >= 0 ? process.argv[rootIndex + 1] : undefined;
  runWindowsModelRecoveryHarness({
    root,
    forceWindowsKill: process.argv.includes("--force-windows-kill"),
    cleanup: false,
  })
    .then((outcomes) => {
      process.stdout.write(
        JSON.stringify({ ok: true, outcomes }, null, 2) + "\n",
      );
    })
    .catch((error) => {
      process.stderr.write(`${error.stack || error}\n`);
      process.exitCode = 1;
    });
}

if (!CLI_MODE) {
  test(
    "recovers every modeled Windows process-crash journal window",
    { timeout: 60_000 },
    async () => {
      const outcomes = await runWindowsModelRecoveryHarness();
      assert.equal(outcomes.length, CRASH_STAGES.length);
      assert.deepEqual(
        outcomes.map(({ stage, state }) => [stage, state]),
        CRASH_STAGES.map((stage) => [
          stage,
          stage === "verification" || stage === "cleanup"
            ? "committed"
            : "rolled_back",
        ]),
      );
    },
  );

  test("PowerShell invocation is scoped to a generated temporary root", () => {
    const root = mkdtempSync(
      join(tmpdir(), "aera-windows-model-recovery-args-"),
    );
    try {
      const args = powershellHarnessArguments(repoRoot(), root);
      assert.ok(args.includes(root));
      assert.ok(
        args.includes(
          resolve(
            repoRoot(),
            "scripts/release/windows-model-recovery-harness.ps1",
          ),
        ),
      );
      assert.ok(
        !args.some(
          (value) =>
            value === process.env.HOME || value === process.env.USERPROFILE,
        ),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("PowerShell crash harness is strict and delegates only to the generated root", () => {
    const scriptPath = join(
      repoRoot(),
      "scripts",
      "release",
      "windows-model-recovery-harness.ps1",
    );
    assert.ok(existsSync(scriptPath), "PowerShell harness script must exist");
    const source = readFileSync(scriptPath, "utf8");
    assert.match(source, /Set-StrictMode\s+-Version\s+Latest/u);
    assert.match(source, /Stop-Process\s+-Id|--force-windows-kill/u);
    assert.match(source, /--force-windows-kill/u);
    assert.match(source, /HarnessRoot/u);
    assert.match(source, /GetTempPath/u);
    assert.doesNotMatch(source, /Remove-Item\s+.*ProjectRoot/u);
  });

  test("package scripts expose the Windows recovery harness without global dependencies", () => {
    const packageJson = JSON.parse(
      readFileSync(join(repoRoot(), "package.json"), "utf8"),
    );
    assert.equal(
      packageJson.scripts?.["test:windows-model-recovery"],
      "node scripts/release/windows-model-recovery-harness.test.mjs",
    );
  });

  test("CI runs the Windows crash matrix and uploads its bounded evidence", () => {
    const workflow = readFileSync(
      join(repoRoot(), ".github", "workflows", "ci.yml"),
      "utf8",
    );
    assert.match(workflow, /windows-model-recovery:/u);
    assert.match(workflow, /runs-on:\s+windows-latest/u);
    assert.match(workflow, /windows-model-recovery-harness\.ps1/u);
    assert.match(workflow, /actions\/upload-artifact@v4/u);
    assert.match(workflow, /windows-recovery-evidence\.json/u);
  });
}

function repoRoot() {
  return resolve(dirname(HARNESS_FILE), "../..");
}
