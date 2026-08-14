import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  canonicalPublicRouteKey,
  type ModelConfigurationMutationRequest,
  type OwnerModelRouteCatalogSnapshot,
  type OwnerModelRouteSelection,
  type PublicModelRouteIdentity,
} from "../shared/model-configuration";
import {
  customProviderRuntimeRoute,
  isCustomProviderRoute,
  namedCustomProviderRuntimeName,
  normalizeCustomProviderRuntimeName,
} from "../shared/custom-providers";
import { isLocalBaseUrl, customProviderEnvKey } from "../shared/url-key-map";
import type {
  AgenteraRuntimeOwner,
  AgenteraProfileBindingStore,
} from "./agentera-profile-binding";
import {
  profileHome,
  profilePaths,
  isValidProfileName,
  getActiveProfileNameSync,
} from "./utils";
import { HERMES_HOME, expectedEnvKeyForModel } from "./installer";
import {
  getModelConfig,
  hasOAuthCredentials,
  setEnvValue,
  setModelConfig,
} from "./config";
import { validateModelConfiguration } from "./config-model-migration";
import {
  addModel,
  migrateModelsForCustomProvider,
  readModels,
  removeModel,
  removeModelsForCustomProvider,
  updateModel,
} from "./models";
import {
  listCustomProviders,
  removeCustomProvider,
  upsertCustomProvider,
} from "./providers-store";
import {
  removeNativeCustomProvider,
  upsertNativeCustomProvider,
} from "./native-custom-provider";
import { canonicalProviderBaseUrl } from "./provider-registry";
import { getSecret } from "./secrets";
import {
  listResolvedAgentRuntimeModelRoutes,
  type ResolvedAgentRuntimeModelRoute,
} from "./agentera-agent-control/runtime-model-routes";
import {
  OwnerModelRouteCatalog,
  type OwnerModelProfileDescriptor,
} from "./agentera-agent-control/owner-model-route-catalog";
import {
  ModelConfigurationCoordinator,
  type ModelConfigurationCommitStage,
  type ModelConfigurationMutationAdapter,
  type PreparedModelConfigurationMutation,
} from "./model-configuration-coordinator";
import {
  ModelConfigurationOperationStore,
  type ModelConfigurationOperationStore as ModelConfigurationOperationStoreType,
} from "./model-configuration-operation-store";
import {
  openModelConfigurationDatabase,
  type ModelConfigurationDatabase,
} from "./model-configuration-database";

/** Minimal connection shape needed to fail closed for remote/SSH writes. */
export interface ModelConfigurationRuntimeConnection {
  mode: "local" | "remote" | "ssh";
  remoteChatTransport?: "auto" | "dashboard" | "legacy";
  sshChatTransport?: "auto" | "dashboard" | "legacy";
}

export interface ModelConfigurationRuntimeOptions {
  userDataPath: string;
  getOwner: () => AgenteraRuntimeOwner;
  profileBindings: Pick<AgenteraProfileBindingStore, "verifyProfileBinding">;
  getConnectionConfig: () => ModelConfigurationRuntimeConnection;
  notifyConnectionConfigChanged?: (catalogRevision?: string) => void;
  notifyRuntimeSnapshotChanged?: (catalogRevision?: string) => void;
  notifyModelLibraryChanged?: (catalogRevision?: string) => void;
  notifyCustomProvidersChanged?: (catalogRevision?: string) => void;
  openDatabase?: typeof openModelConfigurationDatabase;
}

export interface ModelConfigurationRuntimeHandle {
  database: ModelConfigurationDatabase | null;
  operationStore: ModelConfigurationOperationStoreType | null;
  catalog: OwnerModelRouteCatalog | null;
  coordinator: ModelConfigurationCoordinator | null;
  /** Main-only adapter exposed for startup diagnostics/tests; never IPC. */
  mutationAdapter: ModelConfigurationMutationAdapter | null;
  recoveryError: unknown | null;
  close(): void;
}

/**
 * This is the same opaque owner key used by Agent control. Keeping the
 * encoding here avoids importing the large manager module during early app
 * startup and, importantly, keeps the owner tuple Main-only.
 */
