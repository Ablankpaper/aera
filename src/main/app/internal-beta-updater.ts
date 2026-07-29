import {
  createHash,
  createPublicKey,
  randomUUID,
  verify as verifySignature,
} from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import extractZip from "extract-zip";

import {
  canonicalJsonBytes,
  parseJsonObjectRejectDuplicates,
  requireExactObjectFields,
} from "../agentera-runtime-distribution/manifest";
import { downloadWithResume } from "../agentera-runtime-distribution/downloader";

export type DesktopUpdateState =
  | "available"
  | "downloading"
  | "ready"
  | "error"
  | "checking"
  | "uptodate"
  | null;

export interface DesktopUpdateSnapshot {
  state: DesktopUpdateState;
  version: string | null;
  releaseNotes: string | null;
  percent: number | null;
  error: string | null;
}

type SupportedPlatform = "darwin" | "win32";
type SupportedArch = "arm64" | "x64";

export interface DesktopUpdateArtifact extends Record<string, unknown> {
  platform: SupportedPlatform;
  arch: SupportedArch;
  kind: "zip" | "nsis";
  name: string;
  size: number;
  sha256: string;
  sha512: string;
  url: string;
}

export interface DesktopUpdateManifest extends Record<string, unknown> {
  schema_version: 1;
  key_id: string;
  channel: "internal-beta";
  version: string;
  published_at: string;
  release_notes: string;
  artifacts: DesktopUpdateArtifact[];
}

export interface DesktopUpdateOffer {
  manifest: DesktopUpdateManifest;
  manifestBytes: Buffer;
  signatureBytes: Buffer;
  artifact: DesktopUpdateArtifact;
}

export interface MetadataTransport {
  get(url: URL, signal: AbortSignal): Promise<Buffer>;
}

export interface ArtifactDownloadRequest {
  url: URL;
  destination: string;
  expectedSize: number;
  expectedSha256: string;
  signal: AbortSignal;
  onProgress: (received: number, total: number) => void;
}

export interface InternalBetaUpdaterOptions {
  currentVersion: string;
  platform: SupportedPlatform;
  arch: SupportedArch;
  userDataPath: string;
  currentAppPath: string | null;
  baseUrl: URL;
  trustedPublicKeys: ReadonlyMap<string, string>;
  autoDownload: boolean;
  onState: (snapshot: DesktopUpdateSnapshot) => void;
  log: {
    info(message?: unknown): void;
    warn(message?: unknown): void;
    error(message?: unknown): void;
  };
  metadataTransport?: MetadataTransport;
  downloadArtifact?: (request: ArtifactDownloadRequest) => Promise<void>;
  prepareArtifact?: (
    offer: DesktopUpdateOffer,
    artifactPath: string,
    stagingDirectory: string,
  ) => Promise<void>;
  installArtifact?: (
    pending: PendingDesktopUpdate,
    context: InstallContext,
  ) => Promise<void>;
}

export interface PendingDesktopUpdate {
  offer: DesktopUpdateOffer;
  artifactPath: string;
  stagingDirectory: string;
}

export interface InstallContext {
  root: string;
  currentAppPath: string | null;
  platform: SupportedPlatform;
  currentVersion: string;
}

const execFile = promisify(execFileCallback);
const VERSION_PATTERN =
  /^([0-9]+)\.([0-9]+)\.([0-9]+)-internal-beta\.([1-9][0-9]*)$/;
const FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SHA512_PATTERN = /^[A-Za-z0-9+/]{86}==$/;
const ISO_SECONDS_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const MANIFEST_FIELDS = [
  "artifacts",
  "channel",
  "key_id",
  "published_at",
  "release_notes",
  "schema_version",
  "version",
] as const;
const ARTIFACT_FIELDS = [
  "arch",
  "kind",
  "name",
  "platform",
  "sha256",
  "sha512",
  "size",
  "url",
] as const;
const SIGNATURE_FIELDS = [
  "algorithm",
  "key_id",
  "schema_version",
  "signature_base64",
] as const;
const PENDING_FIELDS = ["schema_version", "version"] as const;
const INSTALL_JOURNAL_FIELDS = [
  "backup_path",
  "current_app_path",
  "schema_version",
  "success_marker",
  "target_version",
] as const;
const METADATA_LIMIT = 128 * 1024;
const METADATA_TIMEOUT_MS = 20_000;
const UPDATE_ERROR_MESSAGE = "更新失败，请稍后重试。";

