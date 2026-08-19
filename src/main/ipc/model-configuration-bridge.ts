import { randomBytes } from "node:crypto";
import type {
  ModelConfigurationFailureCode,
  ModelConfigurationFailureStage,
  ModelConfigurationOperation,
  ModelConfigurationRetryability,
  ModelConfigurationMutationRequest,
  ModelConfigurationMutationResult,
  LegacyModelConfigurationMutationFailure,
  ModelConfigurationStartupFailure,
  OwnerModelRouteCatalogSnapshot,
  OwnerModelRouteSummary,
} from "../../shared/model-configuration";
import type {
  ManagedModelConfigurationWriteContext,
  ManagedModelConfigurationWritePlan,
  ManagedModelConfigurationWriteRequest,
  ManagedModelConfigurationWriteResult,
  ModelConfigurationOwnerGuard,
} from "../model-configuration-coordinator";

const PROFILE_ID_PATTERN = /^[a-z0-9_][a-z0-9_-]{0,63}$/;
const REVISION_PATTERN = /^[0-9a-f]{64}$/i;
const DIAGNOSTIC_ID_PATTERN = /^[0-9a-f]{12}$/u;

type InternalMutationResult =
  | ModelConfigurationMutationResult
  | LegacyModelConfigurationMutationFailure;
type InternalMutationFailure = Extract<
  InternalMutationResult,
  { status: "rejected" }
>;

