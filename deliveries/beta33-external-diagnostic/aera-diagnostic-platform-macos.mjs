/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, normalize } from "node:path";

import {
  buildProcessTree,
  parseLsofNetwork,
} from "./aera-diagnostic-platform.mjs";
import { runBoundedCommand } from "./aera-diagnostic-core.mjs";

function hash(domain, value) {
  return createHash("sha256")
    .update(`${domain}\0${String(value)}`, "utf8")
    .digest("hex");
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

export function collectMacSecurityEvidence({
  appPath,
  executable,
  runCommand = runBoundedCommand,
}) {
  const checks = [
    {
      name: "codesign",
      command: runCommand(
        "codesign",
        ["--verify", "--deep", "--strict", appPath || executable],
        { timeoutMs: 10_000, maximumBytes: 64 * 1024 },
      ),
    },
    {
      name: "gatekeeper",
      command: runCommand(
        "spctl",
        ["--assess", "--type", "execute", appPath || executable],
        { timeoutMs: 10_000, maximumBytes: 64 * 1024 },
      ),
    },
  ];
  const xattr = runCommand("xattr", [appPath || executable], {
    timeoutMs: 5_000,
    maximumBytes: 32 * 1024,
  });
  const signatureFailed = checks.some(({ command }) => command.code !== 0);
  return {
    signature: {
      status: signatureFailed ? "failed" : "collected",
      reason: signatureFailed ? "macos_signature_verification_failed" : null,
      checks: checks.map(({ name, command }) => ({
        name,
        command: commandSummary(command),
      })),
    },
    quarantine: {
      status: xattr.code === 0 ? "collected" : "failed",
      reason: xattr.code === 0 ? null : "macos_quarantine_query_failed",
      present:
        xattr.code === 0 &&
        /(?:^|\n)com\.apple\.quarantine(?:\n|$)/.test(xattr.stdout || ""),
      command: commandSummary(xattr),
    },
  };
}

function hashedMatches(text, pattern, domain) {
  return [
    ...new Set(
      [...String(text || "").matchAll(pattern)]
        .map((match) => match[1]?.trim())
        .filter(Boolean)
        .map((value) => hash(domain, value)),
    ),
  ].sort();
}

export function collectMacDnsRouteEvidence({
  runCommand = runBoundedCommand,
} = {}) {
  const dns = runCommand("scutil", ["--dns"], {
    timeoutMs: 10_000,
    maximumBytes: 512 * 1024,
  });
  const routes = runCommand("netstat", ["-rn", "-f", "inet"], {
    timeoutMs: 10_000,
    maximumBytes: 512 * 1024,
  });
  const dnsServerSha256s = hashedMatches(
    dns.stdout,
    /^\s*nameserver\[\d+\]\s*:\s*(\S+)\s*$/gimu,
    "aera-diagnostic-dns-server-v1",
  );
  const routeSha256s = hashedMatches(
    routes.stdout,
    /^default\s+(\S+)(?:\s+.*)?$/gimu,
    "aera-diagnostic-default-route-v1",
  );
  const failed = dns.code !== 0 || routes.code !== 0;
  return {
    status: failed ? "failed" : "collected",
    reason: failed ? "dns_route_query_failed" : null,
    dnsServerCount: dnsServerSha256s.length,
    dnsServerSha256s,
    defaultRouteCount: routeSha256s.length,
    defaultRouteSha256s: routeSha256s,
    commands: {
      dns: commandSummary(dns),
      routes: commandSummary(routes),
    },
  };
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

function parsePs(text) {
  const rows = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.{24})\s+(.*)$/);
    if (!match) continue;
    const date = new Date(match[3].trim());
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      startedAt: Number.isFinite(date.getTime()) ? date.toISOString() : null,
      command: match[4],
      executable: match[4].split(/\s+/)[0],
    });
  }
  return rows;
}

function collectOpenFiles(pid) {
  const result = runBoundedCommand(
    "lsof",
    ["-nP", "-a", "-p", String(pid), "-Fn"],
    {
      timeoutMs: 5000,
      maximumBytes: 512 * 1024,
    },
  );
  const paths = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line.startsWith("n")) continue;
    const path = line.slice(1);
    if (path.startsWith("/") && !paths.includes(path)) paths.push(path);
  }
  return {
    command: {
      code: result.code,
      timedOut: result.timedOut,
      stdoutBytes: result.stdoutBytes,
      stdoutTruncated: result.stdoutTruncated,
    },
    paths,
  };
}

function collectNetwork(pid) {
  const result = runBoundedCommand(
    "lsof",
    ["-nP", "-a", "-p", String(pid), "-i", "-FpcnT"],
    {
      timeoutMs: 5000,
      maximumBytes: 256 * 1024,
    },
  );
  return {
    command: {
      code: result.code,
      timedOut: result.timedOut,
      stdoutBytes: result.stdoutBytes,
      stdoutTruncated: result.stdoutTruncated,
    },
    rows: parseLsofNetwork(result.stdout),
  };
}

