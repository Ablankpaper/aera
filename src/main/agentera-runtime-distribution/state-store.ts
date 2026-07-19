import {
  lstat,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  parseJsonObjectRejectDuplicates,
  requireExactObjectFields,
} from "./manifest";
import {
  type RuntimeDistributionPaths,
  RuntimePathError,
  assertRuntimeOwnedPath,
  ensureRuntimeDistributionDirectories,
  verifyRuntimeVersionDirectory,
} from "./paths";

export interface RuntimePointer {
  schemaVersion: 1;
  runtimeVersion: string;
  sourceCommit: string;
  versionDirectory: string;
  manifestSha256: string;
  installedAt: string;
}

export interface CandidatePointer extends RuntimePointer {
  applyOnNextLaunch: boolean;
  stagedAt: string;
}

export interface RuntimeDistributionState {
  current: RuntimePointer | null;
  previous: RuntimePointer | null;
  candidate: CandidatePointer | null;
}

export type RuntimePointerName = "current" | "previous" | "candidate";

export interface RuntimeBootstrapRecovery {
  state: RuntimeDistributionState;
  invalidPointers: RuntimePointerName[];
}

export interface RuntimeStateStoreOptions {
  now?: () => Date;
  staleTransactionAgeMs?: number;
  readPointerFile?: (path: string) => Promise<Buffer>;
}

export class RuntimeStateError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RuntimeStateError";
  }
}

class RuntimePointerReadError extends RuntimeStateError {}

const POINTER_FIELDS = [
  "schemaVersion",
  "runtimeVersion",
  "sourceCommit",
  "versionDirectory",
  "manifestSha256",
  "installedAt",
] as const;
const CANDIDATE_FIELDS = [
  ...POINTER_FIELDS,
  "applyOnNextLaunch",
  "stagedAt",
] as const;
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const DEFAULT_STALE_TRANSACTION_AGE_MS = 24 * 60 * 60 * 1000;
const UNSUPPORTED_DIRECTORY_SYNC_CODES = new Set([
  "EBADF",
  "EINVAL",
  "EISDIR",
  "ENOTSUP",
  "EPERM",
]);

function isErrnoException(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}

function requireString(value: Record<string, unknown>, field: string): string {
  const item = value[field];
  if (typeof item !== "string" || item.length === 0) {
    throw new RuntimeStateError(
      `Runtime pointer ${field} must be a non-empty string`,
    );
  }
  return item;
}

function validateTimestamp(value: string, field: string): void {
  if (!value.endsWith("Z") || Number.isNaN(Date.parse(value))) {
    throw new RuntimeStateError(
      `Runtime pointer ${field} must be a UTC timestamp`,
    );
  }
}

function basePointerFromValue(value: Record<string, unknown>): RuntimePointer {
  if (value.schemaVersion !== 1) {
    throw new RuntimeStateError("unsupported Runtime pointer schemaVersion");
  }
  const runtimeVersion = requireString(value, "runtimeVersion");
  if (!VERSION_PATTERN.test(runtimeVersion)) {
    throw new RuntimeStateError("Runtime pointer runtimeVersion is invalid");
  }
  const sourceCommit = requireString(value, "sourceCommit");
  if (!COMMIT_PATTERN.test(sourceCommit)) {
    throw new RuntimeStateError("Runtime pointer sourceCommit is invalid");
  }
  const versionDirectory = requireString(value, "versionDirectory");
  const manifestSha256 = requireString(value, "manifestSha256");
  if (!SHA256_PATTERN.test(manifestSha256)) {
    throw new RuntimeStateError("Runtime pointer manifestSha256 is invalid");
  }
  const installedAt = requireString(value, "installedAt");
  validateTimestamp(installedAt, "installedAt");
  return {
    schemaVersion: 1,
    runtimeVersion,
    sourceCommit,
    versionDirectory,
    manifestSha256,
    installedAt,
  };
}

