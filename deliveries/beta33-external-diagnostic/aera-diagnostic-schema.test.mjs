import assert from "node:assert/strict";
import { test } from "node:test";

import {
  canonicalDiagnosticJson,
  parseDiagnosticTargetV1,
  validateDiagnosticBundleV4,
} from "./aera-diagnostic-schema.mjs";

const hash = "a".repeat(64);
const target = {
  schemaVersion: 1,
  platform: "darwin",
  version: "0.7.4-internal-beta.32",
  bundleId: "com.example.aera",
  architecture: "arm64",
  executableSha256: hash,
  packageSha256: "b".repeat(64),
  sourceSha: "c".repeat(40),
  candidateManifestSha256: "d".repeat(64),
};

test("accepts a closed target descriptor and rejects unsafe values", () => {
  assert.deepEqual(parseDiagnosticTargetV1(target), target);
  assert.throws(
    () => parseDiagnosticTargetV1({ ...target, unknown: true }),
    /unknown/i,
  );
  assert.throws(
    () => parseDiagnosticTargetV1({ ...target, executableSha256: "bad" }),
    /sha/i,
  );
  assert.throws(
    () => parseDiagnosticTargetV1({ ...target, version: "" }),
    /version/i,
  );
});

test("validates a V4 bundle with explicit missing evidence", () => {
  const bundle = {
    schemaVersion: 4,
    collectorVersion: "4.0.0",
    captureId: "0123456789abcdef0123456789abcdef",
    target,
    startedAt: "2026-08-17T01:00:00.000Z",
    endedAt: "2026-08-17T01:05:00.000Z",
    sections: [
      {
        name: "runtime_logs",
        status: "missing",
        reason: "current_runtime_log_unavailable",
      },
      { name: "journal", status: "collected", reason: null },
    ],
    missingEvidence: ["runtime_logs"],
    files: [{ name: "manifest.json", size: 10, sha256: hash }],
  };
  assert.deepEqual(validateDiagnosticBundleV4(bundle), bundle);
  assert.throws(
    () => validateDiagnosticBundleV4({ ...bundle, missingEvidence: [] }),
    /missingEvidence/,
  );
  assert.throws(
    () =>
      validateDiagnosticBundleV4({
        ...bundle,
        files: [{ ...bundle.files[0], name: "../x" }],
      }),
    /filename/i,
  );
});

test("canonical JSON is deterministic and has no free-form notes", () => {
  const value = { b: 1, a: { z: true, y: "x" } };
  assert.equal(
    canonicalDiagnosticJson(value),
    '{"a":{"y":"x","z":true},"b":1}',
  );
  assert.throws(
    () =>
      validateDiagnosticBundleV4({
        schemaVersion: 4,
        collectorVersion: "4.0.0",
        captureId: "0123456789abcdef0123456789abcdef",
        target,
        startedAt: "2026-08-17T01:00:00.000Z",
        endedAt: "2026-08-17T01:05:00.000Z",
        sections: [],
        missingEvidence: [],
        files: [],
        notes: "secret",
      }),
    /unknown|notes/i,
  );
});
