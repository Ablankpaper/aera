import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";

import {
  canonicalPublicRouteKey,
  type ModelConfigurationMutationRequest,
  type ModelConfigurationStartupFailure,
  type ModelConfigurationStartupFailureCode,
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
  getConfigValue,
  getModelConfig,
  getModelConfigFresh,
  invalidateModelConfigCache,
  hasOAuthCredentials,
  planEnvValueWrite,
  planModelConfigWrite,
  persistConfigWritePlan,
} from "./config";
import { validateModelConfiguration } from "./config-model-migration";
import {
  initializeModelCatalog,
  planAddModel,
  planModelCatalogInitialization,
  planMigrateModelsForCustomProvider,
  planRemoveModel,
  planRemoveModelsForCustomProvider,
  planUpdateModel,
  persistModelCatalogWritePlan,
  readModels,
  type ModelCatalogWritePlan,
} from "./models";
import {
  listCustomProviders,
  persistCustomProviderPlan,
  planCustomProviderRemoval,
  planCustomProviderUpsert,
} from "./providers-store";
import {
  persistNativeCustomProviderPlan,
  planNativeCustomProviderRemoval,
  planNativeCustomProviderUpsert,
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
  type ManagedModelFileInitialization,
  type ModelConfigurationMutationAdapter,
  type PreparedModelConfigurationMutation,
} from "./model-configuration-coordinator";
import {
  ModelConfigurationOperationStore,
  type ModelConfigurationOperationStore as ModelConfigurationOperationStoreType,
  captureModelConfigurationFiles,
  defaultModelConfigurationFilePaths,
  type ModelConfigurationFilePaths,
  type ModelConfigurationFileRole,
} from "./model-configuration-operation-store";
import {
  ModelConfigurationRuntimeError,
  openModelConfigurationDatabase,
  type ModelConfigurationDatabase,
} from "./model-configuration-database";
import {
  registerManagedModelFileRoots,
  writeManagedModelFile,
} from "./model-configuration-managed-files";
import { recoverStagedProfileActivations as recoverStagedProfileActivationJournal } from "./model-configuration-staged-profile";
import {
  planModelRouteDirectoryRepair,
  type ModelRouteDirectorySnapshot,
  type RouteRepairPlan,
} from "./model-configuration-reconciler";

export {
  planModelRouteDirectoryRepair,
  type ManagedModelFilePatch,
  type ModelRouteDirectorySnapshot,
  type RouteRepairPlan,
} from "./model-configuration-reconciler";

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
  recoverStagedProfileActivations?: typeof recoverStagedProfileActivationJournal;
}

