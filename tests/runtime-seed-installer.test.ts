import { readFileSync } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ExtractRuntimeArchiveOptions } from "../src/main/agentera-runtime-distribution/extractor";
import {
  runIsolatedRuntimeHealthCheck,
  type RuntimeHealthCheckOptions,
} from "../src/main/agentera-runtime-distribution/health";
import {
  RUNTIME_MANIFEST_METADATA_NAME,
  RUNTIME_SIGNATURE_METADATA_NAME,
  type RuntimeManifestValidationContext,
} from "../src/main/agentera-runtime-distribution/manifest";
import { createRuntimeDistributionPaths } from "../src/main/agentera-runtime-distribution/paths";
import {
  calculatePackagedSeedDiskBudget,
  installPackagedSeed,
  verifyPackagedRuntimeSeed,
  type PackagedSeedInstallerOptions,
} from "../src/main/agentera-runtime-distribution/seed-installer";
import {
  TEST_PUBLIC_KEY,
  TEST_RUNTIME_VERSION,
  writeFixtureBundle,
} from "./fixtures/runtime-distribution/fixture";

const childProcessSpies = vi.hoisted(() => ({
  execFile: vi.fn(() => {
    throw new Error("unexpected child process");
  }),
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile: childProcessSpies.execFile,
}));

const temporaryDirectories: string[] = [];
const fixtureCleanups: Array<() => void> = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  fixtureCleanups.splice(0).forEach((cleanup) => cleanup());
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

