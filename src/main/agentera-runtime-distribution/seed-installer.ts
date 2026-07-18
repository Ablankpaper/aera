import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  statfs,
  writeFile,
} from "node:fs/promises";
import { basename, join } from "node:path";

import {
  extractRuntimeArchive,
  type ExtractRuntimeArchiveOptions,
  type RuntimeExtractionResult,
} from "./extractor";
import {
  runIsolatedRuntimeHealthCheck,
  type RuntimeHealthCheckOptions,
  type RuntimeHealthCheckResult,
} from "./health";
import {
  RUNTIME_MANIFEST_METADATA_NAME,
  RUNTIME_SIGNATURE_METADATA_NAME,
  type RuntimeManifest,
  type RuntimeManifestValidationContext,
  verifyRuntimeArtifact,
  verifyRuntimeManifestSignature,
} from "./manifest";
import {
  type RuntimeDistributionPaths,
  assertRuntimeOwnedPath,
  ensureRuntimeDistributionDirectories,
  resolveRuntimeVersionDirectory,
} from "./paths";
import {
  refreshRuntimeInvocation,
  selectManagedRuntime,
  type RuntimeInvocation,
} from "./invocation";
import {
  RuntimeStateStore,
  removeRuntimeOwnedPath,
  type RuntimePointer,
} from "./state-store";

export type PackagedSeedRepairAction =
  | "reinstall-desktop"
  | "free-disk-space"
  | "retry";

export type PackagedSeedInstallErrorCode =
  | "packaged-seed-invalid"
  | "insufficient-disk-space"
  | "runtime-health-failed"
  | "runtime-install-failed"
  | "runtime-activation-failed";

export interface VerifiedPackagedRuntimeSeed {
  manifest: RuntimeManifest;
  manifestBytes: Buffer;
  signatureBytes: Buffer;
  manifestPath: string;
  signaturePath: string;
  archivePath: string;
}

export interface VerifyPackagedRuntimeSeedOptions {
  packagedSeedDirectory: string;
  trustedPublicKeys: ReadonlyMap<string, string>;
  manifestContext: RuntimeManifestValidationContext;
}

export interface PackagedSeedInstallProgress {
  step: number;
  totalSteps: number;
  title: "Preparing AgentEra Runtime";
  detail: string;
}

export interface PackagedSeedInstallResult {
  status: "installed" | "repair-required";
  runtimeVersion: string | null;
  versionDirectory: string | null;
  requiredDiskBytes: number | null;
  errorCode: PackagedSeedInstallErrorCode | null;
  action: PackagedSeedRepairAction | null;
}

type RuntimeExtractor = (
  options: ExtractRuntimeArchiveOptions,
) => Promise<RuntimeExtractionResult>;
type RuntimeHealthCheck = (
  options: RuntimeHealthCheckOptions,
) => Promise<RuntimeHealthCheckResult>;

export interface PackagedSeedInstallerOptions {
  paths: RuntimeDistributionPaths;
  trustedPublicKeys: ReadonlyMap<string, string>;
  manifestContext: RuntimeManifestValidationContext;
  availableDiskBytes: (runtimeRoot: string) => Promise<number>;
  extractor?: RuntimeExtractor;
  healthCheck?: RuntimeHealthCheck;
  stateStore?: RuntimeStateStore;
  selectManagedRuntime?: () => void;
  refreshRuntimeInvocation?: () => RuntimeInvocation | object | null;
  now?: () => Date;
  randomId?: () => string;
  onProgress?: (progress: PackagedSeedInstallProgress) => void;
  signal?: AbortSignal;
}

class PackagedSeedInstallError extends Error {
  constructor(
    readonly code: PackagedSeedInstallErrorCode,
    readonly action: PackagedSeedRepairAction,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PackagedSeedInstallError";
  }
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

async function requireRealDirectory(
  path: string,
  label: string,
): Promise<void> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    throw new PackagedSeedInstallError(
      "packaged-seed-invalid",
      "reinstall-desktop",
      `${label} is missing`,
      { cause: error },
    );
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new PackagedSeedInstallError(
      "packaged-seed-invalid",
      "reinstall-desktop",
      `${label} must be a real directory`,
    );
  }
}

