import { describe, it, expect } from "vitest";
import {
  hostDerivedEnvKeyForUrl,
  runtimeHostDerivedEnvKeyForUrl,
  shouldPruneOpenRouterApiKey,
} from "../src/main/host-derived-env";

/**
 * Dual-engine compat: the desktop writes a host-derived `<VENDOR>_API_KEY`
 * env-var to the child process so the upstream engine's host-derive
 * resolver (`hermes_cli/runtime_provider.py::_host_derived_api_key`) finds
 * a key. Without it, custom-provider chat against `api.deepseek.com` etc.
 * on a post-2026 engine falls through to "no-key-required" and 401s.
 *
 * This test pins the URL → env-var mapping so the resolver and the
 * additive-write site in `sendMessage` can never drift.
 */
describe("hostDerivedEnvKeyForUrl", () => {
  it.each([
    ["https://api.deepseek.com/v1", "DEEPSEEK_API_KEY"],
    ["https://api.groq.com/openai/v1", "GROQ_API_KEY"],
    ["https://api.mistral.ai/v1", "MISTRAL_API_KEY"],
    ["https://api.together.xyz/v1", "TOGETHER_API_KEY"],
    ["https://api.fireworks.ai/inference/v1", "FIREWORKS_API_KEY"],
    ["https://api.cerebras.ai/v1", "CEREBRAS_API_KEY"],
    ["https://api.aimlapi.com/v1", "AIMLAPI_API_KEY"],
    ["https://api.perplexity.ai/v1", "PERPLEXITY_API_KEY"],
    ["https://api.petoi.cn/v1", "PETOI_API_KEY"],
    ["https://openrouter.ai/api/v1", "OPENROUTER_API_KEY"],
    ["https://api.anthropic.com/v1", "ANTHROPIC_API_KEY"],
    ["https://api.openai.com/v1", "OPENAI_API_KEY"],
    ["https://api-inference.huggingface.co/models/x", "HF_TOKEN"],
  ])("maps %s → %s", (url, expected) => {
    expect(hostDerivedEnvKeyForUrl(url)).toBe(expected);
  });

  it("returns null for non-vendor hosts (local LLMs, unknown clouds)", () => {
    expect(hostDerivedEnvKeyForUrl("http://localhost:11434/v1")).toBeNull();
    expect(hostDerivedEnvKeyForUrl("http://127.0.0.1:1234/v1")).toBeNull();
    expect(hostDerivedEnvKeyForUrl("https://192.168.1.42:8080/v1")).toBeNull();
    expect(hostDerivedEnvKeyForUrl("https://api.unsloth.ai/v1")).toBeNull();
    expect(hostDerivedEnvKeyForUrl("")).toBeNull();
  });

  it("is case-insensitive (some users paste mixed-case URLs)", () => {
    expect(hostDerivedEnvKeyForUrl("https://API.DeepSeek.com/v1")).toBe(
      "DEEPSEEK_API_KEY",
    );
  });

  it("keeps OPENROUTER_API_KEY when OpenRouter is the host-derived provider", () => {
    expect(shouldPruneOpenRouterApiKey("OPENROUTER_API_KEY")).toBe(false);
    expect(shouldPruneOpenRouterApiKey("DEEPSEEK_API_KEY")).toBe(true);
    expect(shouldPruneOpenRouterApiKey(null)).toBe(true);
  });
});

describe("runtimeHostDerivedEnvKeyForUrl", () => {
  it("mirrors the Runtime host-derived slot for an unknown custom endpoint", () => {
    expect(runtimeHostDerivedEnvKeyForUrl("https://api.anhepro.com/v1")).toBe(
      "ANHEPRO_API_KEY",
    );
  });

  it("does not derive a provider slot for local or LAN endpoints", () => {
    expect(
      runtimeHostDerivedEnvKeyForUrl("http://localhost:11434/v1"),
    ).toBeNull();
    expect(
      runtimeHostDerivedEnvKeyForUrl("http://127.0.0.1:1234/v1"),
    ).toBeNull();
    expect(
      runtimeHostDerivedEnvKeyForUrl("http://192.168.1.42:8080/v1"),
    ).toBeNull();
    expect(
      runtimeHostDerivedEnvKeyForUrl("http://10.0.0.8:8000/v1"),
    ).toBeNull();
  });

  it("derives from the registrable-looking host label instead of a spoofed vendor substring", () => {
    expect(
      runtimeHostDerivedEnvKeyForUrl(
        "https://api.deepseek.com.attacker.test/v1",
      ),
    ).toBe("ATTACKER_API_KEY");
  });

  it("leaves vendors with explicit Runtime host gates to those gates", () => {
    expect(
      runtimeHostDerivedEnvKeyForUrl("https://api.openai.com/v1"),
    ).toBeNull();
    expect(
      runtimeHostDerivedEnvKeyForUrl("https://openrouter.ai/api/v1"),
    ).toBeNull();
    expect(
      runtimeHostDerivedEnvKeyForUrl("https://api.ollama.com/v1"),
    ).toBeNull();
  });

  it("rejects malformed and non-provider hosts", () => {
    expect(runtimeHostDerivedEnvKeyForUrl("")).toBeNull();
    expect(runtimeHostDerivedEnvKeyForUrl("not a url")).toBeNull();
    expect(
      runtimeHostDerivedEnvKeyForUrl("https://single-label/v1"),
    ).toBeNull();
  });
});
