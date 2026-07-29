// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";

let testHome = "";

async function loadModules(): Promise<{
  config: typeof import("../src/main/config");
  native: typeof import("../src/main/native-custom-provider");
}> {
  vi.resetModules();
  vi.stubEnv("HERMES_HOME", testHome);
  return {
    config: await import("../src/main/config"),
    native: await import("../src/main/native-custom-provider"),
  };
}

describe("Hermes-native named custom-provider routing", () => {
  beforeEach(() => {
    testHome = mkdtempSync(join(tmpdir(), "agentera-native-custom-"));
    writeFileSync(
      join(testHome, "config.yaml"),
      [
        "# preserve unrelated Hermes configuration",
        "model:",
        '  provider: "auto"',
        '  default: ""',
        "providers:",
        "  existing:",
        "    api: https://existing.example/v1",
        "    key_env: EXISTING_API_KEY",
        "",
      ].join("\n"),
      "utf8",
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(testHome, { recursive: true, force: true });
  });

  it("persists one native providers entry and activates custom:<name> without inlining the key", async () => {
    const { config, native } = await loadModules();

    const route = native.upsertNativeCustomProvider(undefined, {
      apiMode: "chat_completions",
      baseUrl: "https://api.petoi.cn/v1",
      model: "gpt-5.6-sol",
      models: ["gpt-5.6-sol", "gpt-5.5"],
      name: "petoi.cn",
    });
    config.setModelConfig(route, "gpt-5.6-sol", "https://api.petoi.cn/v1");

    const saved = readFileSync(join(testHome, "config.yaml"), "utf8");
    const parsed = parseYaml(saved) as {
      model: Record<string, unknown>;
      providers: Record<string, Record<string, unknown>>;
    };

    expect(route).toBe("custom:petoi.cn");
    expect(parsed.model).toMatchObject({
      provider: "custom:petoi.cn",
      default: "gpt-5.6-sol",
      base_url: "https://api.petoi.cn/v1",
    });
    expect(parsed.model).not.toHaveProperty("api_key");
    expect(parsed.providers.existing).toMatchObject({
      api: "https://existing.example/v1",
      key_env: "EXISTING_API_KEY",
    });
    expect(parsed.providers["petoi.cn"]).toMatchObject({
      name: "petoi.cn",
      api: "https://api.petoi.cn/v1",
      key_env: "CUSTOM_PROVIDER_PETOI_CN_KEY",
      transport: "chat_completions",
      default_model: "gpt-5.6-sol",
      models: {
        "gpt-5.6-sol": {},
        "gpt-5.5": {},
      },
    });
    expect(saved).not.toContain("sk-");
  });

  it("composes native provider and model writes into valid block YAML on a brand-new profile", async () => {
    rmSync(join(testHome, "config.yaml"));
    const { config, native } = await loadModules();

    const route = native.upsertNativeCustomProvider(undefined, {
      apiMode: "codex_responses",
      baseUrl: "https://api.anhepro.com/v1",
      model: "gpt-5.6-sol",
      models: ["gpt-5.6-sol"],
      name: "anhepro.com",
    });
    config.setModelConfig(
      route,
      "gpt-5.6-sol",
      "https://api.anhepro.com/v1",
      undefined,
      null,
      "codex_responses",
    );

    const saved = readFileSync(join(testHome, "config.yaml"), "utf8");
    const parsed = parseYaml(saved) as {
      model: Record<string, unknown>;
      providers: Record<string, Record<string, unknown>>;
    };

    expect(saved).toMatch(/^providers:\n/);
    expect(parsed.model).toMatchObject({
      provider: "custom:anhepro.com",
      default: "gpt-5.6-sol",
      base_url: "https://api.anhepro.com/v1",
      api_mode: "codex_responses",
    });
    expect(parsed.providers["anhepro.com"]).toMatchObject({
      api: "https://api.anhepro.com/v1",
      key_env: "CUSTOM_PROVIDER_ANHEPRO_COM_KEY",
      transport: "codex_responses",
    });
  });

  it("reuses the key_env identity instead of leaving duplicate native routes after a rename", async () => {
    const { native } = await loadModules();

    native.upsertNativeCustomProvider(undefined, {
      baseUrl: "https://old.example/v1",
      name: "Petoi.CN",
    });
    native.upsertNativeCustomProvider(undefined, {
      baseUrl: "https://api.petoi.cn/v1",
      name: "PETOI_CN",
    });

    const parsed = parseYaml(
      readFileSync(join(testHome, "config.yaml"), "utf8"),
    ) as { providers: Record<string, Record<string, unknown>> };
    const matching = Object.values(parsed.providers).filter(
      (entry) => entry.key_env === "CUSTOM_PROVIDER_PETOI_CN_KEY",
    );

    expect(matching).toHaveLength(1);
    expect(matching[0]).toMatchObject({
      api: "https://api.petoi.cn/v1",
      name: "PETOI_CN",
    });
  });
});
