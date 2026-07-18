import { lstat, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export interface RuntimeDistributionPaths {
  root: string;
  versions: string;
  staging: string;
  downloads: string;
  failures: string;
  current: string;
  previous: string;
  candidate: string;
  packagedSeed: string;
}

export class RuntimePathError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RuntimePathError";
  }
}

function requireAbsolutePath(value: string, label: string): string {
  if (!isAbsolute(value)) {
    throw new RuntimePathError(`${label} must be an absolute path`);
  }
  return resolve(value);
}

export function createRuntimeDistributionPaths(
  userDataDirectory: string,
  packagedSeed: string,
): RuntimeDistributionPaths {
  const userData = requireAbsolutePath(userDataDirectory, "userData directory");
  const seed = requireAbsolutePath(packagedSeed, "packaged Runtime seed");
  const root = join(userData, "runtime");
  return {
    root,
    versions: join(root, "versions"),
    staging: join(root, "staging"),
    downloads: join(root, "downloads"),
    failures: join(root, "failures"),
    current: join(root, "current.json"),
    previous: join(root, "previous.json"),
    candidate: join(root, "candidate.json"),
    packagedSeed: seed,
  };
}

function isRelativeEscape(value: string): boolean {
  return value === ".." || value.startsWith(`..${sep}`) || isAbsolute(value);
}

export function assertRuntimeOwnedPath(
  runtimeRoot: string,
  candidate: string,
  label = "Runtime path",
): string {
  const root = requireAbsolutePath(runtimeRoot, "Runtime root");
  const target = requireAbsolutePath(candidate, label);
  const relativeTarget = relative(root, target);
  if (relativeTarget.length === 0 || isRelativeEscape(relativeTarget)) {
    throw new RuntimePathError(`${label} is outside the Runtime root`);
  }
  return target;
}

function validateVersionDirectoryName(versionDirectory: string): void {
  if (
    versionDirectory.length === 0 ||
    versionDirectory.length > 255 ||
    isAbsolute(versionDirectory) ||
    versionDirectory === "." ||
    versionDirectory === ".." ||
    versionDirectory.includes("/") ||
    versionDirectory.includes("\\") ||
    versionDirectory.includes("\0")
  ) {
    throw new RuntimePathError(
      "Runtime version directory must be one contained relative directory name",
    );
  }
}

export function resolveRuntimeVersionDirectory(
  paths: RuntimeDistributionPaths,
  versionDirectory: string,
): string {
  validateVersionDirectoryName(versionDirectory);
  return assertRuntimeOwnedPath(
    paths.root,
    join(paths.versions, versionDirectory),
    "Runtime version directory",
  );
}

async function assertRealDirectory(
  runtimeRoot: string,
  path: string,
  label: string,
): Promise<string> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    throw new RuntimePathError(`${label} is missing`, { cause: error });
  }
  if (metadata.isSymbolicLink()) {
    throw new RuntimePathError(`${label} must not be a symlink`);
  }
  if (!metadata.isDirectory()) {
    throw new RuntimePathError(`${label} must be a directory`);
  }
  const rootRealPath = await realpath(runtimeRoot);
  const directoryRealPath = await realpath(path);
  if (path !== runtimeRoot) {
    const relativeDirectory = relative(rootRealPath, directoryRealPath);
    if (relativeDirectory.length === 0 || isRelativeEscape(relativeDirectory)) {
      throw new RuntimePathError(`${label} escapes the Runtime root`);
    }
  }
  return directoryRealPath;
}

export async function ensureRuntimeDistributionDirectories(
  paths: RuntimeDistributionPaths,
): Promise<void> {
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  await assertRealDirectory(paths.root, paths.root, "Runtime root");
  for (const [label, path] of [
    ["Runtime versions directory", paths.versions],
    ["Runtime staging directory", paths.staging],
    ["Runtime downloads directory", paths.downloads],
    ["Runtime failures directory", paths.failures],
  ] as const) {
    assertRuntimeOwnedPath(paths.root, path, label);
    await mkdir(path, { recursive: false, mode: 0o700 }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      },
    );
    await assertRealDirectory(paths.root, path, label);
  }
}

export async function verifyRuntimeVersionDirectory(
  paths: RuntimeDistributionPaths,
  versionDirectory: string,
): Promise<string> {
  await ensureRuntimeDistributionDirectories(paths);
  const path = resolveRuntimeVersionDirectory(paths, versionDirectory);
  await assertRealDirectory(
    paths.root,
    path,
    `Runtime version directory ${versionDirectory}`,
  );
  return path;
}
