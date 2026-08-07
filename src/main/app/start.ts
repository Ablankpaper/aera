import {
  app,
  BrowserWindow,
  clipboard,
  net,
  safeStorage,
  session,
  shell,
} from "electron";
import { basename, join } from "path";
import { hostname } from "node:os";
import { electronApp, optimizer, is } from "@electron-toolkit/utils";
import icon from "../../../resources/icon.png?asset";
import {
  getConnectionConfig,
  getModelConfig,
  getPublicConnectionConfig,
} from "../config";
import {
  configureGatewayProcessOwnership,
  recoverAeraOwnedGatewaysFromPreviousRun,
  stopAeraOwnedGateways,
  stopAllTuiGatewayClients,
  stopHealthPolling,
} from "../hermes";
import { stopAllDashboards } from "../dashboard";
import { cleanupTempMediaFiles } from "../media";
import { closeDbConnection } from "../db";
import { stopSshTunnel } from "../ssh-tunnel";
import {
  hardenAttachedWebContents,
  hardenWebviewPreferences,
  isAllowedAppNavigationUrl,
  isAllowedAgenteraAuthExternalUrl,
  isAllowedExternalUrl,
  isAllowedWebviewUrl,
} from "../security";
import { registerIpcHandlers } from "../ipc/register";
import { setGatewayPromptParent } from "../gatewayPrompt";
import { showChatContextMenu } from "./context-menu";
import { buildMenu } from "./menu";
import { setupUpdater } from "./updater";
import { createQuitBarrier } from "./quit-barrier";
import { DESKTOP_APP_ID, DESKTOP_PRODUCT_NAME } from "../../shared/branding";
import { getAgenteraCloudOrigin } from "../agentera-auth/config";
import { AgenteraCloudClient } from "../agentera-auth/client";
import { createAgenteraAuthController } from "../agentera-auth/controller";
import { createAgenteraAuthStoreForApp } from "../agentera-auth/store";
import {
  hasAgenteraGuestAccess,
  hasAgenteraSignedInAccess,
} from "../../shared/agentera-auth";
import { AgenteraUserProfileStore } from "../agentera-user-profile-store";
import {
  AgenteraProfileBindingStore,
  createAgenteraGuestRuntimeOwner,
  type AgenteraRuntimeOwner,
} from "../agentera-profile-binding";
import {
  AgenteraConnectionOwnerStore,
  createAgenteraOwnerSwitchCoordinator,
} from "../agentera-connection-owner";
import { createProductAccessGuard } from "../ipc/auth-guard";
import { getActiveProfileNameSync, profileHome } from "../utils";
import { createRuntimeBootstrapOptions } from "../agentera-runtime-distribution/bootstrap";
import {
  FetchRuntimeDownloadTransport,
  downloadWithResume,
} from "../agentera-runtime-distribution/downloader";
import {
  FetchRuntimeMetadataTransport,
  checkStableRuntimeUpdate,
} from "../agentera-runtime-distribution/update-client";
import type { RuntimeFetch } from "../agentera-runtime-distribution/fetch";
import { createElectronRuntimeDownloadUrlResolver } from "../agentera-runtime-distribution/electron-transport";
import {
  createRuntimeDistributionManager,
  type RuntimeDistributionManager,
} from "../agentera-runtime-distribution/manager";
import {
  activateManagedRuntimeMode,
  isExternalRuntimeSelected,
  runPackagedSeedInstall,
} from "../installer";
import { RuntimeActivityCoordinator } from "../runtime-activity";
import { getRuntimeInvocation } from "../agentera-runtime-distribution/invocation";
import {
  openAgenteraControlPlaneDatabase,
  type AgenteraControlPlaneDatabase,
} from "../agentera-agent-control/db";
import { AgenteraAgentControlClient } from "../agentera-agent-control/client";
import { AgenteraAgentControlManager } from "../agentera-agent-control/manager";
import { resolveOfficialAgentChannel } from "../agentera-agent-control/official-channel";
import {
  openAgenteraWorkspaceDatabase,
  type AgenteraWorkspaceDatabase,
} from "../agentera-workspace/db";
import { AgenteraWorkspaceClient } from "../agentera-workspace/client";
import { AgenteraWorkspaceManager } from "../agentera-workspace/manager";
import { WorkspaceInvitationInbox } from "../agentera-workspace/deep-link";
import {
  openAgenteraOrganizationDatabase,
  type AgenteraOrganizationDatabase,
} from "../agentera-organization/db";
import { AgenteraOrganizationClient } from "../agentera-organization/client";
import { AgenteraOrganizationPolicyVerifier } from "../agentera-organization/policy-verifier";
import { AgenteraOrganizationManager } from "../agentera-organization/manager";
import {
  openAgenteraProductSpaceDatabase,
  type AgenteraProductSpaceDatabase,
} from "../agentera-product-space/db";
import { AgenteraProductSpaceManager } from "../agentera-product-space/manager";
import {
  createProfile,
  deleteProfile,
  profileIdForAgentName,
  setActiveProfile,
} from "../profiles";
import { seedAgentModelProfile } from "../agentera-agent-control/model-profile-seed";
import { AgentIdentityService } from "../agent-identity";
import { AgentUserMemoryRepairService } from "../agent-user-memory-repair";
import { AgenteraGlobalProfileManager } from "../agentera-global-profile/manager";
import { AgenteraMemoryCandidateManager } from "../agentera-global-profile/candidate-manager";
import { AgenteraMemoryCandidateConfirmationCoordinator } from "../agentera-global-profile/candidate-confirmation";
import {
  openAgenteraOfficialQualityDatabase,
  type AgenteraOfficialQualityDatabase,
} from "../agentera-official-quality/db";
import { AgenteraOfficialQualityClient } from "../agentera-official-quality/client";
import {
  OfficialQualityCollector,
  createOfficialQualityBindingResolver,
  type OfficialQualityPrincipal,
  type OfficialQualitySigningPrincipal,
} from "../agentera-official-quality/collector";
import { AgenteraOfficialQualityManager } from "../agentera-official-quality/manager";
import {
  getOrCreateAgenteraDeviceIdentity,
  signAgenteraDeviceDigest,
} from "../agentera-auth/device-key";
import { AgenteraEncryptedBackupClient } from "../agentera-encrypted-backup/client";
import { AgenteraEncryptedBackupController } from "../agentera-encrypted-backup/controller";

