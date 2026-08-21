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
      status: "success_with_models",
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

  async function openPetoiFormAndFetch(): Promise<void> {
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
  }

  async function completePetoiForm(): Promise<void> {
    await openPetoiFormAndFetch();
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

  it.each([
    ["authentication_rejected", "providers.center.errors.authentication"],
    ["forbidden", "providers.center.errors.forbidden"],
    ["not_found", "providers.center.errors.notFound"],
    ["rate_limited", "providers.center.errors.rateLimited"],
    ["upstream_error", "providers.center.errors.upstream"],
    ["malformed_response", "providers.center.errors.malformed"],
    ["timeout", "providers.center.errors.timeout"],
    ["connection_error", "providers.center.errors.network"],
  ])("shows the exact %s discovery failure", async (status, message) => {
    discoverProviderModels.mockResolvedValue({
      models: [],
      status,
      cached: false,
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

    await openPetoiFormAndFetch();

    expect(await screen.findByText(message)).toBeVisible();
    expect(
      screen.queryByText("providers.center.manualModelHint"),
    ).not.toBeInTheDocument();
  });

  it("shows a network error when model discovery rejects", async () => {
    discoverProviderModels.mockRejectedValue(new Error("socket closed"));
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

    await openPetoiFormAndFetch();

    expect(
      await screen.findByText("providers.center.errors.network"),
    ).toBeVisible();
  });

  it("keeps a valid empty catalogue separate from discovery failures", async () => {
    discoverProviderModels.mockResolvedValue({
      models: [],
      status: "success_empty",
      cached: false,
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

    await openPetoiFormAndFetch();

    expect(
      await screen.findByText("providers.center.manualModelHint"),
    ).toBeVisible();
    expect(
      screen.queryByText("providers.center.errors.connection"),
    ).not.toBeInTheDocument();
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
        "model-center",
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

  it("refreshes the parent environment after a coordinated save", async () => {
    const mutateModelConfiguration = vi.fn().mockResolvedValue({
      status: "committed",
      catalog: {
        revision: "b".repeat(64),
        targetProfileId: "acceptance",
        routes: [],
      },
    });
    const onEnvironmentChanged = vi.fn().mockResolvedValue(undefined);
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
        onEnvironmentChanged={onEnvironmentChanged}
        onOpenModelPicker={vi.fn()}
        onBrowseRegistry={vi.fn()}
      />,
    );

    await completePetoiForm();

    await waitFor(() => expect(mutateModelConfiguration).toHaveBeenCalled());
    expect(onEnvironmentChanged).toHaveBeenCalledTimes(1);
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
      await screen.findByText("providers.center.errors.provider"),
    ).toBeVisible();
    expect(screen.getByLabelText(/providers\.center\.apiKey/)).toHaveValue(
      "petoi-test-key",
    );
  });

  it.each([
    [
      "native_module_abi_mismatch",
      "providers.center.errors.nativeModuleAbiMismatch",
    ],
    [
      "model_configuration_database_unavailable",
      "providers.center.errors.databaseUnavailable",
    ],
    [
      "model_configuration_schema_unsupported",
      "providers.center.errors.schemaUnsupported",
    ],
    [
      "route_catalog_repair_required",
      "providers.center.errors.routeCatalogRepairRequired",
    ],
    [
      "model_configuration_recovery_required",
      "providers.center.errors.recoveryRequired",
    ],
  ])("shows the real %s save failure", async (code, message) => {
    const mutateModelConfiguration = vi.fn().mockResolvedValue({
      status: "rejected",
      stage:
        code === "model_configuration_recovery_required"
          ? "recovery"
          : "validation",
      code,
      rollback:
        code === "model_configuration_recovery_required"
          ? "recovery_required"
          : "not_needed",
      diagnosticId: "abc123def456",
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

    expect(await screen.findByText(`${message} (abc123def456)`)).toBeVisible();
  });

  it("shows the safe next action for an Owner transition rejection", async () => {
    const mutateModelConfiguration = vi.fn().mockResolvedValue({
      status: "rejected",
      schemaVersion: 2,
      operation: "save_provider",
      stage: "owner",
      code: "model_owner_transition_in_progress",
      retryability: "retryable",
      rollback: "not_needed",
      diagnosticId: "abc123def456",
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
      await screen.findByText(
        "providers.center.errors.ownerTransitionInProgress providers.center.actions.retry (abc123def456)",
      ),
    ).toBeVisible();
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

  it("activates an existing service without replaying a stale catalog upsert", async () => {
    listModels.mockResolvedValue([
      {
        id: "model-1",
        name: "gpt-5.6-sol",
        provider: "custom",
        model: "gpt-5.6-sol",
        baseUrl: "https://www.api-codex.cn/v1",
        providerLabel: "www.api-codex.cn",
        apiMode: "chat_completions",
        createdAt: 1,
      },
    ]);
    listCustomProviders.mockResolvedValue([
      {
        id: "api-codex",
        name: "www.api-codex.cn",
        baseUrl: "https://www.api-codex.cn/v1",
        createdAt: 1,
      },
    ]);
    getModelConfig.mockResolvedValue({
      provider: "custom:www.api-codex.cn",
      model: "gpt-5.6-sol",
      baseUrl: "https://www.api-codex.cn/v1",
    });
    const getOwnerModelRouteCatalog = vi.fn().mockResolvedValue(emptyCatalog);
    const mutateModelConfiguration = vi.fn().mockResolvedValue({
      status: "rejected",
      schemaVersion: 2,
      operation: "save_provider",
      stage: "revision",
      code: "model_save_stale_catalog_revision",
      retryability: "retryable",
      diagnosticId: "7aafdaa8a645",
      rollback: "not_needed",
      reason: "stale_catalog_revision",
    });
    Object.assign(window.hermesAPI, {
      getOwnerModelRouteCatalog,
      mutateModelConfiguration,
    });
    const onActivated = vi.fn();
    const { container } = render(
      <ModelCenter
        profile="acceptance"
        env={{ CUSTOM_PROVIDER_WWW_API_CODEX_CN_KEY: "configured" }}
        activeModel={{
          provider: "custom:petoi.cn",
          model: "gpt-5.6-sol",
          baseUrl: "https://petoi.cn/v1",
        }}
        onSaveKey={vi.fn().mockResolvedValue(undefined)}
        onActivated={onActivated}
        onOpenModelPicker={vi.fn()}
        onBrowseRegistry={vi.fn()}
      />,
    );

    const card = await waitFor(() => {
      const element = container.querySelector(
        '[data-service-key="custom:api-codex"]',
      );
      expect(element).toBeInTheDocument();
      return element as HTMLElement;
    });
    fireEvent.click(
      within(card).getByRole("button", {
        name: "providers.center.setDefault",
      }),
    );

    await waitFor(() =>
      expect(setModelConfig).toHaveBeenCalledWith(
        "custom",
        "gpt-5.6-sol",
        "https://www.api-codex.cn/v1",
        "acceptance",
      ),
    );
    expect(mutateModelConfiguration).not.toHaveBeenCalled();
    expect(onActivated).toHaveBeenCalledWith({
      provider: "custom:www.api-codex.cn",
      model: "gpt-5.6-sol",
      baseUrl: "https://www.api-codex.cn/v1",
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
      status: "success_with_models",
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
        "model-center",
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

  it("shows a network error when refreshing a service rejects", async () => {
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
    discoverProviderModels.mockRejectedValue(new Error("socket closed"));
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

    expect(
      await screen.findByText("providers.center.errors.network"),
    ).toBeVisible();
  });

  it("clears a stale card error when the edit dialog fetch succeeds", async () => {
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
    discoverProviderModels
      .mockRejectedValueOnce(new Error("socket closed"))
      .mockResolvedValueOnce({
        models: ["gpt-5.6-sol", "gpt-5.5"],
        status: "success_with_models",
        cached: false,
      });

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

    const card = await waitFor(() => {
      const element = container.querySelector(
        '[data-service-key="custom:petoi-acceptance"]',
      );
      expect(element).toBeInTheDocument();
      return element as HTMLElement;
    });
    fireEvent.click(
      within(card).getByRole("button", {
        name: "providers.center.refreshModels",
      }),
    );
    expect(
      await within(card).findByText("providers.center.errors.network"),
    ).toBeVisible();

    fireEvent.click(within(card).getByRole("button", { name: "common.edit" }));
    fireEvent.click(
      screen.getByRole("button", { name: "providers.center.connect" }),
    );
    await waitFor(() =>
      expect(discoverProviderModels).toHaveBeenCalledTimes(2),
    );

    expect(
      within(card).queryByText("providers.center.errors.network"),
    ).not.toBeInTheDocument();
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
        "model-center",
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
      "petoi-acceptance",
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

  it("separates saved models from a failed live discovery", async () => {
    listModels.mockResolvedValue([
      {
        id: "model-1",
        name: "saved-model",
        provider: "custom",
        model: "saved-model",
        baseUrl: "https://api.petoi.cn/v1",
        apiMode: "chat_completions",
        createdAt: 1,
      },
    ]);
    discoverProviderModels.mockResolvedValue({
      models: [],
      status: "authentication_rejected",
      cached: false,
    });
    render(
      <ModelCenter
        env={{ PETOI_API_KEY: "configured" }}
        activeModel={{
          provider: "custom",
          model: "saved-model",
          baseUrl: "https://api.petoi.cn/v1",
        }}
        onSaveKey={vi.fn().mockResolvedValue(undefined)}
        onActivated={vi.fn()}
        onOpenModelPicker={vi.fn()}
        onBrowseRegistry={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "common.edit" }));
    fireEvent.click(
      screen.getByRole("button", { name: "providers.center.connect" }),
    );

    expect(
      await screen.findByText("providers.center.errors.authentication"),
    ).toBeVisible();
    expect(
      screen.getByText("providers.center.savedModelsCount:1"),
    ).toBeVisible();
    expect(
      screen.queryByText("providers.center.modelsFound:1"),
    ).not.toBeInTheDocument();
  });

  it("shows live discovery count separately from saved models", async () => {
    listModels.mockResolvedValue([
      {
        id: "model-1",
        name: "saved-model",
        provider: "custom",
        model: "saved-model",
        baseUrl: "https://api.petoi.cn/v1",
        apiMode: "chat_completions",
        createdAt: 1,
      },
    ]);
    discoverProviderModels.mockResolvedValue({
      models: ["live-one", "live-two"],
      status: "success_with_models",
      cached: false,
    });
    render(
      <ModelCenter
        env={{ PETOI_API_KEY: "configured" }}
        activeModel={{
          provider: "custom",
          model: "saved-model",
          baseUrl: "https://api.petoi.cn/v1",
        }}
        onSaveKey={vi.fn().mockResolvedValue(undefined)}
        onActivated={vi.fn()}
        onOpenModelPicker={vi.fn()}
        onBrowseRegistry={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "common.edit" }));
    fireEvent.click(
      screen.getByRole("button", { name: "providers.center.connect" }),
    );

    expect(
      await screen.findByText("providers.center.fetchedModelsCount:2"),
    ).toBeVisible();
    expect(
      screen.getByText("providers.center.savedModelsCount:1"),
    ).toBeVisible();
  });

  it("carries the stable custom-provider id when saving a renamed service", async () => {
    const mutateModelConfiguration = vi.fn().mockResolvedValue({
      status: "committed",
      catalog: emptyCatalog,
    });
    listModels.mockResolvedValue([
      {
        id: "model-1",
        name: "gpt-5.6-sol",
        provider: "custom",
        providerLabel: "petoi.cn",
        providerId: "provider-1",
        model: "gpt-5.6-sol",
        baseUrl: "https://api.petoi.cn/v1",
        apiMode: "chat_completions",
        createdAt: 1,
      },
    ]);
    listCustomProviders.mockResolvedValue([
      {
        id: "provider-1",
        name: "petoi.cn",
        baseUrl: "https://api.petoi.cn/v1",
        createdAt: 1,
      },
    ]);
    Object.assign(window.hermesAPI, {
      getOwnerModelRouteCatalog: vi.fn().mockResolvedValue(emptyCatalog),
      mutateModelConfiguration,
    });

    render(
      <ModelCenter
        profile="acceptance"
        env={{ CUSTOM_PROVIDER_PETOI_CN_KEY: "configured" }}
        activeModel={{
          provider: "custom:petoi.cn",
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
    fireEvent.change(screen.getByLabelText(/providers\.center\.name/), {
      target: { value: "123456" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "providers.center.saveAndUse" }),
    );

    await waitFor(() => expect(mutateModelConfiguration).toHaveBeenCalled());
    expect(mutateModelConfiguration).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "provider-1",
        providerLabel: "123456",
      }),
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

  it("uses the named route when two custom providers share one endpoint and model", async () => {
    listModels.mockResolvedValue([
      {
        id: "shared-model-b",
        name: "shared-model",
        provider: "custom",
        providerLabel: "Provider B",
        providerId: "provider-b",
        model: "shared-model",
        baseUrl: "https://shared.example/v1",
        createdAt: 1,
      },
      {
        id: "shared-model-a",
        name: "shared-model",
        provider: "custom",
        providerLabel: "Provider A",
        providerId: "provider-a",
        model: "shared-model",
        baseUrl: "https://shared.example/v1",
        createdAt: 2,
      },
    ]);
    listCustomProviders.mockResolvedValue([
      {
        id: "provider-b",
        name: "Provider B",
        baseUrl: "https://shared.example/v1",
        createdAt: 1,
      },
      {
        id: "provider-a",
        name: "Provider A",
        baseUrl: "https://shared.example/v1",
        createdAt: 2,
      },
    ]);

    const { container } = render(
      <ModelCenter
        profile="acceptance"
        env={{
          CUSTOM_PROVIDER_PROVIDER_A_KEY: "configured-a",
          CUSTOM_PROVIDER_PROVIDER_B_KEY: "configured-b",
        }}
        activeModel={{
          provider: "custom:provider-a",
          model: "shared-model",
          baseUrl: "https://shared.example/v1",
        }}
        onSaveKey={vi.fn().mockResolvedValue(undefined)}
        onActivated={vi.fn()}
        onOpenModelPicker={vi.fn()}
        onBrowseRegistry={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(
        container.querySelector('[data-service-key="custom:provider-a"]'),
      ).toBeInTheDocument(),
    );
    expect(
      container.querySelector('[data-service-key="custom:provider-a"]'),
    ).toHaveClass("active");
    expect(
      container.querySelector('[data-service-key="custom:provider-b"]'),
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
      "model-center",
    );
    expect(discoverProviderModels).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      "acceptance",
      "model-center",
    );
    view.unmount();
  });
});
