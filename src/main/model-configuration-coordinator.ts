import { randomBytes, randomUUID } from "node:crypto";
import {
  isModelRouteKeyV2,
  routeKeysMatch,
  ModelConfigurationMutationRequest,
  ModelConfigurationMutationResult,
  ModelConfigurationStage,
  type ModelConfigurationFailureCode,
  type ModelConfigurationFailureStage,
  type ModelConfigurationOperation,
  type ModelConfigurationMutationFailure,
  type ModelConfigurationOwnerTransitionCode,
  type LegacyModelConfigurationMutationFailure,
  OwnerModelRouteCatalogSnapshot,
} from "../shared/model-configuration";
import {
  captureModelConfigurationFiles,
  defaultModelConfigurationFilePaths,
  persistModelConfigurationBackups,
  readModelConfigurationFileDigests,
  removeModelConfigurationBackups,
  restoreModelConfigurationFiles,
  type ModelConfigurationFilePaths,
  type ModelConfigurationFileRole,
  type ModelConfigurationFilesSnapshot,
  type ModelConfigurationOperationRecord,
  type ModelConfigurationOperationStore,
} from "./model-configuration-operation-store";
import {
  defaultModelConfigurationWriteAuthority,
  type ModelConfigurationWritePermit,
  type ModelConfigurationWriteAuthority,
} from "./model-configuration-write-authority";

type Awaitable<T> = T | Promise<T>;

export type ModelConfigurationOwnerGuard = () => void;

export type ModelConfigurationCommitStage =
  | "credential"
  | "provider"
  | "model_library"
  | "native_route"
  | "activation";

const COMMIT_STAGES: readonly ModelConfigurationCommitStage[] = [
  "credential",
  "provider",
  "model_library",
  "native_route",
  "activation",
];

const FILE_ROLES: readonly ModelConfigurationFileRole[] = [
  "env",
  "providers",
  "models",
  "modelDefinitions",
  "config",
];

const PROFILE_ID_PATTERN = /^[a-z0-9_][a-z0-9_-]{0,63}$/;
const REVISION_PATTERN = /^[0-9a-f]{64}$/i;

export interface ModelConfigurationCatalogAdapter {
  snapshot(requestedProfileId?: string): OwnerModelRouteCatalogSnapshot;
  canonicalTargetProfileId(requestedProfileId?: string): string;
}

export interface LocalModelConfigurationMutationLocation {
  kind: "local";
}

export interface RemoteModelConfigurationMutationLocation {
  kind: "remote";
  transport: "dashboard" | "legacy" | "ssh";
  snapshotComplete: boolean;
  restore(): Awaitable<void>;
  verifyRestore(): Awaitable<boolean>;
}

export interface PreparedModelConfigurationMutation {
  targetProfileId: string;
  oldRouteKey: string;
  newRouteKey: string;
  location:
    | LocalModelConfigurationMutationLocation
    | RemoteModelConfigurationMutationLocation;
  applyStage(
    stage: ModelConfigurationCommitStage,
    permit: ModelConfigurationWritePermit | null,
  ): Awaitable<void>;
  verify(catalog: OwnerModelRouteCatalogSnapshot): Awaitable<boolean>;
  refreshPresentation?(): Awaitable<void>;
}

/**
 * Main-only startup maintenance that may update the same five files as a
 * user-initiated model mutation. The caller computes the plan without writing;
 * the coordinator owns admission, snapshotting, journalling, rollback, and
 * final verification.
 */
export interface ManagedModelFileInitialization {
  targetProfileId: string;
  changesRequired: boolean;
  applyStage(
    stage: ModelConfigurationCommitStage,
    permit: ModelConfigurationWritePermit | null,
  ): Awaitable<void>;
  verify(): Awaitable<boolean>;
  refreshPresentation?(): Awaitable<void>;
}

export type ManagedModelConfigurationWriteScope = "profile" | "global";

/**
 * Main-only adapter for legacy product surfaces that still expose one focused
 * config/model command instead of the public multi-stage model-service
 * mutation. The coordinator still owns admission, snapshotting, journalling,
 * rollback, verification, and the write permit.
 */
export interface ManagedModelConfigurationWriteRequest {
  requestedProfileId: string;
  scope: ManagedModelConfigurationWriteScope;
  stage: ModelConfigurationCommitStage;
}

export interface ManagedModelConfigurationWriteContext {
  ownerHandle: string;
  targetProfileId: string;
  catalog: OwnerModelRouteCatalogSnapshot;
  oldRouteKey: string;
}

export interface ManagedModelConfigurationWritePlan<T> {
  /** Omit when the focused command must preserve the active route. */
  newRouteKey?: string;
  write(permit: ModelConfigurationWritePermit): Awaitable<T>;
  verify?(
    catalog: OwnerModelRouteCatalogSnapshot,
    value: T,
  ): Awaitable<boolean>;
  refreshPresentation?(): Awaitable<void>;
}

export type ManagedModelConfigurationWriteResult<T> =
  | {
      status: "executed";
      value: T;
      catalog: OwnerModelRouteCatalogSnapshot;
      warning?: "model_save_refresh_failed";
    }
  | ModelConfigurationMutationFailure
  | LegacyModelConfigurationMutationFailure;

export interface ModelConfigurationMutationAdapter {
  prepare(
    request: ModelConfigurationMutationRequest,
    context: {
      ownerHandle: string;
      targetProfileId: string;
      catalog: OwnerModelRouteCatalogSnapshot;
    },
  ): Awaitable<PreparedModelConfigurationMutation>;
  getActiveRouteKey(profileId: string): Awaitable<string>;
}

