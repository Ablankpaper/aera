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
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { execFile as execFileCallback, spawn } from "node:child_process";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { promisify } from "node:util";

import { extract as extractZip } from "@electron-internal/extract-zip";

import {
  canonicalJsonBytes,
  parseJsonObjectRejectDuplicates,
  requireExactObjectFields,
} from "../agentera-runtime-distribution/manifest";
import {
  downloadWithResume,
  RuntimeDownloadCancelledError,
  RuntimeDownloadError,
  RuntimeDownloadIntegrityError,
} from "../agentera-runtime-distribution/downloader";
import {
  DESKTOP_UPDATE_STAGES,
  desktopUpdateDiagnosticId,
  desktopUpdateStageV2,
  type DesktopUpdateCodeV2,
  type DesktopUpdateStageNameV2,
  type DesktopUpdateStageV2,
} from "../../shared/desktop-update";

export type DesktopUpdateState =
  | "available"
  | "downloading"
  | "ready"
  | "error"
  | "checking"
  | "uptodate"
  | null;

export type DesktopUpdateStage = DesktopUpdateStageNameV2;
export type DesktopUpdateErrorCode = DesktopUpdateCodeV2;

export interface DesktopUpdateSnapshot {
  state: DesktopUpdateState;
  version: string | null;
  releaseNotes: string | null;
  percent: number | null;
  error: string | null;
  errorCode: DesktopUpdateErrorCode | null;
  stage: DesktopUpdateStage | null;
  diagnosticId: string | null;
  stageEvent: DesktopUpdateStageV2 | null;
}

type SupportedPlatform = "darwin" | "win32";
type SupportedArch = "arm64" | "x64";

export interface DesktopUpdateArtifact extends Record<string, unknown> {
  platform: SupportedPlatform;
  arch: SupportedArch;
  kind: "zip" | "app_zip";
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
  spawnDetachedProcess?: SpawnDetachedProcess;
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
  spawnDetachedProcess?: SpawnDetachedProcess;
}

export type SpawnDetachedProcess = typeof spawnDetached;

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
const INSTALL_JOURNAL_FIELDS_V1 = [
  "backup_path",
  "current_app_path",
  "schema_version",
  "success_marker",
  "target_version",
] as const;
const INSTALL_JOURNAL_FIELDS_V2 = [
  "artifact_name",
  "artifact_sha256",
  "artifact_sha512",
  "artifact_size",
  "backup_path",
  "current_app_path",
  "failure_marker",
  "operation_id",
  "platform",
  "rollback_state",
  "schema_version",
  "source_version",
  "staged_app_path",
  "state",
  "success_marker",
  "target_version",
  "updated_at",
] as const;
const INSTALL_JOURNAL_STATES: ReadonlySet<string> = new Set([
  "prepared",
  "waiting_for_exit",
  "backup_created",
  "app_swapped",
  "launched",
  "healthy",
  "finalized",
  "rollback_started",
  "rolled_back",
  "rollback_failed",
  "recovery_required",
] as const);
const INSTALL_ROLLBACK_STATES: ReadonlySet<string> = new Set([
  "not_started",
  "started",
  "succeeded",
  "failed",
] as const);
type InstallJournalState =
  | "prepared"
  | "waiting_for_exit"
  | "backup_created"
  | "app_swapped"
  | "launched"
  | "healthy"
  | "finalized"
  | "rollback_started"
  | "rolled_back"
  | "rollback_failed"
  | "recovery_required";
type InstallRollbackState = "not_started" | "started" | "succeeded" | "failed";

interface InstallJournalV1 {
  schema_version: 1;
  target_version: string;
  current_app_path: string;
  backup_path: string;
  success_marker: string;
}

interface InstallJournalV2 {
  schema_version: 2;
  operation_id: string;
  platform: SupportedPlatform;
  source_version: string;
  target_version: string;
  artifact_name: string;
  artifact_size: number;
  artifact_sha256: string;
  artifact_sha512: string;
  current_app_path: string;
  staged_app_path: string;
  backup_path: string;
  success_marker: string;
  failure_marker: string;
  state: InstallJournalState;
  rollback_state: InstallRollbackState;
  updated_at: string;
}
const INSTALL_FAILURE_FIELDS_V1 = [
  "code",
  "schema_version",
  "target_version",
] as const;
const INSTALL_FAILURE_FIELDS_V2 = [
  "code",
  "schema_version",
  "state",
  "target_version",
] as const;
const INSTALL_FAILURE_FIELDS_V2_OPERATION = [
  "code",
  "operation_id",
  "rollback_state",
  "schema_version",
  "stage",
  "state",
  "target_version",
] as const;
type InstallFailureState = "failed" | "rolled_back";
interface InstallFailureRecord {
  code: DesktopUpdateErrorCode;
  state: InstallFailureState;
  targetVersion: string | null;
  operationId: string | null;
  stage: DesktopUpdateStage | null;
  rollbackState: InstallRollbackState | null;
}
const METADATA_LIMIT = 128 * 1024;
const METADATA_TIMEOUT_MS = 20_000;
const UPDATE_ERROR_MESSAGE = "更新失败，请稍后重试。";

const UPDATE_ERROR_MESSAGES: Readonly<Record<DesktopUpdateErrorCode, string>> =
  {
    update_origin_unavailable: "更新服务不可用：云端地址未配置。",
    update_metadata_unavailable: UPDATE_ERROR_MESSAGE,
    update_metadata_invalid: "更新信息校验失败。",
    update_signature_invalid: "更新签名校验失败。",
    update_artifact_unavailable: "更新包下载失败。",
    update_artifact_size_mismatch: "更新包大小校验失败。",
    update_artifact_hash_mismatch: "更新包完整性校验失败。",
    update_redirect_rejected: "更新包地址跳转已被拒绝。",
    update_extract_failed: "更新包解压失败。",
    update_staged_identity_invalid: "更新包应用身份校验失败。",
    update_staged_native_invalid: "更新包原生模块校验失败。",
    update_swap_failed: "更新安装失败，已保留当前版本。",
    update_launch_failed: "新版本启动失败，正在保留当前版本。",
    update_health_timeout: "新版本启动检查失败，已恢复当前版本。",
    update_rollback_failed: "更新回滚失败，请暂停更新并联系支持。",
    update_client_bridge_required: "当前版本需要使用安装包完成升级。",
    update_cancelled: "更新操作已取消。",
  };

interface DesktopUpdateErrorOptions extends ErrorOptions {
  code?: DesktopUpdateErrorCode;
  stage?: DesktopUpdateStage;
}

export class DesktopUpdateError extends Error {
  readonly code: DesktopUpdateErrorCode | null;
  readonly stage: DesktopUpdateStage | null;

  constructor(message: string, options?: DesktopUpdateErrorOptions) {
    super(message, options);
    this.name = "DesktopUpdateError";
    this.code = options?.code ?? null;
    this.stage = options?.stage ?? null;
  }
}

export function classifyDesktopUpdateDownloadError(
  error: unknown,
): DesktopUpdateError {
  if (error instanceof DesktopUpdateError) return error;
  if (error instanceof RuntimeDownloadCancelledError) {
    return new DesktopUpdateError("Desktop update download was cancelled", {
      cause: error,
      code: "update_cancelled",
      stage: "download",
    });
  }
  if (error instanceof RuntimeDownloadIntegrityError) {
    const sizeMismatch = /(?:size|length|exceeded)/iu.test(error.message);
    return new DesktopUpdateError("Desktop update artifact integrity failed", {
      cause: error,
      code: sizeMismatch
        ? "update_artifact_size_mismatch"
        : "update_artifact_hash_mismatch",
      stage: "verify",
    });
  }
  if (
    error instanceof RuntimeDownloadError &&
    /redirect/iu.test(error.message)
  ) {
    return new DesktopUpdateError("Desktop update redirect was rejected", {
      cause: error,
      code: "update_redirect_rejected",
      stage: "download",
    });
  }
  return new DesktopUpdateError("Desktop update artifact download failed", {
    cause: error instanceof Error ? error : undefined,
    code: "update_artifact_unavailable",
    stage: "download",
  });
}

