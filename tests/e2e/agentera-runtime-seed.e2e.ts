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

type BoundaryEntry =
  | { kind: "directory"; mode: number }
  | { kind: "file"; mode: number; size: number; sha256: string }
  | { kind: "symlink"; mode: number; target: string };

type RuntimeState = {
  phase: string;
  currentVersion: string | null;
  currentSourceCommit: string | null;
};

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
  await writeBoundaryFile(root, "logs/agent.log", "private log\n", 0o640);
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
    expect(actual[path], `existing HERMES_HOME entry changed: ${path}`).toEqual(
      entry,
    );
  }
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
  ) as { runtime_version?: unknown };
  if (typeof lock.runtime_version !== "string") {
    throw new Error("Runtime Seed lock does not contain a Runtime version.");
  }
  expectedRuntimeVersion = lock.runtime_version;
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
test("online auth followed by offline packaged Seed preparation survives restart without public downloads", async () => {
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

  await expect(
    desktopPage.locator('[data-testid="screen-profile-claim"]'),
  ).toBeVisible({ timeout: 180_000 });
  await expect(
    desktopPage.getByRole("button", { name: "Prepare Runtime" }),
  ).toHaveCount(0);
  await expect(
    desktopPage.getByRole("button", { name: "Use existing external Runtime" }),
  ).toHaveCount(0);
  await expect(
    desktopPage.getByRole("button", { name: "Continue to Setup" }),
  ).toHaveCount(0);
  await desktopPage.locator(".agentera-profile-actions .btn-primary").click();
  await expect(desktopPage.locator(".layout")).toBeVisible();

  const firstState = await runtimeState(desktopPage);
  expect(firstState).toMatchObject({
    phase: "current",
    currentVersion: expectedRuntimeVersion,
  });
  const firstVersionOutput = await desktopPage.evaluate(() =>
    window.hermesAPI.getHermesVersion(),
  );
  expect(firstVersionOutput).toContain(expectedRuntimeVersion);
  expectExistingBoundaryUnchanged(
    await boundarySnapshot(harness.hermesHome),
    expectedBoundary,
  );
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
  expect(await publicFetchAttempts(desktopApp)).toEqual([]);
});
