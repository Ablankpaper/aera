import { createHash } from "node:crypto";
import { createServer } from "node:net";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "playwright/test";

import {
  inspectActiveGatewayProfile,
  inspectInstalledRuntimeContract,
  inspectLiveGatewayEndpoint,
  inspectLiveGatewayProcess,
  probeRuntimeCapabilities,
  type LiveGatewayEndpointEvidence,
  type LiveGatewayProcessEvidence,
} from "./support/agentera-runtime-contract-evidence";

const SHA1_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const desktopRoot = resolve(process.cwd());

interface RuntimeLock {
  runtime_version: string;
  source_commit: string;
}

interface SeedManifestIdentity {
  filename: string;
  sha256: string;
  runtimeVersion: string;
  sourceCommit: string;
}

let app: ElectronApplication | null = null;
let page: Page | null = null;
let temporaryRoot = "";

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return resolve(value);
}

function requiredSourceSha(): string {
  const value = process.env.AGENTERA_E2E_SOURCE_SHA?.trim() ?? "";
  if (!SHA1_PATTERN.test(value)) {
    throw new Error("AGENTERA_E2E_SOURCE_SHA must be a full source commit");
  }
  return value;
}

async function freeLoopbackPort(): Promise<number> {
  return new Promise<number>((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Could not reserve a loopback Gateway port"));
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolvePort(address.port);
      });
    });
  });
}

