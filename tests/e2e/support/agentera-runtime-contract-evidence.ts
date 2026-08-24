import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const VERSION_DIRECTORY_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._-]{0,254}$/u;

interface CurrentPointer {
  runtimeVersion: string;
  sourceCommit: string;
  versionDirectory: string;
  manifestSha256: string;
}

interface RuntimeManifestFile {
  path: string;
  kind: string;
  sha256: string | null;
}

interface RuntimeManifest {
  runtime_version: string;
  source_commit: string;
  files: RuntimeManifestFile[];
}

export interface RuntimeContractFileEvidence {
  path: string;
  realPath: string;
  sha256: string;
  manifestSha256: string;
}

export interface InstalledRuntimeContractEvidence {
  currentJson: string;
  runtimeVersion: string;
  sourceCommit: string;
  versionDirectory: string;
  versionRoot: string;
  manifestPath: string;
  manifestSourceCommit: string;
  pythonExecutable: RuntimeContractFileEvidence;
  hermesEntrypoint: RuntimeContractFileEvidence;
}

export interface LiveGatewayProcessEvidence {
  pid: number;
  executable: string;
  command: string;
}

export interface RuntimeProcessIdentity {
  executable: string;
  command: string;
}

export interface RuntimeCapabilitiesEvidence {
  features: {
    request_tool_policy: true;
    request_model_route: true;
  };
  endpoints: {
    chat_completions: { path: "/v1/chat/completions" };
  };
}

export interface RuntimeContractInspectionOptions {
  platform?: NodeJS.Platform;
}

export interface RuntimeProfileLocationEvidence {
  id: string;
  path: string;
  isActive: boolean;
  isDefault: boolean;
}

export interface ActiveGatewayProfileEvidence {
  profileId: string;
  profilePath: string;
  pidFile: string;
}

export interface RuntimeListeningSocket {
  address: string;
  port: number;
}

