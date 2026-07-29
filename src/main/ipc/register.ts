import {
  app,
  shell,
  BrowserWindow,
  ipcMain as electronIpcMain,
  Menu,
  Notification,
  dialog,
  clipboard,
} from "electron";
import { extname } from "path";
import { randomUUID } from "crypto";
import type { AgenteraAuthController } from "../agentera-auth/controller";
import { AgenteraUserProfileStore } from "../agentera-user-profile-store";
import type { RuntimeDistributionManager } from "../agentera-runtime-distribution/manager";
import type { RuntimeActivityCoordinator } from "../runtime-activity";
import {
  serializeRuntimeDistributionPublicState,
  type RuntimeDistributionPublicState,
} from "../../shared/agentera-runtime-distribution";
import { readdir, readFile, stat } from "fs/promises";
import {
  getActiveProfileNameSync,
  isValidProfileName,
  profileHome,
} from "../utils";
import type { Attachment } from "../../shared/attachments";
import { hasAgenteraSignedInAccess } from "../../shared/agentera-auth";
import type { SessionModelOverride } from "../../shared/model-override";
import type { AppLocale } from "../../shared/i18n/types";
import { DESKTOP_PRODUCT_NAME } from "../../shared/branding";
import type {
  DesktopSessionContinuationItem,
  DesktopSessionLocalError,
} from "../../shared/session-continuation";
import { stageAttachment, clearStagedAttachments } from "../attachment-staging";
import { persistPromptImageAttachments } from "../session-attachment-store";
import {
  discoverProviderModels,
  getModelContextWindow,
} from "../model-discovery";
import {
  persistSessionContinuation,
  persistSessionLocalError,
} from "../session-continuation-store";
import {
  getSessionContextFolder,
  setSessionContextFolder,
  getRecentSessionContextFolders,
} from "../session-context-folder-store";
import {
  getSessionModelOverride,
  setSessionModelOverride,
} from "../session-model-override-store";
import {
  materializeDataUrlToTemp,
  readMediaAsDataUrl,
  saveMedia,
  mediaFileExists,
} from "../media";
import { openTerminalInDirectory } from "../terminal-launcher";
import {
  getGpuStatus,
  reenableGpuAndRelaunch,
  setGpuPreference,
  relaunchApp,
} from "../gpu-fallback";
import type { GpuPreferenceMode } from "../../shared/gpu";
import {
  verifyInstall,
  runPackagedSeedInstall,
  validateHermesHome,
  setHermesHomeOverride,
  getHermesVersion,
  clearVersionCache,
  runHermesDoctor,
  runHermesUpdate,
  checkOpenClawExists,
  runClawMigrate,
  runHermesBackup,
  runHermesImport,
  runHermesDump,
  discoverMemoryProviders,
  readLogs,
  type InstallProgress,
} from "../installer";
import {
  ensureLocalDashboardCompatibility,
  ensureSshDashboardCompatibility,
} from "../hermes-agent-compat";
import {
  addMcpServer,
  installMcpCatalogEntry,
  listMcpCatalog,
  listMcpServers,
  removeMcpServer,
  setMcpServerEnabled,
  testMcpServer,
  type McpServerInput,
} from "../mcp-servers";
import {
  runHermesAuthLogin,
  cancelHermesAuthLogin,
  detectDeviceCode,
} from "../hermes-auth";
import { startDeviceLogin, cancelDeviceLogin } from "../hermes-account";
import {
  syncAgents,
  getAgentSyncStatus,
  getLinkedAgentId,
} from "../agent-sync";
import {
  getAccount,
  clearAllAccounts,
  findAccountProfile,
} from "../account-store";
import {
  isRemoteMode,
  isRemoteOnlyMode,
  sendMessage,
  transcribeAudio,
  startGateway,
  startGatewayDetailed,
  stopGateway,
  isGatewayRunning,
  testRemoteConnection,
  restartGateway,
  notifyProfileSwitched,
  setSshRemoteApiKey,
  resolvePendingClarify,
} from "../hermes";
import {
  freshDashboardWebSocketUrl,
  getDashboardStatus,
  startDashboard,
  stopDashboard,
} from "../dashboard";
import {
  clearRemoteOAuthSession,
  connectionConfigAfterRemoteOAuthLogin,
  openRemoteOAuthLogin,
  probeRemoteAuthMode,
  remoteOAuthSessionState,
} from "../remote-oauth";
import {
  startSshTunnel,
  ensureSshTunnel,
  getSshTunnelUrl,
  stopSshTunnel,
  testSshConnection,
  isSshTunnelActive,
} from "../ssh-tunnel";
import {
  getClaw3dStatus,
  setupClaw3d,
  startDevServer,
  stopDevServer,
  startAdapter,
  stopAdapter,
  startAll as startClaw3dAll,
  stopAll as stopClaw3d,
  getClaw3dLogs,
  setClaw3dPort,
  getClaw3dPort,
  setClaw3dWsUrl,
  getClaw3dWsUrl,
  waitForClaw3dReady,
  type Claw3dSetupProgress,
} from "../claw3d";
import { startOfficeStack } from "../office-start";
import {
  readEnv,
  setEnvValue,
  getConfigValue,
  setConfigValue,
  getHermesHome,
  getModelConfig,
  setModelConfig,
  getCredentialPool,
  setCredentialPool,
  addCredentialPoolEntry,
  getConnectionConfig,
  getPublicConnectionConfig,
  normalizeRemoteChatTransport,
  resolveConnectionApiKeyUpdate,
  rotateConnectionContextId,
  setConnectionConfig,
  getPlatformEnabled,
  setPlatformEnabled,
  ensureLocalApiServerKey,
  getApiServerKeyStatus,
  invalidateSecretsCache,
  type ConnectionConfig,
} from "../config";
import {
  getAuxiliaryConfig,
  setAuxiliaryTask,
  resetAuxiliaryToAuto,
} from "../auxiliary-config";
import {
  applySessionLocalOverlays,
  listSessions,
  getSessionMessages,
  searchSessions,
  deleteSession,
  deleteSessions,
} from "../sessions";
import {
  syncSessionCache,
  listCachedSessions,
  updateSessionTitle,
} from "../session-cache";
import {
  remoteDeleteSession,
  remoteDeleteSessions,
  remoteGetSessionMessages,
  remoteListCachedSessions,
  remoteListSessions,
  remoteReadMediaAsDataUrl,
  remoteSearchSessions,
  remoteUpdateSessionTitle,
  type RemoteSessionConfig,
} from "../remote-sessions";
import {
  remoteGetHermesHome,
  remoteGetHermesVersion,
} from "../remote-metadata";
import {
  remoteGetSkillContent,
  remoteInstallSkill,
  remoteListInstalledSkills,
  remoteUninstallSkill,
} from "../remote-skills";
import {
  remoteAddModel,
  remoteGetModelConfig,
  remoteListModels,
  remoteRemoveModel,
  remoteSetModelConfig,
  remoteUpdateModel,
} from "../remote-models";
import {
  listModels,
  addModel,
  removeModel,
  updateModel,
  listModelDefinitions,
  getModelDefinition,
  setModelDefinition,
  removeModelDefinition,
  type SavedModel,
} from "../models";
import { validateChatReadiness } from "../validation";
import {
  runConfigHealthCheck,
  autoFixIssue,
  readConfigFixLog,
  type IssueCode,
} from "../config-health";
import {
  listProfiles,
  listLocalProfileLocations,
  createProfile,
  deleteProfile,
  setActiveProfile,
} from "../profiles";
import {
  discoverProfilesForCurrentOwner,
  hasMeaningfulHermesProfileData,
  type AgenteraProfileBindingStore,
  type AgenteraRuntimeOwner,
} from "../agentera-profile-binding";
import type { AgenteraConnectionOwnerStore } from "../agentera-connection-owner";
import type { AgenteraAgentControlManager } from "../agentera-agent-control/manager";
import type { AgenteraOfficialQualityManager } from "../agentera-official-quality/manager";
import { createOfficialQualityChatObserver } from "../agentera-official-quality/collector";
import {
  parseOfficialQualityConsentInput,
  parseOfficialQualityFeedbackInput,
} from "../agentera-official-quality/ipc-contract";
import type { AgenteraEncryptedBackupController } from "../agentera-encrypted-backup/controller";
import {
  parseAuthorizeEncryptedBackupDeviceInput,
  parseCancelEncryptedBackupInput,
  parseCancelEncryptedBackupRestoreInput,
  parseConfirmEncryptedBackupRecoveryInput,
  parseConfirmEncryptedBackupRestoreInput,
  parseCreateEncryptedBackupInput,
  parseDeleteEncryptedBackupInput,
  parseInitializeEncryptedBackupRecoveryInput,
  parsePrepareEncryptedBackupRestoreInput,
  parseRegisterEncryptedBackupDeviceInput,
  parseRevokeEncryptedBackupDeviceInput,
  parseSetEncryptedBackupScheduleInput,
} from "../agentera-encrypted-backup/ipc-contract";
import {
  executeAgentControlIpc,
  parseAgentControlId,
  parseClaimVersionInput,
  parseConfirmExperienceCandidateImportInput,
  parseConfirmOfficialAgentInstallInput,
  parseConfirmOrganizationReviewInput,
  parseConfirmOrganizationSubmissionInput,
  parseConfirmOrganizationWithdrawalInput,
  parseCreateDraftInput,
  parseInstallVersionInput,
  parsePrepareExperienceCandidateInput,
  parsePrepareOrganizationReviewInput,
  parseRetryPendingInstallationInput,
  parseReviewExperienceCandidateInput,
  parseSelectInstallationVersionInput,
  parseSubmitExperienceCandidateInput,
  parseUpdateDraftInput,
  serializeOrganizationAgentSubmission,
  serializeOrganizationReviewPreview,
  serializeOrganizationSubmissionDetail,
  serializeOrganizationSubmissionPreview,
  serializeOrganizationWithdrawalPreview,
} from "../agentera-agent-control/ipc-contract";
import type { AgenteraWorkspaceManager } from "../agentera-workspace/manager";
import type { WorkspaceInvitationInbox } from "../agentera-workspace/deep-link";
import {
  createWorkspaceIdempotencyKey,
  executeWorkspaceIpc,
  parseAcceptWorkspaceInvitationInput,
  parseChangeWorkspaceMemberRoleInput,
  parseCreateWorkspaceInput,
  parseDismissWorkspaceInvitationInput,
  parseRemoveWorkspaceMemberInput,
  parseRenameWorkspaceInput,
  parseRevokeWorkspaceInvitationInput,
  parseSelectWorkspaceInput,
  parseWorkspaceIDInput,
  parseWorkspaceRevisionInput,
  serializeWorkspaceInvitation,
  serializeWorkspaceInvitationAcceptance,
  serializeWorkspaceInvitationCreation,
  serializeWorkspaceMember,
  serializeWorkspacePublicState,
  serializeWorkspaceSummary,
} from "../agentera-workspace/ipc-contract";
import type { AgenteraOrganizationManager } from "../agentera-organization/manager";
import {
  executeOrganizationIpc,
  parseAcceptOrganizationInvitationInput,
  parseCreateOrganizationDepartmentInput,
  parseCreateOrganizationInput,
  parseDismissOrganizationInvitationInput,
  parseDissolveOrganizationInput,
  parseGetOrganizationPolicySnapshotInput,
  parseOrganizationAuditPageInput,
  parseOrganizationIDInput,
  parseOrganizationRevisionInput,
  parsePatchOrganizationMemberInput,
  parsePublishOrganizationPolicyInput,
  parseRemoveOrganizationMemberInput,
  parseRenameOrganizationDepartmentInput,
  parseRenameOrganizationInput,
  parseReviseOrganizationDepartmentInput,
  parseRevokeOrganizationInvitationInput,
  parseTransferOrganizationOwnerInput,
  serializeOrganizationAuditPage,
  serializeOrganizationCurrentPolicyState,
  serializeOrganizationDepartment,
  serializeOrganizationDepartmentCollection,
  serializeOrganizationInvitationAcceptance,
  serializeOrganizationInvitationCollection,
  serializeOrganizationInvitationCreation,
  serializeOrganizationMember,
  serializeOrganizationMemberCollection,
  serializeOrganizationPolicySnapshot,
  serializeOrganizationPolicySummaries,
  serializeOrganizationPublicState,
  serializeOrganizationSummary,
} from "../agentera-organization/ipc-contract";
import type { AgenteraProductSpaceManager } from "../agentera-product-space/manager";
import {
  executeProductSpaceIpc,
  parseProductSpaceSelectionInput,
  serializeProductSpacePublicState,
} from "../agentera-product-space/ipc-contract";
import {
  probeAgenteraInstallFiles,
  runAgenteraStartupPreflight,
} from "../agentera-startup-preflight";
import {
  AGENTERA_IPC_CHANNEL_POLICY,
  AGENTERA_PROFILE_ARGUMENT_INDEX,
  createGuardedIpcMain,
  type ProductAccessGuard,
} from "./auth-guard";
import {
  setProfileColor,
  setProfileAvatar,
  removeProfileAvatar,
} from "../profile-meta";
import type { AgentIdentityService } from "../agent-identity";
import type { AgentUserMemoryRepairService } from "../agent-user-memory-repair";
import {
  composeGlobalProfileEnvelope,
  summarizeGlobalProfileConversationSnapshot,
  type AgenteraGlobalProfileManager,
} from "../agentera-global-profile/manager";
import type { AgenteraMemoryCandidateManager } from "../agentera-global-profile/candidate-manager";
import type { AgenteraMemoryCandidateConfirmationCoordinator } from "../agentera-global-profile/candidate-confirmation";
import type {
  AgenteraGlobalProfileConversationContext,
  SetAgenteraGlobalProfileEntryInput,
} from "../../shared/agentera-global-profile";
import {
  createWallet,
  deleteWallet,
  importWallet,
  listWallets,
  renameWallet,
} from "../wallet-store";
import {
  listCustomProviders,
  removeCustomProvider,
  upsertCustomProvider,
} from "../providers-store";
import {
  removeNativeCustomProvider,
  upsertNativeCustomProvider,
} from "../native-custom-provider";
import {
  isCustomProviderRoute,
  namedCustomProviderRuntimeName,
  normalizeCustomProviderRuntimeName,
} from "../../shared/custom-providers";
import { customProviderEnvKey } from "../../shared/url-key-map";
import { syncWalletsForProfile } from "../wallet-sync";
import { getWalletPortfolio, provisionAgentWallet } from "../wallet-actions";
import { getTokenBalances } from "../wallet-balances";
import type { ImportWalletInput } from "../../shared/wallets";
import {
  readMemory,
  addMemoryEntry,
  updateMemoryEntry,
  removeMemoryEntry,
  writeUserProfile,
} from "../memory";
import { readSoul, writeSoul, resetSoul } from "../soul";
import {
  getPlatformToolsets,
  getToolsets,
  setMessagingPlatformToolsetEnabled,
  setToolsetEnabled,
} from "../tools";
import {
  fetchRegistry,
  fetchModelRegistry,
  fetchRegistryDetail,
  listInstalledRegistry,
  installRegistryItem,
  type RegistryKind,
  type RegistryItem,
} from "../registry";
import {
  listInstalledSkills,
  listBundledSkills,
  getSkillContent,
  installSkill,
  uninstallSkill,
} from "../skills";
import {
  listCronJobs,
  createCronJob,
  removeCronJob,
  pauseCronJob,
  resumeCronJob,
  triggerCronJob,
} from "../cronjobs";
import {
  applyMessagingPlatformUpdate,
  buildDesktopMessagingPlatforms,
  fetchRemoteMessagingPlatforms,
  readLocalGatewayPlatformStates,
  testDesktopMessagingPlatform,
  testRemoteMessagingPlatform,
  updateRemoteMessagingPlatform,
} from "../messaging-platforms";
import {
  listBoards as kanbanListBoards,
  currentBoard as kanbanCurrentBoard,
  switchBoard as kanbanSwitchBoard,
  createBoard as kanbanCreateBoard,
  removeBoard as kanbanRemoveBoard,
  listTasks as kanbanListTasks,
  getTask as kanbanGetTask,
  createTask as kanbanCreateTask,
  assignTask as kanbanAssignTask,
  completeTask as kanbanCompleteTask,
  blockTask as kanbanBlockTask,
  unblockTask as kanbanUnblockTask,
  archiveTask as kanbanArchiveTask,
  promoteTask as kanbanPromoteTask,
  scheduleTask as kanbanScheduleTask,
  specifyTask as kanbanSpecifyTask,
  reclaimTask as kanbanReclaimTask,
  commentTask as kanbanCommentTask,
  dispatchOnce as kanbanDispatchOnce,
  listClaw3dHqTasks as kanbanListClaw3dHqTasks,
  type CreateTaskInput,
} from "../kanban";
import { getAppLocale, setAppLocale } from "../locale";
import {
  sshListInstalledSkills,
  sshGetSkillContent,
  sshInstallSkill,
  sshUninstallSkill,
  sshListBundledSkills,
  sshReadMemory,
  sshAddMemoryEntry,
  sshUpdateMemoryEntry,
  sshRemoveMemoryEntry,
  sshWriteUserProfile,
  sshReadSoul,
  sshWriteSoul,
  sshResetSoul,
  sshGetToolsets,
  sshGetPlatformToolsets,
  sshSetToolsetEnabled,
  sshSetMessagingPlatformToolsetEnabled,
  sshReadEnv,
  sshSetEnvValue,
  sshGetConfigValue,
  sshSetConfigValue,
  sshGetHermesHome,
  sshGetModelConfig,
  sshSetModelConfig,
  sshListSessions,
  sshGetSessionMessages,
  sshSearchSessions,
  sshListProfiles,
  sshCreateProfile,
  sshDeleteProfile,
  sshGatewayStatus,
  sshStartGateway,
  sshStopGateway,
  sshEnsureDashboard,
  sshEnsureApiServerKey,
  sshWaitGatewayApiReady,
  resetSshDashboardAvailability,
  sshReadRemoteApiKey,
  sshResolveApiServerPort,
  sshReadDirectory,
  sshGetHermesVersion,
  sshReadLogs,
  sshGetPlatformEnabled,
  sshSetPlatformEnabled,
  sshListCachedSessions,
  sshRunDoctor,
  sshListModels,
  sshAddModel,
  sshRemoveModel,
  sshUpdateModel,
  sshRunUpdate,
  sshRunDump,
  sshDiscoverMemoryProviders,
} from "../ssh-remote";

export interface IpcContext {
  runtimeActivity: RuntimeActivityCoordinator;
  getMainWindow: () => BrowserWindow | null;
  notifyConnectionConfigChanged: () => void;
  notifyRuntimeSnapshotChanged: () => void;
  notifyModelLibraryChanged: () => void;
  notifyCustomProvidersChanged: () => void;
  openExternalUrl: (rawUrl: unknown) => void;
  agenteraAuth: AgenteraAuthController;
  agenteraUserProfiles: AgenteraUserProfileStore;
  agentIdentity: AgentIdentityService;
  agentUserMemoryRepair: AgentUserMemoryRepairService;
  agenteraGlobalProfiles: AgenteraGlobalProfileManager;
  agenteraMemoryCandidates: AgenteraMemoryCandidateManager;
  agenteraMemoryCandidateConfirmation: AgenteraMemoryCandidateConfirmationCoordinator;
  productAccessGuard: ProductAccessGuard;
  getAgenteraRuntimeOwner: () => AgenteraRuntimeOwner;
  agenteraProfileBindings: AgenteraProfileBindingStore;
  agenteraConnectionOwners: AgenteraConnectionOwnerStore;
  agenteraAgentControl?: AgenteraAgentControlManager | null;
  agenteraWorkspace?: AgenteraWorkspaceManager | null;
  agenteraOrganization?: AgenteraOrganizationManager | null;
  agenteraProductSpace?: AgenteraProductSpaceManager | null;
  workspaceInvitationInbox: WorkspaceInvitationInbox;
  runtimeDistribution: RuntimeDistributionManager | null;
  agenteraOfficialQuality?: AgenteraOfficialQualityManager | null;
  agenteraEncryptedBackup?: AgenteraEncryptedBackupController | null;
}

const RUNTIME_DISTRIBUTION_UNAVAILABLE_STATE: RuntimeDistributionPublicState = {
  phase: "repair-required",
  currentVersion: null,
  currentSourceCommit: null,
  packagedSeedVersion: null,
  availableVersion: null,
  downloadSize: null,
  downloadPercent: null,
  lastCheckedAt: null,
  lastErrorCode: "runtime_repair_required",
  canCheck: false,
  canDownload: false,
  canCancel: false,
  canRestart: false,
};

