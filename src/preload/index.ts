import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { AppLocale } from "../shared/i18n/types";
import type { Attachment } from "../shared/attachments";
import type { SessionModelOverride } from "../shared/model-override";
import type { DesktopSessionContinuationItem } from "../shared/session-continuation";
import type { DesktopSessionLocalError } from "../shared/session-continuation";
import type {
  ImportWalletInput,
  ProfileWallet,
  ProvisionWalletResult,
  WalletMutationResult,
  WalletPortfolioResult,
  WalletSyncResult,
} from "../shared/wallets";
import type { TokenBalancesResponse } from "../shared/tokens";
import type { CustomProviderRecord } from "../shared/custom-providers";
import type {
  AgentConversationSegmentEvent,
  AgentConversationThreadResumeProjection,
  ModelConfigurationMutationRequest,
  ModelConfigurationMutationResult,
  OwnerModelRouteCatalogSnapshot,
  OwnerModelRouteSelection,
} from "../shared/model-configuration";
import type {
  MessagingPlatformsResponse,
  MessagingPlatformTestResponse,
  MessagingPlatformUpdate,
} from "../shared/messaging-platforms";
import type { ChatToolEvent } from "../shared/chat-stream";
import type {
  DeviceCodeInfo,
  HermesAccount,
  HermesAccountUser,
} from "../shared/account";
import type { AgentSyncResult, AgentSyncStatus } from "../shared/agent-sync";
import type { GpuPreferenceMode, GpuStatus } from "../shared/gpu";
import type {
  AgenteraAuthPublicState,
  AgenteraPortalTarget,
} from "../shared/agentera-auth";
import type {
  AgenteraUserProfile,
  AgenteraUserProfileInput,
} from "../shared/agentera-user-profile";
import type {
  AgenteraGlobalProfile,
  AgenteraGlobalProfileConversationContext,
  AgenteraGlobalProfileHistoryItem,
  AgenteraGlobalProfileResult,
  PrepareAgenteraGlobalProfileConversationContextInput,
  SetAgenteraGlobalProfileEntryInput,
} from "../shared/agentera-global-profile";
import type {
  AgenteraMemoryCandidateBatch,
  AgenteraMemoryCandidateConfirmation,
  AgenteraMemoryCandidateResult,
} from "../shared/agentera-memory-candidate";
import type {
  OfficialQualityConsentReceipt,
  OfficialQualityConsentSettings,
  OfficialQualityFeedbackEligibility,
  OfficialQualityFeedbackSubmission,
  OfficialQualityFeedbackSubmissionResult,
} from "../shared/agentera-official-quality";
import type {
  AgenteraEncryptedBackupConfirmedRestore,
  AgenteraEncryptedBackupCreationResult,
  AgenteraEncryptedBackupPreparedRestore,
  AgenteraEncryptedBackupProgress,
  AgenteraEncryptedBackupPublicDevice,
  AgenteraEncryptedBackupPublicEnrollment,
  AgenteraEncryptedBackupPublicState,
  AgenteraEncryptedBackupPublicSummary,
} from "../shared/agentera-encrypted-backup";
import type {
  AgenteraAccountProfileResolutionPublicState,
  AgenteraBoundConnectionPublicState,
  AgenteraBoundProfilePublicState,
  AgenteraConnectionClaimPublicState,
  AgenteraFreshProfilePublicState,
  AgenteraInstallFileProbe,
  AgenteraProfileClaimPublicState,
  AgenteraStartupPreflightPublicResult,
  AgenteraUnboundProfilePublicState,
} from "../shared/agentera-runtime-access";
import type { RuntimeDistributionPublicState } from "../shared/agentera-runtime-distribution";
import type { DesktopControlPublicState } from "../shared/agentera-desktop-control";
import type {
  ImageGenerationConfigDraft,
  ImageGenerationConfigReadResult,
  ImageGenerationModelsResult,
  ImageGenerationSaveResult,
  ImageGenerationTestResult,
} from "../shared/image-generation";
import type {
  AgentDraft,
  AgentDraftAssetInput,
  AgentDraftDetail,
  AgentCapabilityBindingConfiguration,
  ConfirmCapabilityBindingsInput,
  ConfirmCapabilityBindingsResult,
  AgentMcpRequirementV3,
  AgenteraAgentControlPublicState,
  AgenteraAgentControlResult,
  AgenteraAgentDefinitionSummary,
  AgenteraAgentInstallationSummary,
  AgentRuntimeModelRoute,
  AgenteraAgentOperationScope,
  AgenteraAgentVersionSummary,
  AgenteraClaimVersionInput,
  AgenteraInstallVersionInput,
  AgenteraRepairInstallationModelInput,
  AgenteraRetryPendingInstallationInput,
  AgenteraSelectInstallationVersionInput,
  ConfirmExperienceCandidateImportInput,
  ConfirmInstalledSkillSnapshotInput,
  ConfirmMcpRequirementInput,
  ConfirmOfficialAgentInstallInput,
  ConfirmOrganizationExperienceCandidateImportInput,
  ConfirmOrganizationReviewInput,
  ConfirmOrganizationSubmissionInput,
  ConfirmOrganizationWithdrawalInput,
  DisconnectOrganizationSubmissionReferenceInput,
  CreateAgentDraftInput,
  AuthoringCapabilitySummary,
  EligibleExperienceSkill,
  ExperienceCandidateDetail,
  ExperienceCandidateImportPreview,
  ExperienceCandidatePreview,
  ExperienceCandidateSummary,
  OrganizationExperienceCandidateDetail,
  OrganizationExperienceCandidateImportPreview,
  OrganizationExperienceCandidatePreview,
  OrganizationExperienceCandidateSummary,
  OrganizationAgentSubmissionDetail,
  OrganizationAgentSubmissionList,
  OrganizationAgentSubmissionListItem,
  OrganizationAgentSubmissionSummary,
  OrganizationReviewPreview,
  OrganizationSubmissionPreview,
  OrganizationWithdrawalPreview,
  McpRequirementPreview,
  OfficialAgentDetail,
  OfficialAgentInstallPreview,
  OfficialAgentSummary,
  OfficialManagedUpdate,
  PrepareExperienceCandidateInput,
  PrepareInstalledSkillSnapshotInput,
  PrepareMcpRequirementInput,
  PrepareOrganizationExperienceCandidateInput,
  PrepareOrganizationReviewInput,
  PublicationPreview,
  PublishedRevision,
  SkillSnapshotPreview,
  ReviewExperienceCandidateInput,
  ReviewOrganizationExperienceCandidateInput,
  SubmitOrganizationExperienceCandidateInput,
  SubmitExperienceCandidateInput,
  UpdateAgentDraftInput,
} from "../shared/agentera-agent-control";
import type {
  AgenteraWorkspaceResult,
  WorkspaceInvitation,
  WorkspaceInvitationAcceptance,
  WorkspaceInvitationCreation,
  WorkspaceMember,
  WorkspacePendingInvitation,
  WorkspacePublicState,
  WorkspaceSummary,
} from "../shared/agentera-workspace";
import type {
  ProductSpacePublicState,
  ProductSpaceResult,
  StoredProductSpaceSelection,
} from "../shared/agentera-product-space";
import type {
  AgenteraOrganizationResult,
  OrganizationAuditEvent,
  OrganizationCachedCollection,
  OrganizationCurrentPolicyState,
  OrganizationDepartment,
  OrganizationInvitation,
  OrganizationInvitationAcceptance,
  OrganizationInvitationCreation,
  OrganizationMember,
  OrganizationMemberPatch,
  OrganizationPage,
  OrganizationPendingInvitation,
  OrganizationPolicyDocument,
  OrganizationPolicySnapshot,
  OrganizationPolicySummary,
  OrganizationPublicState,
  OrganizationSummary,
} from "../shared/agentera-organization";

/**
 * Mirror of the renderer-side `CredentialPoolEntry` ambient type
 * (src/preload/index.d.ts) — preload is type-checked under
 * tsconfig.node.json which doesn't include the .d.ts. See #367.
 */
interface CredentialPoolEntry {
  id?: string;
  label?: string;
  auth_type?: "api_key" | "oauth_device_code" | string;
  priority?: number;
  source?: string;
  access_token?: string;
  refresh_token?: string;
  api_key?: string;
  base_url?: string;
  request_count?: number;
  key?: string;
}

interface GatewayStartResult {
  success: boolean;
  running: boolean;
  alreadyRunning?: boolean;
  error?: string;
  logPath?: string;
}

interface DashboardConnection {
  baseUrl: string;
  wsUrl: string;
  token: string;
  authMode?: "token" | "oauth";
  mode: "local" | "remote" | "ssh";
  profile?: string;
  pid?: number;
  port?: number;
  logPath?: string;
  alreadyRunning?: boolean;
}

interface DashboardStatus {
  supported: boolean;
  running: boolean;
  connection?: DashboardConnection;
  error?: string;
  logPath?: string;
  needsOAuthLogin?: boolean;
}

const electronAPI = {
  process: {
    platform: process.platform,
    versions: {
      chrome: process.versions.chrome,
      electron: process.versions.electron,
      node: process.versions.node,
    },
  },
};

