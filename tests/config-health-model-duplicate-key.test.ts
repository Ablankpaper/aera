import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "path";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";

/**
 * The write-path migration only repairs a corrupted `config.yaml` when
 * something actually writes to it. A user whose config was already broken by
 * an earlier build — and who therefore cannot save at all — needs the damage
 * surfaced and repaired directly. Config health is that surface.
 *
 * @lat: [[legacy-model-config-migration#Config health repair]]
 */

const TEST_DIR = join(tmpdir(), `hermes-cfg-health-dupmodel-${process.pid}`);

async function importHealthWithHome(
  home: string,
): Promise<typeof import("../src/main/config-health")> {
  vi.resetModules();
  process.env.HERMES_HOME = home;
  return await import("../src/main/config-health");
}

const CORRUPTED = [
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
].join("\n");

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  delete process.env.HERMES_HOME;
  vi.resetModules();
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("config health — duplicate top-level model key", () => {
  // @lat: [[legacy-model-config-migration#Config health repair#Reports a duplicated model key as an auto-fixable error]]
  it("reports a duplicated model key as an auto-fixable error", async () => {
    writeFileSync(join(TEST_DIR, "config.yaml"), CORRUPTED, "utf-8");
    const health = await importHealthWithHome(TEST_DIR);

    const issue = health
      .runConfigHealthCheck()
      .issues.find((entry) => entry.code === "MODEL_CONFIG_DUPLICATE_KEY");

    expect(issue).toBeDefined();
    expect(issue?.severity).toBe("error");
    expect(issue?.autoFixable).toBe(true);
    // The credential reference may be named, but never its value.
    expect(issue?.detail ?? "").not.toMatch(/sk-[A-Za-z0-9]/);
  });

  // @lat: [[legacy-model-config-migration#Config health repair#Repairs the file in place]]
  it("repairs the file in place, keeping one mapping and every other block", async () => {
    const configFile = join(TEST_DIR, "config.yaml");
    writeFileSync(configFile, CORRUPTED, "utf-8");
    const health = await importHealthWithHome(TEST_DIR);

    const result = health.autoFixIssue("MODEL_CONFIG_DUPLICATE_KEY");
    expect(result.ok).toBe(true);

    const content = readFileSync(configFile, "utf-8");
    expect((content.match(/^model:[^\r\n]*$/gm) ?? []).length).toBe(1);
    expect(content).toContain("providers:");
    expect(content).toContain('key_env: "PETOI_API_KEY"');

    // Re-scanning a repaired file reports the issue as resolved.
    const rescan = health
      .runConfigHealthCheck()
      .issues.find((entry) => entry.code === "MODEL_CONFIG_DUPLICATE_KEY");
    expect(rescan).toBeUndefined();
  });

  it("plans the duplicate-key repair without changing the live file", async () => {
    const configFile = join(TEST_DIR, "config.yaml");
    writeFileSync(configFile, CORRUPTED, "utf-8");
    const health = await importHealthWithHome(TEST_DIR);

    const plan = health.planConfigHealthAutoFix(
      "MODEL_CONFIG_DUPLICATE_KEY",
      "default",
    );

    expect(plan.result).toMatchObject({ ok: true });
    expect(plan.auditEntries).toHaveLength(1);
    expect(readFileSync(configFile, "utf8")).toBe(CORRUPTED);
    expect(plan.writePlan?.after?.toString("utf8")).toContain("providers:");
    expect(
      plan.writePlan?.after?.toString("utf8").match(/^model:[^\r\n]*$/gm),
    ).toHaveLength(1);
  });

  // @lat: [[legacy-model-config-migration#Config health repair#Reports invalid YAML under its own code]]
  it("reports unparseable YAML under its own code, with no merge suggestion", async () => {
    writeFileSync(
      join(TEST_DIR, "config.yaml"),
      "model:\n  provider: [unclosed\nproviders: : :\n",
      "utf-8",
    );
    const health = await importHealthWithHome(TEST_DIR);
    const issues = health.runConfigHealthCheck().issues;

    const issue = issues.find((e) => e.code === "MODEL_CONFIG_UNPARSEABLE");
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe("error");
    // No mechanical repair exists, so no Fix button and no merge advice.
    expect(issue?.autoFixable).toBe(false);
    expect(issue?.fixDescription).toBeUndefined();
    expect(issue?.detail ?? "").not.toMatch(/merge/i);
    // And it must not be misfiled as a duplicate key.
    expect(
      issues.find((e) => e.code === "MODEL_CONFIG_DUPLICATE_KEY"),
    ).toBeUndefined();
  });

  // @lat: [[legacy-model-config-migration#Config health repair#Reports a non-mapping providers block under its own code]]
  it("reports a non-mapping providers block under its own code", async () => {
    writeFileSync(
      join(TEST_DIR, "config.yaml"),
      ["model:", '  default: "gpt-4"', "providers: invalid", ""].join("\n"),
      "utf-8",
    );
    const health = await importHealthWithHome(TEST_DIR);
    const issues = health.runConfigHealthCheck().issues;

    const issue = issues.find(
      (e) => e.code === "MODEL_CONFIG_PROVIDERS_NOT_MAPPING",
    );
    expect(issue).toBeDefined();
    expect(issue?.autoFixable).toBe(false);
    expect(issue?.detail ?? "").not.toMatch(/merge/i);
    expect(
      issues.find((e) => e.code === "MODEL_CONFIG_DUPLICATE_KEY"),
    ).toBeUndefined();
  });

  // @lat: [[legacy-model-config-migration#Config health repair#Refuses to auto-fix a non-duplicate problem]]
  it("refuses to run the merge repair on a non-duplicate problem", async () => {
    const configFile = join(TEST_DIR, "config.yaml");
    const original = [
      "model:",
      '  default: "gpt-4"',
      "providers: invalid",
      "",
    ].join("\n");
    writeFileSync(configFile, original, "utf-8");
    const health = await importHealthWithHome(TEST_DIR);

    const result = health.autoFixIssue("MODEL_CONFIG_DUPLICATE_KEY");
    expect(result.ok).toBe(false);
    // The refusal must name the real remedy. Letting the migration throw and
    // surfacing its raw parser message also refuses, but tells the user
    // nothing they can act on.
    expect(result.message ?? "").toMatch(/manual edit/i);
    expect(result.message ?? "").not.toMatch(/merge/i);
    // Refusing must leave the file exactly as the user wrote it.
    expect(readFileSync(configFile, "utf-8")).toBe(original);
  });

  // @lat: [[legacy-model-config-migration#Config health repair#Stays silent on a healthy config]]
  it("stays silent on a canonical config", async () => {
    writeFileSync(
      join(TEST_DIR, "config.yaml"),
      [
        "model:",
        '  provider: "openai"',
        '  default: "gpt-4"',
        "auxiliary:",
        "  research:",
        '    model: "research-model"',
        "",
      ].join("\n"),
      "utf-8",
    );
    const health = await importHealthWithHome(TEST_DIR);

    expect(
      health
        .runConfigHealthCheck()
        .issues.find((e) => e.code === "MODEL_CONFIG_DUPLICATE_KEY"),
    ).toBeUndefined();
  });
});
