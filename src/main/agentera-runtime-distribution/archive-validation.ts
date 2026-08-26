import { constants as bufferConstants } from "node:buffer";
import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { fromBufferPromise, type Entry as ZipEntry, type ZipFile } from "yauzl";

import {
  type RuntimeInventoryKind,
  type RuntimeManifest,
  type RuntimeManifestFile,
} from "./manifest";
import {
  MAX_SYMLINK_TARGET_BYTES,
  RuntimeExtractionError,
  manifestExtractedBytes,
  normalizedComparablePath,
  throwIfAborted,
  validateRelativePath,
  validateSymlinkTarget,
} from "./inventory";

const ARCHIVE_ROOT = "agentera-runtime";
const ARCHIVE_VALIDATION_HELPER_MARKER =
  "AGENTERA_RUNTIME_ARCHIVE_VALIDATION_HELPER";

export interface RuntimeArchiveFileHandle {
  stat(): Promise<{ isFile(): boolean; size: number }>;
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number; buffer: Buffer }>;
  createReadStream(options: {
    start: number;
    end: number;
    autoClose: false;
  }): ReturnType<typeof createReadStream>;
  close(): Promise<void>;
}

export interface RuntimeArchiveFileSystem {
  open(path: string, flags: string): Promise<RuntimeArchiveFileHandle>;
}

export type RuntimeArchiveFileSystemLoader = () => Promise<unknown>;

export type RuntimeArchiveValidationDiagnosticEvent =
  | "zip-validation-start"
  | "zip-validation-complete"
  | "zip-validation-failed";

export interface RuntimeArchiveValidationDiagnostic {
  event: RuntimeArchiveValidationDiagnosticEvent;
  durationMs?: number;
  timeoutMs?: number;
  archiveBytes?: number;
  entryCount?: number;
  extractedBytes?: number;
}

export type RuntimeArchiveValidationDiagnosticObserver = (
  diagnostic: RuntimeArchiveValidationDiagnostic,
) => void;

/**
 * The packaged Windows parent bounds the helper with the same deadline that
 * is reported in its path-free diagnostic stream. The signed archive size,
 * rather than an arbitrary process default, bounds the validation buffer.
 */
export const WINDOWS_ARCHIVE_VALIDATION_TIMEOUT_MS = 8 * 60 * 1000;

const NODE_RUNTIME_ARCHIVE_FILE_SYSTEM: RuntimeArchiveFileSystem = {
  open,
};

const ORIGINAL_FS_MODULE = "original-fs";
const loadElectronOriginalFs: RuntimeArchiveFileSystemLoader = () =>
  import(/* @vite-ignore */ ORIGINAL_FS_MODULE);

function archiveFileSystemCandidate(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  return record.default && typeof record.default === "object"
    ? (record.default as Record<string, unknown>)
    : record;
}

export async function resolveRuntimeArchiveFileSystem(
  electronVersion: string | undefined = process.versions.electron,
  loadOriginalFs?: RuntimeArchiveFileSystemLoader,
): Promise<RuntimeArchiveFileSystem> {
  if (
    process.env[ARCHIVE_VALIDATION_HELPER_MARKER] === "1" ||
    (!electronVersion && !loadOriginalFs)
  ) {
    return NODE_RUNTIME_ARCHIVE_FILE_SYSTEM;
  }
  const candidate = archiveFileSystemCandidate(
    await (loadOriginalFs ?? loadElectronOriginalFs)(),
  );
  const promises = candidate.promises;
  if (!promises || typeof promises !== "object") {
    throw new RuntimeExtractionError(
      "Electron original filesystem is unavailable",
    );
  }
  const promiseRecord = promises as Record<string, unknown>;
  if (typeof promiseRecord.open !== "function") {
    throw new RuntimeExtractionError(
      "Electron original filesystem is unavailable",
    );
  }
  return {
    open: promiseRecord.open.bind(promises) as RuntimeArchiveFileSystem["open"],
  };
}

interface ArchiveInventoryEntry {
  path: string;
  kind: RuntimeInventoryKind;
  size: number;
  mode: number;
  linkTarget: string | null;
}