const hermesAPI = {
  // Installation
  checkInstall: (): Promise<{
    installed: boolean;
    configured: boolean;
    hasApiKey: boolean;
  }> => ipcRenderer.invoke("check-install"),

  verifyInstall: (): Promise<boolean> => ipcRenderer.invoke("verify-install"),

  startInstall: (): Promise<{
    success: boolean;
    error?: string;
    errorCode?: string;
    repairRequired?: boolean;
    action?: "reinstall-desktop" | "free-disk-space" | "retry";
  }> => ipcRenderer.invoke("start-install"),

  validateHermesHome: (dir: string): Promise<boolean> =>
    ipcRenderer.invoke("validate-hermes-home", dir),

  adoptHermesHome: (dir: string): Promise<boolean> =>
    ipcRenderer.invoke("adopt-hermes-home", dir),

  quitApp: (): Promise<void> => ipcRenderer.invoke("quit-app"),

  getGpuStatus: (): Promise<GpuStatus> => ipcRenderer.invoke("get-gpu-status"),

  reenableGpu: (): Promise<boolean> => ipcRenderer.invoke("reenable-gpu"),

  setGpuPreference: (mode: GpuPreferenceMode): Promise<boolean> =>
    ipcRenderer.invoke("set-gpu-preference", mode),

  relaunchApp: (): Promise<void> => ipcRenderer.invoke("relaunch-app"),

  onInstallProgress: (
    callback: (progress: {
      step: number;
      totalSteps: number;
      title: string;
      detail: string;
      log: string;
    }) => void,
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      progress: unknown,
    ): void =>
      callback(
        progress as {
          step: number;
          totalSteps: number;
          title: string;
          detail: string;
          log: string;
        },
      );
    ipcRenderer.on("install-progress", handler);
    return () => ipcRenderer.removeListener("install-progress", handler);
  },

  // Hermes engine info
  getHermesVersion: (): Promise<string | null> =>
    ipcRenderer.invoke("get-hermes-version"),
  refreshHermesVersion: (): Promise<string | null> =>
    ipcRenderer.invoke("refresh-hermes-version"),
  runHermesDoctor: (): Promise<string> =>
    ipcRenderer.invoke("run-hermes-doctor"),
  runHermesUpdate: (): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke("run-hermes-update"),

  // OpenClaw migration
  checkOpenClaw: (): Promise<{ found: boolean; path: string | null }> =>
    ipcRenderer.invoke("check-openclaw"),
  runClawMigrate: (): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke("run-claw-migrate"),

  // OAuth provider sign-in
  oauthLogin: (
    provider: string,
    profile?: string,
  ): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke("oauth-login", provider, profile),
  cancelOAuthLogin: (): Promise<boolean> =>
    ipcRenderer.invoke("oauth-login-cancel"),
  onOAuthLoginProgress: (callback: (chunk: string) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, chunk: unknown): void =>
      callback(String(chunk));
    ipcRenderer.on("oauth-login-progress", handler);
    return () => ipcRenderer.removeListener("oauth-login-progress", handler);
  },

  // Hermes account sign-in (device authorization grant)
  accountLogin: (
    profile?: string,
  ): Promise<{ success: boolean; user?: HermesAccountUser; error?: string }> =>
    ipcRenderer.invoke("hermes-account-login", profile),
  cancelAccountLogin: (): Promise<boolean> =>
    ipcRenderer.invoke("hermes-account-login-cancel"),
  onAccountLoginCode: (
    callback: (info: DeviceCodeInfo) => void,
  ): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, info: unknown): void =>
      callback(info as DeviceCodeInfo);
    ipcRenderer.on("hermes-account-login-code", handler);
    return () =>
      ipcRenderer.removeListener("hermes-account-login-code", handler);
  },
  onAccountLoginProgress: (callback: (chunk: string) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, chunk: unknown): void =>
      callback(String(chunk));
    ipcRenderer.on("hermes-account-login-progress", handler);
    return () =>
      ipcRenderer.removeListener("hermes-account-login-progress", handler);
  },
  getAccount: (profile?: string): Promise<HermesAccount | null> =>
    ipcRenderer.invoke("hermes-account-get", profile),
  accountLogout: (profile?: string): Promise<{ success: boolean }> =>
    ipcRenderer.invoke("hermes-account-logout", profile),

  // Cloud agent sync (profiles ↔ signed-in Hermes One account)
  syncAgents: (): Promise<AgentSyncResult> =>
    ipcRenderer.invoke("agent-sync-run"),
  getAgentSyncStatus: (): Promise<AgentSyncStatus> =>
    ipcRenderer.invoke("agent-sync-status"),
  getLinkedAgentId: (profile: string): Promise<string | null> =>
    ipcRenderer.invoke("agent-sync-linked-id", profile),
  onAgentSyncUpdated: (
    callback: (result: AgentSyncResult) => void,
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      result: unknown,
    ): void => callback(result as AgentSyncResult);
    ipcRenderer.on("agent-sync-updated", handler);
    return () => ipcRenderer.removeListener("agent-sync-updated", handler);
  },

  getLocale: (): Promise<AppLocale> => ipcRenderer.invoke("get-locale"),
  setLocale: (locale: AppLocale): Promise<AppLocale> =>
    ipcRenderer.invoke("set-locale", locale),

  // Configuration (profile-aware)
  getEnv: (profile?: string): Promise<Record<string, string>> =>
    ipcRenderer.invoke("get-env", profile),

  setEnv: (key: string, value: string, profile?: string): Promise<boolean> =>
    ipcRenderer.invoke("set-env", key, value, profile),

  validateChatReadiness: (
    profile?: string,
  ): Promise<{
    ok: boolean;
    code?:
      | "NO_ACTIVE_MODEL"
      | "NO_PROVIDER"
      | "NO_BASE_URL"
      | "MISSING_API_KEY"
      | "GATEWAY_DOWN";
    message?: string;
    fixLocation?: "providers" | "models" | "gateway" | "setup";
    expectedEnvKey?: string;
  }> => ipcRenderer.invoke("validate-chat-readiness", profile),

  getConfigHealth: (profile?: string): Promise<unknown> =>
    ipcRenderer.invoke("get-config-health", profile),
  rerunConfigHealth: (profile?: string): Promise<unknown> =>
    ipcRenderer.invoke("rerun-config-health", profile),
  autofixConfigIssue: (
    code: string,
    profile?: string,
    context?: Record<string, string>,
  ): Promise<{ ok: boolean; message?: string }> =>
    ipcRenderer.invoke("autofix-config-issue", code, profile, context),
  getConfigFixLog: (maxEntries?: number): Promise<unknown[]> =>
    ipcRenderer.invoke("get-config-fix-log", maxEntries),

  getConfig: (key: string, profile?: string): Promise<string | null> =>
    ipcRenderer.invoke("get-config", key, profile),

  setConfig: (key: string, value: string, profile?: string): Promise<boolean> =>
    ipcRenderer.invoke("set-config", key, value, profile),

  getHermesHome: (profile?: string): Promise<string> =>
    ipcRenderer.invoke("get-hermes-home", profile),

  getModelConfig: (
    profile?: string,
  ): Promise<{ provider: string; model: string; baseUrl: string }> =>
    ipcRenderer.invoke("get-model-config", profile),

  listAgentRuntimeModelRoutes: (
    profile: string,
  ): Promise<AgentRuntimeModelRoute[]> =>
    ipcRenderer.invoke("list-agent-runtime-model-routes", profile),

  getOwnerModelRouteCatalog: (
    requestedProfileId?: string,
  ): Promise<OwnerModelRouteCatalogSnapshot> =>
    ipcRenderer.invoke("get-owner-model-route-catalog", requestedProfileId),

  mutateModelConfiguration: (
    request: ModelConfigurationMutationRequest,
  ): Promise<ModelConfigurationMutationResult> =>
    ipcRenderer.invoke("mutate-model-configuration", request),

  setModelConfig: (
    provider: string,
    model: string,
    baseUrl: string,
    profile?: string,
  ): Promise<boolean> =>
    ipcRenderer.invoke("set-model-config", provider, model, baseUrl, profile),

  // Auxiliary (side-task) model routing
  getAuxiliaryConfig: (
    profile?: string,
  ): Promise<
    { task: string; provider: string; model: string; baseUrl: string }[]
  > => ipcRenderer.invoke("get-auxiliary-config", profile),

  setAuxiliaryTask: (
    task: string,
    cfg: { provider: string; model: string; baseUrl: string },
    profile?: string,
  ): Promise<boolean> =>
    ipcRenderer.invoke("set-auxiliary-task", task, cfg, profile),

  resetAuxiliaryConfig: (profile?: string): Promise<boolean> =>
    ipcRenderer.invoke("reset-auxiliary-config", profile),

  // Connection mode (local / remote / ssh)
  isRemoteMode: (): Promise<boolean> => ipcRenderer.invoke("is-remote-mode"),
  isRemoteOnlyMode: (): Promise<boolean> =>
    ipcRenderer.invoke("is-remote-only-mode"),
  getConnectionConfig: (): Promise<{
    connectionContextId: string;
    mode: "local" | "remote" | "ssh";
    remoteUrl: string;
    remoteAuthMode: "auto" | "token" | "oauth";
    remoteChatTransport: "auto" | "dashboard" | "legacy";
    sshChatTransport: "auto" | "dashboard" | "legacy";
    hasApiKey: boolean;
    apiKeyLength: number;
    ssh: {
      host: string;
      port: number;
      username: string;
      keyPath: string;
      remotePort: number;
      localPort: number;
    };
  }> => ipcRenderer.invoke("get-connection-config"),

  setConnectionConfig: (
    mode: "local" | "remote" | "ssh",
    remoteUrl: string,
    apiKey?: string,
  ): Promise<boolean> =>
    ipcRenderer.invoke("set-connection-config", mode, remoteUrl, apiKey),

  setConnectionChatTransports: (
    remoteChatTransport: "auto" | "dashboard" | "legacy",
    sshChatTransport: "auto" | "dashboard" | "legacy",
  ): Promise<boolean> =>
    ipcRenderer.invoke(
      "set-connection-chat-transports",
      remoteChatTransport,
      sshChatTransport,
    ),

  onConnectionConfigChanged: (
    callback: (config: {
      mode: "local" | "remote" | "ssh";
      remoteUrl: string;
      remoteAuthMode: "auto" | "token" | "oauth";
      remoteChatTransport: "auto" | "dashboard" | "legacy";
      sshChatTransport: "auto" | "dashboard" | "legacy";
      hasApiKey: boolean;
      apiKeyLength: number;
      ssh: {
        host: string;
        port: number;
        username: string;
        keyPath: string;
        remotePort: number;
        localPort: number;
      };
    }) => void,
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      config: unknown,
    ): void =>
      callback(
        config as {
          mode: "local" | "remote" | "ssh";
          remoteUrl: string;
          remoteAuthMode: "auto" | "token" | "oauth";
          remoteChatTransport: "auto" | "dashboard" | "legacy";
          sshChatTransport: "auto" | "dashboard" | "legacy";
          hasApiKey: boolean;
          apiKeyLength: number;
          ssh: {
            host: string;
            port: number;
            username: string;
            keyPath: string;
            remotePort: number;
            localPort: number;
          };
        },
      );
    ipcRenderer.on("connection-config-changed", handler);
    return () =>
      ipcRenderer.removeListener("connection-config-changed", handler);
  },

  onRuntimeSnapshotChanged: (
    callback: (change?: {
      catalogRevision?: string;
      profile?: string;
    }) => void,
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      change?: { catalogRevision?: string; profile?: string },
    ): void => callback(change);
    ipcRenderer.on("runtime-snapshot-changed", handler);
    return () =>
      ipcRenderer.removeListener("runtime-snapshot-changed", handler);
  },

  setSshConfig: (
    host: string,
    port: number,
    username: string,
    keyPath: string,
    remotePort: number,
    localPort: number,
  ): Promise<boolean> =>
    ipcRenderer.invoke(
      "set-ssh-config",
      host,
      port,
      username,
      keyPath,
      remotePort,
      localPort,
    ),

  testRemoteConnection: (url: string, apiKey?: string): Promise<boolean> =>
    ipcRenderer.invoke("test-remote-connection", url, apiKey),

  probeRemoteAuthMode: (
    url: string,
  ): Promise<{ authMode: "token" | "oauth"; version: string | null }> =>
    ipcRenderer.invoke("probe-remote-auth-mode", url),

  remoteOAuthLogin: (): Promise<{ signedIn: true }> =>
    ipcRenderer.invoke("remote-oauth-login"),

  remoteOAuthLogout: (): Promise<{ signedIn: false }> =>
    ipcRenderer.invoke("remote-oauth-logout"),

  remoteOAuthSessionState: (): Promise<{ signedIn: boolean }> =>
    ipcRenderer.invoke("remote-oauth-session-state"),

  testSshConnection: (
    host: string,
    port: number,
    username: string,
    keyPath: string,
    remotePort: number,
  ): Promise<boolean> =>
    ipcRenderer.invoke(
      "test-ssh-connection",
      host,
      port,
      username,
      keyPath,
      remotePort,
    ),

  isSshTunnelActive: (): Promise<boolean> =>
    ipcRenderer.invoke("is-ssh-tunnel-active"),

  startSshTunnel: (): Promise<boolean> =>
    ipcRenderer.invoke("start-ssh-tunnel"),

  stopSshTunnel: (): Promise<boolean> => ipcRenderer.invoke("stop-ssh-tunnel"),

  // Chat
  sendMessage: (
    message: string,
    profile?: string,
    resumeSessionId?: string,
    history?: Array<{ role: string; content: string }>,
    attachments?: Attachment[],
    contextFolder?: string,
    runId?: string,
    modelOverride?: SessionModelOverride,
    agentModelSelection?: OwnerModelRouteSelection,
  ): Promise<{ response: string; sessionId?: string }> =>
    ipcRenderer.invoke(
      "send-message",
      message,
      profile,
      resumeSessionId,
      history,
      attachments,
      contextFolder,
      runId,
      modelOverride,
      agentModelSelection,
    ),

  abortChat: (runId?: string): Promise<void> =>
    ipcRenderer.invoke("abort-chat", runId),

  transcribeAudio: (
    audio: Uint8Array,
    mimeType: string,
    profile?: string,
  ): Promise<string> =>
    ipcRenderer.invoke("transcribe-audio", audio, mimeType, profile),

  getApiServerKeyStatus: (
    profile?: string,
  ): Promise<{ hasKey: boolean; providerId?: string; checkedAt?: number }> =>
    ipcRenderer.invoke("get-api-server-key-status", profile),

  invalidateSecretsCache: (): Promise<void> =>
    ipcRenderer.invoke("invalidate-secrets-cache"),

  generateApiServerKey: (profile?: string): Promise<{ generated: boolean }> =>
    ipcRenderer.invoke("generate-api-server-key", profile),

  copyToClipboard: (text: string): Promise<void> =>
    ipcRenderer.invoke("copy-to-clipboard", text),

  // Media (agent-generated images / files — issue #299)
  readMediaFile: (filePath: string): Promise<string | null> =>
    ipcRenderer.invoke("read-media-file", filePath),
  saveMediaFile: (src: string, name: string): Promise<boolean> =>
    ipcRenderer.invoke("save-media-file", src, name),
  mediaFileExists: (filePath: string): Promise<boolean> =>
    ipcRenderer.invoke("media-file-exists", filePath),
  showMediaMenu: (
    src: string,
    name: string,
    labels: { open: string; saveAs: string },
  ): void => {
    ipcRenderer.send("show-media-menu", src, name, labels);
  },

  // Resolve the absolute filesystem path for a File coming from drag-drop
  // or the file picker.  Returns "" for blobs that have no origin path
  // (e.g. clipboard paste) — caller should stageAttachment for those.
  getPathForFile: (file: File): string => {
    try {
      return webUtils.getPathForFile(file) || "";
    } catch {
      return "";
    }
  },

  stageAttachment: (
    sessionId: string,
    filename: string,
    base64Bytes: string,
  ): Promise<string> =>
    ipcRenderer.invoke("stage-attachment", sessionId, filename, base64Bytes),

  clearStagedAttachments: (sessionId: string): Promise<void> =>
    ipcRenderer.invoke("clear-staged-attachments", sessionId),

  discoverProviderModels: (
    provider: string,
    baseUrl?: string,
    apiKey?: string,
    profile?: string,
  ): Promise<{
    models: string[];
    status: "ok" | "no-key" | "error" | "unsupported" | "unknown-host";
    cached: boolean;
    /** Subset of `models` flagged as free per the provider catalog
     *  (Nous Portal today). Optional — providers without pricing
     *  metadata return undefined. Issue #367. */
    freeModels?: string[];
  }> =>
    ipcRenderer.invoke(
      "discover-provider-models",
      provider,
      baseUrl,
      apiKey,
      profile,
    ),

  getModelContextWindow: (
    provider: string,
    model: string,
    baseUrl?: string,
    profile?: string,
  ): Promise<number | null> =>
    ipcRenderer.invoke(
      "get-model-context-window",
      provider,
      model,
      baseUrl,
      profile,
    ),

  onChatChunk: (
    callback: (runId: string, chunk: string) => void,
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      runId: string,
      chunk: string,
    ): void => callback(runId, chunk);
    ipcRenderer.on("chat-chunk", handler);
    return () => ipcRenderer.removeListener("chat-chunk", handler);
  },

  /** Streaming reasoning / thinking tokens — separate from `onChatChunk`
   *  so the renderer can render a "thinking" bubble that grows
   *  independently of the assistant's content (#352). */
  onChatReasoningChunk: (
    callback: (runId: string, chunk: string) => void,
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      runId: string,
      chunk: string,
    ): void => callback(runId, chunk);
    ipcRenderer.on("chat-reasoning-chunk", handler);
    return () => ipcRenderer.removeListener("chat-reasoning-chunk", handler);
  },

  onChatDone: (
    callback: (runId: string, sessionId?: string) => void,
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      runId: string,
      sessionId?: string,
    ): void => callback(runId, sessionId);
    ipcRenderer.on("chat-done", handler);
    return () => ipcRenderer.removeListener("chat-done", handler);
  },

  onChatSessionStarted: (
    callback: (runId: string, sessionId: string) => void,
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      runId: string,
      sessionId: string,
    ): void => callback(runId, sessionId);
    ipcRenderer.on("chat-session-started", handler);
    return () => ipcRenderer.removeListener("chat-session-started", handler);
  },

  onContextMenuCopyChat: (
    callback: (format: "text" | "markdown") => void,
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      format: "text" | "markdown",
    ): void => callback(format);
    ipcRenderer.on("context-menu-copy-chat", handler);
    return () => ipcRenderer.removeListener("context-menu-copy-chat", handler);
  },

  onContextMenuSelectBubble: (
    callback: (point: { x: number; y: number }) => void,
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      point: { x: number; y: number },
    ): void => callback(point);
    ipcRenderer.on("context-menu-select-bubble", handler);
    return () =>
      ipcRenderer.removeListener("context-menu-select-bubble", handler);
  },

  onChatToolProgress: (
    callback: (runId: string, tool: string) => void,
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      runId: string,
      tool: string,
    ): void => callback(runId, tool);
    ipcRenderer.on("chat-tool-progress", handler);
    return () => ipcRenderer.removeListener("chat-tool-progress", handler);
  },

  onChatToolEvent: (
    callback: (runId: string, event: ChatToolEvent) => void,
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      runId: string,
      toolEvent: ChatToolEvent,
    ): void => callback(runId, toolEvent);
    ipcRenderer.on("chat-tool-event", handler);
    return () => ipcRenderer.removeListener("chat-tool-event", handler);
  },

  onChatUsage: (
    callback: (
      runId: string,
      usage: {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
        cost?: number;
        rateLimitRemaining?: number;
        rateLimitReset?: number;
        cacheReadTokens?: number;
        cacheWriteTokens?: number;
      },
    ) => void,
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      runId: string,
      usage: unknown,
    ): void => callback(runId, usage as Parameters<typeof callback>[1]);
    ipcRenderer.on("chat-usage", handler);
    return () => ipcRenderer.removeListener("chat-usage", handler);
  },

  onChatError: (
    callback: (runId: string, error: string) => void,
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      runId: string,
      error: string,
    ): void => callback(runId, error);
    ipcRenderer.on("chat-error", handler);
    return () => ipcRenderer.removeListener("chat-error", handler);
  },

  onChatAgentSegment: (
    callback: (runId: string, event: AgentConversationSegmentEvent) => void,
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      runId: string,
      segmentEvent: AgentConversationSegmentEvent,
    ): void => callback(runId, segmentEvent);
    ipcRenderer.on("chat-agent-segment", handler);
    return () => ipcRenderer.removeListener("chat-agent-segment", handler);
  },

  /** The agent asked a clarifying question mid-turn. The renderer shows an
   *  inline card and answers via `respondClarify`. */
  onClarifyRequest: (
    callback: (
      runId: string,
      req: {
        requestId: string;
        question: string;
        choices: string[];
      },
    ) => void,
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      runId: string,
      req: { requestId: string; question: string; choices: string[] },
    ): void => callback(runId, req);
    ipcRenderer.on("chat-clarify-request", handler);
    return () => ipcRenderer.removeListener("chat-clarify-request", handler);
  },

  /** Answer an inline clarify card. An empty/skip answer lets the agent proceed
   *  autonomously (the gateway treats it as "you decide"). */
  respondClarify: (requestId: string, answer: string): Promise<boolean> =>
    ipcRenderer.invoke("clarify-respond", { requestId, answer }),

  // Gateway
  startGateway: (): Promise<GatewayStartResult> =>
    ipcRenderer.invoke("start-gateway"),
  stopGateway: (): Promise<boolean> => ipcRenderer.invoke("stop-gateway"),
  restartGateway: (profile?: string): Promise<boolean> =>
    ipcRenderer.invoke("restart-gateway", profile),
  gatewayStatus: (): Promise<boolean> => ipcRenderer.invoke("gateway-status"),
  dashboardStatus: (profile?: string): Promise<DashboardStatus> =>
    ipcRenderer.invoke("dashboard-status", profile),
  freshDashboardWsUrl: (profile?: string): Promise<string> =>
    ipcRenderer.invoke("fresh-dashboard-ws-url", profile),
  startDashboard: (profile?: string): Promise<DashboardStatus> =>
    ipcRenderer.invoke("start-dashboard", profile),
  stopDashboard: (profile?: string): Promise<boolean> =>
    ipcRenderer.invoke("stop-dashboard", profile),

  // Platform toggles
  getPlatformEnabled: (profile?: string): Promise<Record<string, boolean>> =>
    ipcRenderer.invoke("get-platform-enabled", profile),
  setPlatformEnabled: (
    platform: string,
    enabled: boolean,
    profile?: string,
  ): Promise<boolean> =>
    ipcRenderer.invoke("set-platform-enabled", platform, enabled, profile),
  getMessagingPlatforms: (
    profile?: string,
  ): Promise<MessagingPlatformsResponse> =>
    ipcRenderer.invoke("get-messaging-platforms", profile),
  updateMessagingPlatform: (
    platform: string,
    update: MessagingPlatformUpdate,
    profile?: string,
  ): Promise<{ ok: boolean; platform: string }> =>
    ipcRenderer.invoke("update-messaging-platform", platform, update, profile),
  testMessagingPlatform: (
    platform: string,
    profile?: string,
  ): Promise<MessagingPlatformTestResponse> =>
    ipcRenderer.invoke("test-messaging-platform", platform, profile),

  // Sessions
  listSessions: (
    limit?: number,
    offset?: number,
  ): Promise<
    Array<{
      id: string;
      source: string;
      startedAt: number;
      endedAt: number | null;
      messageCount: number;
      model: string;
      title: string | null;
      preview: string;
      threadId?: string;
      segmentCount?: number;
    }>
  > => ipcRenderer.invoke("list-sessions", limit, offset),

  resolveSessionThread: (
    sessionId: string,
  ): Promise<AgentConversationThreadResumeProjection | null> =>
    ipcRenderer.invoke("resolve-session-thread", sessionId),

  getSessionMessages: (
    sessionId: string,
  ): Promise<
    Array<{
      id: number;
      role: "user" | "assistant";
      content: string;
      timestamp: number;
      attachments?: Attachment[];
    }>
  > => ipcRenderer.invoke("get-session-messages", sessionId),

  recordSessionContinuation: (
    sessionId: string,
    items: DesktopSessionContinuationItem[],
  ): Promise<boolean> =>
    ipcRenderer.invoke("record-session-continuation", sessionId, items),

  recordSessionLocalError: (
    sessionId: string,
    error: DesktopSessionLocalError,
  ): Promise<boolean> =>
    ipcRenderer.invoke("record-session-local-error", sessionId, error),

  getSessionContextFolder: (sessionId: string): Promise<string | null> =>
    ipcRenderer.invoke("get-session-context-folder", sessionId),

  setSessionContextFolder: (
    sessionId: string,
    folder: string | null,
  ): Promise<boolean> =>
    ipcRenderer.invoke("set-session-context-folder", sessionId, folder),

  listRecentSessionContextFolders: (limit?: number): Promise<string[]> =>
    ipcRenderer.invoke("list-recent-session-context-folders", limit),

  getSessionModelOverride: (
    sessionId: string,
  ): Promise<SessionModelOverride | null> =>
    ipcRenderer.invoke("get-session-model-override", sessionId),

  setSessionModelOverride: (
    sessionId: string,
    override: SessionModelOverride | null,
  ): Promise<boolean> =>
    ipcRenderer.invoke("set-session-model-override", sessionId, override),

  // Profiles
  listProfiles: (): Promise<
    Array<{
      id: string;
      name: string;
      displayName: string | null;
      path: string;
      isDefault: boolean;
      isActive: boolean;
      model: string;
      provider: string;
      hasEnv: boolean;
      hasSoul: boolean;
      skillCount: number;
      gatewayRunning: boolean;
      color?: string;
      avatar?: string | null;
      agentInstallationId?: string | null;
      runtimeProfileId?: string | null;
    }>
  > => ipcRenderer.invoke("list-profiles"),

  createProfile: (
    name: string,
    cloneFrom: string | null,
  ): Promise<{ success: boolean; error?: string; id?: string }> =>
    ipcRenderer.invoke("create-profile", name, cloneFrom),

  deleteProfile: (
    name: string,
  ): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke("delete-profile", name),

  setActiveProfile: (name: string): Promise<boolean> =>
    ipcRenderer.invoke("set-active-profile", name),

  setProfileColor: (
    name: string,
    color: string,
  ): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke("set-profile-color", name, color),

  setProfileName: (
    id: string,
    name: string,
  ): Promise<{
    success: boolean;
    error?: string;
    operationId?: string;
    identity?: {
      profileId: string;
      displayName: string;
      revision: number;
      updatedAt: string;
    };
  }> => ipcRenderer.invoke("set-profile-name", id, name),

  onAgentIdentityChanged: (
    callback: (identity: {
      profileId: string;
      displayName: string;
      revision: number;
      updatedAt: string;
    }) => void,
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      identity: {
        profileId: string;
        displayName: string;
        revision: number;
        updatedAt: string;
      },
    ): void => callback(identity);
    ipcRenderer.on("agent-identity-changed", handler);
    return () => ipcRenderer.removeListener("agent-identity-changed", handler);
  },

  setProfileAvatar: (
    name: string,
    dataUrl: string,
  ): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke("set-profile-avatar", name, dataUrl),

  removeProfileAvatar: (
    name: string,
  ): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke("remove-profile-avatar", name),

  listWallets: (profile?: string): Promise<ProfileWallet[]> =>
    ipcRenderer.invoke("list-wallets", profile),

  // Custom (OpenAI-compatible) providers, profile-scoped identity records.
  listCustomProviders: (profile?: string): Promise<CustomProviderRecord[]> =>
    ipcRenderer.invoke("list-custom-providers", profile),
  upsertCustomProvider: (
    profile: string | undefined,
    input: { name: string; baseUrl: string },
  ): Promise<CustomProviderRecord | null> =>
    ipcRenderer.invoke("upsert-custom-provider", profile, input),
  removeCustomProvider: (
    profile: string | undefined,
    name: string,
  ): Promise<void> =>
    ipcRenderer.invoke("remove-custom-provider", profile, name),

  // Cloud wallets from the backend for the profile's linked agent.
  syncWallets: (profile?: string): Promise<WalletSyncResult> =>
    ipcRenderer.invoke("wallet-sync", profile),

  // Backend-driven wallet ops (Office space representatives): token balances
  // for a cloud wallet, and provisioning a cloud wallet for the linked agent.
  getWalletPortfolio: (
    profile: string | undefined,
    walletId: string,
  ): Promise<WalletPortfolioResult> =>
    ipcRenderer.invoke("wallet-portfolio", profile, walletId),

  provisionCloudWallet: (profile?: string): Promise<ProvisionWalletResult> =>
    ipcRenderer.invoke("wallet-provision", profile),

  createWallet: (
    profile?: string,
    name?: string,
  ): Promise<WalletMutationResult> =>
    ipcRenderer.invoke("create-wallet", profile, name),

  importWallet: (input: ImportWalletInput): Promise<WalletMutationResult> =>
    ipcRenderer.invoke("import-wallet", input),

  renameWallet: (
    profile: string | undefined,
    id: string,
    name: string,
  ): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke("rename-wallet", profile, id, name),

  deleteWallet: (
    profile: string | undefined,
    id: string,
  ): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke("delete-wallet", profile, id),

  getTokenBalances: (address: string): Promise<TokenBalancesResponse> =>
    ipcRenderer.invoke("get-token-balances", address),

  // Memory
  readMemory: (
    profile?: string,
  ): Promise<{
    memory: { content: string; exists: boolean; lastModified: number | null };
    user: { content: string; exists: boolean; lastModified: number | null };
    stats: { totalSessions: number; totalMessages: number };
  }> => ipcRenderer.invoke("read-memory", profile),

  addMemoryEntry: (
    content: string,
    profile?: string,
  ): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke("add-memory-entry", content, profile),
  updateMemoryEntry: (
    index: number,
    content: string,
    profile?: string,
  ): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke("update-memory-entry", index, content, profile),
  removeMemoryEntry: (index: number, profile?: string): Promise<boolean> =>
    ipcRenderer.invoke("remove-memory-entry", index, profile),
  writeUserProfile: (
    content: string,
    profile?: string,
  ): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke("write-user-profile", content, profile),
  previewUserMemoryRepair: (
    profile?: string,
  ): Promise<{
    success: boolean;
    error?: string;
    preview?: {
      profileId: string;
      exists: boolean;
      content: string;
      charCount: number;
      currentSha256: string;
    };
  }> => ipcRenderer.invoke("preview-user-memory-repair", profile),
  applyUserMemoryRepair: (
    profile: string | undefined,
    expectedSha256: string,
    replacementContent: string,
    confirmed: boolean,
  ): Promise<{
    success: boolean;
    error?: string;
    operationId?: string;
    profileId?: string;
  }> =>
    ipcRenderer.invoke(
      "apply-user-memory-repair",
      profile,
      expectedSha256,
      replacementContent,
      confirmed,
    ),
  undoUserMemoryRepair: (
    profile: string | undefined,
    operationId: string,
  ): Promise<{ success: boolean; error?: string; profileId?: string }> =>
    ipcRenderer.invoke("undo-user-memory-repair", profile, operationId),

  // Soul
  readSoul: (profile?: string): Promise<string> =>
    ipcRenderer.invoke("read-soul", profile),
  writeSoul: (content: string, profile?: string): Promise<boolean> =>
    ipcRenderer.invoke("write-soul", content, profile),
  resetSoul: (profile?: string): Promise<string> =>
    ipcRenderer.invoke("reset-soul", profile),

  // Tools
  getToolsets: (
    profile?: string,
  ): Promise<
    Array<{ key: string; label: string; description: string; enabled: boolean }>
  > => ipcRenderer.invoke("get-toolsets", profile),
  setToolsetEnabled: (
    key: string,
    enabled: boolean,
    profile?: string,
  ): Promise<boolean> =>
    ipcRenderer.invoke("set-toolset-enabled", key, enabled, profile),
  getImageGenerationConfig: (
    profile?: string,
  ): Promise<ImageGenerationConfigReadResult> =>
    ipcRenderer.invoke("get-image-generation-config", profile),
  saveImageGenerationConfig: (
    request: ImageGenerationConfigDraft,
    profile?: string,
  ): Promise<ImageGenerationSaveResult> =>
    ipcRenderer.invoke("save-image-generation-config", request, profile),
  discoverImageGenerationModels: (
    request: ImageGenerationConfigDraft,
    profile?: string,
  ): Promise<ImageGenerationModelsResult> =>
    ipcRenderer.invoke("discover-image-generation-models", request, profile),
  testImageGeneration: (
    request: ImageGenerationConfigDraft,
    profile?: string,
  ): Promise<ImageGenerationTestResult> =>
    ipcRenderer.invoke("test-image-generation", request, profile),

  // Skills
  listInstalledSkills: (
    profile?: string,
  ): Promise<
    Array<{ name: string; category: string; description: string; path: string }>
  > => ipcRenderer.invoke("list-installed-skills", profile),
  listBundledSkills: (): Promise<
    Array<{
      name: string;
      description: string;
      category: string;
      source: string;
      installed: boolean;
    }>
  > => ipcRenderer.invoke("list-bundled-skills"),
  getSkillContent: (skillPath: string): Promise<string> =>
    ipcRenderer.invoke("get-skill-content", skillPath),
  installSkill: (
    identifier: string,
    profile?: string,
  ): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke("install-skill", identifier, profile),
  uninstallSkill: (
    name: string,
    profile?: string,
  ): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke("uninstall-skill", name, profile),

  // Session cache (fast local cache with generated titles)
  listCachedSessions: (
    limit?: number,
    offset?: number,
  ): Promise<
    Array<{
      id: string;
      title: string;
      startedAt: number;
      source: string;
      messageCount: number;
      model: string;
      contextFolder: string | null;
    }>
  > => ipcRenderer.invoke("list-cached-sessions", limit, offset),

  syncSessionCache: (): Promise<
    Array<{
      id: string;
      title: string;
      startedAt: number;
      source: string;
      messageCount: number;
      model: string;
      contextFolder: string | null;
    }>
  > => ipcRenderer.invoke("sync-session-cache"),

  updateSessionTitle: (sessionId: string, title: string): Promise<void> =>
    ipcRenderer.invoke("update-session-title", sessionId, title),
  deleteSession: (sessionId: string): Promise<void> =>
    ipcRenderer.invoke("delete-session", sessionId),
  deleteSessions: (
    sessionIds: string[],
  ): Promise<{ requested: number; deleted: number }> =>
    ipcRenderer.invoke("delete-sessions", sessionIds),

  // Session search
  searchSessions: (
    query: string,
    limit?: number,
  ): Promise<
    Array<{
      sessionId: string;
      title: string | null;
      startedAt: number;
      source: string;
      messageCount: number;
      model: string;
      snippet: string;
    }>
  > => ipcRenderer.invoke("search-sessions", query, limit),

  // Credential Pool (profile-aware: reads/writes the named profile's
  // auth.json; defaults to the currently active profile when omitted)
  //
  // Pool entries follow the upstream engine schema (issue #367) —
  // `access_token` for the secret, `auth_type` to distinguish OAuth
  // from API key, plus `id`/`priority`/`source` for rotation.
  getCredentialPool: (
    profile?: string,
  ): Promise<Record<string, Array<CredentialPoolEntry>>> =>
    ipcRenderer.invoke("get-credential-pool", profile),
  setCredentialPool: (
    provider: string,
    entries: Array<CredentialPoolEntry>,
    profile?: string,
  ): Promise<boolean> =>
    ipcRenderer.invoke("set-credential-pool", provider, entries, profile),
  // Add a manually-typed key as a properly-shaped pool entry. Returns
  // the updated entries list for the provider.
  addCredentialPoolEntry: (
    provider: string,
    apiKey: string,
    label: string,
    profile?: string,
  ): Promise<Array<CredentialPoolEntry>> =>
    ipcRenderer.invoke(
      "add-credential-pool-entry",
      provider,
      apiKey,
      label,
      profile,
    ),

  // Models
  listModels: (): Promise<
    Array<{
      id: string;
      name: string;
      provider: string;
      model: string;
      baseUrl: string;
      providerLabel?: string;
      contextLength?: number;
      capabilities?: string[];
      modalities?: { input?: string[]; output?: string[] };
      createdAt: number;
    }>
  > => ipcRenderer.invoke("list-models"),

  addModel: (
    name: string,
    provider: string,
    model: string,
    baseUrl: string,
    contextLength?: number,
    providerLabel?: string,
    apiMode?: string | null,
  ): Promise<{
    id: string;
    name: string;
    provider: string;
    model: string;
    baseUrl: string;
    contextLength?: number;
    providerLabel?: string;
    apiMode?: string | null;
    createdAt: number;
  }> =>
    ipcRenderer.invoke(
      "add-model",
      name,
      provider,
      model,
      baseUrl,
      contextLength,
      providerLabel,
      apiMode,
    ),

  removeModel: (id: string): Promise<boolean> =>
    ipcRenderer.invoke("remove-model", id),

  updateModel: (
    id: string,
    fields: Record<string, string>,
    contextLength?: number | null,
  ): Promise<boolean> =>
    ipcRenderer.invoke("update-model", id, fields, contextLength),

  // Shared model definitions (per-model-id metadata, local-only).
  listModelDefinitions: (): Promise<
    Array<{
      model: string;
      name?: string;
      contextLength?: number;
      capabilities?: string[];
      modalities?: { input?: string[]; output?: string[] };
      createdAt: number;
      updatedAt: number;
    }>
  > => ipcRenderer.invoke("list-model-definitions"),

  getModelDefinition: (
    model: string,
  ): Promise<{
    model: string;
    name?: string;
    contextLength?: number;
    capabilities?: string[];
    modalities?: { input?: string[]; output?: string[] };
    createdAt: number;
    updatedAt: number;
  } | null> => ipcRenderer.invoke("get-model-definition", model),

  setModelDefinition: (
    model: string,
    patch: {
      name?: string;
      contextLength?: number | null;
      capabilities?: string[];
      modalities?: { input?: string[]; output?: string[] };
    },
  ): Promise<{
    model: string;
    name?: string;
    contextLength?: number;
    capabilities?: string[];
    modalities?: { input?: string[]; output?: string[] };
    createdAt: number;
    updatedAt: number;
  } | null> => ipcRenderer.invoke("set-model-definition", model, patch),

  removeModelDefinition: (model: string): Promise<boolean> =>
    ipcRenderer.invoke("remove-model-definition", model),

  onModelLibraryChanged: (callback: () => void): (() => void) => {
    const handler = (): void => callback();
    ipcRenderer.on("model-library-changed", handler);
    return () => ipcRenderer.removeListener("model-library-changed", handler);
  },

  onCustomProvidersChanged: (callback: () => void): (() => void) => {
    const handler = (): void => callback();
    ipcRenderer.on("custom-providers-changed", handler);
    return () =>
      ipcRenderer.removeListener("custom-providers-changed", handler);
  },

  // Claw3D
  claw3dStatus: (): Promise<{
    cloned: boolean;
    installed: boolean;
    devServerRunning: boolean;
    adapterRunning: boolean;
    port: number;
    portInUse: boolean;
    wsUrl: string;
    running: boolean;
    error: string;
    remoteUrl?: string | null;
    remoteSource?: "ssh" | null;
  }> => ipcRenderer.invoke("claw3d-status"),

  claw3dSetup: (): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke("claw3d-setup"),

  onClaw3dSetupProgress: (
    callback: (progress: {
      step: number;
      totalSteps: number;
      title: string;
      detail: string;
      log: string;
    }) => void,
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      progress: unknown,
    ): void =>
      callback(
        progress as {
          step: number;
          totalSteps: number;
          title: string;
          detail: string;
          log: string;
        },
      );
    ipcRenderer.on("claw3d-setup-progress", handler);
    return () => ipcRenderer.removeListener("claw3d-setup-progress", handler);
  },

  claw3dGetPort: (): Promise<number> => ipcRenderer.invoke("claw3d-get-port"),
  claw3dSetPort: (port: number): Promise<boolean> =>
    ipcRenderer.invoke("claw3d-set-port", port),
  claw3dGetWsUrl: (): Promise<string> =>
    ipcRenderer.invoke("claw3d-get-ws-url"),
  claw3dSetWsUrl: (url: string): Promise<boolean> =>
    ipcRenderer.invoke("claw3d-set-ws-url", url),

  claw3dStartAll: (
    profile?: string,
  ): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke("claw3d-start-all", profile),
  claw3dStopAll: (): Promise<boolean> => ipcRenderer.invoke("claw3d-stop-all"),
  claw3dGetLogs: (): Promise<string> => ipcRenderer.invoke("claw3d-get-logs"),

  claw3dStartDev: (): Promise<boolean> =>
    ipcRenderer.invoke("claw3d-start-dev"),
  claw3dStopDev: (): Promise<boolean> => ipcRenderer.invoke("claw3d-stop-dev"),
  claw3dStartAdapter: (): Promise<boolean> =>
    ipcRenderer.invoke("claw3d-start-adapter"),
  claw3dStopAdapter: (): Promise<boolean> =>
    ipcRenderer.invoke("claw3d-stop-adapter"),

  // Updates
  checkForUpdates: (): Promise<string | null> =>
    ipcRenderer.invoke("check-for-updates"),
  getDesktopUpdateState: (): Promise<{
    state:
      | "available"
      | "downloading"
      | "ready"
      | "error"
      | "checking"
      | "uptodate"
      | null;
    version: string | null;
    releaseNotes: string | null;
    percent: number | null;
    error: string | null;
  }> => ipcRenderer.invoke("get-desktop-update-state"),
  downloadUpdate: (): Promise<boolean> => ipcRenderer.invoke("download-update"),
  installUpdate: (): Promise<void> => ipcRenderer.invoke("install-update"),
  getAppVersion: (): Promise<string> => ipcRenderer.invoke("get-app-version"),
  getAutoUpgradeEnabled: (): Promise<boolean> =>
    ipcRenderer.invoke("get-auto-upgrade-enabled"),
  setAutoUpgradeEnabled: (enabled: boolean): Promise<boolean> =>
    ipcRenderer.invoke("set-auto-upgrade-enabled", enabled),

  onUpdateAvailable: (
    callback: (info: { version: string; releaseNotes: string }) => void,
  ): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, info: unknown): void =>
      callback(info as { version: string; releaseNotes: string });
    ipcRenderer.on("update-available", handler);
    return () => ipcRenderer.removeListener("update-available", handler);
  },

  onUpdateDownloadProgress: (
    callback: (info: { percent: number }) => void,
  ): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, info: unknown): void =>
      callback(info as { percent: number });
    ipcRenderer.on("update-download-progress", handler);
    return () =>
      ipcRenderer.removeListener("update-download-progress", handler);
  },

  onUpdateDownloaded: (callback: () => void): (() => void) => {
    const handler = (): void => callback();
    ipcRenderer.on("update-downloaded", handler);
    return () => ipcRenderer.removeListener("update-downloaded", handler);
  },

  onUpdateError: (callback: (message: string) => void): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      message: unknown,
    ): void => callback(String(message));
    ipcRenderer.on("update-error", handler);
    return () => ipcRenderer.removeListener("update-error", handler);
  },

  // Menu events (from native menu bar)
  onMenuNewChat: (callback: () => void): (() => void) => {
    const handler = (): void => callback();
    ipcRenderer.on("menu-new-chat", handler);
    return () => ipcRenderer.removeListener("menu-new-chat", handler);
  },

  onMenuSearchSessions: (callback: () => void): (() => void) => {
    const handler = (): void => callback();
    ipcRenderer.on("menu-search-sessions", handler);
    return () => ipcRenderer.removeListener("menu-search-sessions", handler);
  },

  // Cron Jobs
  listCronJobs: (
    includeDisabled?: boolean,
    profile?: string,
  ): Promise<
    Array<{
      id: string;
      name: string;
      schedule: string;
      prompt: string;
      state: "active" | "paused" | "completed";
      enabled: boolean;
      next_run_at: string | null;
      last_run_at: string | null;
      last_status: string | null;
      last_error: string | null;
      repeat: { times: number | null; completed: number } | null;
      deliver: string[];
      skills: string[];
      script: string | null;
    }>
  > => ipcRenderer.invoke("list-cron-jobs", includeDisabled, profile),

  createCronJob: (
    schedule: string,
    prompt?: string,
    name?: string,
    deliver?: string,
    profile?: string,
  ): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke(
      "create-cron-job",
      schedule,
      prompt,
      name,
      deliver,
      profile,
    ),

  removeCronJob: (
    jobId: string,
    profile?: string,
  ): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke("remove-cron-job", jobId, profile),

  pauseCronJob: (
    jobId: string,
    profile?: string,
  ): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke("pause-cron-job", jobId, profile),

  resumeCronJob: (
    jobId: string,
    profile?: string,
  ): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke("resume-cron-job", jobId, profile),

  triggerCronJob: (
    jobId: string,
    profile?: string,
  ): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke("trigger-cron-job", jobId, profile),

  // Kanban
  kanbanListBoards: (includeArchived?: boolean, profile?: string) =>
    ipcRenderer.invoke("kanban-list-boards", includeArchived, profile),
  kanbanCurrentBoard: (profile?: string) =>
    ipcRenderer.invoke("kanban-current-board", profile),
  kanbanSwitchBoard: (slug: string, profile?: string) =>
    ipcRenderer.invoke("kanban-switch-board", slug, profile),
  kanbanCreateBoard: (
    slug: string,
    name?: string,
    switchAfter?: boolean,
    profile?: string,
  ) =>
    ipcRenderer.invoke("kanban-create-board", slug, name, switchAfter, profile),
  kanbanRemoveBoard: (slug: string, hardDelete?: boolean, profile?: string) =>
    ipcRenderer.invoke("kanban-remove-board", slug, hardDelete, profile),
  kanbanListTasks: (filters?: {
    status?: string;
    assignee?: string;
    tenant?: string;
    includeArchived?: boolean;
    profile?: string;
  }) => ipcRenderer.invoke("kanban-list-tasks", filters),
  kanbanGetTask: (taskId: string, profile?: string) =>
    ipcRenderer.invoke("kanban-get-task", taskId, profile),
  kanbanCreateTask: (
    input: {
      title: string;
      body?: string;
      assignee?: string;
      priority?: number;
      tenant?: string;
      workspace?: string;
      triage?: boolean;
      skills?: string[];
      maxRetries?: number;
    },
    profile?: string,
  ) => ipcRenderer.invoke("kanban-create-task", input, profile),
  selectFolder: (): Promise<string | null> =>
    ipcRenderer.invoke("select-folder"),
  readDirectory: (
    dirPath: string,
  ): Promise<{ name: string; isDirectory: boolean }[] | null> =>
    ipcRenderer.invoke("read-directory", dirPath),
  readFile: (
    filePath: string,
    maxBytes?: number,
  ): Promise<{ content: string; truncated: boolean } | null> =>
    ipcRenderer.invoke("read-file", filePath, maxBytes),
  openFileInEditor: (filePath: string): Promise<boolean> =>
    ipcRenderer.invoke("open-file-in-editor", filePath),
  openTerminal: (dirPath: string): Promise<boolean> =>
    ipcRenderer.invoke("open-terminal", dirPath),
  readImageFile: (filePath: string): Promise<string | null> =>
    ipcRenderer.invoke("read-image-file", filePath),
  kanbanAssignTask: (
    taskId: string,
    assignee: string | null,
    profile?: string,
  ) => ipcRenderer.invoke("kanban-assign-task", taskId, assignee, profile),
  kanbanCompleteTask: (taskId: string, result?: string, profile?: string) =>
    ipcRenderer.invoke("kanban-complete-task", taskId, result, profile),
  kanbanBlockTask: (taskId: string, reason?: string, profile?: string) =>
    ipcRenderer.invoke("kanban-block-task", taskId, reason, profile),
  kanbanUnblockTask: (taskId: string, profile?: string) =>
    ipcRenderer.invoke("kanban-unblock-task", taskId, profile),
  kanbanArchiveTask: (taskId: string, profile?: string) =>
    ipcRenderer.invoke("kanban-archive-task", taskId, profile),
  kanbanPromoteTask: (taskId: string, profile?: string) =>
    ipcRenderer.invoke("kanban-promote-task", taskId, profile),
  kanbanScheduleTask: (taskId: string, reason?: string, profile?: string) =>
    ipcRenderer.invoke("kanban-schedule-task", taskId, reason, profile),
  kanbanSpecifyTask: (taskId: string, profile?: string) =>
    ipcRenderer.invoke("kanban-specify-task", taskId, profile),
  kanbanReclaimTask: (taskId: string, reason?: string, profile?: string) =>
    ipcRenderer.invoke("kanban-reclaim-task", taskId, reason, profile),
  kanbanCommentTask: (taskId: string, body: string, profile?: string) =>
    ipcRenderer.invoke("kanban-comment-task", taskId, body, profile),
  kanbanDispatchOnce: (dryRun?: boolean, profile?: string) =>
    ipcRenderer.invoke("kanban-dispatch-once", dryRun, profile),
  kanbanListClaw3dHqTasks: () =>
    ipcRenderer.invoke("kanban-list-claw3d-hq-tasks"),

  // Shell
  openExternal: (url: string): Promise<void> =>
    ipcRenderer.invoke("open-external", url),

  // Backup / Import
  runHermesBackup: (
    profile?: string,
  ): Promise<{ success: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke("run-hermes-backup", profile),

  runHermesImport: (
    archivePath: string,
    profile?: string,
  ): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke("run-hermes-import", archivePath, profile),

  // Debug dump
  runHermesDump: (): Promise<string> => ipcRenderer.invoke("run-hermes-dump"),

  // Memory providers
  discoverMemoryProviders: (
    profile?: string,
  ): Promise<
    Array<{
      name: string;
      description: string;
      installed: boolean;
      active: boolean;
      envVars: string[];
    }>
  > => ipcRenderer.invoke("discover-memory-providers", profile),

  // MCP servers
  listMcpServers: (
    profile?: string,
  ): Promise<
    Array<{
      name: string;
      type: "http" | "stdio" | "unknown";
      transport: "http" | "stdio" | "unknown";
      enabled: boolean;
      detail: string;
      url?: string;
      command?: string;
      args: string[];
      env: Record<string, string>;
      auth?: string;
      tools?: unknown;
    }>
  > => ipcRenderer.invoke("list-mcp-servers", profile),
  addMcpServer: (
    input: {
      name: string;
      type: "http" | "stdio";
      url?: string;
      command?: string;
      args?: string[];
      env?: Record<string, string>;
      auth?: string;
    },
    profile?: string,
  ): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke("add-mcp-server", input, profile),
  removeMcpServer: (
    name: string,
    profile?: string,
  ): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke("remove-mcp-server", name, profile),
  setMcpServerEnabled: (
    name: string,
    enabled: boolean,
    profile?: string,
  ): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke("set-mcp-server-enabled", name, enabled, profile),
  testMcpServer: (
    name: string,
    profile?: string,
  ): Promise<{
    success: boolean;
    error?: string;
    tools?: Array<{ name: string; description: string }>;
  }> => ipcRenderer.invoke("test-mcp-server", name, profile),
  listMcpCatalog: (
    profile?: string,
  ): Promise<{
    entries: Array<{
      name: string;
      description: string;
      source: string;
      transport: "http" | "stdio" | "unknown";
      authType: string;
      requiredEnv: Array<{ name: string; prompt: string; required: boolean }>;
      needsInstall: boolean;
      installed: boolean;
      enabled: boolean;
    }>;
    diagnostics: unknown[];
    error?: string;
  }> => ipcRenderer.invoke("list-mcp-catalog", profile),
  installMcpCatalogEntry: (
    name: string,
    env?: Record<string, string>,
    profile?: string,
  ): Promise<{
    success: boolean;
    error?: string;
    background?: boolean;
    action?: string;
  }> => ipcRenderer.invoke("install-mcp-catalog-entry", name, env, profile),

  // Discover marketplace (community registry)
  fetchRegistry: (force?: boolean) =>
    ipcRenderer.invoke("registry-fetch", force),
  fetchModelRegistry: (force?: boolean) =>
    ipcRenderer.invoke("registry-fetch-models", force),
  listInstalledRegistry: (profile?: string) =>
    ipcRenderer.invoke("registry-list-installed", profile),
  fetchRegistryDetail: (kind: string, item: unknown) =>
    ipcRenderer.invoke("registry-detail", kind, item),
  installRegistryItem: (
    kind: string,
    item: unknown,
    profile?: string,
  ): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke("registry-install", kind, item, profile),

  // Log viewer
  readLogs: (
    logFile?: string,
    lines?: number,
  ): Promise<{ content: string; path: string }> =>
    ipcRenderer.invoke("read-logs", logFile, lines),
};

