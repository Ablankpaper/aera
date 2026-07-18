import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  configureRuntimeInvocationContext,
  getRuntimeInvocation,
  refreshRuntimeInvocation,
  resetRuntimeInvocationContext,
  selectExternalRuntime,
  selectManagedRuntime,
} from "../src/main/agentera-runtime-distribution/invocation";

const temporaryDirectories: string[] = [];

function makeContext(platform: "darwin" | "win32" = "darwin"): {
  directory: string;
  hermesHome: string;
  userDataPath: string;
} {
  const directory = mkdtempSync(join(tmpdir(), "agentera-runtime-invocation-"));
  temporaryDirectories.push(directory);
  const hermesHome = join(directory, "hermes-home");
  const userDataPath = join(directory, "user-data");
  mkdirSync(hermesHome, { recursive: true });
  mkdirSync(userDataPath, { recursive: true });
  configureRuntimeInvocationContext({ hermesHome, userDataPath, platform });
  return { directory, hermesHome, userDataPath };
}

function createExternalRuntime(
  hermesHome: string,
  platform: "darwin" | "win32" = "darwin",
): { repo: string; python: string } {
  const repo = join(hermesHome, "hermes-agent");
  const python =
    platform === "win32"
      ? join(repo, "venv", "Scripts", "pythonw.exe")
      : join(repo, "venv", "bin", "python");
  mkdirSync(join(repo, "hermes_cli", "web_dist"), { recursive: true });
  mkdirSync(join(repo, "skills"), { recursive: true });
  mkdirSync(dirname(python), { recursive: true });
  writeFileSync(join(repo, "hermes_cli", "main.py"), "# fixture\n");
  writeFileSync(python, "fixture");
  return { repo, python };
}

function writeManagedRuntime(
  userDataPath: string,
  platform: "darwin" | "win32" = "darwin",
  versionDirectory = "0.18.2-agentera.1-e46cd0f",
): { root: string; python: string; sitePackages: string } {
  const runtimeRoot = join(userDataPath, "runtime");
  const root = join(runtimeRoot, "versions", versionDirectory);
  const python =
    platform === "win32"
      ? join(root, "python", "python.exe")
      : join(root, "python", "bin", "python3");
  const sitePackages =
    platform === "win32"
      ? join(root, "python", "Lib", "site-packages")
      : join(root, "python", "lib", "python3.11", "site-packages");
  mkdirSync(join(sitePackages, "hermes_cli", "web_dist"), {
    recursive: true,
  });
  mkdirSync(join(root, "python", "skills"), { recursive: true });
  mkdirSync(dirname(python), { recursive: true });
  writeFileSync(python, "fixture");
  mkdirSync(runtimeRoot, { recursive: true });
  writeFileSync(
    join(runtimeRoot, "current.json"),
    JSON.stringify({
      schemaVersion: 1,
      runtimeVersion: "0.18.2-agentera.1",
      sourceCommit: "e46cd0f8e90dda7c9970394fb0c0203ebe9bf3c4",
      versionDirectory,
      manifestSha256: "a".repeat(64),
      installedAt: "2026-07-18T08:00:00.000Z",
    }),
  );
  return { root, python, sitePackages };
}

afterEach(() => {
  resetRuntimeInvocationContext();
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe("Runtime invocation selection", () => {
  it("resolves an explicit external Runtime through the module entrypoint", () => {
    const { hermesHome } = makeContext();
    const external = createExternalRuntime(hermesHome);

    selectExternalRuntime(hermesHome);
    const invocation = getRuntimeInvocation();

    expect(invocation).toMatchObject({
      source: "external",
      version: null,
      sourceCommit: null,
      root: external.repo,
      python: external.python,
      workingDirectory: external.repo,
      bundledSkillsDirectory: join(external.repo, "skills"),
      webDistDirectory: join(external.repo, "hermes_cli", "web_dist"),
    });
    expect(invocation?.cliArgs(["doctor"])).toEqual([
      "-m",
      "hermes_cli.main",
      "doctor",
    ]);
    expect(
      invocation?.environment({ PATH: "base", PYTHONPATH: "keep" }),
    ).toMatchObject({
      HERMES_HOME: hermesHome,
      PYTHONPATH: "keep",
    });
    expect(invocation?.environment({ PATH: "base" }).PYTHONNOUSERSITE).toBe(
      undefined,
    );
  });

  it("returns null for a stale external selection", () => {
    const { hermesHome } = makeContext();
    const { python } = createExternalRuntime(hermesHome);
    selectExternalRuntime(hermesHome);
    expect(getRuntimeInvocation()).not.toBeNull();

    unlinkSync(python);

    expect(refreshRuntimeInvocation()).toBeNull();
  });

  it("resolves the current managed Runtime and isolates its Python environment", () => {
    const { hermesHome, userDataPath } = makeContext();
    const managed = writeManagedRuntime(userDataPath);

    selectManagedRuntime();
    const invocation = getRuntimeInvocation();

    expect(invocation).toMatchObject({
      source: "managed",
      version: "0.18.2-agentera.1",
      sourceCommit: "e46cd0f8e90dda7c9970394fb0c0203ebe9bf3c4",
      root: managed.root,
      python: managed.python,
      workingDirectory: managed.sitePackages,
      bundledSkillsDirectory: join(managed.root, "python", "skills"),
      webDistDirectory: join(managed.sitePackages, "hermes_cli", "web_dist"),
    });
    expect(invocation?.cliArgs(["--version"])).toEqual([
      "-m",
      "hermes_cli.main",
      "--version",
    ]);
    const environment = invocation?.environment({
      PATH: "base",
      PYTHONPATH: "untrusted",
      PYTHONHOME: "untrusted",
      PYTHONDONTWRITEBYTECODE: "0",
      HERMES_HOME: hermesHome,
    });
    expect(environment).toMatchObject({
      HERMES_HOME: hermesHome,
      PYTHONDONTWRITEBYTECODE: "1",
      PYTHONNOUSERSITE: "1",
    });
    expect(environment?.PYTHONPATH).toBeUndefined();
    expect(environment?.PYTHONHOME).toBeUndefined();
  });

  it("returns null when no managed current pointer exists", () => {
    makeContext();
    selectManagedRuntime();
    expect(getRuntimeInvocation()).toBeNull();
  });

  it("uses the Windows x64 managed Runtime layout", () => {
    const { userDataPath } = makeContext("win32");
    const managed = writeManagedRuntime(userDataPath, "win32");

    selectManagedRuntime();

    expect(getRuntimeInvocation()).toMatchObject({
      source: "managed",
      python: managed.python,
      workingDirectory: managed.sitePackages,
    });
  });

  it("refreshes live after the first managed Seed is installed", () => {
    const { userDataPath } = makeContext();
    selectManagedRuntime();
    expect(getRuntimeInvocation()).toBeNull();

    const managed = writeManagedRuntime(userDataPath);

    expect(refreshRuntimeInvocation()).toMatchObject({
      source: "managed",
      root: managed.root,
    });
  });

  it("rejects a managed pointer that escapes the versions directory", () => {
    const { userDataPath } = makeContext();
    writeManagedRuntime(userDataPath);
    const current = join(userDataPath, "runtime", "current.json");
    const value = JSON.parse(readFileSync(current, "utf8"));
    value.versionDirectory = "../outside";
    writeFileSync(current, JSON.stringify(value));

    selectManagedRuntime();

    expect(getRuntimeInvocation()).toBeNull();
  });
});
