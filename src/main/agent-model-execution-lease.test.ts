import { describe, expect, it, vi } from "vitest";
import {
  createAgentModelExecutionLease,
  type FrozenAgentExecutionRoute,
} from "./agent-model-execution-lease";
import { parseFrozenAgentModelRoute } from "./agentera-agent-control/frozen-agent-model-route";
import type { AgenteraOwnerEpochLease } from "./agentera-connection-owner";

const PETOI_ROUTE: FrozenAgentExecutionRoute = {
  provider: "custom:petoi",
  model: "gpt-5.6-sol",
  baseUrl: "https://api.petoi.cn/v1",
  apiMode: "codex_responses",
  sourceProfileId: "account-home",
  modelLibraryId: "petoi-gpt",
  credentialRef: "CUSTOM_PROVIDER_PETOI_KEY",
  legacy: false,
};
const LEGACY_PETOI_ROUTE = parseFrozenAgentModelRoute({
  provider: "custom:petoi",
  model: "gpt-5.6-sol",
  baseUrl: "https://api.petoi.cn/v1",
});

function ownerLease(): AgenteraOwnerEpochLease {
  return {
    epoch: 1,
    signal: new AbortController().signal,
    assertCurrent: vi.fn(),
  };
}

describe("Agent model execution lease", () => {
  it("resolves a same-owner credential only inside the send callback", async () => {
    const getSecret = vi.fn(() => "petoi-secret-value");
    const verifySourceProfile = vi.fn(() => true);
    const resolveSourceRoute = vi.fn(() => PETOI_ROUTE);
    const lease = createAgentModelExecutionLease({
      route: PETOI_ROUTE,
      ownerLease: ownerLease(),
      getSecret,
      verifySourceProfile,
      resolveSourceRoute,
      routeMode: "dynamic",
      disableTransportReplay: true,
    });

    expect(getSecret).not.toHaveBeenCalled();
    const captured: Array<{ credential: string | null }> = [];
    await lease.run(async (execution) => {
      captured.push(execution);
      expect(execution.modelOverride).toEqual({
        provider: "custom:petoi",
        model: "gpt-5.6-sol",
        baseUrl: "https://api.petoi.cn/v1",
      });
      expect(execution.apiMode).toBe("codex_responses");
      expect(execution.credential).toBe("petoi-secret-value");
      expect(execution.routeMode).toBe("dynamic");
      expect(execution.disableTransportReplay).toBe(true);
    });

    expect(verifySourceProfile).toHaveBeenCalledWith(
      "account-home",
      "petoi-gpt",
    );
    expect(getSecret).toHaveBeenCalledWith(
      "CUSTOM_PROVIDER_PETOI_KEY",
      "account-home",
    );
    expect(resolveSourceRoute).toHaveBeenCalledWith(
      "account-home",
      "petoi-gpt",
    );
    expect(lease.publicIdentity).toEqual({
      provider: "custom:petoi",
      model: "gpt-5.6-sol",
      baseUrl: "https://api.petoi.cn/v1",
      apiMode: "codex_responses",
    });
    expect(JSON.stringify(lease.publicIdentity)).not.toContain(
      "petoi-secret-value",
    );
    expect(captured[0]?.credential).toBeNull();
  });

  it("fails closed when the same-owner source route has drifted", async () => {
    const lease = createAgentModelExecutionLease({
      route: PETOI_ROUTE,
      ownerLease: ownerLease(),
      verifySourceProfile: vi.fn(() => false),
      getSecret: vi.fn(() => "should-not-be-read"),
    });

    await expect(lease.run(vi.fn())).rejects.toMatchObject({
      code: "model_switch_source_unavailable",
    });
  });

  it("rejects SSH when the remote route is not already configured", async () => {
    const getSecret = vi.fn(() => "must-not-be-read");
    const lease = createAgentModelExecutionLease({
      route: PETOI_ROUTE,
      ownerLease: ownerLease(),
      mode: "ssh",
      routeAvailable: false,
      getSecret,
    });

    await expect(lease.run(vi.fn())).rejects.toMatchObject({
      code: "model_switch_remote_unavailable",
    });
    expect(getSecret).not.toHaveBeenCalled();
  });

  it("upgrades a legacy route only through one same-owner catalog match", async () => {
    const upgraded: FrozenAgentExecutionRoute = {
      ...PETOI_ROUTE,
      legacy: false,
    };
    const lease = createAgentModelExecutionLease({
      route: {
        ...LEGACY_PETOI_ROUTE,
      },
      ownerLease: ownerLease(),
      resolveLegacyRoute: vi.fn(() => ({
        status: "resolved" as const,
        route: upgraded,
      })),
      verifySourceProfile: vi.fn(() => true),
      resolveSourceRoute: vi.fn(() => upgraded),
      getSecret: vi.fn(() => "petoi-secret-value"),
    });

    await expect(lease.run((execution) => execution.credential)).resolves.toBe(
      "petoi-secret-value",
    );
  });

  it.each([
    ["missing", "model_switch_source_unavailable"],
    ["ambiguous", "model_switch_route_ambiguous"],
  ] as const)(
    "rejects a legacy route when catalog resolution is %s",
    async (status, code) => {
      const lease = createAgentModelExecutionLease({
        route: {
          ...LEGACY_PETOI_ROUTE,
        },
        ownerLease: ownerLease(),
        resolveLegacyRoute: () => ({ status }),
      });

      await expect(lease.run(vi.fn())).rejects.toMatchObject({ code });
    },
  );

  it("rejects a legacy route with no resolver instead of running anonymously", async () => {
    const lease = createAgentModelExecutionLease({
      route: {
        ...LEGACY_PETOI_ROUTE,
      },
      ownerLease: ownerLease(),
      getSecret: vi.fn(() => "must-not-be-read"),
    });

    await expect(lease.run(vi.fn())).rejects.toMatchObject({
      code: "model_switch_source_unavailable",
    });
  });

  it("stops a legacy send when its owner epoch changes", async () => {
    const controller = new AbortController();
    const assertCurrent = vi
      .fn()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw Object.assign(new Error("owner changed"), {
          code: "model_owner_changed",
        });
      });
    const lease = createAgentModelExecutionLease({
      route: PETOI_ROUTE,
      ownerLease: {
        epoch: 1,
        signal: controller.signal,
        assertCurrent,
      },
      verifySourceProfile: vi.fn(() => true),
      resolveSourceRoute: vi.fn(() => PETOI_ROUTE),
      getSecret: vi.fn(() => "petoi-secret-value"),
    });

    await expect(lease.run(async () => "result")).rejects.toMatchObject({
      code: "model_owner_changed",
    });
    expect(assertCurrent).toHaveBeenCalledTimes(2);
  });
});
