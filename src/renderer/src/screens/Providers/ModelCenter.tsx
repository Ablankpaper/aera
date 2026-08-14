import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  CheckCircle2,
  Eye,
  EyeOff,
  Layers3,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  ServerCog,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import {
  customProviderRuntimeRoute,
  namedCustomProviderRuntimeName,
  type CustomProviderRecord,
} from "../../../../shared/custom-providers";
import {
  customProviderEnvKey,
  isLocalBaseUrl,
} from "../../../../shared/url-key-map";
import { isSafeToRetryStaleRevision } from "../../../../shared/model-configuration";
import type {
  ModelConfigurationMutationRequest,
  ModelConfigurationMutationResult,
  OwnerModelRouteCatalogSnapshot,
  OwnerModelRouteSummary,
  UpsertModelServiceRequest,
} from "../../../../shared/model-configuration";
import BrandLogo from "../../components/common/BrandLogo";
import { useI18n } from "../../components/useI18n";
import {
  findModelProviderPreset,
  findPresetForConfig,
  MODEL_PROVIDER_PRESETS,
  type ModelApiMode,
  type ModelProviderPreset,
} from "./modelProviderPresets";

interface LibraryModel {
  id: string;
  name: string;
  provider: string;
  model: string;
  baseUrl: string;
  apiMode?: string | null;
  providerLabel?: string;
  providerId?: string;
  contextLength?: number;
  createdAt: number;
}

interface ActiveModel {
  provider: string;
  model: string;
  baseUrl: string;
}

interface ModelService {
  key: string;
  kind: ProviderMode;
  label: string;
  brand: string;
  provider: string;
  baseUrl: string;
  envKey: string;
  keyOptional: boolean;
  apiMode?: ModelApiMode;
  providerLabel?: string;
  models: LibraryModel[];
  isActive: boolean;
  preset?: ModelProviderPreset;
  customProvider?: CustomProviderRecord;
}

interface ServiceFeedback {
  tone: "success" | "error" | "neutral";
  message: string;
}

interface ModelCenterProps {
  profile?: string;
  env: Record<string, string>;
  activeModel: ActiveModel;
  onSaveKey: (key: string, value: string) => Promise<void>;
  onActivated: (model: ActiveModel) => void;
  onEnvironmentChanged?: () => void | Promise<void>;
  onOpenModelPicker: () => void | Promise<void>;
  onBrowseRegistry: () => void;
}

type ProviderMode = "preset" | "custom";
type ConnectionState = "idle" | "loading" | "connected" | "manual" | "failed";
type ServiceAction = "activate" | "refresh" | "delete";

const MODEL_TAG_PREVIEW_LIMIT = 6;

interface ProviderForm {
  mode: ProviderMode;
  presetId: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  contextLength: string;
  apiMode: ModelApiMode;
}

const EMPTY_FORM: ProviderForm = {
  mode: "preset",
  presetId: "",
  name: "",
  baseUrl: "",
  apiKey: "",
  model: "",
  contextLength: "",
  apiMode: "chat_completions",
};

const API_MODE_OPTIONS: ReadonlyArray<{
  value: ModelApiMode;
  label: string;
}> = [
  {
    value: "chat_completions",
    label: "chat_completions (/chat/completions)",
  },
  { value: "codex_responses", label: "codex_responses (/responses)" },
  {
    value: "anthropic_messages",
    label: "anthropic_messages (/messages)",
  },
  { value: "bedrock_converse", label: "bedrock_converse (Converse API)" },
  { value: "codex_app_server", label: "codex_app_server (App Server)" },
];

const normalizeUrl = (value: string): string =>
  value.trim().replace(/\/+$/, "").toLowerCase();

const uniqueModelIds = (models: LibraryModel[]): string[] =>
  Array.from(new Set(models.map((model) => model.model).filter(Boolean)));

function autoProviderName(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    if (
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "0.0.0.0"
    ) {
      return `Local ${url.port || "Model"}`;
    }
    return url.hostname.replace(/^api\./, "");
  } catch {
    return "";
  }
}

function modelBelongsToPreset(
  model: LibraryModel,
  preset: ModelProviderPreset,
): boolean {
  const modelBaseUrl = normalizeUrl(model.baseUrl);
  const presetBaseUrl = normalizeUrl(preset.baseUrl);
  if (modelBaseUrl && presetBaseUrl && modelBaseUrl === presetBaseUrl) {
    return !model.providerLabel;
  }
  // Multiple OpenAI-compatible presets deliberately share the generic
  // `custom` provider id. Their endpoint is the identity; falling back to the
  // provider id would attach every custom endpoint's models to every preset.
  if (preset.provider === "custom") return false;
  return model.provider === preset.provider || model.provider === preset.id;
}

function modelBelongsToCustomProvider(
  model: LibraryModel,
  provider: CustomProviderRecord,
): boolean {
  if (model.provider !== "custom") return false;
  if (model.providerId) return model.providerId === provider.id;
  if (model.providerLabel === provider.name) return true;
  return (
    !model.providerLabel &&
    normalizeUrl(model.baseUrl) === normalizeUrl(provider.baseUrl)
  );
}

