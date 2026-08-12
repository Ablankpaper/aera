import { useEffect, useId, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  FlaskConical,
  RefreshCw,
  Save,
  X,
} from "lucide-react";
import type {
  ImageGenerationConfigDraft,
  ImageGenerationErrorCode,
  ImageGenerationPublicConfig,
} from "../../../../shared/image-generation";
import { useI18n } from "../../components/useI18n";

interface ImageGenerationConfigProps {
  profile?: string;
  remoteMode?: boolean;
  onSaved?: (config: ImageGenerationPublicConfig) => void;
}

const EMPTY_DRAFT: ImageGenerationConfigDraft = {
  enabled: true,
  baseUrl: "https://api.openai.com/v1",
  apiKey: "",
  model: "gpt-image-1",
  quality: "medium",
  aspectRatio: "square",
};

type BusyAction = "load" | "save" | "discover" | "test" | "";

export function ImageGenerationConfig({
  profile,
  remoteMode = false,
  onSaved,
}: ImageGenerationConfigProps): React.JSX.Element {
  const { t } = useI18n();
  const [draft, setDraft] = useState<ImageGenerationConfigDraft>(EMPTY_DRAFT);
  const [hasApiKey, setHasApiKey] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState<BusyAction>(remoteMode ? "" : "load");
  const [message, setMessage] = useState("");
  const [errorCode, setErrorCode] = useState<ImageGenerationErrorCode | "">("");
  const [confirmingTest, setConfirmingTest] = useState(false);
  const [preview, setPreview] = useState("");
  const [expanded, setExpanded] = useState(true);
  const bodyId = useId();

  function showError(code: ImageGenerationErrorCode): void {
    setMessage("");
    setErrorCode(code);
  }

  useEffect(() => {
    if (remoteMode) return;
    let active = true;
    setBusy("load");
    setErrorCode("");
    void window.hermesAPI
      .getImageGenerationConfig(profile)
      .then((result) => {
        if (!active) return;
        if (!result.success) {
          setErrorCode(result.errorCode);
          return;
        }
        const { config } = result;
        setDraft({
          enabled: config.enabled,
          baseUrl: config.baseUrl,
          apiKey: "",
          model: config.model,
          quality: config.quality,
          aspectRatio: config.aspectRatio,
        });
        setModels([config.model]);
        setHasApiKey(config.hasApiKey);
      })
      .catch(() => {
        if (active) setErrorCode("network_unavailable");
      })
      .finally(() => {
        if (active) setBusy("");
      });
    return () => {
      active = false;
    };
  }, [profile, remoteMode]);

  function update<K extends keyof ImageGenerationConfigDraft>(
    key: K,
    value: ImageGenerationConfigDraft[K],
  ): void {
    setDraft((current) => ({ ...current, [key]: value }));
    setErrorCode("");
    setMessage("");
    setConfirmingTest(false);
  }

  async function save(): Promise<void> {
    setBusy("save");
    setErrorCode("");
    setMessage("");
    try {
      const result = await window.hermesAPI.saveImageGenerationConfig(
        draft,
        profile,
      );
      if (!result.success) {
        showError(result.errorCode);
        return;
      }
      setHasApiKey(result.config.hasApiKey);
      setDraft((current) => ({
        ...current,
        apiKey: "",
        baseUrl: result.config.baseUrl,
        model: result.config.model,
      }));
      setMessage(t("tools.imageGeneration.saved"));
      onSaved?.(result.config);
    } catch {
      showError("write_failed");
    } finally {
      setBusy("");
    }
  }

  async function discover(): Promise<void> {
    setBusy("discover");
    setErrorCode("");
    setMessage("");
    try {
      const result = await window.hermesAPI.discoverImageGenerationModels(
        draft,
        profile,
      );
      if (!result.success) {
        showError(result.errorCode);
        return;
      }
      setModels(
        result.models.includes(draft.model)
          ? result.models
          : [draft.model, ...result.models],
      );
      setMessage(
        t("tools.imageGeneration.modelsFound", {
          count: result.models.length,
        }),
      );
    } catch {
      showError("network_unavailable");
    } finally {
      setBusy("");
    }
  }

  async function testGeneration(): Promise<void> {
    setConfirmingTest(false);
    setBusy("test");
    setErrorCode("");
    setMessage("");
    setPreview("");
    try {
      const result = await window.hermesAPI.testImageGeneration(draft, profile);
      if (!result.success) {
        showError(result.errorCode);
        return;
      }
      setPreview(result.imageUrl);
      setMessage(t("tools.imageGeneration.testSucceeded"));
    } catch {
      showError("network_unavailable");
    } finally {
      setBusy("");
    }
  }

  if (remoteMode) {
    return (
      <section className="image-generation-config image-generation-remote">
        <div className="image-generation-heading">
          <h2>{t("tools.imageGeneration.title")}</h2>
        </div>
        <div className="tools-error">
          {t("tools.imageGeneration.remoteUnsupported")}
        </div>
      </section>
    );
  }

  return (
    <section className="image-generation-config" aria-busy={busy === "load"}>
      <div className="image-generation-heading">
        <button
          type="button"
          className="image-generation-disclosure"
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? (
            <ChevronDown size={17} aria-hidden="true" />
          ) : (
            <ChevronRight size={17} aria-hidden="true" />
          )}
          <h2>{t("tools.imageGeneration.title")}</h2>
        </button>
        <label
          className="tools-toggle"
          title={t("tools.imageGeneration.enabled")}
        >
          <input
            type="checkbox"
            aria-label={t("tools.imageGeneration.enabled")}
            checked={draft.enabled}
            disabled={Boolean(busy)}
            onChange={(event) => update("enabled", event.target.checked)}
          />
          <span className="tools-toggle-track" />
        </label>
      </div>

      <div id={bodyId} className="image-generation-body" hidden={!expanded}>
        <p className="image-generation-subtitle">
          {t("tools.imageGeneration.subtitle")}
        </p>
        {busy === "load" ? (
          <div className="image-generation-loading">
            <span className="loading-spinner" />
          </div>
        ) : (
          <>
            <div className="image-generation-form">
              <label
                className="image-generation-field image-generation-field-wide"
                htmlFor="image-generation-base-url"
              >
                <span>{t("tools.imageGeneration.baseUrl")}</span>
                <input
                  id="image-generation-base-url"
                  className="input"
                  type="url"
                  value={draft.baseUrl}
                  disabled={!draft.enabled || Boolean(busy)}
                  onChange={(event) => update("baseUrl", event.target.value)}
                />
              </label>
              <label
                className="image-generation-field image-generation-field-wide"
                htmlFor="image-generation-api-key"
              >
                <span>{t("tools.imageGeneration.apiKey")}</span>
                <input
                  id="image-generation-api-key"
                  className="input"
                  type="password"
                  aria-label={t("tools.imageGeneration.apiKey")}
                  autoComplete="new-password"
                  value={draft.apiKey}
                  placeholder={
                    hasApiKey ? t("tools.imageGeneration.keyPreserved") : ""
                  }
                  disabled={!draft.enabled || Boolean(busy)}
                  onChange={(event) => update("apiKey", event.target.value)}
                />
                {hasApiKey ? (
                  <span className="image-generation-key-status">
                    <Check size={13} />
                    {t("tools.imageGeneration.keyConfigured")}
                  </span>
                ) : null}
              </label>
              <label
                className="image-generation-field image-generation-model-field"
                htmlFor="image-generation-model"
              >
                <span>{t("tools.imageGeneration.model")}</span>
                <input
                  id="image-generation-model"
                  className="input"
                  list="image-generation-models"
                  value={draft.model}
                  disabled={!draft.enabled || Boolean(busy)}
                  onChange={(event) => update("model", event.target.value)}
                />
                <datalist id="image-generation-models">
                  {models.map((model) => (
                    <option key={model} value={model} />
                  ))}
                </datalist>
              </label>
              <label
                className="image-generation-field"
                htmlFor="image-generation-quality"
              >
                <span>{t("tools.imageGeneration.quality")}</span>
                <select
                  id="image-generation-quality"
                  className="input"
                  value={draft.quality}
                  disabled={!draft.enabled || Boolean(busy)}
                  onChange={(event) =>
                    update(
                      "quality",
                      event.target
                        .value as ImageGenerationConfigDraft["quality"],
                    )
                  }
                >
                  <option value="low">
                    {t("tools.imageGeneration.qualityLow")}
                  </option>
                  <option value="medium">
                    {t("tools.imageGeneration.qualityMedium")}
                  </option>
                  <option value="high">
                    {t("tools.imageGeneration.qualityHigh")}
                  </option>
                </select>
              </label>
              <label
                className="image-generation-field"
                htmlFor="image-generation-aspect-ratio"
              >
                <span>{t("tools.imageGeneration.aspectRatio")}</span>
                <select
                  id="image-generation-aspect-ratio"
                  className="input"
                  value={draft.aspectRatio}
                  disabled={!draft.enabled || Boolean(busy)}
                  onChange={(event) =>
                    update(
                      "aspectRatio",
                      event.target
                        .value as ImageGenerationConfigDraft["aspectRatio"],
                    )
                  }
                >
                  <option value="landscape">
                    {t("tools.imageGeneration.landscape")}
                  </option>
                  <option value="square">
                    {t("tools.imageGeneration.square")}
                  </option>
                  <option value="portrait">
                    {t("tools.imageGeneration.portrait")}
                  </option>
                </select>
              </label>
            </div>

            {errorCode ? (
              <div className="tools-error">
                {t(`tools.imageGeneration.errors.${errorCode}`)}
              </div>
            ) : null}
            {message ? <div className="tools-success">{message}</div> : null}

            {confirmingTest ? (
              <div className="image-generation-confirmation" role="alert">
                <span>{t("tools.imageGeneration.testConfirmation")}</span>
                <div className="image-generation-confirmation-actions">
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => setConfirmingTest(false)}
                  >
                    <X size={15} />
                    {t("tools.cancel")}
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={() => void testGeneration()}
                  >
                    <FlaskConical size={15} />
                    {t("tools.imageGeneration.confirmTest")}
                  </button>
                </div>
              </div>
            ) : null}

            <div className="image-generation-actions">
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={!draft.enabled || Boolean(busy)}
                onClick={() => void discover()}
              >
                <RefreshCw size={15} />
                {t("tools.imageGeneration.discover")}
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={!draft.enabled || Boolean(busy)}
                onClick={() => setConfirmingTest(true)}
              >
                <FlaskConical size={15} />
                {t("tools.imageGeneration.test")}
              </button>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={Boolean(busy)}
                onClick={() => void save()}
              >
                <Save size={15} />
                {t("tools.imageGeneration.save")}
              </button>
            </div>

            {preview ? (
              <div className="image-generation-preview">
                <img
                  src={preview}
                  alt={t("tools.imageGeneration.previewAlt")}
                />
              </div>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}
