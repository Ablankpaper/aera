// @vitest-environment node

import { describe, expect, it, vi, type Mocked } from "vitest";
import type { AgentVersion } from "./client";
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

function dependencies(): Mocked<SeedDependencies> {
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
  };
}

describe("Agent Profile model seeding", () => {
  it("validates a compatible installed Agent Profile without copying its model route onto itself", () => {
    const deps = dependencies();

    seedAgentModelProfile(
      {
        sourceProfileId: "installed-agent",
        targetProfileId: "installed-agent",
        version: version(["custom:anhepro.com"], ["gpt-5.6-sol"]),
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

  it("copies only the signed named-provider route and its exact credential", () => {
    const deps = dependencies();

    seedAgentModelProfile(
      {
        sourceProfileId: "source-profile",
        targetProfileId: "target-profile",
        version: version(["custom:anhepro.com"], ["gpt-5.6-sol"]),
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

  it("reconfigures an in-place Agent Profile when the new signed version selects another model", () => {
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

    seedAgentModelProfile(
      {
        sourceProfileId: "source-profile",
        targetProfileId: "source-profile",
        version: version(["custom:anhepro.com"], ["signed-model"]),
      },
      deps,
    );

    expect(deps.upsertNativeCustomProvider).toHaveBeenCalledWith(
      "source-profile",
      {
        name: "anhepro.com",
        baseUrl: "https://api.anhepro.com/v1",
        model: "signed-model",
        models: ["signed-model"],
        apiMode: "chat_completions",
      },
    );
    expect(deps.setModelConfig).toHaveBeenCalledWith(
      "custom:anhepro.com",
      "signed-model",
      "https://api.anhepro.com/v1",
      "source-profile",
      64_000,
      "chat_completions",
    );
  });

  it("fails closed before target writes when the signed version disallows the source model", () => {
    const deps = dependencies();

    expect(() =>
      seedAgentModelProfile(
        {
          sourceProfileId: "source-profile",
          targetProfileId: "target-profile",
          version: version(["openai"], ["gpt-5.6"]),
        },
        deps,
      ),
    ).toThrow(/not allowed/);

    expect(deps.getSecret).not.toHaveBeenCalled();
    expect(deps.upsertCustomProvider).not.toHaveBeenCalled();
    expect(deps.setModelConfig).not.toHaveBeenCalled();
    expect(deps.setEnvValue).not.toHaveBeenCalled();
  });

  it("fails closed before target writes when a remote route has no credential", () => {
    const deps = dependencies();
    deps.getSecret.mockReturnValue(null);

    expect(() =>
      seedAgentModelProfile(
        {
          sourceProfileId: "source-profile",
          targetProfileId: "target-profile",
          version: version(["custom:anhepro.com"], ["gpt-5.6-sol"]),
        },
        deps,
      ),
    ).toThrow(/credential is unavailable/);

    expect(deps.upsertCustomProvider).not.toHaveBeenCalled();
    expect(deps.setModelConfig).not.toHaveBeenCalled();
    expect(deps.setEnvValue).not.toHaveBeenCalled();
  });
});
