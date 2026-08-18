// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import type {
  ModelConfigurationMutationRequest,
  ModelConfigurationMutationResult,
  ModelConfigurationStartupFailure,
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
  managedWriteMock: ReturnType<typeof vi.fn>;
  assertRequestedProfile: NonNullable<
    ModelConfigurationIpcBridgeDependencies["assertRequestedProfile"]
  >;
} {
  const managedWriteMock = vi.fn(
    async (
      _request: unknown,
      prepare: (context: {
        ownerHandle: string;
        targetProfileId: string;
        catalog: OwnerModelRouteCatalogSnapshot;
        oldRouteKey: string;
      }) => Promise<{ write(): unknown }> | { write(): unknown },
    ) => {
      const plan = await prepare({
        ownerHandle: "owner",
        targetProfileId: "account",
        catalog: publicSnapshot(),
        oldRouteKey:
          "custom:petoi\0gpt-5.6-sol\0https://api.petoi.cn/v1\0codex_responses",
      });
      return {
        status: "executed" as const,
        value: await plan.write(),
        catalog: publicSnapshot(),
      };
    },
  );
  const coordinator: ModelConfigurationIpcBridgeDependencies["coordinator"] = {
    mutate: vi.fn(async () => ({
      status: "committed" as const,
      catalog: publicSnapshot(),
    })),
    runManagedWrite:
      managedWriteMock as unknown as ModelConfigurationIpcBridgeDependencies["coordinator"]["runManagedWrite"],
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
    managedWriteMock,
    assertRequestedProfile,
  };
}

