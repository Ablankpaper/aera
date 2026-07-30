import {
  getModelConfig,
  hasOAuthCredentials,
  setEnvValue,
  setModelConfig,
} from "../config";
import { expectedEnvKeyForModel } from "../installer";
import { readModels, type SavedModel } from "../models";
import { upsertNativeCustomProvider } from "../native-custom-provider";
import { listCustomProviders, upsertCustomProvider } from "../providers-store";
import { getSecret } from "../secrets";
import {
  isCustomProviderRoute,
  namedCustomProviderRuntimeName,
  normalizeCustomProviderRuntimeName,
} from "../../shared/custom-providers";
import { customProviderEnvKey } from "../../shared/url-key-map";
import type { AgentVersion } from "./client";

export interface AgentModelProfileSeedInput {
  sourceProfileId: string;
  targetProfileId: string;
  version: AgentVersion;
}

interface ModelProfileSeedDependencies {
  getModelConfig: typeof getModelConfig;
  hasOAuthCredentials: typeof hasOAuthCredentials;
  readModels: typeof readModels;
  listCustomProviders: typeof listCustomProviders;
  getSecret: typeof getSecret;
  upsertCustomProvider: typeof upsertCustomProvider;
  upsertNativeCustomProvider: typeof upsertNativeCustomProvider;
  setModelConfig: typeof setModelConfig;
  setEnvValue: typeof setEnvValue;
}

const DEFAULT_DEPENDENCIES: ModelProfileSeedDependencies = {
  getModelConfig,
  hasOAuthCredentials,
  readModels,
  listCustomProviders,
  getSecret,
  upsertCustomProvider,
  upsertNativeCustomProvider,
  setModelConfig,
  setEnvValue,
};

function normalizedEndpoint(value: string): string {
  return value.trim().replace(/\/+$/, "").toLocaleLowerCase();
}

function isLocalNoKeyEndpoint(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLocaleLowerCase();
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname.endsWith(".local")
    );
  } catch {
    return false;
  }
}

function matchingSavedModel(
  models: readonly SavedModel[],
  provider: string,
  model: string,
  baseUrl: string,
): SavedModel | null {
  const endpoint = normalizedEndpoint(baseUrl);
  const namedProvider = namedCustomProviderRuntimeName(provider);
  return (
    models.find((candidate) => {
      if (candidate.model.trim() !== model) return false;
      if (
        endpoint &&
        normalizedEndpoint(candidate.baseUrl || "") !== endpoint
      ) {
        return false;
      }
      if (namedProvider) {
        return (
          candidate.provider.trim().toLocaleLowerCase() === "custom" &&
          normalizeCustomProviderRuntimeName(
            candidate.providerLabel || candidate.name,
          ) === namedProvider
        );
      }
      return (
        candidate.provider.trim().toLocaleLowerCase() ===
        provider.trim().toLocaleLowerCase()
      );
    }) ?? null
  );
}

function resolveSignedSourceModel(
  version: AgentVersion,
  provider: string,
  currentModel: string,
  baseUrl: string,
  models: readonly SavedModel[],
): string {
  const allowedProviders =
    version.manifest.model_constraints.allowed_providers.map((value) =>
      value.trim().toLocaleLowerCase(),
    );
  const normalizedProvider = provider.trim().toLocaleLowerCase();
  const providerAllowed =
    allowedProviders.includes(normalizedProvider) ||
    (isCustomProviderRoute(provider) && allowedProviders.includes("custom"));
  if (!providerAllowed) {
    throw new Error(
      "The source Profile model is not allowed by the signed Agent version.",
    );
  }
  const allowedModels = version.manifest.model_constraints.allowed_models.map(
    (value) => value.trim(),
  );
  if (allowedModels.includes(currentModel)) return currentModel;
  const signedModel = allowedModels.find(
    (candidate) =>
      matchingSavedModel(models, provider, candidate, baseUrl) !== null,
  );
  if (!signedModel) {
    throw new Error(
      "The source Profile model is not allowed by the signed Agent version.",
    );
  }
  return signedModel;
}