const agenteraAuthAPI = {
  getState: (): Promise<AgenteraAuthPublicState> =>
    ipcRenderer.invoke("agentera-auth-get-state"),
  startLogin: (options?: { forceAccountSelection?: boolean }): Promise<void> =>
    ipcRenderer.invoke("agentera-auth-start-login", options),
  restartLogin: (options?: {
    forceAccountSelection?: boolean;
  }): Promise<void> =>
    ipcRenderer.invoke("agentera-auth-restart-login", options),
  cancelLogin: (): Promise<void> =>
    ipcRenderer.invoke("agentera-auth-cancel-login"),
  copyLoginLink: (): Promise<void> =>
    ipcRenderer.invoke("agentera-auth-copy-login-link"),
  retryOnline: (): Promise<AgenteraAuthPublicState> =>
    ipcRenderer.invoke("agentera-auth-retry-online"),
  logout: (): Promise<void> => ipcRenderer.invoke("agentera-auth-logout"),
  openPortal: (target: AgenteraPortalTarget): Promise<void> =>
    ipcRenderer.invoke("agentera-auth-open-portal", target),
  getUserProfile: (): Promise<AgenteraUserProfile> =>
    ipcRenderer.invoke("agentera-user-profile-get"),
  updateUserProfile: (
    input: AgenteraUserProfileInput,
  ): Promise<AgenteraUserProfile> =>
    ipcRenderer.invoke("agentera-user-profile-update", input),
  onUserProfileChanged: (
    callback: (profile: AgenteraUserProfile) => void,
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      profile: AgenteraUserProfile,
    ): void => callback(profile);
    ipcRenderer.on("agentera-user-profile-changed", handler);
    return () =>
      ipcRenderer.removeListener("agentera-user-profile-changed", handler);
  },
  onStateChanged: (
    callback: (state: AgenteraAuthPublicState) => void,
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      state: AgenteraAuthPublicState,
    ): void => callback(state);
    ipcRenderer.on("agentera-auth-state-changed", handler);
    return () =>
      ipcRenderer.removeListener("agentera-auth-state-changed", handler);
  },
};

