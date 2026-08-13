import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "path";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";

/**
 * End-to-end regression for the Beta.27 legacy-config save failure.
 *
 * These drive the real writers (`setModelConfig`,
 * `upsertNativeCustomProvider`) against an isolated `HERMES_HOME`, so they
 * reproduce the actual user-visible bug rather than just unit-testing the
 * migration helper:
 *
 *   1. Pre-Beta.27 config holds a scalar `model: old-model`.
 *   2. First Beta.27 edit appends a second, mapping-form `model:` block.
 *   3. Every later save reads that file, the YAML parser rejects the
 *      duplicate key with `Map keys must be unique`, `native_route` fails,
 *      and the transaction rolls back — "模型服务未保存".
 *
 * @lat: [[legacy-model-config-migration#End-to-end save recovery]]
 */

const TEST_DIR = join(tmpdir(), `hermes-legacy-model-e2e-${process.pid}`);

async function importWithHome(home: string): Promise<{
  config: typeof import("../src/main/config");
  native: typeof import("../src/main/native-custom-provider");
  migration: typeof import("../src/main/config-model-migration");
}> {
  vi.resetModules();
  process.env.HERMES_HOME = home;
  return {
    config: await import("../src/main/config"),
    native: await import("../src/main/native-custom-provider"),
    migration: await import("../src/main/config-model-migration"),
  };
}

