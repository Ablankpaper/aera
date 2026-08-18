// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { runProviderAuthenticationRecovery } from "./provider-authentication-recovery";
import type { ProviderCredentialRefreshPort } from "./provider-credential-refresh";
import type { AgenteraOwnerEpochLease } from "./agentera-connection-owner";

type AuthResult = { status: number; models?: string[] };

function lease(): AgenteraOwnerEpochLease {
  return {
    epoch: 1,
    signal: new AbortController().signal,
    assertCurrent: vi.fn<() => void>(),
  };
}

function refreshPort(
  status: "refreshed" | "rejected" | "unavailable" | "not_refreshable",
): ProviderCredentialRefreshPort {
  return { refresh: vi.fn(async () => ({ status })) };
}

describe("bounded provider authentication recovery", () => {
  it("refreshes once and retries one 401 for a Runtime-owned credential", async () => {
    const fetchOnce = vi
      .fn<() => Promise<AuthResult>>()
      .mockResolvedValueOnce({ status: 401 })
      .mockResolvedValueOnce({ status: 200, models: ["gpt-5.6"] });
    const refresh = refreshPort("refreshed");
    const result = await runProviderAuthenticationRecovery({
      ownerLease: lease(),
      credentialSource: "runtime_refreshable",
      refreshPort: refresh,
      refreshInput: {
        provider: "openai-codex",
        profile: "default",
        eligibility: {
          source: "runtime_pool",
          authType: "oauth",
          hasRefreshToken: true,
        },
      },
      fetchOnce,
      isAuthenticationRejected: (value: AuthResult) => value.status === 401,
    });

    expect(result).toMatchObject({
      result: { status: 200 },
      refreshAttempted: true,
      retried: true,
      finalAuthenticationRejected: false,
    });
    expect(fetchOnce).toHaveBeenCalledTimes(2);
    expect(refresh.refresh).toHaveBeenCalledTimes(1);
  });

  it("does not loop after a second 401", async () => {
    const fetchOnce = vi
      .fn<() => Promise<AuthResult>>()
      .mockResolvedValueOnce({ status: 401 })
      .mockResolvedValueOnce({ status: 401 });
    const refresh = refreshPort("refreshed");
    const result = await runProviderAuthenticationRecovery({
      ownerLease: lease(),
      credentialSource: "runtime_refreshable",
      refreshPort: refresh,
      refreshInput: {
        provider: "openai-codex",
        eligibility: {
          source: "runtime_pool",
          authType: "oauth",
          hasRefreshToken: true,
        },
      },
      fetchOnce,
      isAuthenticationRejected: (value: AuthResult) => value.status === 401,
    });
    expect(result.finalAuthenticationRejected).toBe(true);
    expect(fetchOnce).toHaveBeenCalledTimes(2);
    expect(refresh.refresh).toHaveBeenCalledTimes(1);
  });

  it.each(["static_key", "none"] as const)(
    "does not refresh or retry a %s credential",
    async (credentialSource) => {
      const fetchOnce = vi
        .fn<() => Promise<AuthResult>>()
        .mockResolvedValue({ status: 401 });
      const refresh = refreshPort("refreshed");
      const result = await runProviderAuthenticationRecovery({
        ownerLease: lease(),
        credentialSource,
        refreshPort: refresh,
        refreshInput: {
          provider: "custom",
          eligibility: {
            source: "static_key",
            authType: "api_key",
            hasRefreshToken: false,
          },
        },
        fetchOnce,
        isAuthenticationRejected: (value: AuthResult) => value.status === 401,
      });
      expect(result.refreshAttempted).toBe(false);
      expect(fetchOnce).toHaveBeenCalledTimes(1);
      expect(refresh.refresh).not.toHaveBeenCalled();
    },
  );

  it("does not retry when Runtime refresh rejects or is unavailable", async () => {
    for (const status of ["rejected", "unavailable"] as const) {
      const fetchOnce = vi
        .fn<() => Promise<AuthResult>>()
        .mockResolvedValue({ status: 401 });
      const refresh = refreshPort(status);
      const result = await runProviderAuthenticationRecovery({
        ownerLease: lease(),
        credentialSource: "runtime_refreshable",
        refreshPort: refresh,
        refreshInput: {
          provider: "openai-codex",
          eligibility: {
            source: "runtime_pool",
            authType: "oauth",
            hasRefreshToken: true,
          },
        },
        fetchOnce,
        isAuthenticationRejected: (value: AuthResult) => value.status === 401,
      });
      expect(result.retried).toBe(false);
      expect(fetchOnce).toHaveBeenCalledTimes(1);
    }
  });

  it("does not retry when refresh succeeds but no new credential is available", async () => {
    const fetchOnce = vi
      .fn<() => Promise<AuthResult>>()
      .mockResolvedValue({ status: 401 });
    const result = await runProviderAuthenticationRecovery({
      ownerLease: lease(),
      credentialSource: "runtime_refreshable",
      refreshPort: refreshPort("refreshed"),
      refreshInput: {
        provider: "openai-codex",
        eligibility: {
          source: "runtime_pool",
          authType: "oauth",
          hasRefreshToken: true,
        },
      },
      canRetry: () => false,
      fetchOnce,
      isAuthenticationRejected: (value: AuthResult) => value.status === 401,
    });

    expect(result).toMatchObject({
      refreshAttempted: true,
      retried: false,
      finalAuthenticationRejected: true,
    });
    expect(fetchOnce).toHaveBeenCalledTimes(1);
  });

  it("treats a refresh-port exception as a bounded refresh failure", async () => {
    const fetchOnce = vi
      .fn<() => Promise<AuthResult>>()
      .mockResolvedValue({ status: 401 });
    const refreshPortThatThrows: ProviderCredentialRefreshPort = {
      refresh: vi.fn(async () => {
        throw new Error("private refresh detail");
      }),
    };

    const result = await runProviderAuthenticationRecovery({
      ownerLease: lease(),
      credentialSource: "runtime_refreshable",
      refreshPort: refreshPortThatThrows,
      refreshInput: {
        provider: "openai-codex",
        eligibility: {
          source: "runtime_pool",
          authType: "oauth",
          hasRefreshToken: true,
        },
      },
      fetchOnce,
      isAuthenticationRejected: (value: AuthResult) => value.status === 401,
    });

    expect(result).toMatchObject({
      refreshAttempted: true,
      retried: false,
      finalAuthenticationRejected: true,
    });
    expect(fetchOnce).toHaveBeenCalledTimes(1);
  });

  it("stops without retry when the owner changes during refresh", async () => {
    const assertCurrent = vi
      .fn<() => void>()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error("owner changed");
      });
    const owner: AgenteraOwnerEpochLease = {
      epoch: 1,
      signal: new AbortController().signal,
      assertCurrent,
    };
    const fetchOnce = vi
      .fn<() => Promise<AuthResult>>()
      .mockResolvedValue({ status: 401 });
    await expect(
      runProviderAuthenticationRecovery({
        ownerLease: owner,
        credentialSource: "runtime_refreshable",
        refreshPort: refreshPort("refreshed"),
        refreshInput: {
          provider: "openai-codex",
          eligibility: {
            source: "runtime_pool",
            authType: "oauth",
            hasRefreshToken: true,
          },
        },
        fetchOnce,
        isAuthenticationRejected: (value: AuthResult) => value.status === 401,
      }),
    ).rejects.toMatchObject({
      code: "owner_changed",
    });
    expect(fetchOnce).toHaveBeenCalledTimes(1);
  });
});