const manifestContext: RuntimeManifestValidationContext = {
  repository: "bignormal/aera-runtime",
  platform: "darwin",
  arch: "arm64",
  desktopVersion: "0.7.3",
  allowedChannels: new Set(["candidate", "stable"]),
};

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(
    join(tmpdir(), "agentera-seed-installer-test-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

async function createRuntimeLayout(destination: string): Promise<void> {
  for (const directory of [
    "python/bin",
    "python/lib/python3.11/site-packages/hermes_cli/web_dist",
    "python/skills",
    "runtime",
  ]) {
    await mkdir(join(destination, ...directory.split("/")), {
      recursive: true,
    });
  }
  await writeFile(join(destination, "python", "bin", "python3"), "python");
  await writeFile(join(destination, "runtime", "hermes"), "hermes");
}

async function harness(
  overrides: Partial<PackagedSeedInstallerOptions> = {},
): Promise<{
  root: string;
  bundle: ReturnType<typeof writeFixtureBundle>;
  paths: ReturnType<typeof createRuntimeDistributionPaths>;
  extractor: ReturnType<typeof vi.fn>;
  healthCheck: ReturnType<typeof vi.fn>;
  selectManagedRuntime: ReturnType<typeof vi.fn>;
  refreshRuntimeInvocation: ReturnType<typeof vi.fn>;
  options: PackagedSeedInstallerOptions;
}> {
  const root = await temporaryDirectory();
  const bundle = writeFixtureBundle();
  fixtureCleanups.push(bundle.cleanup);
  await unlink(bundle.trustPath);
  const paths = createRuntimeDistributionPaths(
    join(root, "user-data"),
    bundle.directory,
  );
  const extractor = vi.fn(
    async ({ destination }: ExtractRuntimeArchiveOptions) => {
      await createRuntimeLayout(destination);
      return { fileCount: 2, extractedBytes: 30 };
    },
  );
  const healthCheck = vi.fn(async (_options: RuntimeHealthCheckOptions) => ({
    probes: 3,
    versionOutput: TEST_RUNTIME_VERSION,
  }));
  const selectManagedRuntime = vi.fn();
  const refreshRuntimeInvocation = vi.fn(() => ({ source: "managed" }));
  const options: PackagedSeedInstallerOptions = {
    paths,
    trustedPublicKeys: new Map([["agentera-runtime-test-01", TEST_PUBLIC_KEY]]),
    manifestContext,
    availableDiskBytes: async () => Number.MAX_SAFE_INTEGER,
    extractor,
    healthCheck,
    selectManagedRuntime,
    refreshRuntimeInvocation,
    now: () => new Date("2026-07-18T12:00:00.000Z"),
    randomId: () => "11111111-2222-4333-8444-555555555555",
    ...overrides,
  };
  return {
    root,
    bundle,
    paths,
    extractor,
    healthCheck,
    selectManagedRuntime,
    refreshRuntimeInvocation,
    options,
  };
}

describe("packaged Runtime Seed discovery and installation", () => {
  it("discovers and independently verifies the one signed packaged Seed", async () => {
    const setup = await harness();

    const seed = await verifyPackagedRuntimeSeed({
      packagedSeedDirectory: setup.paths.packagedSeed,
      trustedPublicKeys: setup.options.trustedPublicKeys,
      manifestContext,
    });

    expect(seed.manifest.runtime_version).toBe(TEST_RUNTIME_VERSION);
    expect(seed.archivePath).toBe(setup.bundle.archivePath);
    expect(seed.manifestPath).toBe(setup.bundle.manifestPath);
    expect(seed.signaturePath).toBe(setup.bundle.signaturePath);
  });

  it("calculates archive + extraction + rollback reserve + 10%", async () => {
    const setup = await harness();
    const seed = await verifyPackagedRuntimeSeed({
      packagedSeedDirectory: setup.paths.packagedSeed,
      trustedPublicKeys: setup.options.trustedPublicKeys,
      manifestContext,
    });
    const extracted = seed.manifest.files.reduce(
      (total, entry) => total + (entry.kind === "file" ? entry.size : 0),
      0,
    );
    const subtotal = seed.manifest.archive_size + extracted + extracted;

    expect(calculatePackagedSeedDiskBudget(seed.manifest)).toBe(
      subtotal + Math.ceil(subtotal / 10),
    );
  });

  it("fails closed on an invalid signature without extracting or launching anything", async () => {
    const setup = await harness();
    await writeFile(setup.bundle.signaturePath, "{}", "utf8");
    const fetchSpy = vi.fn(() => {
      throw new Error("unexpected HTTP");
    });
    vi.stubGlobal("fetch", fetchSpy);

    const result = await installPackagedSeed(setup.options);

    expect(result).toMatchObject({
      status: "repair-required",
      action: "reinstall-desktop",
      errorCode: "packaged-seed-invalid",
    });
    expect(setup.extractor).not.toHaveBeenCalled();
    expect(setup.healthCheck).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(childProcessSpies.execFile).not.toHaveBeenCalled();
  });

  it("checks the complete disk budget before creating an extractable version", async () => {
    const baseline = await harness();
    const seed = await verifyPackagedRuntimeSeed({
      packagedSeedDirectory: baseline.paths.packagedSeed,
      trustedPublicKeys: baseline.options.trustedPublicKeys,
      manifestContext,
    });
    const required = calculatePackagedSeedDiskBudget(seed.manifest);
    const setup = await harness({
      availableDiskBytes: async () => required - 1,
    });

    const result = await installPackagedSeed(setup.options);

    expect(result).toMatchObject({
      status: "repair-required",
      action: "free-disk-space",
      errorCode: "insufficient-disk-space",
      requiredDiskBytes: required,
    });
    expect(setup.extractor).not.toHaveBeenCalled();
    await expect(readdir(setup.paths.staging)).resolves.toEqual([]);
  });

  it("health-checks staging before atomically publishing the current pointer", async () => {
    const setup = await harness();
    setup.healthCheck.mockImplementationOnce(
      async ({ runtimeRoot }: RuntimeHealthCheckOptions) => {
        await expect(lstat(setup.paths.current)).rejects.toMatchObject({
          code: "ENOENT",
        });
        expect(runtimeRoot.startsWith(setup.paths.staging)).toBe(true);
        return { probes: 3, versionOutput: TEST_RUNTIME_VERSION };
      },
    );

    const result = await installPackagedSeed(setup.options);

    expect(result.status).toBe("installed");
    const pointer = JSON.parse(await readFile(setup.paths.current, "utf8")) as {
      versionDirectory: string;
    };
    await expect(
      lstat(join(setup.paths.versions, pointer.versionDirectory)),
    ).resolves.toBeDefined();
    await expect(
      readFile(
        join(
          setup.paths.versions,
          pointer.versionDirectory,
          RUNTIME_MANIFEST_METADATA_NAME,
        ),
      ),
    ).resolves.toEqual(await readFile(setup.bundle.manifestPath));
    await expect(
      readFile(
        join(
          setup.paths.versions,
          pointer.versionDirectory,
          RUNTIME_SIGNATURE_METADATA_NAME,
        ),
      ),
    ).resolves.toEqual(await readFile(setup.bundle.signaturePath));
    await expect(readdir(setup.paths.staging)).resolves.toEqual([]);
  });

  it("cleans only the failed transaction when isolated health fails", async () => {
    const setup = await harness({
      healthCheck: vi.fn(async () => {
        throw new Error("health failed");
      }),
    });
    const keep = join(setup.paths.staging, "keep-unrelated");
    await mkdir(keep, { recursive: true });

    const result = await installPackagedSeed(setup.options);

    expect(result).toMatchObject({
      status: "repair-required",
      errorCode: "runtime-health-failed",
      action: "retry",
    });
    await expect(lstat(keep)).resolves.toBeDefined();
    await expect(readdir(setup.paths.versions)).resolves.toEqual([]);
    expect(await readdir(setup.paths.staging)).toEqual(["keep-unrelated"]);
  });

  it("does not delete a colliding staging transaction it did not create", async () => {
    const setup = await harness();
    const collision = join(setup.paths.staging, "seed-111111112222");
    await mkdir(collision, { recursive: true });
    const keep = join(collision, "keep.txt");
    await writeFile(keep, "owned by another transaction", "utf8");

    const result = await installPackagedSeed(setup.options);

    expect(result).toMatchObject({
      status: "repair-required",
      errorCode: "runtime-install-failed",
    });
    expect(await readFile(keep, "utf8")).toBe("owned by another transaction");
    expect(setup.extractor).not.toHaveBeenCalled();
  });

  it("selects and refreshes the live managed invocation only after promotion", async () => {
    const setup = await harness();
    const order: string[] = [];
    setup.selectManagedRuntime.mockImplementation(() => order.push("select"));
    setup.refreshRuntimeInvocation.mockImplementation(() => {
      expect(readFileSync(setup.paths.current, "utf8")).toContain(
        TEST_RUNTIME_VERSION,
      );
      order.push("refresh");
      return { source: "managed" };
    });

    const result = await installPackagedSeed(setup.options);

    expect(result.status).toBe("installed");
    expect(order).toEqual(["select", "refresh"]);
  });

  it("repairs a corrupt current Runtime into a new version directory without touching HERMES_HOME", async () => {
    let randomIndex = 0;
    const setup = await harness({
      randomId: () =>
        randomIndex++ === 0
          ? "11111111-2222-4333-8444-555555555555"
          : "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    });
    const hermesHome = join(setup.root, "hermes-home");
    await mkdir(hermesHome, { recursive: true });
    const memory = join(hermesHome, "MEMORY.md");
    await writeFile(memory, "private adaptive state\n", "utf8");

    const first = await installPackagedSeed(setup.options);
    expect(first.status).toBe("installed");
    const firstPointer = JSON.parse(
      await readFile(setup.paths.current, "utf8"),
    ) as {
      versionDirectory: string;
    };
    await unlink(
      join(
        setup.paths.versions,
        firstPointer.versionDirectory,
        "runtime",
        "hermes",
      ),
    );

    const second = await installPackagedSeed(setup.options);
    expect(second.status).toBe("installed");
    const secondPointer = JSON.parse(
      await readFile(setup.paths.current, "utf8"),
    ) as {
      versionDirectory: string;
    };
    expect(secondPointer.versionDirectory).not.toBe(
      firstPointer.versionDirectory,
    );
    expect(await readFile(memory, "utf8")).toBe("private adaptive state\n");
  });

  it("uses a disposable health boundary and does not inherit private process credentials", async () => {
    const root = await temporaryDirectory();
    const runtimeRoot = join(root, "transaction", "payload");
    await createRuntimeLayout(runtimeRoot);
    const setup = await harness();
    const seed = await verifyPackagedRuntimeSeed({
      packagedSeedDirectory: setup.paths.packagedSeed,
      trustedPublicKeys: setup.options.trustedPublicKeys,
      manifestContext,
    });
    process.env.AGENTERA_PRIVATE_TEST_TOKEN = "must-not-cross-health-boundary";
    const calls: RuntimeHealthCheckOptions[] = [];

    try {
      await runIsolatedRuntimeHealthCheck({
        runtimeRoot,
        manifest: seed.manifest,
        runner: async (_executable, args, options) => {
          calls.push({
            runtimeRoot,
            manifest: seed.manifest,
            signal: options.signal,
          });
          expect(options.env.HERMES_HOME).toContain(
            ".agentera-runtime-health-",
          );
          expect(options.env.HERMES_HOME).not.toBe(process.env.HERMES_HOME);
          expect(options.env.AGENTERA_PRIVATE_TEST_TOKEN).toBeUndefined();
          expect(args.slice(0, 2)).toEqual(["-I", "-c"]);
          expect(args[2]).toContain("socket.socket.connect=blocked");
          return { stdout: TEST_RUNTIME_VERSION, stderr: "" };
        },
      });
    } finally {
      delete process.env.AGENTERA_PRIVATE_TEST_TOKEN;
    }
    expect(calls).toHaveLength(3);
  });

  it("performs no HTTP, Git, or legacy shell installer call on success", async () => {
    const setup = await harness();
    const fetchSpy = vi.fn(() => {
      throw new Error("unexpected HTTP");
    });
    vi.stubGlobal("fetch", fetchSpy);

    const result = await installPackagedSeed(setup.options);

    expect(result.status).toBe("installed");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(childProcessSpies.execFile).not.toHaveBeenCalled();
  });
});