function updateFailure(
  error: unknown,
  fallbackCode: DesktopUpdateErrorCode,
  fallbackStage: DesktopUpdateStage,
): {
  code: DesktopUpdateErrorCode;
  stage: DesktopUpdateStage;
  diagnosticId: string;
} {
  return {
    code:
      error instanceof DesktopUpdateError && error.code !== null
        ? error.code
        : fallbackCode,
    stage:
      error instanceof DesktopUpdateError && error.stage !== null
        ? error.stage
        : fallbackStage,
    diagnosticId: desktopUpdateDiagnosticId(),
  };
}

export function createDesktopUpdateFailureSnapshot(options: {
  error: unknown;
  fallbackCode: DesktopUpdateErrorCode;
  fallbackStage: DesktopUpdateStage;
  version: string | null;
  releaseNotes: string | null;
  operationId?: string;
  stageState?: "failed" | "rolled_back";
}): DesktopUpdateSnapshot {
  const failure = updateFailure(
    options.error,
    options.fallbackCode,
    options.fallbackStage,
  );
  const event = desktopUpdateStageV2({
    operationId: options.operationId ?? desktopUpdateDiagnosticId(),
    stage: failure.stage,
    state: options.stageState ?? "failed",
    code: failure.code,
    targetVersion: options.version,
    diagnosticId: failure.diagnosticId,
  });
  return {
    state: "error",
    version: options.version,
    releaseNotes: options.releaseNotes,
    percent: null,
    error: UPDATE_ERROR_MESSAGES[failure.code],
    errorCode: failure.code,
    stage: failure.stage,
    diagnosticId: failure.diagnosticId,
    stageEvent: event,
  };
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

function isoTimestampSeconds(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/u, "Z");
}

function parseInstallJournal(raw: Buffer): InstallJournalV1 | InstallJournalV2 {
  const value = parseJsonObjectRejectDuplicates(raw, "Desktop update journal");
  if (value.schema_version === 1) {
    requireExactObjectFields(
      value,
      INSTALL_JOURNAL_FIELDS_V1,
      "Desktop update journal",
    );
    if (
      typeof value.target_version !== "string" ||
      !VERSION_PATTERN.test(value.target_version) ||
      typeof value.current_app_path !== "string" ||
      value.current_app_path.length === 0 ||
      typeof value.backup_path !== "string" ||
      value.backup_path.length === 0 ||
      typeof value.success_marker !== "string" ||
      value.success_marker.length === 0
    ) {
      throw new DesktopUpdateError("Desktop update journal V1 is invalid");
    }
    return value as unknown as InstallJournalV1;
  }
  requireExactObjectFields(
    value,
    INSTALL_JOURNAL_FIELDS_V2,
    "Desktop update journal",
  );
  if (
    value.schema_version !== 2 ||
    typeof value.operation_id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      value.operation_id,
    ) ||
    (value.platform !== "darwin" && value.platform !== "win32") ||
    typeof value.source_version !== "string" ||
    !VERSION_PATTERN.test(value.source_version) ||
    typeof value.target_version !== "string" ||
    !VERSION_PATTERN.test(value.target_version) ||
    typeof value.artifact_name !== "string" ||
    !FILE_NAME_PATTERN.test(value.artifact_name) ||
    !Number.isSafeInteger(value.artifact_size) ||
    (value.artifact_size as number) <= 0 ||
    typeof value.artifact_sha256 !== "string" ||
    !SHA256_PATTERN.test(value.artifact_sha256) ||
    typeof value.artifact_sha512 !== "string" ||
    !SHA512_PATTERN.test(value.artifact_sha512) ||
    typeof value.current_app_path !== "string" ||
    value.current_app_path.length === 0 ||
    typeof value.staged_app_path !== "string" ||
    value.staged_app_path.length === 0 ||
    typeof value.backup_path !== "string" ||
    value.backup_path.length === 0 ||
    typeof value.success_marker !== "string" ||
    value.success_marker.length === 0 ||
    typeof value.failure_marker !== "string" ||
    value.failure_marker.length === 0 ||
    typeof value.state !== "string" ||
    !INSTALL_JOURNAL_STATES.has(value.state) ||
    typeof value.rollback_state !== "string" ||
    !INSTALL_ROLLBACK_STATES.has(value.rollback_state) ||
    typeof value.updated_at !== "string" ||
    !ISO_SECONDS_PATTERN.test(value.updated_at) ||
    compareInternalBetaVersions(value.source_version, value.target_version) >= 0
  ) {
    throw new DesktopUpdateError("Desktop update journal V2 is invalid");
  }
  return value as unknown as InstallJournalV2;
}

function parseInstallFailure(raw: Buffer): InstallFailureRecord {
  const value = parseJsonObjectRejectDuplicates(raw, "Desktop update failure");
  if (value.schema_version !== 2 && value.schema_version !== 1) {
    throw new DesktopUpdateError("Desktop update failure schema is invalid");
  }
  if (value.schema_version === 1) {
    requireExactObjectFields(
      value,
      INSTALL_FAILURE_FIELDS_V1,
      "Desktop update failure",
    );
  } else if (
    Object.keys(value).sort().join("\0") ===
    [...INSTALL_FAILURE_FIELDS_V2_OPERATION].sort().join("\0")
  ) {
    // The operation-bound V2 marker is emitted by the Beta.33 helpers.
  } else {
    requireExactObjectFields(
      value,
      INSTALL_FAILURE_FIELDS_V2,
      "Desktop update failure",
    );
  }
  if (
    typeof value.code !== "string" ||
    !Object.prototype.hasOwnProperty.call(UPDATE_ERROR_MESSAGES, value.code) ||
    (value.schema_version === 2 &&
      value.state !== "failed" &&
      value.state !== "rolled_back")
  ) {
    throw new DesktopUpdateError("Desktop update failure fields are invalid");
  }
  let operationId: string | null = null;
  let stage: DesktopUpdateStage | null = null;
  let rollbackState: InstallRollbackState | null = null;
  if (Object.hasOwn(value, "operation_id")) {
    if (
      typeof value.operation_id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
        value.operation_id,
      ) ||
      typeof value.stage !== "string" ||
      !DESKTOP_UPDATE_STAGES.includes(value.stage as DesktopUpdateStage) ||
      typeof value.rollback_state !== "string" ||
      !INSTALL_ROLLBACK_STATES.has(value.rollback_state)
    ) {
      throw new DesktopUpdateError(
        "Desktop update failure operation fields are invalid",
      );
    }
    operationId = value.operation_id;
    stage = value.stage as DesktopUpdateStage;
    rollbackState = value.rollback_state as InstallRollbackState;
  }
  const targetVersion =
    typeof value.target_version === "string" &&
    VERSION_PATTERN.test(value.target_version)
      ? value.target_version
      : null;
  return {
    code: value.code as DesktopUpdateErrorCode,
    state:
      value.schema_version === 1
        ? "failed"
        : (value.state as InstallFailureState),
    targetVersion,
    operationId,
    stage,
    rollbackState,
  };
}

function installJournalFor(options: {
  pending: PendingDesktopUpdate;
  context: InstallContext;
  currentAppPath: string;
  stagedAppPath: string;
  backupPath: string;
  successMarker: string;
  failureMarker: string;
}): InstallJournalV2 {
  const artifact = options.pending.offer.artifact;
  return {
    schema_version: 2,
    operation_id: randomUUID(),
    platform: options.context.platform,
    source_version: options.context.currentVersion,
    target_version: options.pending.offer.manifest.version,
    artifact_name: artifact.name,
    artifact_size: artifact.size,
    artifact_sha256: artifact.sha256,
    artifact_sha512: artifact.sha512,
    current_app_path: options.currentAppPath,
    staged_app_path: options.stagedAppPath,
    backup_path: options.backupPath,
    success_marker: options.successMarker,
    failure_marker: options.failureMarker,
    state: "prepared",
    rollback_state: "not_started",
    updated_at: isoTimestampSeconds(),
  };
}

