import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  bootstrapRuntimeDistribution,
  RUNTIME_LAST_FAILURE_NAME,
  type RuntimeBootstrapOptions,
} from "../src/main/agentera-runtime-distribution/bootstrap";
import type { RuntimeHealthCheckOptions } from "../src/main/agentera-runtime-distribution/health";
import type { RuntimeManifestValidationContext } from "../src/main/agentera-runtime-distribution/manifest";
import {
  RUNTIME_MANIFEST_METADATA_NAME,
  RUNTIME_SIGNATURE_METADATA_NAME,
} from "../src/main/agentera-runtime-distribution/manager";
import {
  createRuntimeDistributionPaths,
  ensureRuntimeDistributionDirectories,
} from "../src/main/agentera-runtime-distribution/paths";
import {
  RuntimeStateStore,
  type CandidatePointer,
  type RuntimePointer,
} from "../src/main/agentera-runtime-distribution/state-store";
import {
  TEST_KEY_ID,
  TEST_PUBLIC_KEY,
  TEST_RUNTIME_VERSION,
  TEST_SOURCE_COMMIT,
  createSignedFixture,
} from "./fixtures/runtime-distribution/fixture";

const temporaryDirectories: string[] = [];
const runtimeBootstrapRecoveryTestTimeoutMs =
  process.platform === "win32" ? 30_000 : 5_000;

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

function pointer(
  versionDirectory: string,
  runtimeVersion: string,
  sourceCommit: string,
  manifestSha256 = "a".repeat(64),
): RuntimePointer {
  return {
    schemaVersion: 1,
    runtimeVersion,
    sourceCommit,
    versionDirectory,
    manifestSha256,
    installedAt: "2026-07-18T12:00:00.000Z",
  };
}

async function createRuntimeLayout(
  versions: string,
  versionDirectory: string,
  healthy = true,
): Promise<string> {
  const root = join(versions, versionDirectory);
  for (const directory of [
    "python/bin",
    "python/lib/python3.11/site-packages/hermes_cli/web_dist",
    "python/skills",
    "runtime",
  ]) {
    await mkdir(join(root, ...directory.split("/")), { recursive: true });
  }
  if (healthy) {
    await writeFile(join(root, "python", "bin", "python3"), "python");
    await writeFile(join(root, "runtime", "hermes"), "hermes");
  }
  return root;
}

async function writeRuntimeMetadata(
  root: string,
  runtimeVersion = TEST_RUNTIME_VERSION,
  sourceCommit = TEST_SOURCE_COMMIT,
): Promise<{
  manifestSha256: string;
}> {
  const signed = createSignedFixture({
    channel: "stable",
    runtime_version: runtimeVersion,
    source_commit: sourceCommit,
  });
  await writeFile(
    join(root, RUNTIME_MANIFEST_METADATA_NAME),
    signed.manifestBytes,
  );
  await writeFile(
    join(root, RUNTIME_SIGNATURE_METADATA_NAME),
    signed.signatureBytes,
  );
  return {
    manifestSha256: createHash("sha256")
      .update(signed.manifestBytes)
      .digest("hex"),
  };
}

async function createSignedRuntimePointer(
  versions: string,
  versionDirectory: string,
  runtimeVersion = "0.18.1-agentera.1",
  sourceCommit = "a".repeat(40),
): Promise<RuntimePointer> {
  const root = await createRuntimeLayout(versions, versionDirectory);
  const metadata = await writeRuntimeMetadata(
    root,
    runtimeVersion,
    sourceCommit,
  );
  return pointer(
    versionDirectory,
    runtimeVersion,
    sourceCommit,
    metadata.manifestSha256,
  );
}

async function harness(
  overrides: Partial<RuntimeBootstrapOptions> = {},
): Promise<{
  paths: ReturnType<typeof createRuntimeDistributionPaths>;
  store: RuntimeStateStore;
  healthCheck: ReturnType<typeof vi.fn>;
  selectManagedRuntime: ReturnType<typeof vi.fn>;
  options: RuntimeBootstrapOptions;
}> {
  const root = await mkdtemp(join(tmpdir(), "agentera-runtime-bootstrap-"));
  temporaryDirectories.push(root);
  const paths = createRuntimeDistributionPaths(
    join(root, "user-data"),
    join(root, "packaged-seed"),
  );
  await ensureRuntimeDistributionDirectories(paths);
  const store = new RuntimeStateStore(paths, {
    now: () => new Date("2026-07-18T14:00:00.000Z"),
  });
  const healthCheck = vi.fn(async (_options: RuntimeHealthCheckOptions) => ({
    probes: 3,
    versionOutput: TEST_RUNTIME_VERSION,
  }));
  const inventoryCheck = vi.fn(async () => ({
    fileCount: 2,
    extractedBytes: 30,
  }));
  const selectManagedRuntime = vi.fn();
  const options: RuntimeBootstrapOptions = {
    paths,
    trustedPublicKeys: new Map([[TEST_KEY_ID, TEST_PUBLIC_KEY]]),
    manifestContext,
    stateStore: store,
    healthCheck,
    inventoryCheck,
    selectManagedRuntime,
    now: () => new Date("2026-07-18T14:00:00.000Z"),
    ...overrides,
  };
  return { paths, store, healthCheck, selectManagedRuntime, options };
}