export interface LiveGatewayEndpointEvidence {
  address: "127.0.0.1";
  port: number;
  origin: string;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function parsePointer(value: unknown): CurrentPointer {
  const pointer = record(value, "Runtime current pointer");
  if (
    typeof pointer.runtimeVersion !== "string" ||
    pointer.runtimeVersion.length === 0 ||
    typeof pointer.sourceCommit !== "string" ||
    !COMMIT_PATTERN.test(pointer.sourceCommit) ||
    typeof pointer.versionDirectory !== "string" ||
    !VERSION_DIRECTORY_PATTERN.test(pointer.versionDirectory) ||
    pointer.versionDirectory === "." ||
    pointer.versionDirectory === ".." ||
    typeof pointer.manifestSha256 !== "string" ||
    !DIGEST_PATTERN.test(pointer.manifestSha256)
  ) {
    throw new Error("Runtime current pointer identity is invalid");
  }
  return {
    runtimeVersion: pointer.runtimeVersion,
    sourceCommit: pointer.sourceCommit,
    versionDirectory: pointer.versionDirectory,
    manifestSha256: pointer.manifestSha256,
  };
}

function parseManifest(value: unknown): RuntimeManifest {
  const manifest = record(value, "Installed Runtime manifest");
  if (
    typeof manifest.runtime_version !== "string" ||
    typeof manifest.source_commit !== "string" ||
    !COMMIT_PATTERN.test(manifest.source_commit) ||
    !Array.isArray(manifest.files)
  ) {
    throw new Error("Installed Runtime manifest identity is invalid");
  }
  const files = manifest.files.map((entry) => {
    const file = record(entry, "Installed Runtime manifest file");
    if (
      typeof file.path !== "string" ||
      typeof file.kind !== "string" ||
      (file.sha256 !== null && typeof file.sha256 !== "string")
    ) {
      throw new Error("Installed Runtime manifest file is invalid");
    }
    return {
      path: file.path,
      kind: file.kind,
      sha256: file.sha256,
    };
  });
  return {
    runtime_version: manifest.runtime_version,
    source_commit: manifest.source_commit,
    files,
  };
}

function containedRelativePath(root: string, target: string): string {
  const value = relative(root, target);
  if (
    value.length === 0 ||
    value === ".." ||
    value.startsWith(`..${sep}`) ||
    isAbsolute(value)
  ) {
    throw new Error("Runtime contract entry escapes its installed version");
  }
  return value.split(sep).join("/");
}

async function inspectManifestFile(
  versionRoot: string,
  path: string,
  manifest: RuntimeManifest,
): Promise<RuntimeContractFileEvidence> {
  const realVersionRoot = await realpath(versionRoot);
  const realPath = await realpath(path);
  const manifestPath = containedRelativePath(realVersionRoot, realPath);
  const entry = manifest.files.find(
    (candidate) => candidate.path === manifestPath && candidate.kind === "file",
  );
  if (!entry || !entry.sha256 || !DIGEST_PATTERN.test(entry.sha256)) {
    throw new Error(`Installed Runtime manifest omits ${manifestPath}`);
  }
  const sha256 = createHash("sha256")
    .update(await readFile(realPath))
    .digest("hex");
  if (sha256 !== entry.sha256) {
    throw new Error(`Installed Runtime file hash differs for ${manifestPath}`);
  }
  return {
    path,
    realPath,
    sha256,
    manifestSha256: entry.sha256,
  };
}

export async function inspectInstalledRuntimeContract(
  userDataPath: string,
  options: RuntimeContractInspectionOptions = {},
): Promise<InstalledRuntimeContractEvidence> {
  const currentJson = join(resolve(userDataPath), "runtime", "current.json");
  const pointer = parsePointer(
    JSON.parse(await readFile(currentJson, "utf8")) as unknown,
  );
  const versionsRoot = await realpath(
    join(resolve(userDataPath), "runtime", "versions"),
  );
  const versionRoot = await realpath(
    join(versionsRoot, pointer.versionDirectory),
  );
  containedRelativePath(versionsRoot, versionRoot);

  const manifestPath = join(versionRoot, ".agentera-runtime-manifest.json");
  const manifestBytes = await readFile(manifestPath);
  const manifestSha256 = createHash("sha256")
    .update(manifestBytes)
    .digest("hex");
  if (manifestSha256 !== pointer.manifestSha256) {
    throw new Error(
      "Installed Runtime manifest hash differs from current pointer",
    );
  }
  const manifest = parseManifest(
    JSON.parse(manifestBytes.toString("utf8")) as unknown,
  );
  if (
    manifest.runtime_version !== pointer.runtimeVersion ||
    manifest.source_commit !== pointer.sourceCommit
  ) {
    throw new Error("Installed Runtime pointer and manifest disagree");
  }

  const pythonExecutable = join(
    versionRoot,
    "python",
    options.platform === "win32" ||
      (options.platform === undefined && process.platform === "win32")
      ? "python.exe"
      : "bin/python3",
  );
  const hermesEntrypoint = join(
    versionRoot,
    "python",
    options.platform === "win32" ||
      (options.platform === undefined && process.platform === "win32")
      ? "Lib"
      : "lib/python3.11",
    "site-packages",
    "hermes_cli",
    "main.py",
  );
  return {
    currentJson,
    runtimeVersion: pointer.runtimeVersion,
    sourceCommit: pointer.sourceCommit,
    versionDirectory: pointer.versionDirectory,
    versionRoot,
    manifestPath,
    manifestSourceCommit: manifest.source_commit,
    pythonExecutable: await inspectManifestFile(
      versionRoot,
      pythonExecutable,
      manifest,
    ),
    hermesEntrypoint: await inspectManifestFile(
      versionRoot,
      hermesEntrypoint,
      manifest,
    ),
  };
}

export async function inspectActiveGatewayProfile(
  profiles: readonly RuntimeProfileLocationEvidence[],
): Promise<ActiveGatewayProfileEvidence> {
  const activeProfiles = profiles.filter((profile) => profile.isActive);
  if (activeProfiles.length !== 1) {
    throw new Error("Runtime contract evidence requires one active Profile");
  }
  const active = activeProfiles[0];
  if (!active || !active.id.trim() || !active.path.trim()) {
    throw new Error("Active Runtime Profile identity is invalid");
  }
  const profilePath = resolve(active.path);
  return {
    profileId: active.id,
    profilePath,
    pidFile: join(profilePath, "gateway.pid"),
  };
}

function parseListeningSocketAddress(
  value: string,
): RuntimeListeningSocket | null {
  const trimmed = value.trim();
  const match = trimmed.match(/^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/u);
  if (!match) return null;
  const address = (match[1] ?? match[2] ?? "").trim();
  const port = Number.parseInt(match[3] ?? "", 10);
  if (
    !["127.0.0.1", "::1", "localhost"].includes(address) ||
    !Number.isSafeInteger(port) ||
    port <= 0 ||
    port >= 65_536
  ) {
    return null;
  }
  return { address, port };
}

async function defaultListeningSocketReader(
  pid: number,
): Promise<RuntimeListeningSocket[]> {
  if (process.platform === "win32") {
    const result = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$rows=@(Get-NetTCPConnection -State Listen -OwningProcess ${String(pid)} -ErrorAction Stop | Select-Object LocalAddress,LocalPort); $rows|ConvertTo-Json -Compress`,
      ],
      { encoding: "utf8", stdio: "pipe" },
    );
    if (result.status !== 0 || !result.stdout.trim()) {
      throw new Error("Live Gateway listening socket is unavailable");
    }
    const parsed = JSON.parse(result.stdout) as unknown;
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.flatMap((entry) => {
      const row = record(entry, "Live Gateway listening socket");
      const socket = parseListeningSocketAddress(
        `${String(row.LocalAddress ?? "")}:${String(row.LocalPort ?? "")}`,
      );
      return socket ? [socket] : [];
    });
  }

  const result = spawnSync(
    "lsof",
    ["-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-Fn"],
    { encoding: "utf8", stdio: "pipe" },
  );
  if (result.status !== 0 || !result.stdout.trim()) {
    throw new Error("Live Gateway listening socket is unavailable");
  }
  return result.stdout
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("n"))
    .flatMap((line) => {
      const socket = parseListeningSocketAddress(line.slice(1));
      return socket ? [socket] : [];
    });
}

export async function inspectLiveGatewayEndpoint(
  pid: number,
  readListeningSockets: (
    pid: number,
  ) => Promise<RuntimeListeningSocket[]> = defaultListeningSocketReader,
): Promise<LiveGatewayEndpointEvidence> {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error("Live Gateway PID is invalid");
  }
  const sockets = await readListeningSockets(pid);
  const ports = [...new Set(sockets.map((socket) => socket.port))];
  if (ports.length !== 1 || ports[0] === undefined) {
    throw new Error("Live Gateway listening port is ambiguous or unavailable");
  }
  return {
    address: "127.0.0.1",
    port: ports[0],
    origin: `http://127.0.0.1:${String(ports[0])}`,
  };
}

async function canonicalPath(path: string): Promise<string> {
  return realpath(path).catch(() => resolve(path));
}

function commandExecutable(command: string): string | null {
  const quoted = command.match(/^"([^"]+)"(?:\s|$)/u);
  if (quoted?.[1]) return quoted[1];
  return command.match(/^(\S+)(?:\s|$)/u)?.[1] ?? null;
}

