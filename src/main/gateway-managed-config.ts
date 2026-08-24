import { parseDocument } from "yaml";
import {
  persistConfigWritePlan,
  planConfigDocumentWrite,
  planLocalApiServerKeyWrite,
  type ConfigWritePlan,
  type EnsureLocalApiServerKeyResult,
} from "./config";
import { ensureProfilePortAvailable } from "./gateway-ports";
import {
  requireManagedModelMutationValue,
  type ManagedModelMutationPort,
} from "./model-configuration-mutation-port";
import { migrateLegacyOpenAiModelRoute } from "./runtime-provider-compat";
import {
  getActiveProfileNameSync,
  normalizeProfileName,
} from "./utils";

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
  const configPlan = planConfigDocumentWrite(
    targetProfile,
    (current) => {
      const next = migrateLegacyOpenAiModelRoute(current);
      if (!/api_server/i.test(next)) {
        const separator = next.endsWith("\n") || next === "" ? "" : "\n";
        return `${next}${separator}
# Desktop app API server (auto-configured)
platforms:
  api_server:
    enabled: true
    extra:
      port: ${port}
      host: "127.0.0.1"
`;
      }

      const document = parseDocument(next);
      if (document.errors.length > 0) {
        throw new Error("Cannot repair invalid gateway YAML.");
      }
      if (
        String(
          document.getIn(["platforms", "api_server", "extra", "port"]) ??
            "",
        ).trim() === String(port)
      ) {
        return next;
      }
      if (
        document.getIn(["platforms", "api_server", "enabled"]) ===
        undefined
      ) {
        document.setIn(["platforms", "api_server", "enabled"], true);
      }
      if (
        document.getIn(["platforms", "api_server", "extra", "host"]) ===
        undefined
      ) {
        document.setIn(
          ["platforms", "api_server", "extra", "host"],
          "127.0.0.1",
        );
      }
      document.setIn(["platforms", "api_server", "extra", "port"], port);
      return document.toString();
    },
    undefined,
  );

  const unchanged =
    configPlan.before === null
      ? configPlan.after === null
      : configPlan.after !== null && configPlan.before.equals(configPlan.after);
  return { credentialPlan, configPlan: unchanged ? null : configPlan };
}

export async function prepareGatewayManagedConfiguration(
  profile: string | undefined,
  dependencies: GatewayManagedConfigurationDependencies,
): Promise<{ key: string; port: number }> {
  const port = await (
    dependencies.resolvePort ?? ensureProfilePortAvailable
  )(profile);
  const targetProfile = resolveGatewayProfile(profile);
  const result = await dependencies.modelMutationPort.mutate({
    operation: "gateway_configuration_prepare",
    globalCatalog: false,
    profileIds: [targetProfile || "default"],
    // API-server credential preparation is the invariant purpose of this
    // transaction. Build every file plan only after the coordinator has taken
    // its Profile lock; account/Profile materialization may update config.yaml
    // between the caller entering this function and mutation admission.
    stage: "credential",
    prepare: () => {
      const plan = planGatewayManagedConfiguration(profile, port);
      return {
        write: (permit) => {
          const credential = persistConfigWritePlan(
            permit,
            plan.credentialPlan,
          );
          if (plan.configPlan) persistConfigWritePlan(permit, plan.configPlan);
          return { key: credential.key, port };
        },
      };
    },
  });
  return requireManagedModelMutationValue(result);
}
