// @vitest-environment node

import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  AGENTERA_PRODUCT_SPACE_SCHEMA_VERSION,
  LEGACY_WORKSPACE_SELECTION_MIGRATION,
  openAgenteraProductSpaceDatabase,
  resolveAgenteraProductSpacePaths,
  type AgenteraProductSpaceDatabase,
  type AgenteraProductSpaceSqliteDatabase,
} from "./db";

const ACCOUNT_A = "10000000-0000-4000-8000-000000000001";
const ACCOUNT_B = "10000000-0000-4000-8000-000000000002";
const WORKSPACE_A = "20000000-0000-4000-8000-000000000001";
const WORKSPACE_B = "20000000-0000-4000-8000-000000000002";
const ORGANIZATION_A = "30000000-0000-4000-8000-000000000001";
const DEPARTMENT_A = "40000000-0000-4000-8000-000000000001";
const MIGRATED_AT = "2026-07-21T05:00:00Z";
const UPDATED_AT = "2026-07-21T06:00:00Z";

const roots: string[] = [];
const databases: AgenteraProductSpaceDatabase[] = [];
const ORIGINAL_HERMES_HOME = process.env.HERMES_HOME;

function temporaryUserData(): string {
  const root = mkdtempSync(join(tmpdir(), "agentera-product-space-db-"));
  roots.push(root);
  return join(root, "user-data");
}

function databaseFor(
  userDataPath = temporaryUserData(),
): AgenteraProductSpaceDatabase {
  const database = openAgenteraProductSpaceDatabase(userDataPath, {
    databaseFactory: (path) =>
      new DatabaseSync(path) as unknown as AgenteraProductSpaceSqliteDatabase,
  });
  databases.push(database);
  return database;
}

afterEach(() => {
  delete process.env.HERMES_HOME;
  for (const database of databases.splice(0)) database.close();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
  if (ORIGINAL_HERMES_HOME !== undefined) {
    process.env.HERMES_HOME = ORIGINAL_HERMES_HOME;
  }
});