async function writeInstallJournal(
  path: string,
  journal: InstallJournalV2,
  state: InstallJournalState = journal.state,
  rollbackState: InstallRollbackState = journal.rollback_state,
): Promise<InstallJournalV2> {
  const next = {
    ...journal,
    state,
    rollback_state: rollbackState,
    updated_at: isoTimestampSeconds(),
  } satisfies InstallJournalV2;
  await writePrivateFileAtomic(path, canonicalJsonBytes(next));
  return next;
}

async function writeInstallFailureMarker(
  journal: InstallJournalV2,
  code: DesktopUpdateErrorCode,
  state: InstallFailureState,
  stage: DesktopUpdateStage,
  rollbackState: InstallRollbackState,
): Promise<void> {
  await writePrivateFileAtomic(
    journal.failure_marker,
    canonicalJsonBytes({
      code,
      schema_version: 2,
      state,
      target_version: journal.target_version,
      operation_id: journal.operation_id,
      stage,
      rollback_state: rollbackState,
    }),
  );
}

async function pathStatus(
  path: string,
): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(path);
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
    (kind !== "zip" && kind !== "app_zip") ||
    (platform === "darwin" && (arch !== "arm64" || kind !== "zip")) ||
    (platform === "win32" && (arch !== "x64" || kind !== "app_zip"))
  ) {
    throw new DesktopUpdateError(`${label} target is invalid`);
  }
  const name = requireString(value, "name", label);
  const expectedName =
    platform === "darwin"
      ? `Aera-Internal-Beta-${manifestVersion}-macos-arm64.zip`
      : `Aera-Internal-Beta-${manifestVersion}-windows-x64-app.zip`;
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
    throw new DesktopUpdateError("Desktop update signing key is not trusted", {
      code: "update_signature_invalid",
      stage: "verify",
    });
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
    throw new DesktopUpdateError("Desktop update signature is invalid", {
      code: "update_signature_invalid",
      stage: "verify",
    });
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
          "User-Agent": "Aera-Desktop-Updater",
        },
      });
      if (!response.ok || response.body === null) {
        throw new DesktopUpdateError(
          `Desktop update metadata returned HTTP ${response.status}`,
          { code: "update_metadata_unavailable", stage: "metadata" },
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
        throw new DesktopUpdateError("Desktop update check was cancelled", {
          code: "update_cancelled",
          stage: "metadata",
        });
      }
      if (error instanceof DesktopUpdateError) throw error;
      throw new DesktopUpdateError("Desktop update metadata request failed", {
        cause: error,
        code: "update_metadata_unavailable",
        stage: "metadata",
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
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporaryPath, path);
  } finally {
    await handle?.close().catch(() => {});
    await rm(temporaryPath, { force: true });
  }
}

async function verifyArtifactFile(
  path: string,
  artifact: DesktopUpdateArtifact,
): Promise<void> {
  const info = await stat(path);
  if (!info.isFile()) {
    throw new DesktopUpdateError("Desktop update artifact is not a file", {
      code: "update_artifact_hash_mismatch",
      stage: "download",
    });
  }
  const digest = await fileDigest(path);
  if (
    digest.size !== artifact.size ||
    digest.sha256 !== artifact.sha256 ||
    digest.sha512 !== artifact.sha512
  ) {
    throw new DesktopUpdateError("Desktop update artifact integrity failed", {
      code:
        digest.size === artifact.size
          ? "update_artifact_hash_mismatch"
          : "update_artifact_size_mismatch",
      stage: "verify",
    });
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

export function validatePackagedMacRuntimeEntries(
  asarEntries: readonly string[],
  nativeEntries: readonly string[],
): void {
  const normalizedAsar = new Set(
    asarEntries.map((entry) => entry.replace(/^\/+/, "")),
  );
  const required = [
    "out/main/index.js",
    "out/preload/index.js",
    "out/renderer/index.html",
  ];
  const missing = required.filter((entry) => !normalizedAsar.has(entry));
  const native = nativeEntries
    .map((entry) => entry.replace(/^\/+/, ""))
    .filter((entry) => entry.endsWith(".node"));
  if (
    missing.length > 0 ||
    !native.some((entry) =>
      entry.endsWith("better-sqlite3/build/Release/better_sqlite3.node"),
    )
  ) {
    throw new DesktopUpdateError(
      `Desktop update runtime entries are incomplete: ${[
        ...missing,
        ...(native.length === 0 ? ["native module"] : []),
      ].join(", ")}`,
      { code: "update_staged_native_invalid", stage: "stage" },
    );
  }
}

function validateWindowsPeX64(bytes: Uint8Array, label: string): void {
  const image = Buffer.from(bytes);
  if (image.length < 0x40 || image.readUInt16LE(0) !== 0x5a4d) {
    throw new DesktopUpdateError(`${label} has no valid MZ header`, {
      code: "update_staged_identity_invalid",
      stage: "stage",
    });
  }
  const peOffset = image.readUInt32LE(0x3c);
  if (
    peOffset > image.length - 6 ||
    image.readUInt32LE(peOffset) !== 0x00004550 ||
    image.readUInt16LE(peOffset + 4) !== 0x8664
  ) {
    throw new DesktopUpdateError(`${label} is not an x64 PE image`, {
      code: "update_staged_identity_invalid",
      stage: "stage",
    });
  }
}

function packagedNativeAbi(bytes: Uint8Array, label: string): string {
  const markers = new Set(
    Array.from(
      Buffer.from(bytes)
        .toString("latin1")
        .matchAll(/node_register_module_v(\d+)/gu),
      (match) => match[1],
    ),
  );
  if (markers.size !== 1) {
    throw new DesktopUpdateError(
      `Desktop update native module ${label} has an invalid ABI inventory`,
      { code: "update_staged_native_invalid", stage: "stage" },
    );
  }
  return [...markers][0];
}

export function validatePackagedWindowsRuntimeEntries(options: {
  asarEntries: readonly string[];
  executableBytes: Uint8Array;
  packageDocument: unknown;
  nativeModules: readonly { path: string; bytes: Uint8Array }[];
  expectedVersion: string;
  expectedElectronAbi: string;
}): void {
  const normalizedAsar = new Set(
    options.asarEntries.map((entry) => entry.replace(/^\/+/, "")),
  );
  const requiredAsarEntries = [
    "out/main/index.js",
    "out/preload/index.js",
    "out/renderer/index.html",
    "package.json",
  ];
  const missing = requiredAsarEntries.filter(
    (entry) => !normalizedAsar.has(entry),
  );
  const packageDocument = options.packageDocument;
  if (
    missing.length > 0 ||
    !isObject(packageDocument) ||
    packageDocument.name !== "agentera-studio" ||
    packageDocument.version !== options.expectedVersion
  ) {
    throw new DesktopUpdateError(
      `Desktop update Windows application identity is invalid${
        missing.length > 0 ? `: ${missing.join(", ")}` : ""
      }`,
      { code: "update_staged_identity_invalid", stage: "stage" },
    );
  }
  validateWindowsPeX64(options.executableBytes, "Desktop update executable");
  if (!/^\d+$/u.test(options.expectedElectronAbi)) {
    throw new DesktopUpdateError("Desktop update Electron ABI is invalid", {
      code: "update_staged_native_invalid",
      stage: "stage",
    });
  }
  const seen = new Set<string>();
  let hasBetterSqlite = false;
  for (const module of options.nativeModules) {
    const normalized = module.path.replaceAll("\\", "/").replace(/^\/+/, "");
    if (
      normalized.length === 0 ||
      normalized.split("/").includes("..") ||
      seen.has(normalized)
    ) {
      throw new DesktopUpdateError(
        "Desktop update native module inventory is invalid",
        { code: "update_staged_native_invalid", stage: "stage" },
      );
    }
    seen.add(normalized);
    hasBetterSqlite ||= normalized.endsWith(
      "better-sqlite3/build/Release/better_sqlite3.node",
    );
    try {
      validateWindowsPeX64(
        module.bytes,
        `Desktop update native module ${normalized}`,
      );
    } catch (error) {
      throw new DesktopUpdateError(
        `Desktop update native module ${normalized} is not x64`,
        {
          cause: error,
          code: "update_staged_native_invalid",
          stage: "stage",
        },
      );
    }
    const actualAbi = packagedNativeAbi(module.bytes, normalized);
    if (actualAbi !== options.expectedElectronAbi) {
      throw new DesktopUpdateError(
        `Desktop update native module ${normalized} ABI differs from Electron ABI`,
        { code: "update_staged_native_invalid", stage: "stage" },
      );
    }
  }
  if (seen.size === 0 || !hasBetterSqlite) {
    throw new DesktopUpdateError(
      "Desktop update native module inventory is incomplete",
      { code: "update_staged_native_invalid", stage: "stage" },
    );
  }
}

async function collectPackagedNativeEntries(
  root: string,
  prefix = "",
): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) {
      throw new DesktopUpdateError(
        "Desktop update native entry is a symbolic link",
        { code: "update_staged_native_invalid", stage: "stage" },
      );
    }
    if (entry.isDirectory()) {
      result.push(
        ...(await collectPackagedNativeEntries(
          join(root, entry.name),
          relativePath,
        )),
      );
    } else if (entry.isFile() && entry.name.endsWith(".node")) {
      result.push(relativePath);
    }
  }
  return result;
}

