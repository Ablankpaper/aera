import type { ConnectionConfig } from "../config";
import {
  isGatewayRunning,
  prepareGatewayForLaunch,
  startGatewayWithReadiness,
  startGatewayWithRecovery,
} from "../hermes";
import { sshStartGatewayAndWaitApiReady } from "../ssh-remote";

export interface ProfileGatewayReadinessDependencies {
  isGatewayRunning: typeof isGatewayRunning;
  prepareGatewayForLaunch: typeof prepareGatewayForLaunch;
  startGatewayWithReadiness: typeof startGatewayWithReadiness;
  startGatewayWithRecovery: typeof startGatewayWithRecovery;
  sshStartGatewayAndWaitApiReady: typeof sshStartGatewayAndWaitApiReady;
}

const defaultDependencies: ProfileGatewayReadinessDependencies = {
  isGatewayRunning,
  prepareGatewayForLaunch,
  startGatewayWithReadiness,
  startGatewayWithRecovery,
  sshStartGatewayAndWaitApiReady,
};

/**
 * Ensure the newly selected Profile has a serving Gateway before the profile
 * activation IPC reports success. Process liveness alone is never sufficient.
 */
export async function ensureActivatedProfileGatewayReady(
  connection: ConnectionConfig,
  profile: string,
  dependencies: ProfileGatewayReadinessDependencies = defaultDependencies,
): Promise<boolean> {
  if (connection.mode === "ssh") {
    const result = await dependencies.sshStartGatewayAndWaitApiReady(
      connection.ssh,
      profile,
      30_000,
    );
    return result.ready;
  }
  if (connection.mode === "remote") return true;

  if (dependencies.isGatewayRunning(profile)) {
    return dependencies.startGatewayWithRecovery(profile);
  }

  const prepared = await dependencies.prepareGatewayForLaunch(profile);
  const result = await dependencies.startGatewayWithReadiness(
    profile,
    prepared,
  );
  return result.ready === true;
}
