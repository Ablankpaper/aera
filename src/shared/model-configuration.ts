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
        | "model_configuration_recovery_required";
      rollback: "not_needed" | "restored" | "recovery_required";
    };

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
