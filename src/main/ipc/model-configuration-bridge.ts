import { randomBytes } from "node:crypto";
import type {
  ModelConfigurationMutationRequest,
  ModelConfigurationMutationResult,
  ModelConfigurationStartupFailure,
  OwnerModelRouteCatalogSnapshot,
  OwnerModelRouteSummary,
} from "../../shared/model-configuration";
import type {
  ManagedModelConfigurationWriteContext,
  ManagedModelConfigurationWritePlan,
  ManagedModelConfigurationWriteRequest,
  ManagedModelConfigurationWriteResult,
} from "../model-configuration-coordinator";

const PROFILE_ID_PATTERN = /^[a-z0-9_][a-z0-9_-]{0,63}$/;
const REVISION_PATTERN = /^[0-9a-f]{64}$/i;
const DIAGNOSTIC_ID_PATTERN = /^[0-9a-f]{12}$/u;

export interface ModelConfigurationIpcBridgeDependencies {
  catalog: {
    snapshot(requestedProfileId?: string): OwnerModelRouteCatalogSnapshot;
  };
  coordinator: {
    mutate(
      request: ModelConfigurationMutationRequest,
    ): Promise<ModelConfigurationMutationResult>;
    runManagedWrite<T>(
      request: ManagedModelConfigurationWriteRequest,
      prepare: (
        context: ManagedModelConfigurationWriteContext,
      ) =>
        | ManagedModelConfigurationWritePlan<T>
        | Promise<ManagedModelConfigurationWritePlan<T>>,
    ): Promise<ManagedModelConfigurationWriteResult<T>>;
  };
  /** Main-only ownership check for the optional catalog target. */
  assertRequestedProfile?(profileId: string): void;
}

export function coordinatorUnavailableMutation(
  startupFailure: ModelConfigurationStartupFailure | null,
): ModelConfigurationIpcBridgeDependencies["coordinator"] {
  const failure = {
    code: startupFailure?.code ?? "model_configuration_recovery_required",
    diagnosticId:
      startupFailure && DIAGNOSTIC_ID_PATTERN.test(startupFailure.diagnosticId)
        ? startupFailure.diagnosticId
        : randomBytes(6).toString("hex"),
  } satisfies ModelConfigurationStartupFailure;
  const recoveryRequired =
    failure.code === "model_configuration_recovery_required";
  return {
    async mutate() {
      return {
        status: "rejected",
        stage: recoveryRequired ? "recovery" : "validation",
        code: failure.code,
        rollback: recoveryRequired ? "recovery_required" : "not_needed",
        diagnosticId: failure.diagnosticId,
      };
    },
    async runManagedWrite<T>(): Promise<
      ManagedModelConfigurationWriteResult<T>
    > {
      return {
        status: "rejected",
        stage: recoveryRequired ? "recovery" : "validation",
        code: failure.code,
        rollback: recoveryRequired ? "recovery_required" : "not_needed",
        diagnosticId: failure.diagnosticId,
      };
    },
  };
}

function invalidRequest(): Error {
  return Object.assign(new Error("Invalid model configuration request."), {
    code: "invalid_request",
  });
}

function managedWriteBlocked(
  result: Extract<
    ManagedModelConfigurationWriteResult<never>,
    { status: "rejected" }
  >,
): Error {
  return Object.assign(new Error(result.code), {
    code: result.code,
    stage: result.stage,
    rollback: result.rollback,
    ...(result.diagnosticId ? { diagnosticId: result.diagnosticId } : {}),
  });
}

const MANAGED_WRITE_STAGES = new Set<
  ManagedModelConfigurationWriteRequest["stage"]
>(["credential", "provider", "model_library", "native_route", "activation"]);

export interface ManagedModelConfigurationWriteBridgeOptions {
  refreshWarningToError?(
    warning: "model_save_refresh_failed",
  ): Error;
}

function profileId(value: unknown): string {
  if (typeof value !== "string" || !PROFILE_ID_PATTERN.test(value)) {
    throw invalidRequest();
  }
  return value;
}

function text(value: unknown, maximum: number, allowEmpty = false): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    value.length > maximum ||
    /[\0\r\n]/.test(value)
  ) {
    throw invalidRequest();
  }
  return value;
}

function revision(value: unknown): string {
  if (typeof value !== "string" || !REVISION_PATTERN.test(value)) {
    throw invalidRequest();
  }
  return value;
}

