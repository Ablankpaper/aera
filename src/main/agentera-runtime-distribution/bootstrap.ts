import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

import type { RuntimeDistributionPhase } from "../../shared/agentera-runtime-distribution";
import {
  verifyExtractedRuntimeInventory,
  type RuntimeExtractionResult,
} from "./extractor";
import {
  runIsolatedRuntimeHealthCheck,
  type RuntimeHealthCheckOptions,
  type RuntimeHealthCheckResult,
} from "./health";
import {
  verifyRuntimeManifestSignature,
  type RuntimeManifest,
  type RuntimeManifestValidationContext,
} from "./manifest";
import {
  RUNTIME_LAST_FAILURE_NAME,
  RUNTIME_MANIFEST_METADATA_NAME,
  RUNTIME_SIGNATURE_METADATA_NAME,
} from "./manager";
import {
  assertRuntimeOwnedPath,
  createRuntimeDistributionPaths,
  ensureRuntimeDistributionDirectories,
  verifyRuntimeVersionDirectory,
  type RuntimeDistributionPaths,
} from "./paths";
import { selectManagedRuntime as selectManagedRuntimeDefault } from "./invocation";
import { loadRuntimeTrustFile } from "./trust";
import {
  RuntimeStateStore,
  removeRuntimeOwnedPath,
  type CandidatePointer,
  type RuntimeDistributionState,
  type RuntimePointer,
} from "./state-store";

export { RUNTIME_LAST_FAILURE_NAME };

type RuntimeHealthCheck = (
  options: RuntimeHealthCheckOptions,
) => Promise<RuntimeHealthCheckResult>;
type RuntimeInventoryCheck = (
  destination: string,
  manifest: RuntimeManifest,
  maxExtractedBytes: number,
) => Promise<RuntimeExtractionResult>;

export interface RuntimeBootstrapOptions {
  paths: RuntimeDistributionPaths;
  trustedPublicKeys: ReadonlyMap<string, string>;
  manifestContext: RuntimeManifestValidationContext;
  stateStore?: RuntimeStateStore;
  healthCheck?: RuntimeHealthCheck;
  inventoryCheck?: RuntimeInventoryCheck;
  selectManagedRuntime?: () => void;
  now?: () => Date;
}

export interface RuntimeBootstrapEnvironment {
  userDataPath: string;
  resourcesPath: string;
  workingDirectory: string;
  desktopVersion: string;
  platform: NodeJS.Platform;
  arch: string;
}

export interface RuntimeBootstrapResult {
  phase: Extract<
    RuntimeDistributionPhase,
    "current" | "rollback" | "repair-required"
  >;
  currentVersion: string | null;
  currentSourceCommit: string | null;
  activatedCandidate: boolean;
  lastErrorCode: string | null;
}

function nativeTarget(
  platform: NodeJS.Platform,
  arch: string,
): Pick<RuntimeManifestValidationContext, "platform" | "arch"> {
  if (platform === "darwin" && arch === "arm64") {
    return { platform: "darwin", arch: "arm64" };
  }
  if (platform === "win32" && arch === "x64") {
    return { platform: "windows", arch: "x64" };
  }
  throw new Error(
    `Bundled AgentEra Runtime is unavailable for ${platform}-${arch}`,
  );
}

function runtimeTrustPath(environment: RuntimeBootstrapEnvironment): string {
  const candidates = [
    join(
      environment.resourcesPath,
      "app.asar.unpacked",
      "resources",
      "agentera-runtime-trust.json",
    ),
    join(
      environment.resourcesPath,
      "app.asar",
      "resources",
      "agentera-runtime-trust.json",
    ),
    join(
      environment.workingDirectory,
      "resources",
      "agentera-runtime-trust.json",
    ),
  ];
  const selected = candidates.find((candidate) => existsSync(candidate));
  if (selected === undefined) {
    throw new Error("AgentEra Runtime trust document is missing");
  }
  return selected;
}