export interface ModelConfigurationFileAdapter {
  paths(profileId: string): ModelConfigurationFilePaths;
  capture(input: {
    profileId: string;
    operationId: string;
    paths?: ModelConfigurationFilePaths;
  }): Awaitable<ModelConfigurationFilesSnapshot>;
  persistBackups(snapshot: ModelConfigurationFilesSnapshot): Awaitable<void>;
  restore(snapshot: ModelConfigurationFilesSnapshot): Awaitable<void>;
  removeBackups(snapshot: ModelConfigurationFilesSnapshot): Awaitable<void>;
  readDigests(
    paths: ModelConfigurationFilePaths,
  ): Awaitable<Record<ModelConfigurationFileRole, string>>;
}

export interface ModelConfigurationCoordinatorDependencies {
  catalog: ModelConfigurationCatalogAdapter;
  ownerHandle(): string;
  operationStore: ModelConfigurationOperationStore;
  mutationAdapter: ModelConfigurationMutationAdapter;
  fileAdapter?: ModelConfigurationFileAdapter;
  operationId?: () => string;
  isProfileOwned?: (
    ownerHandle: string,
    profileId: string,
  ) => Awaitable<boolean>;
  writeAuthority?: ModelConfigurationWriteAuthority;
  /**
   * Runs only after a rollback has restored and verified all managed bytes and
   * the journal is terminal. A notification failure degrades presentation but
   * must never reclassify the operation as recovery-required.
   */
  notifyRolledBack?: () => Awaitable<void>;
}

const DEFAULT_FILE_ADAPTER: ModelConfigurationFileAdapter = {
  paths: defaultModelConfigurationFilePaths,
  capture: captureModelConfigurationFiles,
  persistBackups: persistModelConfigurationBackups,
  restore: restoreModelConfigurationFiles,
  removeBackups: removeModelConfigurationBackups,
  readDigests: readModelConfigurationFileDigests,
};

function rejected(
  stage: ModelConfigurationStage,
  rollback: "not_needed" | "restored" | "recovery_required",
  recoveryRequired = false,
  codeOverride?: ModelConfigurationOwnerTransitionCode,
  operation: ModelConfigurationOperation = "save_model",
  diagnosticId?: string,
): ModelConfigurationMutationFailure {
  const code: ModelConfigurationFailureCode =
    codeOverride ??
    (recoveryRequired
      ? "model_configuration_recovery_required"
      : failureCodeForStage(stage));
  return {
    status: "rejected",
    schemaVersion: 2,
    operation,
    stage: failureStageFor(stage, code),
    code,
    retryability: retryabilityFor(code),
    diagnosticId:
      diagnosticId && /^[0-9a-f]{12}$/u.test(diagnosticId)
        ? diagnosticId
        : modelConfigurationDiagnosticId(),
    rollback,
  };
}

function failureCodeForStage(
  stage: ModelConfigurationStage,
): ModelConfigurationFailureCode {
  switch (stage) {
    case "validation":
      return "model_save_validation_failed";
    case "credential":
      return "model_save_credential_failed";
    case "provider":
      return "model_save_provider_failed";
    case "model_library":
      return "model_save_model_library_failed";
    case "native_route":
      return "model_save_native_route_failed";
    case "activation":
      return "model_save_activation_failed";
    case "verification":
      return "model_save_verification_failed";
    case "rollback":
      return "model_save_rollback_failed";
    case "recovery":
      return "model_configuration_recovery_required";
  }
}

function modelConfigurationDiagnosticId(): string {
  return randomBytes(6).toString("hex");
}

function failureStageFor(
  stage: ModelConfigurationStage,
  code: ModelConfigurationFailureCode,
): ModelConfigurationFailureStage {
  if (code.startsWith("native_module_")) return "native_load";
  if (code === "model_configuration_database_unavailable") {
    return "database_open";
  }
  if (code === "model_configuration_schema_unsupported") return "schema";
  if (code === "route_catalog_repair_required") return "route_repair";
  if (code === "model_save_stale_catalog_revision") return "revision";
  if (
    code === "model_owner_transition_in_progress" ||
    code === "model_owner_changed" ||
    code === "owner_transition_timeout" ||
    code === "owner_transition_failed"
  ) {
    return "owner";
  }
  return stage;
}

function retryabilityFor(
  code: ModelConfigurationFailureCode,
): ModelConfigurationMutationFailure["retryability"] {
  if (
    code === "model_save_stale_catalog_revision" ||
    code === "model_owner_changed" ||
    code === "model_owner_transition_in_progress"
  ) {
    return "retryable";
  }
  if (
    code === "native_module_abi_mismatch" ||
    code === "native_module_architecture_mismatch" ||
    code === "native_module_dependency_missing" ||
    code === "native_module_load_denied" ||
    code === "native_module_load_failed" ||
    code === "model_configuration_database_unavailable" ||
    code === "model_configuration_schema_unsupported"
  ) {
    return "after_restart";
  }
  if (
    code === "model_configuration_recovery_required" ||
    code === "route_catalog_repair_required" ||
    code === "owner_transition_timeout" ||
    code === "owner_transition_failed"
  ) {
    return "after_user_action";
  }
  return "not_retryable";
}

function ownerTransitionCode(
  error: unknown,
): ModelConfigurationOwnerTransitionCode | null {
  if (!error || typeof error !== "object") return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" &&
    [
      "model_owner_transition_in_progress",
      "model_owner_changed",
      "owner_transition_timeout",
      "owner_transition_failed",
    ].includes(code)
    ? (code as ModelConfigurationOwnerTransitionCode)
    : null;
}

function ownerTransitionDiagnosticId(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const diagnosticId = (error as { diagnosticId?: unknown }).diagnosticId;
  return typeof diagnosticId === "string" &&
    /^[0-9a-f]{12}$/u.test(diagnosticId)
    ? diagnosticId
    : undefined;
}

function rejectedForError(
  error: unknown,
  stage: ModelConfigurationStage,
  rollback: "not_needed" | "restored" | "recovery_required",
  recoveryRequired = false,
): Extract<ModelConfigurationMutationResult, { status: "rejected" }> {
  return rejected(
    stage,
    rollback,
    recoveryRequired,
    ownerTransitionCode(error) ?? undefined,
    "save_model",
    ownerTransitionDiagnosticId(error),
  );
}

