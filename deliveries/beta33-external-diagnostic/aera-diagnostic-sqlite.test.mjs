/* eslint-disable @typescript-eslint/explicit-function-return-type */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  collectModelJournal,
  createReadOnlySqliteSnapshot,
} from "./aera-diagnostic-sqlite.mjs";
import { DatabaseSync } from "node:sqlite";

function makeDatabase(root) {
  const db = join(root, "model-configuration.db");
  const database = new DatabaseSync(db);
  database.exec(`
    CREATE TABLE desktop_model_configuration_operations (
      operation_id TEXT PRIMARY KEY,
      profile_id TEXT,
      state TEXT,
      stage TEXT,
      owner_handle TEXT,
      old_route_key TEXT,
      new_route_key TEXT,
      created_at TEXT,
      updated_at TEXT
    );
    INSERT INTO desktop_model_configuration_operations VALUES (
      'operation-raw-identity', 'profile-secret', 'rolled_back', 'recovery',
      'owner-secret', 'route-old-secret', 'route-new-secret',
      '2026-08-17T01:00:00.000Z', '2026-08-17T01:00:01.000Z'
    );
  `);
  database.close();
  return db;
}

test("queries an immutable copy without changing DB source fingerprints", () => {
  const root = mkdtempSync(join(tmpdir(), "aera-sqlite-test-"));
  try {
    const db = makeDatabase(root);
    const before = statSync(db);
    const result = collectModelJournal(db);
    const after = statSync(db);
    assert.equal(result.status, "collected");
    assert.equal(result.readStrategy, "immutable");
    assert.equal(result.sourceUnchanged, true);
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].state, "rolled_back");
    assert.match(result.rows[0].operationSha256, /^[0-9a-f]{64}$/);
    assert.doesNotMatch(
      JSON.stringify(result),
      /owner-secret|route-old-secret|profile-secret|operation-raw-identity/,
    );
    assert.equal(before.size, after.size);
    assert.equal(before.mtimeMs, after.mtimeMs);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("copies DB with WAL and SHM sidecars and leaves all sources unchanged", () => {
  const root = mkdtempSync(join(tmpdir(), "aera-sqlite-sidecar-test-"));
  try {
    const db = makeDatabase(root);
    writeFileSync(`${db}-wal`, "");
    writeFileSync(`${db}-shm`, "");
    const snapshot = createReadOnlySqliteSnapshot(db);
    assert.equal(snapshot.strategy, "copied_sidecars");
    assert.equal(snapshot.sidecars.wal, true);
    assert.equal(snapshot.sidecars.shm, true);
    snapshot.cleanup();
    assert.equal(snapshot.sourceUnchanged, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reports missing DB and sqlite CLI explicitly", () => {
  const missing = collectModelJournal(
    "/definitely/missing/model-configuration.db",
  );
  assert.equal(missing.status, "missing");
  assert.equal(missing.reason, "database_missing");
  const root = mkdtempSync(join(tmpdir(), "aera-sqlite-cli-test-"));
  try {
    const db = makeDatabase(root);
    const unavailable = collectModelJournal(db, {
      sqliteExecutable: "/definitely/missing/sqlite3",
    });
    assert.equal(unavailable.status, "failed");
    assert.equal(unavailable.reason, "sqlite_cli_unavailable");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
