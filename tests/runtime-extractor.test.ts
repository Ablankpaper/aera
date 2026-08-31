import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";

import { afterEach, describe, expect, it } from "vitest";
import { Header } from "tar";

import {
  RuntimeExtractionError,
  extractRuntimeArchive,
  type RuntimeArchiveFileSystem,
  type RuntimeArchiveFileSystemLoader,
  shouldEnforceExtractedRuntimeMode,
  verifyExtractedRuntimeInventory,
} from "../src/main/agentera-runtime-distribution/extractor";
import { extractRuntimeArchiveSequentially } from "../src/main/agentera-runtime-distribution/sequential-zip-extractor";
import {
  type RuntimeManifest,
  type RuntimeManifestFile,
  parseRuntimeManifest,
} from "../src/main/agentera-runtime-distribution/manifest";
import {
  createFixtureManifest,
  fixtureCanonicalBytes,
} from "./fixtures/runtime-distribution/fixture";

interface ArchiveEntry {
  name: string;
  kind: "file" | "directory" | "symlink";
  body?: Buffer;
  mode?: number;
  linkTarget?: string;
}

const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(
    workspaces
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function workspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "agentera-extractor-test-"));
  workspaces.push(path);
  return path;
}

function digest(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function file(path: string, body: Buffer, mode = 0o644): RuntimeManifestFile {
  return {
    path,
    kind: "file",
    size: body.length,
    sha256: digest(body),
    mode,
    link_target: null,
  };
}

function directory(path: string): RuntimeManifestFile {
  return {
    path,
    kind: "directory",
    size: 0,
    sha256: null,
    mode: 0o755,
    link_target: null,
  };
}

function symlink(path: string, target: string): RuntimeManifestFile {
  return {
    path,
    kind: "symlink",
    size: 0,
    sha256: null,
    mode: 0o777,
    link_target: target,
  };
}

const pythonBody = Buffer.from("#!/bin/sh\necho python\n", "utf8");
const hermesBody = Buffer.from("#!/bin/sh\necho hermes\n", "utf8");

function baseFiles(extra: RuntimeManifestFile[] = []): RuntimeManifestFile[] {
  return [
    directory("python"),
    directory("python/bin"),
    file("python/bin/python3", pythonBody, 0o755),
    directory("runtime"),
    file("runtime/hermes", hermesBody, 0o755),
    ...extra,
  ].sort((left, right) =>
    Buffer.from(left.path).compare(Buffer.from(right.path)),
  );
}

function manifest(
  platform: "darwin" | "windows" = "darwin",
  files = baseFiles(),
): RuntimeManifest {
  const arch = platform === "darwin" ? "arm64" : "x64";
  const extension = platform === "darwin" ? ".tar.zst" : ".zip";
  const value = createFixtureManifest({
    platform,
    arch,
    archive_name: `agentera-runtime-test-${platform}-${arch}${extension}`,
    files,
  });
  return parseRuntimeManifest(fixtureCanonicalBytes(value));
}

function archiveEntries(
  files: RuntimeManifestFile[],
  overrides: ArchiveEntry[] = [],
): ArchiveEntry[] {
  const byName = new Map<string, ArchiveEntry>();
  byName.set("agentera-runtime", {
    name: "agentera-runtime",
    kind: "directory",
    mode: 0o755,
  });
  for (const entry of files) {
    byName.set(`agentera-runtime/${entry.path}`, {
      name: `agentera-runtime/${entry.path}`,
      kind: entry.kind,
      body:
        entry.path === "python/bin/python3"
          ? pythonBody
          : entry.path === "runtime/hermes"
            ? hermesBody
            : entry.kind === "file"
              ? Buffer.alloc(entry.size)
              : undefined,
      mode: entry.mode,
      linkTarget: entry.link_target ?? undefined,
    });
  }
  for (const entry of overrides) byName.set(entry.name, entry);
  return [...byName.values()].sort((left, right) =>
    Buffer.from(left.name).compare(Buffer.from(right.name)),
  );
}

function tarBuffer(entries: ArchiveEntry[]): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const body = entry.body ?? Buffer.alloc(0);
    const type =
      entry.kind === "directory"
        ? "Directory"
        : entry.kind === "symlink"
          ? "SymbolicLink"
          : "File";
    const header = new Header({
      path: entry.name,
      type,
      mode: entry.mode ?? (entry.kind === "file" ? 0o644 : 0o755),
      uid: 0,
      gid: 0,
      size: entry.kind === "file" ? body.length : 0,
      mtime: new Date(0),
      uname: "",
      gname: "",
      linkpath: entry.linkTarget,
    });
    header.encode();
    if (!header.block) throw new Error("failed to encode TAR header");
    chunks.push(header.block);
    if (entry.kind === "file") {
      chunks.push(body);
      const padding = (512 - (body.length % 512)) % 512;
      if (padding > 0) chunks.push(Buffer.alloc(padding));
    }
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

async function writeTarZstd(
  root: string,
  entries: ArchiveEntry[],
): Promise<string> {
  const path = join(root, "seed.tar.zst");
  await writeFile(path, zstdCompressSync(tarBuffer(entries)));
  return path;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(value: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of value) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function zipBuffer(entries: ArchiveEntry[]): Buffer {
  const localChunks: Buffer[] = [];
  const centralChunks: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const nameText =
      entry.kind === "directory" && !entry.name.endsWith("/")
        ? `${entry.name}/`
        : entry.name;
    const name = Buffer.from(nameText, "utf8");
    const body =
      entry.kind === "symlink"
        ? Buffer.from(entry.linkTarget ?? "", "utf8")
        : entry.kind === "file"
          ? (entry.body ?? Buffer.alloc(0))
          : Buffer.alloc(0);
    const crc = crc32(body);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localChunks.push(local, name, body);

    const mode = entry.mode ?? (entry.kind === "file" ? 0o644 : 0o755);
    const typeBits =
      entry.kind === "directory"
        ? 0o040000
        : entry.kind === "symlink"
          ? 0o120000
          : 0o100000;
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(((typeBits | mode) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralChunks.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const centralDirectory = Buffer.concat(centralChunks);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localChunks, centralDirectory, end]);
}

async function writeZip(
  root: string,
  entries: ArchiveEntry[],
): Promise<string> {
  const path = join(root, "seed.zip");
  await writeFile(path, zipBuffer(entries));
  return path;
}

async function recordNoAsarAssignments(
  operation: () => Promise<void>,
): Promise<unknown[]> {
  const descriptor = Object.getOwnPropertyDescriptor(process, "noAsar");
  const assignments: unknown[] = [];
  let current = false;
  Object.defineProperty(process, "noAsar", {
    configurable: true,
    get: () => current,
    set: (value: unknown) => {
      assignments.push(value);
      current = value === true;
    },
  });
  try {
    await operation();
    return assignments;
  } finally {
    if (descriptor) Object.defineProperty(process, "noAsar", descriptor);
    else Reflect.deleteProperty(process, "noAsar");
  }
}

describe("Runtime Seed extractor", () => {
  it("opens ZIP metadata through the supplied native filesystem adapter", async () => {
    const source = await readFile(
      join(
        process.cwd(),
        "src/main/agentera-runtime-distribution/extractor.ts",
      ),
      "utf8",
    );
    expect(source).toMatch(/fromRandomAccessReaderPromise/u);
    expect(source).not.toMatch(/openPromise as openZip/u);

    const root = await workspace();
    const value = manifest("windows");
    const archivePath = await writeZip(root, archiveEntries(value.files));
    const destination = join(root, "payload");
    const calls: string[] = [];
    const adapter = (await import("node:fs")).promises;
    const nativeAdapter: RuntimeArchiveFileSystem = {
      open: async (path, flags) => {
        calls.push(`open:${path}:${flags}`);
        const handle = await adapter.open(path, flags);
        return {
          stat: async () => {
            calls.push("stat");
            return handle.stat();
          },
          read: async (buffer, offset, length, position) => {
            calls.push(`read:${position}:${length}`);
            return handle.read(buffer, offset, length, position);
          },
          createReadStream: (options) => {
            calls.push("stream");
            return handle.createReadStream(options);
          },
          close: () => handle.close(),
        };
      },
    };
    const loader: RuntimeArchiveFileSystemLoader = async () => ({
      promises: {
        open: nativeAdapter.open,
      },
    });

    await extractRuntimeArchive({
      archivePath,
      destination,
      manifest: value,
      maxExtractedBytes: 1024 * 1024,
      archiveFileSystemLoader: loader,
    });

    expect(calls.some((call) => call.startsWith("open:"))).toBe(true);
    expect(calls).toContain("stat");
    expect(calls.some((call) => call.startsWith("read:"))).toBe(true);
  });

  // @lat: [[agentera-runtime-distribution#Offline Seed installation and repair]]
  it("performs one full extracted-inventory pass for a Windows ZIP", async () => {
    const source = await readFile(
      join(
        process.cwd(),
        "src/main/agentera-runtime-distribution/extractor.ts",
      ),
      "utf8",
    );
    const calls = source.match(/await verifyExtractedRuntimeInventory\(/gu);

    expect(calls).toHaveLength(1);
    expect(source).not.toMatch(
      /readdir\(join\(workDirectory,\s*ARCHIVE_ROOT\),\s*\{\s*recursive:\s*true/gu,
    );
  });

  it("does not eagerly load the native ZIP binding in the main process", async () => {
    const source = await readFile(
      join(
        process.cwd(),
        "src/main/agentera-runtime-distribution/extractor.ts",
      ),
      "utf8",
    );

    expect(source).not.toMatch(
      /^\s*import\s*\{[^\n]*extract[^\n]*\}\s*from\s*["']@electron-internal\/extract-zip["']/mu,
    );
    expect(source).toMatch(
      /await\s+import\(\s*["']@electron-internal\/extract-zip["']\s*\)/u,
    );
  });

  it("moves packaged Windows ZIP validation into the isolated Node helper", async () => {
    const source = await readFile(
      join(
        process.cwd(),
        "src/main/agentera-runtime-distribution/extractor.ts",
      ),
      "utf8",
    );

    expect(source).toMatch(/shouldUseIsolatedRuntimeArchiveValidation\(\)/u);
    expect(source).toMatch(/verifyRuntimeArchiveWithHelper\(/u);
  });

  it("extracts TAR/Zstandard, verifies hashes, and preserves executable modes where supported", async () => {
    const root = await workspace();
    const value = manifest();
    const archivePath = await writeTarZstd(root, archiveEntries(value.files));
    const destination = join(root, "payload");

    const result = await extractRuntimeArchive({
      archivePath,
      destination,
      manifest: value,
      maxExtractedBytes: 1024 * 1024,
    });

    expect(result).toEqual({ fileCount: 2, extractedBytes: 44 });
    expect(await readFile(join(destination, "runtime", "hermes"), "utf8")).toBe(
      hermesBody.toString("utf8"),
    );
    if (process.platform !== "win32") {
      expect(
        (await stat(join(destination, "python", "bin", "python3"))).mode &
          0o777,
      ).toBe(0o755);
    }
  });

  it("enforces POSIX modes only when both the Seed and host support them", () => {
    expect(shouldEnforceExtractedRuntimeMode("darwin", "darwin")).toBe(true);
    expect(shouldEnforceExtractedRuntimeMode("darwin", "linux")).toBe(true);
    expect(shouldEnforceExtractedRuntimeMode("darwin", "win32")).toBe(false);
    expect(shouldEnforceExtractedRuntimeMode("windows", "linux")).toBe(false);
    expect(shouldEnforceExtractedRuntimeMode("windows", "win32")).toBe(false);
  });

  it("extracts the Windows ZIP layout into the same logical Runtime root", async () => {
    const root = await workspace();
    const value = manifest("windows");
    const archivePath = await writeZip(root, archiveEntries(value.files));
    const destination = join(root, "payload");

    await extractRuntimeArchive({
      archivePath,
      destination,
      manifest: value,
      maxExtractedBytes: 1024 * 1024,
    });

    expect(
      await readFile(join(destination, "python", "bin", "python3"), "utf8"),
    ).toBe(pythonBody.toString("utf8"));
    await expect(
      lstat(join(destination, "agentera-runtime")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("can extract a verified Windows ZIP sequentially", async () => {
    const root = await workspace();
    const value = manifest("windows");
    const archivePath = await writeZip(root, archiveEntries(value.files));
    const destination = join(root, "payload.zip-extracting");
    await mkdir(destination, { recursive: false, mode: 0o700 });

    await extractRuntimeArchiveSequentially(archivePath, destination);

    expect(
      await readFile(
        join(destination, "agentera-runtime", "runtime", "hermes"),
        "utf8",
      ),
    ).toBe(hermesBody.toString("utf8"));
    expect(
      await stat(
        join(destination, "agentera-runtime", "python", "bin", "python3"),
      ),
    ).toMatchObject({ isFile: expect.any(Function) });
  });

  it("rejects unsafe members before sequential ZIP writes", async () => {
    const root = await workspace();
    const value = manifest("windows");
    const archivePath = await writeZip(
      root,
      archiveEntries(value.files, [
        {
          name: "agentera-runtime/../escape.txt",
          kind: "file",
          body: Buffer.from("escape", "utf8"),
        },
      ]),
    );
    const destination = join(root, "payload.zip-extracting");
    await mkdir(destination, { recursive: false, mode: 0o700 });

    await expect(
      extractRuntimeArchiveSequentially(archivePath, destination),
    ).rejects.toThrow(/invalid|unsafe|outside|escapes/i);
    await expect(stat(join(root, "escape.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects sequential ZIP symlinks that leave the Runtime root", async () => {
    const root = await workspace();
    const value = manifest("windows");
    const archivePath = await writeZip(
      root,
      archiveEntries(value.files, [
        {
          name: "agentera-runtime/runtime/escape-link",
          kind: "symlink",
          linkTarget: "../../outside",
        },
      ]),
    );
    const destination = join(root, "payload.zip-extracting");
    await mkdir(destination, { recursive: false, mode: 0o700 });

    await expect(
      extractRuntimeArchiveSequentially(archivePath, destination),
    ).rejects.toThrow(/symlink|target|escape|root/i);
    await expect(lstat(join(root, "outside"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects a sequential ZIP symlink target containing a NUL byte", async () => {
    const root = await workspace();
    const value = manifest("windows");
    const archivePath = await writeZip(
      root,
      archiveEntries(value.files, [
        {
          name: "agentera-runtime/runtime/nul-link",
          kind: "symlink",
          linkTarget: "hermes\0",
        },
      ]),
    );
    const destination = join(root, "payload.zip-extracting");
    await mkdir(destination, { recursive: false, mode: 0o700 });

    await expect(
      extractRuntimeArchiveSequentially(archivePath, destination),
    ).rejects.toThrow(/symlink|target|invalid/i);
  });

  it("bypasses Electron ASAR interception for Windows extraction and restores it", async () => {
    const root = await workspace();
    const value = manifest("windows");
    const archivePath = await writeZip(root, archiveEntries(value.files));

    const assignments = await recordNoAsarAssignments(async () => {
      await extractRuntimeArchive({
        archivePath,
        destination: join(root, "payload"),
        manifest: value,
        maxExtractedBytes: 1024 * 1024,
      });
    });

    expect(assignments).toEqual([true, false]);
  });

  it("restores Electron ASAR interception after Windows verification fails", async () => {
    const root = await workspace();
    const files = baseFiles().map((entry) =>
      entry.path === "runtime/hermes"
        ? { ...entry, sha256: "0".repeat(64) }
        : entry,
    );
    const value = manifest("windows", files);
    const archivePath = await writeZip(root, archiveEntries(baseFiles()));

    const assignments = await recordNoAsarAssignments(async () => {
      await expect(
        extractRuntimeArchive({
          archivePath,
          destination: join(root, "payload"),
          manifest: value,
          maxExtractedBytes: 1024 * 1024,
        }),
      ).rejects.toThrow(/hash|manifest/i);
    });

    expect(assignments).toEqual([true, false]);
  });

  it("rejects archive path traversal before files can escape staging", async () => {
    const root = await workspace();
    const value = manifest();
    const entries = archiveEntries(value.files);
    entries.push({
      name: "agentera-runtime/../escape",
      kind: "file",
      body: Buffer.from("escape"),
      mode: 0o644,
    });
    const archivePath = await writeTarZstd(root, entries);
    const destination = join(root, "payload");

    await expect(
      extractRuntimeArchive({
        archivePath,
        destination,
        manifest: value,
        maxExtractedBytes: 1024 * 1024,
      }),
    ).rejects.toThrow(/unsafe|escape|normalized|outside/i);
    await expect(lstat(join(root, "escape"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects case-folded duplicate ZIP members for Windows", async () => {
    const root = await workspace();
    const value = manifest("windows");
    const entries = archiveEntries(value.files);
    entries.push({
      name: "agentera-runtime/runtime/HERMES",
      kind: "file",
      body: hermesBody,
      mode: 0o755,
    });
    const archivePath = await writeZip(root, entries);

    await expect(
      extractRuntimeArchive({
        archivePath,
        destination: join(root, "payload"),
        manifest: value,
        maxExtractedBytes: 1024 * 1024,
      }),
    ).rejects.toThrow(/duplicate/i);
  });

  it("rejects ZIP path traversal before files can escape staging", async () => {
    const root = await workspace();
    const value = manifest("windows");
    const entries = archiveEntries(value.files);
    entries.push({
      name: "agentera-runtime/../escape",
      kind: "file",
      body: Buffer.from("escape"),
      mode: 0o644,
    });
    const archivePath = await writeZip(root, entries);
    const destination = join(root, "payload");

    await expect(
      extractRuntimeArchive({
        archivePath,
        destination,
        manifest: value,
        maxExtractedBytes: 1024 * 1024,
      }),
    ).rejects.toBeInstanceOf(RuntimeExtractionError);
    await expect(lstat(join(root, "escape"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a ZIP symlink target that differs from the signed inventory", async () => {
    const root = await workspace();
    const files = baseFiles([symlink("runtime/current", "hermes")]);
    const value = manifest("windows", files);
    const entries = archiveEntries(files);
    const link = entries.find((entry) =>
      entry.name.endsWith("runtime/current"),
    );
    if (!link) throw new Error("missing test symlink");
    link.linkTarget = "../../../escape";

    await expect(
      extractRuntimeArchive({
        archivePath: await writeZip(root, entries),
        destination: join(root, "payload"),
        manifest: value,
        maxExtractedBytes: 1024 * 1024,
      }),
    ).rejects.toThrow(/symlink|target|escape|relative/i);
    await expect(lstat(join(root, "escape"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each(["/tmp/agentera-escape", "../../../agentera-escape"])(
    "rejects unsafe symlink target %s",
    async (linkTarget) => {
      const root = await workspace();
      const files = baseFiles([symlink("runtime/current", "hermes")]);
      const value = manifest("darwin", files);
      const entries = archiveEntries(files);
      const link = entries.find((entry) =>
        entry.name.endsWith("runtime/current"),
      );
      if (!link) throw new Error("missing test symlink");
      link.linkTarget = linkTarget;
      const archivePath = await writeTarZstd(root, entries);

      await expect(
        extractRuntimeArchive({
          archivePath,
          destination: join(root, "payload"),
          manifest: value,
          maxExtractedBytes: 1024 * 1024,
        }),
      ).rejects.toThrow(/symlink|target|escape|relative/i);
    },
  );

  it("enforces the signed decompression budget before extraction", async () => {
    const root = await workspace();
    const value = manifest();
    const archivePath = await writeTarZstd(root, archiveEntries(value.files));
    const destination = join(root, "payload");

    await expect(
      extractRuntimeArchive({
        archivePath,
        destination,
        manifest: value,
        maxExtractedBytes: 43,
      }),
    ).rejects.toThrow(/budget/i);
    await expect(lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cancels without leaving a partial destination", async () => {
    const root = await workspace();
    const value = manifest();
    const archivePath = await writeTarZstd(root, archiveEntries(value.files));
    const controller = new AbortController();
    controller.abort();
    const destination = join(root, "payload");

    await expect(
      extractRuntimeArchive({
        archivePath,
        destination,
        manifest: value,
        maxExtractedBytes: 1024 * 1024,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    await expect(lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never deletes a pre-existing extraction destination", async () => {
    const root = await workspace();
    const value = manifest();
    const archivePath = await writeTarZstd(root, archiveEntries(value.files));
    const destination = join(root, "payload");
    await mkdir(destination);
    const keep = join(destination, "keep.txt");
    await writeFile(keep, "keep", "utf8");

    await expect(
      extractRuntimeArchive({
        archivePath,
        destination,
        manifest: value,
        maxExtractedBytes: 1024 * 1024,
      }),
    ).rejects.toThrow(/must not already exist/i);
    expect(await readFile(keep, "utf8")).toBe("keep");
  });

  it("rejects unexpected and missing archive members", async () => {
    const root = await workspace();
    const value = manifest();
    const unexpected = archiveEntries(value.files);
    unexpected.push({
      name: "agentera-runtime/runtime/extra",
      kind: "file",
      body: Buffer.from("extra"),
      mode: 0o644,
    });
    await expect(
      extractRuntimeArchive({
        archivePath: await writeTarZstd(root, unexpected),
        destination: join(root, "unexpected"),
        manifest: value,
        maxExtractedBytes: 1024 * 1024,
      }),
    ).rejects.toThrow(/unexpected/i);

    const missing = archiveEntries(value.files).filter(
      (entry) => !entry.name.endsWith("runtime/hermes"),
    );
    await expect(
      extractRuntimeArchive({
        archivePath: await writeTarZstd(root, missing),
        destination: join(root, "missing"),
        manifest: value,
        maxExtractedBytes: 1024 * 1024,
      }),
    ).rejects.toThrow(/missing/i);
  });

  it("re-hashes extracted files and rejects content mismatches", async () => {
    const root = await workspace();
    const files = baseFiles().map((entry) =>
      entry.path === "runtime/hermes"
        ? { ...entry, sha256: "0".repeat(64) }
        : entry,
    );
    const value = manifest("darwin", files);
    const archivePath = await writeTarZstd(root, archiveEntries(baseFiles()));
    const destination = join(root, "payload");

    await expect(
      extractRuntimeArchive({
        archivePath,
        destination,
        manifest: value,
        maxExtractedBytes: 1024 * 1024,
      }),
    ).rejects.toBeInstanceOf(RuntimeExtractionError);
    await expect(lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("re-verifies an installed candidate while allowing only signed metadata sidecars", async () => {
    const root = await workspace();
    const value = manifest();
    const archivePath = await writeTarZstd(root, archiveEntries(value.files));
    const destination = join(root, "payload");
    await extractRuntimeArchive({
      archivePath,
      destination,
      manifest: value,
      maxExtractedBytes: 1024 * 1024,
    });
    await writeFile(
      join(destination, ".agentera-runtime-manifest.json"),
      "signed manifest",
    );
    await writeFile(
      join(destination, ".agentera-runtime-manifest.sig"),
      "signed envelope",
    );

    await expect(
      verifyExtractedRuntimeInventory(destination, value, 1024 * 1024),
    ).resolves.toEqual({ fileCount: 2, extractedBytes: 44 });

    await writeFile(join(destination, "runtime", "hermes"), "tampered");
    await expect(
      verifyExtractedRuntimeInventory(destination, value, 1024 * 1024),
    ).rejects.toThrow(/size|hash|manifest/i);
  });
});
