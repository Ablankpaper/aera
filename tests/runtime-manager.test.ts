import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ExtractRuntimeArchiveOptions } from "../src/main/agentera-runtime-distribution/extractor";
import type { RuntimeManifestValidationContext } from "../src/main/agentera-runtime-distribution/manifest";
import {
  createRuntimeDistributionManager,
  RUNTIME_LAST_FAILURE_NAME,
  RUNTIME_MANIFEST_METADATA_NAME,
  RUNTIME_SIGNATURE_METADATA_NAME,
  type RuntimeDistributionManagerOptions,
} from "../src/main/agentera-runtime-distribution/manager";
import {
  createRuntimeDistributionPaths,
  ensureRuntimeDistributionDirectories,
} from "../src/main/agentera-runtime-distribution/paths";
import {
  RuntimeStateStore,
  type RuntimePointer,
} from "../src/main/agentera-runtime-distribution/state-store";
import type { RuntimeUpdateOffer } from "../src/main/agentera-runtime-distribution/update-client";
import {
  TEST_ARCHIVE_BYTES,
  TEST_ARCHIVE_NAME,
  TEST_KEY_ID,
  TEST_PUBLIC_KEY,
  TEST_RUNTIME_VERSION,
  TEST_SOURCE_COMMIT,
  createFixtureManifest,
  createSignedFixture,
} from "./fixtures/runtime-distribution/fixture";

const temporaryDirectories: string[] = [];
const runtimeManagerTestTimeoutMs =
  process.platform === "win32" ? 20_000 : 5_000;

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

const manifestContext: RuntimeManifestValidationContext = {
  repository: "Ablankpaper/aera-runtime",
  platform: "darwin",
  arch: "arm64",
  desktopVersion: "0.7.3",
  allowedChannels: new Set(["stable"]),
};

function pointer(versionDirectory: string): RuntimePointer {
  return {
    schemaVersion: 1,
    runtimeVersion: "0.18.1-agentera.1",
    sourceCommit: "a".repeat(40),
    versionDirectory,
    manifestSha256: "b".repeat(64),
    installedAt: "2026-07-18T12:00:00.000Z",
  };
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
  overrides: Partial<RuntimeDistributionManagerOptions> = {},
): Promise<{
  paths: ReturnType<typeof createRuntimeDistributionPaths>;
  store: RuntimeStateStore;
  offer: RuntimeUpdateOffer;
  options: RuntimeDistributionManagerOptions;
  checkUpdate: ReturnType<typeof vi.fn>;
  download: ReturnType<typeof vi.fn>;
  extractor: ReturnType<typeof vi.fn>;
  activeRuns: { count: number };
  stopRuntimeContext: ReturnType<typeof vi.fn>;
  relaunch: ReturnType<typeof vi.fn>;
}> {
  const root = await mkdtemp(join(tmpdir(), "agentera-runtime-manager-"));
  temporaryDirectories.push(root);
  const paths = createRuntimeDistributionPaths(
    join(root, "user-data"),
    join(root, "packaged-seed"),
  );
  await ensureRuntimeDistributionDirectories(paths);
  await mkdir(join(paths.versions, "current-v1"));
  const store = new RuntimeStateStore(paths);
  await store.setCurrent(pointer("current-v1"));

  const signed = createSignedFixture({ channel: "stable" });
  const manifest = createFixtureManifest({ channel: "stable" });
  const offer: RuntimeUpdateOffer = {
    runtimeVersion: TEST_RUNTIME_VERSION,
    sourceCommit: TEST_SOURCE_COMMIT,
    releaseTag: `runtime-v${TEST_RUNTIME_VERSION}`,
    archiveName: TEST_ARCHIVE_NAME,
    archiveSize: TEST_ARCHIVE_BYTES.length,
    archiveSha256: manifest.archive_sha256,
    archiveUrl: new URL(
      `https://github.com/Ablankpaper/aera-runtime/releases/download/runtime-v${TEST_RUNTIME_VERSION}/${TEST_ARCHIVE_NAME}`,
    ),
    manifestUrl: new URL(
      `https://github.com/Ablankpaper/aera-runtime/releases/download/runtime-v${TEST_RUNTIME_VERSION}/${TEST_ARCHIVE_NAME}.manifest.json`,
    ),
    signatureUrl: new URL(
      `https://github.com/Ablankpaper/aera-runtime/releases/download/runtime-v${TEST_RUNTIME_VERSION}/${TEST_ARCHIVE_NAME}.manifest.sig`,
    ),
    manifestBytes: signed.manifestBytes,
    signatureBytes: signed.signatureBytes,
  };
  const checkUpdate = vi.fn(async () => offer);
  const download = vi.fn(async ({ destination }) => {
    await writeFile(destination, TEST_ARCHIVE_BYTES);
  });
  const extractor = vi.fn(
    async ({ destination }: ExtractRuntimeArchiveOptions) => {
      await createRuntimeLayout(destination);
      return { fileCount: 2, extractedBytes: 30 };
    },
  );
  const activeRuns = { count: 0 };
  const stopRuntimeContext = vi.fn();
  const relaunch = vi.fn();
  const options: RuntimeDistributionManagerOptions = {
    paths,
    trustedPublicKeys: new Map([[TEST_KEY_ID, TEST_PUBLIC_KEY]]),
    manifestContext,
    stateStore: store,
    checkUpdate,
    download,
    extractor,
    now: () => new Date("2026-07-18T13:00:00.000Z"),
    randomId: () => "11111111-2222-4333-8444-555555555555",
    activeRunCount: () => activeRuns.count,
    stopRuntimeContext,
    relaunch,
    ...overrides,
  };
  return {
    paths,
    store,
    offer,
    options,
    checkUpdate,
    download,
    extractor,
    activeRuns,
    stopRuntimeContext,
    relaunch,
  };
}

