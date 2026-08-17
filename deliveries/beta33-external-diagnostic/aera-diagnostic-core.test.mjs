import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildMacLogQueries,
  collectSection,
  formatMacLogTimestamp,
  runBoundedCommand,
  safeRelativeName,
} from "./aera-diagnostic-core.mjs";

test("formats unified-log bounds as local macOS timestamps without ISO Z", () => {
  const value = formatMacLogTimestamp("2026-08-17T01:02:03.456Z");
  assert.match(value, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.doesNotMatch(value, /T|Z/);
});

test("builds exact-window PID and policy queries", () => {
  const queries = buildMacLogQueries({
    startedAt: "2026-08-17T01:02:03.456Z",
    endedAt: "2026-08-17T01:03:04.456Z",
    pids: [12, 12, 34],
    bundleId: "com.example.aera",
    appPath: "/Applications/Aera.app",
  });
  assert.equal(queries.length, 2);
  for (const query of queries) {
    assert.equal(query.command, "log");
    const start = query.args[query.args.indexOf("--start") + 1];
    const end = query.args[query.args.indexOf("--end") + 1];
    assert.match(start, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    assert.match(end, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  }
  assert.match(queries[0].args.at(-1), /processID == 12/);
  assert.match(queries[0].args.at(-1), /processID == 34/);
});

test("bounds command output and terminates a noisy child", () => {
  const result = runBoundedCommand(
    process.execPath,
    [
      "-e",
      "process.stdout.write('x'.repeat(200000)); process.stderr.write('y'.repeat(200000));",
    ],
    { maximumBytes: 4096, timeoutMs: 5000 },
  );
  assert.equal(result.code, 0);
  assert.equal(result.stdoutBytes, 200000);
  assert.equal(result.stderrBytes, 200000);
  assert.equal(result.stdoutTruncated, true);
  assert.equal(result.stderrTruncated, true);
  assert.ok(result.stdout.length <= 4096);
});

test("collectSection records safe missing and failed states", async () => {
  assert.deepEqual(await collectSection("runtime", async () => null), {
    name: "runtime",
    status: "missing",
    reason: "evidence_unavailable",
    value: null,
  });
  const failed = await collectSection("db", async () => {
    throw new Error("ENOENT user secret path");
  });
  assert.equal(failed.name, "db");
  assert.equal(failed.status, "failed");
  assert.equal(typeof failed.reason, "string");
  assert.equal(failed.value, null);
  assert.doesNotMatch(JSON.stringify(failed), /secret path/);
});

test("safeRelativeName rejects traversal and absolute output names", () => {
  assert.equal(safeRelativeName("logs/runtime.txt"), "logs/runtime.txt");
  assert.throws(() => safeRelativeName("../secrets.txt"), /unsafe/i);
  assert.throws(() => safeRelativeName("/tmp/secrets.txt"), /unsafe/i);
});
