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

  const catalogRevision = "a".repeat(64);
  const emptyCatalog = {
    revision: catalogRevision,
    targetProfileId: "acceptance",
    routes: [],
  };

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

  async function completePetoiForm(): Promise<void> {
    await waitFor(() => expect(listModels).toHaveBeenCalled());
    fireEvent.click(
      screen.getAllByRole("button", {
        name: /providers\.center\.addModel/,
      })[0],
    );
    fireEvent.change(screen.getByLabelText(/providers\.center\.provider/), {
      target: { value: "petoi" },
    });
    fireEvent.change(screen.getByLabelText(/providers\.center\.apiKey/), {
      target: { value: "petoi-test-key" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "providers.center.connect" }),
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
    fireEvent.click(
      screen.getByRole("button", { name: "providers.center.addAndUse" }),
    );
  }

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

  it("saves through one coordinator call and trusts its catalog", async () => {
    const mutateModelConfiguration = vi.fn().mockResolvedValue({
      status: "committed",
      catalog: {
        revision: "b".repeat(64),
        targetProfileId: "acceptance",
        routes: [
          {
            id: "acceptance\0model-1",
            provider: "custom:petoi",
            model: "gpt-5.6-sol",
            baseUrl: "https://api.petoi.cn/v1",
            apiMode: "chat_completions",
            providerLabel: "Petoi",
            displayName: "gpt-5.6-sol",
            sourceProfileId: "acceptance",
            sourceKind: "account",
            selection: {
              sourceProfileId: "acceptance",
              modelLibraryId: "model-1",
              catalogRevision: "b".repeat(64),
            },
          },
        ],
      },
    });
    Object.assign(window.hermesAPI, {
      getOwnerModelRouteCatalog: vi.fn().mockResolvedValue(emptyCatalog),
      mutateModelConfiguration,
    });
    const onActivated = vi.fn();
    render(
      <ModelCenter
        profile="acceptance"
        env={{}}
        activeModel={{ provider: "auto", model: "", baseUrl: "" }}
        onSaveKey={vi.fn().mockResolvedValue(undefined)}
        onActivated={onActivated}
        onOpenModelPicker={vi.fn()}
        onBrowseRegistry={vi.fn()}
      />,
    );

    await completePetoiForm();

    await waitFor(() =>
      expect(mutateModelConfiguration).toHaveBeenCalledTimes(1),
    );
    expect(mutateModelConfiguration).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: "upsert",
        expectedCatalogRevision: catalogRevision,
        requestedProfileId: "acceptance",
        provider: "custom",
        providerLabel: "Petoi",
        apiKey: "petoi-test-key",
        activeModel: "gpt-5.6-sol",
      }),
    );
    expect(addModel).not.toHaveBeenCalled();
    expect(setModelConfig).not.toHaveBeenCalled();
    expect(upsertCustomProvider).not.toHaveBeenCalled();
    expect(onActivated).toHaveBeenCalledWith({
      provider: "custom:petoi",
      model: "gpt-5.6-sol",
      baseUrl: "https://api.petoi.cn/v1",
    });
  });

  it("does not call a committed refresh warning a save failure", async () => {
    const mutateModelConfiguration = vi.fn().mockResolvedValue({
      status: "committed_refresh_warning",
      catalog: emptyCatalog,
      warning: "model_save_refresh_failed",
    });
    Object.assign(window.hermesAPI, {
      getOwnerModelRouteCatalog: vi.fn().mockResolvedValue(emptyCatalog),
      mutateModelConfiguration,
    });
    render(
      <ModelCenter
        profile="acceptance"
        env={{}}
        activeModel={{ provider: "auto", model: "", baseUrl: "" }}
        onSaveKey={vi.fn().mockResolvedValue(undefined)}
        onActivated={vi.fn()}
        onOpenModelPicker={vi.fn()}
        onBrowseRegistry={vi.fn()}
      />,
    );

    await completePetoiForm();

    expect(
      await screen.findByText("providers.center.warnings.refresh"),
    ).toBeVisible();
    expect(
      screen.queryByText("providers.center.errors.save"),
    ).not.toBeInTheDocument();
  });

  it("keeps the editor open when Main rejects a provider stage", async () => {
    const mutateModelConfiguration = vi.fn().mockResolvedValue({
      status: "rejected",
      stage: "provider",
      code: "model_save_provider_failed",
      rollback: "restored",
    });
    Object.assign(window.hermesAPI, {
      getOwnerModelRouteCatalog: vi.fn().mockResolvedValue(emptyCatalog),
      mutateModelConfiguration,
    });
    render(
      <ModelCenter
        profile="acceptance"
        env={{}}
        activeModel={{ provider: "auto", model: "", baseUrl: "" }}
        onSaveKey={vi.fn().mockResolvedValue(undefined)}
        onActivated={vi.fn()}
        onOpenModelPicker={vi.fn()}
        onBrowseRegistry={vi.fn()}
      />,
    );

    await completePetoiForm();

    expect(
      await screen.findByText("providers.center.errors.stage"),
    ).toBeVisible();
    expect(screen.getByLabelText(/providers\.center\.apiKey/)).toHaveValue(
      "petoi-test-key",
    );
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

  it("keeps a named custom provider's credential when its URL matches a preset", async () => {
    listModels.mockResolvedValue([
      {
        id: "model-1",
        name: "gpt-5.6-sol",
        provider: "custom",
        model: "gpt-5.6-sol",
        baseUrl: "https://api.petoi.cn/v1",
        providerLabel: "Petoi Acceptance",
        apiMode: "chat_completions",
        createdAt: 1,
      },
    ]);
    listCustomProviders.mockResolvedValue([
      {
        id: "petoi-acceptance",
        name: "Petoi Acceptance",
        baseUrl: "https://api.petoi.cn/v1",
        createdAt: 1,
      },
    ]);

    const { container } = render(
      <ModelCenter
        profile="acceptance"
        env={{ CUSTOM_PROVIDER_PETOI_ACCEPTANCE_KEY: "configured" }}
        activeModel={{
          provider: "custom:petoi-acceptance",
          model: "gpt-5.6-sol",
          baseUrl: "https://api.petoi.cn/v1",
        }}
        onSaveKey={vi.fn().mockResolvedValue(undefined)}
        onActivated={vi.fn()}
        onOpenModelPicker={vi.fn()}
        onBrowseRegistry={vi.fn()}
      />,
    );

    const serviceCard = await waitFor(() => {
      const card = container.querySelector(
        '[data-service-key="custom:petoi-acceptance"]',
      );
      expect(card).toBeInTheDocument();
      return card as HTMLElement;
    });
    expect(
      within(serviceCard).getByText("Petoi Acceptance"),
    ).toBeInTheDocument();
    expect(
      container.querySelector('[data-service-key="preset:petoi"]'),
    ).not.toBeInTheDocument();

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
    expect(addModel).toHaveBeenCalledWith(
      "gpt-5.6-sol",
      "custom",
      "gpt-5.6-sol",
      "https://api.petoi.cn/v1",
      undefined,
      "Petoi Acceptance",
      "chat_completions",
    );
  });

  it("deletes the named custom identity and key instead of the matching preset key", async () => {
    listModels.mockResolvedValue([
      {
        id: "model-1",
        name: "gpt-5.6-sol",
        provider: "custom",
        model: "gpt-5.6-sol",
        baseUrl: "https://api.petoi.cn/v1",
        providerLabel: "Petoi Acceptance",
        apiMode: "chat_completions",
        createdAt: 1,
      },
    ]);
    listCustomProviders.mockResolvedValue([
      {
        id: "petoi-acceptance",
        name: "Petoi Acceptance",
        baseUrl: "https://api.petoi.cn/v1",
        createdAt: 1,
      },
    ]);
    const onSaveKey = vi.fn().mockResolvedValue(undefined);

    const { container } = render(
      <ModelCenter
        profile="acceptance"
        env={{ CUSTOM_PROVIDER_PETOI_ACCEPTANCE_KEY: "configured" }}
        activeModel={{
          provider: "custom:petoi-acceptance",
          model: "gpt-5.6-sol",
          baseUrl: "https://api.petoi.cn/v1",
        }}
        onSaveKey={onSaveKey}
        onActivated={vi.fn()}
        onOpenModelPicker={vi.fn()}
        onBrowseRegistry={vi.fn()}
      />,
    );

    const serviceCard = await waitFor(() => {
      const card = container.querySelector(
        '[data-service-key="custom:petoi-acceptance"]',
      );
      expect(card).toBeInTheDocument();
      return card as HTMLElement;
    });
    fireEvent.click(
      within(serviceCard).getByRole("button", {
        name: "providers.center.deleteService",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "providers.center.confirmDelete",
      }),
    );

    await waitFor(() =>
      expect(removeCustomProvider).toHaveBeenCalledWith(
        "acceptance",
        "Petoi Acceptance",
      ),
    );
    expect(onSaveKey).toHaveBeenCalledWith(
      "CUSTOM_PROVIDER_PETOI_ACCEPTANCE_KEY",
      "",
    );
    expect(onSaveKey).not.toHaveBeenCalledWith("PETOI_API_KEY", "");
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

  it("keeps an active service when no replacement route is available", async () => {
    listModels.mockResolvedValue([
      {
        id: "petoi-model",
        name: "petoi-chat",
        provider: "custom",
        model: "petoi-chat",
        baseUrl: "https://api.petoi.cn/v1",
        createdAt: 1,
      },
    ]);
    const activeCatalog = {
      revision: catalogRevision,
      targetProfileId: "acceptance",
      routes: [
        {
          id: "acceptance\0petoi-model",
          provider: "custom:petoi",
          model: "petoi-chat",
          baseUrl: "https://api.petoi.cn/v1",
          apiMode: "chat_completions",
          providerLabel: "Petoi",
          displayName: "petoi-chat",
          sourceProfileId: "acceptance",
          sourceKind: "account",
          selection: {
            sourceProfileId: "acceptance",
            modelLibraryId: "petoi-model",
            catalogRevision,
          },
        },
      ],
    };
    const mutateModelConfiguration = vi.fn().mockResolvedValue({
      status: "rejected",
      stage: "validation",
      code: "model_save_validation_failed",
      rollback: "not_needed",
    });
    Object.assign(window.hermesAPI, {
      getOwnerModelRouteCatalog: vi.fn().mockResolvedValue(activeCatalog),
      mutateModelConfiguration,
    });
    const { container } = render(
      <ModelCenter
        profile="acceptance"
        env={{ PETOI_API_KEY: "configured" }}
        activeModel={{
          provider: "custom",
          model: "petoi-chat",
          baseUrl: "https://api.petoi.cn/v1",
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
    fireEvent.click(
      within(petoiCard).getByRole("button", {
        name: "providers.center.deleteService",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "providers.center.confirmDelete",
      }),
    );

    await waitFor(() =>
      expect(mutateModelConfiguration).toHaveBeenCalledOnce(),
    );
    expect(mutateModelConfiguration).toHaveBeenCalledWith(
      expect.objectContaining({ intent: "delete", replacement: null }),
    );
    expect(
      screen.getByText("providers.center.errors.replacementRequired"),
    ).toBeVisible();
    expect(removeCustomProvider).not.toHaveBeenCalled();
    expect(setModelConfig).not.toHaveBeenCalled();
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

  function renderAt(profile: string): ReturnType<typeof render> {
    return render(
      <ModelCenter
        profile={profile}
        env={{}}
        activeModel={{ provider: "auto", model: "", baseUrl: "" }}
        onSaveKey={vi.fn().mockResolvedValue(undefined)}
        onActivated={vi.fn()}
        onOpenModelPicker={vi.fn()}
        onBrowseRegistry={vi.fn()}
      />,
    );
  }

  const rejection = (
    reason?: string,
  ): {
    status: string;
    stage: string;
    code: string;
    rollback: string;
    reason?: string;
  } => ({
    status: "rejected",
    stage: "validation",
    code: "model_save_validation_failed",
    rollback: "not_needed",
    ...(reason ? { reason } : {}),
  });

  // @lat: [[legacy-model-config-migration#Stale catalog retry policy#Refreshes and retries once]]
  it("refreshes the catalog and retries a stale revision exactly once", async () => {
    const freshCatalog = {
      revision: "c".repeat(64),
      targetProfileId: "acceptance",
      routes: [],
    };
    const getOwnerModelRouteCatalog = vi
      .fn()
      .mockResolvedValueOnce(emptyCatalog)
      .mockResolvedValue(freshCatalog);
    const mutateModelConfiguration = vi
      .fn()
      .mockResolvedValueOnce(rejection("stale_catalog_revision"))
      .mockResolvedValue({ status: "committed", catalog: freshCatalog });
    Object.assign(window.hermesAPI, {
      getOwnerModelRouteCatalog,
      mutateModelConfiguration,
    });

    renderAt("acceptance");
    await completePetoiForm();

    await waitFor(() =>
      expect(mutateModelConfiguration).toHaveBeenCalledTimes(2),
    );
    // The replay carries the refreshed revision, never the rejected one.
    expect(mutateModelConfiguration.mock.calls[0][0]).toMatchObject({
      expectedCatalogRevision: catalogRevision,
    });
    expect(mutateModelConfiguration.mock.calls[1][0]).toMatchObject({
      expectedCatalogRevision: "c".repeat(64),
    });
    // Exactly once: a second stale rejection would not be replayed again.
    expect(mutateModelConfiguration).toHaveBeenCalledTimes(2);
  });

  // @lat: [[legacy-model-config-migration#Stale catalog retry policy#Never retries an unrelated validation rejection]]
  it("does not retry a validation rejection that is not a stale revision", async () => {
    const cases = [
      undefined,
      "invalid_request",
      "no_replacement_model",
      "profile_owner_mismatch",
    ];
    for (const reason of cases) {
      vi.clearAllMocks();
      const mutateModelConfiguration = vi
        .fn()
        .mockResolvedValue(rejection(reason));
      // The refresh deliberately returns a *different* revision, so a replay
      // is mechanically possible here. The declared reason is then the only
      // thing that may hold it back.
      Object.assign(window.hermesAPI, {
        getOwnerModelRouteCatalog: vi
          .fn()
          .mockResolvedValueOnce(emptyCatalog)
          .mockResolvedValue({
            revision: "9".repeat(64),
            targetProfileId: "acceptance",
            routes: [],
          }),
        mutateModelConfiguration,
      });

      const view = renderAt("acceptance");
      await completePetoiForm();

      await waitFor(() =>
        expect(mutateModelConfiguration).toHaveBeenCalledTimes(1),
      );
      // No replay for any cause other than an actual revision mismatch.
      expect(mutateModelConfiguration).toHaveBeenCalledTimes(1);
      view.unmount();
    }
  });

  // @lat: [[legacy-model-config-migration#Profile target cache#Drops a previous profile's catalog on switch]]
  it("never saves against a previous profile's catalog after a switch", async () => {
    const acceptanceCatalog = emptyCatalog;
    const installedCatalog = {
      revision: "d".repeat(64),
      targetProfileId: "installed",
      routes: [],
    };
    // The switched-to profile's first catalog read fails, which is the exact
    // window the bug lived in: the reload swallows the error, so nothing
    // overwrites the cache. A profile-blind cache would hand the save the
    // previous profile's revision and write target.
    let installedAttempts = 0;
    const getOwnerModelRouteCatalog = vi
      .fn()
      .mockImplementation(async (profile: string) => {
        if (profile !== "installed") return acceptanceCatalog;
        installedAttempts += 1;
        if (installedAttempts === 1) throw new Error("catalog unavailable");
        return installedCatalog;
      });
    const mutateModelConfiguration = vi
      .fn()
      .mockResolvedValue({ status: "committed", catalog: installedCatalog });
    Object.assign(window.hermesAPI, {
      getOwnerModelRouteCatalog,
      mutateModelConfiguration,
    });

    const view = renderAt("acceptance");
    await waitFor(() =>
      expect(getOwnerModelRouteCatalog).toHaveBeenCalledWith("acceptance"),
    );

    view.rerender(
      <ModelCenter
        profile="installed"
        env={{}}
        activeModel={{ provider: "auto", model: "", baseUrl: "" }}
        onSaveKey={vi.fn().mockResolvedValue(undefined)}
        onActivated={vi.fn()}
        onOpenModelPicker={vi.fn()}
        onBrowseRegistry={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(getOwnerModelRouteCatalog).toHaveBeenCalledWith("installed"),
    );

    await completePetoiForm();
    await waitFor(() => expect(mutateModelConfiguration).toHaveBeenCalled());
    // The switched-to profile's revision and target — never the stale pair.
    expect(mutateModelConfiguration).toHaveBeenCalledWith(
      expect.objectContaining({
        requestedProfileId: "installed",
        expectedCatalogRevision: "d".repeat(64),
      }),
    );
    expect(mutateModelConfiguration).not.toHaveBeenCalledWith(
      expect.objectContaining({ expectedCatalogRevision: catalogRevision }),
    );
    view.unmount();
  });

  // @lat: [[legacy-model-config-migration#Profile target cache#Ignores a late response from a previous profile]]
  it("ignores a slow catalog response that arrives after a profile switch", async () => {
    const gate = { release: () => {} };
    const acceptanceLate = new Promise<void>((resolve) => {
      gate.release = resolve;
    });
    const staleCatalog = {
      revision: "e".repeat(64),
      targetProfileId: "acceptance",
      routes: [],
    };
    const installedCatalog = {
      revision: "f".repeat(64),
      targetProfileId: "installed",
      routes: [],
    };
    const getOwnerModelRouteCatalog = vi
      .fn()
      .mockImplementation(async (profile: string) => {
        if (profile === "acceptance") {
          await acceptanceLate;
          return staleCatalog;
        }
        return installedCatalog;
      });
    const mutateModelConfiguration = vi
      .fn()
      .mockResolvedValue({ status: "committed", catalog: installedCatalog });
    Object.assign(window.hermesAPI, {
      getOwnerModelRouteCatalog,
      mutateModelConfiguration,
    });

    const view = renderAt("acceptance");
    view.rerender(
      <ModelCenter
        profile="installed"
        env={{}}
        activeModel={{ provider: "auto", model: "", baseUrl: "" }}
        onSaveKey={vi.fn().mockResolvedValue(undefined)}
        onActivated={vi.fn()}
        onOpenModelPicker={vi.fn()}
        onBrowseRegistry={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(getOwnerModelRouteCatalog).toHaveBeenCalledWith("installed"),
    );
    // The first profile's fetch lands only now, after the switch.
    gate.release();
    await acceptanceLate;

    await completePetoiForm();
    await waitFor(() => expect(mutateModelConfiguration).toHaveBeenCalled());
    expect(mutateModelConfiguration).toHaveBeenCalledWith(
      expect.objectContaining({
        requestedProfileId: "installed",
        expectedCatalogRevision: "f".repeat(64),
      }),
    );
    // The late acceptance snapshot must never become the write target.
    expect(mutateModelConfiguration).not.toHaveBeenCalledWith(
      expect.objectContaining({ expectedCatalogRevision: "e".repeat(64) }),
    );
    // Nor may it poison the profile-scoped reads that run off the write-target
    // ref: discovery ran after the late snapshot landed.
    expect(discoverProviderModels).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      "installed",
    );
    expect(discoverProviderModels).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      "acceptance",
    );
    view.unmount();
  });
});