// @lat: [[agentera-runtime-distribution#Release gate]]
export async function verifyPackagedRuntimeSeed({
  packagedSeedDirectory,
  trustedPublicKeys,
  manifestContext,
}: VerifyPackagedRuntimeSeedOptions): Promise<VerifiedPackagedRuntimeSeed> {
  await requireRealDirectory(packagedSeedDirectory, "packaged Runtime Seed");
  let entries;
  try {
    entries = await readdir(packagedSeedDirectory, { withFileTypes: true });
  } catch (error) {
    throw new PackagedSeedInstallError(
      "packaged-seed-invalid",
      "reinstall-desktop",
      "cannot read packaged Runtime Seed",
      { cause: error },
    );
  }
  if (entries.some((entry) => !entry.isFile() || entry.isSymbolicLink())) {
    throw new PackagedSeedInstallError(
      "packaged-seed-invalid",
      "reinstall-desktop",
      "packaged Runtime Seed may contain only regular files",
    );
  }
  const manifestEntries = entries.filter((entry) =>
    entry.name.endsWith(".manifest.json"),
  );
  if (manifestEntries.length !== 1) {
    throw new PackagedSeedInstallError(
      "packaged-seed-invalid",
      "reinstall-desktop",
      "packaged Runtime Seed must contain exactly one manifest",
    );
  }
  const manifestPath = join(packagedSeedDirectory, manifestEntries[0].name);
  const signatureName = manifestEntries[0].name.replace(/\.json$/, ".sig");
  const signaturePath = join(packagedSeedDirectory, signatureName);
  let manifestBytes: Buffer;
  let signatureBytes: Buffer;
  try {
    [manifestBytes, signatureBytes] = await Promise.all([
      readFile(manifestPath),
      readFile(signaturePath),
    ]);
  } catch (error) {
    throw new PackagedSeedInstallError(
      "packaged-seed-invalid",
      "reinstall-desktop",
      "packaged Runtime Seed manifest or signature is missing",
      { cause: error },
    );
  }
  let manifest: RuntimeManifest;
  let archivePath: string;
  try {
    // The archive name is accepted only after the manifest signature and
    // target context validate it as a plain file name.
    const preliminary = await verifyRuntimeArtifactNameAndBytes({
      packagedSeedDirectory,
      manifestBytes,
      signatureBytes,
      trustedPublicKeys,
      manifestContext,
    });
    manifest = preliminary.manifest;
    archivePath = preliminary.archivePath;
  } catch (error) {
    if (error instanceof PackagedSeedInstallError) throw error;
    throw new PackagedSeedInstallError(
      "packaged-seed-invalid",
      "reinstall-desktop",
      "packaged Runtime Seed failed signature or archive verification",
      { cause: error },
    );
  }
  const expectedFiles = new Set([
    basename(manifestPath),
    basename(signaturePath),
    manifest.archive_name,
  ]);
  if (
    entries.length !== expectedFiles.size ||
    entries.some((entry) => !expectedFiles.has(entry.name))
  ) {
    throw new PackagedSeedInstallError(
      "packaged-seed-invalid",
      "reinstall-desktop",
      "packaged Runtime Seed contains unexpected files",
    );
  }
  return {
    manifest,
    manifestBytes,
    signatureBytes,
    manifestPath,
    signaturePath,
    archivePath,
  };
}

async function verifyRuntimeArtifactNameAndBytes(options: {
  packagedSeedDirectory: string;
  manifestBytes: Buffer;
  signatureBytes: Buffer;
  trustedPublicKeys: ReadonlyMap<string, string>;
  manifestContext: RuntimeManifestValidationContext;
}): Promise<{ manifest: RuntimeManifest; archivePath: string }> {
  // Verify the signed context once to obtain the constrained archive_name,
  // then use the artifact verifier for the actual file size and SHA-256.
  const signedManifest = verifyRuntimeManifestSignature({
    manifestBytes: options.manifestBytes,
    signatureBytes: options.signatureBytes,
    trustedPublicKeys: options.trustedPublicKeys,
    context: options.manifestContext,
  });
  const archivePath = join(
    options.packagedSeedDirectory,
    signedManifest.archive_name,
  );
  const manifest = await verifyRuntimeArtifact({
    archivePath,
    manifestBytes: options.manifestBytes,
    signatureBytes: options.signatureBytes,
    trustedPublicKeys: options.trustedPublicKeys,
    context: options.manifestContext,
  });
  return { manifest, archivePath };
}

function extractedManifestBytes(manifest: RuntimeManifest): number {
  let total = 0;
  for (const entry of manifest.files) {
    if (entry.kind !== "file") continue;
    total += entry.size;
    if (!Number.isSafeInteger(total)) {
      throw new PackagedSeedInstallError(
        "packaged-seed-invalid",
        "reinstall-desktop",
        "Runtime Seed extracted size exceeds the supported range",
      );
    }
  }
  return total;
}

