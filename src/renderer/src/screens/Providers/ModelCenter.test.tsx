import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ModelCenter from "./ModelCenter";

vi.mock("../../components/useI18n", () => ({
  useI18n: () => ({
    locale: "en",
    setLocale: vi.fn(),
    t: (key: string, values?: { count?: number }) =>
      values?.count === undefined ? key : `${key}:${values.count}`,
  }),
}));

vi.mock("../../components/common/BrandLogo", () => ({
  default: () => <span data-testid="brand-logo" />,
}));

describe("ModelCenter", () => {
  const listModels = vi.fn();
  const listCustomProviders = vi.fn();
  const discoverProviderModels = vi.fn();
  const addModel = vi.fn();
  const setModelConfig = vi.fn();
  const getModelConfig = vi.fn();
  const upsertCustomProvider = vi.fn();
  const removeCustomProvider = vi.fn();
  const removeModel = vi.fn();
  const onModelLibraryChanged = vi.fn();
  const onCustomProvidersChanged = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    listModels.mockResolvedValue([]);
    listCustomProviders.mockResolvedValue([]);
    discoverProviderModels.mockResolvedValue({
      models: ["gpt-5.6-sol"],
      status: "ok",
      cached: false,
    });
    addModel.mockResolvedValue({
      id: "model-1",
      name: "gpt-5.6-sol",
      provider: "custom",
      model: "gpt-5.6-sol",
      baseUrl: "https://api.petoi.cn/v1",
      apiMode: "chat_completions",
      createdAt: Date.now(),
    });
    setModelConfig.mockResolvedValue(true);
    getModelConfig.mockImplementation(async () => {
      const lastCall = setModelConfig.mock.lastCall;
      return {
        provider: lastCall?.[0] ?? "auto",
        model: lastCall?.[1] ?? "",
        baseUrl: lastCall?.[2] ?? "",
      };
    });
    upsertCustomProvider.mockResolvedValue(null);
    removeCustomProvider.mockResolvedValue(undefined);
    removeModel.mockResolvedValue(true);
    onModelLibraryChanged.mockReturnValue(vi.fn());
    onCustomProvidersChanged.mockReturnValue(vi.fn());

    Object.defineProperty(window, "hermesAPI", {
      configurable: true,
      value: {
        listModels,
        listCustomProviders,
        discoverProviderModels,
        addModel,
        setModelConfig,
        getModelConfig,
        upsertCustomProvider,
        removeCustomProvider,
        removeModel,
        onModelLibraryChanged,
        onCustomProvidersChanged,
      },
    });
  });

  it("uses the Petoi preset to connect, discover, save, and activate a model", async () => {
    const onSaveKey = vi.fn().mockResolvedValue(undefined);
    const onActivated = vi.fn();
    render(
      <ModelCenter
        profile="acceptance"
        env={{}}
        activeModel={{ provider: "auto", model: "", baseUrl: "" }}
        onSaveKey={onSaveKey}
        onActivated={onActivated}
        onOpenModelPicker={vi.fn()}
        onBrowseRegistry={vi.fn()}
      />,
    );

    await waitFor(() => expect(listModels).toHaveBeenCalled());
    fireEvent.click(
      screen.getAllByRole("button", {
        name: /providers\.center\.addModel/,
      })[0],
    );

    fireEvent.change(screen.getByLabelText(/providers\.center\.provider/), {
      target: { value: "petoi" },
    });
    const baseUrl = screen.getByLabelText(
      /providers\.center\.baseUrl/,
    ) as HTMLInputElement;
    expect(baseUrl.value).toBe("https://api.petoi.cn/v1");
    expect(baseUrl).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/providers\.center\.apiKey/), {
      target: { value: "petoi-test-key" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "providers.center.connect" }),
    );

    await waitFor(() =>
      expect(discoverProviderModels).toHaveBeenCalledWith(
        "custom",
        "https://api.petoi.cn/v1",
        "petoi-test-key",
        "acceptance",
      ),
    );
    await waitFor(() =>
      expect(
        (
          screen.getByLabelText(
            /providers\.center\.defaultModel/,
          ) as HTMLInputElement
        ).value,
      ).toBe("gpt-5.6-sol"),
    );
    const defaultModelInput = screen.getByLabelText(
      /providers\.center\.defaultModel/,
    );
    expect(
      defaultModelInput.closest(".model-provider-model-row"),
    ).toContainElement(
      screen.getByRole("button", { name: "providers.center.connected" }),
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "providers.center.addAndUse",
      }),
    );

    await waitFor(() =>
      expect(onSaveKey).toHaveBeenCalledWith("PETOI_API_KEY", "petoi-test-key"),
    );
    expect(addModel).toHaveBeenCalledWith(
      "gpt-5.6-sol",
      "custom",
      "gpt-5.6-sol",
      "https://api.petoi.cn/v1",
      undefined,
      undefined,
      "chat_completions",
    );
    expect(setModelConfig).toHaveBeenCalledWith(
      "custom",
      "gpt-5.6-sol",
      "https://api.petoi.cn/v1",
      "acceptance",
    );
    expect(onActivated).toHaveBeenCalledWith({
      provider: "custom",
      model: "gpt-5.6-sol",
      baseUrl: "https://api.petoi.cn/v1",
    });
  });

  it("shows context length and API mode only in custom mode", async () => {
    render(
      <ModelCenter
        env={{}}
        activeModel={{ provider: "auto", model: "", baseUrl: "" }}
        onSaveKey={vi.fn().mockResolvedValue(undefined)}
        onActivated={vi.fn()}
        onOpenModelPicker={vi.fn()}
        onBrowseRegistry={vi.fn()}
      />,
    );

    await waitFor(() => expect(listModels).toHaveBeenCalled());
    fireEvent.click(
      screen.getAllByRole("button", {
        name: /providers\.center\.addModel/,
      })[0],
    );
    expect(
      screen.queryByLabelText("providers.center.apiMode"),
    ).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "providers.center.custom" }),
    );
    expect(
      screen.getByLabelText("providers.center.contextLength"),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText("providers.center.apiMode"),
    ).toBeInTheDocument();
  });

  it("renders configured services as detailed cards without exposing the API key", async () => {
    listModels.mockResolvedValue([
      {
        id: "model-1",
        name: "gpt-5.6-sol",
        provider: "custom",
        model: "gpt-5.6-sol",
        baseUrl: "https://api.petoi.cn/v1",
        apiMode: "chat_completions",
        createdAt: 1,
      },
      {
        id: "model-2",
        name: "gpt-5.5",
        provider: "custom",
        model: "gpt-5.5",
        baseUrl: "https://api.petoi.cn/v1",
        apiMode: "chat_completions",
        createdAt: 2,
      },
    ]);

    render(
      <ModelCenter
        profile="acceptance"
        env={{ PETOI_API_KEY: "secret-that-must-not-render" }}
        activeModel={{
          provider: "custom",
          model: "gpt-5.6-sol",
          baseUrl: "https://api.petoi.cn/v1",
        }}
        onSaveKey={vi.fn().mockResolvedValue(undefined)}
        onActivated={vi.fn()}
        onOpenModelPicker={vi.fn()}
        onBrowseRegistry={vi.fn()}
      />,
    );

    expect(await screen.findByText("custom")).toBeInTheDocument();
    expect(
      screen.getByText("providers.center.modelsCount:2"),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText("Petoi providers.center.defaultModel"),
    ).toHaveValue("gpt-5.6-sol");
    expect(screen.getByTitle("gpt-5.5")).toBeInTheDocument();
    expect(
      screen.queryByText("secret-that-must-not-render"),
    ).not.toBeInTheDocument();
  });

  it("changes the default model directly from a service card", async () => {
    listModels.mockResolvedValue([
      {
        id: "model-1",
        name: "gpt-5.6-sol",
        provider: "custom",
        model: "gpt-5.6-sol",
        baseUrl: "https://api.petoi.cn/v1",
        apiMode: "chat_completions",
        createdAt: 1,
      },
      {
        id: "model-2",
        name: "gpt-5.5",
        provider: "custom",
        model: "gpt-5.5",
        baseUrl: "https://api.petoi.cn/v1",
        apiMode: "chat_completions",
        createdAt: 2,
      },
    ]);
    const onActivated = vi.fn();

    render(
      <ModelCenter
        profile="acceptance"
        env={{ PETOI_API_KEY: "configured" }}
        activeModel={{
          provider: "custom",
          model: "gpt-5.6-sol",
          baseUrl: "https://api.petoi.cn/v1",
        }}
        onSaveKey={vi.fn().mockResolvedValue(undefined)}
        onActivated={onActivated}
        onOpenModelPicker={vi.fn()}
        onBrowseRegistry={vi.fn()}
      />,
    );

    const select = await screen.findByLabelText(
      "Petoi providers.center.defaultModel",
    );
    fireEvent.change(select, { target: { value: "gpt-5.5" } });

    await waitFor(() =>
      expect(setModelConfig).toHaveBeenCalledWith(
        "custom",
        "gpt-5.5",
        "https://api.petoi.cn/v1",
        "acceptance",
      ),
    );
    expect(onActivated).toHaveBeenCalledWith({
      provider: "custom",
      model: "gpt-5.5",
      baseUrl: "https://api.petoi.cn/v1",
    });
  });

  it("uses Main's canonical named-custom route after activating a service", async () => {
    listModels.mockResolvedValue([
      {
        id: "model-1",
        name: "gpt-5.6-sol",
        provider: "custom",
        model: "gpt-5.6-sol",
        baseUrl: "https://api.anhepro.com/v1",
        providerLabel: "Anhe Pro",
        createdAt: 2,
      },
    ]);
    listCustomProviders.mockResolvedValue([
      {
        id: "anhepro",
        name: "Anhe Pro",
        baseUrl: "https://api.anhepro.com/v1",
        createdAt: 1,
      },
    ]);
    getModelConfig.mockResolvedValue({
      provider: "custom:anhe-pro",
      model: "gpt-5.6-sol",
      baseUrl: "https://api.anhepro.com/v1",
    });
    const onActivated = vi.fn();
    const { container } = render(
      <ModelCenter
        profile="acceptance"
        env={{ CUSTOM_PROVIDER_ANHE_PRO_KEY: "configured" }}
        activeModel={{ provider: "auto", model: "", baseUrl: "" }}
        onSaveKey={vi.fn().mockResolvedValue(undefined)}
        onActivated={onActivated}
        onOpenModelPicker={vi.fn()}
        onBrowseRegistry={vi.fn()}
      />,
    );

    const card = await waitFor(() => {
      const element = container.querySelector(
        '[data-service-key="custom:anhepro"]',
      );
      expect(element).toBeInTheDocument();
      return element as HTMLElement;
    });
    expect(within(card).getByText("custom:anhe-pro")).toBeInTheDocument();

    fireEvent.click(
      within(card).getByRole("button", {
        name: "providers.center.setDefault",
      }),
    );

    await waitFor(() =>
      expect(setModelConfig).toHaveBeenCalledWith(
        "custom",
        "gpt-5.6-sol",
        "https://api.anhepro.com/v1",
        "acceptance",
      ),
    );
    expect(onActivated).toHaveBeenCalledWith({
      provider: "custom:anhe-pro",
      model: "gpt-5.6-sol",
      baseUrl: "https://api.anhepro.com/v1",
    });
  });

  it("refreshes a service through discovery and saves the returned model catalog", async () => {
    listModels.mockResolvedValue([
      {
        id: "model-1",
        name: "gpt-5.6-sol",
        provider: "custom",
        model: "gpt-5.6-sol",
        baseUrl: "https://api.petoi.cn/v1",
        apiMode: "chat_completions",
        createdAt: 1,
      },
    ]);
    discoverProviderModels.mockResolvedValue({
      models: ["gpt-5.6-sol", "gpt-5.6-terra"],
      status: "ok",
      cached: false,
    });

    render(
      <ModelCenter
        profile="acceptance"
        env={{ PETOI_API_KEY: "configured" }}
        activeModel={{
          provider: "custom",
          model: "gpt-5.6-sol",
          baseUrl: "https://api.petoi.cn/v1",
        }}
        onSaveKey={vi.fn().mockResolvedValue(undefined)}
        onActivated={vi.fn()}
        onOpenModelPicker={vi.fn()}
        onBrowseRegistry={vi.fn()}
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", {
        name: "providers.center.refreshModels",
      }),
    );

    await waitFor(() =>
      expect(discoverProviderModels).toHaveBeenCalledWith(
        "custom",
        "https://api.petoi.cn/v1",
        "configured",
        "acceptance",
      ),
    );
    await waitFor(() => expect(addModel).toHaveBeenCalledTimes(2));
    expect(addModel).toHaveBeenNthCalledWith(
      2,
      "gpt-5.6-terra",
      "custom",
      "gpt-5.6-terra",
      "https://api.petoi.cn/v1",
      undefined,
      undefined,
      "chat_completions",
    );
  });

  it("opens the existing service in the edit dialog", async () => {
    listModels.mockResolvedValue([
      {
        id: "model-1",
        name: "gpt-5.6-sol",
        provider: "custom",
        model: "gpt-5.6-sol",
        baseUrl: "https://api.petoi.cn/v1",
        apiMode: "chat_completions",
        createdAt: 1,
      },
    ]);

    render(
      <ModelCenter
        env={{ PETOI_API_KEY: "configured" }}
        activeModel={{
          provider: "custom",
          model: "gpt-5.6-sol",
          baseUrl: "https://api.petoi.cn/v1",
        }}
        onSaveKey={vi.fn().mockResolvedValue(undefined)}
        onActivated={vi.fn()}
        onOpenModelPicker={vi.fn()}
        onBrowseRegistry={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "common.edit" }));
    expect(
      screen.getByRole("heading", {
        name: "providers.center.editDialogTitle",
      }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/providers\.center\.baseUrl/)).toHaveValue(
      "https://api.petoi.cn/v1",
    );
  });

  it("marks only the exact custom endpoint as active", async () => {
    listModels.mockResolvedValue([
      {
        id: "petoi-model",
        name: "gpt-5.6-sol",
        provider: "custom",
        model: "gpt-5.6-sol",
        baseUrl: "https://api.petoi.cn/v1",
        createdAt: 1,
      },
      {
        id: "anhepro-model",
        name: "gpt-5.6-sol",
        provider: "custom",
        model: "gpt-5.6-sol",
        baseUrl: "https://api.anhepro.com/v1",
        providerLabel: "anhepro.com",
        createdAt: 2,
      },
    ]);
    listCustomProviders.mockResolvedValue([
      {
        id: "anhepro",
        name: "anhepro.com",
        baseUrl: "https://api.anhepro.com/v1",
        createdAt: 1,
      },
    ]);

    const { container } = render(
      <ModelCenter
        profile="acceptance"
        env={{
          PETOI_API_KEY: "configured",
          CUSTOM_PROVIDER_ANHEPRO_COM_KEY: "configured",
        }}
        activeModel={{
          provider: "custom",
          model: "gpt-5.6-sol",
          baseUrl: "https://api.anhepro.com/v1",
        }}
        onSaveKey={vi.fn().mockResolvedValue(undefined)}
        onActivated={vi.fn()}
        onOpenModelPicker={vi.fn()}
        onBrowseRegistry={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(
        container.querySelector('[data-service-key="custom:anhepro"]'),
      ).toBeInTheDocument(),
    );
    expect(
      container.querySelector('[data-service-key="custom:anhepro"]'),
    ).toHaveClass("active");
    expect(
      container.querySelector('[data-service-key="preset:petoi"]'),
    ).not.toHaveClass("active");
  });

  it("filters configured services and keeps model previews compact", async () => {
    listModels.mockResolvedValue([
      ...Array.from({ length: 8 }, (_, index) => ({
        id: `petoi-${index}`,
        name: `petoi-model-${index}`,
        provider: "custom",
        model: `petoi-model-${index}`,
        baseUrl: "https://api.petoi.cn/v1",
        createdAt: index,
      })),
      {
        id: "anhepro-model",
        name: "anhepro-chat",
        provider: "custom",
        model: "anhepro-chat",
        baseUrl: "https://api.anhepro.com/v1",
        providerLabel: "anhepro.com",
        createdAt: 20,
      },
    ]);
    listCustomProviders.mockResolvedValue([
      {
        id: "anhepro",
        name: "anhepro.com",
        baseUrl: "https://api.anhepro.com/v1",
        createdAt: 1,
      },
    ]);

    const { container } = render(
      <ModelCenter
        profile="acceptance"
        env={{
          PETOI_API_KEY: "configured",
          CUSTOM_PROVIDER_ANHEPRO_COM_KEY: "configured",
        }}
        activeModel={{
          provider: "custom",
          model: "anhepro-chat",
          baseUrl: "https://api.anhepro.com/v1",
        }}
        onSaveKey={vi.fn().mockResolvedValue(undefined)}
        onActivated={vi.fn()}
        onOpenModelPicker={vi.fn()}
        onBrowseRegistry={vi.fn()}
      />,
    );

    const petoiCard = await waitFor(() => {
      const card = container.querySelector('[data-service-key="preset:petoi"]');
      expect(card).toBeInTheDocument();
      return card as HTMLElement;
    });
    expect(within(petoiCard).getByText("+2")).toBeInTheDocument();
    expect(within(petoiCard).queryByTitle("petoi-model-7")).toBeNull();

    fireEvent.change(
      screen.getByRole("searchbox", {
        name: "providers.center.searchPlaceholder",
      }),
      { target: { value: "anhepro-chat" } },
    );

    await waitFor(() =>
      expect(
        container.querySelector('[data-service-key="preset:petoi"]'),
      ).not.toBeInTheDocument(),
    );
    expect(
      container.querySelector('[data-service-key="custom:anhepro"]'),
    ).toBeInTheDocument();
  });

  it("deletes a configured service and switches an active service to a safe fallback", async () => {
    listModels.mockResolvedValue([
      {
        id: "petoi-model",
        name: "petoi-chat",
        provider: "custom",
        model: "petoi-chat",
        baseUrl: "https://api.petoi.cn/v1",
        createdAt: 1,
      },
      {
        id: "anhepro-model",
        name: "anhepro-chat",
        provider: "custom",
        model: "anhepro-chat",
        baseUrl: "https://api.anhepro.com/v1",
        providerLabel: "anhepro.com",
        createdAt: 2,
      },
    ]);
    listCustomProviders.mockResolvedValue([
      {
        id: "anhepro",
        name: "anhepro.com",
        baseUrl: "https://api.anhepro.com/v1",
        createdAt: 1,
      },
    ]);
    const onSaveKey = vi.fn().mockResolvedValue(undefined);
    const onActivated = vi.fn();
    const { container } = render(
      <ModelCenter
        profile="acceptance"
        env={{
          PETOI_API_KEY: "configured",
          CUSTOM_PROVIDER_ANHEPRO_COM_KEY: "configured",
        }}
        activeModel={{
          provider: "custom",
          model: "anhepro-chat",
          baseUrl: "https://api.anhepro.com/v1",
        }}
        onSaveKey={onSaveKey}
        onActivated={onActivated}
        onOpenModelPicker={vi.fn()}
        onBrowseRegistry={vi.fn()}
      />,
    );

    const anheproCard = await waitFor(() => {
      const card = container.querySelector(
        '[data-service-key="custom:anhepro"]',
      );
      expect(card).toBeInTheDocument();
      return card as HTMLElement;
    });
    fireEvent.click(
      within(anheproCard).getByRole("button", {
        name: "providers.center.deleteService",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "providers.center.confirmDelete",
      }),
    );

    await waitFor(() =>
      expect(setModelConfig).toHaveBeenCalledWith(
        "custom",
        "petoi-chat",
        "https://api.petoi.cn/v1",
        "acceptance",
      ),
    );
    expect(removeModel).not.toHaveBeenCalled();
    expect(removeCustomProvider).toHaveBeenCalledWith(
      "acceptance",
      "anhepro.com",
    );
    expect(onSaveKey).toHaveBeenCalledWith(
      "CUSTOM_PROVIDER_ANHEPRO_COM_KEY",
      "",
    );
    expect(onActivated).toHaveBeenCalledWith({
      provider: "custom",
      model: "petoi-chat",
      baseUrl: "https://api.petoi.cn/v1",
    });
  });
});
