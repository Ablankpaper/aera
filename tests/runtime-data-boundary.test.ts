import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  bootstrapRuntimeDistribution,
  type RuntimeBootstrapOptions,
} from "../src/main/agentera-runtime-distribution/bootstrap";
import type { ExtractRuntimeArchiveOptions } from "../src/main/agentera-runtime-distribution/extractor";
import {
  configureRuntimeInvocationContext,
  getRuntimeInvocation,
  resetRuntimeInvocationContext,
  selectExternalRuntime,
  selectManagedRuntime,
} from "../src/main/agentera-runtime-distribution/invocation";
import type { RuntimeManifestValidationContext } from "../src/main/agentera-runtime-distribution/manifest";
import {
  createRuntimeDistributionManager,
  type RuntimeDistributionManager,
} from "../src/main/agentera-runtime-distribution/manager";
import { createRuntimeDistributionPaths } from "../src/main/agentera-runtime-distribution/paths";
import {
  installPackagedSeed,
  type PackagedSeedInstallerOptions,
} from "../src/main/agentera-runtime-distribution/seed-installer";
import {
  persistRuntimeSelection,
  readRuntimeSelection,
} from "../src/main/agentera-runtime-distribution/selection-store";
import { RuntimeStateStore } from "../src/main/agentera-runtime-distribution/state-store";
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
  writeFixtureBundle,
} from "./fixtures/runtime-distribution/fixture";

type BoundaryEntry =
  | { kind: "directory"; mode: number }
  | { kind: "file"; mode: number; size: number; sha256: string }
  | { kind: "symlink"; mode: number; target: string };

type BoundarySnapshot = Record<string, BoundaryEntry>;

const temporaryDirectories: string[] = [];
const fixtureCleanups: Array<() => void> = [];

afterEach(async () => {
  resetRuntimeInvocationContext();
  fixtureCleanups.splice(0).forEach((cleanup) => cleanup());
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agentera-runtime-boundary-"));
  temporaryDirectories.push(root);
  return root;
}

async function writeBoundaryFile(
  root: string,
  relativePath: string,
  contents: string | Buffer,
  mode = 0o600,
): Promise<void> {
  const target = join(root, ...relativePath.split("/"));
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, contents, { mode });
  await chmod(target, mode);
}

async function writeProfileFixture(
  root: string,
  prefix: string,
  label: string,
): Promise<void> {
  const path = (relativePath: string): string =>
    prefix ? `${prefix}/${relativePath}` : relativePath;
  await writeBoundaryFile(
    root,
    path(".env"),
    `OPENAI_API_KEY=synthetic-${label}-only\n`,
  );
  await writeBoundaryFile(
    root,
    path("auth.json"),
    `${JSON.stringify({ active_provider: "openai", synthetic: label })}\n`,
  );
  await writeBoundaryFile(root, path("MEMORY.md"), `# ${label} memory\n`);
  await writeBoundaryFile(root, path("USER.md"), `# ${label} user\n`);
  await writeBoundaryFile(root, path("config.yaml"), `profile: ${label}\n`);
  await writeBoundaryFile(
    root,
    path(".usage.json"),
    `${JSON.stringify({ input_tokens: 17, output_tokens: 29 })}\n`,
  );
  await writeBoundaryFile(
    root,
    path("sessions/2026-07/session.json"),
    `${JSON.stringify({ id: `${label}-session`, learned: true })}\n`,
  );
  await writeBoundaryFile(
    root,
    path("sessions/index.sqlite"),
    Buffer.from([0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x00, 0x03]),
  );
  await writeBoundaryFile(
    root,
    path("attachments/session/image.bin"),
    Buffer.from([0x00, 0xff, 0x10, 0x80, 0x42]),
    0o640,
  );
  await writeBoundaryFile(
    root,
    path("skills/agent-created/SKILL.md"),
    `# ${label} learned skill\n`,
    0o644,
  );
  await writeBoundaryFile(
    root,
    path("skills/pinned/research/SKILL.md"),
    `# ${label} pinned skill\n`,
    0o644,
  );
  await writeBoundaryFile(
    root,
    path("skills/.pins.json"),
    `${JSON.stringify(["research"])}\n`,
  );
  await writeBoundaryFile(
    root,
    path("curator/archives/2026-07-18.jsonl"),
    `{"profile":"${label}","event":"learned"}\n`,
  );
  await writeBoundaryFile(
    root,
    path("curator/backups/latest.tar.gz"),
    Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x01]),
  );
  await writeBoundaryFile(
    root,
    path("curator/state.sqlite"),
    Buffer.from("SQLite format 3\0synthetic", "utf8"),
  );
  await writeBoundaryFile(root, path("gateway/gateway.pid"), "4242\n");
  await writeBoundaryFile(
    root,
    path("gateway/state.json"),
    `${JSON.stringify({ port: 8642, profile: label })}\n`,
  );
  await writeBoundaryFile(
    root,
    path("cron/jobs.json"),
    `${JSON.stringify({ jobs: [{ id: `${label}-daily` }] })}\n`,
  );
  await writeBoundaryFile(
    root,
    path("cron/history/last-run.json"),
    `${JSON.stringify({ status: "complete" })}\n`,
  );
  await writeBoundaryFile(
    root,
    path("logs/agent.log"),
    `${label} private log\n`,
    0o640,
  );
  await writeBoundaryFile(
    root,
    path("workspace/project/notes.md"),
    `# ${label} workspace\n`,
    0o644,
  );
  const linkPath = join(root, ...path("workspace/current").split("/"));
  await mkdir(dirname(linkPath), { recursive: true });
  await symlink(
    process.platform === "win32" ? dirname(linkPath) : "project",
    linkPath,
    process.platform === "win32" ? "junction" : "dir",
  );
}