async function parsePointer(
  raw: Buffer,
  paths: RuntimeDistributionPaths,
  candidate: false,
): Promise<RuntimePointer>;
async function parsePointer(
  raw: Buffer,
  paths: RuntimeDistributionPaths,
  candidate: true,
): Promise<CandidatePointer>;
async function parsePointer(
  raw: Buffer,
  paths: RuntimeDistributionPaths,
  candidate: boolean,
): Promise<RuntimePointer | CandidatePointer> {
  let value: Record<string, unknown>;
  try {
    value = parseJsonObjectRejectDuplicates(raw, "Runtime pointer");
    requireExactObjectFields(
      value,
      candidate ? CANDIDATE_FIELDS : POINTER_FIELDS,
      candidate ? "Runtime candidate pointer" : "Runtime pointer",
    );
  } catch (error) {
    throw new RuntimeStateError("Runtime pointer JSON is invalid", {
      cause: error,
    });
  }
  const pointer = basePointerFromValue(value);
  try {
    await verifyRuntimeVersionDirectory(paths, pointer.versionDirectory);
  } catch (error) {
    throw new RuntimeStateError(
      `Runtime pointer version directory is missing or unsafe: ${pointer.versionDirectory}`,
      { cause: error },
    );
  }
  if (!candidate) return pointer;
  if (typeof value.applyOnNextLaunch !== "boolean") {
    throw new RuntimeStateError(
      "Runtime candidate applyOnNextLaunch must be boolean",
    );
  }
  const stagedAt = requireString(value, "stagedAt");
  validateTimestamp(stagedAt, "stagedAt");
  return {
    ...pointer,
    applyOnNextLaunch: value.applyOnNextLaunch,
    stagedAt,
  };
}

async function readPointer(
  path: string,
  paths: RuntimeDistributionPaths,
  candidate: false,
  readPointerFile: (path: string) => Promise<Buffer>,
): Promise<RuntimePointer | null>;
async function readPointer(
  path: string,
  paths: RuntimeDistributionPaths,
  candidate: true,
  readPointerFile: (path: string) => Promise<Buffer>,
): Promise<CandidatePointer | null>;
async function readPointer(
  path: string,
  paths: RuntimeDistributionPaths,
  candidate: boolean,
  readPointerFile: (path: string) => Promise<Buffer>,
): Promise<RuntimePointer | CandidatePointer | null> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return null;
    throw new RuntimePointerReadError("cannot read Runtime pointer", {
      cause: error,
    });
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new RuntimeStateError("Runtime pointer path must be a regular file");
  }
  let raw: Buffer;
  try {
    raw = await readPointerFile(path);
  } catch (error) {
    throw new RuntimePointerReadError("cannot read Runtime pointer", {
      cause: error,
    });
  }
  return candidate
    ? parsePointer(raw, paths, true)
    : parsePointer(raw, paths, false);
}

async function syncDirectory(path: string): Promise<void> {
  let directory;
  try {
    directory = await open(path, "r");
    await directory.sync();
  } catch (error) {
    if (
      !isErrnoException(error) ||
      !UNSUPPORTED_DIRECTORY_SYNC_CODES.has(error.code ?? "")
    ) {
      throw error;
    }
  } finally {
    await directory?.close();
  }
}

