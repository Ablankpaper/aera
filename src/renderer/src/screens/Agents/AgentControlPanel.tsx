import { useCallback, useEffect, useRef, useState } from "react";
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
import ExperienceCandidatePanel from "./ExperienceCandidatePanel";
import ExperiencePromotionDialog from "./ExperiencePromotionDialog";
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

function contextKey(state: AgenteraAgentControlPublicState): string {
  switch (state.context.scope) {
    case "USER":
      return "USER";
    case "WORKSPACE":
      return `WORKSPACE\0${state.context.workspaceId}\0${state.context.role}`;
    case "ORGANIZATION":
      return `ORGANIZATION\0${state.context.organizationId}\0${state.context.role}`;
    case "ORGANIZATION_UNAVAILABLE":
      return `ORGANIZATION_UNAVAILABLE\0${state.context.organizationId}\0${state.context.role}`;
  }
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
  const [promotionTarget, setPromotionTarget] =
    useState<AgenteraAgentInstallationSummary | null>(null);
  const [candidateRefreshToken, setCandidateRefreshToken] = useState(0);
  const [archiving, setArchiving] = useState(false);
  const loadEpoch = useRef(0);
  const selectedContextKey = useRef<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    const epoch = ++loadEpoch.current;
    setLoading(true);
    setError(null);
    try {
      const stateResult = await window.agenteraAgents.getState();
      if (epoch !== loadEpoch.current) return;
      if (!stateResult.ok) {
        setError(errorKey(stateResult.errorCode));
        return;
      }
      const nextState = stateResult.data;
      const nextContextKey = contextKey(nextState);
      if (nextState.context.scope === "ORGANIZATION_UNAVAILABLE") {
        selectedContextKey.current = nextContextKey;
        setState(nextState);
        setDrafts([]);
        setDefinitions([]);
        setInstallations([]);
        setEditor(null);
        setInstallDialog(null);
        setArchiveTarget(null);
        setPromotionTarget(null);
        return;
      }

      const installationResult =
        await window.agenteraAgents.listInstallations();
      if (epoch !== loadEpoch.current) return;
      if (!installationResult.ok) {
        setError(errorKey(installationResult.errorCode));
        return;
      }
      const memberInstallOnly =
        nextState.context.scope === "WORKSPACE" &&
        nextState.context.role === "member";
      let nextDrafts: AgentDraft[] = [];
      if (!memberInstallOnly) {
        const draftResult = await window.agenteraAgents.listDrafts();
        if (epoch !== loadEpoch.current) return;
        if (!draftResult.ok) {
          setError(errorKey(draftResult.errorCode));
          return;
        }
        nextDrafts = draftResult.data;
      }

      let nextDefinitions: AgenteraAgentDefinitionSummary[] = [];
      let nextError: string | null = null;
      if (nextState.access === "online" && nextState.cloudAvailable) {
        const definitionResult = await window.agenteraAgents.listDefinitions();
        if (epoch !== loadEpoch.current) return;
        if (!definitionResult.ok) {
          nextError = errorKey(definitionResult.errorCode);
        } else {
          nextDefinitions = definitionResult.data;
        }
      }
      if (epoch !== loadEpoch.current) return;

      if (
        selectedContextKey.current !== null &&
        selectedContextKey.current !== nextContextKey
      ) {
        setEditor(null);
        setInstallDialog(null);
        setArchiveTarget(null);
        setPromotionTarget(null);
      }
      selectedContextKey.current = nextContextKey;
      setState(nextState);
      setDrafts(nextDrafts);
      setInstallations(installationResult.data);
      setDefinitions(nextDefinitions);
      setError(nextError);
    } catch {
      if (epoch === loadEpoch.current) {
        setError("agents.control.errors.operation_failed");
      }
    } finally {
      if (epoch === loadEpoch.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    return window.agenteraAgents.onStateChanged(() => {
      setEditor(null);
      setInstallDialog(null);
      setArchiveTarget(null);
      setPromotionTarget(null);
      setCandidateRefreshToken((value) => value + 1);
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

  const context = state?.context ?? ({ scope: "USER" } as const);
  const organizationUnavailable = context.scope === "ORGANIZATION_UNAVAILABLE";
  const isWorkspace = context.scope === "WORKSPACE";
  const isWorkspaceMember = isWorkspace && context.role === "member";
  const workspaceReadOnly =
    isWorkspace &&
    (state?.access !== "online" || state.cloudAvailable === false);
  const canViewDrafts = !isWorkspaceMember;
  const canAuthor = !isWorkspace || (!isWorkspaceMember && !workspaceReadOnly);

  if (!loading && organizationUnavailable) {
    return (
      <section
        className="agent-control-panel agent-control-organization-unavailable"
        aria-labelledby="agent-control-title"
      >
        <div className="agent-control-section-header">
          <div>
            <span className="agent-control-eyebrow">
              {t("navigation.organization.agentUnavailable.eyebrow")}
            </span>
            <h2 id="agent-control-title">
              {t("navigation.organization.agentUnavailable.title")}
            </h2>
            <p>{t("navigation.organization.agentUnavailable.description")}</p>
            <p className="agent-control-notice">
              {t("navigation.organization.agentUnavailable.boundary")}
            </p>
            <span className="agent-control-eyebrow">
              {t(`navigation.organization.roles.${context.role}`)}
            </span>
          </div>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => void load()}
            aria-label={t("agents.control.refresh")}
          >
            <Refresh size={14} />
          </button>
        </div>
      </section>
    );
  }

  return (
    <section
      className="agent-control-panel"
      aria-labelledby="agent-control-title"
    >
      <div className="agent-control-section-header">
        <div>
          <span className="agent-control-eyebrow">
            {t(
              isWorkspace
                ? "agents.control.workspaceSpace"
                : "agents.control.personalSpace",
            )}
          </span>
          <h2 id="agent-control-title">
            {t(
              isWorkspace
                ? "agents.control.workspaceSpaceTitle"
                : "agents.control.personalSpaceTitle",
            )}
          </h2>
          <p>
            {t(
              isWorkspace
                ? isWorkspaceMember
                  ? "agents.control.workspaceMemberSubtitle"
                  : "agents.control.workspaceAuthorSubtitle"
                : "agents.control.personalSpaceSubtitle",
            )}
          </p>
          {isWorkspace ? (
            <span className="agent-control-eyebrow">
              {t(`agents.control.role.${context.role}`)}
            </span>
          ) : null}
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
          {!isWorkspaceMember ? (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => setEditor("new")}
              disabled={!canAuthor}
            >
              <Plus size={14} />
              {t("agents.control.newAgent")}
            </button>
          ) : null}
        </div>
      </div>

      {state?.access === "offline" || state?.cloudAvailable === false ? (
        <div className="agent-control-notice">
          {t(
            isWorkspace
              ? "agents.control.workspaceOfflineNotice"
              : "agents.control.offlineNotice",
          )}
        </div>
      ) : null}
      {error && <div className="agents-create-error">{t(error)}</div>}

      {loading ? (
        <div className="agent-control-loading">
          <div className="loading-spinner" />
        </div>
      ) : (
        <div className="agent-control-columns">
          {canViewDrafts ? (
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
                      {t(
                        workspaceReadOnly
                          ? "agents.control.view"
                          : "agents.control.edit",
                      )}
                    </button>
                  </article>
                ))
              )}
            </section>
          ) : null}

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
                      disabled={!state?.cloudAvailable}
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
                      {isWorkspace ? (
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          onClick={() => setPromotionTarget(installation)}
                        >
                          {t(
                            "agents.control.experience.promoteLocalExperience",
                          )}
                        </button>
                      ) : null}
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

      {!loading && isWorkspace && state ? (
        <ExperienceCandidatePanel
          online={state.access === "online" && state.cloudAvailable}
          canReview={!isWorkspaceMember}
          contextKey={contextKey(state)}
          refreshToken={candidateRefreshToken}
          onDraftReady={(draft) => {
            setEditor(draft);
            setCandidateRefreshToken((value) => value + 1);
            void load();
          }}
        />
      ) : null}

      <AgentDraftEditor
        open={editor !== null}
        draft={editor === "new" ? null : editor}
        readOnly={workspaceReadOnly}
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

      {promotionTarget ? (
        <ExperiencePromotionDialog
          open
          installation={promotionTarget}
          agentName={definitionName(promotionTarget.definitionId)}
          online={state?.access === "online" && state.cloudAvailable === true}
          onClose={() => setPromotionTarget(null)}
          onSubmitted={() => {
            setPromotionTarget(null);
            setCandidateRefreshToken((value) => value + 1);
          }}
        />
      ) : null}

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
