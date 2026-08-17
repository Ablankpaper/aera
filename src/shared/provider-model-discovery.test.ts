import { describe, expect, it } from "vitest";
import {
  isProviderDiscoverySuccess,
  parseProviderDiscoveryResult,
  providerDiscoveryFailure,
  providerDiscoverySuccess,
  type ProviderDiscoveryResultV2,
  type ProviderDiscoveryStatusV2,
} from "./provider-model-discovery";

const ALL_STATUSES = [
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
] as const satisfies readonly ProviderDiscoveryStatusV2[];

describe("provider discovery V2 result contract", () => {
  it("defines exactly the reviewed status vocabulary", () => {
    expect(ALL_STATUSES).toHaveLength(16);
    expect(new Set(ALL_STATUSES).size).toBe(ALL_STATUSES.length);
  });

  it.each([
    ["success_with_models", ["zeta", "alpha", "alpha"]],
    ["success_empty", []],
  ] as const)("constructs a verified %s result", (status, models) => {
    const result = providerDiscoverySuccess(models, {
      cached: true,
      statusCode: 200,
      freeModels: ["zeta", "zeta"],
    });

    expect(result.schemaVersion).toBe(2);
    expect(result.status).toBe(status);
    expect(result.models).toEqual(status === "success_empty" ? [] : ["alpha", "zeta"]);
    expect(result.cached).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(result.freeModels).toEqual(
      status === "success_empty" ? undefined : ["zeta"],
    );
    expect(isProviderDiscoverySuccess(result)).toBe(true);
  });

  it("never allows an empty-success result to carry model ids", () => {
    const result = providerDiscoverySuccess([], { cached: false });
    expect(result.status).toBe("success_empty");
    expect(result.models).toEqual([]);
  });

  it.each(ALL_STATUSES.slice(2))(
    "constructs %s as a non-success with no models or cache claim",
    (status) => {
      const result = providerDiscoveryFailure(status, {
        cached: true,
        models: ["must-not-cross-boundary"],
        statusCode: 401,
      });

      expect(result.schemaVersion).toBe(2);
      expect(result.status).toBe(status);
      expect(result.models).toEqual([]);
      expect(result.cached).toBe(false);
      expect(isProviderDiscoverySuccess(result)).toBe(false);
    },
  );

  it("keeps HTTP status codes only on HTTP-derived outcomes", () => {
    const httpResult = providerDiscoveryFailure("authentication_rejected", {
      statusCode: 401,
    });
    const transportResult = providerDiscoveryFailure("dns_error", {
      statusCode: 503,
    });

    expect(httpResult.statusCode).toBe(401);
    expect(transportResult.statusCode).toBeUndefined();
  });

  it("sanitizes a valid IPC result to the public allowlist", () => {
    const valid: ProviderDiscoveryResultV2 = {
      schemaVersion: 2,
      status: "success_with_models",
      models: ["b", "a", "a"],
      cached: false,
      statusCode: 200,
      freeModels: ["b", "b"],
    };

    expect(parseProviderDiscoveryResult(valid)).toEqual({
      schemaVersion: 2,
      status: "success_with_models",
      models: ["a", "b"],
      cached: false,
      statusCode: 200,
      freeModels: ["b"],
    });
  });

  it("converts malformed IPC data into a bounded connection error", () => {
    const parsed = parseProviderDiscoveryResult({
      schemaVersion: 2,
      status: "success_empty",
      models: ["unexpected"],
      cached: true,
      responseBody: "secret provider response",
    });

    expect(parsed.status).toBe("connection_error");
    expect(parsed.models).toEqual([]);
    expect(parsed.cached).toBe(false);
    expect(parsed.diagnosticId).toMatch(/^md-[0-9a-f]{12}$/);
    expect(JSON.stringify(parsed)).not.toContain("secret provider response");
  });
});
