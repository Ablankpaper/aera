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

function nodeSqliteFactory(path: string): AgenteraSqliteDatabase {
  return new DatabaseSync(path) as unknown as AgenteraSqliteDatabase;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("AgentEra control-plane schema", () => {
  it("creates the encrypted restore provenance boundary in a fresh database", () => {
    const root = mkdtempSync(join(tmpdir(), "agentera-control-schema-"));
    roots.push(root);
    const database = openAgenteraControlPlaneDatabase(join(root, "user-data"), {
      databaseFactory: nodeSqliteFactory,
    });
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
    } finally {
      database.close();
    }
  });

  it("migrates an existing v6 control plane without reading private bytes", () => {
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
    } finally {
      database.close();
    }
  });
});
