import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentDraft,
  AgentDraftDetail,
  AgenteraAgentControlErrorCode,
  AgenteraAgentControlPublicState,
  AgenteraAgentDefinitionSummary,
  AgenteraAgentInstallationSummary,
  AgenteraAgentVersionSummary,
  OfficialAgentInstallPreview,
  OfficialAgentSummary,
  OfficialManagedUpdate,
} from "../../../../shared/agentera-agent-control";
import {
  Bot,
  Check,
  ChevronDown,
  Plus,
  Refresh,
  Search,
  Sparkles,
} from "../../assets/icons";
import ProfileAvatar from "../../components/common/ProfileAvatar";
import { useI18n } from "../../components/useI18n";
import AgentHubDetailDialog, {
  type AgentHubDetailAction,
} from "./AgentHubDetailDialog";
import AgentDraftEditor from "./AgentDraftEditor";
import ExperienceCandidatePanel from "./ExperienceCandidatePanel";
import ExperiencePromotionDialog from "./ExperiencePromotionDialog";
import AgentInstallDialog, {
  type AgentInstallProfileOption,
} from "./AgentInstallDialog";
import OrganizationSubmissionPanel from "./OrganizationSubmissionPanel";
import OfficialAgentInstallDialog from "./OfficialAgentInstallDialog";
import OfficialAgentSection from "./OfficialAgentSection";

export interface AgentControlProfileOption extends AgentInstallProfileOption {
  model?: string;
  provider?: string;
  skillCount?: number;
  gatewayRunning?: boolean;
  color?: string;
  avatar?: string | null;
  agentInstallationId?: string | null;
  runtimeProfileId?: string | null;
}

export interface AgentControlPanelProps {
  profiles: AgentControlProfileOption[];
  initialTab?: "official" | "mine";
  advancedOpenByDefault?: boolean;
  onChatWithProfile?: (profileId: string) => void;
  onEditProfile?: (profileId: string) => void;
  onCreateLocalProfile?: () => void;
  onProfilesChanged?: () => void | Promise<void>;
  profileSyncLabel?: string | null;
  profileSyncTitle?: string;
  profileSyncEnabled?: boolean;
  profileSyncing?: boolean;
  onSyncProfiles?: () => void;
}

interface PersonalAgentCard {
  key: string;
  name: string;
  description: string;
  tags: string[];
  draft: AgentDraft | null;
  definition: AgenteraAgentDefinitionSummary | null;
  installation: AgenteraAgentInstallationSummary | null;
  profile: AgentControlProfileOption | null;
  iconSrc: string | null;
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
  }
}

