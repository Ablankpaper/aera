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
  it("pins the Workspace Agent local schema at version 3", () => {
    expect(AGENTERA_CONTROL_PLANE_SCHEMA_VERSION).toBe(3);
  });

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

      const draftColumns = database.sqlite
        .prepare("PRAGMA table_info(agent_drafts)")
        .all() as Array<{ name: string }>;
      expect(draftColumns.map(({ name }) => name)).toEqual(
        expect.arrayContaining(["target_scope", "workspace_id"]),
      );
      const installationColumns = database.sqlite
        .prepare("PRAGMA table_info(local_agent_installations)")
        .all() as Array<{ name: string }>;
      expect(installationColumns.map(({ name }) => name)).toEqual(
        expect.arrayContaining(["source_scope", "source_workspace_id"]),
      );
      const cachedColumns = database.sqlite
        .prepare("PRAGMA table_info(cached_agent_versions)")
        .all() as Array<{ name: string; pk: number }>;
      expect(
        cachedColumns
          .filter(({ pk }) => pk > 0)
          .sort((left, right) => left.pk - right.pk)
          .map(({ name }) => name),
      ).toEqual(["tenant_id", "owner_id", "version_id"]);

      const schemaRows = database.sqlite
        .prepare(
          "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name IN ('agent_drafts', 'local_agent_installations') ORDER BY name",
        )
        .all() as Array<{ name: string; sql: string }>;
      const schemaSql = schemaRows
        .map(({ sql }) => sql.replace(/\s+/g, " "))
        .join("\n");
      expect(schemaSql).toContain(
        "target_scope = 'USER' AND workspace_id IS NULL",
      );
      expect(schemaSql).toContain(
        "target_scope = 'WORKSPACE' AND workspace_id IS NOT NULL",
      );
      expect(schemaSql).toContain(
        "source_scope = 'USER' AND source_workspace_id IS NULL",
      );
      expect(schemaSql).toContain(
        "source_scope = 'WORKSPACE' AND source_workspace_id IS NOT NULL",
      );
      database.close();
    }
  });

  it("migrates owned schema v2 rows to USER context without changing legacy cache paths", () => {
    const userDataPath = join(temporaryRoot(), "user-data");
    const paths = resolveAgenteraControlPlanePaths(userDataPath);
    mkdirSync(paths.rootPath, { recursive: true });
    const legacy = new DatabaseSync(paths.databasePath);
    legacy.exec(`
	  CREATE TABLE agent_drafts (
		id TEXT PRIMARY KEY,
		tenant_id TEXT NOT NULL,
		owner_id TEXT NOT NULL,
		source_agent_definition_id TEXT,
		base_agent_version_id TEXT,
		display_name TEXT NOT NULL,
		icon_media_type TEXT,
		icon_data_base64 TEXT,
		manifest_json TEXT NOT NULL,
		revision INTEGER NOT NULL,
		publication_attempt_revision INTEGER,
		publication_attempted_at TEXT,
		publication_idempotency_key TEXT,
		publication_error_code TEXT,
		publication_error_summary TEXT,
		published_definition_id TEXT,
		published_version_id TEXT,
		published_revision INTEGER,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL
	  );
	  CREATE TABLE draft_assets (
		draft_id TEXT NOT NULL REFERENCES agent_drafts(id) ON DELETE CASCADE,
		path TEXT NOT NULL,
		revision INTEGER NOT NULL,
		kind TEXT NOT NULL,
		media_type TEXT NOT NULL,
		size_bytes INTEGER NOT NULL,
		sha256 TEXT NOT NULL,
		PRIMARY KEY (draft_id, path)
	  );
	  CREATE TABLE cached_agent_versions (
		version_id TEXT PRIMARY KEY,
		tenant_id TEXT NOT NULL,
		owner_id TEXT NOT NULL,
		definition_id TEXT NOT NULL,
		version_number INTEGER NOT NULL,
		content_digest TEXT NOT NULL,
		version_json TEXT NOT NULL,
		policy_snapshot_json TEXT,
		cache_relative_path TEXT NOT NULL,
		verified_at TEXT NOT NULL
	  );
	  CREATE TABLE local_agent_installations (
		agent_installation_id TEXT PRIMARY KEY,
		tenant_id TEXT NOT NULL,
		owner_id TEXT NOT NULL,
		device_installation_id TEXT NOT NULL,
		definition_id TEXT NOT NULL,
		selected_version_id TEXT NOT NULL,
		runtime_profile_id TEXT,
		policy_snapshot_id TEXT,
		status TEXT NOT NULL,
		retry_code TEXT,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL
	  );
	  INSERT INTO agent_drafts (
		id, tenant_id, owner_id, display_name, manifest_json, revision, created_at, updated_at
	  ) VALUES (
		'33333333-3333-4333-8333-333333333333',
		'11111111-1111-4111-8111-111111111111',
		'22222222-2222-4222-8222-222222222222',
		'Legacy USER draft', '{}', 1,
		'2026-07-19T00:00:00.000Z', '2026-07-19T00:00:00.000Z'
	  );
	  INSERT INTO draft_assets (
		draft_id, path, revision, kind, media_type, size_bytes, sha256
	  ) VALUES (
		'33333333-3333-4333-8333-333333333333', 'knowledge/legacy.md', 1,
		'knowledge', 'text/markdown', 6, '${"ab".repeat(32)}'
	  );
	  INSERT INTO cached_agent_versions (
		version_id, tenant_id, owner_id, definition_id, version_number, content_digest,
		version_json, cache_relative_path, verified_at
	  ) VALUES (
		'44444444-4444-4444-8444-444444444444',
		'11111111-1111-4111-8111-111111111111',
		'22222222-2222-4222-8222-222222222222',
		'77777777-7777-4777-8777-777777777777', 1, '${"cd".repeat(32)}', '{}',
		'44444444-4444-4444-8444-444444444444/${"cd".repeat(32)}',
		'2026-07-19T00:00:00.000Z'
	  );
	  INSERT INTO local_agent_installations (
		agent_installation_id, tenant_id, owner_id, device_installation_id,
		definition_id, selected_version_id, status, created_at, updated_at
	  ) VALUES (
		'55555555-5555-4555-8555-555555555555',
		'11111111-1111-4111-8111-111111111111',
		'22222222-2222-4222-8222-222222222222',
		'66666666-6666-4666-8666-666666666666',
		'77777777-7777-4777-8777-777777777777',
		'44444444-4444-4444-8444-444444444444', 'active',
		'2026-07-19T00:00:00.000Z', '2026-07-19T00:00:00.000Z'
	  );
	  PRAGMA user_version = 2;
	`);
    legacy.close();

    const database = openAgenteraControlPlaneDatabase(userDataPath, {
      databaseFactory: nodeSqliteFactory,
    });
    expect(
      database.sqlite
        .prepare(
          "SELECT target_scope, workspace_id FROM agent_drafts WHERE id = ?",
        )
        .get("33333333-3333-4333-8333-333333333333"),
    ).toEqual({ target_scope: "USER", workspace_id: null });
    expect(
      database.sqlite
        .prepare(
          "SELECT source_scope, source_workspace_id FROM local_agent_installations WHERE agent_installation_id = ?",
        )
        .get("55555555-5555-4555-8555-555555555555"),
    ).toEqual({ source_scope: "USER", source_workspace_id: null });
    expect(
      database.sqlite
        .prepare(
          "SELECT tenant_id, owner_id, cache_relative_path FROM cached_agent_versions WHERE version_id = ?",
        )
        .get("44444444-4444-4444-8444-444444444444"),
    ).toEqual({
      tenant_id: "11111111-1111-4111-8111-111111111111",
      owner_id: "22222222-2222-4222-8222-222222222222",
      cache_relative_path: `44444444-4444-4444-8444-444444444444/${"cd".repeat(32)}`,
    });
    expect(
      database.sqlite
        .prepare("SELECT count(*) AS count FROM draft_assets")
        .get(),
    ).toEqual({ count: 1 });
    database.close();
  });

  it("migrates schema v1 without assigning legacy rows to the next login", () => {
    const userDataPath = join(temporaryRoot(), "user-data");
    const paths = resolveAgenteraControlPlanePaths(userDataPath);
    mkdirSync(paths.rootPath, { recursive: true });
    const legacy = new DatabaseSync(paths.databasePath);
    legacy.exec(`
      CREATE TABLE agent_drafts (
		id TEXT PRIMARY KEY, source_agent_definition_id TEXT, base_agent_version_id TEXT,
		display_name TEXT NOT NULL, icon_media_type TEXT, icon_data_base64 TEXT,
		manifest_json TEXT NOT NULL, revision INTEGER NOT NULL,
		publication_attempt_revision INTEGER, publication_attempted_at TEXT,
		publication_idempotency_key TEXT, publication_error_code TEXT,
		publication_error_summary TEXT, published_definition_id TEXT,
		published_version_id TEXT, published_revision INTEGER,
		created_at TEXT NOT NULL, updated_at TEXT NOT NULL
	  );
	  CREATE TABLE draft_assets (
		draft_id TEXT NOT NULL REFERENCES agent_drafts(id) ON DELETE CASCADE,
		path TEXT NOT NULL, revision INTEGER NOT NULL, kind TEXT NOT NULL,
		media_type TEXT NOT NULL, size_bytes INTEGER NOT NULL, sha256 TEXT NOT NULL,
		PRIMARY KEY (draft_id, path)
	  );
	  CREATE TABLE cached_agent_versions (
		version_id TEXT PRIMARY KEY, definition_id TEXT NOT NULL,
		version_number INTEGER NOT NULL, content_digest TEXT NOT NULL,
		version_json TEXT NOT NULL, policy_snapshot_json TEXT,
		cache_relative_path TEXT NOT NULL, verified_at TEXT NOT NULL
	  );
	  CREATE TABLE local_agent_installations (
		agent_installation_id TEXT PRIMARY KEY, definition_id TEXT NOT NULL,
		selected_version_id TEXT NOT NULL, runtime_profile_id TEXT,
		policy_snapshot_id TEXT, status TEXT NOT NULL, retry_code TEXT,
		created_at TEXT NOT NULL, updated_at TEXT NOT NULL
	  );
	  CREATE TABLE runtime_bindings (
		id TEXT PRIMARY KEY, conversation_key TEXT NOT NULL UNIQUE,
		hermes_session_id TEXT UNIQUE, binding_json TEXT NOT NULL, created_at TEXT NOT NULL
	  );
	  CREATE TABLE pending_sanitized_records (
		id TEXT PRIMARY KEY, record_type TEXT NOT NULL, payload_json TEXT NOT NULL,
		attempt_count INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT,
		created_at TEXT NOT NULL, updated_at TEXT NOT NULL
	  );
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
