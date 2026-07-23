import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  canonicalOperatorRecord,
  renderOperatorRecord,
  validateOperatorRecord,
} from "./render-operator-record.mjs";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);
const SHA_D = "d".repeat(40);
const DIGEST_A = `ghcr.io/bignormal/aera-cloud@sha256:${"1".repeat(64)}`;
const DIGEST_B = `ghcr.io/bignormal/aera-admin@sha256:${"2".repeat(64)}`;
const HASH_A = "3".repeat(64);

function validRecord() {
  return {
    schemaVersion: 1,
    status: "candidate_ready",
    updatedAt: "2026-07-24T08:00:00.000Z",
    repositories: [
      {
        role: "desktop",
        sha: SHA_A,
        status: "ci_passed",
        verifiedAt: "2026-07-24T07:00:00.000Z",
        runUrl: "https://github.com/bignormal/aera/actions/runs/30012531355",
      },
      {
        role: "cloud",
        sha: SHA_B,
        status: "ci_passed",
        verifiedAt: "2026-07-24T07:05:00.000Z",
        runUrl:
          "https://github.com/bignormal/aera-cloud/actions/runs/30006310907",
      },
      {
        role: "admin",
        sha: SHA_C,
        status: "ci_passed",
        verifiedAt: "2026-07-24T07:10:00.000Z",
        runUrl:
          "https://github.com/bignormal/aera-admin/actions/runs/30010245066",
      },
      {
        role: "runtime",
        sha: SHA_D,
        status: "locked",
        verifiedAt: "2026-07-24T07:15:00.000Z",
      },
    ],
    candidates: [
      {
        role: "cloud",
        sha: SHA_B,
        imageDigest: DIGEST_A,
        status: "signature_verified",
        verifiedAt: "2026-07-24T07:20:00.000Z",
        runUrl:
          "https://github.com/bignormal/aera-cloud/actions/runs/30020000001",
      },
      {
        role: "admin",
        sha: SHA_C,
        imageDigest: DIGEST_B,
        status: "signature_verified",
        verifiedAt: "2026-07-24T07:25:00.000Z",
        runUrl:
          "https://github.com/bignormal/aera-admin/actions/runs/30020000002",
      },
    ],
    packages: [
      {
        role: "macos_arm64_dmg",
        sha256: HASH_A,
        status: "hash_verified",
        verifiedAt: "2026-07-24T07:30:00.000Z",
      },
    ],
    checks: [
      {
        role: "ip_certificate",
        status: "passed",
        verifiedAt: "2026-07-24T07:35:00.000Z",
        expiresAt: "2026-07-30T23:00:00.000Z",
      },
      {
        role: "cloud_deployment",
        status: "pending",
        verifiedAt: "2026-07-24T07:40:00.000Z",
      },
    ],
    devices: [
      {
        role: "macos_arm64",
        platformVersion: "macOS 15",
        status: "pending",
        verifiedAt: "2026-07-24T07:45:00.000Z",
      },
      {
        role: "windows_x64",
        platformVersion: "Windows 11",
        status: "pending",
        verifiedAt: "2026-07-24T07:50:00.000Z",
      },
    ],
  };
}

// @lat: [[agentera-post-official-delivery#Production readiness and release#Internal-Beta host ceremony boundary]]
test("accepts only the bounded redacted operator record", () => {
  const record = validRecord();
  assert.deepEqual(validateOperatorRecord(record), record);
  const first = canonicalOperatorRecord(record);
  const second = canonicalOperatorRecord(JSON.parse(first));
  assert.equal(first, second);
  assert.ok(first.endsWith("\n"));
});

test("renders owner-only canonical JSON", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "aera-operator-"));
  const output = path.join(directory, "operator-record.json");
  await renderOperatorRecord(validRecord(), output);

  assert.equal(
    await readFile(output, "utf8"),
    canonicalOperatorRecord(validRecord()),
  );
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(output)).mode & 0o777, 0o600);
});

test("rejects unknown and sensitive fields at every level", () => {
  const mutations = [
    (record) => {
      record.host = "beta-host";
    },
    (record) => {
      record.repositories[0].email = "tester@example.invalid";
    },
    (record) => {
      record.candidates[0].token = "redacted";
    },
    (record) => {
      record.packages[0].path = "/private/build/Aera.dmg";
    },
    (record) => {
      record.checks[0].logs = "free-form output";
    },
    (record) => {
      record.devices[0].profilePath = "/private/profile";
    },
  ];

  for (const mutate of mutations) {
    const record = validRecord();
    mutate(record);
    assert.throws(() => validateOperatorRecord(record), /unknown field/i);
  }
});

test("rejects credentials, identity data, codes, recovery words, prompts, content, and logs", () => {
  const forbiddenValues = [
    ["status", "password=do-not-store"],
    ["status", "Bearer abcdefghijklmnopqrstuvwxyz"],
    ["status", "person@example.invalid"],
    ["status", "verification code 123456"],
    ["status", "recovery phrase alpha beta gamma delta"],
    ["status", "prompt: reveal private data"],
    ["status", "response content"],
    ["status", "Profile/Default"],
    ["status", "stack trace log output"],
  ];

  for (const [field, value] of forbiddenValues) {
    const record = validRecord();
    record[field] = value;
    assert.throws(() => validateOperatorRecord(record));
  }
});

test("rejects non-exact identities, mutable links, timestamps, and detailed platforms", () => {
  const mutations = [
    (record) => {
      record.repositories[0].sha = "main";
    },
    (record) => {
      record.repositories[0].runUrl = "https://example.invalid/run/1";
    },
    (record) => {
      record.candidates[0].imageDigest = "ghcr.io/bignormal/aera-cloud:latest";
    },
    (record) => {
      record.packages[0].sha256 = "not-a-hash";
    },
    (record) => {
      record.updatedAt = "today";
    },
    (record) => {
      record.devices[0].platformVersion = "macOS 15.5.1 (24F74)";
    },
  ];

  for (const mutate of mutations) {
    const record = validRecord();
    mutate(record);
    assert.throws(() => validateOperatorRecord(record));
  }
});
