#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_COMMAND_BYTES = 4 * 1024 * 1024;
const SAFE_REASONS = new Set([
  "evidence_unavailable",
  "command_unavailable",
  "command_timeout",
  "permission_denied",
  "source_missing",
  "source_changed",
  "invalid_output",
  "sqlite_unavailable",
  "sqlite_locked",
  "sqlite_corrupt",
  "identity_mismatch",
  "collector_error",
]);

function readFileSlice(path, position, length) {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const count = readSync(
        fd,
        buffer,
        offset,
        length - offset,
        position + offset,
      );
      if (count === 0) break;
      offset += count;
    }
    return buffer.subarray(0, offset).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

export function readBoundedFile(path, maximumBytes = DEFAULT_COMMAND_BYTES) {
  const size = statSync(path).size;
  if (size <= maximumBytes) {
    return {
      text: readFileSync(path, "utf8"),
      bytes: size,
      truncated: false,
    };
  }
  const marker = `\n[TRUNCATED ${size - maximumBytes} BYTES]\n`;
  const markerBytes = Buffer.byteLength(marker, "utf8");
  const contentBytes = Math.max(0, maximumBytes - markerBytes);
  const headBytes = Math.floor(contentBytes / 2);
  const tailBytes = contentBytes - headBytes;
  return {
    text: `${readFileSlice(path, 0, headBytes)}${marker}${readFileSlice(path, size - tailBytes, tailBytes)}`,
    bytes: size,
    truncated: true,
  };
}

export function runBoundedCommand(command, args, options = {}) {
  const maximumBytes = options.maximumBytes ?? DEFAULT_COMMAND_BYTES;
  const commandRoot = mkdtempSync(
    join(options.tempRoot ?? tmpdir(), "aera-diagnostic-command-"),
  );
  chmodSync(commandRoot, 0o700);
  const stdoutPath = join(commandRoot, "stdout");
  const stderrPath = join(commandRoot, "stderr");
  const stdoutFd = openSync(stdoutPath, "w", 0o600);
  const stderrFd = openSync(stderrPath, "w", 0o600);
  let result;
  try {
    result = spawnSync(command, args, {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeoutMs ?? 5000,
      windowsHide: true,
      stdio: ["ignore", stdoutFd, stderrFd],
    });
  } finally {
    closeSync(stdoutFd);
    closeSync(stderrFd);
  }
  try {
    const stdout = readBoundedFile(stdoutPath, maximumBytes);
    const stderr = readBoundedFile(stderrPath, maximumBytes);
    return {
      command: [command, ...args].join(" "),
      code: typeof result?.status === "number" ? result.status : null,
      signal: result?.signal ?? null,
      timedOut: result?.error?.code === "ETIMEDOUT",
      stdout: stdout.text,
      stderr: stderr.text,
      stdoutBytes: stdout.bytes,
      stderrBytes: stderr.bytes,
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
      error: result?.error ? result.error.message : null,
    };
  } finally {
    rmSync(commandRoot, { recursive: true, force: true });
  }
}

/**
 * Convert an arbitrary collector failure into a closed, non-sensitive reason.
 * Raw exception text is deliberately not returned in a shareable section.
 */
export function classifyCollectorError(error) {
  const code = String(error?.code || "").toUpperCase();
  const message = String(error?.message || error || "").toLowerCase();
  if (code === "ETIMEDOUT" || message.includes("timeout"))
    return "command_timeout";
  if (code === "ENOENT" || message.includes("not found"))
    return "command_unavailable";
  if (code === "EACCES" || message.includes("permission"))
    return "permission_denied";
  if (message.includes("sqlite") && message.includes("locked"))
    return "sqlite_locked";
  if (message.includes("sqlite") && message.includes("corrupt"))
    return "sqlite_corrupt";
  if (message.includes("sqlite")) return "sqlite_unavailable";
  if (message.includes("missing") || message.includes("enoent"))
    return "source_missing";
  if (message.includes("changed") || message.includes("race"))
    return "source_changed";
  if (message.includes("invalid")) return "invalid_output";
  return "collector_error";
}

/** Return one shareable section result and never leak an exception message. */
export async function collectSection(name, operation) {
  try {
    const value = await operation();
    return value == null
      ? { name, status: "missing", reason: "evidence_unavailable", value: null }
      : { name, status: "collected", reason: null, value };
  } catch (error) {
    const reason = classifyCollectorError(error);
    return {
      name: String(name),
      status: "failed",
      reason: SAFE_REASONS.has(reason) ? reason : "collector_error",
      value: null,
    };
  }
}

/**
 * Ensure a generated bundle entry cannot escape its capture directory.
 * Backslashes are normalized so the same rule applies on Windows.
 */
export function safeRelativeName(value) {
  const name = String(value ?? "").replaceAll("\\", "/");
  if (
    !name ||
    name.startsWith("/") ||
    /^[A-Za-z]:\//.test(name) ||
    name.split("/").some((part) => part === ".." || part === "")
  )
    throw new Error("unsafe output filename");
  return name;
}

