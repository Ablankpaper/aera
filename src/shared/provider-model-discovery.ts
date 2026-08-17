/**
 * Renderer-safe contract for provider model discovery.
 *
 * A discovery response is deliberately a discriminated, versioned value.  A
 * transport failure must never look like an empty successful catalogue: the
 * distinction controls cache writes and what the UI is allowed to display.
 */

export type ProviderDiscoveryStatusV2 =
  | "success_with_models"
  | "success_empty"
  | "credential_missing"
  | "authentication_rejected"
  | "forbidden"
  | "not_found"
  | "rate_limited"
  | "upstream_error"
  | "malformed_response"
  | "dns_error"
  | "connection_error"
  | "tls_error"
  | "timeout"
  | "cancelled"
  | "unsupported_provider"
  | "unknown_endpoint";

export type ProviderDiscoveryHttpStatusV2 =
  | "success_with_models"
  | "success_empty"
  | "authentication_rejected"
  | "forbidden"
  | "not_found"
  | "rate_limited"
  | "upstream_error"
  | "malformed_response";

export interface ProviderDiscoveryResultV2 {
  schemaVersion: 2;
  status: ProviderDiscoveryStatusV2;
  models: string[];
  cached: boolean;
  statusCode?: number;
  /** Reserved for the post-refresh 401 contract owned by PR-F. */
  code?: "provider_authentication_rejected";
  freeModels?: string[];
  diagnosticId?: string;
}

export interface ProviderDiscoverySuccessOptions {
  cached?: boolean;
  statusCode?: number;
  freeModels?: readonly string[];
}

export interface ProviderDiscoveryFailureOptions {
  /** Accepted for callers that are converting an untrusted value; ignored. */
  models?: readonly string[];
  /** Accepted for callers that are converting an untrusted value; ignored. */
  cached?: boolean;
  statusCode?: number;
  code?: "provider_authentication_rejected";
  diagnosticId?: string;
}

const SUCCESS_STATUSES = new Set<ProviderDiscoveryStatusV2>([
  "success_with_models",
  "success_empty",
]);

const HTTP_STATUSES = new Set<ProviderDiscoveryStatusV2>([
  "success_with_models",
  "success_empty",
  "authentication_rejected",
  "forbidden",
  "not_found",
  "rate_limited",
  "upstream_error",
  "malformed_response",
]);

const STATUS_SET = new Set<ProviderDiscoveryStatusV2>([
  "success_with_models",
  "success_empty",
  "credential_missing",
  "authentication_rejected",
  "forbidden",
  "not_found",
  "rate_limited",
  "upstream_error",
  "malformed_response",
  "dns_error",
  "connection_error",
  "tls_error",
  "timeout",
  "cancelled",
  "unsupported_provider",
  "unknown_endpoint",
]);

function isValidStatusCode(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 100 &&
    value <= 599
  );
}

