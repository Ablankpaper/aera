import { expect, it, vi } from "vitest";

it("uses Electron original-fs for final Runtime inventory verification", async () => {
  const { resolveRuntimeInventoryFileSystem } =
    await import("../src/main/agentera-runtime-distribution/inventory");
  const originalFs = {
    createReadStream: vi.fn(),
    promises: {
      chmod: vi.fn(),
      lstat: vi.fn(),
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
  expect(fileSystem.createReadStream).toBeTypeOf("function");
  expect(fileSystem.chmod).toBeTypeOf("function");
  expect(fileSystem.lstat).toBeTypeOf("function");
  expect(fileSystem.readlink).toBeTypeOf("function");
  expect(fileSystem.readdir).toBeTypeOf("function");
  expect(fileSystem.realpath).toBeTypeOf("function");
  await fileSystem.chmod("runtime.exe", 0o755);
  expect(originalFs.promises.chmod).toHaveBeenCalledWith("runtime.exe", 0o755);
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
