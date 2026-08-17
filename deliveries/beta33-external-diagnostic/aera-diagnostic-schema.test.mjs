import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  canonicalDiagnosticJson,
  parseDiagnosticTargetV1,
  REQUIRED_DIAGNOSTIC_SECTIONS,
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

test("publishes parseable JSON schemas", () => {
  for (const name of [
    "aera-diagnostic-bundle-v4.schema.json",
    "aera-diagnostic-target-v1.schema.json",
  ]) {
    const path = new URL(name, import.meta.url);
    assert.doesNotThrow(() => JSON.parse(readFileSync(path, "utf8")));
  }
});

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
  const sections = REQUIRED_DIAGNOSTIC_SECTIONS.map((name) => ({
    name,
    status: name === "runtime_logs" ? "missing" : "collected",
    reason: name === "runtime_logs" ? "current_runtime_log_unavailable" : null,
  }));
  const bundle = {
    schemaVersion: 4,
    collectorVersion: "4.0.0",
    captureId: "0123456789abcdef0123456789abcdef",
    target,
    startedAt: "2026-08-17T01:00:00.000Z",
    endedAt: "2026-08-17T01:05:00.000Z",
    sections,
    missingEvidence: ["runtime_logs"],
    files: [{ name: "manifest.json", size: 10, sha256: hash }],
    redaction: {
      schemaVersion: 1,
      finalScan: "passed",
      replacements: 0,
      dropped: 0,
      truncated: 0,
    },
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
        sections: sections.filter((entry) => entry.name !== "cloud_origin"),
      }),
    /required section.*cloud_origin/i,
  );
  assert.throws(
    () =>
      validateDiagnosticBundleV4({
        ...bundle,
        sections: [
          ...sections,
          { name: "unexpected", status: "collected", reason: null },
        ],
      }),
    /unknown section.*unexpected/i,
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
        redaction: {
          schemaVersion: 1,
          finalScan: "passed",
          replacements: 0,
          dropped: 0,
          truncated: 0,
        },
        notes: "secret",
      }),
    /unknown|notes/i,
  );
});