async function writePointerAtomic(
  path: string,
  pointer: RuntimePointer | CandidatePointer,
  paths: RuntimeDistributionPaths,
  candidate: boolean,
): Promise<void> {
  assertRuntimeOwnedPath(paths.root, path, "Runtime pointer path");
  const validated = candidate
    ? await parsePointer(
        Buffer.from(JSON.stringify(pointer), "utf8"),
        paths,
        true,
      )
    : await parsePointer(
        Buffer.from(JSON.stringify(pointer), "utf8"),
        paths,
        false,
      );
  const temporaryPath = `${path}.tmp`;
  assertRuntimeOwnedPath(
    paths.root,
    temporaryPath,
    "Runtime pointer temp path",
  );
  let handle;
  try {
    await removeRuntimeOwnedPath(paths.root, temporaryPath);
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(validated, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
    await syncDirectory(dirname(path));
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw new RuntimeStateError("cannot write Runtime pointer atomically", {
      cause: error,
    });
  }
}

async function removePointer(
  path: string,
  paths: RuntimeDistributionPaths,
): Promise<void> {
  assertRuntimeOwnedPath(paths.root, path, "Runtime pointer path");
  try {
    await unlink(path);
    await syncDirectory(dirname(path));
  } catch (error) {
    if (!isErrnoException(error) || error.code !== "ENOENT") {
      throw new RuntimeStateError("cannot remove Runtime pointer", {
        cause: error,
      });
    }
  }
}

function relativeEscapesRoot(value: string): boolean {
  return value === ".." || value.startsWith(`..${sep}`) || isAbsolute(value);
}

async function requireRealRuntimeRoot(runtimeRoot: string): Promise<string> {
  const root = resolve(runtimeRoot);
  let metadata;
  try {
    metadata = await lstat(root);
  } catch (error) {
    throw new RuntimePathError("Runtime root is missing", { cause: error });
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new RuntimePathError("Runtime root must be a real directory");
  }
  return realpath(root);
}

function assertRealPathContained(
  rootRealPath: string,
  candidateRealPath: string,
  label: string,
  allowRoot = false,
): void {
  const relativePath = relative(rootRealPath, candidateRealPath);
  if (
    (!allowRoot && relativePath.length === 0) ||
    relativeEscapesRoot(relativePath)
  ) {
    throw new RuntimePathError(`${label} is outside the Runtime root`);
  }
}

export async function removeRuntimeOwnedPath(
  runtimeRoot: string,
  target: string,
): Promise<void> {
  const ownedTarget = assertRuntimeOwnedPath(
    runtimeRoot,
    target,
    "Runtime cleanup target",
  );
  const rootRealPath = await requireRealRuntimeRoot(runtimeRoot);
  const parentRealPath = await realpath(dirname(ownedTarget));
  assertRealPathContained(
    rootRealPath,
    parentRealPath,
    "Runtime cleanup parent",
    true,
  );
  let metadata;
  try {
    metadata = await lstat(ownedTarget);
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return;
    throw new RuntimeStateError("cannot inspect Runtime cleanup target", {
      cause: error,
    });
  }
  if (metadata.isSymbolicLink()) {
    await unlink(ownedTarget);
  } else {
    const targetRealPath = await realpath(ownedTarget);
    assertRealPathContained(
      rootRealPath,
      targetRealPath,
      "Runtime cleanup target",
    );
    await rm(ownedTarget, { recursive: true, force: true });
  }
  await syncDirectory(dirname(ownedTarget));
}

function isSafeVersionName(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 255 &&
    value !== "." &&
    value !== ".." &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !value.includes("\0")
  );
}

async function cleanupUnreferencedRuntimeVersions(
  runtimeRoot: string,
  referencedVersions: ReadonlySet<string>,
): Promise<string[]> {
  const root = resolve(runtimeRoot);
  const versions = assertRuntimeOwnedPath(
    root,
    join(root, "versions"),
    "Runtime versions directory",
  );
  const rootRealPath = await requireRealRuntimeRoot(root);
  const versionsMetadata = await lstat(versions);
  if (!versionsMetadata.isDirectory() || versionsMetadata.isSymbolicLink()) {
    throw new RuntimePathError(
      "Runtime versions directory must be a real directory",
    );
  }
  assertRealPathContained(
    rootRealPath,
    await realpath(versions),
    "Runtime versions directory",
  );
  for (const version of referencedVersions) {
    if (!isSafeVersionName(version)) {
      throw new RuntimeStateError("referenced Runtime version name is unsafe");
    }
  }
  const deleted: string[] = [];
  const entries = await readdir(versions, { withFileTypes: true });
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (referencedVersions.has(entry.name)) continue;
    await removeRuntimeOwnedPath(root, join(versions, entry.name));
    deleted.push(entry.name);
  }
  return deleted;
}

function isRecoverableTransactionName(value: string): boolean {
  return value.startsWith("transaction-") || value.endsWith(".tmp");
}

