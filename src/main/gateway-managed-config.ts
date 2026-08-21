import { existsSync, readFileSync } from "node:fs";
import { parseDocument } from "yaml";
import {
  getConfigValue,
  persistConfigWritePlan,
  planConfigDocumentWrite,
  planConfigValueWrite,
  planLocalApiServerKeyWrite,
  type ConfigWritePlan,
  type EnsureLocalApiServerKeyResult,
} from "./config";
import { ensureProfilePortAvailable } from "./gateway-ports";
import {
  requireManagedModelMutationValue,
  type ManagedModelMutationPort,
} from "./model-configuration-mutation-port";
import {
  getActiveProfileNameSync,
  normalizeProfileName,
  profilePaths,
} from "./utils";

const API_SERVER_PORT_PATH = "platforms.api_server.extra.port";

/**
 * Resolve the profile once for the whole Gateway write plan. The Gateway
 * launcher treats an omitted profile as the file-backed active Profile, while
 * the config planners previously treated the same value as the default
 * Profile. That produced a mixed plan (.env in the active Profile and
 * config.yaml in the default Profile) and the coordinator correctly rejected
 * the cross-Profile write. Keep every plan and the mutation scope on one
 * canonical Profile identity.
 */
function resolveGatewayProfile(profile?: string): string | undefined {
  // Keep the explicit default sentinel through the mutation boundary. The
  // file helpers intentionally normalize `default` to the root home, but an
  // omitted profile means "active Profile" and must remain distinct here.
  if (profile === "default") return "default";
  return normalizeProfileName(profile ?? getActiveProfileNameSync());
}

export interface GatewayManagedConfigurationDependencies {
  readonly modelMutationPort: ManagedModelMutationPort;
  readonly resolvePort?: (profile?: string) => Promise<number>;
}

export interface GatewayManagedConfigurationPlan {
  readonly credentialPlan: ConfigWritePlan<EnsureLocalApiServerKeyResult>;
  readonly configPlan: ConfigWritePlan<void> | null;
}

export function planGatewayManagedConfiguration(
  profile: string | undefined,
  port: number,
): GatewayManagedConfigurationPlan {
  const targetProfile = resolveGatewayProfile(profile);
  const credentialPlan = planLocalApiServerKeyWrite(targetProfile);
  const { configFile } = profilePaths(targetProfile);
  if (!existsSync(configFile)) {
    return { credentialPlan, configPlan: null };
  }

  const content = readFileSync(configFile, "utf-8");
  let configPlan: ConfigWritePlan<void> | null = null;
  if (!/api_server/i.test(content)) {
    configPlan = planConfigDocumentWrite(
      targetProfile,
      (current) => {
        const separator = current.endsWith("\n") ? "" : "\n";
        return `${current}${separator}
# Desktop app API server (auto-configured)
platforms:
  api_server:
    enabled: true
    extra:
      port: ${port}
      host: "127.0.0.1"
`;
      },
      undefined,
    );
  } else {
    const configuredPort = getConfigValue(API_SERVER_PORT_PATH, targetProfile);
    if (configuredPort?.trim() !== String(port)) {
      configPlan = configuredPort
        ? planConfigValueWrite(
            API_SERVER_PORT_PATH,
            String(port),
            targetProfile,
          )
        : planConfigDocumentWrite(
            targetProfile,
            (current) => {
              const document = parseDocument(current);
              if (document.errors.length > 0) {
                throw new Error("Cannot repair invalid gateway YAML.");
              }
              if (
                document.getIn(["platforms", "api_server", "enabled"]) ===
                undefined
              ) {
                document.setIn(["platforms", "api_server", "enabled"], true);
              }
              if (
                document.getIn([
                  "platforms",
                  "api_server",
                  "extra",
                  "host",
                ]) === undefined
              ) {
                document.setIn(
                  ["platforms", "api_server", "extra", "host"],
                  "127.0.0.1",
                );
              }
              document.setIn(
                ["platforms", "api_server", "extra", "port"],
                port,
              );
              return document.toString();
            },
            undefined,
          );
    }
  }

  return { credentialPlan, configPlan };
}

export async function prepareGatewayManagedConfiguration(
  profile: string | undefined,
  dependencies: GatewayManagedConfigurationDependencies,
): Promise<{ key: string; port: number }> {
  const port = await (
    dependencies.resolvePort ?? ensureProfilePortAvailable
  )(profile);
  const targetProfile = resolveGatewayProfile(profile);
  const plan = planGatewayManagedConfiguration(profile, port);
  const result = await dependencies.modelMutationPort.mutate({
    operation: "gateway_configuration_prepare",
    globalCatalog: false,
    profileIds: [targetProfile || "default"],
    stage: plan.credentialPlan.value.generated ? "credential" : "activation",
    prepare: () => ({
      write: (permit) => {
        const credential = persistConfigWritePlan(
          permit,
          plan.credentialPlan,
        );
        if (plan.configPlan) persistConfigWritePlan(permit, plan.configPlan);
        return { key: credential.key, port };
      },
    }),
  });
  return requireManagedModelMutationValue(result);
}
