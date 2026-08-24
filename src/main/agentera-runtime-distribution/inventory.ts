import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  open,
  readlink,
  readdir,
  realpath,
} from "node:fs/promises";
import { isAbsolute, join, posix, relative, sep } from "node:path";

import {
  RUNTIME_MANIFEST_METADATA_NAME,
  RUNTIME_SIGNATURE_METADATA_NAME,
  type RuntimeInventoryKind,
  type RuntimeManifest,
} from "./manifest";

export const MAX_SYMLINK_TARGET_BYTES = 16 * 1024;
const RUNTIME_HASH_CONCURRENCY = 8;
const RUNTIME_HASH_BUFFER_BYTES = 1024 * 1024;
const INSTALLED_METADATA_FILES = new Set([
  RUNTIME_MANIFEST_METADATA_NAME,
  RUNTIME_SIGNATURE_METADATA_NAME,
]);

export interface RuntimeExtractionResult {
  fileCount: number;
  extractedBytes: number;
}

export interface RuntimeFileHashCheck {
  physicalPath: string;
  relativePath: string;
  expectedSha256: string | null;
}

export type RuntimeFileHasher = (
  path: string,
  signal?: AbortSignal,
) => Promise<string>;

export type RuntimeInventoryDiagnosticEvent =
  | "inventory-walk-start"
  | "inventory-walk-complete"
  | "inventory-hash-start"
  | "inventory-hash-complete";

export type RuntimeInventoryDiagnosticObserver = (
  event: RuntimeInventoryDiagnosticEvent,
) => void;

export interface RuntimeInventoryFileSystem {
  chmod: typeof chmod;
  lstat: typeof lstat;
  open: typeof open;
  readlink: typeof readlink;
  readdir: typeof readdir;
  realpath: typeof realpath;
}

export type RuntimeOriginalFsLoader = () => Promise<unknown>;

export class RuntimeExtractionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RuntimeExtractionError";
  }
}

function abortError(): Error {
  const error = new Error("Runtime extraction was cancelled");
  error.name = "AbortError";
  return error;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function requireExtractionBudget(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RuntimeExtractionError(
      "Runtime extraction budget must be a non-negative safe integer",
    );
  }
}

export function manifestExtractedBytes(manifest: RuntimeManifest): number {
  let total = 0;
  for (const entry of manifest.files) {
    if (entry.kind !== "file") continue;
    total += entry.size;
    if (!Number.isSafeInteger(total)) {
      throw new RuntimeExtractionError(
        "Runtime manifest extracted size exceeds the supported range",
      );
    }
  }
  return total;
}

export function validateRelativePath(path: string, label: string): void {
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.endsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.includes("//")
  ) {
    throw new RuntimeExtractionError(`${label} is not a safe relative path`);
  }
  const parts = path.split("/");
  if (
    parts.some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    throw new RuntimeExtractionError(
      `${label} escapes the Runtime archive root`,
    );
  }
  if (posix.normalize(path) !== path) {
    throw new RuntimeExtractionError(`${label} is not normalized`);
  }
}

export function normalizedComparablePath(
  path: string,
  windows: boolean,
): string {
  return windows ? path.normalize("NFKC").toLocaleLowerCase("en-US") : path;
}

export function validateSymlinkTarget(path: string, target: string): void {
  if (
    target.length === 0 ||
    Buffer.byteLength(target, "utf8") > MAX_SYMLINK_TARGET_BYTES ||
    target.startsWith("/") ||
    target.includes("\\") ||
    target.includes("\0") ||
    /^[A-Za-z]:/.test(target)
  ) {
    throw new RuntimeExtractionError(
      `Runtime symlink target must be relative: ${path}`,
    );
  }
  const combined = posix.normalize(posix.join(posix.dirname(path), target));
  if (
    combined === "." ||
    combined === ".." ||
    combined.startsWith("../") ||
    combined.startsWith("/")
  ) {
    throw new RuntimeExtractionError(`Runtime symlink target escapes: ${path}`);
  }
}

function pathEscapes(parent: string, child: string): boolean {
  const value = relative(parent, child);
  return value === ".." || value.startsWith(`..${sep}`) || isAbsolute(value);
}