/**
 * A refusal the caller can act on: their catalog revision is behind ours, so
 * re-reading it and replaying once may succeed. Kept separate from [[rejected]]
 * so no other validation path can accidentally claim retryability.
 */
function rejectedStaleRevision(
  operation: ModelConfigurationOperation,
): ModelConfigurationMutationResult {
  return {
    ...rejected("validation", "not_needed", false, undefined, operation),
    code: "model_save_stale_catalog_revision",
    stage: "revision",
    retryability: "retryable",
    reason: "stale_catalog_revision",
  };
}

function withOperation(
  result: ModelConfigurationMutationResult,
  operation: ModelConfigurationOperation,
): ModelConfigurationMutationResult {
  return result.status === "rejected" ? { ...result, operation } : result;
}

function operationForMutation(
  request: ModelConfigurationMutationRequest,
): ModelConfigurationOperation {
  return request && request.intent === "delete"
    ? "remove_provider"
    : "save_provider";
}

function boundedString(
  value: unknown,
  maximum: number,
  allowEmpty = false,
): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    value.length > maximum ||
    /[\0\r\n]/.test(value)
  ) {
    throw new Error("Invalid model configuration value.");
  }
  return value;
}

function validateProfileId(value: unknown): string {
  if (typeof value !== "string" || !PROFILE_ID_PATTERN.test(value)) {
    throw new Error("Invalid model configuration Profile.");
  }
  return value;
}

function validateUrl(value: unknown): void {
  if (value === "") return;
  if (typeof value !== "string" || value.length > 2048) {
    throw new Error("Invalid model configuration endpoint.");
  }
  const parsed = new URL(value);
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error("Invalid model configuration endpoint.");
  }
}

function validateMutationRequest(
  request: ModelConfigurationMutationRequest,
): void {
  if (!request || typeof request !== "object") {
    throw new Error("Invalid model configuration request.");
  }
  validateProfileId(request.requestedProfileId);
  if (request.intent === "upsert" && request.providerId !== undefined) {
    boundedString(request.providerId.trim(), 128);
  }
  if (!REVISION_PATTERN.test(request.expectedCatalogRevision)) {
    throw new Error("Invalid model configuration revision.");
  }
  if (request.intent === "delete") {
    boundedString(request.providerLabel?.trim(), 256);
    if (request.replacement) {
      validateProfileId(request.replacement.sourceProfileId);
      boundedString(request.replacement.modelLibraryId, 512);
      if (!REVISION_PATTERN.test(request.replacement.catalogRevision)) {
        throw new Error("Invalid replacement model revision.");
      }
    }
    return;
  }
  if (request.intent !== "upsert") {
    throw new Error("Invalid model configuration intent.");
  }
  boundedString(request.provider?.trim(), 256);
  boundedString(request.providerLabel?.trim(), 256);
  validateUrl(request.baseUrl);
  if (request.apiMode !== null) boundedString(request.apiMode?.trim(), 64);
  if (
    typeof request.apiKey !== "string" ||
    request.apiKey.length > 65_536 ||
    request.apiKey.includes("\0")
  ) {
    throw new Error("Invalid model configuration credential.");
  }
  if (
    !Array.isArray(request.models) ||
    request.models.length < 1 ||
    request.models.length > 512
  ) {
    throw new Error("Invalid model configuration models.");
  }
  const models = new Set<string>();
  for (const model of request.models) {
    const id = boundedString(model?.model?.trim(), 512);
    boundedString(model?.displayName?.trim(), 512);
    if (
      model.contextLength !== undefined &&
      (!Number.isSafeInteger(model.contextLength) ||
        model.contextLength <= 0 ||
        model.contextLength > 100_000_000)
    ) {
      throw new Error("Invalid model configuration context length.");
    }
    if (models.has(id)) throw new Error("Duplicate model configuration model.");
    models.add(id);
  }
  const active = boundedString(request.activeModel?.trim(), 512);
  if (!models.has(active)) {
    throw new Error("Active model is absent from the model catalog.");
  }
}

function validateOwnerHandle(value: unknown): string {
  // Owner handles are opaque Main-only keys. The runtime deliberately uses
  // NUL separators between the tenant, owner, and installation identities so
  // concatenation cannot be ambiguous; unlike user/model fields, NUL is
  // therefore valid here. Keep the other bounded-string protections so an
  // owner key can never carry line-oriented or unbounded data into the
  // journal/lock paths.
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    /[\r\n]/.test(value)
  ) {
    throw new Error("Invalid model configuration owner handle.");
  }
  return value;
}

function boundedRouteKey(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4096 ||
    /[\r\n]/.test(value) ||
    !isModelRouteKeyV2(value)
  ) {
    throw new Error("Invalid canonical model route.");
  }
  return value;
}

function validatePreparedMutation(
  prepared: PreparedModelConfigurationMutation,
  targetProfileId: string,
  apiKey: string,
): void {
  if (!prepared || typeof prepared !== "object") {
    throw new Error("Invalid prepared model configuration mutation.");
  }
  if (prepared.targetProfileId !== targetProfileId) {
    throw new Error("Prepared model configuration target changed.");
  }
  const oldRouteKey = boundedRouteKey(prepared.oldRouteKey);
  const newRouteKey = boundedRouteKey(prepared.newRouteKey);
  if (
    apiKey &&
    (oldRouteKey.includes(apiKey) || newRouteKey.includes(apiKey))
  ) {
    throw new Error("Prepared route contains credential material.");
  }
  if (!prepared.location || typeof prepared.location !== "object") {
    throw new Error("Prepared model configuration location is invalid.");
  }
  if (
    prepared.location.kind !== "local" &&
    prepared.location.kind !== "remote"
  ) {
    throw new Error("Prepared model configuration location is invalid.");
  }
  if (
    typeof prepared.applyStage !== "function" ||
    typeof prepared.verify !== "function"
  ) {
    throw new Error("Prepared model configuration operations are invalid.");
  }
}

