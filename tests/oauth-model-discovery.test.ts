import { beforeEach, describe, expect, it, vi } from "vitest";
import { sep } from "node:path";

/**
 * Coverage for OAuth/subscription-provider model discovery.
 *
 * These providers have no static-key `/v1/models` endpoint, so the
 * desktop asks hermes-agent's `provider_model_ids` via a short Python
 * call. When that's unavailable it falls back to a curated list mirrored
 * from the agent. Both paths are exercised here with a mocked
 * `child_process.execFile`.
 */

const { execFileSpy, behavior, childKillSpy } = vi.hoisted(() => {
  const behavior: { err: Error | null; stdout: string; hold: boolean } = {
    err: null,
    stdout: "",
    hold: false,
  };
  const childKillSpy = vi.fn();
  return {
    behavior,
    childKillSpy,
    execFileSpy: vi.fn(
      (
        _file: unknown,
        _args: unknown,
        _opts: unknown,
        cb: (e: Error | null, out: string, errOut: string) => void,
      ) => {
        if (!behavior.hold) cb(behavior.err, behavior.stdout, "");
        return { kill: childKillSpy };
      },
    ),
  };
});

vi.mock("child_process", () => ({
  execFile: execFileSpy,
  default: { execFile: execFileSpy },
}));

vi.mock("../src/main/installer", () => ({
  expectedEnvKeyForModel: () => "",
  HERMES_HOME: "/tmp/hermes-home",
  getEnhancedPath: () => process.env.PATH || "",
}));

vi.mock("../src/main/agentera-runtime-distribution/invocation", () => ({
  getRuntimeInvocation: () => ({
    source: "managed",
    version: "test",
    sourceCommit: "0".repeat(40),
    root: "/tmp/runtime/test",
    python: "/usr/bin/python3",
    workingDirectory: "/tmp/runtime/test/python/lib/python3.11/site-packages",
    bundledSkillsDirectory: "/tmp/runtime/test/python/skills",
    webDistDirectory:
      "/tmp/runtime/test/python/lib/python3.11/site-packages/hermes_cli/web_dist",
    cliArgs: (args: string[] = []) => ["-m", "hermes_cli.main", ...args],
    environment: (base: Record<string, string> = {}) => ({ ...base }),
  }),
}));

vi.mock("../src/main/config", () => ({
  readEnv: () => ({}),
}));

import {
  discoverProviderModels,
  _clearCache,
} from "../src/main/model-discovery";

