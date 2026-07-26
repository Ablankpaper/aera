export type AgenteraAuthBlockReason =
  | "sign_in_required"
  | "offline_expired"
  | "clock_rollback"
  | "device_revoked"
  | "account_disabled"
  | "account_pending_deletion"
  | "secure_storage_unavailable";

export type AgenteraPortalTarget = "account" | "devices" | "recharge";

export type AgenteraAuthPublicState =
  | { status: "checking" }
  | { status: "unauthenticated"; reason?: AgenteraAuthBlockReason }
  | {
      status: "authenticated" | "offline";
      userId: string;
      personalSpaceId: string;
      deviceId: string;
      offlineExpiresAt: string;
      cloudAvailable: boolean;
    }
  | { status: "blocked"; reason: AgenteraAuthBlockReason };

export type AgenteraSignedInAuthState = Extract<
  AgenteraAuthPublicState,
  { status: "authenticated" | "offline" }
>;

export type AgenteraGuestAuthState = Extract<
  AgenteraAuthPublicState,
  { status: "unauthenticated" }
>;

export type AgenteraDesktopAccessState =
  | AgenteraSignedInAuthState
  | AgenteraGuestAuthState;

export function hasAgenteraSignedInAccess(
  state: AgenteraAuthPublicState,
): state is AgenteraSignedInAuthState {
  return state.status === "authenticated" || state.status === "offline";
}

export function hasAgenteraGuestAccess(
  state: AgenteraAuthPublicState,
): state is AgenteraGuestAuthState {
  return state.status === "unauthenticated";
}

export function hasAgenteraDesktopAccess(
  state: AgenteraAuthPublicState,
): state is AgenteraDesktopAccessState {
  return hasAgenteraSignedInAccess(state) || hasAgenteraGuestAccess(state);
}

const BLOCK_REASONS = new Set<AgenteraAuthBlockReason>([
  "sign_in_required",
  "offline_expired",
  "clock_rollback",
  "device_revoked",
  "account_disabled",
  "account_pending_deletion",
  "secure_storage_unavailable",
]);

function validReason(value: unknown): value is AgenteraAuthBlockReason {
  return (
    typeof value === "string" &&
    BLOCK_REASONS.has(value as AgenteraAuthBlockReason)
  );
}

/**
 * Rebuild the renderer-visible state from an explicit allowlist. The main
 * process may carry richer internal objects, so spreading an input object over
 * IPC would risk exposing a token, key, authorization code, or encrypted blob.
 */
export function serializeAgenteraAuthPublicState(
  state: AgenteraAuthPublicState,
): AgenteraAuthPublicState {
  switch (state.status) {
    case "checking":
      return { status: "checking" };
    case "unauthenticated":
      if (state.reason === undefined) return { status: "unauthenticated" };
      if (!validReason(state.reason)) {
        throw new Error("AgentEra authentication state has an invalid reason.");
      }
      return { status: "unauthenticated", reason: state.reason };
    case "authenticated":
    case "offline":
      return {
        status: state.status,
        userId: state.userId,
        personalSpaceId: state.personalSpaceId,
        deviceId: state.deviceId,
        offlineExpiresAt: state.offlineExpiresAt,
        cloudAvailable: state.cloudAvailable,
      };
    case "blocked":
      if (!validReason(state.reason)) {
        throw new Error("AgentEra authentication state has an invalid reason.");
      }
      return { status: "blocked", reason: state.reason };
    default:
      throw new Error("AgentEra authentication state has an invalid status.");
  }
}
