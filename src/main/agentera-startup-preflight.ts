import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ConnectionConfig } from "./config";
import { getRuntimeInvocation } from "./agentera-runtime-distribution/invocation";
import { getActiveProfileNameSync, profileHome } from "./utils";

export type AgenteraPostAuthTarget = "welcome" | "setup" | "main";

export interface AgenteraStartupPreflightResult {
  connectionMode: "local" | "remote" | "ssh";
  postAuthTarget: AgenteraPostAuthTarget;
  verifyWarning: boolean;
}

export interface AgenteraInstallFileStatus {
  installed: boolean;
  configured: boolean;
  hasApiKey: boolean;
}

export interface AgenteraStartupPreflightDependencies {
  getConnectionConfig: () => ConnectionConfig;
  checkInstallStatus: () => AgenteraInstallFileStatus;
  verifyInstall: () => Promise<boolean>;
  probeRemote: (config: ConnectionConfig) => Promise<unknown>;
  probeSsh: (config: ConnectionConfig) => Promise<unknown>;
}

/** File-metadata-only probe: it never opens config, auth, Memory, or sessions. */
export function probeAgenteraInstallFiles(): AgenteraInstallFileStatus {
  const home = profileHome(getActiveProfileNameSync());
  const configured =
    existsSync(join(home, ".env")) || existsSync(join(home, "auth.json"));
  return {
    installed: getRuntimeInvocation() !== null,
    configured,
    // Pre-auth needs only a post-auth route hint. Treat presence of approved
    // configuration metadata as configured without reading any key value.
    hasApiKey: configured,
  };
}

/**
 * Main-process-only startup probe. The returned object is deliberately a
 * three-field allowlist: connection credentials and Runtime owner data are
 * consumed only inside the main process and can never cross pre-auth IPC.
 */
export async function runAgenteraStartupPreflight(
  dependencies: AgenteraStartupPreflightDependencies,
): Promise<AgenteraStartupPreflightResult> {
  const connection = dependencies.getConnectionConfig();
  if (connection.mode === "remote") {
    await dependencies.probeRemote(connection).catch(() => undefined);
    return {
      connectionMode: "remote",
      postAuthTarget: "main",
      verifyWarning: false,
    };
  }
  if (connection.mode === "ssh") {
    await dependencies.probeSsh(connection).catch(() => undefined);
    return {
      connectionMode: "ssh",
      postAuthTarget: "main",
      verifyWarning: false,
    };
  }

  const install = dependencies.checkInstallStatus();
  const postAuthTarget: AgenteraPostAuthTarget = !install.installed
    ? "welcome"
    : install.hasApiKey
      ? "main"
      : "setup";
  let verifyWarning = false;
  if (install.installed) {
    verifyWarning = !(await dependencies.verifyInstall().catch(() => false));
  }
  return {
    connectionMode: "local",
    postAuthTarget,
    verifyWarning,
  };
}
