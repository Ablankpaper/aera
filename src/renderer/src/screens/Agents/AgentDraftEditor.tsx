import { useEffect, useMemo, useState } from "react";
import type {
  AgentDraftAssetKind,
  AgentDraftDetail,
  AgentEditableManifest,
  AgenteraAgentControlErrorCode,
  PublicationPreview,
  PublishedRevision,
} from "../../../../shared/agentera-agent-control";
import { Plus, X } from "../../assets/icons";
import { AppModal, AppModalTitle } from "../../components/modal/AppModal";
import { useI18n } from "../../components/useI18n";

interface EditableAssetRow {
  key: string;
  path: string;
  kind: AgentDraftAssetKind;
  content: string;
}

export interface AgentDraftEditorProps {
  open: boolean;
  draft: AgentDraftDetail | null;
  onClose: () => void;
  onSaved: (draft: AgentDraftDetail) => void;
  onPublished: (revision: PublishedRevision) => void;
  onRequestInstall: (target: {
    definitionId: string;
    versionId: string;
  }) => void;
}

const DEFAULT_RUNTIME_VERSION = "v0.18.2-agentera.1";

function newManifest(systemPrompt: string): AgentEditableManifest {
  return {
    schemaVersion: 1,
    identity: { systemPrompt },
    assets: [],
    modelConstraints: {
      allowedProviders: ["openai"],
      allowedModels: ["gpt-5.6"],
    },
    tools: { allowed: [], denied: [] },
    dependencies: [],
    runtimeCompatibility: {
      minimumVersion: DEFAULT_RUNTIME_VERSION,
      maximumVersionExclusive: null,
    },
  };
}

