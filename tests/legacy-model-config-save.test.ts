import { beforeEach, describe, expect, it } from "vitest";

/**
 * Integration test: Verify that the migration logic correctly handles
 * legacy `model: scalar` config and duplicate `model:` keys.
 *
 * Reproduces the user-reported issue:
 * - User has old config with `model: gpt-4` (scalar)
 * - User edits petoi.cn provider and changes Base URL
 * - Save fails with "模型服务未保存，系统没有保留任何部分配置。"
 * - Root cause: duplicate `model:` keys → YAML parse error
 *
 * @lat: [[legacy-model-config-migration]]
 */

describe("legacy-model-config-migration", () => {
  let migrateModelConfigFormat: (content: string) => {
    content: string;
    modified: boolean;
    summary: string;
  };

  beforeEach(async () => {
    const module = await import("../src/main/config-model-migration");
    migrateModelConfigFormat = module.migrateModelConfigFormat;
  });

  it("should migrate legacy scalar model to mapping format", () => {
    const input = `model: old-gpt-3.5
providers:
  petoi:
    api: "https://api.petoi.cn/v1"
`;

    const result = migrateModelConfigFormat(input);

    expect(result.modified).toBe(true);
    expect(result.content).toContain("model:");
    expect(result.content).not.toMatch(/^model:\s+\S+\s*$/m); // No scalar

    // Should have mapping structure (default: is the model name)
    expect(result.content).toMatch(/default:\s*["']?old-gpt-3\.5["']?/);

    // Should preserve providers block
    expect(result.content).toContain("providers:");
    expect(result.content).toContain("petoi:");
  });

  it("should remove duplicate model: keys", () => {
    const input = `model: old-model
model:
  provider: "custom:petoi"
  default: "gpt-3.5"
  base_url: "https://api.petoi.cn/v1"
providers:
  petoi:
    api: "https://api.petoi.cn/v1"
`;

    const result = migrateModelConfigFormat(input);

    expect(result.modified).toBe(true);

    // Should have exactly one model: key
    const modelMatches = result.content.match(/^model:/gm);
    expect(modelMatches?.length).toBe(1);

    // Should preserve the mapping format
    expect(result.content).toContain("provider:");
    expect(result.content).toContain("default:");
    expect(result.content).toContain("base_url:");
  });

  it("should preserve nested model keys in other blocks", () => {
    const input = `model: gpt-3.5
auxiliary:
  research:
    enabled: true
    model: "research-model"
providers:
  test:
    api: "https://example.com/v1"
`;

    const result = migrateModelConfigFormat(input);

    expect(result.modified).toBe(true);

    // Top-level model should be migrated
    expect(result.content).toMatch(/^model:/m);
    expect(result.content).toMatch(/default:\s*["']?gpt-3\.5["']?/);

    // Nested model keys should be preserved
    expect(result.content).toContain('model: "research-model"');

    // Other blocks should be preserved
    expect(result.content).toContain("auxiliary:");
    expect(result.content).toContain("research:");
    expect(result.content).toContain("providers:");
  });

  it("should not modify already-migrated config", () => {
    const input = `model:
  provider: "openai"
  default: "gpt-4"
  base_url: "https://api.openai.com/v1"
providers:
  test:
    api: "https://example.com/v1"
`;

    const result = migrateModelConfigFormat(input);

    expect(result.modified).toBe(false);
    expect(result.content).toBe(input);
  });

  it("should handle empty config", () => {
    const input = "";

    const result = migrateModelConfigFormat(input);

    expect(result.modified).toBe(false);
    expect(result.content).toBe("");
  });

  it("should handle config with only other blocks", () => {
    const input = `providers:
  test:
    api: "https://example.com/v1"
auxiliary:
  research:
    enabled: true
`;

    const result = migrateModelConfigFormat(input);

    expect(result.modified).toBe(false);
    expect(result.content).toBe(input);
  });

  it("should handle malformed duplicate keys without crashing", () => {
    const input = `model: scalar-value
model:
model: another-scalar
providers:
  test:
    api: "https://example.com/v1"
`;

    const result = migrateModelConfigFormat(input);

    expect(result.modified).toBe(true);

    // Should have exactly one model: key after cleanup
    const modelMatches = result.content.match(/^model:/gm);
    expect(modelMatches?.length).toBe(1);
  });
});
