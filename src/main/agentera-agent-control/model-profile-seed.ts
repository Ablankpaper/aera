import {
  getModelConfig,
  hasOAuthCredentials,
  setEnvValue,
  setModelConfig,
} from "../config";
import { expectedEnvKeyForModel } from "../installer";
import { readModels, type SavedModel } from "../models";
import { upsertNativeCustomProvider } from "../native-custom-provider";
import { canonicalProviderBaseUrl } from "../provider-registry";
import { listCustomProviders, upsertCustomProvider } from "../providers-store";
import { getSecret } from "../secrets";
import {
  isCustomProviderRoute,
  namedCustomProviderRuntimeName,
  normalizeCustomProviderRuntimeName,
} from "../../shared/custom-providers";
import { canonicalPublicRouteKey } from "../../shared/model-configuration";
import { customProviderEnvKey } from "../../shared/url-key-map";
import { currentModelConfigurationWritePermit } from "../model-configuration-managed-files";
import {
  requireManagedModelMutationValue,
  type ManagedModelMutationPort,
} from "../model-configuration-mutation-port";
import type { AgentPolicySnapshot, AgentVersion } from "./client";
import {
  agentModelPolicyAllowsRoute,
  modelPolicyForManifest,
  modelPolicyForPolicyDocument,
} from "./model-policy";

export interface AgentModelProfileSeedInput {
  sourceProfileId: string;
  sourceModelId?: string;
  targetProfileId: string;
  version: AgentVersion;
  policy: AgentPolicySnapshot;
}

export interface ModelProfileSeedDependencies {
  getModelConfig: typeof getModelConfig;
  hasOAuthCredentials: typeof hasOAuthCredentials;
  readModels: typeof readModels;
  listCustomProviders: typeof listCustomProviders;
  getSecret: typeof getSecret;
  upsertCustomProvider: typeof upsertCustomProvider;
  upsertNativeCustomProvider: typeof upsertNativeCustomProvider;
  setModelConfig: typeof setModelConfig;
  setEnvValue: typeof setEnvValue;
  modelMutationPort?: ManagedModelMutationPort;
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

let configuredModelMutationPort: ManagedModelMutationPort | null = null;

export function configureAgentModelProfileSeedMutationPort(
  modelMutationPort: ManagedModelMutationPort | null,
): void {
  configuredModelMutationPort = modelMutationPort;
}

async function executeManagedProfileSeed(
  targetProfileId: string,
  route: {
    provider: string;
    model: string;
    baseUrl: string;
    apiMode: string | null;
  },
  write: () => void,
  dependencies: ModelProfileSeedDependencies,
): Promise<void> {
  // A staged Profile already holds the opaque ordered-write permit supplied by
  // the candidate. Re-entering the coordinator here would reject nested lock
  // acquisition; the candidate still scopes every managed path to its isolated
  // root and revalidates the complete tree before activation.
  if (currentModelConfigurationWritePermit()) {
    write();
    return;
  }
  const modelMutationPort =
    dependencies.modelMutationPort ?? configuredModelMutationPort;
  if (!modelMutationPort) {
    throw new Error("model_configuration_mutation_unavailable");
  }
  const result = await modelMutationPort.mutate({
    operation: "agent_model_profile_seed",
    globalCatalog: false,
    profileIds: [targetProfileId],
    stage: "activation",
    prepare: () => ({
      newRouteKey: canonicalPublicRouteKey(route),
      write: () => write(),
    }),
  });
  requireManagedModelMutationValue(result);
}

function normalizedEndpoint(value: string): string {
  return value.trim().replace(/\/+$/, "").toLowerCase();
}

function isLocalNoKeyEndpoint(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
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
          candidate.provider.trim().toLowerCase() === "custom" &&
          normalizeCustomProviderRuntimeName(
            candidate.providerLabel || candidate.name,
          ) === namedProvider
        );
      }
      return (
        candidate.provider.trim().toLowerCase() ===
        provider.trim().toLowerCase()
      );
    }) ?? null
  );
}