export function createRuntimeBootstrapOptions(
  environment: RuntimeBootstrapEnvironment,
): RuntimeBootstrapOptions {
  const target = nativeTarget(environment.platform, environment.arch);
  return {
    paths: createRuntimeDistributionPaths(
      environment.userDataPath,
      join(environment.resourcesPath, "agentera-runtime-seed"),
    ),
    trustedPublicKeys: loadRuntimeTrustFile(runtimeTrustPath(environment)),
    manifestContext: {
      repository: "bignormal/aera-runtime",
      platform: target.platform,
      arch: target.arch,
      desktopVersion: environment.desktopVersion,
      allowedChannels: new Set(["stable"]),
    },
  };
}

interface VerifiedCandidate {
  pointer: RuntimePointer;
  manifest: RuntimeManifest;
  root: string;
}

interface FailureRecord {
  schemaVersion: 1;
  errorCode: string;
  runtimeVersion: string | null;
  sourceCommitShort: string | null;
  exitCode: number | null;
  recordedAt: string;
}

function isContained(root: string, target: string): boolean {
  const value = relative(root, target);
  return (
    value.length > 0 &&
    value !== ".." &&
    !value.startsWith(`..${sep}`) &&
    !isAbsolute(value)
  );
}

async function requireContainedFile(
  root: string,
  relativePath: string,
): Promise<void> {
  const target = join(root, ...relativePath.split("/"));
  const metadata = await lstat(target);
  if (!metadata.isFile() && !metadata.isSymbolicLink()) {
    throw new Error("Runtime required entrypoint is not a file");
  }
  if (!isContained(await realpath(root), await realpath(target))) {
    throw new Error("Runtime required entrypoint escapes its version root");
  }
}

async function requireContainedDirectory(
  root: string,
  relativePath: string,
): Promise<void> {
  const target = join(root, ...relativePath.split("/"));
  const metadata = await lstat(target);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Runtime required directory is invalid");
  }
  if (!isContained(await realpath(root), await realpath(target))) {
    throw new Error("Runtime required directory escapes its version root");
  }
}

async function verifyRuntimeLayout(
  paths: RuntimeDistributionPaths,
  pointer: RuntimePointer,
  platform: RuntimeManifestValidationContext["platform"],
  manifest?: RuntimeManifest,
): Promise<string> {
  const root = await verifyRuntimeVersionDirectory(
    paths,
    pointer.versionDirectory,
  );
  const python =
    manifest?.entrypoints.python ??
    (platform === "windows" ? "python/python.exe" : "python/bin/python3");
  const hermes =
    manifest?.entrypoints.hermes ??
    (platform === "windows" ? "runtime/hermes.cmd" : "runtime/hermes");
  const sitePackages =
    platform === "windows"
      ? "python/Lib/site-packages"
      : "python/lib/python3.11/site-packages";
  await Promise.all([
    requireContainedFile(root, python),
    requireContainedFile(root, hermes),
    requireContainedDirectory(root, sitePackages),
    requireContainedDirectory(root, "python/skills"),
    requireContainedDirectory(root, `${sitePackages}/hermes_cli/web_dist`),
  ]);
  return root;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function verifySignedInstalledRuntime(
  options: RuntimeBootstrapOptions,
  pointer: RuntimePointer,
): Promise<VerifiedCandidate> {
  const root = await verifyRuntimeVersionDirectory(
    options.paths,
    pointer.versionDirectory,
  );
  const [manifestBytes, signatureBytes] = await Promise.all([
    readFile(join(root, RUNTIME_MANIFEST_METADATA_NAME)),
    readFile(join(root, RUNTIME_SIGNATURE_METADATA_NAME)),
  ]);
  const manifestSha256 = createHash("sha256")
    .update(manifestBytes)
    .digest("hex");
  if (manifestSha256 !== pointer.manifestSha256) {
    throw new Error("Runtime candidate manifest hash differs from its pointer");
  }
  const manifest = verifyRuntimeManifestSignature({
    manifestBytes,
    signatureBytes,
    trustedPublicKeys: options.trustedPublicKeys,
    context: options.manifestContext,
  });
  if (
    manifest.channel !== "stable" ||
    manifest.runtime_version !== pointer.runtimeVersion ||
    manifest.source_commit !== pointer.sourceCommit
  ) {
    throw new Error("Runtime candidate metadata differs from its pointer");
  }
  await verifyRuntimeLayout(
    options.paths,
    pointer,
    options.manifestContext.platform,
    manifest,
  );
  let maximumBytes = 0;
  for (const entry of manifest.files) {
    if (entry.kind !== "file") continue;
    maximumBytes += entry.size;
    if (!Number.isSafeInteger(maximumBytes)) {
      throw new Error("Runtime candidate inventory is too large");
    }
  }
  await (options.inventoryCheck ?? verifyExtractedRuntimeInventory)(
    root,
    manifest,
    maximumBytes,
  );
  return { pointer, manifest, root };
}

function findNumericExitCode(error: unknown, depth = 0): number | null {
  if (depth > 5 || error === null || typeof error !== "object") return null;
  const value = error as { code?: unknown; cause?: unknown };
  if (typeof value.code === "number" && Number.isSafeInteger(value.code)) {
    return value.code;
  }
  return findNumericExitCode(value.cause, depth + 1);
}

async function writeFailureRecord(
  paths: RuntimeDistributionPaths,
  record: FailureRecord,
): Promise<void> {
  await ensureRuntimeDistributionDirectories(paths);
  const target = assertRuntimeOwnedPath(
    paths.root,
    join(paths.failures, RUNTIME_LAST_FAILURE_NAME),
    "Runtime failure record",
  );
  const temporary = assertRuntimeOwnedPath(
    paths.root,
    `${target}.tmp-${process.pid}-${randomUUID()}`,
    "Runtime failure record temp file",
  );
  try {
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, target).catch(
      async (error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST" && error.code !== "EPERM") throw error;
        await removeRuntimeOwnedPath(paths.root, target);
        await rename(temporary, target);
      },
    );
  } finally {
    await removeRuntimeOwnedPath(paths.root, temporary).catch(() => undefined);
  }
}

