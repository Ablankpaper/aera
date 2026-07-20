// @vitest-environment node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgenteraAuthPublicState } from "../../shared/agentera-auth";
import type {
  ProductSpacePublicState,
  ProductSpaceSelection,
} from "../../shared/agentera-product-space";
import type {
  WorkspaceInvitation,
  WorkspaceInvitationCreation,
  WorkspaceMember,
  WorkspaceSummary,
} from "../../shared/agentera-workspace";
import {
  openAgenteraWorkspaceDatabase,
  type AgenteraWorkspaceDatabase,
  type AgenteraWorkspaceSqliteDatabase,
} from "./db";
import {
  AgenteraWorkspaceManager,
  type AgenteraWorkspaceCloudClient,
  type AgenteraWorkspaceSelectionCoordinator,
} from "./manager";

const ACCOUNT_A = "10000000-0000-4000-8000-000000000001";
const ACCOUNT_B = "10000000-0000-4000-8000-000000000002";
const PERSONAL_A = "11000000-0000-4000-8000-000000000001";
const PERSONAL_B = "11000000-0000-4000-8000-000000000002";
const WORKSPACE_A = "20000000-0000-4000-8000-000000000001";
const WORKSPACE_B = "20000000-0000-4000-8000-000000000002";
const MEMBER_A = "30000000-0000-4000-8000-000000000001";
const MEMBER_B = "30000000-0000-4000-8000-000000000002";
const INVITATION_A = "40000000-0000-4000-8000-000000000001";
const CREATED_AT = "2026-07-20T10:00:00Z";
const UPDATED_AT = "2026-07-20T11:00:00Z";
const EXPIRES_AT = "2026-07-27T10:00:00Z";
const NOW = "2026-07-20T12:00:00Z";
const RAW_TOKEN = "A".repeat(43);

const roots: string[] = [];
const managers: AgenteraWorkspaceManager[] = [];

function temporaryUserData(): string {
  const root = mkdtempSync(join(tmpdir(), "agentera-workspace-manager-"));
  roots.push(root);
  return join(root, "user-data");
}

function databaseFor(userDataPath: string): AgenteraWorkspaceDatabase {
  return openAgenteraWorkspaceDatabase(userDataPath, {
    databaseFactory: (path) =>
      new DatabaseSync(path) as unknown as AgenteraWorkspaceSqliteDatabase,
  });
}

function authState(
  user: "A" | "B" = "A",
  status: "authenticated" | "offline" = "authenticated",
  cloudAvailable = status === "authenticated",
): AgenteraAuthPublicState {
  return {
    status,
    userId: user === "A" ? ACCOUNT_A : ACCOUNT_B,
    personalSpaceId: user === "A" ? PERSONAL_A : PERSONAL_B,
    deviceId: "50000000-0000-4000-8000-000000000001",
    offlineExpiresAt: "2026-07-27T12:00:00Z",
    cloudAvailable,
  };
}

function summary(
  id: string,
  overrides: Partial<WorkspaceSummary> = {},
): WorkspaceSummary {
  return {
    id,
    displayName: `Workspace ${id.slice(-1)}`,
    status: "active",
    revision: 1,
    mutationState: "writable",
    role: "owner",
    memberCount: 1,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    archivedAt: null,
    ...overrides,
  };
}

function member(
  userId: string,
  overrides: Partial<WorkspaceMember> = {},
): WorkspaceMember {
  return {
    userId,
    nickname: `Member ${userId.slice(-1)}`,
    role: "member",
    revision: 1,
    joinedAt: CREATED_AT,
    ...overrides,
  };
}

function invitation(
  overrides: Partial<WorkspaceInvitation> = {},
): WorkspaceInvitation {
  return {
    id: INVITATION_A,
    status: "pending",
    createdByUserId: MEMBER_A,
    acceptedByUserId: null,
    createdAt: CREATED_AT,
    expiresAt: EXPIRES_AT,
    acceptedAt: null,
    revokedAt: null,
    ...overrides,
  };
}

function invitationCreation(): WorkspaceInvitationCreation {
  return {
    ...invitation(),
    token: RAW_TOKEN,
    inviteUrl: `agentera://workspace-invitation#${RAW_TOKEN}`,
    secretReplayable: false,
  };
}

