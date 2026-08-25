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

it("uses native Node fs inside the packaged inventory helper", async () => {
  const { resolveRuntimeInventoryFileSystem } =
    await import("../src/main/agentera-runtime-distribution/inventory");
  const loadOriginalFs = vi.fn(async () => {
    throw new Error("helper must not load Electron original-fs");
  });
  vi.stubEnv("AGENTERA_RUNTIME_INVENTORY_HELPER", "1");
  try {
    const fileSystem = await resolveRuntimeInventoryFileSystem(
      "41.10.5",
      loadOriginalFs,
    );
    expect(loadOriginalFs).not.toHaveBeenCalled();
    expect(fileSystem.open).toBeTypeOf("function");
    expect(fileSystem.readFile).toBeTypeOf("function");
  } finally {
    vi.unstubAllEnvs();
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

it("uses a higher bounded hash pool for a Windows Runtime inventory", async () => {
  const { verifyExtractedRuntimeInventoryInProcess } =
    await import("../src/main/agentera-runtime-distribution/inventory");
  const root = await mkdtemp(join(tmpdir(), "aera-runtime-windows-hash-pool-"));
  const contents = Buffer.from("verified Runtime entry");
  const entries = Array.from({ length: 64 }, (_, index) => ({
    path: `runtime-${index}.bin`,
    kind: "file" as const,
    size: contents.length,
    sha256: createHash("sha256").update(contents).digest("hex"),
    mode: 0o644,
    link_target: null,
  }));
  await Promise.all(
    entries.map((entry) => writeFile(join(root, entry.path), contents)),
  );
  let active = 0;
  let maximum = 0;
  const readFilePath = vi.fn(async (path: string) => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    try {
      return await readFile(path);
    } finally {
      active -= 1;
    }
  });

  try {
    await expect(
      verifyExtractedRuntimeInventoryInProcess(
        root,
        { platform: "windows", files: entries } as RuntimeManifest,
        contents.length * entries.length,
        undefined,
        "win32",
        {
          chmod,
          lstat,
          open,
          readFile: readFilePath as typeof readFile,
          readlink,
          readdir,
          realpath,
        } satisfies RuntimeInventoryFileSystem,
      ),
    ).resolves.toEqual({
      fileCount: entries.length,
      extractedBytes: contents.length * entries.length,
    });
    expect(maximum).toBe(32);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("does not repeat lstat for Windows Runtime entries", async () => {
  const { verifyExtractedRuntimeInventoryInProcess } =
    await import("../src/main/agentera-runtime-distribution/inventory");
  const root = await mkdtemp(join(tmpdir(), "aera-runtime-dirent-walk-"));
  const contents = Buffer.from("verified Runtime bytes");
  await mkdir(join(root, "runtime"), { recursive: true });
  await writeFile(join(root, "runtime", "hermes.exe"), contents);
  const statPath = vi.fn(lstat);
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

  try {
    await expect(
      verifyExtractedRuntimeInventoryInProcess(
        root,
        manifest,
        contents.length,
        undefined,
        "win32",
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

it("checks a Windows Runtime file size during its content read", async () => {
  const { verifyExtractedRuntimeInventoryInProcess } =
    await import("../src/main/agentera-runtime-distribution/inventory");
  const root = await mkdtemp(join(tmpdir(), "aera-runtime-size-check-"));
  const contents = Buffer.from("unexpectedly long Runtime bytes");
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
