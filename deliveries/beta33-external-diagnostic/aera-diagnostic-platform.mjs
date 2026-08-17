/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, normalize } from "node:path";

export {
  collectMacDnsRouteEvidence,
  collectMacPlatformEvidence,
  collectMacSecurityEvidence,
} from "./aera-diagnostic-platform-macos.mjs";

function relationHash(domain, value) {
  return createHash("sha256")
    .update(`${domain}\0${String(value)}`, "utf8")
    .digest("hex");
}

export function classifyProcessRole(command) {
  const value = String(command || "").toLowerCase();
  if (/--type=renderer\b/.test(value) || /helper \(renderer\)/.test(value))
    return "renderer";
  if (/--type=gpu-process\b/.test(value) || /helper \(gpu\)/.test(value))
    return "gpu";
  if (/--type=utility\b/.test(value) || /helper \(plugin\)/.test(value))
    return "utility";
  if (
    /hermes_cli|aera runtime|\bhermes\b/.test(value) &&
    /serve|gateway|agent|python/.test(value)
  )
    return "runtime";
  if (
    /aera(?:\.app|\.exe|\/contents\/macos\/aera)/.test(value) &&
    !/helper/.test(value)
  )
    return "main";
  if (/helper/.test(value)) return "helper";
  return "other";
}

export function buildProcessTree(rows, rootPid) {
  const byParent = new Map();
  for (const row of rows) {
    const parent = Number(row.ppid);
    const list = byParent.get(parent) || [];
    list.push(row);
    byParent.set(parent, list);
  }
  const selected = [];
  const queue = [Number(rootPid)];
  const visited = new Set();
  const byPid = new Map(rows.map((row) => [Number(row.pid), row]));
  while (queue.length > 0) {
    const pid = queue.shift();
    if (!Number.isInteger(pid) || visited.has(pid)) continue;
    visited.add(pid);
    const row = byPid.get(pid);
    if (row) {
      const command = String(row.command || "");
      selected.push({
        pid,
        ppid: Number(row.ppid) || null,
        startedAt: Number.isFinite(Date.parse(row.startedAt))
          ? new Date(row.startedAt).toISOString()
          : null,
        role: pid === Number(rootPid) ? "main" : classifyProcessRole(command),
        commandSha256: relationHash("aera-diagnostic-command-v1", command),
        executablePathSha256: row.executable
          ? relationHash(
              "aera-diagnostic-executable-path-v1",
              normalize(String(row.executable)),
            )
          : null,
      });
    }
    for (const child of (byParent.get(pid) || []).sort(
      (left, right) => Number(left.pid) - Number(right.pid),
    )) {
      queue.push(Number(child.pid));
    }
  }
  return selected;
}

function listLogFiles(directory) {
  if (!existsSync(directory)) return [];
  try {
    return readdirSync(directory)
      .filter((name) => /\.(?:log|txt|jsonl|out|err)$/i.test(name))
      .map((name) => join(directory, name))
      .filter((path) => {
        try {
          return statSync(path).isFile();
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

function activeProfile(hermesHome) {
  const path = join(hermesHome, "active_profile");
  try {
    const value = readFileSync(path, "utf8").trim();
    return /^[a-z0-9_][a-z0-9_-]{0,127}$/i.test(value) ? value : "default";
  } catch {
    return "default";
  }
}

export function findRuntimeLogSources({
  hermesHome,
  userDataPaths = [],
  openFiles = [],
}) {
  const profile = activeProfile(hermesHome);
  const profileRoot =
    profile === "default" ? hermesHome : join(hermesHome, "profiles", profile);
  const candidates = [];
  const add = (path, source, pid = null, processRole = null) => {
    if (!path || !/\.(?:log|txt|jsonl|out|err)$/i.test(path)) return;
    const key = normalize(path);
    const observed = source === "observed_open_file";
    const duplicate = candidates.find(
      (entry) =>
        entry.path === key &&
        (observed
          ? entry.source === source && entry.pid === pid
          : entry.source !== "observed_open_file"),
    );
    if (duplicate) return;
    candidates.push({ path: key, source, pid, processRole });
  };
  for (const entry of openFiles) {
    // The Runtime may write to a temporary or opaque path. Process ownership
    // and a bounded log-like suffix are stronger evidence than directory names.
    add(
      entry.path,
      "observed_open_file",
      Number(entry.pid) || null,
      entry.processRole || null,
    );
  }
  add(join(profileRoot, "gateway-stderr.log"), "active_profile");
  for (const path of listLogFiles(profileRoot)) add(path, "active_profile");
  for (const path of listLogFiles(join(profileRoot, "logs")))
    add(path, "active_profile");
  add(join(hermesHome, "gateway-stderr.log"), "global_runtime");
  for (const path of listLogFiles(join(hermesHome, "logs")))
    add(path, "global_runtime");
  for (const userData of userDataPaths) {
    for (const path of listLogFiles(join(userData, "logs")))
      add(path, "desktop_user_data");
    for (const path of listLogFiles(join(userData, "updater-logs")))
      add(path, "updater");
  }
  return candidates;
}

function logEvidence(entry, startedAt, endedAt) {
  try {
    const info = statSync(entry.path);
    const lower = Date.parse(startedAt) - 1000;
    const upper = Date.parse(endedAt) + 1000;
    const current = info.mtimeMs >= lower && info.mtimeMs <= upper;
    return {
      source: entry.source,
      pid: entry.pid,
      processRole: entry.processRole,
      pathSha256: relationHash(
        "aera-diagnostic-log-path-v1",
        normalize(entry.path),
      ),
      size: info.size,
      mtime: info.mtime.toISOString(),
      current,
    };
  } catch {
    return null;
  }
}

export function discoverRuntimeLogEvidence(input) {
  const entries = findRuntimeLogSources(input);
  const evidence = entries
    .map((entry) => logEvidence(entry, input.startedAt, input.endedAt))
    .filter(Boolean);
  const logs = evidence.filter((entry) => entry.current);
  const pidCorrelatedLogs = logs.filter(
    (entry) =>
      entry.source === "observed_open_file" &&
      Number.isInteger(entry.pid) &&
      entry.pid > 0 &&
      entry.processRole === "runtime",
  );
  const stale = evidence.filter((entry) => !entry.current);
  return {
    status: pidCorrelatedLogs.length > 0 ? "collected" : "missing",
    reason:
      pidCorrelatedLogs.length > 0 ? null : "current_runtime_log_unavailable",
    logs,
    pidCorrelatedLogs,
    pidCorrelatedCount: pidCorrelatedLogs.length,
    stale,
    discoveredCount: evidence.length,
  };
}

export function parseLsofNetwork(text) {
  const rows = [];
  let pid = null;
  let endpoint = null;
  const flush = (state = "unknown") => {
    if (Number.isInteger(pid) && endpoint) rows.push({ pid, endpoint, state });
    endpoint = null;
  };
  for (const line of String(text || "").split(/\r?\n/)) {
    if (line.startsWith("p")) {
      flush();
      pid = Number(line.slice(1));
    } else if (line.startsWith("n")) {
      flush();
      const name = line.slice(1);
      endpoint = name.includes("->") ? name.split("->").at(-1) : name;
    } else if (line.startsWith("TST=")) {
      flush(line.slice(4) || "unknown");
    }
  }
  flush();
  return rows.filter((row) =>
    /^[A-Za-z0-9_.:[\]-]+:\d{1,5}$/.test(row.endpoint),
  );
}
