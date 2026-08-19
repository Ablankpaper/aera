import { routeKeyV2 } from "./model-route-identity";

export {
  MODEL_ROUTE_KEY_VERSION,
  canonicalModelEndpointV2,
  isLegacyModelRouteKeyV1,
  isModelRouteKeyV2,
  routeKeyMatches,
  routeKeysMatch,
  routeKeyV2,
  type ModelRouteIdentityV2,
} from "./model-route-identity";

/**
 * Public model-route identity shared by Main and Renderer. Credential values
 * and Main-only credential references intentionally do not belong here.
 */
export interface PublicModelRouteIdentity {
  provider: string;
  model: string;
  baseUrl: string;
  apiMode: string | null;
}

/** An opaque owner route selection that Main must resolve again. */
export interface OwnerModelRouteSelection {
  sourceProfileId: string;
  modelLibraryId: string;
  catalogRevision: string;
}

export interface OwnerModelRouteSummary extends PublicModelRouteIdentity {
  id: string;
  providerLabel: string;
  displayName: string;
  sourceProfileId: string;
  sourceKind: "account" | "legacy_agent";
  selection: OwnerModelRouteSelection;
}

export interface OwnerModelRouteCatalogSnapshot {
  revision: string;
  targetProfileId: string;
  routes: OwnerModelRouteSummary[];
}

/** Renderer-safe model context for an installed Agent conversation. */
export interface AgentConversationModelContext {
  threadId: string;
  policyMode: "user_select" | "allowlist" | "fixed";
  activeRoute: PublicModelRouteIdentity;
  activeSegmentOrdinal: number;
  catalog: OwnerModelRouteCatalogSnapshot;
  switchDisabledCode: "model_switch_fixed_policy" | null;
}

/** Main-to-renderer lifecycle notification for a candidate Agent segment. */
export interface AgentConversationSegmentEvent {
  state: "preparing" | "active" | "failed";
  threadId: string;
  segmentId: string;
  from: PublicModelRouteIdentity;
  to: PublicModelRouteIdentity;
  historyBoundaryCount: number;
  code: string | null;
}

/** Renderer-safe cold-resume marker derived from activated segment metadata. */
export interface AgentConversationModelSwitchMarker {
  threadId: string;
  segmentId: string;
  from: PublicModelRouteIdentity;
  to: PublicModelRouteIdentity;
  historyBoundaryCount: number;
}

/** Safe Main result for resolving any historical segment during cold resume. */
export interface AgentConversationThreadResumeProjection {
  activeSessionId: string;
  threadId: string;
  markers: AgentConversationModelSwitchMarker[];
}

export type ModelConfigurationStage =
  | "validation"
  | "credential"
  | "provider"
  | "model_library"
  | "native_route"
  | "activation"
  | "verification"
  | "rollback"
  | "recovery";

export interface UpsertModelServiceRequest {
  intent: "upsert";
  expectedCatalogRevision: string;
  requestedProfileId: string;
  /** Stable providers.json id when editing an existing named custom provider. */
  providerId?: string;
  provider: string;
  providerLabel: string;
  baseUrl: string;
  apiMode: string | null;
  apiKey: string;
  models: Array<{
    model: string;
    displayName: string;
    contextLength?: number;
  }>;
  activeModel: string;
}

export interface DeleteModelServiceRequest {
  intent: "delete";
  expectedCatalogRevision: string;
  requestedProfileId: string;
  providerLabel: string;
  replacement: OwnerModelRouteSelection | null;
}

export type ModelConfigurationMutationRequest =
  | UpsertModelServiceRequest
  | DeleteModelServiceRequest;

/** Stable, Renderer-safe causes for an unavailable model configuration runtime. */
export type ModelConfigurationStartupFailureCode =
  | "native_module_abi_mismatch"
  | "native_module_architecture_mismatch"
  | "native_module_dependency_missing"
  | "native_module_load_denied"
  | "native_module_load_failed"
  | "model_configuration_database_unavailable"
  | "model_configuration_schema_unsupported"
  | "route_catalog_repair_required"
  | "model_configuration_recovery_required";

export type ModelConfigurationOwnerTransitionCode =
  | "model_owner_transition_in_progress"
  | "model_owner_changed"
  | "owner_transition_timeout"
  | "owner_transition_failed";