async function hashFileWithHandle(
  path: string,
  signal: AbortSignal | undefined,
  openFile: typeof open,
): Promise<string> {
  const hash = createHash("sha256");
  const handle = await openFile(path, "r");
  const buffer = Buffer.allocUnsafe(RUNTIME_HASH_BUFFER_BYTES);
  let position = 0;
  try {
    while (true) {
      throwIfAborted(signal);
      const { bytesRead } = await handle.read(
        buffer,
        0,
        buffer.length,
        position,
      );
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

async function hashFile(path: string, signal?: AbortSignal): Promise<string> {
  return hashFileWithHandle(path, signal, open);
}

const NODE_RUNTIME_INVENTORY_FILE_SYSTEM: RuntimeInventoryFileSystem = {
  chmod,
  lstat,
  open,
  readlink,
  readdir,
  realpath,
};

const ORIGINAL_FS_MODULE = "original-fs";
const loadElectronOriginalFs: RuntimeOriginalFsLoader = () =>
  import(/* @vite-ignore */ ORIGINAL_FS_MODULE);

function originalFsCandidate(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  return record.default && typeof record.default === "object"
    ? (record.default as Record<string, unknown>)
    : record;
}

export async function resolveRuntimeInventoryFileSystem(
  electronVersion: string | undefined = process.versions.electron,
  loadOriginalFs: RuntimeOriginalFsLoader = loadElectronOriginalFs,
): Promise<RuntimeInventoryFileSystem> {
  if (!electronVersion) return NODE_RUNTIME_INVENTORY_FILE_SYSTEM;
  const candidate = originalFsCandidate(await loadOriginalFs());
  const promises = candidate.promises;
  if (!promises || typeof promises !== "object") {
    throw new RuntimeExtractionError(
      "Electron original filesystem is unavailable",
    );
  }
  const promiseRecord = promises as Record<string, unknown>;
  if (
    typeof promiseRecord.chmod !== "function" ||
    typeof promiseRecord.lstat !== "function" ||
    typeof promiseRecord.open !== "function" ||
    typeof promiseRecord.readlink !== "function" ||
    typeof promiseRecord.readdir !== "function" ||
    typeof promiseRecord.realpath !== "function"
  ) {
    throw new RuntimeExtractionError(
      "Electron original filesystem is unavailable",
    );
  }
  return {
    chmod: promiseRecord.chmod.bind(promises) as typeof chmod,
    lstat: promiseRecord.lstat.bind(promises) as typeof lstat,
    open: promiseRecord.open.bind(promises) as typeof open,
    readlink: promiseRecord.readlink.bind(promises) as typeof readlink,
    readdir: promiseRecord.readdir.bind(promises) as typeof readdir,
    realpath: promiseRecord.realpath.bind(promises) as typeof realpath,
  };
}

export async function verifyRuntimeFileHashes(
  checks: readonly RuntimeFileHashCheck[],
  signal?: AbortSignal,
  fileHasher: RuntimeFileHasher = hashFile,
): Promise<void> {
  for (
    let offset = 0;
    offset < checks.length;
    offset += RUNTIME_HASH_CONCURRENCY
  ) {
    throwIfAborted(signal);
    const batch = checks.slice(offset, offset + RUNTIME_HASH_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (check) => {
        if (
          (await fileHasher(check.physicalPath, signal)) !==
          check.expectedSha256
        ) {
          throw new RuntimeExtractionError(
            `extracted Runtime hash differs from the manifest: ${check.relativePath}`,
          );
        }
      }),
    );
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failure) throw failure.reason;
  }
}

export function shouldEnforceExtractedRuntimeMode(
  manifestPlatform: RuntimeManifest["platform"],
  hostPlatform: NodeJS.Platform = process.platform,
): boolean {
  return manifestPlatform !== "windows" && hostPlatform !== "win32";
}

export async function verifyExtractedRuntimeInventoryInProcess(
  destination: string,
  manifest: RuntimeManifest,
  maxExtractedBytes: number,
  signal?: AbortSignal,
  hostPlatform: NodeJS.Platform = process.platform,
  onDiagnostic?: RuntimeInventoryDiagnosticObserver,
  fileSystem?: RuntimeInventoryFileSystem,
): Promise<RuntimeExtractionResult> {
  requireExtractionBudget(maxExtractedBytes);
  const inventoryFileSystem =
    fileSystem ?? (await resolveRuntimeInventoryFileSystem());
  const root = await inventoryFileSystem.realpath(destination);
  const enforceExtractedModes = shouldEnforceExtractedRuntimeMode(
    manifest.platform,
    hostPlatform,
  );
  const expected = new Map(manifest.files.map((entry) => [entry.path, entry]));
  const expectedComparable = new Set(
    manifest.files.map((entry) =>
      normalizedComparablePath(entry.path, manifest.platform === "windows"),
    ),
  );
  const seen = new Set<string>();
  const comparableSeen = new Set<string>();
  const fileHashChecks: RuntimeFileHashCheck[] = [];
  let fileCount = 0;
  let extractedBytes = 0;

  async function walk(
    directory: string,
    relativeDirectory = "",
  ): Promise<void> {
    throwIfAborted(signal);
    const children = await inventoryFileSystem.readdir(directory, {
      withFileTypes: true,
    });
    children.sort((left, right) =>
      Buffer.from(left.name).compare(Buffer.from(right.name)),
    );
    for (const child of children) {
      throwIfAborted(signal);
      if (
        relativeDirectory.length === 0 &&
        INSTALLED_METADATA_FILES.has(child.name)
      ) {
        const metadata = await inventoryFileSystem.lstat(
          join(directory, child.name),
        );
        if (!metadata.isFile() || metadata.isSymbolicLink()) {
          throw new RuntimeExtractionError(
            "installed Runtime metadata must be a regular file",
          );
        }
        continue;
      }
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${child.name}`
        : child.name;
      validateRelativePath(relativePath, "extracted Runtime path");
      const comparablePath = normalizedComparablePath(
        relativePath,
        manifest.platform === "windows",
      );
      if (comparableSeen.has(comparablePath)) {
        throw new RuntimeExtractionError(
          `extracted Runtime contains a duplicate path: ${relativePath}`,
        );
      }
      comparableSeen.add(comparablePath);
      const expectedEntry = expected.get(relativePath);
      if (!expectedEntry) {
        if (expectedComparable.has(comparablePath)) {
          throw new RuntimeExtractionError(
            `extracted Runtime contains a duplicate path: ${relativePath}`,
          );
        }
        throw new RuntimeExtractionError(
          `extracted Runtime contains an unexpected path: ${relativePath}`,
        );
      }
      const physicalPath = join(directory, child.name);
      const metadata = await inventoryFileSystem.lstat(physicalPath);
      const kind: RuntimeInventoryKind = metadata.isSymbolicLink()
        ? "symlink"
        : metadata.isDirectory()
          ? "directory"
          : metadata.isFile()
            ? "file"
            : (() => {
                throw new RuntimeExtractionError(
                  `extracted Runtime contains a special file: ${relativePath}`,
                );
              })();
      if (kind !== expectedEntry.kind) {
        throw new RuntimeExtractionError(
          `extracted Runtime kind differs from the manifest: ${relativePath}`,
        );
      }
      if (kind !== "symlink" && enforceExtractedModes) {
        await inventoryFileSystem.chmod(physicalPath, expectedEntry.mode);
        const normalizedMode =
          (await inventoryFileSystem.lstat(physicalPath)).mode & 0o777;
        if (normalizedMode !== expectedEntry.mode) {
          throw new RuntimeExtractionError(
            `extracted Runtime mode differs from the manifest: ${relativePath}`,
          );
        }
      }
      if (kind === "file") {
        if (metadata.size !== expectedEntry.size) {
          throw new RuntimeExtractionError(
            `extracted Runtime size differs from the manifest: ${relativePath}`,
          );
        }
        extractedBytes += metadata.size;
        fileCount += 1;
        if (
          !Number.isSafeInteger(extractedBytes) ||
          extractedBytes > maxExtractedBytes
        ) {
          throw new RuntimeExtractionError(
            "extracted Runtime exceeds the signed extraction budget",
          );
        }
        fileHashChecks.push({
          physicalPath,
          relativePath,
          expectedSha256: expectedEntry.sha256,
        });
      } else if (kind === "symlink") {
        const target = await inventoryFileSystem.readlink(physicalPath);
        validateSymlinkTarget(relativePath, target);
        if (target !== expectedEntry.link_target) {
          throw new RuntimeExtractionError(
            `extracted Runtime symlink differs from the manifest: ${relativePath}`,
          );
        }
        let resolvedTarget: string;
        try {
          resolvedTarget = await inventoryFileSystem.realpath(physicalPath);
        } catch (error) {
          throw new RuntimeExtractionError(
            `extracted Runtime symlink is broken: ${relativePath}`,
            { cause: error },
          );
        }
        if (pathEscapes(root, resolvedTarget)) {
          throw new RuntimeExtractionError(
            `extracted Runtime symlink escapes its root: ${relativePath}`,
          );
        }
      } else {
        await walk(physicalPath, relativePath);
      }
      seen.add(relativePath);
    }
  }

  onDiagnostic?.("inventory-walk-start");
  await walk(root);
  onDiagnostic?.("inventory-walk-complete");
  const missing = manifest.files.find((entry) => !seen.has(entry.path));
  if (missing) {
    throw new RuntimeExtractionError(
      `extracted Runtime is missing a manifest path: ${missing.path}`,
    );
  }
  if (extractedBytes !== manifestExtractedBytes(manifest)) {
    throw new RuntimeExtractionError(
      "extracted Runtime byte count differs from the manifest",
    );
  }
  onDiagnostic?.("inventory-hash-start");
  await verifyRuntimeFileHashes(fileHashChecks, signal, (path, hashSignal) =>
    hashFileWithHandle(path, hashSignal, inventoryFileSystem.open),
  );
  onDiagnostic?.("inventory-hash-complete");
  return { fileCount, extractedBytes };
}
