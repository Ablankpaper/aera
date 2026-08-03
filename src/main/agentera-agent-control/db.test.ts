// @vitest-environment node

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  AGENTERA_CONTROL_PLANE_SCHEMA_VERSION,
  openAgenteraControlPlaneDatabase,
  resolveAgenteraControlPlanePaths,
  type AgenteraSqliteDatabase,
} from "./db";

const roots: string[] = [];
const databaseTestTimeoutMs = process.platform === "win32" ? 30_000 : 5_000;

function nodeSqliteFactory(path: string): AgenteraSqliteDatabase {
  return new DatabaseSync(path) as unknown as AgenteraSqliteDatabase;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Aera control-plane schema", () => {
  it(
    "creates durable Installation, restore, and conversation ownership boundaries in a fresh database",
    () => {
      const root = mkdtempSync(join(tmpdir(), "agentera-control-schema-"));
      roots.push(root);
      const database = openAgenteraControlPlaneDatabase(
        join(root, "user-data"),
        {
          databaseFactory: nodeSqliteFactory,
        },
      );
      try {
        expect(database.sqlite.prepare("PRAGMA user_version").get()).toEqual({
          user_version: AGENTERA_CONTROL_PLANE_SCHEMA_VERSION,
        });
        expect(
          database.sqlite
            .prepare(
              `SELECT name FROM sqlite_master
               WHERE type = 'table' AND name = 'encrypted_backup_restores'`,
            )
            .get(),
        ).toEqual({ name: "encrypted_backup_restores" });
        expect(
          database.sqlite
            .prepare(
              `SELECT name FROM sqlite_master
               WHERE type = 'table' AND name = 'conversation_boundaries'`,
            )
            .get(),
        ).toEqual({ name: "conversation_boundaries" });
        expect(
          database.sqlite
            .prepare(
              `SELECT name FROM sqlite_master
               WHERE type = 'table' AND name = 'installation_operations'`,
            )
            .get(),
        ).toEqual({ name: "installation_operations" });
      } finally {
        database.close();
      }
    },
    databaseTestTimeoutMs,
  );

  it(
    "adds the Installation operation journal to an existing v8 database",
    () => {
      const root = mkdtempSync(join(tmpdir(), "agentera-control-v8-"));
      roots.push(root);
      const userDataPath = join(root, "user-data");
      const paths = resolveAgenteraControlPlanePaths(userDataPath);
      mkdirSync(paths.rootPath, { recursive: true });
      const legacy = new DatabaseSync(paths.databasePath);
      legacy.exec("PRAGMA user_version = 8");
      legacy.close();

      const database = openAgenteraControlPlaneDatabase(userDataPath, {
        databaseFactory: nodeSqliteFactory,
      });
      try {
        expect(database.sqlite.prepare("PRAGMA user_version").get()).toEqual({
          user_version: AGENTERA_CONTROL_PLANE_SCHEMA_VERSION,
        });
        expect(
          database.sqlite
            .prepare("PRAGMA table_info(installation_operations)")
            .all()
            .map((column) => (column as { name: string }).name),
        ).toEqual(
          expect.arrayContaining([
            "operation_id",
            "agent_installation_id",
            "target_kind",
            "target_profile_id",
            "runtime_profile_id",
            "phase",
            "revision",
          ]),
        );
      } finally {
        database.close();
      }
    },
    databaseTestTimeoutMs,
  );

  it(
    "migrates an existing v6 control plane without reading private bytes",
    () => {
      const root = mkdtempSync(join(tmpdir(), "agentera-control-v6-"));
      roots.push(root);
      const userDataPath = join(root, "user-data");
      const paths = resolveAgenteraControlPlanePaths(userDataPath);
      mkdirSync(paths.rootPath, { recursive: true });
      const legacy = new DatabaseSync(paths.databasePath);
      legacy.exec("PRAGMA user_version = 6");
      legacy.close();

      const database = openAgenteraControlPlaneDatabase(userDataPath, {
        databaseFactory: nodeSqliteFactory,
      });
      try {
        expect(database.sqlite.prepare("PRAGMA user_version").get()).toEqual({
          user_version: AGENTERA_CONTROL_PLANE_SCHEMA_VERSION,
        });
        expect(
          database.sqlite
            .prepare("PRAGMA table_info(encrypted_backup_restores)")
            .all()
            .map((column) => (column as { name: string }).name),
        ).toContain("encrypted_runtime_binding_provenance");
        expect(
          database.sqlite
            .prepare("PRAGMA table_info(conversation_boundaries)")
            .all()
            .map((column) => (column as { name: string }).name),
        ).toEqual(
          expect.arrayContaining([
            "actor_user_id",
            "scope_type",
            "scope_id",
            "visibility",
            "memory_scope",
            "runtime_binding_id",
            "tool_permission_snapshot_kind",
          ]),
        );
      } finally {
        database.close();
      }
    },
    databaseTestTimeoutMs,
  );

  it(
    "adds conversation boundaries to an existing v7 database without migrating legacy sessions",
    () => {
      const root = mkdtempSync(join(tmpdir(), "agentera-control-v7-"));
      roots.push(root);
      const userDataPath = join(root, "user-data");
      const paths = resolveAgenteraControlPlanePaths(userDataPath);
      mkdirSync(paths.rootPath, { recursive: true });
      const legacy = new DatabaseSync(paths.databasePath);
      legacy.exec(`
        CREATE TABLE runtime_bindings (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          owner_id TEXT NOT NULL,
          device_installation_id TEXT NOT NULL,
          conversation_key TEXT NOT NULL UNIQUE,
          hermes_session_id TEXT UNIQUE,
          binding_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        PRAGMA user_version = 7;
      `);
      legacy.close();

      const database = openAgenteraControlPlaneDatabase(userDataPath, {
        databaseFactory: nodeSqliteFactory,
      });
      try {
        expect(database.sqlite.prepare("PRAGMA user_version").get()).toEqual({
          user_version: AGENTERA_CONTROL_PLANE_SCHEMA_VERSION,
        });
        expect(
          database.sqlite
            .prepare("SELECT COUNT(*) AS count FROM conversation_boundaries")
            .get(),
        ).toEqual({ count: 0 });
      } finally {
        database.close();
      }
    },
    databaseTestTimeoutMs,
  );
});