function digestsEqual(
  actual: Partial<Record<ModelConfigurationFileRole, string>>,
  expected: Partial<Record<ModelConfigurationFileRole, string>>,
): boolean {
  return FILE_ROLES.every(
    (role) =>
      typeof expected[role] === "string" && actual[role] === expected[role],
  );
}

function completeDigests(
  value: Partial<Record<ModelConfigurationFileRole, string>>,
): value is Record<ModelConfigurationFileRole, string> {
  return FILE_ROLES.every((role) => typeof value[role] === "string");
}

function reconstructSnapshot(
  record: ModelConfigurationOperationRecord,
  paths: ModelConfigurationFilePaths,
): ModelConfigurationFilesSnapshot {
  const manifest = new Map(record.files.map((file) => [file.role, file]));
  return {
    operationId: record.operationId,
    profileId: record.profileId,
    files: Object.fromEntries(
      FILE_ROLES.map((role) => {
        const file = manifest.get(role);
        const digest = record.beforeDigests[role];
        if (!file || typeof digest !== "string") {
          throw new Error(
            "Model configuration recovery evidence is incomplete.",
          );
        }
        const path = paths[role];
        return [
          role,
          {
            role,
            path,
            backupPath: `${path}.aera-model-config-backup.${record.operationId}`,
            existed: file.existed,
            mode: file.mode,
            bytes: Buffer.alloc(0),
            digest,
          },
        ];
      }),
    ) as Record<
      ModelConfigurationFileRole,
      ModelConfigurationFilesSnapshot["files"][ModelConfigurationFileRole]
    >,
  };
}

export class ModelConfigurationCoordinator {
  private readonly catalog: ModelConfigurationCatalogAdapter;
  private readonly ownerHandle: () => string;
  private readonly operationStore: ModelConfigurationOperationStore;
  private readonly mutationAdapter: ModelConfigurationMutationAdapter;
  private readonly files: ModelConfigurationFileAdapter;
  private readonly operationId: () => string;
  private readonly isProfileOwned: (
    ownerHandle: string,
    profileId: string,
  ) => Awaitable<boolean>;
  private readonly writeAuthority: ModelConfigurationWriteAuthority;
  private readonly notifyRolledBack: (() => Awaitable<void>) | undefined;
  private readonly locks = new Map<string, Promise<void>>();
  private readonly recoveryRequired = new Set<string>();

  constructor(dependencies: ModelConfigurationCoordinatorDependencies) {
    this.catalog = dependencies.catalog;
    this.ownerHandle = dependencies.ownerHandle;
    this.operationStore = dependencies.operationStore;
    this.mutationAdapter = dependencies.mutationAdapter;
    this.files = dependencies.fileAdapter ?? DEFAULT_FILE_ADAPTER;
    this.operationId = dependencies.operationId ?? randomUUID;
    this.isProfileOwned = dependencies.isProfileOwned ?? (() => true);
    this.writeAuthority =
      dependencies.writeAuthority ?? defaultModelConfigurationWriteAuthority;
    this.notifyRolledBack = dependencies.notifyRolledBack;
  }

  async mutate(
    request: ModelConfigurationMutationRequest,
    ownerGuard?: ModelConfigurationOwnerGuard,
  ): Promise<ModelConfigurationMutationResult> {
    const operation = operationForMutation(request);
    let ownerHandle: string;
    let preliminaryTarget: string;
    try {
      ownerGuard?.();
      validateMutationRequest(request);
      ownerHandle = validateOwnerHandle(this.ownerHandle());
      preliminaryTarget = validateProfileId(
        this.catalog.canonicalTargetProfileId(request.requestedProfileId),
      );
    } catch (error) {
      return {
        ...rejectedForError(error, "validation", "not_needed"),
        operation,
      };
    }
    const lockKey = `${ownerHandle}\0${preliminaryTarget}`;
    return this.withLock(lockKey, async () => {
      try {
        ownerGuard?.();
        const currentOwner = validateOwnerHandle(this.ownerHandle());
        const targetProfileId = validateProfileId(
          this.catalog.canonicalTargetProfileId(request.requestedProfileId),
        );
        if (
          currentOwner !== ownerHandle ||
          targetProfileId !== preliminaryTarget ||
          !(await this.isProfileOwned(ownerHandle, targetProfileId))
        ) {
          return rejected(
            "validation",
            "not_needed",
            false,
            undefined,
            operation,
          );
        }
        if (this.profileNeedsRecovery(ownerHandle, targetProfileId)) {
          return rejected(
            "recovery",
            "recovery_required",
            true,
            undefined,
            operation,
          );
        }
        const catalog = this.catalog.snapshot(request.requestedProfileId);
        // The profile the caller resolved to must still be the profile we would
        // write. A mismatch means the caller is looking at another profile, and
        // replaying the same request would resolve the same wrong way.
        if (catalog.targetProfileId !== targetProfileId) {
          return rejected(
            "validation",
            "not_needed",
            false,
            undefined,
            operation,
          );
        }
        // Checked before the replacement below: when the revision is stale the
        // replacement's revision is stale too, and reporting that as a plain
        // rejection would deny the caller its one legitimate retry.
        if (catalog.revision !== request.expectedCatalogRevision) {
          return rejectedStaleRevision(operation);
        }
        // Revision matches, so a replacement pinned to a different revision is
        // an internally inconsistent request rather than staleness.
        if (
          request.intent === "delete" &&
          request.replacement !== null &&
          request.replacement.catalogRevision !== catalog.revision
        ) {
          return rejected(
            "validation",
            "not_needed",
            false,
            undefined,
            operation,
          );
        }

        let prepared: PreparedModelConfigurationMutation;
        try {
          ownerGuard?.();
          prepared = await this.mutationAdapter.prepare(request, {
            ownerHandle,
            targetProfileId,
            catalog,
          });
          validatePreparedMutation(
            prepared,
            targetProfileId,
            request.intent === "upsert" ? request.apiKey : "",
          );
          const activeRoute = boundedRouteKey(
            await this.mutationAdapter.getActiveRouteKey(targetProfileId),
          );
          ownerGuard?.();
          if (activeRoute !== prepared.oldRouteKey) {
            return rejected(
              "validation",
              "not_needed",
              false,
              undefined,
              operation,
            );
          }
        } catch (error) {
          return {
            ...rejectedForError(error, "validation", "not_needed"),
            operation,
          };
        }

        if (prepared.location.kind === "remote") {
          if (
            prepared.location.transport === "legacy" ||
            !prepared.location.snapshotComplete
          ) {
            return rejected(
              "validation",
              "not_needed",
              false,
              undefined,
              operation,
            );
          }
          return withOperation(
            await this.executeRemoteMutation(
              prepared,
              targetProfileId,
              ownerGuard,
            ),
            operation,
          );
        }
        return withOperation(
          await this.executeLocalMutation(
            prepared,
            ownerHandle,
            targetProfileId,
            ownerGuard,
          ),
          operation,
        );
      } catch (error) {
        const ownerCode = ownerTransitionCode(error);
        return ownerCode
          ? rejected("validation", "not_needed", false, ownerCode, operation)
          : rejected(
              "recovery",
              "recovery_required",
              true,
              undefined,
              operation,
            );
      }
    });
  }