function archiveRelativePath(
  rawName: string,
  isDirectory: boolean,
): string | null {
  if (
    rawName.includes("\\") ||
    rawName.includes("\0") ||
    rawName.startsWith("/") ||
    /^[A-Za-z]:/.test(rawName)
  ) {
    throw new RuntimeExtractionError(
      `unsafe Runtime archive member: ${rawName}`,
    );
  }
  const name =
    isDirectory && rawName.endsWith("/") ? rawName.slice(0, -1) : rawName;
  if (name === ARCHIVE_ROOT) return null;
  const prefix = `${ARCHIVE_ROOT}/`;
  if (!name.startsWith(prefix)) {
    throw new RuntimeExtractionError(
      `Runtime archive member is outside ${ARCHIVE_ROOT}: ${rawName}`,
    );
  }
  const path = name.slice(prefix.length);
  validateRelativePath(path, "Runtime archive member");
  return path;
}

function zipEntryMetadata(entry: {
  fileName: string;
  externalFileAttributes: number;
  versionMadeBy: number;
  uncompressedSize: number;
}):
  | ArchiveInventoryEntry
  | { root: true; kind: RuntimeInventoryKind; mode: number } {
  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
  const fileType = unixMode & 0o170000;
  const madeBy = entry.versionMadeBy >>> 8;
  const isDirectory =
    entry.fileName.endsWith("/") ||
    fileType === 0o040000 ||
    (madeBy === 0 && entry.externalFileAttributes === 16);
  const kind: RuntimeInventoryKind = isDirectory
    ? "directory"
    : fileType === 0o120000
      ? "symlink"
      : "file";
  if (
    !isDirectory &&
    fileType !== 0 &&
    fileType !== 0o100000 &&
    kind !== "symlink"
  ) {
    throw new RuntimeExtractionError(
      `unsupported ZIP member type: ${entry.fileName}`,
    );
  }
  const path = archiveRelativePath(entry.fileName, isDirectory);
  const mode = unixMode & 0o777;
  if (path === null) return { root: true, kind, mode };
  return {
    path,
    kind,
    size: kind === "file" ? entry.uncompressedSize : 0,
    mode,
    linkTarget: null,
  };
}

async function* zipEntries(
  zipfile: ZipFile,
  signal?: AbortSignal,
): AsyncGenerator<ZipEntry> {
  let next: (() => void) | null = null;
  let failure: Error | null = null;
  let closed = false;
  const pending: ZipEntry[] = [];
  const onEntry = (entry: ZipEntry): void => {
    pending.push(entry);
    next?.();
    next = null;
  };
  const onError = (error: Error): void => {
    failure = error;
    next?.();
    next = null;
  };
  const onClose = (): void => {
    closed = true;
    next?.();
    next = null;
  };
  // `fromBuffer` deliberately disables yauzl's autoClose behavior. Its
  // metadata lifecycle therefore ends with `end`, not `close`; handling both
  // keeps the iterator bounded for buffer-backed and file-backed readers.
  const onEnd = (): void => {
    closed = true;
    next?.();
    next = null;
  };
  zipfile.on("entry", onEntry);
  zipfile.on("error", onError);
  zipfile.on("close", onClose);
  zipfile.on("end", onEnd);
  try {
    zipfile.readEntry();
    while (pending.length > 0 || (!closed && failure === null)) {
      throwIfAborted(signal);
      if (failure) throw failure;
      const entry = pending.shift();
      if (entry) {
        yield entry;
        zipfile.readEntry();
      } else {
        await new Promise<void>((resolvePromise) => {
          next = resolvePromise;
        });
      }
      if (failure) throw failure;
      if (!zipfile.isOpen && pending.length === 0) break;
    }
  } finally {
    zipfile.off("entry", onEntry);
    zipfile.off("error", onError);
    zipfile.off("close", onClose);
    zipfile.off("end", onEnd);
  }
}

