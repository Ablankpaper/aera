// @vitest-environment node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgenteraAuthPublicState } from "../../shared/agentera-auth";
import type {
  OrganizationPublicState,
  OrganizationSummary,
} from "../../shared/agentera-organization";
import type {
  WorkspacePublicState,
  WorkspaceSummary,
} from "../../shared/agentera-workspace";
import {
  openAgenteraProductSpaceDatabase,
  type AgenteraProductSpaceDatabase,
  type AgenteraProductSpaceSqliteDatabase,
} from "./db";
import {
  AgenteraProductSpaceManager,
  type AgenteraProductSpaceStateSource,
} from "./manager";

const ACCOUNT_A = "10000000-0000-4000-8000-000000000001";
const ACCOUNT_B = "10000000-0000-4000-8000-000000000002";
const PERSONAL_A = "11000000-0000-4000-8000-000000000001";
const PERSONAL_B = "11000000-0000-4000-8000-000000000002";
const WORKSPACE_A = "20000000-0000-4000-8000-000000000001";
const WORKSPACE_B = "20000000-0000-4000-8000-000000000002";
const WORKSPACE_ARCHIVED = "20000000-0000-4000-8000-000000000003";
const ORGANIZATION_A = "30000000-0000-4000-8000-000000000001";
const ORGANIZATION_B = "30000000-0000-4000-8000-000000000002";
const ORGANIZATION_ARCHIVED = "30000000-0000-4000-8000-000000000003";
const DEPARTMENT_SENTINEL = "40000000-0000-4000-8000-000000000001";
const CREATED_AT = "2026-07-21T01:00:00Z";
const UPDATED_AT = "2026-07-21T02:00:00Z";
const NOW = "2026-07-21T07:00:00Z";

const roots: string[] = [];
const managers: AgenteraProductSpaceManager[] = [];

function temporaryUserData(): string {
  const root = mkdtempSync(join(tmpdir(), "agentera-product-space-manager-"));
  roots.push(root);
  return join(root, "user-data");
}

function databaseFor(): AgenteraProductSpaceDatabase {
  return openAgenteraProductSpaceDatabase(temporaryUserData(), {
    databaseFactory: (path) =>
      new DatabaseSync(path) as unknown as AgenteraProductSpaceSqliteDatabase,
  });
}

function authState(
  user: "A" | "B" = "A",
  status: "authenticated" | "offline" = "authenticated",
): AgenteraAuthPublicState {
  return {
    status,
    userId: user === "A" ? ACCOUNT_A : ACCOUNT_B,
    personalSpaceId: user === "A" ? PERSONAL_A : PERSONAL_B,
    deviceId: "50000000-0000-4000-8000-000000000001",
    offlineExpiresAt: "2026-07-28T07:00:00Z",
    cloudAvailable: status === "authenticated",
  };
}

function workspace(
  id: string,
  displayName: string,
  overrides: Partial<WorkspaceSummary> = {},
): WorkspaceSummary {
  return {
    id,
    displayName,
    status: "active",
    revision: 1,
    mutationState: "writable",
    role: "member",
    memberCount: 2,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    archivedAt: null,
    ...overrides,
  };
}

function organization(
  id: string,
  displayName: string,
  overrides: Partial<OrganizationSummary> = {},
): OrganizationSummary {
  return {
    id,
    displayName,
    status: "active",
    revision: 1,
    role: "member",
    memberCount: 2,
    departmentCount: 1,
    currentPolicyVersion: 1,
    currentPolicyDigest: "c".repeat(64),
    mutationState: "writable",
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    archivedAt: null,
    ...overrides,
  };
}

function workspaceState(
  workspaces: readonly WorkspaceSummary[],
  stale = false,
): WorkspacePublicState {
  return {
    access: "online",
    cloudAvailable: true,
    stale,
    selected: {
      kind: "personal",
      userId: ACCOUNT_A,
      personalSpaceId: PERSONAL_A,
    },
    workspaces,
  };
}

function organizationState(
  organizations: readonly OrganizationSummary[],
  stale = false,
): OrganizationPublicState {
  return {
    access: "online",
    cloudAvailable: true,
    stale,
    refreshedAt: UPDATED_AT,
    organizations,
  };
}