export interface ModelConfigurationRuntimeHandle {
  database: ModelConfigurationDatabase | null;
  operationStore: ModelConfigurationOperationStoreType | null;
  catalog: OwnerModelRouteCatalog | null;
  coordinator: ModelConfigurationCoordinator | null;
  /** Main-only adapter exposed for startup diagnostics/tests; never IPC. */
  mutationAdapter: ModelConfigurationMutationAdapter | null;
  /** Stable, Renderer-safe identity for an unavailable startup boundary. */
  startupFailure: ModelConfigurationStartupFailure | null;
  /** Main-only original failure retained for local diagnostics. */
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

function activeRouteIdentity(
  profileId: string,
  fresh = false,
): PublicModelRouteIdentity {
  const config = fresh
    ? getModelConfigFresh(profileId)
    : getModelConfig(profileId);
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
    apiMode: library?.apiMode ?? getConfigValue("model.api_mode", profileId),
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
      canonicalPublicRouteKey(activeRouteIdentity(profileId, true)),

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
        let credentialPlan: ReturnType<typeof planEnvValueWrite> | undefined;
        if (credentialRef && (request.apiKey.trim() || existingCredential)) {
          credentialPlan = planEnvValueWrite(
            credentialRef,
            request.apiKey.trim() || existingCredential,
            context.targetProfileId,
          );
        }
        if (previousCredentialRef && previousCredentialRef !== credentialRef) {
          credentialPlan = planEnvValueWrite(
            previousCredentialRef,
            "",
            context.targetProfileId,
            credentialPlan,
          );
        }

        const providerPlan = custom
          ? planCustomProviderUpsert(context.targetProfileId, {
              id: existingProvider?.id,
              name: providerLabel,
              baseUrl,
            })
          : null;
        const persistedProviderId = providerPlan?.value?.id;

        let modelPlan: ModelCatalogWritePlan<unknown> | undefined;
        if (custom && persistedProviderId) {
          modelPlan = planMigrateModelsForCustomProvider(
            {
              providerId: persistedProviderId,
              oldName: previousProviderName,
              oldBaseUrl: previousProviderBaseUrl,
              newName: providerLabel,
              newBaseUrl: baseUrl,
              apiMode: request.apiMode,
            },
            modelPlan,
          );
        }
        for (const model of request.models) {
          const addPlan = planAddModel(
            model.displayName.trim() || model.model.trim(),
            modelLibraryProvider(provider),
            model.model.trim(),
            baseUrl,
            model.contextLength,
            custom ? providerLabel : undefined,
            request.apiMode,
            persistedProviderId,
            modelPlan,
          );
          const saved = addPlan.value;
          modelPlan = addPlan;
          // A stable provider may absorb a legacy row. Normalize the absorbed
          // attachment in the same virtual catalog before the single write.
          if (
            custom &&
            ((saved.providerLabel || "") !== providerLabel ||
              (saved.providerId || "") !== (persistedProviderId || ""))
          ) {
            modelPlan = planUpdateModel(
              saved.id,
              {
                providerId: persistedProviderId,
                providerLabel,
                name: model.displayName.trim() || model.model.trim(),
                apiMode: request.apiMode,
              },
              modelPlan,
            );
          }
        }

        const nativePlan = custom
          ? planNativeCustomProviderUpsert(context.targetProfileId, {
              name: providerLabel,
              baseUrl,
              previousName: previousProviderName || undefined,
              model: request.activeModel.trim(),
              models: request.models.map((model) => model.model.trim()),
              apiMode: request.apiMode,
            })
          : undefined;
        // Native provider metadata and active route share config.yaml. Compose
        // both edits into one stale-checked plan and persist it once at the
        // activation stage so neither edit can overwrite the other.
        const activationPlan = planModelConfigWrite(
          runtimeProvider,
          request.activeModel.trim(),
          baseUrl,
          context.targetProfileId,
          activeModel?.contextLength ?? null,
          request.apiMode,
          nativePlan,
        );
        const applyStage = async (
          stage: ModelConfigurationCommitStage,
          permit: Parameters<typeof persistConfigWritePlan>[0],
        ): Promise<void> => {
          switch (stage) {
            case "credential":
              if (credentialPlan) {
                persistConfigWritePlan(permit, credentialPlan);
              }
              return;
            case "provider":
              if (providerPlan) {
                persistCustomProviderPlan(permit, providerPlan);
              }
              return;
            case "model_library":
              if (modelPlan) {
                persistModelCatalogWritePlan(permit, modelPlan);
              }
              return;
            case "native_route":
              return;
            case "activation":
              persistConfigWritePlan(permit, activationPlan);
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
      const credentialPlan = credentialRef
        ? planEnvValueWrite(credentialRef, "", context.targetProfileId)
        : undefined;
      const providerPlan = providerRecord
        ? planCustomProviderRemoval(
            context.targetProfileId,
            providerRecord.name,
          )
        : undefined;
      let modelPlan: ModelCatalogWritePlan<unknown> | undefined;
      if (providerRecord) {
        modelPlan = planRemoveModelsForCustomProvider(
          providerRecord.name,
          providerRecord.baseUrl,
          providerRecord.id,
          modelPlan,
        );
      } else {
        for (const row of matchingRows) {
          modelPlan = planRemoveModel(row.id, modelPlan);
        }
      }
      const nativePlan = providerRecord
        ? planNativeCustomProviderRemoval(
            context.targetProfileId,
            providerRecord.name,
          )
        : undefined;
      const activationPlan = replacement
        ? planModelConfigWrite(
            replacement.provider,
            replacement.model,
            replacement.baseUrl,
            context.targetProfileId,
            null,
            replacement.apiMode,
            nativePlan,
          )
        : undefined;
      const applyStage = async (
        stage: ModelConfigurationCommitStage,
        permit: Parameters<typeof persistConfigWritePlan>[0],
      ): Promise<void> => {
        switch (stage) {
          case "credential":
            if (credentialPlan) {
              persistConfigWritePlan(permit, credentialPlan);
            }
            return;
          case "provider":
            if (providerPlan) {
              persistCustomProviderPlan(permit, providerPlan);
            }
            return;
          case "model_library":
            if (modelPlan) {
              persistModelCatalogWritePlan(permit, modelPlan);
            }
            return;
          case "native_route":
            if (nativePlan && !activationPlan) {
              persistNativeCustomProviderPlan(permit, nativePlan);
            }
            return;
          case "activation":
            if (activationPlan) {
              persistConfigWritePlan(permit, activationPlan);
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

function modelConfigurationDiagnosticId(): string {
  return randomBytes(6).toString("hex");
}

function startupFailure(
  code: ModelConfigurationStartupFailureCode,
): ModelConfigurationStartupFailure {
  return { code, diagnosticId: modelConfigurationDiagnosticId() };
}

function initializationFailureCode(
  error: unknown,
): ModelConfigurationStartupFailureCode {
  return error instanceof ModelConfigurationRuntimeError
    ? error.code
    : "model_configuration_database_unavailable";
}

const ROUTE_REPAIR_REQUIRED_ROLES: readonly ModelConfigurationFileRole[] = [
  "providers",
  "models",
  "modelDefinitions",
  "config",
];

function sameBytes(left: Buffer | null, right: Buffer | null): boolean {
  return left === null ? right === null : right !== null && left.equals(right);
}

function freshRouteDirectorySnapshot(profileId: string): {
  paths: ModelConfigurationFilePaths;
  snapshot: ModelRouteDirectorySnapshot;
} | null {
  const paths = defaultModelConfigurationFilePaths(profileId);
  const captured = captureModelConfigurationFiles({
    profileId,
    operationId: randomUUID(),
    paths,
  });
  if (
    ROUTE_REPAIR_REQUIRED_ROLES.some((role) => !captured.files[role].existed)
  ) {
    return null;
  }
  return {
    paths,
    snapshot: {
      profileId,
      ownerHandle: "",
      expectedOwnerHandle: "",
      incompleteOperation: false,
      files: Object.fromEntries(
        (Object.keys(captured.files) as ModelConfigurationFileRole[]).map(
          (role) => [
            role,
            captured.files[role].existed
              ? Buffer.from(captured.files[role].bytes)
              : null,
          ],
        ),
      ) as ModelRouteDirectorySnapshot["files"],
    },
  };
}

function planFreshRouteRepair(
  profileId: string,
  ownerHandle: string,
): RouteRepairPlan | null {
  const current = freshRouteDirectorySnapshot(profileId);
  if (!current) return null;
  current.snapshot.ownerHandle = ownerHandle;
  current.snapshot.expectedOwnerHandle = ownerHandle;
  return planModelRouteDirectoryRepair(current.snapshot);
}

function sameActiveRoute(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function routeRepairInitialization(
  options: ModelConfigurationRuntimeOptions,
  catalog: OwnerModelRouteCatalog,
  targetProfileId: string,
  ownerHandle: string,
  initial: {
    plan: Extract<RouteRepairPlan, { status: "repair" }>;
  },
): ManagedModelFileInitialization {
  const patches = initial.plan.patches;
  return {
    targetProfileId,
    changesRequired: true,
    applyStage: async (
      stage: ModelConfigurationCommitStage,
      permit: Parameters<typeof writeManagedModelFile>[0],
    ): Promise<void> => {
      if (stage !== "model_library") return;
      const current = freshRouteDirectorySnapshot(targetProfileId);
      if (!current) throw new Error("Route repair files disappeared.");
      for (const patch of patches) {
        const actual = current.snapshot.files[patch.role];
        if (!sameBytes(actual, patch.before)) {
          throw new Error("Route repair plan became stale.");
        }
      }
      for (const patch of patches) {
        writeManagedModelFile(permit, current.paths[patch.role], patch.after);
      }
      invalidateModelConfigCache(targetProfileId);
    },
    verify: async (): Promise<boolean> => {
      const current = planFreshRouteRepair(targetProfileId, ownerHandle);
      if (!current || current.status !== "unchanged") return false;
      return sameActiveRoute(current.activeRoute, initial.plan.activeRoute);
    },
    refreshPresentation: (): void => {
      let revision: string | undefined;
      const failures: unknown[] = [];
      try {
        revision = catalog.snapshot(targetProfileId).revision;
      } catch (error) {
        failures.push(error);
      }
      const listeners = [
        options.notifyModelLibraryChanged,
        options.notifyCustomProvidersChanged,
        options.notifyConnectionConfigChanged,
        options.notifyRuntimeSnapshotChanged,
      ];
      for (const listener of listeners) {
        if (!listener) continue;
        try {
          listener(revision);
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) throw failures[0];
    },
  };
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
  let unavailable: ModelConfigurationStartupFailure | null = null;

  try {
    await (
      options.recoverStagedProfileActivations ??
      recoverStagedProfileActivationJournal
    )({
      profilesRoot: join(HERMES_HOME, "profiles"),
    });
  } catch (error) {
    recoveryError = error;
    unavailable = startupFailure("model_configuration_recovery_required");
  }

  if (unavailable === null) {
    try {
      registerManagedModelFileRoots({
        globalRoot: HERMES_HOME,
        profiles: Object.fromEntries(
          profileIdsSync().map((profileId) => [
            profileId,
            profileHome(profileId),
          ]),
        ),
      });
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
        // A rollback is authoritative only after all five bytes and the
        // journal have been verified. Notify every in-memory consumer even if
        // one listener fails; the coordinator records a presentation warning
        // without reopening the recovery lock.
        notifyRolledBack: () => {
          let revision: string | undefined;
          const failures: unknown[] = [];
          try {
            revision = catalog!.snapshot(getActiveProfileNameSync()).revision;
          } catch (error) {
            failures.push(error);
          }
          const listeners = [
            options.notifyModelLibraryChanged,
            options.notifyCustomProvidersChanged,
            options.notifyConnectionConfigChanged,
            options.notifyRuntimeSnapshotChanged,
          ];
          for (const listener of listeners) {
            if (!listener) continue;
            try {
              listener(revision);
            } catch (error) {
              failures.push(error);
            }
          }
          if (failures.length > 0) throw failures[0];
        },
      });
    } catch (error) {
      recoveryError = error;
      unavailable = startupFailure(initializationFailureCode(error));
      coordinator = null;
    }
  }

  if (coordinator !== null) {
    try {
      await coordinator.recoverIncompleteOperations();
    } catch (error) {
      recoveryError = error;
      unavailable = startupFailure("model_configuration_recovery_required");
      coordinator = null;
    }
  }

  if (coordinator !== null && catalog !== null) {
    let routeStartupFailureCode: ModelConfigurationStartupFailureCode =
      "model_configuration_recovery_required";
    try {
      const targetProfileId = catalog.canonicalTargetProfileId("default");
      const ownerHandle = runtimeComponentKey(options.getOwner());
      const routeRepair = planFreshRouteRepair(targetProfileId, ownerHandle);
      if (routeRepair?.status === "repair_required") {
        routeStartupFailureCode = routeRepair.code;
        console.error(
          "[MODEL_CONFIGURATION] route repair required",
          routeRepair.conflict,
        );
        throw new Error("Model route directory repair is ambiguous.");
      }
      if (routeRepair?.status === "repair") {
        const repairResult = await coordinator.initializeManagedModelFiles(
          routeRepairInitialization(
            options,
            catalog,
            targetProfileId,
            ownerHandle,
            {
              plan: routeRepair,
            },
          ),
        );
        if (repairResult.status === "rejected") {
          throw new Error("Managed model route repair was rejected.");
        }
      }
      const initialization = await initializeModelCatalog(
        coordinator,
        planModelCatalogInitialization([targetProfileId]),
      );
      if (initialization.status === "rejected") {
        throw new Error("Managed model catalog initialization was rejected.");
      }
    } catch (error) {
      recoveryError = error;
      unavailable = startupFailure(routeStartupFailureCode);
      coordinator = null;
    }
  }

  if (unavailable !== null) {
    console.error(
      "[MODEL_CONFIGURATION] unavailable",
      unavailable.diagnosticId,
      unavailable.code,
    );
  }

  return {
    database,
    operationStore,
    catalog,
    coordinator,
    mutationAdapter,
    startupFailure: unavailable,
    recoveryError,
    close: () => database?.close(),
  };
}
