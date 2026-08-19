/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

import { redactText } from "./aera-diagnostic-redaction.mjs";
import { runBoundedCommand } from "./aera-diagnostic-core.mjs";
import { parseStableEvents } from "./aera-diagnostic-events.mjs";

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

function commandSummary(command) {
  return {
    code: command.code,
    timedOut: Boolean(command.timedOut),
    stdoutBytes: Number(command.stdoutBytes) || 0,
    stderrBytes: Number(command.stderrBytes) || 0,
    stdoutTruncated: Boolean(command.stdoutTruncated),
    stderrTruncated: Boolean(command.stderrTruncated),
  };
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
    `$executable=${quotePowerShell(executable)}`,
    "$all=@(Get-CimInstance Win32_Process)",
    "$ids=@($rootPid)",
    "if($rootPid -gt 0){do{$children=@($all|Where-Object{$ids -contains [int]$_.ParentProcessId -and -not ($ids -contains [int]$_.ProcessId)}|ForEach-Object{[int]$_.ProcessId});if($children.Count -gt 0){$ids+=$children}}while($children.Count -gt 0)}",
    "$processes=@($all|Where-Object{$ids -contains [int]$_.ProcessId}|Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine,CreationDate)",
    "$runtimeIds=@($processes|Where-Object{$_.Name -match 'hermes|python|runtime'}|ForEach-Object{[int]$_.ProcessId})",
    "$handleTool=Get-Command handle.exe -ErrorAction SilentlyContinue",
    "$openHandles=[pscustomobject]@{status='missing';reason='runtime_process_unavailable';entries=@();commands=@()}",
    "if($runtimeIds.Count -gt 0){if($null -eq $handleTool){$openHandles=[pscustomobject]@{status='unavailable';reason='handle_tool_unavailable';entries=@();commands=@()}}else{$handleEntries=@();$handleCommands=@();foreach($runtimePid in $runtimeIds){$handleOutput=@(& $handleTool.Source -accepteula -nobanner -p $runtimePid 2>&1);$handleCode=if($null -eq $LASTEXITCODE){0}else{[int]$LASTEXITCODE};$handleCommands+=[pscustomobject]@{ProcessId=$runtimePid;Code=$handleCode};foreach($line in $handleOutput){if([string]$line -match '^\\s*[0-9A-Fa-f]+:\\s+File\\s+\\([^)]+\\)\\s+(.+)$'){$handleEntries+=[pscustomobject]@{ProcessId=$runtimePid;Path=$matches[1].Trim()}}}};$handleStatus=if(@($handleCommands|Where-Object{$_.Code -ne 0}).Count -gt 0){'failed'}elseif($handleEntries.Count -gt 0){'collected'}else{'missing'};$handleReason=if($handleStatus -eq 'failed'){'handle_query_failed'}elseif($handleStatus -eq 'missing'){'runtime_log_handles_unavailable'}else{$null};$openHandles=[pscustomobject]@{status=$handleStatus;reason=$handleReason;entries=$handleEntries;commands=$handleCommands}}}",
    "$connections=@(Get-NetTCPConnection|Where-Object{$ids -contains [int]$_.OwningProcess}|Select-Object OwningProcess,RemoteAddress,RemotePort,State,CreationTime)",
    "$dns=@(Get-DnsClientServerAddress|Select-Object InterfaceAlias,ServerAddresses)",
    "$routes=@(Get-NetRoute|Where-Object{$_.DestinationPrefix -in @('0.0.0.0/0','::/0')}|Select-Object NextHop,DestinationPrefix)",
    `$events=@(Get-WinEvent -FilterHashtable @{LogName='Application';StartTime=[datetime]${quotePowerShell(start)};EndTime=[datetime]${quotePowerShell(end)}}|Where-Object{$_.ProviderName -match 'Aera|Electron|agentera'}|Select-Object TimeCreated,ProviderName,Id,LevelDisplayName,Message -First 500)`,
    `$signatureSource=Get-AuthenticodeSignature -LiteralPath ${quotePowerShell(executable)}`,
    "$signature=[pscustomobject]@{Status=[string]$signatureSource.Status}",
    `$quarantine=[pscustomobject]@{present=$null -ne (Get-Item -LiteralPath $executable -Stream Zone.Identifier -ErrorAction SilentlyContinue)}`,
    "[pscustomobject]@{processes=$processes;connections=$connections;dns=$dns;routes=$routes;events=$events;signature=$signature;quarantine=$quarantine;openHandles=$openHandles}|ConvertTo-Json -Depth 8 -Compress",
  ].join(";");
}

function executableIdentity(path) {
  if (!path) return { sha256: null, status: "unavailable" };
  try {
    return {
      sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
      status: "collected",
    };
  } catch {
    return { sha256: null, status: "unavailable" };
  }
}

function listValue(value) {
  return Array.isArray(value) ? value : value == null ? [] : [value];
}