function parseMutationRequest(
  input: unknown,
): ModelConfigurationMutationRequest {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw invalidRequest();
  }
  const value = input as Record<string, unknown>;
  const intent = value.intent;
  const expectedCatalogRevision = revision(value.expectedCatalogRevision);
  const requestedProfileId = profileId(value.requestedProfileId);
  if (intent === "upsert") {
    if (!Array.isArray(value.models) || value.models.length === 0) {
      throw invalidRequest();
    }
    const models = value.models.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw invalidRequest();
      }
      const model = entry as Record<string, unknown>;
      const result: {
        model: string;
        displayName: string;
        contextLength?: number;
      } = {
        model: text(model.model, 512),
        displayName: text(model.displayName, 512),
      };
      if (model.contextLength !== undefined) {
        if (
          !Number.isSafeInteger(model.contextLength) ||
          (model.contextLength as number) <= 0
        ) {
          throw invalidRequest();
        }
        result.contextLength = model.contextLength as number;
      }
      return result;
    });
    const apiMode = value.apiMode;
    if (apiMode !== null && typeof apiMode !== "string") {
      throw invalidRequest();
    }
    const providerId =
      value.providerId === undefined ? undefined : text(value.providerId, 128);
    return {
      intent: "upsert",
      expectedCatalogRevision,
      requestedProfileId,
      ...(providerId ? { providerId } : {}),
      provider: text(value.provider, 256),
      providerLabel: text(value.providerLabel, 256),
      baseUrl: text(value.baseUrl, 2048, true),
      apiMode: apiMode as string | null,
      apiKey: text(value.apiKey, 65_536, true),
      models,
      activeModel: text(value.activeModel, 512),
    };
  }
  if (intent === "delete") {
    const replacementValue = value.replacement;
    let replacement: Extract<
      ModelConfigurationMutationRequest,
      { intent: "delete" }
    >["replacement"];
    if (replacementValue === null) {
      replacement = null;
    } else {
      if (
        !replacementValue ||
        typeof replacementValue !== "object" ||
        Array.isArray(replacementValue)
      ) {
        throw invalidRequest();
      }
      const selected = replacementValue as Record<string, unknown>;
      replacement = {
        sourceProfileId: profileId(selected.sourceProfileId),
        modelLibraryId: text(selected.modelLibraryId, 512),
        catalogRevision: revision(selected.catalogRevision),
      };
    }
    return {
      intent: "delete",
      expectedCatalogRevision,
      requestedProfileId,
      providerLabel: text(value.providerLabel, 256),
      replacement,
    };
  }
  throw invalidRequest();
}

function redactRoute(route: OwnerModelRouteSummary): OwnerModelRouteSummary {
  return {
    id: route.id,
    provider: route.provider,
    model: route.model,
    baseUrl: route.baseUrl,
    apiMode: route.apiMode,
    providerLabel: route.providerLabel,
    displayName: route.displayName,
    sourceProfileId: route.sourceProfileId,
    sourceKind: route.sourceKind,
    selection: {
      sourceProfileId: route.selection.sourceProfileId,
      modelLibraryId: route.selection.modelLibraryId,
      catalogRevision: route.selection.catalogRevision,
    },
  };
}

export function redactOwnerModelRouteCatalog(
  snapshot: OwnerModelRouteCatalogSnapshot,
): OwnerModelRouteCatalogSnapshot {
  return {
    revision: snapshot.revision,
    targetProfileId: snapshot.targetProfileId,
    routes: snapshot.routes.map(redactRoute),
  };
}

function redactMutationResult(
  result: ModelConfigurationMutationResult,
): ModelConfigurationMutationResult {
  if (result.status === "rejected") return result;
  return { ...result, catalog: redactOwnerModelRouteCatalog(result.catalog) };
}

export function createModelConfigurationIpcBridge(
  dependencies: ModelConfigurationIpcBridgeDependencies,
): {
  getOwnerModelRouteCatalog(
    requestedProfileId?: unknown,
  ): OwnerModelRouteCatalogSnapshot;
  mutateModelConfiguration(
    input: unknown,
  ): Promise<ModelConfigurationMutationResult>;
  runManagedModelConfigurationWrite<T>(
    request: ManagedModelConfigurationWriteRequest,
    prepare: (
      context: ManagedModelConfigurationWriteContext,
    ) =>
      | ManagedModelConfigurationWritePlan<T>
      | Promise<ManagedModelConfigurationWritePlan<T>>,
    options?: ManagedModelConfigurationWriteBridgeOptions,
  ): Promise<T>;
} {
  return {
    getOwnerModelRouteCatalog(requestedProfileId?: unknown) {
      let profile: string | undefined;
      if (
        requestedProfileId !== undefined &&
        requestedProfileId !== null &&
        requestedProfileId !== ""
      ) {
        profile = profileId(requestedProfileId);
        dependencies.assertRequestedProfile?.(profile);
      }
      return redactOwnerModelRouteCatalog(
        dependencies.catalog.snapshot(profile),
      );
    },
    async mutateModelConfiguration(input: unknown) {
      const request = parseMutationRequest(input);
      const result = await dependencies.coordinator.mutate(request);
      return redactMutationResult(result);
    },
    async runManagedModelConfigurationWrite<T>(
      request,
      prepare,
      options: ManagedModelConfigurationWriteBridgeOptions = {},
    ): Promise<T> {
      const requestedProfileId = profileId(request.requestedProfileId);
      if (
        (request.scope !== "profile" && request.scope !== "global") ||
        !MANAGED_WRITE_STAGES.has(request.stage) ||
        typeof prepare !== "function"
      ) {
        throw invalidRequest();
      }
      const result = await dependencies.coordinator.runManagedWrite<T>(
        { ...request, requestedProfileId },
        prepare,
      );
      if (result.status === "rejected") throw managedWriteBlocked(result);
      if (result.warning && options.refreshWarningToError) {
        const error = options.refreshWarningToError(result.warning);
        if (!(error instanceof Error)) throw invalidRequest();
        throw error;
      }
      return result.value;
    },
  };
}
