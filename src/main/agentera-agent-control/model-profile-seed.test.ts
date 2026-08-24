// @vitest-environment node

import { describe, expect, it, vi, type Mocked } from "vitest";
import type { ManagedModelMutationPort } from "../model-configuration-mutation-port";
import type { ModelConfigurationWritePermit } from "../model-configuration-write-authority";
import type { AgentPolicySnapshot, AgentVersion } from "./client";
import { seedAgentModelProfile } from "./model-profile-seed";

type SeedDependencies = NonNullable<
  Parameters<typeof seedAgentModelProfile>[1]
>;

function version(providers: string[], models: string[]): AgentVersion {
  return {
    manifest: {
      model_constraints: {
        allowed_providers: providers,
        allowed_models: models,
      },
    },
  } as unknown as AgentVersion;
}

function versionV2(
  mode: "user_select" | "allowlist" | "fixed",
  providers: string[] = [],
  models: string[] = [],
): AgentVersion {
  return {
    manifest: {
      schema_version: 2,
      model_policy: {
        mode,
        allowed_providers: providers,
        allowed_models: models,
      },
    },
  } as unknown as AgentVersion;
}

function policyV2(
  mode: "user_select" | "allowlist" | "fixed",
  providers: string[] = [],
  models: string[] = [],
): AgentPolicySnapshot {
  return {
    document: {
      schema_version: 2,
      model_policy: {
        mode,
        allowed_providers: providers,
        allowed_models: models,
      },
    },
  } as unknown as AgentPolicySnapshot;
}

function policyV1(providers: string[], models: string[]): AgentPolicySnapshot {
  return {
    document: {
      schema_version: 1,
      model_constraints: {
        allowed_providers: providers,
        allowed_models: models,
      },
    },
  } as unknown as AgentPolicySnapshot;
}

function dependencies(): Mocked<SeedDependencies> {
  const modelMutationPort: ManagedModelMutationPort = {
    async mutate(input) {
      const plan = await input.prepare();
      const value = await plan.write(
        null as unknown as ModelConfigurationWritePermit,
      );
      return {
        status: "executed",
        value,
        catalog: {
          revision: "0".repeat(64),
          targetProfileId: input.profileIds[0],
          routes: [],
        },
      };
    },
  };
  return {
    getModelConfig: vi.fn(() => ({
      provider: "custom:anhepro.com",
      model: "gpt-5.6-sol",
      baseUrl: "https://api.anhepro.com/v1",
    })),
    hasOAuthCredentials: vi.fn(() => false),
    readModels: vi.fn(() => [
      {
        id: "model-1",
        name: "gpt-5.6-sol",
        provider: "custom",
        providerLabel: "anhepro.com",
        model: "gpt-5.6-sol",
        baseUrl: "https://api.anhepro.com/v1/",
        apiMode: "chat_completions",
        contextLength: 64_000,
        createdAt: 1,
      },
    ]),
    listCustomProviders: vi.fn(() => [
      {
        id: "provider-1",
        name: "anhepro.com",
        baseUrl: "https://api.anhepro.com/v1",
        createdAt: 1,
      },
    ]),
    getSecret: vi.fn(
      (_key: string, _profile?: string): string | null => "private-value",
    ),
    upsertCustomProvider: vi.fn(() => ({
      id: "provider-2",
      name: "anhepro.com",
      baseUrl: "https://api.anhepro.com/v1",
      createdAt: 2,
    })),
    upsertNativeCustomProvider: vi.fn(() => "custom:anhepro.com"),
    setModelConfig: vi.fn(),
    setEnvValue: vi.fn(),
    modelMutationPort,
  } as Mocked<SeedDependencies>;
}