const agenteraGlobalProfileAPI = {
  get: (): Promise<AgenteraGlobalProfileResult<AgenteraGlobalProfile>> =>
    ipcRenderer.invoke("agentera-global-profile-get"),
  setEntry: (
    input: SetAgenteraGlobalProfileEntryInput,
  ): Promise<AgenteraGlobalProfileResult<AgenteraGlobalProfile>> =>
    ipcRenderer.invoke("agentera-global-profile-set", input),
  removeEntry: (
    entryId: string,
  ): Promise<AgenteraGlobalProfileResult<AgenteraGlobalProfile>> =>
    ipcRenderer.invoke("agentera-global-profile-remove", entryId),
  listHistory: (): Promise<
    AgenteraGlobalProfileResult<AgenteraGlobalProfileHistoryItem[]>
  > => ipcRenderer.invoke("agentera-global-profile-history"),
  rollback: (
    targetVersion: number,
  ): Promise<AgenteraGlobalProfileResult<AgenteraGlobalProfile>> =>
    ipcRenderer.invoke("agentera-global-profile-rollback", targetVersion),
  prepareConversationContext: (
    input: PrepareAgenteraGlobalProfileConversationContextInput,
  ): Promise<AgenteraGlobalProfileConversationContext> =>
    ipcRenderer.invoke(
      "agentera-global-profile-conversation-context",
      input.runId,
      input.profile,
      input.resumeSessionId,
    ),
  extractCandidates: (
    rawText: string,
    profile: string,
  ): Promise<
    AgenteraMemoryCandidateResult<AgenteraMemoryCandidateBatch | null>
  > =>
    ipcRenderer.invoke("agentera-memory-candidates-extract", rawText, profile),
  confirmCandidates: (
    batchId: string,
    profile: string,
  ): Promise<
    AgenteraMemoryCandidateResult<AgenteraMemoryCandidateConfirmation>
  > =>
    ipcRenderer.invoke("agentera-memory-candidates-confirm", batchId, profile),
  rejectCandidates: (
    batchId: string,
    profile: string,
  ): Promise<AgenteraMemoryCandidateResult<AgenteraMemoryCandidateBatch>> =>
    ipcRenderer.invoke("agentera-memory-candidates-reject", batchId, profile),
  onChanged: (
    callback: (profile: AgenteraGlobalProfile) => void,
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      profile: AgenteraGlobalProfile,
    ): void => callback(profile);
    ipcRenderer.on("agentera-global-profile-changed", handler);
    return () =>
      ipcRenderer.removeListener("agentera-global-profile-changed", handler);
  },
};

