/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

import { redactText } from "./aera-diagnostic-redaction.mjs";
import { runBoundedCommand } from "./aera-diagnostic-core.mjs";

function hash(domain, value) {
  return createHash("sha256")
    .update(`${domain}\0${String(value)}`, "utf8")
    .digest("hex");
}

function inspectNativeFile(path) {
  try {
    const bytes = readFileSync(path);
    const markers = [
      ...bytes.toString("latin1").matchAll(/node_register_module_v(\d+)/gu),
    ].map((match) => match[1]);
    const uniqueMarkers = [...new Set(markers)];
    return {
      sha256: createHash("sha256").update(bytes).digest("hex"),
      abi: uniqueMarkers.length === 1 ? uniqueMarkers[0] : null,
      abiStatus:
        uniqueMarkers.length === 0
          ? "not_found"
          : uniqueMarkers.length === 1
            ? "collected"
            : "ambiguous",
    };
  } catch {
    return { sha256: null, abi: null, abiStatus: "unavailable" };
  }
}

function nativeRootForApp(appPath, executable) {
  const candidates = [];
  const addCandidate = (base, isDirectoryHint = false) => {
    if (!base) return;
    let directory = isDirectoryHint;
    if (!isDirectoryHint) {
      try {
        directory = lstatSync(base).isDirectory();
      } catch {
        directory = false;
      }
    }
    const root = join(
      directory ? base : dirname(base),
      "resources",
      "app.asar.unpacked",
    );
    if (!candidates.includes(root)) candidates.push(root);
  };
  addCandidate(appPath);
  if (executable && executable !== appPath) addCandidate(executable);
  return (
    candidates.find((candidate) => existsSync(candidate)) || candidates[0] || ""
  );
}

function walkNative(root, entries = []) {
  if (!root || !existsSync(root) || entries.length >= 500) return entries;
  let names;
  try {
    names = readdirSync(root);
  } catch {
    return entries;
  }
  for (const name of names.sort()) {
    if (entries.length >= 500) break;
    const path = join(root, name);
    let info;
    try {
      info = lstatSync(path);
    } catch {
      continue;
    }
    if (info.isDirectory()) walkNative(path, entries);
    else if (info.isFile() && path.toLowerCase().endsWith(".node")) {
      const native = inspectNativeFile(path);
      entries.push({
        pathSha256: hash("aera-diagnostic-native-path-v1", normalize(path)),
        ...native,
        size: info.size,
        architecture: "unknown",
      });
    }
  }
  return entries;
}

function collectNativeInventory(appPath, executable) {
  const root = nativeRootForApp(appPath, executable);
  const entries = walkNative(root);
  return {
    status: entries.length ? "collected" : "missing",
    reason: entries.length ? null : "native_module_inventory_unavailable",
    entries,
    electronModulesAbi: String(process.versions.modules || "unknown"),
  };
}

