import { appendFileSync, createReadStream } from "node:fs";
import { lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Writable } from "node:stream";
import { createZstdDecompress } from "node:zlib";

import { extract as extractZip } from "@electron-internal/extract-zip";
import { Parser, x as extractTar, type ReadEntry } from "tar";
import {
  openPromise as openZip,
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
  isAbortError,
  manifestExtractedBytes,
  normalizedComparablePath,
  requireExtractionBudget,
  throwIfAborted,
  validateRelativePath,
  validateSymlinkTarget,
  type RuntimeExtractionResult,
} from "./inventory";
import { verifyExtractedRuntimeInventory } from "./inventory-process";

export {
  RuntimeExtractionError,
  shouldEnforceExtractedRuntimeMode,
  verifyRuntimeFileHashes,
  type RuntimeExtractionResult,
  type RuntimeFileHashCheck,
  type RuntimeFileHasher,
} from "./inventory";
export { verifyExtractedRuntimeInventory } from "./inventory-process";

const ARCHIVE_ROOT = "agentera-runtime";

let activeRuntimeExtractions = 0;
const runtimeExtractionDiagnosticStartedAt = Date.now();

function runtimeExtractionDiagnostic(
  event: string,
  fields: Readonly<Record<string, boolean | number | string | null>> = {},
): void {
  if (process.env.AGENTERA_E2E_DIAGNOSTICS !== "1") return;
  const output = process.env.AGENTERA_E2E_RUNTIME_CONTRACT_DIAGNOSTIC_OUTPUT;
  if (!output) return;
  try {
    appendFileSync(
      output,
      `${JSON.stringify({
        schemaVersion: 1,
        event,
        elapsedMs: Date.now() - runtimeExtractionDiagnosticStartedAt,
        pid: process.pid,
        ...fields,
      })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  } catch {
    // Diagnostics must never affect Runtime installation.
  }
}

export interface ExtractRuntimeArchiveOptions {
  archivePath: string;
  destination: string;
  manifest: RuntimeManifest;
  maxExtractedBytes: number;
  signal?: AbortSignal;
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
  zipfile: Awaited<ReturnType<typeof openZip>>,
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

const openRuntimeZip = (archivePath: string): Promise<ZipFile> =>
  openZip(archivePath, {
    lazyEntries: true,
    decodeStrings: true,
    validateEntrySizes: true,
    strictFileNames: true,
  });

async function readZipSymlinkTarget(
  zipfile: Awaited<ReturnType<typeof openZip>>,
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

async function validateZipArchive(
  archivePath: string,
  manifest: RuntimeManifest,
  maxExtractedBytes: number,
  signal?: AbortSignal,
): Promise<void> {
  runtimeExtractionDiagnostic("zip-validation-start");
  const validator = new ArchiveInventoryValidator(manifest, maxExtractedBytes);
  const zipfile = await openRuntimeZip(archivePath);
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
  runtimeExtractionDiagnostic("zip-validation-complete");
}

function tarParserWritable(parser: Parser): Writable {
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      try {
        if (parser.write(chunk)) callback();
        else parser.once("drain", callback);
      } catch (error) {
        callback(error as Error);
      }
    },
    final(callback) {
      parser.once("end", callback);
      parser.end();
    },
    destroy(error, callback) {
      parser.off("error", onParserError);
      if (error) {
        parser.once("error", () => undefined);
        parser.abort(error);
      }
      callback(error);
    },
  });
  const onParserError = (error: Error): void => {
    sink.destroy(error);
  };
  parser.on("error", onParserError);
  sink.once("close", () => parser.off("error", onParserError));
  return sink;
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

function tarEntryKind(entry: ReadEntry): RuntimeInventoryKind {
  if (entry.type === "Directory") return "directory";
  if (entry.type === "SymbolicLink") return "symlink";
  if (entry.type === "File" || entry.type === "OldFile") return "file";
  throw new RuntimeExtractionError(
    `unsupported TAR member type ${entry.type}: ${entry.path}`,
  );
}

async function validateTarArchive(
  archivePath: string,
  manifest: RuntimeManifest,
  maxExtractedBytes: number,
  signal?: AbortSignal,
): Promise<void> {
  const validator = new ArchiveInventoryValidator(manifest, maxExtractedBytes);
  let validationError: Error | null = null;
  const parser = new Parser({
    strict: true,
    onReadEntry: (entry) => {
      try {
        if (validationError) return;
        throwIfAborted(signal);
        const kind = tarEntryKind(entry);
        const path = archiveRelativePath(entry.path, kind === "directory");
        const mode = (entry.mode ?? 0) & 0o777;
        if (path === null) {
          validator.addRoot(kind, mode);
        } else {
          validator.add({
            path,
            kind,
            size: kind === "file" ? entry.size : 0,
            mode,
            linkTarget: kind === "symlink" ? (entry.linkpath ?? "") : null,
          });
        }
      } catch (error) {
        validationError =
          error instanceof Error
            ? error
            : new RuntimeExtractionError("cannot validate TAR member");
      } finally {
        entry.resume();
      }
    },
  });
  await pipeline(
    createReadStream(archivePath),
    createZstdDecompress(),
    tarParserWritable(parser),
    signal ? { signal } : {},
  );
  if (validationError) throw validationError;
  throwIfAborted(signal);
  validator.finish();
}

async function extractZipArchive(
  archivePath: string,
  destination: string,
  workDirectory: string,
  manifest: RuntimeManifest,
  maxExtractedBytes: number,
  signal?: AbortSignal,
): Promise<void> {
  runtimeExtractionDiagnostic("zip-extraction-start", {
    activeExtractions: activeRuntimeExtractions,
  });
  await validateZipArchive(archivePath, manifest, maxExtractedBytes, signal);
  try {
    throwIfAborted(signal);
    const entryCount = manifest.files.length + 1;
    await extractZip(archivePath, { dir: workDirectory });
    throwIfAborted(signal);
    runtimeExtractionDiagnostic("zip-extraction-native-complete", {
      entryCount,
    });
    const children = await readdir(workDirectory);
    if (children.length !== 1 || children[0] !== ARCHIVE_ROOT) {
      throw new RuntimeExtractionError(
        "ZIP extraction produced content outside the Runtime archive root",
      );
    }
    await rename(join(workDirectory, ARCHIVE_ROOT), destination);
    runtimeExtractionDiagnostic("zip-extraction-rename-complete", {
      entryCount,
    });
  } finally {
    await rm(workDirectory, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
}

async function extractTarArchive(
  archivePath: string,
  destination: string,
  signal?: AbortSignal,
): Promise<void> {
  await mkdir(destination, { recursive: false, mode: 0o700 });
  const unpack = extractTar({
    cwd: destination,
    strip: 1,
    preservePaths: false,
    strict: true,
  });
  await pipeline(
    createReadStream(archivePath),
    createZstdDecompress(),
    tarParserWritable(unpack),
    signal ? { signal } : {},
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

// @lat: [[agentera-runtime-distribution#Offline Seed installation and repair]]
export async function extractRuntimeArchive({
  archivePath,
  destination,
  manifest,
  maxExtractedBytes,
  signal,
}: ExtractRuntimeArchiveOptions): Promise<RuntimeExtractionResult> {
  activeRuntimeExtractions += 1;
  runtimeExtractionDiagnostic("extract-start", {
    activeExtractions: activeRuntimeExtractions,
  });
  try {
    requireExtractionBudget(maxExtractedBytes);
    throwIfAborted(signal);
    const declaredBytes = manifestExtractedBytes(manifest);
    if (declaredBytes > maxExtractedBytes) {
      throw new RuntimeExtractionError(
        "Runtime manifest exceeds the signed extraction budget",
      );
    }
    const target = resolve(destination);
    if (!isAbsolute(destination)) {
      throw new RuntimeExtractionError(
        "Runtime extraction destination must be absolute",
      );
    }
    const zipWorkDirectory = `${target}.zip-extracting`;
    if ((await pathExists(target)) || (await pathExists(zipWorkDirectory))) {
      throw new RuntimeExtractionError(
        "Runtime extraction destination must not already exist",
      );
    }
    const electronProcess = process as NodeJS.Process & { noAsar?: boolean };
    const previousNoAsar = electronProcess.noAsar;
    if (manifest.platform === "windows") electronProcess.noAsar = true;
    try {
      if (manifest.platform === "darwin") {
        if (!manifest.archive_name.endsWith(".tar.zst")) {
          throw new RuntimeExtractionError(
            "macOS Runtime Seed must use TAR/Zstandard",
          );
        }
        await validateTarArchive(
          archivePath,
          manifest,
          maxExtractedBytes,
          signal,
        );
        throwIfAborted(signal);
        await extractTarArchive(archivePath, target, signal);
      } else {
        if (!manifest.archive_name.endsWith(".zip")) {
          throw new RuntimeExtractionError("Windows Runtime Seed must use ZIP");
        }
        await mkdir(zipWorkDirectory, { recursive: false, mode: 0o700 });
        await extractZipArchive(
          archivePath,
          target,
          zipWorkDirectory,
          manifest,
          maxExtractedBytes,
          signal,
        );
      }
      throwIfAborted(signal);
      const result = await verifyExtractedRuntimeInventory(
        target,
        manifest,
        maxExtractedBytes,
        signal,
      );
      runtimeExtractionDiagnostic("extract-complete", {
        activeExtractions: activeRuntimeExtractions,
        fileCount: result.fileCount,
        extractedBytes: result.extractedBytes,
      });
      return result;
    } catch (error) {
      await rm(target, { recursive: true, force: true }).catch(() => undefined);
      await rm(zipWorkDirectory, { recursive: true, force: true }).catch(
        () => undefined,
      );
      if (isAbortError(error)) throw error;
      if (error instanceof RuntimeExtractionError) throw error;
      throw new RuntimeExtractionError("cannot safely extract Runtime Seed", {
        cause: error,
      });
    } finally {
      await rm(zipWorkDirectory, { recursive: true, force: true }).catch(
        () => undefined,
      );
      if (manifest.platform === "windows") {
        electronProcess.noAsar = previousNoAsar;
      }
    }
  } finally {
    activeRuntimeExtractions -= 1;
    runtimeExtractionDiagnostic("extract-finally", {
      activeExtractions: activeRuntimeExtractions,
    });
  }
}
