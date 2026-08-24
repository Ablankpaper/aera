import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readlink,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import type { RuntimeInventoryFileSystem } from "../src/main/agentera-runtime-distribution/inventory";
import type { RuntimeManifest } from "../src/main/agentera-runtime-distribution/manifest";

it("uses Electron original-fs for final Runtime inventory verification", async () => {
  const { resolveRuntimeInventoryFileSystem } =
    await import("../src/main/agentera-runtime-distribution/inventory");
  const originalFs = {
    promises: {
      chmod: vi.fn(),
      lstat: vi.fn(),
      open: vi.fn(),
      readFile: vi.fn(),
      readlink: vi.fn(),
      readdir: vi.fn(),
      realpath: vi.fn(),
    },
  };
  const loadOriginalFs = vi.fn(async () => originalFs);

  const fileSystem = await resolveRuntimeInventoryFileSystem(
    "41.10.5",
    loadOriginalFs,
  );

  expect(loadOriginalFs).toHaveBeenCalledOnce();
  expect(fileSystem.chmod).toBeTypeOf("function");
  expect(fileSystem.lstat).toBeTypeOf("function");
  expect(fileSystem.open).toBeTypeOf("function");
  expect(fileSystem.readFile).toBeTypeOf("function");
  expect(fileSystem.readlink).toBeTypeOf("function");
  expect(fileSystem.readdir).toBeTypeOf("function");
  expect(fileSystem.realpath).toBeTypeOf("function");
  await fileSystem.chmod("runtime.exe", 0o755);
  expect(originalFs.promises.chmod).toHaveBeenCalledWith("runtime.exe", 0o755);
});

it("allows the isolated Electron Node helper to use ordinary Node fs", async () => {
  const { resolveRuntimeInventoryFileSystem } =
    await import("../src/main/agentera-runtime-distribution/inventory");
  const previousHelper = process.env.AGENTERA_RUNTIME_INVENTORY_HELPER;
  const previousNodeFs = process.env.AGENTERA_RUNTIME_INVENTORY_USE_NODE_FS;
  process.env.AGENTERA_RUNTIME_INVENTORY_HELPER = "1";
  process.env.AGENTERA_RUNTIME_INVENTORY_USE_NODE_FS = "1";
  const loadOriginalFs = vi.fn(async () => {
    throw new Error("original-fs must not be loaded in the helper probe");
  });
  try {
    const fileSystem = await resolveRuntimeInventoryFileSystem(
      "41.10.5",
      loadOriginalFs,
    );
    expect(fileSystem.readFile).toBeTypeOf("function");
    expect(loadOriginalFs).not.toHaveBeenCalled();
  } finally {
    if (previousHelper === undefined)
      delete process.env.AGENTERA_RUNTIME_INVENTORY_HELPER;
    else process.env.AGENTERA_RUNTIME_INVENTORY_HELPER = previousHelper;
    if (previousNodeFs === undefined)
      delete process.env.AGENTERA_RUNTIME_INVENTORY_USE_NODE_FS;
    else process.env.AGENTERA_RUNTIME_INVENTORY_USE_NODE_FS = previousNodeFs;
  }
});

