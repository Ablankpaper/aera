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
  | "model_configuration_recovery_required";

/** Public startup failure identity. Raw native/database errors stay in Main. */
export interface ModelConfigurationStartupFailure {
  code: ModelConfigurationStartupFailureCode;
  diagnosticId: string;
}

export type ModelConfigurationMutationResult =
  | { status: "committed"; catalog: OwnerModelRouteCatalogSnapshot }
  | {
      status: "committed_refresh_warning";
      catalog: OwnerModelRouteCatalogSnapshot;
      warning: "model_save_refresh_failed";
    }
  | {
      status: "rejected";
      stage: ModelConfigurationStage;
      code:
        | `model_save_${ModelConfigurationStage}_failed`
        | ModelConfigurationStartupFailureCode;
      rollback: "not_needed" | "restored" | "recovery_required";
      /** Opaque correlation id for startup/unavailable-runtime failures. */
      diagnosticId?: string;
      /**
       * Set only when the caller's `expectedCatalogRevision` did not match the
       * coordinator's current catalog — the one rejection a caller can fix by
       * re-reading the catalog. Every other refusal (illegal request, unowned
       * profile, missing replacement, moved active route) leaves this absent,
       * because replaying those would fail again in exactly the same way.
       */
      reason?: "stale_catalog_revision";
    };

/**
 * Whether a rejected mutation may be safely replayed against a fresh catalog.
 *
 * Requires all three of:
 *   - an explicit `stale_catalog_revision` reason, so only a revision mismatch
 *     qualifies and never some other validation refusal;
 *   - the `validation` stage, which runs before any adapter work;
 *   - `rollback: "not_needed"`, proving nothing was written and a replay
 *     therefore cannot double-apply.
 */
export function isSafeToRetryStaleRevision(
  result: ModelConfigurationMutationResult,
): boolean {
  return (
    result.status === "rejected" &&
    result.reason === "stale_catalog_revision" &&
    result.stage === "validation" &&
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
  return [
    route.provider.trim().toLocaleLowerCase(),
    route.model.trim(),
    route.baseUrl.trim().replace(/\/+$/, "").toLocaleLowerCase(),
    route.apiMode?.trim().toLocaleLowerCase() || "",
  ].join("\0");
}
