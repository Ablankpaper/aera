import { createWriteStream } from "node:fs";
import { lstat, mkdir, symlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, win32 } from "node:path";
import { pipeline } from "node:stream/promises";

import { openPromise, type Entry as ZipEntry, type ZipFile } from "yauzl";

const ARCHIVE_ROOT = "agentera-runtime";
// Keep the helper-side bound identical to the signed archive validator. The
// helper receives an archive that has already passed that validator, so a
// tighter local limit would reject an otherwise valid Seed during extraction.
const MAX_SYMLINK_TARGET_BYTES = 16 * 1024;
const MAX_SYMLINK_HOPS = 40;

export class SequentialZipExtractionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SequentialZipExtractionError";
  }
}

function isDirectoryEntry(entry: ZipEntry): boolean {
  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
  const fileType = unixMode & 0o170000;
  const madeBy = entry.versionMadeBy >>> 8;
  return (
    entry.fileName.endsWith("/") ||
    fileType === 0o040000 ||
    (madeBy === 0 && entry.externalFileAttributes === 16)
  );
}

function isSymlinkEntry(entry: ZipEntry): boolean {
  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
  return (unixMode & 0o170000) === 0o120000;
}

function comparablePath(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US");
}

function reservedWindowsName(value: string): boolean {
  const trimmed = value.replace(/[ .]+$/u, "");
  const stem = trimmed.split(".")[0] ?? trimmed;
  if (/^(?:CON|PRN|AUX|NUL)$/iu.test(stem)) return true;
  return /^(?:COM|LPT)[0-9\u00b9\u00b2\u00b3]$/iu.test(stem);
}

function archiveMemberPath(rawName: string): {
  root: boolean;
  relativePath: string;
} {
  if (
    rawName.includes("\\") ||
    rawName.includes("\0") ||
    rawName.startsWith("/") ||
    /^[A-Za-z]:/u.test(rawName)
  ) {
    throw new SequentialZipExtractionError(
      `unsafe Runtime archive member: ${rawName}`,
    );
  }
  const parts = rawName.split("/");
  if (parts.at(-1) === "") parts.pop();
  if (parts.length === 0 || parts[0] !== ARCHIVE_ROOT) {
    throw new SequentialZipExtractionError(
      `Runtime archive member is outside ${ARCHIVE_ROOT}: ${rawName}`,
    );
  }
  if (parts.length === 1) return { root: true, relativePath: "" };
  const suffix = parts.slice(1);
  if (
    suffix.some(
      (part) =>
        part.length === 0 ||
        part === "." ||
        part === ".." ||
        (process.platform === "win32" && reservedWindowsName(part)),
    )
  ) {
    throw new SequentialZipExtractionError(
      `unsafe Runtime archive member: ${rawName}`,
    );
  }
  return { root: false, relativePath: suffix.join("/") };
}

function assertContained(root: string, target: string): void {
  const value = relative(resolve(root), resolve(target));
  if (
    value.length === 0 ||
    value === ".." ||
    /^(?:\.\.(?:[\\/]|$))/u.test(value) ||
    isAbsolute(value)
  ) {
    throw new SequentialZipExtractionError(
      "Runtime archive member escapes the extraction destination",
    );
  }
}

async function ensureRealDirectory(
  root: string,
  target: string,
  cache: Set<string>,
): Promise<void> {
  assertContained(root, target);
  const suffix = relative(resolve(root), resolve(target));
  let current = resolve(root);
  for (const component of suffix.split(/[\\/]+/u).filter(Boolean)) {
    current = join(current, component);
    if (cache.has(current)) continue;
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new SequentialZipExtractionError(
          `Runtime archive path is not a directory: ${component}`,
        );
      }
    } catch (error) {
      if (
        error instanceof SequentialZipExtractionError ||
        (error as NodeJS.ErrnoException).code !== "ENOENT"
      ) {
        throw error;
      }
      await mkdir(current, { recursive: false, mode: 0o755 });
    }
    cache.add(current);
  }
}