const APP_NAME =
  process.env.HERMES_DESKTOP_APP_NAME?.trim() || DESKTOP_PRODUCT_NAME;

type RemoteSessionBridgeConfig = RemoteSessionConfig;

async function getSshDashboardSessionConfig(
  conn: ConnectionConfig,
  profile?: string,
): Promise<RemoteSessionBridgeConfig> {
  if (conn.mode !== "ssh" || !conn.ssh)
    throw new Error("SSH connection is not configured.");
  // Start the UNIFIED machine `hermes dashboard` on the remote and tunnel to it.
  // It serves /api/* + the /api/ws chat WS for EVERY profile (scoped via
  // ?profile=, see RemoteSessionConfig.profile), NOT /v1 — chat over /v1 is the
  // gateway api_server (prepareSshTunnel gateway branch). All profiles share one
  // dashboard port + token so the single global SSH tunnel never thrashes. The
  // /api/* routes are gated by the dashboard session token (the api_server key is
  // rejected there). Returns null when the remote can't run the dashboard (no
  // web dist); we throw so callers fall back to legacy.
  const dash = await sshEnsureDashboard(conn.ssh, profile);
  if (!dash)
    throw new Error(
      "AgentEra Runtime dashboard is unavailable on this SSH remote (needs Node + the dashboard web dist).",
    );
  await ensureSshTunnel({ ...conn.ssh, remotePort: dash.port });
  const remoteUrl = getSshTunnelUrl();
  if (!remoteUrl) throw new Error("SSH tunnel is not active.");
  setSshRemoteApiKey(dash.token);
  // The tunnel + token are the shared machine dashboard's; scope data to the
  // requested profile via `?profile=` (handled in dashboardApiUrl).
  return { remoteUrl, apiKey: dash.token, profile };
}

// Most session/metadata IPC calls don't carry a profile, but the unified SSH
// machine dashboard serves EVERY profile — an unscoped request silently
// returns the DEFAULT profile's data (wrong session list / transcript for a
// named-profile user). Fall back to the locally persisted active profile so
// `dashboardApiUrl` appends `?profile=` ("default" needs no param and is
// skipped there; explicit params like `profile=all` are never overridden).
function activeSshProfile(profile?: string): string {
  return profile?.trim() || getActiveProfileNameSync();
}

/**
 * Establish the SSH tunnel to the correct endpoint and cache the matching
 * credential — the remote dashboard (/api/* + chat WS; dashboard-token auth)
 * when available, else the gateway api_server (/v1; api_server-key auth) —
 * the dashboard is NOT a /v1 superset, the two are disjoint. EVERY SSH
 * tunnel entry point routes through this so they never target different ports
 * on the single global tunnel and thrash it (each `startSshTunnel` first calls
 * `stopSshTunnel`, so a 9119↔8642 flip-flop yields "SSH tunnel is not active").
 */
async function prepareSshTunnel(
  conn: ConnectionConfig,
  profile?: string,
): Promise<void> {
  if (conn.mode !== "ssh" || !conn.ssh) return;
  const dash =
    conn.sshChatTransport === "legacy"
      ? null
      : await sshEnsureDashboard(conn.ssh, profile);
  if (dash) {
    await ensureSshTunnel({ ...conn.ssh, remotePort: dash.port });
    setSshRemoteApiKey(dash.token);
    return;
  }
  // Gateway /v1 path — the no-build chat transport used when the remote has no
  // dashboard web dist (gateway-only installs) or when transport is "legacy".
  // SSH mode, unlike local mode, never provisioned the remote api_server, so a
  // fresh server had no /v1 endpoint at all (no API_SERVER_KEY → api_server
  // refuses to bind; API_SERVER_ENABLED unset → gateway never loads it). Ensure
  // both, then tunnel to the api_server and use that key.
  const { key, created } = await sshEnsureApiServerKey(conn.ssh, profile);
  const remotePort = await sshResolveApiServerPort(conn.ssh, profile);
  const running = await sshGatewayStatus(conn.ssh, profile);
  let apiReady = true;
  if (!running) {
    // Down → start it. (A cold tunnel must not take over a healthy gateway,
    // hence the status check; but a stopped gateway must be started.)
    await sshStartGateway(conn.ssh, profile);
    apiReady = await sshWaitGatewayApiReady(conn.ssh, remotePort);
  } else if (created) {
    // Up, but predates the key/enable we just wrote, so its api_server isn't
    // bound. Restart so it picks up the new env, then wait for /health.
    await sshStopGateway(conn.ssh, profile);
    await sshStartGateway(conn.ssh, profile);
    apiReady = await sshWaitGatewayApiReady(conn.ssh, remotePort);
  }
  // A false readiness result must FAIL setup — opening the tunnel and caching
  // the key anyway reports success while /v1 isn't bound, so the first chat
  // hits a confusing connection error later instead of a clear one here.
  if (!apiReady)
    throw new Error(
      `Remote gateway api_server did not become ready on port ${remotePort} ` +
        "(/health never answered). Check the gateway logs on the remote and retry.",
    );
  await ensureSshTunnel({ ...conn.ssh, remotePort });
  setSshRemoteApiKey(key);
}

async function withSshDashboardSessions<T>(
  conn: ConnectionConfig,
  dashboardOperation: (config: RemoteSessionBridgeConfig) => Promise<T>,
  legacyOperation?: () => Promise<T> | T,
  profile?: string,
): Promise<T> {
  if (conn.sshChatTransport === "legacy") {
    if (legacyOperation) return legacyOperation();
    throw new Error("This SSH session operation requires dashboard transport.");
  }
  try {
    return await dashboardOperation(
      await getSshDashboardSessionConfig(conn, profile),
    );
  } catch (err) {
    if (conn.sshChatTransport === "auto" && legacyOperation)
      return legacyOperation();
    throw err;
  }
}

async function withSshDashboardModelLibrary<T>(
  conn: ConnectionConfig,
  dashboardOperation: (config: RemoteSessionBridgeConfig) => Promise<T>,
  legacyOperation: () => Promise<T> | T,
  profile?: string,
): Promise<T> {
  if (conn.mode !== "ssh" || !conn.ssh)
    throw new Error("SSH connection is not configured.");
  if (conn.sshChatTransport === "legacy") return legacyOperation();
  try {
    // getSshDashboardSessionConfig starts the remote dashboard (which natively
    // serves /api/model/*) and tunnels to it — no gateway web_server patch /
    // restart dance needed.
    return await dashboardOperation(
      await getSshDashboardSessionConfig(conn, profile),
    );
  } catch (err) {
    // Auto transport degrades to the legacy CLI/file path when the dashboard
    // can't be reached — e.g. a gateway-only remote that can't run the
    // dashboard (no Node / no web dist). A forced "dashboard" transport
    // rethrows so the failure is visible.
    if (conn.sshChatTransport === "auto") {
      console.warn(
        "[ssh-model-library] Dashboard unavailable; " +
          "falling back to legacy SSH transport",
        err,
      );
      return legacyOperation();
    }
    throw err;
  }
}

async function withRemoteDashboard<T>(
  conn: ConnectionConfig,
  dashboardOperation: () => Promise<T>,
  legacyOperation: () => Promise<T> | T,
): Promise<T> {
  if (conn.remoteAuthMode === "oauth") {
    if (conn.remoteChatTransport === "legacy") {
      throw new Error(
        "Legacy remote transport cannot authenticate to an OAuth gateway.",
      );
    }
    return dashboardOperation();
  }
  if (conn.remoteChatTransport === "legacy") return legacyOperation();
  try {
    return await dashboardOperation();
  } catch (err) {
    if (conn.remoteChatTransport === "auto") return legacyOperation();
    throw err;
  }
}

async function getActiveDashboardMediaConfig(): Promise<RemoteSessionBridgeConfig | null> {
  const conn = getConnectionConfig();
  if (conn.mode === "remote") {
    if (conn.remoteChatTransport === "legacy") return null;
    if (!conn.remoteUrl.trim() || !conn.apiKey.trim()) return null;
    return { remoteUrl: conn.remoteUrl, apiKey: conn.apiKey };
  }
  if (conn.mode === "ssh") {
    if (conn.sshChatTransport === "legacy") return null;
    try {
      return await getSshDashboardSessionConfig(conn);
    } catch {
      return null;
    }
  }
  return null;
}

async function readMediaForCurrentConnection(
  filePath: string,
): Promise<string | null> {
  const local = readMediaAsDataUrl(filePath);
  if (local) return local;
  const remote = await getActiveDashboardMediaConfig();
  return remote ? remoteReadMediaAsDataUrl(remote, filePath) : null;
}

async function mediaFileExistsForCurrentConnection(
  filePath: string,
): Promise<boolean> {
  if (mediaFileExists(filePath)) return true;
  const remote = await getActiveDashboardMediaConfig();
  if (!remote) return false;
  return (await remoteReadMediaAsDataUrl(remote, filePath)) !== null;
}

