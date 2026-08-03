import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  chmodSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  type BigIntStats,
} from "node:fs";
import { open as openFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import Database from "better-sqlite3";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { RuntimeActivityCoordinator } from "../runtime-activity";
import {
  AGENTERA_ENCRYPTED_BACKUP_MAXIMUM_BYTES,
  createEncryptedBackupSnapshotManifest,
  serializeEncryptedBackupSnapshotManifest,
  type EncryptedBackupSnapshotFile,
  type EncryptedBackupSnapshotFileKind,
  type EncryptedBackupSnapshotManifest,
  type EncryptedBackupSnapshotProvenance,
} from "./manifest";

const MAXIMUM_CONFIG_BYTES = 1024 * 1024;
const MAXIMUM_PROVENANCE_BYTES = 1024 * 1024;
const MAXIMUM_SNAPSHOT_FILES = 100_000;
const FILE_CAPTURE_ATTEMPTS = 3;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FORBIDDEN_SEGMENTS = new Set([
  ".env",
  "auth.json",
  "credentials",
  "credentials.json",
  ".ssh",
  ".usage.json",
  "cache",
  ".cache",
  "logs",
  "log",
  "tmp",
  "temp",
  "runtime",
  "projections",
  "gateway.pid",
  "gateway.log",
  "dashboard.log",
]);
const SAFE_CONFIG_SCALARS = [
  "model",
  "provider",
  "default_model",
  "temperature",
  "max_tokens",
  "reasoning_effort",
  "language",
  "timezone",
  "personality",
] as const;
const SAFE_AUXILIARY_FIELDS = ["provider", "model"] as const;

export type EncryptedBackupSnapshotErrorCode =
  | "runtime_busy"
  | "invalid_profile"
  | "unsafe_entry"
  | "path_collision"
  | "unstable_file"
  | "snapshot_too_large"
  | "cancelled"
  | "database_backup_failed"
  | "invalid_config";

export class EncryptedBackupSnapshotError extends Error {
  readonly code: EncryptedBackupSnapshotErrorCode;

  constructor(code: EncryptedBackupSnapshotErrorCode) {
    super(`Aera encrypted backup snapshot failed: ${code}.`);
    this.name = "EncryptedBackupSnapshotError";
    this.code = code;
  }
}

export interface EncryptedBackupSnapshot {
  transactionId: string;
  transactionPath: string;
  filesPath: string;
  manifestPath: string;
  manifest: EncryptedBackupSnapshotManifest;
  manifestBytes: Buffer;
}

export interface EncryptedBackupSnapshotFileHooks {
  afterRead?(sourcePath: string, attempt: number): void;
}

export interface EncryptedBackupSqliteSnapshotAdapter {
  backup(sourcePath: string, destinationPath: string): Promise<void>;
  normalize(path: string): void;
  verify(path: string): boolean;
}

export interface EncryptedBackupSnapshotInput {
  profilePath: string;
  transactionsRoot: string;
  profileLineageId: string;
  provenance: EncryptedBackupSnapshotProvenance;
  encryptedRuntimeBindingProvenance: Uint8Array;
  activity: RuntimeActivityCoordinator;
  signal?: AbortSignal;
  maximumBytes?: number;
  now?: () => Date;
  randomUUID?: () => string;
  fileHooks?: EncryptedBackupSnapshotFileHooks;
  sqlite?: EncryptedBackupSqliteSnapshotAdapter;
}

interface SourceFile {
  sourcePath: string;
  relativePath: string;
  kind: EncryptedBackupSnapshotFileKind;
  treatment: "copy" | "config" | "sqlite";
}

function fail(code: EncryptedBackupSnapshotErrorCode): never {
  throw new EncryptedBackupSnapshotError(code);
}

function isInside(parent: string, child: string): boolean {
  const value = relative(resolve(parent), resolve(child));
  return value === "" || (!value.startsWith("..") && !isAbsolute(value));
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) fail("cancelled");
}