async function writeHermesBoundaryFixture(root: string): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await writeProfileFixture(root, "", "default");
  await writeProfileFixture(root, "profiles/research", "research");
  await writeBoundaryFile(root, "active_profile", "research\n");

  // Explicit external Runtime compatibility lives inside the same historical
  // Hermes home and must remain byte-for-byte untouched by managed lifecycle.
  await writeBoundaryFile(
    root,
    "hermes-agent/venv/bin/python",
    "external-python\n",
    0o755,
  );
  await writeBoundaryFile(
    root,
    "hermes-agent/hermes_cli/main.py",
    "# external main\n",
    0o644,
  );
  await writeBoundaryFile(
    root,
    "hermes-agent/hermes_cli/web_dist/index.html",
    "external dashboard\n",
    0o644,
  );
  await writeBoundaryFile(
    root,
    "hermes-agent/skills/base/SKILL.md",
    "# external base skill\n",
    0o644,
  );
  await writeBoundaryFile(
    root,
    "hermes-agent/local-learning.txt",
    "never mutate this checkout\n",
  );
}

async function boundarySnapshot(root: string): Promise<BoundarySnapshot> {
  const snapshot: BoundarySnapshot = {};
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const target = join(directory, entry.name);
      const metadata = await lstat(target);
      const mode = metadata.mode & 0o7777;
      if (metadata.isSymbolicLink()) {
        snapshot[relativePath] = {
          kind: "symlink",
          mode,
          target: await readlink(target),
        };
      } else if (metadata.isDirectory()) {
        snapshot[relativePath] = { kind: "directory", mode };
        await visit(target, relativePath);
      } else if (metadata.isFile()) {
        const contents = await readFile(target);
        snapshot[relativePath] = {
          kind: "file",
          mode,
          size: contents.length,
          sha256: createHash("sha256").update(contents).digest("hex"),
        };
      } else {
        throw new Error(`Unsupported boundary entry: ${relativePath}`);
      }
    }
  };
  await visit(root, "");
  return snapshot;
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
  await chmod(join(destination, "python", "bin", "python3"), 0o755);
  await chmod(join(destination, "runtime", "hermes"), 0o755);
}

function stableOffer(
  overrides: {
    runtimeVersion?: string;
    sourceCommit?: string;
    archiveName?: string;
  } = {},
): RuntimeUpdateOffer {
  const runtimeVersion = overrides.runtimeVersion ?? TEST_RUNTIME_VERSION;
  const sourceCommit = overrides.sourceCommit ?? TEST_SOURCE_COMMIT;
  const archiveName = overrides.archiveName ?? TEST_ARCHIVE_NAME;
  const manifestOverrides = {
    channel: "stable",
    runtime_version: runtimeVersion,
    source_commit: sourceCommit,
    archive_name: archiveName,
  };
  const manifest = createFixtureManifest(manifestOverrides);
  const signed = createSignedFixture(manifestOverrides);
  const releaseTag = `runtime-v${runtimeVersion}`;
  return {
    runtimeVersion,
    sourceCommit,
    releaseTag,
    archiveName,
    archiveSize: manifest.archive_size,
    archiveSha256: manifest.archive_sha256,
    archiveUrl: new URL(
      `https://github.com/Ablankpaper/aera-runtime/releases/download/${releaseTag}/${archiveName}`,
    ),
    manifestUrl: new URL(
      `https://github.com/Ablankpaper/aera-runtime/releases/download/${releaseTag}/${archiveName}.manifest.json`,
    ),
    signatureUrl: new URL(
      `https://github.com/Ablankpaper/aera-runtime/releases/download/${releaseTag}/${archiveName}.manifest.sig`,
    ),
    manifestBytes: signed.manifestBytes,
    signatureBytes: signed.signatureBytes,
  };
}

