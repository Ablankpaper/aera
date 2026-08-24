import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdtemp,
  open,
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
  expect(fileSystem.readlink).toBeTypeOf("function");
  expect(fileSystem.readdir).toBeTypeOf("function");
  expect(fileSystem.realpath).toBeTypeOf("function");
  await fileSystem.chmod("runtime.exe", 0o755);
  expect(originalFs.promises.chmod).toHaveBeenCalledWith("runtime.exe", 0o755);
});

it("hashes the final Runtime inventory through file handles instead of streams", async () => {
  const { verifyExtractedRuntimeInventoryInProcess } =
    await import("../src/main/agentera-runtime-distribution/inventory");
  const root = await mkdtemp(join(tmpdir(), "aera-runtime-handle-hash-"));
  const contents = Buffer.from("verified runtime bytes");
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
