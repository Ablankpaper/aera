import { app, ipcMain, type BrowserWindow } from "electron";
import type { AppUpdater } from "electron-updater";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { getAgenteraCloudOrigin } from "../agentera-auth/config";
import { updaterLogger } from "../updater-log";
import {
  InternalBetaDesktopUpdater,
  resolveCurrentMacAppPath,
  type DesktopUpdateSnapshot,
} from "./internal-beta-updater";
import {
  INTERNAL_BETA_UPDATE_PUBLIC_KEYS,
  isInternalBetaDesktopVersion,
} from "./update-channel";

interface UpdaterDeps {
  getMainWindow: () => BrowserWindow | null;
}

const UPDATE_CHECK_DELAY_MS = 5_000;
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000;

let autoUpdaterInstance: AppUpdater | null = null;
let internalBetaUpdaterInstance: InternalBetaDesktopUpdater | null = null;
let updateSnapshot: DesktopUpdateSnapshot = {
  state: null,
  version: null,
  releaseNotes: null,
  percent: null,
  error: null,
};

function updatePreferencesPath(): string {
  return join(app.getPath("userData"), "update-preferences.json");
}

function getAutoUpgradeEnabled(): boolean {
  const file = updatePreferencesPath();
  if (!existsSync(file)) return true;

  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as {
      autoUpgrade?: unknown;
    };
    return parsed.autoUpgrade !== false;
  } catch {
    return true;
  }
}

