import { app, BrowserWindow } from "electron";
import { resolve } from "node:path";
import { applyGpuPreferences, installGpuCrashGuard } from "./gpu-fallback";
import { configureDesktopIdentity } from "./app/identity";
import { loadDotEnvForDev } from "./load-env";
import {
  bootstrapRuntimeDistribution,
  createRuntimeBootstrapOptions,
} from "./agentera-runtime-distribution/bootstrap";
import { WorkspaceInvitationInbox } from "./agentera-workspace/deep-link";

// Dev only: make process.env reflect the project `.env` so runtime env reads
// (e.g. the Hermes One API endpoint) pick up edits on relaunch without a
// rebuild. Packaged builds carry their config baked in and ship no `.env`.
if (!app.isPackaged) loadDotEnvForDev();

configureDesktopIdentity(app);
applyGpuPreferences();
installGpuCrashGuard();

if (process.env.ENABLE_CDP === "1") {
  app.commandLine.appendSwitch(
    "remote-debugging-port",
    process.env.CDP_PORT || "9222",
  );
}

async function bootstrapAndStartMainProcess(): Promise<void> {
  try {
    await bootstrapRuntimeDistribution(
      createRuntimeBootstrapOptions({
        userDataPath: app.getPath("userData"),
        resourcesPath: process.resourcesPath,
        workingDirectory: process.cwd(),
        isPackaged: app.isPackaged,
        developmentSeedDirectory: process.env.AGENTERA_RUNTIME_SEED_DIR,
        desktopVersion: app.getVersion(),
        platform: process.platform,
        arch: process.arch,
      }),
    );
  } catch {
    // Startup remains available so the signed packaged Seed repair UI can
    // recover a missing or unusable Runtime without exposing local paths.
    console.error("[AGENTERA_RUNTIME_BOOTSTRAP] repair required");
  }
  const { startMainProcess } = await import("./app/start");
  await startMainProcess({ workspaceInvitationInbox });
}

const workspaceInvitationInbox = new WorkspaceInvitationInbox();

function registerAgenteraInvitationProtocol(): void {
  const schemes = ["aera", "agentera"];
  if (app.isPackaged) {
    for (const scheme of schemes) {
      app.setAsDefaultProtocolClient(scheme);
    }
    return;
  }
  const developmentEntry = process.argv[1];
  if (typeof developmentEntry === "string" && developmentEntry.length > 0) {
    for (const scheme of schemes) {
      app.setAsDefaultProtocolClient(scheme, process.execPath, [
        resolve(developmentEntry),
      ]);
    }
  }
}

function focusPrimaryWindow(): void {
  const window = BrowserWindow.getAllWindows()[0];
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  registerAgenteraInvitationProtocol();
  app.on("open-url", (event, url) => {
    event.preventDefault();
    workspaceInvitationInbox.receiveDeepLink(url);
    focusPrimaryWindow();
  });
  app.on("second-instance", (_event, commandLine) => {
    workspaceInvitationInbox.receiveArguments(commandLine);
    focusPrimaryWindow();
  });
  workspaceInvitationInbox.receiveArguments(process.argv);
  void bootstrapAndStartMainProcess();
}
