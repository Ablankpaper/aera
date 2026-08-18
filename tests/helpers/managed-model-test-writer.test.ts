// @vitest-environment node

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withManagedModelTestWrite } from "./managed-model-test-writer";

let testHome = "";

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "aera-managed-writer-helper-"));
  vi.stubEnv("HERMES_HOME", testHome);
});

afterEach(async () => {
  const managed =
    await import("../../src/main/model-configuration-managed-files");
  managed.clearManagedModelFileRoots();
  vi.unstubAllEnvs();
  vi.resetModules();
  rmSync(testHome, { recursive: true, force: true });
});

describe("managed model test writer", () => {
  it("uses the current module instance and limits a write to its explicit scope", async () => {
    vi.resetModules();
    const config = await import("../../src/main/config");

    await withManagedModelTestWrite(
      {
        roots: {
          globalRoot: testHome,
          profiles: { default: testHome },
        },
        scope: { globalCatalog: false, profileIds: ["default"] },
      },
      () => config.setEnvValue("TEST_ONLY_KEY", "value"),
    );

    const envFile = join(testHome, ".env");
    expect(existsSync(envFile)).toBe(true);
    expect(readFileSync(envFile, "utf8")).toContain("TEST_ONLY_KEY=value");
    expect(() => config.setEnvValue("OUTSIDE_SCOPE", "blocked")).toThrow(
      /registered managed model file/i,
    );
  });
});
