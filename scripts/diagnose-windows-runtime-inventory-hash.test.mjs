import test from "node:test";
import assert from "node:assert/strict";

import {
  buildInventoryHelperEnvironment,
  parseConcurrencyList,
  summarizeHashEvents,
} from "./diagnose-windows-runtime-inventory-hash.mjs";

test("parses a bounded, duplicate-free hash concurrency list", () => {
  assert.deepEqual(parseConcurrencyList("32, 8,4,1"), [32, 8, 4, 1]);
  assert.throws(() => parseConcurrencyList("32,0"), /positive integer/u);
  assert.throws(() => parseConcurrencyList("32,32"), /duplicate/u);
});

test("builds the credential-free helper environment with diagnostic controls", () => {
  assert.deepEqual(
    buildInventoryHelperEnvironment(
      {
        SystemRoot: "C:\\Windows",
        WINDIR: "C:\\Windows",
        TEMP: "C:\\Temp",
        TMP: "C:\\Temp",
        PATH: "C:\\Windows\\System32",
        OPENAI_API_KEY: "must-not-cross",
      },
      "C:\\evidence\\inventory.jsonl",
      8,
    ),
    {
      ELECTRON_RUN_AS_NODE: "1",
      AGENTERA_RUNTIME_INVENTORY_HELPER: "1",
      AGENTERA_RUNTIME_INVENTORY_DIAGNOSTIC_OUTPUT:
        "C:\\evidence\\inventory.jsonl",
      AERA_RUNTIME_INVENTORY_HASH_CONCURRENCY: "8",
      SystemRoot: "C:\\Windows",
      WINDIR: "C:\\Windows",
      TEMP: "C:\\Temp",
      TMP: "C:\\Temp",
    },
  );
});

test("identifies started files with no terminal lifecycle event", () => {
  assert.deepEqual(
    summarizeHashEvents([
      {
        event: "inventory-hash-file-start",
        fileIndex: 4,
        size: 11,
        relativePathSha256: "a".repeat(64),
        timestampMs: 100,
      },
      {
        event: "inventory-hash-file-complete",
        fileIndex: 3,
        size: 9,
        relativePathSha256: "b".repeat(64),
        durationMs: 5,
        timestampMs: 101,
      },
      {
        event: "inventory-hash-file-start",
        fileIndex: 3,
        size: 9,
        relativePathSha256: "b".repeat(64),
        timestampMs: 96,
      },
    ]),
    {
      eventCount: 3,
      startedCount: 2,
      completedCount: 1,
      errorCount: 0,
      pending: [
        {
          fileIndex: 4,
          size: 11,
          relativePathSha256: "a".repeat(64),
        },
      ],
      lastEvent: "inventory-hash-file-start",
    },
  );
});