const agenteraOfficialQualityAPI = {
  getConsent: (): Promise<OfficialQualityConsentSettings> =>
    ipcRenderer.invoke("agentera-official-quality-get-consent"),
  setPassiveConsent: (
    enabled: boolean,
  ): Promise<OfficialQualityConsentReceipt> =>
    ipcRenderer.invoke("agentera-official-quality-set-passive-consent", {
      enabled,
    }),
  setExplicitFeedbackConsent: (
    enabled: boolean,
  ): Promise<OfficialQualityConsentReceipt> =>
    ipcRenderer.invoke(
      "agentera-official-quality-set-explicit-feedback-consent",
      { enabled },
    ),
  submitFeedback: (
    input: OfficialQualityFeedbackSubmission,
  ): Promise<OfficialQualityFeedbackSubmissionResult> =>
    ipcRenderer.invoke("agentera-official-quality-submit-feedback", input),
  onEligible: (
    callback: (
      runId: string,
      eligibility: OfficialQualityFeedbackEligibility,
    ) => void,
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      runId: string,
      eligibility: OfficialQualityFeedbackEligibility,
    ): void => callback(runId, eligibility);
    ipcRenderer.on("agentera-official-quality-eligible", handler);
    return () =>
      ipcRenderer.removeListener("agentera-official-quality-eligible", handler);
  },
};