export function normalizeWindowsPlatformEvidence(value) {
  const processes = (
    Array.isArray(value?.processes)
      ? value.processes
      : value?.processes
        ? [value.processes]
        : []
  ).map((row) => {
    const role = /renderer/i.test(row.Name)
      ? "renderer"
      : /aera/i.test(row.Name)
        ? "main"
        : /hermes|python|runtime/i.test(row.Name)
          ? "runtime"
          : "other";
    const identity = executableIdentity(row.ExecutablePath);
    return {
      pid: Number(row.ProcessId),
      ppid: Number(row.ParentProcessId),
      role,
      nameSha256: hash("aera-diagnostic-process-name-v1", row.Name || ""),
      executablePathSha256: row.ExecutablePath
        ? hash("aera-diagnostic-executable-path-v1", row.ExecutablePath)
        : null,
      executableSha256: identity.sha256,
      executableIdentityStatus: identity.status,
      startedAt: Number.isFinite(Date.parse(row.CreationDate))
        ? new Date(row.CreationDate).toISOString()
        : null,
    };
  });
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
  const diagnosticEventResult = parseStableEvents(
    listValue(value?.events).map(
      (row) => `${String(row?.TimeCreated || "")} ${String(row?.Message || "")}`,
    ),
  );
  const dnsRows = value?.dns == null ? null : listValue(value.dns);
  const dnsServerSha256s = [
    ...new Set(
      (dnsRows || [])
        .flatMap((row) =>
          Array.isArray(row?.ServerAddresses)
            ? row.ServerAddresses
            : typeof row?.ServerAddresses === "string"
              ? [row.ServerAddresses]
              : row?.ServerAddress
                ? [row.ServerAddress]
                : [],
        )
        .filter((address) => typeof address === "string" && address.length > 0)
        .map((address) => hash("aera-diagnostic-dns-server-v1", address)),
    ),
  ].sort();
  const routeRows = value?.routes == null ? null : listValue(value.routes);
  const defaultRouteSha256s = [
    ...new Set(
      (routeRows || [])
        .filter((row) => ["0.0.0.0/0", "::/0"].includes(row?.DestinationPrefix))
        .map((row) =>
          hash("aera-diagnostic-default-route-v1", row.NextHop || ""),
        ),
    ),
  ].sort();
  const signatureStatus = String(value?.signature?.Status || "");
  const safeSignatureStatus = /^[A-Za-z]+$/.test(signatureStatus)
    ? signatureStatus
    : "unknown";
  const quarantinePresent = value?.quarantine?.present;
  const openFiles = normalizeWindowsOpenHandles(value?.openHandles);
  const runtimePids = new Set(
    processes
      .filter((process) => process.role === "runtime")
      .map((process) => process.pid),
  );
  const runtimeOpenFiles =
    String(value?.openHandles?.status || "") === "collected"
      ? listValue(value?.openHandles?.entries)
          .map((entry) => ({
            pid: Number(entry?.ProcessId),
            path: String(entry?.Path || ""),
            processRole: "runtime",
          }))
          .filter(
            (entry) =>
              runtimePids.has(entry.pid) &&
              /\.(?:log|txt|jsonl|out|err)(?:\s+\(deleted\))?$/iu.test(
                entry.path,
              ),
          )
      : [];
  const result = {
    processes,
    network,
    events,
    signature:
      value?.signature && signatureStatus
        ? {
            status: "collected",
            reason: null,
            statusValue: safeSignatureStatus,
          }
        : { status: "missing", reason: "windows_signature_unavailable" },
    quarantine:
      typeof quarantinePresent === "boolean"
        ? {
            status: "collected",
            reason: null,
            present: quarantinePresent,
          }
        : { status: "missing", reason: "windows_quarantine_unavailable" },
    dnsRoutes:
      dnsRows && routeRows
        ? {
            status: "collected",
            reason: null,
            dnsServerCount: dnsServerSha256s.length,
            dnsServerSha256s,
            defaultRouteCount: defaultRouteSha256s.length,
            defaultRouteSha256s,
          }
        : { status: "missing", reason: "windows_dns_route_unavailable" },
    openFiles,
  };
  Object.defineProperty(result, "runtimeOpenFiles", {
    value: runtimeOpenFiles,
    enumerable: false,
  });
  Object.defineProperty(result, "diagnosticEventResult", {
    value: diagnosticEventResult,
    enumerable: false,
  });
  return result;
}

function normalizeWindowsOpenHandles(value) {
  const status = String(value?.status || "missing");
  const reason = String(value?.reason || "windows_open_files_unavailable");
  const commands = listValue(value?.commands).map((command) => ({
    pid: Number(command?.ProcessId),
    code: Number.isInteger(Number(command?.Code)) ? Number(command.Code) : null,
  }));
  const entries = listValue(value?.entries)
    .map((entry) => ({
      pid: Number(entry?.ProcessId),
      pathSha256: hash(
        "aera-diagnostic-open-file-path-v1",
        String(entry?.Path || ""),
      ),
    }))
    .filter((entry) => Number.isInteger(entry.pid) && entry.pid > 0);
  const publicStatus =
    status === "collected" && entries.length > 0
      ? "collected"
      : status === "failed"
        ? "failed"
        : "missing";
  return {
    status: publicStatus,
    reason: publicStatus === "collected" ? null : reason,
    entries,
    commands,
  };
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
      quarantine: { status: "failed", reason },
      dnsRoutes: { status: "failed", reason },
      openFiles: {
        status: "failed",
        reason: reason === "powershell_unavailable" ? "powershell_unavailable" : reason,
        entries: [],
        commands: [],
      },
      nativeInventory,
      command: commandSummary(command),
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
      signature: normalized.signature,
      quarantine: normalized.quarantine,
      dnsRoutes: normalized.dnsRoutes,
      openFiles: normalized.openFiles,
      runtimeOpenFiles: normalized.runtimeOpenFiles,
      diagnosticEventResult: normalized.diagnosticEventResult,
      nativeInventory,
      command: commandSummary(command),
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
      quarantine: {
        status: "failed",
        reason: "windows_evidence_invalid_json",
      },
      dnsRoutes: {
        status: "failed",
        reason: "windows_evidence_invalid_json",
      },
      openFiles: {
        status: "failed",
        reason: "windows_evidence_invalid_json",
        entries: [],
        commands: [],
      },
      runtimeOpenFiles: [],
      nativeInventory,
      command: commandSummary(command),
    };
  }
}