function requireRemoteCredential(
  value: string | null,
  provider: string,
  baseUrl: string,
  sourceProfileId: string,
  dependencies: ModelProfileSeedDependencies,
): string | null {
  if (value?.trim()) return value;
  if (isLocalNoKeyEndpoint(baseUrl)) return null;
  if (dependencies.hasOAuthCredentials(provider, sourceProfileId)) {
    throw new Error(
      "OAuth-backed model credentials cannot be copied into an Agent Profile.",
    );
  }
  throw new Error(
    "The selected model credential is unavailable for the Agent Profile.",
  );
}

/**
 * Seed only the signed model route required by one installed Agent.
 *
 * The target remains a `cloneFrom=null` Profile: this function does not read or
 * copy Memory, USER, sessions, files, Skills, auth.json, or arbitrary env
 * entries. It resolves exactly one provider credential from a same-owner source
 * Profile and writes only that credential plus the matching model route.
 */
export function seedAgentModelProfile(
  input: AgentModelProfileSeedInput,
  dependencies: ModelProfileSeedDependencies = DEFAULT_DEPENDENCIES,
): void {
  const source = dependencies.getModelConfig(input.sourceProfileId);
  const provider = source.provider.trim();
  const currentModel = source.model.trim();
  const baseUrl = source.baseUrl.trim();
  if (!provider || provider === "auto" || !currentModel) {
    throw new Error("The source Profile has no configured model.");
  }
  const models = dependencies.readModels();
  const model = resolveSignedSourceModel(
    input.version,
    provider,
    currentModel,
    baseUrl,
    models,
  );
  const saved = matchingSavedModel(models, provider, model, baseUrl);
  const namedProvider = namedCustomProviderRuntimeName(provider);
  if (isCustomProviderRoute(provider)) {
    if (!baseUrl) {
      throw new Error("The selected custom model endpoint is unavailable.");
    }
    const providerRecord = dependencies
      .listCustomProviders(input.sourceProfileId)
      .find(
        (candidate) =>
          normalizedEndpoint(candidate.baseUrl) ===
            normalizedEndpoint(baseUrl) &&
          (!namedProvider ||
            normalizeCustomProviderRuntimeName(candidate.name) ===
              namedProvider),
      );
    const providerName =
      providerRecord?.name ||
      saved?.providerLabel ||
      (namedProvider ? namedProvider : saved?.name || "");
    if (!providerName.trim()) {
      throw new Error("The selected custom provider identity is unavailable.");
    }
    const credentialKey = customProviderEnvKey(providerName);
    const credential = requireRemoteCredential(
      dependencies.getSecret(credentialKey, input.sourceProfileId),
      provider,
      baseUrl,
      input.sourceProfileId,
      dependencies,
    );

    dependencies.upsertCustomProvider(input.targetProfileId, {
      name: providerName,
      baseUrl,
    });
    const nativeRoute = dependencies.upsertNativeCustomProvider(
      input.targetProfileId,
      {
        name: providerName,
        baseUrl,
        model,
        models: [model],
        apiMode: saved?.apiMode ?? undefined,
      },
    );
    const targetProvider = namedProvider ? nativeRoute : "custom";
    dependencies.setModelConfig(
      targetProvider,
      model,
      baseUrl,
      input.targetProfileId,
      saved?.contextLength,
      saved?.apiMode ?? undefined,
    );
    if (credential) {
      dependencies.setEnvValue(
        credentialKey,
        credential,
        input.targetProfileId,
      );
    }
    return;
  }

  const credentialKey = expectedEnvKeyForModel(provider, baseUrl);
  const credential = credentialKey
    ? requireRemoteCredential(
        dependencies.getSecret(credentialKey, input.sourceProfileId),
        provider,
        baseUrl,
        input.sourceProfileId,
        dependencies,
      )
    : null;
  dependencies.setModelConfig(
    provider,
    model,
    baseUrl,
    input.targetProfileId,
    saved?.contextLength,
    saved?.apiMode ?? undefined,
  );
  if (credentialKey && credential) {
    dependencies.setEnvValue(credentialKey, credential, input.targetProfileId);
  }
}
