// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import {
  OwnerModelRouteCatalog,
  type OwnerModelRouteCatalogDependencies,
  type OwnerModelProfileDescriptor,
  type ResolvedOwnerModelRoute,
} from "./owner-model-route-catalog";

const OWNER = "tenant-owner-device";

function route(
  sourceProfileId: string,
  model: string,
  overrides: Partial<ResolvedOwnerModelRoute> = {},
): ResolvedOwnerModelRoute {
  return {
    id: `${sourceProfileId}-${model}`,
    sourceProfileId,
    modelLibraryId: `${sourceProfileId}-${model}-library`,
    provider: "custom:petoi",
    providerLabel: "Petoi",
    model,
    displayName: model,
    baseUrl: "https://api.petoi.cn/v1",
    apiMode: "chat_completions",
    credentialRef: "PETOI_API_KEY",
    ...overrides,
  };
}

function profile(
  id: string,
  overrides: Partial<OwnerModelProfileDescriptor> = {},
): OwnerModelProfileDescriptor {
  return {
    id,
    ownerKey: OWNER,
    isDefault: false,
    isActive: false,
    agentInstallationId: null,
    ...overrides,
  };
}

function subject(
  profiles: OwnerModelProfileDescriptor[],
  routes: Record<string, ResolvedOwnerModelRoute[]>,
  requestedProfileId?: string,
): {
  catalog: OwnerModelRouteCatalog;
  dependencies: OwnerModelRouteCatalogDependencies;
} {
  const dependencies: OwnerModelRouteCatalogDependencies = {
    getOwnerKey: () => OWNER,
    getActiveProfileId: () => "installed",
    listProfiles: () => profiles,
    listResolvedRoutes: (profileId) => routes[profileId] ?? [],
  };
  return {
    catalog: new OwnerModelRouteCatalog(dependencies, requestedProfileId),
    dependencies,
  };
}

describe("OwnerModelRouteCatalog", () => {
  it("keeps an active installed-Profile route visible beside account Profiles", () => {
    const { catalog } = subject(
      [
        profile("account", { isDefault: true }),
        profile("installed", {
          isActive: true,
          agentInstallationId: "installation-1",
        }),
      ],
      {
        account: [route("account", "old-model")],
        installed: [route("installed", "new-model")],
      },
      "installed",
    );

    const snapshot = catalog.snapshot();
    expect(snapshot.targetProfileId).toBe("account");
    expect(snapshot.routes.map((candidate) => candidate.model)).toEqual([
      "old-model",
      "new-model",
    ]);
    expect(snapshot.routes[1].sourceKind).toBe("legacy_agent");
  });

  it("deduplicates by API mode and keeps the first account source", () => {
    const { catalog } = subject(
      [profile("default", { isDefault: true }), profile("other")],
      {
        default: [route("default", "same")],
        other: [
          route("other", "same"),
          route("other", "same", { apiMode: "codex_responses" }),
        ],
      },
    );

    expect(catalog.snapshot().routes).toHaveLength(2);
    expect(catalog.snapshot().routes[0].sourceProfileId).toBe("default");
    expect(catalog.snapshot().routes[1].apiMode).toBe("codex_responses");
  });

  it("rejects a stale catalog selection before resolving credentials", () => {
    const resolveRoute = vi.fn(() => route("default", "same"));
    const { dependencies } = subject(
      [profile("default", { isDefault: true })],
      { default: [route("default", "same")] },
    );
    dependencies.resolveRoute = resolveRoute;
    const catalog = new OwnerModelRouteCatalog(dependencies);
    const snapshot = catalog.snapshot();

    try {
      catalog.resolve({
        ...snapshot.routes[0].selection,
        catalogRevision: "stale-revision",
      });
      throw new Error("expected stale selection rejection");
    } catch (error) {
      expect(error).toMatchObject({ code: "model_switch_route_stale" });
    }
    expect(resolveRoute).not.toHaveBeenCalled();
  });

  it("rejects a foreign profile before exposing its route", () => {
    const { catalog } = subject(
      [
        profile("default", { isDefault: true }),
        profile("foreign", { ownerKey: "another-owner" }),
      ],
      {
        default: [route("default", "safe")],
        foreign: [route("foreign", "secret")],
      },
    );
    expect(
      catalog.snapshot().routes.map((candidate) => candidate.model),
    ).toEqual(["safe"]);
  });
});
