import assert from "node:assert/strict";
import { test } from "node:test";

import {
  collectMacUnifiedLogEvidence,
  normalizeDiagnosticEvent,
  parseStableEvents,
  buildMacUnifiedLogRequest,
} from "./aera-diagnostic-events.mjs";

test("normalizes only allowlisted stable product events", () => {
  const event = normalizeDiagnosticEvent({
    at: "2026-08-17T01:02:03.000Z",
    source: "main",
    pid: 123,
    event: "model_configuration_unavailable",
    code: "native_module_abi_mismatch",
    diagnosticId: "0123456789ab",
    operationId: "fedcba987654",
    transitionId: "aabbccddeeff",
    message: "token=fixture-secret /Users/alice/private",
  });
  assert.deepEqual(event, {
    at: "2026-08-17T01:02:03.000Z",
    source: "main",
    pid: 123,
    event: "model_configuration_unavailable",
    code: "native_module_abi_mismatch",
    diagnosticId: "0123456789ab",
    operationId: "fedcba987654",
    transitionId: "aabbccddeeff",
  });
});

test("parses main, renderer, owner and updater events and reports absent families", () => {
  const result = parseStableEvents(
    [
      "[AGENTERA_MAIN] model_configuration_unavailable code=native_module_abi_mismatch diagnosticId=0123456789ab",
      "[AGENTERA_RENDERER] model_save_rejected code=route_catalog_repair_required diagnosticId=0123456789ac",
      "[AGENTERA_OWNER] transition_started transitionId=0123456789ad",
      "[AGENTERA_UPDATER] stage=download_completed diagnosticId=0123456789ae",
    ],
    {
      startedAt: "2026-08-17T01:00:00.000Z",
      endedAt: "2026-08-17T01:05:00.000Z",
    },
  );
  assert.equal(result.events.length, 4);
  assert.deepEqual(result.missingFamilies, ["preload", "runtime"]);
  assert.equal(result.events[0].code, "native_module_abi_mismatch");
  assert.equal(result.events[3].stage, "download_completed");
});

test("unified-log request never passes ISO-Z timestamps", () => {
  const request = buildMacUnifiedLogRequest({
    startedAt: "2026-08-17T01:00:00.000Z",
    endedAt: "2026-08-17T01:05:00.000Z",
    pids: [123],
    bundleId: "com.example.aera",
  });
  assert.equal(request.command, "log");
  const args = request.args.join(" ");
  assert.doesNotMatch(args, /2026-08-17T/);
  assert.match(args, /--start 2026-08-17 09:00:00|--start 2026-08-17 01:00:00/);
});

test("collects bounded PID and macOS policy unified-log queries", () => {
  const calls = [];
  const result = collectMacUnifiedLogEvidence({
    startedAt: "2026-08-17T01:00:00.000Z",
    endedAt: "2026-08-17T01:05:00.000Z",
    pids: [123, 456],
    bundleId: "com.example.aera",
    appPath: "/Applications/Aera.app",
    runCommand: (command, args, options) => {
      calls.push({ command, args, options });
      return {
        code: 0,
        timedOut: false,
        stdout: "log fixture\n",
        stderr: "",
        stdoutBytes: 12,
        stderrBytes: 0,
        stdoutTruncated: false,
        stderrTruncated: false,
      };
    },
  });

  assert.equal(result.status, "collected");
  assert.equal(result.reason, null);
  assert.equal(calls.length, 2);
  assert.equal(result.requests.length, 2);
  for (const call of calls) {
    const start = call.args[call.args.indexOf("--start") + 1];
    const end = call.args[call.args.indexOf("--end") + 1];
    assert.match(start, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    assert.match(end, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    assert.doesNotMatch(`${start} ${end}`, /T|Z/);
    assert.equal(call.options.timeoutMs, 10_000);
    assert.equal(call.options.maximumBytes, 1024 * 1024);
  }
  assert.match(result.text, /aera_processes/);
  assert.match(result.text, /macos_policy/);
});

test("marks unified-log evidence failed when one bounded query fails", () => {
  let callCount = 0;
  const result = collectMacUnifiedLogEvidence({
    startedAt: "2026-08-17T01:00:00.000Z",
    endedAt: "2026-08-17T01:05:00.000Z",
    pids: [123],
    bundleId: "com.example.aera",
    appPath: "/Applications/Aera.app",
    runCommand: () => {
      callCount += 1;
      return {
        code: callCount === 2 ? 64 : 0,
        timedOut: false,
        stdout: "",
        stderr: callCount === 2 ? "bad timestamp" : "",
        stdoutBytes: 0,
        stderrBytes: callCount === 2 ? 13 : 0,
        stdoutTruncated: false,
        stderrTruncated: false,
      };
    },
  });

  assert.equal(result.status, "failed");
  assert.equal(result.reason, "unified_log_query_failed");
  assert.equal(result.requests[1].command.code, 64);
});
