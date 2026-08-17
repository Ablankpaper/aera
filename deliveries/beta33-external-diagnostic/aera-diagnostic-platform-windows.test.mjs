import assert from "node:assert/strict";
import { test } from "node:test";

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
