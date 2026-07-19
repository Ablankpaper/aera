// @vitest-environment node

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AGENTERA_CONTROL_PLANE_SCHEMA_VERSION,
  openAgenteraControlPlaneDatabase,
  resolveAgenteraControlPlanePaths,
  type AgenteraSqliteDatabase,
} from "../src/main/agentera-agent-control/db";

const roots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "agentera-control-db-"));
  roots.push(root);
  return root;
}

function nodeSqliteFactory(path: string): AgenteraSqliteDatabase {
  return new DatabaseSync(path) as unknown as AgenteraSqliteDatabase;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("AgentEra control-plane database", () => {
  it("opens exactly below Electron userData and never below HERMES_HOME", () => {
    const root = temporaryRoot();
    const userDataPath = join(root, "user-data");
    const hermesHome = join(root, "hermes-home");
    mkdirSync(hermesHome, { recursive: true });
    const previousHermesHome = process.env.HERMES_HOME;
    process.env.HERMES_HOME = hermesHome;
    const opened: string[] = [];
    try {
      const paths = resolveAgenteraControlPlanePaths(userDataPath);
      expect(paths.databasePath).toBe(
        join(userDataPath, "agentera-control-plane", "control-plane.db"),
      );
      const database = openAgenteraControlPlaneDatabase(userDataPath, {
        databaseFactory: (path) => {
          opened.push(path);
          return nodeSqliteFactory(path);
        },
      });
      expect(database.databasePath).toBe(paths.databasePath);
      expect(opened).toEqual([paths.databasePath]);
      expect(opened[0].startsWith(hermesHome)).toBe(false);
      database.close();

      const unsafeFactory = vi.fn(nodeSqliteFactory);
      expect(() =>
        openAgenteraControlPlaneDatabase(join(hermesHome, "nested"), {
          databaseFactory: unsafeFactory,
        }),
      ).toThrow(/HERMES_HOME|control-plane path/i);
      expect(unsafeFactory).not.toHaveBeenCalled();
    } finally {
      if (previousHermesHome === undefined) delete process.env.HERMES_HOME;
      else process.env.HERMES_HOME = previousHermesHome;
    }
  });

  it("enables WAL and foreign keys and migrates the complete schema idempotently", () => {
    const userDataPath = join(temporaryRoot(), "user-data");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const database = openAgenteraControlPlaneDatabase(userDataPath, {
        databaseFactory: nodeSqliteFactory,
      });
      const journal = database.sqlite
        .prepare("PRAGMA journal_mode")
        .get() as Record<string, unknown>;
      const foreignKeys = database.sqlite
        .prepare("PRAGMA foreign_keys")
        .get() as Record<string, unknown>;
      const userVersion = database.sqlite
        .prepare("PRAGMA user_version")
        .get() as Record<string, unknown>;
      expect(Object.values(journal)).toEqual(["wal"]);
      expect(Object.values(foreignKeys)).toEqual([1]);
      expect(Object.values(userVersion)).toEqual([
        AGENTERA_CONTROL_PLANE_SCHEMA_VERSION,
      ]);

      const tables = database.sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all() as Array<{ name: string }>;
      expect(tables.map(({ name }) => name)).toEqual([
        "agent_drafts",
        "cached_agent_versions",
        "draft_assets",
        "local_agent_installations",
        "pending_sanitized_records",
        "runtime_bindings",
        "signing_key_cache",
      ]);
      for (const table of [
        "agent_drafts",
        "cached_agent_versions",
        "local_agent_installations",
        "runtime_bindings",
        "pending_sanitized_records",
      ]) {
        const columns = database.sqlite
          .prepare(`PRAGMA table_info(${table})`)
          .all() as Array<{ name: string }>;
        expect(columns.map(({ name }) => name)).toEqual(
          expect.arrayContaining(["tenant_id", "owner_id"]),
        );
      }
      database.close();
    }
  });

  it("migrates schema v1 without assigning legacy rows to the next login", () => {
    const userDataPath = join(temporaryRoot(), "user-data");
    const paths = resolveAgenteraControlPlanePaths(userDataPath);
    mkdirSync(paths.rootPath, { recursive: true });
    const legacy = new DatabaseSync(paths.databasePath);
    legacy.exec(`
      CREATE TABLE agent_drafts (id TEXT PRIMARY KEY);
      CREATE TABLE cached_agent_versions (version_id TEXT PRIMARY KEY);
      CREATE TABLE local_agent_installations (agent_installation_id TEXT PRIMARY KEY);
      CREATE TABLE runtime_bindings (id TEXT PRIMARY KEY, binding_json TEXT NOT NULL);
      CREATE TABLE pending_sanitized_records (id TEXT PRIMARY KEY, record_type TEXT NOT NULL);
      PRAGMA user_version = 1;
    `);
    legacy.close();

    const database = openAgenteraControlPlaneDatabase(userDataPath, {
      databaseFactory: nodeSqliteFactory,
    });
    expect(
      Object.values(
        database.sqlite.prepare("PRAGMA user_version").get() as Record<
          string,
          unknown
        >,
      ),
    ).toEqual([AGENTERA_CONTROL_PLANE_SCHEMA_VERSION]);
    const draftColumns = database.sqlite
      .prepare("PRAGMA table_info(agent_drafts)")
      .all() as Array<{ name: string }>;
    expect(draftColumns.map(({ name }) => name)).toEqual(
      expect.arrayContaining(["tenant_id", "owner_id"]),
    );
    database.close();
  });
});
