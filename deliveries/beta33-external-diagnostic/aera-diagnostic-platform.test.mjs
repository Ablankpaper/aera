import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  buildProcessTree,
  classifyProcessRole,
  collectMacPlatformEvidence,
  collectMacSecurityEvidence,
  collectMacDnsRouteEvidence,
  discoverRuntimeLogEvidence,
  parseLsofNetwork,
} from "./aera-diagnostic-platform.mjs";

test("builds the verified Aera descendant tree with stable roles", () => {
  const rows = [
    {
      pid: 100,
      ppid: 1,
      command: "/Applications/Aera.app/Contents/MacOS/Aera",
      startedAt: "2026-08-17T01:00:00.000Z",
    },
    {
      pid: 101,
      ppid: 100,
      command: "Aera Helper (Renderer) --type=renderer",
      startedAt: "2026-08-17T01:00:01.000Z",
    },
    {
      pid: 102,
      ppid: 100,
      command: "Aera Helper (GPU) --type=gpu-process",
      startedAt: "2026-08-17T01:00:01.000Z",
    },
    {
      pid: 103,
      ppid: 100,
      command: "python -m hermes_cli.main serve --no-open",
      startedAt: "2026-08-17T01:00:02.000Z",
    },
    {
      pid: 104,
      ppid: 103,
      command: "python -m hermes_cli.main gateway",
      startedAt: "2026-08-17T01:00:03.000Z",
    },
    {
      pid: 999,
      ppid: 1,
      command: "unrelated",
      startedAt: "2026-08-17T01:00:00.000Z",
    },
  ];
  const tree = buildProcessTree(rows, 100);
  assert.deepEqual(
    tree.map((entry) => entry.pid),
    [100, 101, 102, 103, 104],
  );
  assert.deepEqual(
    tree.map((entry) => entry.role),
    ["main", "renderer", "gpu", "runtime", "runtime"],
  );
  assert.equal(classifyProcessRole("Aera Helper --type=utility"), "utility");
});

