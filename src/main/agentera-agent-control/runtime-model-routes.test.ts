// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { listAgentRuntimeModelRoutes } from "./runtime-model-routes";

type RouteDependencies = NonNullable<
  Parameters<typeof listAgentRuntimeModelRoutes>[1]
>;

describe("Agent runtime model routes", () => {
  it("lists every credential-backed model for configured providers and excludes stale attachments", () => {
    const dependencies: RouteDependencies = {
      readModels: vi.fn(() => [
        {
          id: "petoi-gpt",
          name: "GPT 5.6",
          provider: "custom",
          providerLabel: "Petoi",
          model: "gpt-5.6-sol",
          baseUrl: "https://api.petoi.cn/v1",
          createdAt: 1,
        },
        {
          id: "petoi-claude",
          name: "Claude Opus",
          provider: "custom",
          providerLabel: "Petoi",
          model: "claude-opus-4-6",
          baseUrl: "https://api.petoi.cn/v1",
          createdAt: 2,
        },
        {
          id: "yundu-sonnet",
          name: "Claude Sonnet",
          provider: "custom",
          providerLabel: "yundu.lat",
          model: "claude-sonnet-4-6",
          baseUrl: "https://yundu.lat/v1",
          createdAt: 3,
        },
        {
          id: "deleted-provider-model",
          name: "Deleted",
          provider: "custom",
          providerLabel: "Deleted Provider",
          model: "deleted-model",
          baseUrl: "https://deleted.example/v1",
          createdAt: 4,
        },
      ]),
      listCustomProviders: vi.fn(() => [
        {
          id: "petoi",
          name: "Petoi",
          baseUrl: "https://api.petoi.cn/v1",
          createdAt: 1,
        },
        {
          id: "yundu",
          name: "yundu.lat",
          baseUrl: "https://yundu.lat/v1",
          createdAt: 2,
        },
      ]),
      getSecret: vi.fn((key: string) =>
        key === "CUSTOM_PROVIDER_PETOI_KEY" ||
        key === "CUSTOM_PROVIDER_YUNDU_LAT_KEY"
          ? "configured"
          : null,
      ),
      hasOAuthCredentials: vi.fn(() => false),
    };

    expect(listAgentRuntimeModelRoutes("account-home", dependencies)).toEqual([
      expect.objectContaining({
        id: "account-home\0petoi-gpt",
        sourceProfileId: "account-home",
        modelLibraryId: "petoi-gpt",
        provider: "custom:petoi",
        providerLabel: "Petoi",
        model: "gpt-5.6-sol",
      }),
      expect.objectContaining({
        id: "account-home\0petoi-claude",
        provider: "custom:petoi",
        providerLabel: "Petoi",
        model: "claude-opus-4-6",
      }),
      expect.objectContaining({
        id: "account-home\0yundu-sonnet",
        provider: "custom:yundu.lat",
        providerLabel: "yundu.lat",
        model: "claude-sonnet-4-6",
      }),
    ]);
  });
});