async function readSymlinkTarget(
  zipfile: ZipFile,
  entry: ZipEntry,
): Promise<string> {
  if (entry.uncompressedSize > MAX_SYMLINK_TARGET_BYTES) {
    throw new SequentialZipExtractionError(
      "Runtime symlink target is too large",
    );
  }
  const stream = await zipfile.openReadStreamPromise(entry);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_SYMLINK_TARGET_BYTES) {
      stream.destroy();
      throw new SequentialZipExtractionError(
        "Runtime symlink target is too large",
      );
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function symlinkTargetWithinRoot(
  archiveRoot: string,
  parent: string,
  target: string,
  pending: ReadonlyMap<string, string>,
): void {
  if (
    target.length === 0 ||
    target.includes("\0") ||
    target.includes("\\") ||
    win32.isAbsolute(target) ||
    isAbsolute(target)
  ) {
    throw new SequentialZipExtractionError("Runtime symlink target is invalid");
  }
  let current = resolve(parent, target);
  const rootPath = resolve(archiveRoot);
  for (let hops = 0; hops <= MAX_SYMLINK_HOPS; hops += 1) {
    assertContained(rootPath, current);
    const key = comparablePath(relative(rootPath, current));
    const pendingTarget = pending.get(key);
    if (pendingTarget === undefined) return;
    current = resolve(dirname(current), pendingTarget);
  }
  throw new SequentialZipExtractionError("Runtime symlink target has a loop");
}

interface PendingSymlink {
  output: string;
  target: string;
  parent: string;
}

/**
 * Extract a previously validated Runtime ZIP with one yauzl reader and one
 * output stream at a time.  The packaged Windows helper uses this deliberately
 * bounded path to avoid the native extractor's parallel file-write boundary.
 */
export async function extractRuntimeArchiveSequentially(
  archivePath: string,
  destination: string,
): Promise<void> {
  if (!isAbsolute(archivePath) || !isAbsolute(destination)) {
    throw new SequentialZipExtractionError(
      "Runtime archive paths must be absolute Windows paths",
    );
  }
  const destinationRoot = resolve(destination);
  const rootMetadata = await lstat(destinationRoot);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new SequentialZipExtractionError(
      "Runtime extraction destination must be a directory",
    );
  }

  const zipfile: ZipFile = await openPromise(archivePath, {
    autoClose: true,
    lazyEntries: true,
    decodeStrings: true,
    validateEntrySizes: true,
    strictFileNames: true,
  });
  const seen = new Set<string>();
  const safeDirectories = new Set<string>([destinationRoot]);
  const pendingSymlinks: PendingSymlink[] = [];
  const pendingTargets = new Map<string, string>();
  const archiveRoot = join(destinationRoot, ARCHIVE_ROOT);
  let rootSeen = false;
  try {
    for await (const entry of zipfile.eachEntry()) {
      const directory = isDirectoryEntry(entry);
      const member = archiveMemberPath(entry.fileName);
      if (member.root) {
        const rootMode = (entry.externalFileAttributes >>> 16) & 0o777;
        if (rootSeen || !isDirectoryEntry(entry) || rootMode !== 0o755) {
          throw new SequentialZipExtractionError(
            "Runtime archive root metadata is invalid",
          );
        }
        rootSeen = true;
        await ensureRealDirectory(
          destinationRoot,
          join(destinationRoot, ARCHIVE_ROOT),
          safeDirectories,
        );
        continue;
      }
      const key = comparablePath(member.relativePath);
      if (seen.has(key)) {
        throw new SequentialZipExtractionError(
          `Runtime archive contains a duplicate member: ${member.relativePath}`,
        );
      }
      seen.add(key);
      const output = join(
        destinationRoot,
        ARCHIVE_ROOT,
        ...member.relativePath.split("/"),
      );
      assertContained(destinationRoot, output);
      const symlinkEntry = !directory && isSymlinkEntry(entry);
      const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
      const fileType = unixMode & 0o170000;
      if (
        !directory &&
        !symlinkEntry &&
        fileType !== 0 &&
        fileType !== 0o100000
      ) {
        throw new SequentialZipExtractionError(
          `unsupported Runtime archive member type: ${entry.fileName}`,
        );
      }
      if (directory) {
        await ensureRealDirectory(destinationRoot, output, safeDirectories);
        continue;
      }
      await ensureRealDirectory(
        destinationRoot,
        dirname(output),
        safeDirectories,
      );
      if (symlinkEntry) {
        const target = await readSymlinkTarget(zipfile, entry);
        const parent = dirname(output);
        symlinkTargetWithinRoot(archiveRoot, parent, target, pendingTargets);
        pendingSymlinks.push({ output, parent, target });
        pendingTargets.set(
          comparablePath(relative(archiveRoot, output)),
          target,
        );
        continue;
      }
      const stream = await zipfile.openReadStreamPromise(entry);
      await pipeline(
        stream,
        createWriteStream(output, {
          flags: "wx",
          mode: (entry.externalFileAttributes >>> 16) & 0o777 || 0o644,
        }),
      );
    }
    if (!rootSeen) {
      throw new SequentialZipExtractionError(
        `Runtime archive is missing its ${ARCHIVE_ROOT} root`,
      );
    }
    for (const link of pendingSymlinks) {
      symlinkTargetWithinRoot(
        archiveRoot,
        link.parent,
        link.target,
        pendingTargets,
      );
      try {
        await symlink(link.target, link.output);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (
          process.platform !== "win32" ||
          !["EACCES", "EPERM"].includes(code ?? "")
        ) {
          throw error;
        }
      }
    }
  } finally {
    zipfile.close();
  }
}