async function defaultPrepareArtifact(
  offer: DesktopUpdateOffer,
  artifactPath: string,
  stagingDirectory: string,
): Promise<void> {
  await rm(stagingDirectory, { recursive: true, force: true });
  await mkdir(stagingDirectory, { recursive: true, mode: 0o700 });
  try {
    await extractDesktopUpdateZip(artifactPath, stagingDirectory);
  } catch (error) {
    throw new DesktopUpdateError("Desktop update archive extraction failed", {
      cause: error,
      code: "update_extract_failed",
      stage: "extract",
    });
  }
  if (offer.artifact.platform === "win32") {
    const executable = join(stagingDirectory, "Aera.exe");
    const resources = join(stagingDirectory, "resources");
    const appAsar = join(resources, "app.asar");
    const executableStatus = await lstat(executable).catch(() => null);
    if (
      executableStatus === null ||
      !executableStatus.isFile() ||
      executableStatus.isSymbolicLink()
    ) {
      throw new DesktopUpdateError(
        "Desktop update Windows executable is unavailable",
        { code: "update_staged_identity_invalid", stage: "stage" },
      );
    }
    let asarEntries: string[];
    let packageDocument: unknown;
    try {
      const { extractFile, listPackage } = await import("@electron/asar");
      asarEntries = listPackage(appAsar, { isPack: false });
      packageDocument = JSON.parse(
        extractFile(appAsar, "package.json").toString("utf8"),
      ) as unknown;
    } catch (error) {
      throw new DesktopUpdateError(
        "Desktop update Windows app.asar cannot be inspected",
        {
          cause: error,
          code: "update_staged_identity_invalid",
          stage: "stage",
        },
      );
    }
    const nativeRoot = join(resources, "app.asar.unpacked");
    let nativeEntries: string[];
    try {
      nativeEntries = await collectPackagedNativeEntries(nativeRoot);
    } catch (error) {
      if (error instanceof DesktopUpdateError) throw error;
      throw new DesktopUpdateError(
        "Desktop update Windows native inventory is unavailable",
        {
          cause: error,
          code: "update_staged_native_invalid",
          stage: "stage",
        },
      );
    }
    const nativeModules = await Promise.all(
      nativeEntries.map(async (path) => ({
        path,
        bytes: await readFile(join(nativeRoot, ...path.split("/"))),
      })),
    );
    validatePackagedWindowsRuntimeEntries({
      asarEntries,
      executableBytes: await readFile(executable),
      packageDocument,
      nativeModules,
      expectedVersion: offer.manifest.version,
      expectedElectronAbi: process.versions.modules,
    });
    return;
  }
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
    throw new DesktopUpdateError("Desktop update app is not Apple Silicon", {
      code: "update_staged_identity_invalid",
      stage: "stage",
    });
  }
  let asarEntries: string[];
  try {
    const { listPackage } = await import("@electron/asar");
    asarEntries = listPackage(
      join(appPath, "Contents", "Resources", "app.asar"),
      { isPack: false },
    );
  } catch (error) {
    throw new DesktopUpdateError(
      "Desktop update app.asar cannot be inspected",
      {
        cause: error,
        code: "update_staged_identity_invalid",
        stage: "stage",
      },
    );
  }
  const nativeRoot = join(
    appPath,
    "Contents",
    "Resources",
    "app.asar.unpacked",
  );
  let nativeEntries: string[];
  try {
    nativeEntries = await collectPackagedNativeEntries(nativeRoot);
  } catch (error) {
    if (error instanceof DesktopUpdateError) throw error;
    throw new DesktopUpdateError(
      "Desktop update native inventory is unavailable",
      {
        cause: error,
        code: "update_staged_native_invalid",
        stage: "stage",
      },
    );
  }
  validatePackagedMacRuntimeEntries(asarEntries, nativeEntries);
}

type DesktopUpdateZipExtractor = (
  archivePath: string,
  options: { dir: string },
) => Promise<void>;

export async function extractDesktopUpdateZip(
  archivePath: string,
  stagingDirectory: string,
  extractor: DesktopUpdateZipExtractor = extractZip,
): Promise<void> {
  const electronProcess = process as NodeJS.Process & { noAsar?: boolean };
  const previousNoAsar = electronProcess.noAsar;
  electronProcess.noAsar = true;
  try {
    await extractor(archivePath, { dir: stagingDirectory });
  } finally {
    electronProcess.noAsar = previousNoAsar;
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
    throw new DesktopUpdateError("请先将 Aera 安装到“应用程序”目录后再更新。");
  }
  return resolve(path);
}

function safeWindowsExecutablePath(path: string | null): string {
  if (
    !path ||
    !isAbsolute(path) ||
    basename(path).toLowerCase() !== "aera.exe"
  ) {
    throw new DesktopUpdateError("Windows update executable path is invalid", {
      code: "update_swap_failed",
      stage: "swap",
    });
  }
  const executable = resolve(path);
  const installDirectory = dirname(executable);
  if (installDirectory === dirname(installDirectory)) {
    throw new DesktopUpdateError(
      "Windows update install directory is invalid",
      {
        code: "update_swap_failed",
        stage: "swap",
      },
    );
  }
  return executable;
}

type WindowsInstallPathAccess = (path: string, mode?: number) => Promise<void>;

export async function validateWindowsInstallPreflight(
  executablePath: string,
  accessPath: WindowsInstallPathAccess = access,
): Promise<void> {
  const executable = safeWindowsExecutablePath(executablePath);
  const installDirectory = dirname(executable);
  // The swap moves the whole install directory to a sibling backup.  The
  // parent therefore needs create/rename permission in addition to the
  // install directory itself being writable.
  await accessPath(dirname(installDirectory), fsConstants.W_OK);
  await accessPath(installDirectory, fsConstants.W_OK);
}

function windowsPowerShellPath(): string {
  const systemRoot = process.env.SystemRoot;
  return systemRoot
    ? join(
        systemRoot,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      )
    : "powershell.exe";
}