export function calculatePackagedSeedDiskBudget(
  manifest: RuntimeManifest,
): number {
  const extractedBytes = extractedManifestBytes(manifest);
  const subtotal = manifest.archive_size + extractedBytes + extractedBytes;
  if (!Number.isSafeInteger(subtotal)) {
    throw new PackagedSeedInstallError(
      "packaged-seed-invalid",
      "reinstall-desktop",
      "Runtime Seed disk budget exceeds the supported range",
    );
  }
  const required = subtotal + Math.ceil(subtotal / 10);
  if (!Number.isSafeInteger(required)) {
    throw new PackagedSeedInstallError(
      "packaged-seed-invalid",
      "reinstall-desktop",
      "Runtime Seed disk safety margin exceeds the supported range",
    );
  }
  return required;
}

export async function getAvailableRuntimeDiskBytes(
  path: string,
): Promise<number> {
  const statistics = await statfs(path);
  const available = Number(statistics.bavail) * Number(statistics.bsize);
  return Number.isSafeInteger(available)
    ? available
    : Math.min(available, Number.MAX_SAFE_INTEGER);
}

function progress(
  callback: PackagedSeedInstallerOptions["onProgress"],
  step: number,
  detail: string,
): void {
  callback?.({
    step,
    totalSteps: 5,
    title: "Preparing AgentEra Runtime",
    detail,
  });
}

function safeRandomFragment(randomId: () => string): string {
  const fragment = randomId()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 12);
  if (fragment.length < 8) {
    throw new PackagedSeedInstallError(
      "runtime-install-failed",
      "retry",
      "Runtime transaction id is invalid",
    );
  }
  return fragment;
}

async function versionDirectoryExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function failureResult(
  error: PackagedSeedInstallError,
  runtimeVersion: string | null,
  requiredDiskBytes: number | null,
): PackagedSeedInstallResult {
  return {
    status: "repair-required",
    runtimeVersion,
    versionDirectory: null,
    requiredDiskBytes,
    errorCode: error.code,
    action: error.action,
  };
}

function asInstallError(
  error: unknown,
  code: PackagedSeedInstallErrorCode,
  action: PackagedSeedRepairAction,
  message: string,
): PackagedSeedInstallError {
  return error instanceof PackagedSeedInstallError
    ? error
    : new PackagedSeedInstallError(code, action, message, { cause: error });
}