  async initializeManagedModelFiles(
    input: ManagedModelFileInitialization,
    ownerGuard?: ModelConfigurationOwnerGuard,
  ): Promise<ModelConfigurationMutationResult> {
    let ownerHandle: string;
    let preliminaryTarget: string;
    try {
      ownerGuard?.();
      if (
        !input ||
        typeof input !== "object" ||
        typeof input.changesRequired !== "boolean" ||
        typeof input.applyStage !== "function" ||
        typeof input.verify !== "function"
      ) {
        throw new Error("Invalid managed model initialization.");
      }
      ownerHandle = validateOwnerHandle(this.ownerHandle());
      preliminaryTarget = validateProfileId(input.targetProfileId);
      if (
        this.catalog.canonicalTargetProfileId(preliminaryTarget) !==
        preliminaryTarget
      ) {
        throw new Error("Managed model initialization target changed.");
      }
    } catch (error) {
      return rejectedForError(error, "validation", "not_needed");
    }

    const lockKey = `${ownerHandle}\0${preliminaryTarget}`;
    return this.withLock(lockKey, async () => {
      try {
        ownerGuard?.();
        const currentOwner = validateOwnerHandle(this.ownerHandle());
        const targetProfileId = validateProfileId(
          this.catalog.canonicalTargetProfileId(preliminaryTarget),
        );
        if (
          currentOwner !== ownerHandle ||
          targetProfileId !== preliminaryTarget ||
          !(await this.isProfileOwned(ownerHandle, targetProfileId))
        ) {
          return rejected("validation", "not_needed");
        }
        if (this.profileNeedsRecovery(ownerHandle, targetProfileId)) {
          return rejected("recovery", "recovery_required", true);
        }

        if (!input.changesRequired) {
          return this.writeAuthority.run(
            { globalCatalog: true, profileIds: [targetProfileId] },
            async () => {
              if (!(await input.verify())) {
                return rejected("verification", "not_needed");
              }
              const catalog = this.catalog.snapshot(targetProfileId);
              ownerGuard?.();
              if (catalog.targetProfileId !== targetProfileId) {
                return rejected("validation", "not_needed");
              }
              return { status: "committed", catalog };
            },
          );
        }

        const routeKey = boundedRouteKey(
          await this.mutationAdapter.getActiveRouteKey(targetProfileId),
        );
        return this.executeLocalMutation(
          {
            targetProfileId,
            oldRouteKey: routeKey,
            newRouteKey: routeKey,
            location: { kind: "local" },
            applyStage: input.applyStage,
            verify: async (catalog) =>
              catalog.targetProfileId === targetProfileId &&
              (await input.verify()),
            refreshPresentation: input.refreshPresentation,
          },
          ownerHandle,
          targetProfileId,
          ownerGuard,
        );
      } catch (error) {
        const ownerCode = ownerTransitionCode(error);
        return ownerCode
          ? rejected("validation", "not_needed", false, ownerCode)
          : rejected("recovery", "recovery_required", true);
      }
    });
  }