function sha256File(path) {
  const hash = createHash("sha256");
  const fd = openSync(path, "r");
  const buffer = Buffer.alloc(1024 * 1024);
  try {
    while (true) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

export function fingerprintFile(path) {
  if (!existsSync(path)) return { path, exists: false };
  const info = statSync(path);
  return {
    path,
    exists: true,
    size: info.size,
    mtimeMs: info.mtimeMs,
    sha256: sha256File(path),
  };
}

function fingerprintsMatch(before, after) {
  if (before.length !== after.length) return false;
  return before.every((entry, index) => {
    const candidate = after[index];
    return (
      entry.path === candidate.path &&
      entry.exists === candidate.exists &&
      entry.size === candidate.size &&
      entry.mtimeMs === candidate.mtimeMs &&
      entry.sha256 === candidate.sha256
    );
  });
}

export function prepareSqliteReadSnapshot(dbPath, tempRoot = tmpdir()) {
  if (!existsSync(dbPath)) throw new Error("sqlite_source_missing");
  const sourcePaths = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
  const sourceBefore = sourcePaths.map(fingerprintFile);
  const sidecars = sourceBefore.filter(
    (entry) => entry.exists && entry.path !== dbPath,
  );
  let copyDirectory = null;
  let sqliteTarget;
  let strategy;
  if (sidecars.length === 0) {
    const uri = pathToFileURL(dbPath);
    uri.searchParams.set("mode", "ro");
    uri.searchParams.set("immutable", "1");
    sqliteTarget = uri.href;
    strategy = "immutable";
  } else {
    copyDirectory = mkdtempSync(join(tempRoot, "aera-sqlite-snapshot-"));
    chmodSync(copyDirectory, 0o700);
    for (const source of sourceBefore.filter((entry) => entry.exists)) {
      const destination = join(copyDirectory, basename(source.path));
      copyFileSync(source.path, destination);
      chmodSync(destination, 0o600);
    }
    sqliteTarget = join(copyDirectory, basename(dbPath));
    strategy = "copied_sidecars";
  }
  const snapshot = {
    strategy,
    sqliteTarget,
    copyDirectory,
    sourceBefore,
    sourceAfter: null,
    sourceUnchanged: null,
    sidecars: {
      wal: sourceBefore[1].exists,
      shm: sourceBefore[2].exists,
    },
    cleanup() {
      snapshot.sourceAfter = sourcePaths.map(fingerprintFile);
      snapshot.sourceUnchanged = fingerprintsMatch(
        snapshot.sourceBefore,
        snapshot.sourceAfter,
      );
      if (copyDirectory)
        rmSync(copyDirectory, { recursive: true, force: true });
    },
  };
  return snapshot;
}

export function classifyObservationOutcome({
  requestedFinishReason,
  childExited,
  hasUntrackedAeraProcess,
  installedAppReplaced,
  processIdentityMatches,
}) {
  if (childExited)
    return {
      finishReason: "tracked_process_exited",
      reproductionConfirmed: false,
      processContinuityConfirmed: false,
    };
  if (hasUntrackedAeraProcess)
    return {
      finishReason: "untracked_aera_process_detected",
      reproductionConfirmed: false,
      processContinuityConfirmed: false,
    };
  if (installedAppReplaced)
    return {
      finishReason: "installed_app_replaced",
      reproductionConfirmed: false,
      processContinuityConfirmed: false,
    };
  if (!processIdentityMatches)
    return {
      finishReason: "running_identity_changed",
      reproductionConfirmed: false,
      processContinuityConfirmed: false,
    };
  if (requestedFinishReason === "user_enter")
    return {
      finishReason: "user_enter_with_verified_process",
      reproductionConfirmed: true,
      processContinuityConfirmed: true,
    };
  return {
    finishReason:
      requestedFinishReason === "stdin_not_tty"
        ? "stdin_unavailable"
        : requestedFinishReason,
    reproductionConfirmed: false,
    processContinuityConfirmed: true,
  };
}

function quotePredicate(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function padDatePart(value) {
  return String(value).padStart(2, "0");
}

export function formatMacLogTimestamp(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error("macOS unified-log timestamp is invalid");
  }
  return [
    date.getFullYear(),
    "-",
    padDatePart(date.getMonth() + 1),
    "-",
    padDatePart(date.getDate()),
    " ",
    padDatePart(date.getHours()),
    ":",
    padDatePart(date.getMinutes()),
    ":",
    padDatePart(date.getSeconds()),
  ].join("");
}

export function buildMacLogQueries({
  startedAt,
  endedAt,
  pids,
  bundleId,
  appPath,
}) {
  const uniquePids = [...new Set(pids.map(Number).filter(Number.isInteger))];
  const pidPredicate =
    uniquePids.length > 0
      ? uniquePids.map((pid) => `processID == ${pid}`).join(" OR ")
      : "FALSEPREDICATE";
  const baseArgs = [
    "show",
    "--style",
    "compact",
    "--start",
    formatMacLogTimestamp(startedAt),
    "--end",
    formatMacLogTimestamp(endedAt),
    "--info",
    "--debug",
    "--predicate",
  ];
  const policyProcesses = [
    "runningboardd",
    "syspolicyd",
    "taskgated",
    "taskgated-helper",
    "amfid",
    "launchservicesd",
  ]
    .map((name) => `process == ${quotePredicate(name)}`)
    .join(" OR ");
  return [
    {
      name: "aera_processes",
      command: "log",
      args: [...baseArgs, `(${pidPredicate})`],
    },
    {
      name: "macos_policy",
      command: "log",
      args: [
        ...baseArgs,
        `((${policyProcesses}) AND (eventMessage CONTAINS[c] ${quotePredicate(bundleId)} OR eventMessage CONTAINS[c] ${quotePredicate(appPath)} OR ${pidPredicate}))`,
      ],
    },
  ];
}

export function createBoundedInventory(entries, limit) {
  const included = entries.slice(0, limit);
  return {
    entries: included,
    discoveredCount: entries.length,
    includedCount: included.length,
    limit,
    truncated: entries.length > included.length,
  };
}