async function spawnDetached(
  command: string,
  args: string[],
  options?: { windowsHide?: boolean },
): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: options?.windowsHide,
    });
    child.once("error", rejectPromise);
    child.once("spawn", () => {
      child.unref();
      resolvePromise();
    });
  });
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
    'if [ "$#" -ge 8 ]; then failure="$7"; opener="$8"; else failure="$(dirname "$journal")/install-failure.json"; opener="$7"; fi',
    'target_version="${9:-unknown}"',
    'operation_id="${10:-unknown}"',
    'candidate_executable_prefix="$current/Contents/MacOS/"',
    "export candidate_executable_prefix",
    "write_journal() {",
    '  state="$1"',
    '  rollback_state="$2"',
    '  if [ ! -f "$journal" ] || ! /usr/bin/plutil -extract state raw -o - "$journal" >/dev/null 2>&1; then return 0; fi',
    '  temporary="${journal}.tmp.$$"',
    '  cp "$journal" "$temporary"',
    '  /usr/bin/plutil -replace state -string "$state" "$temporary"',
    '  /usr/bin/plutil -replace rollback_state -string "$rollback_state" "$temporary"',
    '  /usr/bin/plutil -replace updated_at -string "$(date -u "+%Y-%m-%dT%H:%M:%SZ")" "$temporary"',
    '  mv -f "$temporary" "$journal"',
    "}",
    "write_failure() {",
    '  printf \'{"code":"%s","schema_version":2,"state":"%s","target_version":"%s","operation_id":"%s","stage":"%s","rollback_state":"%s"}\' "$1" "$2" "$target_version" "$operation_id" "$3" "$4" > "$failure"',
    "}",
    "cleanup_attempt() {",
    '  rm -f "$marker" "$journal"',
    "}",
    "find_candidate_pids() {",
    '  /bin/ps -axo pid=,command= | /usr/bin/awk \'BEGIN { executable_prefix = ENVIRON["candidate_executable_prefix"] } index($0, executable_prefix) > 0 { sub(/^[[:space:]]+/, "", $0); split($0, fields, /[[:space:]]+/); if (fields[1] ~ /^[0-9]+$/) print fields[1] }\'',
    "}",
    "terminate_candidate() {",
    '  candidate_pids="$(find_candidate_pids)" || return 1',
    '  [ -n "$candidate_pids" ] || return 0',
    '  for candidate_pid in $candidate_pids; do /bin/kill -TERM "$candidate_pid" 2>/dev/null || true; done',
    "  count=0",
    '  while [ -n "$(find_candidate_pids)" ]; do',
    "    count=$((count + 1))",
    '    [ "$count" -lt 50 ] || break',
    "    sleep 0.1",
    "  done",
    '  remaining_pids="$(find_candidate_pids)" || return 1',
    '  if [ -n "$remaining_pids" ]; then',
    '    for candidate_pid in $remaining_pids; do /bin/kill -KILL "$candidate_pid" 2>/dev/null || true; done',
    "    count=0",
    '    while [ -n "$(find_candidate_pids)" ]; do',
    "      count=$((count + 1))",
    '      [ "$count" -lt 50 ] || return 1',
    "      sleep 0.1",
    "    done",
    "  fi",
    "}",
    "rollback() {",
    '  failure_code="$1"',
    '  write_journal "rollback_started" "started"',
    '  if ! terminate_candidate || ! rm -rf "$current" || [ ! -e "$backup" ] || ! mv "$backup" "$current"; then',
    '    write_journal "rollback_failed" "failed"',
    '    write_failure "update_rollback_failed" "failed" "rollback" "failed"',
    "    exit 75",
    "  fi",
    '  if ! "$opener" -n "$current"; then',
    '    write_journal "rollback_failed" "failed"',
    '    write_failure "update_rollback_failed" "failed" "rollback" "failed"',
    "    exit 75",
    "  fi",
    '  write_journal "rolled_back" "succeeded"',
    '  write_failure "$failure_code" "rolled_back" "rollback" "succeeded"',
    "  cleanup_attempt",
    "  exit 1",
    "}",
    'write_journal "waiting_for_exit" "not_started"',
    "count=0",
    'while kill -0 "$pid" 2>/dev/null; do',
    "  count=$((count + 1))",
    `  [ "$count" -lt ${processWaitAttempts} ] || { write_journal "recovery_required" "failed"; write_failure "update_swap_failed" "failed" "swap" "failed"; cleanup_attempt; exit 70; }`,
    "  sleep 0.1",
    "done",
    '[ ! -e "$backup" ] || { write_journal "recovery_required" "failed"; write_failure "update_swap_failed" "failed" "swap" "failed"; cleanup_attempt; "$opener" -n "$current" >/dev/null 2>&1 || true; exit 71; }',
    'if ! mv "$current" "$backup"; then',
    '  write_journal "recovery_required" "failed"',
    '  write_failure "update_swap_failed" "failed" "swap" "failed"',
    "  cleanup_attempt",
    '  "$opener" -n "$current" >/dev/null 2>&1 || true',
    "  exit 72",
    "fi",
    'write_journal "backup_created" "started"',
    'if ! mv "$staged" "$current"; then',
    '  rollback "update_swap_failed"',
    "fi",
    'write_journal "app_swapped" "started"',
    'if ! "$opener" -n "$current"; then',
    '  rollback "update_launch_failed"',
    "fi",
    'write_journal "launched" "started"',
    "count=0",
    'while [ ! -f "$marker" ]; do',
    "  count=$((count + 1))",
    `  [ "$count" -lt ${healthyWaitAttempts} ] || rollback "update_health_timeout"`,
    "  sleep 0.1",
    "done",
    'write_journal "healthy" "succeeded"',
    'rm -rf "$backup"',
    'write_journal "finalized" "succeeded"',
    'rm -f "$marker" "$journal" "$failure"',
  ].join("\n");
}

/**
 * Build the detached Windows app-directory swapper.  Setup and portable
 * executables remain manual delivery artifacts; online updates use a verified
 * app ZIP so the helper can exchange one staged directory and restore the
 * previous directory without invoking an installer with separate state.
 */
