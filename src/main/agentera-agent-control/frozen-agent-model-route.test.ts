// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { ResolvedOwnerModelRoute } from "./owner-model-route-catalog";
import {
  freezeResolvedOwnerModelRoute,
  parseFrozenAgentModelRoute,
  sessionModelOverrideFromFrozenRoute,
  serializeFrozenAgentModelRoute,
} from "./frozen-agent-model-route";

function resolvedRoute(
  overrides: Partial<ResolvedOwnerModelRoute> = {},
): ResolvedOwnerModelRoute {
  return {
    id: "account-home\0petoi-gpt",
    sourceProfileId: "account-home",
    modelLibraryId: "petoi-gpt",
    provider: "custom:petoi",
    providerLabel: "Petoi",
    model: "gpt-5.6-sol",
    displayName: "GPT 5.6 Sol",
    baseUrl: "https://api.petoi.cn/v1",
    apiMode: "codex_responses",
    credentialRef: "CUSTOM_PROVIDER_PETOI_KEY",
    ...overrides,
  };
}

describe("frozen Agent model route", () => {
  // @lat: [[agentera-agent-control-plane#Installation and binding#Model policy and runtime selection#Complete local route freeze#Strict current and legacy parsing]]
  it("freezes only the complete Main-owned execution identity", () => {
    const frozen = freezeResolvedOwnerModelRoute(resolvedRoute());

    expect(frozen).toEqual({
      provider: "custom:petoi",
      model: "gpt-5.6-sol",
      baseUrl: "https://api.petoi.cn/v1",
      apiMode: "codex_responses",
      sourceProfileId: "account-home",
      modelLibraryId: "petoi-gpt",
      credentialRef: "CUSTOM_PROVIDER_PETOI_KEY",
      legacy: false,
    });
    expect(
      parseFrozenAgentModelRoute(
        JSON.parse(serializeFrozenAgentModelRoute(frozen)),
      ),
    ).toEqual(frozen);
    expect(JSON.stringify(frozen)).not.toMatch(
      /providerLabel|displayName|account-home\\0/,
    );
  });

  it("reads the exact Beta.26 three-field route as immutable legacy data", () => {
    expect(
      parseFrozenAgentModelRoute({
        provider: "openai",
        model: "gpt-5.6",
        baseUrl: "https://api.openai.com/v1",
      }),
    ).toEqual({
      provider: "openai",
      model: "gpt-5.6",
      baseUrl: "https://api.openai.com/v1",
      apiMode: null,
      sourceProfileId: null,
      modelLibraryId: null,
      credentialRef: null,
      legacy: true,
    });
  });

  // @lat: [[agentera-agent-control-plane#Installation and binding#Model policy and runtime selection#Complete local route freeze#Ordinary transport projection]]
  it("projects only the ordinary three-field override for transport", () => {
    const frozen = freezeResolvedOwnerModelRoute(resolvedRoute());

    expect(sessionModelOverrideFromFrozenRoute(frozen)).toEqual({
      provider: "custom:petoi",
      model: "gpt-5.6-sol",
      baseUrl: "https://api.petoi.cn/v1",
    });
    expect(
      JSON.stringify(sessionModelOverrideFromFrozenRoute(frozen)),
    ).not.toMatch(
      /credentialRef|CUSTOM_PROVIDER|sourceProfileId|modelLibraryId|apiMode/,
    );
  });

  it.each([
    {
      name: "unknown keys",
      value: { ...freezeResolvedOwnerModelRoute(resolvedRoute()), secret: "x" },
    },
    {
      name: "partial current shape",
      value: {
        provider: "custom:petoi",
        model: "gpt-5.6-sol",
        baseUrl: "https://api.petoi.cn/v1",
        apiMode: "codex_responses",
      },
    },
    {
      name: "Profile paths",
      value: {
        ...freezeResolvedOwnerModelRoute(resolvedRoute()),
        sourceProfileId: "/Users/example/.hermes/profiles/default",
      },
    },
    {
      name: "raw secret values",
      value: {
        ...freezeResolvedOwnerModelRoute(resolvedRoute()),
        credentialRef: "sk-live-secret-value",
      },
    },
    {
      name: "invalid URLs",
      value: {
        ...freezeResolvedOwnerModelRoute(resolvedRoute()),
        baseUrl: "petoi endpoint",
      },
    },
    {
      name: "credential-bearing URLs",
      value: {
        ...freezeResolvedOwnerModelRoute(resolvedRoute()),
        baseUrl: "https://user:secret@api.petoi.cn/v1?key=secret",
      },
    },
  ])("rejects $name", ({ value }) => {
    expect(() => parseFrozenAgentModelRoute(value)).toThrowError(
      expect.objectContaining({ code: "binding_corrupt" }),
    );
  });

  it("rejects unusable resolved input before persistence", () => {
    expect(() =>
      freezeResolvedOwnerModelRoute(
        resolvedRoute({ credentialRef: "actual secret with spaces" }),
      ),
    ).toThrowError(expect.objectContaining({ code: "invalid_binding" }));
  });

  it("requires a credential reference for a non-local resolved endpoint", () => {
    expect(() =>
      freezeResolvedOwnerModelRoute(resolvedRoute({ credentialRef: null })),
    ).toThrowError(expect.objectContaining({ code: "invalid_binding" }));

    expect(
      freezeResolvedOwnerModelRoute(
        resolvedRoute({
          baseUrl: "http://127.0.0.1:11434/v1",
          credentialRef: null,
        }),
      ).credentialRef,
    ).toBeNull();
  });
});