function plainSummary(value: string, fallback: string): string {
  const normalized = value
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[`*_>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return fallback;
  const characters = Array.from(normalized);
  return characters.length > 150
    ? `${characters.slice(0, 149).join("")}…`
    : normalized;
}

function draftIconDataUrl(draft: AgentDraft | null): string | null {
  return draft?.icon
    ? `data:${draft.icon.mediaType};base64,${draft.icon.dataBase64}`
    : null;
}

export default function AgentControlPanel({
  profiles,
  initialTab = "mine",
  advancedOpenByDefault = true,
  onChatWithProfile,
  onEditProfile,
  onCreateLocalProfile,
  onProfilesChanged,
  profileSyncLabel = null,
  profileSyncTitle,
  profileSyncEnabled = false,
  profileSyncing = false,
  onSyncProfiles,
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
  const [officialAgents, setOfficialAgents] = useState<OfficialAgentSummary[]>(
    [],
  );
  const [officialUpdates, setOfficialUpdates] = useState<
    OfficialManagedUpdate[]
  >([]);
  const [officialInstallPreview, setOfficialInstallPreview] =
    useState<OfficialAgentInstallPreview | null>(null);
  const [busyOfficialInstallationId, setBusyOfficialInstallationId] = useState<
    string | null
  >(null);
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
  const [organizationRefreshToken, setOrganizationRefreshToken] = useState(0);
  const [archiving, setArchiving] = useState(false);
  const [activeTab, setActiveTab] = useState<"official" | "mine">(initialTab);
  const [query, setQuery] = useState("");
  const [officialFilter, setOfficialFilter] = useState<
    "all" | "installed" | "updates"
  >("all");
  const [mineFilter, setMineFilter] = useState<"all" | "ready" | "drafts">(
    "all",
  );
  const [advancedOpen, setAdvancedOpen] = useState(advancedOpenByDefault);
  const [selectedPersonalKey, setSelectedPersonalKey] = useState<string | null>(
    null,
  );
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
      const canListInstallations =
        nextState.context.scope !== "ORGANIZATION" ||
        nextState.context.role !== "auditor";
      let nextInstallations: AgenteraAgentInstallationSummary[] = [];
      if (canListInstallations) {
        const installationResult =
          await window.agenteraAgents.listInstallations();
        if (epoch !== loadEpoch.current) return;
        if (!installationResult.ok) {
          setError(errorKey(installationResult.errorCode));
          return;
        }
        nextInstallations = installationResult.data;
      }
      const workspaceMemberInstallOnly =
        nextState.context.scope === "WORKSPACE" &&
        nextState.context.role === "member";
      const organizationCanReadDrafts =
        nextState.context.scope === "ORGANIZATION" &&
        (nextState.context.role === "owner" ||
          nextState.context.role === "admin");
      const canReadDrafts =
        nextState.context.scope === "ORGANIZATION"
          ? organizationCanReadDrafts
          : !workspaceMemberInstallOnly;
      let nextDrafts: AgentDraft[] = [];
      if (canReadDrafts) {
        const draftResult = await window.agenteraAgents.listDrafts();
        if (epoch !== loadEpoch.current) return;
        if (!draftResult.ok) {
          setError(errorKey(draftResult.errorCode));
          return;
        }
        nextDrafts = draftResult.data;
      }

      let nextDefinitions: AgenteraAgentDefinitionSummary[] = [];
      let nextOfficialAgents: OfficialAgentSummary[] = [];
      let nextOfficialUpdates: OfficialManagedUpdate[] = [];
      let nextError: string | null = null;
      if (nextState.access === "online" && nextState.cloudAvailable) {
        const definitionResult = await window.agenteraAgents.listDefinitions();
        if (epoch !== loadEpoch.current) return;
        if (!definitionResult.ok) {
          nextError = errorKey(definitionResult.errorCode);
        } else {
          nextDefinitions = definitionResult.data;
        }
        if (canListInstallations) {
          const officialResult =
            await window.agenteraAgents.listOfficialAgents();
          if (epoch !== loadEpoch.current) return;
          if (!officialResult.ok) {
            nextError = errorKey(officialResult.errorCode);
          } else {
            nextOfficialAgents = officialResult.data;
          }
          const updateResult =
            await window.agenteraAgents.refreshOfficialUpdates();
          if (epoch !== loadEpoch.current) return;
          if (!updateResult.ok) {
            nextError = errorKey(updateResult.errorCode);
          } else {
            nextOfficialUpdates = updateResult.data;
          }
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
        setOfficialInstallPreview(null);
        setBusyOfficialInstallationId(null);
      }
      selectedContextKey.current = nextContextKey;
      setState(nextState);
      setDrafts(nextDrafts);
      setInstallations(nextInstallations);
      setDefinitions(nextDefinitions);
      setOfficialAgents(nextOfficialAgents);
      setOfficialUpdates(nextOfficialUpdates);
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
      setOfficialInstallPreview(null);
      setBusyOfficialInstallationId(null);
      setCandidateRefreshToken((value) => value + 1);
      setOrganizationRefreshToken((value) => value + 1);
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

  const requestOfficialInstall = async (
    definitionId: string,
  ): Promise<void> => {
    setError(null);
    const result =
      await window.agenteraAgents.prepareOfficialInstall(definitionId);
    if (!result.ok) {
      setError(errorKey(result.errorCode));
      return;
    }
    setOfficialInstallPreview(result.data);
  };

  const applyOfficialUpdate = async (installationId: string): Promise<void> => {
    if (busyOfficialInstallationId) return;
    setBusyOfficialInstallationId(installationId);
    setError(null);
    const result =
      await window.agenteraAgents.applyOfficialUpdate(installationId);
    setBusyOfficialInstallationId(null);
    if (!result.ok) {
      setError(errorKey(result.errorCode));
      return;
    }
    await load();
  };

  const definitionNames = useMemo(
    () => new Map(definitions.map((item) => [item.id, item.displayName])),
    [definitions],
  );
  const definitionName = useCallback(
    (definitionId: string): string =>
      definitionNames.get(definitionId) ?? t("agents.control.installedLocally"),
    [definitionNames, t],
  );

  const context = state?.context ?? ({ scope: "USER" } as const);
  const isWorkspace = context.scope === "WORKSPACE";
  const isOrganization = context.scope === "ORGANIZATION";
  const isWorkspaceMember = isWorkspace && context.role === "member";
  const workspaceReadOnly =
    isWorkspace &&
    (state?.access !== "online" || state.cloudAvailable === false);
  const organizationOnline =
    isOrganization &&
    state?.access === "online" &&
    state.cloudAvailable === true;
  const organizationCanAuthor =
    organizationOnline &&
    (context.role === "owner" || context.role === "admin");
  const organizationCanReadReview = isOrganization && context.role !== "member";
  const organizationCanReview = organizationCanAuthor;
  const organizationCanInstall =
    organizationOnline && context.role !== "auditor";
  const organizationCanSeeInstallations =
    !isOrganization || context.role !== "auditor";
  const organizationCanViewDrafts =
    isOrganization && (context.role === "owner" || context.role === "admin");
  const organizationReadOnly = isOrganization && !organizationCanAuthor;
  const canViewDrafts = isOrganization
    ? organizationCanViewDrafts
    : !isWorkspaceMember;
  const canAuthor = isOrganization
    ? organizationCanAuthor
    : !isWorkspace || (!isWorkspaceMember && !workspaceReadOnly);
  const showNewDraft = isOrganization
    ? organizationCanAuthor
    : !isWorkspaceMember;
  const draftReadOnly = workspaceReadOnly || organizationReadOnly;
  const officialInstallations = installations.filter(
    (installation) => installation.sourceScope === "PLATFORM",
  );
  const scopedInstallations = installations.filter(
    (installation) => installation.sourceScope !== "PLATFORM",
  );
  const officialOnline =
    state?.access === "online" &&
    state.cloudAvailable === true &&
    organizationCanSeeInstallations;

  const personalCards = useMemo(() => {
    const result: PersonalAgentCard[] = [];
    const representedDrafts = new Set<string>();
    const representedInstallations = new Set<string>();
    const installationByDefinition = new Map(
      scopedInstallations.map((installation) => [
        installation.definitionId,
        installation,
      ]),
    );
    const profileByInstallation = new Map(
      profiles
        .filter((profile) => profile.agentInstallationId)
        .map((profile) => [profile.agentInstallationId!, profile]),
    );
    const draftByDefinition = new Map<string, AgentDraft>();
    for (const draft of drafts) {
      const definitionId =
        draft.publishedRevision?.definitionId ?? draft.sourceAgentDefinitionId;
      if (definitionId) draftByDefinition.set(definitionId, draft);
    }

    const sourceTag = (
      installation: AgenteraAgentInstallationSummary | null,
    ): string =>
      installation?.sourceScope === "WORKSPACE"
        ? t("agents.hub.workspaceAgent")
        : installation?.sourceScope === "ORGANIZATION"
          ? t("agents.hub.organizationAgent")
          : isWorkspace
            ? t("agents.hub.workspaceAgent")
            : isOrganization
              ? t("agents.hub.organizationAgent")
              : t("agents.hub.personalAgent");

    for (const definition of definitions) {
      const draft = draftByDefinition.get(definition.id) ?? null;
      const installation = installationByDefinition.get(definition.id) ?? null;
      const profile = installation
        ? (profileByInstallation.get(installation.id) ?? null)
        : null;
      if (draft) representedDrafts.add(draft.id);
      if (installation) representedInstallations.add(installation.id);
      const tags = [sourceTag(installation), t("agents.hub.published")];
      if (installation?.status === "active")
        tags.push(t("agents.hub.installed"));
      if (installation?.status === "pending")
        tags.push(t("agents.hub.pending"));
      if (profile?.model)
        tags.push(profile.model.split("/").pop() ?? profile.model);
      result.push({
        key: `definition:${definition.id}`,
        name: definition.displayName,
        description: draft
          ? plainSummary(
              draft.manifest.identity.systemPrompt,
              t("agents.hub.personalCardFallback"),
            )
          : t("agents.hub.publishedCardDescription"),
        tags: tags.slice(0, 4),
        draft,
        definition,
        installation,
        profile,
        iconSrc: draftIconDataUrl(draft),
      });
    }

    for (const draft of drafts) {
      if (representedDrafts.has(draft.id)) continue;
      result.push({
        key: `draft:${draft.id}`,
        name: draft.displayName,
        description: plainSummary(
          draft.manifest.identity.systemPrompt,
          t("agents.hub.personalCardFallback"),
        ),
        tags: [
          sourceTag(null),
          draft.publishedRevision
            ? t("agents.hub.published")
            : t("agents.hub.localDraft"),
        ],
        draft,
        definition: null,
        installation: null,
        profile: null,
        iconSrc: draftIconDataUrl(draft),
      });
    }

    for (const installation of scopedInstallations) {
      if (representedInstallations.has(installation.id)) continue;
      const profile = profileByInstallation.get(installation.id) ?? null;
      result.push({
        key: `installation:${installation.id}`,
        name: profile?.name ?? definitionName(installation.definitionId),
        description:
          installation.status === "active"
            ? t("agents.hub.installedCardDescription")
            : t("agents.hub.pendingCardDescription"),
        tags: [
          sourceTag(installation),
          installation.status === "active"
            ? t("agents.hub.installed")
            : t("agents.hub.pending"),
        ],
        draft: null,
        definition: null,
        installation,
        profile,
        iconSrc: null,
      });
    }

    return result;
  }, [
    definitions,
    definitionName,
    drafts,
    isOrganization,
    isWorkspace,
    profiles,
    scopedInstallations,
    t,
  ]);

  const filteredPersonalCards = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return personalCards.filter((card) => {
      if (
        normalizedQuery &&
        !`${card.name} ${card.description}`
          .toLocaleLowerCase()
          .includes(normalizedQuery)
      ) {
        return false;
      }
      if (mineFilter === "ready") return card.profile !== null;
      if (mineFilter === "drafts") {
        return Boolean(card.draft && !card.draft.publishedRevision);
      }
      return true;
    });
  }, [mineFilter, personalCards, query]);

  const hasSearchQuery = query.trim().length > 0;
  const personalEmptyTitle = hasSearchQuery
    ? "agents.hub.noSearchResults"
    : personalCards.length > 0
      ? "agents.hub.noFilteredResults"
      : "agents.hub.noPersonalAgents";
  const personalEmptyHint = hasSearchQuery
    ? "agents.hub.noSearchResultsHint"
    : personalCards.length > 0
      ? "agents.hub.noFilteredResultsHint"
      : "agents.hub.noPersonalAgentsHint";

  const selectedPersonal =
    personalCards.find((card) => card.key === selectedPersonalKey) ?? null;

  let selectedPersonalPrimary: AgentHubDetailAction | null = null;
  const selectedPersonalExtra: AgentHubDetailAction[] = [];
  if (selectedPersonal) {
    if (selectedPersonal.profile && onChatWithProfile) {
      selectedPersonalPrimary = {
        label: t("agents.hub.useAgent"),
        kind: "chat",
        onClick: () => {
          onChatWithProfile(selectedPersonal.profile!.id);
          setSelectedPersonalKey(null);
        },
      };
    } else if (selectedPersonal.draft) {
      selectedPersonalPrimary = {
        label: t(draftReadOnly ? "agents.control.view" : "agents.control.edit"),
        onClick: () => {
          void editDraft(selectedPersonal.draft!.id);
          setSelectedPersonalKey(null);
        },
      };
    } else if (selectedPersonal.installation?.status === "pending") {
      selectedPersonalPrimary = {
        label: t("agents.control.retry"),
        disabled: !state?.cloudAvailable,
        onClick: () => {
          const installation = selectedPersonal.installation!;
          setInstallDialog({
            mode: "retry",
            definitionId: installation.definitionId,
            versionId: installation.selectedVersionId,
            installation,
            versions: [],
          });
          setSelectedPersonalKey(null);
        },
      };
    } else if (selectedPersonal.definition?.latestVersionId) {
      selectedPersonalPrimary = {
        label: t("agents.hub.installAgent"),
        disabled: !state?.cloudAvailable,
        onClick: () => {
          requestInstall({
            definitionId: selectedPersonal.definition!.id,
            versionId: selectedPersonal.definition!.latestVersionId!,
          });
          setSelectedPersonalKey(null);
        },
      };
    }
    if (selectedPersonal.profile && onEditProfile) {
      selectedPersonalExtra.push({
        label: t("agents.hub.editAppearance"),
        onClick: () => {
          onEditProfile(selectedPersonal.profile!.id);
          setSelectedPersonalKey(null);
        },
      });
    }
    if (selectedPersonal.draft && selectedPersonal.profile && !draftReadOnly) {
      selectedPersonalExtra.push({
        label: t("agents.control.edit"),
        onClick: () => {
          void editDraft(selectedPersonal.draft!.id);
          setSelectedPersonalKey(null);
        },
      });
    }
    if (selectedPersonal.installation?.status === "active") {
      selectedPersonalExtra.push(
        {
          label: t("agents.control.update"),
          disabled: !state?.cloudAvailable,
          onClick: () => void requestUpdate(selectedPersonal.installation!),
        },
        {
          label: t("agents.control.archive"),
          disabled: !state?.cloudAvailable,
          onClick: () => {
            setArchiveTarget(selectedPersonal.installation!);
            setSelectedPersonalKey(null);
          },
        },
      );
    }
  }

  return (
    <section className="agent-hub-shell" aria-labelledby="agent-control-title">
      <header className="agent-hub-toolbar">
        <div className="agent-hub-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "official"}
            className={activeTab === "official" ? "active" : ""}
            onClick={() => {
              setActiveTab("official");
              setQuery("");
            }}
          >
            <Sparkles size={17} />
            {t("agents.hub.officialTab")}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "mine"}
            className={activeTab === "mine" ? "active" : ""}
            onClick={() => {
              setActiveTab("mine");
              setQuery("");
            }}
          >
            <Bot size={17} />
            {t("agents.hub.mineTab")}
          </button>
        </div>
        <div className="agent-hub-toolbar-actions">
          <label className="agent-hub-search">
            <Search size={16} />
            <input
              value={query}
              aria-label={t("agents.hub.searchPlaceholder")}
              placeholder={t("agents.hub.searchPlaceholder")}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <button
            type="button"
            className="agent-hub-icon-button"
            onClick={() => void load()}
            disabled={loading}
            aria-label={t("agents.control.refresh")}
          >
            <Refresh size={16} />
          </button>
          {activeTab === "mine" && showNewDraft ? (
            <button
              type="button"
              className="btn btn-primary btn-sm agent-hub-create-button"
              onClick={() => setEditor("new")}
              disabled={!canAuthor}
            >
              <Plus size={15} />
              {t(
                isOrganization
                  ? "agents.control.organization.newDraft"
                  : "agents.control.newAgent",
              )}
            </button>
          ) : null}
        </div>
      </header>

      {state?.access === "offline" || state?.cloudAvailable === false ? (
        <div className="agent-hub-notice">
          <span className="agent-hub-notice-dot" />
          <div>
            <strong>{t("agents.hub.offlineTitle")}</strong>
            <p>
              {t(
                isOrganization
                  ? "agents.control.organization.cachedReadOnly"
                  : isWorkspace
                    ? "agents.control.workspaceOfflineNotice"
                    : "agents.control.offlineNotice",
              )}
            </p>
          </div>
        </div>
      ) : null}
      {error ? <div className="agents-create-error">{t(error)}</div> : null}

      {loading ? (
        <div className="agent-hub-loading">
          <div className="loading-spinner" />
        </div>
      ) : activeTab === "official" ? (
        <div className="agent-hub-page" role="tabpanel">
          <div className="agent-hub-page-heading">
            <div>
              <h2 id="agent-control-title">{t("agents.hub.officialTitle")}</h2>
              <p>{t("agents.hub.officialSubtitle")}</p>
            </div>
            <div
              className="agent-hub-filters"
              aria-label={t("agents.hub.filters")}
            >
              {(["all", "installed", "updates"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  className={officialFilter === value ? "active" : ""}
                  onClick={() => setOfficialFilter(value)}
                >
                  {t(`agents.hub.officialFilter.${value}`)}
                </button>
              ))}
            </div>
          </div>
          {organizationCanSeeInstallations ? (
            <OfficialAgentSection
              online={officialOnline}
              agents={officialAgents}
              installations={officialInstallations}
              updates={officialUpdates}
              profiles={profiles}
              query={query}
              filter={officialFilter}
              busyInstallationId={busyOfficialInstallationId}
              onInstall={(definitionId) =>
                void requestOfficialInstall(definitionId)
              }
              onApplyUpdate={(installationId) =>
                void applyOfficialUpdate(installationId)
              }
              onChatWithProfile={onChatWithProfile}
            />
          ) : (
            <div className="agent-hub-empty agent-hub-empty-compact">
              <div className="agent-hub-empty-icon">
                <Sparkles size={28} />
              </div>
              <strong>{t("agents.hub.officialUnavailable")}</strong>
            </div>
          )}
        </div>
      ) : (
        <div className="agent-hub-page" role="tabpanel">
          <div className="agent-hub-page-heading">
            <div>
              <div className="agent-hub-title-row">
                <h2 id="agent-control-title">
                  {t(
                    isOrganization
                      ? "agents.control.organization.title"
                      : isWorkspace
                        ? "agents.control.workspaceSpaceTitle"
                        : "agents.control.personalSpaceTitle",
                  )}
                </h2>
                {isWorkspace || isOrganization ? (
                  <span>{t(`agents.control.role.${context.role}`)}</span>
                ) : null}
              </div>
              <p>
                {t(
                  isOrganization
                    ? "agents.hub.organizationSubtitle"
                    : isWorkspace
                      ? "agents.hub.workspaceSubtitle"
                      : "agents.hub.mineSubtitle",
                )}
              </p>
            </div>
            <div
              className="agent-hub-filters"
              aria-label={t("agents.hub.filters")}
            >
              {(["all", "ready", "drafts"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  className={mineFilter === value ? "active" : ""}
                  onClick={() => setMineFilter(value)}
                >
                  {t(`agents.hub.mineFilter.${value}`)}
                </button>
              ))}
            </div>
          </div>

          {filteredPersonalCards.length === 0 ? (
            <div className="agent-hub-empty">
              <div className="agent-hub-empty-icon">
                <Bot size={30} />
              </div>
              <strong>{t(personalEmptyTitle)}</strong>
              <p>{t(personalEmptyHint)}</p>
              {!hasSearchQuery && personalCards.length === 0 && showNewDraft ? (
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={!canAuthor}
                  onClick={() => setEditor("new")}
                >
                  <Plus size={16} />
                  {t("agents.hub.createAgent")}
                </button>
              ) : null}
            </div>
          ) : (
            <div className="agent-hub-grid" data-testid="personal-agent-grid">
              {filteredPersonalCards.map((card) => (
                <button
                  key={card.key}
                  type="button"
                  className="agent-hub-card"
                  onClick={() => setSelectedPersonalKey(card.key)}
                >
                  <div className="agent-hub-card-heading">
                    <div
                      className="agent-hub-card-avatar"
                      style={{ color: card.profile?.color }}
                    >
                      {card.iconSrc ? (
                        <img src={card.iconSrc} alt="" />
                      ) : card.profile ? (
                        <ProfileAvatar
                          name={card.profile.id}
                          color={card.profile.color}
                          avatar={card.profile.avatar}
                          size={46}
                        />
                      ) : (
                        <Bot size={24} />
                      )}
                    </div>
                    <div className="agent-hub-card-title-group">
                      <strong>{card.name}</strong>
                      <span>{card.tags[0]}</span>
                    </div>
                    {card.profile ? (
                      <span className="agent-hub-card-state installed">
                        <Check size={12} />
                        {t("agents.hub.ready")}
                      </span>
                    ) : null}
                  </div>
                  <p>{card.description}</p>
                  <div className="agent-hub-card-tags">
                    {card.tags.slice(1).map((tag) => (
                      <span key={tag}>{tag}</span>
                    ))}
                  </div>
                </button>
              ))}
            </div>
          )}

          <section
            className={`agent-hub-advanced ${advancedOpen ? "open" : ""}`}
          >
            <button
              type="button"
              className="agent-hub-advanced-toggle"
              aria-expanded={advancedOpen}
              onClick={() => setAdvancedOpen((value) => !value)}
            >
              <span>
                <strong>{t("agents.hub.advancedTitle")}</strong>
                <small>{t("agents.hub.advancedSubtitle")}</small>
              </span>
              <ChevronDown size={18} />
            </button>
            {advancedOpen ? (
              <div className="agent-hub-advanced-body">
                <section className="agent-hub-local-profiles">
                  <div className="agent-control-group-title">
                    <div>
                      <h3>{t("agents.legacyTitle")}</h3>
                      <p>{t("agents.legacySubtitle")}</p>
                    </div>
                    <div className="agent-control-inline-actions">
                      {profileSyncLabel ? (
                        <span
                          className="agent-hub-sync-status"
                          title={profileSyncTitle}
                        >
                          {profileSyncLabel}
                        </span>
                      ) : null}
                      {onSyncProfiles && profileSyncEnabled ? (
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={onSyncProfiles}
                          disabled={profileSyncing}
                        >
                          {profileSyncing
                            ? t("agents.syncing")
                            : t("agents.sync")}
                        </button>
                      ) : null}
                      <span className="agent-hub-legacy-badge">
                        {t("agents.legacyAccountSyncLabel")}
                      </span>
                      {onCreateLocalProfile ? (
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={onCreateLocalProfile}
                        >
                          <Plus size={14} />
                          {t("agents.legacyNewProfile")}
                        </button>
                      ) : null}
                    </div>
                  </div>
                  {profiles.length > 0 ? (
                    <div
                      className="agent-hub-profile-list"
                      data-testid="local-runtime-profiles"
                    >
                      {profiles.map((profile) => (
                        <article
                          key={profile.id}
                          className="agent-hub-profile-row"
                        >
                          <ProfileAvatar
                            name={profile.id}
                            color={profile.color}
                            avatar={profile.avatar}
                            size={34}
                          />
                          <div className="agent-hub-profile-copy">
                            <strong>{profile.name}</strong>
                            <span>
                              {profile.model
                                ? (profile.model.split("/").pop() ??
                                  profile.model)
                                : t("agents.noModel")}
                              {profile.gatewayRunning
                                ? ` · ${t("agents.running")}`
                                : ""}
                            </span>
                          </div>
                          <div className="agent-control-inline-actions">
                            {onEditProfile ? (
                              <button
                                type="button"
                                className="btn btn-secondary btn-sm"
                                onClick={() => onEditProfile(profile.id)}
                              >
                                {t("agents.hub.editAppearance")}
                              </button>
                            ) : null}
                            {onChatWithProfile ? (
                              <button
                                type="button"
                                className="btn btn-primary btn-sm"
                                onClick={() => onChatWithProfile(profile.id)}
                              >
                                {t("agents.hub.useAgent")}
                              </button>
                            ) : null}
                          </div>
                        </article>
                      ))}
                    </div>
                  ) : null}
                </section>

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
                          <article
                            key={draft.id}
                            className="agent-control-card"
                          >
                            <div>
                              <strong>{draft.displayName}</strong>
                              <p>
                                {t("agents.control.revision")} {draft.revision}{" "}
                                ·{" "}
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
                                draftReadOnly
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
                        <article
                          key={definition.id}
                          className="agent-control-card"
                        >
                          <div>
                            <strong>{definition.displayName}</strong>
                            <p>{t("agents.control.immutableVersion")}</p>
                          </div>
                          {definition.latestVersionId &&
                          (!isOrganization || organizationCanInstall) ? (
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
                          ) : null}
                        </article>
                      ))
                    )}
                  </section>
                </div>

                {organizationCanSeeInstallations ? (
                  <section className="agent-control-group agent-control-installations">
                    <div className="agent-control-group-title">
                      <h3>{t("agents.control.installations")}</h3>
                      <span>{scopedInstallations.length}</span>
                    </div>
                    {scopedInstallations.length === 0 ? (
                      <p className="agent-control-empty">
                        {t("agents.control.noInstallations")}
                      </p>
                    ) : (
                      scopedInstallations.map((installation, index) => (
                        <article
                          key={`${installation.id}-${index}`}
                          className="agent-control-card agent-control-installation-card"
                        >
                          <div>
                            <strong>
                              {definitionName(installation.definitionId)}
                            </strong>
                            <p>
                              {installation.status === "pending"
                                ? t("agents.control.pendingInstallation")
                                : t("agents.control.installedLocally")}
                            </p>
                          </div>
                          <div className="agent-control-inline-actions">
                            {!isOrganization || organizationOnline ? (
                              <>
                                {installation.status === "pending" ? (
                                  <button
                                    type="button"
                                    className="btn btn-primary btn-sm"
                                    disabled={!state?.cloudAvailable}
                                    onClick={() =>
                                      setInstallDialog({
                                        mode: "retry",
                                        definitionId: installation.definitionId,
                                        versionId:
                                          installation.selectedVersionId,
                                        installation,
                                        versions: [],
                                      })
                                    }
                                  >
                                    {t("agents.control.retry")}
                                  </button>
                                ) : null}
                                {installation.status === "active" ? (
                                  <>
                                    {isWorkspace ? (
                                      <button
                                        type="button"
                                        className="btn btn-primary btn-sm"
                                        onClick={() =>
                                          setPromotionTarget(installation)
                                        }
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
                                      onClick={() =>
                                        void requestUpdate(installation)
                                      }
                                    >
                                      {t("agents.control.update")}
                                    </button>
                                    <button
                                      type="button"
                                      className="btn btn-secondary btn-sm"
                                      disabled={!state?.cloudAvailable}
                                      onClick={() =>
                                        setArchiveTarget(installation)
                                      }
                                    >
                                      {t("agents.control.archive")}
                                    </button>
                                  </>
                                ) : null}
                              </>
                            ) : null}
                          </div>
                        </article>
                      ))
                    )}
                  </section>
                ) : null}

                {isWorkspace && state ? (
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

                {isOrganization && organizationCanReadReview && state ? (
                  <OrganizationSubmissionPanel
                    online={organizationOnline}
                    canAuthor={organizationCanAuthor}
                    canReview={organizationCanReview}
                    contextKey={contextKey(state)}
                    refreshToken={organizationRefreshToken}
                    onChanged={() => void load()}
                  />
                ) : null}
              </div>
            ) : null}
          </section>
        </div>
      )}

      {selectedPersonal ? (
        <AgentHubDetailDialog
          open
          onClose={() => setSelectedPersonalKey(null)}
          name={selectedPersonal.name}
          eyebrow={selectedPersonal.tags[0] ?? t("agents.hub.personalAgent")}
          meta={
            selectedPersonal.profile
              ? t("agents.hub.ready")
              : selectedPersonal.draft
                ? t("agents.hub.localDraft")
                : t("agents.hub.published")
          }
          iconSrc={selectedPersonal.iconSrc}
          iconColor={selectedPersonal.profile?.color}
          description={selectedPersonal.description}
          tags={selectedPersonal.tags.slice(1)}
          examples={[
            t("agents.hub.exampleIntroduce", { name: selectedPersonal.name }),
            t("agents.hub.examplePlan"),
            t("agents.hub.exampleExecute"),
          ]}
          primaryAction={selectedPersonalPrimary}
          extraActions={selectedPersonalExtra}
        />
      ) : null}

      <AgentDraftEditor
        open={editor !== null}
        draft={editor === "new" ? null : editor}
        readOnly={draftReadOnly}
        publicationTarget={isOrganization ? "ORGANIZATION" : "DIRECT"}
        onClose={() => setEditor(null)}
        onSaved={() => void load()}
        onPublished={() => void load()}
        onOrganizationSubmitted={() => {
          setOrganizationRefreshToken((value) => value + 1);
          void load();
        }}
        onRequestInstall={requestInstall}
      />
      {installDialog && (
        <AgentInstallDialog
          open
          {...installDialog}
          profiles={profiles}
          onClose={() => setInstallDialog(null)}
          onCompleted={() => {
            void load();
            void onProfilesChanged?.();
          }}
        />
      )}
      {officialInstallPreview ? (
        <OfficialAgentInstallDialog
          open
          preview={officialInstallPreview}
          onClose={() => setOfficialInstallPreview(null)}
          onCompleted={() => {
            setOfficialInstallPreview(null);
            void load();
            void onProfilesChanged?.();
          }}
        />
      ) : null}

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