function normalizeModels(values: readonly string[]): string[] {
  return Array.from(
    new Set(
      values
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ).sort();
}

function optionalStatusCode(
  status: ProviderDiscoveryStatusV2,
  statusCode: unknown,
): number | undefined {
  if (!HTTP_STATUSES.has(status) || !isValidStatusCode(statusCode)) {
    return undefined;
  }
  return statusCode;
}

function optionalDiagnosticId(value: unknown): string | undefined {
  return typeof value === "string" && /^md-[0-9a-f]{12}$/.test(value)
    ? value
    : undefined;
}

/** Generate an opaque, non-secret identifier for malformed IPC diagnostics. */
export function createProviderDiscoveryDiagnosticId(): string {
  try {
    const randomUUID = globalThis.crypto?.randomUUID;
    if (typeof randomUUID === "function") {
      return `md-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    }
  } catch {
    // Fall through to the bounded fallback below.
  }
  let fragment = "";
  while (fragment.length < 12) {
    fragment += Math.floor(Math.random() * 16).toString(16);
  }
  return `md-${fragment.slice(0, 12)}`;
}

/** Construct a verified 2xx catalogue result. */
export function providerDiscoverySuccess(
  models: readonly string[],
  options: ProviderDiscoverySuccessOptions = {},
): ProviderDiscoveryResultV2 {
  const normalizedModels = normalizeModels(models);
  const result: ProviderDiscoveryResultV2 = {
    schemaVersion: 2,
    status:
      normalizedModels.length > 0 ? "success_with_models" : "success_empty",
    models: normalizedModels,
    cached: options.cached === true,
  };
  const statusCode = optionalStatusCode(result.status, options.statusCode);
  if (statusCode !== undefined) result.statusCode = statusCode;
  const freeModels = normalizeModels(options.freeModels ?? []).filter((id) =>
    normalizedModels.includes(id),
  );
  if (freeModels.length > 0) result.freeModels = freeModels;
  return result;
}

/** Construct a failure result that cannot claim cached or successful data. */
export function providerDiscoveryFailure(
  status: Exclude<ProviderDiscoveryStatusV2, "success_with_models" | "success_empty">,
  options: ProviderDiscoveryFailureOptions = {},
): ProviderDiscoveryResultV2 {
  const result: ProviderDiscoveryResultV2 = {
    schemaVersion: 2,
    status,
    models: [],
    cached: false,
  };
  const statusCode = optionalStatusCode(status, options.statusCode);
  if (statusCode !== undefined) result.statusCode = statusCode;
  if (status === "authentication_rejected") {
    result.code = "provider_authentication_rejected";
  }
  const diagnosticId = optionalDiagnosticId(options.diagnosticId);
  if (diagnosticId) result.diagnosticId = diagnosticId;
  return result;
}

/** True only for the two statuses that represent a verified catalogue. */
export function isProviderDiscoverySuccess(
  value: ProviderDiscoveryResultV2 | ProviderDiscoveryStatusV2,
): boolean {
  const status = typeof value === "string" ? value : value.status;
  return SUCCESS_STATUSES.has(status);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate and redact a value crossing the Main/preload boundary.
 *
 * Unknown or internally inconsistent values are converted to a generic
 * connection error with a short diagnostic id.  Response bodies, URLs and
 * credentials are intentionally never copied into the returned value.
 */
export function parseProviderDiscoveryResult(
  value: unknown,
): ProviderDiscoveryResultV2 {
  if (!isRecord(value)) return invalidDiscoveryResult();
  if (value.schemaVersion !== 2) return invalidDiscoveryResult();
  if (!STATUS_SET.has(value.status as ProviderDiscoveryStatusV2)) {
    return invalidDiscoveryResult();
  }
  if (typeof value.cached !== "boolean" || !Array.isArray(value.models)) {
    return invalidDiscoveryResult();
  }
  if (!value.models.every((model) => typeof model === "string")) {
    return invalidDiscoveryResult();
  }

  const status = value.status as ProviderDiscoveryStatusV2;
  const models = normalizeModels(value.models as string[]);
  if (SUCCESS_STATUSES.has(status)) {
    if (status === "success_with_models" && models.length === 0) {
      return invalidDiscoveryResult();
    }
    if (status === "success_empty" && models.length !== 0) {
      return invalidDiscoveryResult();
    }
  } else if (models.length !== 0 || value.cached !== false) {
    return invalidDiscoveryResult();
  }

  if (
    value.statusCode !== undefined &&
    (!HTTP_STATUSES.has(status) || !isValidStatusCode(value.statusCode))
  ) {
    return invalidDiscoveryResult();
  }
  if (
    value.freeModels !== undefined &&
    (!Array.isArray(value.freeModels) ||
      !value.freeModels.every((model) => typeof model === "string"))
  ) {
    return invalidDiscoveryResult();
  }
  if (
    value.code !== undefined &&
    value.code !== "provider_authentication_rejected"
  ) {
    return invalidDiscoveryResult();
  }

  const result: ProviderDiscoveryResultV2 = {
    schemaVersion: 2,
    status,
    models,
    cached: status === "success_with_models" || status === "success_empty"
      ? value.cached
      : false,
  };
  if (value.statusCode !== undefined) result.statusCode = value.statusCode;
  const freeModels = normalizeModels((value.freeModels as string[]) ?? []).filter(
    (id) => models.includes(id),
  );
  if (freeModels.length > 0) result.freeModels = freeModels;
  if (value.code === "provider_authentication_rejected") {
    if (status !== "authentication_rejected") return invalidDiscoveryResult();
    result.code = value.code;
  }
  const diagnosticId = optionalDiagnosticId(value.diagnosticId);
  if (value.diagnosticId !== undefined && !diagnosticId) {
    return invalidDiscoveryResult();
  }
  if (diagnosticId) result.diagnosticId = diagnosticId;
  return result;
}

function invalidDiscoveryResult(): ProviderDiscoveryResultV2 {
  return providerDiscoveryFailure("connection_error", {
    diagnosticId: createProviderDiscoveryDiagnosticId(),
  });
}

