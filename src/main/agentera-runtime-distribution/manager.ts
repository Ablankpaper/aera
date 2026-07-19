import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import type { RuntimeDistributionPublicState } from "../../shared/agentera-runtime-distribution";
import {
  RuntimeDownloadCancelledError,
  downloadWithResume,
  type RuntimeDownloadRequest,
} from "./downloader";
import {
  extractRuntimeArchive,
  type ExtractRuntimeArchiveOptions,
  type RuntimeExtractionResult,
} from "./extractor";
import {
  RUNTIME_MANIFEST_METADATA_NAME,
  RUNTIME_SIGNATURE_METADATA_NAME,
  verifyRuntimeArtifact,
  type RuntimeManifest,
  type RuntimeManifestValidationContext,
} from "./manifest";
import {
  assertRuntimeOwnedPath,
  ensureRuntimeDistributionDirectories,
  resolveRuntimeVersionDirectory,
  type RuntimeDistributionPaths,
} from "./paths";
import {
  RuntimeStateStore,
  removeRuntimeOwnedPath,
  type CandidatePointer,
  type RuntimeDistributionState,
} from "./state-store";
import {
  checkStableRuntimeUpdate,
  type RuntimeUpdateContext,
  type RuntimeUpdateOffer,
} from "./update-client";

export {
  RUNTIME_MANIFEST_METADATA_NAME,
  RUNTIME_SIGNATURE_METADATA_NAME,
} from "./manifest";
export const RUNTIME_LAST_FAILURE_NAME = "last-runtime-failure.json";

type RuntimeUpdateCheck = (
  context: RuntimeUpdateContext,
) => Promise<RuntimeUpdateOffer | null>;
type RuntimeDownloader = (request: RuntimeDownloadRequest) => Promise<void>;
type RuntimeExtractor = (
  options: ExtractRuntimeArchiveOptions,
) => Promise<RuntimeExtractionResult>;

export interface RuntimeDistributionManagerOptions {
  paths: RuntimeDistributionPaths;
  trustedPublicKeys: ReadonlyMap<string, string>;
  manifestContext: RuntimeManifestValidationContext;
  stateStore?: RuntimeStateStore;
  checkUpdate?: RuntimeUpdateCheck;
  download?: RuntimeDownloader;
  extractor?: RuntimeExtractor;
  now?: () => Date;
  randomId?: () => string;
  activeRunCount?: () => number;
  beginRuntimeTransition?: () => boolean;
  cancelRuntimeTransition?: () => void;
  stopRuntimeContext?: () => void | Promise<void>;
  relaunch?: () => void | Promise<void>;
  isExternalRuntime?: () => boolean;
  repair?: () => Promise<{
    success: boolean;
    runtimeVersion: string | null;
    errorCode: string | null;
  }>;
}

export interface RuntimeDistributionManager {
  initialize(): Promise<RuntimeDistributionPublicState>;
  getState(): Promise<RuntimeDistributionPublicState>;
  check(): Promise<RuntimeDistributionPublicState>;
  downloadConfirmed(): Promise<RuntimeDistributionPublicState>;
  cancelDownload(): Promise<RuntimeDistributionPublicState>;
  restartToApply(): Promise<RuntimeDistributionPublicState>;
  retryRepair(): Promise<RuntimeDistributionPublicState>;
  subscribe(
    listener: (state: RuntimeDistributionPublicState) => void,
  ): () => void;
}

function safeRandomFragment(randomId: () => string): string {
  const value = randomId()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 12);
  if (value.length < 8) {
    throw new Error("Runtime update transaction id is invalid");
  }
  return value;
}

