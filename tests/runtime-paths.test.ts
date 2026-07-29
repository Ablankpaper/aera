import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  createRuntimeDistributionPaths,
  ensureRuntimeDistributionDirectories,
  resolveRuntimeVersionDirectory,
  type RuntimeDistributionPaths,
  verifyRuntimeVersionDirectory,
} from "../src/main/agentera-runtime-distribution/paths";

const temporaryDirectories: string[] = [];

function makePaths(): { directory: string; paths: RuntimeDistributionPaths } {
  const directory = mkdtempSync(join(tmpdir(), "agentera-runtime-paths-"));
  temporaryDirectories.push(directory);
  const userData = join(directory, "user-data");
  const packagedSeed = join(directory, "app-resources", "runtime-seed");
  return {
    directory,
    paths: createRuntimeDistributionPaths(userData, packagedSeed),
  };
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe("Aera Runtime distribution paths", () => {
  it("derives every mutable path below the dedicated Runtime root", () => {
    const { directory, paths } = makePaths();
    const root = join(directory, "user-data", "runtime");
    expect(paths).toEqual({
      root,
      versions: join(root, "versions"),
      staging: join(root, "staging"),
      downloads: join(root, "downloads"),
      failures: join(root, "failures"),
      current: join(root, "current.json"),
      previous: join(root, "previous.json"),
      candidate: join(root, "candidate.json"),
      packagedSeed: join(directory, "app-resources", "runtime-seed"),
    });
  });

  it.each(["../MEMORY.md", "nested/version", "..", ".", "version\\evil"])(
    "rejects an unsafe version directory %s",
    (versionDirectory) => {
      const { paths } = makePaths();
      expect(() =>
        resolveRuntimeVersionDirectory(paths, versionDirectory),
      ).toThrow(/version directory|relative|contained/i);
    },
  );

  it("rejects an absolute version directory", () => {
    const { paths } = makePaths();
    expect(() =>
      resolveRuntimeVersionDirectory(paths, resolve("/tmp/runtime-escape")),
    ).toThrow(/version directory|relative|contained/i);
  });

  it("rejects a version-directory symlink that escapes the Runtime root", async () => {
    const { directory, paths } = makePaths();
    await ensureRuntimeDistributionDirectories(paths);
    const outside = join(directory, "outside-runtime");
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(paths.versions, "escaped-version"), "dir");

    await expect(
      verifyRuntimeVersionDirectory(paths, "escaped-version"),
    ).rejects.toThrow(/symlink|contained|escape/i);
  });

  it("accepts a real direct child of the versions directory", async () => {
    const { paths } = makePaths();
    await ensureRuntimeDistributionDirectories(paths);
    const expected = join(paths.versions, "0.18.2-agentera.1-e46cd0f");
    mkdirSync(expected);

    await expect(
      verifyRuntimeVersionDirectory(paths, "0.18.2-agentera.1-e46cd0f"),
    ).resolves.toBe(expected);
  });
});