const APP_NAME =
  process.env.HERMES_DESKTOP_APP_NAME?.trim() || DESKTOP_PRODUCT_NAME;
const OPEN_DEVTOOLS_ON_START =
  process.env.HERMES_OPEN_DEVTOOLS === "1" ||
  process.env.HERMES_DESKTOP_OPEN_DEVTOOLS === "1";

let mainWindow: BrowserWindow | null = null;
const runtimeActivity = new RuntimeActivityCoordinator();

export interface StartMainProcessOptions {
  workspaceInvitationInbox?: WorkspaceInvitationInbox;
}

export function startMainProcess(options: StartMainProcessOptions = {}): void {
  const workspaceInvitationInbox =
    options.workspaceInvitationInbox ?? new WorkspaceInvitationInbox();
  configureGatewayProcessOwnership(app.getPath("userData"));
  const gatewayRecovery = recoverAeraOwnedGatewaysFromPreviousRun();
  if (gatewayRecovery.errorCode) {
    console.warn(
      `[gateway-ownership] Recovery degraded: ${gatewayRecovery.errorCode}.`,
    );
  }
  if (gatewayRecovery.ambiguousProfiles.length > 0) {
    console.warn(
      `[gateway-ownership] ${gatewayRecovery.ambiguousProfiles.length} prior launch record(s) remain ambiguous.`,
    );
  }
  process.on("uncaughtException", (err) => {
    console.error("[MAIN UNCAUGHT]", err);
  });

  process.on("unhandledRejection", (reason) => {
    console.error("[MAIN UNHANDLED REJECTION]", reason);
  });

  const agenteraAuthStore = createAgenteraAuthStoreForApp(app, safeStorage);
  const agenteraUserProfiles = new AgenteraUserProfileStore({
    userDataPath: app.getPath("userData"),
  });
  const agentIdentity = new AgentIdentityService({
    resolveProfilePath: (profileId) => profileHome(profileId),
  });
  const agentUserMemoryRepair = new AgentUserMemoryRepairService({
    resolveProfilePath: (profileId) => profileHome(profileId),
  });
  const agenteraGlobalProfiles = new AgenteraGlobalProfileManager({
    userDataPath: app.getPath("userData"),
  });
  const agenteraMemoryCandidates = new AgenteraMemoryCandidateManager({
    userDataPath: app.getPath("userData"),
  });
  const agenteraMemoryCandidateConfirmation =
    new AgenteraMemoryCandidateConfirmationCoordinator({
      candidates: agenteraMemoryCandidates,
      identities: agentIdentity,
      globalProfiles: agenteraGlobalProfiles,
    });
  const agenteraProfileBindings = new AgenteraProfileBindingStore({
    userDataPath: app.getPath("userData"),
    secureStorage: safeStorage,
  });
  const agenteraConnectionOwners = new AgenteraConnectionOwnerStore({
    userDataPath: app.getPath("userData"),
    secureStorage: safeStorage,
  });
  const agenteraAuth = createAgenteraAuthController({
    store: agenteraAuthStore,
    getCloudClient: () =>
      new AgenteraCloudClient({ origin: getAgenteraCloudOrigin() }),
    openExternal: openAgenteraAuthUrl,
    writeClipboard: (text) => clipboard.writeText(text),
    openTrustedExternal: openExternalUrl,
    bringMainWindowToFront: () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    },
    getDeviceMetadata: () => ({
      deviceName: (hostname().trim() || "Aera device").slice(0, 100),
      platform:
        process.platform === "win32"
          ? "windows"
          : process.platform === "darwin"
            ? "darwin"
            : "linux",
      appVersion: (app.getVersion().trim() || "unknown").slice(0, 64),
    }),
  });
  const getAgenteraRuntimeOwner = (): AgenteraRuntimeOwner => {
    const state = agenteraAuth.getPublicState();
    if (!hasAgenteraSignedInAccess(state) && !hasAgenteraGuestAccess(state)) {
      throw new Error("Aera product sign-in is required.");
    }
    const installation =
      agenteraAuthStore.getInstallation() ??
      (hasAgenteraGuestAccess(state)
        ? getOrCreateAgenteraDeviceIdentity(agenteraAuthStore)
        : null);
    if (!installation) {
      throw new Error("Aera installation identity is unavailable.");
    }
    if (hasAgenteraGuestAccess(state)) {
      return createAgenteraGuestRuntimeOwner(installation.installationId);
    }
    return {
      tenantId: state.personalSpaceId,
      ownerId: state.userId,
      deviceInstallationId: installation.installationId,
    };
  };
  const productAccessGuard = createProductAccessGuard({
    getAuthState: () => agenteraAuth.getPublicState(),
    assertCurrentEntitlement: () => agenteraAuth.assertCanStartNewTask(),
    isRuntimeContextBound: () => {
      try {
        const owner = getAgenteraRuntimeOwner();
        const connection = getConnectionConfig();
        if (connection.mode === "local") {
          agenteraProfileBindings.verifyProfileBinding(
            profileHome(getActiveProfileNameSync()),
            owner,
          );
        } else {
          agenteraConnectionOwners.verifyConnectionContext(
            connection.connectionContextId,
            owner,
          );
        }
        return true;
      } catch {
        return false;
      }
    },
  });
  let runtimeDistribution: RuntimeDistributionManager | null = null;
  try {
    const runtimeOptions = createRuntimeBootstrapOptions({
      userDataPath: app.getPath("userData"),
      resourcesPath: process.resourcesPath,
      workingDirectory: process.cwd(),
      isPackaged: app.isPackaged,
      developmentSeedDirectory: process.env.AGENTERA_RUNTIME_SEED_DIR,
      desktopVersion: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
    });
    const runtimeFetch: RuntimeFetch = (url, init) =>
      net.fetch(url, {
        ...init,
        bypassCustomProtocolHandlers: true,
      });
    const runtimeMetadataTransport = new FetchRuntimeMetadataTransport(
      runtimeFetch,
    );
    let runtimeUpdateFirstPartyBaseUrl: URL | undefined;
    try {
      runtimeUpdateFirstPartyBaseUrl = new URL(
        "/runtime-updates/stable/",
        getAgenteraCloudOrigin(),
      );
    } catch {
      // Development without a configured Cloud origin retains GitHub-only checks.
    }
    const runtimeDownloadTransport = new FetchRuntimeDownloadTransport(
      runtimeFetch,
      createElectronRuntimeDownloadUrlResolver((requestOptions) =>
        net.request(requestOptions),
      ),
    );
    runtimeDistribution = createRuntimeDistributionManager({
      ...runtimeOptions,
      checkUpdate: (context) =>
        checkStableRuntimeUpdate({
          ...context,
          transport: runtimeMetadataTransport,
          firstPartyBaseUrl: runtimeUpdateFirstPartyBaseUrl,
          onDiagnostic: ({ source, stage, code }) => {
            console.warn(
              `[AGENTERA_RUNTIME_UPDATE] source=${source} stage=${stage} code=${code}`,
            );
          },
        }),
      download: (request) =>
        downloadWithResume({
          ...request,
          transport: runtimeDownloadTransport,
        }),
      activeRunCount: () => runtimeActivity.activeRunCount,
      beginRuntimeTransition: () => runtimeActivity.beginTransition(),
      cancelRuntimeTransition: () => runtimeActivity.cancelTransition(),
      isExternalRuntime: isExternalRuntimeSelected,
      stopRuntimeContext: stopActiveRuntimeContext,
      relaunch: () => {
        app.relaunch();
        app.exit(0);
      },
      repair: async () => {
        const existingManaged = activateManagedRuntimeMode();
        if (existingManaged !== null) {
          return {
            success: true,
            runtimeVersion: existingManaged.version,
            errorCode: null,
          };
        }
        const result = await runPackagedSeedInstall((progress) => {
          if (!mainWindow || mainWindow.isDestroyed()) return;
          mainWindow.webContents.send("install-progress", progress);
        });
        return {
          success: result.status === "installed",
          runtimeVersion: result.runtimeVersion,
          errorCode:
            result.status === "installed" ? null : "runtime_install_failed",
        };
      },
    });
    void runtimeDistribution.initialize().catch(() => {
      console.error("[AGENTERA_RUNTIME_MANAGER] initialization failed");
    });
  } catch {
    console.error("[AGENTERA_RUNTIME_MANAGER] unavailable");
  }
  let agenteraWorkspaceDatabase: AgenteraWorkspaceDatabase | null = null;
  let agenteraWorkspace: AgenteraWorkspaceManager | null = null;
  let agenteraOrganizationDatabase: AgenteraOrganizationDatabase | null = null;
  let agenteraOrganization: AgenteraOrganizationManager | null = null;
  let agenteraProductSpaceDatabase: AgenteraProductSpaceDatabase | null = null;
  let agenteraProductSpace: AgenteraProductSpaceManager | null = null;
  let agenteraAgentControlDatabase: AgenteraControlPlaneDatabase | null = null;
  let agenteraAgentControl: AgenteraAgentControlManager | null = null;
  let agenteraOfficialQualityDatabase: AgenteraOfficialQualityDatabase | null =
    null;
  let agenteraOfficialQuality: AgenteraOfficialQualityManager | null = null;
  let agenteraEncryptedBackup: AgenteraEncryptedBackupController | null = null;
  try {
    agenteraWorkspaceDatabase = openAgenteraWorkspaceDatabase(
      app.getPath("userData"),
    );
    const workspaceClient = new AgenteraWorkspaceClient({
      origin: getAgenteraCloudOrigin(),
      getAccessToken: () => agenteraAuth.getAccessTokenForCloudRequest(),
    });
    agenteraWorkspace = new AgenteraWorkspaceManager({
      database: agenteraWorkspaceDatabase,
      client: workspaceClient,
      getAuthState: () => agenteraAuth.getPublicState(),
    });
  } catch {
    agenteraWorkspaceDatabase?.close();
    agenteraWorkspaceDatabase = null;
    agenteraWorkspace = null;
    console.error("[AGENTERA_WORKSPACE] unavailable");
  }
  try {
    agenteraOrganizationDatabase = openAgenteraOrganizationDatabase(
      app.getPath("userData"),
    );
    const organizationClient = new AgenteraOrganizationClient({
      origin: getAgenteraCloudOrigin(),
      getAccessToken: () => agenteraAuth.getAccessTokenForCloudRequest(),
    });
    const organizationPolicyVerifier = new AgenteraOrganizationPolicyVerifier({
      origin: getAgenteraCloudOrigin(),
    });
    agenteraOrganization = new AgenteraOrganizationManager({
      database: agenteraOrganizationDatabase,
      client: organizationClient,
      policyVerifier: organizationPolicyVerifier,
      getAuthState: () => agenteraAuth.getPublicState(),
    });
  } catch {
    agenteraOrganizationDatabase?.close();
    agenteraOrganizationDatabase = null;
    agenteraOrganization = null;
    console.error("[AGENTERA_ORGANIZATION] unavailable");
  }
  if (agenteraWorkspace && agenteraOrganization) {
    try {
      agenteraProductSpaceDatabase = openAgenteraProductSpaceDatabase(
        app.getPath("userData"),
      );
      agenteraProductSpace = new AgenteraProductSpaceManager({
        database: agenteraProductSpaceDatabase,
        workspaceSource: agenteraWorkspace,
        organizationSource: agenteraOrganization,
        getLegacyWorkspaceSelection: (accountUserId) =>
          agenteraWorkspaceDatabase?.readSelectedWorkspace(accountUserId) ??
          null,
        getAuthState: () => agenteraAuth.getPublicState(),
      });
      agenteraWorkspace.attachProductSpaceCoordinator(agenteraProductSpace);
    } catch {
      agenteraProductSpace?.close();
      if (!agenteraProductSpace) agenteraProductSpaceDatabase?.close();
      agenteraProductSpaceDatabase = null;
      agenteraProductSpace = null;
      console.error("[AGENTERA_PRODUCT_SPACE] unavailable");
    }
  }
  try {
    agenteraAgentControlDatabase = openAgenteraControlPlaneDatabase(
      app.getPath("userData"),
    );
    const agentControlClient = new AgenteraAgentControlClient({
      origin: getAgenteraCloudOrigin(),
      getAccessToken: () => agenteraAuth.getAccessTokenForCloudRequest(),
      getInstallationIdentity: () => agenteraAuthStore.getInstallation(),
      officialAgentChannel: resolveOfficialAgentChannel({
        isPackaged: app.isPackaged,
        environment: process.env,
      }),
      desktopVersion: app.getVersion(),
      getAgentContext: () =>
        agenteraProductSpace?.getAgentContext() ?? { scope: "USER" },
    });
    agenteraAgentControl = new AgenteraAgentControlManager({
      database: agenteraAgentControlDatabase,
      client: agentControlClient,
      profileBindings: agenteraProfileBindings,
      profiles: {
        profileIdForAgentName,
        createProfile,
        deleteProfile,
        resolveProfilePath: (profileId) => profileHome(profileId),
        activateProfile: setActiveProfile,
        readProfileModelConfig: (profilePath) =>
          getModelConfig(
            profilePath === profileHome() ? "default" : basename(profilePath),
          ),
        configureFreshProfileModel: seedAgentModelProfile,
      },
      userDataPath: app.getPath("userData"),
      getOwner: getAgenteraRuntimeOwner,
      getAgentContext: () =>
        agenteraProductSpace?.getAgentContext() ?? { scope: "USER" },
      getAuthState: () => agenteraAuth.getPublicState(),
      getRuntimeVersion: async () => {
        const invocationVersion = getRuntimeInvocation()?.version;
        if (invocationVersion) return invocationVersion;
        const state = await runtimeDistribution?.getState();
        if (!state?.currentVersion) {
          throw new Error("Aera Runtime version is unavailable.");
        }
        return state.currentVersion;
      },
      getConnectionMode: () => getConnectionConfig().mode,
      assertEntitled: () => agenteraAuth.assertCanStartNewTask(),
    });
  } catch {
    agenteraAgentControlDatabase?.close();
    agenteraAgentControlDatabase = null;
    agenteraAgentControl = null;
    console.error("[AGENTERA_AGENT_CONTROL] unavailable");
  }
  const getOfficialQualitySigningPrincipal =
    (): OfficialQualitySigningPrincipal | null => {
      const state = agenteraAuth.getPublicState();
      const identity = agenteraAuthStore.getInstallation();
      if (
        (state.status !== "authenticated" && state.status !== "offline") ||
        identity === null
      ) {
        return null;
      }
      return {
        accountId: state.userId,
        deviceId: identity.installationId,
        devicePrivateKey: identity.devicePrivateKey,
      };
    };
  const getOfficialQualityPrincipal = (): OfficialQualityPrincipal | null => {
    const principal = getOfficialQualitySigningPrincipal();
    return principal === null
      ? null
      : { accountId: principal.accountId, deviceId: principal.deviceId };
  };
  if (agenteraAgentControlDatabase !== null) {
    try {
      agenteraOfficialQualityDatabase = openAgenteraOfficialQualityDatabase(
        app.getPath("userData"),
      );
      const qualityClient = new AgenteraOfficialQualityClient({
        origin: getAgenteraCloudOrigin(),
        getAccessToken: () => agenteraAuth.getAccessTokenForCloudRequest(),
      });
      const qualityCollector = new OfficialQualityCollector({
        database: agenteraOfficialQualityDatabase,
        desktopVersion: app.getVersion(),
        getPrincipal: getOfficialQualitySigningPrincipal,
        resolveBinding: createOfficialQualityBindingResolver(
          agenteraAgentControlDatabase,
        ),
      });
      agenteraOfficialQuality = new AgenteraOfficialQualityManager({
        database: agenteraOfficialQualityDatabase,
        client: qualityClient,
        collector: qualityCollector,
        getPrincipal: getOfficialQualityPrincipal,
      });
    } catch {
      agenteraOfficialQualityDatabase?.close();
      agenteraOfficialQualityDatabase = null;
      agenteraOfficialQuality = null;
      console.error("[AGENTERA_OFFICIAL_QUALITY] unavailable");
    }
  }
  if (agenteraAgentControl !== null) {
    try {
      const encryptedBackupClient = new AgenteraEncryptedBackupClient({
        origin: getAgenteraCloudOrigin(),
        getAccessToken: () => agenteraAuth.getAccessTokenForCloudRequest(),
      });
      agenteraEncryptedBackup = new AgenteraEncryptedBackupController({
        userDataPath: app.getPath("userData"),
        secureStorage: safeStorage,
        activity: runtimeActivity,
        client: encryptedBackupClient,
        agentControl: agenteraAgentControl,
        getPrincipal: () => {
          const state = agenteraAuth.getPublicState();
          const identity = agenteraAuthStore.getInstallation();
          if (
            (state.status !== "authenticated" && state.status !== "offline") ||
            identity === null
          ) {
            return null;
          }
          return {
            accountId: state.userId,
            deviceId: state.deviceId,
            online: state.status === "authenticated" && state.cloudAvailable,
            signDigest: (digest) =>
              signAgenteraDeviceDigest(identity.devicePrivateKey, digest),
          };
        },
      });
    } catch {
      agenteraEncryptedBackup?.close();
      agenteraEncryptedBackup = null;
      console.error("[AGENTERA_ENCRYPTED_BACKUP] unavailable");
    }
  }
  const unsubscribeProductSpace =
    agenteraProductSpace?.subscribe(() => {
      agenteraAgentControl?.notifyAgentContextChanged();
    }) ?? (() => undefined);
  const ownerSwitchCoordinator = createAgenteraOwnerSwitchCoordinator({
    stopRuntimeContext: stopActiveRuntimeContext,
  });
  let runtimeUpdateCheckedUserId: string | null = null;
  const unsubscribeAgenteraAuth = agenteraAuth.subscribe((state) => {
    agenteraAgentControl?.notifyAccessStateChanged();
    void agenteraWorkspace?.notifyAccessStateChanged();
    void agenteraOrganization?.notifyAccessStateChanged();
    void agenteraProductSpace?.notifyAccessStateChanged();
    const qualityPrincipal = getOfficialQualityPrincipal();
    agenteraOfficialQuality?.notifyPrincipalChanged(qualityPrincipal);
    agenteraEncryptedBackup?.notifyPrincipalChanged();
    if (state.status === "authenticated" && state.cloudAvailable) {
      void agenteraOfficialQuality?.uploadPending();
    }
    let runtimeOwnerId: string | null = null;
    if (hasAgenteraSignedInAccess(state)) {
      runtimeOwnerId = state.userId;
    } else if (hasAgenteraGuestAccess(state)) {
      try {
        runtimeOwnerId = getAgenteraRuntimeOwner().ownerId;
      } catch {
        // Secure-storage failure stays unmounted and is surfaced by AuthGate.
      }
    }
    ownerSwitchCoordinator.transitionTo(runtimeOwnerId);
    if (
      state.status === "authenticated" &&
      state.cloudAvailable &&
      runtimeDistribution !== null &&
      runtimeUpdateCheckedUserId !== state.userId
    ) {
      runtimeUpdateCheckedUserId = state.userId;
      void runtimeDistribution.check().catch(() => {
        console.error("[AGENTERA_RUNTIME_UPDATE_CHECK] unavailable");
      });
    } else if (state.status !== "authenticated" && state.status !== "offline") {
      runtimeUpdateCheckedUserId = null;
    }
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send("agentera-auth-state-changed", state);
  });

  registerIpcHandlers({
    runtimeActivity,
    getMainWindow: () => mainWindow,
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
  });

  setupUpdater({ getMainWindow: () => mainWindow });

  app.whenReady().then(() => {
    electronApp.setAppUserModelId(DESKTOP_APP_ID);

    app.on("browser-window-created", (_, window) => {
      optimizer.watchWindowShortcuts(window);
    });

    app.on("web-contents-created", (_event, contents) => {
      if (contents.getType() === "webview") {
        // The web preview webview is the only one allowed to load remote HTTPS.
        // Identify it reliably by its session: a <webview partition="web-preview">
        // shares the singleton in-memory session returned by fromPartition().
        // The partition session is the only dependable signal available in
        // web-contents-created — without it, post-attach redirects/navigations
        // (e.g. google.com -> www.google.com) are wrongly blocked.
        const isWebPreview =
          contents.session === session.fromPartition("web-preview");
        hardenAttachedWebContents(contents, isWebPreview);
      }
    });

    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          "Content-Security-Policy": [
            "default-src 'self'; " +
              "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; " +
              "style-src 'self' 'unsafe-inline'; " +
              "img-src 'self' data: blob: file: https:; " +
              "media-src 'self' data: blob: file: https:; " +
              "connect-src 'self' blob: http://127.0.0.1:* ws://127.0.0.1:* http://localhost:* ws://localhost:* https: wss:; " +
              "font-src 'self' data:; " +
              "frame-src 'self' https: http://127.0.0.1:* http://localhost:*; " +
              "object-src 'none'; " +
              "base-uri 'self';",
          ],
        },
      });
    });

    createWindow();
    void agenteraAuth.initialize();
    buildMenu({ getMainWindow: () => mainWindow, openExternalUrl });

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on(
    "before-quit",
    createQuitBarrier(
      async () => {
        unsubscribeAgenteraAuth();
        unsubscribeProductSpace();
        agenteraAuth.dispose();
        agenteraProductSpace?.close();
        agenteraOrganization?.close();
        agenteraWorkspace?.close();
        agenteraOfficialQualityDatabase?.close();
        agenteraEncryptedBackup?.close();
        agenteraAgentControlDatabase?.close();
        await stopActiveRuntimeContext();
      },
      () => app.quit(),
      (error) => {
        console.error("[APP_QUIT_CLEANUP] failed", error);
      },
    ),
  );
}