// @lat: [[agentera-runtime-distribution#Offline Seed installation and repair]]
export async function installPackagedSeed(
  options: PackagedSeedInstallerOptions,
): Promise<PackagedSeedInstallResult> {
  let seed: VerifiedPackagedRuntimeSeed;
  try {
    progress(options.onProgress, 1, "Verifying the packaged Runtime Seed");
    await ensureRuntimeDistributionDirectories(options.paths);
    seed = await verifyPackagedRuntimeSeed({
      packagedSeedDirectory: options.paths.packagedSeed,
      trustedPublicKeys: options.trustedPublicKeys,
      manifestContext: options.manifestContext,
    });
  } catch (error) {
    return failureResult(
      asInstallError(
        error,
        "packaged-seed-invalid",
        "reinstall-desktop",
        "packaged Runtime Seed is invalid",
      ),
      null,
      null,
    );
  }

  let requiredDiskBytes: number;
  try {
    requiredDiskBytes = calculatePackagedSeedDiskBudget(seed.manifest);
    const available = await options.availableDiskBytes(options.paths.root);
    if (!Number.isSafeInteger(available) || available < 0) {
      throw new PackagedSeedInstallError(
        "runtime-install-failed",
        "retry",
        "available Runtime disk space is invalid",
      );
    }
    if (available < requiredDiskBytes) {
      throw new PackagedSeedInstallError(
        "insufficient-disk-space",
        "free-disk-space",
        "not enough disk space for AgentEra Runtime",
      );
    }
  } catch (error) {
    return failureResult(
      asInstallError(
        error,
        "runtime-install-failed",
        "retry",
        "cannot calculate Runtime disk budget",
      ),
      seed.manifest.runtime_version,
      (() => {
        try {
          return calculatePackagedSeedDiskBudget(seed.manifest);
        } catch {
          return null;
        }
      })(),
    );
  }

  const randomFragment = safeRandomFragment(options.randomId ?? randomUUID);
  const transaction = assertRuntimeOwnedPath(
    options.paths.root,
    join(options.paths.staging, `seed-${randomFragment}`),
    "Runtime Seed transaction",
  );
  const payload = assertRuntimeOwnedPath(
    options.paths.root,
    join(transaction, "payload"),
    "Runtime Seed transaction payload",
  );
  let publishedVersionPath: string | null = null;
  let pointerPublished = false;
  let transactionCreated = false;
  try {
    await mkdir(transaction, { recursive: false, mode: 0o700 });
    transactionCreated = true;
    progress(options.onProgress, 2, "Extracting the verified local Runtime");
    try {
      await (options.extractor ?? extractRuntimeArchive)({
        archivePath: seed.archivePath,
        destination: payload,
        manifest: seed.manifest,
        maxExtractedBytes: extractedManifestBytes(seed.manifest),
        signal: options.signal,
      });
    } catch (error) {
      throw new PackagedSeedInstallError(
        "runtime-install-failed",
        "retry",
        "cannot extract the packaged Runtime Seed",
        { cause: error },
      );
    }

    progress(options.onProgress, 3, "Checking Runtime health in isolation");
    try {
      await (options.healthCheck ?? runIsolatedRuntimeHealthCheck)({
        runtimeRoot: payload,
        manifest: seed.manifest,
        signal: options.signal,
      });
    } catch (error) {
      throw new PackagedSeedInstallError(
        "runtime-health-failed",
        "retry",
        "packaged Runtime Seed failed isolated health checks",
        { cause: error },
      );
    }

    progress(options.onProgress, 4, "Publishing the verified Runtime version");
    await Promise.all([
      writeFile(
        join(payload, RUNTIME_MANIFEST_METADATA_NAME),
        seed.manifestBytes,
        { flag: "wx", mode: 0o600 },
      ),
      writeFile(
        join(payload, RUNTIME_SIGNATURE_METADATA_NAME),
        seed.signatureBytes,
        { flag: "wx", mode: 0o600 },
      ),
    ]);
    const manifestSha256 = createHash("sha256")
      .update(seed.manifestBytes)
      .digest("hex");
    const baseVersionDirectory = [
      seed.manifest.runtime_version,
      seed.manifest.source_commit.slice(0, 12),
      manifestSha256.slice(0, 12),
    ].join("-");
    let versionDirectory = baseVersionDirectory;
    let versionPath = resolveRuntimeVersionDirectory(
      options.paths,
      versionDirectory,
    );
    if (await versionDirectoryExists(versionPath)) {
      versionDirectory = `${baseVersionDirectory}-repair-${randomFragment}`;
      versionPath = resolveRuntimeVersionDirectory(
        options.paths,
        versionDirectory,
      );
      if (await versionDirectoryExists(versionPath)) {
        throw new PackagedSeedInstallError(
          "runtime-install-failed",
          "retry",
          "Runtime repair destination already exists",
        );
      }
    }
    await rename(payload, versionPath);
    publishedVersionPath = versionPath;
    const pointer: RuntimePointer = {
      schemaVersion: 1,
      runtimeVersion: seed.manifest.runtime_version,
      sourceCommit: seed.manifest.source_commit,
      versionDirectory,
      manifestSha256,
      installedAt: (options.now ?? (() => new Date()))().toISOString(),
    };
    await (
      options.stateStore ?? new RuntimeStateStore(options.paths)
    ).setCurrent(pointer);
    pointerPublished = true;

    progress(options.onProgress, 5, "Activating the local managed Runtime");
    (options.selectManagedRuntime ?? selectManagedRuntime)();
    const invocation = (
      options.refreshRuntimeInvocation ?? refreshRuntimeInvocation
    )();
    if (invocation === null) {
      throw new PackagedSeedInstallError(
        "runtime-activation-failed",
        "retry",
        "installed Runtime could not become the live managed Runtime",
      );
    }
    return {
      status: "installed",
      runtimeVersion: seed.manifest.runtime_version,
      versionDirectory,
      requiredDiskBytes,
      errorCode: null,
      action: null,
    };
  } catch (error) {
    if (publishedVersionPath !== null && !pointerPublished) {
      await removeRuntimeOwnedPath(
        options.paths.root,
        publishedVersionPath,
      ).catch(() => undefined);
    }
    return failureResult(
      asInstallError(
        error,
        "runtime-install-failed",
        "retry",
        "cannot install packaged Runtime Seed",
      ),
      seed.manifest.runtime_version,
      requiredDiskBytes,
    );
  } finally {
    if (transactionCreated) {
      await removeRuntimeOwnedPath(options.paths.root, transaction).catch(
        () => undefined,
      );
    }
  }
}