  async runManagedWrite<T>(
    input: ManagedModelConfigurationWriteRequest,
    prepare: (
      context: ManagedModelConfigurationWriteContext,
    ) => Awaitable<ManagedModelConfigurationWritePlan<T>>,
    ownerGuard?: ModelConfigurationOwnerGuard,
  ): Promise<ManagedModelConfigurationWriteResult<T>> {
    let ownerHandle: string;
    let preliminaryTarget: string;
    try {
      ownerGuard?.();
      if (
        !input ||
        typeof input !== "object" ||
        (input.scope !== "profile" && input.scope !== "global") ||
        !COMMIT_STAGES.includes(input.stage) ||
        typeof prepare !== "function"
      ) {
        throw new Error("Invalid managed model write request.");
      }
      ownerHandle = validateOwnerHandle(this.ownerHandle());
      preliminaryTarget = validateProfileId(
        this.catalog.canonicalTargetProfileId(input.requestedProfileId),
      );
    } catch (error) {
      return rejectedForError(error, "validation", "not_needed");
    }

    const lockKey = `${ownerHandle}\0${preliminaryTarget}`;
    return this.withLock(lockKey, async () => {
      try {
        ownerGuard?.();
        const currentOwner = validateOwnerHandle(this.ownerHandle());
        const targetProfileId = validateProfileId(
          this.catalog.canonicalTargetProfileId(input.requestedProfileId),
        );
        if (
          currentOwner !== ownerHandle ||
          targetProfileId !== preliminaryTarget ||
          !(await this.isProfileOwned(ownerHandle, targetProfileId))
        ) {
          return rejected("validation", "not_needed");
        }
        if (
          this.profileNeedsRecovery(ownerHandle, targetProfileId) ||
          (input.scope === "global" && this.anyProfileNeedsRecovery())
        ) {
          return rejected("recovery", "recovery_required", true);
        }

        const paths = this.files.paths(targetProfileId);
        let catalog: OwnerModelRouteCatalogSnapshot;
        let oldRouteKey: string;
        let plannedDigests: Record<ModelConfigurationFileRole, string>;
        let plan: ManagedModelConfigurationWritePlan<T>;
        let newRouteKey: string;
        try {
          ownerGuard?.();
          catalog = this.catalog.snapshot(input.requestedProfileId);
          if (catalog.targetProfileId !== targetProfileId) {
            return rejected("validation", "not_needed");
          }
          oldRouteKey = boundedRouteKey(
            await this.mutationAdapter.getActiveRouteKey(targetProfileId),
          );
          plannedDigests = await this.files.readDigests(paths);
          // Planning deliberately runs before an authority permit exists. A
          // planner that calls any protected writer therefore fails before a
          // backup, journal row, or managed byte can be created.
          plan = await prepare({
            ownerHandle,
            targetProfileId,
            catalog,
            oldRouteKey,
          });
          if (!plan || typeof plan.write !== "function") {
            throw new Error("Invalid managed model write plan.");
          }
          newRouteKey = boundedRouteKey(plan.newRouteKey ?? oldRouteKey);
          ownerGuard?.();
        } catch (error) {
          return rejectedForError(error, "validation", "not_needed");
        }

        return this.writeAuthority.run(
          {
            globalCatalog: input.scope === "global",
            profileIds: [targetProfileId],
          },
          async (permit): Promise<ManagedModelConfigurationWriteResult<T>> => {
            ownerGuard?.();
            // The global authority may have been queued behind another Profile.
            // Recheck ownership, recovery, catalog, route, and all five byte
            // digests before journalling the read-only plan.
            if (
              this.profileNeedsRecovery(ownerHandle, targetProfileId) ||
              (input.scope === "global" && this.anyProfileNeedsRecovery())
            ) {
              return rejected("recovery", "recovery_required", true);
            }
            const admittedOwner = validateOwnerHandle(this.ownerHandle());
            const admittedTarget = validateProfileId(
              this.catalog.canonicalTargetProfileId(input.requestedProfileId),
            );
            const admittedCatalog = this.catalog.snapshot(
              input.requestedProfileId,
            );
            const admittedRouteKey = boundedRouteKey(
              await this.mutationAdapter.getActiveRouteKey(targetProfileId),
            );
            const admittedDigests = await this.files.readDigests(paths);
            ownerGuard?.();
            if (
              admittedOwner !== ownerHandle ||
              admittedTarget !== targetProfileId ||
              !(await this.isProfileOwned(ownerHandle, targetProfileId)) ||
              admittedCatalog.targetProfileId !== targetProfileId ||
              admittedCatalog.revision !== catalog.revision ||
              admittedRouteKey !== oldRouteKey ||
              !digestsEqual(admittedDigests, plannedDigests)
            ) {
              return rejected("validation", "not_needed");
            }
            let value!: T;
            let executed = false;
            const prepared: PreparedModelConfigurationMutation = {
              targetProfileId,
              oldRouteKey,
              newRouteKey,
              location: { kind: "local" },
              applyStage: async (stage) => {
                if (stage !== input.stage) return;
                value = await plan.write(permit);
                executed = true;
              },
              verify: async (nextCatalog) =>
                executed &&
                (plan.verify ? await plan.verify(nextCatalog, value) : true),
              refreshPresentation: plan.refreshPresentation,
            };
            const result = await this.executeLocalMutationWithinPermit(
              prepared,
              ownerHandle,
              targetProfileId,
              permit,
              ownerGuard,
            );
            if (result.status === "rejected") return result;
            return {
              status: "executed",
              value,
              catalog: result.catalog,
              ...(result.status === "committed_refresh_warning"
                ? { warning: result.warning }
                : {}),
            };
          },
        );
      } catch (error) {
        const ownerCode = ownerTransitionCode(error);
        return ownerCode
          ? rejected("validation", "not_needed", false, ownerCode)
          : rejected("recovery", "recovery_required", true);
      }
    });
  }

  async recoverIncompleteOperations(): Promise<void> {
    const records = this.operationStore.listIncomplete();
    for (const record of records) {
      const lockKey = `${record.ownerHandle}\0${record.profileId}`;
      await this.withLock(lockKey, async () => {
        await this.writeAuthority.run(
          { globalCatalog: true, profileIds: [record.profileId] },
          async () => {
            try {
              validateOwnerHandle(record.ownerHandle);
              validateProfileId(record.profileId);
              if (
                !(await this.isProfileOwned(
                  record.ownerHandle,
                  record.profileId,
                ))
              ) {
                throw new Error("Model configuration recovery owner mismatch.");
              }
              const paths = this.files.paths(record.profileId);
              const snapshot = reconstructSnapshot(record, paths);
              const currentDigests = await this.files.readDigests(paths);
              const activeRouteKey = boundedRouteKey(
                await this.mutationAdapter.getActiveRouteKey(record.profileId),
              );
              if (
                completeDigests(record.afterDigests) &&
                digestsEqual(currentDigests, record.afterDigests) &&
                routeKeysMatch(record.newRouteKey, activeRouteKey)
              ) {
                this.operationStore.finish(record.operationId, "committed");
                await this.removeBackupsSafely(snapshot);
                this.recoveryRequired.delete(lockKey);
                return;
              }

              if (
                digestsEqual(currentDigests, record.beforeDigests) &&
                routeKeysMatch(record.oldRouteKey, activeRouteKey)
              ) {
                this.operationStore.finish(record.operationId, "rolled_back");
                await this.removeBackupsSafely(snapshot);
                this.recoveryRequired.delete(lockKey);
                await this.notifyRolledBackOrLog();
                return;
              }

              await this.files.restore(snapshot);
              const restoredDigests = await this.files.readDigests(paths);
              const restoredRouteKey = boundedRouteKey(
                await this.mutationAdapter.getActiveRouteKey(record.profileId),
              );
              if (
                !digestsEqual(restoredDigests, record.beforeDigests) ||
                !routeKeysMatch(record.oldRouteKey, restoredRouteKey)
              ) {
                throw new Error(
                  "Model configuration recovery verification failed.",
                );
              }
              this.operationStore.finish(record.operationId, "rolled_back");
              await this.removeBackupsSafely(snapshot);
              this.recoveryRequired.delete(lockKey);
              await this.notifyRolledBackOrLog();
            } catch {
              try {
                this.operationStore.finish(
                  record.operationId,
                  "recovery_required",
                );
              } catch {
                // The caller will fail startup closed if even the recovery journal
                // cannot record the terminal recovery-required state.
              }
              this.recoveryRequired.add(lockKey);
            }
          },
        );
      });
    }
  }