export function runtimeComponentKey(owner: AgenteraRuntimeOwner): string {
  return `${owner.tenantId}\0${owner.ownerId}\0${owner.deviceInstallationId}`;
}

function ownerFromComponentKey(value: string): AgenteraRuntimeOwner | null {
  if (typeof value !== "string") return null;
  const fields = value.split("\0");
  if (fields.length !== 3 || fields.some((field) => field.length === 0)) {
    return null;
  }
  return {
    tenantId: fields[0],
    ownerId: fields[1],
    deviceInstallationId: fields[2],
  };
}

function normalizedEndpoint(value: string): string {
  return value.trim().replace(/\/+$/, "").toLocaleLowerCase();
}

function profileIdsSync(): string[] {
  const result = ["default"];
  const profilesRoot = join(HERMES_HOME, "profiles");
  let names: string[];
  try {
    names = readdirSync(profilesRoot).sort();
  } catch {
    return result;
  }
  for (const name of names) {
    if (!isValidProfileName(name) || name === "default") continue;
    try {
      if (statSync(join(profilesRoot, name)).isDirectory()) result.push(name);
    } catch {
      // A disappearing Profile is simply omitted from this snapshot.
    }
  }
  return result;
}

function listOwnedProfiles(
  owner: AgenteraRuntimeOwner,
  bindings: Pick<AgenteraProfileBindingStore, "verifyProfileBinding">,
): OwnerModelProfileDescriptor[] {
  const ownerKey = runtimeComponentKey(owner);
  const activeProfileId = getActiveProfileNameSync();
  const result: OwnerModelProfileDescriptor[] = [];
  for (const id of profileIdsSync()) {
    try {
      const binding = bindings.verifyProfileBinding(profileHome(id), owner);
      result.push({
        id,
        ownerKey,
        isDefault: id === "default",
        isActive: id === activeProfileId,
        agentInstallationId: binding.agentInstallationId,
      });
    } catch {
      // Do not expose unbound or foreign Profiles to the catalog.
    }
  }
  return result;
}

function providerEquivalent(left: string, right: string): boolean {
  const a = left.trim().toLocaleLowerCase();
  const b = right.trim().toLocaleLowerCase();
  if (a === b) return true;
  if (isCustomProviderRoute(a) && isCustomProviderRoute(b)) {
    const aName = namedCustomProviderRuntimeName(a);
    const bName = namedCustomProviderRuntimeName(b);
    // A legacy bare `custom` route can only be matched to a named route when
    // the caller has no better identity; the model row/provider label check
    // below supplies that missing discriminator.
    return aName !== null && bName !== null && aName === bName;
  }
  return false;
}

function routeMatchesConfig(
  route: ResolvedAgentRuntimeModelRoute,
  config: { provider: string; model: string; baseUrl: string },
): boolean {
  if (route.model !== config.model) return false;
  const configEndpoint = normalizedEndpoint(
    config.baseUrl || canonicalProviderBaseUrl(config.provider) || "",
  );
  const routeEndpoint = normalizedEndpoint(route.baseUrl);
  if (configEndpoint !== routeEndpoint) return false;
  if (providerEquivalent(route.provider, config.provider)) return true;
  if (isCustomProviderRoute(config.provider) && route.providerLabel) {
    const named = namedCustomProviderRuntimeName(config.provider);
    return (
      named === normalizeCustomProviderRuntimeName(route.providerLabel) ||
      (named === null && isCustomProviderRoute(route.provider))
    );
  }
  return false;
}

function activeRouteIdentity(profileId: string): PublicModelRouteIdentity {
  const config = getModelConfig(profileId);
  const routes = listResolvedAgentRuntimeModelRoutes(profileId);
  const resolved = routes.find((route) => routeMatchesConfig(route, config));
  if (resolved) {
    return {
      provider: resolved.provider,
      model: resolved.model,
      baseUrl: resolved.baseUrl,
      apiMode: resolved.apiMode,
    };
  }
  const library = readModels().find(
    (candidate) =>
      candidate.model === config.model &&
      normalizedEndpoint(candidate.baseUrl || "") ===
        normalizedEndpoint(config.baseUrl || "") &&
      providerEquivalent(candidate.provider, config.provider),
  );
  return {
    provider: config.provider,
    model: config.model,
    baseUrl: config.baseUrl || canonicalProviderBaseUrl(config.provider) || "",
    apiMode: library?.apiMode ?? null,
  };
}