function extractedBytes(manifest: RuntimeManifest): number {
  let total = 0;
  for (const entry of manifest.files) {
    if (entry.kind !== "file") continue;
    total += entry.size;
    if (!Number.isSafeInteger(total)) {
      throw new Error("Runtime update extracted size is too large");
    }
  }
  return total;
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

function createBaseState(
  journal: RuntimeDistributionState,
  candidateFailureCode: string | null,
): RuntimeDistributionPublicState {
  const candidate = journal.candidate;
  const current = journal.current;
  const candidateReady =
    candidate !== null &&
    !candidate.applyOnNextLaunch &&
    candidateFailureCode === null;
  return {
    phase:
      candidateFailureCode !== null
        ? "rollback"
        : candidateReady
          ? "candidate-ready"
          : current === null
            ? "missing"
            : "current",
    currentVersion: current?.runtimeVersion ?? null,
    currentSourceCommit: current?.sourceCommit ?? null,
    packagedSeedVersion: null,
    availableVersion: candidate?.runtimeVersion ?? null,
    downloadSize: null,
    downloadPercent: null,
    lastCheckedAt: null,
    lastErrorCode: candidateFailureCode,
    canCheck: current !== null && candidate === null,
    canDownload: false,
    canCancel: false,
    canRestart: candidateReady,
  };
}

function createExternalState(): RuntimeDistributionPublicState {
  return {
    phase: "external",
    currentVersion: null,
    currentSourceCommit: null,
    packagedSeedVersion: null,
    availableVersion: null,
    downloadSize: null,
    downloadPercent: null,
    lastCheckedAt: null,
    lastErrorCode: null,
    canCheck: false,
    canDownload: false,
    canCancel: false,
    canRestart: false,
  };
}

async function readCandidateFailureCode(
  paths: RuntimeDistributionPaths,
  candidate: CandidatePointer | null,
): Promise<string | null> {
  if (candidate === null) return null;
  try {
    const value = JSON.parse(
      await readFile(join(paths.failures, RUNTIME_LAST_FAILURE_NAME), "utf8"),
    ) as Record<string, unknown>;
    if (
      value.schemaVersion !== 1 ||
      typeof value.errorCode !== "string" ||
      !/^runtime_[a-z0-9_]+$/.test(value.errorCode) ||
      value.runtimeVersion !== candidate.runtimeVersion ||
      value.sourceCommitShort !== candidate.sourceCommit.slice(0, 12) ||
      typeof value.recordedAt !== "string" ||
      Number.isNaN(Date.parse(value.recordedAt)) ||
      Date.parse(value.recordedAt) < Date.parse(candidate.stagedAt)
    ) {
      return null;
    }
    return value.errorCode;
  } catch {
    return null;
  }
}

function cloneState(
  state: RuntimeDistributionPublicState,
): RuntimeDistributionPublicState {
  return { ...state };
}

function withCapabilities(
  state: RuntimeDistributionPublicState,
): RuntimeDistributionPublicState {
  const phase = state.phase;
  return {
    ...state,
    canCheck: phase === "current",
    canDownload: phase === "update-available",
    canCancel: phase === "downloading",
    canRestart: phase === "candidate-ready",
  };
}

function manifestMatchesOffer(
  manifest: RuntimeManifest,
  offer: RuntimeUpdateOffer,
): boolean {
  return (
    manifest.channel === "stable" &&
    manifest.runtime_version === offer.runtimeVersion &&
    manifest.source_commit === offer.sourceCommit &&
    manifest.archive_name === offer.archiveName &&
    manifest.archive_size === offer.archiveSize &&
    manifest.archive_sha256 === offer.archiveSha256
  );
}

function publicRepairErrorCode(value: string | null): string {
  return value !== null && /^runtime_[a-z0-9_]+$/.test(value)
    ? value
    : "runtime_repair_required";
}

// @lat: [[agentera-runtime-distribution#Update policy]]
export function createRuntimeDistributionManager(
  options: RuntimeDistributionManagerOptions,
): RuntimeDistributionManager {
  const store = options.stateStore ?? new RuntimeStateStore(options.paths);
  const now = options.now ?? (() => new Date());
  const randomId = options.randomId ?? randomUUID;
  const listeners = new Set<(state: RuntimeDistributionPublicState) => void>();
  let state: RuntimeDistributionPublicState | null = null;
  let offer: RuntimeUpdateOffer | null = null;
  let downloadController: AbortController | null = null;
  let operation: Promise<void> = Promise.resolve();

  const publish = (
    next: RuntimeDistributionPublicState,
  ): RuntimeDistributionPublicState => {
    state = withCapabilities(next);
    const snapshot = cloneState(state);
    for (const listener of listeners) {
      try {
        listener(cloneState(snapshot));
      } catch {
        // A renderer listener cannot change the Runtime lifecycle.
      }
    }
    return snapshot;
  };

  const exclusive = async <T>(task: () => Promise<T>): Promise<T> => {
    let release!: () => void;
    const previous = operation;
    operation = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await task();
    } finally {
      release();
    }
  };

  const initialize = async (): Promise<RuntimeDistributionPublicState> => {
    if (state !== null) return cloneState(state);
    if (options.isExternalRuntime?.()) {
      return publish(createExternalState());
    }
    const journal = await store.recover();
    return publish(
      createBaseState(
        journal,
        await readCandidateFailureCode(options.paths, journal.candidate),
      ),
    );
  };

  const getState = async (): Promise<RuntimeDistributionPublicState> => {
    return state === null ? initialize() : cloneState(state);
  };

  const check = (): Promise<RuntimeDistributionPublicState> =>
    exclusive(async () => {
      const currentState = await getState();
      if (
        downloadController !== null ||
        currentState.currentVersion === null ||
        !currentState.canCheck
      ) {
        return currentState;
      }
      publish({
        ...currentState,
        phase: "checking",
        lastErrorCode: null,
      });
      let checkError: string | null = null;
      let checked: RuntimeUpdateOffer | null;
      try {
        checked = await (options.checkUpdate ?? checkStableRuntimeUpdate)({
          currentVersion: currentState.currentVersion,
          currentSourceCommit: currentState.currentSourceCommit,
          repository: options.manifestContext.repository,
          platform: options.manifestContext.platform,
          arch: options.manifestContext.arch,
          desktopVersion: options.manifestContext.desktopVersion,
          trustedPublicKeys: options.trustedPublicKeys,
          signal: new AbortController().signal,
          onCheckError: (code) => {
            checkError = code;
          },
        });
      } catch {
        checked = null;
        checkError = "runtime_update_unavailable";
      }
      offer = checked;
      return publish({
        ...currentState,
        phase: checked === null ? "current" : "update-available",
        availableVersion: checked?.runtimeVersion ?? null,
        downloadSize: checked?.archiveSize ?? null,
        downloadPercent: null,
        lastCheckedAt: now().toISOString(),
        lastErrorCode: checkError,
      });
    });

  const downloadConfirmed = (): Promise<RuntimeDistributionPublicState> =>
    exclusive(async () => {
      const currentState = await getState();
      const selected = offer;
      if (selected === null || currentState.phase !== "update-available") {
        return publish({
          ...currentState,
          lastErrorCode: "runtime_update_not_available",
        });
      }
      const controller = new AbortController();
      downloadController = controller;
      publish({
        ...currentState,
        phase: "downloading",
        downloadPercent: 0,
        lastErrorCode: null,
      });

      let transaction: string | null = null;
      let publishedVersionPath: string | null = null;
      let candidateWritten = false;
      let stage: "download" | "candidate" = "download";
      try {
        await ensureRuntimeDistributionDirectories(options.paths);
        const archivePath = assertRuntimeOwnedPath(
          options.paths.root,
          join(options.paths.downloads, selected.archiveName),
          "Runtime update archive",
        );
        await (options.download ?? downloadWithResume)({
          url: selected.archiveUrl,
          destination: archivePath,
          expectedSize: selected.archiveSize,
          expectedSha256: selected.archiveSha256,
          signal: controller.signal,
          onProgress: (received, total) => {
            if (state?.phase !== "downloading") return;
            publish({
              ...state,
              downloadPercent:
                total === 0 ? null : Math.min(100, (received / total) * 100),
            });
          },
        });

        stage = "candidate";
        const manifest = await verifyRuntimeArtifact({
          archivePath,
          manifestBytes: selected.manifestBytes,
          signatureBytes: selected.signatureBytes,
          trustedPublicKeys: options.trustedPublicKeys,
          context: options.manifestContext,
        });
        if (!manifestMatchesOffer(manifest, selected)) {
          throw new Error(
            "Runtime update offer differs from its signed artifact",
          );
        }
        const fragment = safeRandomFragment(randomId);
        transaction = assertRuntimeOwnedPath(
          options.paths.root,
          join(options.paths.staging, `transaction-update-${fragment}`),
          "Runtime update transaction",
        );
        const payload = assertRuntimeOwnedPath(
          options.paths.root,
          join(transaction, "payload"),
          "Runtime update payload",
        );
        await mkdir(transaction, { recursive: false, mode: 0o700 });
        await (options.extractor ?? extractRuntimeArchive)({
          archivePath,
          destination: payload,
          manifest,
          maxExtractedBytes: extractedBytes(manifest),
          signal: controller.signal,
        });
        await Promise.all([
          writeFile(
            join(payload, RUNTIME_MANIFEST_METADATA_NAME),
            selected.manifestBytes,
            { flag: "wx", mode: 0o600 },
          ),
          writeFile(
            join(payload, RUNTIME_SIGNATURE_METADATA_NAME),
            selected.signatureBytes,
            { flag: "wx", mode: 0o600 },
          ),
        ]);
        const manifestSha256 = createHash("sha256")
          .update(selected.manifestBytes)
          .digest("hex");
        const baseVersionDirectory = [
          manifest.runtime_version,
          manifest.source_commit.slice(0, 12),
          manifestSha256.slice(0, 12),
        ].join("-");
        let versionDirectory = baseVersionDirectory;
        let versionPath = resolveRuntimeVersionDirectory(
          options.paths,
          versionDirectory,
        );
        if (await pathExists(versionPath)) {
          versionDirectory = `${baseVersionDirectory}-retry-${fragment}`;
          versionPath = resolveRuntimeVersionDirectory(
            options.paths,
            versionDirectory,
          );
          if (await pathExists(versionPath)) {
            throw new Error("Runtime update retry directory already exists");
          }
        }
        await rename(payload, versionPath);
        publishedVersionPath = versionPath;
        const timestamp = now().toISOString();
        const candidate: CandidatePointer = {
          schemaVersion: 1,
          runtimeVersion: manifest.runtime_version,
          sourceCommit: manifest.source_commit,
          versionDirectory,
          manifestSha256,
          installedAt: timestamp,
          applyOnNextLaunch: false,
          stagedAt: timestamp,
        };
        await store.stageCandidate(candidate);
        candidateWritten = true;
        await rm(join(options.paths.failures, RUNTIME_LAST_FAILURE_NAME), {
          force: true,
        }).catch(() => undefined);
        return publish({
          ...(state ?? currentState),
          phase: "candidate-ready",
          availableVersion: manifest.runtime_version,
          downloadSize: manifest.archive_size,
          downloadPercent: 100,
          lastErrorCode: null,
        });
      } catch (error) {
        const cancelled =
          controller.signal.aborted ||
          error instanceof RuntimeDownloadCancelledError ||
          (error instanceof Error && error.name === "AbortError");
        if (publishedVersionPath !== null && !candidateWritten) {
          await removeRuntimeOwnedPath(
            options.paths.root,
            publishedVersionPath,
          ).catch(() => undefined);
        }
        return publish({
          ...currentState,
          phase: "update-available",
          availableVersion: selected.runtimeVersion,
          downloadSize: selected.archiveSize,
          downloadPercent: null,
          lastErrorCode: cancelled
            ? null
            : stage === "download"
              ? "runtime_download_failed"
              : "runtime_candidate_invalid",
        });
      } finally {
        downloadController = null;
        if (transaction !== null) {
          await removeRuntimeOwnedPath(options.paths.root, transaction).catch(
            () => undefined,
          );
        }
      }
    });

  const cancelDownload = async (): Promise<RuntimeDistributionPublicState> => {
    downloadController?.abort();
    return getState();
  };

  const restartToApply = (): Promise<RuntimeDistributionPublicState> =>
    exclusive(async () => {
      const currentState = await getState();
      const journal = await store.readState();
      if (journal.candidate === null) {
        return publish({
          ...currentState,
          lastErrorCode: "runtime_candidate_missing",
        });
      }
      const transitionReserved =
        options.beginRuntimeTransition?.() ??
        (options.activeRunCount?.() ?? 0) === 0;
      if (!transitionReserved) {
        return publish({
          ...currentState,
          lastErrorCode: "runtime_tasks_active",
        });
      }
      try {
        await options.stopRuntimeContext?.();
        await store.stageCandidate({
          ...journal.candidate,
          applyOnNextLaunch: true,
        });
        await options.relaunch?.();
        return publish({ ...currentState, lastErrorCode: null });
      } catch {
        if (options.beginRuntimeTransition !== undefined) {
          options.cancelRuntimeTransition?.();
        }
        return publish({
          ...currentState,
          lastErrorCode: "runtime_restart_failed",
        });
      }
    });

  const retryRepair = (): Promise<RuntimeDistributionPublicState> =>
    exclusive(async () => {
      let currentState = await getState();
      let journal = await store.readState();

      if (currentState.phase === "rollback" && journal.candidate !== null) {
        const failedCandidate = journal.candidate;
        await store.clearCandidate();
        await rm(join(options.paths.failures, RUNTIME_LAST_FAILURE_NAME), {
          force: true,
        });
        const stillReferenced = [journal.current, journal.previous].some(
          (pointer) =>
            pointer?.versionDirectory === failedCandidate.versionDirectory,
        );
        if (!stillReferenced) {
          await removeRuntimeOwnedPath(
            options.paths.root,
            resolveRuntimeVersionDirectory(
              options.paths,
              failedCandidate.versionDirectory,
            ),
          ).catch(() => undefined);
        }
        offer = null;
        journal = await store.readState();
        currentState = publish(createBaseState(journal, null));
        if (journal.current !== null) return currentState;
      }

      if (
        currentState.phase !== "missing" &&
        currentState.phase !== "repair-required" &&
        currentState.phase !== "rollback" &&
        currentState.phase !== "external"
      ) {
        return currentState;
      }

      const startedInExternalMode = currentState.phase === "external";
      const transitionReserved =
        options.beginRuntimeTransition?.() ??
        (options.activeRunCount?.() ?? 0) === 0;
      if (!transitionReserved) {
        return publish({
          ...currentState,
          phase: startedInExternalMode ? "external" : "repair-required",
          lastErrorCode: "runtime_tasks_active",
        });
      }
      publish({
        ...currentState,
        phase: "installing",
        lastErrorCode: null,
      });
      try {
        await options.stopRuntimeContext?.();
        const repaired = await options.repair?.();
        if (!repaired?.success || options.isExternalRuntime?.()) {
          return publish({
            ...currentState,
            phase: startedInExternalMode ? "external" : "repair-required",
            lastErrorCode: publicRepairErrorCode(
              repaired?.errorCode ?? "runtime_repair_required",
            ),
          });
        }
        const recovered = await store.recover();
        if (recovered.current === null) {
          return publish({
            ...currentState,
            phase: "repair-required",
            lastErrorCode: "runtime_repair_required",
          });
        }
        offer = null;
        return publish({
          ...createBaseState(
            recovered,
            await readCandidateFailureCode(options.paths, recovered.candidate),
          ),
          packagedSeedVersion: repaired.runtimeVersion,
        });
      } catch {
        return publish({
          ...currentState,
          phase: startedInExternalMode ? "external" : "repair-required",
          lastErrorCode: "runtime_repair_required",
        });
      } finally {
        if (options.beginRuntimeTransition !== undefined) {
          options.cancelRuntimeTransition?.();
        }
      }
    });

  return {
    initialize,
    getState,
    check,
    downloadConfirmed,
    cancelDownload,
    restartToApply,
    retryRepair,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
