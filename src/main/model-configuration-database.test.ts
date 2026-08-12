// @vitest-environment node

import { mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  MODEL_CONFIGURATION_SCHEMA_VERSION,
  openModelConfigurationDatabase,
  resolveModelConfigurationDatabasePaths,
  type ModelConfigurationDatabase,
  type ModelConfigurationSqliteDatabase,
} from "./model-configuration-database";

const roots: string[] = [];
const databases: ModelConfigurationDatabase[] = [];
const originalHermesHome = process.env.HERMES_HOME;

function temporaryUserData(): string {
  const root = mkdtempSync(join(tmpdir(), "aera-model-configuration-db-"));
  roots.push(root);
  return join(root, "user-data");
}

function databaseFor(
  userDataPath = temporaryUserData(),
): ModelConfigurationDatabase {
  const database = openModelConfigurationDatabase(userDataPath, {
    databaseFactory: (path) =>
      new DatabaseSync(path) as unknown as ModelConfigurationSqliteDatabase,
  });
  databases.push(database);
  return database;
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
  if (originalHermesHome === undefined) delete process.env.HERMES_HOME;
  else process.env.HERMES_HOME = originalHermesHome;
});

describe("ModelConfigurationDatabase", () => {
  it("opens the stable restrictive userData database outside HERMES_HOME", () => {
    expect(() =>
      resolveModelConfigurationDatabasePaths("relative/path"),
    ).toThrow("absolute");
    const userDataPath = temporaryUserData();
    const paths = resolveModelConfigurationDatabasePaths(userDataPath);
    expect(paths).toEqual({
      rootPath: join(userDataPath, "model-configuration"),
      databasePath: join(
        userDataPath,
        "model-configuration",
        "model-configuration.db",
      ),
    });

    process.env.HERMES_HOME = paths.rootPath;
    expect(() => databaseFor(userDataPath)).toThrow("outside HERMES_HOME");
    delete process.env.HERMES_HOME;

    const database = databaseFor(userDataPath);
    expect(database.sqlite.prepare("PRAGMA user_version").get()).toMatchObject({
      user_version: MODEL_CONFIGURATION_SCHEMA_VERSION,
    });
    if (process.platform !== "win32") {
      expect(statSync(database.paths.rootPath).mode & 0o777).toBe(0o700);
      expect(statSync(database.paths.databasePath).mode & 0o777).toBe(0o600);
    }
  });

  it("creates only the bounded operation journal schema", () => {
    const database = databaseFor();
    const tables = database.sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all() as Array<{ name: string }>;
    expect(tables.map(({ name }) => name)).toEqual([
      "desktop_model_configuration_operations",
    ]);
    const columns = database.sqlite
      .prepare("PRAGMA table_info(desktop_model_configuration_operations)")
      .all() as Array<{ name: string }>;
    expect(columns.map(({ name }) => name)).not.toEqual(
      expect.arrayContaining(["api_key", "absolute_path", "file_body"]),
    );
  });
});
