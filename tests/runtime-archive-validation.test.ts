import { Readable } from "node:stream";

import { expect, it } from "vitest";

import {
  validateRuntimeZipArchive,
  type RuntimeArchiveFileSystem,
} from "../src/main/agentera-runtime-distribution/archive-validation";
import type { RuntimeManifest } from "../src/main/agentera-runtime-distribution/manifest";

interface ZipTestEntry {
  name: string;
  kind: "file" | "directory";
  mode: number;
}

function zipBuffer(entries: readonly ZipTestEntry[]): Buffer {
  const localChunks: Buffer[] = [];
  const centralChunks: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const nameText =
      entry.kind === "directory" && !entry.name.endsWith("/")
        ? `${entry.name}/`
        : entry.name;
    const name = Buffer.from(nameText, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(0, 18);
    local.writeUInt32LE(0, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localChunks.push(local, name);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(0, 20);
    central.writeUInt32LE(0, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    const typeBits = entry.kind === "directory" ? 0o040000 : 0o100000;
    central.writeUInt32LE(((typeBits | entry.mode) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralChunks.push(central, name);
    offset += local.length + name.length;
  }
  const centralDirectory = Buffer.concat(centralChunks);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localChunks, centralDirectory, end]);
}

function manifestForEntries(
  entries: readonly ZipTestEntry[],
  archiveSize: number,
): RuntimeManifest {
  return {
    schema_version: 1,
    key_id: "test-key",
    runtime_version: "0.18.2-agentera.1",
    source_repository: "Ablankpaper/aera-runtime",
    source_commit: "f".repeat(40),
    channel: "candidate",
    platform: "windows",
    arch: "x64",
    archive_name: "agentera-runtime-test-windows-x64.zip",
    archive_size: archiveSize,
    archive_sha256: "0".repeat(64),
    python_version: "3.11.15",
    entrypoints: {
      python: "file-0000",
      hermes: "file-0001",
      module: "hermes_cli.main",
    },
    minimum_desktop_version: "0.7.3",
    compatibility_gate_revision: 1,
    created_at: "2026-07-18T04:05:06Z",
    files: entries.map((entry) => ({
      path: entry.name.slice("agentera-runtime/".length),
      kind: "file",
      size: 0,
      sha256: "0".repeat(64),
      mode: entry.mode,
      link_target: null,
    })),
  };
}

function inMemoryArchiveFileSystem(
  archive: Buffer,
  onRead: (length: number, position: number) => void,
  reportedSize = archive.length,
  maxReadBytes = Number.POSITIVE_INFINITY,
): RuntimeArchiveFileSystem {
  return {
    open: async () => ({
      stat: async () => ({
        isFile: () => true,
        size: reportedSize,
      }),
      read: async (buffer, offset, length, position) => {
        onRead(length, position);
        const available = Math.max(
          0,
          Math.min(maxReadBytes, length, archive.length - position),
        );
        if (available > 0) {
          archive.copy(buffer, offset, position, position + available);
        }
        return { bytesRead: available, buffer };
      },
      createReadStream: () => Readable.from([]),
      close: async () => undefined,
    }),
  };
}

function largeArchiveFixture(count: number): {
  archive: Buffer;
  manifest: RuntimeManifest;
} {
  const entries = [
    { name: "agentera-runtime", kind: "directory" as const, mode: 0o755 },
    ...Array.from({ length: count }, (_, index) => ({
      name: `agentera-runtime/file-${String(index).padStart(4, "0")}`,
      kind: "file" as const,
      mode: 0o644,
    })),
  ];
  const archive = zipBuffer(entries);
  return {
    archive,
    manifest: manifestForEntries(entries.slice(1), archive.length),
  };
}

it("validates a large ZIP with one bounded bulk archive read", async () => {
  const { archive, manifest } = largeArchiveFixture(1024);
  const reads: Array<{ length: number; position: number }> = [];

  await validateRuntimeZipArchive(
    "C:\\runtime\\seed.zip",
    manifest,
    0,
    undefined,
    inMemoryArchiveFileSystem(archive, (length, position) =>
      reads.push({ length, position }),
    ),
  );

  expect(reads.length).toBeLessThanOrEqual(2);
  expect(reads.some(({ length }) => length === archive.length)).toBe(true);
});

it("fills the bounded archive buffer when a file handle returns partial reads", async () => {
  const { archive, manifest } = largeArchiveFixture(2);
  const reads: Array<{ length: number; position: number }> = [];

  await validateRuntimeZipArchive(
    "C:\\runtime\\seed.zip",
    manifest,
    0,
    undefined,
    inMemoryArchiveFileSystem(
      archive,
      (length, position) => {
        reads.push({ length, position });
      },
      archive.length,
      7,
    ),
  );

  expect(reads.length).toBeGreaterThan(1);
  expect(reads.every(({ length }) => length <= archive.length)).toBe(true);
});

it("fails closed when the archive length differs from signed archive_size", async () => {
  const { archive, manifest } = largeArchiveFixture(2);
  const reads: number[] = [];

  await expect(
    validateRuntimeZipArchive(
      "C:\\runtime\\seed.zip",
      { ...manifest, archive_size: archive.length + 1 },
      0,
      undefined,
      inMemoryArchiveFileSystem(archive, (length) => reads.push(length)),
    ),
  ).rejects.toThrow(/archive.*size|size.*manifest/i);
  expect(reads).toHaveLength(0);
});

it("emits bounded validation timing and count evidence", async () => {
  const { archive, manifest } = largeArchiveFixture(4);
  const diagnostics: unknown[] = [];

  await validateRuntimeZipArchive(
    "C:\\runtime\\seed.zip",
    manifest,
    0,
    undefined,
    inMemoryArchiveFileSystem(archive, () => undefined),
    (diagnostic) => diagnostics.push(diagnostic),
  );

  expect(diagnostics).toHaveLength(2);
  expect(diagnostics[0]).toMatchObject({
    event: "zip-validation-start",
    archiveBytes: archive.length,
  });
  expect(diagnostics[1]).toMatchObject({
    event: "zip-validation-complete",
    durationMs: expect.any(Number),
    archiveBytes: archive.length,
    entryCount: 5,
    extractedBytes: 0,
  });
});
