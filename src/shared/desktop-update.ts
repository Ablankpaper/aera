/**
 * The only public updater failure/event contract.  Main may retain detailed
 * diagnostics in its private log, but this value is safe to cross IPC and to
 * place in an external diagnostic bundle.
 */
export type DesktopUpdateStageNameV2 =
  | "metadata"
  | "download"
  | "verify"
  | "extract"
  | "stage"
  | "swap"
  | "launch"
  | "health"
  | "finalize"
  | "rollback";

export type DesktopUpdateStateV2 =
  | "started"
  | "succeeded"
  | "failed"
  | "rolled_back";

export type DesktopUpdateCodeV2 =
  | "update_origin_unavailable"
  | "update_metadata_unavailable"
  | "update_metadata_invalid"
  | "update_artifact_unavailable"
  | "update_artifact_size_mismatch"
  | "update_artifact_hash_mismatch"
  | "update_signature_invalid"
  | "update_redirect_rejected"
  | "update_extract_failed"
  | "update_staged_identity_invalid"
  | "update_staged_native_invalid"
  | "update_swap_failed"
  | "update_launch_failed"
  | "update_health_timeout"
  | "update_rollback_failed"
  | "update_client_bridge_required"
  | "update_cancelled";

export type DesktopUpdateRetryabilityV2 =
  | "retryable"
  | "after_restart"
  | "after_user_action"
  | "not_retryable";

export interface DesktopUpdateStageV2 {
  schemaVersion: 2;
  operationId: string;
  stage: DesktopUpdateStageNameV2;
  state: DesktopUpdateStateV2;
  code: DesktopUpdateCodeV2 | null;
  retryability: DesktopUpdateRetryabilityV2;
  diagnosticId: string;
  targetVersion: string | null;
}

export const DESKTOP_UPDATE_CODES = [
  "update_origin_unavailable",
  "update_metadata_unavailable",
  "update_metadata_invalid",
  "update_artifact_unavailable",
  "update_artifact_size_mismatch",
  "update_artifact_hash_mismatch",
  "update_signature_invalid",
  "update_redirect_rejected",
  "update_extract_failed",
  "update_staged_identity_invalid",
  "update_staged_native_invalid",
  "update_swap_failed",
  "update_launch_failed",
  "update_health_timeout",
  "update_rollback_failed",
  "update_client_bridge_required",
  "update_cancelled",
] as const satisfies readonly DesktopUpdateCodeV2[];

export const DESKTOP_UPDATE_STAGES = [
  "metadata",
  "download",
  "verify",
  "extract",
  "stage",
  "swap",
  "launch",
  "health",
  "finalize",
  "rollback",
] as const satisfies readonly DesktopUpdateStageNameV2[];

const CODES: ReadonlySet<string> = new Set(DESKTOP_UPDATE_CODES);
const STAGES: ReadonlySet<string> = new Set(DESKTOP_UPDATE_STAGES);

const STATES: ReadonlySet<string> = new Set([
  "started",
  "succeeded",
  "failed",
  "rolled_back",
]);

const DIAGNOSTIC_ID = /^[0-9a-f]{12}$/u;

export function desktopUpdateRetryability(
  code: DesktopUpdateCodeV2 | null,
): DesktopUpdateRetryabilityV2 {
  switch (code) {
    case "update_metadata_unavailable":
    case "update_artifact_unavailable":
    case "update_artifact_size_mismatch":
    case "update_artifact_hash_mismatch":
    case "update_extract_failed":
    case "update_cancelled":
      return "retryable";
    case "update_swap_failed":
    case "update_launch_failed":
    case "update_health_timeout":
    case "update_staged_native_invalid":
      return "after_restart";
    case "update_origin_unavailable":
    case "update_client_bridge_required":
      return "after_user_action";
    case "update_metadata_invalid":
    case "update_signature_invalid":
    case "update_redirect_rejected":
    case "update_staged_identity_invalid":
    case "update_rollback_failed":
      return "not_retryable";
    case null:
      return "not_retryable";
  }
}

