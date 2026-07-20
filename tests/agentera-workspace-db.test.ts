// @vitest-environment node

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AGENTERA_WORKSPACE_SCHEMA_VERSION,
  openAgenteraWorkspaceDatabase,
  resolveAgenteraWorkspacePaths,
  type AgenteraWorkspaceSqliteDatabase,
} from "../src/main/agentera-workspace/db";
import type {
  WorkspaceInvitation,
  WorkspaceMember,
  WorkspaceSummary,
} from "../src/shared/agentera-workspace";

const ACCOUNT_A = "10000000-0000-4000-8000-000000000001";
const ACCOUNT_B = "10000000-0000-4000-8000-000000000002";
const WORKSPACE_A = "20000000-0000-4000-8000-000000000001";
const WORKSPACE_B = "20000000-0000-4000-8000-000000000002";
const MEMBER_A = "30000000-0000-4000-8000-000000000001";
const MEMBER_B = "30000000-0000-4000-8000-000000000002";
const INVITATION_A = "40000000-0000-4000-8000-000000000001";
const INVITATION_B = "40000000-0000-4000-8000-000000000002";
const CREATED_AT = "2026-07-20T10:00:00Z";
const UPDATED_AT = "2026-07-20T11:00:00Z";
const REFRESHED_AT = "2026-07-20T12:00:00Z";
const EXPIRES_AT = "2026-07-27T10:00:00Z";

const roots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "agentera-workspace-db-"));
  roots.push(root);
  return root;
}

