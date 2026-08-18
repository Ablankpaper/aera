import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "path";
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "fs";

/**
 * Tests for setToolsetEnabled / getToolsets — the YAML line-by-line
 * state machine that reads/writes platform_toolsets.cli in config.yaml.
 *
 * Regression target: when platform_toolsets: exists but has no cli:
 * subsection, and that section is the last top-level block in the file,
 * setToolsetEnabled silently returns true without writing the cli:
 * block.  The stale file means toolsets appear disabled on every read.
 */

const { TEST_HOME, WRITE_CONTROL } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require("path");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require("os");
  return {
    TEST_HOME: path.join(os.tmpdir(), `hermes-toolset-test-${Date.now()}`),
    WRITE_CONTROL: { count: 0, failAt: 0 },
  };
});

vi.mock("../src/main/installer", () => ({
  HERMES_HOME: TEST_HOME,
  HERMES_PYTHON: "/usr/bin/python3",
  HERMES_REPO: "/dev/null",
  hermesCliArgs: (args: string[] = []) => ["/dev/null", ...args],
  getEnhancedPath: () => process.env.PATH || "",
}));

vi.mock("../src/main/utils", async () => {
  const actual =
    await vi.importActual<typeof import("../src/main/utils")>(
      "../src/main/utils",
    );
  return {
    ...actual,
    safeWriteFile: (...args: Parameters<typeof actual.safeWriteFile>) => {
      WRITE_CONTROL.count += 1;
      if (WRITE_CONTROL.failAt === WRITE_CONTROL.count) {
        throw new Error("fixture write failure");
      }
      return actual.safeWriteFile(...args);
    },
  };
});