export function buildWindowsUpdateHelperScript(options?: {
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
    "param(",
    "  [int]$ProcessId,",
    "  [string]$InstallDirectory,",
    "  [string]$StagedDirectory,",
    "  [string]$BackupDirectory,",
    "  [string]$TargetExecutable,",
    "  [string]$MarkerPath,",
    "  [string]$JournalPath,",
    "  [string]$FailurePath,",
    "  [string]$HelperPath,",
    "  [string]$TargetVersion,",
    "  [string]$OperationId",
    ")",
    "$ErrorActionPreference = 'Stop'",
    "Set-StrictMode -Version Latest",
    `$ProcessWaitAttempts = ${processWaitAttempts}`,
    `$HealthyWaitAttempts = ${healthyWaitAttempts}`,
    "function Remove-IfExists([string]$Path) {",
    "  if (Test-Path -LiteralPath $Path) {",
    "    Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction SilentlyContinue",
    "  }",
    "}",
    "function Write-Failure([string]$Code, [string]$State = 'failed') {",
    "  try {",
    "    $json = [ordered]@{ code = $Code; schema_version = 2; state = $State; target_version = $TargetVersion; operation_id = $OperationId; stage = if ($Code -eq 'update_rollback_failed') { 'rollback' } else { 'swap' }; rollback_state = if ($State -eq 'rolled_back') { 'succeeded' } else { 'failed' } } | ConvertTo-Json -Compress",
    "    [System.IO.File]::WriteAllText($FailurePath, $json, (New-Object System.Text.UTF8Encoding($false)))",
    "  } catch { }",
    "}",
    "function Write-Journal([string]$State, [string]$RollbackState) {",
    "  if (-not (Test-Path -LiteralPath $JournalPath -PathType Leaf)) { return }",
    "  $document = Get-Content -LiteralPath $JournalPath -Raw | ConvertFrom-Json",
    "  if (-not ($document.PSObject.Properties.Name -contains 'state')) { return }",
    "  $document.state = $State",
    "  $document.rollback_state = $RollbackState",
    "  $document.updated_at = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')",
    "  $temporary = $JournalPath + '.tmp.' + $PID",
    "  $json = $document | ConvertTo-Json -Compress",
    "  [System.IO.File]::WriteAllText($temporary, $json, (New-Object System.Text.UTF8Encoding($false)))",
    "  try { [System.IO.File]::Replace($temporary, $JournalPath, $null) } catch { Move-Item -LiteralPath $temporary -Destination $JournalPath -Force }",
    "}",
    "function Get-DescendantIds([int]$RootId) {",
    "  $all = @(Get-CimInstance Win32_Process -ErrorAction Stop)",
    "  $children = @{}",
    "  foreach ($item in $all) {",
    "    $parent = [int]$item.ParentProcessId",
    "    if (-not $children.ContainsKey($parent)) { $children[$parent] = New-Object System.Collections.Generic.List[int] }",
    "    [void]$children[$parent].Add([int]$item.ProcessId)",
    "  }",
    "  $seen = New-Object System.Collections.Generic.HashSet[int]",
    "  $queue = New-Object System.Collections.Generic.Queue[int]",
    "  [void]$queue.Enqueue($RootId)",
    "  while ($queue.Count -gt 0) {",
    "    $id = $queue.Dequeue()",
    "    if (-not $seen.Add($id)) { continue }",
    "    if ($children.ContainsKey($id)) { foreach ($child in $children[$id]) { [void]$queue.Enqueue($child) } }",
    "  }",
    "  return @($seen)",
    "}",
    "function Wait-ForProcessTreeExit {",
    "  for ($attempt = 0; $attempt -lt $ProcessWaitAttempts; $attempt++) {",
    "    $running = $false",
    "    try {",
    "      foreach ($id in (Get-DescendantIds $ProcessId)) {",
    "        if (Get-Process -Id $id -ErrorAction SilentlyContinue) { $running = $true; break }",
    "      }",
    "    } catch { throw 'process_tree_query_failed' }",
    "    if (-not $running) { return }",
    "    Start-Sleep -Milliseconds 100",
    "  }",
    "  throw 'process_wait_timeout'",
    "}",
    "function Stop-ProcessTree([int]$RootId) {",
    "  $ids = @(Get-DescendantIds $RootId | Sort-Object -Descending)",
    "  foreach ($id in $ids) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }",
    "  for ($attempt = 0; $attempt -lt $ProcessWaitAttempts; $attempt++) {",
    "    $running = $false",
    "    foreach ($id in $ids) {",
    "      if (Get-Process -Id $id -ErrorAction SilentlyContinue) { $running = $true; break }",
    "    }",
    "    if (-not $running) { return }",
    "    Start-Sleep -Milliseconds 100",
    "  }",
    "  throw 'candidate_process_stop_failed'",
    "}",
    "$newProcess = $null",
    "function Restore-Install([string]$FailureCode) {",
    "  Write-Journal 'rollback_started' 'started'",
    "  try {",
    "    if ($null -ne $newProcess -and -not $newProcess.HasExited) { Stop-ProcessTree $newProcess.Id }",
    "    Remove-IfExists $InstallDirectory",
    "    if (-not (Test-Path -LiteralPath $BackupDirectory -PathType Container)) { throw 'backup_missing' }",
    "    Move-Item -LiteralPath $BackupDirectory -Destination $InstallDirectory -Force",
    "    [void](Start-Process -FilePath $TargetExecutable -PassThru)",
    "  } catch {",
    "    Write-Journal 'rollback_failed' 'failed'",
    "    Write-Failure 'update_rollback_failed' 'failed'",
    "    exit 75",
    "  }",
    "  Write-Journal 'rolled_back' 'succeeded'",
    "  Write-Failure $FailureCode 'rolled_back'",
    "  Remove-IfExists $JournalPath",
    "  Remove-IfExists $MarkerPath",
    "  Remove-IfExists $HelperPath",
    "  exit 1",
    "}",
    "$swapped = $false",
    "$oldProcessExited = $false",
    "try {",
    "  Write-Journal 'waiting_for_exit' 'not_started'",
    "  Wait-ForProcessTreeExit",
    "  $oldProcessExited = $true",
    "  if (Test-Path -LiteralPath $BackupDirectory) { throw 'backup_exists' }",
    "  if (-not (Test-Path -LiteralPath $InstallDirectory -PathType Container)) { throw 'install_directory_missing' }",
    "  if (-not (Test-Path -LiteralPath $StagedDirectory -PathType Container)) { throw 'staged_directory_missing' }",
    "  Move-Item -LiteralPath $InstallDirectory -Destination $BackupDirectory -Force",
    "  $swapped = $true",
    "  Write-Journal 'backup_created' 'started'",
    "  Move-Item -LiteralPath $StagedDirectory -Destination $InstallDirectory -Force",
    "  Write-Journal 'app_swapped' 'started'",
    "  if (-not (Test-Path -LiteralPath $TargetExecutable -PathType Leaf)) { throw 'installed_executable_missing' }",
    "  $newProcess = Start-Process -FilePath $TargetExecutable -PassThru",
    "  Write-Journal 'launched' 'started'",
    "  $healthy = $false",
    "  for ($attempt = 0; $attempt -lt $HealthyWaitAttempts; $attempt++) {",
    "    if (Test-Path -LiteralPath $MarkerPath -PathType Leaf) { $healthy = $true; break }",
    "    if ($newProcess.HasExited) { throw 'new_process_exited_before_health' }",
    "    Start-Sleep -Milliseconds 100",
    "  }",
    "  if (-not $healthy) { throw 'health_timeout' }",
    "  Write-Journal 'healthy' 'succeeded'",
    "  Remove-IfExists $BackupDirectory",
    "  Write-Journal 'finalized' 'succeeded'",
    "  Remove-IfExists $MarkerPath",
    "  Remove-IfExists $JournalPath",
    "  Remove-IfExists $FailurePath",
    "  Remove-IfExists $HelperPath",
    "  exit 0",
    "} catch {",
    "  if (-not $swapped) {",
    "    Write-Journal 'recovery_required' 'failed'",
    "    $code = if ($_.Exception.Message -eq 'process_wait_timeout' -or $_.Exception.Message -eq 'process_tree_query_failed') { 'update_swap_failed' } else { 'update_staged_identity_invalid' }",
    "    Write-Failure $code 'failed'",
    "    Remove-IfExists $JournalPath",
    "    Remove-IfExists $MarkerPath",
    "    Remove-IfExists $HelperPath",
    "    if ($oldProcessExited) {",
    "      try {",
    "        if (-not (Test-Path -LiteralPath $TargetExecutable -PathType Leaf)) { throw 'old_executable_missing' }",
    "        [void](Start-Process -FilePath $TargetExecutable)",
    "      } catch {",
    "        Write-Failure 'update_rollback_failed' 'failed'",
    "        exit 75",
    "      }",
    "    }",
    "    exit 1",
    "  }",
    "  $code = if ($_.Exception.Message -eq 'health_timeout' -or $_.Exception.Message -eq 'new_process_exited_before_health') { 'update_health_timeout' } else { 'update_swap_failed' }",
    "  Restore-Install $code",
    "}",
  ].join("\n");
}

