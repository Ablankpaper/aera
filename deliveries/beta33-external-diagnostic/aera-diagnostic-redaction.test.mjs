import assert from "node:assert/strict";
import { test } from "node:test";

import {
  redactStructured,
  redactText,
  scanShareableText,
} from "./aera-diagnostic-redaction.mjs";

// @lat: [[lat.md/beta27-reliability-plan#Beta.27 Reliability Plan#Acceptance and release boundary#Beta.33 external diagnostic collector V4#Privacy and forensic limits]]
test("redacts credentials, paths and URLs while preserving safe metadata", () => {
  const input =
    "Authorization: Bearer fixture-secret-token; API_KEY=fixture-api-key url=https://example.test/path?q=secret";
  const output = redactText(input);
  assert.doesNotMatch(output, /fixture-secret-token|fixture-api-key|q=secret/);
  assert.match(output, /REDACTED/);
  assert.equal(scanShareableText(output).passed, true);
});

test("redacts sensitive structured keys to presence and length", () => {
  const output = redactStructured({
    apiKey: "fixture-api-key",
    token: "fixture-token",
    modelCount: 7,
    nested: { password: "fixture-password" },
  });
  assert.deepEqual(output.apiKey, { present: true, length: 15 });
  assert.deepEqual(output.token, { present: true, length: 13 });
  assert.equal(output.modelCount, 7);
  assert.deepEqual(output.nested.password, { present: true, length: 16 });
});

test("fails closed for PEM, JWT and credential assignments", () => {
  const raw =
    "-----BEGIN PRIVATE KEY-----\nfixture-private\n-----END PRIVATE KEY----- eyJabc123456.x.y token=fixture-secret-value";
  const result = scanShareableText(raw);
  assert.equal(result.passed, false);
  assert.ok(result.findings.length >= 2);
});

test("fails closed when chat transcript content reaches a shareable file", () => {
  const scan = scanShareableText("CHAT user: my private conversation");
  assert.equal(scan.passed, false);
  assert.ok(scan.findings.includes("chat_content"));
});
