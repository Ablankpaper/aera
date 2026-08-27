#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */
/**
 * Diagnose where the packaged Windows Runtime's `serve --help` launch stalls.
 *
 * Mirrors the exact probes of src/main/agentera-runtime-distribution/health.ts
 * (isolated env, NETWORK_GUARD, runpy module entry) on the exact packaged
 * Seed, but splits the launch into staged variants so the failure evidence
 * says which phase stalls: interpreter boot, module import, or serve
 * dispatch. Each phase records the real child PID, full command line,
 * 2-second liveness/output/CPU samples, and the final exit evidence.
 *
 * Evidence is written as JSONL: no credentials, no user paths beyond the
 * runner's own workspace, and never changes Runtime installation behavior.
 *
 * Usage:
 *   node scripts/diagnose-windows-serve-help.mjs \
 *     --runtime-root <extracted seed dir> --manifest <manifest.json> \
 *     [--timeout-ms 150000] [--output <path>]
 */

import { execFile, spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const NETWORK_GUARD = [
  "import socket",
  'blocked=lambda *_args,**_kwargs: (_ for _ in ()).throw(RuntimeError("network is disabled during Aera Runtime health checks"))',
  "socket.create_connection=blocked",
  "socket.socket.connect=blocked",
  "socket.socket.connect_ex=blocked",
].join(";");

function guardedModuleScript(module, args) {
  return [
    NETWORK_GUARD,
    "import runpy,sys",
    `sys.argv=${JSON.stringify(["agentera-runtime-health", ...args])}`,
    `runpy.run_module(${JSON.stringify(module)},run_name="__main__")`,
  ].join(";");
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error(
        "usage: diagnose-windows-serve-help.mjs --runtime-root <dir> --manifest <file> [--timeout-ms N] [--output file]",
      );
    }
    values[flag.slice(2).replaceAll("-", "_")] = value;
  }
  if (!values.runtime_root || !values.manifest) {
    throw new Error("--runtime-root and --manifest are required");
  }
  return {
    runtimeRoot: values.runtime_root,
    manifestPath: values.manifest,
    timeoutMs: values.timeout_ms ? Number(values.timeout_ms) : 150_000,
    output: values.output ?? null,
  };
}

function loadManifest(manifestPath) {
  const parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  const entrypoints = parsed?.entrypoints;
  if (
    !entrypoints ||
    typeof entrypoints.python !== "string" ||
    typeof entrypoints.hermes !== "string" ||
    entrypoints.module !== "hermes_cli.main"
  ) {
    throw new Error("manifest entrypoints are missing or unexpected");
  }
  return parsed;
}

function resolveRuntimeRoot(root) {
  // The seed ZIP may nest the runtime under a single top-level directory.
  if (
    existsSync(join(root, "python")) ||
    existsSync(join(root, "python.exe")) ||
    existsSync(join(root, "python313.dll"))
  ) {
    return root;
  }
  const children = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name));
  if (children.length === 1) return children[0];
  return root;
}