async function defaultInstallArtifact(
  pending: PendingDesktopUpdate,
  context: InstallContext,
): Promise<void> {
  const spawnDetachedProcess = context.spawnDetachedProcess ?? spawnDetached;
  if (context.platform === "win32") {
    const currentExecutable = safeWindowsExecutablePath(context.currentAppPath);
    const installDirectory = dirname(currentExecutable);
    await validateWindowsInstallPreflight(currentExecutable);
    const backupDirectory = `${installDirectory}.aera-update-backup-${process.pid}`;
    const markerPath = assertOwnedPath(
      context.root,
      join(
        context.root,
        `install-success-${pending.offer.manifest.version}-${process.pid}`,
      ),
      "Desktop update success marker",
    );
    const failurePath = assertOwnedPath(
      context.root,
      join(context.root, "install-failure.json"),
      "Desktop update failure marker",
    );
    const journalPath = assertOwnedPath(
      context.root,
      join(context.root, "install-journal.json"),
      "Desktop update journal",
    );
    const helperPath = assertOwnedPath(
      context.root,
      join(
        context.root,
        `windows-update-helper-${pending.offer.manifest.version}-${process.pid}-${randomUUID()}.ps1`,
      ),
      "Desktop update helper",
    );
    let journal = installJournalFor({
      pending,
      context,
      currentAppPath: installDirectory,
      stagedAppPath: pending.stagingDirectory,
      backupPath: backupDirectory,
      successMarker: markerPath,
      failureMarker: failurePath,
    });
    try {
      journal = await writeInstallJournal(journalPath, journal);
      await writeFile(helperPath, buildWindowsUpdateHelperScript(), {
        flag: "wx",
        mode: 0o600,
      });
      journal = await writeInstallJournal(
        journalPath,
        journal,
        "waiting_for_exit",
      );
      await spawnDetachedProcess(
        windowsPowerShellPath(),
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          helperPath,
          String(process.pid),
          installDirectory,
          pending.stagingDirectory,
          backupDirectory,
          currentExecutable,
          markerPath,
          journalPath,
          failurePath,
          helperPath,
          pending.offer.manifest.version,
          journal.operation_id,
        ],
        { windowsHide: true },
      );
    } catch (error) {
      await Promise.all([
        rm(journalPath, { force: true }),
        rm(helperPath, { force: true }),
      ]);
      if (error instanceof DesktopUpdateError) throw error;
      throw new DesktopUpdateError("Desktop update helper could not start", {
        cause: error,
        code: "update_swap_failed",
        stage: "swap",
      });
    }
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
  const failurePath = assertOwnedPath(
    context.root,
    join(context.root, "install-failure.json"),
    "Desktop update failure marker",
  );
  let journal = installJournalFor({
    pending,
    context,
    currentAppPath,
    stagedAppPath,
    backupPath,
    successMarker: markerPath,
    failureMarker: failurePath,
  });
  try {
    journal = await writeInstallJournal(journalPath, journal);
    journal = await writeInstallJournal(
      journalPath,
      journal,
      "waiting_for_exit",
    );
    await spawnDetachedProcess("/bin/sh", [
      "-c",
      buildMacUpdateHelperScript(),
      "aera-desktop-updater",
      String(process.pid),
      currentAppPath,
      stagedAppPath,
      backupPath,
      markerPath,
      journalPath,
      failurePath,
      "/usr/bin/open",
      pending.offer.manifest.version,
      journal.operation_id,
    ]);
  } catch (error) {
    await Promise.all([
      rm(journalPath, { force: true }),
      rm(markerPath, { force: true }),
      rm(failurePath, { force: true }),
    ]);
    if (error instanceof DesktopUpdateError) throw error;
    throw new DesktopUpdateError("Desktop update helper could not start", {
      cause: error,
      code: "update_swap_failed",
      stage: "swap",
    });
  }
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
  private operationId: string = randomUUID();
  private readonly diagnosticId = desktopUpdateDiagnosticId();
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
    errorCode: null,
    stage: null,
    diagnosticId: null,
    stageEvent: null,
  };
  private offer: DesktopUpdateOffer | null = null;
  private pending: PendingDesktopUpdate | null = null;
  private autoDownload: boolean;
  private checkPromise: Promise<string | null> | null = null;
  private downloadPromise: Promise<boolean> | null = null;
  private controller: AbortController | null = null;
  private initialized = false;
  private rendererReady = false;
  private healthyInstallSignaled = false;

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
      (async (request) => {
        try {
          await downloadWithResume({
            ...request,
            maxRedirects: 0,
          });
        } catch (error) {
          throw classifyDesktopUpdateDownloadError(error);
        }
      });
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
    next: Omit<
      DesktopUpdateSnapshot,
      "releaseNotes" | "errorCode" | "stage" | "diagnosticId" | "stageEvent"
    > & {
      releaseNotes?: string | null;
      errorCode?: DesktopUpdateErrorCode | null;
      stage?: DesktopUpdateStage | null;
      diagnosticId?: string | null;
      stageEvent?: DesktopUpdateStageV2 | null;
    },
  ): void {
    this.snapshot = {
      ...next,
      errorCode: next.errorCode ?? null,
      stage: next.stage ?? null,
      diagnosticId: next.diagnosticId ?? null,
      stageEvent: next.stageEvent ?? null,
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

  private publishFailure(
    error: unknown,
    fallbackCode: DesktopUpdateErrorCode,
    fallbackStage: DesktopUpdateStage,
    version: string | null,
  ): void {
    const snapshot = createDesktopUpdateFailureSnapshot({
      error,
      fallbackCode,
      fallbackStage,
      version,
      releaseNotes: this.snapshot.releaseNotes,
      operationId: this.operationId,
    });
    this.options.log.error(
      `Desktop update failed code=${snapshot.errorCode} stage=${snapshot.stage} diagnostic=${snapshot.diagnosticId}`,
    );
    this.publish(snapshot);
  }

  private emitStage(
    stage: DesktopUpdateStage,
    state: DesktopUpdateStageV2["state"],
    code: DesktopUpdateErrorCode | null,
    targetVersion: string | null,
  ): void {
    this.publish({
      state: this.snapshot.state,
      version: this.snapshot.version,
      percent: this.snapshot.percent,
      error: this.snapshot.error,
      releaseNotes: this.snapshot.releaseNotes,
      errorCode: this.snapshot.errorCode,
      stage: this.snapshot.stage,
      diagnosticId: this.snapshot.diagnosticId,
      stageEvent: desktopUpdateStageV2({
        operationId: this.operationId,
        stage,
        state,
        code,
        targetVersion,
        diagnosticId: this.diagnosticId,
      }),
    });
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

  private installFailurePath(): string {
    return assertOwnedPath(
      this.root,
      join(this.root, "install-failure.json"),
      "Desktop update failure path",
    );
  }

  private validateInstallJournalBinding(journal: InstallJournalV2): void {
    if (journal.platform !== this.options.platform) {
      throw new DesktopUpdateError("Desktop update journal platform differs");
    }
    const expectedCurrent =
      this.options.platform === "darwin"
        ? safeMacAppPath(this.options.currentAppPath)
        : dirname(safeWindowsExecutablePath(this.options.currentAppPath));
    if (resolve(journal.current_app_path) !== expectedCurrent) {
      throw new DesktopUpdateError("Desktop update journal app path differs");
    }
    const backupPrefix = `${expectedCurrent}.aera-update-backup-`;
    if (
      !journal.backup_path.startsWith(backupPrefix) ||
      !/^[1-9][0-9]*$/u.test(journal.backup_path.slice(backupPrefix.length))
    ) {
      throw new DesktopUpdateError(
        "Desktop update journal backup path differs",
      );
    }
    const expectedStaging = this.stagingDirectory(journal.target_version);
    const staged = assertOwnedPath(
      this.root,
      journal.staged_app_path,
      "Desktop update staged app path",
    );
    if (
      (journal.platform === "win32" && staged !== expectedStaging) ||
      (journal.platform === "darwin" &&
        (dirname(staged) !== expectedStaging || !staged.endsWith(".app")))
    ) {
      throw new DesktopUpdateError(
        "Desktop update journal staging path differs",
      );
    }
    if (
      assertOwnedPath(
        this.root,
        journal.success_marker,
        "Desktop update success marker",
      ) !== journal.success_marker ||
      assertOwnedPath(
        this.root,
        journal.failure_marker,
        "Desktop update failure marker",
      ) !== this.installFailurePath()
    ) {
      throw new DesktopUpdateError(
        "Desktop update journal marker path differs",
      );
    }
    const expectedArtifactName =
      journal.platform === "darwin"
        ? `Aera-Internal-Beta-${journal.target_version}-macos-arm64.zip`
        : `Aera-Internal-Beta-${journal.target_version}-windows-x64-app.zip`;
    if (journal.artifact_name !== expectedArtifactName) {
      throw new DesktopUpdateError("Desktop update journal artifact differs");
    }
  }

  private async recoverInterruptedInstall(): Promise<void> {
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
    let journal: InstallJournalV1 | InstallJournalV2;
    try {
      journal = parseInstallJournal(raw);
    } catch (error) {
      this.publishFailure(error, "update_rollback_failed", "rollback", null);
      return;
    }
    if (journal.schema_version === 1) return;
    this.operationId = journal.operation_id;
    try {
      this.validateInstallJournalBinding(journal);
    } catch (error) {
      this.publishFailure(
        error,
        "update_rollback_failed",
        "rollback",
        journal.target_version,
      );
      return;
    }
    if (journal.state === "finalized" || journal.state === "rolled_back") {
      await Promise.all([
        rm(this.installJournalPath(), { force: true }),
        rm(journal.success_marker, { force: true }),
      ]);
      return;
    }
    if (
      journal.state === "rollback_failed" ||
      journal.state === "recovery_required"
    ) {
      await writeInstallFailureMarker(
        journal,
        "update_rollback_failed",
        "failed",
        "rollback",
        "failed",
      );
      return;
    }
    if (
      compareInternalBetaVersions(
        journal.target_version,
        this.options.currentVersion,
      ) === 0 &&
      ["app_swapped", "launched", "healthy"].includes(journal.state)
    ) {
      return;
    }
    if (journal.state === "prepared" || journal.state === "waiting_for_exit") {
      await writeInstallFailureMarker(
        journal,
        "update_swap_failed",
        "failed",
        "swap",
        "not_started",
      );
      return;
    }
    try {
      journal = await writeInstallJournal(
        this.installJournalPath(),
        journal,
        "rollback_started",
        "started",
      );
      const backup = await pathStatus(journal.backup_path);
      if (backup === null || !backup.isDirectory() || backup.isSymbolicLink()) {
        throw new DesktopUpdateError("Desktop update backup is unavailable");
      }
      const current = await pathStatus(journal.current_app_path);
      if (current !== null) {
        if (!current.isDirectory() || current.isSymbolicLink()) {
          throw new DesktopUpdateError("Desktop update current app is unsafe");
        }
        await rm(journal.current_app_path, { recursive: true, force: true });
      }
      await rename(journal.backup_path, journal.current_app_path);
      journal = await writeInstallJournal(
        this.installJournalPath(),
        journal,
        "rolled_back",
        "succeeded",
      );
      await writeInstallFailureMarker(
        journal,
        "update_swap_failed",
        "rolled_back",
        "rollback",
        "succeeded",
      );
    } catch (_error) {
      journal = await writeInstallJournal(
        this.installJournalPath(),
        journal,
        "rollback_failed",
        "failed",
      );
      await writeInstallFailureMarker(
        journal,
        "update_rollback_failed",
        "failed",
        "rollback",
        "failed",
      );
      this.options.log.error(
        `Desktop update recovery failed operation=${journal.operation_id}`,
      );
    }
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await this.recoverInterruptedInstall();
    await this.signalInstallFailure();
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
    this.initialized = true;
    if (this.rendererReady) await this.signalHealthyInstallOnce();
  }

  /**
   * A helper must not consider an install healthy until the packaged
   * renderer has actually loaded.  `initialize()` runs at `app.whenReady`,
   * which is earlier than BrowserWindow creation in the desktop startup
   * sequence; this explicit handshake is the rollback gate.
   */
  async markRendererReady(): Promise<void> {
    this.rendererReady = true;
    if (!this.initialized) return;
    await this.signalHealthyInstallOnce();
  }

  private async signalHealthyInstallOnce(): Promise<void> {
    if (this.healthyInstallSignaled) return;
    await this.signalHealthyInstall();
    this.healthyInstallSignaled = true;
  }

  private async signalInstallFailure(): Promise<void> {
    let raw: Buffer;
    try {
      raw = await readFile(this.installFailurePath());
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

    let failureRecord: InstallFailureRecord = {
      code: "update_swap_failed",
      state: "failed",
      targetVersion: null,
      operationId: null,
      stage: null,
      rollbackState: null,
    };
    try {
      failureRecord = parseInstallFailure(raw);
      if (
        failureRecord.code === "update_health_timeout" ||
        failureRecord.code === "update_launch_failed"
      ) {
        // Beta.32 helpers only wrote these codes after restoring the backup.
        failureRecord.state = "rolled_back";
      }
    } catch {
      // A malformed helper marker is still an install failure, but never let
      // its contents block startup or expose a raw path/body to the UI.
    }

    if (failureRecord.operationId !== null) {
      this.operationId = failureRecord.operationId;
    }
    const code = failureRecord.code;
    const version = failureRecord.targetVersion;

    const stage: DesktopUpdateStage =
      failureRecord.stage ??
      (code === "update_health_timeout"
        ? "health"
        : code === "update_rollback_failed"
          ? "rollback"
          : code === "update_staged_identity_invalid" ||
              code === "update_staged_native_invalid"
            ? "stage"
            : "swap");
    this.publish(
      createDesktopUpdateFailureSnapshot({
        error: new DesktopUpdateError(
          "Desktop update helper reported failure",
          {
            code,
            stage,
          },
        ),
        fallbackCode: code,
        fallbackStage: stage,
        version,
        releaseNotes: null,
      }),
    );
    if (failureRecord.state === "rolled_back") {
      this.emitStage("rollback", "rolled_back", code, version);
    }
    if (code === "update_rollback_failed") {
      await rm(this.installFailurePath(), { force: true });
    } else {
      await Promise.all([
        rm(this.installFailurePath(), { force: true }),
        rm(this.installJournalPath(), { force: true }),
        this.clearPendingFiles(),
      ]);
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
    const journal = parseInstallJournal(raw);
    if (journal.schema_version === 2) {
      this.validateInstallJournalBinding(journal);
    }
    if (
      compareInternalBetaVersions(
        journal.target_version,
        this.options.currentVersion,
      ) !== 0 ||
      (journal.schema_version === 2 &&
        (journal.platform !== this.options.platform ||
          !["app_swapped", "launched", "healthy"].includes(journal.state)))
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
    if (journal.schema_version === 2) {
      await writeInstallJournal(
        this.installJournalPath(),
        journal,
        "healthy",
        "succeeded",
      );
    }
    this.emitStage("health", "succeeded", null, journal.target_version);
    this.emitStage("finalize", "succeeded", null, journal.target_version);
    if (journal.schema_version === 2 && journal.state === "healthy") {
      await Promise.all([
        rm(journal.backup_path, { recursive: true, force: true }),
        rm(journal.success_marker, { force: true }),
        rm(journal.failure_marker, { force: true }),
        rm(this.installJournalPath(), { force: true }),
      ]);
    }
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
    this.emitStage("extract", "started", null, offer.manifest.version);
    await this.prepareArtifact(offer, artifactPath, stagingDirectory);
    this.emitStage("extract", "succeeded", null, offer.manifest.version);
    this.emitStage("stage", "succeeded", null, offer.manifest.version);
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
    this.emitStage("metadata", "started", null, null);
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
      this.emitStage("metadata", "succeeded", null, null);
      this.emitStage("verify", "started", null, null);
      const offer = this.offerFromMetadata(manifestBytes, signatureBytes);
      this.emitStage("verify", "succeeded", null, offer.manifest.version);
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
      this.publishFailure(error, "update_metadata_invalid", "metadata", null);
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
    this.emitStage("download", "started", null, offer.manifest.version);
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
      this.emitStage("download", "succeeded", null, offer.manifest.version);
      this.emitStage("verify", "started", null, offer.manifest.version);
      await verifyArtifactFile(artifactPath, offer.artifact);
      this.emitStage("verify", "succeeded", null, offer.manifest.version);
      this.emitStage("extract", "started", null, offer.manifest.version);
      await this.prepareArtifact(offer, artifactPath, stagingDirectory);
      this.emitStage("extract", "succeeded", null, offer.manifest.version);
      this.emitStage("stage", "started", null, offer.manifest.version);
      this.emitStage("stage", "succeeded", null, offer.manifest.version);
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
      this.publishFailure(
        error,
        "update_artifact_unavailable",
        "download",
        offer.manifest.version,
      );
      return false;
    } finally {
      if (this.controller === controller) this.controller = null;
    }
  }

  async install(): Promise<void> {
    if (!this.pending) {
      throw new DesktopUpdateError("Desktop update is not ready", {
        code: "update_client_bridge_required",
        stage: "stage",
      });
    }
    await this.installArtifact(this.pending, {
      root: this.root,
      currentAppPath: this.options.currentAppPath,
      platform: this.options.platform,
      currentVersion: this.options.currentVersion,
      spawnDetachedProcess: this.options.spawnDetachedProcess,
    });
  }

  dispose(): void {
    this.controller?.abort();
  }
}

export function tryCreateInternalBetaDesktopUpdater(
  options: InternalBetaUpdaterOptions,
): InternalBetaDesktopUpdater | null {
  try {
    return new InternalBetaDesktopUpdater(options);
  } catch (error) {
    options.log.error(
      `Internal Beta updater configuration is unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}