const agenteraEncryptedBackupAPI = {
  getState: (): Promise<AgenteraEncryptedBackupPublicState> =>
    ipcRenderer.invoke("agentera-encrypted-backup-get-state"),
  initializeRecovery: (): Promise<AgenteraEncryptedBackupPublicEnrollment> =>
    ipcRenderer.invoke("agentera-encrypted-backup-initialize-recovery", {
      confirmation: "initialize-recovery",
    }),
  confirmRecoverySaved: (): Promise<AgenteraEncryptedBackupPublicState> =>
    ipcRenderer.invoke("agentera-encrypted-backup-confirm-recovery", {
      confirmation: "recovery-written-down",
    }),
  registerCurrentDevice: (): Promise<AgenteraEncryptedBackupPublicDevice[]> =>
    ipcRenderer.invoke("agentera-encrypted-backup-register-current-device", {
      confirmation: "register-current-device",
    }),
  authorizeDevice: (
    deviceId: string,
  ): Promise<AgenteraEncryptedBackupPublicDevice[]> =>
    ipcRenderer.invoke("agentera-encrypted-backup-authorize-device", {
      deviceId,
      confirmation: "authorize-device",
    }),
  createBackup: (
    installationId: string,
  ): Promise<AgenteraEncryptedBackupCreationResult> =>
    ipcRenderer.invoke("agentera-encrypted-backup-create", {
      installationId,
    }),
  cancelBackup: (installationId: string): Promise<boolean> =>
    ipcRenderer.invoke("agentera-encrypted-backup-cancel", {
      installationId,
    }),
  listBackups: (): Promise<AgenteraEncryptedBackupPublicSummary[]> =>
    ipcRenderer.invoke("agentera-encrypted-backup-list"),
  deleteBackup: (backupId: string): Promise<void> =>
    ipcRenderer.invoke("agentera-encrypted-backup-delete", {
      backupId,
      confirmation: "delete-backup",
    }),
  setDailySchedule: (
    installationId: string,
    enabled: boolean,
  ): Promise<AgenteraEncryptedBackupPublicState> =>
    ipcRenderer.invoke("agentera-encrypted-backup-set-daily-schedule", {
      installationId,
      enabled,
    }),
  listDevices: (): Promise<AgenteraEncryptedBackupPublicDevice[]> =>
    ipcRenderer.invoke("agentera-encrypted-backup-list-devices"),
  revokeDevice: (
    deviceId: string,
  ): Promise<AgenteraEncryptedBackupPublicDevice[]> =>
    ipcRenderer.invoke("agentera-encrypted-backup-revoke-device", {
      deviceId,
      confirmation: "revoke-device",
    }),
  prepareRestore: (
    backupId: string,
    recoveryPhrase?: string,
  ): Promise<AgenteraEncryptedBackupPreparedRestore> =>
    ipcRenderer.invoke("agentera-encrypted-backup-prepare-restore", {
      backupId,
      ...(recoveryPhrase === undefined ? {} : { recoveryPhrase }),
    }),
  confirmRestore: (
    preparationId: string,
    name: string,
  ): Promise<AgenteraEncryptedBackupConfirmedRestore> =>
    ipcRenderer.invoke("agentera-encrypted-backup-confirm-restore", {
      preparationId,
      name,
      confirmation: "restore-into-new-profile",
    }),
  cancelRestore: (preparationId: string): Promise<boolean> =>
    ipcRenderer.invoke("agentera-encrypted-backup-cancel-restore", {
      preparationId,
    }),
  onProgress: (
    callback: (progress: AgenteraEncryptedBackupProgress[]) => void,
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      progress: AgenteraEncryptedBackupProgress[],
    ): void => callback(progress);
    ipcRenderer.on("agentera-encrypted-backup-progress", handler);
    return () =>
      ipcRenderer.removeListener("agentera-encrypted-backup-progress", handler);
  },
};

const agenteraRuntimeAccessAPI = {
  probeInstallFiles: (): Promise<AgenteraInstallFileProbe> =>
    ipcRenderer.invoke("agentera-install-file-probe"),
  runStartupPreflight: (): Promise<AgenteraStartupPreflightPublicResult> =>
    ipcRenderer.invoke("agentera-startup-preflight"),
  resolveAccountProfile:
    (): Promise<AgenteraAccountProfileResolutionPublicState> =>
      ipcRenderer.invoke("agentera-profile-resolve-account-space"),
  inspectActiveProfile: (): Promise<AgenteraProfileClaimPublicState> =>
    ipcRenderer.invoke("agentera-profile-inspect-active"),
  bindActiveProfile: (): Promise<AgenteraBoundProfilePublicState> =>
    ipcRenderer.invoke("agentera-profile-bind-active"),
  createFreshProfile: (
    name: string,
  ): Promise<AgenteraFreshProfilePublicState> =>
    ipcRenderer.invoke("agentera-profile-create-fresh", name),
  listUnboundProfiles: (): Promise<AgenteraUnboundProfilePublicState[]> =>
    ipcRenderer.invoke("agentera-profile-list-unbound"),
  inspectCurrentConnection: (): Promise<AgenteraConnectionClaimPublicState> =>
    ipcRenderer.invoke("agentera-connection-inspect-current"),
  bindCurrentConnection: (): Promise<AgenteraBoundConnectionPublicState> =>
    ipcRenderer.invoke("agentera-connection-bind-current"),
  switchToLocal: (): Promise<void> =>
    ipcRenderer.invoke("agentera-switch-to-local"),
};

const agenteraRuntimeDistributionAPI = {
  getState: (): Promise<RuntimeDistributionPublicState> =>
    ipcRenderer.invoke("agentera-runtime-get-state"),
  checkForUpdate: (): Promise<RuntimeDistributionPublicState> =>
    ipcRenderer.invoke("agentera-runtime-check-update"),
  downloadConfirmed: (): Promise<RuntimeDistributionPublicState> =>
    ipcRenderer.invoke("agentera-runtime-download-confirmed"),
  cancelDownload: (): Promise<RuntimeDistributionPublicState> =>
    ipcRenderer.invoke("agentera-runtime-cancel-download"),
  restartToApply: (): Promise<RuntimeDistributionPublicState> =>
    ipcRenderer.invoke("agentera-runtime-restart-apply"),
  retryRepair: (): Promise<RuntimeDistributionPublicState> =>
    ipcRenderer.invoke("agentera-runtime-retry-repair"),
  onStateChanged: (
    callback: (state: RuntimeDistributionPublicState) => void,
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      state: RuntimeDistributionPublicState,
    ): void => callback(state);
    ipcRenderer.on("agentera-runtime-state-changed", handler);
    return () =>
      ipcRenderer.removeListener("agentera-runtime-state-changed", handler);
  },
};

const agenteraDesktopControlAPI = {
  getState: (): Promise<DesktopControlPublicState> =>
    ipcRenderer.invoke("agentera-desktop-control-get-state"),
  onStateChanged: (
    callback: (state: DesktopControlPublicState) => void,
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      state: DesktopControlPublicState,
    ): void => callback(state);
    ipcRenderer.on("agentera-desktop-control-state-changed", handler);
    return () =>
      ipcRenderer.removeListener(
        "agentera-desktop-control-state-changed",
        handler,
      );
  },
};

const agenteraProductSpaceAPI = {
  getState: (): Promise<ProductSpaceResult<ProductSpacePublicState>> =>
    ipcRenderer.invoke("agentera-product-space-get-state"),
  refresh: (): Promise<ProductSpaceResult<ProductSpacePublicState>> =>
    ipcRenderer.invoke("agentera-product-space-refresh"),
  select: (
    input: StoredProductSpaceSelection,
  ): Promise<ProductSpaceResult<ProductSpacePublicState>> =>
    ipcRenderer.invoke("agentera-product-space-select", input),
  onStateChanged: (
    callback: (state: ProductSpacePublicState) => void,
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      state: ProductSpacePublicState,
    ): void => callback(state);
    ipcRenderer.on("agentera-product-space-state-changed", handler);
    return () =>
      ipcRenderer.removeListener(
        "agentera-product-space-state-changed",
        handler,
      );
  },
};

const agenteraOrganizationAPI = {
  getState: (): Promise<AgenteraOrganizationResult<OrganizationPublicState>> =>
    ipcRenderer.invoke("agentera-organization-get-state"),
  refresh: (): Promise<AgenteraOrganizationResult<OrganizationPublicState>> =>
    ipcRenderer.invoke("agentera-organization-refresh"),
  create: (input: {
    displayName: string;
  }): Promise<AgenteraOrganizationResult<OrganizationSummary>> =>
    ipcRenderer.invoke("agentera-organization-create", input),
  rename: (input: {
    organizationId: string;
    displayName: string;
    expectedRevision: number;
  }): Promise<AgenteraOrganizationResult<OrganizationSummary>> =>
    ipcRenderer.invoke("agentera-organization-rename", input),
  archive: (input: {
    organizationId: string;
    expectedRevision: number;
  }): Promise<AgenteraOrganizationResult<OrganizationSummary>> =>
    ipcRenderer.invoke("agentera-organization-archive", input),
  restore: (input: {
    organizationId: string;
    expectedRevision: number;
  }): Promise<AgenteraOrganizationResult<OrganizationSummary>> =>
    ipcRenderer.invoke("agentera-organization-restore", input),
  transferOwner: (input: {
    organizationId: string;
    targetUserId: string;
    expectedOrganizationRevision: number;
    expectedOwnerRevision: number;
    expectedTargetRevision: number;
    confirmation: "transfer-organization-owner";
  }): Promise<AgenteraOrganizationResult<OrganizationSummary>> =>
    ipcRenderer.invoke("agentera-organization-transfer-owner", input),
  dissolve: (input: {
    organizationId: string;
    displayName: string;
    expectedRevision: number;
    confirmation: "dissolve-organization";
  }): Promise<AgenteraOrganizationResult<OrganizationSummary>> =>
    ipcRenderer.invoke("agentera-organization-dissolve", input),
  listMembers: (input: {
    organizationId: string;
  }): Promise<
    AgenteraOrganizationResult<OrganizationCachedCollection<OrganizationMember>>
  > => ipcRenderer.invoke("agentera-organization-list-members", input),
  patchMember: (input: {
    organizationId: string;
    userId: string;
    patch: OrganizationMemberPatch;
  }): Promise<AgenteraOrganizationResult<OrganizationMember>> =>
    ipcRenderer.invoke("agentera-organization-patch-member", input),
  removeMember: (input: {
    organizationId: string;
    userId: string;
    expectedRevision: number;
  }): Promise<AgenteraOrganizationResult<true>> =>
    ipcRenderer.invoke("agentera-organization-remove-member", input),
  leave: (input: {
    organizationId: string;
  }): Promise<AgenteraOrganizationResult<true>> =>
    ipcRenderer.invoke("agentera-organization-leave", input),
  listDepartments: (input: {
    organizationId: string;
  }): Promise<
    AgenteraOrganizationResult<
      OrganizationCachedCollection<OrganizationDepartment>
    >
  > => ipcRenderer.invoke("agentera-organization-list-departments", input),
  createDepartment: (input: {
    organizationId: string;
    displayName: string;
  }): Promise<AgenteraOrganizationResult<OrganizationDepartment>> =>
    ipcRenderer.invoke("agentera-organization-create-department", input),
  renameDepartment: (input: {
    organizationId: string;
    departmentId: string;
    displayName: string;
    expectedRevision: number;
  }): Promise<AgenteraOrganizationResult<OrganizationDepartment>> =>
    ipcRenderer.invoke("agentera-organization-rename-department", input),
  archiveDepartment: (input: {
    organizationId: string;
    departmentId: string;
    expectedRevision: number;
  }): Promise<AgenteraOrganizationResult<OrganizationDepartment>> =>
    ipcRenderer.invoke("agentera-organization-archive-department", input),
  restoreDepartment: (input: {
    organizationId: string;
    departmentId: string;
    expectedRevision: number;
  }): Promise<AgenteraOrganizationResult<OrganizationDepartment>> =>
    ipcRenderer.invoke("agentera-organization-restore-department", input),
  listInvitations: (input: {
    organizationId: string;
  }): Promise<
    AgenteraOrganizationResult<
      OrganizationCachedCollection<OrganizationInvitation>
    >
  > => ipcRenderer.invoke("agentera-organization-list-invitations", input),
  createInvitation: (input: {
    organizationId: string;
  }): Promise<AgenteraOrganizationResult<OrganizationInvitationCreation>> =>
    ipcRenderer.invoke("agentera-organization-create-invitation", input),
  revokeInvitation: (input: {
    organizationId: string;
    invitationId: string;
  }): Promise<AgenteraOrganizationResult<true>> =>
    ipcRenderer.invoke("agentera-organization-revoke-invitation", input),
  acceptInvitation: (input: {
    token: string;
  }): Promise<AgenteraOrganizationResult<OrganizationInvitationAcceptance>> =>
    ipcRenderer.invoke("agentera-organization-accept-invitation", input),
  submitInvitationLink: (input: {
    inviteUrl: string;
  }): Promise<AgenteraOrganizationResult<true>> =>
    ipcRenderer.invoke("agentera-organization-submit-invitation-link", input),
  getPendingInvitation: (): Promise<
    AgenteraOrganizationResult<OrganizationPendingInvitation | null>
  > => ipcRenderer.invoke("agentera-organization-get-pending-invitation"),
  dismissPendingInvitation: (input: {
    token: string;
  }): Promise<AgenteraOrganizationResult<boolean>> =>
    ipcRenderer.invoke(
      "agentera-organization-dismiss-pending-invitation",
      input,
    ),
  getCurrentPolicy: (input: {
    organizationId: string;
  }): Promise<AgenteraOrganizationResult<OrganizationCurrentPolicyState>> =>
    ipcRenderer.invoke("agentera-organization-get-current-policy", input),
  listPolicySnapshots: (input: {
    organizationId: string;
  }): Promise<
    AgenteraOrganizationResult<readonly OrganizationPolicySummary[]>
  > => ipcRenderer.invoke("agentera-organization-list-policy-snapshots", input),
  publishPolicy: (input: {
    organizationId: string;
    document: OrganizationPolicyDocument;
    expectedOrganizationRevision: number;
    expectedPolicyVersion: number;
  }): Promise<AgenteraOrganizationResult<OrganizationPolicySnapshot>> =>
    ipcRenderer.invoke("agentera-organization-publish-policy", input),
  getPolicySnapshot: (input: {
    organizationId: string;
    policySnapshotId: string;
  }): Promise<AgenteraOrganizationResult<OrganizationPolicySnapshot>> =>
    ipcRenderer.invoke("agentera-organization-get-policy-snapshot", input),
  listAuditEvents: (input: {
    organizationId: string;
    limit?: number;
    cursor?: string;
  }): Promise<
    AgenteraOrganizationResult<OrganizationPage<OrganizationAuditEvent>>
  > => ipcRenderer.invoke("agentera-organization-list-audit-events", input),
  onStateChanged: (
    callback: (state: OrganizationPublicState) => void,
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      state: OrganizationPublicState,
    ): void => callback(state);
    ipcRenderer.on("agentera-organization-state-changed", handler);
    return () =>
      ipcRenderer.removeListener(
        "agentera-organization-state-changed",
        handler,
      );
  },
  onInvitationReceived: (
    callback: (invitation: OrganizationPendingInvitation) => void,
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      invitation: OrganizationPendingInvitation,
    ): void => callback(invitation);
    ipcRenderer.on("agentera-organization-invitation-received", handler);
    return () =>
      ipcRenderer.removeListener(
        "agentera-organization-invitation-received",
        handler,
      );
  },
};

