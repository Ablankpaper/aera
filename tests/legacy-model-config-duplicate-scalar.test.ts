import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "path";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { withManagedModelTestWrite } from "./helpers/managed-model-test-writer";

/**
 * Regression suite for the duplicate-key shapes the first migration missed.
 *
 * The original repair only recognized `scalar + mapping`. A config holding two
 * legacy scalars kept the first scalar and dropped the second, so the very next
 * `setModelConfig()` appended a mapping and the file was corrupt again. These
 * drive the real writer, because only the writer proves the shape is gone.
 *
 * @lat: [[legacy-model-config-migration#Duplicate scalar recovery]]
 */

const TEST_DIR = join(tmpdir(), `hermes-dup-scalar-${process.pid}`);

async function importWithHome(home: string): Promise<{
  config: typeof import("../src/main/config");
  migration: typeof import("../src/main/config-model-migration");
}> {
  vi.resetModules();
  process.env.HERMES_HOME = home;
  return {
    config: await import("../src/main/config"),
    migration: await import("../src/main/config-model-migration"),
  };
}

async function writeDefaultProfile<T>(
  callback: () => T | Promise<T>,
): Promise<T> {
  return await withManagedModelTestWrite(
    {
      roots: {
        globalRoot: TEST_DIR,
        profiles: { default: TEST_DIR },
      },
      scope: { globalCatalog: false, profileIds: ["default"] },
    },
    callback,
  );
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

describe("legacy model config — duplicate scalar recovery", () => {
  // @lat: [[legacy-model-config-migration#Duplicate scalar recovery#Collapses two legacy scalars through a real save]]
  it("collapses two legacy scalar model keys through a real setModelConfig", async () => {
    const configFile = join(TEST_DIR, "config.yaml");
    writeFileSync(
      configFile,
      ["model: first", "model: second", "providers:", "  x: {}", ""].join("\n"),
      "utf-8",
    );

    const { config } = await importWithHome(TEST_DIR);
    await writeDefaultProfile(() =>
      config.setModelConfig("openai", "gpt-4", "https://api.openai.com/v1"),
    );

    const content = readFileSync(configFile, "utf-8");
    // The bug: the write used to append a mapping beside a surviving scalar.
    expect(topLevelModelKeys(content)).toBe(1);
    expect(content).not.toMatch(/^model:[ \t]+\S/m);
    expect(config.getModelConfig().model).toBe("gpt-4");
    expect(content).toContain("providers:");
  });

  // @lat: [[legacy-model-config-migration#Duplicate scalar recovery#Collapses a scalar beside a mapping through a real save]]
  it("collapses a scalar beside a mapping through a real setModelConfig", async () => {
    const configFile = join(TEST_DIR, "config.yaml");
    writeFileSync(
      configFile,
      [
        "model: old-model",
        "model:",
        '  provider: "custom:petoi"',
        '  default: "old-model"',
        "providers:",
        "  petoi:",
        '    api: "https://api.petoi.cn/v1"',
        "",
      ].join("\n"),
      "utf-8",
    );

    const { config } = await importWithHome(TEST_DIR);
    await writeDefaultProfile(() =>
      config.setModelConfig(
        "deepseek",
        "deepseek-v4-pro",
        "https://api.deepseek.com/v1",
      ),
    );

    const content = readFileSync(configFile, "utf-8");
    expect(topLevelModelKeys(content)).toBe(1);
    expect(config.getModelConfig().model).toBe("deepseek-v4-pro");
    expect(content).toContain('api: "https://api.petoi.cn/v1"');
  });

  // @lat: [[legacy-model-config-migration#Duplicate scalar recovery#Refuses a duplicate key beside an illegal providers block]]
  it("refuses to write when duplicate keys sit beside an illegal providers block", async () => {
    const configFile = join(TEST_DIR, "config.yaml");
    // Removing the duplicate still leaves `providers:` as a scalar, so the
    // repair cannot produce a committable file.
    const broken = [
      "model: old-model",
      "model:",
      '  provider: "openai"',
      "providers: not-a-mapping",
      "",
    ].join("\n");
    writeFileSync(configFile, broken, "utf-8");

    const { config } = await importWithHome(TEST_DIR);
    await writeDefaultProfile(() => {
      expect(() =>
        config.setModelConfig("openai", "gpt-4", "https://api.openai.com/v1"),
      ).toThrow();
    });

    // Half-repaired content must never reach disk.
    expect(readFileSync(configFile, "utf-8")).toBe(broken);
  });

  // @lat: [[legacy-model-config-migration#Duplicate scalar recovery#Reports the migration as unrepairable rather than returning partial content]]
  it("throws model_config_migration_unrepairable instead of returning partial content", async () => {
    const { migration } = await importWithHome(TEST_DIR);
    let thrown: unknown;
    try {
      migration.migrateModelConfigFormat(
        ["model: a", "model: b", "providers: not-a-mapping", ""].join("\n"),
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeDefined();
    expect((thrown as { code?: string }).code).toBe(
      "model_config_migration_unrepairable",
    );
    expect((thrown as { problem?: string }).problem).toBe(
      "providers_not_mapping",
    );
  });

  // @lat: [[legacy-model-config-migration#Duplicate scalar recovery#Always returns content it would accept]]
  it("returns content that passes its own validation for every repairable shape", async () => {
    const { migration } = await importWithHome(TEST_DIR);
    const shapes = [
      ["model: first", "model: second", ""].join("\n"),
      ["model: scalar", "model:", '  provider: "openai"', ""].join("\n"),
      ["model: a", "model:", "model: b", "providers:", "  x: {}", ""].join(
        "\n",
      ),
      ["model:", "model: only-scalar", ""].join("\n"),
    ];
    for (const shape of shapes) {
      const result = migration.migrateModelConfigFormat(shape);
      // The contract: a returned result is always committable.
      expect(migration.validateModelConfiguration(result.content)).toBe(true);
      expect(
        (result.content.match(/^model:[^\r\n]*$/gm) ?? []).length,
      ).toBeLessThanOrEqual(1);
    }
  });
});
