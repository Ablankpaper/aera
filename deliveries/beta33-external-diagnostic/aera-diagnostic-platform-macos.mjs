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

function collectOpenFiles(pid, runCommand = runBoundedCommand) {
  const result = runCommand(
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
      stderrBytes: result.stderrBytes,
      stdoutTruncated: result.stdoutTruncated,
      stderrTruncated: result.stderrTruncated,
    },
    paths,
  };
}

function collectNetwork(pid, runCommand = runBoundedCommand) {
  const result = runCommand(
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
      stderrBytes: result.stderrBytes,
      stdoutTruncated: result.stdoutTruncated,
      stderrTruncated: result.stderrTruncated,
    },
    rows: parseLsofNetwork(result.stdout),
  };
}

function collectExecutableIdentity(pid, fallbackPath, runCommand) {
  const result = runCommand(
    "lsof",
    ["-nP", "-a", "-p", String(pid), "-d", "txt", "-Fn"],
    { timeoutMs: 5000, maximumBytes: 64 * 1024 },
  );
  const paths = String(result.stdout || "")
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("n"))
    .map((line) => line.slice(1))
    .filter((path) => path.startsWith("/"));
  const candidates = [...new Set([...paths, fallbackPath].filter(Boolean))];
  for (const path of candidates) {
    try {
      const info = statSync(path);
      if (!info.isFile()) continue;
      return {
        sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
        pathSha256: hash(
          "aera-diagnostic-executable-path-v1",
          normalize(path),
        ),
        status: "collected",
        source: paths.includes(path) ? "lsof_txt_handle" : "verified_fallback",
        command: commandSummary(result),
      };
    } catch {
      // Continue to the next candidate while retaining command metadata.
    }
  }
  return {
    sha256: null,
    pathSha256: null,
    status: "unavailable",
    source: "lsof_txt_handle",
    command: commandSummary(result),
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
  const ps = runCommand("ps", ["-axo", "pid=,ppid=,lstart=,command="], {
    timeoutMs: 5000,
    maximumBytes: 2 * 1024 * 1024,
  });
  const rows = ps.code === 0 ? parsePs(ps.stdout) : [];
  const rootObserved = rows.some((row) => row.pid === Number(rootPid));
  const rawTree = rootObserved ? buildProcessTree(rows, Number(rootPid)) : [];
  const identityFailures = [];
  const tree = rawTree.map((entry) => {
    const sourceRow = rows.find((row) => Number(row.pid) === entry.pid);
    const identity = collectExecutableIdentity(
      entry.pid,
      entry.pid === Number(rootPid) ? executable : null,
      runCommand,
    );
    if (entry.role === "runtime" && identity.status !== "collected")
      identityFailures.push(entry.pid);
    return {
      ...entry,
      executablePathSha256:
        identity.pathSha256 || entry.executablePathSha256 || null,
      executableSha256: identity.sha256,
      executableIdentityStatus: identity.status,
      executableIdentitySource: identity.source,
      executableIdentityCommand: identity.command,
      commandSha256: sourceRow?.command
        ? hash("aera-diagnostic-command-v1", sourceRow.command)
        : entry.commandSha256,
    };
  });
  const openFileEvidence = [];
  const openFileCommands = [];
  const networkRows = [];
  const networkCommands = [];
  const pids = tree.map((entry) => entry.pid).slice(0, 64);
  for (const pid of pids) {
    const files = collectOpenFiles(pid, runCommand);
    openFileCommands.push({ pid, ...files.command });
    for (const path of files.paths) {
      openFileEvidence.push({
        pid,
        pathSha256: hash("aera-diagnostic-open-file-path-v1", normalize(path)),
      });
    }
    const network = collectNetwork(pid, runCommand);
    networkCommands.push({ pid, ...network.command });
    networkRows.push(...network.rows);
  }
  const openFileFailed = openFileCommands.some(
    (command) => command.code !== 0 || command.timedOut,
  );
  const openFileTimedOut = openFileCommands.some(
    (command) => command.timedOut,
  );
  const networkFailed = networkCommands.some(
    (command) => command.code !== 0 || command.timedOut,
  );
  const networkTimedOut = networkCommands.some(
    (command) => command.timedOut,
  );
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
      status:
        ps.code !== 0 || identityFailures.length > 0
          ? "failed"
          : tree.length
            ? "collected"
            : "missing",
      reason:
        ps.code !== 0
          ? ps.timedOut
            ? "process_query_timeout"
            : "process_query_failed"
          : identityFailures.length > 0
            ? "runtime_executable_identity_unavailable"
            : tree.length
              ? null
              : "root_process_unavailable",
      rootPid: Number(rootPid),
      tree,
      command: {
        code: ps.code,
        timedOut: ps.timedOut,
        stdoutBytes: ps.stdoutBytes,
        stderrBytes: ps.stderrBytes,
        stdoutTruncated: ps.stdoutTruncated,
        stderrTruncated: ps.stderrTruncated,
      },
    },
    openFiles: {
      status: openFileFailed
        ? "failed"
        : openFileEvidence.length
          ? "collected"
          : "missing",
      reason: openFileFailed
        ? openFileTimedOut
          ? "open_file_query_timeout"
          : "open_file_query_failed"
        : openFileEvidence.length
          ? null
          : "open_files_unavailable",
      entries: openFileEvidence,
      commands: openFileCommands,
    },
    network: {
      status: networkFailed
        ? "failed"
        : uniqueNetwork.length
          ? "collected"
          : "missing",
      reason: networkFailed
        ? networkTimedOut
          ? "network_query_timeout"
          : "network_query_failed"
        : uniqueNetwork.length
          ? null
          : "network_endpoints_unavailable",
      entries: uniqueNetwork,
      commands: networkCommands,
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