export function normalizeSnapshotRelativePath(value: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.includes("\0") ||
    value.includes("\\") ||
    isAbsolute(value) ||
    /^[A-Za-z]:/.test(value) ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("//")
  ) {
    fail("unsafe_entry");
  }
  const segments = value.split("/");
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    fail("unsafe_entry");
  }
  const normalized = segments
    .map((segment) => segment.normalize("NFC"))
    .join("/");
  if (
    normalized.length > 1024 ||
    Buffer.byteLength(normalized, "utf8") > 4096
  ) {
    fail("unsafe_entry");
  }
  return normalized;
}

export function assertUniqueSnapshotPaths(values: readonly string[]): void {
  const exact = new Set<string>();
  const folded = new Set<string>();
  for (const value of values) {
    const normalized = normalizeSnapshotRelativePath(value);
    const caseFolded = normalized.toLocaleLowerCase("en-US");
    if (exact.has(normalized) || folded.has(caseFolded)) {
      fail("path_collision");
    }
    exact.add(normalized);
    folded.add(caseFolded);
  }
}

function forbiddenPath(relativePath: string): boolean {
  return relativePath.split("/").some((segment) => {
    const folded = segment.toLocaleLowerCase("en-US");
    return (
      FORBIDDEN_SEGMENTS.has(folded) ||
      folded.endsWith(".pem") ||
      folded.endsWith(".key")
    );
  });
}

function safeDestination(filesPath: string, relativePath: string): string {
  const destination = join(
    filesPath,
    ...normalizeSnapshotRelativePath(relativePath).split("/"),
  );
  if (!isInside(filesPath, destination)) fail("unsafe_entry");
  return destination;
}

function inspectRegularFile(path: string): BigIntStats {
  let stats: BigIntStats;
  try {
    stats = lstatSync(path, { bigint: true });
  } catch {
    fail("unstable_file");
  }
  if (
    stats.isSymbolicLink() ||
    !stats.isFile() ||
    stats.nlink !== 1n ||
    stats.size < 0n ||
    stats.size > BigInt(AGENTERA_ENCRYPTED_BACKUP_MAXIMUM_BYTES)
  ) {
    fail("unsafe_entry");
  }
  return stats;
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.nlink === right.nlink
  );
}

function identityToken(stats: BigIntStats): string {
  return [
    stats.dev,
    stats.ino,
    stats.size,
    stats.mode,
    stats.mtimeNs,
    stats.ctimeNs,
    stats.nlink,
  ].join(":");
}

function ensurePrivateParent(path: string): void {
  const parent = resolve(path, "..");
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  chmodSync(parent, 0o700);
}

async function hashOpenFileContents(input: {
  file: Awaited<ReturnType<typeof openFile>>;
  maximumBytes: number;
  signal?: AbortSignal;
}): Promise<{ size: number; sha256: string }> {
  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let size = 0;
  try {
    for (;;) {
      throwIfCancelled(input.signal);
      const { bytesRead } = await input.file.read(
        buffer,
        0,
        buffer.byteLength,
        size,
      );
      if (bytesRead === 0) break;
      size += bytesRead;
      if (size > input.maximumBytes) fail("snapshot_too_large");
      digest.update(buffer.subarray(0, bytesRead));
    }
    return { size, sha256: digest.digest("hex") };
  } finally {
    buffer.fill(0);
  }
}

