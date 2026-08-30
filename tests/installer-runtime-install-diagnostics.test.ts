// @vitest-environment node

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  installPackagedSeed: vi.fn(),
  userData: "",
}));

vi.mock("electron", () => ({
  app: {
    getPath: (): string => mocks.userData,
    getVersion: (): string => "0.7.4-internal-beta.38",
    isPackaged: false,
  },
  BrowserWindow: class {},
  ipcMain: {
    on: (): void => {},
    handle: (): void => {},
    removeHandler: (): void => {},
    removeAllListeners: (): void => {},
  },
}));

vi.mock("../src/main/agentera-runtime-distribution/seed-installer", () => ({
  getAvailableRuntimeDiskBytes: vi.fn(),
  installPackagedSeed: mocks.installPackagedSeed,
}));

vi.mock("../src/main/agentera-runtime-distribution/trust", () => ({
  loadRuntimeTrustFile: vi.fn(() => new Map()),
}));

const roots: string[] = [];

beforeEach(async () => {
  // This test exercises installer option wiring, not native-target admission.
  // Pin one supported target so the same contract runs on Linux CI as well.
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  vi.spyOn(process, "arch", "get").mockReturnValue("arm64");
  const root = await mkdtemp(join(tmpdir(), "aera-installer-runtime-diag-"));
  roots.push(root);
  mocks.userData = join(root, "user-data");
  await writeFile(join(root, "seed-marker"), "seed");
  Object.defineProperty(process, "resourcesPath", {
    configurable: true,
    value: process.cwd(),
  });
  process.env.AGENTERA_RUNTIME_SEED_DIR = join(root, "seed");
  mocks.installPackagedSeed.mockReset();
  mocks.installPackagedSeed.mockResolvedValue({
    status: "repair-required",
    runtimeVersion: null,
    versionDirectory: null,
    requiredDiskBytes: null,
    errorCode: "runtime-health-failed",
    action: "retry",
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.AGENTERA_E2E_DIAGNOSTICS;
  delete process.env.AGENTERA_E2E_RUNTIME_CONTRACT_DIAGNOSTIC_OUTPUT;
  delete process.env.AGENTERA_RUNTIME_SEED_DIR;
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function loadInstaller(): Promise<{
  runPackagedSeedInstall: (
    onProgress: (progress: unknown) => void,
  ) => Promise<unknown>;
}> {
  return import("../src/main/installer");
}

describe("installer Runtime lifecycle diagnostic wiring", () => {
  it("does not pass an observer in ordinary installer mode", async () => {
    const { runPackagedSeedInstall } = await loadInstaller();

    await runPackagedSeedInstall(vi.fn());

    expect(mocks.installPackagedSeed).toHaveBeenCalledOnce();
    expect(
      mocks.installPackagedSeed.mock.calls[0][0].onDiagnostic,
    ).toBeUndefined();
  });

  it("passes the explicit packaged diagnostic observer to the installer", async () => {
    const root = roots[0];
    const output = join(root, "diagnostics", "events.jsonl");
    await mkdir(join(root, "diagnostics"), { recursive: true });
    await writeFile(output, "", { flag: "wx", mode: 0o600 });
    process.env.AGENTERA_E2E_DIAGNOSTICS = "1";
    process.env.AGENTERA_E2E_RUNTIME_CONTRACT_DIAGNOSTIC_OUTPUT = output;
    const { runPackagedSeedInstall } = await loadInstaller();

    await runPackagedSeedInstall(vi.fn());

    const observer = mocks.installPackagedSeed.mock.calls[0][0].onDiagnostic;
    expect(observer).toEqual(expect.any(Function));
    observer("health-failed", { runtimeVersion: "0.20.0-agentera.5" });
    expect(await readFile(output, "utf8")).toContain(
      '"event":"runtime-install-health-failed"',
    );
  });
});