describe("Aera Runtime distribution manager", () => {
  it("shares an in-flight startup recovery between initialize and getState", async () => {
    const setup = await harness();
    const journal = await setup.store.readState();
    let release!: (value: typeof journal) => void;
    const recovery = new Promise<typeof journal>((resolve) => {
      release = resolve;
    });
    const recover = vi.spyOn(setup.store, "recover").mockReturnValue(recovery);
    const manager = createRuntimeDistributionManager(setup.options);

    const initialized = manager.initialize();
    const observed = manager.getState();

    await Promise.resolve();
    expect(recover).toHaveBeenCalledOnce();

    release(journal);
    await expect(Promise.all([initialized, observed])).resolves.toSatisfy(
      ([first, second]) =>
        first.phase === "current" &&
        second.phase === "current" &&
        first.currentVersion === second.currentVersion,
    );
  });

  // @lat: [[agentera-runtime-distribution#Offline Seed installation and repair]]
  it("waits for startup recovery before synchronizing a concurrent Seed repair", async () => {
    const repair = vi.fn();
    const setup = await harness({ repair });
    const startupJournal = await setup.store.readState();
    let release!: (value: typeof startupJournal) => void;
    const recovery = new Promise<typeof startupJournal>((resolve) => {
      release = resolve;
    });
    const recover = vi.spyOn(setup.store, "recover").mockReturnValue(recovery);
    const manager = createRuntimeDistributionManager(setup.options);

    const initializing = manager.initialize();
    const repairedVersion = "seed-repair-v1";
    await mkdir(join(setup.paths.versions, repairedVersion));
    await setup.store.setCurrent({
      ...pointer(repairedVersion),
      runtimeVersion: "0.18.0-agentera.9",
      sourceCommit: "c".repeat(40),
      manifestSha256: "d".repeat(64),
      installedAt: "2026-07-18T13:30:00.000Z",
    });

    const synchronizing = manager.retryRepair();
    release(startupJournal);

    await expect(synchronizing).resolves.toMatchObject({
      phase: "current",
      currentVersion: "0.18.0-agentera.9",
      currentSourceCommit: "c".repeat(40),
      packagedSeedVersion: "0.18.0-agentera.9",
    });
    await initializing;
    expect(recover).toHaveBeenCalledOnce();
    expect(repair).not.toHaveBeenCalled();
  });

  it("checks only signed metadata and performs zero archive downloads", async () => {
    const setup = await harness();
    const manager = createRuntimeDistributionManager(setup.options);

    await manager.initialize();
    const state = await manager.check();

    expect(setup.checkUpdate).toHaveBeenCalledOnce();
    expect(setup.download).not.toHaveBeenCalled();
    expect(setup.extractor).not.toHaveBeenCalled();
    expect(state).toMatchObject({
      phase: "update-available",
      currentVersion: "0.18.1-agentera.1",
      availableVersion: TEST_RUNTIME_VERSION,
      canDownload: true,
    });
  });

  it("returns to the current Runtime when metadata checking throws", async () => {
    const setup = await harness({
      checkUpdate: vi.fn(async () => {
        throw new Error("temporary metadata transport failure");
      }),
    });
    const manager = createRuntimeDistributionManager(setup.options);
    await manager.initialize();

    const state = await manager.check();

    expect(state).toMatchObject({
      phase: "current",
      currentVersion: "0.18.1-agentera.1",
      lastErrorCode: "runtime_update_unavailable",
      canCheck: true,
    });
    expect(setup.download).not.toHaveBeenCalled();
  });

  it(
    "downloads only after confirmation, verifies, extracts, and stages without activating",
    async () => {
      const setup = await harness();
      const manager = createRuntimeDistributionManager(setup.options);
      await manager.initialize();
      await manager.check();

      const state = await manager.downloadConfirmed();

      expect(setup.download).toHaveBeenCalledOnce();
      expect(setup.extractor).toHaveBeenCalledOnce();
      expect(state).toMatchObject({
        phase: "candidate-ready",
        currentVersion: "0.18.1-agentera.1",
        availableVersion: TEST_RUNTIME_VERSION,
        canRestart: true,
      });
      const journal = await setup.store.readState();
      expect(journal.current?.versionDirectory).toBe("current-v1");
      expect(journal.candidate).toMatchObject({
        runtimeVersion: TEST_RUNTIME_VERSION,
        sourceCommit: TEST_SOURCE_COMMIT,
        applyOnNextLaunch: false,
      });
      const candidateRoot = join(
        setup.paths.versions,
        journal.candidate!.versionDirectory,
      );
      expect(
        createHash("sha256")
          .update(
            await readFile(join(candidateRoot, RUNTIME_MANIFEST_METADATA_NAME)),
          )
          .digest("hex"),
      ).toBe(journal.candidate?.manifestSha256);
      await expect(
        readFile(join(candidateRoot, RUNTIME_SIGNATURE_METADATA_NAME)),
      ).resolves.toEqual(setup.offer.signatureBytes);
    },
    runtimeManagerTestTimeoutMs,
  );

  it("cancels an active download without changing current or staging a candidate", async () => {
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => {
      started = resolve;
    });
    const setup = await harness({
      download: vi.fn(
        ({ signal }) =>
          new Promise<void>((_resolve, reject) => {
            started();
            signal.addEventListener(
              "abort",
              () =>
                reject(
                  Object.assign(new Error("cancelled"), {
                    name: "AbortError",
                  }),
                ),
              { once: true },
            );
          }),
      ),
    });
    const manager = createRuntimeDistributionManager(setup.options);
    await manager.initialize();
    await manager.check();

    const downloadPromise = manager.downloadConfirmed();
    await didStart;
    await manager.cancelDownload();
    const state = await downloadPromise;

    expect(state.phase).toBe("update-available");
    expect(await setup.store.readState()).toMatchObject({
      current: { versionDirectory: "current-v1" },
      candidate: null,
    });
  });

  it("keeps the current Runtime usable when a confirmed download fails", async () => {
    const setup = await harness({
      download: vi.fn(async () => {
        throw new Error("network failed");
      }),
    });
    const manager = createRuntimeDistributionManager(setup.options);
    await manager.initialize();
    await manager.check();

    const state = await manager.downloadConfirmed();

    expect(state).toMatchObject({
      phase: "update-available",
      currentVersion: "0.18.1-agentera.1",
      lastErrorCode: "runtime_download_failed",
    });
    expect(await setup.store.readState()).toMatchObject({
      current: { versionDirectory: "current-v1" },
      candidate: null,
    });
  });

  it(
    "refuses restart while tasks are active and only then marks next-launch activation",
    async () => {
      const setup = await harness();
      const manager = createRuntimeDistributionManager(setup.options);
      await manager.initialize();
      await manager.check();
      await manager.downloadConfirmed();
      setup.activeRuns.count = 1;

      const refused = await manager.restartToApply();

      expect(refused.lastErrorCode).toBe("runtime_tasks_active");
      expect(setup.stopRuntimeContext).not.toHaveBeenCalled();
      expect(setup.relaunch).not.toHaveBeenCalled();
      expect((await setup.store.readState()).candidate?.applyOnNextLaunch).toBe(
        false,
      );

      setup.activeRuns.count = 0;
      await manager.restartToApply();

      expect(setup.stopRuntimeContext).toHaveBeenCalledOnce();
      expect(setup.relaunch).toHaveBeenCalledOnce();
      expect((await setup.store.readState()).candidate?.applyOnNextLaunch).toBe(
        true,
      );
    },
    runtimeManagerTestTimeoutMs,
  );

  it(
    "atomically reserves the Runtime transition before stopping the live context",
    async () => {
      const beginRuntimeTransition = vi.fn(() => false);
      const cancelRuntimeTransition = vi.fn();
      const setup = await harness({
        beginRuntimeTransition,
        cancelRuntimeTransition,
      });
      const manager = createRuntimeDistributionManager(setup.options);
      await manager.initialize();
      await manager.check();
      await manager.downloadConfirmed();

      const refused = await manager.restartToApply();

      expect(beginRuntimeTransition).toHaveBeenCalledOnce();
      expect(refused.lastErrorCode).toBe("runtime_tasks_active");
      expect(setup.stopRuntimeContext).not.toHaveBeenCalled();
      expect(setup.relaunch).not.toHaveBeenCalled();
      expect(cancelRuntimeTransition).not.toHaveBeenCalled();
      expect((await setup.store.readState()).candidate?.applyOnNextLaunch).toBe(
        false,
      );
    },
    runtimeManagerTestTimeoutMs,
  );

  it("releases a reserved Runtime transition when restart preparation fails", async () => {
    const beginRuntimeTransition = vi.fn(() => true);
    const cancelRuntimeTransition = vi.fn();
    const setup = await harness({
      beginRuntimeTransition,
      cancelRuntimeTransition,
      stopRuntimeContext: vi.fn(() => {
        throw new Error("stop failed");
      }),
    });
    const manager = createRuntimeDistributionManager(setup.options);
    await manager.initialize();
    await manager.check();
    await manager.downloadConfirmed();

    const failed = await manager.restartToApply();

    expect(failed.lastErrorCode).toBe("runtime_restart_failed");
    expect(cancelRuntimeTransition).toHaveBeenCalledOnce();
    expect(setup.relaunch).not.toHaveBeenCalled();
    expect((await setup.store.readState()).candidate?.applyOnNextLaunch).toBe(
      false,
    );
  });

  it("does not present a durably failed candidate as restartable", async () => {
    const setup = await harness();
    const first = createRuntimeDistributionManager(setup.options);
    await first.initialize();
    await first.check();
    await first.downloadConfirmed();
    await writeFile(
      join(setup.paths.failures, RUNTIME_LAST_FAILURE_NAME),
      JSON.stringify({
        schemaVersion: 1,
        errorCode: "runtime_candidate_health_failed",
        runtimeVersion: TEST_RUNTIME_VERSION,
        sourceCommitShort: TEST_SOURCE_COMMIT.slice(0, 12),
        recordedAt: "2026-07-18T14:00:00.000Z",
      }),
    );

    const restarted = createRuntimeDistributionManager(setup.options);
    const state = await restarted.initialize();

    expect(state).toMatchObject({
      phase: "rollback",
      lastErrorCode: "runtime_candidate_health_failed",
      canRestart: false,
    });
  });

  it("does not replace an already prepared candidate during automatic checks", async () => {
    const setup = await harness();
    const first = createRuntimeDistributionManager(setup.options);
    await first.initialize();
    await first.check();
    await first.downloadConfirmed();
    setup.checkUpdate.mockClear();

    const restarted = createRuntimeDistributionManager(setup.options);
    expect((await restarted.initialize()).phase).toBe("candidate-ready");
    const state = await restarted.check();

    expect(setup.checkUpdate).not.toHaveBeenCalled();
    expect(state.phase).toBe("candidate-ready");
    expect((await setup.store.readState()).candidate).not.toBeNull();
  });

  it("discards a failed candidate before returning to the healthy current Runtime", async () => {
    const setup = await harness();
    const first = createRuntimeDistributionManager(setup.options);
    await first.initialize();
    await first.check();
    await first.downloadConfirmed();
    await writeFile(
      join(setup.paths.failures, RUNTIME_LAST_FAILURE_NAME),
      JSON.stringify({
        schemaVersion: 1,
        errorCode: "runtime_candidate_health_failed",
        runtimeVersion: TEST_RUNTIME_VERSION,
        sourceCommitShort: TEST_SOURCE_COMMIT.slice(0, 12),
        recordedAt: "2026-07-18T14:00:00.000Z",
      }),
    );
    const manager = createRuntimeDistributionManager(setup.options);
    await manager.initialize();

    const state = await manager.retryRepair();

    expect(state).toMatchObject({
      phase: "current",
      currentVersion: "0.18.1-agentera.1",
      availableVersion: null,
      lastErrorCode: null,
      canCheck: true,
    });
    expect((await setup.store.readState()).candidate).toBeNull();
    await expect(
      readFile(join(setup.paths.failures, RUNTIME_LAST_FAILURE_NAME)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("repairs a missing Runtime only through the supplied packaged Seed repair", async () => {
    let repairedStore: RuntimeStateStore | null = null;
    const repair = vi.fn(async () => {
      await repairedStore!.setCurrent(pointer("current-v1"));
      return {
        success: true,
        runtimeVersion: "0.18.1-agentera.1",
        errorCode: null,
      };
    });
    const setup = await harness({ repair });
    repairedStore = setup.store;
    await setup.store.clearCurrent();
    const manager = createRuntimeDistributionManager(setup.options);
    expect((await manager.initialize()).phase).toBe("missing");

    const state = await manager.retryRepair();

    expect(repair).toHaveBeenCalledOnce();
    expect(state).toMatchObject({
      phase: "current",
      currentVersion: "0.18.1-agentera.1",
      packagedSeedVersion: "0.18.1-agentera.1",
      canCheck: false,
      lastErrorCode: null,
    });
    await expect(manager.check()).resolves.toMatchObject({
      phase: "current",
      packagedSeedVersion: "0.18.1-agentera.1",
      canCheck: false,
    });
    expect(setup.checkUpdate).not.toHaveBeenCalled();

    const nextLaunch = createRuntimeDistributionManager(setup.options);
    await expect(nextLaunch.initialize()).resolves.toMatchObject({
      phase: "current",
      packagedSeedVersion: null,
      canCheck: true,
    });
  });

  it("resynchronizes after the packaged Seed installer replaces the current pointer", async () => {
    const repair = vi.fn();
    const setup = await harness({ repair });
    const manager = createRuntimeDistributionManager(setup.options);
    await expect(manager.initialize()).resolves.toMatchObject({
      phase: "current",
      currentVersion: "0.18.1-agentera.1",
      packagedSeedVersion: null,
      canCheck: true,
    });

    await mkdir(join(setup.paths.versions, "seed-repair-v0"));
    await setup.store.setCurrent({
      ...pointer("seed-repair-v0"),
      runtimeVersion: "0.18.0-agentera.9",
      sourceCommit: "c".repeat(40),
      manifestSha256: "d".repeat(64),
      installedAt: "2026-07-18T13:30:00.000Z",
    });

    const state = await manager.retryRepair();

    expect(repair).not.toHaveBeenCalled();
    expect(setup.stopRuntimeContext).not.toHaveBeenCalled();
    expect(state).toMatchObject({
      phase: "current",
      currentVersion: "0.18.0-agentera.9",
      currentSourceCommit: "c".repeat(40),
      packagedSeedVersion: "0.18.0-agentera.9",
      canCheck: false,
      lastErrorCode: null,
    });
    await expect(manager.check()).resolves.toMatchObject({
      phase: "current",
      packagedSeedVersion: "0.18.0-agentera.9",
      canCheck: false,
    });
    expect(setup.checkUpdate).not.toHaveBeenCalled();

    const nextLaunch = createRuntimeDistributionManager(setup.options);
    await expect(nextLaunch.initialize()).resolves.toMatchObject({
      phase: "current",
      currentVersion: "0.18.0-agentera.9",
      packagedSeedVersion: null,
      canCheck: true,
    });
  });

  it("detects a same-version packaged Seed repair directory", async () => {
    const repair = vi.fn();
    const setup = await harness({ repair });
    const manager = createRuntimeDistributionManager(setup.options);
    await manager.initialize();

    await mkdir(join(setup.paths.versions, "current-v1-repair"));
    await setup.store.setCurrent({
      ...pointer("current-v1-repair"),
      installedAt: "2026-07-18T13:30:00.000Z",
    });

    await expect(manager.retryRepair()).resolves.toMatchObject({
      phase: "current",
      currentVersion: "0.18.1-agentera.1",
      packagedSeedVersion: "0.18.1-agentera.1",
      canCheck: false,
      lastErrorCode: null,
    });
    expect(repair).not.toHaveBeenCalled();
  });

  it("reserves and releases a Runtime transition around packaged Seed repair", async () => {
    let repairedStore: RuntimeStateStore | null = null;
    const repair = vi.fn(async () => {
      await repairedStore!.setCurrent(pointer("current-v1"));
      return {
        success: true,
        runtimeVersion: "0.18.1-agentera.1",
        errorCode: null,
      };
    });
    const beginRuntimeTransition = vi.fn(() => true);
    const cancelRuntimeTransition = vi.fn();
    const stopRuntimeContext = vi.fn();
    const setup = await harness({
      repair,
      beginRuntimeTransition,
      cancelRuntimeTransition,
      stopRuntimeContext,
    });
    repairedStore = setup.store;
    await setup.store.clearCurrent();
    const manager = createRuntimeDistributionManager(setup.options);
    await manager.initialize();

    const state = await manager.retryRepair();

    expect(beginRuntimeTransition).toHaveBeenCalledOnce();
    expect(stopRuntimeContext).toHaveBeenCalledOnce();
    expect(repair).toHaveBeenCalledOnce();
    expect(cancelRuntimeTransition).toHaveBeenCalledOnce();
    expect(state.phase).toBe("current");
  });

  it("refuses packaged Seed repair while a Runtime task owns the transition", async () => {
    const repair = vi.fn();
    const setup = await harness({
      repair,
      beginRuntimeTransition: vi.fn(() => false),
    });
    await setup.store.clearCurrent();
    const manager = createRuntimeDistributionManager(setup.options);
    await manager.initialize();

    const state = await manager.retryRepair();

    expect(repair).not.toHaveBeenCalled();
    expect(setup.stopRuntimeContext).not.toHaveBeenCalled();
    expect(state).toMatchObject({
      phase: "repair-required",
      lastErrorCode: "runtime_tasks_active",
    });
  });

  it("keeps a staged candidate when diagnostic cleanup fails", async () => {
    const setup = await harness();
    await mkdir(join(setup.paths.failures, RUNTIME_LAST_FAILURE_NAME));
    const manager = createRuntimeDistributionManager(setup.options);
    await manager.initialize();
    await manager.check();

    const state = await manager.downloadConfirmed();

    expect(state.phase).toBe("candidate-ready");
    await expect(setup.store.readState()).resolves.toMatchObject({
      candidate: { runtimeVersion: TEST_RUNTIME_VERSION },
    });
  });

  it("reports explicit external mode and switches to managed only after Seed repair succeeds", async () => {
    let external = true;
    const repair = vi.fn(async () => {
      external = false;
      return {
        success: true,
        runtimeVersion: "0.18.1-agentera.1",
        errorCode: null,
      };
    });
    const setup = await harness({
      repair,
      isExternalRuntime: () => external,
    });
    const manager = createRuntimeDistributionManager(setup.options);

    expect(await manager.initialize()).toMatchObject({
      phase: "external",
      currentVersion: null,
      canCheck: false,
    });
    expect((await manager.check()).phase).toBe("external");

    const state = await manager.retryRepair();

    expect(repair).toHaveBeenCalledOnce();
    expect(state).toMatchObject({
      phase: "current",
      currentVersion: "0.18.1-agentera.1",
      packagedSeedVersion: "0.18.1-agentera.1",
    });
  });
});
