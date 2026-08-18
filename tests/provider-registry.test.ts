import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";
import {
  PROVIDER_BASE_URLS,
  canonicalProviderBaseUrl,
} from "../src/main/provider-registry";

describe("provider-registry", () => {
  describe("canonicalProviderBaseUrl", () => {
    it("returns the canonical URL for built-in OpenAI-compatible providers", () => {
      expect(canonicalProviderBaseUrl("deepseek")).toBe(
        "https://api.deepseek.com/v1",
      );
      expect(canonicalProviderBaseUrl("groq")).toBe(
        "https://api.groq.com/openai/v1",
      );
      expect(canonicalProviderBaseUrl("mistral")).toBe(
        "https://api.mistral.ai/v1",
      );
      expect(canonicalProviderBaseUrl("xiaomi")).toBe(
        "https://api.xiaomimimo.com/v1",
      );
      expect(canonicalProviderBaseUrl("aimlapi")).toBe(
        "https://api.aimlapi.com/v1",
      );
      expect(canonicalProviderBaseUrl("together")).toBe(
        "https://api.together.xyz/v1",
      );
      expect(canonicalProviderBaseUrl("fireworks")).toBe(
        "https://api.fireworks.ai/inference/v1",
      );
      expect(canonicalProviderBaseUrl("cerebras")).toBe(
        "https://api.cerebras.ai/v1",
      );
      // Must stay the agent's own default (international) — a CN value here
      // would be written into every empty-base_url alibaba config on save.
      expect(canonicalProviderBaseUrl("alibaba")).toBe(
        "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      );
    });

    it("returns the canonical URL for the Big3 (openai / anthropic / openrouter)", () => {
      expect(canonicalProviderBaseUrl("openai")).toBe(
        "https://api.openai.com/v1",
      );
      expect(canonicalProviderBaseUrl("anthropic")).toBe(
        "https://api.anthropic.com/v1",
      );
      expect(canonicalProviderBaseUrl("openrouter")).toBe(
        "https://openrouter.ai/api/v1",
      );
      expect(canonicalProviderBaseUrl("ollama-cloud")).toBe(
        "https://ollama.com/v1",
      );
    });

    it("returns default URLs for local OpenAI-compatible providers", () => {
      expect(canonicalProviderBaseUrl("lmstudio")).toBe(
        "http://localhost:1234/v1",
      );
      expect(canonicalProviderBaseUrl("atomicchat")).toBe(
        "http://localhost:1337/v1",
      );
      expect(canonicalProviderBaseUrl("ollama")).toBe(
        "http://localhost:11434/v1",
      );
      expect(canonicalProviderBaseUrl("vllm")).toBe("http://localhost:8000/v1");
      expect(canonicalProviderBaseUrl("llamacpp")).toBe(
        "http://localhost:8080/v1",
      );
    });

    it("is case-insensitive on the provider id", () => {
      expect(canonicalProviderBaseUrl("DeepSeek")).toBe(
        "https://api.deepseek.com/v1",
      );
      expect(canonicalProviderBaseUrl("MISTRAL")).toBe(
        "https://api.mistral.ai/v1",
      );
    });

    it("returns null for providers that don't have a canonical URL", () => {
      // `custom` and `auto` are intentionally not in the registry — the
      // user must supply their own baseUrl.
      expect(canonicalProviderBaseUrl("custom")).toBeNull();
      expect(canonicalProviderBaseUrl("auto")).toBeNull();
      // Unknown/user-defined provider ids.
      expect(canonicalProviderBaseUrl("my-private-llm")).toBeNull();
      expect(canonicalProviderBaseUrl("")).toBeNull();
    });

    it("the registry covers every built-in remote OpenAI-compat provider", () => {
      // These are the provider ids that hermes-desktop's renderer
      // exposes as built-in "remote" presets (constants.ts:LOCAL_PRESETS,
      // group: "remote"). They MUST have canonical URLs here — otherwise
      // setModelConfig would silently leave `base_url:` empty when the
      // user picks them, which is the regression this module exists to
      // prevent.
      const requiredBuiltins = [
        "groq",
        "aimlapi",
        "deepseek",
        "together",
        "fireworks",
        "cerebras",
        "mistral",
        "xiaomi",
        "ollama-cloud",
      ];
      for (const provider of requiredBuiltins) {
        expect(PROVIDER_BASE_URLS[provider]).toBeTruthy();
      }
    });
  });
});

describe("registry MCP managed configuration", () => {
  it("keeps config.yaml unchanged when coordinated MCP install is refused", async () => {
    const home = mkdtempSync(join(tmpdir(), "aera-registry-mcp-"));
    const configFile = join(home, "config.yaml");
    writeFileSync(configFile, "model:\n  default: local-model\n", "utf-8");
    const before = readFileSync(configFile);
    const mutationPort = {
      mutate: vi.fn(async () => ({
        status: "rejected" as const,
        stage: "recovery" as const,
        code: "model_configuration_recovery_required" as const,
        rollback: "recovery_required" as const,
        diagnosticId: "0123456789ab",
      })),
    };
    vi.resetModules();
    vi.doMock("../src/main/installer", () => ({
      HERMES_HOME: home,
      listMcpServers: () => [],
    }));
    vi.doMock("../src/main/skills", () => ({
      installSkill: () => ({ success: true }),
      listInstalledSkills: () => [],
    }));
    vi.doMock("../src/main/profiles", () => ({
      createProfile: () => ({ success: true, id: "unused" }),
    }));
    vi.doMock("../src/main/soul", () => ({ writeSoul: () => true }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ url: "https://mcp.example.test/stream" }),
      ),
    );

    try {
      const { installRegistryItem } = await import("../src/main/registry");
      const result = await (
        installRegistryItem as unknown as (
          kind: "mcps",
          item: {
            id: string;
            name: string;
            description: string;
            path: string;
          },
          profile: string | undefined,
          dependencies: { modelMutationPort: typeof mutationPort },
        ) => Promise<{ success: boolean; error?: string }>
      )(
        "mcps",
        {
          id: "fixture-mcp",
          name: "Fixture MCP",
          description: "fixture",
          path: "mcps/fixture-mcp",
        },
        undefined,
        { modelMutationPort: mutationPort },
      );

      expect(result).toEqual({
        success: false,
        error: "model_configuration_recovery_required",
      });
      expect(mutationPort.mutate).toHaveBeenCalledTimes(1);
      expect(readFileSync(configFile)).toEqual(before);
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
