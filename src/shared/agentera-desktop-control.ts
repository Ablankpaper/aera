import type { components } from "./agentera-cloud-api.generated";

export type DesktopHealthCode =
  components["schemas"]["DesktopHealthSummary"]["code"];
export type DesktopHealthSummary =
  components["schemas"]["DesktopHealthSummary"];
export type DesktopControlConnectionStatus =
  | "unregistered"
  | "connecting"
  | "online"
  | "offline"
  | "needs_reauth"
  | "degraded";
export type DesktopControlPublicErrorCode =
  | "network_unavailable"
  | "rate_limited"
  | "service_unavailable"
  | "session_revoked"
  | "device_not_found"
  | "account_disabled"
  | "account_pending_deletion"
  | "invalid_response"
  | "request_timeout";

export interface DesktopControlPublicHealth {
  state: "succeeded" | "failed";
  code: DesktopHealthCode;
  completedAt: string;
}

export interface DesktopControlPublicState {
  status: DesktopControlConnectionStatus;
  lastHeartbeatAt: string | null;
  lastErrorCode: DesktopControlPublicErrorCode | null;
  lastHealth: DesktopControlPublicHealth | null;
}

const STATUSES = new Set<DesktopControlConnectionStatus>([
  "unregistered",
  "connecting",
  "online",
  "offline",
  "needs_reauth",
  "degraded",
]);
const HEALTH_CODES = new Set<DesktopHealthCode>([
  "HEALTHY",
  "DESKTOP_UNHEALTHY",
  "RUNTIME_UNAVAILABLE",
  "GATEWAY_UNAVAILABLE",
  "HEALTH_CHECK_TIMEOUT",
  "CLIENT_INTERRUPTED",
]);
const ERROR_CODES = new Set<DesktopControlPublicErrorCode>([
  "network_unavailable",
  "rate_limited",
  "service_unavailable",
  "session_revoked",
  "device_not_found",
  "account_disabled",
  "account_pending_deletion",
  "invalid_response",
  "request_timeout",
]);

function validIso(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 64 &&
    Number.isFinite(Date.parse(value))
  );
}

export function serializeDesktopControlPublicState(
  input: DesktopControlPublicState,
): DesktopControlPublicState {
  if (!STATUSES.has(input.status)) {
    throw new Error("Desktop control state has an invalid status.");
  }
  if (input.lastHeartbeatAt !== null && !validIso(input.lastHeartbeatAt)) {
    throw new Error("Desktop control state has an invalid heartbeat time.");
  }
  if (input.lastErrorCode !== null && !ERROR_CODES.has(input.lastErrorCode)) {
    throw new Error("Desktop control state has an invalid error code.");
  }
  let lastHealth: DesktopControlPublicHealth | null = null;
  if (input.lastHealth !== null) {
    if (
      (input.lastHealth.state !== "succeeded" &&
        input.lastHealth.state !== "failed") ||
      !HEALTH_CODES.has(input.lastHealth.code) ||
      !validIso(input.lastHealth.completedAt)
    ) {
      throw new Error("Desktop control state has an invalid health result.");
    }
    lastHealth = {
      state: input.lastHealth.state,
      code: input.lastHealth.code,
      completedAt: input.lastHealth.completedAt,
    };
  }
  return {
    status: input.status,
    lastHeartbeatAt: input.lastHeartbeatAt,
    lastErrorCode: input.lastErrorCode,
    lastHealth,
  };
}