async function resolveMediaForSave(src: string): Promise<string> {
  if (src.startsWith("data:") || /^https?:\/\//i.test(src)) return src;
  return (await readMediaForCurrentConnection(src)) ?? src;
}

/**
 * Resolve the saved-model library entry for an activated (provider, model) so
 * its `apiMode`/`contextLength` can be mirrored into config.yaml. When several
 * entries share the same provider+model — e.g. two `custom` endpoints exposing
 * the same model id over different transports/base URLs — a bare provider+model
 * `find` would return the wrong one and persist its transport, routing requests
 * over the wrong protocol. Disambiguate by base URL in that case; fall back to
 * the first match when none align (single-entry activations are unaffected).
 */
function resolveLibraryModelEntry(
  provider: string,
  model: string,
  baseUrl: string,
): SavedModel | undefined {
  const norm = (u: string | undefined): string =>
    (u || "").trim().replace(/\/+$/, "");
  const namedCustom = namedCustomProviderRuntimeName(provider) || "";
  const matches = listModels().filter(
    (candidate) =>
      candidate.model === model &&
      (candidate.provider === provider ||
        (namedCustom &&
          candidate.provider === "custom" &&
          ((!candidate.providerLabel &&
            norm(candidate.baseUrl) === norm(baseUrl)) ||
            normalizeCustomProviderRuntimeName(
              candidate.providerLabel || "",
            ) === namedCustom))),
  );
  if (matches.length <= 1) return matches[0];
  const target = norm(baseUrl);
  return matches.find((m) => norm(m.baseUrl) === target) ?? matches[0];
}

function normalizedBaseUrl(value: string | undefined): string {
  return (value || "").trim().replace(/\/+$/, "").toLowerCase();
}

/**
 * Turn a Desktop named-custom library attachment into AgentEra Runtime's native
 * `providers.<name>` + `custom:<name>` route. Preset compatibility providers
 * without a providerLabel keep their existing route; this bridge only runs
 * when the model can be tied to a first-class named provider.
 */
function persistNativeCustomRouteForModel(
  provider: string,
  model: string,
  baseUrl: string,
  profile: string | undefined,
  libraryEntry: SavedModel | undefined,
): string {
  if (!isCustomProviderRoute(provider)) {
    return provider;
  }

  const targetUrl = normalizedBaseUrl(baseUrl);
  let providerName = (libraryEntry?.providerLabel || "").trim();
  const routeName = namedCustomProviderRuntimeName(provider);
  if (!providerName && routeName) {
    providerName =
      listCustomProviders(profile).find(
        (record) =>
          normalizeCustomProviderRuntimeName(record.name) === routeName &&
          (!targetUrl || normalizedBaseUrl(record.baseUrl) === targetUrl),
      )?.name || routeName;
  }
  if (!providerName && targetUrl) {
    providerName =
      listCustomProviders(profile).find(
        (record) => normalizedBaseUrl(record.baseUrl) === targetUrl,
      )?.name || "";
  }
  if (!providerName || !targetUrl) {
    return provider;
  }

  const providerAnchor = customProviderEnvKey(providerName);
  const models = listModels()
    .filter(
      (candidate) =>
        normalizedBaseUrl(candidate.baseUrl) === targetUrl &&
        candidate.providerLabel &&
        customProviderEnvKey(candidate.providerLabel) === providerAnchor,
    )
    .map((candidate) => candidate.model);
  if (!models.includes(model)) models.unshift(model);

  return upsertNativeCustomProvider(profile, {
    name: providerName,
    baseUrl,
    model,
    models,
    apiMode: libraryEntry?.apiMode ?? null,
  });
}

function isRuntimeCredentialEnvKey(key: string): boolean {
  return (
    key.endsWith("_API_KEY") ||
    key.endsWith("_TOKEN") ||
    key === "HF_TOKEN" ||
    key === "CUSTOM_API_KEY" ||
    (key.startsWith("CUSTOM_PROVIDER_") && key.endsWith("_KEY"))
  );
}

function refreshLocalModelRuntimeSnapshot(
  previous: { provider: string; model: string; baseUrl: string },
  next: { provider: string; model: string; baseUrl: string },
  profile?: string,
): boolean {
  const changed =
    previous.provider !== next.provider ||
    previous.model !== next.model ||
    previous.baseUrl !== next.baseUrl;
  if (!changed) return false;

  // Dashboard and gateway both snapshot config/env at process start. Retire
  // the dashboard before returning so a send immediately after Save cannot hit
  // the old route; the renderer reconnects lazily.
  stopDashboard(profile);
  if (isGatewayRunning(profile)) {
    void restartGateway(profile);
  }
  return true;
}

export function registerIpcHandlers(context: IpcContext): void {
  const {
    runtimeActivity,
    getMainWindow,
    notifyConnectionConfigChanged,
    notifyRuntimeSnapshotChanged,
    notifyModelLibraryChanged,
    notifyCustomProvidersChanged,
    openExternalUrl,
    agenteraAuth,
    agenteraUserProfiles,
    agentIdentity,
    agentUserMemoryRepair,
    agenteraGlobalProfiles,
    agenteraMemoryCandidates,
    agenteraMemoryCandidateConfirmation,
    productAccessGuard,
    getAgenteraRuntimeOwner,
    agenteraProfileBindings,
    agenteraConnectionOwners,
    agenteraAgentControl,
    agenteraWorkspace,
    agenteraOrganization,
    agenteraProductSpace,
    workspaceInvitationInbox,
    runtimeDistribution,
    agenteraOfficialQuality,
    agenteraEncryptedBackup,
  } = context;
  const globalProfileChangedChannel = "agentera-global-profile-changed";
  const notifyGlobalProfileChanged = (profile: unknown): void => {
    const window = getMainWindow();
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
      return;
    }
    window.webContents.send(globalProfileChangedChannel, profile);
  };
  const agentIdentityChangedChannel = "agent-identity-changed";
  const notifyAgentIdentityChanged = (payload: {
    profileId: string;
    displayName: string;
    revision: number;
    updatedAt: string;
  }): void => {
    const window = getMainWindow();
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
      return;
    }
    window.webContents.send(agentIdentityChangedChannel, payload);
  };
  const requireAgentControl = (): AgenteraAgentControlManager => {
    if (!agenteraAgentControl) {
      throw Object.assign(new Error("Agent control is unavailable."), {
        code: "operation_failed",
      });
    }
    return agenteraAgentControl;
  };
  const requireOfficialQuality = (): AgenteraOfficialQualityManager => {
    if (!agenteraOfficialQuality) {
      throw Object.assign(new Error("Official quality is unavailable."), {
        code: "service_unavailable",
      });
    }
    return agenteraOfficialQuality;
  };
  const requireEncryptedBackup = (): AgenteraEncryptedBackupController => {
    if (!agenteraEncryptedBackup) {
      throw Object.assign(new Error("Encrypted backup is unavailable."), {
        code: "service_unavailable",
      });
    }
    return agenteraEncryptedBackup;
  };
  const encryptedBackupProgressChannel = "agentera-encrypted-backup-progress";
  agenteraEncryptedBackup?.subscribe((progress) => {
    const window = getMainWindow();
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
      return;
    }
    window.webContents.send(encryptedBackupProgressChannel, progress);
  });
  const agentControlStateChannel = "agentera-agents-state-changed";
  agenteraAgentControl?.subscribe((state) => {
    const window = getMainWindow();
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
      return;
    }
    window.webContents.send(agentControlStateChannel, state);
  });
  const requireWorkspace = (): AgenteraWorkspaceManager => {
    if (!agenteraWorkspace) {
      throw Object.assign(new Error("Workspace control is unavailable."), {
        code: "service_unavailable",
      });
    }
    return agenteraWorkspace;
  };
  const workspaceStateChannel = "agentera-workspace-state-changed";
  const workspaceInvitationChannel = "agentera-workspace-invitation-received";
  agenteraWorkspace?.subscribe((state) => {
    const window = getMainWindow();
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
      return;
    }
    window.webContents.send(
      workspaceStateChannel,
      serializeWorkspacePublicState(state),
    );
  });
  workspaceInvitationInbox.subscribe((invitation) => {
    const window = getMainWindow();
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
      return;
    }
    window.webContents.send(workspaceInvitationChannel, {
      token: invitation.token,
    });
  });
  const requireOrganization = (): AgenteraOrganizationManager => {
    if (!agenteraOrganization) {
      throw Object.assign(new Error("Organization control is unavailable."), {
        code: "service_unavailable",
      });
    }
    return agenteraOrganization;
  };
  const organizationStateChannel = "agentera-organization-state-changed";
  const organizationInvitationChannel =
    "agentera-organization-invitation-received";
  agenteraOrganization?.subscribe((state) => {
    const window = getMainWindow();
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
      return;
    }
    window.webContents.send(
      organizationStateChannel,
      serializeOrganizationPublicState(state),
    );
  });
  workspaceInvitationInbox.subscribeOrganization((invitation) => {
    const window = getMainWindow();
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
      return;
    }
    window.webContents.send(organizationInvitationChannel, {
      token: invitation.token,
    });
  });
  const requireProductSpace = (): AgenteraProductSpaceManager => {
    if (!agenteraProductSpace) {
      throw Object.assign(new Error("Product Space is unavailable."), {
        code: "service_unavailable",
      });
    }
    return agenteraProductSpace;
  };
  const productSpaceStateChannel = "agentera-product-space-state-changed";
  agenteraProductSpace?.subscribe((state) => {
    const window = getMainWindow();
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
      return;
    }
    window.webContents.send(
      productSpaceStateChannel,
      serializeProductSpacePublicState(state),
    );
  });
  const directProfileTargetIndex: Readonly<Record<string, number>> = {
    "set-profile-avatar": 0,
    "set-profile-color": 0,
    "set-profile-name": 0,
    "remove-profile-avatar": 0,
  };
  const assertChannelProfileTarget = (
    channel: string,
    rendererArguments: readonly unknown[],
  ): void => {
    const index =
      AGENTERA_PROFILE_ARGUMENT_INDEX[channel] ??
      directProfileTargetIndex[channel];
    if (index === undefined) return;
    const connection = getConnectionConfig();
    if (connection.mode !== "local") return;
    const candidate = rendererArguments[index];
    const profile =
      candidate === undefined || candidate === null || candidate === ""
        ? getActiveProfileNameSync()
        : candidate;
    if (typeof profile !== "string" || !isValidProfileName(profile)) {
      throw new Error("AgentEra Runtime Profile target is invalid.");
    }
    agenteraProfileBindings.verifyProfileBinding(
      profileHome(profile),
      getAgenteraRuntimeOwner(),
    );
  };
  const ipcMain = createGuardedIpcMain(
    electronIpcMain,
    productAccessGuard,
    assertChannelProfileTarget,
  );
  ipcMain.handle("agentera-official-quality-get-consent", () =>
    requireOfficialQuality().getConsent(),
  );
  ipcMain.handle(
    "agentera-official-quality-set-passive-consent",
    (_event, input: unknown) =>
      requireOfficialQuality().setConsent(
        "official_quality_metrics",
        parseOfficialQualityConsentInput(input).enabled,
      ),
  );
  ipcMain.handle(
    "agentera-official-quality-set-explicit-feedback-consent",
    (_event, input: unknown) =>
      requireOfficialQuality().setConsent(
        "official_explicit_feedback",
        parseOfficialQualityConsentInput(input).enabled,
      ),
  );
  ipcMain.handle(
    "agentera-official-quality-submit-feedback",
    (_event, input: unknown) =>
      requireOfficialQuality().submitFeedback(
        parseOfficialQualityFeedbackInput(input),
      ),
  );
  const noEncryptedBackupArguments = (values: unknown[]): void => {
    if (values.length !== 0) {
      throw Object.assign(new Error("Invalid encrypted backup request."), {
        code: "invalid_request",
      });
    }
  };
  ipcMain.handle(
    "agentera-encrypted-backup-get-state",
    (_event, ...values: unknown[]) => {
      noEncryptedBackupArguments(values);
      return requireEncryptedBackup().getState();
    },
  );
  ipcMain.handle(
    "agentera-encrypted-backup-initialize-recovery",
    (_event, input: unknown) => {
      parseInitializeEncryptedBackupRecoveryInput(input);
      return requireEncryptedBackup().initializeRecovery();
    },
  );
  ipcMain.handle(
    "agentera-encrypted-backup-confirm-recovery",
    (_event, input: unknown) => {
      parseConfirmEncryptedBackupRecoveryInput(input);
      return requireEncryptedBackup().confirmRecoverySaved();
    },
  );
  ipcMain.handle(
    "agentera-encrypted-backup-register-current-device",
    (_event, input: unknown) => {
      parseRegisterEncryptedBackupDeviceInput(input);
      return requireEncryptedBackup().registerCurrentDevice();
    },
  );
  ipcMain.handle(
    "agentera-encrypted-backup-authorize-device",
    (_event, input: unknown) => {
      const parsed = parseAuthorizeEncryptedBackupDeviceInput(input);
      return requireEncryptedBackup().authorizeDevice(parsed.deviceId);
    },
  );
  ipcMain.handle("agentera-encrypted-backup-create", (_event, input: unknown) =>
    requireEncryptedBackup().createBackup(
      parseCreateEncryptedBackupInput(input).installationId,
    ),
  );
  ipcMain.handle("agentera-encrypted-backup-cancel", (_event, input: unknown) =>
    requireEncryptedBackup().cancelBackup(
      parseCancelEncryptedBackupInput(input).installationId,
    ),
  );
  ipcMain.handle(
    "agentera-encrypted-backup-list",
    (_event, ...values: unknown[]) => {
      noEncryptedBackupArguments(values);
      return requireEncryptedBackup().listBackups();
    },
  );
  ipcMain.handle(
    "agentera-encrypted-backup-delete",
    (_event, input: unknown) => {
      const parsed = parseDeleteEncryptedBackupInput(input);
      return requireEncryptedBackup().deleteBackup(parsed.backupId);
    },
  );
  ipcMain.handle(
    "agentera-encrypted-backup-set-daily-schedule",
    (_event, input: unknown) => {
      const parsed = parseSetEncryptedBackupScheduleInput(input);
      return requireEncryptedBackup().setDailySchedule(
        parsed.installationId,
        parsed.enabled,
      );
    },
  );
  ipcMain.handle(
    "agentera-encrypted-backup-list-devices",
    (_event, ...values: unknown[]) => {
      noEncryptedBackupArguments(values);
      return requireEncryptedBackup().listDevices();
    },
  );
  ipcMain.handle(
    "agentera-encrypted-backup-revoke-device",
    (_event, input: unknown) => {
      const parsed = parseRevokeEncryptedBackupDeviceInput(input);
      return requireEncryptedBackup().revokeDevice(parsed.deviceId);
    },
  );
  ipcMain.handle(
    "agentera-encrypted-backup-prepare-restore",
    (_event, input: unknown) =>
      requireEncryptedBackup().prepareRestore(
        parsePrepareEncryptedBackupRestoreInput(input),
      ),
  );
  ipcMain.handle(
    "agentera-encrypted-backup-confirm-restore",
    (_event, input: unknown) => {
      const parsed = parseConfirmEncryptedBackupRestoreInput(input);
      return requireEncryptedBackup().confirmRestore({
        preparationId: parsed.preparationId,
        name: parsed.name,
      });
    },
  );
  ipcMain.handle(
    "agentera-encrypted-backup-cancel-restore",
    (_event, input: unknown) =>
      requireEncryptedBackup().cancelRestore(
        parseCancelEncryptedBackupRestoreInput(input).preparationId,
      ),
  );
  const registerAgentControlHandler = (
    channel: string,
    listener: (...args: unknown[]) => unknown,
  ): void => {
    const level = AGENTERA_IPC_CHANNEL_POLICY[channel];
    if (!level) throw new Error(`Missing AgentEra IPC policy for ${channel}.`);
    electronIpcMain.handle(channel, (event, ...args: unknown[]) =>
      executeAgentControlIpc(() => {
        productAccessGuard.assert(level);
        return listener(event, ...args);
      }),
    );
  };
  const registerWorkspaceHandler = (
    channel: string,
    listener: (...args: unknown[]) => unknown,
  ): void => {
    const level = AGENTERA_IPC_CHANNEL_POLICY[channel];
    if (!level) throw new Error(`Missing AgentEra IPC policy for ${channel}.`);
    electronIpcMain.handle(channel, (event, ...args: unknown[]) =>
      executeWorkspaceIpc(() => {
        productAccessGuard.assert(level);
        return listener(event, ...args);
      }),
    );
  };
  const registerOrganizationHandler = (
    channel: string,
    listener: (...args: unknown[]) => unknown,
  ): void => {
    const level = AGENTERA_IPC_CHANNEL_POLICY[channel];
    if (!level) throw new Error(`Missing AgentEra IPC policy for ${channel}.`);
    electronIpcMain.handle(channel, (event, ...args: unknown[]) =>
      executeOrganizationIpc(() => {
        productAccessGuard.assert(level);
        return listener(event, ...args);
      }),
    );
  };
  const registerProductSpaceHandler = (
    channel: string,
    listener: (...args: unknown[]) => unknown,
  ): void => {
    const level = AGENTERA_IPC_CHANNEL_POLICY[channel];
    if (!level) throw new Error(`Missing AgentEra IPC policy for ${channel}.`);
    electronIpcMain.handle(channel, (event, ...args: unknown[]) =>
      executeProductSpaceIpc(() => {
        productAccessGuard.assert(level);
        return listener(event, ...args);
      }),
    );
  };

  registerProductSpaceHandler("agentera-product-space-get-state", () =>
    requireProductSpace().getState().then(serializeProductSpacePublicState),
  );
  registerProductSpaceHandler("agentera-product-space-refresh", () =>
    requireProductSpace().refresh().then(serializeProductSpacePublicState),
  );
  registerProductSpaceHandler(
    "agentera-product-space-select",
    (_event, input: unknown) =>
      requireProductSpace()
        .select(parseProductSpaceSelectionInput(input))
        .then(serializeProductSpacePublicState),
  );

  registerOrganizationHandler("agentera-organization-get-state", () =>
    requireOrganization().getState().then(serializeOrganizationPublicState),
  );
  registerOrganizationHandler("agentera-organization-refresh", () =>
    requireOrganization().refresh().then(serializeOrganizationPublicState),
  );
  registerOrganizationHandler(
    "agentera-organization-create",
    (_event, input: unknown) =>
      requireOrganization()
        .create(parseCreateOrganizationInput(input))
        .then(serializeOrganizationSummary),
  );
  registerOrganizationHandler(
    "agentera-organization-rename",
    (_event, input: unknown) =>
      requireOrganization()
        .rename(parseRenameOrganizationInput(input))
        .then(serializeOrganizationSummary),
  );
  registerOrganizationHandler(
    "agentera-organization-archive",
    (_event, input: unknown) =>
      requireOrganization()
        .archive(parseOrganizationRevisionInput(input))
        .then(serializeOrganizationSummary),
  );
  registerOrganizationHandler(
    "agentera-organization-restore",
    (_event, input: unknown) =>
      requireOrganization()
        .restore(parseOrganizationRevisionInput(input))
        .then(serializeOrganizationSummary),
  );
  registerOrganizationHandler(
    "agentera-organization-transfer-owner",
    (_event, input: unknown) =>
      requireOrganization()
        .transferOwner(parseTransferOrganizationOwnerInput(input))
        .then(serializeOrganizationSummary),
  );
  registerOrganizationHandler(
    "agentera-organization-dissolve",
    (_event, input: unknown) =>
      requireOrganization()
        .dissolve(parseDissolveOrganizationInput(input))
        .then(serializeOrganizationSummary),
  );
  registerOrganizationHandler(
    "agentera-organization-list-members",
    (_event, input: unknown) =>
      requireOrganization()
        .listMembers(parseOrganizationIDInput(input))
        .then(serializeOrganizationMemberCollection),
  );
  registerOrganizationHandler(
    "agentera-organization-patch-member",
    (_event, input: unknown) =>
      requireOrganization()
        .patchMember(parsePatchOrganizationMemberInput(input))
        .then(serializeOrganizationMember),
  );
  registerOrganizationHandler(
    "agentera-organization-remove-member",
    async (_event, input: unknown) => {
      await requireOrganization().removeMember(
        parseRemoveOrganizationMemberInput(input),
      );
      return true;
    },
  );
  registerOrganizationHandler(
    "agentera-organization-leave",
    async (_event, input: unknown) => {
      await requireOrganization().leave(parseOrganizationIDInput(input));
      return true;
    },
  );
  registerOrganizationHandler(
    "agentera-organization-list-departments",
    (_event, input: unknown) =>
      requireOrganization()
        .listDepartments(parseOrganizationIDInput(input))
        .then(serializeOrganizationDepartmentCollection),
  );
  registerOrganizationHandler(
    "agentera-organization-create-department",
    (_event, input: unknown) =>
      requireOrganization()
        .createDepartment(parseCreateOrganizationDepartmentInput(input))
        .then(serializeOrganizationDepartment),
  );
  registerOrganizationHandler(
    "agentera-organization-rename-department",
    (_event, input: unknown) =>
      requireOrganization()
        .renameDepartment(parseRenameOrganizationDepartmentInput(input))
        .then(serializeOrganizationDepartment),
  );
  registerOrganizationHandler(
    "agentera-organization-archive-department",
    (_event, input: unknown) =>
      requireOrganization()
        .archiveDepartment(parseReviseOrganizationDepartmentInput(input))
        .then(serializeOrganizationDepartment),
  );
  registerOrganizationHandler(
    "agentera-organization-restore-department",
    (_event, input: unknown) =>
      requireOrganization()
        .restoreDepartment(parseReviseOrganizationDepartmentInput(input))
        .then(serializeOrganizationDepartment),
  );
  registerOrganizationHandler(
    "agentera-organization-list-invitations",
    (_event, input: unknown) =>
      requireOrganization()
        .listInvitations(parseOrganizationIDInput(input))
        .then(serializeOrganizationInvitationCollection),
  );
  registerOrganizationHandler(
    "agentera-organization-create-invitation",
    (_event, input: unknown) =>
      requireOrganization()
        .createInvitation(parseOrganizationIDInput(input))
        .then(serializeOrganizationInvitationCreation),
  );
  registerOrganizationHandler(
    "agentera-organization-revoke-invitation",
    async (_event, input: unknown) => {
      await requireOrganization().revokeInvitation(
        parseRevokeOrganizationInvitationInput(input),
      );
      return true;
    },
  );
  registerOrganizationHandler(
    "agentera-organization-accept-invitation",
    async (_event, input: unknown) => {
      const parsed = parseAcceptOrganizationInvitationInput(input);
      const accepted = await requireOrganization().acceptInvitation(parsed);
      workspaceInvitationInbox.clearAcceptedOrganization(parsed.token);
      return serializeOrganizationInvitationAcceptance(accepted);
    },
  );
  registerOrganizationHandler(
    "agentera-organization-get-pending-invitation",
    () => workspaceInvitationInbox.peekOrganization(),
  );
  registerOrganizationHandler(
    "agentera-organization-dismiss-pending-invitation",
    (_event, input: unknown) => {
      const parsed = parseDismissOrganizationInvitationInput(input);
      return workspaceInvitationInbox.dismissOrganization(parsed.token);
    },
  );
  registerOrganizationHandler(
    "agentera-organization-get-current-policy",
    (_event, input: unknown) =>
      requireOrganization()
        .getCurrentPolicy(parseOrganizationIDInput(input))
        .then(serializeOrganizationCurrentPolicyState),
  );
  registerOrganizationHandler(
    "agentera-organization-list-policy-snapshots",
    (_event, input: unknown) =>
      requireOrganization()
        .listPolicySnapshots(parseOrganizationIDInput(input))
        .then(serializeOrganizationPolicySummaries),
  );
  registerOrganizationHandler(
    "agentera-organization-publish-policy",
    (_event, input: unknown) =>
      requireOrganization()
        .publishPolicy(parsePublishOrganizationPolicyInput(input))
        .then(serializeOrganizationPolicySnapshot),
  );
  registerOrganizationHandler(
    "agentera-organization-get-policy-snapshot",
    (_event, input: unknown) =>
      requireOrganization()
        .getPolicySnapshot(parseGetOrganizationPolicySnapshotInput(input))
        .then(serializeOrganizationPolicySnapshot),
  );
  registerOrganizationHandler(
    "agentera-organization-list-audit-events",
    (_event, input: unknown) => {
      const parsed = parseOrganizationAuditPageInput(input);
      return requireOrganization()
        .listAuditEvents({ organizationId: parsed.organizationId }, parsed.page)
        .then(serializeOrganizationAuditPage);
    },
  );

  registerWorkspaceHandler("agentera-workspace-get-state", () =>
    requireWorkspace().getState().then(serializeWorkspacePublicState),
  );
  registerWorkspaceHandler("agentera-workspace-refresh", () =>
    requireWorkspace().refresh().then(serializeWorkspacePublicState),
  );
  registerWorkspaceHandler(
    "agentera-workspace-select",
    (_event, input: unknown) =>
      requireWorkspace()
        .select(parseSelectWorkspaceInput(input))
        .then(serializeWorkspacePublicState),
  );
  registerWorkspaceHandler(
    "agentera-workspace-create",
    (_event, input: unknown) => {
      const parsed = parseCreateWorkspaceInput(input);
      return requireWorkspace()
        .create({
          ...parsed,
          idempotencyKey: createWorkspaceIdempotencyKey(),
        })
        .then(serializeWorkspaceSummary);
    },
  );
  registerWorkspaceHandler(
    "agentera-workspace-rename",
    (_event, input: unknown) =>
      requireWorkspace()
        .rename(parseRenameWorkspaceInput(input))
        .then(serializeWorkspaceSummary),
  );
  registerWorkspaceHandler(
    "agentera-workspace-archive",
    (_event, input: unknown) =>
      requireWorkspace()
        .archive(parseWorkspaceRevisionInput(input))
        .then(serializeWorkspaceSummary),
  );
  registerWorkspaceHandler(
    "agentera-workspace-restore",
    (_event, input: unknown) =>
      requireWorkspace()
        .restore(parseWorkspaceRevisionInput(input))
        .then(serializeWorkspaceSummary),
  );
  registerWorkspaceHandler(
    "agentera-workspace-list-members",
    (_event, input: unknown) =>
      requireWorkspace()
        .listMembers(parseWorkspaceIDInput(input))
        .then((members) => members.map(serializeWorkspaceMember)),
  );
  registerWorkspaceHandler(
    "agentera-workspace-change-member-role",
    (_event, input: unknown) =>
      requireWorkspace()
        .changeMemberRole(parseChangeWorkspaceMemberRoleInput(input))
        .then(serializeWorkspaceMember),
  );
  registerWorkspaceHandler(
    "agentera-workspace-remove-member",
    async (_event, input: unknown) => {
      await requireWorkspace().removeMember(
        parseRemoveWorkspaceMemberInput(input),
      );
      return true;
    },
  );
  registerWorkspaceHandler(
    "agentera-workspace-leave",
    async (_event, input: unknown) => {
      await requireWorkspace().leave(parseWorkspaceIDInput(input));
      return true;
    },
  );
  registerWorkspaceHandler(
    "agentera-workspace-list-invitations",
    (_event, input: unknown) =>
      requireWorkspace()
        .listInvitations(parseWorkspaceIDInput(input))
        .then((invitations) => invitations.map(serializeWorkspaceInvitation)),
  );
  registerWorkspaceHandler(
    "agentera-workspace-create-invitation",
    (_event, input: unknown) => {
      const parsed = parseWorkspaceIDInput(input);
      return requireWorkspace()
        .createInvitation({
          ...parsed,
          idempotencyKey: createWorkspaceIdempotencyKey(),
        })
        .then(serializeWorkspaceInvitationCreation);
    },
  );
  registerWorkspaceHandler(
    "agentera-workspace-revoke-invitation",
    async (_event, input: unknown) => {
      await requireWorkspace().revokeInvitation(
        parseRevokeWorkspaceInvitationInput(input),
      );
      return true;
    },
  );
  registerWorkspaceHandler(
    "agentera-workspace-accept-invitation",
    async (_event, input: unknown) => {
      const parsed = parseAcceptWorkspaceInvitationInput(input);
      const accepted = await requireWorkspace().acceptInvitation({
        ...parsed,
        idempotencyKey: createWorkspaceIdempotencyKey(),
      });
      workspaceInvitationInbox.clearAccepted(parsed.token);
      return serializeWorkspaceInvitationAcceptance(accepted);
    },
  );
  registerWorkspaceHandler("agentera-workspace-get-pending-invitation", () =>
    workspaceInvitationInbox.peek(),
  );
  registerWorkspaceHandler(
    "agentera-workspace-dismiss-pending-invitation",
    (_event, input: unknown) => {
      const parsed = parseDismissWorkspaceInvitationInput(input);
      return workspaceInvitationInbox.dismiss(parsed.token);
    },
  );

  registerAgentControlHandler("agentera-agents-get-state", () =>
    requireAgentControl().getState(),
  );
  registerAgentControlHandler("agentera-agents-list-drafts", () =>
    requireAgentControl().listDrafts(),
  );
  registerAgentControlHandler(
    "agentera-agents-get-draft",
    (_event, id: unknown) =>
      requireAgentControl().getDraft(parseAgentControlId(id)),
  );
  registerAgentControlHandler(
    "agentera-agents-create-draft",
    (_event, input: unknown) =>
      requireAgentControl().createDraft(parseCreateDraftInput(input)),
  );
  registerAgentControlHandler(
    "agentera-agents-update-draft",
    (_event, input: unknown) =>
      requireAgentControl().updateDraft(parseUpdateDraftInput(input)),
  );
  registerAgentControlHandler(
    "agentera-agents-delete-draft",
    (_event, id: unknown) =>
      requireAgentControl().deleteDraft(parseAgentControlId(id)),
  );
  registerAgentControlHandler(
    "agentera-agents-prepare-publication",
    (_event, id: unknown) =>
      requireAgentControl().preparePublication(parseAgentControlId(id)),
  );
  registerAgentControlHandler(
    "agentera-agents-confirm-publication",
    (_event, handle: unknown) =>
      requireAgentControl().confirmPublication(parseAgentControlId(handle)),
  );
  registerAgentControlHandler(
    "agentera-agents-prepare-organization-submission",
    async (_event, draftId: unknown) =>
      serializeOrganizationSubmissionPreview(
        await requireAgentControl().prepareOrganizationSubmission(
          parseAgentControlId(draftId),
        ),
      ),
  );
  registerAgentControlHandler(
    "agentera-agents-confirm-organization-submission",
    async (_event, input: unknown) =>
      serializeOrganizationAgentSubmission(
        await requireAgentControl().confirmOrganizationSubmission(
          parseConfirmOrganizationSubmissionInput(input),
        ),
      ),
  );
  registerAgentControlHandler(
    "agentera-agents-list-organization-submissions",
    async () =>
      (await requireAgentControl().listOrganizationSubmissions()).map(
        serializeOrganizationAgentSubmission,
      ),
  );
  registerAgentControlHandler(
    "agentera-agents-get-organization-submission",
    async (_event, submissionId: unknown) =>
      serializeOrganizationSubmissionDetail(
        await requireAgentControl().getOrganizationSubmission(
          parseAgentControlId(submissionId),
        ),
      ),
  );
  registerAgentControlHandler(
    "agentera-agents-prepare-organization-review",
    async (_event, input: unknown) =>
      serializeOrganizationReviewPreview(
        await requireAgentControl().prepareOrganizationReview(
          parsePrepareOrganizationReviewInput(input),
        ),
      ),
  );
  registerAgentControlHandler(
    "agentera-agents-confirm-organization-review",
    async (_event, input: unknown) =>
      serializeOrganizationAgentSubmission(
        await requireAgentControl().confirmOrganizationReview(
          parseConfirmOrganizationReviewInput(input),
        ),
      ),
  );
  registerAgentControlHandler(
    "agentera-agents-prepare-organization-withdrawal",
    async (_event, submissionId: unknown) =>
      serializeOrganizationWithdrawalPreview(
        await requireAgentControl().prepareOrganizationWithdrawal(
          parseAgentControlId(submissionId),
        ),
      ),
  );
  registerAgentControlHandler(
    "agentera-agents-confirm-organization-withdrawal",
    async (_event, input: unknown) =>
      serializeOrganizationAgentSubmission(
        await requireAgentControl().confirmOrganizationWithdrawal(
          parseConfirmOrganizationWithdrawalInput(input),
        ),
      ),
  );
  registerAgentControlHandler("agentera-agents-list-definitions", () =>
    requireAgentControl().listDefinitions(),
  );
  registerAgentControlHandler("agentera-agents-list-official", () =>
    requireAgentControl().listOfficialAgents(),
  );
  registerAgentControlHandler(
    "agentera-agents-get-official-detail",
    (_event, definitionId: unknown) =>
      requireAgentControl().getOfficialAgentDetail(
        parseAgentControlId(definitionId),
      ),
  );
  registerAgentControlHandler(
    "agentera-agents-prepare-official-install",
    (_event, definitionId: unknown) =>
      requireAgentControl().prepareOfficialInstall(
        parseAgentControlId(definitionId),
      ),
  );
  registerAgentControlHandler(
    "agentera-agents-confirm-official-install",
    (_event, input: unknown) =>
      requireAgentControl().confirmOfficialInstall(
        parseConfirmOfficialAgentInstallInput(input),
      ),
  );
  registerAgentControlHandler("agentera-agents-refresh-official-updates", () =>
    requireAgentControl().refreshOfficialUpdates(),
  );
  registerAgentControlHandler(
    "agentera-agents-apply-official-update",
    (_event, installationId: unknown) =>
      requireAgentControl().applyOfficialUpdate(
        parseAgentControlId(installationId),
      ),
  );
  registerAgentControlHandler(
    "agentera-agents-list-versions",
    (_event, definitionId: unknown) =>
      requireAgentControl().listVersions(parseAgentControlId(definitionId)),
  );
  registerAgentControlHandler("agentera-agents-list-installations", () =>
    requireAgentControl().listInstallations(),
  );
  registerAgentControlHandler(
    "agentera-agents-install-version",
    (_event, input: unknown) =>
      requireAgentControl().installVersion(parseInstallVersionInput(input)),
  );
  registerAgentControlHandler(
    "agentera-agents-claim-version",
    (_event, input: unknown) =>
      requireAgentControl().claimVersion(parseClaimVersionInput(input)),
  );
  registerAgentControlHandler(
    "agentera-agents-retry-installation",
    (_event, input: unknown) =>
      requireAgentControl().retryPendingInstallation(
        parseRetryPendingInstallationInput(input),
      ),
  );
  registerAgentControlHandler(
    "agentera-agents-select-version",
    (_event, input: unknown) =>
      requireAgentControl().selectInstallationVersion(
        parseSelectInstallationVersionInput(input),
      ),
  );
  registerAgentControlHandler(
    "agentera-agents-archive-installation",
    (_event, id: unknown) =>
      requireAgentControl().archiveInstallation(parseAgentControlId(id)),
  );
  registerAgentControlHandler(
    "agentera-agents-list-eligible-experience-skills",
    (_event, installationId: unknown) =>
      requireAgentControl().listEligibleExperienceSkills(
        parseAgentControlId(installationId),
      ),
  );
  registerAgentControlHandler(
    "agentera-agents-prepare-experience-candidate",
    (_event, input: unknown) =>
      requireAgentControl().prepareExperienceCandidate(
        parsePrepareExperienceCandidateInput(input),
      ),
  );
  registerAgentControlHandler(
    "agentera-agents-submit-experience-candidate",
    (_event, input: unknown) =>
      requireAgentControl().submitExperienceCandidate(
        parseSubmitExperienceCandidateInput(input),
      ),
  );
  registerAgentControlHandler(
    "agentera-agents-list-my-experience-candidates",
    () => requireAgentControl().listMyExperienceCandidates(),
  );
  registerAgentControlHandler(
    "agentera-agents-list-experience-review-queue",
    () => requireAgentControl().listExperienceReviewQueue(),
  );
  registerAgentControlHandler(
    "agentera-agents-get-experience-candidate",
    (_event, candidateId: unknown) =>
      requireAgentControl().getExperienceCandidate(
        parseAgentControlId(candidateId),
      ),
  );
  registerAgentControlHandler(
    "agentera-agents-review-experience-candidate",
    (_event, input: unknown) =>
      requireAgentControl().reviewExperienceCandidate(
        parseReviewExperienceCandidateInput(input),
      ),
  );
  registerAgentControlHandler(
    "agentera-agents-prepare-experience-candidate-import",
    (_event, candidateId: unknown) =>
      requireAgentControl().prepareExperienceCandidateImport(
        parseAgentControlId(candidateId),
      ),
  );
  registerAgentControlHandler(
    "agentera-agents-confirm-experience-candidate-import",
    (_event, input: unknown) =>
      requireAgentControl().confirmExperienceCandidateImport(
        parseConfirmExperienceCandidateImportInput(input),
      ),
  );
  const mainWindow = getMainWindow();
  // AgentEra product authentication is intentionally namespaced away from the
  // legacy Hermes account and provider OAuth channels.
  ipcMain.handle("agentera-auth-get-state", () =>
    agenteraAuth.getPublicState(),
  );
  const parseAgenteraLoginOptions = (
    rawOptions: unknown,
  ): { forceAccountSelection?: boolean } => {
    if (rawOptions === undefined) return {};
    if (
      !rawOptions ||
      typeof rawOptions !== "object" ||
      Array.isArray(rawOptions)
    ) {
      throw new Error("AgentEra login options are invalid.");
    }
    const options = rawOptions as Record<string, unknown>;
    if (
      Object.keys(options).some((key) => key !== "forceAccountSelection") ||
      (options.forceAccountSelection !== undefined &&
        typeof options.forceAccountSelection !== "boolean")
    ) {
      throw new Error("AgentEra login options are invalid.");
    }
    return {
      forceAccountSelection: options.forceAccountSelection === true,
    };
  };
  ipcMain.handle("agentera-auth-start-login", (_event, rawOptions: unknown) => {
    if (rawOptions === undefined) return agenteraAuth.startBrowserLogin();
    return agenteraAuth.startBrowserLogin(
      parseAgenteraLoginOptions(rawOptions),
    );
  });
  ipcMain.handle(
    "agentera-auth-restart-login",
    (_event, rawOptions: unknown) => {
      if (rawOptions === undefined) return agenteraAuth.restartBrowserLogin();
      return agenteraAuth.restartBrowserLogin(
        parseAgenteraLoginOptions(rawOptions),
      );
    },
  );
  ipcMain.handle("agentera-auth-copy-login-link", () => {
    return agenteraAuth.copyBrowserLoginLink();
  });
  ipcMain.handle("agentera-auth-cancel-login", () =>
    agenteraAuth.cancelBrowserLogin(),
  );
  ipcMain.handle("agentera-auth-retry-online", () =>
    agenteraAuth.refreshOnline(),
  );
  ipcMain.handle("agentera-auth-logout", () => agenteraAuth.logout());
  ipcMain.handle("agentera-auth-open-portal", (_event, target: unknown) => {
    if (target !== "account" && target !== "devices" && target !== "recharge") {
      throw new Error("AgentEra portal target is invalid.");
    }
    return agenteraAuth.openPortal(target);
  });

  const currentAgenteraUserId = (): string => {
    return getAgenteraRuntimeOwner().ownerId;
  };

  ipcMain.handle("agentera-user-profile-get", () => {
    return agenteraUserProfiles.getOrCreate(currentAgenteraUserId());
  });
  ipcMain.handle(
    "agentera-user-profile-update",
    (_event, rawInput: unknown) => {
      if (
        !rawInput ||
        typeof rawInput !== "object" ||
        Array.isArray(rawInput)
      ) {
        throw new Error("AgentEra user profile input is invalid.");
      }
      const input = rawInput as Record<string, unknown>;
      const expectedKeys = [
        "avatarDataUrl",
        "bio",
        "displayName",
        "occupation",
      ];
      if (
        Object.keys(input).length !== expectedKeys.length ||
        expectedKeys.some(
          (key) => !Object.prototype.hasOwnProperty.call(input, key),
        )
      ) {
        throw new Error("AgentEra user profile input is invalid.");
      }
      const profile = agenteraUserProfiles.save(currentAgenteraUserId(), {
        displayName: input.displayName as string,
        occupation: input.occupation as string,
        bio: input.bio as string,
        avatarDataUrl: input.avatarDataUrl as string | null,
      });
      const window = getMainWindow();
      if (
        window &&
        !window.isDestroyed() &&
        !window.webContents.isDestroyed()
      ) {
        window.webContents.send("agentera-user-profile-changed", profile);
      }
      return profile;
    },
  );
  ipcMain.handle("agentera-global-profile-get", () =>
    agenteraGlobalProfiles.get(currentAgenteraUserId()),
  );
  ipcMain.handle(
    "agentera-global-profile-set",
    (_event, input: SetAgenteraGlobalProfileEntryInput) => {
      const result = agenteraGlobalProfiles.setEntry(
        currentAgenteraUserId(),
        input,
      );
      if (result.success) notifyGlobalProfileChanged(result.value);
      return result;
    },
  );
  ipcMain.handle(
    "agentera-global-profile-remove",
    (_event, entryId: string) => {
      const result = agenteraGlobalProfiles.removeEntry(
        currentAgenteraUserId(),
        entryId,
      );
      if (result.success) notifyGlobalProfileChanged(result.value);
      return result;
    },
  );
  ipcMain.handle("agentera-global-profile-history", () =>
    agenteraGlobalProfiles.listHistory(currentAgenteraUserId()),
  );
  ipcMain.handle(
    "agentera-global-profile-rollback",
    (_event, targetVersion: number) => {
      const result = agenteraGlobalProfiles.rollback(
        currentAgenteraUserId(),
        targetVersion,
      );
      if (result.success) notifyGlobalProfileChanged(result.value);
      return result;
    },
  );
  ipcMain.handle(
    "agentera-global-profile-conversation-context",
    (
      _event,
      runId: string,
      profile?: string,
      resumeSessionId?: string | null,
    ): AgenteraGlobalProfileConversationContext => {
      if (
        typeof runId !== "string" ||
        !runId ||
        runId.length > 256 ||
        /\p{Cc}/u.test(runId)
      ) {
        throw new Error("AgentEra conversation identity is invalid.");
      }
      const identityProfileId = profile?.trim() || "default";
      if (!isValidProfileName(identityProfileId)) {
        throw new Error("AgentEra Runtime Profile target is invalid.");
      }
      if (
        resumeSessionId !== undefined &&
        resumeSessionId !== null &&
        typeof resumeSessionId !== "string"
      ) {
        throw new Error("AgentEra Hermes session identity is invalid.");
      }
      const identityResumeSessionId = agentIdentity.resolveResumeSessionId(
        identityProfileId,
        resumeSessionId ?? undefined,
      );
      const identityConversationKey = agentIdentity.scopeConversationKey(
        identityProfileId,
        runId,
      );
      const binding = agenteraProfileBindings.verifyProfileBinding(
        profileHome(identityProfileId),
        getAgenteraRuntimeOwner(),
      );
      const result = agenteraGlobalProfiles.prepareConversationSnapshot(
        currentAgenteraUserId(),
        identityConversationKey,
        {
          existingSession: Boolean(identityResumeSessionId),
          ...(identityResumeSessionId
            ? {
                resumeSession: {
                  profileId: identityProfileId,
                  sessionId: identityResumeSessionId,
                },
              }
            : {}),
        },
      );
      if (!result.success) {
        console.warn(
          "[agentera-global-profile] Conversation context degraded:",
          result.error,
        );
      }
      const context = summarizeGlobalProfileConversationSnapshot(result);
      return {
        ...context,
        requiresBoundApiTransport:
          context.requiresBoundApiTransport ||
          binding.agentInstallationId !== null ||
          identityConversationKey !== runId,
      };
    },
  );
  ipcMain.handle(
    "agentera-memory-candidates-extract",
    (_event, rawText: unknown, profile: unknown) =>
      agenteraMemoryCandidates.extract(
        currentAgenteraUserId(),
        rawText,
        profile,
      ),
  );
  ipcMain.handle(
    "agentera-memory-candidates-confirm",
    (_event, batchId: string, profile: string) => {
      const result = agenteraMemoryCandidateConfirmation.confirm(
        currentAgenteraUserId(),
        batchId,
        profile,
      );
      if (result.success) {
        if (result.value.identity) {
          notifyAgentIdentityChanged(result.value.identity);
        }
        if (result.value.globalProfile) {
          notifyGlobalProfileChanged(result.value.globalProfile);
        }
      }
      return result;
    },
  );
  ipcMain.handle(
    "agentera-memory-candidates-reject",
    (_event, batchId: string, profile: string) =>
      agenteraMemoryCandidateConfirmation.reject(
        currentAgenteraUserId(),
        batchId,
        profile,
      ),
  );

  const runtimeState = async (
    action?: (
      manager: RuntimeDistributionManager,
    ) =>
      | RuntimeDistributionPublicState
      | Promise<RuntimeDistributionPublicState>,
  ): Promise<RuntimeDistributionPublicState> => {
    if (runtimeDistribution === null) {
      return serializeRuntimeDistributionPublicState(
        RUNTIME_DISTRIBUTION_UNAVAILABLE_STATE,
      );
    }
    const state = action
      ? await action(runtimeDistribution)
      : await runtimeDistribution.getState();
    return serializeRuntimeDistributionPublicState(state);
  };
  runtimeDistribution?.subscribe((state) => {
    const window = getMainWindow();
    if (!window || window.isDestroyed()) return;
    window.webContents.send(
      "agentera-runtime-state-changed",
      serializeRuntimeDistributionPublicState(state),
    );
  });
  ipcMain.handle("agentera-runtime-get-state", () => runtimeState());
  ipcMain.handle("agentera-runtime-check-update", () =>
    runtimeState((manager) => manager.check()),
  );
  ipcMain.handle("agentera-runtime-download-confirmed", () =>
    runtimeState((manager) => manager.downloadConfirmed()),
  );
  ipcMain.handle("agentera-runtime-cancel-download", () =>
    runtimeState((manager) => manager.cancelDownload()),
  );
  ipcMain.handle("agentera-runtime-restart-apply", () =>
    runtimeState((manager) => manager.restartToApply()),
  );
  ipcMain.handle("agentera-runtime-retry-repair", () =>
    runtimeState((manager) => manager.retryRepair()),
  );

  ipcMain.handle("agentera-install-file-probe", () => ({
    installed: probeAgenteraInstallFiles().installed,
  }));
  ipcMain.handle("agentera-startup-preflight", () =>
    runAgenteraStartupPreflight({
      getConnectionConfig,
      checkInstallStatus: probeAgenteraInstallFiles,
      verifyInstall,
      probeRemote: (config) => testRemoteConnection(config.remoteUrl),
      probeSsh: (config) => testSshConnection(config.ssh),
    }),
  );

  ipcMain.handle("agentera-profile-resolve-account-space", async () => {
    const config = getConnectionConfig();
    if (config.mode !== "local") {
      throw new Error("Account spaces require local Runtime mode.");
    }
    const { profiles: locations, owner } =
      await discoverProfilesForCurrentOwner({
        discoverProfiles: listLocalProfileLocations,
        getCurrentOwner: getAgenteraRuntimeOwner,
      });
    const preferred = agenteraProfileBindings.findPreferredOwnedProfile(
      locations,
      owner,
    );
    if (preferred) {
      if (!preferred.profile.isActive) {
        setActiveProfile(preferred.profile.id);
        if (getActiveProfileNameSync() !== preferred.profile.id) {
          throw new Error("The account's local space could not be activated.");
        }
        notifyProfileSwitched();
      }
      return {
        status: "bound",
        profileId: preferred.profile.id,
        runtimeProfileId: preferred.binding.runtimeProfileId,
      };
    }

    const active = locations.find((profile) => profile.isActive);
    if (!active) {
      throw new Error("The active local Profile is unavailable.");
    }
    const inspection = agenteraProfileBindings.inspectProfile(
      active.path,
      owner,
    );
    if (inspection.status === "unbound" && !inspection.meaningfulData) {
      const binding = agenteraProfileBindings.bindExistingProfile(
        active.path,
        owner,
      );
      return {
        status: "bound",
        profileId: active.id,
        runtimeProfileId: binding.runtimeProfileId,
      };
    }
    if (inspection.status === "owned" && inspection.isCurrentOwner) {
      return {
        status: "bound",
        profileId: active.id,
        runtimeProfileId: inspection.binding.runtimeProfileId,
      };
    }

    const created = agenteraProfileBindings.createAndBindFreshProfile({
      name: `AgentEra Space ${Date.now().toString(36)}`,
      owner,
      createProfile,
      resolveProfilePath: (profileId) => profileHome(profileId),
      activateProfile: (profileId) => {
        setActiveProfile(profileId);
        if (getActiveProfileNameSync() !== profileId) {
          throw new Error("The new account space could not be activated.");
        }
        notifyProfileSwitched();
      },
    });
    return {
      status: "bound",
      profileId: created.profileId,
      runtimeProfileId: created.binding.runtimeProfileId,
    };
  });

  ipcMain.handle("agentera-profile-inspect-active", () => {
    const config = getConnectionConfig();
    if (config.mode !== "local") {
      throw new Error("The active Runtime context is not a local Profile.");
    }
    const inspection = agenteraProfileBindings.inspectProfile(
      profileHome(getActiveProfileNameSync()),
      getAgenteraRuntimeOwner(),
    );
    if (inspection.status === "unbound") return inspection;
    return {
      status: inspection.status,
      meaningfulData: inspection.meaningfulData,
      isCurrentOwner: inspection.isCurrentOwner,
      ...(inspection.isCurrentOwner
        ? { runtimeProfileId: inspection.binding.runtimeProfileId }
        : {}),
    };
  });
  ipcMain.handle("agentera-profile-bind-active", () => {
    const config = getConnectionConfig();
    if (config.mode !== "local") {
      throw new Error("The active Runtime context is not a local Profile.");
    }
    const binding = agenteraProfileBindings.bindExistingProfile(
      profileHome(getActiveProfileNameSync()),
      getAgenteraRuntimeOwner(),
    );
    return { status: "bound", runtimeProfileId: binding.runtimeProfileId };
  });
  ipcMain.handle("agentera-profile-create-fresh", (_event, name: string) => {
    const config = getConnectionConfig();
    if (config.mode !== "local") {
      throw new Error("Fresh local Profiles require local Runtime mode.");
    }
    const created = agenteraProfileBindings.createAndBindFreshProfile({
      name,
      owner: getAgenteraRuntimeOwner(),
      createProfile,
      resolveProfilePath: (profileId) => profileHome(profileId),
      activateProfile: (profileId) => {
        setActiveProfile(profileId);
        notifyProfileSwitched();
      },
    });
    return {
      status: "bound",
      profileId: created.profileId,
      runtimeProfileId: created.binding.runtimeProfileId,
    };
  });
  ipcMain.handle("agentera-profile-list-unbound", async () => {
    const locations = await listLocalProfileLocations();
    return agenteraProfileBindings
      .listUnboundProfiles(locations)
      .map((profile) => ({
        id: profile.id,
        isActive: profile.isActive,
        meaningfulData: hasMeaningfulHermesProfileData(profile.path),
      }));
  });
  ipcMain.handle("agentera-connection-inspect-current", () => {
    const config = getConnectionConfig();
    if (config.mode === "local") {
      throw new Error("The active Runtime context is not remote or SSH.");
    }
    const inspection = agenteraConnectionOwners.inspectConnectionContext(
      config.connectionContextId,
      getAgenteraRuntimeOwner(),
    );
    return inspection.status === "unbound"
      ? inspection
      : {
          status: inspection.status,
          isCurrentOwner: inspection.isCurrentOwner,
        };
  });
  ipcMain.handle("agentera-connection-bind-current", () => {
    const config = getConnectionConfig();
    if (config.mode === "local") {
      throw new Error("The active Runtime context is not remote or SSH.");
    }
    agenteraConnectionOwners.bindConnectionContext(
      config.connectionContextId,
      getAgenteraRuntimeOwner(),
    );
    return { status: "bound" };
  });
  ipcMain.handle("agentera-switch-to-local", () => {
    const existing = getConnectionConfig();
    stopSshTunnel();
    setConnectionConfig({ ...existing, mode: "local" });
    resetSshDashboardAvailability();
    notifyConnectionConfigChanged();
  });

  // Installation
  ipcMain.handle("check-install", () => {
    const status = probeAgenteraInstallFiles();
    return {
      installed: status.installed,
      configured: status.configured,
      hasApiKey: status.hasApiKey,
      verified: status.installed,
    };
  });

  ipcMain.handle("verify-install", () => verifyInstall());

  ipcMain.handle("start-install", async (event) => {
    try {
      const result = await runPackagedSeedInstall(
        (progress: InstallProgress) => {
          event.sender.send("install-progress", progress);
        },
      );
      if (result.status === "installed") {
        // The Welcome flow installs through the local Seed installer so it can
        // return detailed repair guidance. Synchronize the long-lived manager
        // immediately; otherwise Settings keeps its startup-time `missing`
        // snapshot until the entire desktop is restarted.
        if (runtimeDistribution !== null) {
          const synchronized = await runtimeDistribution.retryRepair();
          if (
            synchronized.phase !== "current" ||
            synchronized.currentVersion !== result.runtimeVersion
          ) {
            return {
              success: false,
              error:
                "AgentEra Runtime was prepared but could not be activated. Retry the local repair.",
              errorCode: "runtime-activation-failed",
              repairRequired: true,
              action: "retry",
            };
          }
        }
        return { success: true };
      }
      const error =
        result.errorCode === "packaged-seed-invalid"
          ? "The Runtime included with AgentEra Studio is missing or invalid. Reinstall AgentEra Studio."
          : result.errorCode === "insufficient-disk-space"
            ? "There is not enough free disk space to prepare AgentEra Runtime."
            : result.errorCode === "runtime-health-failed"
              ? "The included AgentEra Runtime did not pass its local health check."
              : "AgentEra Runtime could not be prepared from the local installer resources.";
      return {
        success: false,
        error,
        errorCode: result.errorCode,
        repairRequired: true,
        action: result.action,
      };
    } catch (err) {
      return {
        success: false,
        error: (err as Error).message,
        errorCode: "runtime-install-failed",
        repairRequired: true,
        action: "retry",
      };
    }
  });

  // Explicit "use an existing external Runtime" compatibility path.
  ipcMain.handle("validate-hermes-home", (_event, dir: string) =>
    validateHermesHome(dir),
  );
  ipcMain.handle("adopt-hermes-home", (_event, dir: string) => {
    if (!validateHermesHome(dir)) return false;
    // Persist the choice only. HERMES_HOME is resolved once at module
    // load, so the override takes effect on the next launch — the renderer
    // asks the user to restart. (An app-driven relaunch is unreliable
    // under the dev server, which is torn down with the process.)
    setHermesHomeOverride(dir);
    return true;
  });
  ipcMain.handle("quit-app", () => app.quit());

  // GPU fallback visibility: lets the Office tab explain SwiftShader slowness
  // and offer a one-click recovery instead of silently rendering 3D on the CPU.
  ipcMain.handle("get-gpu-status", () => getGpuStatus());
  ipcMain.handle("reenable-gpu", () => reenableGpuAndRelaunch());
  // Settings → Appearance hardware-acceleration preference. Validated here
  // because the renderer is untrusted for main-process file writes.
  ipcMain.handle("set-gpu-preference", (_event, mode: GpuPreferenceMode) => {
    if (mode !== "auto" && mode !== "on" && mode !== "off") return false;
    return setGpuPreference(mode);
  });
  ipcMain.handle("relaunch-app", () => relaunchApp());

  // Hermes engine info
  ipcMain.handle("get-hermes-version", async () => {
    const conn = getConnectionConfig();
    if (conn.mode === "remote") return remoteGetHermesVersion(conn);
    if (conn.mode === "ssh" && conn.ssh)
      return withSshDashboardSessions(
        conn,
        (config) => remoteGetHermesVersion(config),
        () => sshGetHermesVersion(conn.ssh),
        activeSshProfile(),
      );
    return getHermesVersion();
  });
  ipcMain.handle("refresh-hermes-version", async () => {
    const conn = getConnectionConfig();
    if (conn.mode === "remote") return remoteGetHermesVersion(conn);
    if (conn.mode === "ssh" && conn.ssh)
      return withSshDashboardSessions(
        conn,
        (config) => remoteGetHermesVersion(config),
        () => sshGetHermesVersion(conn.ssh),
        activeSshProfile(),
      );
    clearVersionCache();
    return getHermesVersion();
  });
  ipcMain.handle("run-hermes-doctor", () => {
    const conn = getConnectionConfig();
    if (conn.mode === "ssh" && conn.ssh) return sshRunDoctor(conn.ssh);
    return runHermesDoctor();
  });
  ipcMain.handle("run-hermes-update", async (event) => {
    try {
      const conn = getConnectionConfig();
      if (conn.mode === "ssh" && conn.ssh) {
        event.sender.send("install-progress", {
          step: 1,
          totalSteps: 1,
          title: "Updating remote AgentEra Runtime",
          detail: "Running hermes update over SSH...",
          log: "Running hermes update over SSH...\n",
        });
        await sshRunUpdate(conn.ssh);
        const compat = await ensureSshDashboardCompatibility(conn.ssh);
        if (!compat.ok) {
          event.sender.send("install-progress", {
            step: 1,
            totalSteps: 1,
            title: "Updating remote AgentEra Runtime",
            detail: "Dashboard compatibility check needs attention.",
            log: `Dashboard compatibility warning: ${
              compat.error ? `${compat.detail}: ${compat.error}` : compat.detail
            }\n`,
          });
        }
        await sshStartGateway(conn.ssh);
        await startSshTunnel(conn.ssh);
        // Authoritative SSH credential is the remote API_SERVER_KEY (see
        // getSshDashboardSessionConfig); conn.apiKey is remote-mode-only.
        const key = (await sshReadRemoteApiKey(conn.ssh)).trim();
        setSshRemoteApiKey(key);
        return { success: true };
      }
      await runHermesUpdate((progress: InstallProgress) => {
        event.sender.send("install-progress", progress);
      });
      const compat = ensureLocalDashboardCompatibility();
      if (!compat.ok) {
        event.sender.send("install-progress", {
          step: 1,
          totalSteps: 1,
          title: "Updating AgentEra Runtime",
          detail: "Dashboard compatibility check needs attention.",
          log: `Dashboard compatibility warning: ${
            compat.error ? `${compat.detail}: ${compat.error}` : compat.detail
          }\n`,
        });
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // OpenClaw migration
  ipcMain.handle("check-openclaw", () => checkOpenClawExists());
  ipcMain.handle("run-claw-migrate", async (event) => {
    try {
      await runClawMigrate((progress: InstallProgress) => {
        event.sender.send("install-progress", progress);
      });
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // OAuth provider sign-in — spawns `hermes auth add <provider> --type
  // oauth`, streaming the CLI's output to the renderer's sign-in modal.
  ipcMain.handle("oauth-login", (event, provider: string, profile?: string) => {
    // Codex uses a device-code flow: it prints a URL + code instead
    // of opening a browser. Watch the stream for that prompt, then
    // open the page and pre-copy the code so the user just pastes.
    let buffer = "";
    let deviceHandled = false;
    return runHermesAuthLogin(
      provider,
      (chunk) => {
        // The user can close the modal mid-flow before cancelHermesAuthLogin
        // tears down the subprocess; any send on a destroyed sender throws.
        if (event.sender.isDestroyed()) return;
        event.sender.send("oauth-login-progress", chunk);
        if (deviceHandled) return;
        buffer += chunk;
        const device = detectDeviceCode(buffer);
        if (device) {
          deviceHandled = true;
          openExternalUrl(device.url);
          clipboard.writeText(device.code);
          event.sender.send(
            "oauth-login-progress",
            `\n→ Code ${device.code} copied to clipboard — opening browser...\n`,
          );
        }
      },
      profile,
    );
  });
  ipcMain.handle("oauth-login-cancel", () => cancelHermesAuthLogin());

  // Hermes account sign-in — OAuth 2.0 Device Authorization Grant against the
  // Hermes backend. Streams progress to the renderer's modal, opens the browser
  // approval page once the code is issued, and stores the encrypted session.
  ipcMain.handle("hermes-account-login", (event, profile?: string) =>
    startDeviceLogin(profile, {
      onCode: (info) => {
        if (event.sender.isDestroyed()) return;
        // Show the code in the modal, then open the browser to approve it.
        event.sender.send("hermes-account-login-code", info);
        openExternalUrl(info.verificationUriComplete);
      },
      emit: (chunk) => {
        if (event.sender.isDestroyed()) return;
        event.sender.send("hermes-account-login-progress", chunk);
      },
    }),
  );
  ipcMain.handle("hermes-account-login-cancel", () => cancelDeviceLogin());
  // The account is device-wide (one Hermes One login for the whole app), but
  // account.json lives under whichever profile was active at sign-in. Resolve
  // it app-wide so switching the active agent doesn't read as signed out, and
  // sign out wherever the file lives.
  ipcMain.handle("hermes-account-get", (_event, profile?: string) =>
    getAccount(findAccountProfile() ?? profile),
  );
  ipcMain.handle("hermes-account-logout", () => {
    clearAllAccounts();
    return { success: true };
  });

  // Cloud agent sync — reconciles local profiles with the signed-in Hermes One
  // account's cloud agents. `agent-sync-updated` tells the renderer to reload
  // its profile list (pull-created profiles appear without a manual refresh).
  ipcMain.handle("agent-sync-run", async (event) => {
    const result = await syncAgents();
    if (!event.sender.isDestroyed()) {
      event.sender.send("agent-sync-updated", result);
    }
    return result;
  });
  ipcMain.handle("agent-sync-status", () => getAgentSyncStatus());
  // The cloud agent id a profile is currently linked to (null when unlinked),
  // for the per-profile Sync tab.
  ipcMain.handle("agent-sync-linked-id", (_event, profile: string) =>
    getLinkedAgentId(profile),
  );

  // Configuration (profile-aware)
  ipcMain.handle("get-locale", () => getAppLocale());
  ipcMain.handle("set-locale", (_event, locale: AppLocale) =>
    setAppLocale(locale),
  );

  ipcMain.handle("get-env", (_event, profile?: string) => {
    const conn = getConnectionConfig();
    if (conn.mode === "ssh" && conn.ssh) return sshReadEnv(conn.ssh, profile);
    return readEnv(profile);
  });

  // Pre-send chat readiness — answers "if Send is clicked right now,
  // will it work?". Fail-open semantics: any uncertain state returns
  // `ok: true`, so the renderer never false-blocks a Send.
  ipcMain.handle("validate-chat-readiness", (_event, profile?: string) => {
    return validateChatReadiness(profile);
  });

  // Config-health audit + per-issue auto-fix. The renderer renders a
  // dismissible banner above the chat input and a full report in the
  // Settings → Diagnose section. Auto-fixes are additive only — never
  // delete; always log to ~/.hermes/logs/config-fixes.log.
  ipcMain.handle("get-config-health", (_event, profile?: string) => {
    return runConfigHealthCheck(profile);
  });

  ipcMain.handle("rerun-config-health", (_event, profile?: string) => {
    return runConfigHealthCheck(profile);
  });

  ipcMain.handle(
    "autofix-config-issue",
    (
      _event,
      code: IssueCode,
      profile?: string,
      context?: Record<string, string>,
    ) => {
      return autoFixIssue(code, profile, context);
    },
  );

  ipcMain.handle("get-config-fix-log", (_event, maxEntries?: number) => {
    return readConfigFixLog(maxEntries);
  });

  ipcMain.handle(
    "set-env",
    async (_event, key: string, value: string, profile?: string) => {
      const conn = getConnectionConfig();
      if (conn.mode === "ssh" && conn.ssh) {
        await sshSetEnvValue(conn.ssh, key, value, profile);
        return true;
      }
      setEnvValue(key, value, profile);
      // Every local Runtime process receives a snapshot of the profile env at
      // spawn. Retire the managed dashboard as soon as a credential changes so
      // the next chat starts it with the new key; model discovery uses the key
      // directly and therefore must not be mistaken for proof that an older
      // dashboard process has the same credential.
      const looksLikeCredential = isRuntimeCredentialEnvKey(key);
      if (looksLikeCredential) {
        stopDashboard(profile);
        // Tell every mounted chat to retire its WebSocket immediately. This
        // payload-free lifecycle signal is separate from account connection
        // config, so guest chats do not receive Remote/SSH account details. A
        // dashboard process can take time to finish after SIGTERM (especially
        // after a provider error); without the signal the renderer may keep
        // submitting to it even after a fresh dashboard has started.
        notifyRuntimeSnapshotChanged();
      }
      // Restart gateway so it picks up the new API key.
      // The earlier condition had a precedence bug —
      //   `(isGatewayRunning() && _API_KEY) || _TOKEN || HF_TOKEN`
      // — that triggered a restart for `_TOKEN`/`HF_TOKEN` writes even
      // when no local gateway was running, which in remote mode hit the
      // `startGateway` path with no local install (issue #266).
      // restartGateway() now also self-gates on isRemoteMode(), so this
      // is belt-and-braces, but the condition is fixed too for clarity.
      if (isGatewayRunning(profile) && looksLikeCredential) {
        void restartGateway(profile);
      }
      return true;
    },
  );

  ipcMain.handle("get-config", (_event, key: string, profile?: string) => {
    const conn = getConnectionConfig();
    if (conn.mode === "ssh" && conn.ssh)
      return sshGetConfigValue(conn.ssh, key, profile);
    return getConfigValue(key, profile);
  });

  ipcMain.handle(
    "set-config",
    async (_event, key: string, value: string, profile?: string) => {
      const conn = getConnectionConfig();
      if (conn.mode === "ssh" && conn.ssh) {
        await sshSetConfigValue(conn.ssh, key, value, profile);
        return true;
      }
      setConfigValue(key, value, profile);
      return true;
    },
  );

  ipcMain.handle("get-hermes-home", (_event, profile?: string) => {
    const conn = getConnectionConfig();
    if (conn.mode === "remote") return remoteGetHermesHome(conn);
    if (conn.mode === "ssh" && conn.ssh)
      return withSshDashboardSessions(
        conn,
        (config) => remoteGetHermesHome(config),
        () => sshGetHermesHome(conn.ssh, profile),
        activeSshProfile(profile),
      );
    return getHermesHome(profile);
  });

  ipcMain.handle("get-model-config", (_event, profile?: string) => {
    const conn = getConnectionConfig();
    if (conn.mode === "remote")
      return withRemoteDashboard(
        conn,
        () => remoteGetModelConfig(conn),
        () => getModelConfig(profile),
      );
    if (conn.mode === "ssh" && conn.ssh)
      return withSshDashboardSessions(
        conn,
        (config) => remoteGetModelConfig(config),
        () => sshGetModelConfig(conn.ssh!, profile),
        activeSshProfile(profile),
      );
    return getModelConfig(profile);
  });

  ipcMain.handle(
    "set-model-config",
    async (
      _event,
      provider: string,
      model: string,
      baseUrl: string,
      profile?: string,
    ) => {
      const conn = getConnectionConfig();
      if (conn.mode === "remote") {
        return withRemoteDashboard(
          conn,
          () => remoteSetModelConfig(conn, provider, model, baseUrl),
          () => {
            const prev = getModelConfig(profile);
            // Same library-mirroring as the pure-local path below: carry the
            // activated model's context-window and api_mode into config.yaml
            // so this local fallback write doesn't leave a stale transport.
            const libEntry = resolveLibraryModelEntry(provider, model, baseUrl);
            const runtimeProvider = persistNativeCustomRouteForModel(
              provider,
              model,
              baseUrl,
              profile,
              libEntry,
            );
            setModelConfig(
              runtimeProvider,
              model,
              baseUrl,
              profile,
              libEntry?.contextLength ?? null,
              libEntry?.apiMode ?? null,
            );
            const changed = refreshLocalModelRuntimeSnapshot(
              prev,
              { provider: runtimeProvider, model, baseUrl },
              profile,
            );
            if (changed) notifyRuntimeSnapshotChanged();
            return true;
          },
        );
      }
      if (conn.mode === "ssh" && conn.ssh) {
        return withSshDashboardSessions(
          conn,
          (config) => remoteSetModelConfig(config, provider, model, baseUrl),
          async () => {
            const prev = await sshGetModelConfig(conn.ssh!, profile);
            await sshSetModelConfig(
              conn.ssh!,
              provider,
              model,
              baseUrl,
              profile,
            );
            if (
              (await sshGatewayStatus(conn.ssh!)) &&
              (prev.provider !== provider ||
                prev.model !== model ||
                prev.baseUrl !== baseUrl)
            ) {
              await sshStopGateway(conn.ssh!);
              await sshStartGateway(conn.ssh!);
            }
            return true;
          },
          activeSshProfile(profile),
        );
      }
      const prev = getModelConfig(profile);
      // Mirror the activated model's context-window override and API-protocol
      // mode (if any) into config.yaml so the gauge, the agent's
      // auto-compaction threshold, and the runtime transport all match the
      // model being activated. Passing `null` when the library entry has none
      // clears any stale value left by a previously-active model — critical for
      // `api_mode`, since a leftover `anthropic_messages`/`chat_completions`
      // would otherwise route the new endpoint over the wrong protocol.
      const libEntry = resolveLibraryModelEntry(provider, model, baseUrl);
      const runtimeProvider = persistNativeCustomRouteForModel(
        provider,
        model,
        baseUrl,
        profile,
        libEntry,
      );
      setModelConfig(
        runtimeProvider,
        model,
        baseUrl,
        profile,
        libEntry?.contextLength ?? null,
        libEntry?.apiMode ?? null,
      );
      const changed = refreshLocalModelRuntimeSnapshot(
        prev,
        { provider: runtimeProvider, model, baseUrl },
        profile,
      );
      if (changed) notifyRuntimeSnapshotChanged();

      return true;
    },
  );

  // Auxiliary (side-task) model routing
  ipcMain.handle("get-auxiliary-config", (_event, profile?: string) => {
    const conn = getConnectionConfig();
    if (conn.mode === "ssh" && conn.ssh) {
      // TODO: SSH path for auxiliary config (requires sshGetAuxiliaryConfig)
      return [];
    }
    return getAuxiliaryConfig(profile);
  });

  ipcMain.handle(
    "set-auxiliary-task",
    async (
      _event,
      task: string,
      cfg: { provider: string; model: string; baseUrl: string },
      profile?: string,
    ) => {
      const conn = getConnectionConfig();
      if (conn.mode === "ssh" && conn.ssh) {
        // TODO: SSH path for auxiliary config (requires sshSetAuxiliaryTask)
        return false;
      }
      setAuxiliaryTask(task, cfg, profile);

      // Restart gateway so it picks up the new auxiliary config
      if (isGatewayRunning(profile)) {
        restartGateway(profile);
      }

      return true;
    },
  );

  ipcMain.handle("reset-auxiliary-config", async (_event, profile?: string) => {
    const conn = getConnectionConfig();
    if (conn.mode === "ssh" && conn.ssh) {
      // TODO: SSH path for auxiliary config (requires sshResetAuxiliaryConfig)
      return false;
    }
    resetAuxiliaryToAuto(profile);

    // Restart gateway so it picks up the reset
    if (isGatewayRunning(profile)) {
      restartGateway(profile);
    }

    return true;
  });

  // API_SERVER_KEY management — this is an internal local-gateway credential,
  // not a model-provider key. The renderer can ask Main to ensure it exists,
  // but never receives the generated secret itself.
  // Additive shape: `hasKey` stays the required primary field; `providerId` /
  // `checkedAt` are optional extras for a follow-up Settings/Gateway UI.
  ipcMain.handle("get-api-server-key-status", (_event, profile?: string) =>
    getApiServerKeyStatus(profile),
  );

  // Drops the cached secrets-provider values so the next status check re-reads
  // the vault — lets the renderer's "Refresh from vault" button take effect
  // immediately instead of waiting out the cache TTL.
  ipcMain.handle("invalidate-secrets-cache", () => {
    invalidateSecretsCache();
  });

  ipcMain.handle(
    "generate-api-server-key",
    async (_event, profile?: string) => {
      const result = ensureLocalApiServerKey(profile);
      // Restart gateway so it picks up the new key immediately.
      if (result.generated && isGatewayRunning(profile)) {
        const restarted = await restartGateway(profile);
        if (!restarted) {
          throw new Error(
            "The local gateway credential was created, but the gateway could not restart with it.",
          );
        }
      }
      return { generated: result.generated };
    },
  );

  // Connection mode (local / remote / ssh)
  ipcMain.handle("is-remote-mode", () => isRemoteMode());
  ipcMain.handle("is-remote-only-mode", () => isRemoteOnlyMode());
  ipcMain.handle("get-connection-config", () => getPublicConnectionConfig());
  ipcMain.handle("is-ssh-tunnel-active", () => isSshTunnelActive());

  ipcMain.handle(
    "set-connection-config",
    (
      _event,
      mode: "local" | "remote" | "ssh",
      remoteUrl: string,
      apiKey?: string,
    ) => {
      const existing = getConnectionConfig();
      setConnectionConfig({
        ...existing,
        mode,
        remoteUrl,
        remoteAuthMode:
          existing.remoteUrl === remoteUrl ? existing.remoteAuthMode : "auto",
        apiKey: resolveConnectionApiKeyUpdate(
          existing,
          mode,
          remoteUrl,
          apiKey,
        ),
      });
      resetSshDashboardAvailability();
      notifyRuntimeSnapshotChanged();
      return true;
    },
  );

  ipcMain.handle(
    "set-connection-chat-transports",
    (_event, remoteChatTransport: unknown, sshChatTransport: unknown) => {
      const current = getConnectionConfig();
      setConnectionConfig({
        ...current,
        remoteChatTransport: normalizeRemoteChatTransport(remoteChatTransport),
        sshChatTransport: normalizeRemoteChatTransport(sshChatTransport),
      });
      resetSshDashboardAvailability();
      notifyConnectionConfigChanged();
      return true;
    },
  );

  ipcMain.handle(
    "set-ssh-config",
    (
      _event,
      host: string,
      port: number,
      username: string,
      keyPath: string,
      remotePort: number,
      localPort: number,
    ) => {
      const current = getConnectionConfig();
      setConnectionConfig({
        ...current,
        mode: "ssh",
        ssh: { host, port, username, keyPath, remotePort, localPort },
      });
      resetSshDashboardAvailability();
      notifyConnectionConfigChanged();
      return true;
    },
  );

  ipcMain.handle(
    "test-remote-connection",
    (_event, url: string, apiKey?: string) => testRemoteConnection(url, apiKey),
  );

  ipcMain.handle("probe-remote-auth-mode", async (_event, url: string) => {
    const result = await probeRemoteAuthMode(url);
    const conn = getConnectionConfig();
    if (
      conn.mode === "remote" &&
      conn.remoteUrl.trim() === url.trim() &&
      conn.remoteAuthMode !== result.authMode
    ) {
      setConnectionConfig({ ...conn, remoteAuthMode: result.authMode });
      notifyConnectionConfigChanged();
    }
    return result;
  });

  ipcMain.handle("remote-oauth-login", async () => {
    const loginConfig = getConnectionConfig();
    if (loginConfig.mode !== "remote" || !loginConfig.remoteUrl.trim()) {
      throw new Error("Configure a Remote gateway URL before signing in.");
    }
    const result = await openRemoteOAuthLogin(
      loginConfig.remoteUrl,
      context.getMainWindow(),
    );
    setConnectionConfig(
      connectionConfigAfterRemoteOAuthLogin(
        loginConfig.remoteUrl,
        getConnectionConfig(),
      ),
    );
    rotateConnectionContextId();
    notifyConnectionConfigChanged();
    return result;
  });

  ipcMain.handle("remote-oauth-logout", async () => {
    const conn = getConnectionConfig();
    if (conn.mode !== "remote" || !conn.remoteUrl.trim()) {
      throw new Error("Remote gateway is not configured.");
    }
    await clearRemoteOAuthSession(conn.remoteUrl);
    rotateConnectionContextId();
    notifyConnectionConfigChanged();
    return { signedIn: false };
  });

  ipcMain.handle("remote-oauth-session-state", () => {
    const conn = getConnectionConfig();
    if (conn.mode !== "remote" || !conn.remoteUrl.trim()) {
      return { signedIn: false };
    }
    return remoteOAuthSessionState(conn.remoteUrl);
  });

  ipcMain.handle(
    "test-ssh-connection",
    (
      _event,
      host: string,
      port: number,
      username: string,
      keyPath: string,
      remotePort: number,
    ) =>
      testSshConnection({
        host,
        port,
        username,
        keyPath,
        remotePort,
        localPort: 19642,
      }),
  );

  ipcMain.handle("start-ssh-tunnel", async () => {
    const conn = getConnectionConfig();
    if (conn.mode !== "ssh") return false;
    // Route through the shared preparer so this targets the SAME endpoint
    // (dashboard 9119, else gateway api_server) as every other SSH path — a
    // bare ensureSshTunnel(conn.ssh) here would tunnel to the gateway port and
    // fight the dashboard tunnel.
    await prepareSshTunnel(conn);
    return true;
  });

  ipcMain.handle("stop-ssh-tunnel", () => {
    stopSshTunnel();
    return true;
  });

  // Chat — lazy-start gateway on first message
  ipcMain.handle(
    "transcribe-audio",
    async (
      _event,
      audio: Uint8Array,
      mimeType: string,
      profile?: string,
    ): Promise<string> => transcribeAudio(audio, mimeType, profile),
  );

  ipcMain.handle(
    "send-message",
    async (
      event,
      message: string,
      profile?: string,
      resumeSessionId?: string,
      history?: Array<{ role: string; content: string }>,
      attachments?: Attachment[],
      contextFolder?: string,
      runId?: string,
      modelOverride?: SessionModelOverride,
    ) => {
      // Each conversation has a stable runId minted by the renderer. Fall back
      // to a generated id for legacy callers so the run is still tracked.
      const chatRunId = runId || `run-${randomUUID()}`;
      const identityProfileId = profile?.trim() || "default";
      const identityResumeSessionId = agentIdentity.resolveResumeSessionId(
        identityProfileId,
        resumeSessionId,
      );
      const identityConversationKey = agentIdentity.scopeConversationKey(
        identityProfileId,
        chatRunId,
      );
      const globalProfileUserId = currentAgenteraUserId();
      const runtimeRun = runtimeActivity.beginRun(chatRunId);
      if (runtimeRun === null) {
        throw new Error("AgentEra Runtime restart is pending.");
      }
      try {
        const preparedAgentTurn =
          agenteraAgentControl &&
          hasAgenteraSignedInAccess(agenteraAuth.getPublicState())
            ? await agenteraAgentControl.prepareHermesTurn({
                conversationKey: identityConversationKey,
                profilePath: profileHome(profile),
                owner: getAgenteraRuntimeOwner(),
                resumeSessionId: identityResumeSessionId || null,
              })
            : null;
        let conversationEnvelope = preparedAgentTurn?.envelope;
        try {
          const globalSnapshot =
            agenteraGlobalProfiles.prepareConversationSnapshot(
              globalProfileUserId,
              identityConversationKey,
              {
                existingSession: Boolean(identityResumeSessionId),
                ...(identityResumeSessionId
                  ? {
                      resumeSession: {
                        profileId: identityProfileId,
                        sessionId: identityResumeSessionId,
                      },
                    }
                  : {}),
              },
            );
          if (globalSnapshot.success) {
            conversationEnvelope = composeGlobalProfileEnvelope(
              conversationEnvelope,
              globalSnapshot.value?.renderedSnapshot,
            );
          } else {
            console.warn(
              "[agentera-global-profile] Continuing without global profile:",
              globalSnapshot.error,
            );
          }
        } catch (error) {
          // The global profile is additive context. Corruption or local I/O
          // failure must never block the native Hermes conversation.
          console.warn(
            "[agentera-global-profile] Continuing without global profile:",
            error instanceof Error ? error.message : String(error),
          );
        }
        if (!isRemoteMode() && !isGatewayRunning(profile)) {
          startGateway(profile);
        }

        const conn = getConnectionConfig();
        if (conn.mode === "ssh" && conn.ssh) {
          // Tunnel to the dashboard (/api/* + chat WS; NOT /v1) and cache its
          // token, else the gateway api_server (/v1) — via the shared preparer
          // so all SSH paths agree on one tunnel target.
          await prepareSshTunnel(conn, profile);
        }

        let fullResponse = "";
        const chatStartTime = Date.now();
        let resolveChat: (v: { response: string; sessionId?: string }) => void;
        let rejectChat: (reason?: unknown) => void;
        const promise = new Promise<{ response: string; sessionId?: string }>(
          (res, rej) => {
            resolveChat = res;
            rejectChat = rej;
          },
        );

        // Streaming sends to `event.sender` will throw "Object has been
        // destroyed" if the renderer WebContents goes away mid-response
        // (window closed, reloaded, navigated away). Guard every send so a
        // dead sender doesn't crash the IPC handler, and abort the in-flight
        // chat the first time we see one — there's nobody listening anymore.
        // Every event carries the runId as its first arg so the renderer can
        // route it to the right conversation among several running at once.
        const safeSend = (channel: string, payload: unknown): boolean => {
          if (event.sender.isDestroyed()) return false;
          try {
            event.sender.send(channel, chatRunId, payload);
            return true;
          } catch {
            return false;
          }
        };
        const officialQualityObserver = createOfficialQualityChatObserver({
          binding: preparedAgentTurn?.binding ?? null,
          startedAt: chatStartTime,
          recordMetric: (input) =>
            agenteraOfficialQuality?.recordMetric(input) ?? null,
          onEligible: (eligibility) => {
            safeSend("agentera-official-quality-eligible", eligibility);
          },
        });
        const abortThisRun = (): void => {
          runtimeActivity.abortRun(chatRunId);
        };
        let boundGlobalProfileSessionId: string | null = null;
        const bindGlobalProfileSnapshotToSession = (
          sessionId: string,
        ): void => {
          if (boundGlobalProfileSessionId === sessionId) return;
          const bound =
            agenteraGlobalProfiles.bindConversationSnapshotToSession(
              globalProfileUserId,
              identityConversationKey,
              identityProfileId,
              sessionId,
            );
          if (bound.success) {
            boundGlobalProfileSessionId = sessionId;
          } else {
            console.warn(
              "[agentera-global-profile] Failed to bind Hermes session snapshot:",
              bound.error,
            );
          }
        };

        const handle = await sendMessage(
          message,
          {
            onChunk: (chunk) => {
              fullResponse += chunk;
              if (!safeSend("chat-chunk", chunk)) {
                // Renderer is gone — stop generating and resolve with what we
                // have so the awaiting promise doesn't leak.
                abortThisRun();
              }
            },
            onReasoningChunk: (chunk) => {
              // Forward reasoning/thinking tokens on a dedicated channel so
              // the renderer can render the thinking bubble live during the
              // stream rather than waiting for a focus-change refresh (#352).
              // Same renderer-gone abort guard as the content channel.
              if (!safeSend("chat-reasoning-chunk", chunk)) {
                abortThisRun();
              }
            },
            onDone: (sessionId) => {
              runtimeRun.finish();
              officialQualityObserver.onDone();
              if (sessionId) {
                bindGlobalProfileSnapshotToSession(sessionId);
                const recorded = agentIdentity.recordSessionRevision(
                  identityProfileId,
                  sessionId,
                );
                if (!recorded.success) {
                  console.warn(
                    "[agent-identity] Failed to record completed session:",
                    recorded.error,
                  );
                }
              }
              try {
                persistPromptImageAttachments(sessionId, message, attachments);
              } catch (err) {
                console.warn(
                  "[sessions] Failed to persist prompt image attachments:",
                  err,
                );
              }
              safeSend("chat-done", sessionId || "");
              resolveChat({ response: fullResponse, sessionId });
              // Desktop notification when window is not focused and response took >10s
              if (
                mainWindow &&
                !mainWindow.isFocused() &&
                Date.now() - chatStartTime > 10000
              ) {
                const preview = fullResponse
                  .replace(/[#*_`~\n]+/g, " ")
                  .trim()
                  .slice(0, 80);
                new Notification({
                  title: APP_NAME,
                  body: preview || "Response ready",
                }).show();
              }
            },
            onSessionStarted: (sessionId) => {
              if (preparedAgentTurn) {
                try {
                  agenteraAgentControl?.attachHermesSession(
                    preparedAgentTurn.binding.id,
                    sessionId,
                  );
                } catch {
                  runtimeRun.finish();
                  abortThisRun();
                  const message =
                    "AgentEra RuntimeBinding session attachment failed.";
                  safeSend("chat-error", message);
                  rejectChat(new Error(message));
                  return;
                }
              }
              bindGlobalProfileSnapshotToSession(sessionId);
              const recorded = agentIdentity.recordSessionRevision(
                identityProfileId,
                sessionId,
              );
              if (!recorded.success) {
                console.warn(
                  "[agent-identity] Failed to record new session:",
                  recorded.error,
                );
              }
              safeSend("chat-session-started", sessionId);
            },
            onError: (error) => {
              runtimeRun.finish();
              officialQualityObserver.onError(error);
              safeSend("chat-error", error);
              rejectChat(new Error(error));
              // Notify on error too if window not focused
              if (mainWindow && !mainWindow.isFocused()) {
                new Notification({
                  title: `${APP_NAME} — Error`,
                  body: error.slice(0, 100),
                }).show();
              }
            },
            onToolProgress: (tool) => {
              safeSend("chat-tool-progress", tool);
            },
            onToolEvent: (toolEvent) => {
              safeSend("chat-tool-event", toolEvent);
            },
            onUsage: (usage) => {
              officialQualityObserver.onUsage(usage);
              safeSend("chat-usage", usage);
            },
            onClarify: (req) => {
              safeSend("chat-clarify-request", req);
            },
          },
          profile,
          preparedAgentTurn?.resumeSessionId ?? identityResumeSessionId,
          history,
          attachments,
          contextFolder,
          modelOverride,
          conversationEnvelope,
        );

        runtimeRun.attachAbort(handle.abort);
        return promise;
      } catch (error) {
        runtimeRun.finish();
        throw error;
      }
    },
  );

  ipcMain.handle("abort-chat", (_event, runId?: string) => {
    // Abort one run when given its id; with no id (legacy callers) abort all.
    if (runId) {
      runtimeActivity.abortRun(runId);
      return;
    }
    runtimeActivity.abortAll();
  });

  // Renderer's answer to an inline clarify card. Resolves the pending gateway
  // request for this request_id, which forwards the answer to `clarify.respond`.
  ipcMain.handle(
    "clarify-respond",
    (_event, payload: { requestId: string; answer: string }) => {
      return resolvePendingClarify(
        payload?.requestId ?? "",
        payload?.answer ?? "",
      );
    },
  );

  // Renderer-driven clipboard write (issue #298 — "Copy entire chat").
  // Routed through the main process so it doesn't depend on the renderer's
  // document being focused, which the navigator.clipboard API requires.
  ipcMain.handle("copy-to-clipboard", (_event, text: string) => {
    clipboard.writeText(typeof text === "string" ? text : "");
  });

  // Media — render agent-generated images and save them to disk (#299).
  ipcMain.handle("read-media-file", (_event, filePath: string) =>
    readMediaForCurrentConnection(filePath),
  );
  ipcMain.handle("save-media-file", async (event, src: string, name: string) =>
    saveMedia(
      await resolveMediaForSave(src),
      name,
      BrowserWindow.fromWebContents(event.sender),
    ),
  );
  ipcMain.handle("media-file-exists", (_event, filePath: string) =>
    mediaFileExistsForCurrentConnection(filePath),
  );

  // Native right-click menu for a rendered media element (#299): "Open"
  // hands the file to the OS default handler (or a web URL to the browser),
  // "Save as…" writes a copy elsewhere. Labels are passed in from the
  // renderer so the menu honours the active UI locale.
  ipcMain.on(
    "show-media-menu",
    (
      event,
      src: string,
      name: string,
      labels: { open: string; saveAs: string },
    ) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || !src) return;
      const isUrl = /^https?:\/\//i.test(src);
      const isData = src.startsWith("data:");
      const template: Electron.MenuItemConstructorOptions[] = [];
      template.push({
        label: labels.open,
        click: () => {
          if (isUrl) {
            openExternalUrl(src);
            return;
          }

          const target = isData ? materializeDataUrlToTemp(src, name) : src;
          if (!target) return;
          shell.openPath(target).then((err) => {
            if (err) console.error("[media] open failed:", err);
          });
        },
      });
      template.push({
        label: labels.saveAs,
        click: () => {
          void saveMedia(src, name, win);
        },
      });
      Menu.buildFromTemplate(template).popup({ window: win });
    },
  );

  // Attachment staging — for pasted blobs that have no filesystem origin.
  ipcMain.handle(
    "stage-attachment",
    (_event, sessionId: string, filename: string, base64Bytes: string) => {
      return stageAttachment(sessionId, filename, base64Bytes);
    },
  );
  ipcMain.handle("clear-staged-attachments", (_event, sessionId: string) => {
    clearStagedAttachments(sessionId);
  });

  // Model discovery — fetch the provider's /v1/models for autocomplete.
  ipcMain.handle(
    "discover-provider-models",
    (
      _event,
      provider: string,
      baseUrl: string | undefined,
      apiKey: string | undefined,
      profile?: string,
    ) => {
      return discoverProviderModels(provider, baseUrl, apiKey, profile);
    },
  );

  // Authoritative context-window size for the active model (issue #597).
  // Resolves the real `context_length` from the provider's /models catalogue;
  // returns null when unavailable so the renderer falls back to its heuristic.
  ipcMain.handle(
    "get-model-context-window",
    (
      _event,
      provider: string,
      model: string,
      baseUrl: string | undefined,
      profile?: string,
    ) => {
      return getModelContextWindow(
        provider,
        model,
        baseUrl,
        undefined,
        profile,
      );
    },
  );

  // Gateway
  ipcMain.handle("start-gateway", async () => {
    const conn = getConnectionConfig();
    if (conn.mode === "ssh" && conn.ssh) {
      await sshStartGateway(conn.ssh);
      return { success: true, running: true };
    }
    if (conn.mode === "remote") {
      // The remote server runs its own gateway; nothing to start locally.
      // Without this guard we'd fall through to `startGateway()` and
      // spawn a non-existent local hermes-agent (issue #266).
      return {
        success: false,
        running: false,
        error:
          "Remote mode points at an already-running AgentEra Runtime server. Start or restart the gateway on that remote host.",
      };
    }
    return startGatewayDetailed();
  });
  ipcMain.handle("stop-gateway", async () => {
    const conn = getConnectionConfig();
    if (conn.mode === "ssh" && conn.ssh) {
      await sshStopGateway(conn.ssh);
      return true;
    }
    if (conn.mode === "remote") {
      // No local gateway to stop in pure remote mode.
      return true;
    }
    // No profile argument → stops the active profile's gateway, leaving any
    // other profiles' gateways running.
    stopGateway(undefined, true);
    return true;
  });
  ipcMain.handle("restart-gateway", async (_event, profile?: string) => {
    const conn = getConnectionConfig();
    if (conn.mode === "ssh" && conn.ssh) {
      await sshStopGateway(conn.ssh);
      await sshStartGateway(conn.ssh);
      return sshGatewayStatus(conn.ssh);
    }
    if (conn.mode === "remote") {
      return false;
    }
    return restartGateway(profile);
  });
  ipcMain.handle("gateway-status", () => {
    const conn = getConnectionConfig();
    if (conn.mode === "ssh" && conn.ssh) return sshGatewayStatus(conn.ssh);
    return isGatewayRunning();
  });

  // Dashboard/WebSocket transport probe. This is intentionally separate from
  // the current chat path while we validate the ordered event stream.
  ipcMain.handle("dashboard-status", (_event, profile?: string) =>
    getDashboardStatus(profile),
  );
  ipcMain.handle("fresh-dashboard-ws-url", (_event, profile?: string) =>
    freshDashboardWebSocketUrl(profile),
  );
  ipcMain.handle("start-dashboard", (_event, profile?: string) =>
    startDashboard(profile),
  );
  ipcMain.handle("stop-dashboard", (_event, profile?: string) =>
    stopDashboard(profile),
  );

  // Platform toggles (config.yaml platforms section)
  ipcMain.handle("get-platform-enabled", (_event, profile?: string) => {
    const conn = getConnectionConfig();
    if (conn.mode === "ssh" && conn.ssh)
      return sshGetPlatformEnabled(conn.ssh, profile);
    return getPlatformEnabled(profile);
  });
  ipcMain.handle(
    "set-platform-enabled",
    async (_event, platform: string, enabled: boolean, profile?: string) => {
      const conn = getConnectionConfig();
      if (conn.mode === "ssh" && conn.ssh) {
        await sshSetPlatformEnabled(conn.ssh, platform, enabled, profile);
        return true;
      }
      setPlatformEnabled(platform, enabled, profile);
      // Restart gateway so it picks up the new platform config
      if (isGatewayRunning(profile)) {
        restartGateway(profile);
      }
      return true;
    },
  );

  ipcMain.handle(
    "get-messaging-platforms",
    async (_event, profile?: string) => {
      const conn = getConnectionConfig();
      if (conn.mode === "remote") {
        return fetchRemoteMessagingPlatforms();
      }
      if (conn.mode === "ssh" && conn.ssh) {
        const [envData, enabled, running, platformToolsets] = await Promise.all(
          [
            sshReadEnv(conn.ssh, profile),
            sshGetPlatformEnabled(conn.ssh, profile),
            sshGatewayStatus(conn.ssh),
            sshGetPlatformToolsets(conn.ssh, profile),
          ],
        );
        return buildDesktopMessagingPlatforms(
          envData,
          enabled,
          running,
          platformToolsets,
        );
      }
      const running = isGatewayRunning(profile);
      return buildDesktopMessagingPlatforms(
        readEnv(profile),
        getPlatformEnabled(profile),
        running,
        getPlatformToolsets(profile),
        readLocalGatewayPlatformStates(profile, running),
      );
    },
  );

  ipcMain.handle(
    "update-messaging-platform",
    async (_event, platform: string, update, profile?: string) => {
      const conn = getConnectionConfig();
      if (conn.mode === "remote") {
        return updateRemoteMessagingPlatform(platform, update);
      }
      if (conn.mode === "ssh" && conn.ssh) {
        await applyMessagingPlatformUpdate(
          platform,
          update,
          (key, value) => sshSetEnvValue(conn.ssh!, key, value, profile),
          (key, enabled) =>
            sshSetPlatformEnabled(conn.ssh!, key, enabled, profile),
          (platformKey, toolsetKey, enabled) =>
            sshSetMessagingPlatformToolsetEnabled(
              conn.ssh!,
              platformKey,
              toolsetKey,
              enabled,
              profile,
            ),
        );
        return { ok: true, platform };
      }
      await applyMessagingPlatformUpdate(
        platform,
        update,
        (key, value) => setEnvValue(key, value, profile),
        (key, enabled) => setPlatformEnabled(key, enabled, profile),
        (platformKey, toolsetKey, enabled) =>
          setMessagingPlatformToolsetEnabled(
            platformKey,
            toolsetKey,
            enabled,
            profile,
          ),
      );
      if (isGatewayRunning(profile)) {
        restartGateway(profile);
      }
      return { ok: true, platform };
    },
  );

  ipcMain.handle(
    "test-messaging-platform",
    async (_event, platform: string, profile?: string) => {
      const conn = getConnectionConfig();
      if (conn.mode === "remote") {
        return testRemoteMessagingPlatform(platform);
      }
      if (conn.mode === "ssh" && conn.ssh) {
        const [envData, enabled, running, platformToolsets] = await Promise.all(
          [
            sshReadEnv(conn.ssh, profile),
            sshGetPlatformEnabled(conn.ssh, profile),
            sshGatewayStatus(conn.ssh),
            sshGetPlatformToolsets(conn.ssh, profile),
          ],
        );
        return testDesktopMessagingPlatform(
          platform,
          buildDesktopMessagingPlatforms(
            envData,
            enabled,
            running,
            platformToolsets,
          ),
        );
      }
      const running = isGatewayRunning(profile);
      return testDesktopMessagingPlatform(
        platform,
        buildDesktopMessagingPlatforms(
          readEnv(profile),
          getPlatformEnabled(profile),
          running,
          getPlatformToolsets(profile),
          readLocalGatewayPlatformStates(profile, running),
        ),
      );
    },
  );

  // Sessions
  ipcMain.handle("list-sessions", (_event, limit?: number, offset?: number) => {
    const conn = getConnectionConfig();
    if (conn.mode === "remote") return remoteListSessions(conn, limit, offset);
    if (conn.mode === "ssh" && conn.ssh)
      return withSshDashboardSessions(
        conn,
        (config) => remoteListSessions(config, limit, offset),
        () => sshListSessions(conn.ssh, limit, offset),
        activeSshProfile(),
      );
    return listSessions(limit, offset);
  });

  ipcMain.handle("get-session-messages", (_event, sessionId: string) => {
    const conn = getConnectionConfig();
    if (conn.mode === "remote")
      return remoteGetSessionMessages(conn, sessionId).then((items) =>
        applySessionLocalOverlays(sessionId, items),
      );
    if (conn.mode === "ssh" && conn.ssh)
      return withSshDashboardSessions(
        conn,
        (config) =>
          remoteGetSessionMessages(config, sessionId).then((items) =>
            applySessionLocalOverlays(sessionId, items),
          ),
        () =>
          sshGetSessionMessages(conn.ssh, sessionId).then((items) =>
            applySessionLocalOverlays(sessionId, items),
          ),
        activeSshProfile(),
      );
    return getSessionMessages(sessionId);
  });

  ipcMain.handle(
    "record-session-continuation",
    (_event, sessionId: string, items: DesktopSessionContinuationItem[]) => {
      persistSessionContinuation(sessionId, items);
      return true;
    },
  );

  ipcMain.handle(
    "record-session-local-error",
    (_event, sessionId: string, error: DesktopSessionLocalError) => {
      persistSessionLocalError(sessionId, error?.error, error?.userContent);
      return true;
    },
  );

  // Per-session linked working folder (issue #27): a desktop-only binding
  // persisted in the local state.db so a re-opened session restores its folder.
  ipcMain.handle("get-session-context-folder", (_event, sessionId: string) => {
    return getSessionContextFolder(sessionId);
  });

  ipcMain.handle(
    "set-session-context-folder",
    (_event, sessionId: string, folder: string | null) => {
      setSessionContextFolder(sessionId, folder);
      return true;
    },
  );

  ipcMain.handle(
    "list-recent-session-context-folders",
    (_event, limit?: number) => {
      const lim = typeof limit === "number" && limit > 0 ? limit : 20;
      const folders = getRecentSessionContextFolders(lim);
      if (folders.length < lim) {
        const cached = listCachedSessions(100);
        const seen = new Set(folders);
        for (const s of cached) {
          if (s.contextFolder && !seen.has(s.contextFolder)) {
            seen.add(s.contextFolder);
            folders.push(s.contextFolder);
            if (folders.length >= lim) break;
          }
        }
      }
      return folders;
    },
  );

  // Per-session model/provider selected from the in-chat picker. This is a
  // desktop-only routing binding and intentionally stores no API keys.
  ipcMain.handle("get-session-model-override", (_event, sessionId: string) => {
    return getSessionModelOverride(sessionId);
  });

  ipcMain.handle(
    "set-session-model-override",
    (_event, sessionId: string, override: SessionModelOverride | null) => {
      setSessionModelOverride(sessionId, override);
      return true;
    },
  );

  ipcMain.handle("delete-session", (_event, sessionId: string) => {
    const conn = getConnectionConfig();
    if (conn.mode === "remote") return remoteDeleteSession(conn, sessionId);
    if (conn.mode === "ssh" && conn.ssh)
      return withSshDashboardSessions(
        conn,
        (config) => remoteDeleteSession(config, sessionId),
        undefined,
        activeSshProfile(),
      );
    return deleteSession(sessionId);
  });

  ipcMain.handle("delete-sessions", (_event, sessionIds: string[]) => {
    const ids = Array.isArray(sessionIds) ? sessionIds : [];
    const conn = getConnectionConfig();
    if (conn.mode === "remote") return remoteDeleteSessions(conn, ids);
    if (conn.mode === "ssh" && conn.ssh)
      return withSshDashboardSessions(
        conn,
        (config) => remoteDeleteSessions(config, ids),
        undefined,
        activeSshProfile(),
      );
    return deleteSessions(ids);
  });

  // Profiles
  ipcMain.handle("list-profiles", async () => {
    const conn = getConnectionConfig();
    if (conn.mode === "ssh" && conn.ssh) {
      // The desktop's active profile is the LOCAL selection (persisted in
      // ~/.hermes/active_profile by set-active-profile), not whatever the remote
      // CLI last marked active. Override isActive so the UI highlights the
      // profile the user actually selected — and it survives relaunches.
      const active = getActiveProfileNameSync();
      const list = await sshListProfiles(conn.ssh);
      return list.map((p) => ({
        ...p,
        id: p.name,
        isActive: p.name === active,
        agentInstallationId: null,
        runtimeProfileId: null,
      }));
    }
    const owner = getAgenteraRuntimeOwner();
    const locations = await listLocalProfileLocations();
    const allowedProfileIds = new Set<string>();
    const safeBindingByProfileId = new Map<
      string,
      { agentInstallationId: string | null; runtimeProfileId: string }
    >();
    for (const profile of locations) {
      try {
        const inspection = agenteraProfileBindings.inspectProfile(
          profile.path,
          owner,
        );
        if (inspection.status === "owned" && inspection.isCurrentOwner) {
          allowedProfileIds.add(profile.id);
          safeBindingByProfileId.set(profile.id, {
            agentInstallationId: inspection.binding.agentInstallationId,
            runtimeProfileId: inspection.binding.runtimeProfileId,
          });
        }
      } catch {
        // A missing/corrupt/unowned Profile is not opened for rich metadata.
      }
    }
    const profiles = await listProfiles(allowedProfileIds);
    return profiles.map((profile) => ({
      ...profile,
      agentInstallationId:
        safeBindingByProfileId.get(profile.id)?.agentInstallationId ?? null,
      runtimeProfileId:
        safeBindingByProfileId.get(profile.id)?.runtimeProfileId ?? null,
    }));
  });
  ipcMain.handle(
    "create-profile",
    (_event, name: string, cloneFrom: string | null) => {
      const conn = getConnectionConfig();
      if (conn.mode === "ssh" && conn.ssh)
        return sshCreateProfile(conn.ssh, name, cloneFrom);
      const owner = getAgenteraRuntimeOwner();
      if (cloneFrom) {
        agenteraProfileBindings.verifyProfileBinding(
          profileHome(cloneFrom),
          owner,
        );
      }
      const created = createProfile(name, cloneFrom);
      if (created.success && created.id) {
        agenteraProfileBindings.bindExistingProfile(
          profileHome(created.id),
          owner,
        );
      }
      return created;
    },
  );
  ipcMain.handle("delete-profile", (_event, name: string) => {
    const conn = getConnectionConfig();
    if (conn.mode === "ssh" && conn.ssh)
      return sshDeleteProfile(conn.ssh, name);
    agenteraProfileBindings.verifyProfileBinding(
      profileHome(name),
      getAgenteraRuntimeOwner(),
    );
    return deleteProfile(name);
  });
  ipcMain.handle("set-active-profile", async (_event, name: string) => {
    // Persist the selection LOCALLY in every mode (incl. SSH) — the desktop
    // tracks "which profile is active" via the local ~/.hermes/active_profile,
    // so without this an SSH session forgot the choice and reset to `default`
    // on every relaunch. Then drop the cached health flag so the next check
    // probes the newly-active profile's gateway, not the previous one's.
    const conn = getConnectionConfig();
    if (conn.mode === "local") {
      agenteraProfileBindings.verifyProfileBinding(
        profileHome(name),
        getAgenteraRuntimeOwner(),
      );
    }
    setActiveProfile(name);
    notifyProfileSwitched();
    // Bring the activated profile's own gateway up if it isn't already —
    // without stopping any other profile's gateway (their bots stay online).
    if (conn.mode === "ssh" && conn.ssh) {
      // Per-profile gateway lives on the remote; start it over SSH. (Previously
      // SSH was skipped entirely, so selecting/Chatting a profile in the Agents
      // page never started its gateway and the status spun on "Starting…".)
      if (!(await sshGatewayStatus(conn.ssh, name))) {
        await sshStartGateway(conn.ssh, name);
      }
    } else if (!isRemoteMode() && !isGatewayRunning(name)) {
      startGateway(name);
    }
    return true;
  });

  // Profile appearance (desktop-only avatar + accent colour). Local-only —
  // these write to the local ~/.hermes profile dirs, not the SSH remote.
  ipcMain.handle("set-profile-color", (_event, name: string, color: string) =>
    setProfileColor(name, color),
  );
  ipcMain.handle("set-profile-name", (_event, id: string, name: string) => {
    const conn = getConnectionConfig();
    if (conn.mode === "ssh" || conn.mode === "remote") {
      return {
        success: false,
        error: "Agent renaming is only supported for local profiles",
      };
    }
    const result = agentIdentity.setDisplayName(id, name);
    if (result.success) notifyAgentIdentityChanged(result.identity);
    return result;
  });
  ipcMain.handle(
    "set-profile-avatar",
    (_event, name: string, dataUrl: string) => setProfileAvatar(name, dataUrl),
  );
  ipcMain.handle("remove-profile-avatar", (_event, name: string) =>
    removeProfileAvatar(name),
  );

  // Profile wallets are desktop-local and profile-scoped. The renderer only
  // receives public wallet metadata, plus a one-time recovery phrase immediately
  // after create/import.
  ipcMain.handle("list-wallets", (_event, profile?: string) =>
    listWallets(profile),
  );
  ipcMain.handle("create-wallet", (_event, profile?: string, name?: string) =>
    createWallet(profile, name),
  );
  ipcMain.handle("import-wallet", (_event, input: ImportWalletInput) =>
    importWallet(input),
  );
  ipcMain.handle(
    "rename-wallet",
    (_event, profile: string | undefined, id: string, name: string) =>
      renameWallet(profile, id, name),
  );
  ipcMain.handle(
    "delete-wallet",
    (_event, profile: string | undefined, id: string) =>
      deleteWallet(profile, id),
  );

  // Custom (OpenAI-compatible) providers are desktop-local and profile-scoped.
  // This store owns provider identity (name + base URL) so a configured
  // provider renders as a card independent of whether a model is added yet; the
  // key still lives in the profile `.env` and models in `models.json`.
  ipcMain.handle("list-custom-providers", (_event, profile?: string) =>
    listCustomProviders(profile),
  );
  ipcMain.handle(
    "upsert-custom-provider",
    (
      _event,
      profile: string | undefined,
      input: { name: string; baseUrl: string },
    ) => {
      const record = upsertCustomProvider(profile, input);
      notifyCustomProvidersChanged();
      return record;
    },
  );
  ipcMain.handle(
    "remove-custom-provider",
    (_event, profile: string | undefined, name: string) => {
      removeCustomProvider(profile, name);
      removeNativeCustomProvider(profile, name);
      stopDashboard(profile);
      notifyConnectionConfigChanged();
      notifyCustomProvidersChanged();
    },
  );
  // Cloud wallets provisioned by the backend for the profile's linked agent.
  // Read-only here; the desktop no longer mints wallets locally.
  ipcMain.handle("wallet-sync", (_event, profile?: string) =>
    syncWalletsForProfile(profile),
  );
  // Backend-driven wallet ops used by the Office's space representatives
  // (bank tellers): balances and provisioning both live server-side.
  ipcMain.handle(
    "wallet-portfolio",
    (_event, profile: string | undefined, walletId: string) =>
      getWalletPortfolio(profile, walletId),
  );
  ipcMain.handle("wallet-provision", (_event, profile?: string) =>
    provisionAgentWallet(profile),
  );
  ipcMain.handle("get-token-balances", (_event, address: string) =>
    getTokenBalances(address),
  );

  // Memory
  ipcMain.handle("read-memory", (_event, profile?: string) => {
    const conn = getConnectionConfig();
    if (conn.mode === "ssh" && conn.ssh)
      return sshReadMemory(conn.ssh, profile);
    return readMemory(profile);
  });
  ipcMain.handle("preview-user-memory-repair", (_event, profile?: string) => {
    if (getConnectionConfig().mode !== "local") {
      return {
        success: false,
        error: "USER.md repair is only supported for local Agent profiles.",
      };
    }
    return agentUserMemoryRepair.preview(profile?.trim() || "default");
  });
  ipcMain.handle(
    "apply-user-memory-repair",
    (
      _event,
      profile: string | undefined,
      expectedSha256: string,
      replacementContent: string,
      confirmed: boolean,
    ) => {
      if (getConnectionConfig().mode !== "local") {
        return {
          success: false,
          error: "USER.md repair is only supported for local Agent profiles.",
        };
      }
      return agentUserMemoryRepair.apply({
        profileId: profile?.trim() || "default",
        expectedSha256,
        replacementContent,
        confirmed,
      });
    },
  );
  ipcMain.handle(
    "undo-user-memory-repair",
    (_event, profile: string | undefined, operationId: string) => {
      if (getConnectionConfig().mode !== "local") {
        return {
          success: false,
          error: "USER.md repair is only supported for local Agent profiles.",
        };
      }
      return agentUserMemoryRepair.undo(
        profile?.trim() || "default",
        operationId,
      );
    },
  );
  ipcMain.handle(
    "add-memory-entry",
    (_event, content: string, profile?: string) => {
      const conn = getConnectionConfig();
      if (conn.mode === "ssh" && conn.ssh)
        return sshAddMemoryEntry(conn.ssh, content, profile);
      return addMemoryEntry(content, profile);
    },
  );
  ipcMain.handle(
    "update-memory-entry",
    (_event, index: number, content: string, profile?: string) => {
      const conn = getConnectionConfig();
      if (conn.mode === "ssh" && conn.ssh)
        return sshUpdateMemoryEntry(conn.ssh, index, content, profile);
      return updateMemoryEntry(index, content, profile);
    },
  );
  ipcMain.handle(
    "remove-memory-entry",
    (_event, index: number, profile?: string) => {
      const conn = getConnectionConfig();
      if (conn.mode === "ssh" && conn.ssh)
        return sshRemoveMemoryEntry(conn.ssh, index, profile);
      return removeMemoryEntry(index, profile);
    },
  );
  ipcMain.handle(
    "write-user-profile",
    (_event, content: string, profile?: string) => {
      const conn = getConnectionConfig();
      if (conn.mode === "ssh" && conn.ssh)
        return sshWriteUserProfile(conn.ssh, content, profile);
      return writeUserProfile(content, profile);
    },
  );

  // Soul
  ipcMain.handle("read-soul", (_event, profile?: string) => {
    const conn = getConnectionConfig();
    if (conn.mode === "ssh" && conn.ssh) return sshReadSoul(conn.ssh, profile);
    return readSoul(profile);
  });
  ipcMain.handle("write-soul", (_event, content: string, profile?: string) => {
    const conn = getConnectionConfig();
    if (conn.mode === "ssh" && conn.ssh)
      return sshWriteSoul(conn.ssh, content, profile);
    return writeSoul(content, profile);
  });
  ipcMain.handle("reset-soul", (_event, profile?: string) => {
    const conn = getConnectionConfig();
    if (conn.mode === "ssh" && conn.ssh) return sshResetSoul(conn.ssh, profile);
    return resetSoul(profile);
  });

  // Tools
  ipcMain.handle("get-toolsets", (_event, profile?: string) => {
    const conn = getConnectionConfig();
    if (conn.mode === "ssh" && conn.ssh)
      return sshGetToolsets(conn.ssh, profile);
    return getToolsets(profile);
  });
  ipcMain.handle(
    "set-toolset-enabled",
    (_event, key: string, enabled: boolean, profile?: string) => {
      const conn = getConnectionConfig();
      if (conn.mode === "ssh" && conn.ssh)
        return sshSetToolsetEnabled(conn.ssh, key, enabled, profile);
      return setToolsetEnabled(key, enabled, profile);
    },
  );

  // Skills. Remote (HTTP) mode routes to the dashboard's /api/skills* —
  // falling through to the local CLI there showed (and mutated) the LOCAL
  // machine's skills while connected to a remote (#578's report). Bundled
  // skills stay local in remote mode: that list is the shipped catalog, not
  // per-machine state.
  ipcMain.handle("list-installed-skills", (_event, profile?: string) => {
    const conn = getConnectionConfig();
    if (conn.mode === "ssh" && conn.ssh)
      return sshListInstalledSkills(conn.ssh, profile);
    if (conn.mode === "remote")
      return remoteListInstalledSkills(activeSshProfile(profile));
    return listInstalledSkills(profile);
  });
  ipcMain.handle("list-bundled-skills", () => {
    const conn = getConnectionConfig();
    if (conn.mode === "ssh" && conn.ssh) return sshListBundledSkills(conn.ssh);
    return listBundledSkills();
  });
  ipcMain.handle("get-skill-content", (_event, skillPath: string) => {
    const conn = getConnectionConfig();
    if (conn.mode === "ssh" && conn.ssh)
      return sshGetSkillContent(conn.ssh, skillPath);
    if (conn.mode === "remote")
      return remoteGetSkillContent(skillPath, activeSshProfile());
    return getSkillContent(skillPath);
  });
  ipcMain.handle(
    "install-skill",
    (_event, identifier: string, _profile?: string) => {
      const conn = getConnectionConfig();
      if (conn.mode === "ssh" && conn.ssh)
        return sshInstallSkill(conn.ssh, identifier);
      if (conn.mode === "remote")
        return remoteInstallSkill(identifier, activeSshProfile(_profile));
      return installSkill(identifier, _profile);
    },
  );
  ipcMain.handle(
    "uninstall-skill",
    (_event, name: string, _profile?: string) => {
      const conn = getConnectionConfig();
      if (conn.mode === "ssh" && conn.ssh)
        return sshUninstallSkill(conn.ssh, name);
      if (conn.mode === "remote")
        return remoteUninstallSkill(name, activeSshProfile(_profile));
      return uninstallSkill(name, _profile);
    },
  );

  // Session cache (fast local cache with generated titles)
  ipcMain.handle(
    "list-cached-sessions",
    (_event, limit?: number, offset?: number) => {
      const conn = getConnectionConfig();
      if (conn.mode === "remote")
        return remoteListCachedSessions(conn, limit, offset);
      if (conn.mode === "ssh" && conn.ssh)
        return withSshDashboardSessions(
          conn,
          (config) => remoteListCachedSessions(config, limit, offset),
          () => sshListCachedSessions(conn.ssh, limit, offset),
          activeSshProfile(),
        );
      return listCachedSessions(limit, offset);
    },
  );
  ipcMain.handle("sync-session-cache", () => {
    const conn = getConnectionConfig();
    if (conn.mode === "remote") return remoteListCachedSessions(conn, 50);
    if (conn.mode === "ssh" && conn.ssh)
      return withSshDashboardSessions(
        conn,
        (config) => remoteListCachedSessions(config, 50),
        () => sshListCachedSessions(conn.ssh, 50),
        activeSshProfile(),
      );
    try {
      return syncSessionCache();
    } catch (error) {
      console.error("sync-session-cache failed; using local cache", error);
      return listCachedSessions(50);
    }
  });
  ipcMain.handle(
    "update-session-title",
    (_event, sessionId: string, title: string) => {
      const conn = getConnectionConfig();
      if (conn.mode === "remote")
        return remoteUpdateSessionTitle(conn, sessionId, title);
      if (conn.mode === "ssh" && conn.ssh)
        return withSshDashboardSessions(
          conn,
          (config) => remoteUpdateSessionTitle(config, sessionId, title),
          undefined,
          activeSshProfile(),
        );
      return updateSessionTitle(sessionId, title);
    },
  );

  // Session search
  ipcMain.handle("search-sessions", (_event, query: string, limit?: number) => {
    const conn = getConnectionConfig();
    if (conn.mode === "remote") return remoteSearchSessions(conn, query, limit);
    if (conn.mode === "ssh" && conn.ssh)
      return withSshDashboardSessions(
        conn,
        (config) => remoteSearchSessions(config, query, limit),
        () => sshSearchSessions(conn.ssh, query, limit),
        activeSshProfile(),
      );
    return searchSessions(query, limit);
  });

  // Credential Pool — profile-aware. When `profile` is omitted, the
  // credential pool helpers default to the currently active profile's
  // auth.json (see config.ts:authFilePath), so the renderer can pass an
  // explicit profile or rely on the active-profile fallback.
  ipcMain.handle("get-credential-pool", (_event, profile?: string) =>
    getCredentialPool(profile),
  );
  ipcMain.handle(
    "set-credential-pool",
    (
      _event,
      provider: string,
      entries: Array<Record<string, unknown>>,
      profile?: string,
    ) => {
      setCredentialPool(provider, entries, profile);
      return true;
    },
  );

  // Append a user-typed key as a properly-shaped credential pool
  // entry. Constructs the full upstream schema (id, label, auth_type,
  // priority, source, access_token, base_url, request_count) so the
  // engine's resolver can read it — issue #367 Bug 3.
  ipcMain.handle(
    "add-credential-pool-entry",
    (
      _event,
      provider: string,
      apiKey: string,
      label: string,
      profile?: string,
    ) => {
      return addCredentialPoolEntry(provider, apiKey, label, profile);
    },
  );

  // Models
  ipcMain.handle("list-models", () => {
    const conn = getConnectionConfig();
    if (conn.mode === "remote") {
      if (conn.remoteChatTransport === "legacy") {
        throw new Error(
          "Remote model library reads require dashboard transport.",
        );
      }
      return remoteListModels(conn);
    }
    if (conn.mode === "ssh" && conn.ssh) {
      if (conn.sshChatTransport === "legacy") {
        return sshListModels(conn.ssh);
      }
      return withSshDashboardModelLibrary(
        conn,
        (config) => remoteListModels(config),
        () => sshListModels(conn.ssh!),
        getActiveProfileNameSync(),
      );
    }
    return listModels();
  });
  ipcMain.handle(
    "add-model",
    async (
      _event,
      name: string,
      provider: string,
      model: string,
      baseUrl: string,
      contextLength?: number,
      providerLabel?: string,
      apiMode?: string | null,
    ) => {
      const conn = getConnectionConfig();
      let addedModel: Awaited<ReturnType<typeof addModel>>;
      if (conn.mode === "remote") {
        if (conn.remoteChatTransport === "legacy") {
          throw new Error(
            "Remote model library writes require dashboard transport.",
          );
        }
        // Remote/SSH library writes don't carry the context-length override
        // yet (local-mode feature for now); the local branch persists it.
        addedModel = await remoteAddModel(conn, name, provider, model, baseUrl);
      } else if (conn.mode === "ssh" && conn.ssh) {
        addedModel = await withSshDashboardModelLibrary(
          conn,
          (config) => remoteAddModel(config, name, provider, model, baseUrl),
          () => sshAddModel(conn.ssh!, name, provider, model, baseUrl),
          getActiveProfileNameSync(),
        );
      } else {
        addedModel = addModel(
          name,
          provider,
          model,
          baseUrl,
          contextLength,
          providerLabel,
          apiMode,
        );
      }
      notifyModelLibraryChanged();
      return addedModel;
    },
  );
  ipcMain.handle("remove-model", async (_event, id: string) => {
    const conn = getConnectionConfig();
    let removed: boolean;
    if (conn.mode === "remote") {
      if (conn.remoteChatTransport === "legacy") {
        throw new Error(
          "Remote model library writes require dashboard transport.",
        );
      }
      removed = await remoteRemoveModel(conn, id);
    } else if (conn.mode === "ssh" && conn.ssh) {
      removed = await withSshDashboardModelLibrary(
        conn,
        (config) => remoteRemoveModel(config, id),
        () => sshRemoveModel(conn.ssh!, id),
        getActiveProfileNameSync(),
      );
    } else {
      removed = removeModel(id);
    }
    if (removed) notifyModelLibraryChanged();
    return removed;
  });
  ipcMain.handle(
    "update-model",
    async (
      _event,
      id: string,
      fields: Record<string, string>,
      // Context-length override travels as a separate arg (it's numeric, so it
      // can't ride inside the string-only `fields`). Local-mode only for now.
      contextLength?: number | null,
    ) => {
      const conn = getConnectionConfig();
      let updated: boolean;
      if (conn.mode === "remote") {
        if (conn.remoteChatTransport === "legacy") {
          throw new Error(
            "Remote model library writes require dashboard transport.",
          );
        }
        updated = await remoteUpdateModel(conn, id, fields);
      } else if (conn.mode === "ssh" && conn.ssh) {
        updated = await withSshDashboardModelLibrary(
          conn,
          (config) => remoteUpdateModel(config, id, fields),
          () => sshUpdateModel(conn.ssh!, id, fields),
          getActiveProfileNameSync(),
        );
      } else {
        updated = updateModel(
          id,
          contextLength === undefined ? fields : { ...fields, contextLength },
        );
      }
      if (updated) notifyModelLibraryChanged();
      return updated;
    },
  );

  // Shared model definitions — per-model-id metadata (display name, context
  // window, capabilities) reused across every provider that serves the model.
  // Local-only, mirroring the existing scoping of the context-length override
  // (the remote/SSH library paths never carried it); remote/ssh sessions get
  // inert no-op results rather than an error.
  ipcMain.handle("list-model-definitions", () => {
    const conn = getConnectionConfig();
    if (conn.mode === "remote" || conn.mode === "ssh") return [];
    return listModelDefinitions();
  });
  ipcMain.handle("get-model-definition", (_event, model: string) => {
    const conn = getConnectionConfig();
    if (conn.mode === "remote" || conn.mode === "ssh") return null;
    return getModelDefinition(model);
  });
  ipcMain.handle(
    "set-model-definition",
    (
      _event,
      model: string,
      patch: {
        name?: string;
        contextLength?: number | null;
        capabilities?: string[];
        modalities?: { input?: string[]; output?: string[] };
      },
    ) => {
      const conn = getConnectionConfig();
      if (conn.mode === "remote" || conn.mode === "ssh") return null;
      const def = setModelDefinition(model, patch);
      // The gauge/picker read the merged model shape, so a definition change is
      // a library change from the renderer's perspective.
      notifyModelLibraryChanged();
      return def;
    },
  );
  ipcMain.handle("remove-model-definition", (_event, model: string) => {
    const conn = getConnectionConfig();
    if (conn.mode === "remote" || conn.mode === "ssh") return false;
    const removed = removeModelDefinition(model);
    if (removed) notifyModelLibraryChanged();
    return removed;
  });

  // Claw3D
  ipcMain.handle("claw3d-status", () => getClaw3dStatus());

  ipcMain.handle("claw3d-setup", async (event) => {
    try {
      await setupClaw3d((progress: Claw3dSetupProgress) => {
        event.sender.send("claw3d-setup-progress", progress);
      });
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("claw3d-get-port", () => getClaw3dPort());
  ipcMain.handle("claw3d-set-port", (_event, port: number) => {
    setClaw3dPort(port);
    return true;
  });
  ipcMain.handle("claw3d-get-ws-url", () => getClaw3dWsUrl());
  ipcMain.handle("claw3d-set-ws-url", (_event, url: string) => {
    setClaw3dWsUrl(url);
    return true;
  });

  ipcMain.handle("claw3d-start-all", (_event, profile?: string) =>
    startOfficeStack(profile, {
      getConnectionConfig,
      isGatewayRunning,
      startGateway,
      sshGatewayStatus,
      sshStartGateway,
      startSshTunnel,
      stopSshTunnel,
      sshReadRemoteApiKey,
      setSshRemoteApiKey,
      startClaw3dAll,
      stopClaw3dAll: stopClaw3d,
      waitForClaw3dReady,
    }),
  );
  ipcMain.handle("claw3d-stop-all", () => {
    stopClaw3d();
    return true;
  });
  ipcMain.handle("claw3d-get-logs", () => getClaw3dLogs());

  ipcMain.handle("claw3d-start-dev", () => startDevServer());
  ipcMain.handle("claw3d-stop-dev", () => {
    stopDevServer();
    return true;
  });
  ipcMain.handle("claw3d-start-adapter", () => startAdapter());
  ipcMain.handle("claw3d-stop-adapter", () => {
    stopAdapter();
    return true;
  });

  // Cron Jobs
  ipcMain.handle(
    "list-cron-jobs",
    (_event, includeDisabled?: boolean, profile?: string) =>
      listCronJobs(includeDisabled, profile),
  );
  ipcMain.handle(
    "create-cron-job",
    (
      _event,
      schedule: string,
      prompt?: string,
      name?: string,
      deliver?: string,
      profile?: string,
    ) => createCronJob(schedule, prompt, name, deliver, profile),
  );
  ipcMain.handle("remove-cron-job", (_event, jobId: string, profile?: string) =>
    removeCronJob(jobId, profile),
  );
  ipcMain.handle("pause-cron-job", (_event, jobId: string, profile?: string) =>
    pauseCronJob(jobId, profile),
  );
  ipcMain.handle("resume-cron-job", (_event, jobId: string, profile?: string) =>
    resumeCronJob(jobId, profile),
  );
  ipcMain.handle(
    "trigger-cron-job",
    (_event, jobId: string, profile?: string) => triggerCronJob(jobId, profile),
  );

  // Kanban
  ipcMain.handle(
    "kanban-list-boards",
    (_event, includeArchived?: boolean, profile?: string) =>
      kanbanListBoards(includeArchived, profile),
  );
  ipcMain.handle("kanban-current-board", (_event, profile?: string) =>
    kanbanCurrentBoard(profile),
  );
  ipcMain.handle(
    "kanban-switch-board",
    (_event, slug: string, profile?: string) =>
      kanbanSwitchBoard(slug, profile),
  );
  ipcMain.handle(
    "kanban-create-board",
    (
      _event,
      slug: string,
      name?: string,
      switchAfter?: boolean,
      profile?: string,
    ) => kanbanCreateBoard(slug, name, switchAfter, profile),
  );
  ipcMain.handle(
    "kanban-remove-board",
    (_event, slug: string, hardDelete?: boolean, profile?: string) =>
      kanbanRemoveBoard(slug, hardDelete, profile),
  );
  ipcMain.handle(
    "kanban-list-tasks",
    (
      _event,
      filters?: {
        status?: string;
        assignee?: string;
        tenant?: string;
        includeArchived?: boolean;
        profile?: string;
      },
    ) => kanbanListTasks(filters || {}),
  );
  ipcMain.handle(
    "kanban-get-task",
    (_event, taskId: string, profile?: string) =>
      kanbanGetTask(taskId, profile),
  );
  ipcMain.handle(
    "kanban-create-task",
    (_event, input: CreateTaskInput, profile?: string) =>
      kanbanCreateTask(input, profile),
  );
  ipcMain.handle("select-folder", async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ["openDirectory"] })
      : await dialog.showOpenDialog({ properties: ["openDirectory"] });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  // Read directory contents for worktree panel
  ipcMain.handle(
    "read-directory",
    async (
      _event,
      dirPath: string,
    ): Promise<{ name: string; isDirectory: boolean }[] | null> => {
      const conn = getConnectionConfig();
      if (conn.mode === "ssh" && conn.ssh) {
        return sshReadDirectory(conn.ssh, dirPath);
      }
      if (conn.mode === "remote") {
        return null;
      }
      try {
        const entries = await readdir(dirPath, { withFileTypes: true });
        return entries
          .map((entry) => ({
            name: entry.name,
            isDirectory: entry.isDirectory(),
          }))
          .sort(
            (a, b) =>
              Number(b.isDirectory) - Number(a.isDirectory) ||
              a.name.localeCompare(b.name),
          );
      } catch {
        return null;
      }
    },
  );

  // Read file contents for file viewer
  ipcMain.handle(
    "read-file",
    async (
      _event,
      filePath: string,
      maxBytes?: number,
    ): Promise<{ content: string; truncated: boolean } | null> => {
      try {
        const limit = maxBytes ?? 102400; // Default 100KB
        const buffer = await readFile(filePath);
        const truncated = buffer.byteLength > limit;
        const content = truncated
          ? buffer.subarray(0, limit).toString("utf-8")
          : buffer.toString("utf-8");
        return { content, truncated };
      } catch {
        return null;
      }
    },
  );

  // Open file in default application
  ipcMain.handle("open-file-in-editor", async (_event, filePath: string) => {
    try {
      await shell.openPath(filePath);
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.handle("open-terminal", async (_event, dirPath: string) => {
    if (isRemoteOnlyMode()) return false;
    if (typeof dirPath !== "string" || dirPath.trim().length === 0)
      return false;
    try {
      const info = await stat(dirPath);
      if (!info.isDirectory()) return false;
      return await openTerminalInDirectory(dirPath);
    } catch {
      return false;
    }
  });

  // Read image file as data URL for preview
  ipcMain.handle(
    "read-image-file",
    async (_event, filePath: string): Promise<string | null> => {
      try {
        const buffer = await readFile(filePath);
        const ext = extname(filePath).toLowerCase().slice(1);
        const mimeType =
          ext === "png"
            ? "image/png"
            : ext === "jpg" || ext === "jpeg"
              ? "image/jpeg"
              : ext === "gif"
                ? "image/gif"
                : ext === "webp"
                  ? "image/webp"
                  : ext === "svg"
                    ? "image/svg+xml"
                    : ext === "bmp"
                      ? "image/bmp"
                      : ext === "ico"
                        ? "image/x-icon"
                        : "application/octet-stream";
        const base64 = buffer.toString("base64");
        return `data:${mimeType};base64,${base64}`;
      } catch {
        return null;
      }
    },
  );
  ipcMain.handle(
    "kanban-assign-task",
    (_event, taskId: string, assignee: string | null, profile?: string) =>
      kanbanAssignTask(taskId, assignee, profile),
  );
  ipcMain.handle(
    "kanban-complete-task",
    (_event, taskId: string, result?: string, profile?: string) =>
      kanbanCompleteTask(taskId, result, profile),
  );
  ipcMain.handle(
    "kanban-block-task",
    (_event, taskId: string, reason?: string, profile?: string) =>
      kanbanBlockTask(taskId, reason, profile),
  );
  ipcMain.handle(
    "kanban-unblock-task",
    (_event, taskId: string, profile?: string) =>
      kanbanUnblockTask(taskId, profile),
  );
  ipcMain.handle(
    "kanban-archive-task",
    (_event, taskId: string, profile?: string) =>
      kanbanArchiveTask(taskId, profile),
  );
  ipcMain.handle(
    "kanban-promote-task",
    (_event, taskId: string, profile?: string) =>
      kanbanPromoteTask(taskId, profile),
  );
  ipcMain.handle(
    "kanban-schedule-task",
    (_event, taskId: string, reason?: string, profile?: string) =>
      kanbanScheduleTask(taskId, reason, profile),
  );
  ipcMain.handle(
    "kanban-specify-task",
    (_event, taskId: string, profile?: string) =>
      kanbanSpecifyTask(taskId, profile),
  );
  ipcMain.handle(
    "kanban-reclaim-task",
    (_event, taskId: string, reason?: string, profile?: string) =>
      kanbanReclaimTask(taskId, reason, profile),
  );
  ipcMain.handle(
    "kanban-comment-task",
    (_event, taskId: string, body: string, profile?: string) =>
      kanbanCommentTask(taskId, body, profile),
  );
  ipcMain.handle(
    "kanban-dispatch-once",
    (_event, dryRun?: boolean, profile?: string) =>
      kanbanDispatchOnce(dryRun, profile),
  );
  ipcMain.handle("kanban-list-claw3d-hq-tasks", () =>
    kanbanListClaw3dHqTasks(),
  );

  // Shell
  ipcMain.handle("open-external", (_event, url: string) => {
    openExternalUrl(url);
  });

  // Backup / Import
  ipcMain.handle("run-hermes-backup", (_event, profile?: string) =>
    runHermesBackup(profile),
  );
  ipcMain.handle(
    "run-hermes-import",
    (_event, archivePath: string, profile?: string) =>
      runHermesImport(archivePath, profile),
  );

  // Debug dump
  ipcMain.handle("run-hermes-dump", () => {
    const conn = getConnectionConfig();
    if (conn.mode === "ssh" && conn.ssh) return sshRunDump(conn.ssh);
    return runHermesDump();
  });

  // MCP servers
  ipcMain.handle("list-mcp-servers", (_event, profile?: string) =>
    listMcpServers(profile),
  );
  ipcMain.handle(
    "add-mcp-server",
    (_event, input: McpServerInput, profile?: string) =>
      addMcpServer(input, profile),
  );
  ipcMain.handle(
    "remove-mcp-server",
    (_event, name: string, profile?: string) => removeMcpServer(name, profile),
  );
  ipcMain.handle(
    "set-mcp-server-enabled",
    (_event, name: string, enabled: boolean, profile?: string) =>
      setMcpServerEnabled(name, enabled, profile),
  );
  ipcMain.handle("test-mcp-server", (_event, name: string, profile?: string) =>
    testMcpServer(name, profile),
  );
  ipcMain.handle("list-mcp-catalog", (_event, profile?: string) =>
    listMcpCatalog(profile),
  );
  ipcMain.handle(
    "install-mcp-catalog-entry",
    (_event, name: string, env?: Record<string, string>, profile?: string) =>
      installMcpCatalogEntry(name, env, profile),
  );

  // Discover marketplace (community registry)
  ipcMain.handle("registry-fetch", (_event, force?: boolean) =>
    fetchRegistry(!!force),
  );
  ipcMain.handle("registry-fetch-models", (_event, force?: boolean) =>
    fetchModelRegistry(!!force),
  );
  ipcMain.handle("registry-list-installed", (_event, profile?: string) =>
    listInstalledRegistry(profile),
  );
  ipcMain.handle(
    "registry-detail",
    (_event, kind: RegistryKind, item: RegistryItem) =>
      fetchRegistryDetail(kind, item),
  );
  ipcMain.handle(
    "registry-install",
    (_event, kind: RegistryKind, item: RegistryItem, profile?: string) =>
      installRegistryItem(kind, item, profile),
  );

  // Memory providers
  ipcMain.handle("discover-memory-providers", (_event, profile?: string) => {
    const conn = getConnectionConfig();
    if (conn.mode === "ssh" && conn.ssh)
      return sshDiscoverMemoryProviders(conn.ssh, profile);
    return discoverMemoryProviders(profile);
  });

  // Log viewer
  ipcMain.handle("read-logs", (_event, logFile?: string, lines?: number) => {
    const conn = getConnectionConfig();
    if (conn.mode === "ssh" && conn.ssh)
      return sshReadLogs(conn.ssh, logFile, lines);
    return readLogs(logFile, lines);
  });
}
