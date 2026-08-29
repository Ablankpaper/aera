import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createServer } from "node:net";
import { appendFileSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";

import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "playwright/test";

import {
  classifyLiveGatewayProcessInspectionError,
  inspectActiveGatewayProfile,
  inspectGatewayPidFile,
  inspectInstalledRuntimeContract,
  inspectLiveGatewayEndpoint,
  inspectLiveGatewayProcess,
  parseWindowsGatewayProcessSamples,
  probeRuntimeCapabilities,
  readRedactedGatewayLogTail,
  redactGatewayDiagnosticTail,
  type LiveGatewayEndpointEvidence,
  type LiveGatewayProcessEvidence,
  type WindowsGatewayProcessSample,
} from "./support/agentera-runtime-contract-evidence";

const SHA1_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const desktopRoot = resolve(process.cwd());

interface RuntimeLock {
  runtime_version: string;
  source_commit: string;
}

interface SeedManifestIdentity {
  filename: string;
  sha256: string;
  runtimeVersion: string;
  sourceCommit: string;
}

let app: ElectronApplication | null = null;
let page: Page | null = null;
let temporaryRoot = "";
let diagnosticOutput: string | null = null;
let diagnosticStartedAt = 0;
let electronStderrTail = "";
let electronStderrCapture = "";
let gatewayLaunchObserver: GatewayLaunchObserver | null = null;
const MAIN_PROCESS_STDERR_READ_CHARS = 16_384;
const MAX_CAPTURED_ELECTRON_STDERR_CHARS = 512 * 1024;
const EXTERNAL_GATEWAY_OBSERVER_INTERVAL_MS = 5_000;
const EXTERNAL_GATEWAY_OBSERVER_TIMEOUT_MS = 4_000;
const EXTERNAL_GATEWAY_OBSERVER_MAX_OUTPUT_BYTES = 512 * 1024;
const PROFILE_STAGE_FILES = [
  ".env",
  "config.yaml",
  "gateway.pid",
  "gateway-stderr.log",
  "state.db",
  "state.db-wal",
  "state.db-shm",
  "gateway.lock",
  ".gateway.lock",
  "skills/.bundled_manifest",
  "skills/.bundled_manifest.tmp",
  "logs/gateway.log",
  "logs/errors.log",
  "logs/gateway-exit-diag.log",
] as const;

function runtimeContractDiagnostic(
  event: string,
  fields: Readonly<Record<string, boolean | number | string | null>> = {},
): void {
  if (diagnosticOutput === null) return;
  try {
    appendFileSync(
      diagnosticOutput,
      `${JSON.stringify({
        schemaVersion: 1,
        event,
        elapsedMs: Math.round(performance.now() - diagnosticStartedAt),
        ...fields,
      })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  } catch {
    // Diagnostic persistence must never change the acceptance behavior.
  }
}

async function writeDiagnosticArtifact(
  filename: string,
  content: string,
): Promise<void> {
  if (diagnosticOutput === null) return;
  try {
    await writeFile(join(dirname(diagnosticOutput), filename), content, {
      encoding: "utf8",
      mode: 0o600,
    });
  } catch (error) {
    runtimeContractDiagnostic("diagnostic-artifact-write-failed", {
      filename,
      failure: diagnosticErrorClass(error),
    });
  }
}

function diagnosticErrorClass(error: unknown): string {
  if (error && typeof error === "object") {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z0-9_]{1,32}$/u.test(code)) {
      return code.toLowerCase();
    }
  }
  if (error instanceof Error && error.message === "diagnostic-timeout") {
    return "timeout";
  }
  return error instanceof Error && error.name
    ? error.name.replace(/[^A-Za-z0-9_-]/gu, "").toLowerCase() || "error"
    : "unknown";
}

interface ExternalCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runExternalCommand(
  file: string,
  args: readonly string[],
  options: Readonly<Record<string, unknown>>,
): Promise<ExternalCommandResult> {
  return new Promise((resolveCommand) => {
    execFile(file, [...args], options as never, (error, stdout, stderr) => {
      const code = error && typeof error.code === "number" ? error.code : null;
      resolveCommand({
        status: error === null ? 0 : code,
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? ""),
      });
    });
  });
}

const WINDOWS_GATEWAY_PROCESS_QUERY = `
$ErrorActionPreference = 'Stop'
$rows = @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
  $_.Name -match '^(python|pythonw)\\.exe$' -and
  $_.CommandLine -match 'hermes_cli\\.main|gateway'
})
if ($rows.Count -eq 0) {
  '[]'
} else {
  $rows | ForEach-Object {
    [ordered]@{
      ProcessId = [int]$_.ProcessId
      ParentProcessId = [int]$_.ParentProcessId
      Name = $_.Name
      ExecutablePath = $_.ExecutablePath
      CommandLine = $_.CommandLine
      CreationFileTimeUtc = if ($_.CreationDate) {
        $_.CreationDate.ToFileTimeUtc().ToString([Globalization.CultureInfo]::InvariantCulture)
      } else { $null }
      KernelModeTime100ns = $_.KernelModeTime
      UserModeTime100ns = $_.UserModeTime
      WorkingSetBytes = $_.WorkingSetSize
      ThreadCount = $_.ThreadCount
    }
  } | ConvertTo-Json -Compress
}`;

function normalizedDiagnosticPath(value: string | null | undefined): string {
  return String(value ?? "")
    .trim()
    .replaceAll("\\", "/")
    .toLowerCase();
}

function processUsesGatewayCommand(
  sample: WindowsGatewayProcessSample,
): boolean {
  const command = (sample.commandLine ?? "").toLowerCase();
  return command.includes("hermes_cli.main") && command.includes("gateway");
}

function processMatchesInstalledPython(
  sample: WindowsGatewayProcessSample,
  pythonExecutable: string,
): boolean {
  const expected = normalizedDiagnosticPath(pythonExecutable);
  const observed = normalizedDiagnosticPath(sample.executablePath);
  return Boolean(expected && observed === expected);
}

async function queryWindowsGatewayProcesses(
  pythonExecutable: string,
): Promise<WindowsGatewayProcessSample[]> {
  const result = await runExternalCommand(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      WINDOWS_GATEWAY_PROCESS_QUERY,
    ],
    {
      encoding: "utf8",
      timeout: EXTERNAL_GATEWAY_OBSERVER_TIMEOUT_MS,
      maxBuffer: EXTERNAL_GATEWAY_OBSERVER_MAX_OUTPUT_BYTES,
      windowsHide: true,
    },
  );
  if (result.status !== 0) {
    throw new Error("Windows Gateway process sample query failed");
  }
  return parseWindowsGatewayProcessSamples(result).filter(
    (sample) =>
      processMatchesInstalledPython(sample, pythonExecutable) ||
      processUsesGatewayCommand(sample),
  );
}

type ProfileStageFact = {
  exists: boolean;
  sizeBytes: number | null;
  mtimeMs: number | null;
  error: string | null;
};

async function readProfileStageFacts(
  profilePath: string,
): Promise<Record<string, ProfileStageFact>> {
  const entries = await Promise.all(
    PROFILE_STAGE_FILES.map(async (relativePath) => {
      try {
        const metadata = await stat(join(profilePath, relativePath));
        return [
          relativePath,
          {
            exists: true,
            sizeBytes: metadata.size,
            mtimeMs: Math.round(metadata.mtimeMs),
            error: null,
          },
        ] as const;
      } catch (error) {
        const code =
          error && typeof error === "object" && "code" in error
            ? String((error as { code?: unknown }).code ?? "error")
            : "error";
        return [
          relativePath,
          { exists: false, sizeBytes: null, mtimeMs: null, error: code },
        ] as const;
      }
    }),
  );
  return Object.fromEntries(entries);
}

function compactDiagnosticJson(value: unknown, maxChars = 6_000): string {
  try {
    return JSON.stringify(value).slice(0, maxChars);
  } catch {
    return "<unserializable>";
  }
}

function sanitizedProcessSample(
  sample: WindowsGatewayProcessSample,
  privateRoots: readonly string[],
  pythonExecutable: string,
): Record<string, boolean | number | string | null> {
  const command = sample.commandLine
    ? redactGatewayDiagnosticTail(sample.commandLine, privateRoots)
    : null;
  return {
    pid: sample.pid,
    parentPid: sample.parentPid,
    image: sample.name,
    executableMatchesInstalled: processMatchesInstalledPython(
      sample,
      pythonExecutable,
    ),
    creationIdentity: sample.creationIdentity,
    cpuSeconds: sample.cpuSeconds,
    workingSetBytes: sample.workingSetBytes,
    threadCount: sample.threadCount,
    commandShape: command,
    commandHasHermesMain: Boolean(
      sample.commandLine?.toLowerCase().includes("hermes_cli.main"),
    ),
    commandHasGateway: Boolean(
      sample.commandLine?.toLowerCase().includes("gateway"),
    ),
  };
}

interface GatewayLaunchObserver {
  stop(): Promise<void>;
}

function startGatewayLaunchObserver(options: {
  profilePath: string;
  pythonExecutable: string;
  privateRoots: readonly string[];
}): GatewayLaunchObserver {
  let stopped = false;
  let sampleNumber = 0;
  let inFlight: Promise<void> | null = null;
  let unsupportedReported = false;

  const collect = async (): Promise<void> => {
    sampleNumber += 1;
    const pidFile = await inspectGatewayPidFile(options.profilePath);
    const stageFacts = await readProfileStageFacts(options.profilePath);
    if (process.platform !== "win32") {
      if (!unsupportedReported) {
        unsupportedReported = true;
        runtimeContractDiagnostic("gateway-external-observer-unsupported", {
          platform: process.platform,
        });
      }
      runtimeContractDiagnostic("gateway-profile-stage-sample", {
        sample: sampleNumber,
        pidFileStatus: pidFile.status,
        pid: pidFile.pid,
        files: compactDiagnosticJson(stageFacts),
      });
      return;
    }

    let samples: WindowsGatewayProcessSample[];
    try {
      samples = await queryWindowsGatewayProcesses(options.pythonExecutable);
    } catch (error) {
      runtimeContractDiagnostic("gateway-external-observer-failed", {
        sample: sampleNumber,
        failure: diagnosticErrorClass(error),
      });
      return;
    }
    runtimeContractDiagnostic("gateway-external-observer-sample", {
      sample: sampleNumber,
      pidFileStatus: pidFile.status,
      pid: pidFile.pid,
      processCount: samples.length,
      pids: samples.map((sample) => sample.pid).join(","),
    });
    for (const sample of samples) {
      const safe = sanitizedProcessSample(
        sample,
        options.privateRoots,
        options.pythonExecutable,
      );
      runtimeContractDiagnostic("gateway-external-process-sample", {
        sample: sampleNumber,
        ...safe,
      });
    }
    runtimeContractDiagnostic("gateway-profile-stage-sample", {
      sample: sampleNumber,
      pidFileStatus: pidFile.status,
      pid: pidFile.pid,
      files: compactDiagnosticJson(stageFacts),
    });
  };

  const tick = (): void => {
    if (stopped || inFlight !== null) return;
    inFlight = collect()
      .catch((error) => {
        runtimeContractDiagnostic("gateway-external-observer-failed", {
          sample: sampleNumber,
          failure: diagnosticErrorClass(error),
        });
      })
      .finally(() => {
        inFlight = null;
      });
  };

  const timer = setInterval(tick, EXTERNAL_GATEWAY_OBSERVER_INTERVAL_MS);
  timer.unref?.();
  tick();

  return {
    async stop(): Promise<void> {
      stopped = true;
      clearInterval(timer);
      if (inFlight !== null) await inFlight;
      // One final snapshot catches a PID file/exit transition between the
      // last interval and the readiness call's resolution.
      try {
        await collect();
      } catch (error) {
        runtimeContractDiagnostic("gateway-external-observer-failed", {
          sample: sampleNumber,
          failure: diagnosticErrorClass(error),
        });
      }
    },
  };
}

async function collectBoundedRelativeInventory(
  root: string,
  maxEntries = 512,
): Promise<readonly Record<string, boolean | number | string | null>[]> {
  const entries: Array<Record<string, boolean | number | string | null>> = [];
  const queue: Array<{ directory: string; depth: number }> = [
    { directory: root, depth: 0 },
  ];
  while (queue.length > 0 && entries.length < maxEntries) {
    const current = queue.shift();
    if (!current) break;
    let children;
    try {
      children = await readdir(current.directory, { withFileTypes: true });
    } catch (error) {
      entries.push({
        path: relative(root, current.directory).split(sep).join("/") || ".",
        directory: true,
        error: diagnosticErrorClass(error),
      });
      continue;
    }
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      if (entries.length >= maxEntries) break;
      const childPath = join(current.directory, child.name);
      const relativePath = relative(root, childPath).split(sep).join("/");
      if (child.isSymbolicLink()) {
        entries.push({ path: relativePath, kind: "symlink" });
        continue;
      }
      if (child.isDirectory()) {
        entries.push({ path: relativePath, kind: "directory" });
        if (current.depth < 4) {
          queue.push({ directory: childPath, depth: current.depth + 1 });
        }
        continue;
      }
      try {
        const metadata = await stat(childPath);
        entries.push({
          path: relativePath,
          kind: "file",
          sizeBytes: metadata.size,
          mtimeMs: Math.round(metadata.mtimeMs),
        });
      } catch (error) {
        entries.push({
          path: relativePath,
          kind: "file",
          sizeBytes: null,
          mtimeMs: null,
          error: diagnosticErrorClass(error),
        });
      }
    }
  }
  return entries;
}

function appendElectronStderr(chunk: unknown): void {
  const value = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
  electronStderrTail = `${electronStderrTail}${value}`.slice(
    -MAIN_PROCESS_STDERR_READ_CHARS,
  );
  electronStderrCapture = `${electronStderrCapture}${value}`.slice(
    -MAX_CAPTURED_ELECTRON_STDERR_CHARS,
  );
}

async function withDiagnosticTimeout<T>(
  action: () => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      action(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("diagnostic-timeout")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

async function runCleanupBoundary(
  boundary: string,
  timeoutMs: number,
  action: () => Promise<unknown>,
): Promise<boolean> {
  const startedAt = performance.now();
  runtimeContractDiagnostic("cleanup-boundary-start", { boundary, timeoutMs });
  try {
    await withDiagnosticTimeout(action, timeoutMs);
    runtimeContractDiagnostic("cleanup-boundary-complete", {
      boundary,
      boundaryElapsedMs: Math.round(performance.now() - startedAt),
    });
    return true;
  } catch (error) {
    runtimeContractDiagnostic("cleanup-boundary-failed", {
      boundary,
      boundaryElapsedMs: Math.round(performance.now() - startedAt),
      failure: diagnosticErrorClass(error),
    });
    return false;
  }
}

function containedPath(root: string, target: string): boolean {
  const value = relative(resolve(root), resolve(target));
  return value.length > 0 && value !== ".." && !value.startsWith(`..${sep}`);
}

function classifyGatewayEndpointInspectionError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message === "Live Gateway PID is invalid") return "pid_invalid";
  if (message === "Live Gateway listening socket is unavailable") {
    return "listening_socket_unavailable";
  }
  if (message === "Live Gateway listening port is ambiguous or unavailable") {
    return "listening_port_ambiguous_or_unavailable";
  }
  return "unexpected";
}

function classifyCapabilityProbeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const status = message.match(/returned HTTP (\d{3})$/u)?.[1];
  if (status) return `http_${status}`;
  if (message === "Runtime request-scoped Agent capabilities are unavailable") {
    return "contract_unavailable";
  }
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return "timeout";
  }
  return "unexpected";
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return resolve(value);
}

function requiredSourceSha(): string {
  const value = process.env.AGENTERA_E2E_SOURCE_SHA?.trim() ?? "";
  if (!SHA1_PATTERN.test(value)) {
    throw new Error("AGENTERA_E2E_SOURCE_SHA must be a full source commit");
  }
  return value;
}

async function freeLoopbackPort(): Promise<number> {
  return new Promise<number>((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Could not reserve a loopback Gateway port"));
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolvePort(address.port);
      });
    });
  });
}

function dotenvValue(contents: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = contents.match(new RegExp(`^${escaped}=(.*)$`, "mu"));
  if (!match) return null;
  const value = match[1]?.trim() ?? "";
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value || null;
}

async function readRuntimeLock(): Promise<RuntimeLock> {
  const value = JSON.parse(
    await readFile(
      join(desktopRoot, "build", "agentera-runtime-seed.lock.json"),
      "utf8",
    ),
  ) as Record<string, unknown>;
  if (
    typeof value.runtime_version !== "string" ||
    value.runtime_version.length === 0 ||
    typeof value.source_commit !== "string" ||
    !SHA1_PATTERN.test(value.source_commit)
  ) {
    throw new Error("Runtime Seed lock identity is invalid");
  }
  return {
    runtime_version: value.runtime_version,
    source_commit: value.source_commit,
  };
}

async function readSeedManifestIdentity(
  seedDirectory: string,
): Promise<SeedManifestIdentity> {
  const entries = (await readdir(seedDirectory)).filter(
    (entry) => entry !== ".gitkeep",
  );
  const manifests = entries.filter((entry) => entry.endsWith(".manifest.json"));
  if (entries.length !== 3 || manifests.length !== 1 || !manifests[0]) {
    throw new Error("Packaged Runtime Seed must contain exactly three files");
  }
  const filename = manifests[0];
  const bytes = await readFile(join(seedDirectory, filename));
  const value = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
  if (
    typeof value.runtime_version !== "string" ||
    value.runtime_version.length === 0 ||
    typeof value.source_commit !== "string" ||
    !SHA1_PATTERN.test(value.source_commit)
  ) {
    throw new Error("Packaged Runtime Seed manifest identity is invalid");
  }
  return {
    filename,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    runtimeVersion: value.runtime_version,
    sourceCommit: value.source_commit,
  };
}

async function assertExactPackagedSeed(
  executablePath: string,
  seedDirectory: string,
): Promise<void> {
  const realExecutable = await realpath(executablePath);
  const expectedSeed =
    process.platform === "darwin"
      ? join(
          dirname(dirname(realExecutable)),
          "Resources",
          "agentera-runtime-seed",
        )
      : join(dirname(realExecutable), "resources", "agentera-runtime-seed");
  expect(await realpath(seedDirectory)).toBe(await realpath(expectedSeed));
}

async function waitForGatewayProcess(
  profilePath: string,
  pythonExecutable: string,
): Promise<LiveGatewayProcessEvidence> {
  let evidence: LiveGatewayProcessEvidence | null = null;
  let attempt = 0;
  let previousSnapshot = "";
  await expect
    .poll(
      async () => {
        attempt += 1;
        try {
          evidence = await inspectLiveGatewayProcess(
            profilePath,
            pythonExecutable,
          );
          runtimeContractDiagnostic("gateway-process-ready", {
            attempt,
            pid: evidence.pid,
          });
          return true;
        } catch (error) {
          const pidFile = await inspectGatewayPidFile(profilePath);
          const failure = classifyLiveGatewayProcessInspectionError(error);
          const snapshot = `${failure}:${pidFile.status}:${String(pidFile.pid)}`;
          if (snapshot !== previousSnapshot) {
            previousSnapshot = snapshot;
            runtimeContractDiagnostic("gateway-process-probe", {
              attempt,
              failure,
              pidFileStatus: pidFile.status,
              pid: pidFile.pid,
            });
          }
          return false;
        }
      },
      { timeout: 45_000 },
    )
    .toBe(true);
  if (evidence === null) {
    throw new Error("Live packaged Gateway process evidence is unavailable");
  }
  return evidence;
}

async function waitForGatewayEndpoint(
  pid: number,
): Promise<LiveGatewayEndpointEvidence> {
  let evidence: LiveGatewayEndpointEvidence | null = null;
  let attempt = 0;
  let previousFailure = "";
  await expect
    .poll(
      async () => {
        attempt += 1;
        try {
          evidence = await inspectLiveGatewayEndpoint(pid);
          runtimeContractDiagnostic("gateway-endpoint-ready", {
            attempt,
            pid,
            port: evidence.port,
          });
          return true;
        } catch (error) {
          const failure = classifyGatewayEndpointInspectionError(error);
          if (failure !== previousFailure) {
            previousFailure = failure;
            runtimeContractDiagnostic("gateway-endpoint-probe", {
              attempt,
              pid,
              failure,
            });
          }
          return false;
        }
      },
      { timeout: 45_000 },
    )
    .toBe(true);
  if (evidence === null) {
    throw new Error("Live packaged Gateway endpoint evidence is unavailable");
  }
  return evidence;
}

async function recordGatewayFailureEvidence(options: {
  profilePath: string;
  logPath: string | undefined;
  privateRoots: readonly string[];
  pythonExecutable?: string;
  versionRoot?: string;
  userDataPath?: string;
}): Promise<void> {
  const pidFile = await inspectGatewayPidFile(options.profilePath);
  const gatewayStatus = page
    ? await withDiagnosticTimeout(
        () =>
          page?.evaluate(() => window.hermesAPI.gatewayStatus()) ??
          Promise.resolve(null),
        5_000,
      ).catch(() => null)
    : null;
  runtimeContractDiagnostic("gateway-failure-snapshot", {
    pidFileStatus: pidFile.status,
    pid: pidFile.pid,
    rendererGatewayStatus: gatewayStatus,
    hasLogPath: Boolean(options.logPath),
  });

  const stageFacts = await readProfileStageFacts(options.profilePath);
  const profileInventory = await collectBoundedRelativeInventory(
    options.profilePath,
  );
  await writeDiagnosticArtifact(
    "gateway-profile-snapshot.json",
    `${JSON.stringify(
      {
        schemaVersion: 1,
        pidFile,
        stageFiles: stageFacts,
        inventory: profileInventory,
      },
      null,
      2,
    )}\n`,
  );
  runtimeContractDiagnostic("gateway-profile-snapshot-written", {
    inventoryCount: profileInventory.length,
    stageFileCount: PROFILE_STAGE_FILES.length,
  });

  const knownStateFiles = [
    ...(options.userDataPath
      ? [
          {
            name: "runtime-current",
            path: join(options.userDataPath, "runtime", "current.json"),
          },
          {
            name: "runtime-install-state",
            path: join(options.userDataPath, "runtime", "install-state.json"),
          },
        ]
      : []),
    ...(options.versionRoot
      ? [
          {
            name: "runtime-manifest",
            path: join(options.versionRoot, ".agentera-runtime-manifest.json"),
          },
        ]
      : []),
  ];
  for (const stateFile of knownStateFiles) {
    try {
      const metadata = await stat(stateFile.path);
      runtimeContractDiagnostic("gateway-state-file", {
        name: stateFile.name,
        exists: true,
        sizeBytes: metadata.size,
      });
    } catch (error) {
      runtimeContractDiagnostic("gateway-state-file", {
        name: stateFile.name,
        exists: false,
        failure: diagnosticErrorClass(error),
      });
    }
  }

  const logCandidates = [
    ...(options.logPath
      ? [{ name: "gateway-stderr", path: options.logPath }]
      : []),
    {
      name: "gateway-log",
      path: join(options.profilePath, "logs", "gateway.log"),
    },
    {
      name: "errors-log",
      path: join(options.profilePath, "logs", "errors.log"),
    },
    {
      name: "gateway-exit-diag",
      path: join(options.profilePath, "logs", "gateway-exit-diag.log"),
    },
  ];
  const seenLogPaths = new Set<string>();
  for (const candidate of logCandidates) {
    if (seenLogPaths.has(candidate.path)) continue;
    seenLogPaths.add(candidate.path);
    if (!containedPath(options.profilePath, candidate.path)) {
      runtimeContractDiagnostic("gateway-log-unavailable", {
        name: candidate.name,
        failure: "outside_profile",
      });
      continue;
    }
    try {
      const tail = await readRedactedGatewayLogTail(
        candidate.path,
        options.privateRoots,
      );
      runtimeContractDiagnostic("gateway-log-tail", {
        name: candidate.name,
        characters: tail.length,
        tail,
      });
      await writeDiagnosticArtifact(`${candidate.name}.log`, `${tail}\n`);
    } catch (error) {
      runtimeContractDiagnostic("gateway-log-unavailable", {
        name: candidate.name,
        failure: diagnosticErrorClass(error),
      });
    }
  }

  const mainTail = redactGatewayDiagnosticTail(
    electronStderrTail,
    options.privateRoots,
  );
  runtimeContractDiagnostic("electron-stderr-tail", {
    characters: mainTail.length,
    tail: mainTail,
  });
  const fullMainStderr = redactGatewayDiagnosticTail(
    electronStderrCapture,
    options.privateRoots,
  );
  await writeDiagnosticArtifact("electron-stderr-full.log", fullMainStderr);
  runtimeContractDiagnostic("electron-stderr-full", {
    characters: fullMainStderr.length,
  });

  if (options.pythonExecutable) {
    try {
      const samples = await queryWindowsGatewayProcesses(
        options.pythonExecutable,
      );
      runtimeContractDiagnostic("gateway-external-final-sample", {
        processCount: samples.length,
        pids: samples.map((sample) => sample.pid).join(","),
      });
      for (const sample of samples) {
        runtimeContractDiagnostic("gateway-external-final-process", {
          ...sanitizedProcessSample(
            sample,
            options.privateRoots,
            options.pythonExecutable,
          ),
        });
      }
    } catch (error) {
      runtimeContractDiagnostic("gateway-external-final-failed", {
        failure: diagnosticErrorClass(error),
      });
    }
  }
}

test.afterEach(async () => {
  if (gatewayLaunchObserver !== null) {
    await gatewayLaunchObserver.stop();
    gatewayLaunchObserver = null;
  }
  if (page) {
    await runCleanupBoundary(
      "gateway-stop",
      30_000,
      () =>
        page?.evaluate(() => window.hermesAPI.stopGateway()) ??
        Promise.resolve(),
    );
  }
  let electronClosed = true;
  if (app) {
    electronClosed = await runCleanupBoundary(
      "electron-close",
      90_000,
      () => app?.close() ?? Promise.resolve(),
    );
    if (!electronClosed && app.process().exitCode === null) {
      runtimeContractDiagnostic("cleanup-electron-force-kill", {
        attempted: true,
      });
      app.process().kill();
    }
  }
  app = null;
  page = null;
  if (temporaryRoot) {
    const root = temporaryRoot;
    await runCleanupBoundary("temporary-root-remove", 30_000, () =>
      rm(root, { recursive: true, force: true }),
    );
    temporaryRoot = "";
  }
  runtimeContractDiagnostic("test-cleanup-complete", { electronClosed });
  diagnosticOutput = null;
  electronStderrTail = "";
  electronStderrCapture = "";
});

// @lat: [[agentera-runtime-distribution#Release gate#Packaged live Runtime contract]]
// Playwright requires its fixtures argument to use object destructuring.
// eslint-disable-next-line no-empty-pattern
test("packaged Electron runs its installed locked Runtime and advertises Agent request contracts", async ({}) => {
  test.setTimeout(1_200_000);
  const executablePath = requiredEnvironment("AGENTERA_E2E_EXECUTABLE_PATH");
  const seedDirectory = requiredEnvironment("AGENTERA_RUNTIME_SEED_DIR");
  const evidenceOutput = requiredEnvironment(
    "AGENTERA_E2E_RUNTIME_CONTRACT_OUTPUT",
  );
  const sourceSha = requiredSourceSha();
  const lock = await readRuntimeLock();
  const seed = await readSeedManifestIdentity(seedDirectory);
  expect(seed.runtimeVersion).toBe(lock.runtime_version);
  expect(seed.sourceCommit).toBe(lock.source_commit);
  expect(seed.sha256).toMatch(SHA256_PATTERN);
  await assertExactPackagedSeed(executablePath, seedDirectory);

  temporaryRoot = await mkdtemp(join(tmpdir(), "aera-runtime-contract-"));
  const userData = join(temporaryRoot, "user-data");
  const hermesHome = join(temporaryRoot, "hermes-home");
  await Promise.all([
    mkdir(userData, { recursive: true, mode: 0o700 }),
    mkdir(hermesHome, { recursive: true, mode: 0o700 }),
    mkdir(dirname(evidenceOutput), { recursive: true }),
  ]);
  const requestedDiagnosticOutput =
    process.env.AGENTERA_E2E_RUNTIME_CONTRACT_DIAGNOSTIC_OUTPUT?.trim();
  if (requestedDiagnosticOutput) {
    diagnosticOutput = resolve(requestedDiagnosticOutput);
    electronStderrCapture = "";
    electronStderrTail = "";
    await mkdir(dirname(diagnosticOutput), { recursive: true });
    await writeFile(diagnosticOutput, "", { flag: "w", mode: 0o600 });
    diagnosticStartedAt = performance.now();
    runtimeContractDiagnostic("test-start", {
      platform: process.platform,
      architecture: process.arch,
    });
  }
  const gatewayPort = await freeLoopbackPort();

  app = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${userData}`],
    cwd: desktopRoot,
    env: {
      ...process.env,
      AGENTERA_E2E_DIAGNOSTICS: "1",
      AGENTERA_RUNTIME_SEED_DIR: seedDirectory,
      HERMES_DESKTOP_DEFAULT_API_PORT: String(gatewayPort),
      HERMES_DESKTOP_PORT_RANGE_START: String(gatewayPort + 1),
      HERMES_DESKTOP_USER_DATA_DIR: userData,
      HERMES_DISABLE_GPU: "1",
      HERMES_HOME: hermesHome,
      HERMES_OPEN_DEVTOOLS: "0",
      HERMES_DESKTOP_OPEN_DEVTOOLS: "0",
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
    },
  });
  app.process().stderr?.on("data", appendElectronStderr);
  app.process().once("exit", (code, signal) => {
    runtimeContractDiagnostic("electron-exit", { code, signal });
  });
  page = await app.firstWindow();

  await page.exposeFunction(
    "__aeraRecordRuntimeInstallProgress",
    (value: unknown) => {
      if (typeof value !== "object" || value === null) return;
      const progress = value as Record<string, unknown>;
      runtimeContractDiagnostic("install-progress", {
        step: typeof progress.step === "number" ? progress.step : -1,
        totalSteps:
          typeof progress.totalSteps === "number" ? progress.totalSteps : -1,
        detail:
          typeof progress.detail === "string"
            ? redactGatewayDiagnosticTail(progress.detail.slice(0, 160), [
                temporaryRoot,
                userData,
                hermesHome,
                seedDirectory,
                desktopRoot,
              ])
            : "invalid",
      });
    },
  );
  await page.evaluate(() => {
    const exposed = (
      window as unknown as {
        __aeraRecordRuntimeInstallProgress: (value: unknown) => Promise<void>;
      }
    ).__aeraRecordRuntimeInstallProgress;
    window.hermesAPI.onInstallProgress((progress) => {
      void exposed(progress);
    });
  });

  const desktopVersion = await app.evaluate(({ app: electronApp }) =>
    electronApp.getVersion(),
  );
  runtimeContractDiagnostic("install-invoke-start");
  const installHeartbeat = setInterval(
    () => runtimeContractDiagnostic("install-heartbeat"),
    15_000,
  );
  let install: Awaited<ReturnType<typeof window.hermesAPI.startInstall>>;
  try {
    install = await withDiagnosticTimeout(
      () => page!.evaluate(() => window.hermesAPI.startInstall()),
      600_000,
    );
    runtimeContractDiagnostic("install-invoke-complete", {
      success: install.success,
      errorCode: install.errorCode ?? null,
    });
  } catch (error) {
    runtimeContractDiagnostic("install-invoke-failed", {
      failure: diagnosticErrorClass(error),
    });
    throw error;
  } finally {
    clearInterval(installHeartbeat);
  }
  expect(install).toEqual({ success: true });
  // `start-install` returns only after the main process has synchronized its
  // long-lived manager and verified the exact installed version. A second
  // polling loop can overlap the renderer's queued progress/state messages on
  // heavily loaded hosted macOS runners: the first getState call then waits
  // behind that renderer work even though the authoritative install result is
  // already complete. Keep one independently bounded state read as evidence,
  // rather than retrying a potentially still-in-flight IPC call every 100ms.
  runtimeContractDiagnostic("runtime-state-probe-start", {
    timeoutMs: 120_000,
  });
  const runtimeState = await withDiagnosticTimeout(
    () => page!.evaluate(() => window.agenteraRuntimeDistribution.getState()),
    120_000,
  );
  runtimeContractDiagnostic("runtime-state-probe-complete", {
    phase: runtimeState?.phase ?? null,
    currentVersionMatches:
      runtimeState?.currentVersion === lock.runtime_version,
    currentSourceCommitMatches:
      runtimeState?.currentSourceCommit === lock.source_commit,
    lastErrorCode: runtimeState?.lastErrorCode ?? null,
  });
  expect(runtimeState).toMatchObject({
    phase: "current",
    currentVersion: lock.runtime_version,
    currentSourceCommit: lock.source_commit,
  });

  runtimeContractDiagnostic("installed-contract-inspection-start");
  const installed = await withDiagnosticTimeout(
    () => inspectInstalledRuntimeContract(userData),
    120_000,
  );
  runtimeContractDiagnostic("installed-contract-inspection-complete");
  expect(installed).toMatchObject({
    runtimeVersion: lock.runtime_version,
    sourceCommit: lock.source_commit,
    manifestSourceCommit: lock.source_commit,
  });
  expect(installed.manifestSha256).toBe(seed.sha256);
  expect(installed.pythonExecutable.sha256).toBe(
    installed.pythonExecutable.manifestSha256,
  );
  expect(installed.hermesEntrypoint.sha256).toBe(
    installed.hermesEntrypoint.manifestSha256,
  );

  runtimeContractDiagnostic("profile-bind-start");
  let profileBinding: Awaited<
    ReturnType<typeof window.agenteraRuntimeAccess.bindActiveProfile>
  >;
  try {
    profileBinding = await withDiagnosticTimeout(
      () =>
        page!.evaluate(() => window.agenteraRuntimeAccess.bindActiveProfile()),
      30_000,
    );
  } catch (error) {
    runtimeContractDiagnostic("profile-bind-failed", {
      failure: diagnosticErrorClass(error),
    });
    throw error;
  }
  runtimeContractDiagnostic("profile-bind-complete", {
    status: profileBinding.status,
  });
  expect(profileBinding).toMatchObject({ status: "bound" });
  const activeGateway = await inspectActiveGatewayProfile([
    {
      id: "default",
      path: hermesHome,
      isActive: true,
      isDefault: true,
    },
  ]);
  runtimeContractDiagnostic("gateway-invoke-start", { timeoutMs: 180_000 });
  gatewayLaunchObserver = startGatewayLaunchObserver({
    profilePath: activeGateway.profilePath,
    pythonExecutable: installed.pythonExecutable.path,
    privateRoots: [
      temporaryRoot,
      userData,
      hermesHome,
      installed.versionRoot,
      desktopRoot,
    ],
  });
  const gatewayHeartbeat = setInterval(
    () => runtimeContractDiagnostic("gateway-invoke-heartbeat"),
    10_000,
  );
  let gatewayStart: Awaited<ReturnType<typeof window.hermesAPI.startGateway>>;
  try {
    gatewayStart = await withDiagnosticTimeout(
      () => page!.evaluate(() => window.hermesAPI.startGateway()),
      180_000,
    );
    runtimeContractDiagnostic("gateway-invoke-complete", {
      success: gatewayStart.success,
      running: gatewayStart.running,
      ready: gatewayStart.ready ?? false,
      alreadyRunning: gatewayStart.alreadyRunning ?? false,
      hasError: Boolean(gatewayStart.error),
      hasLogPath: Boolean(gatewayStart.logPath),
      pid: gatewayStart.diagnostics?.pid ?? null,
      exitCode: gatewayStart.diagnostics?.exitCode ?? null,
      signal: gatewayStart.diagnostics?.signal ?? null,
      terminationForced: gatewayStart.diagnostics?.termination?.forced ?? false,
      remainingPidCount:
        gatewayStart.diagnostics?.termination?.remainingPids.length ?? 0,
      requestToolPolicy:
        gatewayStart.diagnostics?.capabilities?.requestToolPolicy ?? false,
      requestModelRoute:
        gatewayStart.diagnostics?.capabilities?.requestModelRoute ?? false,
    });
  } catch (error) {
    runtimeContractDiagnostic("gateway-invoke-failed", {
      failure: diagnosticErrorClass(error),
    });
    await recordGatewayFailureEvidence({
      profilePath: activeGateway.profilePath,
      logPath: join(activeGateway.profilePath, "gateway-stderr.log"),
      privateRoots: [temporaryRoot, userData, hermesHome, desktopRoot],
      pythonExecutable: installed.pythonExecutable.path,
      versionRoot: installed.versionRoot,
      userDataPath: userData,
    });
    throw error;
  } finally {
    clearInterval(gatewayHeartbeat);
    if (gatewayLaunchObserver !== null) {
      await gatewayLaunchObserver.stop();
      gatewayLaunchObserver = null;
    }
  }
  if (!gatewayStart.success || gatewayStart.ready !== true) {
    await recordGatewayFailureEvidence({
      profilePath: activeGateway.profilePath,
      logPath:
        gatewayStart.logPath ??
        join(activeGateway.profilePath, "gateway-stderr.log"),
      privateRoots: [
        temporaryRoot,
        userData,
        hermesHome,
        installed.versionRoot,
        desktopRoot,
      ],
      pythonExecutable: installed.pythonExecutable.path,
      versionRoot: installed.versionRoot,
      userDataPath: userData,
    });
  }
  expect(gatewayStart).toMatchObject({
    success: true,
    running: true,
    ready: true,
  });
  const apiKey = dotenvValue(
    await readFile(join(activeGateway.profilePath, ".env"), "utf8"),
    "API_SERVER_KEY",
  );
  expect(apiKey).not.toBeNull();

  const gatewayEvidence = await (async () => {
    const liveProcess = await waitForGatewayProcess(
      activeGateway.profilePath,
      installed.pythonExecutable.path,
    );
    expect(liveProcess.command).toContain("hermes_cli.main");
    expect(liveProcess.command).toMatch(/\bgateway\b/u);
    const liveEndpoint = await waitForGatewayEndpoint(liveProcess.pid);
    expect(liveEndpoint.port).toBe(gatewayPort);
    let capabilityAttempt = 0;
    let previousCapabilityFailure = "";
    await expect
      .poll(
        async () => {
          capabilityAttempt += 1;
          try {
            await probeRuntimeCapabilities(liveEndpoint.origin, apiKey ?? "");
            runtimeContractDiagnostic("gateway-capabilities-ready", {
              attempt: capabilityAttempt,
            });
            return true;
          } catch (error) {
            const failure = classifyCapabilityProbeError(error);
            if (failure !== previousCapabilityFailure) {
              previousCapabilityFailure = failure;
              runtimeContractDiagnostic("gateway-capabilities-probe", {
                attempt: capabilityAttempt,
                failure,
              });
            }
            return false;
          }
        },
        { timeout: 15_000 },
      )
      .toBe(true);
    const capabilities = await probeRuntimeCapabilities(
      liveEndpoint.origin,
      apiKey ?? "",
    );
    return { liveProcess, liveEndpoint, capabilities };
  })().catch(async (error: unknown) => {
    await recordGatewayFailureEvidence({
      profilePath: activeGateway.profilePath,
      logPath: gatewayStart.logPath,
      privateRoots: [
        temporaryRoot,
        userData,
        hermesHome,
        installed.versionRoot,
        desktopRoot,
      ],
      pythonExecutable: installed.pythonExecutable.path,
      versionRoot: installed.versionRoot,
      userDataPath: userData,
    });
    throw error;
  });
  const { liveProcess, liveEndpoint, capabilities } = gatewayEvidence;

  const evidence = {
    schemaVersion: 1,
    sourceSha,
    desktopVersion,
    platform: process.platform,
    architecture: process.arch,
    runtime: {
      runtimeVersion: installed.runtimeVersion,
      sourceCommit: installed.sourceCommit,
      versionDirectory: installed.versionDirectory,
      currentManifestSha256: installed.manifestSha256,
      manifestSourceCommit: installed.manifestSourceCommit,
      seedManifest: seed.filename,
      pythonSha256: installed.pythonExecutable.sha256,
      hermesEntrypointSha256: installed.hermesEntrypoint.sha256,
    },
    gateway: {
      profileId: activeGateway.profileId,
      pid: liveProcess.pid,
      address: liveEndpoint.address,
      port: liveEndpoint.port,
      installedPythonMatched: true,
      hermesEntrypointMatched: true,
    },
    capabilities,
  };
  const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
  expect(serialized).not.toContain(apiKey ?? "unavailable-runtime-key");
  expect(serialized).not.toContain(userData);
  expect(serialized).not.toContain(hermesHome);
  expect(serialized).not.toContain(installed.versionRoot);
  await writeFile(evidenceOutput, serialized, { flag: "wx", mode: 0o600 });
});