function routeForSelection(
  catalog: OwnerModelRouteCatalogSnapshot,
  selection: OwnerModelRouteSelection,
): OwnerModelRouteCatalogSnapshot["routes"][number] | null {
  if (selection.catalogRevision !== catalog.revision) return null;
  return (
    catalog.routes.find(
      (route) =>
        route.selection.sourceProfileId === selection.sourceProfileId &&
        route.selection.modelLibraryId === selection.modelLibraryId,
    ) ?? null
  );
}

export function isActiveProviderRoute(
  active: PublicModelRouteIdentity,
  providerLabel: string,
  providerRecordBaseUrl: string,
): boolean {
  const normalizedLabel = normalizeCustomProviderRuntimeName(providerLabel);
  const named = namedCustomProviderRuntimeName(active.provider);
  if (named && named === normalizedLabel) return true;
  // Named custom routes are distinct identities even when they intentionally
  // share an endpoint. Endpoint fallback is reserved for legacy bare custom.
  if (named) return false;
  if (isCustomProviderRoute(active.provider)) {
    return (
      normalizedEndpoint(active.baseUrl) ===
      normalizedEndpoint(providerRecordBaseUrl)
    );
  }
  return (
    active.provider.toLocaleLowerCase() === providerLabel.toLocaleLowerCase()
  );
}

function routeKeyForRequest(
  request: Extract<ModelConfigurationMutationRequest, { intent: "upsert" }>,
  runtimeProvider: string,
): string {
  const baseUrl =
    request.baseUrl.trim() || canonicalProviderBaseUrl(request.provider) || "";
  return canonicalPublicRouteKey({
    provider: runtimeProvider,
    model: request.activeModel.trim(),
    baseUrl,
    apiMode: request.apiMode,
  });
}

function modelLibraryProvider(provider: string): string {
  return isCustomProviderRoute(provider) ? "custom" : provider.trim();
}

