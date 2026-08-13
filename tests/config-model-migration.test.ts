import { describe, it, expect } from "vitest";
import {
  migrateModelConfigFormat,
  validateModelConfiguration,
} from "../src/main/config-model-migration";

describe("config-model-migration", () => {
  it("should leave empty config unchanged", () => {
    const result = migrateModelConfigFormat("");
    expect(result.modified).toBe(false);
    expect(result.content).toBe("");
    expect(result.summary).toContain("Empty config");
  });

  it("should leave well-formed model mapping unchanged", () => {
    const content = `model:
  provider: "openai"
  default: "gpt-4"
  base_url: "https://api.openai.com/v1"
providers:
  custom-provider:
    api: "https://example.com/v1"
`;
    const result = migrateModelConfigFormat(content);
    expect(result.modified).toBe(false);
    expect(result.summary).toContain("already well-formed");
  });

  it("should migrate legacy scalar model to mapping", () => {
    const content = `model: gpt-4
providers:
  test:
    api: "https://example.com/v1"
`;
    const result = migrateModelConfigFormat(content);
    expect(result.modified).toBe(true);
    expect(result.summary).toContain("Migrated legacy scalar");
    expect(result.content).toContain("model:");
    expect(result.content).toContain("default: gpt-4");
    expect(result.content).toContain("providers:");
  });

  it("should remove duplicate model keys keeping the mapping", () => {
    const content = `model: old-gpt-3.5
model:
  provider: "custom:petoi"
  default: "old-gpt-3.5"
  base_url: "https://api.example.com/v1"
providers:
  petoi:
    name: "Petoi API"
    api: "https://api.example.com/v1"
    key_env: "CUSTOM_PROVIDER_PETOI_KEY"
`;
    const result = migrateModelConfigFormat(content);
    expect(result.modified).toBe(true);
    expect(result.summary).toContain("Removed duplicate model:");

    // Should have exactly one "model:" at column 0
    const modelMatches = result.content.match(/^model:/gm);
    expect(modelMatches?.length).toBe(1);

    // Should preserve the mapping structure
    expect(result.content).toContain("provider:");
    expect(result.content).toContain("default:");
    expect(result.content).toContain("providers:");
  });

  it("should handle empty scalar model", () => {
    const content = `model: ""
providers:
  test:
    api: "https://example.com/v1"
`;
    const result = migrateModelConfigFormat(content);
    expect(result.modified).toBe(true);
    expect(result.summary).toContain("Removed empty legacy");
    expect(result.content).not.toContain("model:");
    expect(result.content).toContain("providers:");
  });

  it("should reject malformed YAML", () => {
    const content = `model:
  provider: "openai
  default: unquoted
    bad_indent: value
`;
    expect(() => migrateModelConfigFormat(content)).toThrow(
      /Cannot migrate model config/,
    );
  });

  it("should leave config without model key unchanged", () => {
    const content = `providers:
  test:
    api: "https://example.com/v1"
auxiliary:
  research:
    enabled: true
`;
    const result = migrateModelConfigFormat(content);
    expect(result.modified).toBe(false);
    expect(result.summary).toContain("No model key");
  });

  it("should preserve comments and formatting around model block", () => {
    const content = `# Top-level comment
model:
  provider: "openai"
  default: "gpt-4"  # inline comment
  base_url: "https://api.openai.com/v1"

# Section comment
providers:
  test:
    api: "https://example.com/v1"
`;
    const result = migrateModelConfigFormat(content);
    expect(result.modified).toBe(false);
    // Comments should be preserved (though exact formatting may vary)
    expect(result.content).toContain("providers:");
  });

  it("should handle multiple duplicate model blocks", () => {
    const content = `model: first-scalar
model:
  provider: "openai"
  default: "gpt-4"
model: second-scalar
providers:
  test:
    api: "https://example.com/v1"
`;
    const result = migrateModelConfigFormat(content);
    expect(result.modified).toBe(true);

    // Should have exactly one "model:" at column 0
    const modelMatches = result.content.match(/^model:/gm);
    expect(modelMatches?.length).toBe(1);

    // Should keep the mapping, not the scalars
    expect(result.content).toContain("provider:");
    expect(result.content).toContain("default:");
  });

  it("should not touch nested model keys in other blocks", () => {
    const content = `model:
  provider: "openai"
  default: "gpt-4"
auxiliary:
  research:
    model: "different-model"  # This should stay untouched
    enabled: true
`;
    const result = migrateModelConfigFormat(content);
    expect(result.modified).toBe(false);
    expect(result.content).toContain('model: "different-model"');
  });
});

describe("validateModelConfiguration", () => {
  it("should accept a canonical mapping model", () => {
    const content = `model:
  provider: "openai"
  default: "gpt-4"
providers:
  custom-provider:
    api: "https://example.com/v1"
`;
    expect(validateModelConfiguration(content)).toBe(true);
  });

  it("should accept a single legacy scalar model", () => {
    const content = `model: gpt-4
providers:
  test:
    api: "https://example.com/v1"
`;
    expect(validateModelConfiguration(content)).toBe(true);
  });

  it("should accept empty or missing config", () => {
    expect(validateModelConfiguration("")).toBe(true);
    expect(validateModelConfiguration("# comment only\n")).toBe(true);
  });

  it("should reject duplicate top-level model keys", () => {
    const content = `model: old-gpt-3.5
model:
  provider: "openai"
  default: "gpt-4"
providers:
  test:
    api: "https://example.com/v1"
`;
    expect(() => validateModelConfiguration(content)).toThrowError(
      expect.objectContaining({ code: "model_config_validation_failed" }),
    );
  });

  it("should reject a non-mapping providers block", () => {
    const content = `model:
  provider: "openai"
  default: "gpt-4"
providers: not-a-mapping
`;
    expect(() => validateModelConfiguration(content)).toThrowError(
      expect.objectContaining({ code: "model_config_validation_failed" }),
    );
  });

  it("should reject malformed YAML", () => {
    const content = `model:
  provider: "openai
  default: unquoted
    bad_indent: value
`;
    expect(() => validateModelConfiguration(content)).toThrowError(
      expect.objectContaining({ code: "model_config_validation_failed" }),
    );
  });
});