describe("Agent Profile model seeding", () => {
  it("seeds the user's selected route even when a legacy signature names another model", async () => {
    const deps = dependencies();

    await seedAgentModelProfile(
      {
        sourceProfileId: "source-profile",
        targetProfileId: "target-profile",
        version: versionV2("fixed", ["openai"], ["gpt-5.6"]),
        policy: policyV2("allowlist", ["openai"], ["gpt-5.6"]),
      },
      deps,
    );

    expect(deps.setModelConfig).toHaveBeenCalledWith(
      "custom:anhepro.com",
      "gpt-5.6-sol",
      "https://api.anhepro.com/v1",
      "target-profile",
      64_000,
      "chat_completions",
    );
  });

  // @lat: [[beta27-reliability-plan#Recoverable model configuration#Indirect feature writers use the managed boundary]]
  it("does not write any target model file when recovery refuses the seed", async () => {
    const deps = Object.assign(dependencies(), {
      modelMutationPort: {
        mutate: vi.fn(async () => ({
          status: "rejected" as const,
          stage: "recovery" as const,
          code: "model_configuration_recovery_required" as const,
          rollback: "recovery_required" as const,
          diagnosticId: "0123456789ab",
        })),
      },
    });

    await expect(
      Promise.resolve(
        seedAgentModelProfile(
          {
            sourceProfileId: "source-profile",
            targetProfileId: "target-profile",
            version: version(["custom:anhepro.com"], ["gpt-5.6-sol"]),
            policy: policyV1(["custom:anhepro.com"], ["gpt-5.6-sol"]),
          },
          deps,
        ),
      ),
    ).rejects.toThrow("model_configuration_recovery_required");
    expect(deps.modelMutationPort.mutate).toHaveBeenCalledTimes(1);
    expect(deps.upsertCustomProvider).not.toHaveBeenCalled();
    expect(deps.upsertNativeCustomProvider).not.toHaveBeenCalled();
    expect(deps.setModelConfig).not.toHaveBeenCalled();
    expect(deps.setEnvValue).not.toHaveBeenCalled();
  });

  it("copies the exact selected library route instead of the source Profile default", async () => {
    const deps = dependencies();
    deps.getModelConfig.mockReturnValue({
      provider: "custom:yundu.lat",
      model: "claude-sonnet-4-6",
      baseUrl: "https://yundu.lat/v1",
    });
    deps.readModels.mockReturnValue([
      {
        id: "selected-petoi-model",
        name: "gpt-5.6-sol",
        provider: "custom",
        providerLabel: "Petoi",
        model: "gpt-5.6-sol",
        baseUrl: "https://api.petoi.cn/v1",
        apiMode: "chat_completions",
        createdAt: 1,
      },
    ]);
    deps.listCustomProviders.mockReturnValue([
      {
        id: "petoi-provider",
        name: "Petoi",
        baseUrl: "https://api.petoi.cn/v1",
        createdAt: 1,
      },
    ]);
    deps.upsertNativeCustomProvider.mockReturnValue("custom:petoi");

    await seedAgentModelProfile(
      {
        sourceProfileId: "source-profile",
        sourceModelId: "selected-petoi-model",
        targetProfileId: "target-profile",
        version: versionV2("user_select"),
        policy: policyV2("user_select"),
      },
      deps,
    );

    expect(deps.getSecret).toHaveBeenCalledWith(
      "CUSTOM_PROVIDER_PETOI_KEY",
      "source-profile",
    );
    expect(deps.setModelConfig).toHaveBeenCalledWith(
      "custom:petoi",
      "gpt-5.6-sol",
      "https://api.petoi.cn/v1",
      "target-profile",
      undefined,
      "chat_completions",
    );
  });

  it("projects a user-selected route without replacing the Agent Profile default", async () => {
    const deps = dependencies();
    if (!deps.modelMutationPort) throw new Error("missing mutation port");
    const mutate = vi.spyOn(deps.modelMutationPort, "mutate");

    await seedAgentModelProfile(
      {
        sourceProfileId: "source-profile",
        sourceModelId: "model-1",
        targetProfileId: "target-profile",
        version: versionV2("user_select"),
        policy: policyV2("user_select"),
        activateDefault: false,
      },
      deps,
    );

    expect(deps.setEnvValue).toHaveBeenCalledWith(
      "CUSTOM_PROVIDER_ANHEPRO_COM_KEY",
      "private-value",
      "target-profile",
    );
    expect(deps.upsertCustomProvider).toHaveBeenCalled();
    expect(deps.upsertNativeCustomProvider).toHaveBeenCalledWith(
      "target-profile",
      {
        name: "anhepro.com",
        baseUrl: "https://api.anhepro.com/v1",
        apiMode: "chat_completions",
      },
    );
    expect(deps.setModelConfig).not.toHaveBeenCalled();
    const plan = await mutate.mock.calls[0][0].prepare();
    expect(plan.newRouteKey).toBeUndefined();
  });

  it("projects an OpenAI-compatible third-party endpoint with a dedicated Profile credential reference", async () => {
    const deps = dependencies();
    if (!deps.modelMutationPort) throw new Error("missing mutation port");
    const mutate = vi.spyOn(deps.modelMutationPort, "mutate");
    deps.getModelConfig.mockReturnValue({
      provider: "openai",
      model: "source-default",
      baseUrl: "https://api.openai.com/v1",
    });
    deps.readModels.mockReturnValue([
      {
        id: "third-party-openai-model",
        name: "gpt-5.6-sol",
        provider: "openai",
        model: "gpt-5.6-sol",
        baseUrl: "https://api.petoi.cn/v1",
        apiMode: "chat_completions",
        createdAt: 1,
      },
    ]);
    deps.listCustomProviders.mockReturnValue([]);
    deps.getSecret.mockImplementation((key) => {
      if (key === "PETOI_API_KEY") return "source-route-key";
      if (key === "OPENAI_API_KEY") return "must-not-copy-global-openai";
      return null;
    });

    await seedAgentModelProfile(
      {
        sourceProfileId: "source-profile",
        sourceModelId: "third-party-openai-model",
        targetProfileId: "target-profile",
        version: versionV2("user_select"),
        policy: policyV2("user_select"),
        activateDefault: false,
      },
      deps,
    );

    expect(deps.setEnvValue).toHaveBeenCalledTimes(1);
    const [credentialRef, credential, profileId] =
      deps.setEnvValue.mock.calls[0];
    expect(credentialRef).toMatch(
      /^CUSTOM_PROVIDER_AERA_ROUTE_API_PETOI_CN_[A-F0-9]{12}_KEY$/,
    );
    expect(credentialRef).not.toBe("OPENAI_API_KEY");
    expect(credential).toBe("source-route-key");
    expect(profileId).toBe("target-profile");
    expect(deps.upsertCustomProvider).toHaveBeenCalledWith(
      "target-profile",
      expect.objectContaining({
        name: expect.stringMatching(/^aera-route-api\.petoi\.cn-[a-f0-9]{12}$/),
        baseUrl: "https://api.petoi.cn/v1",
      }),
    );
    expect(deps.upsertNativeCustomProvider).toHaveBeenCalledWith(
      "target-profile",
      {
        name: expect.stringMatching(/^aera-route-api\.petoi\.cn-[a-f0-9]{12}$/),
        baseUrl: "https://api.petoi.cn/v1",
        apiMode: "chat_completions",
      },
    );
    expect(deps.setModelConfig).not.toHaveBeenCalled();
    const plan = await mutate.mock.calls[0][0].prepare();
    expect(plan.newRouteKey).toBeUndefined();
    expect(deps.getSecret).not.toHaveBeenCalledWith(
      "OPENAI_API_KEY",
      expect.anything(),
    );
  });

  it("activates a loopback openai-compatible route without copying a global OpenAI key", async () => {
    const deps = dependencies();
    deps.getModelConfig.mockReturnValue({
      provider: "openai",
      model: "fixture-model",
      baseUrl: "http://127.0.0.1:19001/v1",
    });
    deps.readModels.mockReturnValue([
      {
        id: "local-openai-compatible-model",
        name: "fixture-model",
        provider: "openai",
        model: "fixture-model",
        baseUrl: "http://127.0.0.1:19001/v1",
        apiMode: "chat_completions",
        createdAt: 1,
      },
    ]);
    deps.getSecret.mockImplementation((key) =>
      key === "OPENAI_API_KEY" ? "must-not-copy-global-openai" : null,
    );

    await seedAgentModelProfile(
      {
        sourceProfileId: "source-profile",
        sourceModelId: "local-openai-compatible-model",
        targetProfileId: "target-profile",
        version: versionV2("user_select"),
        policy: policyV2("user_select"),
      },
      deps,
    );

    expect(deps.getSecret).not.toHaveBeenCalledWith(
      "OPENAI_API_KEY",
      expect.anything(),
    );
    expect(deps.setEnvValue).not.toHaveBeenCalled();
    expect(deps.setModelConfig).toHaveBeenCalledWith(
      "custom",
      "fixture-model",
      "http://127.0.0.1:19001/v1",
      "target-profile",
      undefined,
      "chat_completions",
    );
  });

  it("activates a third-party OpenAI-compatible endpoint through its dedicated named provider", async () => {
    const deps = dependencies();
    if (!deps.modelMutationPort) throw new Error("missing mutation port");
    const mutate = vi.spyOn(deps.modelMutationPort, "mutate");
    deps.getModelConfig.mockReturnValue({
      provider: "openai",
      model: "source-default",
      baseUrl: "https://api.openai.com/v1",
    });
    deps.readModels.mockReturnValue([
      {
        id: "third-party-openai-model",
        name: "gpt-5.6-sol",
        provider: "openai",
        model: "gpt-5.6-sol",
        baseUrl: "https://api.petoi.cn/v1",
        apiMode: "chat_completions",
        createdAt: 1,
      },
    ]);
    deps.listCustomProviders.mockReturnValue([]);
    deps.getSecret.mockImplementation((key) =>
      key === "PETOI_API_KEY" ? "source-route-key" : null,
    );

    await seedAgentModelProfile(
      {
        sourceProfileId: "source-profile",
        sourceModelId: "third-party-openai-model",
        targetProfileId: "target-profile",
        version: versionV2("user_select"),
        policy: policyV2("user_select"),
      },
      deps,
    );

    expect(deps.setModelConfig).toHaveBeenCalledWith(
      expect.stringMatching(/^custom:aera-route-api\.petoi\.cn-[a-f0-9]{12}$/),
      "gpt-5.6-sol",
      "https://api.petoi.cn/v1",
      "target-profile",
      undefined,
      "chat_completions",
    );
    const plan = await mutate.mock.calls[0][0].prepare();
    expect(plan.newRouteKey?.split("\0")[1]).toMatch(
      /^custom:aera-route-api\.petoi\.cn-[a-f0-9]{12}$/,
    );
  });

  it("rejects an ambiguous third-party endpoint before choosing one provider credential", async () => {
    const deps = dependencies();
    deps.getModelConfig.mockReturnValue({
      provider: "openai",
      model: "source-default",
      baseUrl: "https://api.openai.com/v1",
    });
    deps.readModels.mockReturnValue([
      {
        id: "ambiguous-third-party-model",
        name: "shared-model",
        provider: "openai",
        model: "shared-model",
        baseUrl: "https://shared-relay.example/v1",
        apiMode: "chat_completions",
        createdAt: 1,
      },
    ]);
    deps.listCustomProviders.mockReturnValue([
      {
        id: "relay-a",
        name: "Relay A",
        baseUrl: "https://shared-relay.example/v1",
        createdAt: 1,
      },
      {
        id: "relay-b",
        name: "Relay B",
        baseUrl: "https://shared-relay.example/v1",
        createdAt: 2,
      },
    ]);

    await expect(
      seedAgentModelProfile(
        {
          sourceProfileId: "source-profile",
          sourceModelId: "ambiguous-third-party-model",
          targetProfileId: "target-profile",
          version: versionV2("user_select"),
          policy: policyV2("user_select"),
          activateDefault: false,
        },
        deps,
      ),
    ).rejects.toThrow(/ambiguous/i);

    expect(deps.getSecret).not.toHaveBeenCalled();
    expect(deps.setEnvValue).not.toHaveBeenCalled();
    expect(deps.upsertNativeCustomProvider).not.toHaveBeenCalled();
  });

  it("uses an existing exact endpoint provider credential instead of the global OpenAI key", async () => {
    const deps = dependencies();
    deps.getModelConfig.mockReturnValue({
      provider: "openai",
      model: "source-default",
      baseUrl: "https://api.openai.com/v1",
    });
    deps.readModels.mockReturnValue([
      {
        id: "third-party-openai-model",
        name: "gpt-5.6-sol",
        provider: "openai",
        model: "gpt-5.6-sol",
        baseUrl: "https://relay.example/v1",
        apiMode: "chat_completions",
        createdAt: 1,
      },
    ]);
    deps.listCustomProviders.mockReturnValue([
      {
        id: "relay-provider",
        name: "Relay Example",
        baseUrl: "https://relay.example/v1",
        createdAt: 1,
      },
    ]);
    deps.getSecret.mockImplementation((key) => {
      if (key === "CUSTOM_PROVIDER_RELAY_EXAMPLE_KEY") {
        return "exact-relay-key";
      }
      if (key === "OPENAI_API_KEY") return "must-not-copy-global-openai";
      return null;
    });

    await seedAgentModelProfile(
      {
        sourceProfileId: "source-profile",
        sourceModelId: "third-party-openai-model",
        targetProfileId: "target-profile",
        version: versionV2("user_select"),
        policy: policyV2("user_select"),
        activateDefault: false,
      },
      deps,
    );

    expect(deps.getSecret).toHaveBeenCalledWith(
      "CUSTOM_PROVIDER_RELAY_EXAMPLE_KEY",
      "source-profile",
    );
    expect(deps.getSecret).not.toHaveBeenCalledWith(
      "OPENAI_API_KEY",
      expect.anything(),
    );
    expect(deps.setEnvValue).toHaveBeenCalledWith(
      "CUSTOM_PROVIDER_RELAY_EXAMPLE_KEY",
      "exact-relay-key",
      "target-profile",
    );
    expect(deps.setModelConfig).not.toHaveBeenCalled();
  });

  it("repairs an in-place legacy OpenAI-compatible endpoint without changing its default route", async () => {
    const deps = dependencies();
    deps.getModelConfig.mockReturnValue({
      provider: "openai",
      model: "gpt-5.6-sol",
      baseUrl: "https://api.petoi.cn/v1",
    });
    deps.readModels.mockReturnValue([
      {
        id: "legacy-agent-profile-model",
        name: "gpt-5.6-sol",
        provider: "openai",
        model: "gpt-5.6-sol",
        baseUrl: "https://api.petoi.cn/v1",
        apiMode: "chat_completions",
        createdAt: 1,
      },
    ]);
    deps.listCustomProviders.mockReturnValue([]);
    deps.getSecret.mockImplementation((key) => {
      if (key === "PETOI_API_KEY") return "legacy-agent-profile-key";
      if (key === "OPENAI_API_KEY") return "must-not-copy-global-openai";
      return null;
    });

    await seedAgentModelProfile(
      {
        sourceProfileId: "installed-agent",
        sourceModelId: "legacy-agent-profile-model",
        targetProfileId: "installed-agent",
        version: versionV2("user_select"),
        policy: policyV2("user_select"),
        activateDefault: false,
      },
      deps,
    );

    expect(deps.upsertNativeCustomProvider).toHaveBeenCalledWith(
      "installed-agent",
      expect.objectContaining({
        name: expect.stringMatching(/^aera-route-api\.petoi\.cn-/),
        baseUrl: "https://api.petoi.cn/v1",
      }),
    );
    expect(deps.setEnvValue).toHaveBeenCalledWith(
      expect.stringMatching(/^CUSTOM_PROVIDER_AERA_ROUTE_API_PETOI_CN_/),
      "legacy-agent-profile-key",
      "installed-agent",
    );
    expect(deps.setModelConfig).not.toHaveBeenCalled();
  });

  it("fails closed for an unknown third-party endpoint instead of copying a global OpenAI key", async () => {
    const deps = dependencies();
    deps.getModelConfig.mockReturnValue({
      provider: "openai",
      model: "source-default",
      baseUrl: "https://api.openai.com/v1",
    });
    deps.readModels.mockReturnValue([
      {
        id: "unknown-third-party-model",
        name: "gpt-compatible-model",
        provider: "openai",
        model: "gpt-compatible-model",
        baseUrl: "https://unknown-relay.example/v1",
        apiMode: "chat_completions",
        createdAt: 1,
      },
    ]);
    deps.listCustomProviders.mockReturnValue([]);
    deps.getSecret.mockImplementation((key) => {
      if (key === "OPENAI_API_KEY") return "global-openai-secret";
      if (key === "CUSTOM_API_KEY") return "ambiguous-custom-secret";
      return null;
    });

    await expect(
      seedAgentModelProfile(
        {
          sourceProfileId: "source-profile",
          sourceModelId: "unknown-third-party-model",
          targetProfileId: "target-profile",
          version: versionV2("user_select"),
          policy: policyV2("user_select"),
          activateDefault: false,
        },
        deps,
      ),
    ).rejects.toThrow(/credential is unavailable/i);

    expect(deps.getSecret).not.toHaveBeenCalledWith(
      "OPENAI_API_KEY",
      expect.anything(),
    );
    expect(deps.getSecret).not.toHaveBeenCalledWith(
      "CUSTOM_API_KEY",
      expect.anything(),
    );
    expect(deps.setEnvValue).not.toHaveBeenCalled();
    expect(deps.upsertNativeCustomProvider).not.toHaveBeenCalled();
  });

  it("rejects a legacy custom model row that has no provider identity", async () => {
    const deps = dependencies();
    deps.readModels.mockReturnValue([
      {
        id: "ambiguous-custom-model",
        name: "gpt-5.6-sol",
        provider: "custom",
        model: "gpt-5.6-sol",
        baseUrl: "",
        createdAt: 1,
      },
    ]);

    await expect(
      seedAgentModelProfile(
        {
          sourceProfileId: "source-profile",
          sourceModelId: "ambiguous-custom-model",
          targetProfileId: "target-profile",
          version: versionV2("user_select"),
          policy: policyV2("user_select"),
        },
        deps,
      ),
    ).rejects.toThrow(/identity is unavailable/i);
    expect(deps.getSecret).not.toHaveBeenCalled();
    expect(deps.setModelConfig).not.toHaveBeenCalled();
  });

  it("uses the current owner's live route for a V2 user_select Agent", async () => {
    const deps = dependencies();

    await seedAgentModelProfile(
      {
        sourceProfileId: "source-profile",
        targetProfileId: "target-profile",
        version: versionV2("user_select"),
        policy: policyV2("user_select"),
      },
      deps,
    );

    expect(deps.setModelConfig).toHaveBeenCalledWith(
      "custom:anhepro.com",
      "gpt-5.6-sol",
      "https://api.anhepro.com/v1",
      "target-profile",
      64_000,
      "chat_completions",
    );
  });

  it("uses the user's route even when a legacy tenant policy names another model", async () => {
    const deps = dependencies();

    await seedAgentModelProfile(
      {
        sourceProfileId: "source-profile",
        targetProfileId: "target-profile",
        version: versionV2("user_select"),
        policy: policyV2("allowlist", ["openai"], ["gpt-5.6"]),
      },
      deps,
    );

    expect(deps.setModelConfig).toHaveBeenCalledWith(
      "custom:anhepro.com",
      "gpt-5.6-sol",
      "https://api.anhepro.com/v1",
      "target-profile",
      64_000,
      "chat_completions",
    );
  });

  it("validates a compatible installed Agent Profile without copying its model route onto itself", async () => {
    const deps = dependencies();

    await seedAgentModelProfile(
      {
        sourceProfileId: "installed-agent",
        targetProfileId: "installed-agent",
        version: version(["custom:anhepro.com"], ["gpt-5.6-sol"]),
        policy: policyV1(["custom:anhepro.com"], ["gpt-5.6-sol"]),
      },
      deps,
    );

    expect(deps.getSecret).toHaveBeenCalledWith(
      "CUSTOM_PROVIDER_ANHEPRO_COM_KEY",
      "installed-agent",
    );
    expect(deps.upsertCustomProvider).not.toHaveBeenCalled();
    expect(deps.upsertNativeCustomProvider).not.toHaveBeenCalled();
    expect(deps.setModelConfig).not.toHaveBeenCalled();
    expect(deps.setEnvValue).not.toHaveBeenCalled();
  });

  it("copies only the signed named-provider route and its exact credential", async () => {
    const deps = dependencies();

    await seedAgentModelProfile(
      {
        sourceProfileId: "source-profile",
        targetProfileId: "target-profile",
        version: version(["custom:anhepro.com"], ["gpt-5.6-sol"]),
        policy: policyV1(["custom:anhepro.com"], ["gpt-5.6-sol"]),
      },
      deps,
    );

    expect(deps.getSecret).toHaveBeenCalledTimes(1);
    expect(deps.getSecret).toHaveBeenCalledWith(
      "CUSTOM_PROVIDER_ANHEPRO_COM_KEY",
      "source-profile",
    );
    expect(deps.upsertNativeCustomProvider).toHaveBeenCalledWith(
      "target-profile",
      {
        name: "anhepro.com",
        baseUrl: "https://api.anhepro.com/v1",
        model: "gpt-5.6-sol",
        models: ["gpt-5.6-sol"],
        apiMode: "chat_completions",
      },
    );
    expect(deps.setModelConfig).toHaveBeenCalledWith(
      "custom:anhepro.com",
      "gpt-5.6-sol",
      "https://api.anhepro.com/v1",
      "target-profile",
      64_000,
      "chat_completions",
    );
    expect(deps.setEnvValue).toHaveBeenCalledWith(
      "CUSTOM_PROVIDER_ANHEPRO_COM_KEY",
      "private-value",
      "target-profile",
    );
  });

  it("keeps the user's in-place model when a legacy signed version names another model", async () => {
    const deps = dependencies();
    deps.getModelConfig.mockReturnValue({
      provider: "custom:anhepro.com",
      model: "currently-active-model",
      baseUrl: "https://api.anhepro.com/v1",
    });
    deps.readModels.mockReturnValue([
      {
        id: "model-current",
        name: "currently-active-model",
        provider: "custom",
        providerLabel: "anhepro.com",
        model: "currently-active-model",
        baseUrl: "https://api.anhepro.com/v1",
        apiMode: "chat_completions",
        contextLength: 32_000,
        createdAt: 1,
      },
      {
        id: "model-signed",
        name: "signed-model",
        provider: "custom",
        providerLabel: "anhepro.com",
        model: "signed-model",
        baseUrl: "https://api.anhepro.com/v1",
        apiMode: "chat_completions",
        contextLength: 64_000,
        createdAt: 2,
      },
    ]);

    await seedAgentModelProfile(
      {
        sourceProfileId: "source-profile",
        targetProfileId: "source-profile",
        version: version(["custom:anhepro.com"], ["signed-model"]),
        policy: policyV1(["custom:anhepro.com"], ["signed-model"]),
      },
      deps,
    );

    expect(deps.upsertNativeCustomProvider).not.toHaveBeenCalled();
    expect(deps.setModelConfig).not.toHaveBeenCalled();
  });

  it("copies the user's route when a legacy signed version names a different provider", async () => {
    const deps = dependencies();

    await seedAgentModelProfile(
      {
        sourceProfileId: "source-profile",
        targetProfileId: "target-profile",
        version: version(["openai"], ["gpt-5.6"]),
        policy: policyV1(["openai"], ["gpt-5.6"]),
      },
      deps,
    );

    expect(deps.setModelConfig).toHaveBeenCalledWith(
      "custom:anhepro.com",
      "gpt-5.6-sol",
      "https://api.anhepro.com/v1",
      "target-profile",
      64_000,
      "chat_completions",
    );
  });

  it("fails closed before target writes when a remote route has no credential", async () => {
    const deps = dependencies();
    deps.getSecret.mockReturnValue(null);

    await expect(
      seedAgentModelProfile(
        {
          sourceProfileId: "source-profile",
          targetProfileId: "target-profile",
          version: version(["custom:anhepro.com"], ["gpt-5.6-sol"]),
          policy: policyV1(["custom:anhepro.com"], ["gpt-5.6-sol"]),
        },
        deps,
      ),
    ).rejects.toThrow(/credential is unavailable/);

    expect(deps.upsertCustomProvider).not.toHaveBeenCalled();
    expect(deps.setModelConfig).not.toHaveBeenCalled();
    expect(deps.setEnvValue).not.toHaveBeenCalled();
  });
});
