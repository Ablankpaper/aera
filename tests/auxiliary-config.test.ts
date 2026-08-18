import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "path";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import type { ManagedModelMutationPort } from "../src/main/model-configuration-mutation-port";

// Tests for auxiliary config nested YAML writer and get/set/reset functions.

const TEST_DIR = join(tmpdir(), `hermes-test-aux-config-${Date.now()}`);

async function importAuxConfigWithHome(
  home: string,
): Promise<typeof import("../src/main/auxiliary-config")> {
  vi.resetModules();
  process.env.HERMES_HOME = home;
  const module = await import("../src/main/auxiliary-config");
  const writeAuthority =
    await import("../src/main/model-configuration-write-authority");
  writeAuthority.registerManagedModelFileRoots({
    globalRoot: home,
    profiles: { default: home },
  });
  const authority = new writeAuthority.ModelConfigurationWriteAuthority();
  const defaultDependencies: { modelMutationPort: ManagedModelMutationPort } = {
    modelMutationPort: {
      async mutate(input) {
        return authority.run(
          {
            globalCatalog: input.globalCatalog,
            profileIds: input.profileIds,
          },
          async (permit) => {
            const plan = await input.prepare();
            const value = await plan.write(permit);
            return {
              status: "executed" as const,
              value,
              catalog: {
                revision: "0".repeat(64),
                targetProfileId: input.profileIds[0],
                routes: [],
              },
            };
          },
        );
      },
    },
  };
  return {
    ...module,
    setAuxiliaryTask: (
      task: string,
      cfg: { provider: string; model: string; baseUrl: string },
      profile?: string,
      dependencies = defaultDependencies,
    ) => module.setAuxiliaryTask(task, cfg, profile, dependencies),
    resetAuxiliaryToAuto: (
      profile?: string,
      dependencies = defaultDependencies,
    ) => module.resetAuxiliaryToAuto(profile, dependencies),
  };
}

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  delete process.env.HERMES_HOME;
  vi.resetModules();
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("getAuxiliaryConfig", () => {
  it("returns defaults when config.yaml doesn't exist", async () => {
    const { getAuxiliaryConfig, AUX_TASK_SLOTS } =
      await importAuxConfigWithHome(TEST_DIR);
    const config = getAuxiliaryConfig();

    expect(config).toHaveLength(AUX_TASK_SLOTS.length);
    expect(config[0]).toEqual({
      task: "vision",
      provider: "auto",
      model: "",
      baseUrl: "",
    });
  });

  it("reads existing auxiliary config from config.yaml", async () => {
    writeFileSync(
      join(TEST_DIR, "config.yaml"),
      [
        "auxiliary:",
        "  vision:",
        "    provider: openai",
        "    model: gpt-4o-mini",
        "    base_url: https://api.openai.com/v1",
        "  compression:",
        "    provider: anthropic",
        "    model: claude-haiku",
        "",
      ].join("\n"),
    );

    const { getAuxiliaryConfig } = await importAuxConfigWithHome(TEST_DIR);
    const config = getAuxiliaryConfig();

    const vision = config.find((c) => c.task === "vision");
    expect(vision).toEqual({
      task: "vision",
      provider: "openai",
      model: "gpt-4o-mini",
      baseUrl: "https://api.openai.com/v1",
    });

    const compression = config.find((c) => c.task === "compression");
    expect(compression).toEqual({
      task: "compression",
      provider: "anthropic",
      model: "claude-haiku",
      baseUrl: "",
    });

    const webExtract = config.find((c) => c.task === "web_extract");
    expect(webExtract).toEqual({
      task: "web_extract",
      provider: "auto",
      model: "",
      baseUrl: "",
    });
  });

  it("handles missing fields gracefully", async () => {
    writeFileSync(
      join(TEST_DIR, "config.yaml"),
      [
        "auxiliary:",
        "  vision:",
        "    provider: custom",
        "    # model and base_url missing",
        "",
      ].join("\n"),
    );

    const { getAuxiliaryConfig } = await importAuxConfigWithHome(TEST_DIR);
    const config = getAuxiliaryConfig();

    const vision = config.find((c) => c.task === "vision");
    expect(vision).toEqual({
      task: "vision",
      provider: "custom",
      model: "",
      baseUrl: "",
    });
  });
});