  private async executeLocalMutation(
    prepared: PreparedModelConfigurationMutation,
    ownerHandle: string,
    targetProfileId: string,
    ownerGuard?: ModelConfigurationOwnerGuard,
  ): Promise<ModelConfigurationMutationResult> {
    return this.writeAuthority.run(
      { globalCatalog: true, profileIds: [targetProfileId] },
      (permit) =>
        this.executeLocalMutationWithinPermit(
          prepared,
          ownerHandle,
          targetProfileId,
          permit,
          ownerGuard,
        ),
    );
  }

  private async executeLocalMutationWithinPermit(
    prepared: PreparedModelConfigurationMutation,
    ownerHandle: string,
    targetProfileId: string,
    permit: ModelConfigurationWritePermit,
    ownerGuard?: ModelConfigurationOwnerGuard,
  ): Promise<ModelConfigurationMutationResult> {
    const operationId = this.operationId();
    const paths = this.files.paths(targetProfileId);
    let snapshot: ModelConfigurationFilesSnapshot | undefined;
    let journalStarted = false;
    try {
      ownerGuard?.();
      snapshot = await this.files.capture({
        profileId: targetProfileId,
        operationId,
        paths,
      });
      ownerGuard?.();
      this.operationStore.begin({
        operationId,
        ownerHandle,
        profileId: targetProfileId,
        oldRouteKey: prepared.oldRouteKey,
        newRouteKey: prepared.newRouteKey,
        snapshot,
      });
      journalStarted = true;
      // The journal is the recovery authority. It must exist before any
      // backup or managed byte is touched, so a crash in backup creation is
      // represented by a recoverable prepared row rather than an orphaned
      // filesystem artifact.
      await this.files.persistBackups(snapshot);
      ownerGuard?.();
    } catch (error) {
      if (journalStarted && snapshot && ownerTransitionCode(error)) {
        return this.rollbackLocalMutation(
          operationId,
          snapshot,
          paths,
          prepared.oldRouteKey,
          ownerHandle,
          targetProfileId,
          "validation",
          ownerTransitionCode(error) ?? undefined,
          ownerTransitionDiagnosticId(error),
        );
      }
      if (journalStarted) {
        const lockKey = `${ownerHandle}\0${targetProfileId}`;
        try {
          this.operationStore.finish(operationId, "recovery_required");
        } catch {
          // Preserve the in-memory fail-closed lock if the journal itself is
          // unavailable; startup will remain closed until it can be read.
        }
        this.recoveryRequired.add(lockKey);
        return rejected("recovery", "recovery_required", true);
      }
      if (snapshot) await this.removeBackupsSafely(snapshot);
      return rejectedForError(error, "validation", "not_needed");
    }

    for (const stage of COMMIT_STAGES) {
      try {
        ownerGuard?.();
        await prepared.applyStage(stage, permit);
        ownerGuard?.();
        const afterDigests = await this.files.readDigests(paths);
        ownerGuard?.();
        this.operationStore.advance({
          operationId,
          state: stage,
          stage,
          afterDigests,
        });
      } catch (error) {
        return this.rollbackLocalMutation(
          operationId,
          snapshot,
          paths,
          prepared.oldRouteKey,
          ownerHandle,
          targetProfileId,
          stage,
          ownerTransitionCode(error) ?? undefined,
          ownerTransitionDiagnosticId(error),
        );
      }
    }

    let catalog: OwnerModelRouteCatalogSnapshot;
    try {
      ownerGuard?.();
      catalog = this.catalog.snapshot(targetProfileId);
      if (
        catalog.targetProfileId !== targetProfileId ||
        !(await prepared.verify(catalog))
      ) {
        throw new Error("Model configuration verification failed.");
      }
      const activeRoute = boundedRouteKey(
        await this.mutationAdapter.getActiveRouteKey(targetProfileId),
      );
      ownerGuard?.();
      if (activeRoute !== prepared.newRouteKey) {
        throw new Error("Model configuration activation verification failed.");
      }
      const afterDigests = await this.files.readDigests(paths);
      ownerGuard?.();
      this.operationStore.advance({
        operationId,
        state: "verification",
        stage: "verification",
        afterDigests,
      });
      ownerGuard?.();
      this.operationStore.finish(operationId, "committed");
      await this.removeBackupsSafely(snapshot);
    } catch (error) {
      return this.rollbackLocalMutation(
        operationId,
        snapshot,
        paths,
        prepared.oldRouteKey,
        ownerHandle,
        targetProfileId,
        "verification",
        ownerTransitionCode(error) ?? undefined,
      );
    }

    try {
      await prepared.refreshPresentation?.();
      return { status: "committed", catalog };
    } catch {
      return {
        status: "committed_refresh_warning",
        catalog,
        warning: "model_save_refresh_failed",
      };
    }
  }

