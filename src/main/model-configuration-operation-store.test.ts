// @vitest-environment node

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  openModelConfigurationDatabase,
  type ModelConfigurationDatabase,
  type ModelConfigurationSqliteDatabase,
} from "./model-configuration-database";
import {
  ModelConfigurationOperationStore,
  captureModelConfigurationFiles,
  persistModelConfigurationBackups,
  removeModelConfigurationBackups,
  restoreModelConfigurationFiles,
  type ModelConfigurationFilePaths,
} from "./model-configuration-operation-store";

const OPERATION_ID = "10000000-0000-4000-8000-000000000001";
const roots: string[] = [];
const databases: ModelConfigurationDatabase[] = [];

function fixture(): {
  root: string;
  database: ModelConfigurationDatabase;
  paths: ModelConfigurationFilePaths;
} {
  const root = mkdtempSync(join(tmpdir(), "aera-model-operation-"));
  roots.push(root);
  const database = openModelConfigurationDatabase(join(root, "user-data"), {
    databaseFactory: (path) =>
      new DatabaseSync(path) as unknown as ModelConfigurationSqliteDatabase,
  });
  databases.push(database);
  const profile = join(root, "hermes", "profiles", "default");
  const global = join(root, "hermes");
  mkdirSync(profile, { recursive: true });
  return {
    root,
    database,
    paths: {
      env: join(profile, ".env"),
      providers: join(profile, "providers.json"),
      config: join(profile, "config.yaml"),
      models: join(global, "models.json"),
      modelDefinitions: join(global, "model-definitions.json"),
    },
  };
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("ModelConfigurationOperationStore", () => {
  it("journals only bounded non-secret operation metadata", () => {
    const { database, paths } = fixture();
    writeFileSync(paths.config, "model:\n  provider: openai\n");
    const snapshot = captureModelConfigurationFiles({
      profileId: "default",
      operationId: OPERATION_ID,
      paths,
    });
    const store = new ModelConfigurationOperationStore(database);
    const record = store.begin({
      operationId: OPERATION_ID,
      ownerHandle: "a".repeat(64),
      profileId: "default",
      oldRouteKey: "openai\0gpt-5.6\0\0chat_completions",
      newRouteKey:
        "custom:petoi\0gpt-5.6-sol\0https://api.petoi.cn/v1\0codex_responses",
      snapshot,
    });

    expect(JSON.stringify(record)).not.toMatch(
      /api[_-]?key|secret|fileBody|absolutePath/i,
    );
    expect(JSON.stringify(record)).not.toContain(paths.config);
    expect(record.oldRouteKey).toBe("openai\0gpt-5.6\0\0chat_completions");
    expect(record.newRouteKey).toBe(
      "custom:petoi\0gpt-5.6-sol\0https://api.petoi.cn/v1\0codex_responses",
    );
    const columns = database.sqlite
      .prepare("PRAGMA table_info(desktop_model_configuration_operations)")
      .all() as Array<{ name: string }>;
    expect(columns.map(({ name }) => name)).not.toEqual(
      expect.arrayContaining(["api_key", "absolute_path", "file_body"]),
    );
  });

  it("round-trips the three-part owner handle without NUL truncation", () => {
    const { database, paths } = fixture();
    const snapshot = captureModelConfigurationFiles({
      profileId: "default",
      operationId: OPERATION_ID,
      paths,
    });
    const store = new ModelConfigurationOperationStore(database);
    const ownerHandle = [
      "10000000-0000-4000-8000-000000000001",
      "20000000-0000-4000-8000-000000000002",
      "30000000-0000-4000-8000-000000000003",
    ].join("\0");

    const record = store.begin({
      operationId: OPERATION_ID,
      ownerHandle,
      profileId: "default",
      oldRouteKey: "auto\0old\0\0",
      newRouteKey: "openai\0new\0https://example.invalid/v1\0responses",
      snapshot,
    });

    expect(record.ownerHandle).toBe(ownerHandle);
  });

  it("restores exact comments, CRLF bytes, modes, and absence", () => {
    const { paths } = fixture();
    const original = Buffer.from(
      "# keep this comment\r\nmodel:\r\n  provider: openai\r\n",
      "utf8",
    );
    writeFileSync(paths.config, original, { mode: 0o640 });
    const snapshot = captureModelConfigurationFiles({
      profileId: "default",
      operationId: OPERATION_ID,
      paths,
    });
    persistModelConfigurationBackups(snapshot);

    writeFileSync(paths.config, "model:\n  provider: broken\n");
    writeFileSync(paths.providers, '{"version":1,"providers":[]}');
    restoreModelConfigurationFiles(snapshot);

    expect(readFileSync(paths.config)).toEqual(original);
    expect(existsSync(paths.providers)).toBe(false);
    removeModelConfigurationBackups(snapshot);
    expect(
      Object.values(snapshot.files).some(({ backupPath }) =>
        existsSync(backupPath),
      ),
    ).toBe(false);
  });

  it("uses the durable replace protocol for every restored managed file", () => {
    const { paths, root } = fixture();
    const original = Buffer.from("model:\n  provider: openai\n", "utf8");
    writeFileSync(paths.config, original, { mode: 0o640 });
    const snapshot = captureModelConfigurationFiles({
      profileId: "default",
      operationId: OPERATION_ID,
      paths,
    });
    persistModelConfigurationBackups(snapshot);
    writeFileSync(paths.config, "model:\n  provider: broken\n");

    const events: string[] = [];
    const adapter = {
      writeTemporary(target: string, bytes: Buffer, mode: number): string {
        const temporary = `${target}.injected-temp`;
        events.push(`write:${target}`);
        writeFileSync(temporary, bytes, { mode });
        return temporary;
      },
      replace(temporary: string, target: string): void {
        events.push(`replace:${target}`);
        rmSync(target, { force: true });
        // The injected adapter intentionally models a same-volume replace;
        // the production adapter supplies the platform-specific primitive.
        renameSync(temporary, target);
      },
      flushTarget(target: string): void {
        events.push(`flush-target:${target}`);
      },
      flushParent(parent: string): void {
        events.push(`flush-parent:${parent}`);
      },
    };

    restoreModelConfigurationFiles(snapshot, adapter);

    expect(readFileSync(paths.config)).toEqual(original);
    expect(events).toEqual([
      `write:${paths.config}`,
      `replace:${paths.config}`,
      `flush-target:${paths.config}`,
      `flush-parent:${join(root, "hermes", "profiles", "default")}`,
    ]);
  });
});