function cloudClient(): AgenteraWorkspaceCloudClient {
  return {
    listWorkspaces: vi.fn(async () => []),
    createWorkspace: vi.fn(async () => summary(WORKSPACE_A)),
    renameWorkspace: vi.fn(async () => summary(WORKSPACE_A)),
    archiveWorkspace: vi.fn(async () =>
      summary(WORKSPACE_A, {
        status: "archived",
        mutationState: "archived",
        archivedAt: UPDATED_AT,
      }),
    ),
    restoreWorkspace: vi.fn(async () => summary(WORKSPACE_A)),
    listMembers: vi.fn(async () => []),
    changeMemberRole: vi.fn(async () =>
      member(MEMBER_B, { role: "admin", revision: 2 }),
    ),
    removeMember: vi.fn(async () => undefined),
    leaveWorkspace: vi.fn(async () => undefined),
    listInvitations: vi.fn(async () => []),
    createInvitation: vi.fn(async () => invitationCreation()),
    revokeInvitation: vi.fn(async () => undefined),
    acceptInvitation: vi.fn(async () => ({
      workspace: summary(WORKSPACE_B, { role: "member" }),
      member: member(ACCOUNT_A),
    })),
  };
}

function selectionCoordinatorFor(
  database: AgenteraWorkspaceDatabase,
  getAuthState: () => AgenteraAuthPublicState,
): AgenteraWorkspaceSelectionCoordinator {
  const selected = new Map<string, string | null>();
  const listeners = new Set<(state: ProductSpacePublicState) => void>();
  const currentAccess = (): Extract<
    AgenteraAuthPublicState,
    { status: "authenticated" | "offline" }
  > => {
    const access = getAuthState();
    if (access.status !== "authenticated" && access.status !== "offline") {
      throw new Error("unauthenticated");
    }
    return access;
  };
  const selectedWorkspace = (accountUserId: string): string | null => {
    if (!selected.has(accountUserId)) {
      selected.set(
        accountUserId,
        database.readSelectedWorkspace(accountUserId),
      );
    }
    return selected.get(accountUserId) ?? null;
  };
  const publicSelection = (): ProductSpaceSelection => {
    const access = currentAccess();
    const workspaceId = selectedWorkspace(access.userId);
    const workspace = database
      .readWorkspaces(access.userId)
      .workspaces.find(
        ({ id, status }) => id === workspaceId && status === "active",
      );
    return workspace
      ? {
          kind: "WORKSPACE",
          workspaceId: workspace.id,
          role: workspace.role,
        }
      : { kind: "PERSONAL" };
  };
  const state = (): ProductSpacePublicState => {
    const access = currentAccess();
    const workspaceOptions = database
      .readWorkspaces(access.userId)
      .workspaces.filter(({ status }) => status === "active")
      .map((workspace) => ({
        kind: "WORKSPACE" as const,
        workspaceId: workspace.id,
        displayName: workspace.displayName,
        role: workspace.role,
      }));
    return {
      access: access.status === "offline" ? "offline" : "online",
      stale: access.status === "offline",
      selected: publicSelection(),
      options: [{ kind: "PERSONAL" }, ...workspaceOptions],
    };
  };
  return {
    readSelectedWorkspaceId: selectedWorkspace,
    getAgentContext() {
      const value = publicSelection();
      return value.kind === "WORKSPACE"
        ? {
            scope: "WORKSPACE",
            workspaceId: value.workspaceId,
            role: value.role,
          }
        : { scope: "USER" };
    },
    select: vi.fn(async (input) => {
      const access = currentAccess();
      selected.set(
        access.userId,
        input.kind === "WORKSPACE" ? input.workspaceId : null,
      );
      const next = state();
      for (const listener of listeners) listener(next);
      return next;
    }),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function managerFor(options: {
  database?: AgenteraWorkspaceDatabase;
  client?: AgenteraWorkspaceCloudClient;
  selectionCoordinator?: AgenteraWorkspaceSelectionCoordinator;
  getAuthState: () => AgenteraAuthPublicState;
}): AgenteraWorkspaceManager {
  const database = options.database ?? databaseFor(temporaryUserData());
  const manager = new AgenteraWorkspaceManager({
    database,
    client: options.client ?? cloudClient(),
    getAuthState: options.getAuthState,
    selectionCoordinator:
      options.selectionCoordinator ??
      selectionCoordinatorFor(database, options.getAuthState),
    now: () => NOW,
  });
  managers.push(manager);
  return manager;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const manager of managers.splice(0)) manager.close();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("AgenteraWorkspaceManager", () => {
  it("defaults to personal space without making a cloud request", async () => {
    let auth: AgenteraAuthPublicState = authState();
    const client = cloudClient();
    const manager = managerFor({ client, getAuthState: () => auth });

    await expect(manager.getState()).resolves.toEqual({
      access: "online",
      cloudAvailable: true,
      stale: true,
      selected: {
        kind: "personal",
        userId: ACCOUNT_A,
        personalSpaceId: PERSONAL_A,
      },
      workspaces: [],
    });
    expect(client.listWorkspaces).not.toHaveBeenCalled();

    auth = authState("A", "offline", false);
    await expect(manager.getState()).resolves.toMatchObject({
      access: "offline",
      cloudAvailable: false,
      stale: true,
      selected: { kind: "personal", userId: ACCOUNT_A },
    });
  });

  it("atomically refreshes and delegates only active cached membership selection", async () => {
    const userDataPath = temporaryUserData();
    const client = cloudClient();
    vi.mocked(client.listWorkspaces).mockResolvedValueOnce([
      summary(WORKSPACE_A),
      summary(WORKSPACE_B, {
        status: "archived",
        mutationState: "archived",
        archivedAt: UPDATED_AT,
      }),
    ]);
    const first = managerFor({
      database: databaseFor(userDataPath),
      client,
      getAuthState: () => authState(),
    });
    const emitted: string[] = [];
    first.subscribe((state) => emitted.push(JSON.stringify(state)));

    await expect(first.refresh()).resolves.toMatchObject({
      stale: false,
      workspaces: [{ id: WORKSPACE_A }, { id: WORKSPACE_B }],
    });
    await expect(
      first.select({ workspaceId: WORKSPACE_A }),
    ).resolves.toMatchObject({
      selected: {
        kind: "workspace",
        userId: ACCOUNT_A,
        workspaceId: WORKSPACE_A,
        role: "owner",
      },
    });
    await expect(
      first.select({ workspaceId: WORKSPACE_B }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(client.listWorkspaces).toHaveBeenCalledTimes(1);
    expect(emitted.at(-1)).toContain(WORKSPACE_A);
    first.close();

    const second = managerFor({
      database: databaseFor(userDataPath),
      client: cloudClient(),
      getAuthState: () => authState(),
    });
    await expect(second.getState()).resolves.toMatchObject({
      stale: true,
      selected: { kind: "personal" },
    });
  });

  // @lat: [[agentera-workspaces#Desktop context#Trusted Agent context projection]]
  it("exposes only the trusted selected Agent context and notifies context subscribers", async () => {
    const client = cloudClient();
    vi.mocked(client.listWorkspaces).mockResolvedValueOnce([
      summary(WORKSPACE_A, { role: "admin" }),
    ]);
    const manager = managerFor({ client, getAuthState: () => authState() });

    expect(manager.getSelectedAgentContext()).toEqual({ scope: "USER" });
    const listener = vi.fn();
    const unsubscribe = manager.subscribeSelectedAgentContext(listener);
    await manager.refresh();
    listener.mockClear();

    await manager.select({ workspaceId: WORKSPACE_A });
    expect(manager.getSelectedAgentContext()).toEqual({
      scope: "WORKSPACE",
      workspaceId: WORKSPACE_A,
      role: "admin",
    });
    expect(listener).toHaveBeenCalledOnce();

    await manager.select({ workspaceId: null });
    expect(manager.getSelectedAgentContext()).toEqual({ scope: "USER" });
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    await manager.select({ workspaceId: WORKSPACE_A });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("serves stale cached summaries, members, and invitations while offline", async () => {
    let auth: AgenteraAuthPublicState = authState();
    const client = cloudClient();
    vi.mocked(client.listWorkspaces).mockResolvedValueOnce([
      summary(WORKSPACE_A),
    ]);
    vi.mocked(client.listMembers).mockResolvedValueOnce([member(MEMBER_A)]);
    vi.mocked(client.listInvitations).mockResolvedValueOnce([invitation()]);
    const manager = managerFor({ client, getAuthState: () => auth });
    await manager.refresh();
    await manager.select({ workspaceId: WORKSPACE_A });
    await manager.listMembers({ workspaceId: WORKSPACE_A });
    await manager.listInvitations({ workspaceId: WORKSPACE_A });

    auth = authState("A", "offline", false);
    await manager.notifyAccessStateChanged();
    await expect(manager.getState()).resolves.toMatchObject({
      access: "offline",
      stale: true,
      selected: { kind: "workspace", workspaceId: WORKSPACE_A },
    });
    await expect(
      manager.listMembers({ workspaceId: WORKSPACE_A }),
    ).resolves.toEqual([member(MEMBER_A)]);
    await expect(
      manager.listInvitations({ workspaceId: WORKSPACE_A }),
    ).resolves.toEqual([invitation()]);
    expect(client.listMembers).toHaveBeenCalledTimes(1);
    expect(client.listInvitations).toHaveBeenCalledTimes(1);
  });

  it("isolates account A, account B, logout, and re-login state", async () => {
    const database = databaseFor(temporaryUserData());
    database.replaceWorkspaces(ACCOUNT_A, [summary(WORKSPACE_A)], NOW);
    database.writeSelectedWorkspace(ACCOUNT_A, WORKSPACE_A, NOW);
    database.replaceWorkspaces(
      ACCOUNT_B,
      [summary(WORKSPACE_B, { role: "member" })],
      NOW,
    );
    database.writeSelectedWorkspace(ACCOUNT_B, WORKSPACE_B, NOW);
    let auth: AgenteraAuthPublicState = authState("A");
    const manager = managerFor({ database, getAuthState: () => auth });

    await expect(manager.getState()).resolves.toMatchObject({
      selected: { userId: ACCOUNT_A, workspaceId: WORKSPACE_A },
      workspaces: [{ id: WORKSPACE_A }],
    });
    auth = authState("B");
    await expect(manager.getState()).resolves.toMatchObject({
      selected: { userId: ACCOUNT_B, workspaceId: WORKSPACE_B },
      workspaces: [{ id: WORKSPACE_B }],
    });
    auth = { status: "unauthenticated" };
    await expect(manager.getState()).rejects.toMatchObject({
      code: "unauthenticated",
    });
    auth = authState("A");
    await expect(manager.getState()).resolves.toMatchObject({
      stale: true,
      selected: { userId: ACCOUNT_A, workspaceId: WORKSPACE_A },
      workspaces: [{ id: WORKSPACE_A }],
    });
  });

  it("falls back to personal after membership removal or archive", async () => {
    const client = cloudClient();
    vi.mocked(client.listWorkspaces)
      .mockResolvedValueOnce([summary(WORKSPACE_A)])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([summary(WORKSPACE_A)])
      .mockResolvedValueOnce([
        summary(WORKSPACE_A, {
          status: "archived",
          mutationState: "archived",
          revision: 2,
          archivedAt: UPDATED_AT,
        }),
      ]);
    const manager = managerFor({ client, getAuthState: () => authState() });
    await manager.refresh();
    await manager.select({ workspaceId: WORKSPACE_A });
    await expect(manager.refresh()).resolves.toMatchObject({
      selected: { kind: "personal" },
    });
    await manager.refresh();
    await manager.select({ workspaceId: WORKSPACE_A });
    await expect(manager.refresh()).resolves.toMatchObject({
      selected: { kind: "personal" },
      workspaces: [{ status: "archived" }],
    });
  });

  it("coalesces concurrent refreshes and preserves the last safe cache on failure", async () => {
    const pending = deferred<WorkspaceSummary[]>();
    const client = cloudClient();
    vi.mocked(client.listWorkspaces)
      .mockReturnValueOnce(pending.promise)
      .mockRejectedValueOnce(new Error("network-private-detail"));
    const manager = managerFor({ client, getAuthState: () => authState() });

    const first = manager.refresh();
    const second = manager.refresh();
    expect(client.listWorkspaces).toHaveBeenCalledTimes(1);
    pending.resolve([summary(WORKSPACE_A)]);
    await Promise.all([first, second]);
    await expect(manager.refresh()).rejects.toThrow("network-private-detail");
    await expect(manager.getState()).resolves.toMatchObject({
      workspaces: [{ id: WORKSPACE_A }],
    });
  });

  it("discards a late refresh result after the authenticated account changes", async () => {
    let auth: AgenteraAuthPublicState = authState("A");
    const pending = deferred<WorkspaceSummary[]>();
    const client = cloudClient();
    vi.mocked(client.listWorkspaces).mockReturnValueOnce(pending.promise);
    const database = databaseFor(temporaryUserData());
    database.replaceWorkspaces(
      ACCOUNT_B,
      [summary(WORKSPACE_B, { role: "member" })],
      NOW,
    );
    const manager = managerFor({
      database,
      client,
      getAuthState: () => auth,
    });

    const late = manager.refresh();
    auth = authState("B");
    await manager.getState();
    pending.resolve([summary(WORKSPACE_A)]);
    await expect(late).resolves.toMatchObject({
      selected: { userId: ACCOUNT_B },
      workspaces: [{ id: WORKSPACE_B }],
    });
    expect(database.readWorkspaces(ACCOUNT_A).workspaces).toEqual([]);
  });

  it("fails every cloud mutation offline before calling the client", async () => {
    const client = cloudClient();
    const manager = managerFor({
      client,
      getAuthState: () => authState("A", "offline", false),
    });
    const mutations: Array<() => Promise<unknown>> = [
      () => manager.create({ displayName: "Team", idempotencyKey: "create" }),
      () =>
        manager.rename({
          workspaceId: WORKSPACE_A,
          displayName: "Renamed",
          expectedRevision: 1,
        }),
      () => manager.archive({ workspaceId: WORKSPACE_A, expectedRevision: 1 }),
      () => manager.restore({ workspaceId: WORKSPACE_A, expectedRevision: 2 }),
      () =>
        manager.changeMemberRole({
          workspaceId: WORKSPACE_A,
          userId: MEMBER_B,
          role: "admin",
          expectedRevision: 1,
        }),
      () =>
        manager.removeMember({
          workspaceId: WORKSPACE_A,
          userId: MEMBER_B,
          expectedRevision: 1,
        }),
      () => manager.leave({ workspaceId: WORKSPACE_A }),
      () =>
        manager.createInvitation({
          workspaceId: WORKSPACE_A,
          idempotencyKey: "invite",
        }),
      () =>
        manager.revokeInvitation({
          workspaceId: WORKSPACE_A,
          invitationId: INVITATION_A,
        }),
      () =>
        manager.acceptInvitation({
          token: RAW_TOKEN,
          idempotencyKey: "accept",
        }),
    ];

    for (const mutate of mutations) {
      await expect(mutate()).rejects.toMatchObject({ code: "online_required" });
    }
    for (const method of Object.values(client))
      expect(method).not.toHaveBeenCalled();
  });

  it("updates lifecycle and membership caches only after online success", async () => {
    const client = cloudClient();
    const database = databaseFor(temporaryUserData());
    database.replaceWorkspaces(ACCOUNT_A, [summary(WORKSPACE_A)], NOW);
    database.replaceMembers(ACCOUNT_A, WORKSPACE_A, [member(MEMBER_B)], NOW);
    const manager = managerFor({
      database,
      client,
      getAuthState: () => authState(),
    });

    vi.mocked(client.createWorkspace).mockResolvedValueOnce(
      summary(WORKSPACE_B),
    );
    await manager.create({ displayName: "Created", idempotencyKey: "create" });
    vi.mocked(client.renameWorkspace).mockResolvedValueOnce(
      summary(WORKSPACE_A, { displayName: "Renamed", revision: 2 }),
    );
    await manager.rename({
      workspaceId: WORKSPACE_A,
      displayName: "Renamed",
      expectedRevision: 1,
    });
    await manager.select({ workspaceId: WORKSPACE_A });
    await manager.archive({ workspaceId: WORKSPACE_A, expectedRevision: 2 });
    expect((await manager.getState()).selected.kind).toBe("personal");
    await manager.restore({ workspaceId: WORKSPACE_A, expectedRevision: 3 });
    await manager.changeMemberRole({
      workspaceId: WORKSPACE_A,
      userId: MEMBER_B,
      role: "admin",
      expectedRevision: 1,
    });
    await manager.removeMember({
      workspaceId: WORKSPACE_A,
      userId: MEMBER_B,
      expectedRevision: 2,
    });

    expect(database.readWorkspaces(ACCOUNT_A).workspaces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: WORKSPACE_A, status: "active" }),
        expect.objectContaining({ id: WORKSPACE_B }),
      ]),
    );
    expect(database.readMembers(ACCOUNT_A, WORKSPACE_A).members).toEqual([]);
    expect(client.createWorkspace).toHaveBeenCalledWith("Created", "create");
    expect(client.renameWorkspace).toHaveBeenCalledWith(
      WORKSPACE_A,
      "Renamed",
      1,
    );
    expect(client.changeMemberRole).toHaveBeenCalledWith(
      WORKSPACE_A,
      MEMBER_B,
      "admin",
      1,
    );

    await manager.leave({ workspaceId: WORKSPACE_B });
    expect(database.readWorkspaces(ACCOUNT_A).workspaces).toEqual([
      expect.objectContaining({ id: WORKSPACE_A }),
    ]);
  });

  it("keeps invitation secrets only in the immediate creation result", async () => {
    const client = cloudClient();
    const database = databaseFor(temporaryUserData());
    database.replaceWorkspaces(ACCOUNT_A, [summary(WORKSPACE_A)], NOW);
    const manager = managerFor({
      database,
      client,
      getAuthState: () => authState(),
    });
    const emitted: string[] = [];
    manager.subscribe((state) => emitted.push(JSON.stringify(state)));

    await expect(
      manager.createInvitation({
        workspaceId: WORKSPACE_A,
        idempotencyKey: "invite",
      }),
    ).resolves.toEqual(invitationCreation());
    expect(
      database.readInvitations(ACCOUNT_A, WORKSPACE_A).invitations,
    ).toEqual([invitation()]);
    expect(JSON.stringify(await manager.getState())).not.toContain(RAW_TOKEN);
    expect(emitted.join("\n")).not.toContain(RAW_TOKEN);

    await manager.revokeInvitation({
      workspaceId: WORKSPACE_A,
      invitationId: INVITATION_A,
    });
    expect(
      database.readInvitations(ACCOUNT_A, WORKSPACE_A).invitations,
    ).toEqual([]);
    const accepted = await manager.acceptInvitation({
      token: RAW_TOKEN,
      idempotencyKey: "accept",
    });
    expect(accepted.workspace.id).toBe(WORKSPACE_B);
    expect(database.readWorkspaces(ACCOUNT_A).workspaces).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: WORKSPACE_B })]),
    );
    expect(database.readMembers(ACCOUNT_A, WORKSPACE_B).members).toEqual([
      member(ACCOUNT_A),
    ]);
  });

  it("forwards selection to the sole product-space coordinator without writing the legacy Workspace selection", async () => {
    const client = cloudClient();
    const database = databaseFor(temporaryUserData());
    database.replaceWorkspaces(ACCOUNT_A, [summary(WORKSPACE_A)], NOW);
    const writeSelection = vi.spyOn(database, "writeSelectedWorkspace");
    const selectionCoordinator = selectionCoordinatorFor(database, () =>
      authState(),
    );
    const manager = managerFor({
      database,
      client,
      selectionCoordinator,
      getAuthState: () => authState(),
    });
    const listener = vi.fn();
    manager.subscribe(listener);

    await manager.select({ workspaceId: WORKSPACE_A });
    expect(selectionCoordinator.select).toHaveBeenCalledWith({
      kind: "WORKSPACE",
      workspaceId: WORKSPACE_A,
    });
    expect(writeSelection).not.toHaveBeenCalled();
    expect(listener).toHaveBeenCalledTimes(1);
    for (const method of Object.values(client))
      expect(method).not.toHaveBeenCalled();
  });
});
