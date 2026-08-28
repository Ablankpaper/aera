import { execFile, type ChildProcess } from "node:child_process";
import { appendFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";

import type { RuntimeManifest } from "./manifest";

const POSIX_HEALTH_TIMEOUT_MS = 45_000;
const WINDOWS_HEALTH_TIMEOUT_MS = 120_000;
const HEALTH_MAX_OUTPUT_BYTES = 1024 * 1024;
// The recorded output tail must hold enough of an `-X importtime` waterfall
// (each line ~80 chars) to show exactly which import never completed.
const HEALTH_DIAGNOSTIC_MAX_STDERR_CHARS = 2048;
const HEALTH_DIAGNOSTIC_OUTPUT =
  "AGENTERA_E2E_RUNTIME_CONTRACT_DIAGNOSTIC_OUTPUT";
const REQUIRED_IMPORTS = [
  "hermes_cli.main",
  "tools.registry",
  "tools.memory_tool",
  "tools.skill_manager_tool",
  "agent.curator",
] as const;
const NETWORK_GUARD = [
  "import socket",
  'blocked=lambda *_args,**_kwargs: (_ for _ in ()).throw(RuntimeError("network is disabled during Aera Runtime health checks"))',
  "socket.create_connection=blocked",
  "socket.socket.connect=blocked",
  "socket.socket.connect_ex=blocked",
].join(";");

export interface RuntimeHealthCommandOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
  onLifecycle?: (event: RuntimeHealthCommandLifecycleEvent) => void;
}

export type RuntimeHealthCommandLifecycleType =
  | "spawn"
  | "timeout"
  | "exit"
  | "stdout-close"
  | "stderr-close"
  | "close"
  | "callback";

export interface RuntimeHealthCommandLifecycleEvent {
  type: RuntimeHealthCommandLifecycleType;
  pid: number | null;
  code?: number | string | null;
  signal?: string | null;
  childAlive?: boolean | null;
  childExited?: boolean;
  childClosed?: boolean;
  stdoutClosed?: boolean;
  stderrClosed?: boolean;
  killed?: boolean;
}

export type RuntimeHealthCommandRunner = (
  executable: string,
  args: readonly string[],
  options: RuntimeHealthCommandOptions,
) => Promise<{ stdout: string; stderr: string }>;

export interface RuntimeHealthCheckOptions {
  runtimeRoot: string;
  manifest: RuntimeManifest;
  sandboxParent?: string;
  signal?: AbortSignal;
  runner?: RuntimeHealthCommandRunner;
  timeoutMs?: number;
}

export interface RuntimeHealthCheckResult {
  probes: number;
  versionOutput: string;
}

export class RuntimeHealthError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RuntimeHealthError";
  }
}

interface RuntimeHealthCommandFailure {
  code: number | string | null;
  killed: boolean;
  signal: string | null;
  timedOut: boolean;
  stdoutTail: string;
  stdoutBytes: number;
  stderrClass: string;
  stderrTail: string;
  stderrBytes: number;
}

class RuntimeHealthCommandError extends RuntimeHealthError {
  constructor(
    readonly failure: RuntimeHealthCommandFailure,
    options?: ErrorOptions,
  ) {
    super("Runtime health command failed", options);
    this.name = "RuntimeHealthCommandError";
  }
}

