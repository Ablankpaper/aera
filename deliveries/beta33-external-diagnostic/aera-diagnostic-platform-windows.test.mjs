/* eslint-disable @typescript-eslint/explicit-function-return-type */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  buildWindowsEvidenceScript,
  collectWindowsPlatformEvidence,
  normalizeWindowsPlatformEvidence,
} from "./aera-diagnostic-platform-windows.mjs";

test("Windows evidence script binds process ancestry and exact event window", () => {
  const script = buildWindowsEvidenceScript({
    rootPid: 123,
    executable: "C:\\Program Files\\Aera\\Aera.exe",
    startedAt: "2026-08-17T01:00:00.000Z",
    endedAt: "2026-08-17T01:05:00.000Z",
  });
  assert.match(script, /Get-CimInstance Win32_Process/);
  assert.match(script, /Get-NetTCPConnection/);
  assert.match(script, /Get-WinEvent/);
  assert.match(script, /Get-AuthenticodeSignature/);
  assert.match(script, /handle\.exe|openHandles/i);
  assert.match(script, /\[string\]\$signatureSource\.Status/);
  assert.doesNotMatch(script, /StatusMessage/);
  assert.match(script, /2026-08-17T01:00:00\.000Z/);
  assert.match(script, /2026-08-17T01:05:00\.000Z/);
  assert.doesNotMatch(script, /Get-ChildItem Env:|ConvertTo-SecureString/);
});

