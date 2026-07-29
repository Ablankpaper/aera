import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentDraft,
  AgentDraftDetail,
  AgenteraAgentControlErrorCode,
  AgenteraAgentControlPublicState,
  AgenteraAgentDefinitionSummary,
  AgenteraAgentInstallationSummary,
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
import OrganizationSubmissionPanel from "./OrganizationSubmissionPanel";
import OfficialAgentInstallDialog from "./OfficialAgentInstallDialog";
import OfficialAgentSection from "./OfficialAgentSection";

export interface AgentControlProfileOption {
  id: string;
  name: string;
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
  initialTab?: "official" | "mine" | "enterprise";
  advancedOpenByDefault?: boolean;
  onChatWithProfile?: (profileId: string) => void;
  onProfilesChanged?: () => unknown | Promise<unknown>;
  onAgentReady?: (installationId: string) => boolean | Promise<boolean>;
  modelProfileId?: string;
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
  origin: "definition" | "draft" | "installation" | "profile";
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

function automaticRuntimeName(
  displayName: string,
  definitionId: string,
  profiles: readonly AgentControlProfileOption[],
): string {
  const normalized = displayName.trim() || "Agent";
  if (!profiles.some((profile) => profile.name === normalized)) {
    return normalized;
  }
  return `${normalized}-${definitionId.slice(0, 8)}`;
}

export default function AgentControlPanel({
  profiles,
  initialTab = "mine",
  advancedOpenByDefault = true,
  onChatWithProfile,
  onProfilesChanged,
  onAgentReady,
  modelProfileId,
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
  const [notice, setNotice] = useState<string | null>(null);
  const [editor, setEditor] = useState<AgentDraftDetail | "new" | null>(null);
  const [archiveTarget, setArchiveTarget] =
    useState<AgenteraAgentInstallationSummary | null>(null);
  const [promotionTarget, setPromotionTarget] =
    useState<AgenteraAgentInstallationSummary | null>(null);
  const [candidateRefreshToken, setCandidateRefreshToken] = useState(0);
  const [organizationRefreshToken, setOrganizationRefreshToken] = useState(0);
  const [archiving, setArchiving] = useState(false);
  const [busyPersonalKey, setBusyPersonalKey] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<
    "official" | "mine" | "enterprise"
  >(initialTab);
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
  const organizationReadOnly = isOrganization && !organizationCanAuthor;
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

  useEffect(() => {
    if (state && !isOrganization && activeTab === "enterprise") {
      setActiveTab("mine");
    }
  }, [activeTab, isOrganization, state]);

  const finishAgentActivation = useCallback(
    async (installationId: string): Promise<void> => {
      await onProfilesChanged?.();
      const opened = onAgentReady ? await onAgentReady(installationId) : false;
      if (!opened) setNotice("agents.control.agentReadyManualOpen");
    },
    [onAgentReady, onProfilesChanged],
  );

  const activateAgent = useCallback(
    async (target: {
      key: string;
      displayName: string;
      definitionId: string;
      versionId: string;
      installation: AgenteraAgentInstallationSummary | null;
      profile: AgentControlProfileOption | null;
    }): Promise<void> => {
      if (busyPersonalKey) return;
      setBusyPersonalKey(target.key);
      setError(null);
      setNotice(null);
      try {
        if (
          target.installation?.status === "active" &&
          target.installation.selectedVersionId === target.versionId
        ) {
          if (target.profile && onChatWithProfile) {
            onChatWithProfile(target.profile.id);
          } else {
            await finishAgentActivation(target.installation.id);
          }
          return;
        }
        if (target.installation?.status === "active" && !target.profile) {
          await finishAgentActivation(target.installation.id);
          return;
        }
        const result =
          target.installation?.status === "pending"
            ? await window.agenteraAgents.retryPendingInstallation({
                id: target.installation.id,
                target: {
                  kind: "fresh",
                  profileName: automaticRuntimeName(
                    target.displayName,
                    target.definitionId,
                    profiles,
                  ),
                },
              })
            : target.installation?.status === "active" && target.profile
              ? await window.agenteraAgents.selectInstallationVersion({
                  id: target.installation.id,
                  versionId: target.versionId,
                  localProfileId: target.profile.id,
                })
              : await window.agenteraAgents.installVersion({
                  definitionId: target.definitionId,
                  versionId: target.versionId,
                  profileName: automaticRuntimeName(
                    target.displayName,
                    target.definitionId,
                    profiles,
                  ),
                });
        if (!result.ok) {
          setError(errorKey(result.errorCode));
          return;
        }
        setEditor(null);
        await load();
        await finishAgentActivation(result.data.id);
      } catch {
        setError("agents.control.errors.operation_failed");
      } finally {
        setBusyPersonalKey(null);
      }
    },
    [busyPersonalKey, finishAgentActivation, load, onChatWithProfile, profiles],
  );

  const personalCards = useMemo(() => {
    const result: PersonalAgentCard[] = [];
    const representedDrafts = new Set<string>();
    const representedInstallations = new Set<string>();
    const representedProfiles = new Set<string>();
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
      if (profile) representedProfiles.add(profile.id);
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
        origin: "definition",
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
        origin: "draft",
      });
    }

    for (const installation of scopedInstallations) {
      if (representedInstallations.has(installation.id)) continue;
      const profile = profileByInstallation.get(installation.id) ?? null;
      if (profile) representedProfiles.add(profile.id);
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
        origin: "installation",
      });
    }

    for (const profile of profiles) {
      if (representedProfiles.has(profile.id)) continue;
      const model = profile.model?.split("/").pop() ?? profile.model;
      result.push({
        key: `profile:${profile.id}`,
        name: profile.name,
        description: profile.model
          ? t("agents.hub.localProfileDescription", {
              model: model || profile.model,
              count: profile.skillCount ?? 0,
            })
          : t("agents.hub.localProfileNoModel"),
        tags: [
          t("agents.hub.localAgent"),
          t("agents.hub.ready"),
          ...(model ? [model] : []),
        ],
        draft: null,
        definition: null,
        installation: null,
        profile,
        iconSrc: null,
        origin: "profile",
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

  const requestInstall = useCallback(
    (target: {
      definitionId: string;
      versionId: string;
      displayName?: string;
    }): void => {
      const installation =
        scopedInstallations.find(
          (item) => item.definitionId === target.definitionId,
        ) ?? null;
      const profile = installation
        ? (profiles.find(
            (item) => item.agentInstallationId === installation.id,
          ) ?? null)
        : null;
      const displayName =
        target.displayName ?? definitionName(target.definitionId);
      void activateAgent({
        key: `definition:${target.definitionId}`,
        displayName,
        definitionId: target.definitionId,
        versionId: target.versionId,
        installation,
        profile,
      });
    },
    [activateAgent, definitionName, profiles, scopedInstallations],
  );

  const visiblePersonalCards = useMemo(() => {
    if (!isOrganization) return personalCards;
    if (activeTab === "enterprise") {
      return personalCards.filter((card) => card.origin !== "profile");
    }
    return personalCards.filter((card) => card.profile !== null);
  }, [activeTab, isOrganization, personalCards]);

  const filteredPersonalCards = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return visiblePersonalCards.filter((card) => {
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
  }, [mineFilter, query, visiblePersonalCards]);

  const hasSearchQuery = query.trim().length > 0;
  const personalEmptyTitle = hasSearchQuery
    ? "agents.hub.noSearchResults"
    : visiblePersonalCards.length > 0
      ? "agents.hub.noFilteredResults"
      : activeTab === "enterprise"
        ? "agents.hub.noEnterpriseAgents"
        : "agents.hub.noPersonalAgents";
  const personalEmptyHint = hasSearchQuery
    ? "agents.hub.noSearchResultsHint"
    : visiblePersonalCards.length > 0
      ? "agents.hub.noFilteredResultsHint"
      : activeTab === "enterprise"
        ? "agents.hub.noEnterpriseAgentsHint"
        : "agents.hub.noPersonalAgentsHint";

  const selectedPersonal =
    personalCards.find((card) => card.key === selectedPersonalKey) ?? null;

  let selectedPersonalPrimary: AgentHubDetailAction | null = null;
  const selectedPersonalExtra: AgentHubDetailAction[] = [];
  if (selectedPersonal) {
    const definitionId =
      selectedPersonal.definition?.id ??
      selectedPersonal.draft?.publishedRevision?.definitionId ??
      selectedPersonal.installation?.definitionId ??
      null;
    const versionId =
      selectedPersonal.definition?.latestVersionId ??
      selectedPersonal.draft?.publishedRevision?.versionId ??
      selectedPersonal.installation?.selectedVersionId ??
      null;
    if (selectedPersonal.profile && onChatWithProfile) {
      selectedPersonalPrimary = {
        label: t("agents.hub.useAgent"),
        kind: "chat",
        onClick: () => {
          onChatWithProfile(selectedPersonal.profile!.id);
          setSelectedPersonalKey(null);
        },
      };
    } else if (
      selectedPersonal.installation?.status === "pending" &&
      definitionId &&
      versionId
    ) {
      selectedPersonalPrimary = {
        label: t("agents.control.retryAgent"),
        disabled:
          !state?.cloudAvailable ||
          (isOrganization && !organizationCanInstall) ||
          busyPersonalKey === selectedPersonal.key,
        onClick: () => {
          void activateAgent({
            key: selectedPersonal.key,
            displayName: selectedPersonal.name,
            definitionId,
            versionId,
            installation: selectedPersonal.installation,
            profile: selectedPersonal.profile,
          });
          setSelectedPersonalKey(null);
        },
      };
    } else if (definitionId && versionId) {
      selectedPersonalPrimary = {
        label: t("agents.hub.useAgent"),
        disabled:
          !state?.cloudAvailable ||
          (isOrganization && !organizationCanInstall) ||
          busyPersonalKey === selectedPersonal.key,
        onClick: () => {
          void activateAgent({
            key: selectedPersonal.key,
            displayName: selectedPersonal.name,
            definitionId,
            versionId,
            installation: selectedPersonal.installation,
            profile: selectedPersonal.profile,
          });
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
    }
    if (
      selectedPersonal.draft &&
      selectedPersonalPrimary?.label !== t("agents.control.edit") &&
      !draftReadOnly
    ) {
      selectedPersonalExtra.push({
        label: t("agents.control.edit"),
        onClick: () => {
          void editDraft(selectedPersonal.draft!.id);
          setSelectedPersonalKey(null);
        },
      });
    }
    if (selectedPersonal.installation?.status === "active") {
      if (isWorkspace) {
        selectedPersonalExtra.push({
          label: t("agents.control.experience.promoteLocalExperience"),
          disabled: state?.access !== "online" || state.cloudAvailable !== true,
          onClick: () => {
            setPromotionTarget(selectedPersonal.installation!);
            setSelectedPersonalKey(null);
          },
        });
      }
      if (
        selectedPersonal.profile &&
        selectedPersonal.definition?.latestVersionId &&
        selectedPersonal.definition.latestVersionId !==
          selectedPersonal.installation.selectedVersionId
      ) {
        selectedPersonalExtra.push({
          label: t("agents.control.update"),
          disabled:
            !state?.cloudAvailable || busyPersonalKey === selectedPersonal.key,
          onClick: () =>
            void activateAgent({
              key: selectedPersonal.key,
              displayName: selectedPersonal.name,
              definitionId: selectedPersonal.installation!.definitionId,
              versionId: selectedPersonal.definition!.latestVersionId!,
              installation: selectedPersonal.installation,
              profile: selectedPersonal.profile,
            }),
        });
      }
      selectedPersonalExtra.push({
        label: t("agents.control.archive"),
        disabled: !state?.cloudAvailable,
        onClick: () => {
          setArchiveTarget(selectedPersonal.installation!);
          setSelectedPersonalKey(null);
        },
      });
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
              setSelectedPersonalKey(null);
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
              setSelectedPersonalKey(null);
            }}
          >
            <Bot size={17} />
            {t("agents.hub.mineTab")}
          </button>
          {isOrganization ? (
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "enterprise"}
              className={activeTab === "enterprise" ? "active" : ""}
              onClick={() => {
                setActiveTab("enterprise");
                setQuery("");
                setSelectedPersonalKey(null);
              }}
            >
              <Bot size={17} />
              {t("agents.hub.enterpriseTab")}
            </button>
          ) : null}
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
          {((activeTab === "mine" && !isOrganization) ||
            (activeTab === "enterprise" && isOrganization)) &&
          showNewDraft ? (
            <button
              type="button"
              className="btn btn-primary btn-sm agent-hub-create-button"
              onClick={() => setEditor("new")}
              disabled={!canAuthor}
            >
              <Plus size={15} />
              {t(
                activeTab === "enterprise"
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
      {notice ? <div className="agent-control-success">{t(notice)}</div> : null}

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
                    activeTab === "enterprise"
                      ? "agents.control.organization.title"
                      : isWorkspace
                        ? "agents.control.workspaceSpaceTitle"
                        : "agents.control.personalSpaceTitle",
                  )}
                </h2>
                {context.scope !== "USER" &&
                (isWorkspace || activeTab === "enterprise") ? (
                  <span>{t(`agents.control.role.${context.role}`)}</span>
                ) : null}
              </div>
              <p>
                {t(
                  isOrganization
                    ? activeTab === "enterprise"
                      ? "agents.hub.organizationSubtitle"
                      : "agents.hub.mineSubtitle"
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
              {!hasSearchQuery &&
              visiblePersonalCards.length === 0 &&
              showNewDraft &&
              (!isOrganization || activeTab === "enterprise") ? (
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

          {isWorkspace ||
          (isOrganization &&
            activeTab === "enterprise" &&
            organizationCanReadReview) ? (
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

                  {isOrganization &&
                  activeTab === "enterprise" &&
                  organizationCanReadReview &&
                  state ? (
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
          ) : null}
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
              : selectedPersonal.installation?.status === "pending"
                ? t("agents.hub.pending")
                : selectedPersonal.definition ||
                    selectedPersonal.draft?.publishedRevision
                  ? t("agents.hub.published")
                  : t("agents.hub.localDraft")
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
        modelProfileId={modelProfileId}
        onClose={() => setEditor(null)}
        onSaved={() => void load()}
        onPublished={() => void load()}
        onOrganizationSubmitted={() => {
          setOrganizationRefreshToken((value) => value + 1);
          void load();
        }}
        onRequestInstall={requestInstall}
      />
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
