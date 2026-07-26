import { getModelConfig, readEnv } from "./config";
import { runtimeHostDerivedEnvKeyForUrl } from "./host-derived-env";
import { readModels } from "./models";
import { providerListSafe } from "./secrets";
import { customProviderEnvKey } from "../shared/url-key-map";

function normalizedCredentialEndpoint(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

/**
 * Bridge the active named custom provider's private desktop slot into the
 * exact host-derived slot read by Hermes Runtime.
 *
 * The bridge is process-local: it does not duplicate or persist the provider
 * key. Requiring an exact provider + model + endpoint library match prevents a
 * key belonging to one custom service from being forwarded to another.
 */
export function bridgeActiveCustomProviderCredential(
  env: Record<string, string>,
  profile?: string,
): void {
  const modelConfig = getModelConfig(profile);
  if (
    modelConfig.provider !== "custom" ||
    !modelConfig.model ||
    !modelConfig.baseUrl
  ) {
    return;
  }

  const runtimeEnvKey = runtimeHostDerivedEnvKeyForUrl(modelConfig.baseUrl);
  if (!runtimeEnvKey) return;

  const endpoint = normalizedCredentialEndpoint(modelConfig.baseUrl);
  const model = readModels().find(
    (candidate) =>
      candidate.provider === "custom" &&
      candidate.model === modelConfig.model &&
      normalizedCredentialEndpoint(candidate.baseUrl) === endpoint,
  );
  if (!model) return;

  const sourceEnvKey = customProviderEnvKey(model.providerLabel || model.name);
  const value = env[sourceEnvKey]?.trim();
  if (!value) return;

  env[runtimeEnvKey] = value;
}

/**
 * Hydrate one trusted local Runtime child environment from the selected
 * Profile and its configured secrets provider, then apply the active-model
 * credential bridge.
 */
export function hydrateProfileRuntimeEnv(
  env: Record<string, string>,
  profile?: string,
): Record<string, string> {
  for (const [key, value] of Object.entries(readEnv(profile))) {
    if (value) env[key] = value;
  }
  for (const [key, value] of Object.entries(providerListSafe(profile))) {
    if (value && !env[key]) env[key] = value;
  }
  bridgeActiveCustomProviderCredential(env, profile);
  return env;
}