function createMutationAdapter(
  options: ModelConfigurationRuntimeOptions,
  catalog: OwnerModelRouteCatalog,
): ModelConfigurationMutationAdapter {
  return {
    getActiveRouteKey: (profileId) =>
      canonicalPublicRouteKey(activeRouteIdentity(profileId)),

    prepare: (request, context) => {
      const connection = options.getConnectionConfig();
      if (connection.mode !== "local") {
        throw Object.assign(
          new Error(
            "Coordinated local model writes require local Runtime mode.",
          ),
          { code: "model_configuration_remote_unsupported" },
        );
      }

      if (request.intent === "upsert") {
        const provider = request.provider.trim();
        const providerLabel =
          request.providerLabel.trim() ||
          namedCustomProviderRuntimeName(provider) ||
          provider;
        const custom = isCustomProviderRoute(provider);
        if (custom && !providerLabel.trim()) {
          throw new Error("A named custom provider is required.");
        }
        const baseUrl =
          request.baseUrl.trim() || canonicalProviderBaseUrl(provider) || "";
        const requestedProviderId = request.providerId?.trim() || "";
        const providers = custom
          ? listCustomProviders(context.targetProfileId)
          : [];
        const existingProvider = requestedProviderId
          ? providers.find((candidate) => candidate.id === requestedProviderId)
          : providers.find(
              (candidate) =>
                customProviderEnvKey(candidate.name) ===
                customProviderEnvKey(providerLabel),
            );
        if (requestedProviderId && !existingProvider) {
          throw new Error("Custom provider identity was not found.");
        }
        const previousProviderName = existingProvider?.name || "";
        const previousProviderBaseUrl = existingProvider?.baseUrl || "";
        let persistedProviderId = existingProvider?.id;
        const credentialRef = custom
          ? customProviderEnvKey(providerLabel)
          : expectedEnvKeyForModel(provider, baseUrl);
        const previousCredentialRef = existingProvider
          ? customProviderEnvKey(existingProvider.name)
          : "";
        const existingCredential = credentialRef
          ? getSecret(credentialRef, context.targetProfileId)?.trim() ||
            (previousCredentialRef && previousCredentialRef !== credentialRef
              ? getSecret(
                  previousCredentialRef,
                  context.targetProfileId,
                )?.trim() || ""
              : "")
          : "";
        if (
          !isLocalBaseUrl(baseUrl) &&
          !request.apiKey.trim() &&
          !existingCredential
        ) {
          if (hasOAuthCredentials(provider, context.targetProfileId)) {
            throw new Error(
              "OAuth-backed model credentials cannot be used by this local mutation.",
            );
          }
          throw new Error("The selected model credential is unavailable.");
        }

        const runtimeProvider = custom
          ? customProviderRuntimeRoute(providerLabel)
          : provider;
        const oldRouteKey = canonicalPublicRouteKey(
          activeRouteIdentity(context.targetProfileId),
        );
        const newRouteKey = routeKeyForRequest(request, runtimeProvider);
        const activeModel = request.models.find(
          (model) => model.model.trim() === request.activeModel.trim(),
        );
        const applyStage = async (
          stage: ModelConfigurationCommitStage,
        ): Promise<void> => {
          switch (stage) {
            case "credential":
              if (
                credentialRef &&
                (request.apiKey.trim() || existingCredential)
              ) {
                setEnvValue(
                  credentialRef,
                  request.apiKey.trim() || existingCredential,
                  context.targetProfileId,
                );
              }
              if (
                previousCredentialRef &&
                previousCredentialRef !== credentialRef
              ) {
                setEnvValue(previousCredentialRef, "", context.targetProfileId);
              }
              return;
            case "provider":
              if (custom) {
                const persisted = upsertCustomProvider(
                  context.targetProfileId,
                  {
                    id: existingProvider?.id,
                    name: providerLabel,
                    baseUrl,
                  },
                );
                persistedProviderId = persisted?.id;
              }
              return;
            case "model_library":
              if (custom && persistedProviderId) {
                migrateModelsForCustomProvider({
                  providerId: persistedProviderId,
                  oldName: previousProviderName,
                  oldBaseUrl: previousProviderBaseUrl,
                  newName: providerLabel,
                  newBaseUrl: baseUrl,
                  apiMode: request.apiMode,
                });
              }
              for (const model of request.models) {
                const saved = addModel(
                  model.displayName.trim() || model.model.trim(),
                  modelLibraryProvider(provider),
                  model.model.trim(),
                  baseUrl,
                  model.contextLength,
                  custom ? providerLabel : undefined,
                  request.apiMode,
                  persistedProviderId,
                );
                // `addModel` intentionally deduplicates legacy rows without
                // rewriting their provider label. Repair that identity here so
                // a cosmetic provider rename cannot leave a stale catalog.
                if (
                  custom &&
                  ((saved.providerLabel || "") !== providerLabel ||
                    (saved.providerId || "") !== (persistedProviderId || ""))
                ) {
                  const row = readModels().find(
                    (candidate) => candidate.id === saved.id,
                  );
                  if (row) {
                    updateModel(saved.id, {
                      providerId: persistedProviderId,
                      providerLabel,
                      name: model.displayName.trim() || model.model.trim(),
                      apiMode: request.apiMode,
                    });
                  }
                }
              }
              return;
            case "native_route":
              if (custom) {
                upsertNativeCustomProvider(context.targetProfileId, {
                  name: providerLabel,
                  baseUrl,
                  previousName: previousProviderName || undefined,
                  model: request.activeModel.trim(),
                  models: request.models.map((model) => model.model.trim()),
                  apiMode: request.apiMode,
                });
              }
              return;
            case "activation":
              setModelConfig(
                runtimeProvider,
                request.activeModel.trim(),
                baseUrl,
                context.targetProfileId,
                activeModel?.contextLength ?? null,
                request.apiMode,
              );
              return;
          }
        };

        const prepared: PreparedModelConfigurationMutation = {
          targetProfileId: context.targetProfileId,
          oldRouteKey,
          newRouteKey,
          location: { kind: "local" },
          applyStage,
          verify: async (snapshot) => {
            const routeExists = snapshot.routes.some(
              (route) =>
                route.sourceProfileId === context.targetProfileId &&
                canonicalPublicRouteKey(route) === newRouteKey,
            );
            const routeMatches =
              routeExists &&
              canonicalPublicRouteKey(
                activeRouteIdentity(context.targetProfileId),
              ) === newRouteKey;
            if (!routeMatches) return false;

            // Final structural guard: the activation stage wrote the profile's
            // config.yaml. If that write left duplicate `model:` keys or a
            // broken `providers:` block (e.g. untouched legacy scalar format),
            // a later read will fail to parse. Reject so the coordinator
            // restores the snapshot instead of committing corrupt config.
            const { configFile } = profilePaths(context.targetProfileId);
            if (existsSync(configFile)) {
              try {
                validateModelConfiguration(readFileSync(configFile, "utf-8"));
              } catch {
                return false;
              }
            }
            return true;
          },
          refreshPresentation: async () => {
            const revision = catalog.snapshot(context.targetProfileId).revision;
            options.notifyModelLibraryChanged?.(revision);
            if (custom) options.notifyCustomProvidersChanged?.(revision);
            options.notifyConnectionConfigChanged?.(revision);
            options.notifyRuntimeSnapshotChanged?.(revision);
          },
        };
        return prepared;
      }

      const providerLabel = request.providerLabel.trim();
      if (!providerLabel) throw new Error("A provider label is required.");
      const providerRecord = listCustomProviders(context.targetProfileId).find(
        (candidate) =>
          customProviderEnvKey(candidate.name) ===
          customProviderEnvKey(providerLabel),
      );
      const providerBaseUrl = providerRecord?.baseUrl || "";
      const active = activeRouteIdentity(context.targetProfileId);
      const activeProvider = isActiveProviderRoute(
        active,
        providerLabel,
        providerBaseUrl,
      );
      const replacement = request.replacement
        ? routeForSelection(context.catalog, request.replacement)
        : null;
      if (activeProvider && !replacement) {
        throw Object.assign(
          new Error("An active model route requires a replacement."),
          { code: "active_route_requires_replacement" },
        );
      }
      if (
        replacement &&
        replacement.sourceProfileId !== context.targetProfileId
      ) {
        throw new Error("Replacement route must belong to the target Profile.");
      }
      const oldRouteKey = canonicalPublicRouteKey(active);
      const newRouteKey = replacement
        ? canonicalPublicRouteKey(replacement)
        : oldRouteKey;
      const providerAnchor = customProviderEnvKey(providerLabel);
      const matchingRows = readModels().filter((candidate) => {
        const labelMatches =
          isCustomProviderRoute(candidate.provider) &&
          customProviderEnvKey(candidate.providerLabel || candidate.name) ===
            providerAnchor;
        const providerMatches =
          candidate.provider.toLocaleLowerCase() ===
          providerLabel.toLocaleLowerCase();
        return labelMatches || providerMatches;
      });
      const credentialRef = providerRecord
        ? customProviderEnvKey(providerRecord.name)
        : expectedEnvKeyForModel(active.provider, active.baseUrl);
      const applyStage = async (
        stage: ModelConfigurationCommitStage,
      ): Promise<void> => {
        switch (stage) {
          case "credential":
            if (credentialRef) {
              setEnvValue(credentialRef, "", context.targetProfileId);
            }
            return;
          case "provider":
            if (providerRecord) {
              removeCustomProvider(
                context.targetProfileId,
                providerRecord.name,
              );
            }
            return;
          case "model_library":
            if (providerRecord) {
              removeModelsForCustomProvider(
                providerRecord.name,
                providerRecord.baseUrl,
                providerRecord.id,
              );
            } else {
              for (const row of matchingRows) removeModel(row.id);
            }
            return;
          case "native_route":
            if (providerRecord) {
              removeNativeCustomProvider(
                context.targetProfileId,
                providerRecord.name,
              );
            }
            return;
          case "activation":
            if (replacement) {
              setModelConfig(
                replacement.provider,
                replacement.model,
                replacement.baseUrl,
                context.targetProfileId,
                null,
                replacement.apiMode,
              );
            }
            return;
        }
      };
      return {
        targetProfileId: context.targetProfileId,
        oldRouteKey,
        newRouteKey,
        location: { kind: "local" },
        applyStage,
        verify: async (snapshot) => {
          if (!activeProvider) return true;
          return (
            replacement !== null &&
            snapshot.routes.some(
              (route) =>
                route.sourceProfileId === context.targetProfileId &&
                canonicalPublicRouteKey(route) === newRouteKey,
            ) &&
            canonicalPublicRouteKey(
              activeRouteIdentity(context.targetProfileId),
            ) === newRouteKey
          );
        },
        refreshPresentation: async () => {
          const revision = catalog.snapshot(context.targetProfileId).revision;
          options.notifyModelLibraryChanged?.(revision);
          options.notifyCustomProvidersChanged?.(revision);
          options.notifyConnectionConfigChanged?.(revision);
          options.notifyRuntimeSnapshotChanged?.(revision);
        },
      } satisfies PreparedModelConfigurationMutation;
    },
  };
}