function walkNative(root, entries = []) {
  if (!existsSync(root) || entries.length >= 500) return entries;
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
      info = statSync(path);
    } catch {
      continue;
    }
    if (info.isDirectory()) walkNative(path, entries);
    else if (info.isFile() && path.endsWith(".node")) {
      const fileInfo = runBoundedCommand("file", [path], {
        timeoutMs: 5000,
        maximumBytes: 8192,
      });
      const native = inspectNativeFile(path);
      entries.push({
        pathSha256: hash("aera-diagnostic-native-path-v1", normalize(path)),
        ...native,
        size: info.size,
        architecture: /arm64|aarch64/i.test(fileInfo.stdout)
          ? "arm64"
          : /x86_64|amd64/i.test(fileInfo.stdout)
            ? "x64"
            : "unknown",
        fileCommand: {
          code: fileInfo.code,
          stdoutBytes: fileInfo.stdoutBytes,
          truncated: fileInfo.stdoutTruncated,
        },
      });
    }
  }
  return entries;
}

export function collectMacPlatformEvidence({
  rootPid,
  executable,
  appPath,
  runCommand = runBoundedCommand,
  includeStaticEvidence = true,
}) {
  const ps = runBoundedCommand("ps", ["-axo", "pid=,ppid=,lstart=,command="], {
    timeoutMs: 5000,
    maximumBytes: 2 * 1024 * 1024,
  });
  const rows = parsePs(ps.stdout);
  if (!rows.some((row) => row.pid === Number(rootPid))) {
    rows.push({
      pid: Number(rootPid),
      ppid: null,
      startedAt: null,
      command: executable,
      executable,
    });
  }
  const tree = buildProcessTree(rows, Number(rootPid));
  const openFileEvidence = [];
  const networkRows = [];
  const pids = tree.map((entry) => entry.pid).slice(0, 64);
  for (const pid of pids) {
    const files = collectOpenFiles(pid);
    for (const path of files.paths) {
      openFileEvidence.push({
        pid,
        pathSha256: hash("aera-diagnostic-open-file-path-v1", normalize(path)),
      });
    }
    const network = collectNetwork(pid);
    networkRows.push(...network.rows);
  }
  const uniqueNetwork = [
    ...new Map(
      networkRows.map((row) => [
        `${row.pid}:${row.endpoint}:${row.state}`,
        row,
      ]),
    ).values(),
  ];
  const nativeRoot = join(
    appPath || "",
    "Contents",
    "Resources",
    "app.asar.unpacked",
  );
  const nativeEntries = includeStaticEvidence ? walkNative(nativeRoot) : [];
  const security = includeStaticEvidence
    ? collectMacSecurityEvidence({ appPath, executable, runCommand })
    : {
        signature: {
          status: "missing",
          reason: "static_evidence_deferred",
        },
        quarantine: {
          status: "missing",
          reason: "static_evidence_deferred",
        },
      };
  const dnsRoutes = includeStaticEvidence
    ? collectMacDnsRouteEvidence({ runCommand })
    : { status: "missing", reason: "static_evidence_deferred" };
  return {
    platform: "darwin",
    process: {
      status: tree.length ? "collected" : "missing",
      reason: tree.length ? null : "process_tree_unavailable",
      rootPid: Number(rootPid),
      tree,
      command: {
        code: ps.code,
        timedOut: ps.timedOut,
        stdoutBytes: ps.stdoutBytes,
        stdoutTruncated: ps.stdoutTruncated,
      },
    },
    openFiles: {
      status: openFileEvidence.length ? "collected" : "missing",
      reason: openFileEvidence.length ? null : "open_files_unavailable",
      entries: openFileEvidence,
    },
    network: {
      status: uniqueNetwork.length ? "collected" : "missing",
      reason: uniqueNetwork.length ? null : "network_endpoints_unavailable",
      entries: uniqueNetwork,
    },
    nativeInventory: {
      status: nativeEntries.length ? "collected" : "missing",
      reason: nativeEntries.length
        ? null
        : "native_module_inventory_unavailable",
      entries: nativeEntries,
      electronModulesAbi: String(process.versions.modules || "unknown"),
    },
    signature: security.signature,
    quarantine: security.quarantine,
    dnsRoutes,
    events: {
      status: "missing",
      reason: "macos_platform_events_unavailable",
      entries: [],
    },
  };
}

export function collectMacOpenFilePaths(rootPid) {
  const result = collectOpenFiles(rootPid);
  return result.paths.map((path) => ({ pid: Number(rootPid), path }));
}
