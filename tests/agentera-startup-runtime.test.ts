// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

const { runtimeState, TEST_HOME } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require("path");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require("os");
  return {
    runtimeState: { prepared: true },
    TEST_HOME: path.join(os.tmpdir(), `agentera-preflight-${Date.now()}`),
  };
});

vi.mock("../src/main/agentera-runtime-distribution/invocation", () => ({
  getRuntimeInvocation: () =>
    runtimeState.prepared
      ? {
          source: "managed",
          version: "test",
          sourceCommit: "0".repeat(40),
          root: "/tmp/runtime/test",
          python: "/tmp/runtime/test/python/bin/python3",
          workingDirectory:
            "/tmp/runtime/test/python/lib/python3.11/site-packages",
          bundledSkillsDirectory: "/tmp/runtime/test/python/skills",
          webDistDirectory:
            "/tmp/runtime/test/python/lib/python3.11/site-packages/hermes_cli/web_dist",
          cliArgs: (args: string[] = []) => ["-m", "hermes_cli.main", ...args],
          environment: (base: Record<string, string> = {}) => ({ ...base }),
        }
      : null,
}));

vi.mock("../src/main/utils", () => ({
  getActiveProfileNameSync: () => undefined,
  profileHome: () => TEST_HOME,
}));

import { probeAgenteraInstallFiles } from "../src/main/agentera-startup-preflight";

describe("AgentEra startup Runtime probe", () => {
  it("tracks the live managed Runtime selection without reading user data", () => {
    runtimeState.prepared = true;
    expect(probeAgenteraInstallFiles()).toEqual({
      installed: true,
      configured: false,
      hasApiKey: false,
    });

    runtimeState.prepared = false;
    expect(probeAgenteraInstallFiles()).toEqual({
      installed: false,
      configured: false,
      hasApiKey: false,
    });
  });
});
