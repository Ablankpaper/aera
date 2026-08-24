import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "playwright/test";

import {
  authenticateNewProductAccount,
  closeProductAuthHarness,
  createProductAuthHarness,
  launchRuntimeDesktop,
  publicFetchAttempts,
  stopProductAuthCloud,
  type ProductAuthHarness,
} from "./support/agentera-product-auth-harness";
import {
  inspectActiveGatewayProfile,
  inspectInstalledRuntimeContract,
  inspectLiveGatewayEndpoint,
  inspectLiveGatewayProcess,
  probeRuntimeCapabilities,
  type LiveGatewayEndpointEvidence,
  type LiveGatewayProcessEvidence,
} from "./support/agentera-runtime-contract-evidence";

type BoundaryEntry =
  | { kind: "directory"; mode: number }
  | { kind: "file"; mode: number; size: number; sha256: string }
  | { kind: "symlink"; mode: number; target: string };

type RuntimeState = {
  phase: string;
  currentVersion: string | null;
  currentSourceCommit: string | null;
};

const existingAgentLog = "private log\n";
const desktopRoot = resolve(process.cwd());
const runtimeSeedDirectory = resolve(
  process.env.AGENTERA_RUNTIME_SEED_DIR?.trim() ||
    join(desktopRoot, "resources", "agentera-runtime-seed"),
);

let harness: ProductAuthHarness | null = null;
let desktopApp: ElectronApplication | null = null;
let desktopPage: Page | null = null;
let expectedBoundary: Record<string, BoundaryEntry> = {};
let expectedRuntimeVersion = "";
let expectedRuntimeSourceCommit = "";