class DesktopUpdateError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DesktopUpdateError";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseInternalBetaVersion(value: string): bigint[] {
  const match = VERSION_PATTERN.exec(value.trim());
  if (!match) {
    throw new DesktopUpdateError("Desktop update version is invalid");
  }
  return match.slice(1).map((part) => BigInt(part));
}

export function compareInternalBetaVersions(
  left: string,
  right: string,
): number {
  const leftParts = parseInternalBetaVersion(left);
  const rightParts = parseInternalBetaVersion(right);
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] === rightParts[index]) continue;
    return leftParts[index] < rightParts[index] ? -1 : 1;
  }
  return 0;
}

function assertOwnedPath(root: string, path: string, label: string): string {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(path);
  const fragment = relative(resolvedRoot, resolvedPath);
  if (
    fragment.length === 0 ||
    fragment === ".." ||
    fragment.startsWith(`..${sep}`) ||
    isAbsolute(fragment)
  ) {
    throw new DesktopUpdateError(`${label} is outside the update directory`);
  }
  return resolvedPath;
}

function requireString(
  value: Record<string, unknown>,
  field: string,
  label: string,
): string {
  const item = value[field];
  if (typeof item !== "string" || item.length === 0) {
    throw new DesktopUpdateError(`${label}.${field} is invalid`);
  }
  return item;
}

function parseCanonicalObject(
  raw: Buffer,
  label: string,
): Record<string, unknown> {
  const value = parseJsonObjectRejectDuplicates(raw, label);
  if (!canonicalJsonBytes(value).equals(raw)) {
    throw new DesktopUpdateError(`${label} is not canonical JSON`);
  }
  return value;
}

function validateArtifact(
  value: unknown,
  index: number,
  manifestVersion: string,
  baseUrl: URL,
): DesktopUpdateArtifact {
  const label = `Desktop update artifact ${index}`;
  if (!isObject(value)) {
    throw new DesktopUpdateError(`${label} must be an object`);
  }
  requireExactObjectFields(value, ARTIFACT_FIELDS, label);
  const platform = value.platform;
  const arch = value.arch;
  const kind = value.kind;
  if (
    (platform !== "darwin" && platform !== "win32") ||
    (arch !== "arm64" && arch !== "x64") ||
    (kind !== "zip" && kind !== "nsis") ||
    (platform === "darwin" && (arch !== "arm64" || kind !== "zip")) ||
    (platform === "win32" && (arch !== "x64" || kind !== "nsis"))
  ) {
    throw new DesktopUpdateError(`${label} target is invalid`);
  }
  const name = requireString(value, "name", label);
  const expectedName =
    platform === "darwin"
      ? `Aera-Internal-Beta-${manifestVersion}-macos-arm64.zip`
      : `Aera-Internal-Beta-${manifestVersion}-windows-x64-setup.exe`;
  if (!FILE_NAME_PATTERN.test(name) || name !== expectedName) {
    throw new DesktopUpdateError(`${label} filename is invalid`);
  }
  if (!Number.isSafeInteger(value.size) || (value.size as number) <= 0) {
    throw new DesktopUpdateError(`${label} size is invalid`);
  }
  const sha256 = requireString(value, "sha256", label);
  const sha512 = requireString(value, "sha512", label);
  if (!SHA256_PATTERN.test(sha256) || !SHA512_PATTERN.test(sha512)) {
    throw new DesktopUpdateError(`${label} digest is invalid`);
  }
  const urlText = requireString(value, "url", label);
  let url: URL;
  try {
    url = new URL(urlText);
  } catch {
    throw new DesktopUpdateError(`${label} URL is invalid`);
  }
  const expectedPath = `${baseUrl.pathname.replace(/\/$/u, "")}/releases/${manifestVersion}/${name}`;
  if (
    url.origin !== baseUrl.origin ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    url.pathname !== expectedPath
  ) {
    throw new DesktopUpdateError(`${label} URL is outside the update channel`);
  }
  return {
    platform,
    arch,
    kind,
    name,
    size: value.size as number,
    sha256,
    sha512,
    url: url.href,
  };
}