const agenteraWorkspaceAPI = {
  getState: (): Promise<AgenteraWorkspaceResult<WorkspacePublicState>> =>
    ipcRenderer.invoke("agentera-workspace-get-state"),
  refresh: (): Promise<AgenteraWorkspaceResult<WorkspacePublicState>> =>
    ipcRenderer.invoke("agentera-workspace-refresh"),
  select: (input: {
    workspaceId: string | null;
  }): Promise<AgenteraWorkspaceResult<WorkspacePublicState>> =>
    ipcRenderer.invoke("agentera-workspace-select", input),
  create: (input: {
    displayName: string;
  }): Promise<AgenteraWorkspaceResult<WorkspaceSummary>> =>
    ipcRenderer.invoke("agentera-workspace-create", input),
  rename: (input: {
    workspaceId: string;
    displayName: string;
    expectedRevision: number;
  }): Promise<AgenteraWorkspaceResult<WorkspaceSummary>> =>
    ipcRenderer.invoke("agentera-workspace-rename", input),
  archive: (input: {
    workspaceId: string;
    expectedRevision: number;
  }): Promise<AgenteraWorkspaceResult<WorkspaceSummary>> =>
    ipcRenderer.invoke("agentera-workspace-archive", input),
  restore: (input: {
    workspaceId: string;
    expectedRevision: number;
  }): Promise<AgenteraWorkspaceResult<WorkspaceSummary>> =>
    ipcRenderer.invoke("agentera-workspace-restore", input),
  listMembers: (input: {
    workspaceId: string;
  }): Promise<AgenteraWorkspaceResult<readonly WorkspaceMember[]>> =>
    ipcRenderer.invoke("agentera-workspace-list-members", input),
  changeMemberRole: (input: {
    workspaceId: string;
    userId: string;
    role: "admin" | "member";
    expectedRevision: number;
  }): Promise<AgenteraWorkspaceResult<WorkspaceMember>> =>
    ipcRenderer.invoke("agentera-workspace-change-member-role", input),
  removeMember: (input: {
    workspaceId: string;
    userId: string;
    expectedRevision: number;
  }): Promise<AgenteraWorkspaceResult<true>> =>
    ipcRenderer.invoke("agentera-workspace-remove-member", input),
  leave: (input: {
    workspaceId: string;
  }): Promise<AgenteraWorkspaceResult<true>> =>
    ipcRenderer.invoke("agentera-workspace-leave", input),
  listInvitations: (input: {
    workspaceId: string;
  }): Promise<AgenteraWorkspaceResult<readonly WorkspaceInvitation[]>> =>
    ipcRenderer.invoke("agentera-workspace-list-invitations", input),
  createInvitation: (input: {
    workspaceId: string;
  }): Promise<AgenteraWorkspaceResult<WorkspaceInvitationCreation>> =>
    ipcRenderer.invoke("agentera-workspace-create-invitation", input),
  revokeInvitation: (input: {
    workspaceId: string;
    invitationId: string;
  }): Promise<AgenteraWorkspaceResult<true>> =>
    ipcRenderer.invoke("agentera-workspace-revoke-invitation", input),
  acceptInvitation: (input: {
    token: string;
  }): Promise<AgenteraWorkspaceResult<WorkspaceInvitationAcceptance>> =>
    ipcRenderer.invoke("agentera-workspace-accept-invitation", input),
  getPendingInvitation: (): Promise<
    AgenteraWorkspaceResult<WorkspacePendingInvitation | null>
  > => ipcRenderer.invoke("agentera-workspace-get-pending-invitation"),
  dismissPendingInvitation: (input: {
    token: string;
  }): Promise<AgenteraWorkspaceResult<boolean>> =>
    ipcRenderer.invoke("agentera-workspace-dismiss-pending-invitation", input),
  onStateChanged: (
    callback: (state: WorkspacePublicState) => void,
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      state: WorkspacePublicState,
    ): void => callback(state);
    ipcRenderer.on("agentera-workspace-state-changed", handler);
    return () =>
      ipcRenderer.removeListener("agentera-workspace-state-changed", handler);
  },
  onInvitationReceived: (
    callback: (invitation: WorkspacePendingInvitation) => void,
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      invitation: WorkspacePendingInvitation,
    ): void => callback(invitation);
    ipcRenderer.on("agentera-workspace-invitation-received", handler);
    return () =>
      ipcRenderer.removeListener(
        "agentera-workspace-invitation-received",
        handler,
      );
  },
};