async function captureStableFile(input: {
  sourcePath: string;
  destinationPath: string;
  remainingBytes: number;
  signal?: AbortSignal;
  hooks?: EncryptedBackupSnapshotFileHooks;
}): Promise<{ size: number; sha256: string; sourceIdentity: string }> {
  for (let attempt = 1; attempt <= FILE_CAPTURE_ATTEMPTS; attempt += 1) {
    throwIfCancelled(input.signal);
    const before = inspectRegularFile(input.sourcePath);
    if (before.size > BigInt(input.remainingBytes)) {
      fail("snapshot_too_large");
    }
    ensurePrivateParent(input.destinationPath);
    const temporaryPath = `${input.destinationPath}.attempt-${attempt}`;
    let source: Awaited<ReturnType<typeof openFile>> | null = null;
    let destination: Awaited<ReturnType<typeof openFile>> | null = null;
    try {
      source = await openFile(
        input.sourcePath,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      const opened = await source.stat({ bigint: true });
      if (!opened.isFile() || !sameIdentity(before, opened)) {
        continue;
      }
      destination = await openFile(
        temporaryPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      const digest = createHash("sha256");
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      let position = 0;
      for (;;) {
        throwIfCancelled(input.signal);
        const { bytesRead } = await source.read(
          buffer,
          0,
          buffer.byteLength,
          position,
        );
        if (bytesRead === 0) break;
        position += bytesRead;
        if (position > input.remainingBytes) fail("snapshot_too_large");
        digest.update(buffer.subarray(0, bytesRead));
        let written = 0;
        while (written < bytesRead) {
          const result = await destination.write(
            buffer,
            written,
            bytesRead - written,
          );
          if (result.bytesWritten < 1) fail("unstable_file");
          written += result.bytesWritten;
        }
      }
      buffer.fill(0);
      const copiedSha256 = digest.digest("hex");
      input.hooks?.afterRead?.(input.sourcePath, attempt);
      const verification = await hashOpenFileContents({
        file: source,
        maximumBytes: input.remainingBytes,
        signal: input.signal,
      });
      const afterHandle = await source.stat({ bigint: true });
      const afterPath = inspectRegularFile(input.sourcePath);
      if (
        position !== Number(before.size) ||
        verification.size !== position ||
        verification.sha256 !== copiedSha256 ||
        !sameIdentity(before, afterHandle) ||
        !sameIdentity(before, afterPath)
      ) {
        continue;
      }
      await destination.sync();
      await destination.close();
      destination = null;
      await source.close();
      source = null;
      renameSync(temporaryPath, input.destinationPath);
      chmodSync(input.destinationPath, 0o600);
      return {
        size: position,
        sha256: copiedSha256,
        sourceIdentity: identityToken(afterPath),
      };
    } catch (error) {
      if (error instanceof EncryptedBackupSnapshotError) throw error;
      if (attempt === FILE_CAPTURE_ATTEMPTS) fail("unstable_file");
    } finally {
      await source?.close().catch(() => undefined);
      await destination?.close().catch(() => undefined);
      rmSync(temporaryPath, { force: true });
    }
  }
  fail("unstable_file");
}

async function readStableFile(input: {
  sourcePath: string;
  maximumBytes: number;
  signal?: AbortSignal;
  hooks?: EncryptedBackupSnapshotFileHooks;
}): Promise<{ content: Buffer; sourceIdentity: string }> {
  for (let attempt = 1; attempt <= FILE_CAPTURE_ATTEMPTS; attempt += 1) {
    throwIfCancelled(input.signal);
    const before = inspectRegularFile(input.sourcePath);
    if (before.size > BigInt(input.maximumBytes)) {
      fail("snapshot_too_large");
    }
    let file: Awaited<ReturnType<typeof openFile>> | null = null;
    let content: Buffer | null = null;
    try {
      file = await openFile(
        input.sourcePath,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      const opened = await file.stat({ bigint: true });
      if (!opened.isFile() || !sameIdentity(before, opened)) continue;
      content = Buffer.alloc(Number(before.size));
      let position = 0;
      while (position < content.byteLength) {
        throwIfCancelled(input.signal);
        const result = await file.read(
          content,
          position,
          content.byteLength - position,
          position,
        );
        if (result.bytesRead < 1) break;
        position += result.bytesRead;
      }
      input.hooks?.afterRead?.(input.sourcePath, attempt);
      const verification = await hashOpenFileContents({
        file,
        maximumBytes: input.maximumBytes,
        signal: input.signal,
      });
      const afterHandle = await file.stat({ bigint: true });
      const afterPath = inspectRegularFile(input.sourcePath);
      if (
        position !== content.byteLength ||
        verification.size !== content.byteLength ||
        verification.sha256 !==
          createHash("sha256").update(content).digest("hex") ||
        !sameIdentity(before, afterHandle) ||
        !sameIdentity(before, afterPath)
      ) {
        content.fill(0);
        content = null;
        continue;
      }
      return {
        content,
        sourceIdentity: identityToken(afterPath),
      };
    } catch (error) {
      content?.fill(0);
      if (error instanceof EncryptedBackupSnapshotError) throw error;
      if (attempt === FILE_CAPTURE_ATTEMPTS) fail("unstable_file");
    } finally {
      await file?.close().catch(() => undefined);
    }
  }
  fail("unstable_file");
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function safeConfigScalar(value: unknown): string | number | boolean | null {
  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    (typeof value === "string" && value.length <= 4096 && !value.includes("\0"))
  ) {
    return value;
  }
  fail("invalid_config");
}

function sanitizeConfig(content: Buffer): Buffer {
  let parsed: unknown;
  try {
    parsed = parseYaml(content.toString("utf8"), {
      maxAliasCount: 0,
      uniqueKeys: true,
    });
  } catch {
    fail("invalid_config");
  } finally {
    content.fill(0);
  }
  if (!plainObject(parsed)) fail("invalid_config");
  const sanitized: Record<string, unknown> = {};
  for (const field of SAFE_CONFIG_SCALARS) {
    if (Object.hasOwn(parsed, field)) {
      sanitized[field] = safeConfigScalar(parsed[field]);
    }
  }
  if (Object.hasOwn(parsed, "auxiliary")) {
    if (!plainObject(parsed.auxiliary)) fail("invalid_config");
    const auxiliary: Record<string, unknown> = {};
    for (const task of Object.keys(parsed.auxiliary).sort()) {
      const value = parsed.auxiliary[task];
      if (!plainObject(value)) fail("invalid_config");
      const safeTask: Record<string, unknown> = {};
      for (const field of SAFE_AUXILIARY_FIELDS) {
        if (Object.hasOwn(value, field)) {
          safeTask[field] = safeConfigScalar(value[field]);
        }
      }
      if (Object.keys(safeTask).length > 0) auxiliary[task] = safeTask;
    }
    if (Object.keys(auxiliary).length > 0) {
      sanitized.auxiliary = auxiliary;
    }
  }
  return Buffer.from(
    stringifyYaml(sanitized, { sortMapEntries: true }),
    "utf8",
  );
}

function writePrivateFile(path: string, content: Uint8Array): void {
  ensurePrivateParent(path);
  const descriptor = openSync(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600,
  );
  try {
    writeFileSync(descriptor, content);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  chmodSync(path, 0o600);
}

function walkAllowedDirectory(
  profilePath: string,
  relativeRoot: string,
  kind: EncryptedBackupSnapshotFileKind,
  files: SourceFile[],
): void {
  const sourceRoot = join(profilePath, relativeRoot);
  if (!existsSync(sourceRoot)) return;
  let rootStats: BigIntStats;
  try {
    rootStats = lstatSync(sourceRoot, { bigint: true });
  } catch {
    fail("unstable_file");
  }
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    fail("unsafe_entry");
  }

  const visit = (sourceDirectory: string, relativeDirectory: string): void => {
    let names: string[];
    try {
      names = readdirSync(sourceDirectory);
    } catch {
      fail("unstable_file");
    }
    for (const name of names.sort((left, right) =>
      left < right ? -1 : left > right ? 1 : 0,
    )) {
      const sourcePath = join(sourceDirectory, name);
      const rawRelativePath = `${relativeDirectory}/${name}`;
      const normalizedPath = normalizeSnapshotRelativePath(rawRelativePath);
      let stats: BigIntStats;
      try {
        stats = lstatSync(sourcePath, { bigint: true });
      } catch {
        fail("unstable_file");
      }
      if (stats.isSymbolicLink()) fail("unsafe_entry");
      if (forbiddenPath(normalizedPath)) {
        if (!stats.isFile() && !stats.isDirectory()) fail("unsafe_entry");
        continue;
      }
      if (stats.isDirectory()) {
        visit(sourcePath, normalizedPath);
      } else if (stats.isFile()) {
        if (stats.nlink !== 1n) fail("unsafe_entry");
        files.push({
          sourcePath,
          relativePath: normalizedPath,
          kind,
          treatment: "copy",
        });
        if (files.length > MAXIMUM_SNAPSHOT_FILES) {
          fail("snapshot_too_large");
        }
      } else {
        fail("unsafe_entry");
      }
    }
  };
  visit(sourceRoot, normalizeSnapshotRelativePath(relativeRoot));
}

function collectSourceFiles(profilePath: string): SourceFile[] {
  const files: SourceFile[] = [];
  const exact: Array<{
    relativePath: string;
    kind: EncryptedBackupSnapshotFileKind;
    treatment: SourceFile["treatment"];
  }> = [
    {
      relativePath: "memories/MEMORY.md",
      kind: "memory",
      treatment: "copy",
    },
    {
      relativePath: "memories/USER.md",
      kind: "user",
      treatment: "copy",
    },
    {
      relativePath: "config.yaml",
      kind: "profile_configuration",
      treatment: "config",
    },
    {
      relativePath: "state.db",
      kind: "session_database",
      treatment: "sqlite",
    },
  ];
  for (const descriptor of exact) {
    const sourcePath = join(profilePath, ...descriptor.relativePath.split("/"));
    if (!existsSync(sourcePath)) continue;
    inspectRegularFile(sourcePath);
    files.push({ sourcePath, ...descriptor });
    if (files.length > MAXIMUM_SNAPSHOT_FILES) {
      fail("snapshot_too_large");
    }
  }
  walkAllowedDirectory(profilePath, "skills", "private_skill", files);
  walkAllowedDirectory(profilePath, ".curator", "curator", files);
  walkAllowedDirectory(profilePath, "curator", "curator", files);
  walkAllowedDirectory(profilePath, "files", "managed_attachment", files);
  return files;
}

async function backupSqlite(input: {
  sourcePath: string;
  destinationPath: string;
  remainingBytes: number;
  adapter: EncryptedBackupSqliteSnapshotAdapter;
}): Promise<{ size: number; sha256: string }> {
  inspectRegularFile(input.sourcePath);
  ensurePrivateParent(input.destinationPath);
  try {
    await input.adapter.backup(input.sourcePath, input.destinationPath);
    input.adapter.normalize(input.destinationPath);
  } catch {
    fail("database_backup_failed");
  }
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    rmSync(`${input.destinationPath}${suffix}`, { force: true });
  }
  chmodSync(input.destinationPath, 0o600);
  try {
    if (!input.adapter.verify(input.destinationPath)) {
      fail("database_backup_failed");
    }
  } catch (error) {
    if (error instanceof EncryptedBackupSnapshotError) throw error;
    fail("database_backup_failed");
  }
  const stats = statSync(input.destinationPath);
  if (stats.size > input.remainingBytes) fail("snapshot_too_large");
  const digest = createHash("sha256");
  const file = await openFile(
    input.destinationPath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  let size = 0;
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const result = await file.read(buffer, 0, buffer.byteLength, size);
      if (result.bytesRead === 0) break;
      size += result.bytesRead;
      if (size > input.remainingBytes) fail("snapshot_too_large");
      digest.update(buffer.subarray(0, result.bytesRead));
    }
    buffer.fill(0);
  } finally {
    await file.close();
  }
  if (size !== stats.size) fail("database_backup_failed");
  return { size, sha256: digest.digest("hex") };
}

const betterSqliteSnapshotAdapter: EncryptedBackupSqliteSnapshotAdapter = {
  backup: async (sourcePath, destinationPath) => {
    const source = new Database(sourcePath, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      await source.backup(destinationPath);
    } finally {
      source.close();
    }
  },
  normalize: (path) => {
    const database = new Database(path, { fileMustExist: true });
    try {
      database.pragma("journal_mode = DELETE");
    } finally {
      database.close();
    }
  },
  verify: (path) => {
    const database = new Database(path, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      return database.pragma("quick_check", { simple: true }) === "ok";
    } finally {
      database.close();
    }
  },
};

function validateProfileAndRoots(
  profilePathValue: string,
  transactionsRootValue: string,
): { profilePath: string; transactionsRoot: string } {
  if (
    typeof profilePathValue !== "string" ||
    !isAbsolute(profilePathValue) ||
    typeof transactionsRootValue !== "string" ||
    !isAbsolute(transactionsRootValue)
  ) {
    fail("invalid_profile");
  }
  let profileStats: BigIntStats;
  let profilePath: string;
  try {
    profileStats = lstatSync(profilePathValue, { bigint: true });
    profilePath = realpathSync.native(profilePathValue);
  } catch {
    fail("invalid_profile");
  }
  if (profileStats.isSymbolicLink() || !profileStats.isDirectory()) {
    fail("invalid_profile");
  }
  const transactionsRoot = resolve(transactionsRootValue);
  if (
    isInside(profilePath, transactionsRoot) ||
    isInside(transactionsRoot, profilePath)
  ) {
    fail("invalid_profile");
  }
  return { profilePath, transactionsRoot };
}

function prepareTransactionsRoot(
  profilePath: string,
  transactionsRootValue: string,
): string {
  mkdirSync(transactionsRootValue, { recursive: true, mode: 0o700 });
  let stats: BigIntStats;
  let transactionsRoot: string;
  try {
    stats = lstatSync(transactionsRootValue, { bigint: true });
    transactionsRoot = realpathSync.native(transactionsRootValue);
  } catch {
    fail("invalid_profile");
  }
  if (
    stats.isSymbolicLink() ||
    !stats.isDirectory() ||
    isInside(profilePath, transactionsRoot) ||
    isInside(transactionsRoot, profilePath)
  ) {
    fail("invalid_profile");
  }
  chmodSync(transactionsRoot, 0o700);
  return transactionsRoot;
}

export async function withEncryptedBackupSnapshot<T>(
  input: EncryptedBackupSnapshotInput,
  operation: (snapshot: EncryptedBackupSnapshot) => Promise<T> | T,
): Promise<T> {
  const lease = input.activity.beginSnapshot();
  if (!lease) fail("runtime_busy");
  let transactionPath: string | null = null;
  try {
    throwIfCancelled(input.signal);
    const validated = validateProfileAndRoots(
      input.profilePath,
      input.transactionsRoot,
    );
    const profilePath = validated.profilePath;
    const transactionsRoot = prepareTransactionsRoot(
      profilePath,
      validated.transactionsRoot,
    );
    const maximumBytes =
      input.maximumBytes ?? AGENTERA_ENCRYPTED_BACKUP_MAXIMUM_BYTES;
    if (
      !Number.isSafeInteger(maximumBytes) ||
      maximumBytes < 1 ||
      maximumBytes > AGENTERA_ENCRYPTED_BACKUP_MAXIMUM_BYTES
    ) {
      fail("snapshot_too_large");
    }
    const transactionId = (input.randomUUID ?? randomUUID)();
    if (!UUID_PATTERN.test(transactionId)) fail("unsafe_entry");
    transactionPath = join(transactionsRoot, transactionId);
    try {
      mkdirSync(transactionPath, { mode: 0o700 });
    } catch {
      fail("unsafe_entry");
    }
    chmodSync(transactionPath, 0o700);
    const filesPath = join(transactionPath, "plaintext");
    mkdirSync(filesPath, { mode: 0o700 });
    chmodSync(filesPath, 0o700);

    const sources = collectSourceFiles(profilePath);
    const provenancePath = "provenance/runtime-bindings.enc";
    assertUniqueSnapshotPaths([
      ...sources.map((source) => source.relativePath),
      provenancePath,
    ]);
    const manifestFiles: EncryptedBackupSnapshotFile[] = [];
    const capturedSourceIdentities = new Map<string, string>();
    let totalSize = 0;
    for (const source of sources.sort((left, right) =>
      left.relativePath < right.relativePath
        ? -1
        : left.relativePath > right.relativePath
          ? 1
          : 0,
    )) {
      throwIfCancelled(input.signal);
      const destinationPath = safeDestination(filesPath, source.relativePath);
      let captured: {
        size: number;
        sha256: string;
        sourceIdentity?: string;
      };
      if (source.treatment === "copy") {
        captured = await captureStableFile({
          sourcePath: source.sourcePath,
          destinationPath,
          remainingBytes: maximumBytes - totalSize,
          signal: input.signal,
          hooks: input.fileHooks,
        });
      } else if (source.treatment === "config") {
        const stableConfig = await readStableFile({
          sourcePath: source.sourcePath,
          maximumBytes: Math.min(
            MAXIMUM_CONFIG_BYTES,
            maximumBytes - totalSize,
          ),
          signal: input.signal,
          hooks: input.fileHooks,
        });
        const sanitized = sanitizeConfig(stableConfig.content);
        if (sanitized.byteLength > maximumBytes - totalSize) {
          sanitized.fill(0);
          fail("snapshot_too_large");
        }
        writePrivateFile(destinationPath, sanitized);
        captured = {
          size: sanitized.byteLength,
          sha256: createHash("sha256").update(sanitized).digest("hex"),
          sourceIdentity: stableConfig.sourceIdentity,
        };
        sanitized.fill(0);
      } else {
        captured = await backupSqlite({
          sourcePath: source.sourcePath,
          destinationPath,
          remainingBytes: maximumBytes - totalSize,
          adapter: input.sqlite ?? betterSqliteSnapshotAdapter,
        });
      }
      if (captured.sourceIdentity !== undefined) {
        capturedSourceIdentities.set(
          source.sourcePath,
          captured.sourceIdentity,
        );
      }
      totalSize += captured.size;
      manifestFiles.push({
        path: source.relativePath,
        kind: source.kind,
        modeClass: "owner-read-write",
        size: captured.size,
        sha256: captured.sha256,
      });
    }

    const finalSources = collectSourceFiles(profilePath);
    const inventoryKey = (source: SourceFile): string =>
      `${source.relativePath}\0${source.kind}\0${source.treatment}`;
    const initialInventory = sources.map(inventoryKey).sort();
    const finalInventory = finalSources.map(inventoryKey).sort();
    if (
      initialInventory.length !== finalInventory.length ||
      initialInventory.some((value, index) => value !== finalInventory[index])
    ) {
      fail("unstable_file");
    }
    for (const [sourcePath, capturedIdentity] of capturedSourceIdentities) {
      if (identityToken(inspectRegularFile(sourcePath)) !== capturedIdentity) {
        fail("unstable_file");
      }
    }

    if (!(input.encryptedRuntimeBindingProvenance instanceof Uint8Array)) {
      fail("unsafe_entry");
    }
    const provenance = Buffer.from(input.encryptedRuntimeBindingProvenance);
    if (
      provenance.byteLength < 1 ||
      provenance.byteLength > MAXIMUM_PROVENANCE_BYTES ||
      provenance.byteLength > maximumBytes - totalSize
    ) {
      provenance.fill(0);
      fail("snapshot_too_large");
    }
    const provenanceDestination = safeDestination(filesPath, provenancePath);
    writePrivateFile(provenanceDestination, provenance);
    manifestFiles.push({
      path: provenancePath,
      kind: "runtime_binding_provenance",
      modeClass: "owner-read-write",
      size: provenance.byteLength,
      sha256: createHash("sha256").update(provenance).digest("hex"),
    });
    totalSize += provenance.byteLength;
    provenance.fill(0);

    const manifest = createEncryptedBackupSnapshotManifest({
      profileLineageId: input.profileLineageId,
      createdAt: (input.now ?? (() => new Date()))(),
      provenance: input.provenance,
      files: manifestFiles,
    });
    if (manifest.totalPlaintextSize !== totalSize) {
      fail("unstable_file");
    }
    const manifestBytes = serializeEncryptedBackupSnapshotManifest(manifest);
    const manifestPath = join(transactionPath, "manifest.json");
    writePrivateFile(manifestPath, manifestBytes);
    throwIfCancelled(input.signal);
    return await operation({
      transactionId,
      transactionPath,
      filesPath,
      manifestPath,
      manifest,
      manifestBytes,
    });
  } finally {
    if (transactionPath !== null) {
      rmSync(transactionPath, {
        recursive: true,
        force: true,
        maxRetries: 2,
      });
    }
    lease.finish();
  }
}