test("normalizes Runtime open handles and executable content identity", () => {
  const root = mkdtempSync(join(tmpdir(), "aera-windows-runtime-handle-test-"));
  try {
    const executable = join(root, "runtime.exe");
    const bytes = Buffer.from("windows runtime executable bytes", "utf8");
    writeFileSync(executable, bytes);
    const result = normalizeWindowsPlatformEvidence({
      processes: [
        {
          ProcessId: 321,
          ParentProcessId: 123,
          Name: "python.exe",
          ExecutablePath: executable,
          CreationDate: "2026-08-17T01:00:00.000Z",
        },
      ],
      openHandles: {
        status: "collected",
        entries: [{ ProcessId: 321, Path: "C:\\Users\\alice\\runtime.log" }],
        commands: [{ ProcessId: 321, Code: 0 }],
      },
    });
    assert.equal(result.processes[0].executableSha256, createHash("sha256").update(bytes).digest("hex"));
    assert.equal(result.processes[0].executableIdentityStatus, "collected");
    assert.equal(result.openFiles.status, "collected");
    assert.equal(result.openFiles.entries[0].pid, 321);
    assert.match(result.openFiles.entries[0].pathSha256, /^[0-9a-f]{64}$/);
    assert.doesNotMatch(JSON.stringify(result), /Users|runtime\.log/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("keeps unavailable Windows Runtime handles explicit", () => {
  const result = normalizeWindowsPlatformEvidence({
    processes: [{ ProcessId: 321, ParentProcessId: 123, Name: "python.exe" }],
    openHandles: { status: "unavailable", reason: "handle_tool_unavailable" },
  });
  assert.equal(result.openFiles.status, "missing");
  assert.equal(result.openFiles.reason, "handle_tool_unavailable");
  assert.deepEqual(result.openFiles.entries, []);
});

test("collects Windows Runtime handles as a bounded source with command status", () => {
  const root = mkdtempSync(join(tmpdir(), "aera-windows-collect-handles-test-"));
  try {
    const executable = join(root, "Aera.exe");
    writeFileSync(executable, "aera executable");
    const result = collectWindowsPlatformEvidence({
      rootPid: 123,
      executable,
      appPath: executable,
      startedAt: "2026-08-17T01:00:00.000Z",
      endedAt: "2026-08-17T01:05:00.000Z",
      runCommand: () => ({
        code: 0,
        stdout: JSON.stringify({
          processes: [
            {
              ProcessId: 123,
              ParentProcessId: 1,
              Name: "Aera.exe",
              ExecutablePath: executable,
            },
            {
              ProcessId: 321,
              ParentProcessId: 123,
              Name: "python.exe",
              ExecutablePath: executable,
            },
          ],
          connections: [],
          events: [],
          dns: [],
          routes: [],
          signature: { Status: "Valid" },
          quarantine: { present: false },
          openHandles: {
            status: "collected",
            entries: [{ ProcessId: 321, Path: "C:\\Runtime\\gateway.log" }],
            commands: [{ ProcessId: 321, Code: 0 }],
          },
        }),
        stderr: "",
        stdoutBytes: 0,
        stderrBytes: 0,
        stdoutTruncated: false,
        stderrTruncated: false,
        timedOut: false,
      }),
    });
    assert.equal(result.openFiles.status, "collected");
    assert.equal(result.openFiles.commands[0].code, 0);
    assert.deepEqual(result.runtimeOpenFiles, [
      { pid: 321, path: "C:\\Runtime\\gateway.log", processRole: "runtime" },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("normalizes Windows evidence without raw command lines or paths", () => {
  const result = normalizeWindowsPlatformEvidence({
    processes: [
      {
        ProcessId: 123,
        ParentProcessId: 1,
        Name: "Aera.exe",
        ExecutablePath: "C:\\Users\\alice\\Aera.exe",
        CommandLine: "Aera.exe --token secret",
      },
    ],
    connections: [
      {
        OwningProcess: 123,
        RemoteAddress: "47.100.169.193",
        RemotePort: 443,
        State: "Established",
      },
    ],
    events: [
      {
        TimeCreated: "2026-08-17T01:01:00.000Z",
        ProviderName: "Aera",
        Id: 1,
        LevelDisplayName: "Error",
        Message: "token=fixture-secret",
      },
    ],
    dns: [{ ServerAddresses: ["10.0.0.1"] }, { ServerAddresses: "8.8.8.8" }],
    routes: [{ NextHop: "10.0.0.1", DestinationPrefix: "0.0.0.0/0" }],
    quarantine: { present: true },
    signature: { Status: "Valid" },
  });
  assert.equal(result.processes[0].pid, 123);
  assert.match(result.processes[0].executablePathSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(result.network, [
    { pid: 123, endpoint: "47.100.169.193:443", state: "Established" },
  ]);
  assert.equal(result.signature.status, "collected");
  assert.equal(result.quarantine.status, "collected");
  assert.equal(result.dnsRoutes.status, "collected");
  assert.equal(result.dnsRoutes.dnsServerCount, 2);
  assert.equal(result.dnsRoutes.defaultRouteCount, 1);
  assert.doesNotMatch(JSON.stringify(result), /alice|fixture-secret|--token/);
});

test("extracts real Windows diagnostic event coverage without raw messages", () => {
  const result = normalizeWindowsPlatformEvidence({
    events: [
      {
        TimeCreated: "2026-08-17T01:01:00.000Z",
        ProviderName: "Aera",
        Id: 1,
        LevelDisplayName: "Error",
        Message:
          "[MODEL_CONFIGURATION] unavailable 0123456789ab model_configuration_database_unavailable CHAT user: my private conversation",
      },
      {
        TimeCreated: "2026-08-17T01:02:00.000Z",
        ProviderName: "Aera",
        Id: 2,
        LevelDisplayName: "Warning",
        Message:
          "[AGENTERA_RUNTIME_UPDATE] source=github stage=manifest code=transport_failed",
      },
    ],
  });
  assert.equal(result.diagnosticEventResult?.coverage.mainRendererIpc, true);
  assert.equal(result.diagnosticEventResult?.coverage.updater, true);
  assert.equal(
    result.diagnosticEventResult?.events.some(
      (event) =>
        event.diagnosticId === "0123456789ab" &&
        event.code === "model_configuration_database_unavailable",
    ),
    true,
  );
  assert.doesNotMatch(JSON.stringify(result), /my private conversation/);
});

test("classifies unavailable PowerShell as explicit failed platform evidence", () => {
  const result = collectWindowsPlatformEvidence({
    rootPid: 123,
    executable: "C:\\Program Files\\Aera\\Aera.exe",
    startedAt: "2026-08-17T01:00:00.000Z",
    endedAt: "2026-08-17T01:05:00.000Z",
    runCommand: () => ({ code: null, error: "ENOENT", stdout: "", stderr: "" }),
  });
  assert.equal(result.process.status, "failed");
  assert.equal(result.process.reason, "powershell_unavailable");
  assert.equal(result.network.status, "failed");
});

test("classifies invalid Windows evidence JSON as failed open-file evidence", () => {
  const result = collectWindowsPlatformEvidence({
    rootPid: 123,
    executable: "C:\\Program Files\\Aera\\Aera.exe",
    appPath: "C:\\Program Files\\Aera\\Aera.exe",
    startedAt: "2026-08-17T01:00:00.000Z",
    endedAt: "2026-08-17T01:05:00.000Z",
    runCommand: () => ({
      code: 0,
      stdout: "not-json",
      stderr: "bounded parser input",
      stdoutBytes: 8,
      stderrBytes: 20,
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
    }),
  });
  assert.equal(result.openFiles.status, "failed");
  assert.equal(result.openFiles.reason, "windows_evidence_invalid_json");
  assert.deepEqual(result.openFiles.entries, []);
  assert.deepEqual(result.openFiles.commands, []);
  assert.deepEqual(result.command, {
    code: 0,
    timedOut: false,
    stdoutBytes: 8,
    stderrBytes: 20,
    stdoutTruncated: false,
    stderrTruncated: false,
  });
});

function successfulPowerShellResult() {
  return {
    code: 0,
    stdout: JSON.stringify({
      processes: [
        {
          ProcessId: 123,
          ParentProcessId: 1,
          Name: "Aera.exe",
          CreationDate: "2026-08-17T01:00:00.000Z",
        },
      ],
      connections: [],
      events: [],
      signature: { Status: "Valid" },
      dns: [{ ServerAddresses: ["10.0.0.1"] }],
      routes: [{ NextHop: "10.0.0.1", DestinationPrefix: "0.0.0.0/0" }],
      quarantine: { present: false },
    }),
    stderr: "",
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
  };
}

test("collects Windows native module inventory from the installed app layout", () => {
  const root = mkdtempSync(join(tmpdir(), "aera-windows-native-inventory-"));
  try {
    const executable = join(root, "Aera.exe");
    const unpacked = join(root, "resources", "app.asar.unpacked", "native");
    mkdirSync(unpacked, { recursive: true });
    const bytes = Buffer.from(
      "native module fixture node_register_module_v137\n",
      "utf8",
    );
    const nativePath = join(unpacked, "fixture.node");
    writeFileSync(executable, "fixture executable");
    writeFileSync(nativePath, bytes);

    const result = collectWindowsPlatformEvidence({
      rootPid: 123,
      executable,
      appPath: executable,
      startedAt: "2026-08-17T01:00:00.000Z",
      endedAt: "2026-08-17T01:05:00.000Z",
      runCommand: () => successfulPowerShellResult(),
    });

    assert.equal(result.nativeInventory.status, "collected");
    const entry = result.nativeInventory.entries.find(
      (candidate) => candidate.abi === "137",
    );
    assert.ok(entry);
    assert.equal(entry.abiStatus, "collected");
    assert.equal(
      entry.sha256,
      createHash("sha256").update(bytes).digest("hex"),
    );
    assert.match(entry.pathSha256, /^[0-9a-f]{64}$/);
    assert.doesNotMatch(
      JSON.stringify(result.nativeInventory),
      /fixture\.node|aera-windows-native-inventory/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("marks Windows native inventory missing when the installed layout is unavailable", () => {
  const root = mkdtempSync(join(tmpdir(), "aera-windows-native-missing-"));
  try {
    const executable = join(root, "Aera.exe");
    writeFileSync(executable, "fixture executable");
    const result = collectWindowsPlatformEvidence({
      rootPid: 123,
      executable,
      appPath: executable,
      startedAt: "2026-08-17T01:00:00.000Z",
      endedAt: "2026-08-17T01:05:00.000Z",
      runCommand: () => successfulPowerShellResult(),
    });

    assert.equal(result.nativeInventory.status, "missing");
    assert.equal(
      result.nativeInventory.reason,
      "native_module_inventory_unavailable",
    );
    assert.deepEqual(result.nativeInventory.entries, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
