import { useCallback, useEffect, useState } from "react";
import type {
  AgentDraft,
  AgentDraftDetail,
  AgenteraAgentControlErrorCode,
  AgenteraAgentControlPublicState,
  AgenteraAgentDefinitionSummary,
  AgenteraAgentInstallationSummary,
  AgenteraAgentVersionSummary,
} from "../../../../shared/agentera-agent-control";
import { Plus, Refresh } from "../../assets/icons";
import { useI18n } from "../../components/useI18n";
import AgentDraftEditor from "./AgentDraftEditor";
import AgentInstallDialog, {
  type AgentInstallProfileOption,
} from "./AgentInstallDialog";

export interface AgentControlPanelProps {
  profiles: AgentInstallProfileOption[];
}

interface InstallDialogState {
  mode: "install" | "retry" | "update";
  definitionId: string;
  versionId: string;
  installation: AgenteraAgentInstallationSummary | null;
  versions: AgenteraAgentVersionSummary[];
}

function errorKey(code: AgenteraAgentControlErrorCode): string {
  return `agents.control.errors.${code}`;
}

export default function AgentControlPanel({
  profiles,
}: AgentControlPanelProps): React.JSX.Element {
  const { t } = useI18n();
  const [state, setState] = useState<AgenteraAgentControlPublicState | null>(
    null,
  );
  const [drafts, setDrafts] = useState<AgentDraft[]>([]);
  const [definitions, setDefinitions] = useState<
    AgenteraAgentDefinitionSummary[]
  >([]);
  const [installations, setInstallations] = useState<
    AgenteraAgentInstallationSummary[]
  >([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<AgentDraftDetail | "new" | null>(null);
  const [installDialog, setInstallDialog] = useState<InstallDialogState | null>(
    null,
  );
  const [archiveTarget, setArchiveTarget] =
    useState<AgenteraAgentInstallationSummary | null>(null);
  const [archiving, setArchiving] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const [stateResult, draftResult, installationResult] = await Promise.all([
        window.agenteraAgents.getState(),
        window.agenteraAgents.listDrafts(),
        window.agenteraAgents.listInstallations(),
      ]);
      const failed = [stateResult, draftResult, installationResult].find(
        (result) => !result.ok,
      );
      if (failed && !failed.ok) {
        setError(errorKey(failed.errorCode));
        return;
      }
      if (!stateResult.ok || !draftResult.ok || !installationResult.ok) return;
      setState(stateResult.data);
      setDrafts(draftResult.data);
      setInstallations(installationResult.data);
      if (
        stateResult.data.access === "online" &&
        stateResult.data.cloudAvailable
      ) {
        const definitionResult = await window.agenteraAgents.listDefinitions();
        if (!definitionResult.ok) {
          setError(errorKey(definitionResult.errorCode));
          setDefinitions([]);
        } else {
          setDefinitions(definitionResult.data);
        }
      } else {
        setDefinitions([]);
      }
    } catch {
      setError("agents.control.errors.operation_failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    return window.agenteraAgents.onStateChanged(() => {
      void load();
    });
  }, [load]);

  const editDraft = async (id: string): Promise<void> => {
    setError(null);
    const result = await window.agenteraAgents.getDraft(id);
    if (!result.ok) {
      setError(errorKey(result.errorCode));
      return;
    }
    setEditor(result.data);
  };

  const requestInstall = (target: {
    definitionId: string;
    versionId: string;
  }): void => {
    setEditor(null);
    setInstallDialog({
      mode: "install",
      definitionId: target.definitionId,
      versionId: target.versionId,
      installation: null,
      versions: [],
    });
  };

  const requestUpdate = async (
    installation: AgenteraAgentInstallationSummary,
  ): Promise<void> => {
    setError(null);
    const result = await window.agenteraAgents.listVersions(
      installation.definitionId,
    );
    if (!result.ok) {
      setError(errorKey(result.errorCode));
      return;
    }
    const latest = [...result.data].sort(
      (left, right) => right.versionNumber - left.versionNumber,
    )[0];
    setInstallDialog({
      mode: "update",
      definitionId: installation.definitionId,
      versionId: latest?.id ?? installation.selectedVersionId,
      installation,
      versions: result.data,
    });
  };

  const confirmArchive = async (): Promise<void> => {
    if (!archiveTarget || archiving) return;
    setArchiving(true);
    const result = await window.agenteraAgents.archiveInstallation(
      archiveTarget.id,
    );
    setArchiving(false);
    setArchiveTarget(null);
    if (!result.ok) {
      setError(errorKey(result.errorCode));
      return;
    }
    await load();
  };

  const definitionName = (definitionId: string): string =>
    definitions.find((item) => item.id === definitionId)?.displayName ??
    t("agents.control.installedLocally");

  return (
    <section
      className="agent-control-panel"
      aria-labelledby="agent-control-title"
    >
      <div className="agent-control-section-header">
        <div>
          <span className="agent-control-eyebrow">
            {t("agents.control.personalSpace")}
          </span>
          <h2 id="agent-control-title">
            {t("agents.control.personalSpaceTitle")}
          </h2>
          <p>{t("agents.control.personalSpaceSubtitle")}</p>
        </div>
        <div className="agent-control-inline-actions">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => void load()}
            disabled={loading}
            aria-label={t("agents.control.refresh")}
          >
            <Refresh size={14} />
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => setEditor("new")}
          >
            <Plus size={14} />
            {t("agents.control.newAgent")}
          </button>
        </div>
      </div>

      {state?.access === "offline" || state?.cloudAvailable === false ? (
        <div className="agent-control-notice">
          {t("agents.control.offlineNotice")}
        </div>
      ) : null}
      {error && <div className="agents-create-error">{t(error)}</div>}

      {loading ? (
        <div className="agent-control-loading">
          <div className="loading-spinner" />
        </div>
      ) : (
        <div className="agent-control-columns">
          <section className="agent-control-group">
            <div className="agent-control-group-title">
              <h3>{t("agents.control.localDrafts")}</h3>
              <span>{drafts.length}</span>
            </div>
            {drafts.length === 0 ? (
              <p className="agent-control-empty">
                {t("agents.control.noDrafts")}
              </p>
            ) : (
              drafts.map((draft) => (
                <article key={draft.id} className="agent-control-card">
                  <div>
                    <strong>{draft.displayName}</strong>
                    <p>
                      {t("agents.control.revision")} {draft.revision} ·{" "}
                      {draft.publishedRevision
                        ? t("agents.control.published")
                        : t("agents.control.localOnly")}
                    </p>
                  </div>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => void editDraft(draft.id)}
                  >
                    {t("agents.control.edit")}
                  </button>
                </article>
              ))
            )}
          </section>

          <section className="agent-control-group">
            <div className="agent-control-group-title">
              <h3>{t("agents.control.publishedAgents")}</h3>
              <span>{definitions.length}</span>
            </div>
            {definitions.length === 0 ? (
              <p className="agent-control-empty">
                {state?.cloudAvailable
                  ? t("agents.control.noPublishedAgents")
                  : t("agents.control.discoveryPaused")}
              </p>
            ) : (
              definitions.map((definition) => (
                <article key={definition.id} className="agent-control-card">
                  <div>
                    <strong>{definition.displayName}</strong>
                    <p>{t("agents.control.immutableVersion")}</p>
                  </div>
                  {definition.latestVersionId && (
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      onClick={() =>
                        requestInstall({
                          definitionId: definition.id,
                          versionId: definition.latestVersionId!,
                        })
                      }
                    >
                      {t("agents.control.install")}
                    </button>
                  )}
                </article>
              ))
            )}
          </section>
        </div>
      )}

      {!loading && (
        <section className="agent-control-group agent-control-installations">
          <div className="agent-control-group-title">
            <h3>{t("agents.control.installations")}</h3>
            <span>{installations.length}</span>
          </div>
          {installations.length === 0 ? (
            <p className="agent-control-empty">
              {t("agents.control.noInstallations")}
            </p>
          ) : (
            installations.map((installation, index) => (
              <article
                key={`${installation.id}-${index}`}
                className="agent-control-card agent-control-installation-card"
              >
                <div>
                  <strong>{definitionName(installation.definitionId)}</strong>
                  <p>
                    {installation.status === "pending"
                      ? t("agents.control.pendingInstallation")
                      : t("agents.control.installedLocally")}
                  </p>
                </div>
                <div className="agent-control-inline-actions">
                  {installation.status === "pending" && (
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      onClick={() =>
                        setInstallDialog({
                          mode: "retry",
                          definitionId: installation.definitionId,
                          versionId: installation.selectedVersionId,
                          installation,
                          versions: [],
                        })
                      }
                    >
                      {t("agents.control.retry")}
                    </button>
                  )}
                  {installation.status === "active" && (
                    <>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        disabled={!state?.cloudAvailable}
                        onClick={() => void requestUpdate(installation)}
                      >
                        {t("agents.control.update")}
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        disabled={!state?.cloudAvailable}
                        onClick={() => setArchiveTarget(installation)}
                      >
                        {t("agents.control.archive")}
                      </button>
                    </>
                  )}
                </div>
              </article>
            ))
          )}
        </section>
      )}

      <AgentDraftEditor
        open={editor !== null}
        draft={editor === "new" ? null : editor}
        onClose={() => setEditor(null)}
        onSaved={() => void load()}
        onPublished={() => void load()}
        onRequestInstall={requestInstall}
      />
      {installDialog && (
        <AgentInstallDialog
          open
          {...installDialog}
          profiles={profiles}
          onClose={() => setInstallDialog(null)}
          onCompleted={() => void load()}
        />
      )}

      {archiveTarget && (
        <div className="agent-control-dialog-backdrop">
          <div
            className="agent-control-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="agent-archive-title"
          >
            <h3 id="agent-archive-title">{t("agents.control.archiveTitle")}</h3>
            <p>{t("agents.control.archiveKeepsLocalData")}</p>
            <div className="agent-control-dialog-actions">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setArchiveTarget(null)}
              >
                {t("agents.control.cancel")}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void confirmArchive()}
                disabled={archiving}
              >
                {t("agents.control.confirmArchive")}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