export function verifyDesktopUpdateMetadata(options: {
  manifestBytes: Buffer;
  signatureBytes: Buffer;
  baseUrl: URL;
  trustedPublicKeys: ReadonlyMap<string, string>;
}): DesktopUpdateManifest {
  const manifestValue = parseCanonicalObject(
    options.manifestBytes,
    "Desktop update manifest",
  );
  requireExactObjectFields(
    manifestValue,
    MANIFEST_FIELDS,
    "Desktop update manifest",
  );
  if (
    manifestValue.schema_version !== 1 ||
    manifestValue.channel !== "internal-beta"
  ) {
    throw new DesktopUpdateError("Desktop update manifest identity is invalid");
  }
  const keyId = requireString(
    manifestValue,
    "key_id",
    "Desktop update manifest",
  );
  const version = requireString(
    manifestValue,
    "version",
    "Desktop update manifest",
  );
  parseInternalBetaVersion(version);
  if (
    typeof manifestValue.published_at !== "string" ||
    !ISO_SECONDS_PATTERN.test(manifestValue.published_at) ||
    Number.isNaN(new Date(manifestValue.published_at).valueOf())
  ) {
    throw new DesktopUpdateError("Desktop update timestamp is invalid");
  }
  if (
    typeof manifestValue.release_notes !== "string" ||
    manifestValue.release_notes.length === 0 ||
    manifestValue.release_notes.length > 2_000
  ) {
    throw new DesktopUpdateError("Desktop update release notes are invalid");
  }
  if (
    !Array.isArray(manifestValue.artifacts) ||
    manifestValue.artifacts.length !== 2
  ) {
    throw new DesktopUpdateError("Desktop update artifacts are incomplete");
  }
  const artifacts = manifestValue.artifacts.map((artifact, index) =>
    validateArtifact(artifact, index, version, options.baseUrl),
  );
  if (
    `${artifacts[0].platform}-${artifacts[0].arch}` !== "darwin-arm64" ||
    `${artifacts[1].platform}-${artifacts[1].arch}` !== "win32-x64"
  ) {
    throw new DesktopUpdateError(
      "Desktop update targets must be unique and sorted",
    );
  }

  const signatureValue = parseCanonicalObject(
    options.signatureBytes,
    "Desktop update signature",
  );
  requireExactObjectFields(
    signatureValue,
    SIGNATURE_FIELDS,
    "Desktop update signature",
  );
  const signatureKeyId = requireString(
    signatureValue,
    "key_id",
    "Desktop update signature",
  );
  const signatureText = requireString(
    signatureValue,
    "signature_base64",
    "Desktop update signature",
  );
  if (
    signatureValue.schema_version !== 1 ||
    signatureValue.algorithm !== "Ed25519" ||
    signatureKeyId !== keyId
  ) {
    throw new DesktopUpdateError(
      "Desktop update signature identity is invalid",
    );
  }
  const publicKeyPem = options.trustedPublicKeys.get(keyId);
  if (!publicKeyPem) {
    throw new DesktopUpdateError("Desktop update signing key is not trusted");
  }
  let publicKey;
  try {
    publicKey = createPublicKey(publicKeyPem);
  } catch (error) {
    throw new DesktopUpdateError(
      "Desktop update trusted public key is invalid",
      { cause: error },
    );
  }
  const signature = Buffer.from(signatureText, "base64");
  if (
    publicKey.asymmetricKeyType !== "ed25519" ||
    signature.length !== 64 ||
    signature.toString("base64") !== signatureText ||
    !verifySignature(null, options.manifestBytes, publicKey, signature)
  ) {
    throw new DesktopUpdateError("Desktop update signature is invalid");
  }
  return {
    schema_version: 1,
    key_id: keyId,
    channel: "internal-beta",
    version,
    published_at: manifestValue.published_at,
    release_notes: manifestValue.release_notes,
    artifacts,
  };
}

function createMetadataSignal(signal: AbortSignal): {
  signal: AbortSignal;
  dispose(): void;
} {
  const controller = new AbortController();
  const onAbort = (): void => controller.abort(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) controller.abort(signal.reason);
  const timer = setTimeout(() => controller.abort(), METADATA_TIMEOUT_MS);
  timer.unref?.();
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    },
  };
}

class FetchMetadataTransport implements MetadataTransport {
  async get(url: URL, signal: AbortSignal): Promise<Buffer> {
    const operation = createMetadataSignal(signal);
    try {
      const response = await fetch(url, {
        method: "GET",
        redirect: "error",
        signal: operation.signal,
        headers: {
          Accept: "application/json",
          "User-Agent": "AgentEra-Studio-Desktop-Updater",
        },
      });
      if (!response.ok || response.body === null) {
        throw new DesktopUpdateError(
          `Desktop update metadata returned HTTP ${response.status}`,
        );
      }
      const declaredLength = response.headers.get("content-length");
      if (
        declaredLength !== null &&
        (!/^(?:0|[1-9][0-9]*)$/.test(declaredLength) ||
          Number(declaredLength) > METADATA_LIMIT)
      ) {
        throw new DesktopUpdateError("Desktop update metadata is too large");
      }
      const chunks: Buffer[] = [];
      let received = 0;
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        const bytes = Buffer.from(chunk);
        received += bytes.length;
        if (received > METADATA_LIMIT) {
          throw new DesktopUpdateError("Desktop update metadata is too large");
        }
        chunks.push(bytes);
      }
      return Buffer.concat(chunks, received);
    } catch (error) {
      if (signal.aborted) {
        throw new DesktopUpdateError("Desktop update check was cancelled");
      }
      if (error instanceof DesktopUpdateError) throw error;
      throw new DesktopUpdateError("Desktop update metadata request failed", {
        cause: error,
      });
    } finally {
      operation.dispose();
    }
  }
}

