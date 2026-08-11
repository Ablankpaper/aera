import { describe, expect, it, vi } from "vitest";
import {
  createAgentModelExecutionLease,
  type FrozenAgentExecutionRoute,
} from "./agent-model-execution-lease";

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

describe("Agent model execution lease", () => {
  it("resolves a same-owner credential only inside the send callback", async () => {
    const getSecret = vi.fn(() => "petoi-secret-value");
    const verifySourceProfile = vi.fn(() => true);
    const resolveSourceRoute = vi.fn(() => PETOI_ROUTE);
    const lease = createAgentModelExecutionLease({
      route: PETOI_ROUTE,
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
      mode: "ssh",
      routeAvailable: false,
      getSecret,
    });

    await expect(lease.run(vi.fn())).rejects.toMatchObject({
      code: "model_switch_remote_unavailable",
    });
    expect(getSecret).not.toHaveBeenCalled();
  });
});