function setAutoUpgradeEnabled(enabled: boolean): void {
  const file = updatePreferencesPath();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ autoUpgrade: enabled }, null, 2)}\n`);
}

function releaseNotesText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((entry) => {
      if (
        entry !== null &&
        typeof entry === "object" &&
        "note" in entry &&
        typeof entry.note === "string"
      ) {
        return entry.note;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function publishSnapshot(
  getMainWindow: UpdaterDeps["getMainWindow"],
  snapshot: DesktopUpdateSnapshot,
): void {
  updateSnapshot = { ...snapshot };
  const webContents = getMainWindow()?.webContents;
  if (!webContents) return;
  if (snapshot.state === "available") {
    webContents.send("update-available", {
      version: snapshot.version,
      releaseNotes: snapshot.releaseNotes ?? "",
    });
  } else if (snapshot.state === "downloading") {
    webContents.send("update-download-progress", {
      percent: snapshot.percent ?? 0,
    });
  } else if (snapshot.state === "ready") {
    webContents.send("update-downloaded");
  } else if (snapshot.state === "error") {
    webContents.send(
      "update-error",
      snapshot.error ?? "更新失败，请稍后重试。",
    );
  }
}

function setupDisabledUpdater(): void {
  ipcMain.handle("check-for-updates", async () => null);
  ipcMain.handle("download-update", async () => false);
  ipcMain.handle("install-update", async () => {});
}

function setupInternalBetaUpdater({ getMainWindow }: UpdaterDeps): boolean {
  const platform =
    process.platform === "darwin"
      ? "darwin"
      : process.platform === "win32"
        ? "win32"
        : null;
  const arch =
    process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : null;
  if (
    platform === null ||
    arch === null ||
    (platform === "darwin" && arch !== "arm64") ||
    (platform === "win32" && arch !== "x64")
  ) {
    return false;
  }

  let origin: string;
  try {
    origin = getAgenteraCloudOrigin();
  } catch (error) {
    updaterLogger.error(
      `Internal Beta update origin is unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }

  const updater = new InternalBetaDesktopUpdater({
    currentVersion: app.getVersion(),
    platform,
    arch,
    userDataPath: app.getPath("userData"),
    currentAppPath:
      platform === "darwin" ? resolveCurrentMacAppPath(process.execPath) : null,
    baseUrl: new URL("/desktop-updates/internal-beta", origin),
    trustedPublicKeys: INTERNAL_BETA_UPDATE_PUBLIC_KEYS,
    autoDownload: getAutoUpgradeEnabled(),
    onState: (snapshot) => publishSnapshot(getMainWindow, snapshot),
    log: updaterLogger,
  });
  internalBetaUpdaterInstance = updater;

  ipcMain.handle("check-for-updates", () => updater.check());
  ipcMain.handle("download-update", () => updater.download());
  ipcMain.handle("install-update", async () => {
    try {
      updaterLogger.info(
        "Restart requested by user for verified Internal Beta update",
      );
      await updater.install();
      app.quit();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "更新失败，请稍后重试。";
      publishSnapshot(getMainWindow, {
        state: "error",
        version: updateSnapshot.version,
        releaseNotes: updateSnapshot.releaseNotes,
        percent: null,
        error: message,
      });
    }
  });

  void app.whenReady().then(async () => {
    try {
      await updater.initialize();
    } catch (error) {
      updaterLogger.error(
        `Internal Beta updater initialization failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      publishSnapshot(getMainWindow, {
        state: "error",
        version: null,
        releaseNotes: null,
        percent: null,
        error: "更新服务初始化失败，请稍后重试。",
      });
      return;
    }
    const initialTimer = setTimeout(() => {
      void updater.check();
    }, UPDATE_CHECK_DELAY_MS);
    initialTimer.unref?.();
    const interval = setInterval(() => {
      void updater.check();
    }, UPDATE_CHECK_INTERVAL_MS);
    interval.unref?.();
    app.once("before-quit", () => {
      clearTimeout(initialTimer);
      clearInterval(interval);
      updater.dispose();
    });
  });
  return true;
}

function setupPublicUpdater({ getMainWindow }: UpdaterDeps): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { autoUpdater } = require("electron-updater") as {
    autoUpdater: AppUpdater;
  };

  autoUpdaterInstance = autoUpdater;
  autoUpdater.logger = updaterLogger;
  autoUpdater.autoDownload = getAutoUpgradeEnabled();
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("checking-for-update", () => {
    publishSnapshot(getMainWindow, {
      state: "checking",
      version: null,
      releaseNotes: null,
      percent: null,
      error: null,
    });
  });
  autoUpdater.on("update-not-available", () => {
    publishSnapshot(getMainWindow, {
      state: "uptodate",
      version: null,
      releaseNotes: null,
      percent: null,
      error: null,
    });
  });
  autoUpdater.on("update-available", (info) => {
    publishSnapshot(getMainWindow, {
      state: "available",
      version: info.version,
      releaseNotes: releaseNotesText(info.releaseNotes),
      percent: null,
      error: null,
    });
  });
  autoUpdater.on("download-progress", (progress) => {
    publishSnapshot(getMainWindow, {
      state: "downloading",
      version: updateSnapshot.version,
      releaseNotes: updateSnapshot.releaseNotes,
      percent: Math.round(progress.percent),
      error: null,
    });
  });
  autoUpdater.on("update-downloaded", () => {
    publishSnapshot(getMainWindow, {
      state: "ready",
      version: updateSnapshot.version,
      releaseNotes: updateSnapshot.releaseNotes,
      percent: null,
      error: null,
    });
  });
  autoUpdater.on("error", (error) => {
    publishSnapshot(getMainWindow, {
      state: "error",
      version: updateSnapshot.version,
      releaseNotes: updateSnapshot.releaseNotes,
      percent: null,
      error: error.message,
    });
  });

  ipcMain.handle("check-for-updates", async () => {
    try {
      const result = await autoUpdater.checkForUpdates();
      return result?.updateInfo?.version ?? null;
    } catch {
      return null;
    }
  });
  ipcMain.handle("download-update", async () => {
    try {
      await autoUpdater.downloadUpdate();
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      publishSnapshot(getMainWindow, {
        state: "error",
        version: updateSnapshot.version,
        releaseNotes: updateSnapshot.releaseNotes,
        percent: null,
        error: message,
      });
      return false;
    }
  });
  ipcMain.handle("install-update", () => {
    updaterLogger.info(
      "Restart requested by user — calling quitAndInstall(isSilent=false, isForceRunAfter=true)",
    );
    autoUpdater.quitAndInstall(false, true);
  });

  const initialTimer = setTimeout(() => {
    void autoUpdater.checkForUpdates();
  }, UPDATE_CHECK_DELAY_MS);
  initialTimer.unref?.();
  const interval = setInterval(() => {
    void autoUpdater.checkForUpdates();
  }, UPDATE_CHECK_INTERVAL_MS);
  interval.unref?.();
  app.once("before-quit", () => {
    clearTimeout(initialTimer);
    clearInterval(interval);
  });
}

export function setupUpdater({ getMainWindow }: UpdaterDeps): void {
  ipcMain.handle("get-app-version", () => app.getVersion());
  ipcMain.handle("get-desktop-update-state", () => ({ ...updateSnapshot }));
  ipcMain.handle("get-auto-upgrade-enabled", () => getAutoUpgradeEnabled());
  ipcMain.handle("set-auto-upgrade-enabled", (_event, enabled: boolean) => {
    setAutoUpgradeEnabled(enabled);
    if (autoUpdaterInstance) autoUpdaterInstance.autoDownload = enabled;
    internalBetaUpdaterInstance?.setAutoDownload(enabled);
    return true;
  });

  const isPortableBuild = Boolean(process.env.PORTABLE_EXECUTABLE_DIR);
  if (!app.isPackaged || isPortableBuild) {
    setupDisabledUpdater();
    return;
  }
  if (isInternalBetaDesktopVersion(app.getVersion())) {
    if (!setupInternalBetaUpdater({ getMainWindow })) setupDisabledUpdater();
    return;
  }
  setupPublicUpdater({ getMainWindow });
}
