import { existsSync } from "node:fs";
import { join } from "node:path";

interface IdentityApp {
  getPath(name: "appData" | "userData"): string;
  setPath(name: "userData", path: string): void;
}

export function resolveDesktopUserDataPath(
  app: IdentityApp,
  override = process.env.HERMES_DESKTOP_USER_DATA_DIR?.trim() || "",
  pathExists: (path: string) => boolean = existsSync,
): string | null {
  if (override) return override;

  const current = app.getPath("userData");
  if (pathExists(current)) return null;

  const legacyDirectories = [
    "AgentEra Studio",
    "agentera-studio",
    "hermes-desktop",
  ];
  for (const directory of legacyDirectories) {
    const legacy = join(app.getPath("appData"), directory);
    if (current !== legacy && pathExists(legacy)) {
      return legacy;
    }
  }

  return null;
}

export function configureDesktopIdentity(
  app: IdentityApp,
  pathExists: (path: string) => boolean = existsSync,
): void {
  const target = resolveDesktopUserDataPath(
    app,
    process.env.HERMES_DESKTOP_USER_DATA_DIR?.trim() || "",
    pathExists,
  );
  if (target) app.setPath("userData", target);
}
