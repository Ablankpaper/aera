// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import type {
  ModelConfigurationMutationRequest,
  OwnerModelRouteCatalogSnapshot,
} from "../../shared/model-configuration";
import {
  createModelConfigurationIpcBridge,
  type ModelConfigurationIpcBridgeDependencies,
} from "./model-configuration-bridge";

const revision = "a".repeat(64);
const publicSnapshot = (): OwnerModelRouteCatalogSnapshot => ({
  revision,
  targetProfileId: "account",
  routes: [
    {
      id: "account-route",
      provider: "custom:petoi",
      model: "gpt-5.6-sol",
      baseUrl: "https://api.petoi.cn/v1",
      apiMode: "codex_responses",
      providerLabel: "Petoi",
      displayName: "GPT 5.6",
      sourceProfileId: "account",
      sourceKind: "account",
      selection: {
        sourceProfileId: "account",
        modelLibraryId: "model-1",
        catalogRevision: revision,
      },
    },
  ],
});

function upsertRequest(
  overrides: Partial<
    Extract<ModelConfigurationMutationRequest, { intent: "upsert" }>
  > = {},
): Extract<ModelConfigurationMutationRequest, { intent: "upsert" }> {
  return {
    intent: "upsert",
    expectedCatalogRevision: revision,
    requestedProfileId: "account",
    provider: "custom",
    providerLabel: "Petoi",
    baseUrl: "https://api.petoi.cn/v1",
    apiMode: "codex_responses",
    apiKey: "secret-value",
    models: [{ model: "gpt-5.6-sol", displayName: "GPT 5.6" }],
    activeModel: "gpt-5.6-sol",
    ...overrides,
  };
}

function subject(): {
  bridge: ReturnType<typeof createModelConfigurationIpcBridge>;
  coordinator: ModelConfigurationIpcBridgeDependencies["coordinator"];
  assertRequestedProfile: NonNullable<
    ModelConfigurationIpcBridgeDependencies["assertRequestedProfile"]
  >;
} {
  const coordinator = {
    mutate: vi.fn(async () => ({
      status: "committed" as const,
      catalog: publicSnapshot(),
    })),
  };
  const assertRequestedProfile = vi.fn((profile: string) => {
    if (profile === "foreign") throw new Error("foreign Profile");
  });
  const dependencies: ModelConfigurationIpcBridgeDependencies = {
    catalog: { snapshot: vi.fn(() => publicSnapshot()) },
    coordinator,
    assertRequestedProfile,
  };
  return {
    bridge: createModelConfigurationIpcBridge(dependencies),
    coordinator,
    assertRequestedProfile,
  };
}

describe("coordinated model configuration IPC bridge", () => {
  it("returns a redacted owner catalog and delegates one mutation", async () => {
    const { bridge, coordinator } = subject();
    const snapshot = bridge.getOwnerModelRouteCatalog("account");
    expect(JSON.stringify(snapshot)).not.toMatch(
      /credentialRef|apiKey|secret/i,
    );

    const result = await bridge.mutateModelConfiguration(upsertRequest());
    expect(coordinator.mutate).toHaveBeenCalledTimes(1);
    expect(coordinator.mutate).toHaveBeenCalledWith(upsertRequest());
    expect(result.status).toBe("committed");
  });

  it("preserves the stable custom-provider identity in an edit mutation", async () => {
    const { bridge, coordinator } = subject();
    const request = upsertRequest({
      providerId: "1b3de68f-071f-4d8c-888b-8b3960334011",
      providerLabel: "Renamed Petoi",
    });

    await bridge.mutateModelConfiguration(request);

    expect(coordinator.mutate).toHaveBeenCalledWith(request);
  });

  it("checks an explicit catalog Profile target but leaves mutation target resolution in Main", async () => {
    const { bridge, coordinator, assertRequestedProfile } = subject();
    expect(() => bridge.getOwnerModelRouteCatalog("foreign")).toThrow();
    expect(assertRequestedProfile).toHaveBeenCalledWith("foreign");

    await bridge.mutateModelConfiguration(
      upsertRequest({ requestedProfileId: "foreign" }),
    );
    expect(coordinator.mutate).toHaveBeenCalledTimes(1);
    expect(assertRequestedProfile).toHaveBeenCalledTimes(1);
  });
});
