import type { components } from "../../shared/agentera-cloud-api.generated";

const RESPONSE_LIMIT = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type DesktopHeartbeatRequest =
  components["schemas"]["DesktopHeartbeatRequest"];
export type DesktopHeartbeatReceipt =
  components["schemas"]["DesktopHeartbeatReceipt"];
export type DesktopCommand = components["schemas"]["DesktopControlCommand"];
export type DesktopCommandResultRequest =
  components["schemas"]["DesktopCommandResultRequest"];

export class AgenteraDesktopControlError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfterSeconds: number | null;

  constructor(
    status: number,
    code: string,
    retryAfterSeconds: number | null = null,
  ) {
    super(`Desktop control request failed: ${code}.`);
    this.name = "AgenteraDesktopControlError";
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface AgenteraDesktopControlClientOptions {
  origin: string;
  getAccessToken: () => string | null;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const ERROR_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

function safeErrorCode(body: string): string {
  if (body.length > RESPONSE_LIMIT) return "response_too_large";
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    const nested =
      parsed.error && typeof parsed.error === "object"
        ? (parsed.error as { code?: unknown }).code
        : parsed.error;
    return typeof nested === "string" && ERROR_CODE_PATTERN.test(nested)
      ? nested
      : "request_failed";
  } catch {
    return "request_failed";
  }
}

function isoDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function healthSummary(
  value: unknown,
): value is components["schemas"]["DesktopHealthSummary"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).every((key) =>
      [
        "desktop_status",
        "runtime_status",
        "gateway_status",
        "code",
        "duration_ms",
      ].includes(key),
    ) &&
    typeof record.desktop_status === "string" &&
    typeof record.runtime_status === "string" &&
    typeof record.gateway_status === "string" &&
    ["unknown", "healthy", "degraded", "unhealthy"].includes(
      record.desktop_status,
    ) &&
    ["unknown", "healthy", "degraded", "unhealthy"].includes(
      record.runtime_status,
    ) &&
    ["unknown", "healthy", "degraded", "unhealthy"].includes(
      record.gateway_status,
    ) &&
    [
      "HEALTHY",
      "DESKTOP_UNHEALTHY",
      "RUNTIME_UNAVAILABLE",
      "GATEWAY_UNAVAILABLE",
      "HEALTH_CHECK_TIMEOUT",
      "CLIENT_INTERRUPTED",
    ].includes(record.code as string) &&
    typeof record.duration_ms === "number" &&
    Number.isInteger(record.duration_ms) &&
    record.duration_ms >= 0 &&
    record.duration_ms <= 120_000
  );
}

function command(value: unknown): value is DesktopCommand {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  const allowed = [
    "command_id",
    "type",
    "state",
    "expires_at",
    "claimed_at",
    "started_at",
    "completed_at",
    "code",
    "summary",
    "replayed",
  ];
  return (
    keys.every((key) => allowed.includes(key)) &&
    UUID_PATTERN.test(String(record.command_id)) &&
    record.type === "health_check" &&
    ["queued", "claimed", "running", "succeeded", "failed", "expired"].includes(
      record.state as string,
    ) &&
    isoDate(record.expires_at) &&
    (record.claimed_at === undefined || isoDate(record.claimed_at)) &&
    (record.started_at === undefined || isoDate(record.started_at)) &&
    (record.completed_at === undefined || isoDate(record.completed_at)) &&
    (record.code === undefined || typeof record.code === "string") &&
    (record.summary === undefined || healthSummary(record.summary)) &&
    (record.replayed === undefined || typeof record.replayed === "boolean")
  );
}

function receipt(value: unknown): value is DesktopHeartbeatReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const allowed = [
    "instance_id",
    "accepted_at",
    "next_heartbeat_seconds",
    "effective_status",
    "server_time",
    "command",
  ];
  return (
    Object.keys(record).every((key) => allowed.includes(key)) &&
    UUID_PATTERN.test(String(record.instance_id)) &&
    isoDate(record.accepted_at) &&
    record.next_heartbeat_seconds === 60 &&
    ["pending", "revoked", "disabled", "online", "offline"].includes(
      record.effective_status as string,
    ) &&
    isoDate(record.server_time) &&
    (record.command === null ||
      record.command === undefined ||
      command(record.command))
  );
}

function combineSignals(
  caller: AbortSignal | undefined,
  timeoutMs: number,
): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  caller?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    cleanup: (): void => {
      clearTimeout(timer);
      caller?.removeEventListener("abort", onAbort);
    },
  };
}

export class AgenteraDesktopControlClient {
  readonly origin: string;
  private readonly fetcher: typeof fetch;
  private readonly getAccessToken: () => string | null;
  private readonly timeoutMs: number;

  constructor(options: AgenteraDesktopControlClientOptions) {
    const parsed = new URL(options.origin);
    if (
      parsed.protocol !== "https:" &&
      !["localhost", "127.0.0.1"].includes(parsed.hostname)
    ) {
      throw new Error("Desktop control Cloud origin must use HTTPS.");
    }
    if (
      !Number.isInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS) ||
      (options.timeoutMs ?? DEFAULT_TIMEOUT_MS) < 1
    ) {
      throw new Error("Desktop control timeout is invalid.");
    }
    this.origin = parsed.toString().replace(/\/$/, "");
    this.getAccessToken = options.getAccessToken;
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  heartbeat(
    input: DesktopHeartbeatRequest,
    signal?: AbortSignal,
  ): Promise<DesktopHeartbeatReceipt> {
    return this.request(
      "/api/v1/devices/current/desktop-control/heartbeat",
      input,
      signal,
      receipt,
    );
  }

  submitResult(
    commandId: string,
    input: DesktopCommandResultRequest,
    signal?: AbortSignal,
  ): Promise<DesktopCommand> {
    if (!UUID_PATTERN.test(commandId))
      throw new AgenteraDesktopControlError(400, "invalid_request");
    return this.request(
      `/api/v1/devices/current/desktop-control/commands/${commandId}/result`,
      input,
      signal,
      command,
    );
  }

  private async request<T>(
    path: string,
    input: unknown,
    callerSignal: AbortSignal | undefined,
    parse: (value: unknown) => value is T,
  ): Promise<T> {
    const accessToken = this.getAccessToken();
    if (!accessToken)
      throw new AgenteraDesktopControlError(401, "session_revoked");
    const combined = combineSignals(callerSignal, this.timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.fetcher(`${this.origin}${path}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(input),
          redirect: "error",
          signal: combined.signal,
        });
      } catch {
        if (combined.signal.aborted) {
          throw new AgenteraDesktopControlError(0, "request_timeout");
        }
        throw new AgenteraDesktopControlError(0, "network_unavailable");
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > RESPONSE_LIMIT) {
        throw new AgenteraDesktopControlError(
          response.status,
          "response_too_large",
        );
      }
      const body = new TextDecoder().decode(bytes);
      if (!response.ok) {
        const retryAfter = Number.parseInt(
          response.headers.get("Retry-After") ?? "",
          10,
        );
        throw new AgenteraDesktopControlError(
          response.status,
          safeErrorCode(body),
          Number.isFinite(retryAfter)
            ? Math.max(1, Math.min(300, retryAfter))
            : null,
        );
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        throw new AgenteraDesktopControlError(
          response.status,
          "invalid_response",
        );
      }
      if (!parse(parsed))
        throw new AgenteraDesktopControlError(
          response.status,
          "invalid_response",
        );
      return parsed;
    } finally {
      combined.cleanup();
    }
  }
}