function dotenvValue(contents: string, name: string): string | null {
  const match = contents.match(
    new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}=(.*)$`, "mu"),
  );
  if (!match) return null;
  const value = match[1]?.trim() ?? "";
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value || null;
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

async function writeBoundaryFixture(root: string): Promise<void> {
  await writeBoundaryFile(
    root,
    ".env",
    "OPENAI_API_KEY=synthetic-runtime-e2e-only\n",
  );
  await writeBoundaryFile(
    root,
    "config.yaml",
    "model:\n  provider: openai\n  model: gpt-4o\n",
  );
  await writeBoundaryFile(root, "MEMORY.md", "# Runtime E2E memory\n");
  await writeBoundaryFile(root, "USER.md", "# Runtime E2E user\n");
  await writeBoundaryFile(
    root,
    "sessions/current/session.json",
    '{"id":"runtime-e2e-session"}\n',
  );
  await writeBoundaryFile(
    root,
    "sessions/index.sqlite",
    Buffer.from("SQLite format 3\0runtime-e2e", "utf8"),
  );
  await writeBoundaryFile(
    root,
    "attachments/current/payload.bin",
    Buffer.from([0x00, 0xff, 0x42, 0x80]),
  );
  await writeBoundaryFile(
    root,
    "skills/agent-created/SKILL.md",
    "# Learned Runtime E2E skill\n",
    0o644,
  );
  await writeBoundaryFile(
    root,
    "skills/pinned/research/SKILL.md",
    "# Pinned Runtime E2E skill\n",
    0o644,
  );
  await writeBoundaryFile(
    root,
    "curator/archives/history.jsonl",
    '{"event":"learned"}\n',
  );
  await writeBoundaryFile(
    root,
    "curator/backups/latest.tar.gz",
    Buffer.from([0x1f, 0x8b, 0x08, 0x00]),
  );
  await writeBoundaryFile(root, "cron/jobs.json", '{"jobs":[]}\n');
  await writeBoundaryFile(root, "gateway/state.json", '{"port":8642}\n');
  await writeBoundaryFile(root, "logs/agent.log", existingAgentLog, 0o640);
  await writeBoundaryFile(
    root,
    "workspace/project/notes.md",
    "# Private workspace\n",
    0o644,
  );
}

async function boundarySnapshot(
  root: string,
): Promise<Record<string, BoundaryEntry>> {
  const snapshot: Record<string, BoundaryEntry> = {};
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
      }
    }
  };
  await visit(root, "");
  return snapshot;
}

function expectExistingBoundaryUnchanged(
  actual: Record<string, BoundaryEntry>,
  expected: Record<string, BoundaryEntry>,
): void {
  for (const [path, entry] of Object.entries(expected)) {
    if (path === "logs/agent.log" && entry.kind === "file") {
      expect(actual[path], `existing HERMES_HOME log removed: ${path}`).toEqual(
        expect.objectContaining({
          kind: "file",
          mode: entry.mode,
        }),
      );
      expect(
        actual[path].kind === "file" ? actual[path].size : -1,
        `existing HERMES_HOME log truncated: ${path}`,
      ).toBeGreaterThanOrEqual(entry.size);
      continue;
    }
    expect(actual[path], `existing HERMES_HOME entry changed: ${path}`).toEqual(
      entry,
    );
  }
}

async function expectExistingLogPrefixPreserved(root: string): Promise<void> {
  const contents = await readFile(join(root, "logs", "agent.log"), "utf8");
  expect(contents.slice(0, existingAgentLog.length)).toBe(existingAgentLog);
}

async function runtimeState(page: Page): Promise<RuntimeState> {
  return page.evaluate(() => window.agenteraRuntimeDistribution.getState());
}

test.beforeAll(async () => {
  const lock = JSON.parse(
    await readFile(
      join(desktopRoot, "build", "agentera-runtime-seed.lock.json"),
      "utf8",
    ),
  ) as { runtime_version?: unknown; source_commit?: unknown };
  if (
    typeof lock.runtime_version !== "string" ||
    typeof lock.source_commit !== "string"
  ) {
    throw new Error("Runtime Seed lock does not contain an exact identity.");
  }
  expectedRuntimeVersion = lock.runtime_version;
  expectedRuntimeSourceCommit = lock.source_commit;
  const seedEntries = (await readdir(runtimeSeedDirectory)).filter(
    (entry) => entry !== ".gitkeep",
  );
  if (seedEntries.length !== 3) {
    throw new Error(
      "Prepare the locked native Runtime Seed before running this E2E.",
    );
  }
  harness = await createProductAuthHarness();
  await writeBoundaryFixture(harness.hermesHome);
  expectedBoundary = await boundarySnapshot(harness.hermesHome);
});

test.afterAll(async () => {
  await desktopApp?.close().catch(() => undefined);
  desktopApp = null;
  desktopPage = null;
  await closeProductAuthHarness(harness);
  harness = null;
});

// @lat: [[agentera-runtime-distribution#Release gate]]
// Playwright requires its fixtures argument to use object destructuring.
// eslint-disable-next-line no-empty-pattern
test("online auth followed by offline packaged Seed preparation survives restart without public downloads", async ({}, testInfo) => {
  if (!harness) throw new Error("Runtime E2E harness is unavailable.");

  ({ app: desktopApp, page: desktopPage } = await launchRuntimeDesktop(
    harness,
    runtimeSeedDirectory,
  ));
  await authenticateNewProductAccount(harness, desktopApp, desktopPage);
  // Product login is complete. The desktop must now prepare the packaged
  // Runtime automatically. From this point forward the control plane and
  // every public Runtime source are unavailable; only packaged bytes may run.
  await stopProductAuthCloud(harness);

  const profileClaim = desktopPage.locator(
    '[data-testid="screen-profile-claim"]',
  );
  const mainLayout = desktopPage.locator(".layout");
  await expect(profileClaim.or(mainLayout)).toBeVisible({ timeout: 180_000 });
  await expect(
    desktopPage.getByRole("button", { name: "Prepare Runtime" }),
  ).toHaveCount(0);
  await expect(
    desktopPage.getByRole("button", { name: "Use existing external Runtime" }),
  ).toHaveCount(0);
  await expect(
    desktopPage.getByRole("button", { name: "Continue to Setup" }),
  ).toHaveCount(0);
  if (await profileClaim.isVisible()) {
    await desktopPage.locator(".agentera-profile-actions .btn-primary").click();
  }
  await expect(mainLayout).toBeVisible();

  const firstState = await runtimeState(desktopPage);
  expect(firstState).toMatchObject({
    phase: "current",
    currentVersion: expectedRuntimeVersion,
    currentSourceCommit: expectedRuntimeSourceCommit,
  });
  const firstVersionOutput = await desktopPage.evaluate(() =>
    window.hermesAPI.getHermesVersion(),
  );
  expect(firstVersionOutput).toContain(expectedRuntimeVersion);

  const installedRuntime = await inspectInstalledRuntimeContract(
    harness.userData,
  );
  expect(installedRuntime).toMatchObject({
    runtimeVersion: expectedRuntimeVersion,
    sourceCommit: expectedRuntimeSourceCommit,
    manifestSourceCommit: expectedRuntimeSourceCommit,
  });

  const gatewayStart = await desktopPage.evaluate(() =>
    window.hermesAPI.startGateway(),
  );
  expect(gatewayStart).toMatchObject({ success: true, running: true });
  const activeGateway = await inspectActiveGatewayProfile(
    await desktopPage.evaluate(() => window.hermesAPI.listProfiles()),
  );
  const apiKey = dotenvValue(
    await readFile(join(activeGateway.profilePath, ".env"), "utf8"),
    "API_SERVER_KEY",
  );
  expect(apiKey).not.toBeNull();
  let liveProcess: LiveGatewayProcessEvidence | null = null;
  await expect
    .poll(
      async () => {
        try {
          liveProcess = await inspectLiveGatewayProcess(
            activeGateway.profilePath,
            installedRuntime.pythonExecutable.path,
          );
          return true;
        } catch {
          return false;
        }
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  expect(liveProcess).not.toBeNull();
  let liveEndpoint: LiveGatewayEndpointEvidence | null = null;
  await expect
    .poll(
      async () => {
        try {
          liveEndpoint = await inspectLiveGatewayEndpoint(liveProcess!.pid);
          return true;
        } catch {
          return false;
        }
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  expect(liveEndpoint).not.toBeNull();
  await expect
    .poll(
      async () => {
        try {
          await probeRuntimeCapabilities(liveEndpoint!.origin, apiKey ?? "");
          return true;
        } catch {
          return false;
        }
      },
      { timeout: 120_000 },
    )
    .toBe(true);
  const capabilities = await probeRuntimeCapabilities(
    liveEndpoint!.origin,
    apiKey ?? "",
  );
  await testInfo.attach("packaged-runtime-contract-evidence", {
    body: Buffer.from(
      JSON.stringify(
        {
          currentJson: installedRuntime.currentJson,
          runtimeVersion: installedRuntime.runtimeVersion,
          sourceCommit: installedRuntime.sourceCommit,
          versionDirectory: installedRuntime.versionDirectory,
          versionRoot: installedRuntime.versionRoot,
          manifestPath: installedRuntime.manifestPath,
          manifestSourceCommit: installedRuntime.manifestSourceCommit,
          pythonExecutable: installedRuntime.pythonExecutable,
          hermesEntrypoint: installedRuntime.hermesEntrypoint,
          activeGateway,
          liveProcess,
          liveEndpoint,
          capabilities,
        },
        null,
        2,
      ),
    ),
    contentType: "application/json",
  });
  expectExistingBoundaryUnchanged(
    await boundarySnapshot(harness.hermesHome),
    expectedBoundary,
  );
  await expectExistingLogPrefixPreserved(harness.hermesHome);
  expect(await publicFetchAttempts(desktopApp)).toEqual([]);

  await desktopApp.close();
  desktopApp = null;
  desktopPage = null;

  ({ app: desktopApp, page: desktopPage } = await launchRuntimeDesktop(
    harness,
    runtimeSeedDirectory,
  ));
  await expect
    .poll(async () =>
      desktopPage?.evaluate(() => window.agenteraAuth.getState()),
    )
    .toMatchObject({ status: "offline" });
  const restartedState = await runtimeState(desktopPage);
  expect(restartedState).toMatchObject({
    phase: "current",
    currentVersion: firstState.currentVersion,
    currentSourceCommit: firstState.currentSourceCommit,
  });
  const restartedVersionOutput = await desktopPage.evaluate(() =>
    window.hermesAPI.getHermesVersion(),
  );
  expect(restartedVersionOutput).toContain(expectedRuntimeVersion);
  expectExistingBoundaryUnchanged(
    await boundarySnapshot(harness.hermesHome),
    expectedBoundary,
  );
  await expectExistingLogPrefixPreserved(harness.hermesHome);
  expect(await publicFetchAttempts(desktopApp)).toEqual([]);
});