async function removeStaleTransactions(
  paths: RuntimeDistributionPaths,
  directory: string,
  now: Date,
  staleTransactionAgeMs: number,
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (!isRecoverableTransactionName(entry.name)) continue;
    const target = join(directory, entry.name);
    const metadata = await lstat(target);
    if (now.getTime() - metadata.mtimeMs < staleTransactionAgeMs) continue;
    await removeRuntimeOwnedPath(paths.root, target);
  }
}

function asRuntimePointer(candidate: CandidatePointer): RuntimePointer {
  return {
    schemaVersion: 1,
    runtimeVersion: candidate.runtimeVersion,
    sourceCommit: candidate.sourceCommit,
    versionDirectory: candidate.versionDirectory,
    manifestSha256: candidate.manifestSha256,
    installedAt: candidate.installedAt,
  };
}

function samePointer(
  left: RuntimePointer | null,
  right: RuntimePointer,
): boolean {
  return (
    left !== null &&
    left.runtimeVersion === right.runtimeVersion &&
    left.sourceCommit === right.sourceCommit &&
    left.versionDirectory === right.versionDirectory &&
    left.manifestSha256 === right.manifestSha256
  );
}

export class RuntimeStateStore {
  private readonly now: () => Date;
  private readonly staleTransactionAgeMs: number;
  private readonly readPointerFile: (path: string) => Promise<Buffer>;
  private operation: Promise<void> = Promise.resolve();

