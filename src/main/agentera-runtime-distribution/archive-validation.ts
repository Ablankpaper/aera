import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import {
  fromRandomAccessReaderPromise,
  RandomAccessReader,
  type Entry as ZipEntry,
  type ZipFile,
} from "yauzl";

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

export type RuntimeArchiveValidationDiagnosticObserver = (
  event: "zip-validation-start" | "zip-validation-complete",
) => void;

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

class RuntimeZipRandomAccessReader extends RandomAccessReader {
  private closed = false;

  constructor(private readonly handle: RuntimeArchiveFileHandle) {
    super();
  }

  override _readStreamForRange(
    start: number,
    end: number,
  ): ReturnType<typeof createReadStream> {
    return this.handle.createReadStream({
      start,
      end: end - 1,
      autoClose: false,
    });
  }

  override read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
    callback: (error: Error | null, bytesRead?: number) => void,
  ): void {
    void this.handle
      .read(buffer, offset, length, position)
      .then(({ bytesRead }) => callback(null, bytesRead))
      .catch((error: unknown) =>
        callback(error instanceof Error ? error : new Error("ZIP read failed")),
      );
  }

  override close(callback: (error: Error | null) => void): void {
    if (this.closed) {
      setImmediate(callback, null);
      return;
    }
    this.closed = true;
    void this.handle.close().then(
      () => callback(null),
      (error: unknown) =>
        callback(
          error instanceof Error ? error : new Error("ZIP close failed"),
        ),
    );
  }
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
  zipfile.on("entry", onEntry);
  zipfile.on("error", onError);
  zipfile.on("close", onClose);
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
  }
}

async function openRuntimeZip(
  archivePath: string,
  fileSystem: RuntimeArchiveFileSystem,
): Promise<ZipFile> {
  const handle = await fileSystem.open(archivePath, "r");
  const reader = new RuntimeZipRandomAccessReader(handle);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new RuntimeExtractionError("Runtime ZIP archive must be a file");
    }
    return await fromRandomAccessReaderPromise(reader, metadata.size, {
      lazyEntries: true,
      decodeStrings: true,
      validateEntrySizes: true,
      strictFileNames: true,
    });
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
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

  constructor(
    private readonly manifest: RuntimeManifest,
    private readonly maxExtractedBytes: number,
  ) {
    this.expected = new Map(manifest.files.map((entry) => [entry.path, entry]));
    assertNoSymlinkAncestors(manifest.files);
  }

  addRoot(kind: RuntimeInventoryKind, mode: number): void {
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
}

export async function validateRuntimeZipArchive(
  archivePath: string,
  manifest: RuntimeManifest,
  maxExtractedBytes: number,
  signal?: AbortSignal,
  fileSystem?: RuntimeArchiveFileSystem,
  onDiagnostic?: RuntimeArchiveValidationDiagnosticObserver,
): Promise<void> {
  onDiagnostic?.("zip-validation-start");
  const validator = new ArchiveInventoryValidator(manifest, maxExtractedBytes);
  const zipfile = await openRuntimeZip(
    archivePath,
    fileSystem ?? (await resolveRuntimeArchiveFileSystem()),
  );
  try {
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
  } finally {
    zipfile.close();
  }
  onDiagnostic?.("zip-validation-complete");
}