async function fileDigest(path: string): Promise<{
  size: number;
  sha256: string;
  sha512: string;
}> {
  const sha256 = createHash("sha256");
  const sha512 = createHash("sha512");
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (!Number.isSafeInteger(size)) {
      throw new DesktopUpdateError("Desktop update artifact is too large");
    }
    sha256.update(bytes);
    sha512.update(bytes);
  }
  return {
    size,
    sha256: sha256.digest("hex"),
    sha512: sha512.digest("base64"),
  };
}

async function writePrivateFileAtomic(
  path: string,
  bytes: Uint8Array,
): Promise<void> {
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporaryPath, bytes, { flag: "wx", mode: 0o600 });
    await rm(path, { force: true });
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function verifyArtifactFile(
  path: string,
  artifact: DesktopUpdateArtifact,
): Promise<void> {
  const info = await stat(path);
  if (!info.isFile()) {
    throw new DesktopUpdateError("Desktop update artifact is not a file");
  }
  const digest = await fileDigest(path);
  if (
    digest.size !== artifact.size ||
    digest.sha256 !== artifact.sha256 ||
    digest.sha512 !== artifact.sha512
  ) {
    throw new DesktopUpdateError("Desktop update artifact integrity failed");
  }
}

async function commandOutput(command: string, args: string[]): Promise<string> {
  const result = await execFile(command, args, {
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 64 * 1024,
  });
  return result.stdout.trim();
}

async function defaultPrepareArtifact(
  offer: DesktopUpdateOffer,
  artifactPath: string,
  stagingDirectory: string,
): Promise<void> {
  if (offer.artifact.platform === "win32") return;
  await rm(stagingDirectory, { recursive: true, force: true });
  await mkdir(stagingDirectory, { recursive: true, mode: 0o700 });
  await extractZip(artifactPath, { dir: stagingDirectory });
  const children = await readdir(stagingDirectory);
  if (
    children.length !== 1 ||
    !children[0].endsWith(".app") ||
    children[0].includes("/")
  ) {
    throw new DesktopUpdateError(
      "Desktop update archive must contain exactly one app",
    );
  }
  const appPath = join(stagingDirectory, children[0]);
  const info = await lstat(appPath);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new DesktopUpdateError("Desktop update app bundle is invalid");
  }
  const infoPlist = join(appPath, "Contents", "Info.plist");
  const version = await commandOutput("/usr/bin/plutil", [
    "-extract",
    "CFBundleShortVersionString",
    "raw",
    "-o",
    "-",
    infoPlist,
  ]);
  const bundleIdentifier = await commandOutput("/usr/bin/plutil", [
    "-extract",
    "CFBundleIdentifier",
    "raw",
    "-o",
    "-",
    infoPlist,
  ]);
  if (
    version !== offer.manifest.version ||
    bundleIdentifier !== "com.bignormal.agentera.studio"
  ) {
    throw new DesktopUpdateError("Desktop update app identity differs");
  }
  const executableName = await commandOutput("/usr/bin/plutil", [
    "-extract",
    "CFBundleExecutable",
    "raw",
    "-o",
    "-",
    infoPlist,
  ]);
  if (
    executableName.length === 0 ||
    executableName.includes("/") ||
    executableName.includes("\\")
  ) {
    throw new DesktopUpdateError("Desktop update executable name is invalid");
  }
  const executable = join(appPath, "Contents", "MacOS", executableName);
  const architectures = await commandOutput("/usr/bin/lipo", [
    "-archs",
    executable,
  ]);
  if (!architectures.split(/\s+/u).includes("arm64")) {
    throw new DesktopUpdateError("Desktop update app is not Apple Silicon");
  }
}

function safeMacAppPath(path: string | null): string {
  if (
    !path ||
    !isAbsolute(path) ||
    !path.endsWith(".app") ||
    path.includes("/AppTranslocation/") ||
    path.startsWith("/Volumes/")
  ) {
    throw new DesktopUpdateError(
      "请先将 AgentEra Studio 安装到“应用程序”目录后再更新。",
    );
  }
  return resolve(path);
}