function result(
  phase: RuntimeBootstrapResult["phase"],
  current: RuntimePointer | null,
  lastErrorCode: string | null,
  activatedCandidate = false,
): RuntimeBootstrapResult {
  return {
    phase,
    currentVersion: current?.runtimeVersion ?? null,
    currentSourceCommit: current?.sourceCommit ?? null,
    activatedCandidate,
    lastErrorCode,
  };
}

async function pointerIsUsable(
  options: RuntimeBootstrapOptions,
  pointer: RuntimePointer | null,
): Promise<boolean> {
  if (pointer === null) return false;
  try {
    const root = await verifyRuntimeVersionDirectory(
      options.paths,
      pointer.versionDirectory,
    );
    const [hasManifest, hasSignature] = await Promise.all([
      pathExists(join(root, RUNTIME_MANIFEST_METADATA_NAME)),
      pathExists(join(root, RUNTIME_SIGNATURE_METADATA_NAME)),
    ]);
    if (hasManifest !== hasSignature) return false;
    if (hasManifest) {
      await verifySignedInstalledRuntime(options, pointer);
    } else {
      await verifyRuntimeLayout(
        options.paths,
        pointer,
        options.manifestContext.platform,
      );
    }
    return true;
  } catch {
    return false;
  }
}

async function recoverUsableCurrent(
  options: RuntimeBootstrapOptions,
  store: RuntimeStateStore,
  journal: RuntimeDistributionState,
  currentWasInvalid: boolean,
): Promise<{
  journal: RuntimeDistributionState;
  rolledBack: boolean;
  errorCode: string | null;
}> {
  const currentUsable = await pointerIsUsable(options, journal.current);
  if (currentUsable) {
    return {
      journal,
      rolledBack: false,
      errorCode: currentWasInvalid ? "runtime_current_invalid" : null,
    };
  }
  const previousUsable = await pointerIsUsable(options, journal.previous);
  if (previousUsable) {
    const recovered = await store.rollback();
    return {
      journal: recovered,
      rolledBack: true,
      errorCode: "runtime_current_invalid",
    };
  }
  if (journal.current !== null) await store.clearCurrent();
  if (journal.previous !== null) await store.clearPrevious();
  return {
    journal: await store.readState(),
    rolledBack: false,
    errorCode:
      journal.current !== null || currentWasInvalid
        ? "runtime_current_invalid"
        : null,
  };
}