// Mirror of health.ts isolatedEnvironment(): same isolation variables so the
// diagnostic reproduces the exact health-probe environment.
function isolatedEnvironment(runtimeRoot, hermesHome, home, platform) {
  const runtimeBin =
    platform === "windows" ? runtimeRoot : join(runtimeRoot, "bin");
  const pythonBin =
    platform === "windows" ? runtimeRoot : join(runtimeRoot, "python", "bin");
  const systemPath = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  return {
    SystemDrive: process.env.SystemDrive,
    HERMES_HOME: hermesHome,
    HOME: home,
    USERPROFILE: home,
    PYTHONHOME: runtimeRoot,
    PYTHONPATH: join(runtimeRoot, "python"),
    PYTHONNOUSERSITE: "1",
    PYTHONDONTWRITEBYTECODE: "1",
    PIP_NO_INDEX: "1",
    UV_OFFLINE: "1",
    NO_PROXY: "*",
    no_proxy: "*",
    TZ: "UTC",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    PATH: [runtimeBin, pythonBin, ...systemPath]
      .filter(Boolean)
      .join(delimiter),
    ...Object.fromEntries(
      ["SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "TMP", "TEMP"]
        .filter((name) => process.env[name] !== undefined)
        .map((name) => [name, process.env[name]]),
    ),
  };
}

function makeEmitter(outputPath) {
  const startedAt = Date.now();
  return (event, fields = {}) => {
    const line = `${JSON.stringify({
      schemaVersion: 1,
      event,
      elapsedMs: Date.now() - startedAt,
      ...fields,
    })}\n`;
    process.stdout.write(line);
    if (outputPath) {
      try {
        appendFileSync(outputPath, line, "utf8");
      } catch {
        // Evidence writing must never change the diagnostic outcome.
      }
    }
  };
}

async function sampleCpuSeconds(pid) {
  if (process.platform !== "win32") return null;
  try {
    const { stdout } = await execFileAsync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { $p.CPU } else { "" }`,
      ],
      { timeout: 5_000, windowsHide: true },
    );
    const value = Number(stdout.trim());
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function runProbe({ name, file, args, cwd, env, timeoutMs, emit }) {
  return new Promise((resolveProbe) => {
    const startedAt = Date.now();
    const child = spawn(file, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const pid = child.pid ?? null;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stderrChunks = [];
    const stdoutChunks = [];
    let settled = false;
    let timedOut = false;

    emit("probe-spawned", {
      probe: name,
      pid,
      command: file,
      // The guarded -c script contains no credentials or local secrets.
      args,
    });

    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearInterval(sampler);
      clearTimeout(killer);
      const result = {
        probe: name,
        pid,
        elapsedMs: Date.now() - startedAt,
        stdoutBytes,
        stderrBytes,
        stderrTail: Buffer.concat(stderrChunks).toString("utf8").slice(-2048),
        stdoutTail: Buffer.concat(stdoutChunks).toString("utf8").slice(-2048),
        ...outcome,
      };
      emit("probe-finished", result);
      resolveProbe(result);
    };

    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      stdoutChunks.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      stderrChunks.push(chunk);
    });
    child.on("error", (error) => {
      finish({ outcome: "spawn-error", error: String(error) });
    });
    child.on("close", (code, signal) => {
      finish({
        outcome: timedOut ? "timeout-killed" : "exited",
        exitCode: code,
        signal,
      });
    });

    const sampler = setInterval(() => {
      void (async () => {
        if (pid === null) return;
        let alive = true;
        try {
          process.kill(pid, 0);
        } catch {
          alive = false;
        }
        emit("probe-sample", {
          probe: name,
          pid,
          alive,
          stdoutBytes,
          stderrBytes,
          cpuSeconds: await sampleCpuSeconds(pid),
        });
      })();
    }, 2_000);
    sampler.unref();

    const killer = setTimeout(() => {
      timedOut = true;
      emit("probe-timeout", { probe: name, pid, timeoutMs });
      if (pid !== null) {
        // Bound the diagnostic itself: kill the whole tree so a stalled
        // probe cannot hold the runner.
        const tree = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
        tree.on("error", () => {});
        tree.unref();
      }
    }, timeoutMs);
    killer.unref();
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const manifest = loadManifest(options.manifestPath);
  const runtimeRoot = resolveRuntimeRoot(options.runtimeRoot);
  const python = join(runtimeRoot, ...manifest.entrypoints.python.split("/"));
  if (!existsSync(python)) {
    throw new Error(`Runtime Python entrypoint not found below the seed root`);
  }
  const emit = makeEmitter(options.output);
  if (options.output) {
    mkdirSync(dirname(options.output), { recursive: true });
    writeFileSync(options.output, "", "utf8");
  }

  emit("diagnostic-start", {
    platform: manifest.platform,
    arch: manifest.arch,
    runtimeVersion: manifest.runtime_version,
    sourceCommit: manifest.source_commit,
    pythonVersion: manifest.python_version,
    runnerOs: process.platform,
    runnerArch: process.arch,
    node: process.version,
    timeoutMs: options.timeoutMs,
  });

  const sandbox = mkdtempSync(join(tmpdir(), "aera-serve-help-diagnostic-"));
  const hermesHome = join(sandbox, "hermes-home");
  const fakeHome = join(sandbox, "home");
  mkdirSync(hermesHome, { recursive: true });
  mkdirSync(fakeHome, { recursive: true });
  const env = isolatedEnvironment(
    runtimeRoot,
    hermesHome,
    fakeHome,
    manifest.platform,
  );
  const module = manifest.entrypoints.module;

  const phases = [
    // Baseline: bare interpreter boot (health.ts probe 1 equivalent minus
    // the module import) — expected ~seconds even under Defender.
    { name: "bare-version", args: ["--version"] },
    // Isolated empty boot: separates `-I -B` sandbox flags from module cost.
    { name: "isolated-empty", args: ["-I", "-B", "-c", "pass"] },
    // Import waterfall for the CLI module alone: which import stalls, or
    // whether imports complete and the stall is post-import.
    {
      name: "importtime-module",
      args: [
        "-I",
        "-B",
        "-X",
        "importtime",
        "-c",
        `${NETWORK_GUARD};import hermes_cli.main`,
      ],
    },
    // Exact health probe 1: guarded module --version.
    {
      name: "guarded-version",
      args: ["-I", "-B", "-c", guardedModuleScript(module, ["--version"])],
    },
    // serve --help with the import waterfall on stderr.
    {
      name: "serve-help-importtime",
      args: [
        "-I",
        "-B",
        "-X",
        "importtime",
        "-c",
        guardedModuleScript(module, ["serve", "--help"]),
      ],
    },
    // Exact health probe 2: the stalled candidate path.
    {
      name: "serve-help",
      args: [
        "-I",
        "-B",
        "-c",
        guardedModuleScript(module, ["serve", "--help"]),
      ],
    },
  ];

  const results = [];
  for (const phase of phases) {
    results.push(
      await runProbe({
        name: phase.name,
        file: python,
        args: phase.args,
        cwd: runtimeRoot,
        env,
        timeoutMs: options.timeoutMs,
        emit,
      }),
    );
  }

  emit("diagnostic-complete", {
    results: results.map((result) => ({
      probe: result.probe,
      outcome: result.outcome,
      elapsedMs: result.elapsedMs,
      exitCode: result.exitCode ?? null,
      signal: result.signal ?? null,
      stdoutBytes: result.stdoutBytes,
      stderrBytes: result.stderrBytes,
    })),
  });
}

main().catch((error) => {
  console.error(
    `[serve-help-diagnostic] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
