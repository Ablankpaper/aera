import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { RuntimeManifest } from "./manifest";

const POSIX_HEALTH_TIMEOUT_MS = 45_000;
const WINDOWS_HEALTH_TIMEOUT_MS = 120_000;
const HEALTH_MAX_OUTPUT_BYTES = 1024 * 1024;
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

function defaultRunner(
  executable: string,
  args: readonly string[],
  options: RuntimeHealthCommandOptions,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
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
        if (error) {
          reject(
            new RuntimeHealthError("Runtime health command failed", {
              cause: error,
            }),
          );
          return;
        }
        resolve({ stdout, stderr });
      },
    );
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
    const commands: readonly (readonly string[])[] = [
      [
        "-I",
        "-B",
        "-c",
        guardedModuleScript(manifest.entrypoints.module, ["--version"]),
      ],
      [
        "-I",
        "-B",
        "-c",
        guardedModuleScript(manifest.entrypoints.module, ["serve", "--help"]),
      ],
      ["-I", "-B", "-c", guardedImportScript()],
    ];
    let versionOutput = "";
    for (const [index, args] of commands.entries()) {
      const result = await runner(python, args, {
        cwd: runtimeRoot,
        env,
        timeoutMs: probeTimeoutMs,
        signal,
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
    await rm(sandbox, { recursive: true, force: true });
  }
}
