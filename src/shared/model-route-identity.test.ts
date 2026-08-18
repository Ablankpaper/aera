import { describe, expect, it } from "vitest";
import * as modelConfiguration from "./model-configuration";

interface ModelRouteIdentityV2 {
  providerId: string;
  modelId: string;
  endpoint: string;
  apiMode: string;
}

type RouteIdentityContract = {
  MODEL_ROUTE_KEY_VERSION?: number;
  canonicalModelEndpointV2?: (value: string) => string;
  routeKeyV2?: (route: ModelRouteIdentityV2) => string;
  routeKeyMatches?: (storedKey: string, route: ModelRouteIdentityV2) => boolean;
  routeKeysMatch?: (storedKey: string, currentV2Key: string) => boolean;
};

const contract = modelConfiguration as RouteIdentityContract;

function requireFunction<T extends (...args: never[]) => unknown>(
  value: T | undefined,
  name: string,
): T {
  expect(value, `${name} must be exported`).toBeTypeOf("function");
  return value as T;
}

describe("model route identity v2", () => {
  it("normalizes only URL identity fields and default ports", () => {
    expect(contract.MODEL_ROUTE_KEY_VERSION).toBe(2);
    const canonicalModelEndpointV2 = requireFunction(
      contract.canonicalModelEndpointV2,
      "canonicalModelEndpointV2",
    );

    expect(canonicalModelEndpointV2("HTTPS://API.Example.COM:443/v1/")).toBe(
      "https://api.example.com/v1",
    );
    expect(canonicalModelEndpointV2("http://LOCALHOST:80/V1?Mode=UPPER")).toBe(
      "http://localhost/V1?Mode=UPPER",
    );
    expect(
      canonicalModelEndpointV2("https://api.example.com/Case/Path?Key=Value"),
    ).not.toBe(
      canonicalModelEndpointV2("https://api.example.com/case/path?key=value"),
    );
  });

  it("rejects credentials, fragments, and invalid new endpoints", () => {
    const canonicalModelEndpointV2 = requireFunction(
      contract.canonicalModelEndpointV2,
      "canonicalModelEndpointV2",
    );

    expect(() =>
      canonicalModelEndpointV2("https://user:secret@example.com/v1"),
    ).toThrow();
    expect(() =>
      canonicalModelEndpointV2("https://example.com/v1#fragment"),
    ).toThrow();
    expect(() => canonicalModelEndpointV2("not a URL")).toThrow();
  });

  it("emits v2 keys while matching historical v1 keys", () => {
    const routeKeyV2 = requireFunction(contract.routeKeyV2, "routeKeyV2");
    const routeKeyMatches = requireFunction(
      contract.routeKeyMatches,
      "routeKeyMatches",
    );
    const routeKeysMatch = requireFunction(
      contract.routeKeysMatch,
      "routeKeysMatch",
    );
    const identity: ModelRouteIdentityV2 = {
      providerId: "Custom:Petoi",
      modelId: "gpt-5.6-sol",
      endpoint: "https://API.Example.com/Case/Path?Key=Value",
      apiMode: "Codex_Responses",
    };
    const legacyV1Key = [
      "custom:petoi",
      "gpt-5.6-sol",
      "https://api.example.com/case/path?key=value",
      "codex_responses",
    ].join("\0");

    expect(routeKeyV2(identity)).toBe(
      [
        "v2",
        "custom:petoi",
        "gpt-5.6-sol",
        "https://api.example.com/Case/Path?Key=Value",
        "codex_responses",
      ].join("\0"),
    );
    expect(routeKeyMatches(legacyV1Key, identity)).toBe(true);
    expect(routeKeyMatches(routeKeyV2(identity), identity)).toBe(true);
    expect(routeKeysMatch(legacyV1Key, routeKeyV2(identity))).toBe(true);
    expect(routeKeysMatch(routeKeyV2(identity), routeKeyV2(identity))).toBe(
      true,
    );
  });

  it("reads invalid historical endpoint text but never emits it as v2", () => {
    const routeKeyV2 = requireFunction(contract.routeKeyV2, "routeKeyV2");
    const routeKeyMatches = requireFunction(
      contract.routeKeyMatches,
      "routeKeyMatches",
    );
    const identity: ModelRouteIdentityV2 = {
      providerId: "custom:fixture",
      modelId: "fixture-model",
      endpoint: "legacy invalid endpoint/",
      apiMode: "chat_completions",
    };
    const legacyV1Key = [
      "custom:fixture",
      "fixture-model",
      "legacy invalid endpoint",
      "chat_completions",
    ].join("\0");

    expect(routeKeyMatches(legacyV1Key, identity)).toBe(true);
    expect(() => routeKeyV2(identity)).toThrow();
  });
});