function dotenvValue(contents: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = contents.match(new RegExp(`^${escaped}=(.*)$`, "mu"));
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

async function readRuntimeLock(): Promise<RuntimeLock> {
  const value = JSON.parse(
    await readFile(
      join(desktopRoot, "build", "agentera-runtime-seed.lock.json"),
      "utf8",
    ),
  ) as Record<string, unknown>;
  if (
    typeof value.runtime_version !== "string" ||
    value.runtime_version.length === 0 ||
    typeof value.source_commit !== "string" ||
    !SHA1_PATTERN.test(value.source_commit)
  ) {
    throw new Error("Runtime Seed lock identity is invalid");
  }
  return {
    runtime_version: value.runtime_version,
    source_commit: value.source_commit,
  };
}

async function readSeedManifestIdentity(
  seedDirectory: string,
): Promise<SeedManifestIdentity> {
  const entries = (await readdir(seedDirectory)).filter(
    (entry) => entry !== ".gitkeep",
  );
  const manifests = entries.filter((entry) => entry.endsWith(".manifest.json"));
  if (entries.length !== 3 || manifests.length !== 1 || !manifests[0]) {
    throw new Error("Packaged Runtime Seed must contain exactly three files");
  }
  const filename = manifests[0];
  const bytes = await readFile(join(seedDirectory, filename));
  const value = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
  if (
    typeof value.runtime_version !== "string" ||
    value.runtime_version.length === 0 ||
    typeof value.source_commit !== "string" ||
    !SHA1_PATTERN.test(value.source_commit)
  ) {
    throw new Error("Packaged Runtime Seed manifest identity is invalid");
  }
  return {
    filename,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    runtimeVersion: value.runtime_version,
    sourceCommit: value.source_commit,
  };
}

async function assertExactPackagedSeed(
  executablePath: string,
  seedDirectory: string,
): Promise<void> {
  const realExecutable = await realpath(executablePath);
  const expectedSeed =
    process.platform === "darwin"
      ? join(
          dirname(dirname(realExecutable)),
          "Resources",
          "agentera-runtime-seed",
        )
      : join(dirname(realExecutable), "resources", "agentera-runtime-seed");
  expect(await realpath(seedDirectory)).toBe(await realpath(expectedSeed));
}

async function waitForGatewayProcess(
  profilePath: string,
  pythonExecutable: string,
): Promise<LiveGatewayProcessEvidence> {
  let evidence: LiveGatewayProcessEvidence | null = null;
  await expect
    .poll(
      async () => {
        try {
          evidence = await inspectLiveGatewayProcess(
            profilePath,
            pythonExecutable,
          );
          return true;
        } catch {
          return false;
        }
      },
      { timeout: 45_000 },
    )
    .toBe(true);
  if (evidence === null) {
    throw new Error("Live packaged Gateway process evidence is unavailable");
  }
  return evidence;
}

async function waitForGatewayEndpoint(
  pid: number,
): Promise<LiveGatewayEndpointEvidence> {
  let evidence: LiveGatewayEndpointEvidence | null = null;
  await expect
    .poll(
      async () => {
        try {
          evidence = await inspectLiveGatewayEndpoint(pid);
          return true;
        } catch {
          return false;
        }
      },
      { timeout: 45_000 },
    )
    .toBe(true);
  if (evidence === null) {
    throw new Error("Live packaged Gateway endpoint evidence is unavailable");
  }
  return evidence;
}

test.afterEach(async () => {
  if (page) {
    await page
      .evaluate(() => window.hermesAPI.stopGateway())
      .catch(() => undefined);
  }
  await app?.close().catch(() => undefined);
  app = null;
  page = null;
  if (temporaryRoot) {
    await rm(temporaryRoot, { recursive: true, force: true });
    temporaryRoot = "";
  }
});

// @lat: [[agentera-runtime-distribution#Release gate#Packaged live Runtime contract]]
// Playwright requires its fixtures argument to use object destructuring.
// eslint-disable-next-line no-empty-pattern
test("packaged Electron runs its installed locked Runtime and advertises Agent request contracts", async ({}) => {
  const executablePath = requiredEnvironment("AGENTERA_E2E_EXECUTABLE_PATH");
  const seedDirectory = requiredEnvironment("AGENTERA_RUNTIME_SEED_DIR");
  const evidenceOutput = requiredEnvironment(
    "AGENTERA_E2E_RUNTIME_CONTRACT_OUTPUT",
  );
  const sourceSha = requiredSourceSha();
  const lock = await readRuntimeLock();
  const seed = await readSeedManifestIdentity(seedDirectory);
  expect(seed.runtimeVersion).toBe(lock.runtime_version);
  expect(seed.sourceCommit).toBe(lock.source_commit);
  expect(seed.sha256).toMatch(SHA256_PATTERN);
  await assertExactPackagedSeed(executablePath, seedDirectory);

  temporaryRoot = await mkdtemp(join(tmpdir(), "aera-runtime-contract-"));
  const userData = join(temporaryRoot, "user-data");
  const hermesHome = join(temporaryRoot, "hermes-home");
  await Promise.all([
    mkdir(userData, { recursive: true, mode: 0o700 }),
    mkdir(hermesHome, { recursive: true, mode: 0o700 }),
    mkdir(dirname(evidenceOutput), { recursive: true }),
  ]);
  const gatewayPort = await freeLoopbackPort();

  app = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${userData}`],
    cwd: desktopRoot,
    env: {
      ...process.env,
      AGENTERA_E2E_DIAGNOSTICS: "1",
      AGENTERA_RUNTIME_SEED_DIR: seedDirectory,
      HERMES_DESKTOP_DEFAULT_API_PORT: String(gatewayPort),
      HERMES_DESKTOP_PORT_RANGE_START: String(gatewayPort + 1),
      HERMES_DESKTOP_USER_DATA_DIR: userData,
      HERMES_DISABLE_GPU: "1",
      HERMES_HOME: hermesHome,
      HERMES_OPEN_DEVTOOLS: "0",
      HERMES_DESKTOP_OPEN_DEVTOOLS: "0",
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
    },
  });
  page = await app.firstWindow();

  const desktopVersion = await app.evaluate(({ app: electronApp }) =>
    electronApp.getVersion(),
  );
  const install = await page.evaluate(() => window.hermesAPI.startInstall());
  expect(install).toEqual({ success: true });
  await expect
    .poll(() =>
      page?.evaluate(() => window.agenteraRuntimeDistribution.getState()),
    )
    .toMatchObject({
      phase: "current",
      currentVersion: lock.runtime_version,
      currentSourceCommit: lock.source_commit,
    });

  const installed = await inspectInstalledRuntimeContract(userData);
  expect(installed).toMatchObject({
    runtimeVersion: lock.runtime_version,
    sourceCommit: lock.source_commit,
    manifestSourceCommit: lock.source_commit,
  });
  expect(installed.manifestSha256).toBe(seed.sha256);
  expect(installed.pythonExecutable.sha256).toBe(
    installed.pythonExecutable.manifestSha256,
  );
  expect(installed.hermesEntrypoint.sha256).toBe(
    installed.hermesEntrypoint.manifestSha256,
  );

  const profileBinding = await page.evaluate(() =>
    window.agenteraRuntimeAccess.bindActiveProfile(),
  );
  expect(profileBinding).toMatchObject({ status: "bound" });
  const gatewayStart = await page.evaluate(() =>
    window.hermesAPI.startGateway(),
  );
  expect(gatewayStart).toMatchObject({ success: true, running: true });
  const activeGateway = await inspectActiveGatewayProfile([
    {
      id: "default",
      path: hermesHome,
      isActive: true,
      isDefault: true,
    },
  ]);
  const apiKey = dotenvValue(
    await readFile(join(activeGateway.profilePath, ".env"), "utf8"),
    "API_SERVER_KEY",
  );
  expect(apiKey).not.toBeNull();

  const liveProcess = await waitForGatewayProcess(
    activeGateway.profilePath,
    installed.pythonExecutable.path,
  );
  expect(liveProcess.command).toContain("hermes_cli.main");
  expect(liveProcess.command).toMatch(/\bgateway\b/u);
  const liveEndpoint = await waitForGatewayEndpoint(liveProcess.pid);
  expect(liveEndpoint.port).toBe(gatewayPort);
  await expect
    .poll(
      async () => {
        try {
          await probeRuntimeCapabilities(liveEndpoint.origin, apiKey ?? "");
          return true;
        } catch {
          return false;
        }
      },
      { timeout: 120_000 },
    )
    .toBe(true);
  const capabilities = await probeRuntimeCapabilities(
    liveEndpoint.origin,
    apiKey ?? "",
  );

  const evidence = {
    schemaVersion: 1,
    sourceSha,
    desktopVersion,
    platform: process.platform,
    architecture: process.arch,
    runtime: {
      runtimeVersion: installed.runtimeVersion,
      sourceCommit: installed.sourceCommit,
      versionDirectory: installed.versionDirectory,
      currentManifestSha256: installed.manifestSha256,
      manifestSourceCommit: installed.manifestSourceCommit,
      seedManifest: seed.filename,
      pythonSha256: installed.pythonExecutable.sha256,
      hermesEntrypointSha256: installed.hermesEntrypoint.sha256,
    },
    gateway: {
      profileId: activeGateway.profileId,
      pid: liveProcess.pid,
      address: liveEndpoint.address,
      port: liveEndpoint.port,
      installedPythonMatched: true,
      hermesEntrypointMatched: true,
    },
    capabilities,
  };
  const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
  expect(serialized).not.toContain(apiKey ?? "unavailable-runtime-key");
  expect(serialized).not.toContain(userData);
  expect(serialized).not.toContain(hermesHome);
  expect(serialized).not.toContain(installed.versionRoot);
  await writeFile(evidenceOutput, serialized, { flag: "wx", mode: 0o600 });
});
