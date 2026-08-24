import { describe, expect, it } from "vitest";
import {
  runtimeProviderForRoute,
  runtimeProviderMatchesPublicRoute,
  migrateLegacyOpenAiModelRoute,
} from "./runtime-provider-compat";

describe("Hermes Runtime provider compatibility", () => {
  it("maps an official OpenAI route to the registered openai-api provider", () => {
    expect(
      runtimeProviderForRoute("openai", "https://api.openai.com/v1"),
    ).toBe("openai-api");
  });

  it("maps a loopback OpenAI-compatible route to custom", () => {
    expect(
      runtimeProviderForRoute("openai", "http://127.0.0.1:19001/v1"),
    ).toBe("custom");
  });

  it("keeps a third-party logical openai route for named request resolution", () => {
    expect(
      runtimeProviderForRoute("openai", "https://provider.example/v1"),
    ).toBe("openai");
  });

  it("leaves non-openai providers unchanged", () => {
    expect(
      runtimeProviderForRoute("openrouter", "https://openrouter.ai/api/v1"),
    ).toBe("openrouter");
  });

  it("matches migrated runtime identities back to the public openai route", () => {
    expect(
      runtimeProviderMatchesPublicRoute(
        "openai",
        "http://127.0.0.1:19001/v1",
        "custom",
      ),
    ).toBe(true);
    expect(
      runtimeProviderMatchesPublicRoute(
        "openai",
        "https://api.openai.com/v1",
        "openai-api",
      ),
    ).toBe(true);
    expect(
      runtimeProviderMatchesPublicRoute(
        "openai",
        "https://provider.example/v1",
        "custom",
      ),
    ).toBe(false);
  });

  it("rewrites a legacy loopback model block without touching other sections", () => {
    const input = [
      "model:",
      "  provider: openai",
      "  default: fixture-model",
      '  base_url: "http://127.0.0.1:19001/v1"',
      "",
      "platforms:",
      "  api_server:",
      "    enabled: true",
      "",
    ].join("\n");

    const output = migrateLegacyOpenAiModelRoute(input);

    expect(output).toContain('provider: "custom"');
    expect(output).toContain('base_url: "http://127.0.0.1:19001/v1"');
    expect(output).toContain("platforms:\n  api_server:");
  });

  it("does not rewrite an already compatible model block", () => {
    const input = [
      "model:",
      "  provider: custom",
      "  default: fixture-model",
      '  base_url: "http://127.0.0.1:19001/v1"',
      "",
    ].join("\n");
    expect(migrateLegacyOpenAiModelRoute(input)).toBe(input);
  });
});
