import { app } from "electron";
import { applyGpuPreferences, installGpuCrashGuard } from "./gpu-fallback";
import { configureDesktopIdentity } from "./app/identity";
import { loadDotEnvForDev } from "./load-env";
import {
  bootstrapRuntimeDistribution,
  createRuntimeBootstrapOptions,
} from "./agentera-runtime-distribution/bootstrap";

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
  startMainProcess();
}

void bootstrapAndStartMainProcess();