async function defaultProcessIdentityReader(
  pid: number,
): Promise<RuntimeProcessIdentity> {
  if (process.platform === "win32") {
    const result = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$p=Get-CimInstance Win32_Process -Filter "ProcessId = ${String(pid)}"; if($null -eq $p){exit 1}; @{executable=$p.ExecutablePath;command=$p.CommandLine}|ConvertTo-Json -Compress`,
      ],
      { encoding: "utf8", stdio: "pipe" },
    );
    if (result.status !== 0 || !result.stdout.trim()) {
      throw new Error("Live Runtime process identity is unavailable");
    }
    const value = record(
      JSON.parse(result.stdout) as unknown,
      "Live Runtime process identity",
    );
    if (
      typeof value.executable !== "string" ||
      typeof value.command !== "string"
    ) {
      throw new Error("Live Runtime process identity is invalid");
    }
    return { executable: value.executable, command: value.command };
  }

  const commandResult = spawnSync(
    "ps",
    ["-ww", "-p", String(pid), "-o", "command="],
    { encoding: "utf8", stdio: "pipe" },
  );
  if (commandResult.status !== 0 || !commandResult.stdout.trim()) {
    throw new Error("Live Runtime process command is unavailable");
  }
  if (process.platform === "linux") {
    return {
      executable: await realpath(`/proc/${String(pid)}/exe`),
      command: commandResult.stdout.trim(),
    };
  }
  const executableResult = spawnSync(
    "lsof",
    ["-a", "-p", String(pid), "-d", "txt", "-Fn"],
    { encoding: "utf8", stdio: "pipe" },
  );
  const executable = executableResult.stdout
    .split(/\r?\n/u)
    .find((line) => line.startsWith("n"))
    ?.slice(1);
  if (executableResult.status !== 0 || !executable) {
    throw new Error("Live Runtime process executable is unavailable");
  }
  return { executable, command: commandResult.stdout.trim() };
}

export async function inspectLiveGatewayProcess(
  hermesHome: string,
  pythonExecutable: string,
  readProcessIdentity: (
    pid: number,
  ) => Promise<RuntimeProcessIdentity> = defaultProcessIdentityReader,
): Promise<LiveGatewayProcessEvidence> {
  const raw = (await readFile(join(hermesHome, "gateway.pid"), "utf8")).trim();
  const parsed = raw.startsWith("{")
    ? (record(JSON.parse(raw) as unknown, "Gateway PID record").pid as unknown)
    : Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || Number(parsed) <= 0) {
    throw new Error("Gateway PID record is invalid");
  }
  const pid = Number(parsed);
  const identity = await readProcessIdentity(pid);
  const command = identity.command.trim();
  const executable = identity.executable.trim();
  const invokedExecutable = commandExecutable(command);
  if (
    (await canonicalPath(executable)) !==
    (await canonicalPath(pythonExecutable))
  ) {
    throw new Error(
      "Live Gateway executable differs from installed Runtime Python",
    );
  }
  if (
    invokedExecutable === null ||
    (await canonicalPath(invokedExecutable)) !==
      (await canonicalPath(pythonExecutable))
  ) {
    throw new Error("Live Gateway is not using the installed Runtime Python");
  }
  return { pid, executable, command };
}

export async function probeRuntimeCapabilities(
  origin: string,
  apiKey: string,
  fetcher: typeof fetch = fetch,
): Promise<RuntimeCapabilitiesEvidence> {
  const response = await fetcher(
    `${origin.replace(/\/+$/u, "")}/v1/capabilities`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(5_000),
    },
  );
  if (response.status !== 200) {
    throw new Error(
      `Runtime capabilities endpoint returned HTTP ${String(response.status)}`,
    );
  }
  const value = record(await response.json(), "Runtime capabilities");
  const features = record(value.features, "Runtime capability features");
  const endpoints = record(value.endpoints, "Runtime capability endpoints");
  const chat = record(
    endpoints.chat_completions,
    "Runtime chat completions capability",
  );
  if (
    features.request_tool_policy !== true ||
    features.request_model_route !== true ||
    chat.path !== "/v1/chat/completions"
  ) {
    throw new Error(
      "Runtime request-scoped Agent capabilities are unavailable",
    );
  }
  return {
    features: {
      request_tool_policy: true,
      request_model_route: true,
    },
    endpoints: {
      chat_completions: { path: "/v1/chat/completions" },
    },
  };
}
