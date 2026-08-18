// @vitest-environment node

import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  createProviderCredentialRefreshPort,
  type ProviderCredentialRefreshPortOptions,
  RUNTIME_CREDENTIAL_REFRESH_SCRIPT,
  type ProviderCredentialRefreshInput,
} from "./provider-credential-refresh";
import type { RuntimeInvocation } from "./agentera-runtime-distribution/invocation";

function ownerLease(): ProviderCredentialRefreshInput["ownerLease"] {
  return {
    epoch: 1,
    signal: new AbortController().signal,
    assertCurrent: vi.fn(),
  };
}

function invocation(): RuntimeInvocation {
  return {
    source: "managed",
    version: "1.0.0",
    sourceCommit: "a".repeat(40),
    root: "/runtime",
    python: "/runtime/python",
    workingDirectory: "/runtime/site-packages",
    bundledSkillsDirectory: "/runtime/skills",
    webDistDirectory: "/runtime/web-dist",
    cliArgs: () => [],
    environment: (base = {}) => ({ ...base, HERMES_HOME: "/profile" }),
  };
}

class FakeChild extends PassThrough {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  kill = vi.fn(() => true);
}

type Spawn = NonNullable<ProviderCredentialRefreshPortOptions["spawn"]>;

function eligibleInput(
  overrides: Partial<ProviderCredentialRefreshInput> = {},
): ProviderCredentialRefreshInput {
  return {
    provider: "openai-codex",
    profile: "default",
    ownerLease: ownerLease(),
    eligibility: {
      source: "runtime_pool",
      authType: "oauth",
      hasRefreshToken: true,
    },
    ...overrides,
  };
}

describe("Runtime-owned provider credential refresh", () => {
  it("selects a loaded pool credential before attempting refresh", () => {
    expect(RUNTIME_CREDENTIAL_REFRESH_SCRIPT).toContain(
      "entry = pool.current() or pool.peek()",
    );
    expect(RUNTIME_CREDENTIAL_REFRESH_SCRIPT).toContain(
      "pool.try_refresh_matching()",
    );
  });

  it.each([
    {
      source: "static_key" as const,
      authType: "api_key",
      hasRefreshToken: false,
    },
    {
      source: "renderer" as const,
      authType: "oauth",
      hasRefreshToken: true,
    },
    {
      source: "runtime_pool" as const,
      authType: "api_key",
      hasRefreshToken: true,
    },
    {
      source: "runtime_pool" as const,
      authType: "oauth",
      hasRefreshToken: false,
    },
  ])(
    "does not spawn for ineligible $source/$authType credentials",
    async (eligibility) => {
      const spawn = vi.fn();
      const port = createProviderCredentialRefreshPort({
        getInvocation: () => invocation(),
        spawn,
      });

      await expect(
        port.refresh(eligibleInput({ eligibility })),
      ).resolves.toEqual({ status: "not_refreshable" });
      expect(spawn).not.toHaveBeenCalled();
    },
  );

  it("invokes Runtime once with only provider/profile-safe arguments and returns refreshed", async () => {
    const child = new FakeChild();
    const spawn = vi.fn<Spawn>(() => child);
    const port = createProviderCredentialRefreshPort({
      getInvocation: () => invocation(),
      spawn,
    });
    const pending = port.refresh(eligibleInput());
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
    const [command, args, options] = spawn.mock.calls[0];
    expect(command).toBe("/runtime/python");
    expect(args).toEqual([
      "-c",
      RUNTIME_CREDENTIAL_REFRESH_SCRIPT,
      "openai-codex",
    ]);
    expect(JSON.stringify(args)).not.toContain("secret");
    expect(options.env.HERMES_HOME).toBe("/profile");
    child.stdout.emit("data", "REFRESHED\n");
    child.emit("close", 0);
    await expect(pending).resolves.toEqual({ status: "refreshed" });
  });

  it("maps Runtime rejection and nonzero exits without leaking subprocess output", async () => {
    const child = new FakeChild();
    const port = createProviderCredentialRefreshPort({
      getInvocation: () => invocation(),
      spawn: vi.fn<Spawn>(() => child),
    });
    const pending = port.refresh(eligibleInput());
    child.stdout.emit("data", "REJECTED\nprivate-token-value\n");
    child.emit("close", 0);
    await expect(pending).resolves.toEqual({ status: "unavailable" });
    const failedChild = new FakeChild();
    const failedPort = createProviderCredentialRefreshPort({
      getInvocation: () => invocation(),
      spawn: vi.fn<Spawn>(() => failedChild),
    });
    const failed = failedPort.refresh(eligibleInput());
    failedChild.stderr.emit("data", "traceback /private/path secret");
    failedChild.emit("close", 1);
    await expect(failed).resolves.toEqual({ status: "unavailable" });
  });

  it("kills the Runtime process on owner cancellation or timeout", async () => {
    const ownerController = new AbortController();
    const child = new FakeChild();
    const port = createProviderCredentialRefreshPort({
      getInvocation: () => invocation(),
      spawn: vi.fn<Spawn>(() => child),
      timeoutMs: 10,
    });
    const pending = port.refresh(
      eligibleInput({
        ownerLease: {
          epoch: 1,
          signal: ownerController.signal,
          assertCurrent: vi.fn(),
        },
      }),
    );
    ownerController.abort();
    await expect(pending).resolves.toEqual({ status: "unavailable" });
    expect(child.kill).toHaveBeenCalled();

    const timeoutChild = new FakeChild();
    const timeoutPort = createProviderCredentialRefreshPort({
      getInvocation: () => invocation(),
      spawn: vi.fn<Spawn>(() => timeoutChild),
      timeoutMs: 1,
    });
    await expect(timeoutPort.refresh(eligibleInput())).resolves.toEqual({
      status: "unavailable",
    });
    expect(timeoutChild.kill).toHaveBeenCalled();
  });
});