describe("AgenteraProductSpaceDatabase", () => {
  it("opens the exact restrictive userData database outside HERMES_HOME", () => {
    expect(() => resolveAgenteraProductSpacePaths("relative/path")).toThrow(
      "absolute",
    );
    const userDataPath = temporaryUserData();
    expect(resolveAgenteraProductSpacePaths(userDataPath)).toEqual({
      rootPath: join(userDataPath, "agentera-product-space"),
      databasePath: join(userDataPath, "agentera-product-space", "space.db"),
    });
    process.env.HERMES_HOME = join(userDataPath, "agentera-product-space");
    expect(() => databaseFor(userDataPath)).toThrow("outside HERMES_HOME");
    delete process.env.HERMES_HOME;

    const database = databaseFor(userDataPath);
    expect(statSync(database.paths.rootPath).mode & 0o777).toBe(0o700);
    expect(statSync(database.databasePath).mode & 0o777).toBe(0o600);
  });

  it("creates only the exact account-partitioned selection and migration schema", () => {
    const database = databaseFor();
    const version = database.sqlite.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    expect(version.user_version).toBe(AGENTERA_PRODUCT_SPACE_SCHEMA_VERSION);
    const tables = database.sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all() as Array<{ name: string }>;
    expect(tables.map(({ name }) => name)).toEqual([
      "product_space_migrations",
      "product_space_selection",
    ]);
    expect(
      database.sqlite
        .prepare("PRAGMA table_info(product_space_selection)")
        .all()
        .map((row) => (row as { name: string }).name),
    ).toEqual(["account_user_id", "kind", "scope_id", "updated_at"]);
    expect(
      database.sqlite
        .prepare("PRAGMA table_info(product_space_migrations)")
        .all()
        .map((row) => (row as { name: string }).name),
    ).toEqual(["account_user_id", "migration", "completed_at"]);
  });

  it("migrates missing or invalid legacy selections to Personal exactly once", () => {
    const database = databaseFor();
    expect(
      database.migrateLegacyWorkspaceSelection(ACCOUNT_A, {
        legacyWorkspaceId: null,
        activeWorkspaceIds: [WORKSPACE_A],
        completedAt: MIGRATED_AT,
      }),
    ).toEqual({ kind: "PERSONAL" });
    expect(database.readSelection(ACCOUNT_A)).toEqual({ kind: "PERSONAL" });
    expect(
      database.hasMigration(ACCOUNT_A, LEGACY_WORKSPACE_SELECTION_MIGRATION),
    ).toBe(true);

    expect(
      database.migrateLegacyWorkspaceSelection(ACCOUNT_B, {
        legacyWorkspaceId: WORKSPACE_B,
        activeWorkspaceIds: [WORKSPACE_A],
        completedAt: MIGRATED_AT,
      }),
    ).toEqual({ kind: "PERSONAL" });
  });

  it("imports one valid active Workspace selection without dual writing", () => {
    const database = databaseFor();
    const legacy = { selectedWorkspaceId: WORKSPACE_A };
    const first = database.migrateLegacyWorkspaceSelection(ACCOUNT_A, {
      legacyWorkspaceId: legacy.selectedWorkspaceId,
      activeWorkspaceIds: [WORKSPACE_A, WORKSPACE_B],
      completedAt: MIGRATED_AT,
    });
    expect(first).toEqual({ kind: "WORKSPACE", workspaceId: WORKSPACE_A });

    const second = database.migrateLegacyWorkspaceSelection(ACCOUNT_A, {
      legacyWorkspaceId: WORKSPACE_B,
      activeWorkspaceIds: [WORKSPACE_B],
      completedAt: UPDATED_AT,
    });
    expect(second).toEqual(first);
    expect(legacy.selectedWorkspaceId).toBe(WORKSPACE_A);
    const markers = database.sqlite
      .prepare(
        "SELECT COUNT(*) AS count FROM product_space_migrations WHERE account_user_id = ? AND migration = ?",
      )
      .get(ACCOUNT_A, LEGACY_WORKSPACE_SELECTION_MIGRATION) as {
      count: number;
    };
    expect(markers.count).toBe(1);
  });

  it("partitions Personal, Workspace, and Organization selections by account", () => {
    const database = databaseFor();
    database.writeSelection(
      ACCOUNT_A,
      { kind: "ORGANIZATION", organizationId: ORGANIZATION_A },
      UPDATED_AT,
    );
    database.writeSelection(
      ACCOUNT_B,
      { kind: "WORKSPACE", workspaceId: WORKSPACE_B },
      UPDATED_AT,
    );
    expect(database.readSelection(ACCOUNT_A)).toEqual({
      kind: "ORGANIZATION",
      organizationId: ORGANIZATION_A,
    });
    expect(database.readSelection(ACCOUNT_B)).toEqual({
      kind: "WORKSPACE",
      workspaceId: WORKSPACE_B,
    });

    database.writeSelection(ACCOUNT_A, { kind: "PERSONAL" }, UPDATED_AT);
    expect(database.readSelection(ACCOUNT_A)).toEqual({ kind: "PERSONAL" });
    expect(database.readSelection(ACCOUNT_B)).toEqual({
      kind: "WORKSPACE",
      workspaceId: WORKSPACE_B,
    });
  });

  it("rejects Department and malformed scope IDs as product selections", () => {
    const database = databaseFor();
    expect(() =>
      database.writeSelection(
        ACCOUNT_A,
        { kind: "DEPARTMENT", departmentId: DEPARTMENT_A } as never,
        UPDATED_AT,
      ),
    ).toThrow("selection");
    expect(() =>
      database.writeSelection(
        ACCOUNT_A,
        { kind: "ORGANIZATION", organizationId: "not-an-id" },
        UPDATED_AT,
      ),
    ).toThrow("Organization ID");
    expect(database.readSelection(ACCOUNT_A)).toBeNull();
  });

  it("preserves an existing product selection when the migration marker is added", () => {
    const database = databaseFor();
    database.writeSelection(
      ACCOUNT_A,
      { kind: "ORGANIZATION", organizationId: ORGANIZATION_A },
      UPDATED_AT,
    );
    expect(
      database.migrateLegacyWorkspaceSelection(ACCOUNT_A, {
        legacyWorkspaceId: WORKSPACE_A,
        activeWorkspaceIds: [WORKSPACE_A],
        completedAt: MIGRATED_AT,
      }),
    ).toEqual({ kind: "ORGANIZATION", organizationId: ORGANIZATION_A });
  });

  it("purges one account, closes idempotently, and rejects future schemas", () => {
    const userDataPath = temporaryUserData();
    const database = databaseFor(userDataPath);
    database.writeSelection(
      ACCOUNT_A,
      { kind: "WORKSPACE", workspaceId: WORKSPACE_A },
      UPDATED_AT,
    );
    database.writeSelection(
      ACCOUNT_B,
      { kind: "ORGANIZATION", organizationId: ORGANIZATION_A },
      UPDATED_AT,
    );
    database.purgeAccount(ACCOUNT_A);
    expect(database.readSelection(ACCOUNT_A)).toBeNull();
    expect(database.readSelection(ACCOUNT_B)).not.toBeNull();
    const path = database.databasePath;
    database.close();
    database.close();
    expect(() => database.readSelection(ACCOUNT_B)).toThrow("closed");

    chmodSync(path, 0o600);
    const raw = new DatabaseSync(path);
    raw.exec("PRAGMA user_version = 2");
    raw.close();
    expect(() => databaseFor(userDataPath)).toThrow("Unsupported");
  });
});