export type ModelConfigurationOperation =
  | "startup"
  | "save_provider"
  | "remove_provider"
  | "save_model"
  | "remove_model"
  | "activate_route"
  | "repair_route_catalog"
  | "rollback"
  | "refresh";

export type ModelConfigurationFailureStage =
  | "native_load"
  | "database_open"
  | "schema"
  | "recovery"
  | "route_repair"
  | "revision"
  | "owner"
  | ModelConfigurationStage;

export type ModelConfigurationFailureCode =
  | ModelConfigurationStartupFailureCode
  | ModelConfigurationOwnerTransitionCode
  | "model_save_stale_catalog_revision"
  | "model_save_validation_failed"
  | "model_save_credential_failed"
  | "model_save_provider_failed"
  | "model_save_model_library_failed"
  | "model_save_native_route_failed"
  | "model_save_activation_failed"
  | "model_save_verification_failed"
  | "model_save_rollback_failed"
  | "model_rollback_refresh_failed";

export type ModelConfigurationRetryability =
  | "retryable"
  | "after_restart"
  | "after_user_action"
  | "not_retryable";

export interface ModelConfigurationFailureV2 {
  schemaVersion: 2;
  operation: ModelConfigurationOperation;
  stage: ModelConfigurationFailureStage;
  code: ModelConfigurationFailureCode;
  retryability: ModelConfigurationRetryability;
  diagnosticId: string;
}

/** Public startup failure identity. Raw native/database errors stay in Main. */
export interface ModelConfigurationStartupFailure {
  code: ModelConfigurationStartupFailureCode;
  diagnosticId: string;
}

export type ModelConfigurationMutationFailure = ModelConfigurationFailureV2 & {
  status: "rejected";
  rollback: "not_needed" | "restored" | "recovery_required";
  /** Compatibility hint retained for callers that can safely re-read once. */
  reason?: "stale_catalog_revision";
  rollbackWarning?: "model_rollback_refresh_failed";
};

/** @deprecated Main now emits ModelConfigurationFailureV2; kept for internal
 * test doubles and legacy feature adapters until their next type-only cleanup. */
export type LegacyModelConfigurationMutationFailure = {
  status: "rejected";
  stage: ModelConfigurationStage;
  code: Exclude<
    ModelConfigurationFailureCode,
    "model_save_stale_catalog_revision" | "model_rollback_refresh_failed"
  >;
  rollback: "not_needed" | "restored" | "recovery_required";
  diagnosticId?: string;
  rollbackWarning?: "model_rollback_refresh_failed";
  reason?: "stale_catalog_revision";
};

export type ModelConfigurationMutationResult =
  | { status: "committed"; catalog: OwnerModelRouteCatalogSnapshot }
  | {
      status: "committed_refresh_warning";
      catalog: OwnerModelRouteCatalogSnapshot;
      warning: "model_save_refresh_failed";
    }
  | ModelConfigurationMutationFailure;

/**
 * Whether a rejected mutation may be safely replayed against a fresh catalog.
 *
 * Requires all three of:
 *   - an explicit `stale_catalog_revision` reason, so only a revision mismatch
 *     qualifies and never some other validation refusal;
 *   - the V2 `revision` stage (or legacy `validation`), which runs before any
 *     adapter work;
 *   - `rollback: "not_needed"`, proving nothing was written and a replay
 *     therefore cannot double-apply.
 */
export function isSafeToRetryStaleRevision(
  result:
    | ModelConfigurationMutationResult
    | LegacyModelConfigurationMutationFailure,
): boolean {
  return (
    result.status === "rejected" &&
    result.reason === "stale_catalog_revision" &&
    (result.stage === "revision" || result.stage === "validation") &&
    result.rollback === "not_needed"
  );
}

/**
 * Canonical identity used for deduplication and revision calculation. API
 * mode is part of the identity: the same model at the same endpoint can use
 * two different wire protocols.
 */
export function canonicalPublicRouteKey(
  route: PublicModelRouteIdentity,
): string {
  return routeKeyV2({
    providerId: route.provider,
    modelId: route.model,
    endpoint: route.baseUrl,
    apiMode: route.apiMode ?? "",
  });
}