describe("setAuxiliaryField", () => {
  it("creates auxiliary block when missing", async () => {
    const { setAuxiliaryField } = await importAuxConfigWithHome(TEST_DIR);
    const result = setAuxiliaryField("", "vision", "provider", "openai");

    expect(result).toContain("auxiliary:");
    expect(result).toContain("  vision:");
    expect(result).toContain('    provider: "openai"');
  });

  it("creates task sub-block when missing", async () => {
    const content = [
      "auxiliary:",
      "  compression:",
      "    provider: auto",
      "",
    ].join("\n");
    const { setAuxiliaryField } = await importAuxConfigWithHome(TEST_DIR);
    const result = setAuxiliaryField(
      content,
      "vision",
      "provider",
      "anthropic",
    );

    expect(result).toContain("auxiliary:");
    expect(result).toContain("  vision:");
    expect(result).toContain('    provider: "anthropic"');
    // Existing task should remain intact
    expect(result).toContain("  compression:");
  });

  it("updates existing field within task", async () => {
    const content = [
      "auxiliary:",
      "  vision:",
      '    provider: "openai"',
      '    model: "gpt-4o"',
      "",
    ].join("\n");
    const { setAuxiliaryField } = await importAuxConfigWithHome(TEST_DIR);
    const result = setAuxiliaryField(
      content,
      "vision",
      "provider",
      "anthropic",
    );

    expect(result).toContain('    provider: "anthropic"');
    expect(result).toContain('    model: "gpt-4o"');
  });

  it("inserts new field within existing task", async () => {
    const content = [
      "auxiliary:",
      "  vision:",
      '    provider: "openai"',
      "",
    ].join("\n");
    const { setAuxiliaryField } = await importAuxConfigWithHome(TEST_DIR);
    const result = setAuxiliaryField(content, "vision", "model", "gpt-4o-mini");

    expect(result).toContain('    provider: "openai"');
    expect(result).toContain('    model: "gpt-4o-mini"');
  });

  it("preserves other top-level blocks", async () => {
    const content = [
      "model:",
      '  default: "gpt-4o"',
      "auxiliary:",
      "  vision:",
      '    provider: "openai"',
      "personalities:",
      "  default: helpful",
      "",
    ].join("\n");
    const { setAuxiliaryField } = await importAuxConfigWithHome(TEST_DIR);
    const result = setAuxiliaryField(content, "vision", "model", "gpt-4o-mini");

    expect(result).toContain('  default: "gpt-4o"');
    expect(result).toContain("  default: helpful");
    expect(result).toContain('    model: "gpt-4o-mini"');
  });

  it("preserves comments and extra fields in task", async () => {
    const content = [
      "auxiliary:",
      "  vision:",
      "    # Vision model for image analysis",
      '    provider: "openai"',
      "    timeout: 30",
      "",
    ].join("\n");
    const { setAuxiliaryField } = await importAuxConfigWithHome(TEST_DIR);
    const result = setAuxiliaryField(content, "vision", "model", "gpt-4o-mini");

    expect(result).toContain("# Vision model for image analysis");
    expect(result).toContain("    timeout: 30");
    expect(result).toContain('    model: "gpt-4o-mini"');
  });
});

