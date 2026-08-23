import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentDraft,
  AgentDraftDetail,
  AgentCapabilityBindingConfiguration,
  ConfirmCapabilityBindingsInput,
  AgentRuntimeModelRouteSource,
  AgentRuntimeModelSelection,
  AgenteraAgentControlErrorCode,
  AgenteraAgentControlPublicState,
  AgenteraAgentDefinitionSummary,
  AgenteraAgentInstallationSummary,
  AgenteraAgentOperationScope,
  OfficialAgentSummary,
  OfficialManagedUpdate,
  DisconnectOrganizationSubmissionReferenceInput,
  OrganizationAgentSubmissionListItem,
  OrganizationSubmissionListIssue,
  OrganizationWithdrawalPreview,
} from "../../../../shared/agentera-agent-control";
import {
  Bot,
  Check,
  ChevronDown,
  Plus,
  Refresh,
  Search,
  Sparkles,
  Workflow,
} from "../../assets/icons";
import ProfileAvatar from "../../components/common/ProfileAvatar";
import { useI18n } from "../../components/useI18n";
import AgentHubDetailDialog, {
  type AgentHubDetailAction,
} from "./AgentHubDetailDialog";
import AgentDraftEditor from "./AgentDraftEditor";
import AgentCapabilityBindingDialog from "./AgentCapabilityBindingDialog";
import ExperienceCandidatePanel from "./ExperienceCandidatePanel";
import ExperiencePromotionDialog from "./ExperiencePromotionDialog";
import OrganizationExperienceCandidatePanel from "./OrganizationExperienceCandidatePanel";
import OrganizationSubmissionPanel from "./OrganizationSubmissionPanel";
import OfficialAgentSection from "./OfficialAgentSection";
import { deriveAgentLifecycle, type AgentLifecycle } from "./agentLifecycle";

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

export interface AgentChatOpenOptions {
  forceNewRun?: boolean;
}

export interface AgentControlPanelProps {
  profiles: AgentControlProfileOption[];
  runtimeModelRoutes?: AgentRuntimeModelRouteSource[];
  initialTab?: "official" | "mine" | "enterprise";
  advancedOpenByDefault?: boolean;
  onChatWithProfile?: (
    profileId: string,
    options?: AgentChatOpenOptions,
  ) => void;
  onProfilesChanged?: () => unknown | Promise<unknown>;
  onAgentReady?: (
    installationId: string,
    options?: AgentChatOpenOptions,
  ) => boolean | Promise<boolean>;
  onConfigureModels?: () => void;
  onOpenTeams?: () => void;
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
  submission: OrganizationAgentSubmissionListItem | null;
  lifecycle: AgentLifecycle | null;
  iconSrc: string | null;
  origin: "definition" | "draft" | "installation" | "profile";
}

interface AgentActivationTarget {
  key: string;
  displayName: string;
  definitionId: string;
  versionId: string;
  installation: AgenteraAgentInstallationSummary | null;
  profile: AgentControlProfileOption | null;
}

interface AgentRuntimeModelOption {
  id: string;
  provider: string;
  providerLabel: string;
  model: string;
  modelProfileId?: string;
  modelSelection?: AgentRuntimeModelSelection;
  sourceKind?: "account" | "legacy_agent";
}

interface AgentCardPresentation {
  tone: "ready" | "pending" | "attention";
  statusKey: string;
  primary: "chat" | "retry" | "configure_model" | "details";
}

function errorKey(code: AgenteraAgentControlErrorCode): string {
  return `agents.control.errors.${code}`;
}

export type AgentControlErrorAction = "retry" | "configure_model" | null;

const RETRYABLE_ERROR_KEYS = new Set([
  "agents.control.errors.cloud_unavailable",
  "agents.control.errors.online_required",
  "agents.control.errors.operation_failed",
  "agents.control.errors.model_route_stale",
  "agents.control.errors.capability_profile_unavailable",
  "agents.control.errors.local_runtime_required",
  "agents.control.errors.publication_cache_failed",
  "agents.control.errors.publication_cache_filesystem_denied",
  "agents.control.errors.publication_cache_filesystem_failed",
  "agents.control.errors.publication_cache_database_failed",
  "agents.control.errors.publication_cache_recovery_failed",
]);