// @lat: [[agentera-runtime-distribution#Release gate]]
describe("Aera Runtime preserves Hermes adaptive data", () => {
  it("keeps the complete Hermes boundary invariant through install, update, rollback, switch, repair, and cleanup", async () => {
    const root = await temporaryRoot();
    const hermesHome = join(root, "hermes-home");
    const userData = join(root, "electron-user-data");
    await writeHermesBoundaryFixture(hermesHome);
    await mkdir(userData, { recursive: true });
    const expectedBoundary = await boundarySnapshot(hermesHome);
    const assertInvariant = async (operation: string): Promise<void> => {
      expect(
        await boundarySnapshot(hermesHome),
        `${operation} changed HERMES_HOME`,
      ).toEqual(expectedBoundary);
    };

    const seedBundle = writeFixtureBundle({ channel: "candidate" });
    fixtureCleanups.push(seedBundle.cleanup);
    await unlink(seedBundle.trustPath);
    const paths = createRuntimeDistributionPaths(
      userData,
      seedBundle.directory,
    );
    const store = new RuntimeStateStore(paths, {
      now: () => new Date("2026-07-18T12:00:00.000Z"),
    });
    const trustedPublicKeys = new Map([[TEST_KEY_ID, TEST_PUBLIC_KEY]]);
    const seedContext: RuntimeManifestValidationContext = {
      repository: "Ablankpaper/aera-runtime",
      platform: "darwin",
      arch: "arm64",
      desktopVersion: "0.7.3",
      allowedChannels: new Set(["candidate", "stable"]),
    };
    const stableContext: RuntimeManifestValidationContext = {
      ...seedContext,
      allowedChannels: new Set(["stable"]),
    };
    const extractor = vi.fn(
      async ({ destination }: ExtractRuntimeArchiveOptions) => {
        await createRuntimeLayout(destination);
        return { fileCount: 2, extractedBytes: 12 };
      },
    );
    let seedTransaction = 0;
    const seedOptions: PackagedSeedInstallerOptions = {
      paths,
      trustedPublicKeys,
      manifestContext: seedContext,
      stateStore: store,
      availableDiskBytes: async () => Number.MAX_SAFE_INTEGER,
      extractor,
      healthCheck: async () => ({
        probes: 3,
        versionOutput: TEST_RUNTIME_VERSION,
      }),
      selectManagedRuntime: vi.fn(),
      refreshRuntimeInvocation: vi.fn(() => ({ source: "managed" })),
      now: () => new Date("2026-07-18T12:00:00.000Z"),
      randomId: () =>
        seedTransaction++ === 0
          ? "11111111-2222-4333-8444-555555555555"
          : "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    };

    const installed = await installPackagedSeed(seedOptions);
    expect(installed.status).toBe("installed");
    await assertInvariant("packaged Seed installation");

    const seedRestart = await bootstrapRuntimeDistribution({
      paths,
      trustedPublicKeys,
      manifestContext: seedContext,
      stateStore: store,
      inventoryCheck: async () => ({ fileCount: 2, extractedBytes: 12 }),
      healthCheck: async () => ({
        probes: 3,
        versionOutput: TEST_RUNTIME_VERSION,
      }),
      selectManagedRuntime: vi.fn(),
      now: () => new Date("2026-07-18T12:10:00.000Z"),
    });
    expect(seedRestart).toMatchObject({
      phase: "current",
      activatedCandidate: false,
      currentVersion: TEST_RUNTIME_VERSION,
      lastErrorCode: null,
    });
    expect((await store.readState()).current?.versionDirectory).toBe(
      installed.versionDirectory,
    );
    await assertInvariant("offline packaged Seed restart");

    const firstOffer = stableOffer();
    const createManager = (
      offer: RuntimeUpdateOffer,
    ): RuntimeDistributionManager =>
      createRuntimeDistributionManager({
        paths,
        trustedPublicKeys,
        manifestContext: stableContext,
        stateStore: store,
        checkUpdate: async () => offer,
        download: async ({ destination }) => {
          await writeFile(destination, TEST_ARCHIVE_BYTES);
        },
        extractor,
        now: () => new Date("2026-07-18T13:00:00.000Z"),
        randomId: () => "22222222-3333-4444-8555-666666666666",
        activeRunCount: () => 0,
        stopRuntimeContext: vi.fn(),
        relaunch: vi.fn(),
      });
    const manager = createManager(firstOffer);
    await manager.initialize();
    await manager.check();
    expect((await manager.downloadConfirmed()).phase).toBe("candidate-ready");
    await assertInvariant("managed update staging");
    await manager.restartToApply();

    const bootstrapOptions: RuntimeBootstrapOptions = {
      paths,
      trustedPublicKeys,
      manifestContext: seedContext,
      stateStore: store,
      inventoryCheck: async () => ({ fileCount: 2, extractedBytes: 12 }),
      healthCheck: async () => ({
        probes: 3,
        versionOutput: TEST_RUNTIME_VERSION,
      }),
      selectManagedRuntime: vi.fn(),
      now: () => new Date("2026-07-18T13:10:00.000Z"),
    };
    const promoted = await bootstrapRuntimeDistribution(bootstrapOptions);
    expect(promoted).toMatchObject({
      phase: "current",
      activatedCandidate: true,
      currentVersion: TEST_RUNTIME_VERSION,
    });
    await assertInvariant("candidate promotion");

    const failedVersion = "0.18.3-agentera.1";
    const failedOffer = stableOffer({
      runtimeVersion: failedVersion,
      sourceCommit: "e".repeat(40),
      archiveName: `agentera-runtime-${failedVersion}-darwin-arm64.tar.zst`,
    });
    const failingManager = createManager(failedOffer);
    await failingManager.initialize();
    await failingManager.check();
    expect((await failingManager.downloadConfirmed()).phase).toBe(
      "candidate-ready",
    );
    await failingManager.restartToApply();
    const rejected = await bootstrapRuntimeDistribution({
      ...bootstrapOptions,
      healthCheck: async ({ runtimeRoot }) => {
        if (runtimeRoot.includes(failedVersion)) {
          throw new Error("intentional candidate failure");
        }
        return { probes: 3, versionOutput: TEST_RUNTIME_VERSION };
      },
      now: () => new Date("2026-07-18T13:20:00.000Z"),
    });
    expect(rejected).toMatchObject({
      phase: "rollback",
      activatedCandidate: false,
      currentVersion: TEST_RUNTIME_VERSION,
      lastErrorCode: "runtime_candidate_health_failed",
    });
    await assertInvariant("failed candidate rollback");

    const rollbackManager = createRuntimeDistributionManager({
      paths,
      trustedPublicKeys,
      manifestContext: stableContext,
      stateStore: store,
    });
    expect((await rollbackManager.initialize()).phase).toBe("rollback");
    expect((await rollbackManager.retryRepair()).phase).toBe("current");
    await assertInvariant("failed candidate cleanup");

    configureRuntimeInvocationContext({
      hermesHome,
      userDataPath: userData,
      platform: "darwin",
    });
    selectExternalRuntime(hermesHome);
    expect(getRuntimeInvocation()?.source).toBe("external");
    await assertInvariant("external Runtime selection");
    selectManagedRuntime();
    expect(getRuntimeInvocation()?.source).toBe("managed");
    await assertInvariant("managed Runtime selection");

    const selectionFile = join(userData, "hermes-home.json");
    persistRuntimeSelection(selectionFile, {
      mode: "external",
      hermesHome,
    });
    persistRuntimeSelection(selectionFile, {
      mode: "managed",
      hermesHome,
    });
    expect(readRuntimeSelection(selectionFile)).toEqual({
      mode: "managed",
      hermesHome,
    });
    await assertInvariant("persisted Runtime mode switch");

    const currentBeforeRepair = (await store.readState()).current;
    expect(currentBeforeRepair).not.toBeNull();
    await unlink(
      join(
        paths.versions,
        currentBeforeRepair!.versionDirectory,
        "runtime",
        "hermes",
      ),
    );
    const repaired = await installPackagedSeed(seedOptions);
    expect(repaired).toMatchObject({ status: "installed" });
    expect(repaired.versionDirectory).not.toBe(installed.versionDirectory);
    await assertInvariant("packaged Seed repair");

    const orphan = join(paths.versions, "old-unreferenced-version");
    await mkdir(orphan, { recursive: true });
    await writeFile(join(orphan, "obsolete.txt"), "old Runtime only");
    const deleted = await store.cleanupUnreferencedVersions();
    expect(deleted).toContain("old-unreferenced-version");
    expect(deleted).toContain(currentBeforeRepair!.versionDirectory);
    await assertInvariant("old Runtime version cleanup");
  }, 20_000);
});