describe("coordinated model configuration IPC bridge", () => {
  it("delegates a focused managed writer through the coordinator", async () => {
    const { bridge, managedWriteMock } = subject();
    const focusedBridge = bridge as typeof bridge & {
      runManagedModelConfigurationWrite<T>(
        request: {
          requestedProfileId: string;
          scope: "profile" | "global";
          stage:
            | "credential"
            | "provider"
            | "model_library"
            | "native_route"
            | "activation";
        },
        prepare: (context: { oldRouteKey: string }) => {
          newRouteKey?: string;
          write(): T | Promise<T>;
        },
      ): Promise<T>;
    };
    const write = vi.fn(() => "saved");

    await expect(
      focusedBridge.runManagedModelConfigurationWrite(
        {
          requestedProfileId: "account",
          scope: "profile",
          stage: "credential",
        },
        ({ oldRouteKey }) => ({ newRouteKey: oldRouteKey, write }),
      ),
    ).resolves.toBe("saved");
    expect(managedWriteMock).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("can preserve a legacy caller's refresh-failure error after the bytes commit", async () => {
    const { bridge, managedWriteMock } = subject();
    managedWriteMock.mockResolvedValueOnce({
      status: "executed",
      value: { generated: true },
      catalog: publicSnapshot(),
      warning: "model_save_refresh_failed",
    });
    const legacyMessage =
      "The local gateway credential was created, but the gateway could not restart with it.";
    const focusedBridge = bridge as typeof bridge & {
      runManagedModelConfigurationWrite<T>(
        request: {
          requestedProfileId: string;
          scope: "profile" | "global";
          stage:
            | "credential"
            | "provider"
            | "model_library"
            | "native_route"
            | "activation";
        },
        prepare: () => { write(): T | Promise<T> },
        options: {
          refreshWarningToError(warning: "model_save_refresh_failed"): Error;
        },
      ): Promise<T>;
    };

    await expect(
      focusedBridge.runManagedModelConfigurationWrite(
        {
          requestedProfileId: "account",
          scope: "profile",
          stage: "credential",
        },
        () => ({ write: () => ({ generated: true }) }),
        {
          refreshWarningToError: () => new Error(legacyMessage),
        },
      ),
    ).rejects.toThrow(legacyMessage);
  });

  it("keeps refresh warnings non-throwing for callers without a legacy error contract", async () => {
    const { bridge, managedWriteMock } = subject();
    managedWriteMock.mockResolvedValueOnce({
      status: "executed",
      value: "saved",
      catalog: publicSnapshot(),
      warning: "model_save_refresh_failed",
    });

    await expect(
      bridge.runManagedModelConfigurationWrite(
        {
          requestedProfileId: "account",
          scope: "profile",
          stage: "provider",
        },
        () => ({ write: () => "saved" }),
      ),
    ).resolves.toBe("saved");
  });

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

type CoordinatorUnavailableMutationFactory = (
  startupFailure: ModelConfigurationStartupFailure | null,
) => {
  mutate(
    request: ModelConfigurationMutationRequest,
  ): Promise<ModelConfigurationMutationResult>;
};

async function unavailableMutationFactory(): Promise<CoordinatorUnavailableMutationFactory> {
  const bridgeModule = await import("./model-configuration-bridge");
  const factory = (
    bridgeModule as unknown as {
      coordinatorUnavailableMutation?: CoordinatorUnavailableMutationFactory;
    }
  ).coordinatorUnavailableMutation;
  expect(factory).toBeTypeOf("function");
  return factory!;
}

describe("coordinatorUnavailableMutation", () => {
  // @lat: [[beta27-reliability-plan#Acceptance and release boundary#Database startup identity reaches IPC]]
  it.each([
    "native_module_abi_mismatch",
    "native_module_architecture_mismatch",
    "native_module_dependency_missing",
    "native_module_load_denied",
    "native_module_load_failed",
    "model_configuration_database_unavailable",
    "model_configuration_schema_unsupported",
  ] as const)("maps the exact %s identity to validation", async (code) => {
    const factory = await unavailableMutationFactory();
    const startupFailure = {
      code,
      diagnosticId: "abcdef012345",
    } satisfies ModelConfigurationStartupFailure;
    const result = await factory(startupFailure).mutate(upsertRequest());

    expect(result).toMatchObject({
      status: "rejected",
      stage: "validation",
      code,
      rollback: "not_needed",
      diagnosticId: startupFailure.diagnosticId,
    });
    expect(JSON.stringify(result)).not.toMatch(/detail|message|secret/iu);
  });

  it("maps an explicit recovery-required identity to recovery", async () => {
    const factory = await unavailableMutationFactory();
    const startupFailure = {
      code: "model_configuration_recovery_required",
      diagnosticId: "abcdef012345",
    } satisfies ModelConfigurationStartupFailure;
    const result = await factory(startupFailure).mutate(upsertRequest());

    expect(result).toMatchObject({
      status: "rejected",
      stage: "recovery",
      code: "model_configuration_recovery_required",
      rollback: "recovery_required",
      diagnosticId: startupFailure.diagnosticId,
    });
  });

  it("uses one opaque recovery id when the startup record is absent", async () => {
    const factory = await unavailableMutationFactory();
    const stub = factory(null);
    const first = await stub.mutate(upsertRequest());
    const second = await stub.mutate(upsertRequest());

    expect(first).toMatchObject({
      status: "rejected",
      stage: "recovery",
      code: "model_configuration_recovery_required",
      rollback: "recovery_required",
      diagnosticId: expect.stringMatching(/^[0-9a-f]{12}$/u),
    });
    expect(second).toMatchObject({
      diagnosticId: (first as { diagnosticId: string }).diagnosticId,
    });
  });

  it("replaces an invalid diagnostic id before returning it", async () => {
    const factory = await unavailableMutationFactory();
    const result = await factory({
      code: "native_module_load_failed",
      diagnosticId: "private/path/detail",
    }).mutate(upsertRequest());

    expect(result).toMatchObject({
      stage: "validation",
      code: "native_module_load_failed",
      rollback: "not_needed",
      diagnosticId: expect.stringMatching(/^[0-9a-f]{12}$/u),
    });
    expect(JSON.stringify(result)).not.toContain("private/path/detail");
  });
});
