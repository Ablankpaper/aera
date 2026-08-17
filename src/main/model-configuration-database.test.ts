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

function captureDatabaseOpenFailure(error: unknown): unknown {
  try {
    openModelConfigurationDatabase(temporaryUserData(), {
      databaseFactory: () => {
        throw error;
      },
    });
  } catch (thrown) {
    return thrown;
  }
  throw new Error("Expected model configuration database startup to fail.");
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
  const privateUserPath = ["", "Users", "private"].join("/");

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

  it.each([
    {
      name: "ABI mismatch",
      error: Object.assign(
        new Error(
          [
            `The module '${privateUserPath}/Aera.app/better_sqlite3.node'`,
            "was compiled against a different Node.js version using",
            "NODE_MODULE_VERSION 137. This version of Node.js requires",
            "NODE_MODULE_VERSION 145.",
          ].join(" "),
        ),
        { code: "ERR_DLOPEN_FAILED" },
      ),
      expectedCode: "native_module_abi_mismatch",
    },
    {
      name: "architecture mismatch",
      error: Object.assign(
        new Error(
          `dlopen(${privateUserPath}/better_sqlite3.node): mach-o file, but is an incompatible architecture`,
        ),
        { code: "ERR_DLOPEN_FAILED" },
      ),
      expectedCode: "native_module_architecture_mismatch",
    },
    {
      name: "missing native dependency",
      error: Object.assign(
        new Error(
          `dlopen(${privateUserPath}/better_sqlite3.node): Library not loaded: @rpath/libmissing.dylib`,
        ),
        { code: "ERR_DLOPEN_FAILED" },
      ),
      expectedCode: "native_module_dependency_missing",
    },
    {
      name: "native module load denied",
      error: Object.assign(
        new Error(
          `dlopen(${privateUserPath}/better_sqlite3.node): permission denied`,
        ),
        { code: "EACCES" },
      ),
      expectedCode: "native_module_load_denied",
    },
    {
      name: "unclassified native load failure",
      error: Object.assign(
        new Error(
          `dlopen(${privateUserPath}/better_sqlite3.node): failed for an unclassified reason`,
        ),
        { code: "ERR_DLOPEN_FAILED" },
      ),
      expectedCode: "native_module_load_failed",
    },
    {
      name: "ordinary SQLite open failure",
      error: new Error(
        `SQLITE_CANTOPEN: unable to open ${privateUserPath}/model-configuration.db`,
      ),
      expectedCode: "model_configuration_database_unavailable",
    },
  ])(
    "classifies $name without exposing raw failure data",
    ({ error, expectedCode }) => {
      const thrown = captureDatabaseOpenFailure(error);
      expect(thrown).toMatchObject({
        name: "ModelConfigurationRuntimeError",
        code: expectedCode,
        evidence: {
          status: "failed",
          platform: process.platform,
          processArchitecture: process.arch,
          electronAbi: process.versions.modules,
          failureClass: expectedCode,
        },
      });

      const publicFailure = thrown as {
        code?: unknown;
        evidence?: unknown;
        message?: unknown;
      };
      const serialized = JSON.stringify({
        code: publicFailure.code,
        evidence: publicFailure.evidence,
        message: publicFailure.message,
      });
      expect(serialized).not.toContain(error.message);
      expect(serialized).not.toContain(".node");
      expect(serialized).not.toContain(`${privateUserPath}/`);
      expect(serialized).not.toMatch(/[A-Za-z]:\\\\/u);
    },
  );

  it("refuses a future schema without changing its version", () => {
    const userDataPath = temporaryUserData();
    const seed = databaseFor(userDataPath);
    const futureVersion = MODEL_CONFIGURATION_SCHEMA_VERSION + 1;
    seed.sqlite.exec(`PRAGMA user_version = ${futureVersion}`);
    seed.close();
    databases.splice(databases.indexOf(seed), 1);

    let thrown: unknown;
    try {
      databaseFor(userDataPath);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      name: "ModelConfigurationRuntimeError",
      code: "model_configuration_schema_unsupported",
    });

    const paths = resolveModelConfigurationDatabasePaths(userDataPath);
    const inspection = new DatabaseSync(paths.databasePath, {
      readOnly: true,
    });
    try {
      expect(inspection.prepare("PRAGMA user_version").get()).toMatchObject({
        user_version: futureVersion,
      });
    } finally {
      inspection.close();
    }
  });
});