export interface ModelConfigurationIpcBridgeDependencies {
  catalog: {
    snapshot(requestedProfileId?: string): OwnerModelRouteCatalogSnapshot;
  };
  coordinator: {
    mutate(
      request: ModelConfigurationMutationRequest,
      ownerGuard?: ModelConfigurationOwnerGuard,
    ): Promise<InternalMutationResult>;
    runManagedWrite<T>(
      request: ManagedModelConfigurationWriteRequest,
      prepare: (
        context: ManagedModelConfigurationWriteContext,
      ) =>
        | ManagedModelConfigurationWritePlan<T>
        | Promise<ManagedModelConfigurationWritePlan<T>>,
      ownerGuard?: ModelConfigurationOwnerGuard,
    ): Promise<ManagedModelConfigurationWriteResult<T>>;
  };
  /** Main-only ownership check for the optional catalog target. */
  assertRequestedProfile?(profileId: string): void;
  /** Main-only sink for one-line, already-redacted mutation rejection events. */
  logRejected?(line: string): void;
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
  const stage: ModelConfigurationFailureStage = failure.code.startsWith(
    "native_module_",
  )
    ? "native_load"
    : failure.code === "model_configuration_database_unavailable"
      ? "database_open"
      : failure.code === "model_configuration_schema_unsupported"
        ? "schema"
        : failure.code === "route_catalog_repair_required"
          ? "route_repair"
          : "recovery";
  return {
    async mutate() {
      return {
        status: "rejected",
        schemaVersion: 2,
        operation: "startup",
        stage,
        code: failure.code,
        retryability: recoveryRequired ? "after_user_action" : "after_restart",
        rollback: recoveryRequired ? "recovery_required" : "not_needed",
        diagnosticId: failure.diagnosticId,
      };
    },
    async runManagedWrite<T>(): Promise<
      ManagedModelConfigurationWriteResult<T>
    > {
      return {
        status: "rejected",
        schemaVersion: 2,
        operation: "startup",
        stage,
        code: failure.code,
        retryability: recoveryRequired ? "after_user_action" : "after_restart",
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
  refreshWarningToError?(warning: "model_save_refresh_failed"): Error;
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
  result: InternalMutationResult,
): ModelConfigurationMutationResult {
  if (result.status === "rejected") return sanitizeMutationFailure(result);
  return { ...result, catalog: redactOwnerModelRouteCatalog(result.catalog) };
}

function rejectionLogLine(
  result: Extract<ModelConfigurationMutationResult, { status: "rejected" }>,
): string {
  return `[MODEL_CONFIGURATION] rejected ${result.diagnosticId} ${result.operation} ${result.stage} ${result.code}`;
}

function logRejectedMutation(
  logRejected: (line: string) => void,
  result: Extract<ModelConfigurationMutationResult, { status: "rejected" }>,
): void {
  logRejected(rejectionLogLine(result));
}

function failureOperation(
  result: InternalMutationFailure,
): ModelConfigurationOperation {
  if (result.code === "route_catalog_repair_required") {
    return "repair_route_catalog";
  }
  if (result.stage === "rollback") return "rollback";
  return "save_model";
}

function requestOperation(
  request: ModelConfigurationMutationRequest,
): ModelConfigurationOperation {
  return request.intent === "delete" ? "remove_provider" : "save_provider";
}

function failureStage(
  result: InternalMutationFailure,
): ModelConfigurationFailureStage {
  if (result.code.startsWith("native_module_")) return "native_load";
  if (result.code === "model_configuration_database_unavailable") {
    return "database_open";
  }
  if (result.code === "model_configuration_schema_unsupported") return "schema";
  if (result.code === "route_catalog_repair_required") return "route_repair";
  if (result.reason === "stale_catalog_revision") return "revision";
  if (
    result.code === "model_owner_transition_in_progress" ||
    result.code === "model_owner_changed" ||
    result.code === "owner_transition_timeout" ||
    result.code === "owner_transition_failed"
  ) {
    return "owner";
  }
  return result.stage;
}

function failureRetryability(
  result: InternalMutationFailure,
): ModelConfigurationRetryability {
  if (
    result.reason === "stale_catalog_revision" ||
    result.code === "model_owner_changed" ||
    result.code === "model_owner_transition_in_progress"
  ) {
    return "retryable";
  }
  if (
    result.code.startsWith("native_module_") ||
    result.code === "model_configuration_database_unavailable" ||
    result.code === "model_configuration_schema_unsupported"
  ) {
    return "after_restart";
  }
  if (
    result.code === "model_configuration_recovery_required" ||
    result.code === "route_catalog_repair_required" ||
    result.code === "owner_transition_timeout" ||
    result.code === "owner_transition_failed"
  ) {
    return "after_user_action";
  }
  return "not_retryable";
}

function sanitizeMutationFailure(
  result: InternalMutationFailure,
  operationOverride?: ModelConfigurationOperation,
): Extract<ModelConfigurationMutationResult, { status: "rejected" }> {
  const diagnosticId =
    typeof result.diagnosticId === "string" &&
    DIAGNOSTIC_ID_PATTERN.test(result.diagnosticId)
      ? result.diagnosticId
      : randomBytes(6).toString("hex");
  return {
    status: "rejected",
    schemaVersion: 2,
    operation:
      operationOverride ??
      ("operation" in result ? result.operation : failureOperation(result)),
    stage:
      "schemaVersion" in result && result.schemaVersion === 2
        ? result.stage
        : failureStage(result),
    code: result.code as ModelConfigurationFailureCode,
    retryability:
      "retryability" in result
        ? result.retryability
        : failureRetryability(result),
    diagnosticId,
    rollback: result.rollback,
    ...(result.rollbackWarning
      ? { rollbackWarning: result.rollbackWarning }
      : {}),
    ...(result.reason ? { reason: result.reason } : {}),
  };
}

export function createModelConfigurationIpcBridge(
  dependencies: ModelConfigurationIpcBridgeDependencies,
): {
  getOwnerModelRouteCatalog(
    requestedProfileId?: unknown,
  ): OwnerModelRouteCatalogSnapshot;
  mutateModelConfiguration(
    input: unknown,
    ownerGuard?: ModelConfigurationOwnerGuard,
  ): Promise<ModelConfigurationMutationResult>;
  runManagedModelConfigurationWrite<T>(
    request: ManagedModelConfigurationWriteRequest,
    prepare: (
      context: ManagedModelConfigurationWriteContext,
    ) =>
      | ManagedModelConfigurationWritePlan<T>
      | Promise<ManagedModelConfigurationWritePlan<T>>,
    options?: ManagedModelConfigurationWriteBridgeOptions,
    ownerGuard?: ModelConfigurationOwnerGuard,
  ): Promise<T>;
} {
  const logRejected =
    dependencies.logRejected ?? ((line: string) => console.error(line));
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
    async mutateModelConfiguration(input: unknown, ownerGuard) {
      const request = parseMutationRequest(input);
      const result = ownerGuard
        ? await dependencies.coordinator.mutate(request, ownerGuard)
        : await dependencies.coordinator.mutate(request);
      if (result.status === "rejected") {
        const failure = sanitizeMutationFailure(
          result,
          requestOperation(request),
        );
        logRejectedMutation(logRejected, failure);
        return failure;
      }
      return redactMutationResult(result);
    },
    async runManagedModelConfigurationWrite<T>(
      request,
      prepare,
      options: ManagedModelConfigurationWriteBridgeOptions = {},
      ownerGuard,
    ): Promise<T> {
      const requestedProfileId = profileId(request.requestedProfileId);
      if (
        (request.scope !== "profile" && request.scope !== "global") ||
        !MANAGED_WRITE_STAGES.has(request.stage) ||
        typeof prepare !== "function"
      ) {
        throw invalidRequest();
      }
      const result = ownerGuard
        ? await dependencies.coordinator.runManagedWrite<T>(
            { ...request, requestedProfileId },
            prepare,
            ownerGuard,
          )
        : await dependencies.coordinator.runManagedWrite<T>(
            { ...request, requestedProfileId },
            prepare,
          );
      if (result.status === "rejected") {
        const failure = sanitizeMutationFailure(result);
        logRejectedMutation(logRejected, failure);
        throw managedWriteBlocked(failure);
      }
      if (result.warning && options.refreshWarningToError) {
        const error = options.refreshWarningToError(result.warning);
        if (!(error instanceof Error)) throw invalidRequest();
        throw error;
      }
      return result.value;
    },
  };
}