function resolveSignedSourceModel(
  version: AgentVersion,
  policy: AgentPolicySnapshot,
  provider: string,
  currentModel: string,
  baseUrl: string,
  models: readonly SavedModel[],
  exactSelection: boolean,
): string {
  const versionPolicy = modelPolicyForManifest(version.manifest);
  const effectivePolicy = modelPolicyForPolicyDocument(policy.document);
  const allows = (candidate: string): boolean =>
    agentModelPolicyAllowsRoute(versionPolicy, provider, candidate) &&
    agentModelPolicyAllowsRoute(effectivePolicy, provider, candidate);
  if (allows(currentModel)) return currentModel;
  if (exactSelection) {
    throw new Error(
      "The selected model route is not allowed by the signed effective policy.",
    );
  }
  const candidates = [
    ...new Set([
      ...versionPolicy.allowedModels,
      ...effectivePolicy.allowedModels,
    ]),
  ];
  const signedModel = candidates.find(
    (candidate) =>
      allows(candidate) &&
      matchingSavedModel(models, provider, candidate, baseUrl) !== null,
  );
  if (!signedModel) {
    throw new Error(
      "The source Profile model is not allowed by the signed effective policy.",
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
export async function seedAgentModelProfile(
  input: AgentModelProfileSeedInput,
  dependencies: ModelProfileSeedDependencies = DEFAULT_DEPENDENCIES,
): Promise<void> {
  const source = dependencies.getModelConfig(input.sourceProfileId);
  const models = dependencies.readModels();
  const selected = input.sourceModelId
    ? (models.find((candidate) => candidate.id === input.sourceModelId) ?? null)
    : null;
  if (input.sourceModelId && !selected) {
    throw new Error("The selected model route is no longer available.");
  }
  let provider = source.provider.trim();
  let currentModel = source.model.trim();
  let baseUrl = source.baseUrl.trim();
  if (selected) {
    currentModel = selected.model.trim();
    if (isCustomProviderRoute(selected.provider)) {
      const selectedEndpoint = normalizedEndpoint(selected.baseUrl || "");
      const selectedAnchor = selected.providerLabel
        ? customProviderEnvKey(selected.providerLabel)
        : null;
      if (!selectedEndpoint && !selectedAnchor) {
        throw new Error(
          "The selected custom provider identity is unavailable.",
        );
      }
      const record = dependencies
        .listCustomProviders(input.sourceProfileId)
        .find(
          (candidate) =>
            (!selectedEndpoint ||
              normalizedEndpoint(candidate.baseUrl) === selectedEndpoint) &&
            (!selectedAnchor ||
              customProviderEnvKey(candidate.name) === selectedAnchor),
        );
      if (!record) {
        throw new Error("The selected custom provider is no longer available.");
      }
      provider = `custom:${normalizeCustomProviderRuntimeName(record.name)}`;
      baseUrl = record.baseUrl.trim();
    } else {
      provider = selected.provider.trim();
      baseUrl =
        selected.baseUrl.trim() || canonicalProviderBaseUrl(provider) || "";
    }
  }
  if (!provider || provider.toLowerCase() === "auto" || !currentModel) {
    throw new Error("The source Profile has no configured model.");
  }
  const model = resolveSignedSourceModel(
    input.version,
    input.policy,
    provider,
    currentModel,
    baseUrl,
    models,
    Boolean(selected),
  );
  const alreadyCompatibleInPlace =
    input.sourceProfileId === input.targetProfileId &&
    model === source.model.trim() &&
    provider.toLowerCase() === source.provider.trim().toLowerCase() &&
    normalizedEndpoint(baseUrl) === normalizedEndpoint(source.baseUrl);
  const saved =
    selected && selected.model.trim() === model
      ? selected
      : matchingSavedModel(models, provider, model, baseUrl);
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
    if (alreadyCompatibleInPlace) return;

    const targetProvider = namedProvider
      ? `custom:${normalizeCustomProviderRuntimeName(providerName)}`
      : "custom";
    await executeManagedProfileSeed(
      input.targetProfileId,
      {
        provider: targetProvider,
        model,
        baseUrl,
        apiMode: saved?.apiMode ?? null,
      },
      () => {
        if (credential) {
          dependencies.setEnvValue(
            credentialKey,
            credential,
            input.targetProfileId,
          );
        }
        dependencies.upsertCustomProvider(input.targetProfileId, {
          name: providerName,
          baseUrl,
        });
        dependencies.upsertNativeCustomProvider(input.targetProfileId, {
          name: providerName,
          baseUrl,
          model,
          models: [model],
          apiMode: saved?.apiMode ?? undefined,
        });
        dependencies.setModelConfig(
          targetProvider,
          model,
          baseUrl,
          input.targetProfileId,
          saved?.contextLength,
          saved?.apiMode ?? undefined,
        );
      },
      dependencies,
    );
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
  if (alreadyCompatibleInPlace) return;
  await executeManagedProfileSeed(
    input.targetProfileId,
    {
      provider,
      model,
      baseUrl,
      apiMode: saved?.apiMode ?? null,
    },
    () => {
      if (credentialKey && credential) {
        dependencies.setEnvValue(
          credentialKey,
          credential,
          input.targetProfileId,
        );
      }
      dependencies.setModelConfig(
        provider,
        model,
        baseUrl,
        input.targetProfileId,
        saved?.contextLength,
        saved?.apiMode ?? undefined,
      );
    },
    dependencies,
  );
}