export function desktopUpdateDiagnosticId(): string {
  // This is deliberately dependency-free so the same contract can be used by
  // the Main process and the browser bundle.  It is not an identity or a
  // timestamp; it only correlates one local operation's redacted evidence.
  const cryptoObject = globalThis.crypto;
  if (cryptoObject?.getRandomValues) {
    const bytes = new Uint8Array(6);
    cryptoObject.getRandomValues(bytes);
    return Array.from(bytes, (value) =>
      value.toString(16).padStart(2, "0"),
    ).join("");
  }
  return "000000000000";
}

export function desktopUpdateStageV2(input: {
  operationId: string;
  stage: DesktopUpdateStageNameV2;
  state: DesktopUpdateStateV2;
  code: DesktopUpdateCodeV2 | null;
  targetVersion: string | null;
  diagnosticId?: string;
}): DesktopUpdateStageV2 {
  const inputKeys = Object.keys(input).sort();
  const allowedInputKeys = [
    "code",
    "diagnosticId",
    "operationId",
    "stage",
    "state",
    "targetVersion",
  ].sort();
  if (inputKeys.some((key) => !allowedInputKeys.includes(key))) {
    throw new Error("Updater event contains an unknown field.");
  }
  const diagnosticId = input.diagnosticId ?? desktopUpdateDiagnosticId();
  if (!input.operationId || input.operationId.length > 128) {
    throw new Error("Invalid updater operation id.");
  }
  if (!STAGES.has(input.stage) || !STATES.has(input.state)) {
    throw new Error("Invalid updater stage or state.");
  }
  if (input.code !== null && !CODES.has(input.code)) {
    throw new Error("Invalid updater failure code.");
  }
  if (!DIAGNOSTIC_ID.test(diagnosticId)) {
    throw new Error("Invalid updater diagnostic id.");
  }
  if (input.targetVersion !== null && input.targetVersion.length > 128) {
    throw new Error("Invalid updater target version.");
  }
  return {
    schemaVersion: 2,
    operationId: input.operationId,
    stage: input.stage,
    state: input.state,
    code: input.code,
    retryability: desktopUpdateRetryability(input.code),
    diagnosticId,
    targetVersion: input.targetVersion,
  };
}

export function isDesktopUpdateStageV2(
  value: unknown,
): value is DesktopUpdateStageV2 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate).sort();
  const expected = [
    "code",
    "diagnosticId",
    "operationId",
    "retryability",
    "schemaVersion",
    "stage",
    "state",
    "targetVersion",
  ].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expected)) return false;
  if (candidate.schemaVersion !== 2) return false;
  if (typeof candidate.operationId !== "string" || !candidate.operationId) {
    return false;
  }
  if (typeof candidate.stage !== "string" || !STAGES.has(candidate.stage)) {
    return false;
  }
  if (typeof candidate.state !== "string" || !STATES.has(candidate.state)) {
    return false;
  }
  if (
    candidate.code !== null &&
    (typeof candidate.code !== "string" || !CODES.has(candidate.code))
  ) {
    return false;
  }
  if (
    typeof candidate.retryability !== "string" ||
    candidate.retryability !==
      desktopUpdateRetryability(candidate.code as DesktopUpdateCodeV2 | null)
  ) {
    return false;
  }
  if (
    typeof candidate.diagnosticId !== "string" ||
    !DIAGNOSTIC_ID.test(candidate.diagnosticId)
  ) {
    return false;
  }
  return (
    candidate.targetVersion === null ||
    typeof candidate.targetVersion === "string"
  );
}

export function parseDesktopUpdateStageV2(
  value: unknown,
): DesktopUpdateStageV2 | null {
  return isDesktopUpdateStageV2(value) ? value : null;
}
