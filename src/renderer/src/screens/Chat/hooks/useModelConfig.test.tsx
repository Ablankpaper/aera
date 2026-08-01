import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useModelConfig } from "./useModelConfig";

vi.mock("../../../hooks/useDiscoveredModels", () => ({
  useDiscoveredModels: () => ({
    models: [],
    status: "unsupported",
  }),
}));

vi.mock("../../../components/useI18n", () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}));

interface SavedModel {
  id: string;
  name: string;
  provider: string;
  model: string;
  baseUrl: string;
  providerLabel?: string;
  createdAt: number;
}

function Harness(): React.JSX.Element {
  const { modelGroups } = useModelConfig();
  const labels = modelGroups.flatMap((group) =>
    group.models.map((model) => model.label),
  );
  return <output data-testid="models">{JSON.stringify(labels)}</output>;
}

// Exposes the grouping shape (header brand + each model's routing provider) so a
// test can assert brand grouping without changing routing.
function GroupHarness(): React.JSX.Element {
  const { modelGroups } = useModelConfig();
  const shape = modelGroups.map((g) => ({
    provider: g.provider,
    label: g.providerLabel,
    models: g.models.map((m) => ({ model: m.model, provider: m.provider })),
  }));
  return <output data-testid="groups">{JSON.stringify(shape)}</output>;
}

describe("useModelConfig", () => {
  let savedModels: SavedModel[];
  let customProviders: Array<{
    id: string;
    name: string;
    baseUrl: string;
    createdAt: number;
  }>;
  let emitModelLibraryChanged: (() => void) | null;
  let emitCustomProvidersChanged: (() => void) | null;

  beforeEach(() => {
    savedModels = [
      {
        id: "codex-gpt-55",
        name: "Codex CLI GPT-5.5",
        provider: "codex-cli",
        model: "gpt-5.5",
        baseUrl: "",
        createdAt: 1,
      },
    ];
    customProviders = [];
    emitModelLibraryChanged = null;
    emitCustomProvidersChanged = null;

    Object.defineProperty(window, "hermesAPI", {
      configurable: true,
      value: {
        getModelConfig: vi.fn(async () => ({
          provider: "codex-cli",
          model: "gpt-5.5",
          baseUrl: "",
        })),
        listModels: vi.fn(async () => savedModels),
        listCustomProviders: vi.fn(async () => customProviders),
        onConnectionConfigChanged: vi.fn(() => vi.fn()),
        onModelLibraryChanged: vi.fn((callback: () => void) => {
          emitModelLibraryChanged = callback;
          return vi.fn();
        }),
        onCustomProvidersChanged: vi.fn((callback: () => void) => {
          emitCustomProvidersChanged = callback;
          return vi.fn();
        }),
        setModelConfig: vi.fn(async () => true),
      },
    });
  });

  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(window, "hermesAPI");
  });

  it("reloads the chat picker when the model library changes", async () => {
    render(<Harness />);

    await waitFor(() => {
      expect(screen.getByTestId("models")).toHaveTextContent(
        "Codex CLI GPT-5.5",
      );
    });

    savedModels = [
      ...savedModels,
      {
        id: "deepseek-v4-pro",
        name: "DeepSeek V4 Pro",
        provider: "deepseek",
        model: "deepseek-v4-pro",
        baseUrl: "",
        createdAt: 2,
      },
    ];

    await act(async () => {
      emitModelLibraryChanged?.();
    });

    await waitFor(() => {
      expect(screen.getByTestId("models")).toHaveTextContent("DeepSeek V4 Pro");
    });
  });

  it("groups a custom Hermes One model under the Hermes One brand while keeping custom routing", async () => {
    customProviders = [
      {
        id: "hermes-one",
        name: "Hermes One",
        baseUrl: "https://inference.hermesone.org/v1",
        createdAt: 1,
      },
    ];
    savedModels = [
      {
        id: "hs-swift",
        name: "hermesone-swift",
        provider: "custom",
        model: "hermesone-swift",
        baseUrl: "https://inference.hermesone.org/v1",
        createdAt: 1,
      },
    ];

    render(<GroupHarness />);

    await waitFor(() => {
      const groups = JSON.parse(
        screen.getByTestId("groups").textContent || "[]",
      );
      const hs = groups.find(
        (g: { label: string }) => g.label === "Hermes One",
      );
      expect(hs).toBeTruthy();
      // Not lumped under the generic OpenAI-compatible bucket.
      expect(hs.provider).toBe("hermesone");
      // Routing uses the Profile's current named-provider identity.
      expect(hs.models[0]).toEqual({
        model: "hermesone-swift",
        provider: "custom:hermes-one",
      });
    });
  });

  it("carries a named custom provider's native route into chat picker selections", async () => {
    customProviders = [
      {
        id: "anhepro",
        name: "anhepro.com",
        baseUrl: "https://api.anhepro.com/v1",
        createdAt: 1,
      },
    ];
    savedModels = [
      {
        id: "anhepro-sol",
        name: "gpt-5.6-sol",
        provider: "custom",
        providerLabel: "anhepro.com",
        model: "gpt-5.6-sol",
        baseUrl: "https://api.anhepro.com/v1",
        createdAt: 1,
      },
    ];

    render(<GroupHarness />);

    await waitFor(() => {
      const groups = JSON.parse(
        screen.getByTestId("groups").textContent || "[]",
      );
      expect(groups).toEqual([
        {
          provider: "custom:anhepro.com",
          label: "anhepro.com",
          models: [
            {
              model: "gpt-5.6-sol",
              provider: "custom:anhepro.com",
            },
          ],
        },
      ]);
    });
  });

  it("removes historical custom-provider groups as soon as the current Profile provider list changes", async () => {
    customProviders = [
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
    ];
    savedModels = [
      {
        id: "petoi-sol",
        name: "gpt-5.6-sol",
        provider: "custom",
        providerLabel: "Petoi",
        model: "gpt-5.6-sol",
        baseUrl: "https://api.petoi.cn/v1",
        createdAt: 1,
      },
      {
        id: "yundu-opus",
        name: "claude-opus-4-6",
        provider: "custom",
        providerLabel: "yundu.lat",
        model: "claude-opus-4-6",
        baseUrl: "https://yundu.lat/v1",
        createdAt: 2,
      },
    ];

    render(<GroupHarness />);
    await waitFor(() => {
      expect(screen.getByTestId("groups")).toHaveTextContent("Petoi");
      expect(screen.getByTestId("groups")).toHaveTextContent("yundu.lat");
    });

    customProviders = customProviders.filter(
      (provider) => provider.name === "yundu.lat",
    );
    await act(async () => {
      emitCustomProvidersChanged?.();
    });

    await waitFor(() => {
      expect(screen.getByTestId("groups")).not.toHaveTextContent("Petoi");
      expect(screen.getByTestId("groups")).toHaveTextContent("yundu.lat");
    });
  });
});