it("hashes the final Runtime inventory through file handles instead of streams", async () => {
  const { verifyExtractedRuntimeInventoryInProcess } =
    await import("../src/main/agentera-runtime-distribution/inventory");
  const root = await mkdtemp(join(tmpdir(), "aera-runtime-handle-hash-"));
  const contents = Buffer.alloc(262_145, 0x61);
  const physicalPath = join(root, "runtime.bin");
  await writeFile(physicalPath, contents);
  const manifest = {
    platform: "windows",
    files: [
      {
        path: "runtime.bin",
        kind: "file",
        size: contents.length,
        sha256: createHash("sha256").update(contents).digest("hex"),
        mode: 0o644,
        link_target: null,
      },
    ],
  } as RuntimeManifest;
  const openFile = vi.fn(open);
  const resolvedPhysicalPath = join(await realpath(root), "runtime.bin");

  try {
    await expect(
      verifyExtractedRuntimeInventoryInProcess(
        root,
        manifest,
        contents.length,
        undefined,
        "win32",
        undefined,
        {
          chmod,
          lstat,
          open: openFile,
          readFile,
          readlink,
          readdir,
          realpath,
        } satisfies RuntimeInventoryFileSystem,
      ),
    ).resolves.toEqual({ fileCount: 1, extractedBytes: contents.length });
    expect(openFile).toHaveBeenCalledWith(resolvedPhysicalPath, "r");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("bounds and overlaps final Runtime inventory hashes", async () => {
  const { verifyRuntimeFileHashes } =
    await import("../src/main/agentera-runtime-distribution/extractor");
  const checks = Array.from({ length: 16 }, (_, index) => ({
    physicalPath: `/runtime/file-${index}.bin`,
    relativePath: `file-${index}.bin`,
    expectedSha256: "a".repeat(64),
    size: 1,
  }));
  let active = 0;
  let maximum = 0;

  await expect(
    verifyRuntimeFileHashes(checks, undefined, async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return "a".repeat(64);
    }),
  ).resolves.toBeUndefined();
  expect(maximum).toBe(8);
});

it("uses the bounded readFile path for small Runtime entries", async () => {
  const { verifyExtractedRuntimeInventoryInProcess } =
    await import("../src/main/agentera-runtime-distribution/inventory");
  const root = await mkdtemp(join(tmpdir(), "aera-runtime-small-hash-"));
  const contents = Buffer.from("small verified runtime bytes");
  const physicalPath = join(root, "small.bin");
  await writeFile(physicalPath, contents);
  const manifest = {
    platform: "windows",
    files: [
      {
        path: "small.bin",
        kind: "file",
        size: contents.length,
        sha256: createHash("sha256").update(contents).digest("hex"),
        mode: 0o644,
        link_target: null,
      },
    ],
  } as RuntimeManifest;
  const readFilePath = vi.fn(readFile);
  const openFile = vi.fn(open);
  const resolvedPhysicalPath = join(await realpath(root), "small.bin");

  try {
    await expect(
      verifyExtractedRuntimeInventoryInProcess(
        root,
        manifest,
        contents.length,
        undefined,
        "win32",
        undefined,
        {
          chmod,
          lstat,
          open: openFile,
          readFile: readFilePath,
          readlink,
          readdir,
          realpath,
        } satisfies RuntimeInventoryFileSystem,
      ),
    ).resolves.toEqual({ fileCount: 1, extractedBytes: contents.length });
    expect(readFilePath).toHaveBeenCalledWith(resolvedPhysicalPath);
    expect(openFile).not.toHaveBeenCalled();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("does not repeat lstat for Windows regular Runtime entries", async () => {
  const { verifyExtractedRuntimeInventoryInProcess } =
    await import("../src/main/agentera-runtime-distribution/inventory");
  const root = await mkdtemp(join(tmpdir(), "aera-runtime-dirent-walk-"));
  const contents = Buffer.from("verified runtime bytes");
  await mkdir(join(root, "runtime"), { recursive: true });
  await writeFile(join(root, "runtime", "hermes.exe"), contents);
  const manifest = {
    platform: "windows",
    files: [
      {
        path: "runtime",
        kind: "directory",
        size: 0,
        sha256: null,
        mode: 0o755,
        link_target: null,
      },
      {
        path: "runtime/hermes.exe",
        kind: "file",
        size: contents.length,
        sha256: createHash("sha256").update(contents).digest("hex"),
        mode: 0o755,
        link_target: null,
      },
    ],
  } as RuntimeManifest;
  const statPath = vi.fn(lstat);

  try {
    await expect(
      verifyExtractedRuntimeInventoryInProcess(
        root,
        manifest,
        contents.length,
        undefined,
        "win32",
        undefined,
        {
          chmod,
          lstat: statPath,
          open,
          readFile,
          readlink,
          readdir,
          realpath,
        } satisfies RuntimeInventoryFileSystem,
      ),
    ).resolves.toEqual({ fileCount: 1, extractedBytes: contents.length });
    expect(statPath).not.toHaveBeenCalled();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("rejects a wrong-sized small Windows entry without a separate lstat", async () => {
  const { verifyExtractedRuntimeInventoryInProcess } =
    await import("../src/main/agentera-runtime-distribution/inventory");
  const root = await mkdtemp(join(tmpdir(), "aera-runtime-small-size-"));
  const contents = Buffer.from("unexpectedly long runtime bytes");
  await writeFile(join(root, "runtime.bin"), contents);
  const manifest = {
    platform: "windows",
    files: [
      {
        path: "runtime.bin",
        kind: "file",
        size: contents.length - 1,
        sha256: createHash("sha256").update(contents).digest("hex"),
        mode: 0o644,
        link_target: null,
      },
    ],
  } as RuntimeManifest;

  try {
    await expect(
      verifyExtractedRuntimeInventoryInProcess(
        root,
        manifest,
        contents.length,
        undefined,
        "win32",
        undefined,
        {
          chmod,
          lstat: vi.fn(async () => {
            throw new Error("Windows inventory must not lstat this file");
          }) as typeof lstat,
          open,
          readFile,
          readlink,
          readdir,
          realpath,
        } satisfies RuntimeInventoryFileSystem,
      ),
    ).rejects.toThrow(/size differs from the manifest/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
