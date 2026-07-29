import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentDraftAssetKind,
  AgentDraftDetail,
  AgentEditableManifest,
  AgenteraAgentControlErrorCode,
  OrganizationAgentSubmissionSummary,
  OrganizationSubmissionPreview,
  PublicationPreview,
  PublishedRevision,
} from "../../../../shared/agentera-agent-control";
import { Plus, X } from "../../assets/icons";
import { AppModal, AppModalTitle } from "../../components/modal/AppModal";
import { useI18n } from "../../components/useI18n";
import {
  createDefaultAgentManifest,
  DEFAULT_AGENT_MODEL,
  DEFAULT_AGENT_PROVIDER,
} from "./agentDraftDefaults";

interface EditableAssetRow {
  key: string;
  path: string;
  kind: AgentDraftAssetKind;
  content: string;
  fileName: string;
}

interface ModelChoice {
  key: string;
  provider: string;
  model: string;
  label: string;
}

export interface AgentDraftEditorProps {
  open: boolean;
  draft: AgentDraftDetail | null;
  readOnly?: boolean;
  publicationTarget?: "DIRECT" | "ORGANIZATION";
  onClose: () => void;
  onSaved: (draft: AgentDraftDetail) => void;
  onPublished: (revision: PublishedRevision) => void;
  onOrganizationSubmitted?: (
    submission: OrganizationAgentSubmissionSummary,
  ) => void;
  onRequestInstall: (target: {
    definitionId: string;
    versionId: string;
    displayName: string;
  }) => void;
  modelProfileId?: string;
}

const MAX_UPLOAD_BYTES = 256 * 1024;
const ASSET_DIRECTORY: Record<AgentDraftAssetKind, string> = {
  skill: "skills",
  sop: "sop",
  knowledge: "knowledge",
};

function assetRows(draft: AgentDraftDetail | null): EditableAssetRow[] {
  if (!draft) return [];
  return draft.manifest.assets.map((metadata, index) => ({
    key: `${metadata.path}\0${index}`,
    path: metadata.path,
    kind: metadata.kind,
    fileName: metadata.path.split("/").pop() ?? metadata.path,
    content:
      draft.editableAssets.find((asset) => asset.path === metadata.path)
        ?.content ?? "",
  }));
}

function modelKey(provider: string, model: string): string {
  return `${provider}\0${model}`;
}

function currentModelChoice(draft: AgentDraftDetail | null): ModelChoice {
  const provider =
    draft?.manifest.modelConstraints.allowedProviders[0] ??
    DEFAULT_AGENT_PROVIDER;
  const model =
    draft?.manifest.modelConstraints.allowedModels[0] ?? DEFAULT_AGENT_MODEL;
  return {
    key: modelKey(provider, model),
    provider,
    model,
    label: model,
  };
}

function slugFromFileName(fileName: string): string {
  const withoutExtension = fileName.replace(/\.[^.]+$/, "");
  const normalized = withoutExtension
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9\u3400-\u9fff-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLocaleLowerCase();
  return normalized || "document";
}

function nextAssetPath(
  kind: AgentDraftAssetKind,
  fileName: string,
  existing: readonly EditableAssetRow[],
): string {
  const slug = slugFromFileName(fileName);
  const base =
    kind === "skill"
      ? `${ASSET_DIRECTORY[kind]}/${slug}/SKILL.md`
      : `${ASSET_DIRECTORY[kind]}/${slug}.md`;
  if (!existing.some((asset) => asset.path === base)) return base;
  let suffix = 2;
  while (true) {
    const candidate =
      kind === "skill"
        ? `${ASSET_DIRECTORY[kind]}/${slug}-${suffix}/SKILL.md`
        : `${ASSET_DIRECTORY[kind]}/${slug}-${suffix}.md`;
    if (!existing.some((asset) => asset.path === candidate)) return candidate;
    suffix += 1;
  }
}

function readTextFile(file: File): Promise<string> {
  if (typeof file.text === "function") return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("read_failed"));
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.readAsText(file);
  });
}

