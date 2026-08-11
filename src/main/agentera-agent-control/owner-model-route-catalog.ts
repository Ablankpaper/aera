import { createHash } from "node:crypto";
import {
  canonicalPublicRouteKey,
  type OwnerModelRouteCatalogSnapshot,
  type OwnerModelRouteSelection,
  type OwnerModelRouteSummary,
  type PublicModelRouteIdentity,
} from "../../shared/model-configuration";
import { isLocalBaseUrl } from "../../shared/url-key-map";

const MAX_PROFILE_ID_LENGTH = 64;
const MAX_MODEL_ID_LENGTH = 512;
const MAX_ROUTE_ID_LENGTH = 1024;

export interface OwnerModelProfileDescriptor {
  id: string;
  ownerKey?: string;
  isDefault: boolean;
  isActive: boolean;
  agentInstallationId: string | null;
}

/**
 * Main-only route identity. `credentialRef` is an environment/credential
 * anchor, never the credential value, and is stripped before a snapshot leaves
 * Main.
 */
export interface ResolvedOwnerModelRoute extends PublicModelRouteIdentity {
  id: string;
  sourceProfileId: string;
  modelLibraryId: string;
  providerLabel: string;
  displayName: string;
  credentialRef: string | null;
  credentialAvailable?: boolean;
}

export interface OwnerModelRouteCatalogDependencies {
  getOwnerKey: () => string;
  getActiveProfileId?: () => string;
  listProfiles: () => readonly OwnerModelProfileDescriptor[];
  listResolvedRoutes: (profileId: string) => readonly ResolvedOwnerModelRoute[];
  /** Re-read a selected route immediately before an operation, if available. */
  resolveRoute?: (
    sourceProfileId: string,
    modelLibraryId: string,
  ) => ResolvedOwnerModelRoute | null;
}

function codedError(code: string): Error {
  return Object.assign(new Error(`Aera model route failed: ${code}.`), {
    code,
  });
}

function boundedString(
  value: unknown,
  max: number,
  code = "model_switch_route_unavailable",
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > max ||
    /[\0\r\n]/.test(value)
  ) {
    throw codedError(code);
  }
  return value;
}

function boundedRouteId(value: unknown): string {
  // Route IDs are Main-generated composite identities (`profile\0row`). NUL
  // is the delimiter, not user content, so it is valid in this one field;
  // retain the length and line-control protections used for public strings.
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_ROUTE_ID_LENGTH ||
    /[\r\n]/.test(value)
  ) {
    throw codedError("model_switch_route_unavailable");
  }
  return value;
}

function routeIsUsable(route: ResolvedOwnerModelRoute): boolean {
  if (route.credentialAvailable === false) return false;
  return route.credentialRef !== null || isLocalBaseUrl(route.baseUrl);
}

function profileSort(
  a: OwnerModelProfileDescriptor,
  b: OwnerModelProfileDescriptor,
): number {
  return a.id.localeCompare(b.id);
}

function routeSort(
  a: ResolvedOwnerModelRoute,
  b: ResolvedOwnerModelRoute,
): number {
  const keyA = canonicalPublicRouteKey(a);
  const keyB = canonicalPublicRouteKey(b);
  return (
    keyA.localeCompare(keyB) ||
    a.sourceProfileId.localeCompare(b.sourceProfileId) ||
    a.modelLibraryId.localeCompare(b.modelLibraryId)
  );
}

function publicRoute(
  route: ResolvedOwnerModelRoute,
  revision: string,
  sourceKind: "account" | "legacy_agent",
): OwnerModelRouteSummary {
  return {
    id: boundedRouteId(route.id),
    provider: boundedString(route.provider, MAX_MODEL_ID_LENGTH),
    model: boundedString(route.model, MAX_MODEL_ID_LENGTH),
    baseUrl: boundedString(route.baseUrl, MAX_MODEL_ID_LENGTH),
    apiMode: route.apiMode === null ? null : boundedString(route.apiMode, 64),
    providerLabel: boundedString(
      route.providerLabel || route.provider,
      MAX_MODEL_ID_LENGTH,
    ),
    displayName: boundedString(
      route.displayName || route.model,
      MAX_MODEL_ID_LENGTH,
    ),
    sourceProfileId: boundedString(
      route.sourceProfileId,
      MAX_PROFILE_ID_LENGTH,
    ),
    sourceKind,
    selection: {
      sourceProfileId: boundedString(
        route.sourceProfileId,
        MAX_PROFILE_ID_LENGTH,
      ),
      modelLibraryId: boundedString(route.modelLibraryId, MAX_MODEL_ID_LENGTH),
      catalogRevision: revision,
    },
  };
}

export class OwnerModelRouteCatalog {
  private readonly dependencies: OwnerModelRouteCatalogDependencies;
  private readonly defaultRequestedProfileId: string | undefined;

  constructor(
    dependencies: OwnerModelRouteCatalogDependencies,
    defaultRequestedProfileId?: string,
  ) {
    this.dependencies = dependencies;
    this.defaultRequestedProfileId = defaultRequestedProfileId;
  }