function mutableSource<T>(initial: T): AgenteraProductSpaceStateSource<T> & {
  set(value: T): void;
  resolveNextWith(promise: Promise<T>): void;
} {
  let value = initial;
  let next: Promise<T> | null = null;
  const listeners = new Set<() => void>();
  return {
    getState: vi.fn(() => {
      const result = next ?? Promise.resolve(value);
      next = null;
      return result;
    }),
    refresh: vi.fn(async () => value),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(updated) {
      value = updated;
      for (const listener of listeners) listener();
    },
    resolveNextWith(promise) {
      next = promise;
    },
  };
}

function managerFor(options: {
  database?: AgenteraProductSpaceDatabase;
  workspaceSource?: AgenteraProductSpaceStateSource<WorkspacePublicState>;
  organizationSource?: AgenteraProductSpaceStateSource<OrganizationPublicState>;
  getLegacyWorkspaceSelection?: (accountUserId: string) => string | null;
  getAuthState: () => AgenteraAuthPublicState;
}): AgenteraProductSpaceManager {
  const manager = new AgenteraProductSpaceManager({
    database: options.database ?? databaseFor(),
    workspaceSource:
      options.workspaceSource ?? mutableSource(workspaceState([])),
    organizationSource:
      options.organizationSource ?? mutableSource(organizationState([])),
    getLegacyWorkspaceSelection:
      options.getLegacyWorkspaceSelection ?? (() => null),
    getAuthState: options.getAuthState,
    now: () => NOW,
  });
  managers.push(manager);
  return manager;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const manager of managers.splice(0)) manager.close();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("AgenteraProductSpaceManager", () => {
  it("orders Personal, Workspace, and Organization deterministically and migrates once", async () => {
    const database = databaseFor();
    const workspaces = mutableSource(
      workspaceState([
        workspace(WORKSPACE_B, "Beta", { role: "admin" }),
        workspace(WORKSPACE_A, "Alpha", { role: "owner" }),
        workspace(WORKSPACE_ARCHIVED, "Archived", {
          status: "archived",
          mutationState: "archived",
          archivedAt: UPDATED_AT,
        }),
      ]),
    );
    const organizations = mutableSource(
      organizationState([
        organization(ORGANIZATION_B, "Zulu", { role: "auditor" }),
        organization(ORGANIZATION_A, "Acme", { role: "owner" }),
        organization(ORGANIZATION_ARCHIVED, "Old", {
          status: "archived",
          mutationState: "archived",
          archivedAt: UPDATED_AT,
        }),
      ]),
    );
    const legacyReader = vi.fn(() => WORKSPACE_B);
    const manager = managerFor({
      database,
      workspaceSource: workspaces,
      organizationSource: organizations,
      getLegacyWorkspaceSelection: legacyReader,
      getAuthState: () => authState(),
    });

    await expect(manager.getState()).resolves.toEqual({
      access: "online",
      stale: false,
      selected: {
        kind: "WORKSPACE",
        workspaceId: WORKSPACE_B,
        role: "admin",
      },
      options: [
        { kind: "PERSONAL" },
        {
          kind: "WORKSPACE",
          workspaceId: WORKSPACE_A,
          displayName: "Alpha",
          role: "owner",
        },
        {
          kind: "WORKSPACE",
          workspaceId: WORKSPACE_B,
          displayName: "Beta",
          role: "admin",
        },
        {
          kind: "ORGANIZATION",
          organizationId: ORGANIZATION_A,
          displayName: "Acme",
          role: "owner",
        },
        {
          kind: "ORGANIZATION",
          organizationId: ORGANIZATION_B,
          displayName: "Zulu",
          role: "auditor",
        },
      ],
    });
    await manager.getState();
    expect(legacyReader).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(await manager.getState())).not.toContain(
      DEPARTMENT_SENTINEL,
    );
  });

  it("validates selections against active cached memberships and maps Agent context exactly", async () => {
    const database = databaseFor();
    const manager = managerFor({
      database,
      workspaceSource: mutableSource(
        workspaceState([
          workspace(WORKSPACE_A, "Workspace", { role: "admin" }),
        ]),
      ),
      organizationSource: mutableSource(
        organizationState([
          organization(ORGANIZATION_A, "Organization", { role: "auditor" }),
          organization(ORGANIZATION_ARCHIVED, "Archived", {
            status: "archived",
            mutationState: "archived",
            archivedAt: UPDATED_AT,
          }),
        ]),
      ),
      getAuthState: () => authState(),
    });
    await manager.getState();

    await manager.select({ kind: "WORKSPACE", workspaceId: WORKSPACE_A });
    expect(manager.getAgentContext()).toEqual({
      scope: "WORKSPACE",
      workspaceId: WORKSPACE_A,
      role: "admin",
    });
    await manager.select({
      kind: "ORGANIZATION",
      organizationId: ORGANIZATION_A,
    });
    expect(manager.getAgentContext()).toEqual({
      scope: "ORGANIZATION",
      organizationId: ORGANIZATION_A,
      role: "auditor",
    });
    await expect(
      manager.select({
        kind: "ORGANIZATION",
        organizationId: ORGANIZATION_ARCHIVED,
      }),
    ).rejects.toMatchObject({ code: "selection_unavailable" });
    await expect(
      manager.select({
        kind: "ORGANIZATION",
        organizationId: DEPARTMENT_SENTINEL,
      }),
    ).rejects.toMatchObject({ code: "selection_unavailable" });

    await manager.select({ kind: "PERSONAL" });
    expect(manager.getAgentContext()).toEqual({ scope: "USER" });
  });

  it("partitions selection across account changes", async () => {
    const database = databaseFor();
    const workspaces = mutableSource(
      workspaceState([workspace(WORKSPACE_A, "Workspace")]),
    );
    const organizations = mutableSource(
      organizationState([organization(ORGANIZATION_A, "Organization")]),
    );
    let auth = authState("A");
    const manager = managerFor({
      database,
      workspaceSource: workspaces,
      organizationSource: organizations,
      getAuthState: () => auth,
    });
    await manager.getState();
    await manager.select({
      kind: "ORGANIZATION",
      organizationId: ORGANIZATION_A,
    });

    auth = authState("B");
    await expect(manager.getState()).resolves.toMatchObject({
      selected: { kind: "PERSONAL" },
    });
    await manager.select({ kind: "WORKSPACE", workspaceId: WORKSPACE_A });
    auth = authState("A");
    await expect(manager.getState()).resolves.toMatchObject({
      selected: { kind: "ORGANIZATION", organizationId: ORGANIZATION_A },
    });
  });

  it("never returns the previous account Agent context before async reconciliation", async () => {
    let auth = authState("A");
    const manager = managerFor({
      workspaceSource: mutableSource(
        workspaceState([workspace(WORKSPACE_A, "Workspace")]),
      ),
      organizationSource: mutableSource(
        organizationState([organization(ORGANIZATION_A, "Organization")]),
      ),
      getAuthState: () => auth,
    });
    await manager.getState();
    await manager.select({
      kind: "ORGANIZATION",
      organizationId: ORGANIZATION_A,
    });
    expect(manager.getAgentContext()).toMatchObject({
      scope: "ORGANIZATION",
      organizationId: ORGANIZATION_A,
    });

    auth = authState("B");

    expect(manager.getAgentContext()).toEqual({ scope: "USER" });
  });

  it("fails closed until a stored Organization selection has a verified role", async () => {
    const database = databaseFor();
    database.writeSelection(
      ACCOUNT_A,
      { kind: "ORGANIZATION", organizationId: ORGANIZATION_A },
      NOW,
    );
    const manager = managerFor({
      database,
      organizationSource: mutableSource(
        organizationState([
          organization(ORGANIZATION_A, "Organization", { role: "owner" }),
        ]),
      ),
      getAuthState: () => authState(),
    });

    expect(manager.getAgentContext()).toEqual({ scope: "USER" });
    await manager.getState();
    expect(manager.getAgentContext()).toEqual({
      scope: "ORGANIZATION",
      organizationId: ORGANIZATION_A,
      role: "owner",
    });
  });

  it("rejects stale asynchronous source results after an account switch", async () => {
    const workspacePending = deferred<WorkspacePublicState>();
    const organizationPending = deferred<OrganizationPublicState>();
    const workspaces = mutableSource(workspaceState([]));
    const organizations = mutableSource(organizationState([]));
    workspaces.resolveNextWith(workspacePending.promise);
    organizations.resolveNextWith(organizationPending.promise);
    let auth = authState("A");
    const database = databaseFor();
    const manager = managerFor({
      database,
      workspaceSource: workspaces,
      organizationSource: organizations,
      getAuthState: () => auth,
    });

    const pending = manager.getState();
    auth = authState("B");
    workspacePending.resolve(
      workspaceState([workspace(WORKSPACE_A, "Old account")]),
    );
    organizationPending.resolve(
      organizationState([organization(ORGANIZATION_A, "Old account")]),
    );
    await expect(pending).rejects.toMatchObject({ code: "unauthenticated" });
    expect(database.readSelection(ACCOUNT_A)).toBeNull();
    expect(database.readSelection(ACCOUNT_B)).toBeNull();
  });

  it("falls back once when authoritative state removes the selected scope", async () => {
    const workspaces = mutableSource(
      workspaceState([workspace(WORKSPACE_A, "Workspace")]),
    );
    const organizations = mutableSource(organizationState([]));
    const manager = managerFor({
      workspaceSource: workspaces,
      organizationSource: organizations,
      getAuthState: () => authState(),
    });
    await manager.getState();
    await manager.select({ kind: "WORKSPACE", workspaceId: WORKSPACE_A });
    const listener = vi.fn();
    manager.subscribe(listener);

    workspaces.set(workspaceState([]));
    await manager.notifySourceStateChanged();
    expect((await manager.getState()).selected).toEqual({ kind: "PERSONAL" });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({ selected: { kind: "PERSONAL" } }),
    );
  });

  it("keeps a selected Organization when a degraded refresh reports no Organizations", async () => {
    const organizations = mutableSource(
      organizationState([organization(ORGANIZATION_A, "Organization")]),
    );
    const database = databaseFor();
    const manager = managerFor({
      database,
      workspaceSource: mutableSource(workspaceState([])),
      organizationSource: organizations,
      getAuthState: () => authState(),
    });
    await manager.getState();
    await manager.select({
      kind: "ORGANIZATION",
      organizationId: ORGANIZATION_A,
    });

    organizations.set(organizationState([], true));
    await manager.notifySourceStateChanged();

    await expect(manager.getState()).resolves.toMatchObject({
      stale: true,
      selected: { kind: "ORGANIZATION", organizationId: ORGANIZATION_A },
    });
    expect(database.readSelection(ACCOUNT_A)).toEqual({
      kind: "ORGANIZATION",
      organizationId: ORGANIZATION_A,
    });
  });

  it("emits exactly once per real selection change", async () => {
    const manager = managerFor({
      workspaceSource: mutableSource(
        workspaceState([workspace(WORKSPACE_A, "Workspace")]),
      ),
      getAuthState: () => authState(),
    });
    await manager.getState();
    const listener = vi.fn();
    manager.subscribe(listener);

    await manager.select({ kind: "WORKSPACE", workspaceId: WORKSPACE_A });
    await manager.select({ kind: "WORKSPACE", workspaceId: WORKSPACE_A });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("preserves an active cached selection as stale offline state", async () => {
    const manager = managerFor({
      workspaceSource: mutableSource(
        workspaceState([workspace(WORKSPACE_A, "Workspace")], true),
      ),
      organizationSource: mutableSource(organizationState([], true)),
      getAuthState: () => authState("A", "offline"),
    });
    await manager.getState();
    await manager.select({ kind: "WORKSPACE", workspaceId: WORKSPACE_A });
    await expect(manager.getState()).resolves.toMatchObject({
      access: "offline",
      stale: true,
      selected: { kind: "WORKSPACE", workspaceId: WORKSPACE_A },
    });
  });
});