export function buildMacUpdateHelperScript(options?: {
  processWaitAttempts?: number;
  healthyWaitAttempts?: number;
}): string {
  const processWaitAttempts = options?.processWaitAttempts ?? 600;
  const healthyWaitAttempts = options?.healthyWaitAttempts ?? 1_200;
  if (
    !Number.isSafeInteger(processWaitAttempts) ||
    processWaitAttempts <= 0 ||
    !Number.isSafeInteger(healthyWaitAttempts) ||
    healthyWaitAttempts <= 0
  ) {
    throw new DesktopUpdateError("Desktop update helper limits are invalid");
  }
  return [
    "set -eu",
    'pid="$1"',
    'current="$2"',
    'staged="$3"',
    'backup="$4"',
    'marker="$5"',
    'journal="$6"',
    'opener="$7"',
    "cleanup_failure() {",
    '  rm -f "$marker" "$journal"',
    "}",
    "rollback() {",
    '  code="$1"',
    '  rm -rf "$current"',
    '  [ ! -e "$backup" ] || mv "$backup" "$current"',
    "  cleanup_failure",
    '  exit "$code"',
    "}",
    "count=0",
    'while kill -0 "$pid" 2>/dev/null; do',
    "  count=$((count + 1))",
    `  [ "$count" -lt ${processWaitAttempts} ] || { cleanup_failure; exit 70; }`,
    "  sleep 0.1",
    "done",
    '[ ! -e "$backup" ] || { cleanup_failure; exit 71; }',
    'mv "$current" "$backup"',
    'if ! mv "$staged" "$current"; then',
    '  mv "$backup" "$current"',
    "  cleanup_failure",
    "  exit 72",
    "fi",
    'if ! "$opener" -n "$current"; then',
    "  rollback 73",
    "fi",
    "count=0",
    'while [ ! -f "$marker" ]; do',
    "  count=$((count + 1))",
    `  [ "$count" -lt ${healthyWaitAttempts} ] || rollback 74`,
    "  sleep 0.1",
    "done",
    'rm -rf "$backup"',
    'rm -f "$marker" "$journal"',
  ].join("\n");
}