describe("setAuxiliaryTask", () => {
  it("leaves config.yaml unchanged when coordinated persistence is refused", async () => {
    const configFile = join(TEST_DIR, "config.yaml");
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
    const { setAuxiliaryTask } = await importAuxConfigWithHome(TEST_DIR);

    await expect(
      Promise.resolve(
        (
          setAuxiliaryTask as unknown as (
            task: string,
            cfg: { provider: string; model: string; baseUrl: string },
            profile: string | undefined,
            dependencies: { modelMutationPort: typeof mutationPort },
          ) => unknown
        )(
          "vision",
          {
            provider: "openai",
            model: "gpt-4o-mini",
            baseUrl: "https://api.openai.com/v1",
          },
          undefined,
          { modelMutationPort: mutationPort },
        ),
      ),
    ).rejects.toThrow("model_configuration_recovery_required");

    expect(mutationPort.mutate).toHaveBeenCalledTimes(1);
    expect(readFileSync(configFile)).toEqual(before);
  });

  it("writes all three fields to config.yaml", async () => {
    const { setAuxiliaryTask, getAuxiliaryConfig } =
      await importAuxConfigWithHome(TEST_DIR);

    await setAuxiliaryTask("vision", {
      provider: "openai",
      model: "gpt-4o-mini",
      baseUrl: "https://api.openai.com/v1",
    });

    const config = getAuxiliaryConfig();
    const vision = config.find((c) => c.task === "vision");
    expect(vision).toEqual({
      task: "vision",
      provider: "openai",
      model: "gpt-4o-mini",
      baseUrl: "https://api.openai.com/v1",
    });
  });

  it("creates config.yaml when missing", async () => {
    const configFile = join(TEST_DIR, "config.yaml");
    expect(existsSync(configFile)).toBe(false);

    const { setAuxiliaryTask, getAuxiliaryConfig } =
      await importAuxConfigWithHome(TEST_DIR);

    await setAuxiliaryTask("compression", {
      provider: "anthropic",
      model: "claude-haiku",
      baseUrl: "",
    });

    expect(existsSync(configFile)).toBe(true);
    const config = getAuxiliaryConfig();
    const compression = config.find((c) => c.task === "compression");
    expect(compression).toEqual({
      task: "compression",
      provider: "anthropic",
      model: "claude-haiku",
      baseUrl: "",
    });
  });

  it("updates existing task config", async () => {
    writeFileSync(
      join(TEST_DIR, "config.yaml"),
      [
        "auxiliary:",
        "  vision:",
        '    provider: "openai"',
        '    model: "gpt-4o"',
        "",
      ].join("\n"),
    );

    const { setAuxiliaryTask, getAuxiliaryConfig } =
      await importAuxConfigWithHome(TEST_DIR);

    await setAuxiliaryTask("vision", {
      provider: "anthropic",
      model: "claude-sonnet",
      baseUrl: "",
    });

    const config = getAuxiliaryConfig();
    const vision = config.find((c) => c.task === "vision");
    expect(vision).toEqual({
      task: "vision",
      provider: "anthropic",
      model: "claude-sonnet",
      baseUrl: "",
    });
  });

  it("throws for unknown task", async () => {
    const { setAuxiliaryTask } = await importAuxConfigWithHome(TEST_DIR);

    await expect(
      setAuxiliaryTask("unknown_task", {
        provider: "auto",
        model: "",
        baseUrl: "",
      }),
    ).rejects.toThrow("unknown auxiliary task: unknown_task");
  });

  it("handles empty values (sets to auto/empty)", async () => {
    const { setAuxiliaryTask, getAuxiliaryConfig } =
      await importAuxConfigWithHome(TEST_DIR);

    await setAuxiliaryTask("vision", {
      provider: "",
      model: "",
      baseUrl: "",
    });

    const config = getAuxiliaryConfig();
    const vision = config.find((c) => c.task === "vision");
    expect(vision).toEqual({
      task: "vision",
      provider: "auto",
      model: "",
      baseUrl: "",
    });
  });
});

describe("resetAuxiliaryToAuto", () => {
  it("resets all tasks to auto", async () => {
    writeFileSync(
      join(TEST_DIR, "config.yaml"),
      [
        "auxiliary:",
        "  vision:",
        '    provider: "openai"',
        '    model: "gpt-4o"',
        "  compression:",
        '    provider: "anthropic"',
        '    model: "claude-haiku"',
        "",
      ].join("\n"),
    );

    const { resetAuxiliaryToAuto, getAuxiliaryConfig } =
      await importAuxConfigWithHome(TEST_DIR);

    await resetAuxiliaryToAuto();

    const config = getAuxiliaryConfig();
    for (const task of config) {
      expect(task.provider).toBe("auto");
      expect(task.model).toBe("");
    }
  });

  it("does nothing when config.yaml doesn't exist", async () => {
    const configFile = join(TEST_DIR, "config.yaml");
    expect(existsSync(configFile)).toBe(false);

    const { resetAuxiliaryToAuto } = await importAuxConfigWithHome(TEST_DIR);

    await expect(resetAuxiliaryToAuto()).resolves.toBeUndefined();
    expect(existsSync(configFile)).toBe(false);
  });

  it("preserves other config blocks", async () => {
    writeFileSync(
      join(TEST_DIR, "config.yaml"),
      [
        "model:",
        '  default: "gpt-4o"',
        "auxiliary:",
        "  vision:",
        '    provider: "openai"',
        "personalities:",
        "  default: helpful",
        "",
      ].join("\n"),
    );

    const { resetAuxiliaryToAuto } = await importAuxConfigWithHome(TEST_DIR);

    await resetAuxiliaryToAuto();

    const content = readFileSync(join(TEST_DIR, "config.yaml"), "utf-8");
    expect(content).toContain('  default: "gpt-4o"');
    expect(content).toContain("  default: helpful");
  });
});
