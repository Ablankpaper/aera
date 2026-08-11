import { describe, expect, it } from "vitest";
import {
  canonicalPublicRouteKey,
  type OwnerModelRouteCatalogSnapshot,
} from "./model-configuration";

describe("model configuration contract", () => {
  it("uses API mode in public identity without exposing credentials", () => {
    expect(
      canonicalPublicRouteKey({
        provider: "custom:petoi",
        model: "gpt-5.6-sol",
        baseUrl: "https://api.petoi.cn/v1/",
        apiMode: "codex_responses",
      }),
    ).not.toBe(
      canonicalPublicRouteKey({
        provider: "custom:petoi",
        model: "gpt-5.6-sol",
        baseUrl: "https://api.petoi.cn/v1",
        apiMode: "chat_completions",
      }),
    );

    const snapshot: OwnerModelRouteCatalogSnapshot = {
      revision: "revision-1",
      targetProfileId: "default",
      routes: [],
    };
    expect(JSON.stringify(snapshot)).not.toMatch(
      /apiKey|credentialRef|secret/i,
    );
  });
});
