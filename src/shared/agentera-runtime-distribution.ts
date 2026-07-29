export type RuntimeDistributionPhase =
  | "missing"
  | "installing"
  | "current"
  | "checking"
  | "update-available"
  | "downloading"
  | "candidate-ready"
  | "rollback"
  | "repair-required"
  | "external";

export interface RuntimeDistributionPublicState {
  phase: RuntimeDistributionPhase;
  currentVersion: string | null;
  currentSourceCommit: string | null;
  packagedSeedVersion: string | null;
  availableVersion: string | null;
  downloadSize: number | null;
  downloadPercent: number | null;
  lastCheckedAt: string | null;
  lastErrorCode: string | null;
  canCheck: boolean;
  canDownload: boolean;
  canCancel: boolean;
  canRestart: boolean;
}

const RUNTIME_DISTRIBUTION_PHASES = new Set<RuntimeDistributionPhase>([
  "missing",
  "installing",
  "current",
  "checking",
  "update-available",
  "downloading",
  "candidate-ready",
  "rollback",
  "repair-required",
  "external",
]);

function nullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > 256) {
    throw new Error(`Aera Runtime state has an invalid ${field}.`);
  }
  return value;
}

function nullableVersion(value: unknown, field: string): string | null {
  const version = nullableString(value, field);
  if (version !== null && !/^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$/.test(version)) {
    throw new Error(`Aera Runtime state has an invalid ${field}.`);
  }
  return version;
}

function nullableCommit(value: unknown): string | null {
  const commit = nullableString(value, "currentSourceCommit");
  if (commit !== null && !/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error(
      "Aera Runtime state has an invalid currentSourceCommit.",
    );
  }
  return commit;
}

function nullableTimestamp(value: unknown): string | null {
  const timestamp = nullableString(value, "lastCheckedAt");
  if (
    timestamp !== null &&
    (!timestamp.endsWith("Z") || Number.isNaN(Date.parse(timestamp)))
  ) {
    throw new Error("Aera Runtime state has an invalid lastCheckedAt.");
  }
  return timestamp;
}

function nullableErrorCode(value: unknown): string | null {
  const code = nullableString(value, "lastErrorCode");
  if (code !== null && !/^runtime_[a-z0-9_]+$/.test(code)) {
    throw new Error("Aera Runtime state has an invalid lastErrorCode.");
  }
  return code;
}

function nullableNumber(value: unknown, field: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`Aera Runtime state has an invalid ${field}.`);
  }
  return value;
}

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`Aera Runtime state has an invalid ${field}.`);
  }
  return value;
}

/**
 * Rebuild the renderer-visible Runtime lifecycle from a strict allowlist.
 * Internal download URLs, filesystem paths, signatures, and ownership data
 * must never cross the preload boundary through an accidental object spread.
 */
export function serializeRuntimeDistributionPublicState(
  input: RuntimeDistributionPublicState,
): RuntimeDistributionPublicState {
  const value = input as unknown as Record<string, unknown>;
  const phase = value.phase;
  if (
    typeof phase !== "string" ||
    !RUNTIME_DISTRIBUTION_PHASES.has(phase as RuntimeDistributionPhase)
  ) {
    throw new Error("Aera Runtime state has an invalid phase.");
  }
  return {
    phase: phase as RuntimeDistributionPhase,
    currentVersion: nullableVersion(value.currentVersion, "currentVersion"),
    currentSourceCommit: nullableCommit(value.currentSourceCommit),
    packagedSeedVersion: nullableVersion(
      value.packagedSeedVersion,
      "packagedSeedVersion",
    ),
    availableVersion: nullableVersion(
      value.availableVersion,
      "availableVersion",
    ),
    downloadSize: nullableNumber(value.downloadSize, "downloadSize"),
    downloadPercent: nullableNumber(value.downloadPercent, "downloadPercent"),
    lastCheckedAt: nullableTimestamp(value.lastCheckedAt),
    lastErrorCode: nullableErrorCode(value.lastErrorCode),
    canCheck: booleanValue(value.canCheck, "canCheck"),
    canDownload: booleanValue(value.canDownload, "canDownload"),
    canCancel: booleanValue(value.canCancel, "canCancel"),
    canRestart: booleanValue(value.canRestart, "canRestart"),
  };
}