async function suppressFailedCandidate(
  store: RuntimeStateStore,
  candidate: CandidatePointer,
): Promise<void> {
  try {
    await store.stageCandidate({
      ...candidate,
      applyOnNextLaunch: false,
    });
  } catch {
    await store.clearCandidate().catch(() => undefined);
  }
}

// @lat: [[agentera-runtime-distribution#Update policy]]
export async function bootstrapRuntimeDistribution(
  options: RuntimeBootstrapOptions,
): Promise<RuntimeBootstrapResult> {
  const store = options.stateStore ?? new RuntimeStateStore(options.paths);
  const now = options.now ?? (() => new Date());
  const recovered = await store.recoverForBootstrap();
  const baseline = await recoverUsableCurrent(
    options,
    store,
    recovered.state,
    recovered.invalidPointers.includes("current"),
  );
  let journal = baseline.journal;
  const candidate = journal.candidate;

  if (candidate?.applyOnNextLaunch) {
    let verified: VerifiedCandidate;
    try {
      verified = await verifySignedInstalledRuntime(options, candidate);
    } catch (error) {
      await suppressFailedCandidate(store, candidate);
      await writeFailureRecord(options.paths, {
        schemaVersion: 1,
        errorCode: "runtime_candidate_invalid",
        runtimeVersion: candidate.runtimeVersion,
        sourceCommitShort: candidate.sourceCommit.slice(0, 12),
        exitCode: findNumericExitCode(error),
        recordedAt: now().toISOString(),
      }).catch(() => undefined);
      journal = await store.readState();
      if (journal.current !== null) {
        (options.selectManagedRuntime ?? selectManagedRuntimeDefault)();
        return result("rollback", journal.current, "runtime_candidate_invalid");
      }
      return result("repair-required", null, "runtime_repair_required");
    }

    const healthParent = assertRuntimeOwnedPath(
      options.paths.root,
      join(options.paths.root, "health"),
      "Runtime health directory",
    );
    try {
      await mkdir(healthParent, { recursive: true, mode: 0o700 });
      const healthMetadata = await lstat(healthParent);
      if (!healthMetadata.isDirectory() || healthMetadata.isSymbolicLink()) {
        throw new Error("Runtime health directory must be a real directory");
      }
      await (options.healthCheck ?? runIsolatedRuntimeHealthCheck)({
        runtimeRoot: verified.root,
        manifest: verified.manifest,
        sandboxParent: healthParent,
      });
    } catch (error) {
      await suppressFailedCandidate(store, candidate);
      await writeFailureRecord(options.paths, {
        schemaVersion: 1,
        errorCode: "runtime_candidate_health_failed",
        runtimeVersion: candidate.runtimeVersion,
        sourceCommitShort: candidate.sourceCommit.slice(0, 12),
        exitCode: findNumericExitCode(error),
        recordedAt: now().toISOString(),
      }).catch(() => undefined);
      journal = await store.readState();
      if (journal.current !== null) {
        (options.selectManagedRuntime ?? selectManagedRuntimeDefault)();
        return result(
          "rollback",
          journal.current,
          "runtime_candidate_health_failed",
        );
      }
      return result("repair-required", null, "runtime_repair_required");
    }
    journal = await store.promoteCandidate();
    (options.selectManagedRuntime ?? selectManagedRuntimeDefault)();
    return result("current", journal.current, null, true);
  }

  if (journal.current === null) {
    return result("repair-required", null, "runtime_repair_required");
  }
  (options.selectManagedRuntime ?? selectManagedRuntimeDefault)();
  return result(
    baseline.rolledBack ? "rollback" : "current",
    journal.current,
    baseline.errorCode,
  );
}
