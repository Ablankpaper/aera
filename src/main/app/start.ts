import { app, BrowserWindow, safeStorage, session, shell } from "electron";
import { join } from "path";
import { hostname } from "node:os";
import { electronApp, optimizer, is } from "@electron-toolkit/utils";
import icon from "../../../resources/icon.png?asset";
import { getConnectionConfig, getPublicConnectionConfig } from "../config";
import { stopGateway, stopHealthPolling } from "../hermes";
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
import { DESKTOP_APP_ID, DESKTOP_PRODUCT_NAME } from "../../shared/branding";
import { getAgenteraCloudOrigin } from "../agentera-auth/config";
import { AgenteraCloudClient } from "../agentera-auth/client";
import { createAgenteraAuthController } from "../agentera-auth/controller";
import { createAgenteraAuthStoreForApp } from "../agentera-auth/store";
import {
  AgenteraProfileBindingStore,
  type AgenteraRuntimeOwner,
} from "../agentera-profile-binding";
import {
  AgenteraConnectionOwnerStore,
  createAgenteraOwnerSwitchCoordinator,
} from "../agentera-connection-owner";
import { createProductAccessGuard } from "../ipc/auth-guard";
import { getActiveProfileNameSync, profileHome } from "../utils";

const APP_NAME =
  process.env.HERMES_DESKTOP_APP_NAME?.trim() || DESKTOP_PRODUCT_NAME;
const OPEN_DEVTOOLS_ON_START =
  process.env.HERMES_OPEN_DEVTOOLS === "1" ||
  process.env.HERMES_DESKTOP_OPEN_DEVTOOLS === "1";

let mainWindow: BrowserWindow | null = null;
const activeRuns = new Map<string, () => void>();

export function startMainProcess(): void {
  process.on("uncaughtException", (err) => {
    console.error("[MAIN UNCAUGHT]", err);
  });

  process.on("unhandledRejection", (reason) => {
    console.error("[MAIN UNHANDLED REJECTION]", reason);
  });

  const agenteraAuthStore = createAgenteraAuthStoreForApp(app, safeStorage);
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
    bringMainWindowToFront: () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    },
    getDeviceMetadata: () => ({
      deviceName: (hostname().trim() || "AgentEra device").slice(0, 100),
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
    const installation = agenteraAuthStore.getInstallation();
    if (
      (state.status !== "authenticated" && state.status !== "offline") ||
      !installation
    ) {
      throw new Error("AgentEra product sign-in is required.");
    }
    return {
      tenantId: state.personalSpaceId,
      ownerId: state.userId,
      installationId: installation.installationId,
    };
  };
  const productAccessGuard = createProductAccessGuard({
    getAuthState: () => agenteraAuth.getPublicState(),
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
  const ownerSwitchCoordinator = createAgenteraOwnerSwitchCoordinator({
    stopRuntimeContext: stopActiveRuntimeContext,
  });
  const unsubscribeAgenteraAuth = agenteraAuth.subscribe((state) => {
    ownerSwitchCoordinator.transitionTo(
      state.status === "authenticated" || state.status === "offline"
        ? state.userId
        : null,
    );
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send("agentera-auth-state-changed", state);
  });

  registerIpcHandlers({
    activeRuns,
    getMainWindow: () => mainWindow,
    notifyConnectionConfigChanged,
    notifyModelLibraryChanged,
    notifyCustomProvidersChanged,
    openExternalUrl,
    agenteraAuth,
    productAccessGuard,
    getAgenteraRuntimeOwner,
    agenteraProfileBindings,
    agenteraConnectionOwners,
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

  app.on("before-quit", () => {
    unsubscribeAgenteraAuth();
    agenteraAuth.dispose();
    stopActiveRuntimeContext();
  });
}

function stopActiveRuntimeContext(): void {
  stopHealthPolling();
  for (const abort of activeRuns.values()) abort();
  activeRuns.clear();
  cleanupTempMediaFiles();
  stopAllDashboards();
  // A Profile or connection context must never remain mounted across an
  // AgentEra owner transition. Stop local execution, remote/SSH transport,
  // and cached SQLite access before the next owner can claim a context.
  stopGateway(undefined, true);
  stopSshTunnel();
  closeDbConnection();
}

function notifyConnectionConfigChanged(): void {
  mainWindow?.webContents.send(
    "connection-config-changed",
    getPublicConnectionConfig(),
  );
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
    throw new Error("AgentEra browser authorization URL was blocked.");
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