async function defaultInstallArtifact(
  pending: PendingDesktopUpdate,
  context: InstallContext,
): Promise<void> {
  if (context.platform === "win32") {
    const child = spawn(pending.artifactPath, ["--updated", "--force-run"], {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    child.unref();
    return;
  }

  const currentAppPath = safeMacAppPath(context.currentAppPath);
  await access(dirname(currentAppPath), fsConstants.W_OK);
  const stagedChildren = await readdir(pending.stagingDirectory);
  if (stagedChildren.length !== 1 || !stagedChildren[0].endsWith(".app")) {
    throw new DesktopUpdateError("Desktop update staged app is unavailable");
  }
  const stagedAppPath = join(pending.stagingDirectory, stagedChildren[0]);
  const backupPath = `${currentAppPath}.aera-update-backup-${process.pid}`;
  const markerPath = assertOwnedPath(
    context.root,
    join(
      context.root,
      `install-success-${pending.offer.manifest.version}-${process.pid}`,
    ),
    "Desktop update success marker",
  );
  const journalPath = assertOwnedPath(
    context.root,
    join(context.root, "install-journal.json"),
    "Desktop update journal",
  );
  await writeFile(
    journalPath,
    canonicalJsonBytes({
      schema_version: 1,
      target_version: pending.offer.manifest.version,
      current_app_path: currentAppPath,
      backup_path: backupPath,
      success_marker: markerPath,
    }),
    { flag: "wx", mode: 0o600 },
  );
  const child = spawn(
    "/bin/sh",
    [
      "-c",
      buildMacUpdateHelperScript(),
      "aera-desktop-updater",
      String(process.pid),
      currentAppPath,
      stagedAppPath,
      backupPath,
      markerPath,
      journalPath,
      "/usr/bin/open",
    ],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
}

export function resolveCurrentMacAppPath(
  executablePath: string,
): string | null {
  let current = resolve(executablePath);
  for (let depth = 0; depth < 8; depth += 1) {
    if (current.endsWith(".app")) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

export class InternalBetaDesktopUpdater {
  private readonly root: string;
  private readonly metadataTransport: MetadataTransport;
  private readonly downloadArtifact: (
    request: ArtifactDownloadRequest,
  ) => Promise<void>;
  private readonly prepareArtifact: NonNullable<
    InternalBetaUpdaterOptions["prepareArtifact"]
  >;
  private readonly installArtifact: NonNullable<
    InternalBetaUpdaterOptions["installArtifact"]
  >;
  private snapshot: DesktopUpdateSnapshot = {
    state: null,
    version: null,
    releaseNotes: null,
    percent: null,
    error: null,
  };
  private offer: DesktopUpdateOffer | null = null;
  private pending: PendingDesktopUpdate | null = null;
  private autoDownload: boolean;
  private checkPromise: Promise<string | null> | null = null;
  private downloadPromise: Promise<boolean> | null = null;
  private controller: AbortController | null = null;

  constructor(private readonly options: InternalBetaUpdaterOptions) {
    parseInternalBetaVersion(options.currentVersion);
    if (
      (options.platform !== "darwin" && options.platform !== "win32") ||
      (options.arch !== "arm64" && options.arch !== "x64") ||
      (options.platform === "darwin" && options.arch !== "arm64") ||
      (options.platform === "win32" && options.arch !== "x64")
    ) {
      throw new DesktopUpdateError("Desktop update host target is unsupported");
    }
    if (
      options.baseUrl.protocol !== "https:" ||
      options.baseUrl.pathname.replace(/\/$/u, "") !==
        "/desktop-updates/internal-beta" ||
      options.baseUrl.username.length > 0 ||
      options.baseUrl.password.length > 0 ||
      options.baseUrl.search.length > 0 ||
      options.baseUrl.hash.length > 0
    ) {
      throw new DesktopUpdateError("Desktop update channel URL is invalid");
    }
    this.root = join(options.userDataPath, "desktop-updates");
    this.metadataTransport =
      options.metadataTransport ?? new FetchMetadataTransport();
    this.downloadArtifact =
      options.downloadArtifact ??
      ((request) =>
        downloadWithResume({
          ...request,
          maxRedirects: 0,
        }));
    this.prepareArtifact = options.prepareArtifact ?? defaultPrepareArtifact;
    this.installArtifact = options.installArtifact ?? defaultInstallArtifact;
    this.autoDownload = options.autoDownload;
  }

  getSnapshot(): DesktopUpdateSnapshot {
    return { ...this.snapshot };
  }

  setAutoDownload(enabled: boolean): void {
    this.autoDownload = enabled;
    if (enabled && this.snapshot.state === "available") {
      void this.download();
    }
  }

  private publish(
    next: Omit<DesktopUpdateSnapshot, "releaseNotes"> & {
      releaseNotes?: string | null;
    },
  ): void {
    this.snapshot = {
      ...next,
      releaseNotes:
        next.releaseNotes ??
        (next.version
          ? (this.offer?.manifest.release_notes ??
            this.pending?.offer.manifest.release_notes ??
            null)
          : null),
    };
    this.options.onState(this.getSnapshot());
  }

  private metadataPath(name: string): string {
    return assertOwnedPath(
      this.root,
      join(this.root, "metadata", name),
      "Desktop update metadata path",
    );
  }

  private artifactPath(artifact: DesktopUpdateArtifact): string {
    return assertOwnedPath(
      this.root,
      join(this.root, "downloads", artifact.name),
      "Desktop update artifact path",
    );
  }

  private stagingDirectory(version: string): string {
    return assertOwnedPath(
      this.root,
      join(this.root, "staging", version),
      "Desktop update staging path",
    );
  }

  private pendingPath(): string {
    return assertOwnedPath(
      this.root,
      join(this.root, "pending.json"),
      "Desktop update pending path",
    );
  }

  private installJournalPath(): string {
    return assertOwnedPath(
      this.root,
      join(this.root, "install-journal.json"),
      "Desktop update journal path",
    );
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await this.signalHealthyInstall();
    this.pending = await this.loadPending().catch(async (error) => {
      this.options.log.warn(
        `Ignoring invalid pending Desktop update: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      await this.clearPendingFiles();
      return null;
    });
    if (this.pending) {
      this.offer = this.pending.offer;
      this.publish({
        state: "ready",
        version: this.pending.offer.manifest.version,
        percent: null,
        error: null,
      });
    }
  }

  private async signalHealthyInstall(): Promise<void> {
    let raw: Buffer;
    try {
      raw = await readFile(this.installJournalPath());
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return;
      }
      throw error;
    }
    const journal = parseCanonicalObject(raw, "Desktop update journal");
    requireExactObjectFields(
      journal,
      INSTALL_JOURNAL_FIELDS,
      "Desktop update journal",
    );
    if (
      journal.schema_version !== 1 ||
      typeof journal.target_version !== "string" ||
      compareInternalBetaVersions(
        journal.target_version,
        this.options.currentVersion,
      ) > 0 ||
      typeof journal.success_marker !== "string"
    ) {
      return;
    }
    const marker = assertOwnedPath(
      this.root,
      journal.success_marker,
      "Desktop update success marker",
    );
    await writeFile(marker, `${this.options.currentVersion}\n`, {
      flag: "wx",
      mode: 0o600,
    }).catch((error) => {
      if (
        !(
          error instanceof Error &&
          "code" in error &&
          (error as NodeJS.ErrnoException).code === "EEXIST"
        )
      ) {
        throw error;
      }
    });
  }

  private async loadPending(): Promise<PendingDesktopUpdate | null> {
    let pendingBytes: Buffer;
    try {
      pendingBytes = await readFile(this.pendingPath());
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return null;
      }
      throw error;
    }
    const marker = parseCanonicalObject(
      pendingBytes,
      "Desktop update pending marker",
    );
    requireExactObjectFields(
      marker,
      PENDING_FIELDS,
      "Desktop update pending marker",
    );
    if (marker.schema_version !== 1 || typeof marker.version !== "string") {
      throw new DesktopUpdateError("Desktop update pending marker is invalid");
    }
    if (
      compareInternalBetaVersions(
        marker.version,
        this.options.currentVersion,
      ) <= 0
    ) {
      await this.clearPendingFiles();
      return null;
    }
    const offer = await this.readStoredOffer();
    if (offer.manifest.version !== marker.version) {
      throw new DesktopUpdateError(
        "Desktop update pending version differs from metadata",
      );
    }
    const artifactPath = this.artifactPath(offer.artifact);
    await verifyArtifactFile(artifactPath, offer.artifact);
    const stagingDirectory = this.stagingDirectory(offer.manifest.version);
    if (this.options.platform === "darwin") {
      const children = await readdir(stagingDirectory);
      if (children.length !== 1 || !children[0].endsWith(".app")) {
        throw new DesktopUpdateError("Desktop update staged app is missing");
      }
    }
    return { offer, artifactPath, stagingDirectory };
  }

  private async clearPendingFiles(): Promise<void> {
    await Promise.all([
      rm(this.pendingPath(), { force: true }),
      rm(
        assertOwnedPath(this.root, join(this.root, "downloads"), "downloads"),
        {
          recursive: true,
          force: true,
        },
      ),
      rm(assertOwnedPath(this.root, join(this.root, "staging"), "staging"), {
        recursive: true,
        force: true,
      }),
      rm(assertOwnedPath(this.root, join(this.root, "metadata"), "metadata"), {
        recursive: true,
        force: true,
      }),
    ]);
  }

  private async readStoredOffer(): Promise<DesktopUpdateOffer> {
    const [manifestBytes, signatureBytes] = await Promise.all([
      readFile(this.metadataPath("desktop-update-manifest.json")),
      readFile(this.metadataPath("desktop-update-manifest.sig")),
    ]);
    return this.offerFromMetadata(manifestBytes, signatureBytes);
  }

  private offerFromMetadata(
    manifestBytes: Buffer,
    signatureBytes: Buffer,
  ): DesktopUpdateOffer {
    const manifest = verifyDesktopUpdateMetadata({
      manifestBytes,
      signatureBytes,
      baseUrl: this.options.baseUrl,
      trustedPublicKeys: this.options.trustedPublicKeys,
    });
    const artifact = manifest.artifacts.find(
      (item) =>
        item.platform === this.options.platform &&
        item.arch === this.options.arch,
    );
    if (!artifact) {
      throw new DesktopUpdateError(
        "Desktop update does not contain this platform",
      );
    }
    return { manifest, manifestBytes, signatureBytes, artifact };
  }

  check(): Promise<string | null> {
    if (this.checkPromise) return this.checkPromise;
    this.checkPromise = this.performCheck().finally(() => {
      this.checkPromise = null;
    });
    return this.checkPromise;
  }

  private async performCheck(): Promise<string | null> {
    if (this.pending) {
      this.publish({
        state: "ready",
        version: this.pending.offer.manifest.version,
        percent: null,
        error: null,
      });
      return this.pending.offer.manifest.version;
    }
    this.publish({
      state: "checking",
      version: null,
      percent: null,
      error: null,
    });
    const controller = new AbortController();
    this.controller = controller;
    try {
      const [manifestBytes, signatureBytes] = await Promise.all([
        this.metadataTransport.get(
          new URL(
            "manifest.json",
            `${this.options.baseUrl.href.replace(/\/$/u, "")}/`,
          ),
          controller.signal,
        ),
        this.metadataTransport.get(
          new URL(
            "manifest.sig",
            `${this.options.baseUrl.href.replace(/\/$/u, "")}/`,
          ),
          controller.signal,
        ),
      ]);
      const offer = this.offerFromMetadata(manifestBytes, signatureBytes);
      if (
        compareInternalBetaVersions(
          offer.manifest.version,
          this.options.currentVersion,
        ) <= 0
      ) {
        this.offer = null;
        this.publish({
          state: "uptodate",
          version: null,
          percent: null,
          error: null,
        });
        return null;
      }
      this.offer = offer;
      this.publish({
        state: "available",
        version: offer.manifest.version,
        percent: null,
        error: null,
      });
      if (this.autoDownload) void this.download();
      return offer.manifest.version;
    } catch (error) {
      this.options.log.error(
        `Desktop update check failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      this.publish({
        state: "error",
        version: null,
        percent: null,
        error: UPDATE_ERROR_MESSAGE,
      });
      return null;
    } finally {
      if (this.controller === controller) this.controller = null;
    }
  }

  download(): Promise<boolean> {
    if (this.downloadPromise) return this.downloadPromise;
    this.downloadPromise = this.performDownload().finally(() => {
      this.downloadPromise = null;
    });
    return this.downloadPromise;
  }

  private async performDownload(): Promise<boolean> {
    if (this.pending) return true;
    const offer = this.offer;
    if (!offer) {
      this.publish({
        state: "error",
        version: null,
        percent: null,
        error: UPDATE_ERROR_MESSAGE,
      });
      return false;
    }
    const controller = new AbortController();
    this.controller = controller;
    const artifactPath = this.artifactPath(offer.artifact);
    const stagingDirectory = this.stagingDirectory(offer.manifest.version);
    this.publish({
      state: "downloading",
      version: offer.manifest.version,
      percent: 0,
      error: null,
    });
    try {
      await Promise.all([
        rm(this.pendingPath(), { force: true }),
        rm(
          assertOwnedPath(this.root, join(this.root, "metadata"), "metadata"),
          { recursive: true, force: true },
        ),
        rm(stagingDirectory, { recursive: true, force: true }),
      ]);
      await mkdir(dirname(artifactPath), { recursive: true, mode: 0o700 });
      let lastPercent = -1;
      await this.downloadArtifact({
        url: new URL(offer.artifact.url),
        destination: artifactPath,
        expectedSize: offer.artifact.size,
        expectedSha256: offer.artifact.sha256,
        signal: controller.signal,
        onProgress: (received, total) => {
          const percent =
            total <= 0
              ? 0
              : Math.min(100, Math.floor((received / total) * 100));
          if (percent === lastPercent) return;
          lastPercent = percent;
          this.publish({
            state: "downloading",
            version: offer.manifest.version,
            percent,
            error: null,
          });
        },
      });
      await verifyArtifactFile(artifactPath, offer.artifact);
      await this.prepareArtifact(offer, artifactPath, stagingDirectory);
      await mkdir(dirname(this.metadataPath("manifest")), {
        recursive: true,
        mode: 0o700,
      });
      await Promise.all([
        writePrivateFileAtomic(
          this.metadataPath("desktop-update-manifest.json"),
          offer.manifestBytes,
        ),
        writePrivateFileAtomic(
          this.metadataPath("desktop-update-manifest.sig"),
          offer.signatureBytes,
        ),
      ]);
      await writePrivateFileAtomic(
        this.pendingPath(),
        canonicalJsonBytes({
          schema_version: 1,
          version: offer.manifest.version,
        }),
      );
      this.pending = { offer, artifactPath, stagingDirectory };
      this.publish({
        state: "ready",
        version: offer.manifest.version,
        percent: null,
        error: null,
      });
      return true;
    } catch (error) {
      this.options.log.error(
        `Desktop update download failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      this.publish({
        state: "error",
        version: offer.manifest.version,
        percent: null,
        error: UPDATE_ERROR_MESSAGE,
      });
      return false;
    } finally {
      if (this.controller === controller) this.controller = null;
    }
  }

  async install(): Promise<void> {
    if (!this.pending) {
      throw new DesktopUpdateError("Desktop update is not ready");
    }
    await this.installArtifact(this.pending, {
      root: this.root,
      currentAppPath: this.options.currentAppPath,
      platform: this.options.platform,
      currentVersion: this.options.currentVersion,
    });
  }

  dispose(): void {
    this.controller?.abort();
  }
}
