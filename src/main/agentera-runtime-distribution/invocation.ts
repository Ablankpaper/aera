import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  parseJsonObjectRejectDuplicates,
  requireExactObjectFields,
} from "./manifest";

export interface RuntimeInvocation {
  source: "managed" | "external";
  version: string | null;
  sourceCommit: string | null;
  root: string;
  python: string;
  workingDirectory: string;
  bundledSkillsDirectory: string;
  webDistDirectory: string;
  cliArgs(args?: readonly string[]): string[];
  environment(base?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
}

export interface RuntimeInvocationContext {
  hermesHome: string;
  userDataPath: string | null;
  platform: NodeJS.Platform;
}

type RuntimeSelection =
  | { mode: "managed" }
  | { mode: "external"; hermesHome: string };

const POINTER_FIELDS = [
  "schemaVersion",
  "runtimeVersion",
  "sourceCommit",
  "versionDirectory",
  "manifestSha256",
  "installedAt",
] as const;
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function defaultContext(): RuntimeInvocationContext {
  const configuredHome = process.env.HERMES_HOME?.trim();
  const configuredUserData = process.env.AGENTERA_USER_DATA_PATH?.trim();
  return {
    hermesHome: resolve(configuredHome || join(homedir(), ".hermes")),
    userDataPath: configuredUserData ? resolve(configuredUserData) : null,
    platform: process.platform,
  };
}

let context = defaultContext();
let selection: RuntimeSelection = {
  mode: "external",
  hermesHome: context.hermesHome,
};
let cachedInvocation: RuntimeInvocation | null | undefined;

function isContained(parent: string, child: string): boolean {
  const value = relative(parent, child);
  return (
    value.length > 0 &&
    value !== ".." &&
    !value.startsWith(`..${sep}`) &&
    !isAbsolute(value)
  );
}

function isRealDirectory(path: string): boolean {
  try {
    const metadata = lstatSync(path);
    return metadata.isDirectory() && !metadata.isSymbolicLink();
  } catch {
    return false;
  }
}

function isRealFileOrContainedSymlink(path: string, root: string): boolean {
  try {
    const metadata = lstatSync(path);
    if (!metadata.isFile() && !metadata.isSymbolicLink()) return false;
    return isContained(realpathSync(root), realpathSync(path));
  } catch {
    return false;
  }
}

function runtimeEnvironment(
  base: NodeJS.ProcessEnv,
  python: string,
  hermesHome: string,
  managed: boolean,
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv {
  const environment = { ...base };
  if (!environment.HERMES_HOME) environment.HERMES_HOME = hermesHome;
  const delimiter = platform === "win32" ? ";" : ":";
  environment.PATH = [dirname(python), environment.PATH]
    .filter((value): value is string => Boolean(value))
    .join(delimiter);
  if (managed) {
    delete environment.PYTHONHOME;
    delete environment.PYTHONPATH;
    environment.PYTHONNOUSERSITE = "1";
  }
  return environment;
}

function createInvocation(
  fields: Omit<RuntimeInvocation, "cliArgs" | "environment">,
  hermesHome: string,
  managed: boolean,
): RuntimeInvocation {
  const invocation: RuntimeInvocation = {
    ...fields,
    cliArgs: (args: readonly string[] = []) => [
      "-m",
      "hermes_cli.main",
      ...args,
    ],
    environment: (base: NodeJS.ProcessEnv = process.env) =>
      runtimeEnvironment(
        base,
        fields.python,
        hermesHome,
        managed,
        context.platform,
      ),
  };
  return Object.freeze(invocation);
}

function resolveExternalInvocation(
  hermesHome: string,
): RuntimeInvocation | null {
  if (!isAbsolute(hermesHome) || !isRealDirectory(hermesHome)) return null;
  const root = join(hermesHome, "hermes-agent");
  const python =
    context.platform === "win32"
      ? join(root, "venv", "Scripts", "pythonw.exe")
      : join(root, "venv", "bin", "python");
  const mainModule = join(root, "hermes_cli", "main.py");
  if (
    !isRealDirectory(root) ||
    !isRealFileOrContainedSymlink(python, root) ||
    !isRealFileOrContainedSymlink(mainModule, root)
  ) {
    return null;
  }
  return createInvocation(
    {
      source: "external",
      version: null,
      sourceCommit: null,
      root,
      python,
      workingDirectory: root,
      bundledSkillsDirectory: join(root, "skills"),
      webDistDirectory: join(root, "hermes_cli", "web_dist"),
    },
    hermesHome,
    false,
  );
}

interface ManagedPointer {
  runtimeVersion: string;
  sourceCommit: string;
  versionDirectory: string;
}

function readManagedPointer(path: string): ManagedPointer | null {
  try {
    const value = parseJsonObjectRejectDuplicates(
      readFileSync(path),
      "Runtime current pointer",
    );
    requireExactObjectFields(value, POINTER_FIELDS, "Runtime current pointer");
    if (
      value.schemaVersion !== 1 ||
      typeof value.runtimeVersion !== "string" ||
      !VERSION_PATTERN.test(value.runtimeVersion) ||
      typeof value.sourceCommit !== "string" ||
      !COMMIT_PATTERN.test(value.sourceCommit) ||
      typeof value.versionDirectory !== "string" ||
      value.versionDirectory.length === 0 ||
      value.versionDirectory === "." ||
      value.versionDirectory === ".." ||
      value.versionDirectory.includes("/") ||
      value.versionDirectory.includes("\\") ||
      value.versionDirectory.includes("\0") ||
      typeof value.manifestSha256 !== "string" ||
      !SHA256_PATTERN.test(value.manifestSha256) ||
      typeof value.installedAt !== "string" ||
      Number.isNaN(Date.parse(value.installedAt))
    ) {
      return null;
    }
    return {
      runtimeVersion: value.runtimeVersion,
      sourceCommit: value.sourceCommit,
      versionDirectory: value.versionDirectory,
    };
  } catch {
    return null;
  }
}

function resolveManagedInvocation(): RuntimeInvocation | null {
  if (
    context.userDataPath === null ||
    !isAbsolute(context.userDataPath) ||
    (context.platform !== "darwin" && context.platform !== "win32")
  ) {
    return null;
  }
  const distributionRoot = join(context.userDataPath, "runtime");
  const versions = join(distributionRoot, "versions");
  const pointer = readManagedPointer(join(distributionRoot, "current.json"));
  if (pointer === null || !isRealDirectory(versions)) return null;
  const root = join(versions, pointer.versionDirectory);
  if (!isRealDirectory(root)) return null;
  let versionsRealPath: string;
  let rootRealPath: string;
  try {
    versionsRealPath = realpathSync(versions);
    rootRealPath = realpathSync(root);
  } catch {
    return null;
  }
  if (!isContained(versionsRealPath, rootRealPath)) return null;

  const python =
    context.platform === "win32"
      ? join(root, "python", "python.exe")
      : join(root, "python", "bin", "python3");
  const workingDirectory =
    context.platform === "win32"
      ? join(root, "python", "Lib", "site-packages")
      : join(root, "python", "lib", "python3.11", "site-packages");
  const bundledSkillsDirectory = join(root, "python", "skills");
  const webDistDirectory = join(workingDirectory, "hermes_cli", "web_dist");
  if (
    !isRealFileOrContainedSymlink(python, root) ||
    !isRealDirectory(workingDirectory) ||
    !isRealDirectory(bundledSkillsDirectory) ||
    !isRealDirectory(webDistDirectory)
  ) {
    return null;
  }
  return createInvocation(
    {
      source: "managed",
      version: pointer.runtimeVersion,
      sourceCommit: pointer.sourceCommit,
      root,
      python,
      workingDirectory,
      bundledSkillsDirectory,
      webDistDirectory,
    },
    context.hermesHome,
    true,
  );
}

function resolveSelectedInvocation(): RuntimeInvocation | null {
  return selection.mode === "managed"
    ? resolveManagedInvocation()
    : resolveExternalInvocation(selection.hermesHome);
}

export function getRuntimeInvocation(): RuntimeInvocation | null {
  if (cachedInvocation === undefined) {
    cachedInvocation = resolveSelectedInvocation();
  }
  return cachedInvocation;
}

export function refreshRuntimeInvocation(): RuntimeInvocation | null {
  cachedInvocation = resolveSelectedInvocation();
  return cachedInvocation;
}

export function selectExternalRuntime(hermesHome: string): void {
  const selectedHome = hermesHome.trim();
  if (!isAbsolute(selectedHome)) {
    throw new Error("external Runtime Hermes home must be an absolute path");
  }
  selection = { mode: "external", hermesHome: resolve(selectedHome) };
  cachedInvocation = undefined;
}

export function selectManagedRuntime(): void {
  selection = { mode: "managed" };
  cachedInvocation = undefined;
}

/** Main-process bootstrap seam; renderer code must never receive this context. */
export function configureRuntimeInvocationContext(
  next: RuntimeInvocationContext,
): void {
  if (
    !isAbsolute(next.hermesHome) ||
    (next.userDataPath !== null && !isAbsolute(next.userDataPath))
  ) {
    throw new Error("Runtime invocation context paths must be absolute");
  }
  const previousContext = context;
  const previousSelection = selection;
  context = {
    hermesHome: resolve(next.hermesHome),
    userDataPath:
      next.userDataPath === null ? null : resolve(next.userDataPath),
    platform: next.platform,
  };
  selection =
    previousSelection.mode === "external" &&
    previousSelection.hermesHome === previousContext.hermesHome
      ? { mode: "external", hermesHome: context.hermesHome }
      : previousSelection;
  cachedInvocation = undefined;
}

/** Test-only reset for process-global invocation selection. */
export function resetRuntimeInvocationContext(): void {
  context = defaultContext();
  selection = { mode: "external", hermesHome: context.hermesHome };
  cachedInvocation = undefined;
}
