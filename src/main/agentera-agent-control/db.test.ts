// @vitest-environment node

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
  it.each(["fresh", "v11"] as const)(
    "creates Beta.27 local reliability tables from %s",
    (source) => {
      const root = mkdtempSync(join(tmpdir(), `agentera-control-${source}-`));
      roots.push(root);
      const userDataPath = join(root, "user-data");
      if (source === "v11") {
        const paths = resolveAgenteraControlPlanePaths(userDataPath);
        mkdirSync(paths.rootPath, { recursive: true });
        const legacy = new DatabaseSync(paths.databasePath);
        legacy.exec("PRAGMA user_version = 11");
        legacy.close();
      }

      const database = openAgenteraControlPlaneDatabase(userDataPath, {
        databaseFactory: nodeSqliteFactory,
      });
      try {
        expect(database.sqlite.prepare("PRAGMA user_version").get()).toEqual({
          user_version: 12,
        });
        const tableNames = database.sqlite
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
          )
          .all()
          .map((row) => (row as { name: string }).name);
        const reliabilityTables = [
          "organization_agent_submission_ref_conflicts",
          "conversation_threads",
          "conversation_segments",
        ];
        expect(tableNames).toEqual(expect.arrayContaining(reliabilityTables));
        for (const table of reliabilityTables) {
          const columns = database.sqlite
            .prepare(`PRAGMA table_info(${table})`)
            .all()
            .map((row) => (row as { name: string }).name)
            .join(" ");
          expect(columns).not.toMatch(
            /api_key|secret_value|prompt|message_body|profile_path/i,
          );
        }
      } finally {
        database.close();
      }
    },
    databaseTestTimeoutMs,
  );

  it(
    "migrates v10 MCP requirement bindings without changing an existing Installation",
    () => {
      expect(AGENTERA_CONTROL_PLANE_SCHEMA_VERSION).toBe(12);
      const root = mkdtempSync(join(tmpdir(), "agentera-control-v10-"));
      roots.push(root);
      const userDataPath = join(root, "user-data");
      const paths = resolveAgenteraControlPlanePaths(userDataPath);
      mkdirSync(paths.rootPath, { recursive: true });
      const legacy = new DatabaseSync(paths.databasePath);
      legacy.exec(`
        CREATE TABLE local_agent_installations (
          agent_installation_id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          owner_id TEXT NOT NULL,
          device_installation_id TEXT NOT NULL,
          runtime_profile_id TEXT,
          status TEXT NOT NULL
        );
        INSERT INTO local_agent_installations VALUES (
          '11111111-1111-4111-8111-111111111111',
          '22222222-2222-4222-8222-222222222222',
          '33333333-3333-4333-8333-333333333333',
          '44444444-4444-4444-8444-444444444444',
          '55555555-5555-4555-8555-555555555555',
          'pending'
        );
        PRAGMA user_version = 10;
      `);
      legacy.close();

      const database = openAgenteraControlPlaneDatabase(userDataPath, {
        databaseFactory: nodeSqliteFactory,
      });
      try {
        expect(database.sqlite.prepare("PRAGMA user_version").get()).toEqual({
          user_version: 12,
        });
        expect(
          database.sqlite
            .prepare(
              "SELECT agent_installation_id, runtime_profile_id, status FROM local_agent_installations",
            )
            .get(),
        ).toEqual({
          agent_installation_id: "11111111-1111-4111-8111-111111111111",
          runtime_profile_id: "55555555-5555-4555-8555-555555555555",
          status: "pending",
        });
        const columns = database.sqlite
          .prepare("PRAGMA table_info(agent_mcp_requirement_bindings)")
          .all() as Array<{ name: string }>;
        expect(columns.map(({ name }) => name)).toEqual([
          "tenant_id",
          "owner_id",
          "device_installation_id",
          "agent_installation_id",
          "requirement_logical_name",
          "local_mcp_name",
          "verified_tool_names_json",
          "revision",
          "created_at",
          "updated_at",
        ]);
      } finally {
        database.close();
      }
    },
    databaseTestTimeoutMs,
  );

  it(
    "migrates v9 Organization experience receipts without changing Workspace rows or files",
    () => {
      expect(AGENTERA_CONTROL_PLANE_SCHEMA_VERSION).toBe(12);
      const root = mkdtempSync(join(tmpdir(), "agentera-control-v9-"));
      roots.push(root);
      const userDataPath = join(root, "user-data");
      const paths = resolveAgenteraControlPlanePaths(userDataPath);
      const workspaceSnapshotPath = join(
        paths.candidatesPath,
        "legacy-workspace-candidate.json",
      );
      mkdirSync(paths.candidatesPath, { recursive: true });
      writeFileSync(workspaceSnapshotPath, "workspace-candidate-bytes", {
        mode: 0o600,
      });
      const legacy = new DatabaseSync(paths.databasePath);
      legacy.exec(`
        CREATE TABLE local_experience_candidates (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          owner_id TEXT NOT NULL,
          device_installation_id TEXT NOT NULL,
          agent_installation_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          agent_definition_id TEXT NOT NULL,
          source_agent_version_id TEXT NOT NULL,
          runtime_profile_id TEXT NOT NULL,
          skill_name TEXT NOT NULL,
          source_relative_path TEXT NOT NULL,
          content_digest TEXT NOT NULL,
          dlp_contract_version TEXT NOT NULL,
          snapshot_relative_path TEXT NOT NULL,
          status TEXT NOT NULL,
          cloud_candidate_id TEXT,
          last_error_code TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          submitted_at TEXT
        );
        INSERT INTO local_experience_candidates (
          id, tenant_id, owner_id, device_installation_id,
          agent_installation_id, workspace_id, agent_definition_id,
          source_agent_version_id, runtime_profile_id, skill_name,
          source_relative_path, content_digest, dlp_contract_version,
          snapshot_relative_path, status, created_at, updated_at
        ) VALUES (
          '11111111-1111-4111-8111-111111111111',
          '22222222-2222-4222-8222-222222222222',
          '33333333-3333-4333-8333-333333333333',
          '44444444-4444-4444-8444-444444444444',
          '55555555-5555-4555-8555-555555555555',
          '66666666-6666-4666-8666-666666666666',
          '77777777-7777-4777-8777-777777777777',
          '88888888-8888-4888-8888-888888888888',
          '99999999-9999-4999-8999-999999999999',
          'weekly-summary', 'skills/weekly-summary',
          '${"ab".repeat(32)}', 'experience-candidate-dlp-v1',
          'legacy-workspace-candidate.json', 'PREPARED',
          '2026-08-05T00:00:00.000Z', '2026-08-05T00:00:00.000Z'
        );
        PRAGMA user_version = 9;
      `);
      legacy.close();

      const database = openAgenteraControlPlaneDatabase(userDataPath, {
        databaseFactory: nodeSqliteFactory,
      });
      try {
        expect(database.sqlite.prepare("PRAGMA user_version").get()).toEqual({
          user_version: 12,
        });
        const tables = database.sqlite
          .prepare(
            `SELECT name FROM sqlite_master
             WHERE type = 'table' AND name LIKE 'local_organization_experience_candidate%'
             ORDER BY name`,
          )
          .all();
        expect(tables).toEqual([
          { name: "local_organization_experience_candidate_imports" },
          { name: "local_organization_experience_candidates" },
        ]);
        expect(
          database.sqlite
            .prepare(
              `SELECT id, workspace_id, content_digest, status
               FROM local_experience_candidates`,
            )
            .get(),
        ).toEqual({
          id: "11111111-1111-4111-8111-111111111111",
          workspace_id: "66666666-6666-4666-8666-666666666666",
          content_digest: "ab".repeat(32),
          status: "PREPARED",
        });
        expect(readFileSync(workspaceSnapshotPath, "utf8")).toBe(
          "workspace-candidate-bytes",
        );
      } finally {
        database.close();
      }
    },
    databaseTestTimeoutMs,
  );

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