export async function stopActiveRuntimeContext(): Promise<void> {
  stopHealthPolling();
  runtimeActivity.abortAll();
  cleanupTempMediaFiles();
  stopAllDashboards();
  const tuiShutdown = stopAllTuiGatewayClients();
  // A Profile or connection context must never remain mounted across an
  // Aera owner transition. Stop local execution, remote/SSH transport,
  // and cached SQLite access before the next owner can claim a context.
  stopAeraOwnedGateways();
  stopSshTunnel();
  closeDbConnection();
  await tuiShutdown;
}

function notifyConnectionConfigChanged(): void {
  mainWindow?.webContents.send(
    "connection-config-changed",
    getPublicConnectionConfig(),
  );
}

function notifyRuntimeSnapshotChanged(): void {
  mainWindow?.webContents.send("runtime-snapshot-changed");
}

function notifyModelLibraryChanged(): void {
  mainWindow?.webContents.send("model-library-changed");
}

function notifyCustomProvidersChanged(): void {
  mainWindow?.webContents.send("custom-providers-changed");
}

function openExternalUrl(rawUrl: unknown): void {
  dispatchExternalUrl(rawUrl, isAllowedExternalUrl);
}

function dispatchExternalUrl(
  rawUrl: unknown,
  policy: (candidate: unknown) => boolean,
): boolean {
  if (!policy(rawUrl)) {
    console.warn("[SECURITY] Blocked unsafe external URL");
    return false;
  }
  shell.openExternal(rawUrl as string).catch((err) => {
    console.error("[SECURITY] Failed to open external URL:", err);
  });
  return true;
}

