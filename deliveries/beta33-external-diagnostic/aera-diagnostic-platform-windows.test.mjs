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
  assert.match(script, /2026-08-17T01:00:00\.000Z/);
  assert.match(script, /2026-08-17T01:05:00\.000Z/);
  assert.doesNotMatch(script, /Get-ChildItem Env:|ConvertTo-SecureString/);
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
  });
  assert.equal(result.processes[0].pid, 123);
  assert.match(result.processes[0].executablePathSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(result.network, [
    { pid: 123, endpoint: "47.100.169.193:443", state: "Established" },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /alice|fixture-secret|--token/);
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