function assetRows(draft: AgentDraftDetail | null): EditableAssetRow[] {
  if (!draft) return [];
  return draft.manifest.assets.map((metadata, index) => ({
    key: `${metadata.path}\0${index}`,
    path: metadata.path,
    kind: metadata.kind,
    content:
      draft.editableAssets.find((asset) => asset.path === metadata.path)
        ?.content ?? "",
  }));
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function errorKey(code: AgenteraAgentControlErrorCode): string {
  return `agents.control.errors.${code}`;
}

export default function AgentDraftEditor({
  open,
  draft,
  onClose,
  onSaved,
  onPublished,
  onRequestInstall,
}: AgentDraftEditorProps): React.JSX.Element {
  const { t } = useI18n();
  const [current, setCurrent] = useState<AgentDraftDetail | null>(draft);
  const [name, setName] = useState(draft?.displayName ?? "");
  const [systemPrompt, setSystemPrompt] = useState(
    draft?.manifest.identity.systemPrompt ?? "",
  );
  const [providers, setProviders] = useState(
    draft?.manifest.modelConstraints.allowedProviders.join(", ") ?? "openai",
  );
  const [models, setModels] = useState(
    draft?.manifest.modelConstraints.allowedModels.join(", ") ?? "gpt-5.6",
  );
  const [assets, setAssets] = useState<EditableAssetRow[]>(assetRows(draft));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [preview, setPreview] = useState<PublicationPreview | null>(null);
  const [publishAndUse, setPublishAndUse] = useState(false);

  useEffect(() => {
    if (!open) return;
    setCurrent(draft);
    setName(draft?.displayName ?? "");
    setSystemPrompt(draft?.manifest.identity.systemPrompt ?? "");
    setProviders(
      draft?.manifest.modelConstraints.allowedProviders.join(", ") ?? "openai",
    );
    setModels(
      draft?.manifest.modelConstraints.allowedModels.join(", ") ?? "gpt-5.6",
    );
    setAssets(assetRows(draft));
    setBusy(false);
    setError(null);
    setNotice(null);
    setPreview(null);
    setPublishAndUse(false);
  }, [draft, open]);

  const canSave =
    name.trim().length > 0 &&
    systemPrompt.trim().length > 0 &&
    splitList(providers).length > 0 &&
    splitList(models).length > 0 &&
    assets.every((asset) => asset.path.trim() && asset.content.length > 0);

  const manifest = useMemo<AgentEditableManifest>(() => {
    const base = current?.manifest ?? newManifest(systemPrompt.trim());
    return {
      ...base,
      identity: { systemPrompt: systemPrompt.trim() },
      assets: assets.map((asset) => ({
        path: asset.path.trim(),
        kind: asset.kind,
        mediaType: "text/markdown" as const,
      })),
      modelConstraints: {
        allowedProviders: splitList(providers),
        allowedModels: splitList(models),
      },
    };
  }, [assets, current?.manifest, models, providers, systemPrompt]);

  const persist = async (): Promise<AgentDraftDetail | null> => {
    if (!canSave || busy) return null;
    setBusy(true);
    setError(null);
    setNotice(null);
    const editableAssets = assets.map((asset) => ({
      path: asset.path.trim(),
      content: asset.content,
    }));
    const result = current
      ? await window.agenteraAgents.updateDraft({
          id: current.id,
          expectedRevision: current.revision,
          displayName: name.trim(),
          icon: current.icon,
          manifest,
          assets: editableAssets,
        })
      : await window.agenteraAgents.createDraft({
          sourceAgentDefinitionId: null,
          baseAgentVersionId: null,
          displayName: name.trim(),
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

  const prepare = async (andUse: boolean): Promise<void> => {
    const saved = await persist();
    if (!saved) return;
    setBusy(true);
    setError(null);
    const result = await window.agenteraAgents.preparePublication(saved.id);
    setBusy(false);
    if (!result.ok) {
      setError(errorKey(result.errorCode));
      return;
    }
    setPublishAndUse(andUse);
    setPreview(result.data);
  };

  const confirm = async (): Promise<void> => {
    if (!preview || busy) return;
    setBusy(true);
    setError(null);
    const result = await window.agenteraAgents.confirmPublication(
      preview.publicationHandle,
    );
    setBusy(false);
    setPreview(null);
    if (!result.ok) {
      setError(errorKey(result.errorCode));
      return;
    }
    onPublished(result.data);
    if (publishAndUse) {
      onRequestInstall({
        definitionId: result.data.definitionId,
        versionId: result.data.versionId,
      });
    } else {
      setNotice("agents.control.publishOnlySuccess");
    }
  };

  const addAsset = (kind: AgentDraftAssetKind): void => {
    const index = assets.length + 1;
    setAssets((currentAssets) => [
      ...currentAssets,
      {
        key: `${Date.now()}-${index}`,
        path: `${kind}/${kind}-${index}.md`,
        kind,
        content: "# ",
      },
    ]);
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
            <p>{t("agents.control.localDraftStatus")}</p>
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
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className="agents-create-field agent-control-wide-field">
            <span>{t("agents.control.systemPrompt")}</span>
            <textarea
              className="input agent-control-textarea"
              aria-label={t("agents.control.systemPrompt")}
              value={systemPrompt}
              onChange={(event) => setSystemPrompt(event.target.value)}
            />
          </label>
          <label className="agents-create-field">
            <span>{t("agents.control.allowedProviders")}</span>
            <input
              className="input"
              value={providers}
              onChange={(event) => setProviders(event.target.value)}
            />
          </label>
          <label className="agents-create-field">
            <span>{t("agents.control.allowedModels")}</span>
            <input
              className="input"
              value={models}
              onChange={(event) => setModels(event.target.value)}
            />
          </label>

          <section className="agent-control-assets agent-control-wide-field">
            <div className="agent-control-assets-header">
              <div>
                <h4>{t("agents.control.versionAssets")}</h4>
                <p>{t("agents.control.versionAssetsHint")}</p>
              </div>
              <div className="agent-control-inline-actions">
                {(["skill", "sop", "knowledge"] as const).map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => addAsset(kind)}
                  >
                    <Plus size={13} />
                    {t(`agents.control.asset.${kind}`)}
                  </button>
                ))}
              </div>
            </div>
            {assets.map((asset) => (
              <div key={asset.key} className="agent-control-asset-row">
                <select
                  className="input"
                  value={asset.kind}
                  aria-label={t("agents.control.assetKind")}
                  onChange={(event) =>
                    setAssets((currentAssets) =>
                      currentAssets.map((item) =>
                        item.key === asset.key
                          ? {
                              ...item,
                              kind: event.target.value as AgentDraftAssetKind,
                            }
                          : item,
                      ),
                    )
                  }
                >
                  <option value="skill">
                    {t("agents.control.asset.skill")}
                  </option>
                  <option value="sop">{t("agents.control.asset.sop")}</option>
                  <option value="knowledge">
                    {t("agents.control.asset.knowledge")}
                  </option>
                </select>
                <input
                  className="input"
                  aria-label={t("agents.control.assetPath")}
                  value={asset.path}
                  onChange={(event) =>
                    setAssets((currentAssets) =>
                      currentAssets.map((item) =>
                        item.key === asset.key
                          ? { ...item, path: event.target.value }
                          : item,
                      ),
                    )
                  }
                />
                <textarea
                  className="input agent-control-textarea"
                  aria-label={t("agents.control.assetContent")}
                  value={asset.content}
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
          </section>

          {error && <div className="agents-create-error">{t(error)}</div>}
          {notice && <div className="agent-control-success">{t(notice)}</div>}
          <p className="agent-control-sequence agent-control-wide-field">
            {t("agents.control.publishAndUseSequence")}
          </p>
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
                <dd>{t("agents.control.personalSpace")}</dd>
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
                  disabled={busy}
                >
                  {t("agents.control.confirmPublish")}
                </button>
              </div>
            </div>
          </div>
        )}
      </AppModal>
    </>
  );
}