  canonicalTargetProfileId(requestedProfileId?: string): string {
    const ownerKey = this.dependencies.getOwnerKey();
    const profiles = this.ownerProfiles(ownerKey);
    const accountProfiles = profiles
      .filter((profile) => profile.agentInstallationId === null)
      .sort(profileSort);
    const requested = profiles.find(
      (profile) =>
        profile.id === (requestedProfileId ?? this.defaultRequestedProfileId) &&
        profile.agentInstallationId === null,
    );
    if (requested) return requested.id;
    const defaultProfile = accountProfiles.find((profile) => profile.isDefault);
    if (defaultProfile) return defaultProfile.id;
    if (accountProfiles[0]) return accountProfiles[0].id;

    const activeProfileId = this.dependencies.getActiveProfileId?.();
    const activeInstalled = profiles.find(
      (profile) =>
        profile.agentInstallationId !== null &&
        (profile.isActive || profile.id === activeProfileId),
    );
    if (activeInstalled) return activeInstalled.id;
    const installed = profiles
      .filter((profile) => profile.agentInstallationId !== null)
      .sort(profileSort);
    if (installed[0]) return installed[0].id;
    throw codedError("model_catalog_empty");
  }

  snapshot(requestedProfileId?: string): OwnerModelRouteCatalogSnapshot {
    const ownerKey = this.dependencies.getOwnerKey();
    const profiles = this.ownerProfiles(ownerKey);
    const targetProfileId = this.canonicalTargetProfileId(requestedProfileId);
    const ordered = this.orderedProfiles(profiles, targetProfileId);
    const candidates: ResolvedOwnerModelRoute[] = [];
    const seen = new Set<string>();
    for (const profile of ordered) {
      for (const candidate of this.dependencies.listResolvedRoutes(
        profile.id,
      )) {
        if (
          candidate.sourceProfileId !== profile.id ||
          !routeIsUsable(candidate)
        ) {
          continue;
        }
        const key = canonicalPublicRouteKey(candidate);
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push({ ...candidate });
      }
    }

    const revision = this.revision(ownerKey, targetProfileId, candidates);
    return {
      revision,
      targetProfileId,
      routes: candidates.map((candidate) => {
        const profile = profiles.find(
          (entry) => entry.id === candidate.sourceProfileId,
        );
        return publicRoute(
          candidate,
          revision,
          profile?.agentInstallationId ? "legacy_agent" : "account",
        );
      }),
    };
  }

  resolve(selection: OwnerModelRouteSelection): ResolvedOwnerModelRoute {
    const snapshot = this.snapshot();
    if (selection.catalogRevision !== snapshot.revision) {
      throw codedError("model_switch_route_stale");
    }
    boundedString(selection.sourceProfileId, MAX_PROFILE_ID_LENGTH);
    boundedString(selection.modelLibraryId, MAX_MODEL_ID_LENGTH);
    const profile = this.ownerProfiles(this.dependencies.getOwnerKey()).find(
      (candidate) => candidate.id === selection.sourceProfileId,
    );
    if (!profile) throw codedError("model_switch_route_owner_mismatch");

    const refreshed = this.dependencies.resolveRoute?.(
      selection.sourceProfileId,
      selection.modelLibraryId,
    );
    const route =
      refreshed ??
      this.dependencies
        .listResolvedRoutes(selection.sourceProfileId)
        .find(
          (candidate) => candidate.modelLibraryId === selection.modelLibraryId,
        );
    if (!route || route.sourceProfileId !== selection.sourceProfileId) {
      throw codedError("model_switch_route_unavailable");
    }
    if (!routeIsUsable(route)) {
      throw codedError("model_switch_credential_unavailable");
    }
    return { ...route };
  }

  private ownerProfiles(ownerKey: string): OwnerModelProfileDescriptor[] {
    return this.dependencies
      .listProfiles()
      .filter(
        (profile) =>
          profile.ownerKey === undefined || profile.ownerKey === ownerKey,
      )
      .map((profile) => ({ ...profile }));
  }

  private orderedProfiles(
    profiles: readonly OwnerModelProfileDescriptor[],
    targetProfileId: string,
  ): OwnerModelProfileDescriptor[] {
    const account = profiles
      .filter((profile) => profile.agentInstallationId === null)
      .sort(profileSort);
    const installed = profiles
      .filter((profile) => profile.agentInstallationId !== null)
      .sort(profileSort);
    const result: OwnerModelProfileDescriptor[] = [];
    const add = (profile: OwnerModelProfileDescriptor | undefined): void => {
      if (profile && !result.some((candidate) => candidate.id === profile.id)) {
        result.push(profile);
      }
    };
    add(account.find((profile) => profile.id === targetProfileId));
    add(account.find((profile) => profile.isDefault));
    for (const profile of account) add(profile);

    const activeProfileId = this.dependencies.getActiveProfileId?.();
    add(
      installed.find(
        (profile) => profile.id === activeProfileId || profile.isActive,
      ),
    );
    for (const profile of installed) add(profile);
    return result;
  }

  private revision(
    ownerKey: string,
    targetProfileId: string,
    routes: readonly ResolvedOwnerModelRoute[],
  ): string {
    const material = routes
      .slice()
      .sort(routeSort)
      .map((route) => ({
        id: route.id,
        sourceProfileId: route.sourceProfileId,
        modelLibraryId: route.modelLibraryId,
        identity: canonicalPublicRouteKey(route),
        credentialAvailable: route.credentialRef !== null,
      }));
    return createHash("sha256")
      .update(
        JSON.stringify({
          ownerKey,
          targetProfileId,
          routes: material,
        }),
        "utf8",
      )
      .digest("hex");
  }
}
