import assert from "node:assert/strict";
import { test } from "node:test";

import {
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
  assert.deepEqual(result.missingFamilies, ["preload"]);
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