test("binds each process identity to executable content SHA-256", () => {
  const root = mkdtempSync(join(tmpdir(), "aera-process-identity-test-"));
  try {
    const executable = join(root, "runtime.bin");
    const bytes = Buffer.from("runtime executable bytes", "utf8");
    writeFileSync(executable, bytes);
    const tree = buildProcessTree(
      [
        {
          pid: 103,
          ppid: 100,
          command: "python -m hermes_cli.main gateway",
          executable,
          startedAt: "2026-08-17T01:00:00.000Z",
        },
        {
          pid: 100,
          ppid: 1,
          command: "/Applications/Aera.app/Contents/MacOS/Aera",
          startedAt: "2026-08-17T01:00:00.000Z",
        },
      ],
      100,
    );
    const runtime = tree.find((entry) => entry.pid === 103);
    assert.equal(
      runtime.executableSha256,
      createHash("sha256").update(bytes).digest("hex"),
    );
    assert.equal(runtime.executableIdentityStatus, "collected");
    assert.notEqual(runtime.executableSha256, runtime.executablePathSha256);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("discovers current Runtime logs from open files before known Profile paths", () => {
  const root = mkdtempSync(join(tmpdir(), "aera-runtime-log-test-"));
  try {
    const hermesHome = join(root, "hermes");
    const profileRoot = join(hermesHome, "profiles", "fault-profile");
    const logsRoot = join(profileRoot, "logs");
    mkdirSync(logsRoot, { recursive: true });
    writeFileSync(join(hermesHome, "active_profile"), "fault-profile\n");
    const openLog = join(logsRoot, "runtime-live.log");
    const knownLog = join(profileRoot, "gateway-stderr.log");
    const staleLog = join(hermesHome, "logs", "agent.log");
    mkdirSync(join(hermesHome, "logs"), { recursive: true });
    writeFileSync(openLog, "live runtime marker\n");
    writeFileSync(knownLog, "gateway marker\n");
    writeFileSync(staleLog, "stale marker\n");
    const now = new Date("2026-08-17T01:02:00.000Z");
    utimesSync(openLog, now, now);
    utimesSync(knownLog, now, now);
    const stale = new Date("2026-08-10T01:00:00.000Z");
    utimesSync(staleLog, stale, stale);

    const evidence = discoverRuntimeLogEvidence({
      hermesHome,
      userDataPaths: [],
      openFiles: [{ pid: 103, path: openLog, processRole: "runtime" }],
      startedAt: "2026-08-17T01:00:00.000Z",
      endedAt: "2026-08-17T01:05:00.000Z",
    });
    assert.equal(evidence.status, "collected");
    assert.equal(evidence.logs[0].source, "observed_open_file");
    assert.equal(evidence.logs[0].pid, 103);
    assert.equal(evidence.logs[0].processRole, "runtime");
    assert.equal(evidence.pidCorrelatedCount, 1);
    assert.equal(
      evidence.logs.some((entry) => entry.source === "active_profile"),
      true,
    );
    assert.equal(
      evidence.stale.some((entry) => entry.source === "global_runtime"),
      true,
    );
    assert.equal(
      evidence.logs.every((entry) => /^[0-9a-f]{64}$/.test(entry.pathSha256)),
      true,
    );
    assert.doesNotMatch(
      JSON.stringify(evidence),
      new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("crops Runtime log lines to the session window instead of mtime or tail", () => {
  const root = mkdtempSync(join(tmpdir(), "aera-runtime-log-window-test-"));
  try {
    const logPath = join(root, "runtime.log");
    writeFileSync(
      logPath,
      [
        "2026-08-16T23:59:59.000Z before-session CHAT user: private-before",
        "2026-08-17T01:01:00.000Z CHAT user: my private conversation",
        "2026-08-17T01:02:00.000Z [AGENTERA_RUNTIME] runtime_started pid=103 diagnosticId=0123456789ab",
        "2026-08-17T01:03:00.000Z after-session CHAT user: private-after",
      ].join("\n"),
    );
    const outsideWindow = new Date("2026-08-16T23:00:00.000Z");
    utimesSync(logPath, outsideWindow, outsideWindow);

    const evidence = discoverRuntimeLogEvidence({
      hermesHome: join(root, "home"),
      userDataPaths: [],
      openFiles: [{ pid: 103, path: logPath, processRole: "runtime" }],
      startedAt: "2026-08-17T01:00:00.000Z",
      endedAt: "2026-08-17T01:02:30.000Z",
    });

    assert.equal(evidence.status, "collected");
    assert.match(evidence.text, /runtime_started/);
    assert.doesNotMatch(
      evidence.text,
      /before-session|after-session|private-before|private-after|my private conversation/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("does not mark a current known Runtime log collected without PID correlation", () => {
  const root = mkdtempSync(join(tmpdir(), "aera-runtime-unbound-log-test-"));
  try {
    const hermesHome = join(root, "hermes");
    const profileRoot = join(hermesHome, "profiles", "fault-profile");
    mkdirSync(profileRoot, { recursive: true });
    writeFileSync(join(hermesHome, "active_profile"), "fault-profile\n");
    const knownLog = join(profileRoot, "gateway-stderr.log");
    writeFileSync(knownLog, "current but unbound runtime marker\n");
    const now = new Date("2026-08-17T01:02:00.000Z");
    utimesSync(knownLog, now, now);

    const evidence = discoverRuntimeLogEvidence({
      hermesHome,
      userDataPaths: [],
      openFiles: [],
      startedAt: "2026-08-17T01:00:00.000Z",
      endedAt: "2026-08-17T01:05:00.000Z",
    });

    assert.equal(evidence.status, "missing");
    assert.equal(evidence.reason, "current_runtime_log_unavailable");
    assert.equal(evidence.pidCorrelatedCount, 0);
    assert.equal(evidence.logs[0].source, "active_profile");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("keeps process-owned log files at opaque Runtime paths", () => {
  const root = mkdtempSync(join(tmpdir(), "zq-"));
  try {
    const openLog = join(root, "session-output.txt");
    writeFileSync(openLog, "opaque runtime marker\n");
    const now = new Date("2026-08-17T01:02:00.000Z");
    utimesSync(openLog, now, now);
    const evidence = discoverRuntimeLogEvidence({
      hermesHome: join(root, "home"),
      userDataPaths: [],
      openFiles: [{ pid: 103, path: openLog, processRole: "runtime" }],
      startedAt: "2026-08-17T01:00:00.000Z",
      endedAt: "2026-08-17T01:05:00.000Z",
    });
    assert.equal(evidence.status, "collected");
    assert.deepEqual(
      evidence.logs.map((entry) => entry.source),
      ["observed_open_file"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("keeps Runtime ownership when Main and Runtime share one log path", () => {
  const root = mkdtempSync(join(tmpdir(), "aera-runtime-shared-log-test-"));
  try {
    const openLog = join(root, "shared.log");
    writeFileSync(openLog, "shared runtime marker\n");
    const now = new Date("2026-08-17T01:02:00.000Z");
    utimesSync(openLog, now, now);
    const evidence = discoverRuntimeLogEvidence({
      hermesHome: join(root, "home"),
      userDataPaths: [],
      openFiles: [
        { pid: 100, path: openLog, processRole: "main" },
        { pid: 103, path: openLog, processRole: "runtime" },
      ],
      startedAt: "2026-08-17T01:00:00.000Z",
      endedAt: "2026-08-17T01:05:00.000Z",
    });
    assert.equal(evidence.status, "collected");
    assert.equal(evidence.pidCorrelatedCount, 1);
    assert.equal(evidence.pidCorrelatedLogs[0].pid, 103);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("marks macOS process evidence failed when ps cannot be queried", () => {
  const result = collectMacPlatformEvidence({
    rootPid: 123,
    executable: "/Applications/Aera.app/Contents/MacOS/Aera",
    appPath: "/Applications/Aera.app",
    includeStaticEvidence: false,
    runCommand(command) {
      assert.equal(command, "ps");
      return {
        code: 1,
        timedOut: false,
        stdout: "",
        stderr: "ps denied",
        stdoutBytes: 0,
        stderrBytes: 9,
        stdoutTruncated: false,
        stderrTruncated: false,
      };
    },
  });
  assert.equal(result.process.status, "failed");
  assert.equal(result.process.reason, "process_query_failed");
  assert.deepEqual(result.process.tree, []);
  assert.equal(result.process.command.code, 1);
});

test("uses the macOS Runtime text handle for executable content identity", () => {
  const root = mkdtempSync(join(tmpdir(), "aera-mac-runtime-identity-test-"));
  try {
    const mainExecutable = join(root, "Aera");
    const runtimeExecutable = join(root, "python-runtime");
    const runtimeBytes = Buffer.from("actual Runtime binary", "utf8");
    writeFileSync(mainExecutable, "main executable");
    writeFileSync(runtimeExecutable, runtimeBytes);
    const result = collectMacPlatformEvidence({
      rootPid: 123,
      executable: mainExecutable,
      appPath: root,
      includeStaticEvidence: false,
      runCommand(command, args) {
        if (command === "ps") {
          return {
            code: 0,
            timedOut: false,
            stdout: [
              `123 1 Sun Aug 17 09:00:00 2026 ${mainExecutable}`,
              "321 123 Sun Aug 17 09:00:01 2026 python -m hermes_cli.main gateway",
            ].join("\n"),
            stderr: "",
            stdoutBytes: 128,
            stderrBytes: 0,
            stdoutTruncated: false,
            stderrTruncated: false,
          };
        }
        if (command === "lsof" && args.includes("txt")) {
          const pid = Number(args[args.indexOf("-p") + 1]);
          return {
            code: 0,
            timedOut: false,
            stdout: `p${pid}\nftxt\nn${pid === 321 ? runtimeExecutable : mainExecutable}\n`,
            stderr: "",
            stdoutBytes: 64,
            stderrBytes: 0,
            stdoutTruncated: false,
            stderrTruncated: false,
          };
        }
        return {
          code: 0,
          timedOut: false,
          stdout: "",
          stderr: "",
          stdoutBytes: 0,
          stderrBytes: 0,
          stdoutTruncated: false,
          stderrTruncated: false,
        };
      },
    });
    const runtime = result.process.tree.find((entry) => entry.pid === 321);
    assert.equal(runtime.role, "runtime");
    assert.equal(runtime.executableIdentitySource, "lsof_txt_handle");
    assert.equal(
      runtime.executableSha256,
      createHash("sha256").update(runtimeBytes).digest("hex"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("records macOS lsof exit, timeout and truncation failures", () => {
  const root = mkdtempSync(join(tmpdir(), "aera-mac-lsof-failure-test-"));
  try {
    const executable = join(root, "Aera");
    writeFileSync(executable, "main executable");
    const result = collectMacPlatformEvidence({
      rootPid: 123,
      executable,
      appPath: root,
      includeStaticEvidence: false,
      runCommand(command, args) {
        if (command === "ps")
          return {
            code: 0,
            timedOut: false,
            stdout: `123 1 Sun Aug 17 09:00:00 2026 ${executable}\n`,
            stderr: "",
            stdoutBytes: 64,
            stderrBytes: 0,
            stdoutTruncated: false,
            stderrTruncated: false,
          };
        if (command === "lsof" && args.includes("txt"))
          return {
            code: 0,
            timedOut: false,
            stdout: `p123\nftxt\nn${executable}\n`,
            stderr: "",
            stdoutBytes: 32,
            stderrBytes: 0,
            stdoutTruncated: false,
            stderrTruncated: false,
          };
        return {
          code: 9,
          timedOut: true,
          stdout: args.includes("-i")
            ? "p123\nn127.0.0.1:50000->203.0.113.1:443\nTST=ESTABLISHED\n"
            : `p123\nn${join(root, "partial-runtime.log")}\n`,
          stderr: "bounded failure",
          stdoutBytes: 300,
          stderrBytes: 400,
          stdoutTruncated: true,
          stderrTruncated: true,
        };
      },
    });
    assert.equal(result.openFiles.status, "failed");
    assert.equal(result.openFiles.reason, "open_file_query_timeout");
    assert.equal(result.openFiles.entries.length, 1);
    assert.equal(result.openFiles.entries[0].pid, 123);
    assert.deepEqual(result.openFiles.commands[0], {
      pid: 123,
      code: 9,
      timedOut: true,
      stdoutBytes: 300,
      stderrBytes: 400,
      stdoutTruncated: true,
      stderrTruncated: true,
    });
    assert.equal(result.network.status, "failed");
    assert.equal(result.network.reason, "network_query_timeout");
    assert.deepEqual(result.network.entries, [
      { pid: 123, endpoint: "203.0.113.1:443", state: "ESTABLISHED" },
    ]);
    assert.equal(result.network.commands[0].code, 9);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prefers a timeout reason when a later macOS lsof query times out", () => {
  const root = mkdtempSync(join(tmpdir(), "aera-mac-lsof-timeout-test-"));
  try {
    const executable = join(root, "Aera");
    writeFileSync(executable, "main executable");
    const result = collectMacPlatformEvidence({
      rootPid: 123,
      executable,
      appPath: root,
      includeStaticEvidence: false,
      runCommand(command, args) {
        if (command === "ps")
          return {
            code: 0,
            timedOut: false,
            stdout: [
              `123 1 Sun Aug 17 09:00:00 2026 ${executable}`,
              "456 123 Sun Aug 17 09:00:01 2026 Aera Helper (Renderer) --type=renderer",
            ].join("\n"),
            stderr: "",
            stdoutBytes: 128,
            stderrBytes: 0,
            stdoutTruncated: false,
            stderrTruncated: false,
          };
        if (command === "lsof" && args.includes("txt"))
          return {
            code: 0,
            timedOut: false,
            stdout: `p${args[args.indexOf("-p") + 1]}\nftxt\nn${executable}\n`,
            stderr: "",
            stdoutBytes: 64,
            stderrBytes: 0,
            stdoutTruncated: false,
            stderrTruncated: false,
          };
        const pid = Number(args[args.indexOf("-p") + 1]);
        return {
          code: 9,
          timedOut: pid === 456,
          stdout: "",
          stderr: "bounded failure",
          stdoutBytes: 0,
          stderrBytes: 15,
          stdoutTruncated: false,
          stderrTruncated: false,
        };
      },
    });
    assert.equal(result.openFiles.commands.length, 2);
    assert.equal(result.openFiles.reason, "open_file_query_timeout");
    assert.equal(result.network.commands.length, 2);
    assert.equal(result.network.reason, "network_query_timeout");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("parses only process-owned TCP endpoints without payload", () => {
  const rows = parseLsofNetwork(
    [
      "p100",
      "n127.0.0.1:50000->47.100.169.193:443",
      "TST=ESTABLISHED",
      "p101",
      "n[::1]:51000->[::1]:18080",
      "TST=LISTEN",
    ].join("\n"),
  );
  assert.deepEqual(rows, [
    { pid: 100, endpoint: "47.100.169.193:443", state: "ESTABLISHED" },
    { pid: 101, endpoint: "[::1]:18080", state: "LISTEN" },
  ]);
});

test(
  "collects bounded macOS process, network and native inventory sections",
  { skip: process.platform !== "darwin" },
  () => {
    const result = collectMacPlatformEvidence({
      rootPid: process.pid,
      executable: process.execPath,
      appPath: "/Applications/Aera.app",
      startedAt: new Date(Date.now() - 1000).toISOString(),
      endedAt: new Date().toISOString(),
    });
    assert.equal(result.platform, "darwin");
    assert.equal(result.process.status, "collected");
    assert.ok(result.process.tree.some((entry) => entry.pid === process.pid));
    assert.ok(
      ["collected", "missing", "failed"].includes(result.network.status),
    );
    assert.equal(Array.isArray(result.nativeInventory.entries), true);
    assert.equal(typeof result.nativeInventory.electronModulesAbi, "string");
    assert.doesNotMatch(JSON.stringify(result), /Applications\/Aera\.app/);
  },
);

test("records the SHA-256 of native module bytes, not path or metadata", () => {
  const root = mkdtempSync(join(tmpdir(), "aera-native-inventory-test-"));
  try {
    const appPath = join(root, "Aera.app");
    const unpacked = join(
      appPath,
      "Contents",
      "Resources",
      "app.asar.unpacked",
      "native",
    );
    mkdirSync(unpacked, { recursive: true });
    const bytes = Buffer.from(
      "native module fixture node_register_module_v137\n",
      "utf8",
    );
    writeFileSync(join(unpacked, "fixture.node"), bytes);

    const result = collectMacPlatformEvidence({
      rootPid: process.pid,
      executable: process.execPath,
      appPath,
    });
    const entry = result.nativeInventory.entries.find(
      (candidate) => candidate.size === bytes.length,
    );
    assert.ok(entry);
    assert.equal(
      entry.sha256,
      createHash("sha256").update(bytes).digest("hex"),
    );
    assert.equal(entry.abi, "137");
    assert.equal(entry.abiStatus, "collected");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("collects bounded macOS signature, quarantine, DNS and route evidence", () => {
  const calls = [];
  const result = collectMacSecurityEvidence({
    appPath: "/Applications/Aera.app",
    executable: "/Applications/Aera.app/Contents/MacOS/Aera",
    runCommand(command, args, options) {
      calls.push({ command, args, options });
      if (command === "xattr")
        return {
          code: 0,
          stdout: "com.apple.quarantine\n",
          stderr: "",
          stdoutBytes: 23,
          stderrBytes: 0,
          stdoutTruncated: false,
          stderrTruncated: false,
          timedOut: false,
        };
      return {
        code: 0,
        stdout: "valid\n",
        stderr: "",
        stdoutBytes: 6,
        stderrBytes: 0,
        stdoutTruncated: false,
        stderrTruncated: false,
        timedOut: false,
      };
    },
  });
  assert.equal(result.signature.status, "collected");
  assert.equal(result.quarantine.status, "collected");
  assert.equal(result.quarantine.present, true);
  assert.equal(calls.length, 3);
  assert.ok(calls.every((call) => call.options.maximumBytes <= 64 * 1024));

  const network = collectMacDnsRouteEvidence({
    runCommand(command) {
      assert.ok(["scutil", "netstat"].includes(command));
      return {
        code: 0,
        stdout:
          command === "scutil"
            ? "nameserver[0] : 10.0.0.1\n"
            : "default 10.0.0.1 en0\n",
        stderr: "",
        stdoutBytes: 30,
        stderrBytes: 0,
        stdoutTruncated: false,
        stderrTruncated: false,
        timedOut: false,
      };
    },
  });
  assert.equal(network.status, "collected");
  assert.equal(network.dnsServerCount, 1);
  assert.equal(network.defaultRouteCount, 1);
  assert.doesNotMatch(JSON.stringify(network), /10\.0\.0\.1/);
});