function ModelServiceCard({
  service,
  activeModel,
  busyAction,
  disabled,
  feedback,
  onActivate,
  onRefresh,
  onEdit,
  onDelete,
}: {
  service: ModelService;
  activeModel: ActiveModel;
  busyAction: ServiceAction | null;
  disabled: boolean;
  feedback?: ServiceFeedback;
  onActivate: (model: string) => Promise<void>;
  onRefresh: () => Promise<void>;
  onEdit: () => void;
  onDelete: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const savedModelIds = uniqueModelIds(service.models);
  const modelIds =
    service.isActive &&
    activeModel.model &&
    !savedModelIds.includes(activeModel.model)
      ? [activeModel.model, ...savedModelIds]
      : savedModelIds;
  const selectedModel = service.isActive ? activeModel.model : "";
  const orderedModelIds = selectedModel
    ? [selectedModel, ...modelIds.filter((model) => model !== selectedModel)]
    : modelIds;
  const firstModel = orderedModelIds[0] || "";
  const providerIdentity =
    service.kind === "custom" && service.providerLabel
      ? customProviderRuntimeRoute(service.providerLabel)
      : service.provider;

  return (
    <article
      className={`model-service-card ${service.isActive ? "active" : ""}`}
      data-service-key={service.key}
    >
      <div className="model-service-card-header">
        <div className="model-service-heading">
          <span className="model-center-provider-logo" aria-hidden>
            {service.kind === "preset" ? (
              <BrandLogo provider={service.brand} size={22} matchTheme />
            ) : (
              <ServerCog size={20} />
            )}
          </span>
          <h4>{service.label}</h4>
        </div>
        <div className="model-service-badges">
          {service.isActive && (
            <span className="model-service-badge current">
              {t("providers.center.currentDefault")}
            </span>
          )}
          <span
            className={`model-service-badge ${
              service.kind === "custom" ? "custom" : "preset"
            }`}
          >
            {service.kind === "custom"
              ? t("providers.center.customType")
              : t("providers.center.presetType")}
          </span>
        </div>
      </div>

      <div className="model-service-details">
        <div className="model-service-info-row">
          <span>{t("providers.center.providerLabel")}</span>
          <code title={providerIdentity}>{providerIdentity}</code>
        </div>
        <div className="model-service-info-row">
          <span>{t("providers.center.baseUrl")}</span>
          <code title={service.baseUrl}>{service.baseUrl}</code>
        </div>
        <div className="model-service-info-row">
          <span>{t("providers.center.modelList")}</span>
          <span>
            {t("providers.center.modelsCount", { count: modelIds.length })}
          </span>
        </div>
      </div>

      <label className="model-service-default-row">
        <span>{t("providers.center.defaultModel")}</span>
        <select
          className="input settings-select"
          aria-label={`${service.label} ${t("providers.center.defaultModel")}`}
          value={selectedModel}
          onChange={(event) => void onActivate(event.target.value)}
          disabled={modelIds.length === 0 || busyAction !== null || disabled}
        >
          <option value="">
            {modelIds.length === 0
              ? t("providers.center.noModels")
              : t("providers.center.chooseDefault")}
          </option>
          {modelIds.map((model) => (
            <option key={model} value={model}>
              {model}
            </option>
          ))}
        </select>
      </label>

      <div
        className="model-service-models"
        aria-label={`${service.label} ${t("providers.center.modelList")}`}
      >
        {modelIds.length === 0 ? (
          <span className="model-service-models-empty">
            {t("providers.center.noModelsHint")}
          </span>
        ) : (
          orderedModelIds.slice(0, MODEL_TAG_PREVIEW_LIMIT).map((model) => (
            <span
              key={model}
              className={`model-service-model-tag ${
                service.isActive && activeModel.model === model ? "default" : ""
              }`}
              title={model}
            >
              <span>{model}</span>
              {service.isActive && activeModel.model === model && (
                <small>{t("providers.center.defaultShort")}</small>
              )}
            </span>
          ))
        )}
        {orderedModelIds.length > MODEL_TAG_PREVIEW_LIMIT && (
          <span className="model-service-model-tag more">
            +{orderedModelIds.length - MODEL_TAG_PREVIEW_LIMIT}
          </span>
        )}
      </div>

      <div className="model-service-actions">
        <button
          type="button"
          className="model-service-action"
          onClick={() => void onActivate(firstModel)}
          disabled={
            service.isActive || !firstModel || busyAction !== null || disabled
          }
        >
          {busyAction === "activate" ? (
            <Loader2 size={13} className="spin" aria-hidden />
          ) : (
            <CheckCircle2 size={13} aria-hidden />
          )}
          {service.isActive
            ? t("providers.center.currentDefault")
            : t("providers.center.setDefault")}
        </button>
        <button
          type="button"
          className="model-service-action"
          onClick={() => void onRefresh()}
          disabled={busyAction !== null || disabled}
        >
          {busyAction === "refresh" ? (
            <Loader2 size={13} className="spin" aria-hidden />
          ) : (
            <RefreshCw size={13} aria-hidden />
          )}
          {busyAction === "refresh"
            ? t("providers.center.refreshing")
            : t("providers.center.refreshModels")}
        </button>
        <button
          type="button"
          className="model-service-action"
          onClick={onEdit}
          disabled={busyAction !== null || disabled}
        >
          <Pencil size={13} aria-hidden />
          {t("common.edit")}
        </button>
        <button
          type="button"
          className="model-service-action danger"
          onClick={onDelete}
          disabled={busyAction !== null || disabled}
        >
          {busyAction === "delete" ? (
            <Loader2 size={13} className="spin" aria-hidden />
          ) : (
            <Trash2 size={13} aria-hidden />
          )}
          {t("providers.center.deleteService")}
        </button>
      </div>

      {feedback && (
        <p
          className={`model-service-feedback ${feedback.tone}`}
          role={feedback.tone === "error" ? "alert" : "status"}
        >
          {feedback.message}
        </p>
      )}
    </article>
  );
}

export default function ModelCenter({
  profile,
  env,
  activeModel,
  onSaveKey,
  onActivated,
  onEnvironmentChanged,
  onOpenModelPicker,
  onBrowseRegistry,
}: ModelCenterProps): React.JSX.Element {
  const { t } = useI18n();
  // The active chat `profile` (a named/installed agent profile) is not
  // necessarily where the coordinated catalog writes model configuration.
  // `canonicalTargetProfileId` resolves an installed profile down to the
  // account-default profile when one exists, so `ownerCatalog.targetProfileId`
  // is the authoritative write target. Keep it in a ref so every read and
  // fallback write in the model center routes to the same profile the
  // transaction writes to, instead of mixing the raw `profile` prop with the
  // normalized write target.
  const targetProfileRef = useRef<string | undefined>(profile);
  // Bumped whenever the `profile` prop changes. Every catalog fetch captures
  // the value at call time and refuses to commit its result if the profile
  // moved on while it was in flight, so a slow response for the old profile
  // can never overwrite the new profile's catalog.
  const catalogGenerationRef = useRef(0);
  const lastProfileRef = useRef<string | undefined>(profile);
  if (lastProfileRef.current !== profile) {
    lastProfileRef.current = profile;
    catalogGenerationRef.current += 1;
    // Reset synchronously during render rather than in an effect: an effect
    // would leave one render where writes still route to the old profile.
    targetProfileRef.current = profile;
  }
  const [models, setModels] = useState<LibraryModel[]>([]);
  const [customProviders, setCustomProviders] = useState<
    CustomProviderRecord[]
  >([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState<ProviderForm>(EMPTY_FORM);
  const [nameEdited, setNameEdited] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const [connectionState, setConnectionState] =
    useState<ConnectionState>("idle");
  const [formError, setFormError] = useState("");
  const [formWarning, setFormWarning] = useState("");
  const [saving, setSaving] = useState(false);
  const [editingService, setEditingService] = useState<string | null>(null);
  const [busyService, setBusyService] = useState<{
    key: string;
    action: ServiceAction;
  } | null>(null);
  const [serviceToDelete, setServiceToDelete] = useState<ModelService | null>(
    null,
  );
  const [deleteError, setDeleteError] = useState("");
  const [serviceFeedback, setServiceFeedback] = useState<
    Record<string, ServiceFeedback>
  >({});
  // The cache records which `profile` prop asked for it. `ownerCatalog` below
  // is derived, so a profile switch drops the previous catalog in the very same
  // render — no window where a save could reuse the old profile's revision or
  // write target.
  const [catalogCache, setCatalogCache] = useState<{
    requestedProfile: string | undefined;
    snapshot: OwnerModelRouteCatalogSnapshot;
  } | null>(null);
  const ownerCatalog =
    catalogCache && catalogCache.requestedProfile === profile
      ? catalogCache.snapshot
      : null;

  /**
   * Store a freshly fetched catalog, unless the profile changed while the
   * request was in flight. Also advances the write-target ref, keeping the
   * cached snapshot and the target profile in lockstep.
   */
  const commitCatalog = useCallback(
    (
      requestedProfile: string | undefined,
      snapshot: OwnerModelRouteCatalogSnapshot,
      generation: number,
    ): boolean => {
      if (generation !== catalogGenerationRef.current) return false;
      targetProfileRef.current = snapshot.targetProfileId;
      setCatalogCache({ requestedProfile, snapshot });
      return true;
    },
    [],
  );

  /**
   * Adopt the catalog a committed mutation returned. `profile` here is the value
   * captured when the handler's render ran; if it no longer matches the newest
   * profile, the user switched mid-save and this catalog belongs to the profile
   * they left.
   */
  const commitCatalogFromMutation = useCallback(
    (snapshot: OwnerModelRouteCatalogSnapshot): void => {
      if (lastProfileRef.current !== profile) return;
      commitCatalog(profile, snapshot, catalogGenerationRef.current);
    },
    [commitCatalog, profile],
  );

  const hasCoordinatedModelConfiguration =
    typeof window.hermesAPI.getOwnerModelRouteCatalog === "function" &&
    typeof window.hermesAPI.mutateModelConfiguration === "function";

  const reload = useCallback(
    async (showLoading = true): Promise<void> => {
      if (showLoading) setLoading(true);
      try {
        // Fetch the catalog first: it establishes the authoritative write
        // target profile. Model/library reads below then read from that same
        // target so the UI never mixes the active chat profile with the
        // account profile the transaction actually mutates.
        const generation = catalogGenerationRef.current;
        const requestedProfile = profile;
        let catalogProfile = targetProfileRef.current;
        const nextCatalog = hasCoordinatedModelConfiguration
          ? ((await window.hermesAPI
              .getOwnerModelRouteCatalog(requestedProfile)
              .catch(() => null)) ?? null)
          : null;
        // A catalog that arrived after a profile switch is discarded, and the
        // reads below must not adopt its target profile either.
        const accepted =
          nextCatalog !== null &&
          commitCatalog(requestedProfile, nextCatalog, generation);
        if (accepted && nextCatalog) {
          catalogProfile = nextCatalog.targetProfileId;
        }
        const [nextModels, nextProviders] = await Promise.all([
          window.hermesAPI.listModels() as Promise<LibraryModel[]>,
          window.hermesAPI.listCustomProviders(catalogProfile).catch(() => []),
        ]);
        if (generation !== catalogGenerationRef.current) return;
        setModels(nextModels);
        setCustomProviders(nextProviders);
      } finally {
        if (showLoading) setLoading(false);
      }
    },
    [commitCatalog, hasCoordinatedModelConfiguration, profile],
  );

  useEffect(() => {
    void reload();
    const offModels = window.hermesAPI.onModelLibraryChanged(
      () => void reload(false),
    );
    const offProviders = window.hermesAPI.onCustomProvidersChanged(
      () => void reload(false),
    );
    return () => {
      offModels();
      offProviders();
    };
  }, [reload]);

  const activePreset = useMemo(
    () => findPresetForConfig(activeModel.provider, activeModel.baseUrl),
    [activeModel.provider, activeModel.baseUrl],
  );

  const activeCustomProvider = useMemo(() => {
    const namedRoute = namedCustomProviderRuntimeName(activeModel.provider);
    return customProviders.find((provider) => {
      if (namedRoute !== null) {
        return (
          customProviderRuntimeRoute(provider.name) === `custom:${namedRoute}`
        );
      }
      if (
        normalizeUrl(provider.baseUrl) !== normalizeUrl(activeModel.baseUrl)
      ) {
        return false;
      }
      return models.some(
        (model) =>
          model.model === activeModel.model &&
          modelBelongsToCustomProvider(model, provider),
      );
    });
  }, [
    customProviders,
    models,
    activeModel.provider,
    activeModel.baseUrl,
    activeModel.model,
  ]);

  const configuredPresets = useMemo(
    () =>
      MODEL_PROVIDER_PRESETS.filter((preset) => {
        if (preset.envKey && env[preset.envKey]?.trim()) return true;
        if (!activeCustomProvider && activePreset?.id === preset.id)
          return true;
        return false;
      }),
    [env, activePreset, activeCustomProvider],
  );

  // A named provider is a first-class identity even when it intentionally
  // uses the same endpoint as a curated preset. Keep it as a custom card so
  // refresh/edit/delete continue using its CUSTOM_PROVIDER_* credential.
  const userCustomProviders = customProviders;

  const activeLabel =
    activeCustomProvider?.name ||
    activePreset?.label ||
    activeModel.provider ||
    t("providers.center.notConfigured");

  const services = useMemo<ModelService[]>(
    () => [
      ...configuredPresets.map((preset): ModelService => {
        const providerModels = models.filter((model) =>
          modelBelongsToPreset(model, preset),
        );
        return {
          key: `preset:${preset.id}`,
          kind: "preset",
          label: preset.label,
          brand: preset.id,
          provider: preset.provider,
          baseUrl: preset.baseUrl,
          envKey: preset.envKey,
          keyOptional: Boolean(preset.keyOptional),
          apiMode: preset.apiMode,
          models: providerModels,
          isActive: !activeCustomProvider && activePreset?.id === preset.id,
          preset,
        };
      }),
      ...userCustomProviders.map((provider): ModelService => {
        const providerModels = models.filter((model) =>
          modelBelongsToCustomProvider(model, provider),
        );
        const apiMode = providerModels.find((model) => model.apiMode)?.apiMode;
        return {
          key: `custom:${provider.id}`,
          kind: "custom",
          label: provider.name,
          brand: "custom",
          provider: "custom",
          baseUrl: provider.baseUrl,
          envKey: customProviderEnvKey(provider.name),
          keyOptional: isLocalBaseUrl(provider.baseUrl),
          apiMode: apiMode ? (apiMode as ModelApiMode) : undefined,
          providerLabel: provider.name,
          models: providerModels,
          isActive: activeCustomProvider?.id === provider.id,
          customProvider: provider,
        };
      }),
    ],
    [
      configuredPresets,
      models,
      activePreset,
      userCustomProviders,
      activeCustomProvider,
    ],
  );

  const filteredServices = useMemo(() => {
    const query = deferredSearchQuery.trim().toLowerCase();
    if (!query) return services;
    return services.filter((service) =>
      [
        service.label,
        service.provider,
        service.baseUrl,
        ...service.models.flatMap((model) => [model.name, model.model]),
      ]
        .join("\n")
        .toLowerCase()
        .includes(query),
    );
  }, [services, deferredSearchQuery]);

  const resetTransientState = (): void => {
    setConnectionState("idle");
    setFormError("");
    setFormWarning("");
    setShowKey(false);
  };

  const openAddDialog = (): void => {
    setEditingService(null);
    setForm(EMPTY_FORM);
    setModelOptions([]);
    setNameEdited(false);
    resetTransientState();
    setDialogOpen(true);
  };

  const openPresetDialog = (preset: ModelProviderPreset): void => {
    setEditingService(`preset:${preset.id}`);
    const attachedModels = models.filter((model) =>
      modelBelongsToPreset(model, preset),
    );
    const isActive = activePreset?.id === preset.id;
    const selectedModel = isActive
      ? activeModel.model
      : attachedModels[0]?.model || "";
    setForm({
      ...EMPTY_FORM,
      mode: "preset",
      presetId: preset.id,
      baseUrl: preset.baseUrl,
      apiKey: preset.envKey ? env[preset.envKey] || "" : "",
      model: selectedModel,
      apiMode: preset.apiMode || "chat_completions",
    });
    setModelOptions(
      Array.from(new Set(attachedModels.map((model) => model.model))),
    );
    setNameEdited(false);
    resetTransientState();
    setDialogOpen(true);
  };

  const openCustomDialog = (provider: CustomProviderRecord): void => {
    setEditingService(`custom:${provider.id}`);
    const attachedModels = models.filter((model) =>
      modelBelongsToCustomProvider(model, provider),
    );
    const selectedModel =
      normalizeUrl(activeModel.baseUrl) === normalizeUrl(provider.baseUrl)
        ? activeModel.model
        : attachedModels[0]?.model || "";
    const selected = attachedModels.find(
      (model) => model.model === selectedModel,
    );
    setForm({
      ...EMPTY_FORM,
      mode: "custom",
      name: provider.name,
      baseUrl: provider.baseUrl,
      apiKey: env[customProviderEnvKey(provider.name)] || "",
      model: selectedModel,
      contextLength: selected?.contextLength
        ? String(selected.contextLength)
        : "",
      apiMode:
        (selected?.apiMode as ModelApiMode | undefined) || "chat_completions",
    });
    setModelOptions(
      Array.from(new Set(attachedModels.map((model) => model.model))),
    );
    setNameEdited(true);
    resetTransientState();
    setDialogOpen(true);
  };

  const closeDialog = (): void => {
    if (saving || connectionState === "loading") return;
    setForm((previous) => ({ ...previous, apiKey: "" }));
    setShowKey(false);
    setDialogOpen(false);
  };

  const selectMode = (mode: ProviderMode): void => {
    setEditingService(null);
    setForm({ ...EMPTY_FORM, mode });
    setModelOptions([]);
    setNameEdited(false);
    resetTransientState();
  };

  const selectPreset = (presetId: string): void => {
    if (editingService !== `preset:${presetId}`) {
      setEditingService(null);
    }
    const preset = findModelProviderPreset(presetId);
    if (!preset) {
      setForm({ ...EMPTY_FORM, mode: "preset" });
      setModelOptions([]);
      resetTransientState();
      return;
    }
    const attachedModels = models.filter((model) =>
      modelBelongsToPreset(model, preset),
    );
    setForm({
      ...EMPTY_FORM,
      mode: "preset",
      presetId,
      baseUrl: preset.baseUrl,
      apiKey: preset.envKey ? env[preset.envKey] || "" : "",
      model: attachedModels[0]?.model || "",
      apiMode: preset.apiMode || "chat_completions",
    });
    setModelOptions(
      Array.from(new Set(attachedModels.map((model) => model.model))),
    );
    resetTransientState();
  };

  const routeForForm = (): {
    provider: string;
    baseUrl: string;
    preset?: ModelProviderPreset;
  } | null => {
    if (form.mode === "preset") {
      const preset = findModelProviderPreset(form.presetId);
      return preset
        ? { provider: preset.provider, baseUrl: preset.baseUrl, preset }
        : null;
    }
    return form.baseUrl.trim()
      ? { provider: "custom", baseUrl: form.baseUrl.trim() }
      : null;
  };

  const connectAndFetch = async (): Promise<void> => {
    const route = routeForForm();
    if (!route) {
      setFormError(
        form.mode === "preset"
          ? t("providers.center.errors.selectProvider")
          : t("providers.center.errors.baseUrl"),
      );
      return;
    }
    const keyOptional =
      route.preset?.keyOptional || isLocalBaseUrl(route.baseUrl);
    if (!keyOptional && !form.apiKey.trim()) {
      setFormError(t("providers.center.errors.apiKey"));
      return;
    }

    setConnectionState("loading");
    setFormError("");
    try {
      const result = await window.hermesAPI.discoverProviderModels(
        route.provider,
        route.baseUrl || undefined,
        form.apiKey.trim() || undefined,
        targetProfileRef.current ?? profile,
      );
      if (result.status === "ok") {
        const nextOptions = Array.from(
          new Set([...modelOptions, ...result.models]),
        );
        setModelOptions(nextOptions);
        setForm((previous) => ({
          ...previous,
          model: previous.model || nextOptions[0] || "",
        }));
        setConnectionState(result.models.length > 0 ? "connected" : "manual");
        return;
      }
      if (result.status === "unsupported") {
        setConnectionState("manual");
        return;
      }
      setConnectionState("failed");
      setFormError(
        result.status === "no-key"
          ? t("providers.center.errors.apiKey")
          : t("providers.center.errors.connection"),
      );
    } catch {
      setConnectionState("failed");
      setFormError(t("providers.center.errors.connection"));
    }
  };

  const updateServiceFeedback = (
    serviceKey: string,
    feedback?: ServiceFeedback,
  ): void => {
    setServiceFeedback((previous) => {
      if (feedback) return { ...previous, [serviceKey]: feedback };
      const next = { ...previous };
      delete next[serviceKey];
      return next;
    });
  };

  const refreshParentEnvironment = async (): Promise<void> => {
    try {
      await onEnvironmentChanged?.();
    } catch {
      // Main has already committed the coordinated mutation. A failed UI
      // refresh must not relabel that durable write as a save/delete failure;
      // the next screen load will read the authoritative environment again.
    }
  };

  const requireOwnerCatalog = async (options?: {
    refresh?: boolean;
  }): Promise<OwnerModelRouteCatalogSnapshot> => {
    // `ownerCatalog` is null unless the cache was fetched for the current
    // `profile`, so a switched profile always forces a fresh fetch here.
    if (ownerCatalog && !options?.refresh) return ownerCatalog;
    if (!hasCoordinatedModelConfiguration) {
      throw new Error("Coordinated model configuration is unavailable.");
    }
    const generation = catalogGenerationRef.current;
    const requestedProfile = profile;
    const snapshot =
      await window.hermesAPI.getOwnerModelRouteCatalog(requestedProfile);
    if (!commitCatalog(requestedProfile, snapshot, generation)) {
      // The profile changed mid-flight. Returning this snapshot would let the
      // caller write to the profile the user just navigated away from.
      throw new Error("Model configuration profile changed; retry the save.");
    }
    return snapshot;
  };

  /**
   * Run a coordinated mutation, retrying once when the coordinator rejects a
   * stale `expectedCatalogRevision`.
   *
   * The replay is gated on [[src/shared/model-configuration.ts#isSafeToRetryStaleRevision]],
   * which demands the coordinator's explicit `stale_catalog_revision` reason on
   * top of a `validation` stage and `rollback: "not_needed"`. That triple is the
   * only refusal a replay can fix: the catalog moved under the open screen, and
   * nothing was written. Every other validation refusal — illegal parameters, an
   * unowned profile, a delete with no legal replacement — would fail again
   * identically, and any later stage has already written something a replay
   * could double-apply.
   *
   * The refreshed revision is compared before replaying, so an unchanged
   * catalog returns the original rejection instead of a pointless second call.
   */
  const mutateWithRevisionRetry = async (
    build: (
      catalog: OwnerModelRouteCatalogSnapshot,
    ) => ModelConfigurationMutationRequest,
  ): Promise<ModelConfigurationMutationResult> => {
    const catalog = await requireOwnerCatalog();
    const result = await window.hermesAPI.mutateModelConfiguration(
      build(catalog),
    );
    if (!isSafeToRetryStaleRevision(result)) return result;
    const refreshed = await requireOwnerCatalog({ refresh: true });
    if (refreshed.revision === catalog.revision) return result;
    return window.hermesAPI.mutateModelConfiguration(build(refreshed));
  };

  const routeMatchesService = (
    route: OwnerModelRouteSummary,
    service: Pick<
      ModelService,
      "provider" | "providerLabel" | "label" | "baseUrl"
    >,
  ): boolean => {
    if (normalizeUrl(route.baseUrl) !== normalizeUrl(service.baseUrl)) {
      return false;
    }
    const label = service.providerLabel || service.label;
    if (service.provider === "custom") {
      return (
        route.provider === customProviderRuntimeRoute(label) ||
        route.providerLabel.toLowerCase() === label.toLowerCase()
      );
    }
    return route.provider.toLowerCase() === service.provider.toLowerCase();
  };

  const activeModelFromCatalog = (
    catalog: OwnerModelRouteCatalogSnapshot,
    expected: {
      provider: string;
      providerLabel?: string;
      model: string;
      baseUrl: string;
    },
  ): ActiveModel => {
    const route = catalog.routes.find(
      (candidate) =>
        candidate.model === expected.model &&
        normalizeUrl(candidate.baseUrl) === normalizeUrl(expected.baseUrl) &&
        (expected.provider !== "custom" ||
          !expected.providerLabel ||
          candidate.provider ===
            customProviderRuntimeRoute(expected.providerLabel)),
    );
    if (route) {
      return {
        provider: route.provider,
        model: route.model,
        baseUrl: route.baseUrl,
      };
    }
    return {
      provider:
        expected.provider === "custom" && expected.providerLabel
          ? customProviderRuntimeRoute(expected.providerLabel)
          : expected.provider,
      model: expected.model,
      baseUrl: expected.baseUrl,
    };
  };

  const applyCommittedResult = (
    result: Exclude<ModelConfigurationMutationResult, { status: "rejected" }>,
    expected: {
      provider: string;
      providerLabel?: string;
      model: string;
      baseUrl: string;
    },
  ): ActiveModel => {
    commitCatalogFromMutation(result.catalog);
    const persisted = activeModelFromCatalog(result.catalog, expected);
    onActivated(persisted);
    return persisted;
  };

  const coordinatedUpsert = async (input: {
    providerId?: string;
    provider: string;
    providerLabel: string;
    baseUrl: string;
    apiMode: ModelApiMode | null;
    apiKey: string;
    models: UpsertModelServiceRequest["models"];
    activeModel: string;
  }): Promise<ModelConfigurationMutationResult> =>
    mutateWithRevisionRetry((catalog) => ({
      intent: "upsert",
      expectedCatalogRevision: catalog.revision,
      requestedProfileId: catalog.targetProfileId,
      ...input,
    }));

  const persistAndReadActiveModel = async (
    provider: string,
    model: string,
    baseUrl: string,
  ): Promise<ActiveModel> => {
    const targetProfile = targetProfileRef.current ?? profile;
    await window.hermesAPI.setModelConfig(
      provider,
      model,
      baseUrl,
      targetProfile,
    );
    // Main owns provider canonicalisation (`custom` library attachment →
    // `custom:<name>` Hermes route). Read that result back instead of
    // reconstructing a second provider identity in the Renderer.
    const persisted = await window.hermesAPI.getModelConfig(targetProfile);
    return {
      provider: persisted.provider,
      model: persisted.model,
      baseUrl: persisted.baseUrl,
    };
  };

  const activateServiceModel = async (
    service: ModelService,
    modelId: string,
  ): Promise<void> => {
    const model = modelId.trim();
    if (!model) return;
    setBusyService({ key: service.key, action: "activate" });
    updateServiceFeedback(service.key);
    try {
      if (hasCoordinatedModelConfiguration) {
        const result = await coordinatedUpsert({
          provider: service.provider,
          providerLabel: service.providerLabel || service.label,
          baseUrl: service.baseUrl,
          apiMode:
            (service.models.find((candidate) => candidate.model === model)
              ?.apiMode as ModelApiMode | null | undefined) ??
            service.apiMode ??
            null,
          apiKey: service.envKey ? env[service.envKey]?.trim() || "" : "",
          models: service.models.map((candidate) => ({
            model: candidate.model,
            displayName: candidate.name || candidate.model,
            ...(candidate.contextLength
              ? { contextLength: candidate.contextLength }
              : {}),
          })),
          activeModel: model,
        });
        if (result.status === "rejected") {
          updateServiceFeedback(service.key, {
            tone: "error",
            message: t("providers.center.errors.activate"),
          });
          return;
        }
        applyCommittedResult(result, {
          provider: service.provider,
          providerLabel: service.providerLabel || service.label,
          model,
          baseUrl: service.baseUrl,
        });
        await refreshParentEnvironment();
        updateServiceFeedback(service.key, {
          tone:
            result.status === "committed_refresh_warning"
              ? "neutral"
              : "success",
          message:
            result.status === "committed_refresh_warning"
              ? t("providers.center.warnings.refresh")
              : t("providers.center.defaultUpdated"),
        });
        void reload(false);
        return;
      }
      const persisted = await persistAndReadActiveModel(
        service.provider,
        model,
        service.baseUrl,
      );
      onActivated(persisted);
      updateServiceFeedback(service.key, {
        tone: "success",
        message: t("providers.center.defaultUpdated"),
      });
    } catch {
      updateServiceFeedback(service.key, {
        tone: "error",
        message: t("providers.center.errors.activate"),
      });
    } finally {
      setBusyService(null);
    }
  };

  const refreshServiceModels = async (service: ModelService): Promise<void> => {
    const apiKey = service.envKey ? env[service.envKey]?.trim() || "" : "";
    if (!service.keyOptional && !apiKey) {
      updateServiceFeedback(service.key, {
        tone: "error",
        message: t("providers.center.errors.apiKey"),
      });
      return;
    }

    setBusyService({ key: service.key, action: "refresh" });
    updateServiceFeedback(service.key);
    try {
      const result = await window.hermesAPI.discoverProviderModels(
        service.provider,
        service.baseUrl || undefined,
        apiKey || undefined,
        targetProfileRef.current ?? profile,
      );
      if (result.status === "ok") {
        for (const modelId of result.models) {
          const modelArgs = [
            modelId.split("/").pop() || modelId,
            service.provider,
            modelId,
            service.baseUrl,
            undefined,
            service.providerLabel,
            service.apiMode,
          ] as const;
          if (service.customProvider?.id) {
            await window.hermesAPI.addModel(
              ...modelArgs,
              service.customProvider.id,
            );
          } else {
            await window.hermesAPI.addModel(...modelArgs);
          }
        }
        await reload(false);
        updateServiceFeedback(service.key, {
          tone: "success",
          message:
            result.models.length > 0
              ? t("providers.center.refreshSuccess", {
                  count: result.models.length,
                })
              : t("providers.center.refreshEmpty"),
        });
        return;
      }
      if (result.status === "unsupported" || result.status === "unknown-host") {
        updateServiceFeedback(service.key, {
          tone: "neutral",
          message: t("providers.center.manualModelHint"),
        });
        return;
      }
      updateServiceFeedback(service.key, {
        tone: "error",
        message:
          result.status === "no-key"
            ? t("providers.center.errors.apiKey")
            : t("providers.center.errors.connection"),
      });
    } catch {
      updateServiceFeedback(service.key, {
        tone: "error",
        message: t("providers.center.errors.connection"),
      });
    } finally {
      setBusyService(null);
    }
  };

  const requestDeleteService = (service: ModelService): void => {
    setDeleteError("");
    setServiceToDelete(service);
  };

  const closeDeleteDialog = (): void => {
    if (busyService?.action === "delete") return;
    setDeleteError("");
    setServiceToDelete(null);
  };

  const deleteConfiguredService = async (): Promise<void> => {
    const service = serviceToDelete;
    if (!service) return;

    setBusyService({ key: service.key, action: "delete" });
    setDeleteError("");
    try {
      if (hasCoordinatedModelConfiguration) {
        // Recomputed per attempt: a refreshed catalog can offer a different
        // replacement route than the stale one did.
        const replacementFor = (
          catalog: OwnerModelRouteCatalogSnapshot,
        ): OwnerModelRouteSummary | null =>
          service.isActive
            ? (catalog.routes.find(
                (candidate) =>
                  candidate.sourceProfileId === catalog.targetProfileId &&
                  !routeMatchesService(candidate, service),
              ) ?? null)
            : null;
        const attempt: { replacement: OwnerModelRouteSummary | null } = {
          replacement: null,
        };
        const result = await mutateWithRevisionRetry((catalog) => {
          attempt.replacement = replacementFor(catalog);
          return {
            intent: "delete",
            expectedCatalogRevision: catalog.revision,
            requestedProfileId: catalog.targetProfileId,
            providerLabel: service.providerLabel || service.label,
            replacement: attempt.replacement?.selection ?? null,
          };
        });
        if (result.status === "rejected") {
          setDeleteError(
            service.isActive && !attempt.replacement
              ? t("providers.center.errors.replacementRequired")
              : t("providers.center.errors.delete"),
          );
          return;
        }
        commitCatalogFromMutation(result.catalog);
        if (service.isActive && attempt.replacement) {
          onActivated({
            provider: attempt.replacement.provider,
            model: attempt.replacement.model,
            baseUrl: attempt.replacement.baseUrl,
          });
        }
        await refreshParentEnvironment();
        if (result.status === "committed_refresh_warning") {
          updateServiceFeedback(service.key, {
            tone: "neutral",
            message: t("providers.center.warnings.refresh"),
          });
        }
        await reload(false);
        setServiceToDelete(null);
        return;
      }
      if (service.isActive) {
        const fallback = services.find(
          (candidate) =>
            candidate.key !== service.key && candidate.models.length > 0,
        );
        const fallbackModel = fallback?.models[0]?.model || "";
        const nextModel: ActiveModel = fallback
          ? {
              provider: fallback.provider,
              model: fallbackModel,
              baseUrl: fallback.baseUrl,
            }
          : { provider: "auto", model: "", baseUrl: "" };
        const persisted = await persistAndReadActiveModel(
          nextModel.provider,
          nextModel.model,
          nextModel.baseUrl,
        );
        onActivated(persisted);
      }

      if (service.customProvider) {
        await window.hermesAPI.removeCustomProvider(
          targetProfileRef.current ?? profile,
          service.customProvider.name,
        );
      }
      if (service.envKey) {
        await onSaveKey(service.envKey, "");
      }

      await reload(false);
      setServiceToDelete(null);
    } catch {
      setDeleteError(t("providers.center.errors.delete"));
    } finally {
      setBusyService(null);
    }
  };

  const saveAndActivate = async (): Promise<void> => {
    const route = routeForForm();
    if (!route) {
      setFormError(
        form.mode === "preset"
          ? t("providers.center.errors.selectProvider")
          : t("providers.center.errors.baseUrl"),
      );
      return;
    }
    const providerName =
      form.mode === "preset" ? route.preset?.label || "" : form.name.trim();
    if (form.mode === "custom" && !providerName) {
      setFormError(t("providers.center.errors.name"));
      return;
    }
    const keyOptional =
      route.preset?.keyOptional || isLocalBaseUrl(route.baseUrl);
    if (!keyOptional && !form.apiKey.trim()) {
      setFormError(t("providers.center.errors.apiKey"));
      return;
    }
    const modelId = form.model.trim();
    if (!modelId) {
      setFormError(t("providers.center.errors.model"));
      return;
    }

    setSaving(true);
    setFormError("");
    setFormWarning("");
    try {
      const providerLabel = form.mode === "custom" ? providerName : undefined;
      const editedProvider =
        form.mode === "custom" && editingService?.startsWith("custom:")
          ? customProviders.find(
              (provider) => `custom:${provider.id}` === editingService,
            )
          : undefined;
      const contextLength = parseInt(form.contextLength.trim(), 10);
      const modelsToSave = Array.from(
        new Set([modelId, ...modelOptions].filter(Boolean)),
      );
      if (hasCoordinatedModelConfiguration) {
        const result = await coordinatedUpsert({
          providerId: editedProvider?.id,
          provider: route.provider,
          providerLabel: providerLabel || providerName,
          baseUrl: route.baseUrl,
          apiMode:
            form.mode === "custom"
              ? form.apiMode
              : (route.preset?.apiMode ?? null),
          apiKey: form.apiKey.trim(),
          models: modelsToSave.map((discoveredModel) => ({
            model: discoveredModel,
            displayName: discoveredModel.split("/").pop() || discoveredModel,
            ...(discoveredModel === modelId &&
            Number.isFinite(contextLength) &&
            contextLength > 0
              ? { contextLength }
              : {}),
          })),
          activeModel: modelId,
        });
        if (result.status === "rejected") {
          setFormError(
            t("providers.center.errors.stage", { stage: result.stage }),
          );
          return;
        }
        applyCommittedResult(result, {
          provider: route.provider,
          providerLabel: providerLabel || providerName,
          model: modelId,
          baseUrl: route.baseUrl,
        });
        await refreshParentEnvironment();
        if (result.status === "committed_refresh_warning") {
          setFormWarning(t("providers.center.warnings.refresh"));
        }
        await reload(false);
        setForm((previous) => ({ ...previous, apiKey: "" }));
        setShowKey(false);
        if (result.status === "committed") setDialogOpen(false);
        return;
      }
      const envKey =
        form.mode === "custom"
          ? customProviderEnvKey(providerName)
          : route.preset?.envKey || "";
      if (envKey) {
        await onSaveKey(envKey, form.apiKey.trim());
      }

      if (form.mode === "custom") {
        await window.hermesAPI.upsertCustomProvider(
          targetProfileRef.current ?? profile,
          {
            id: editedProvider?.id,
            name: providerName,
            baseUrl: route.baseUrl,
          },
        );
      } else if (route.preset?.keyOptional) {
        // Local providers often have no API key. Persist a lightweight identity
        // record so their configured card remains visible after another model
        // becomes active.
        await window.hermesAPI.upsertCustomProvider(
          targetProfileRef.current ?? profile,
          {
            name: providerName,
            baseUrl: route.baseUrl,
          },
        );
      }

      for (const discoveredModel of modelsToSave) {
        const modelArgs = [
          discoveredModel.split("/").pop() || discoveredModel,
          route.provider,
          discoveredModel,
          route.baseUrl,
          discoveredModel === modelId &&
          Number.isFinite(contextLength) &&
          contextLength > 0
            ? contextLength
            : undefined,
          providerLabel,
          form.mode === "custom" ? form.apiMode : route.preset?.apiMode,
        ] as const;
        if (form.mode === "custom" && editedProvider?.id) {
          await window.hermesAPI.addModel(...modelArgs, editedProvider.id);
        } else {
          await window.hermesAPI.addModel(...modelArgs);
        }
      }
      const persisted = await persistAndReadActiveModel(
        route.provider,
        modelId,
        route.baseUrl,
      );
      onActivated(persisted);
      await reload();
      setForm((previous) => ({ ...previous, apiKey: "" }));
      setShowKey(false);
      setDialogOpen(false);
    } catch {
      setFormError(t("providers.center.errors.save"));
    } finally {
      setSaving(false);
    }
  };

  const providerCount = services.length;
  const activeConfigured = Boolean(activeModel.model);

  return (
    <div className="model-center">
      <div className="model-center-toolbar">
        <div>
          <h2 className="model-center-title">
            {t("providers.center.generalTitle")}
          </h2>
          <p className="model-center-subtitle">
            {t("providers.center.generalSubtitle")}
          </p>
        </div>
        <div className="model-center-actions">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={onBrowseRegistry}
          >
            <Sparkles size={14} aria-hidden />
            {t("models.browseRegistry")}
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={openAddDialog}
          >
            <Plus size={15} aria-hidden />
            {t("providers.center.addModel")}
          </button>
        </div>
      </div>

      <section className="model-center-active" aria-label={t("common.model")}>
        <div className="model-center-active-copy">
          <span className="model-center-eyebrow">
            {t("providers.center.defaultModel")}
          </span>
          {ownerCatalog && (
            <small className="model-center-target-profile">
              {t("providers.center.targetProfile", {
                profile: ownerCatalog.targetProfileId,
              })}
            </small>
          )}
          {activeConfigured ? (
            <div className="model-center-active-main">
              <span className="model-center-logo">
                <BrandLogo
                  provider={activePreset?.id || activeModel.provider}
                  modelId={activeModel.model}
                  size={24}
                  matchTheme
                />
              </span>
              <span>
                <strong>{activeModel.model}</strong>
                <small>{activeLabel}</small>
              </span>
            </div>
          ) : (
            <div className="model-center-active-empty">
              {t("providers.center.notConfigured")}
            </div>
          )}
        </div>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => void onOpenModelPicker()}
          disabled={providerCount === 0}
        >
          {activeConfigured
            ? t("providers.center.changeDefault")
            : t("providers.center.selectDefault")}
        </button>
      </section>

      <div className="model-center-list-header">
        <div>
          <h3>{t("providers.center.configuredTitle")}</h3>
          <p>{t("providers.center.configuredSubtitle")}</p>
        </div>
        {!loading && providerCount > 0 && (
          <div className="model-center-list-tools">
            <label className="model-center-search">
              <Search size={14} aria-hidden />
              <input
                type="search"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                aria-label={t("providers.center.searchPlaceholder")}
                placeholder={t("providers.center.searchPlaceholder")}
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery("")}
                  aria-label={t("providers.center.clearSearch")}
                >
                  <X size={13} aria-hidden />
                </button>
              )}
            </label>
            <span>
              {searchQuery
                ? t("providers.center.filteredCount", {
                    count: filteredServices.length,
                    total: providerCount,
                  })
                : t("providers.center.count", { count: providerCount })}
            </span>
          </div>
        )}
      </div>

      {loading ? (
        <div className="model-center-loading">
          <Loader2 size={18} className="spin" aria-hidden />
          {t("common.loading")}
        </div>
      ) : providerCount === 0 ? (
        <div className="model-center-empty">
          <span className="model-center-empty-icon">
            <Layers3 size={28} aria-hidden />
          </span>
          <strong>{t("providers.center.emptyTitle")}</strong>
          <p>{t("providers.center.emptyHint")}</p>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={openAddDialog}
          >
            <Plus size={15} aria-hidden />
            {t("providers.center.addFirst")}
          </button>
        </div>
      ) : filteredServices.length === 0 ? (
        <div className="model-center-search-empty">
          <Search size={22} aria-hidden />
          <strong>{t("providers.center.noSearchResults")}</strong>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => setSearchQuery("")}
          >
            {t("providers.center.clearSearch")}
          </button>
        </div>
      ) : (
        <div
          className="model-center-provider-grid"
          data-search-stale={searchQuery !== deferredSearchQuery || undefined}
        >
          {filteredServices.map((service) => (
            <ModelServiceCard
              key={service.key}
              service={service}
              activeModel={activeModel}
              busyAction={
                busyService?.key === service.key ? busyService.action : null
              }
              disabled={busyService !== null && busyService.key !== service.key}
              feedback={serviceFeedback[service.key]}
              onActivate={(model) => activateServiceModel(service, model)}
              onRefresh={() => refreshServiceModels(service)}
              onDelete={() => requestDeleteService(service)}
              onEdit={() => {
                if (service.preset) {
                  openPresetDialog(service.preset);
                } else if (service.customProvider) {
                  openCustomDialog(service.customProvider);
                }
              }}
            />
          ))}
        </div>
      )}

      {dialogOpen && (
        <div className="models-modal-overlay" onClick={closeDialog}>
          <div
            className="models-modal model-provider-wizard"
            role="dialog"
            aria-modal="true"
            aria-labelledby="model-provider-wizard-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="models-modal-header">
              <div>
                <h2
                  id="model-provider-wizard-title"
                  className="models-modal-title"
                >
                  {editingService
                    ? t("providers.center.editDialogTitle")
                    : t("providers.center.dialogTitle")}
                </h2>
              </div>
              <button
                type="button"
                className="btn-ghost"
                onClick={closeDialog}
                aria-label={t("common.close")}
              >
                <X size={18} />
              </button>
            </div>

            <div className="models-modal-body">
              <div className="model-provider-mode">
                <span className="models-modal-label">
                  {t("providers.center.providerType")}
                </span>
                <div className="model-provider-segmented">
                  <button
                    type="button"
                    className={form.mode === "preset" ? "active" : ""}
                    onClick={() => selectMode("preset")}
                  >
                    {t("providers.center.preset")}
                  </button>
                  <button
                    type="button"
                    className={form.mode === "custom" ? "active" : ""}
                    onClick={() => selectMode("custom")}
                  >
                    {t("providers.center.custom")}
                  </button>
                </div>
              </div>

              {form.mode === "preset" ? (
                <div className="models-modal-field">
                  <label
                    className="models-modal-label"
                    htmlFor="provider-preset"
                  >
                    {t("providers.center.provider")}
                    <span aria-hidden>*</span>
                  </label>
                  <select
                    id="provider-preset"
                    className="input settings-select"
                    value={form.presetId}
                    onChange={(event) => selectPreset(event.target.value)}
                  >
                    <option value="">
                      {t("providers.center.chooseProvider")}
                    </option>
                    {MODEL_PROVIDER_PRESETS.map((preset) => (
                      <option key={preset.id} value={preset.id}>
                        {preset.label}
                      </option>
                    ))}
                  </select>
                </div>
              ) : (
                <div className="models-modal-field">
                  <label className="models-modal-label" htmlFor="provider-name">
                    {t("providers.center.name")}
                  </label>
                  <input
                    id="provider-name"
                    className="input"
                    value={form.name}
                    onChange={(event) => {
                      setNameEdited(true);
                      setForm((previous) => ({
                        ...previous,
                        name: event.target.value,
                      }));
                      setFormError("");
                    }}
                    placeholder={t("providers.center.namePlaceholder")}
                  />
                </div>
              )}

              <div className="models-modal-field">
                <label
                  className="models-modal-label"
                  htmlFor="provider-base-url"
                >
                  {t("providers.center.baseUrl")}
                  <span aria-hidden>*</span>
                </label>
                <input
                  id="provider-base-url"
                  className="input"
                  value={form.baseUrl}
                  disabled={form.mode === "preset"}
                  onChange={(event) => {
                    const baseUrl = event.target.value;
                    setForm((previous) => ({
                      ...previous,
                      baseUrl,
                      name:
                        nameEdited || previous.name
                          ? previous.name
                          : autoProviderName(baseUrl),
                    }));
                    setConnectionState("idle");
                    setFormError("");
                  }}
                  placeholder={t("providers.center.baseUrlPlaceholder")}
                />
                {form.mode === "preset" && form.presetId && (
                  <span className="models-modal-hint">
                    {t("providers.center.autoFilled")}
                  </span>
                )}
              </div>

              <div className="models-modal-field">
                <label
                  className="models-modal-label"
                  htmlFor="provider-api-key"
                >
                  {t("providers.center.apiKey")}
                  {!(
                    findModelProviderPreset(form.presetId)?.keyOptional ||
                    isLocalBaseUrl(form.baseUrl)
                  ) && <span aria-hidden>*</span>}
                </label>
                <div className="model-provider-secret">
                  <input
                    id="provider-api-key"
                    className="input"
                    type={showKey ? "text" : "password"}
                    value={form.apiKey}
                    onChange={(event) => {
                      setForm((previous) => ({
                        ...previous,
                        apiKey: event.target.value,
                      }));
                      setConnectionState("idle");
                      setFormError("");
                    }}
                    placeholder={t("providers.center.apiKeyPlaceholder")}
                    autoComplete="new-password"
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey((visible) => !visible)}
                    aria-label={showKey ? t("common.hide") : t("common.show")}
                  >
                    {showKey ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>

              <div className="models-modal-field">
                <label className="models-modal-label" htmlFor="provider-model">
                  {t("providers.center.defaultModel")}
                  <span aria-hidden>*</span>
                </label>
                <div className="model-provider-model-row">
                  <input
                    id="provider-model"
                    className="input"
                    list="model-provider-discovered-models"
                    value={form.model}
                    onChange={(event) => {
                      setForm((previous) => ({
                        ...previous,
                        model: event.target.value.replace(/\s+/g, ""),
                      }));
                      setFormError("");
                    }}
                    placeholder={t("providers.center.modelPlaceholder")}
                  />
                  <button
                    type="button"
                    className="btn btn-secondary model-provider-fetch"
                    onClick={() => void connectAndFetch()}
                    disabled={connectionState === "loading"}
                  >
                    {connectionState === "loading" ? (
                      <Loader2 size={14} className="spin" aria-hidden />
                    ) : connectionState === "connected" ? (
                      <CheckCircle2 size={14} aria-hidden />
                    ) : null}
                    {connectionState === "loading"
                      ? t("providers.center.connecting")
                      : connectionState === "connected"
                        ? t("providers.center.connected")
                        : t("providers.center.connect")}
                  </button>
                </div>
                <datalist id="model-provider-discovered-models">
                  {modelOptions.map((model) => (
                    <option key={model} value={model} />
                  ))}
                </datalist>
                <span className="models-modal-hint">
                  {modelOptions.length > 0
                    ? t("providers.center.modelsFound", {
                        count: modelOptions.length,
                      })
                    : t("providers.center.modelHint")}
                </span>
              </div>

              {connectionState === "manual" && (
                <p className="model-provider-notice">
                  {t("providers.center.manualModelHint")}
                </p>
              )}

              {form.mode === "custom" && (
                <>
                  <div className="models-modal-field">
                    <label
                      className="models-modal-label"
                      htmlFor="provider-context"
                    >
                      {t("providers.center.contextLength")}
                    </label>
                    <input
                      id="provider-context"
                      className="input"
                      type="number"
                      min={0}
                      step={1024}
                      value={form.contextLength}
                      onChange={(event) =>
                        setForm((previous) => ({
                          ...previous,
                          contextLength: event.target.value,
                        }))
                      }
                      placeholder={t(
                        "providers.center.contextLengthPlaceholder",
                      )}
                    />
                  </div>
                  <div className="models-modal-field">
                    <label
                      className="models-modal-label"
                      htmlFor="provider-api-mode"
                    >
                      {t("providers.center.apiMode")}
                    </label>
                    <select
                      id="provider-api-mode"
                      className="input settings-select"
                      value={form.apiMode}
                      onChange={(event) =>
                        setForm((previous) => ({
                          ...previous,
                          apiMode: event.target.value as ModelApiMode,
                        }))
                      }
                    >
                      {API_MODE_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </>
              )}

              {formError && (
                <p className="model-provider-error" role="alert">
                  {formError}
                </p>
              )}
              {formWarning && (
                <p className="model-provider-status" role="status">
                  {formWarning}
                </p>
              )}
            </div>

            <div className="models-modal-footer">
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={closeDialog}
                disabled={saving || connectionState === "loading"}
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void saveAndActivate()}
                disabled={
                  saving || connectionState === "loading" || !form.model.trim()
                }
              >
                {saving && <Loader2 size={15} className="spin" aria-hidden />}
                {editingService
                  ? t("providers.center.saveAndUse")
                  : t("providers.center.addAndUse")}
              </button>
            </div>
          </div>
        </div>
      )}

      {serviceToDelete && (
        <div className="models-modal-overlay" onClick={closeDeleteDialog}>
          <div
            className="models-modal model-service-delete-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="model-service-delete-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="models-modal-header">
              <div className="model-service-delete-heading">
                <span aria-hidden>
                  <Trash2 size={18} />
                </span>
                <div>
                  <h2
                    id="model-service-delete-title"
                    className="models-modal-title"
                  >
                    {t("providers.center.deleteTitle")}
                  </h2>
                  <p>{serviceToDelete.label}</p>
                </div>
              </div>
              <button
                type="button"
                className="btn-ghost"
                onClick={closeDeleteDialog}
                aria-label={t("common.close")}
                disabled={busyService?.action === "delete"}
              >
                <X size={18} />
              </button>
            </div>
            <div className="models-modal-body">
              <p>{t("providers.center.deleteDescription")}</p>
              {serviceToDelete.isActive && (
                <p className="model-service-delete-notice">
                  {services.some(
                    (service) =>
                      service.key !== serviceToDelete.key &&
                      service.models.length > 0,
                  )
                    ? t("providers.center.deleteActiveFallback")
                    : t("providers.center.deleteLastActive")}
                </p>
              )}
              {deleteError && (
                <p className="model-provider-error" role="alert">
                  {deleteError}
                </p>
              )}
            </div>
            <div className="models-modal-footer">
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={closeDeleteDialog}
                disabled={busyService?.action === "delete"}
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => void deleteConfiguredService()}
                disabled={busyService?.action === "delete"}
              >
                {busyService?.action === "delete" && (
                  <Loader2 size={15} className="spin" aria-hidden />
                )}
                {t("providers.center.confirmDelete")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