export function agentControlErrorAction(
  error: string | null,
): AgentControlErrorAction {
  if (
    error === "agents.control.errors.profile_model_configuration_failed" ||
    error === "agents.control.errors.model_route_unavailable" ||
    error === "agents.hub.modelRequired"
  ) {
    return "configure_model";
  }
  return error !== null && RETRYABLE_ERROR_KEYS.has(error) ? "retry" : null;
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

export function isRunnableAgentProfile(
  profile: AgentControlProfileOption | null | undefined,
): profile is AgentControlProfileOption {
  if (!profile) return false;
  const provider = profile.provider?.trim().toLocaleLowerCase() ?? "";
  return (
    provider.length > 0 &&
    provider !== "auto" &&
    (profile.model?.trim().length ?? 0) > 0
  );
}

function publishedDraftAllowsModel(
  draft: AgentDraft,
  providerValue: string,
  modelValue: string,
  versionId: string,
): boolean {
  const published = draft.publishedRevision;
  if (
    !published ||
    published.revision !== draft.revision ||
    published.versionId !== versionId
  ) {
    return false;
  }
  const provider = providerValue.trim().toLocaleLowerCase();
  const model = modelValue.trim();
  return provider.length > 0 && provider !== "auto" && model.length > 0;
}

function automaticRuntimeName(
  _displayName: string,
  definitionId: string,
  profiles: readonly AgentControlProfileOption[],
): string {
  const base = `aera-agent-${definitionId.slice(0, 12).toLocaleLowerCase()}`;
  const existing = new Set(
    profiles.flatMap((profile) => [profile.id, profile.name]),
  );
  if (!existing.has(base)) {
    return base;
  }
  let suffix = 2;
  while (existing.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

export default function AgentControlPanel({
  profiles,
  runtimeModelRoutes,
  initialTab = "mine",
  advancedOpenByDefault = false,
  onChatWithProfile,
  onProfilesChanged,
  onAgentReady,
  onConfigureModels,
  onOpenTeams,
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
  const [organizationSubmissions, setOrganizationSubmissions] = useState<
    OrganizationAgentSubmissionListItem[]
  >([]);
  const [organizationSubmissionIssues, setOrganizationSubmissionIssues] =
    useState<OrganizationSubmissionListIssue[]>([]);
  const [officialAgents, setOfficialAgents] = useState<OfficialAgentSummary[]>(
    [],
  );
  const [officialUpdates, setOfficialUpdates] = useState<
    OfficialManagedUpdate[]
  >([]);
  const [busyOfficialInstallationId, setBusyOfficialInstallationId] = useState<
    string | null
  >(null);
  const [officialInstallBusy, setOfficialInstallBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editor, setEditor] = useState<AgentDraftDetail | "new" | null>(null);
  const [archiveTarget, setArchiveTarget] =
    useState<AgenteraAgentInstallationSummary | null>(null);
  const [draftActionTarget, setDraftActionTarget] = useState<{
    kind: "delete" | "discard";
    draftId: string;
  } | null>(null);
  const [withdrawal, setWithdrawal] =
    useState<OrganizationWithdrawalPreview | null>(null);
  const [promotionTarget, setPromotionTarget] =
    useState<AgenteraAgentInstallationSummary | null>(null);
  const [candidateRefreshToken, setCandidateRefreshToken] = useState(0);
  const [archiving, setArchiving] = useState(false);
  const [lifecycleBusy, setLifecycleBusy] = useState(false);
  const [busyPersonalKey, setBusyPersonalKey] = useState<string | null>(null);
  const [personalCardErrors, setPersonalCardErrors] = useState<
    Record<string, string>
  >({});
  const [capabilityBinding, setCapabilityBinding] =
    useState<AgentCapabilityBindingConfiguration | null>(null);
  const [capabilityBindingBusy, setCapabilityBindingBusy] = useState(false);
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
      const contextChanged =
        selectedContextKey.current !== null &&
        selectedContextKey.current !== nextContextKey;
      if (contextChanged) {
        selectedContextKey.current = nextContextKey;
        setState(nextState);
        setDrafts([]);
        setDefinitions([]);
        setInstallations([]);
        setOrganizationSubmissions([]);
        setOrganizationSubmissionIssues([]);
        setOfficialAgents([]);
        setOfficialUpdates([]);
        setEditor(null);
        setArchiveTarget(null);
        setDraftActionTarget(null);
        setWithdrawal(null);
        setPromotionTarget(null);
        setBusyOfficialInstallationId(null);
        setCapabilityBinding(null);
        setCapabilityBindingBusy(false);
        setSelectedPersonalKey(null);
        setPersonalCardErrors({});
      }
      let nextError: string | null = null;
      const operationScope: AgenteraAgentOperationScope | undefined =
        nextState.context.scope === "ORGANIZATION" && activeTab === "mine"
          ? "USER"
          : undefined;
      const canListInstallations =
        operationScope === "USER" ||
        nextState.context.scope !== "ORGANIZATION" ||
        nextState.context.role !== "auditor";
      const canListOfficialAgents =
        nextState.context.scope !== "ORGANIZATION" ||
        nextState.context.role !== "auditor";
      let nextInstallations: AgenteraAgentInstallationSummary[] = [];
      if (canListInstallations) {
        const installationResult =
          await window.agenteraAgents.listInstallations(operationScope);
        if (epoch !== loadEpoch.current) return;
        if (!installationResult.ok) {
          nextError ??= errorKey(installationResult.errorCode);
        } else {
          nextInstallations = installationResult.data;
        }
      }
      const workspaceMemberInstallOnly =
        nextState.context.scope === "WORKSPACE" &&
        nextState.context.role === "member";
      let nextOrganizationSubmissions: OrganizationAgentSubmissionListItem[] =
        [];
      let nextOrganizationSubmissionIssues: OrganizationSubmissionListIssue[] =
        [];
      const canReadOrganizationSubmissions =
        nextState.context.scope === "ORGANIZATION" &&
        activeTab === "enterprise" &&
        nextState.context.role !== "member" &&
        nextState.access === "online" &&
        nextState.cloudAvailable;
      if (canReadOrganizationSubmissions) {
        const submissionResult =
          await window.agenteraAgents.listOrganizationSubmissionList();
        if (epoch !== loadEpoch.current) return;
        if (!submissionResult.ok) {
          nextError ??= errorKey(submissionResult.errorCode);
        } else {
          nextOrganizationSubmissions = submissionResult.data.submissions;
          nextOrganizationSubmissionIssues = submissionResult.data.issues;
        }
      }
      const organizationCanReadDrafts =
        nextState.context.scope === "ORGANIZATION" &&
        (nextState.context.role === "owner" ||
          nextState.context.role === "admin");
      const canReadDrafts =
        operationScope === "USER"
          ? true
          : nextState.context.scope === "ORGANIZATION"
            ? organizationCanReadDrafts
            : !workspaceMemberInstallOnly;
      let nextDrafts: AgentDraft[] = [];
      if (canReadDrafts) {
        const draftResult =
          await window.agenteraAgents.listDrafts(operationScope);
        if (epoch !== loadEpoch.current) return;
        if (!draftResult.ok) {
          nextError ??= errorKey(draftResult.errorCode);
        } else {
          nextDrafts = draftResult.data;
        }
      }

      let nextDefinitions: AgenteraAgentDefinitionSummary[] = [];
      let nextOfficialAgents: OfficialAgentSummary[] = [];
      let nextOfficialUpdates: OfficialManagedUpdate[] = [];
      if (nextState.access === "online" && nextState.cloudAvailable) {
        const definitionResult =
          await window.agenteraAgents.listDefinitions(operationScope);
        if (epoch !== loadEpoch.current) return;
        if (!definitionResult.ok) {
          nextError ??= errorKey(definitionResult.errorCode);
        } else {
          nextDefinitions = definitionResult.data;
        }
        if (activeTab === "official" && canListOfficialAgents) {
          const officialResult =
            await window.agenteraAgents.listOfficialAgents();
          if (epoch !== loadEpoch.current) return;
          if (!officialResult.ok) {
            nextError ??= errorKey(officialResult.errorCode);
          } else {
            nextOfficialAgents = officialResult.data;
          }
          const updateResult =
            await window.agenteraAgents.refreshOfficialUpdates();
          if (epoch !== loadEpoch.current) return;
          if (!updateResult.ok) {
            nextError ??= errorKey(updateResult.errorCode);
          } else {
            nextOfficialUpdates = updateResult.data;
          }
        }
      }
      if (epoch !== loadEpoch.current) return;

      selectedContextKey.current = nextContextKey;
      setState(nextState);
      setDrafts(nextDrafts);
      setInstallations(nextInstallations);
      setOrganizationSubmissions(nextOrganizationSubmissions);
      setOrganizationSubmissionIssues(nextOrganizationSubmissionIssues);
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
  }, [activeTab]);

  useEffect(() => {
    void load();
    return window.agenteraAgents.onStateChanged(() => {
      setArchiveTarget(null);
      setDraftActionTarget(null);
      setWithdrawal(null);
      setPromotionTarget(null);
      setBusyOfficialInstallationId(null);
      setCapabilityBinding(null);
      setCapabilityBindingBusy(false);
      setCandidateRefreshToken((value) => value + 1);
      void load();
    });
  }, [load]);

  const editDraft = async (id: string): Promise<void> => {
    setError(null);
    const result = await window.agenteraAgents.getDraft(
      id,
      personalOperationScope,
    );
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
      personalOperationScope,
    );
    setArchiving(false);
    setArchiveTarget(null);
    if (!result.ok) {
      setError(errorKey(result.errorCode));
      return;
    }
    await load();
  };

  const confirmDraftAction = async (): Promise<void> => {
    if (!draftActionTarget || lifecycleBusy) return;
    setLifecycleBusy(true);
    setError(null);
    const result =
      draftActionTarget.kind === "delete"
        ? await window.agenteraAgents.deleteDraft(draftActionTarget.draftId)
        : await window.agenteraAgents.discardUnpublishedDraft(
            draftActionTarget.draftId,
          );
    setLifecycleBusy(false);
    setDraftActionTarget(null);
    if (!result.ok) {
      setError(errorKey(result.errorCode));
      return;
    }
    setSelectedPersonalKey(null);
    await load();
  };

  const prepareCardWithdrawal = async (submissionId: string): Promise<void> => {
    if (lifecycleBusy) return;
    setLifecycleBusy(true);
    setError(null);
    const result =
      await window.agenteraAgents.prepareOrganizationWithdrawal(submissionId);
    setLifecycleBusy(false);
    if (!result.ok) {
      setError(errorKey(result.errorCode));
      return;
    }
    setSelectedPersonalKey(null);
    setWithdrawal(result.data);
  };

  const confirmCardWithdrawal = async (): Promise<void> => {
    if (!withdrawal || lifecycleBusy) return;
    setLifecycleBusy(true);
    setError(null);
    const result = await window.agenteraAgents.confirmOrganizationWithdrawal({
      withdrawalHandle: withdrawal.withdrawalHandle,
      confirmation: "withdraw-organization-agent",
    });
    setLifecycleBusy(false);
    setWithdrawal(null);
    if (!result.ok) {
      setError(errorKey(result.errorCode));
      return;
    }
    await load();
  };

  const disconnectOrganizationSubmissionReference = async (
    input: DisconnectOrganizationSubmissionReferenceInput,
  ): ReturnType<
    typeof window.agenteraAgents.disconnectOrganizationSubmissionReference
  > => {
    const result =
      await window.agenteraAgents.disconnectOrganizationSubmissionReference(
        input,
      );
    if (result.ok) {
      setOrganizationSubmissions((current) =>
        current.map((submission) =>
          submission.id === result.data.id ? result.data : submission,
        ),
      );
    }
    return result;
  };

  const requestOfficialInstall = async (
    definitionId: string,
  ): Promise<void> => {
    if (officialInstallBusy) return;
    setOfficialInstallBusy(true);
    setError(null);
    try {
      const preview =
        await window.agenteraAgents.prepareOfficialInstall(definitionId);
      if (!preview.ok) {
        setError(errorKey(preview.errorCode));
        return;
      }
      const result = await window.agenteraAgents.confirmOfficialInstall({
        installHandle: preview.data.installHandle,
        confirmation: "install-official-agent",
      });
      if (!result.ok) {
        setError(errorKey(result.errorCode));
        return;
      }
      await load();
      await finishAgentActivation(result.data.id);
    } catch {
      setError("agents.control.errors.operation_failed");
    } finally {
      setOfficialInstallBusy(false);
    }
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

  const openNewDraft = (): void => {
    setEditor("new");
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
  const isPersonalAgentView = isOrganization && activeTab === "mine";
  const personalOperationScope: AgenteraAgentOperationScope | undefined =
    isPersonalAgentView ? "USER" : undefined;
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
  const canAuthor = isPersonalAgentView
    ? true
    : isOrganization
      ? organizationCanAuthor
      : !isWorkspace || (!isWorkspaceMember && !workspaceReadOnly);
  const showNewDraft = isPersonalAgentView
    ? true
    : isOrganization
      ? organizationCanAuthor
      : !isWorkspaceMember;
  const newDraftDisabled = loading || !canAuthor;
  const draftReadOnly =
    workspaceReadOnly || (!isPersonalAgentView && organizationReadOnly);
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
  const errorAction = agentControlErrorAction(error);
  const canSeeGovernance =
    (isWorkspace && !isWorkspaceMember) ||
    (isOrganization && activeTab === "enterprise" && context.role !== "member");

  useEffect(() => {
    if (state && !isOrganization && activeTab === "enterprise") {
      setActiveTab("mine");
    }
  }, [activeTab, isOrganization, state]);

  const finishAgentActivation = useCallback(
    async (
      installationId: string,
      options?: AgentChatOpenOptions,
    ): Promise<void> => {
      await onProfilesChanged?.();
      const opened = onAgentReady
        ? options
          ? await onAgentReady(installationId, options)
          : await onAgentReady(installationId)
        : false;
      if (!opened) setNotice("agents.control.agentReadyManualOpen");
    },
    [onAgentReady, onProfilesChanged],
  );

  const setPersonalCardError = (key: string, value: string | null): void => {
    setPersonalCardErrors((current) => {
      if (value === null) {
        if (!(key in current)) return current;
        const next = { ...current };
        delete next[key];
        return next;
      }
      return current[key] === value ? current : { ...current, [key]: value };
    });
  };

  const openCapabilityBinding = async (
    installationId: string,
  ): Promise<void> => {
    if (capabilityBindingBusy) return;
    setCapabilityBindingBusy(true);
    setError(null);
    const result =
      await window.agenteraAgents.listCapabilityBindings(installationId);
    setCapabilityBindingBusy(false);
    if (!result.ok) {
      setError(errorKey(result.errorCode));
      return;
    }
    setCapabilityBinding(result.data);
  };

  const confirmCapabilityBindings = async (
    input: ConfirmCapabilityBindingsInput,
  ): Promise<void> => {
    if (capabilityBindingBusy) return;
    setCapabilityBindingBusy(true);
    setError(null);
    const result = await window.agenteraAgents.confirmCapabilityBindings(input);
    setCapabilityBindingBusy(false);
    if (!result.ok) {
      setError(errorKey(result.errorCode));
      return;
    }
    setCapabilityBinding(null);
    await load();
    await finishAgentActivation(result.data.installation.id, {
      forceNewRun: true,
    });
  };

  const activateAgent = async (
    target: AgentActivationTarget & {
      modelProfileId?: string;
      modelSelection?: AgentRuntimeModelSelection;
    },
  ): Promise<void> => {
    if (busyPersonalKey) return;
    setBusyPersonalKey(target.key);
    setPersonalCardError(target.key, null);
    setNotice(null);
    try {
      let installation = target.installation;
      const explicitModelSelection = Boolean(
        target.modelSelection || target.modelProfileId,
      );
      const preserveActiveUserModel = Boolean(
        installation?.status === "active" &&
        installation.sourceScope === "USER" &&
        target.profile &&
        isRunnableAgentProfile(target.profile),
      );
      const sourceModelProfileId =
        target.modelSelection?.sourceProfileId ??
        target.modelProfileId ??
        (preserveActiveUserModel ? target.profile?.id : modelProfileId);
      const modelSourceInput = target.modelSelection
        ? { modelSelection: target.modelSelection }
        : sourceModelProfileId
          ? { modelProfileId: sourceModelProfileId }
          : {};
      const modelSelectionRequested = explicitModelSelection;
      let profileReady = isRunnableAgentProfile(target.profile);
      let forceNewRun = false;
      const alignActiveProfileVersion = async (
        activeInstallation: AgenteraAgentInstallationSummary,
        profile: AgentControlProfileOption,
        ready: boolean,
      ): Promise<{
        installation: AgenteraAgentInstallationSummary;
        profileReady: boolean;
        versionChanged: boolean;
      } | null> => {
        let aligned = activeInstallation;
        let versionChanged = false;
        if (aligned.selectedVersionId !== target.versionId) {
          const selected =
            await window.agenteraAgents.selectInstallationVersion(
              {
                id: aligned.id,
                versionId: target.versionId,
                localProfileId: profile.id,
              },
              personalOperationScope,
            );
          if (!selected.ok) {
            setPersonalCardError(target.key, errorKey(selected.errorCode));
            return null;
          }
          aligned = selected.data;
          versionChanged = true;
          setEditor(null);
          await load();
        }
        if (versionChanged || !ready || modelSelectionRequested) {
          if (!sourceModelProfileId) {
            setPersonalCardError(target.key, "agents.hub.modelRequired");
            return null;
          }
          const repaired = await window.agenteraAgents.repairInstallationModel(
            {
              id: aligned.id,
              localProfileId: profile.id,
              ...modelSourceInput,
            },
            personalOperationScope,
          );
          if (!repaired.ok) {
            setPersonalCardError(target.key, errorKey(repaired.errorCode));
            return null;
          }
          aligned = repaired.data;
          await onProfilesChanged?.();
          ready = true;
          forceNewRun = true;
        }
        return {
          installation: aligned,
          profileReady: ready,
          versionChanged,
        };
      };
      if (installation?.status === "active" && target.profile) {
        const aligned = await alignActiveProfileVersion(
          installation,
          target.profile,
          profileReady,
        );
        if (!aligned) return;
        installation = aligned.installation;
        profileReady = aligned.profileReady;
        if (profileReady && onChatWithProfile) {
          if (forceNewRun || aligned.versionChanged) {
            onChatWithProfile(target.profile.id, { forceNewRun: true });
          } else {
            onChatWithProfile(target.profile.id);
          }
        } else {
          await finishAgentActivation(installation.id);
        }
        return;
      }
      if (installation?.status === "active" && !target.profile) {
        await finishAgentActivation(installation.id);
        return;
      }
      if (
        installation?.status === "pending" &&
        installation.selectedVersionId !== target.versionId &&
        !target.profile
      ) {
        const archived = await window.agenteraAgents.archiveInstallation(
          installation.id,
          personalOperationScope,
        );
        if (!archived.ok) {
          setPersonalCardError(target.key, errorKey(archived.errorCode));
          return;
        }
        installation = null;
      }
      if (!sourceModelProfileId) {
        setPersonalCardError(target.key, "agents.hub.modelRequired");
        return;
      }
      const result =
        installation?.status === "pending"
          ? await window.agenteraAgents.retryPendingInstallation(
              {
                id: installation.id,
                target: target.profile
                  ? {
                      kind: "claim",
                      localProfileId: target.profile.id,
                      confirmation: "claim-existing-profile",
                    }
                  : {
                      kind: "fresh",
                      profileName: automaticRuntimeName(
                        target.displayName,
                        target.definitionId,
                        profiles,
                      ),
                      ...modelSourceInput,
                    },
              },
              personalOperationScope,
            )
          : await window.agenteraAgents.installVersion(
              {
                definitionId: target.definitionId,
                versionId: target.versionId,
                profileName: automaticRuntimeName(
                  target.displayName,
                  target.definitionId,
                  profiles,
                ),
                ...modelSourceInput,
              },
              personalOperationScope,
            );
      if (!result.ok) {
        setPersonalCardError(target.key, errorKey(result.errorCode));
        return;
      }
      installation = result.data;
      if (target.profile && installation.status === "active") {
        const aligned = await alignActiveProfileVersion(
          installation,
          target.profile,
          profileReady,
        );
        if (!aligned) return;
        installation = aligned.installation;
        forceNewRun = forceNewRun || aligned.versionChanged;
      }
      setEditor(null);
      await load();
      if (forceNewRun) {
        await finishAgentActivation(installation.id, { forceNewRun: true });
      } else {
        await finishAgentActivation(installation.id);
      }
    } catch {
      setPersonalCardError(
        target.key,
        "agents.control.errors.operation_failed",
      );
    } finally {
      setBusyPersonalKey(null);
    }
  };

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
    const submissionByDraft = new Map<
      string,
      OrganizationAgentSubmissionListItem
    >();
    for (const submission of organizationSubmissions) {
      if (submission.localDraftId === null) continue;
      const current = submissionByDraft.get(submission.localDraftId);
      if (
        current === undefined ||
        (submission.localDraftRevision ?? 0) >
          (current.localDraftRevision ?? 0) ||
        ((submission.localDraftRevision ?? 0) ===
          (current.localDraftRevision ?? 0) &&
          submission.revision > current.revision)
      ) {
        submissionByDraft.set(submission.localDraftId, submission);
      }
    }

    const lifecycleFor = (
      draft: AgentDraft | null,
      installation: AgenteraAgentInstallationSummary | null,
    ): {
      submission: OrganizationAgentSubmissionListItem | null;
      lifecycle: AgentLifecycle | null;
    } => {
      if (draft === null) return { submission: null, lifecycle: null };
      const submission = submissionByDraft.get(draft.id) ?? null;
      return {
        submission,
        lifecycle: deriveAgentLifecycle({
          draftRevision: draft.revision,
          publishedRevision: draft.publishedRevision?.revision ?? null,
          submissionStatus: submission?.status ?? null,
          hasInstallation: installation !== null,
        }),
      };
    };

    const lifecycleTag = (lifecycle: AgentLifecycle): string => {
      switch (lifecycle.state) {
        case "approved_current":
          return t("agents.control.organization.lifecycle.approvedCurrent");
        case "approved_dirty":
          return t("agents.control.organization.lifecycle.approvedDirty");
        case "local_only":
          return t("agents.control.organization.lifecycle.localOnly");
        case "pending":
          return t("agents.control.organization.lifecycle.pending");
        case "rejected":
          return t("agents.control.organization.lifecycle.rejected");
        case "withdrawn":
          return t("agents.control.organization.lifecycle.withdrawn");
        case "superseded":
          return t("agents.control.organization.lifecycle.superseded");
      }
    };

    const sourceTag = (
      installation: AgenteraAgentInstallationSummary | null,
    ): string =>
      installation?.sourceScope === "WORKSPACE"
        ? t("agents.hub.workspaceAgent")
        : installation?.sourceScope === "ORGANIZATION"
          ? t("agents.hub.organizationAgent")
          : isPersonalAgentView
            ? t("agents.hub.personalAgent")
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
      const { submission, lifecycle } = lifecycleFor(draft, installation);
      const tags = [
        sourceTag(installation),
        isOrganization && activeTab === "enterprise" && lifecycle
          ? lifecycleTag(lifecycle)
          : t("agents.hub.published"),
      ];
      if (installation?.status === "active")
        tags.push(t("agents.hub.installed"));
      if (installation?.status === "pending")
        tags.push(t("agents.hub.pending"));
      if (profile?.model)
        tags.push(profile.model.split("/").pop() ?? profile.model);
      result.push({
        key: `definition:${definition.id}`,
        name: definition.displayName,
        description:
          installation?.status === "pending" &&
          installation.retryCode === "profile_capability_configuration_required"
            ? t("agents.capabilityBinding.requiredState")
            : installation?.status === "pending" &&
                installation.retryCode === "profile_model_configuration_failed"
              ? t("agents.hub.modelCompatibilityPendingCardDescription")
              : draft
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
        submission,
        lifecycle,
        iconSrc: draftIconDataUrl(draft),
        origin: "definition",
      });
    }

    for (const draft of drafts) {
      if (representedDrafts.has(draft.id)) continue;
      const { submission, lifecycle } = lifecycleFor(draft, null);
      result.push({
        key: `draft:${draft.id}`,
        name: draft.displayName,
        description: plainSummary(
          draft.manifest.identity.systemPrompt,
          t("agents.hub.personalCardFallback"),
        ),
        tags: [
          sourceTag(null),
          isOrganization && activeTab === "enterprise" && lifecycle
            ? lifecycleTag(lifecycle)
            : draft.publishedRevision
              ? t("agents.hub.published")
              : t("agents.hub.localDraft"),
        ],
        draft,
        definition: null,
        installation: null,
        profile: null,
        submission,
        lifecycle,
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
            : installation.retryCode ===
                "profile_capability_configuration_required"
              ? t("agents.capabilityBinding.requiredState")
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
        submission: null,
        lifecycle: null,
        iconSrc: null,
        origin: "installation",
      });
    }

    for (const profile of profiles) {
      if (representedProfiles.has(profile.id)) continue;
      const model = profile.model?.split("/").pop() ?? profile.model;
      const runnable = isRunnableAgentProfile(profile);
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
          ...(runnable ? [t("agents.hub.ready")] : []),
          ...(model ? [model] : []),
        ],
        draft: null,
        definition: null,
        installation: null,
        profile,
        submission: null,
        lifecycle: null,
        iconSrc: null,
        origin: "profile",
      });
    }

    return result;
  }, [
    activeTab,
    definitions,
    definitionName,
    drafts,
    isOrganization,
    isPersonalAgentView,
    isWorkspace,
    organizationSubmissions,
    profiles,
    scopedInstallations,
    t,
  ]);

  const selectableModelProfiles = useMemo(() => {
    const runnable = profiles.filter(isRunnableAgentProfile);
    const ownerConfigured = runnable.filter(
      (profile) => !profile.agentInstallationId,
    );
    return ownerConfigured.length > 0 ? ownerConfigured : runnable;
  }, [profiles]);
  const capabilityProfiles = useMemo(
    () =>
      profiles.map((profile) => ({
        profileHandle: profile.id,
        displayName: profile.name,
      })),
    [profiles],
  );

  const selectableModelSources = useMemo<AgentRuntimeModelOption[]>(() => {
    if (runtimeModelRoutes !== undefined) {
      return runtimeModelRoutes.map((route) => ({
        id: route.id,
        provider: route.provider,
        providerLabel: route.providerLabel,
        model: route.model,
        ...("sourceKind" in route ? { sourceKind: route.sourceKind } : {}),
        ...("selection" in route
          ? { modelSelection: route.selection }
          : { modelProfileId: route.sourceProfileId }),
      }));
    }
    return selectableModelProfiles.map((profile) => ({
      id: profile.id,
      provider: profile.provider || "",
      providerLabel: profile.provider || "",
      model: profile.model || "",
      modelProfileId: profile.id,
    }));
  }, [runtimeModelRoutes, selectableModelProfiles]);
  const requestInstall = (target: {
    key?: string;
    definitionId: string;
    versionId: string;
    displayName?: string;
    modelProfileId?: string;
    modelSelection?: AgentRuntimeModelSelection;
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
    const activationTarget: AgentActivationTarget = {
      key: target.key ?? `definition:${target.definitionId}`,
      displayName,
      definitionId: target.definitionId,
      versionId: target.versionId,
      installation,
      profile,
    };
    if (target.modelProfileId || target.modelSelection) {
      void activateAgent({
        ...activationTarget,
        modelProfileId: target.modelProfileId,
        modelSelection: target.modelSelection,
      });
      return;
    }
    // An already configured Agent owns its current route. A normal "Use
    // Agent" click is not a model switch, so do not inject the account's
    // preferred model and trigger a repair transaction. Explicit model
    // choices still take the branch above; version changes still use the
    // normal alignment/seed path below.
    if (
      installation?.status === "active" &&
      installation.sourceScope === "USER" &&
      profile &&
      isRunnableAgentProfile(profile)
    ) {
      void activateAgent(activationTarget);
      return;
    }
    if (
      installation?.status === "pending" &&
      installation.selectedVersionId === target.versionId &&
      profile &&
      isRunnableAgentProfile(profile)
    ) {
      void activateAgent(activationTarget);
      return;
    }
    if (selectableModelSources.length === 0) {
      setError("agents.hub.modelRequired");
      return;
    }
    const preferred =
      selectableModelSources.find(
        (candidate) =>
          candidate.modelSelection?.sourceProfileId === modelProfileId ||
          candidate.modelProfileId === modelProfileId,
      ) ?? selectableModelSources[0];
    void activateAgent({
      ...activationTarget,
      ...(preferred.modelSelection
        ? { modelSelection: preferred.modelSelection }
        : { modelProfileId: preferred.modelProfileId }),
    });
  };

  const cardPresentation = (card: PersonalAgentCard): AgentCardPresentation => {
    if (
      card.installation?.status === "pending" &&
      card.installation.retryCode ===
        "profile_capability_configuration_required"
    ) {
      return {
        tone: "pending",
        statusKey: "agents.hub.setupIncomplete",
        primary: "details",
      };
    }
    if (card.installation?.status === "pending") {
      const needsModel =
        card.installation.retryCode === "profile_model_configuration_failed" ||
        selectableModelSources.length === 0;
      return needsModel
        ? {
            tone: "attention",
            statusKey: "agents.hub.needsModel",
            primary: "configure_model",
          }
        : {
            tone: "pending",
            statusKey: "agents.hub.setupIncomplete",
            primary: "retry",
          };
    }
    if (isRunnableAgentProfile(card.profile)) {
      return {
        tone: "ready",
        statusKey: "agents.hub.ready",
        primary: "chat",
      };
    }
    if (card.profile) {
      return {
        tone: "attention",
        statusKey: "agents.hub.needsModel",
        primary: "configure_model",
      };
    }
    if (card.definition || card.draft?.publishedRevision) {
      return selectableModelSources.length > 0
        ? {
            tone: "pending",
            statusKey: "agents.hub.readyToInstall",
            primary: "chat",
          }
        : {
            tone: "attention",
            statusKey: "agents.hub.needsModel",
            primary: "configure_model",
          };
    }
    return {
      tone: "attention",
      statusKey: "agents.hub.draftNeedsReview",
      primary: "details",
    };
  };

  const cardPrimaryLabel = (presentation: AgentCardPresentation): string => {
    switch (presentation.primary) {
      case "chat":
        return t("agents.hub.useAgent");
      case "retry":
        return t("agents.control.retryAgent");
      case "configure_model":
        return t("agents.hub.configureModel");
      case "details":
        return t("agents.hub.viewDetails");
    }
  };

  const runCardPrimary = (
    card: PersonalAgentCard,
    presentation: AgentCardPresentation,
  ): void => {
    if (presentation.primary === "details") {
      setSelectedPersonalKey(card.key);
      return;
    }
    if (presentation.primary === "configure_model") {
      if (onConfigureModels) onConfigureModels();
      else setPersonalCardError(card.key, "agents.hub.modelRequired");
      return;
    }
    if (!card.installation && card.profile) {
      onChatWithProfile?.(card.profile.id);
      return;
    }
    const definitionId =
      card.definition?.id ??
      card.draft?.publishedRevision?.definitionId ??
      card.installation?.definitionId ??
      null;
    const versionId =
      card.definition?.latestVersionId ??
      card.draft?.publishedRevision?.versionId ??
      card.installation?.selectedVersionId ??
      null;
    if (!definitionId || !versionId) {
      setSelectedPersonalKey(card.key);
      return;
    }
    requestInstall({
      key: card.key,
      displayName: card.name,
      definitionId,
      versionId,
    });
  };

  const visiblePersonalCards = useMemo(() => {
    if (!isOrganization) return personalCards;
    if (activeTab === "enterprise") {
      return personalCards.filter((card) => card.origin !== "profile");
    }
    return personalCards;
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
      if (mineFilter === "ready") return isRunnableAgentProfile(card.profile);
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
    const hasCompatibleModelProfile = Boolean(
      selectedPersonal.draft &&
      versionId &&
      selectableModelSources.some((source) =>
        publishedDraftAllowsModel(
          selectedPersonal.draft!,
          source.provider,
          source.model,
          versionId,
        ),
      ),
    );
    const requiresRepublishForModel = Boolean(
      selectedPersonal.installation?.status === "active" &&
      selectedPersonal.profile &&
      !isRunnableAgentProfile(selectedPersonal.profile) &&
      selectedPersonal.draft &&
      versionId &&
      !hasCompatibleModelProfile,
    );
    if (requiresRepublishForModel && selectedPersonal.draft && !draftReadOnly) {
      selectedPersonalPrimary = {
        label: t("agents.control.edit"),
        onClick: () => {
          void editDraft(selectedPersonal.draft!.id);
          setSelectedPersonalKey(null);
        },
      };
    } else if (
      selectedPersonal.installation?.status === "pending" &&
      selectedPersonal.installation.retryCode ===
        "profile_capability_configuration_required"
    ) {
      selectedPersonalPrimary = {
        label: t("agents.capabilityBinding.configure"),
        disabled:
          capabilityBindingBusy ||
          (isOrganization &&
            activeTab === "enterprise" &&
            !organizationCanInstall),
        onClick: () => {
          void openCapabilityBinding(selectedPersonal.installation!.id);
          setSelectedPersonalKey(null);
        },
      };
    } else if (
      !selectedPersonal.installation &&
      isRunnableAgentProfile(selectedPersonal.profile) &&
      onChatWithProfile
    ) {
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
      const requiresModelConfiguration = selectableModelSources.length === 0;
      selectedPersonalPrimary = {
        label: t(
          requiresModelConfiguration
            ? "agents.hub.configureModel"
            : "agents.control.retryAgent",
        ),
        disabled: requiresModelConfiguration
          ? !onConfigureModels
          : !state?.cloudAvailable ||
            (isOrganization &&
              activeTab === "enterprise" &&
              !organizationCanInstall) ||
            busyPersonalKey === selectedPersonal.key,
        onClick: () => {
          if (requiresModelConfiguration) {
            onConfigureModels?.();
          } else {
            requestInstall({
              displayName: selectedPersonal.name,
              definitionId,
              versionId,
            });
          }
          setSelectedPersonalKey(null);
        },
      };
    } else if (definitionId && versionId) {
      const requiresModelConfiguration = selectableModelSources.length === 0;
      selectedPersonalPrimary = {
        label: t(
          requiresModelConfiguration
            ? "agents.hub.configureModel"
            : "agents.hub.useAgent",
        ),
        disabled: requiresModelConfiguration
          ? !onConfigureModels
          : !state?.cloudAvailable ||
            (isOrganization &&
              activeTab === "enterprise" &&
              !organizationCanInstall) ||
            busyPersonalKey === selectedPersonal.key,
        onClick: () => {
          if (requiresModelConfiguration) {
            onConfigureModels?.();
          } else {
            requestInstall({
              displayName: selectedPersonal.name,
              definitionId,
              versionId,
            });
          }
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
    const organizationLifecycle =
      isOrganization && activeTab === "enterprise"
        ? selectedPersonal.lifecycle
        : null;
    if (
      organizationLifecycle?.actions.includes("withdraw") &&
      selectedPersonal.submission?.status === "pending"
    ) {
      selectedPersonalExtra.push({
        label: t("agents.control.organization.withdraw"),
        disabled: !organizationOnline || lifecycleBusy,
        onClick: () => {
          void prepareCardWithdrawal(selectedPersonal.submission!.id);
        },
      });
    }
    if (
      organizationLifecycle?.actions.includes("delete_draft") &&
      selectedPersonal.draft &&
      !draftReadOnly
    ) {
      selectedPersonalExtra.push({
        label: t("agents.control.organization.deleteDraft"),
        disabled: lifecycleBusy,
        onClick: () => {
          setDraftActionTarget({
            kind: "delete",
            draftId: selectedPersonal.draft!.id,
          });
          setSelectedPersonalKey(null);
        },
      });
    }
    if (
      organizationLifecycle?.actions.includes("discard_unpublished") &&
      selectedPersonal.draft &&
      !draftReadOnly
    ) {
      selectedPersonalExtra.push({
        label: t("agents.control.organization.discardUnpublished"),
        disabled: lifecycleBusy,
        onClick: () => {
          setDraftActionTarget({
            kind: "discard",
            draftId: selectedPersonal.draft!.id,
          });
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
      } else if (
        isOrganization &&
        selectedPersonal.installation.sourceScope === "ORGANIZATION" &&
        context.role !== "auditor"
      ) {
        selectedPersonalExtra.push({
          label: t("agents.control.organizationExperience.contribute"),
          disabled: false,
          onClick: () => {
            setAdvancedOpen(true);
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
    }
    if (
      selectedPersonal.installation &&
      selectedPersonal.installation.status !== "archived"
    ) {
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
          {(activeTab === "mine" && (!isOrganization ? showNewDraft : true)) ||
          (activeTab === "enterprise" && isOrganization && showNewDraft) ? (
            <button
              type="button"
              className="btn btn-primary btn-sm agent-hub-create-button"
              onClick={() => void openNewDraft()}
              disabled={newDraftDisabled}
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
      {error ? (
        <div className="agent-control-error-action">
          <div className="agents-create-error">{t(error)}</div>
          {errorAction === "retry" ? (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={loading}
              onClick={() => void load()}
            >
              {t("agents.control.tryAgain")}
            </button>
          ) : errorAction === "configure_model" && onConfigureModels ? (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={onConfigureModels}
            >
              {t("agents.hub.configureModel")}
            </button>
          ) : null}
        </div>
      ) : null}
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
              installBusy={officialInstallBusy}
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

          {activeTab === "mine" && onOpenTeams ? (
            <section
              className="agent-team-entry"
              aria-labelledby="agent-team-entry-title"
            >
              <div className="agent-team-entry-icon" aria-hidden="true">
                <Workflow size={24} />
              </div>
              <div className="agent-team-entry-content">
                <div className="agent-team-entry-heading">
                  <div>
                    <h3 id="agent-team-entry-title">
                      {t("agents.teams.title")}
                    </h3>
                    <p>{t("agents.teams.description")}</p>
                  </div>
                  <span className="agent-team-entry-status">
                    {t("agents.teams.hermesBoardStatus")}
                  </span>
                </div>
                <div className="agent-team-entry-footer">
                  <span>{t("agents.teams.capabilities")}</span>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={onOpenTeams}
                  >
                    {t("agents.teams.startTask")}
                  </button>
                </div>
              </div>
            </section>
          ) : null}

          {filteredPersonalCards.length === 0 ? (
            <div className="agent-hub-empty">
              <div className="agent-hub-empty-icon">
                <Bot size={30} />
              </div>
              <strong>{t(personalEmptyTitle)}</strong>
              <p>{t(personalEmptyHint)}</p>
              {!hasSearchQuery &&
              visiblePersonalCards.length === 0 &&
              ((activeTab === "mine" && isOrganization) || showNewDraft) ? (
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={newDraftDisabled}
                  onClick={() => void openNewDraft()}
                >
                  <Plus size={16} />
                  {t("agents.hub.createAgent")}
                </button>
              ) : null}
            </div>
          ) : (
            <div className="agent-hub-grid" data-testid="personal-agent-grid">
              {filteredPersonalCards.map((card) => {
                const presentation = cardPresentation(card);
                const localError = personalCardErrors[card.key] ?? null;
                return (
                  <article
                    key={card.key}
                    className={`agent-hub-card ${presentation.tone}`}
                    data-testid="agent-capability-card"
                  >
                    <button
                      type="button"
                      className="agent-hub-card-details"
                      aria-label={t("agents.hub.viewAgentDetails", {
                        name: card.name,
                      })}
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
                        <span
                          className={`agent-hub-card-status ${presentation.tone}`}
                        >
                          {presentation.tone === "ready" ? (
                            <Check size={12} />
                          ) : null}
                          {t(presentation.statusKey)}
                        </span>
                      </div>
                      <p>{card.description}</p>
                      <div className="agent-hub-card-tags">
                        {card.tags.slice(1).map((tag) => (
                          <span key={tag}>{tag}</span>
                        ))}
                      </div>
                    </button>
                    {localError ? (
                      <p className="agent-hub-card-local-error">
                        {t(localError)}
                      </p>
                    ) : null}
                    <button
                      type="button"
                      className="btn btn-primary btn-sm agent-hub-card-primary"
                      data-testid="agent-card-primary-action"
                      disabled={
                        busyPersonalKey === card.key ||
                        (presentation.primary === "configure_model" &&
                          !onConfigureModels)
                      }
                      onClick={() => runCardPrimary(card, presentation)}
                    >
                      {cardPrimaryLabel(presentation)}
                    </button>
                  </article>
                );
              })}
            </div>
          )}

          {canSeeGovernance ? (
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

                  {isOrganization && activeTab === "enterprise" && state ? (
                    <OrganizationExperienceCandidatePanel
                      online={organizationOnline}
                      role={context.role}
                      contextKey={contextKey(state)}
                      refreshToken={candidateRefreshToken}
                      contributionTarget={
                        promotionTarget
                          ? {
                              installation: promotionTarget,
                              agentName: definitionName(
                                promotionTarget.definitionId,
                              ),
                            }
                          : null
                      }
                      onCloseContribution={() => setPromotionTarget(null)}
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
                      key={contextKey(state)}
                      online={organizationOnline}
                      canAuthor={organizationCanAuthor}
                      canReview={organizationCanReview}
                      submissions={organizationSubmissions}
                      issues={organizationSubmissionIssues}
                      loading={loading}
                      onRefresh={load}
                      onDisconnect={disconnectOrganizationSubmissionReference}
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
            isRunnableAgentProfile(selectedPersonal.profile)
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

      {capabilityBinding ? (
        <AgentCapabilityBindingDialog
          open
          configuration={capabilityBinding}
          online={state?.access === "online" && state.cloudAvailable === true}
          busy={capabilityBindingBusy}
          onClose={() => setCapabilityBinding(null)}
          onConfirm={(input) => void confirmCapabilityBindings(input)}
        />
      ) : null}

      <AgentDraftEditor
        open={editor !== null}
        draft={editor === "new" ? null : editor}
        readOnly={draftReadOnly}
        publicationTarget={
          isOrganization && activeTab === "enterprise"
            ? "ORGANIZATION"
            : "DIRECT"
        }
        operationScope={personalOperationScope}
        modelProfileId={modelProfileId}
        runtimeModelRoutes={runtimeModelRoutes}
        capabilityProfiles={capabilityProfiles}
        onClose={() => setEditor(null)}
        onSaved={() => void load()}
        onPublished={() => void load()}
        onOrganizationSubmitted={() => void load()}
        onRequestInstall={requestInstall}
      />
      {promotionTarget && !isOrganization ? (
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

      {draftActionTarget ? (
        <div className="agent-control-dialog-backdrop">
          <div
            className="agent-control-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="organization-draft-action-title"
          >
            <h3 id="organization-draft-action-title">
              {t(
                draftActionTarget.kind === "delete"
                  ? "agents.control.organization.deleteDraftTitle"
                  : "agents.control.organization.discardUnpublishedTitle",
              )}
            </h3>
            <p>
              {t(
                draftActionTarget.kind === "delete"
                  ? "agents.control.organization.deleteDraftBoundary"
                  : "agents.control.organization.discardUnpublishedBoundary",
              )}
            </p>
            <div className="agent-control-dialog-actions">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setDraftActionTarget(null)}
                disabled={lifecycleBusy}
              >
                {t("agents.control.cancel")}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void confirmDraftAction()}
                disabled={lifecycleBusy}
              >
                {t(
                  draftActionTarget.kind === "delete"
                    ? "agents.control.organization.confirmDeleteDraft"
                    : "agents.control.organization.confirmDiscardUnpublished",
                )}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {withdrawal ? (
        <div className="agent-control-dialog-backdrop">
          <div
            className="agent-control-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="organization-card-withdrawal-title"
          >
            <h3 id="organization-card-withdrawal-title">
              {t("agents.control.organization.withdraw")}
            </h3>
            <p>{t("agents.control.organization.withdrawalBoundary")}</p>
            <div className="agent-control-dialog-actions">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setWithdrawal(null)}
                disabled={lifecycleBusy}
              >
                {t("agents.control.cancel")}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void confirmCardWithdrawal()}
                disabled={lifecycleBusy}
              >
                {t("agents.control.organization.confirmWithdrawal")}
              </button>
            </div>
          </div>
        </div>
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
