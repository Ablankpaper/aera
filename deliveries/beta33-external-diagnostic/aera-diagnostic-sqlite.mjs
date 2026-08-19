/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import {
  prepareSqliteReadSnapshot,
  runBoundedCommand,
} from "./aera-diagnostic-core.mjs";

function relationHash(domain, value) {
  if (value == null || String(value).length === 0) return null;
  return createHash("sha256")
    .update(`${domain}\0${String(value)}`, "utf8")
    .digest("hex");
}

function roleForSource(path, dbPath) {
  if (path === dbPath) return "database";
  if (path.endsWith("-wal")) return "wal";
  if (path.endsWith("-shm")) return "shm";
  return "unknown";
}

function publicFingerprint(entry, dbPath) {
  return {
    role: roleForSource(entry.path, dbPath),
    exists: entry.exists,
    size: entry.exists ? entry.size : null,
    mtimeMs: entry.exists ? entry.mtimeMs : null,
    sha256: entry.exists ? entry.sha256 : null,
  };
}

export function createReadOnlySqliteSnapshot(dbPath, tempRoot) {
  return prepareSqliteReadSnapshot(dbPath, tempRoot);
}

function failureReason(command) {
  if (command.error && /ENOENT|not found/i.test(command.error))
    return "sqlite_cli_unavailable";
  if (command.timedOut) return "sqlite_query_timeout";
  if (/locked|busy/i.test(command.stderr)) return "sqlite_locked";
  if (/malformed|corrupt/i.test(command.stderr)) return "sqlite_corrupt";
  if (/no such table/i.test(command.stderr)) return "journal_table_missing";
  return "sqlite_query_failed";
}

function normalizeRow(row) {
  return {
    operationSha256: relationHash(
      "aera-diagnostic-operation-v1",
      row.operation_id,
    ),
    profileSha256: relationHash("aera-diagnostic-profile-v1", row.profile_id),
    state: /^[a-z][a-z0-9_]{0,63}$/i.test(String(row.state || ""))
      ? row.state
      : "unknown",
    stage: /^[a-z][a-z0-9_]{0,63}$/i.test(String(row.stage || ""))
      ? row.stage
      : "unknown",
    ownerSha256: relationHash("aera-diagnostic-owner-v1", row.owner_handle),
    oldRouteSha256: relationHash("aera-diagnostic-route-v1", row.old_route_key),
    newRouteSha256: relationHash("aera-diagnostic-route-v1", row.new_route_key),
    createdAt: Number.isFinite(Date.parse(row.created_at))
      ? new Date(row.created_at).toISOString()
      : null,
    updatedAt: Number.isFinite(Date.parse(row.updated_at))
      ? new Date(row.updated_at).toISOString()
      : null,
  };
}

const JOURNAL_QUERY =
  "SELECT operation_id, profile_id, state, stage, owner_handle, old_route_key, new_route_key, created_at, updated_at FROM desktop_model_configuration_operations ORDER BY created_at, operation_id LIMIT 500;";

function queryWithBuiltInSqlite(sqliteTarget) {
  const path = String(sqliteTarget).startsWith("file:")
    ? fileURLToPath(sqliteTarget)
    : sqliteTarget;
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return database.prepare(JOURNAL_QUERY).all();
  } finally {
    database.close();
  }
}

function builtInFailureReason(error) {
  const message = String(error?.message || error || "");
  return failureReason({ error: null, timedOut: false, stderr: message });
}

/**
 * Query only the stable journal fields from a private immutable/snapshot view.
 * Source paths and raw owner/profile/route/operation values never leave here.
 */
export function collectModelJournal(dbPath, options = {}) {
  if (!existsSync(dbPath))
    return {
      status: "missing",
      reason: "database_missing",
      readStrategy: null,
      sidecars: { wal: false, shm: false },
      sourceUnchanged: true,
      sourceFiles: [],
      rows: [],
    };

  let snapshot;
  try {
    snapshot = createReadOnlySqliteSnapshot(dbPath, options.tempRoot);
  } catch {
    return {
      status: "failed",
      reason: "sqlite_snapshot_failed",
      readStrategy: null,
      sidecars: {
        wal: existsSync(`${dbPath}-wal`),
        shm: existsSync(`${dbPath}-shm`),
      },
      sourceUnchanged: null,
      sourceFiles: [],
      rows: [],
    };
  }

  let command;
  let builtInRows = null;
  let builtInError = null;
  const runCommand = options.runCommand || runBoundedCommand;
  try {
    command = runCommand(
      options.sqliteExecutable || "sqlite3",
      [
        "-json",
        snapshot.sqliteTarget,
        `PRAGMA query_only=ON; ${JOURNAL_QUERY}`,
      ],
      { timeoutMs: options.timeoutMs ?? 5000, maximumBytes: 2 * 1024 * 1024 },
    );
    if (
      command.code !== 0 &&
      failureReason(command) === "sqlite_cli_unavailable" &&
      options.sqliteExecutable == null
    ) {
      try {
        builtInRows = queryWithBuiltInSqlite(snapshot.sqliteTarget);
      } catch (error) {
        builtInError = error;
      }
    }
  } finally {
    snapshot.cleanup();
  }

  const common = {
    readStrategy: snapshot.strategy,
    sidecars: snapshot.sidecars,
    sourceUnchanged: snapshot.sourceUnchanged,
    sourceFiles: snapshot.sourceBefore.map((entry) =>
      publicFingerprint(entry, dbPath),
    ),
  };
  if (builtInRows) {
    return {
      status: "collected",
      reason: null,
      ...common,
      rows: builtInRows.map(normalizeRow),
      command: {
        code: command.code,
        timedOut: command.timedOut,
        stdoutBytes: command.stdoutBytes,
        stderrBytes: command.stderrBytes,
        stdoutTruncated: command.stdoutTruncated,
        stderrTruncated: command.stderrTruncated,
      },
    };
  }
  if (builtInError) {
    return {
      status: "failed",
      reason: builtInFailureReason(builtInError),
      ...common,
      rows: [],
    };
  }
  if (command.code !== 0) {
    return {
      status: "failed",
      reason: failureReason(command),
      ...common,
      rows: [],
      command: {
        code: command.code,
        timedOut: command.timedOut,
        stdoutBytes: command.stdoutBytes,
        stderrBytes: command.stderrBytes,
        stdoutTruncated: command.stdoutTruncated,
        stderrTruncated: command.stderrTruncated,
      },
    };
  }
  try {
    const rows = command.stdout.trim() ? JSON.parse(command.stdout) : [];
    if (!Array.isArray(rows)) throw new Error("invalid sqlite JSON");
    return {
      status: "collected",
      reason: null,
      ...common,
      rows: rows.map(normalizeRow),
      command: {
        code: 0,
        timedOut: false,
        stdoutBytes: command.stdoutBytes,
        stderrBytes: command.stderrBytes,
        stdoutTruncated: command.stdoutTruncated,
        stderrTruncated: command.stderrTruncated,
      },
    };
  } catch {
    return {
      status: "failed",
      reason: "sqlite_invalid_json",
      ...common,
      rows: [],
    };
  }
}
