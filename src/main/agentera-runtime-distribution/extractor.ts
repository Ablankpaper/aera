import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  readlink,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { Writable } from "node:stream";
import { createZstdDecompress } from "node:zlib";

import extractZip from "extract-zip";
import { Parser, x as extractTar, type ReadEntry } from "tar";

import type {
  RuntimeInventoryKind,
  RuntimeManifest,
  RuntimeManifestFile,
} from "./manifest";

const ARCHIVE_ROOT = "agentera-runtime";
const MAX_SYMLINK_TARGET_BYTES = 16 * 1024;

export interface ExtractRuntimeArchiveOptions {
  archivePath: string;
  destination: string;
  manifest: RuntimeManifest;
  maxExtractedBytes: number;
  signal?: AbortSignal;
}

export interface RuntimeExtractionResult {
  fileCount: number;
  extractedBytes: number;
}

export class RuntimeExtractionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RuntimeExtractionError";
  }
}

interface ArchiveInventoryEntry {
  path: string;
  kind: RuntimeInventoryKind;
  size: number;
  mode: number;
  linkTarget: string | null;
}

function abortError(): Error {
  const error = new Error("Runtime extraction was cancelled");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function requireExtractionBudget(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RuntimeExtractionError(
      "Runtime extraction budget must be a non-negative safe integer",
    );
  }
}

function manifestExtractedBytes(manifest: RuntimeManifest): number {
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

function validateRelativePath(path: string, label: string): void {
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

function normalizedComparablePath(path: string, windows: boolean): string {
  return windows ? path.normalize("NFKC").toLocaleLowerCase("en-US") : path;
}

function validateSymlinkTarget(path: string, target: string): void {
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
  if (kind === "symlink" && entry.uncompressedSize > MAX_SYMLINK_TARGET_BYTES) {
    throw new RuntimeExtractionError(
      `Runtime symlink target is too large: ${path}`,
    );
  }
  return {
    path,
    kind,
    size: kind === "file" ? entry.uncompressedSize : 0,
    mode,
    linkTarget: null,
  };
}

async function extractZipArchive(
  archivePath: string,
  destination: string,
  workDirectory: string,
  manifest: RuntimeManifest,
  maxExtractedBytes: number,
  signal?: AbortSignal,
): Promise<void> {
  const validator = new ArchiveInventoryValidator(manifest, maxExtractedBytes);
  let activeZip: { close(): void } | null = null;
  let rejectAbort: ((error: Error) => void) | null = null;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = (): void => {
    activeZip?.close();
    rejectAbort?.(abortError());
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    throwIfAborted(signal);
    const extraction = extractZip(archivePath, {
      dir: workDirectory,
      onEntry: (entry, zipfile) => {
        activeZip = zipfile;
        throwIfAborted(signal);
        const metadata = zipEntryMetadata(entry);
        if ("root" in metadata) {
          validator.addRoot(metadata.kind, metadata.mode);
        } else {
          validator.add(metadata);
        }
      },
    });
    await (signal ? Promise.race([extraction, abortPromise]) : extraction);
    validator.finish();
    const children = await readdir(workDirectory);
    if (children.length !== 1 || children[0] !== ARCHIVE_ROOT) {
      throw new RuntimeExtractionError(
        "ZIP extraction produced content outside the Runtime archive root",
      );
    }
    await rename(join(workDirectory, ARCHIVE_ROOT), destination);
  } finally {
    signal?.removeEventListener("abort", onAbort);
    activeZip = null;
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

function pathEscapes(parent: string, child: string): boolean {
  const value = relative(parent, child);
  return value === ".." || value.startsWith(`..${sep}`) || isAbsolute(value);
}

async function hashFile(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    throwIfAborted(signal);
    hash.update(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return hash.digest("hex");
}

async function verifyExtractedInventory(
  destination: string,
  manifest: RuntimeManifest,
  maxExtractedBytes: number,
  signal?: AbortSignal,
): Promise<RuntimeExtractionResult> {
  const root = await realpath(destination);
  const expected = new Map(manifest.files.map((entry) => [entry.path, entry]));
  const seen = new Set<string>();
  let fileCount = 0;
  let extractedBytes = 0;

  async function walk(
    directory: string,
    relativeDirectory = "",
  ): Promise<void> {
    throwIfAborted(signal);
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) =>
      Buffer.from(left.name).compare(Buffer.from(right.name)),
    );
    for (const child of children) {
      throwIfAborted(signal);
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${child.name}`
        : child.name;
      validateRelativePath(relativePath, "extracted Runtime path");
      const expectedEntry = expected.get(relativePath);
      if (!expectedEntry) {
        throw new RuntimeExtractionError(
          `extracted Runtime contains an unexpected path: ${relativePath}`,
        );
      }
      const physicalPath = join(directory, child.name);
      const metadata = await lstat(physicalPath);
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
      if (kind !== "symlink" && manifest.platform !== "windows") {
        await chmod(physicalPath, expectedEntry.mode);
        const normalizedMode = (await lstat(physicalPath)).mode & 0o777;
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
        if ((await hashFile(physicalPath, signal)) !== expectedEntry.sha256) {
          throw new RuntimeExtractionError(
            `extracted Runtime hash differs from the manifest: ${relativePath}`,
          );
        }
      } else if (kind === "symlink") {
        const target = await readlink(physicalPath);
        validateSymlinkTarget(relativePath, target);
        if (target !== expectedEntry.link_target) {
          throw new RuntimeExtractionError(
            `extracted Runtime symlink differs from the manifest: ${relativePath}`,
          );
        }
        let resolvedTarget: string;
        try {
          resolvedTarget = await realpath(physicalPath);
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

  await walk(root);
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
  return { fileCount, extractedBytes };
}

// @lat: [[agentera-runtime-distribution#Offline Seed installation and repair]]
export async function extractRuntimeArchive({
  archivePath,
  destination,
  manifest,
  maxExtractedBytes,
  signal,
}: ExtractRuntimeArchiveOptions): Promise<RuntimeExtractionResult> {
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
    return await verifyExtractedInventory(
      target,
      manifest,
      maxExtractedBytes,
      signal,
    );
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
  }
}