  constructor(
    private readonly paths: RuntimeDistributionPaths,
    options: RuntimeStateStoreOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.readPointerFile =
      options.readPointerFile ?? ((path: string) => readFile(path));
    this.staleTransactionAgeMs =
      options.staleTransactionAgeMs ?? DEFAULT_STALE_TRANSACTION_AGE_MS;
    if (
      !Number.isSafeInteger(this.staleTransactionAgeMs) ||
      this.staleTransactionAgeMs < 0
    ) {
      throw new RuntimeStateError("staleTransactionAgeMs must be non-negative");
    }
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.then(operation, operation);
    this.operation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async readStateUnlocked(): Promise<RuntimeDistributionState> {
    await ensureRuntimeDistributionDirectories(this.paths);
    const [current, previous, candidate] = await Promise.all([
      readPointer(this.paths.current, this.paths, false, this.readPointerFile),
      readPointer(this.paths.previous, this.paths, false, this.readPointerFile),
      readPointer(this.paths.candidate, this.paths, true, this.readPointerFile),
    ]);
    return { current, previous, candidate };
  }

  readState(): Promise<RuntimeDistributionState> {
    return this.exclusive(() => this.readStateUnlocked());
  }

  recover(): Promise<RuntimeDistributionState> {
    return this.exclusive(async () => {
      await ensureRuntimeDistributionDirectories(this.paths);
      for (const pointerPath of [
        this.paths.current,
        this.paths.previous,
        this.paths.candidate,
      ]) {
        await removeRuntimeOwnedPath(this.paths.root, `${pointerPath}.tmp`);
      }
      await removeStaleTransactions(
        this.paths,
        this.paths.staging,
        this.now(),
        this.staleTransactionAgeMs,
      );
      await removeStaleTransactions(
        this.paths,
        this.paths.downloads,
        this.now(),
        this.staleTransactionAgeMs,
      );
      return this.readStateUnlocked();
    });
  }

  recoverForBootstrap(): Promise<RuntimeBootstrapRecovery> {
    return this.exclusive(async () => {
      await ensureRuntimeDistributionDirectories(this.paths);
      for (const pointerPath of [
        this.paths.current,
        this.paths.previous,
        this.paths.candidate,
      ]) {
        await removeRuntimeOwnedPath(this.paths.root, `${pointerPath}.tmp`);
      }
      await removeStaleTransactions(
        this.paths,
        this.paths.staging,
        this.now(),
        this.staleTransactionAgeMs,
      );
      await removeStaleTransactions(
        this.paths,
        this.paths.downloads,
        this.now(),
        this.staleTransactionAgeMs,
      );

      const invalidPointers: RuntimePointerName[] = [];
      let current: RuntimePointer | null = null;
      let previous: RuntimePointer | null = null;
      let candidate: CandidatePointer | null = null;
      try {
        current = await readPointer(
          this.paths.current,
          this.paths,
          false,
          this.readPointerFile,
        );
      } catch (error) {
        if (error instanceof RuntimePointerReadError) throw error;
        invalidPointers.push("current");
        await removePointer(this.paths.current, this.paths);
      }
      try {
        previous = await readPointer(
          this.paths.previous,
          this.paths,
          false,
          this.readPointerFile,
        );
      } catch (error) {
        if (error instanceof RuntimePointerReadError) throw error;
        invalidPointers.push("previous");
        await removePointer(this.paths.previous, this.paths);
      }
      try {
        candidate = await readPointer(
          this.paths.candidate,
          this.paths,
          true,
          this.readPointerFile,
        );
      } catch (error) {
        if (error instanceof RuntimePointerReadError) throw error;
        invalidPointers.push("candidate");
        await removePointer(this.paths.candidate, this.paths);
      }
      return {
        state: { current, previous, candidate },
        invalidPointers,
      };
    });
  }

  setCurrent(pointer: RuntimePointer): Promise<void> {
    return this.exclusive(async () => {
      await ensureRuntimeDistributionDirectories(this.paths);
      await writePointerAtomic(this.paths.current, pointer, this.paths, false);
    });
  }

  clearCurrent(): Promise<void> {
    return this.exclusive(() => removePointer(this.paths.current, this.paths));
  }

  clearPrevious(): Promise<void> {
    return this.exclusive(() => removePointer(this.paths.previous, this.paths));
  }

  stageCandidate(pointer: CandidatePointer): Promise<void> {
    return this.exclusive(async () => {
      await ensureRuntimeDistributionDirectories(this.paths);
      await writePointerAtomic(this.paths.candidate, pointer, this.paths, true);
    });
  }

  clearCandidate(): Promise<void> {
    return this.exclusive(() =>
      removePointer(this.paths.candidate, this.paths),
    );
  }

  promoteCandidate(): Promise<RuntimeDistributionState> {
    return this.exclusive(async () => {
      const state = await this.readStateUnlocked();
      if (state.candidate === null) {
        throw new RuntimeStateError("no Runtime candidate is staged");
      }
      if (!state.candidate.applyOnNextLaunch) {
        throw new RuntimeStateError(
          "Runtime candidate is not approved for next-launch activation",
        );
      }
      const promoted = asRuntimePointer(state.candidate);
      if (samePointer(state.current, promoted)) {
        await removePointer(this.paths.candidate, this.paths);
        return this.readStateUnlocked();
      }
      if (state.current !== null) {
        await writePointerAtomic(
          this.paths.previous,
          state.current,
          this.paths,
          false,
        );
      }
      await writePointerAtomic(this.paths.current, promoted, this.paths, false);
      await removePointer(this.paths.candidate, this.paths);
      return this.readStateUnlocked();
    });
  }

  rollback(): Promise<RuntimeDistributionState> {
    return this.exclusive(async () => {
      const state = await this.readStateUnlocked();
      if (state.previous === null) {
        throw new RuntimeStateError("no previous Runtime version is available");
      }
      const oldCurrent = state.current;
      await writePointerAtomic(
        this.paths.current,
        state.previous,
        this.paths,
        false,
      );
      if (oldCurrent === null) {
        await removePointer(this.paths.previous, this.paths);
      } else {
        await writePointerAtomic(
          this.paths.previous,
          oldCurrent,
          this.paths,
          false,
        );
      }
      await removePointer(this.paths.candidate, this.paths);
      return this.readStateUnlocked();
    });
  }

  cleanupUnreferencedVersions(): Promise<string[]> {
    return this.exclusive(async () => {
      const state = await this.readStateUnlocked();
      const referenced = new Set(
        [state.current, state.previous, state.candidate]
          .filter((pointer): pointer is RuntimePointer => pointer !== null)
          .map((pointer) => pointer.versionDirectory),
      );
      return cleanupUnreferencedRuntimeVersions(this.paths.root, referenced);
    });
  }
}