function topLevelModelKeys(content: string): number {
  return (content.match(/^model:[^\r\n]*$/gm) ?? []).length;
}

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  delete process.env.HERMES_HOME;
  vi.resetModules();
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("legacy model config — end-to-end save recovery", () => {
  // @lat: [[legacy-model-config-migration#End-to-end save recovery#Edits a legacy scalar config without duplicating the key]]
  it("edits a legacy scalar config without duplicating the model key", async () => {
    const configFile = join(TEST_DIR, "config.yaml");
    writeFileSync(
      configFile,
      [
        "model: old-model",
        "providers:",
        "  petoi:",
        '    api: "https://api.petoi.cn/v1"',
        "",
      ].join("\n"),
      "utf-8",
    );

    const { config } = await importWithHome(TEST_DIR);
    config.setModelConfig(
      "deepseek",
      "deepseek-v4-pro",
      "https://api.deepseek.com/v1",
    );

    const content = readFileSync(configFile, "utf-8");
    expect(topLevelModelKeys(content)).toBe(1);
    // The scalar form is gone; the mapping carries the new route.
    expect(content).not.toMatch(/^model:[ \t]+\S/m);
    expect(config.getModelConfig().model).toBe("deepseek-v4-pro");
    // Unrelated blocks survive the migration.
    expect(content).toContain("providers:");
    expect(content).toContain("petoi:");
  });

  // @lat: [[legacy-model-config-migration#End-to-end save recovery#Repairs an already-duplicated config on the next save]]
  it("repairs an already-duplicated config on the next save", async () => {
    const configFile = join(TEST_DIR, "config.yaml");
    // Exactly the corruption a first Beta.27 edit used to leave behind.
    writeFileSync(
      configFile,
      [
        "model: old-model",
        "model:",
        '  provider: "custom:petoi"',
        '  default: "old-model"',
        '  base_url: "https://api.petoi.cn/v1"',
        "providers:",
        "  petoi:",
        '    api: "https://api.petoi.cn/v1"',
        '    key_env: "PETOI_API_KEY"',
        "",
      ].join("\n"),
      "utf-8",
    );

    const { native } = await importWithHome(TEST_DIR);
    // This is the call that used to throw "Map keys must be unique".
    const route = native.upsertNativeCustomProvider(undefined, {
      name: "petoi",
      baseUrl: "https://api.petoi.cn/v2",
    });

    expect(route).toBe("custom:petoi");
    const content = readFileSync(configFile, "utf-8");
    expect(topLevelModelKeys(content)).toBe(1);
    expect(content).toContain("https://api.petoi.cn/v2");
  });

  // @lat: [[legacy-model-config-migration#End-to-end save recovery#Adds a second model to a legacy service]]
  it("adds a second model to a legacy scalar service", async () => {
    const configFile = join(TEST_DIR, "config.yaml");
    writeFileSync(
      configFile,
      [
        "model: old-model",
        "providers:",
        "  petoi:",
        '    api: "https://api.petoi.cn/v1"',
        "",
      ].join("\n"),
      "utf-8",
    );

    const { native } = await importWithHome(TEST_DIR);
    native.upsertNativeCustomProvider(undefined, {
      name: "petoi",
      baseUrl: "https://api.petoi.cn/v1",
      models: ["old-model", "new-model"],
    });

    const content = readFileSync(configFile, "utf-8");
    expect(topLevelModelKeys(content)).toBe(1);
    expect(content).toContain("new-model");
    expect(content).toContain("old-model");
  });

  // @lat: [[legacy-model-config-migration#End-to-end save recovery#Leaves a canonical config byte-identical]]
  it("leaves an already-canonical config's model block intact", async () => {
    const configFile = join(TEST_DIR, "config.yaml");
    writeFileSync(
      configFile,
      [
        "# user comment preserved",
        "model:",
        '  provider: "openai"',
        '  default: "gpt-4"',
        '  base_url: "https://api.openai.com/v1"',
        "auxiliary:",
        "  research:",
        '    model: "research-model"',
        "",
      ].join("\n"),
      "utf-8",
    );

    const { native } = await importWithHome(TEST_DIR);
    native.upsertNativeCustomProvider(undefined, {
      name: "acme",
      baseUrl: "https://acme.test/v1",
    });

    const content = readFileSync(configFile, "utf-8");
    expect(topLevelModelKeys(content)).toBe(1);
    expect(content).toContain('default: "gpt-4"');
    // A nested `model:` under another block is never treated as the target.
    expect(content).toContain('model: "research-model"');
    expect(content).toContain("# user comment preserved");
  });

  // @lat: [[legacy-model-config-migration#End-to-end save recovery#Named profiles stay isolated]]
  it("writes a named profile's config without touching the default profile", async () => {
    const defaultConfig = join(TEST_DIR, "config.yaml");
    const namedDir = join(TEST_DIR, "profiles", "installed");
    mkdirSync(namedDir, { recursive: true });
    writeFileSync(defaultConfig, "model: default-untouched\n", "utf-8");
    writeFileSync(
      join(namedDir, "config.yaml"),
      "model: named-legacy\n",
      "utf-8",
    );

    const { config } = await importWithHome(TEST_DIR);
    config.setModelConfig("deepseek", "deepseek-v4-pro", "", "installed");

    const named = readFileSync(join(namedDir, "config.yaml"), "utf-8");
    expect(topLevelModelKeys(named)).toBe(1);
    expect(named).toContain("deepseek-v4-pro");
    // The default profile is a separate file and must not be rewritten.
    expect(readFileSync(defaultConfig, "utf-8")).toBe(
      "model: default-untouched\n",
    );
  });

  // @lat: [[legacy-model-config-migration#End-to-end save recovery#Rejects unsalvageable YAML before writing]]
  it("refuses to write when the existing config is unparseable YAML", async () => {
    const configFile = join(TEST_DIR, "config.yaml");
    const broken = "model:\n  provider: [unclosed\nproviders: : :\n";
    writeFileSync(configFile, broken, "utf-8");

    const { native } = await importWithHome(TEST_DIR);
    expect(() =>
      native.upsertNativeCustomProvider(undefined, {
        name: "acme",
        baseUrl: "https://acme.test/v1",
      }),
    ).toThrow();
    // Disk is untouched: a rejected save never leaves a partial write.
    expect(readFileSync(configFile, "utf-8")).toBe(broken);
  });

  // @lat: [[legacy-model-config-migration#End-to-end save recovery#Keeps API keys out of config.yaml]]
  it("keeps the API key out of config.yaml, storing only the env reference", async () => {
    const configFile = join(TEST_DIR, "config.yaml");
    writeFileSync(configFile, "model: old-model\n", "utf-8");

    const { native } = await importWithHome(TEST_DIR);
    native.upsertNativeCustomProvider(undefined, {
      name: "petoi",
      baseUrl: "https://api.petoi.cn/v1",
    });

    const content = readFileSync(configFile, "utf-8");
    expect(content).toContain("key_env:");
    expect(content).not.toMatch(/sk-[A-Za-z0-9]/);
  });
});
