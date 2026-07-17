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
  const legacy = join(app.getPath("appData"), "hermes-desktop");
  if (current !== legacy && pathExists(legacy) && !pathExists(current)) {
    return legacy;
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