function sameDraftContent(
  draft: AgentDraftDetail,
  displayName: string,
  manifest: AgentEditableManifest,
  assets: Array<{ path: string; content: string }>,
): boolean {
  return (
    draft.displayName === displayName &&
    JSON.stringify(draft.manifest) === JSON.stringify(manifest) &&
    JSON.stringify(draft.editableAssets) === JSON.stringify(assets)
  );
}

function errorKey(code: AgenteraAgentControlErrorCode): string {
  return `agents.control.errors.${code}`;
}

export default function AgentDraftEditor({
  open,
  draft,
  readOnly = false,
  publicationTarget = "DIRECT",
  onClose,
  onSaved,
  onPublished,
  onOrganizationSubmitted = () => undefined,
  onRequestInstall,
  modelProfileId,
}: AgentDraftEditorProps): React.JSX.Element {
  const { t } = useI18n();
  const identityFileInputRef = useRef<HTMLInputElement | null>(null);
  const [current, setCurrent] = useState<AgentDraftDetail | null>(draft);
  const [name, setName] = useState(draft?.displayName ?? "");
  const [systemPrompt, setSystemPrompt] = useState(
    draft?.manifest.identity.systemPrompt ?? "",
  );
  const [identityFileName, setIdentityFileName] = useState<string | null>(null);
  const [selectedModelKey, setSelectedModelKey] = useState(
    currentModelChoice(draft).key,
  );
  const [modelChoices, setModelChoices] = useState<ModelChoice[]>([
    currentModelChoice(draft),
  ]);
  const [assets, setAssets] = useState<EditableAssetRow[]>(assetRows(draft));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [preview, setPreview] = useState<PublicationPreview | null>(null);
  const [organizationPreview, setOrganizationPreview] =
    useState<OrganizationSubmissionPreview | null>(null);
  const [publishAndUse, setPublishAndUse] = useState(false);

  useEffect(() => {
    if (!open) return;
    setCurrent(draft);
    setName(draft?.displayName ?? "");
    setSystemPrompt(draft?.manifest.identity.systemPrompt ?? "");
    setIdentityFileName(null);
    const initialChoice = currentModelChoice(draft);
    setSelectedModelKey(initialChoice.key);
    setModelChoices([initialChoice]);
    setAssets(assetRows(draft));
    setBusy(false);
    setError(null);
    setNotice(null);
    setPreview(null);
    setOrganizationPreview(null);
    setPublishAndUse(false);
  }, [draft, open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const loadModels = async (): Promise<void> => {
      const bridge = window.hermesAPI;
      if (!bridge?.listModels || !bridge.getModelConfig) return;
      try {
        const [configured, saved] = await Promise.all([
          bridge.getModelConfig(modelProfileId),
          bridge.listModels(),
        ]);
        if (cancelled) return;
        const byKey = new Map<string, ModelChoice>();
        const addChoice = (
          provider: string,
          model: string,
          label: string,
        ): void => {
          if (!provider.trim() || !model.trim()) return;
          const key = modelKey(provider.trim(), model.trim());
          const choice = {
            key,
            provider: provider.trim(),
            model: model.trim(),
            label,
          };
          const existing = byKey.get(key);
          if (existing) {
            if (existing.label === existing.model && label !== choice.model) {
              byKey.set(key, choice);
            }
            return;
          }
          byKey.set(key, choice);
        };
        const draftChoice = currentModelChoice(draft);
        addChoice(draftChoice.provider, draftChoice.model, draftChoice.label);
        addChoice(
          configured.provider,
          configured.model,
          configured.model || configured.provider,
        );
        for (const item of saved) {
          const providerLabel = item.providerLabel || item.provider;
          addChoice(
            item.provider,
            item.model,
            item.name
              ? `${item.name} · ${providerLabel}`
              : `${item.model} · ${providerLabel}`,
          );
        }
        const nextChoices = [...byKey.values()];
        setModelChoices(nextChoices);
        if (!draft && configured.provider && configured.model) {
          setSelectedModelKey(modelKey(configured.provider, configured.model));
        }
      } catch {
        // The editor remains usable with the safe built-in fallback.
      }
    };
    void loadModels();
    return () => {
      cancelled = true;
    };
  }, [draft, modelProfileId, open]);

  const selectedModel =
    modelChoices.find((choice) => choice.key === selectedModelKey) ??
    currentModelChoice(draft);

  const canSave =
    !readOnly &&
    name.trim().length > 0 &&
    systemPrompt.trim().length > 0 &&
    selectedModel.provider.length > 0 &&
    selectedModel.model.length > 0 &&
    assets.every((asset) => asset.path.trim() && asset.content.length > 0);

  const manifest = useMemo<AgentEditableManifest>(() => {
    const base =
      current?.manifest ??
      createDefaultAgentManifest(
        systemPrompt.trim(),
        selectedModel.provider,
        selectedModel.model,
      );
    return {
      ...base,
      identity: { systemPrompt: systemPrompt.trim() },
      assets: assets.map((asset) => ({
        path: asset.path.trim(),
        kind: asset.kind,
        mediaType: "text/markdown" as const,
      })),
      modelConstraints: {
        allowedProviders: [selectedModel.provider],
        allowedModels: [selectedModel.model],
      },
    };
  }, [assets, current?.manifest, selectedModel, systemPrompt]);

  const persist = async (): Promise<AgentDraftDetail | null> => {
    if (readOnly || !canSave || busy) return null;
    const editableAssets = assets.map((asset) => ({
      path: asset.path.trim(),
      content: asset.content,
    }));
    const displayName = name.trim();
    if (
      current &&
      sameDraftContent(current, displayName, manifest, editableAssets)
    ) {
      return current;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    const result = current
      ? await window.agenteraAgents.updateDraft({
          id: current.id,
          expectedRevision: current.revision,
          displayName,
          icon: current.icon,
          manifest,
          assets: editableAssets,
        })
      : await window.agenteraAgents.createDraft({
          sourceAgentDefinitionId: null,
          baseAgentVersionId: null,
          displayName,
          icon: null,
          manifest,
          assets: editableAssets,
        });
    setBusy(false);
    if (!result.ok) {
      setError(errorKey(result.errorCode));
      return null;
    }
    setCurrent(result.data);
    onSaved(result.data);
    setNotice("agents.control.savedLocally");
    return result.data;
  };

  const publishPrepared = async (
    prepared: PublicationPreview,
    andUse: boolean,
  ): Promise<void> => {
    setBusy(true);
    setError(null);
    const result = await window.agenteraAgents.confirmPublication(
      prepared.publicationHandle,
    );
    setBusy(false);
    setPreview(null);
    if (!result.ok) {
      setError(errorKey(result.errorCode));
      return;
    }
    onPublished(result.data);
    if (andUse) {
      onRequestInstall({
        definitionId: result.data.definitionId,
        versionId: result.data.versionId,
        displayName: name.trim(),
      });
    } else {
      setNotice("agents.control.publishOnlySuccess");
    }
  };

  const prepare = async (andUse: boolean): Promise<void> => {
    if (readOnly) return;
    const saved = await persist();
    if (!saved) return;
    setBusy(true);
    setError(null);
    if (publicationTarget === "ORGANIZATION") {
      const result = await window.agenteraAgents.prepareOrganizationSubmission(
        saved.id,
      );
      setBusy(false);
      if (!result.ok) {
        setError(errorKey(result.errorCode));
        return;
      }
      setPublishAndUse(false);
      setOrganizationPreview(result.data);
      return;
    }
    const result = await window.agenteraAgents.preparePublication(saved.id);
    setBusy(false);
    if (!result.ok) {
      setError(errorKey(result.errorCode));
      return;
    }
    if (result.data.targetScope === "USER") {
      await publishPrepared(result.data, andUse);
      return;
    }
    setPublishAndUse(andUse);
    setPreview(result.data);
  };

  const confirmOrganizationSubmission = async (): Promise<void> => {
    if (readOnly || !organizationPreview || busy) return;
    setBusy(true);
    setError(null);
    const result = await window.agenteraAgents.confirmOrganizationSubmission({
      publicationHandle: organizationPreview.publicationHandle,
      confirmation: "submit-organization-agent",
    });
    setBusy(false);
    setOrganizationPreview(null);
    if (!result.ok) {
      setError(errorKey(result.errorCode));
      return;
    }
    setNotice("agents.control.organization.submittedNotPublished");
    onOrganizationSubmitted(result.data);
  };

  const confirm = async (): Promise<void> => {
    if (readOnly || !preview || busy) return;
    await publishPrepared(preview, publishAndUse);
  };

  const importIdentityFile = async (file: File | undefined): Promise<void> => {
    if (!file || readOnly) return;
    setError(null);
    if (file.size > MAX_UPLOAD_BYTES) {
      setError("agents.control.uploadTooLarge");
      return;
    }
    try {
      const content = await readTextFile(file);
      if (!content.trim()) {
        setError("agents.control.uploadEmpty");
        return;
      }
      setSystemPrompt(content);
      setIdentityFileName(file.name);
      if (!name.trim()) {
        setName(file.name.replace(/\.[^.]+$/, ""));
      }
    } catch {
      setError("agents.control.uploadFailed");
    } finally {
      if (identityFileInputRef.current) {
        identityFileInputRef.current.value = "";
      }
    }
  };

  const importAssets = async (
    kind: AgentDraftAssetKind,
    files: FileList | null,
  ): Promise<void> => {
    if (!files || files.length === 0 || readOnly) return;
    setError(null);
    try {
      const imported: Array<{ file: File; content: string }> = [];
      for (const file of Array.from(files)) {
        if (file.size > MAX_UPLOAD_BYTES) {
          setError("agents.control.uploadTooLarge");
          return;
        }
        const content = await readTextFile(file);
        if (!content.trim()) {
          setError("agents.control.uploadEmpty");
          return;
        }
        imported.push({ file, content });
      }
      setAssets((currentAssets) => {
        const next = [...currentAssets];
        for (const item of imported) {
          const path = nextAssetPath(kind, item.file.name, next);
          next.push({
            key: `${path}\0${crypto.randomUUID()}`,
            path,
            kind,
            content: item.content,
            fileName: item.file.name,
          });
        }
        return next;
      });
    } catch {
      setError("agents.control.uploadFailed");
    }
  };

  return (
    <>
      <AppModal
        open={open}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && !busy) onClose();
        }}
        className="agent-control-modal agent-draft-editor"
        labelledBy="agent-draft-editor-title"
      >
        <header className="agent-control-modal-header">
          <div>
            <AppModalTitle id="agent-draft-editor-title">
              {t(
                current
                  ? "agents.control.editDraftTitle"
                  : "agents.control.newDraftTitle",
              )}
            </AppModalTitle>
            <p>
              {t(
                readOnly
                  ? publicationTarget === "ORGANIZATION"
                    ? "agents.control.organization.draftReadOnly"
                    : "agents.control.workspaceDraftReadOnly"
                  : "agents.control.localDraftStatus",
              )}
            </p>
          </div>
          <button
            type="button"
            className="agents-row-edit"
            aria-label={t("agents.control.close")}
            onClick={onClose}
            disabled={busy}
          >
            <X size={16} />
          </button>
        </header>

        <div className="agent-control-modal-body agent-draft-editor-body">
          <label className="agents-create-field">
            <span>{t("agents.control.name")}</span>
            <input
              className="input"
              aria-label={t("agents.control.name")}
              value={name}
              disabled={readOnly}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className="agents-create-field agent-control-wide-field">
            <span>{t("agents.control.systemPrompt")}</span>
            <textarea
              className="input agent-control-textarea"
              aria-label={t("agents.control.systemPrompt")}
              value={systemPrompt}
              disabled={readOnly}
              onChange={(event) => setSystemPrompt(event.target.value)}
            />
          </label>
          <div className="agent-control-identity-upload agent-control-wide-field">
            <input
              ref={identityFileInputRef}
              type="file"
              accept=".md,text/markdown,text/plain"
              aria-label={t("agents.control.identityUpload")}
              disabled={readOnly}
              onChange={(event) =>
                void importIdentityFile(event.currentTarget.files?.[0])
              }
            />
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={readOnly}
              onClick={() => identityFileInputRef.current?.click()}
            >
              <Plus size={13} />
              {t("agents.control.identityUpload")}
            </button>
            <span>
              {identityFileName
                ? t("agents.control.fileImported", {
                    name: identityFileName,
                  })
                : t("agents.control.identityUploadHint")}
            </span>
          </div>
          <label className="agents-create-field agent-control-wide-field">
            <span>{t("agents.control.runtimeModel")}</span>
            <select
              className="input"
              aria-label={t("agents.control.runtimeModel")}
              value={selectedModelKey}
              disabled={readOnly}
              onChange={(event) => setSelectedModelKey(event.target.value)}
            >
              {modelChoices.map((choice) => (
                <option key={choice.key} value={choice.key}>
                  {choice.label}
                </option>
              ))}
            </select>
            <small>{t("agents.control.runtimeModelHint")}</small>
          </label>

          <section className="agent-control-assets agent-control-wide-field">
            <div className="agent-control-assets-header">
              <div>
                <h4>{t("agents.control.versionAssets")}</h4>
                <p>{t("agents.control.versionAssetsHint")}</p>
              </div>
              <div className="agent-control-inline-actions">
                {(["skill", "sop", "knowledge"] as const).map((kind) => (
                  <label
                    key={kind}
                    className={`btn btn-secondary btn-sm agent-control-file-button${
                      readOnly ? " disabled" : ""
                    }`}
                  >
                    <input
                      type="file"
                      multiple
                      accept=".md,.txt,text/markdown,text/plain"
                      aria-label={t("agents.control.assetUpload", {
                        kind: t(`agents.control.asset.${kind}`),
                      })}
                      disabled={readOnly}
                      onChange={(event) => {
                        void importAssets(kind, event.currentTarget.files);
                        event.currentTarget.value = "";
                      }}
                    />
                    <Plus size={13} />
                    {t("agents.control.assetUpload", {
                      kind: t(`agents.control.asset.${kind}`),
                    })}
                  </label>
                ))}
              </div>
            </div>
            {assets.map((asset) => (
              <div key={asset.key} className="agent-control-asset-row">
                <div className="agent-control-asset-file">
                  <strong>{asset.fileName}</strong>
                  <span>{t(`agents.control.asset.${asset.kind}`)}</span>
                </div>
                <textarea
                  className="input agent-control-textarea"
                  aria-label={t("agents.control.assetContent")}
                  value={asset.content}
                  disabled={readOnly}
                  onChange={(event) =>
                    setAssets((currentAssets) =>
                      currentAssets.map((item) =>
                        item.key === asset.key
                          ? { ...item, content: event.target.value }
                          : item,
                      ),
                    )
                  }
                />
                <button
                  type="button"
                  className="agents-row-edit"
                  aria-label={t("agents.control.removeAsset")}
                  disabled={readOnly}
                  onClick={() =>
                    setAssets((currentAssets) =>
                      currentAssets.filter((item) => item.key !== asset.key),
                    )
                  }
                >
                  <X size={14} />
                </button>
              </div>
            ))}
            {assets.length === 0 ? (
              <p className="agent-control-empty">
                {t("agents.control.noVersionAssets")}
              </p>
            ) : null}
          </section>

          {error && <div className="agents-create-error">{t(error)}</div>}
          {notice && <div className="agent-control-success">{t(notice)}</div>}
          {!readOnly && publicationTarget !== "ORGANIZATION" ? (
            <p className="agent-control-sequence agent-control-wide-field">
              {t("agents.control.publishAndUseSequence")}
            </p>
          ) : null}
        </div>

        <footer className="agent-control-modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            {t("agents.control.cancel")}
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={!canSave || busy}
            onClick={() => void persist()}
          >
            {t("agents.control.saveLocal")}
          </button>
          {publicationTarget === "ORGANIZATION" ? (
            <button
              type="button"
              className="btn btn-primary"
              disabled={!canSave || busy}
              onClick={() => void prepare(false)}
            >
              {t("agents.control.organization.prepareSubmission")}
            </button>
          ) : (
            <>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={!canSave || busy}
                onClick={() => void prepare(false)}
              >
                {t("agents.control.publish")}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={!canSave || busy}
                onClick={() => void prepare(true)}
              >
                {t("agents.control.publishAndUse")}
              </button>
            </>
          )}
        </footer>

        {preview && (
          <div className="agent-control-dialog-backdrop">
            <div
              className="agent-control-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="agent-publication-preview-title"
            >
              <h3 id="agent-publication-preview-title">
                {t("agents.control.publishPreviewTitle")}
              </h3>
              <dl className="agent-control-preview-grid">
                <dt>{t("agents.control.target")}</dt>
                <dd>
                  {t(
                    preview.targetScope === "WORKSPACE"
                      ? "agents.control.workspaceSpace"
                      : "agents.control.personalSpace",
                  )}
                </dd>
                <dt>{t("agents.control.revision")}</dt>
                <dd>{preview.revision}</dd>
                <dt>{t("agents.control.asset.skill")}</dt>
                <dd>{preview.assetCounts.skill}</dd>
                <dt>{t("agents.control.asset.sop")}</dt>
                <dd>{preview.assetCounts.sop}</dd>
                <dt>{t("agents.control.asset.knowledge")}</dt>
                <dd>{preview.assetCounts.knowledge}</dd>
                <dt>{t("agents.control.totalBytes")}</dt>
                <dd>{preview.totalBytes}</dd>
              </dl>
              <p className="agent-control-private-boundary">
                {t("agents.control.privateDataExcluded")}
              </p>
              <div className="agent-control-dialog-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setPreview(null)}
                  disabled={busy}
                >
                  {t("agents.control.cancel")}
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => void confirm()}
                  disabled={busy || readOnly}
                >
                  {t("agents.control.confirmPublish")}
                </button>
              </div>
            </div>
          </div>
        )}
        {organizationPreview && (
          <div className="agent-control-dialog-backdrop">
            <div
              className="agent-control-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="organization-submission-preview-title"
            >
              <h3 id="organization-submission-preview-title">
                {t("agents.control.organization.submissionPreviewTitle")}
              </h3>
              <dl className="agent-control-preview-grid">
                <dt>{t("agents.control.revision")}</dt>
                <dd>{organizationPreview.revision}</dd>
                <dt>{t("agents.control.organization.contentDigest")}</dt>
                <dd>{organizationPreview.contentDigest}</dd>
                <dt>{t("agents.control.asset.skill")}</dt>
                <dd>{organizationPreview.assetCounts.skill}</dd>
                <dt>{t("agents.control.asset.sop")}</dt>
                <dd>{organizationPreview.assetCounts.sop}</dd>
                <dt>{t("agents.control.asset.knowledge")}</dt>
                <dd>{organizationPreview.assetCounts.knowledge}</dd>
                <dt>{t("agents.control.totalBytes")}</dt>
                <dd>{organizationPreview.totalBytes}</dd>
              </dl>
              <p className="agent-control-private-boundary">
                {t("agents.control.privateDataExcluded")}
              </p>
              <p className="agent-control-private-boundary">
                {t("agents.control.organization.submissionBoundary")}
              </p>
              <div className="agent-control-dialog-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setOrganizationPreview(null)}
                  disabled={busy}
                >
                  {t("agents.control.cancel")}
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => void confirmOrganizationSubmission()}
                  disabled={busy || readOnly}
                >
                  {t("agents.control.organization.submitForReview")}
                </button>
              </div>
            </div>
          </div>
        )}
      </AppModal>
    </>
  );
}