async function readRuntimeZipBuffer(
  archivePath: string,
  manifest: RuntimeManifest,
  fileSystem: RuntimeArchiveFileSystem,
): Promise<Buffer> {
  const handle = await fileSystem.open(archivePath, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile()) {
      throw new RuntimeExtractionError("Runtime ZIP archive must be a file");
    }
    const archiveSize = manifest.archive_size;
    if (
      !Number.isSafeInteger(archiveSize) ||
      archiveSize <= 0 ||
      archiveSize > bufferConstants.MAX_LENGTH
    ) {
      throw new RuntimeExtractionError(
        "Runtime archive size is outside the supported validation range",
      );
    }
    if (before.size !== archiveSize) {
      throw new RuntimeExtractionError(
        "Runtime archive size differs from the signed manifest",
      );
    }
    // A bounded sequence of positional reads replaces yauzl's per-entry
    // random reads. Node may legally return fewer bytes than requested even
    // for a regular file, so fill the signed-size buffer instead of treating
    // the first partial read as evidence that the archive changed.
    const buffer = Buffer.allocUnsafe(archiveSize);
    let position = 0;
    while (position < archiveSize) {
      const { bytesRead } = await handle.read(
        buffer,
        position,
        archiveSize - position,
        position,
      );
      if (bytesRead <= 0) {
        throw new RuntimeExtractionError(
          "Runtime archive size changed during validation",
        );
      }
      position += bytesRead;
    }
    const after = await handle.stat();
    if (!after.isFile() || after.size !== archiveSize) {
      throw new RuntimeExtractionError(
        "Runtime archive size changed during validation",
      );
    }
    return buffer;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function readZipSymlinkTarget(
  zipfile: ZipFile,
  entry: ZipEntry,
  path: string,
  signal?: AbortSignal,
): Promise<string> {
  if (entry.uncompressedSize > MAX_SYMLINK_TARGET_BYTES) {
    throw new RuntimeExtractionError(
      `Runtime symlink target is too large: ${path}`,
    );
  }
  const stream = await zipfile.openReadStreamPromise(entry);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    throwIfAborted(signal);
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_SYMLINK_TARGET_BYTES) {
      stream.destroy();
      throw new RuntimeExtractionError(
        `Runtime symlink target is too large: ${path}`,
      );
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function assertNoSymlinkAncestors(
  entries: readonly RuntimeManifestFile[],
): void {
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  for (const entry of entries) {
    const parts = entry.path.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      const ancestor = byPath.get(parts.slice(0, index).join("/"));
      if (ancestor?.kind === "symlink") {
        throw new RuntimeExtractionError(
          `Runtime archive member is nested below a symlink: ${entry.path}`,
        );
      }
    }
    if (entry.kind === "symlink") {
      validateSymlinkTarget(entry.path, entry.link_target ?? "");
    }
  }
}

class ArchiveInventoryValidator {
  private readonly expected: Map<string, RuntimeManifestFile>;
  private readonly seen = new Set<string>();
  private readonly comparableSeen = new Set<string>();
  private rootSeen = false;
  private extractedBytes = 0;
  private entryCount = 0;

  constructor(
    private readonly manifest: RuntimeManifest,
    private readonly maxExtractedBytes: number,
  ) {
    this.expected = new Map(manifest.files.map((entry) => [entry.path, entry]));
    assertNoSymlinkAncestors(manifest.files);
  }

  addRoot(kind: RuntimeInventoryKind, mode: number): void {
    this.entryCount += 1;
    if (this.rootSeen) {
      throw new RuntimeExtractionError(
        "Runtime archive contains a duplicate root",
      );
    }
    if (kind !== "directory" || mode !== 0o755) {
      throw new RuntimeExtractionError(
        "Runtime archive root metadata is invalid",
      );
    }
    this.rootSeen = true;
  }

  add(entry: ArchiveInventoryEntry): void {
    this.entryCount += 1;
    const comparable = normalizedComparablePath(
      entry.path,
      this.manifest.platform === "windows",
    );
    if (this.comparableSeen.has(comparable)) {
      throw new RuntimeExtractionError(
        `Runtime archive contains a duplicate member path: ${entry.path}`,
      );
    }
    this.comparableSeen.add(comparable);
    const expected = this.expected.get(entry.path);
    if (!expected) {
      throw new RuntimeExtractionError(
        `Runtime archive contains an unexpected member: ${entry.path}`,
      );
    }
    if (expected.kind !== entry.kind) {
      throw new RuntimeExtractionError(
        `Runtime archive member kind differs from the manifest: ${entry.path}`,
      );
    }
    if (expected.mode !== entry.mode) {
      throw new RuntimeExtractionError(
        `Runtime archive member mode differs from the manifest: ${entry.path}`,
      );
    }
    if (entry.kind === "file") {
      if (expected.size !== entry.size) {
        throw new RuntimeExtractionError(
          `Runtime archive member size differs from the manifest: ${entry.path}`,
        );
      }
      this.extractedBytes += entry.size;
      if (
        !Number.isSafeInteger(this.extractedBytes) ||
        this.extractedBytes > this.maxExtractedBytes
      ) {
        throw new RuntimeExtractionError(
          "Runtime archive exceeds the signed extraction budget",
        );
      }
    }
    if (entry.kind === "symlink") {
      const target = entry.linkTarget ?? expected.link_target ?? "";
      validateSymlinkTarget(entry.path, target);
      if (
        entry.linkTarget !== null &&
        entry.linkTarget !== expected.link_target
      ) {
        throw new RuntimeExtractionError(
          `Runtime symlink target differs from the manifest: ${entry.path}`,
        );
      }
    }
    this.seen.add(entry.path);
  }

  finish(): void {
    if (!this.rootSeen) {
      throw new RuntimeExtractionError(
        `Runtime archive is missing its ${ARCHIVE_ROOT} root`,
      );
    }
    const missing = this.manifest.files.find(
      (entry) => !this.seen.has(entry.path),
    );
    if (missing) {
      throw new RuntimeExtractionError(
        `Runtime archive is missing a manifest member: ${missing.path}`,
      );
    }
    if (this.extractedBytes !== manifestExtractedBytes(this.manifest)) {
      throw new RuntimeExtractionError(
        "Runtime archive extracted size differs from the manifest",
      );
    }
  }

  get counts(): { entryCount: number; extractedBytes: number } {
    return {
      entryCount: this.entryCount,
      extractedBytes: this.extractedBytes,
    };
  }
}

export async function validateRuntimeZipArchive(
  archivePath: string,
  manifest: RuntimeManifest,
  maxExtractedBytes: number,
  signal?: AbortSignal,
  fileSystem?: RuntimeArchiveFileSystem,
  onDiagnostic?: RuntimeArchiveValidationDiagnosticObserver,
): Promise<void> {
  const startedAt = Date.now();
  const emit = (diagnostic: RuntimeArchiveValidationDiagnostic): void => {
    try {
      onDiagnostic?.(diagnostic);
    } catch {
      // Diagnostics are observational and must never change validation.
    }
  };
  emit({
    event: "zip-validation-start",
    archiveBytes: manifest.archive_size,
    timeoutMs: WINDOWS_ARCHIVE_VALIDATION_TIMEOUT_MS,
  });
  const validator = new ArchiveInventoryValidator(manifest, maxExtractedBytes);
  let zipfile: ZipFile | undefined;
  try {
    const archive = await readRuntimeZipBuffer(
      archivePath,
      manifest,
      fileSystem ?? (await resolveRuntimeArchiveFileSystem()),
    );
    zipfile = await fromBufferPromise(archive, {
      lazyEntries: true,
      decodeStrings: true,
      validateEntrySizes: true,
      strictFileNames: true,
    });
    for await (const entry of zipEntries(zipfile, signal)) {
      const metadata = zipEntryMetadata(entry);
      if ("root" in metadata) validator.addRoot(metadata.kind, metadata.mode);
      else if (metadata.kind === "symlink") {
        validator.add({
          ...metadata,
          linkTarget: await readZipSymlinkTarget(
            zipfile,
            entry,
            metadata.path,
            signal,
          ),
        });
      } else validator.add(metadata);
    }
    validator.finish();
    const counts = validator.counts;
    emit({
      event: "zip-validation-complete",
      durationMs: Math.max(0, Date.now() - startedAt),
      timeoutMs: WINDOWS_ARCHIVE_VALIDATION_TIMEOUT_MS,
      archiveBytes: archive.length,
      ...counts,
    });
  } catch (error) {
    emit({
      event: "zip-validation-failed",
      durationMs: Math.max(0, Date.now() - startedAt),
      timeoutMs: WINDOWS_ARCHIVE_VALIDATION_TIMEOUT_MS,
      ...validator.counts,
    });
    throw error;
  } finally {
    zipfile?.close();
  }
}
