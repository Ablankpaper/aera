import type { AgentRuntimeModelRoute } from "../../shared/agentera-agent-control";
import {
  isCustomProviderRoute,
  normalizeCustomProviderRuntimeName,
} from "../../shared/custom-providers";
import { customProviderEnvKey, isLocalBaseUrl } from "../../shared/url-key-map";
import { hasOAuthCredentials } from "../config";
import { expectedEnvKeyForModel } from "../installer";
import { readModels } from "../models";
import { canonicalProviderBaseUrl } from "../provider-registry";
import { listCustomProviders } from "../providers-store";
import { getSecret } from "../secrets";

export interface RuntimeModelRouteDependencies {
  readModels: typeof readModels;
  listCustomProviders: typeof listCustomProviders;
  getSecret: typeof getSecret;
  hasOAuthCredentials: typeof hasOAuthCredentials;
}

/** Main-only route with the non-secret credential anchor needed for resolve. */
export interface ResolvedAgentRuntimeModelRoute extends AgentRuntimeModelRoute {
  apiMode: string | null;
  credentialRef: string | null;
}

const DEFAULT_DEPENDENCIES: RuntimeModelRouteDependencies = {
  readModels,
  listCustomProviders,
  getSecret,
  hasOAuthCredentials,
};

function normalizedEndpoint(value: string): string {
  return value.trim().replace(/\/+$/, "").toLowerCase();
}

function hasSecret(
  key: string,
  profile: string,
  dependencies: RuntimeModelRouteDependencies,
): boolean {
  try {
    return Boolean(dependencies.getSecret(key, profile)?.trim());
  } catch {
    return false;
  }
}

/**
 * List only routes that can be copied into a fresh same-owner Agent Profile.
 * Provider records are the authority for named custom-provider existence;
 * model-library rows supply the concrete models; the secret store supplies
 * credential evidence without exposing credential values to the renderer.
 */
export function listResolvedAgentRuntimeModelRoutes(
  sourceProfileId: string,
  dependencies: RuntimeModelRouteDependencies = DEFAULT_DEPENDENCIES,
): ResolvedAgentRuntimeModelRoute[] {
  const providers = dependencies.listCustomProviders(sourceProfileId);
  const result: ResolvedAgentRuntimeModelRoute[] = [];

  for (const row of dependencies.readModels()) {
    const rowProvider = row.provider.trim();
    const rowEndpoint = normalizedEndpoint(row.baseUrl || "");
    if (isCustomProviderRoute(rowProvider)) {
      const rowAnchor = row.providerLabel
        ? customProviderEnvKey(row.providerLabel)
        : null;
      const provider = providers.find((candidate) => {
        if (row.providerId) return candidate.id === row.providerId;
        if (
          rowEndpoint &&
          normalizedEndpoint(candidate.baseUrl) !== rowEndpoint
        ) {
          return false;
        }
        return rowAnchor
          ? customProviderEnvKey(candidate.name) === rowAnchor
          : Boolean(rowEndpoint);
      });
      if (!provider) continue;
      if (
        !isLocalBaseUrl(provider.baseUrl) &&
        !hasSecret(
          customProviderEnvKey(provider.name),
          sourceProfileId,
          dependencies,
        )
      ) {
        continue;
      }
      result.push({
        id: `${sourceProfileId}\0${row.id}`,
        sourceProfileId,
        modelLibraryId: row.id,
        provider: `custom:${normalizeCustomProviderRuntimeName(provider.name)}`,
        providerLabel: provider.name,
        model: row.model,
        displayName: row.name || row.model,
        baseUrl: provider.baseUrl,
        apiMode: row.apiMode ?? null,
        credentialRef: customProviderEnvKey(provider.name),
      });
      continue;
    }

    const baseUrl = row.baseUrl || canonicalProviderBaseUrl(rowProvider) || "";
    if (!isLocalBaseUrl(baseUrl)) {
      const credentialKey = expectedEnvKeyForModel(rowProvider, baseUrl);
      if (
        !credentialKey ||
        !hasSecret(credentialKey, sourceProfileId, dependencies)
      ) {
        // OAuth credentials cannot be safely copied into an isolated Agent
        // Profile, so they are intentionally not advertised as install routes.
        if (dependencies.hasOAuthCredentials(rowProvider, sourceProfileId)) {
          continue;
        }
        continue;
      }
    }
    result.push({
      id: `${sourceProfileId}\0${row.id}`,
      sourceProfileId,
      modelLibraryId: row.id,
      provider: rowProvider,
      providerLabel: row.providerLabel || rowProvider,
      model: row.model,
      displayName: row.name || row.model,
      baseUrl,
      apiMode: row.apiMode ?? null,
      credentialRef: expectedEnvKeyForModel(rowProvider, baseUrl),
    });
  }

  return result;
}

/** Renderer-safe projection; credential anchors never cross this boundary. */
export function listAgentRuntimeModelRoutes(
  sourceProfileId: string,
  dependencies: RuntimeModelRouteDependencies = DEFAULT_DEPENDENCIES,
): AgentRuntimeModelRoute[] {
  return listResolvedAgentRuntimeModelRoutes(sourceProfileId, dependencies).map(
    ({ credentialRef: _credentialRef, ...route }) => route,
  );
}