function safeChildPid(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

function childAliveState(
  child: ChildProcess,
  pid: number | null,
): boolean | null {
  if (pid === null) return null;
  if (child.exitCode !== null || child.signalCode !== null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code =
      error && typeof error === "object"
        ? (error as { code?: unknown }).code
        : undefined;
    if (code === "ESRCH") return false;
    // A Windows process can reject signal 0 even while the ChildProcess has
    // not reported an exit. Preserve that uncertainty instead of claiming a
    // dead child and hiding a possible inherited-handle stall.
    return child.killed ? null : true;
  }
}

function runtimeHealthDiagnostic(
  event: string,
  fields: Readonly<Record<string, boolean | number | string | null>> = {},
): void {
  if (process.env.AGENTERA_E2E_DIAGNOSTICS !== "1") return;
  const output = process.env[HEALTH_DIAGNOSTIC_OUTPUT]?.trim();
  if (!output || !isAbsolute(output)) return;
  try {
    appendFileSync(
      output,
      `${JSON.stringify({
        schemaVersion: 1,
        event,
        elapsedMs: Date.now() - runtimeHealthDiagnosticStartedAt,
        pid: process.pid,
        ...fields,
      })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  } catch {
    // Diagnostic evidence must never change Runtime installation behavior.
  }
}

function runtimeHealthDiagnosticsEnabled(): boolean {
  if (process.env.AGENTERA_E2E_DIAGNOSTICS !== "1") return false;
  const output = process.env[HEALTH_DIAGNOSTIC_OUTPUT]?.trim();
  return Boolean(output && isAbsolute(output));
}

const runtimeHealthDiagnosticStartedAt = Date.now();

function safeProcessCode(value: unknown): number | string | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string") return value.slice(0, 80);
  return null;
}

function safeProcessSignal(value: unknown): string | null {
  return typeof value === "string" ? value.slice(0, 32) : null;
}

function stderrClass(stderr: string): string {
  const normalized = stderr.toLowerCase();
  if (!normalized.trim()) return "empty";
  if (
    normalized.includes("modulenotfounderror") ||
    normalized.includes("no module named")
  ) {
    return "module-not-found";
  }
  if (
    normalized.includes("dll load failed") ||
    normalized.includes("could not find module")
  ) {
    return "native-module-load-failed";
  }
  if (
    normalized.includes("access is denied") ||
    normalized.includes("permission denied")
  ) {
    return "permission-denied";
  }
  if (normalized.includes("network is disabled during aera runtime")) {
    return "network-guard";
  }
  if (normalized.includes("traceback")) return "python-traceback";
  return "other";
}

function redactedOutputTail(output: string): string {
  return output
    .replaceAll(String.fromCharCode(27), "")
    .replace(/(["'])(?:[A-Za-z]:[\\/]|\/)[^"'\r\n]+\1/gu, "$1<path>$1")
    .replace(/\b[A-Za-z]:[\\/][^\s"'<>|]+/gu, "<path>")
    .replace(/(Authorization\s*:\s*Bearer\s+)[^\s]+/giu, "$1<redacted>")
    .replace(/\b(?:sk|vck)[-_][A-Za-z0-9._-]+/gu, "<redacted>")
    .replace(/(api[_ -]?key\s*[=:]\s*)[^\s,;]+/giu, "$1<redacted>")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(-HEALTH_DIAGNOSTIC_MAX_STDERR_CHARS);
}

function commandFailureDiagnostic(
  error: unknown,
  probeElapsedMs: number,
  timeoutMs: number,
): RuntimeHealthCommandFailure {
  if (error instanceof RuntimeHealthCommandError) return error.failure;
  const record =
    error && typeof error === "object"
      ? (error as Record<string, unknown>)
      : Object.create(null);
  const code = safeProcessCode(record.code);
  const killed = record.killed === true;
  const stdout = typeof record.stdout === "string" ? record.stdout : "";
  const stderr = typeof record.stderr === "string" ? record.stderr : "";
  return {
    code,
    killed,
    signal: safeProcessSignal(record.signal),
    timedOut:
      code === "ETIMEDOUT" ||
      (killed && probeElapsedMs >= Math.max(0, timeoutMs - 100)),
    stdoutTail: redactedOutputTail(stdout),
    stdoutBytes: Buffer.byteLength(stdout, "utf8"),
    stderrClass: stderrClass(stderr),
    stderrTail: redactedOutputTail(stderr),
    stderrBytes: Buffer.byteLength(stderr, "utf8"),
  };
}

function defaultRunner(
  executable: string,
  args: readonly string[],
  options: RuntimeHealthCommandOptions,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let childPid: number | null = null;
    let childExited = false;
    let childClosed = false;
    let stdoutClosed = false;
    let stderrClosed = false;
    let lifecycleTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const childState: { current?: ChildProcess } = {};
    const emit = (
      type: RuntimeHealthCommandLifecycleType,
      fields: Omit<RuntimeHealthCommandLifecycleEvent, "type" | "pid"> = {},
    ): void => {
      try {
        options.onLifecycle?.({
          type,
          pid: childPid,
          ...fields,
        });
      } catch {
        // Diagnostic observers are strictly best-effort and must never alter
        // the health result or child cleanup path.
      }
    };

    const child: ChildProcess = execFile(
      executable,
      [...args],
      {
        cwd: options.cwd,
        env: options.env,
        timeout: options.timeoutMs,
        maxBuffer: HEALTH_MAX_OUTPUT_BYTES,
        windowsHide: true,
        signal: options.signal,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        settled = true;
        if (lifecycleTimer) clearTimeout(lifecycleTimer);
        emit("callback", {
          code: error ? safeProcessCode(error.code) : null,
          signal: error ? safeProcessSignal(error.signal) : null,
          childAlive: childState.current
            ? childAliveState(childState.current, childPid)
            : null,
          childExited,
          childClosed,
          stdoutClosed,
          stderrClosed,
          killed: childState.current?.killed === true,
        });
        if (error) {
          const code = safeProcessCode(error.code);
          const killed = error.killed === true;
          reject(
            new RuntimeHealthCommandError(
              {
                code,
                killed,
                signal: safeProcessSignal(error.signal),
                timedOut:
                  code === "ETIMEDOUT" ||
                  (!options.signal?.aborted &&
                    killed &&
                    Date.now() - startedAt >=
                      Math.max(0, options.timeoutMs - 100)),
                stdoutTail: redactedOutputTail(stdout),
                stdoutBytes: Buffer.byteLength(stdout, "utf8"),
                stderrClass: stderrClass(stderr),
                stderrTail: redactedOutputTail(stderr),
                stderrBytes: Buffer.byteLength(stderr, "utf8"),
              },
              { cause: error },
            ),
          );
          return;
        }
        resolve({ stdout, stderr });
      },
    );
    childState.current = child;

    childPid = safeChildPid(child.pid);
    emit("spawn", {
      childAlive: childAliveState(child, childPid),
      killed: child.killed === true,
    });
    if (options.onLifecycle) {
      child.once("exit", (code, signal) => {
        childExited = true;
        emit("exit", {
          code: safeProcessCode(code),
          signal: safeProcessSignal(signal),
          childAlive: false,
          killed: child?.killed === true,
        });
      });
      child.stdout?.once("close", () => {
        stdoutClosed = true;
        emit("stdout-close", {
          childAlive: child ? childAliveState(child, childPid) : null,
          childExited,
          childClosed,
          stdoutClosed,
          stderrClosed,
          killed: child?.killed === true,
        });
      });
      child.stderr?.once("close", () => {
        stderrClosed = true;
        emit("stderr-close", {
          childAlive: child ? childAliveState(child, childPid) : null,
          childExited,
          childClosed,
          stdoutClosed,
          stderrClosed,
          killed: child?.killed === true,
        });
      });
      child.once("close", (code, signal) => {
        childClosed = true;
        emit("close", {
          code: safeProcessCode(code),
          signal: safeProcessSignal(signal),
          childAlive: false,
          childExited,
          childClosed,
          stdoutClosed,
          stderrClosed,
          killed: child?.killed === true,
        });
      });
      if (!settled) {
        lifecycleTimer = setTimeout(() => {
          emit("timeout", {
            childAlive: childAliveState(child, childPid),
            childExited,
            childClosed,
            stdoutClosed,
            stderrClosed,
            killed: child.killed === true,
          });
        }, options.timeoutMs);
      }
    }
  });
}

async function requireFile(path: string, label: string): Promise<void> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    throw new RuntimeHealthError(`${label} is missing`, { cause: error });
  }
  if (!metadata.isFile() && !metadata.isSymbolicLink()) {
    throw new RuntimeHealthError(`${label} is not a file`);
  }
}

function isolatedEnvironment(
  runtimeRoot: string,
  hermesHome: string,
  fakeHome: string,
  platform: RuntimeManifest["platform"],
): NodeJS.ProcessEnv {
  const pathDelimiter = platform === "windows" ? ";" : ":";
  const runtimeBin = join(runtimeRoot, "runtime");
  const pythonBin =
    platform === "windows"
      ? join(runtimeRoot, "python")
      : join(runtimeRoot, "python", "bin");
  const systemPath =
    platform === "windows"
      ? [process.env.SYSTEMROOT ? join(process.env.SYSTEMROOT, "System32") : ""]
      : ["/usr/bin", "/bin"];
  const environment: NodeJS.ProcessEnv = {
    HOME: fakeHome,
    USERPROFILE: fakeHome,
    LOCALAPPDATA: join(fakeHome, "AppData", "Local"),
    HERMES_HOME: hermesHome,
    HERMES_BUNDLED_SKILLS: join(runtimeRoot, "python", "skills"),
    HERMES_OPTIONAL_SKILLS: join(runtimeRoot, "python", "optional-skills"),
    HERMES_OPTIONAL_MCPS: join(runtimeRoot, "python", "optional-mcps"),
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
      .join(pathDelimiter),
  };
  for (const name of [
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "TMP",
    "TEMP",
  ] as const) {
    if (process.env[name]) environment[name] = process.env[name];
  }
  return environment;
}

function guardedModuleScript(module: string, args: readonly string[]): string {
  return [
    NETWORK_GUARD,
    "import runpy,sys",
    `sys.argv=${JSON.stringify(["agentera-runtime-health", ...args])}`,
    `runpy.run_module(${JSON.stringify(module)},run_name="__main__")`,
  ].join(";");
}

function guardedImportScript(): string {
  return [
    NETWORK_GUARD,
    "import importlib",
    `mods=${JSON.stringify(REQUIRED_IMPORTS)}`,
    "[importlib.import_module(name) for name in mods]",
  ].join(";");
}

function serveHelpProbeArgs(module: string): readonly string[] {
  const script = guardedModuleScript(module, ["serve", "--help"]);
  // Import tracing is an investigative probe, not part of the health gate.
  // On a packaged Windows first launch it can materially change cold-start
  // timing (and therefore make the gating command fail for the wrong reason).
  // Keep it behind an explicit opt-in so ordinary acceptance diagnostics use
  // the exact same command as production.
  return process.env.AGENTERA_E2E_IMPORTTIME === "1"
    ? ["-I", "-B", "-X", "importtime", "-c", script]
    : ["-I", "-B", "-c", script];
}

// @lat: [[agentera-self-evolution#Runtime isolation]]
export async function runIsolatedRuntimeHealthCheck({
  runtimeRoot,
  manifest,
  sandboxParent,
  signal,
  runner = defaultRunner,
  timeoutMs,
}: RuntimeHealthCheckOptions): Promise<RuntimeHealthCheckResult> {
  const probeTimeoutMs =
    timeoutMs ??
    (manifest.platform === "windows"
      ? WINDOWS_HEALTH_TIMEOUT_MS
      : POSIX_HEALTH_TIMEOUT_MS);
  if (!Number.isSafeInteger(probeTimeoutMs) || probeTimeoutMs <= 0) {
    throw new RuntimeHealthError("Runtime health timeout must be positive");
  }
  runtimeHealthDiagnostic("health-check-start", {
    platform: manifest.platform,
    probes: 3,
    timeoutMs: probeTimeoutMs,
  });
  const python = join(runtimeRoot, ...manifest.entrypoints.python.split("/"));
  const hermes = join(runtimeRoot, ...manifest.entrypoints.hermes.split("/"));
  await requireFile(python, "Runtime Python entrypoint");
  await requireFile(hermes, "Runtime Hermes entrypoint");

  const healthParent = sandboxParent ?? dirname(runtimeRoot);
  await mkdir(healthParent, { recursive: true, mode: 0o700 });
  const healthParentMetadata = await lstat(healthParent);
  if (
    !healthParentMetadata.isDirectory() ||
    healthParentMetadata.isSymbolicLink()
  ) {
    throw new RuntimeHealthError(
      "Runtime health sandbox parent must be a real directory",
    );
  }
  const sandbox = await mkdtemp(
    join(healthParent, ".agentera-runtime-health-"),
  );
  runtimeHealthDiagnostic("health-sandbox-ready");
  try {
    const hermesHome = join(sandbox, "hermes-home");
    const fakeHome = join(sandbox, "home");
    await mkdir(hermesHome, { recursive: false, mode: 0o700 });
    await mkdir(fakeHome, { recursive: false, mode: 0o700 });
    const env = isolatedEnvironment(
      runtimeRoot,
      hermesHome,
      fakeHome,
      manifest.platform,
    );
    const commands: readonly {
      name: "imports" | "serve-help" | "version";
      args: readonly string[];
    }[] = [
      {
        name: "version",
        args: [
          "-I",
          "-B",
          "-c",
          guardedModuleScript(manifest.entrypoints.module, ["--version"]),
        ],
      },
      {
        name: "serve-help",
        args: serveHelpProbeArgs(manifest.entrypoints.module),
      },
      { name: "imports", args: ["-I", "-B", "-c", guardedImportScript()] },
    ];
    let versionOutput = "";
    for (const [index, command] of commands.entries()) {
      const probe = index + 1;
      const probeStartedAt = Date.now();
      const lifecycleState = {
        childPid: null as number | null,
        childExited: false,
        childClosed: false,
        stdoutClosed: false,
        stderrClosed: false,
        childAliveAtTimeout: null as boolean | null,
        timeoutAt: null as number | null,
        callbackAt: null as number | null,
      };
      const onLifecycle = runtimeHealthDiagnosticsEnabled()
        ? (event: RuntimeHealthCommandLifecycleEvent): void => {
            if (event.pid !== null) lifecycleState.childPid = event.pid;
            if (event.type === "exit") lifecycleState.childExited = true;
            if (event.type === "close") lifecycleState.childClosed = true;
            if (event.type === "stdout-close")
              lifecycleState.stdoutClosed = true;
            if (event.type === "stderr-close")
              lifecycleState.stderrClosed = true;
            if (event.type === "timeout") {
              lifecycleState.childAliveAtTimeout = event.childAlive ?? null;
              lifecycleState.timeoutAt = Date.now();
            }
            if (event.type === "callback")
              lifecycleState.callbackAt = Date.now();

            const fields: Record<string, boolean | number | string | null> = {
              probe,
              name: command.name,
              executable: basename(python),
              childPid: event.pid,
              childElapsedMs: Date.now() - probeStartedAt,
              childAlive: event.childAlive ?? null,
              childExited: event.childExited ?? lifecycleState.childExited,
              childClosed: event.childClosed ?? lifecycleState.childClosed,
              stdoutClosed: event.stdoutClosed ?? lifecycleState.stdoutClosed,
              stderrClosed: event.stderrClosed ?? lifecycleState.stderrClosed,
              killed: event.killed ?? false,
            };
            if (event.type === "exit" || event.type === "close") {
              fields.exitCode = event.code ?? null;
              fields.signal = event.signal ?? null;
            }
            if (event.type === "callback") {
              fields.callbackErrorCode = event.code ?? null;
              fields.callbackSignal = event.signal ?? null;
              fields.callbackKilled = event.killed ?? false;
              fields.callbackDelayAfterTimeoutMs =
                lifecycleState.timeoutAt === null
                  ? null
                  : Date.now() - lifecycleState.timeoutAt;
            }
            if (event.type === "timeout") fields.timedOut = true;
            runtimeHealthDiagnostic(`health-probe-child-${event.type}`, fields);
          }
        : undefined;
      runtimeHealthDiagnostic("health-probe-start", {
        probe,
        name: command.name,
        executable: basename(python),
        timeoutMs: probeTimeoutMs,
      });
      let result: { stdout: string; stderr: string };
      try {
        result = await runner(python, command.args, {
          cwd: runtimeRoot,
          env,
          timeoutMs: probeTimeoutMs,
          signal,
          onLifecycle,
        });
      } catch (error) {
        const probeElapsedMs = Date.now() - probeStartedAt;
        const failure = commandFailureDiagnostic(
          error,
          probeElapsedMs,
          probeTimeoutMs,
        );
        runtimeHealthDiagnostic("health-probe-failed", {
          probe,
          name: command.name,
          executable: basename(python),
          probeElapsedMs,
          code: failure.code,
          killed: failure.killed,
          signal: failure.signal,
          timedOut: failure.timedOut,
          stdoutTail: failure.stdoutTail,
          stdoutBytes: failure.stdoutBytes,
          stderrClass: failure.stderrClass,
          stderrTail: failure.stderrTail,
          stderrBytes: failure.stderrBytes,
          childPid: lifecycleState.childPid,
          childExited: lifecycleState.childExited,
          childClosed: lifecycleState.childClosed,
          stdoutClosed: lifecycleState.stdoutClosed,
          stderrClosed: lifecycleState.stderrClosed,
          childAliveAtTimeout: lifecycleState.childAliveAtTimeout,
          callbackDelayAfterTimeoutMs:
            lifecycleState.timeoutAt === null ||
            lifecycleState.callbackAt === null
              ? null
              : lifecycleState.callbackAt - lifecycleState.timeoutAt,
        });
        throw error;
      }
      runtimeHealthDiagnostic("health-probe-complete", {
        probe,
        name: command.name,
        executable: basename(python),
        probeElapsedMs: Date.now() - probeStartedAt,
        code: 0,
        killed: false,
        signal: null,
        timedOut: false,
        stdoutBytes: Buffer.byteLength(result.stdout, "utf8"),
        stderrBytes: Buffer.byteLength(result.stderr, "utf8"),
      });
      if (index === 0) versionOutput = result.stdout.trim();
    }
    return { probes: commands.length, versionOutput };
  } catch (error) {
    if (error instanceof RuntimeHealthError) throw error;
    throw new RuntimeHealthError(
      "Runtime Seed failed its isolated health check",
      {
        cause: error,
      },
    );
  } finally {
    const cleanupStartedAt = Date.now();
    runtimeHealthDiagnostic("health-sandbox-cleanup-start");
    await rm(sandbox, { recursive: true, force: true });
    runtimeHealthDiagnostic("health-sandbox-cleanup-complete", {
      cleanupElapsedMs: Date.now() - cleanupStartedAt,
    });
  }
}