function openAgenteraAuthUrl(rawUrl: string, expectedOrigin: string): void {
  if (
    !dispatchExternalUrl(rawUrl, (candidate) =>
      isAllowedAgenteraAuthExternalUrl(candidate, expectedOrigin),
    )
  ) {
    throw new Error("Aera browser authorization URL was blocked.");
  }
}

function createWindow(): void {
  const rendererHtmlPath = join(__dirname, "../renderer/index.html");
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 850,
    minWidth: 900,
    title: APP_NAME,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : undefined,
    ...(process.platform === "darwin"
      ? { trafficLightPosition: { x: 16, y: 16 } }
      : {}),
    ...(process.platform === "linux" ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: true,
    },
  });

  mainWindow.on("ready-to-show", () => mainWindow?.show());
  mainWindow.webContents.once("did-finish-load", () => {
    if (OPEN_DEVTOOLS_ON_START) {
      mainWindow?.webContents.openDevTools({ mode: "detach" });
    }
  });

  // Let mid-turn gateway sudo/secret prompts parent their modal to this window.
  setGatewayPromptParent(() => mainWindow);

  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    console.error(
      "[CRASH] Renderer process gone:",
      details.reason,
      details.exitCode,
    );
  });
  mainWindow.webContents.on("console-message", (details) => {
    // Electron ≥35 passes a single event object (level is now a string);
    // the old positional `(event, level, message, line, sourceId)` signature
    // is deprecated.
    if (details.level === "error") {
      console.error(
        `[RENDERER ERROR] ${details.message} (${details.sourceId}:${details.lineNumber})`,
      );
    }
  });
  mainWindow.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription) => {
      console.error("[LOAD FAIL]", errorCode, errorDescription);
    },
  );
  mainWindow.webContents.setWindowOpenHandler((details) => {
    openExternalUrl(details.url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (
      isAllowedAppNavigationUrl(
        url,
        rendererHtmlPath,
        is.dev ? process.env["ELECTRON_RENDERER_URL"] : undefined,
      )
    )
      return;
    event.preventDefault();
    openExternalUrl(url);
  });
  mainWindow.webContents.on(
    "will-attach-webview",
    (event, webPreferences, params) => {
      const isWebPreview = params.partition === "web-preview";
      if (!isAllowedWebviewUrl(params.src, isWebPreview)) {
        event.preventDefault();
        console.warn("[SECURITY] Blocked webview attachment for untrusted URL");
        return;
      }
      hardenWebviewPreferences(webPreferences);
    },
  );
  mainWindow.webContents.on("context-menu", (_event, params) => {
    showChatContextMenu(mainWindow, params);
  });

  if (is.dev && process.env["ELECTRON_RENDERER_URL"]) {
    mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    mainWindow.loadFile(rendererHtmlPath);
  }
}