vi.mock("../src/main/model-configuration-managed-files", () => ({
  writeManagedModelFile: (
    _permit: unknown,
    target: string,
    bytes: string | Uint8Array,
  ) => {
    WRITE_CONTROL.count += 1;
    if (WRITE_CONTROL.failAt === WRITE_CONTROL.count) {
      throw new Error("fixture write failure");
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("fs") as typeof import("fs");
    fs.writeFileSync(target, bytes);
  },
}));

vi.mock("../src/shared/i18n", () => ({
  t: (key: string) => key.split(".").pop() || key,
}));

vi.mock("../src/main/locale", () => ({
  getAppLocale: () => "en",
}));

import {
  getPlatformToolsets,
  getToolsets,
  setMessagingPlatformToolsetEnabled,
  setToolsetEnabled,
  setToolsetEnabledManaged,
} from "../src/main/tools";

const CONFIG_FILE = join(TEST_HOME, "config.yaml");

beforeEach(() => {
  WRITE_CONTROL.count = 0;
  WRITE_CONTROL.failAt = 0;
  mkdirSync(TEST_HOME, { recursive: true });
});

afterEach(() => {
  vi.resetModules();
  if (existsSync(TEST_HOME)) {
    rmSync(TEST_HOME, { recursive: true, force: true });
  }
});

function writeConfig(content: string): void {
  writeFileSync(CONFIG_FILE, content);
}

function readConfig(): string {
  return readFileSync(CONFIG_FILE, "utf-8");
}

describe("setToolsetEnabled — platform_toolsets without cli subsection", () => {
  it("writes cli subsection when platform_toolsets block exists but has no cli (last block)", () => {
    writeConfig("model:\n  default: gpt-4o\nplatform_toolsets:\n");

    const result = setToolsetEnabled("web", true);
    expect(result).toBe(true);

    const after = readConfig();
    expect(after).toContain("cli:");
    expect(after).toContain("      - web");
  });

  it("writes cli subsection when platform_toolsets block has sibling keys but no cli (last block)", () => {
    writeConfig(
      "model:\n  default: gpt-4o\nplatform_toolsets:\n  other_key: value\n",
    );

    const result = setToolsetEnabled("web", true);
    expect(result).toBe(true);

    const after = readConfig();
    expect(after).toContain("cli:");
    expect(after).toContain("      - web");
  });

  it("writes cli subsection when platform_toolsets is the ONLY top-level block", () => {
    writeConfig("platform_toolsets:\n");

    const result = setToolsetEnabled("browser", true);
    expect(result).toBe(true);

    const after = readConfig();
    expect(after).toContain("cli:");
    expect(after).toContain("      - browser");
  });

  it("preserves existing non-cli siblings when inserting cli", () => {
    writeConfig(
      [
        "model:",
        "  default: gpt-4o",
        "platform_toolsets:",
        "  some_config: true",
        "",
      ].join("\n"),
    );

    const result = setToolsetEnabled("terminal", true);
    expect(result).toBe(true);

    const after = readConfig();
    expect(after).toContain("cli:");
    expect(after).toContain("      - terminal");
    expect(after).toContain("some_config: true");
  });

  it("reads back the enabled toolset after writing (round-trip)", () => {
    writeConfig("model:\n  default: gpt-4o\nplatform_toolsets:\n");

    setToolsetEnabled("web", true);
    setToolsetEnabled("file", true);

    // Reimport so getToolsets reads the freshly-written file (no cache pollution)
    const toolsets = getToolsets();
    const webTs = toolsets.find((t) => t.key === "web");
    const fileTs = toolsets.find((t) => t.key === "file");
    const memTs = toolsets.find((t) => t.key === "memory");

    expect(webTs?.enabled).toBe(true);
    expect(fileTs?.enabled).toBe(true);
    expect(memTs?.enabled).toBe(true);
  });

  it("round-trips disable after enable when cli was initially missing", () => {
    writeConfig("model:\n  default: gpt-4o\nplatform_toolsets:\n");

    // Enable → should create cli section
    setToolsetEnabled("web", true);
    let toolsets = getToolsets();
    expect(toolsets.find((t) => t.key === "web")?.enabled).toBe(true);

    // Disable → should remove web from cli
    setToolsetEnabled("web", false);
    toolsets = getToolsets();
    expect(toolsets.find((t) => t.key === "web")?.enabled).toBe(false);
  });
});

describe("setToolsetEnabled — no config file", () => {
  it("returns false when config.yaml does not exist", () => {
    const result = setToolsetEnabled("web", true);
    expect(result).toBe(false);
  });
});

describe("setToolsetEnabled — no platform_toolsets section (C1)", () => {
  it("leaves config.yaml unchanged when coordinated persistence is refused", async () => {
    writeConfig("model:\n  default: gpt-4o\n");
    const before = readConfig();
    const mutationPort = {
      mutate: vi.fn(async () => ({
        status: "rejected" as const,
        stage: "recovery" as const,
        code: "model_configuration_recovery_required" as const,
        rollback: "recovery_required" as const,
        diagnosticId: "0123456789ab",
      })),
    };

    await expect(
      setToolsetEnabledManaged("web", false, undefined, {
        modelMutationPort: mutationPort,
      }),
    ).rejects.toThrow("model_configuration_recovery_required");

    expect(mutationPort.mutate).toHaveBeenCalledTimes(1);
    expect(readConfig()).toBe(before);
  });

  // @lat: [[image-generation#Default conversation admission]]
  it("keeps image generation enabled when a first unrelated toggle materializes cli", () => {
    writeConfig("model:\n  default: gpt-4o\n");

    expect(setToolsetEnabled("web", false)).toBe(true);

    const toolsets = getToolsets();
    expect(toolsets.find((tool) => tool.key === "web")?.enabled).toBe(false);
    expect(toolsets.find((tool) => tool.key === "image_gen")?.enabled).toBe(
      true,
    );
    expect(toolsets.find((tool) => tool.key === "memory")?.enabled).toBe(true);
  });

  it("honors an explicit Profile image generation disable without a cli list", () => {
    writeConfig("image_gen:\n  enabled: false\n");

    const toolsets = getToolsets();

    expect(toolsets.find((tool) => tool.key === "image_gen")?.enabled).toBe(
      false,
    );
    expect(toolsets.find((tool) => tool.key === "web")?.enabled).toBe(true);
  });

  // @lat: [[image-generation#Explicit Profile opt-out]]
  it("persists the image generation card toggle as the Profile override", () => {
    writeConfig("model:\n  default: gpt-4o\n");

    expect(setToolsetEnabled("image_gen", false)).toBe(true);
    expect(readConfig()).toContain("image_gen:");
    expect(readConfig()).toContain("enabled: false");
    expect(
      getToolsets().find((tool) => tool.key === "image_gen")?.enabled,
    ).toBe(false);

    expect(setToolsetEnabled("image_gen", true)).toBe(true);
    expect(readConfig()).toContain("enabled: true");
    expect(
      getToolsets().find((tool) => tool.key === "image_gen")?.enabled,
    ).toBe(true);
  });

  it("leaves both image settings unchanged when their one atomic write fails", () => {
    writeConfig("model:\n  default: gpt-4o\n");
    const before = readConfig();
    WRITE_CONTROL.failAt = 1;

    expect(() => setToolsetEnabled("image_gen", false)).toThrow(
      "fixture write failure",
    );

    expect(readConfig()).toBe(before);
    expect(WRITE_CONTROL.count).toBe(1);
  });

  it("appends platform_toolsets.cli when the key is totally absent", () => {
    writeConfig("model:\n  default: gpt-4o\n");

    const result = setToolsetEnabled("vision", true);
    expect(result).toBe(true);

    const after = readConfig();
    expect(after).toContain("platform_toolsets:");
    expect(after).toContain("  cli:");
    expect(after).toContain("      - vision");
    expect(after).toContain("model:");
    expect(after).toContain("default: gpt-4o");
  });

  it("appends only once on repeated calls", () => {
    writeConfig("model:\n  default: gpt-4o\n");

    setToolsetEnabled("web", true);
    setToolsetEnabled("vision", true);

    const after = readConfig();
    const n = after.split("platform_toolsets:").length - 1;
    expect(n).toBe(1);
  });

  it("reads back the appended toolset (round-trip)", () => {
    writeConfig("model:\n  default: gpt-4o\n");

    setToolsetEnabled("memory", true);

    const toolsets = getToolsets();
    expect(toolsets.find((t) => t.key === "memory")?.enabled).toBe(true);
  });
});

describe("setToolsetEnabled — existing cli subsection (C2a)", () => {
  it("replaces in-place when enabling a new toolset alongside existing ones", () => {
    writeConfig(
      [
        "model:",
        "  default: gpt-4o",
        "platform_toolsets:",
        "  cli:",
        "      - web",
        "      - terminal",
        "",
      ].join("\n"),
    );

    setToolsetEnabled("vision", true);

    const after = readConfig();
    expect(after).toContain("      - web");
    expect(after).toContain("      - terminal");
    expect(after).toContain("      - vision");
  });

  it("removes a toolset from the list when disabling an existing one", () => {
    writeConfig(
      [
        "model:",
        "  default: gpt-4o",
        "platform_toolsets:",
        "  cli:",
        "      - web",
        "      - terminal",
        "      - vision",
        "",
      ].join("\n"),
    );

    setToolsetEnabled("terminal", false);

    const after = readConfig();
    expect(after).toContain("      - web");
    expect(after).toContain("      - vision");
    expect(after).not.toContain("      - terminal");
  });

  it("round-trips enable after disable on an existing cli list", () => {
    writeConfig(["platform_toolsets:", "  cli:", "      - web", ""].join("\n"));

    setToolsetEnabled("web", false);
    let toolsets = getToolsets();
    expect(toolsets.find((t) => t.key === "web")?.enabled).toBe(false);

    setToolsetEnabled("web", true);
    toolsets = getToolsets();
    expect(toolsets.find((t) => t.key === "web")?.enabled).toBe(true);
  });
});

describe("setToolsetEnabled — disable all (C2d)", () => {
  it("handles empty cli list gracefully when last toolset is disabled", () => {
    writeConfig(["platform_toolsets:", "  cli:", "      - web", ""].join("\n"));

    const result = setToolsetEnabled("web", false);
    expect(result).toBe(true);

    const after = readConfig();
    expect(after).toContain("platform_toolsets:");
    expect(after).toContain("  cli:");
  });
});

describe("setMessagingPlatformToolsetEnabled", () => {
  it("writes a messaging platform subsection without changing cli", () => {
    writeConfig(
      [
        "platform_toolsets:",
        "  cli:",
        "      - web",
        "  telegram:",
        "      - memory",
        "",
      ].join("\n"),
    );

    const result = setMessagingPlatformToolsetEnabled(
      "telegram",
      "browser",
      true,
    );
    expect(result).toBe(true);

    const after = readConfig();
    expect(after).toContain("  cli:");
    expect(after).toContain("      - web");
    expect(after).toContain("  telegram:");
    expect(after).toContain("      - browser");
    expect(after).toContain("      - memory");
  });

  it("starts from safe messaging defaults when the platform has no explicit list", () => {
    writeConfig(["platform_toolsets:", "  cli:", "      - web", ""].join("\n"));

    const result = setMessagingPlatformToolsetEnabled(
      "telegram",
      "browser",
      true,
    );
    expect(result).toBe(true);

    const toolsets = getPlatformToolsets();
    expect(toolsets.telegram).toContain("browser");
    expect(toolsets.telegram).toContain("web");
    expect(toolsets.telegram).toContain("memory");
    expect(toolsets.telegram).not.toContain("terminal");
  });

  it("respects an explicit empty messaging platform toolset list", () => {
    writeConfig(["platform_toolsets:", "  telegram: []", ""].join("\n"));

    const toolsets = getPlatformToolsets();
    expect(toolsets.telegram).toEqual([]);

    setMessagingPlatformToolsetEnabled("telegram", "browser", true);
    expect(getPlatformToolsets().telegram).toEqual(["browser"]);
  });
});