describe("OAuth provider model discovery", () => {
  beforeEach(() => {
    _clearCache();
    execFileSpy.mockClear();
    childKillSpy.mockClear();
    behavior.err = null;
    behavior.stdout = "";
    behavior.hold = false;
  });

  it("returns the live provider_model_ids list for an OAuth provider", async () => {
    behavior.stdout = '["gpt-5.5", "gpt-5.3-codex", "gpt-5.2-codex"]';
    const result = await discoverProviderModels(
      "openai-codex",
      undefined,
      undefined,
      undefined,
    );
    expect(result.status).toBe("success_with_models");
    // sorted + de-duped
    expect(result.models).toEqual([
      "gpt-5.2-codex",
      "gpt-5.3-codex",
      "gpt-5.5",
    ]);
    // the python call carried the provider as the snippet's argv
    const call = execFileSpy.mock.calls[0];
    expect((call[1] as string[])[(call[1] as string[]).length - 1]).toBe(
      "openai-codex",
    );
  });

  it("falls back to the curated list when the Python call fails", async () => {
    behavior.err = new Error("python: command not found");
    const result = await discoverProviderModels(
      "openai-codex",
      undefined,
      undefined,
      undefined,
    );
    expect(result.status).toBe("success_with_models");
    expect(result.models).toContain("gpt-5.3-codex");
    expect(result.models.length).toBeGreaterThan(0);
  });

  it("falls back when stdout is not a JSON array", async () => {
    behavior.stdout = "Traceback (most recent call last):\n  ImportError";
    const result = await discoverProviderModels(
      "xai-oauth",
      undefined,
      undefined,
      undefined,
    );
    expect(result.models).toContain("grok-4.3");
  });

  it("falls back when the live list comes back empty", async () => {
    behavior.stdout = "[]";
    const result = await discoverProviderModels(
      "google-gemini-cli",
      undefined,
      undefined,
      undefined,
    );
    expect(result.models).toContain("gemini-3-pro-preview");
  });

  it("caches the result so a second call skips the Python spawn", async () => {
    behavior.stdout = '["gpt-5.5"]';
    const first = await discoverProviderModels(
      "openai-codex",
      undefined,
      undefined,
      undefined,
    );
    expect(first.cached).toBe(false);
    const second = await discoverProviderModels(
      "openai-codex",
      undefined,
      undefined,
      undefined,
    );
    expect(second.cached).toBe(true);
    expect(second.models).toEqual(["gpt-5.5"]);
    expect(execFileSpy).toHaveBeenCalledTimes(1);
  });

  it("honors cancellation even when an OAuth result is already cached", async () => {
    behavior.stdout = '["cached-model"]';
    const first = await discoverProviderModels(
      "openai-codex",
      undefined,
      undefined,
      "profile-a",
    );
    expect(first.cached).toBe(false);

    const controller = new AbortController();
    controller.abort();
    const cancelled = await discoverProviderModels(
      "openai-codex",
      undefined,
      undefined,
      "profile-a",
      { signal: controller.signal },
    );

    expect(cancelled).toMatchObject({
      status: "cancelled",
      models: [],
      cached: false,
    });
    expect(execFileSpy).toHaveBeenCalledTimes(1);
  });

  it("isolates OAuth and free-model caches by profile", async () => {
    behavior.stdout = '["profile-a-model"]';
    const first = await discoverProviderModels(
      "openai-codex",
      undefined,
      undefined,
      "profile-a",
    );
    expect(first.cached).toBe(false);

    behavior.stdout = '["profile-b-model"]';
    const second = await discoverProviderModels(
      "openai-codex",
      undefined,
      undefined,
      "profile-b",
    );
    expect(second.cached).toBe(false);
    expect(second.models).toEqual(["profile-b-model"]);

    const profileAAgain = await discoverProviderModels(
      "openai-codex",
      undefined,
      undefined,
      "profile-a",
    );
    expect(profileAAgain.cached).toBe(true);
    expect(profileAAgain.models).toEqual(["profile-a-model"]);
    expect(execFileSpy).toHaveBeenCalledTimes(2);

    const firstEnv = (
      execFileSpy.mock.calls[0][2] as { env: NodeJS.ProcessEnv }
    ).env;
    const secondEnv = (
      execFileSpy.mock.calls[1][2] as {
        env: NodeJS.ProcessEnv;
      }
    ).env;
    const normalizePath = (value: string | undefined): string =>
      value?.split(sep).join("/") ?? "";
    expect(normalizePath(firstEnv.HERMES_HOME)).toContain("profiles/profile-a");
    expect(normalizePath(secondEnv.HERMES_HOME)).toContain("profiles/profile-b");
    expect(firstEnv.HERMES_HOME).not.toBe(secondEnv.HERMES_HOME);
  });

  it("returns cancelled and terminates an in-flight OAuth discovery", async () => {
    behavior.hold = true;
    const controller = new AbortController();
    const pending = discoverProviderModels(
      "openai-codex",
      undefined,
      undefined,
      "profile-a",
      { signal: controller.signal, timeoutMs: 1_000 },
    );
    controller.abort();

    await expect(pending).resolves.toMatchObject({
      status: "cancelled",
      models: [],
      cached: false,
    });
    expect(childKillSpy).toHaveBeenCalledTimes(1);
  });

  it("does not spawn OAuth discovery when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await discoverProviderModels(
      "openai-codex",
      undefined,
      undefined,
      "profile-a",
      { signal: controller.signal },
    );

    expect(result).toMatchObject({
      status: "cancelled",
      models: [],
      cached: false,
    });
    expect(execFileSpy).not.toHaveBeenCalled();
  });

  it("returns timeout and terminates a hung OAuth discovery", async () => {
    behavior.hold = true;
    const result = await discoverProviderModels(
      "openai-codex",
      undefined,
      undefined,
      "profile-a",
      { timeoutMs: 10 },
    );

    expect(result).toMatchObject({
      status: "timeout",
      models: [],
      cached: false,
    });
    expect(childKillSpy).toHaveBeenCalledTimes(1);
  });
});