  private async rollbackLocalMutation(
    operationId: string,
    snapshot: ModelConfigurationFilesSnapshot,
    paths: ModelConfigurationFilePaths,
    oldRouteKey: string,
    ownerHandle: string,
    targetProfileId: string,
    failedStage: ModelConfigurationStage,
    failureCode?: ModelConfigurationOwnerTransitionCode,
    failureDiagnosticId?: string,
  ): Promise<ModelConfigurationMutationResult> {
    const lockKey = `${ownerHandle}\0${targetProfileId}`;
    try {
      const record = this.operationStore.require(operationId);
      const currentDigests = await this.files.readDigests(paths);
      const currentRouteKey = boundedRouteKey(
        await this.mutationAdapter.getActiveRouteKey(targetProfileId),
      );
      if (
        digestsEqual(currentDigests, record.beforeDigests) &&
        currentRouteKey === oldRouteKey
      ) {
        this.operationStore.finish(operationId, "rolled_back");
        await this.removeBackupsSafely(snapshot);
        this.recoveryRequired.delete(lockKey);
        const rollbackWarning = await this.notifyRolledBackSafely();
        return {
          ...rejected(failedStage, "not_needed"),
          ...(failureCode
            ? {
                ...rejected(
                  failedStage,
                  "not_needed",
                  false,
                  failureCode,
                  "save_model",
                  failureDiagnosticId,
                ),
              }
            : {}),
          ...(rollbackWarning ? { rollbackWarning } : {}),
        };
      }

      await this.files.restore(snapshot);
      const restoredDigests = await this.files.readDigests(paths);
      const restoredRouteKey = boundedRouteKey(
        await this.mutationAdapter.getActiveRouteKey(targetProfileId),
      );
      if (
        !digestsEqual(restoredDigests, record.beforeDigests) ||
        restoredRouteKey !== oldRouteKey
      ) {
        throw new Error("Model configuration rollback verification failed.");
      }
      this.operationStore.finish(operationId, "rolled_back");
      await this.removeBackupsSafely(snapshot);
      this.recoveryRequired.delete(lockKey);
      const rollbackWarning = await this.notifyRolledBackSafely();
      return {
        ...rejected(failedStage, "restored"),
        ...(failureCode
          ? {
              ...rejected(
                failedStage,
                "restored",
                false,
                failureCode,
                "save_model",
                failureDiagnosticId,
              ),
            }
          : {}),
        ...(rollbackWarning ? { rollbackWarning } : {}),
      };
    } catch {
      try {
        this.operationStore.finish(operationId, "recovery_required");
      } catch {
        // Preserve the original rollback failure and all remaining backups.
      }
      this.recoveryRequired.add(lockKey);
      return rejected("recovery", "recovery_required", true);
    }
  }

  private async executeRemoteMutation(
    prepared: PreparedModelConfigurationMutation,
    targetProfileId: string,
    ownerGuard?: ModelConfigurationOwnerGuard,
  ): Promise<ModelConfigurationMutationResult> {
    const location = prepared.location;
    if (location.kind !== "remote") {
      return rejected("validation", "not_needed");
    }
    let failedStage: ModelConfigurationStage = "validation";
    try {
      for (const stage of COMMIT_STAGES) {
        failedStage = stage;
        ownerGuard?.();
        await prepared.applyStage(stage, null);
        ownerGuard?.();
      }
      failedStage = "verification";
      ownerGuard?.();
      const catalog = this.catalog.snapshot(targetProfileId);
      if (!(await prepared.verify(catalog))) {
        throw new Error("Remote model configuration verification failed.");
      }
      ownerGuard?.();
      try {
        await prepared.refreshPresentation?.();
        return { status: "committed", catalog };
      } catch {
        return {
          status: "committed_refresh_warning",
          catalog,
          warning: "model_save_refresh_failed",
        };
      }
    } catch (error) {
      try {
        await location.restore();
        if (!(await location.verifyRestore())) {
          throw new Error("Remote model configuration restore failed.");
        }
        return rejectedForError(error, failedStage, "restored");
      } catch {
        return rejected("recovery", "recovery_required", true);
      }
    }
  }

  private profileNeedsRecovery(
    ownerHandle: string,
    profileId: string,
  ): boolean {
    const key = `${ownerHandle}\0${profileId}`;
    if (this.recoveryRequired.has(key)) return true;
    try {
      return this.operationStore
        .listIncomplete()
        .some(
          (record) =>
            record.ownerHandle === ownerHandle &&
            record.profileId === profileId,
        );
    } catch {
      return true;
    }
  }

  private anyProfileNeedsRecovery(): boolean {
    if (this.recoveryRequired.size > 0) return true;
    try {
      return this.operationStore.listIncomplete().length > 0;
    } catch {
      return true;
    }
  }

  private async removeBackupsSafely(
    snapshot: ModelConfigurationFilesSnapshot,
  ): Promise<void> {
    try {
      await this.files.removeBackups(snapshot);
    } catch {
      // A verified terminal product state is not reclassified as a failed save
      // solely because restrictive sibling evidence could not yet be removed.
    }
  }

  private async notifyRolledBackSafely(): Promise<
    "model_rollback_refresh_failed" | undefined
  > {
    if (!this.notifyRolledBack) return undefined;
    try {
      await this.notifyRolledBack();
      return undefined;
    } catch {
      return "model_rollback_refresh_failed";
    }
  }

  private async notifyRolledBackOrLog(): Promise<void> {
    if (await this.notifyRolledBackSafely()) {
      console.error(
        "[MODEL_CONFIGURATION] rollback refresh notification failed",
      );
    }
  }

  private async withLock<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(work);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(key, tail);
    try {
      return await run;
    } finally {
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }
}