async function stageCandidate(
  setup: Awaited<ReturnType<typeof harness>>,
  versionDirectory = "candidate-v2",
  applyOnNextLaunch = true,
): Promise<CandidatePointer> {
  const root = await createRuntimeLayout(
    setup.paths.versions,
    versionDirectory,
  );
  const metadata = await writeRuntimeMetadata(root);
  const candidate: CandidatePointer = {
    ...pointer(
      versionDirectory,
      TEST_RUNTIME_VERSION,
      TEST_SOURCE_COMMIT,
      metadata.manifestSha256,
    ),
    applyOnNextLaunch,
    stagedAt: "2026-07-18T13:30:00.000Z",
  };
  await setup.store.stageCandidate(candidate);
  return candidate;
}

describe("Aera Runtime pre-import bootstrap", () => {
  it("awaits Runtime recovery before dynamically importing app/start", async () => {
    const source = await readFile(
      join(process.cwd(), "src/main/index.ts"),
      "utf8",
    );
    const bootstrapAt = source.indexOf("await bootstrapRuntimeDistribution(");
    const dynamicStartAt = source.indexOf('await import("./app/start")');

    expect(source).not.toMatch(/import\s+\{\s*startMainProcess\s*\}/);
    expect(bootstrapAt).toBeGreaterThan(-1);
    expect(dynamicStartAt).toBeGreaterThan(bootstrapAt);
  });

  it("health-checks and promotes an approved candidate before selecting managed mode", async () => {
    const setup = await harness();
    await setup.store.setCurrent(
      await createSignedRuntimePointer(setup.paths.versions, "current-v1"),
    );
    await stageCandidate(setup);

    const result = await bootstrapRuntimeDistribution(setup.options);

    expect(result).toMatchObject({
      phase: "current",
      currentVersion: TEST_RUNTIME_VERSION,
      activatedCandidate: true,
    });
    expect(setup.healthCheck).toHaveBeenCalledOnce();
    expect(setup.healthCheck.mock.calls[0][0].sandboxParent).toBe(
      join(setup.paths.root, "health"),
    );
    expect(await setup.store.readState()).toMatchObject({
      current: { versionDirectory: "candidate-v2" },
      previous: { versionDirectory: "current-v1" },
      candidate: null,
    });
    expect(setup.selectManagedRuntime).toHaveBeenCalledOnce();
  });

  it("keeps current, suppresses the failed candidate loop, and writes only redacted diagnostics", async () => {
    const setup = await harness({
      healthCheck: vi.fn(async () => {
        throw new Error(
          `private token secret-token at ${join(tmpdir(), "private-profile")}`,
        );
      }),
    });
    await setup.store.setCurrent(
      await createSignedRuntimePointer(setup.paths.versions, "current-v1"),
    );
    await stageCandidate(setup);

    const result = await bootstrapRuntimeDistribution(setup.options);

    expect(result).toMatchObject({
      phase: "rollback",
      currentVersion: "0.18.1-agentera.1",
      lastErrorCode: "runtime_candidate_health_failed",
    });
    const journal = await setup.store.readState();
    expect(journal.current?.versionDirectory).toBe("current-v1");
    expect(journal.candidate?.applyOnNextLaunch).toBe(false);
    const diagnostic = await readFile(
      join(setup.paths.failures, RUNTIME_LAST_FAILURE_NAME),
      "utf8",
    );
    expect(diagnostic).toContain(TEST_RUNTIME_VERSION);
    expect(diagnostic).toContain(TEST_SOURCE_COMMIT.slice(0, 12));
    expect(diagnostic).not.toContain("secret-token");
    expect(diagnostic).not.toContain("private-profile");

    setup.healthCheck.mockClear();
    await bootstrapRuntimeDistribution(setup.options);
    expect(setup.healthCheck).not.toHaveBeenCalled();
  });

  it(
    "completes promotion after a crash between previous and current pointer writes",
    async () => {
      const setup = await harness();
      const current = await createSignedRuntimePointer(
        setup.paths.versions,
        "current-v1",
      );
      await setup.store.setCurrent(current);
      await writeFile(setup.paths.previous, `${JSON.stringify(current)}\n`);
      await stageCandidate(setup);

      await bootstrapRuntimeDistribution(setup.options);

      expect(await setup.store.readState()).toMatchObject({
        current: { versionDirectory: "candidate-v2" },
        previous: { versionDirectory: "current-v1" },
        candidate: null,
      });
    },
    runtimeBootstrapRecoveryTestTimeoutMs,
  );

  it("recovers a corrupt current pointer from a valid previous Runtime", async () => {
    const setup = await harness();
    const previous = await createSignedRuntimePointer(
      setup.paths.versions,
      "previous-v1",
    );
    await writeFile(setup.paths.current, "{private broken pointer");
    await writeFile(setup.paths.previous, `${JSON.stringify(previous)}\n`);

    const result = await bootstrapRuntimeDistribution(setup.options);

    expect(result).toMatchObject({
      phase: "rollback",
      currentVersion: "0.18.1-agentera.1",
      lastErrorCode: "runtime_current_invalid",
    });
    expect(await setup.store.readState()).toMatchObject({
      current: { versionDirectory: "previous-v1" },
      previous: null,
    });
    expect(setup.selectManagedRuntime).toHaveBeenCalledOnce();
  });

  it("rolls back when current program files are corrupt but previous is valid", async () => {
    const setup = await harness();
    const previous = await createSignedRuntimePointer(
      setup.paths.versions,
      "previous-v1",
    );
    await createRuntimeLayout(setup.paths.versions, "current-v2", false);
    await setup.store.setCurrent(previous);
    await setup.store.stageCandidate({
      ...pointer("current-v2", "0.18.2-agentera.1", "b".repeat(40)),
      applyOnNextLaunch: true,
      stagedAt: "2026-07-18T13:00:00.000Z",
    });
    await setup.store.promoteCandidate();

    const result = await bootstrapRuntimeDistribution(setup.options);

    expect(result).toMatchObject({
      phase: "rollback",
      currentVersion: "0.18.1-agentera.1",
      lastErrorCode: "runtime_current_invalid",
    });
    expect((await setup.store.readState()).current?.versionDirectory).toBe(
      "previous-v1",
    );
  });

  it("re-hashes a signed current version and rolls back if its inventory changed", async () => {
    const inventoryCheck = vi.fn(async (destination: string) => {
      if (destination.endsWith("current-v2")) {
        throw new Error("signed inventory hash mismatch");
      }
      return { fileCount: 2, extractedBytes: 30 };
    });
    const setup = await harness({ inventoryCheck });
    const previous = await createSignedRuntimePointer(
      setup.paths.versions,
      "previous-v1",
    );
    const currentRoot = await createRuntimeLayout(
      setup.paths.versions,
      "current-v2",
    );
    const metadata = await writeRuntimeMetadata(currentRoot);
    await setup.store.setCurrent(previous);
    await setup.store.stageCandidate({
      ...pointer(
        "current-v2",
        TEST_RUNTIME_VERSION,
        TEST_SOURCE_COMMIT,
        metadata.manifestSha256,
      ),
      applyOnNextLaunch: true,
      stagedAt: "2026-07-18T13:00:00.000Z",
    });
    await setup.store.promoteCandidate();

    const result = await bootstrapRuntimeDistribution(setup.options);

    expect(result).toMatchObject({
      phase: "rollback",
      currentVersion: "0.18.1-agentera.1",
      lastErrorCode: "runtime_current_invalid",
    });
    expect((await setup.store.readState()).current?.versionDirectory).toBe(
      "previous-v1",
    );
    expect(inventoryCheck).toHaveBeenCalledWith(
      currentRoot,
      expect.objectContaining({ runtime_version: TEST_RUNTIME_VERSION }),
      expect.any(Number),
    );
  });

  it("returns packaged-Seed repair state when current and previous are both unusable", async () => {
    const setup = await harness();
    await createRuntimeLayout(setup.paths.versions, "previous-v1", false);
    await createRuntimeLayout(setup.paths.versions, "current-v2", false);
    await setup.store.setCurrent(
      pointer("previous-v1", "0.18.1-agentera.1", "a".repeat(40)),
    );
    await setup.store.stageCandidate({
      ...pointer("current-v2", "0.18.2-agentera.1", "b".repeat(40)),
      applyOnNextLaunch: true,
      stagedAt: "2026-07-18T13:00:00.000Z",
    });
    await setup.store.promoteCandidate();

    const result = await bootstrapRuntimeDistribution(setup.options);

    expect(result).toMatchObject({
      phase: "repair-required",
      currentVersion: null,
      lastErrorCode: "runtime_repair_required",
    });
    expect(setup.selectManagedRuntime).not.toHaveBeenCalled();
  });

  it("rejects an unsigned managed Runtime even when its legacy layout is complete", async () => {
    const setup = await harness();
    await createRuntimeLayout(setup.paths.versions, "unsigned-current");
    await setup.store.setCurrent(
      pointer("unsigned-current", "0.18.1-agentera.1", "a".repeat(40)),
    );

    const result = await bootstrapRuntimeDistribution(setup.options);

    expect(result).toMatchObject({
      phase: "repair-required",
      currentVersion: null,
      lastErrorCode: "runtime_repair_required",
    });
    expect(setup.selectManagedRuntime).not.toHaveBeenCalled();
  });
});