function quotePowerShell(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function buildWindowsEvidenceScript({
  rootPid,
  executable,
  startedAt,
  endedAt,
}) {
  const start = new Date(startedAt).toISOString();
  const end = new Date(endedAt).toISOString();
  return [
    "$ErrorActionPreference='SilentlyContinue'",
    `$rootPid=${Number(rootPid) || 0}`,
    "$all=@(Get-CimInstance Win32_Process)",
    "$ids=@($rootPid)",
    "if($rootPid -gt 0){do{$children=@($all|Where-Object{$ids -contains [int]$_.ParentProcessId -and -not ($ids -contains [int]$_.ProcessId)}|ForEach-Object{[int]$_.ProcessId});if($children.Count -gt 0){$ids+=$children}}while($children.Count -gt 0)}",
    "$processes=@($all|Where-Object{$ids -contains [int]$_.ProcessId}|Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CreationDate)",
    "$connections=@(Get-NetTCPConnection|Where-Object{$ids -contains [int]$_.OwningProcess}|Select-Object OwningProcess,RemoteAddress,RemotePort,State,CreationTime)",
    `$events=@(Get-WinEvent -FilterHashtable @{LogName='Application';StartTime=[datetime]${quotePowerShell(start)};EndTime=[datetime]${quotePowerShell(end)}}|Where-Object{$_.ProviderName -match 'Aera|Electron|agentera'}|Select-Object TimeCreated,ProviderName,Id,LevelDisplayName,Message -First 500)`,
    `$signature=(Get-AuthenticodeSignature -LiteralPath ${quotePowerShell(executable)}|Select-Object Status,StatusMessage)`,
    "[pscustomobject]@{processes=$processes;connections=$connections;events=$events;signature=$signature}|ConvertTo-Json -Depth 6 -Compress",
  ].join(";");
}

export function normalizeWindowsPlatformEvidence(value) {
  const processes = (
    Array.isArray(value?.processes)
      ? value.processes
      : value?.processes
        ? [value.processes]
        : []
  ).map((row) => ({
    pid: Number(row.ProcessId),
    ppid: Number(row.ParentProcessId),
    role: /renderer/i.test(row.Name)
      ? "renderer"
      : /aera/i.test(row.Name)
        ? "main"
        : /hermes|python/i.test(row.Name)
          ? "runtime"
          : "other",
    nameSha256: hash("aera-diagnostic-process-name-v1", row.Name || ""),
    executablePathSha256: hash(
      "aera-diagnostic-executable-path-v1",
      row.ExecutablePath || "",
    ),
    startedAt: Number.isFinite(Date.parse(row.CreationDate))
      ? new Date(row.CreationDate).toISOString()
      : null,
  }));
  const network = (
    Array.isArray(value?.connections)
      ? value.connections
      : value?.connections
        ? [value.connections]
        : []
  )
    .map((row) => ({
      pid: Number(row.OwningProcess),
      endpoint: `${row.RemoteAddress}:${Number(row.RemotePort)}`,
      state: String(row.State || "unknown"),
    }))
    .filter(
      (row) =>
        Number.isInteger(row.pid) &&
        /^[A-Za-z0-9_.:[\]-]+:\d{1,5}$/.test(row.endpoint),
    );
  const events = (
    Array.isArray(value?.events)
      ? value.events
      : value?.events
        ? [value.events]
        : []
  ).map((row) => ({
    at: Number.isFinite(Date.parse(row.TimeCreated))
      ? new Date(row.TimeCreated).toISOString()
      : null,
    providerSha256: hash(
      "aera-diagnostic-event-provider-v1",
      row.ProviderName || "",
    ),
    eventId: Number(row.Id) || null,
    level: /^[A-Za-z]+$/.test(String(row.LevelDisplayName || ""))
      ? row.LevelDisplayName
      : "unknown",
    messageSha256: hash(
      "aera-diagnostic-event-message-v1",
      redactText(row.Message || ""),
    ),
  }));
  return { processes, network, events };
}

export function collectWindowsPlatformEvidence({
  rootPid,
  executable,
  appPath,
  startedAt,
  endedAt,
  runCommand = runBoundedCommand,
}) {
  const nativeInventory = collectNativeInventory(appPath, executable);
  const command = runCommand(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      buildWindowsEvidenceScript({ rootPid, executable, startedAt, endedAt }),
    ],
    { timeoutMs: 10_000, maximumBytes: 2 * 1024 * 1024 },
  );
  if (command.code !== 0) {
    const reason =
      command.error && /ENOENT|not found/i.test(command.error)
        ? "powershell_unavailable"
        : command.timedOut
          ? "powershell_timeout"
          : "windows_evidence_query_failed";
    return {
      platform: "win32",
      process: { status: "failed", reason, tree: [], rootPid: Number(rootPid) },
      network: { status: "failed", reason, entries: [] },
      events: { status: "failed", reason, entries: [] },
      signature: { status: "failed", reason },
      nativeInventory,
    };
  }
  try {
    const normalized = normalizeWindowsPlatformEvidence(
      JSON.parse(command.stdout),
    );
    return {
      platform: "win32",
      process: {
        status: normalized.processes.length ? "collected" : "missing",
        reason: normalized.processes.length ? null : "process_tree_unavailable",
        tree: normalized.processes,
        rootPid: Number(rootPid),
      },
      network: {
        status: normalized.network.length ? "collected" : "missing",
        reason: normalized.network.length
          ? null
          : "network_endpoints_unavailable",
        entries: normalized.network,
      },
      events: {
        status: normalized.events.length ? "collected" : "missing",
        reason: normalized.events.length ? null : "windows_events_unavailable",
        entries: normalized.events,
      },
      signature: { status: "collected", reason: null },
      nativeInventory,
    };
  } catch {
    return {
      platform: "win32",
      process: {
        status: "failed",
        reason: "windows_evidence_invalid_json",
        tree: [],
        rootPid: Number(rootPid),
      },
      network: {
        status: "failed",
        reason: "windows_evidence_invalid_json",
        entries: [],
      },
      events: {
        status: "failed",
        reason: "windows_evidence_invalid_json",
        entries: [],
      },
      signature: { status: "failed", reason: "windows_evidence_invalid_json" },
      nativeInventory,
    };
  }
}