function createCatalog(
  options: ModelConfigurationRuntimeOptions,
): OwnerModelRouteCatalog {
  return new OwnerModelRouteCatalog({
    getOwnerKey: () => runtimeComponentKey(options.getOwner()),
    getActiveProfileId: getActiveProfileNameSync,
    listProfiles: () => {
      const owner = options.getOwner();
      return listOwnedProfiles(owner, options.profileBindings);
    },
    listResolvedRoutes: (profileId) =>
      listResolvedAgentRuntimeModelRoutes(profileId),
    resolveRoute: (sourceProfileId, modelLibraryId) =>
      listResolvedAgentRuntimeModelRoutes(sourceProfileId).find(
        (route) => route.modelLibraryId === modelLibraryId,
      ) ?? null,
  });
}

/**
 * Open the independent journal and finish crash recovery before the caller
 * registers the coordinated IPC channels. A failure intentionally leaves the
 * coordinator absent; the bridge then returns the bounded recovery-required
 * result while legacy read-only surfaces remain usable.
 */
export async function prepareModelConfigurationRuntime(
  options: ModelConfigurationRuntimeOptions,
): Promise<ModelConfigurationRuntimeHandle> {
  let database: ModelConfigurationDatabase | null = null;
  let operationStore: ModelConfigurationOperationStoreType | null = null;
  let catalog: OwnerModelRouteCatalog | null = null;
  let coordinator: ModelConfigurationCoordinator | null = null;
  let mutationAdapter: ModelConfigurationMutationAdapter | null = null;
  let recoveryError: unknown | null = null;

  try {
    catalog = createCatalog(options);
    database = (options.openDatabase ?? openModelConfigurationDatabase)(
      options.userDataPath,
    );
    operationStore = new ModelConfigurationOperationStore(database);
    mutationAdapter = createMutationAdapter(options, catalog);
    coordinator = new ModelConfigurationCoordinator({
      catalog,
      ownerHandle: () => runtimeComponentKey(options.getOwner()),
      operationStore,
      mutationAdapter,
      isProfileOwned: (ownerHandle, profileId) => {
        const owner = ownerFromComponentKey(ownerHandle);
        if (!owner) return false;
        try {
          options.profileBindings.verifyProfileBinding(
            profileHome(profileId),
            owner,
          );
          return true;
        } catch {
          return false;
        }
      },
    });
    await coordinator.recoverIncompleteOperations();
  } catch (error) {
    recoveryError = error;
    coordinator = null;
  }

  return {
    database,
    operationStore,
    catalog,
    coordinator,
    mutationAdapter,
    recoveryError,
    close: () => database?.close(),
  };
}