function nodeSqliteFactory(path: string): AgenteraWorkspaceSqliteDatabase {
  return new DatabaseSync(path) as unknown as AgenteraWorkspaceSqliteDatabase;
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
  id: string,
  overrides: Partial<WorkspaceInvitation> = {},
): WorkspaceInvitation {
  return {
    id,
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

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("AgentEra Workspace database", () => {
  it("opens at the exact userData path and rejects paths inside HERMES_HOME", () => {
    const root = temporaryRoot();
    const userDataPath = join(root, "user-data");
    const hermesHome = join(root, "hermes-home");
    mkdirSync(hermesHome, { recursive: true });
    const previousHermesHome = process.env.HERMES_HOME;
    process.env.HERMES_HOME = hermesHome;
    const opened: string[] = [];

    try {
      const paths = resolveAgenteraWorkspacePaths(userDataPath);
      expect(paths).toEqual({
        rootPath: join(userDataPath, "agentera-workspace"),
        databasePath: join(userDataPath, "agentera-workspace", "workspace.db"),
      });
      const database = openAgenteraWorkspaceDatabase(userDataPath, {
        databaseFactory: (path) => {
          opened.push(path);
          return nodeSqliteFactory(path);
        },
      });
      expect(database.databasePath).toBe(paths.databasePath);
      expect(opened).toEqual([paths.databasePath]);
      database.close();

      const unsafeFactory = vi.fn(nodeSqliteFactory);
      expect(() =>
        openAgenteraWorkspaceDatabase(join(hermesHome, "nested"), {
          databaseFactory: unsafeFactory,
        }),
      ).toThrow(/HERMES_HOME|Workspace path/i);
      expect(unsafeFactory).not.toHaveBeenCalled();
    } finally {
      if (previousHermesHome === undefined) delete process.env.HERMES_HOME;
      else process.env.HERMES_HOME = previousHermesHome;
    }
  });

  it("enables safe pragmas and migrates the exact schema idempotently", () => {
    const userDataPath = join(temporaryRoot(), "user-data");

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const database = openAgenteraWorkspaceDatabase(userDataPath, {
        databaseFactory: nodeSqliteFactory,
      });
      expect(
        Object.values(
          database.sqlite.prepare("PRAGMA journal_mode").get() as Record<
            string,
            unknown
          >,
        ),
      ).toEqual(["wal"]);
      expect(
        Object.values(
          database.sqlite.prepare("PRAGMA foreign_keys").get() as Record<
            string,
            unknown
          >,
        ),
      ).toEqual([1]);
      expect(
        Object.values(
          database.sqlite.prepare("PRAGMA user_version").get() as Record<
            string,
            unknown
          >,
        ),
      ).toEqual([AGENTERA_WORKSPACE_SCHEMA_VERSION]);

      const tables = database.sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all() as Array<{ name: string }>;
      expect(tables.map(({ name }) => name)).toEqual([
        "workspace_cache",
        "workspace_invitation_cache",
        "workspace_member_cache",
        "workspace_selection",
      ]);

      const expectedColumns: Record<string, string[]> = {
        workspace_cache: [
          "account_user_id",
          "workspace_id",
          "summary_json",
          "refreshed_at",
        ],
        workspace_member_cache: [
          "account_user_id",
          "workspace_id",
          "member_user_id",
          "member_json",
          "refreshed_at",
        ],
        workspace_invitation_cache: [
          "account_user_id",
          "workspace_id",
          "invitation_id",
          "invitation_json",
          "refreshed_at",
        ],
        workspace_selection: [
          "account_user_id",
          "selected_workspace_id",
          "updated_at",
        ],
      };
      for (const [table, columns] of Object.entries(expectedColumns)) {
        const actual = database.sqlite
          .prepare(`PRAGMA table_info(${table})`)
          .all() as Array<{ name: string }>;
        expect(actual.map(({ name }) => name)).toEqual(columns);
      }
      database.close();
    }
  });

  it("atomically replaces Workspace summaries without mutating the legacy migration source", () => {
    const database = openAgenteraWorkspaceDatabase(
      join(temporaryRoot(), "user-data"),
      { databaseFactory: nodeSqliteFactory },
    );
    database.replaceWorkspaces(
      ACCOUNT_A,
      [summary(WORKSPACE_A), summary(WORKSPACE_B)],
      REFRESHED_AT,
    );
    database.replaceWorkspaces(
      ACCOUNT_B,
      [summary(WORKSPACE_A, { displayName: "Account B" })],
      REFRESHED_AT,
    );
    database.writeSelectedWorkspace(ACCOUNT_A, WORKSPACE_A, UPDATED_AT);
    database.writeSelectedWorkspace(ACCOUNT_B, WORKSPACE_A, UPDATED_AT);

    expect(database.readWorkspaces(ACCOUNT_A).workspaces).toEqual([
      summary(WORKSPACE_A),
      summary(WORKSPACE_B),
    ]);
    expect(database.readWorkspaces(ACCOUNT_B).workspaces).toEqual([
      summary(WORKSPACE_A, { displayName: "Account B" }),
    ]);

    database.replaceWorkspaces(
      ACCOUNT_A,
      [summary(WORKSPACE_B)],
      "2026-07-20T13:00:00Z",
    );
    expect(database.readSelectedWorkspace(ACCOUNT_A)).toBe(WORKSPACE_A);
    expect(database.readSelectedWorkspace(ACCOUNT_B)).toBe(WORKSPACE_A);

    expect(() =>
      database.replaceWorkspaces(
        ACCOUNT_A,
        [summary(WORKSPACE_A), summary(WORKSPACE_A)],
        "2026-07-20T14:00:00Z",
      ),
    ).toThrow(/duplicate|workspace/i);
    expect(database.readWorkspaces(ACCOUNT_A).workspaces).toEqual([
      summary(WORKSPACE_B),
    ]);

    database.writeSelectedWorkspace(ACCOUNT_A, WORKSPACE_B, UPDATED_AT);
    database.replaceWorkspaces(
      ACCOUNT_A,
      [
        summary(WORKSPACE_B, {
          status: "archived",
          mutationState: "archived",
          revision: 2,
          archivedAt: UPDATED_AT,
        }),
      ],
      "2026-07-20T15:00:00Z",
    );
    expect(database.readSelectedWorkspace(ACCOUNT_A)).toBe(WORKSPACE_B);
    expect(() =>
      database.writeSelectedWorkspace(ACCOUNT_A, WORKSPACE_B, UPDATED_AT),
    ).toThrow(/active|selection/i);
    database.close();
  });

  it("replaces member and invitation snapshots without crossing accounts or workspaces", () => {
    const database = openAgenteraWorkspaceDatabase(
      join(temporaryRoot(), "user-data"),
      { databaseFactory: nodeSqliteFactory },
    );
    database.replaceWorkspaces(
      ACCOUNT_A,
      [summary(WORKSPACE_A), summary(WORKSPACE_B)],
      REFRESHED_AT,
    );
    database.replaceWorkspaces(ACCOUNT_B, [summary(WORKSPACE_A)], REFRESHED_AT);
    database.replaceMembers(
      ACCOUNT_A,
      WORKSPACE_A,
      [member(MEMBER_A)],
      REFRESHED_AT,
    );
    database.replaceMembers(
      ACCOUNT_A,
      WORKSPACE_B,
      [member(MEMBER_B)],
      REFRESHED_AT,
    );
    database.replaceMembers(
      ACCOUNT_B,
      WORKSPACE_A,
      [member(MEMBER_B, { nickname: "Other account" })],
      REFRESHED_AT,
    );
    database.replaceInvitations(
      ACCOUNT_A,
      WORKSPACE_A,
      [invitation(INVITATION_A)],
      REFRESHED_AT,
    );
    database.replaceInvitations(
      ACCOUNT_B,
      WORKSPACE_A,
      [invitation(INVITATION_B)],
      REFRESHED_AT,
    );

    database.replaceMembers(ACCOUNT_A, WORKSPACE_A, [], "2026-07-20T13:00:00Z");
    database.replaceInvitations(
      ACCOUNT_A,
      WORKSPACE_A,
      [],
      "2026-07-20T13:00:00Z",
    );
    expect(database.readMembers(ACCOUNT_A, WORKSPACE_A).members).toEqual([]);
    expect(database.readMembers(ACCOUNT_A, WORKSPACE_B).members).toEqual([
      member(MEMBER_B),
    ]);
    expect(database.readMembers(ACCOUNT_B, WORKSPACE_A).members).toEqual([
      member(MEMBER_B, { nickname: "Other account" }),
    ]);
    expect(
      database.readInvitations(ACCOUNT_A, WORKSPACE_A).invitations,
    ).toEqual([]);
    expect(
      database.readInvitations(ACCOUNT_B, WORKSPACE_A).invitations,
    ).toEqual([invitation(INVITATION_B)]);
    database.close();
  });

  it("rejects private fields before SQL and defensively decodes cached JSON", () => {
    const userDataPath = join(temporaryRoot(), "user-data");
    const database = openAgenteraWorkspaceDatabase(userDataPath, {
      databaseFactory: nodeSqliteFactory,
    });
    database.replaceWorkspaces(ACCOUNT_A, [summary(WORKSPACE_A)], REFRESHED_AT);
    database.replaceInvitations(
      ACCOUNT_A,
      WORKSPACE_A,
      [invitation(INVITATION_A)],
      REFRESHED_AT,
    );

    const rawToken = "A".repeat(43);
    const inviteUrl = `agentera://workspace-invitation#${rawToken}`;
    const unsafeInvitation = {
      ...invitation(INVITATION_B),
      token: rawToken,
      inviteUrl,
    };
    expect(() =>
      database.replaceInvitations(
        ACCOUNT_A,
        WORKSPACE_A,
        [unsafeInvitation as WorkspaceInvitation],
        REFRESHED_AT,
      ),
    ).toThrow(/private|secret|invitation/i);
    expect(
      database.readInvitations(ACCOUNT_A, WORKSPACE_A).invitations,
    ).toEqual([invitation(INVITATION_A)]);

    database.sqlite
      .prepare(
        "UPDATE workspace_cache SET summary_json = ? WHERE account_user_id = ? AND workspace_id = ?",
      )
      .run(
        JSON.stringify({ ...summary(WORKSPACE_A), profilePath: "/private" }),
        ACCOUNT_A,
        WORKSPACE_A,
      );
    expect(() => database.readWorkspaces(ACCOUNT_A)).toThrow(
      /cache|invalid|Workspace/i,
    );

    database.replaceWorkspaces(ACCOUNT_A, [summary(WORKSPACE_A)], REFRESHED_AT);
    const databasePath = database.databasePath;
    database.close();
    const contents = readFileSync(databasePath).toString("latin1");
    for (const sentinel of [
      rawToken,
      inviteUrl,
      "/private",
      "MEMORY.md",
      "USER.md",
      "session-secret",
      "profile-secret",
      "Curator-secret",
      "Skill-secret",
    ]) {
      expect(contents).not.toContain(sentinel);
    }
  });

  it("persists selection across reopen and closes idempotently", () => {
    const userDataPath = join(temporaryRoot(), "user-data");
    const first = openAgenteraWorkspaceDatabase(userDataPath, {
      databaseFactory: nodeSqliteFactory,
    });
    first.replaceWorkspaces(ACCOUNT_A, [summary(WORKSPACE_A)], REFRESHED_AT);
    first.writeSelectedWorkspace(ACCOUNT_A, WORKSPACE_A, UPDATED_AT);
    first.close();
    first.close();

    const second = openAgenteraWorkspaceDatabase(userDataPath, {
      databaseFactory: nodeSqliteFactory,
    });
    expect(second.readSelectedWorkspace(ACCOUNT_A)).toBe(WORKSPACE_A);
    second.close();
    expect(() => second.readWorkspaces(ACCOUNT_A)).toThrow(/closed/i);
  });
});