const agenteraAgentsAPI = {
  getState: (): Promise<
    AgenteraAgentControlResult<AgenteraAgentControlPublicState>
  > => ipcRenderer.invoke("agentera-agents-get-state"),
  listDrafts: (
    scope?: AgenteraAgentOperationScope,
  ): Promise<AgenteraAgentControlResult<AgentDraft[]>> =>
    ipcRenderer.invoke("agentera-agents-list-drafts", scope),
  getDraft: (
    id: string,
    scope?: AgenteraAgentOperationScope,
  ): Promise<AgenteraAgentControlResult<AgentDraftDetail>> =>
    ipcRenderer.invoke("agentera-agents-get-draft", id, scope),
  createDraft: (
    input: CreateAgentDraftInput,
    scope?: AgenteraAgentOperationScope,
  ): Promise<AgenteraAgentControlResult<AgentDraftDetail>> =>
    ipcRenderer.invoke("agentera-agents-create-draft", input, scope),
  updateDraft: (
    input: UpdateAgentDraftInput,
    scope?: AgenteraAgentOperationScope,
  ): Promise<AgenteraAgentControlResult<AgentDraftDetail>> =>
    ipcRenderer.invoke("agentera-agents-update-draft", input, scope),
  deleteDraft: (
    id: string,
    scope?: AgenteraAgentOperationScope,
  ): Promise<AgenteraAgentControlResult<true>> =>
    ipcRenderer.invoke("agentera-agents-delete-draft", id, scope),
  discardUnpublishedDraft: (
    id: string,
    scope?: AgenteraAgentOperationScope,
  ): Promise<AgenteraAgentControlResult<true>> =>
    ipcRenderer.invoke("agentera-agents-discard-unpublished-draft", id, scope),
  listAuthoringCapabilities: (
    profileId: string,
  ): Promise<AgenteraAgentControlResult<AuthoringCapabilitySummary>> =>
    ipcRenderer.invoke(
      "agentera-agents-list-authoring-capabilities",
      profileId,
    ),
  prepareInstalledSkillSnapshot: (
    input: PrepareInstalledSkillSnapshotInput,
  ): Promise<AgenteraAgentControlResult<SkillSnapshotPreview>> =>
    ipcRenderer.invoke(
      "agentera-agents-prepare-installed-skill-snapshot",
      input,
    ),
  confirmInstalledSkillSnapshot: (
    input: ConfirmInstalledSkillSnapshotInput,
  ): Promise<AgenteraAgentControlResult<AgentDraftAssetInput[]>> =>
    ipcRenderer.invoke(
      "agentera-agents-confirm-installed-skill-snapshot",
      input,
    ),
  prepareMcpRequirement: (
    input: PrepareMcpRequirementInput,
  ): Promise<AgenteraAgentControlResult<McpRequirementPreview>> =>
    ipcRenderer.invoke("agentera-agents-prepare-mcp-requirement", input),
  confirmMcpRequirement: (
    input: ConfirmMcpRequirementInput,
  ): Promise<AgenteraAgentControlResult<AgentMcpRequirementV3>> =>
    ipcRenderer.invoke("agentera-agents-confirm-mcp-requirement", input),
  listCapabilityBindings: (
    installationId: string,
  ): Promise<AgenteraAgentControlResult<AgentCapabilityBindingConfiguration>> =>
    ipcRenderer.invoke(
      "agentera-agents-list-capability-bindings",
      installationId,
    ),
  confirmCapabilityBindings: (
    input: ConfirmCapabilityBindingsInput,
  ): Promise<AgenteraAgentControlResult<ConfirmCapabilityBindingsResult>> =>
    ipcRenderer.invoke("agentera-agents-confirm-capability-bindings", input),
  preparePublication: (
    id: string,
    scope?: AgenteraAgentOperationScope,
  ): Promise<AgenteraAgentControlResult<PublicationPreview>> =>
    ipcRenderer.invoke("agentera-agents-prepare-publication", id, scope),
  confirmPublication: (
    publicationHandle: string,
    scope?: AgenteraAgentOperationScope,
  ): Promise<AgenteraAgentControlResult<PublishedRevision>> =>
    ipcRenderer.invoke(
      "agentera-agents-confirm-publication",
      publicationHandle,
      scope,
    ),
  prepareOrganizationSubmission: (
    draftId: string,
  ): Promise<AgenteraAgentControlResult<OrganizationSubmissionPreview>> =>
    ipcRenderer.invoke(
      "agentera-agents-prepare-organization-submission",
      draftId,
    ),
  confirmOrganizationSubmission: (
    input: ConfirmOrganizationSubmissionInput,
  ): Promise<AgenteraAgentControlResult<OrganizationAgentSubmissionSummary>> =>
    ipcRenderer.invoke(
      "agentera-agents-confirm-organization-submission",
      input,
    ),
  listOrganizationSubmissionList: (): Promise<
    AgenteraAgentControlResult<OrganizationAgentSubmissionList>
  > => ipcRenderer.invoke("agentera-agents-list-organization-submission-list"),
  listOrganizationSubmissions: (): Promise<
    AgenteraAgentControlResult<OrganizationAgentSubmissionSummary[]>
  > => ipcRenderer.invoke("agentera-agents-list-organization-submissions"),
  disconnectOrganizationSubmissionReference: (
    input: DisconnectOrganizationSubmissionReferenceInput,
  ): Promise<AgenteraAgentControlResult<OrganizationAgentSubmissionListItem>> =>
    ipcRenderer.invoke(
      "agentera-agents-disconnect-organization-submission-reference",
      input,
    ),
  getOrganizationSubmission: (
    submissionId: string,
  ): Promise<AgenteraAgentControlResult<OrganizationAgentSubmissionDetail>> =>
    ipcRenderer.invoke(
      "agentera-agents-get-organization-submission",
      submissionId,
    ),
  prepareOrganizationReview: (
    input: PrepareOrganizationReviewInput,
  ): Promise<AgenteraAgentControlResult<OrganizationReviewPreview>> =>
    ipcRenderer.invoke("agentera-agents-prepare-organization-review", input),
  confirmOrganizationReview: (
    input: ConfirmOrganizationReviewInput,
  ): Promise<AgenteraAgentControlResult<OrganizationAgentSubmissionSummary>> =>
    ipcRenderer.invoke("agentera-agents-confirm-organization-review", input),
  prepareOrganizationWithdrawal: (
    submissionId: string,
  ): Promise<AgenteraAgentControlResult<OrganizationWithdrawalPreview>> =>
    ipcRenderer.invoke(
      "agentera-agents-prepare-organization-withdrawal",
      submissionId,
    ),
  confirmOrganizationWithdrawal: (
    input: ConfirmOrganizationWithdrawalInput,
  ): Promise<AgenteraAgentControlResult<OrganizationAgentSubmissionSummary>> =>
    ipcRenderer.invoke(
      "agentera-agents-confirm-organization-withdrawal",
      input,
    ),
  listDefinitions: (
    scope?: AgenteraAgentOperationScope,
  ): Promise<AgenteraAgentControlResult<AgenteraAgentDefinitionSummary[]>> =>
    ipcRenderer.invoke("agentera-agents-list-definitions", scope),
  listOfficialAgents: (): Promise<
    AgenteraAgentControlResult<OfficialAgentSummary[]>
  > => ipcRenderer.invoke("agentera-agents-list-official"),
  getOfficialAgentDetail: (
    definitionId: string,
  ): Promise<AgenteraAgentControlResult<OfficialAgentDetail>> =>
    ipcRenderer.invoke("agentera-agents-get-official-detail", definitionId),
  prepareOfficialInstall: (
    definitionId: string,
  ): Promise<AgenteraAgentControlResult<OfficialAgentInstallPreview>> =>
    ipcRenderer.invoke(
      "agentera-agents-prepare-official-install",
      definitionId,
    ),
  confirmOfficialInstall: (
    input: ConfirmOfficialAgentInstallInput,
  ): Promise<AgenteraAgentControlResult<AgenteraAgentInstallationSummary>> =>
    ipcRenderer.invoke("agentera-agents-confirm-official-install", input),
  refreshOfficialUpdates: (): Promise<
    AgenteraAgentControlResult<OfficialManagedUpdate[]>
  > => ipcRenderer.invoke("agentera-agents-refresh-official-updates"),
  applyOfficialUpdate: (
    installationId: string,
  ): Promise<AgenteraAgentControlResult<AgenteraAgentInstallationSummary>> =>
    ipcRenderer.invoke("agentera-agents-apply-official-update", installationId),
  listVersions: (
    definitionId: string,
    scope?: AgenteraAgentOperationScope,
  ): Promise<AgenteraAgentControlResult<AgenteraAgentVersionSummary[]>> =>
    ipcRenderer.invoke("agentera-agents-list-versions", definitionId, scope),
  listInstallations: (
    scope?: AgenteraAgentOperationScope,
  ): Promise<AgenteraAgentControlResult<AgenteraAgentInstallationSummary[]>> =>
    ipcRenderer.invoke("agentera-agents-list-installations", scope),
  installVersion: (
    input: AgenteraInstallVersionInput,
    scope?: AgenteraAgentOperationScope,
  ): Promise<AgenteraAgentControlResult<AgenteraAgentInstallationSummary>> =>
    ipcRenderer.invoke("agentera-agents-install-version", input, scope),
  claimVersion: (
    input: AgenteraClaimVersionInput,
    scope?: AgenteraAgentOperationScope,
  ): Promise<AgenteraAgentControlResult<AgenteraAgentInstallationSummary>> =>
    ipcRenderer.invoke("agentera-agents-claim-version", input, scope),
  retryPendingInstallation: (
    input: AgenteraRetryPendingInstallationInput,
    scope?: AgenteraAgentOperationScope,
  ): Promise<AgenteraAgentControlResult<AgenteraAgentInstallationSummary>> =>
    ipcRenderer.invoke("agentera-agents-retry-installation", input, scope),
  selectInstallationVersion: (
    input: AgenteraSelectInstallationVersionInput,
    scope?: AgenteraAgentOperationScope,
  ): Promise<AgenteraAgentControlResult<AgenteraAgentInstallationSummary>> =>
    ipcRenderer.invoke("agentera-agents-select-version", input, scope),
  repairInstallationModel: (
    input: AgenteraRepairInstallationModelInput,
    scope?: AgenteraAgentOperationScope,
  ): Promise<AgenteraAgentControlResult<AgenteraAgentInstallationSummary>> =>
    ipcRenderer.invoke(
      "agentera-agents-repair-installation-model",
      input,
      scope,
    ),
  archiveInstallation: (
    id: string,
    scope?: AgenteraAgentOperationScope,
  ): Promise<AgenteraAgentControlResult<AgenteraAgentInstallationSummary>> =>
    ipcRenderer.invoke("agentera-agents-archive-installation", id, scope),
  listEligibleExperienceSkills: (
    installationId: string,
  ): Promise<AgenteraAgentControlResult<EligibleExperienceSkill[]>> =>
    ipcRenderer.invoke(
      "agentera-agents-list-eligible-experience-skills",
      installationId,
    ),
  prepareExperienceCandidate: (
    input: PrepareExperienceCandidateInput,
  ): Promise<AgenteraAgentControlResult<ExperienceCandidatePreview>> =>
    ipcRenderer.invoke("agentera-agents-prepare-experience-candidate", input),
  submitExperienceCandidate: (
    input: SubmitExperienceCandidateInput,
  ): Promise<AgenteraAgentControlResult<ExperienceCandidateSummary>> =>
    ipcRenderer.invoke("agentera-agents-submit-experience-candidate", input),
  listMyExperienceCandidates: (): Promise<
    AgenteraAgentControlResult<ExperienceCandidateSummary[]>
  > => ipcRenderer.invoke("agentera-agents-list-my-experience-candidates"),
  listExperienceReviewQueue: (): Promise<
    AgenteraAgentControlResult<ExperienceCandidateSummary[]>
  > => ipcRenderer.invoke("agentera-agents-list-experience-review-queue"),
  getExperienceCandidate: (
    candidateId: string,
  ): Promise<AgenteraAgentControlResult<ExperienceCandidateDetail>> =>
    ipcRenderer.invoke("agentera-agents-get-experience-candidate", candidateId),
  reviewExperienceCandidate: (
    input: ReviewExperienceCandidateInput,
  ): Promise<AgenteraAgentControlResult<ExperienceCandidateDetail>> =>
    ipcRenderer.invoke("agentera-agents-review-experience-candidate", input),
  prepareExperienceCandidateImport: (
    candidateId: string,
  ): Promise<AgenteraAgentControlResult<ExperienceCandidateImportPreview>> =>
    ipcRenderer.invoke(
      "agentera-agents-prepare-experience-candidate-import",
      candidateId,
    ),
  confirmExperienceCandidateImport: (
    input: ConfirmExperienceCandidateImportInput,
  ): Promise<AgenteraAgentControlResult<AgentDraftDetail>> =>
    ipcRenderer.invoke(
      "agentera-agents-confirm-experience-candidate-import",
      input,
    ),
  listEligibleOrganizationExperienceSkills: (
    installationId: string,
  ): Promise<AgenteraAgentControlResult<EligibleExperienceSkill[]>> =>
    ipcRenderer.invoke(
      "agentera-agents-list-eligible-organization-experience-skills",
      installationId,
    ),
  prepareOrganizationExperienceCandidate: (
    input: PrepareOrganizationExperienceCandidateInput,
  ): Promise<
    AgenteraAgentControlResult<OrganizationExperienceCandidatePreview>
  > =>
    ipcRenderer.invoke(
      "agentera-agents-prepare-organization-experience-candidate",
      input,
    ),
  submitOrganizationExperienceCandidate: (
    input: SubmitOrganizationExperienceCandidateInput,
  ): Promise<
    AgenteraAgentControlResult<OrganizationExperienceCandidateSummary>
  > =>
    ipcRenderer.invoke(
      "agentera-agents-submit-organization-experience-candidate",
      input,
    ),
  listMyOrganizationExperienceCandidates: (): Promise<
    AgenteraAgentControlResult<OrganizationExperienceCandidateSummary[]>
  > =>
    ipcRenderer.invoke(
      "agentera-agents-list-my-organization-experience-candidates",
    ),
  listOrganizationExperienceReviewQueue: (): Promise<
    AgenteraAgentControlResult<OrganizationExperienceCandidateSummary[]>
  > =>
    ipcRenderer.invoke(
      "agentera-agents-list-organization-experience-review-queue",
    ),
  getOrganizationExperienceCandidate: (
    candidateId: string,
  ): Promise<
    AgenteraAgentControlResult<OrganizationExperienceCandidateDetail>
  > =>
    ipcRenderer.invoke(
      "agentera-agents-get-organization-experience-candidate",
      candidateId,
    ),
  reviewOrganizationExperienceCandidate: (
    input: ReviewOrganizationExperienceCandidateInput,
  ): Promise<
    AgenteraAgentControlResult<OrganizationExperienceCandidateDetail>
  > =>
    ipcRenderer.invoke(
      "agentera-agents-review-organization-experience-candidate",
      input,
    ),
  prepareOrganizationExperienceImport: (
    candidateId: string,
  ): Promise<
    AgenteraAgentControlResult<OrganizationExperienceCandidateImportPreview>
  > =>
    ipcRenderer.invoke(
      "agentera-agents-prepare-organization-experience-import",
      candidateId,
    ),
  confirmOrganizationExperienceImport: (
    input: ConfirmOrganizationExperienceCandidateImportInput,
  ): Promise<AgenteraAgentControlResult<AgentDraftDetail>> =>
    ipcRenderer.invoke(
      "agentera-agents-confirm-organization-experience-import",
      input,
    ),
  onStateChanged: (
    callback: (state: AgenteraAgentControlPublicState) => void,
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      state: AgenteraAgentControlPublicState,
    ): void => callback(state);
    ipcRenderer.on("agentera-agents-state-changed", handler);
    return () =>
      ipcRenderer.removeListener("agentera-agents-state-changed", handler);
  },
};

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld("electron", electronAPI);
    contextBridge.exposeInMainWorld("hermesAPI", hermesAPI);
    contextBridge.exposeInMainWorld("agenteraAuth", agenteraAuthAPI);
    contextBridge.exposeInMainWorld(
      "agenteraGlobalProfile",
      agenteraGlobalProfileAPI,
    );
    contextBridge.exposeInMainWorld(
      "agenteraOfficialQuality",
      agenteraOfficialQualityAPI,
    );
    contextBridge.exposeInMainWorld(
      "agenteraEncryptedBackup",
      agenteraEncryptedBackupAPI,
    );
    contextBridge.exposeInMainWorld(
      "agenteraProductSpace",
      agenteraProductSpaceAPI,
    );
    contextBridge.exposeInMainWorld(
      "agenteraOrganization",
      agenteraOrganizationAPI,
    );
    contextBridge.exposeInMainWorld("agenteraWorkspace", agenteraWorkspaceAPI);
    contextBridge.exposeInMainWorld("agenteraAgents", agenteraAgentsAPI);
    contextBridge.exposeInMainWorld(
      "agenteraRuntimeAccess",
      agenteraRuntimeAccessAPI,
    );
    contextBridge.exposeInMainWorld(
      "agenteraRuntimeDistribution",
      agenteraRuntimeDistributionAPI,
    );
    contextBridge.exposeInMainWorld(
      "agenteraDesktopControl",
      agenteraDesktopControlAPI,
    );
  } catch (error) {
    console.error(error);
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI;
  // @ts-ignore (define in dts)
  window.hermesAPI = hermesAPI;
  // @ts-ignore (define in dts)
  window.agenteraAuth = agenteraAuthAPI;
  // @ts-ignore (define in dts)
  window.agenteraGlobalProfile = agenteraGlobalProfileAPI;
  // @ts-ignore (define in dts)
  window.agenteraOfficialQuality = agenteraOfficialQualityAPI;
  // @ts-ignore (define in dts)
  window.agenteraEncryptedBackup = agenteraEncryptedBackupAPI;
  // @ts-ignore (define in dts)
  window.agenteraProductSpace = agenteraProductSpaceAPI;
  // @ts-ignore (define in dts)
  window.agenteraOrganization = agenteraOrganizationAPI;
  // @ts-ignore (define in dts)
  window.agenteraWorkspace = agenteraWorkspaceAPI;
  // @ts-ignore (define in dts)
  window.agenteraAgents = agenteraAgentsAPI;
  // @ts-ignore (define in dts)
  window.agenteraRuntimeAccess = agenteraRuntimeAccessAPI;
  // @ts-ignore (define in dts)
  window.agenteraRuntimeDistribution = agenteraRuntimeDistributionAPI;
  // @ts-ignore (define in dts)
  window.agenteraDesktopControl = agenteraDesktopControlAPI;
}
