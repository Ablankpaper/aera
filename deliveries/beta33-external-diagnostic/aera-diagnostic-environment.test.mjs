import assert from "node:assert/strict";
import { test } from "node:test";

import {
  collectCloudOriginEvidence,
  collectEnvironmentEvidence,
} from "./aera-diagnostic-environment.mjs";

test("environment evidence keeps values to an allowlisted, secret-free shape", () => {
  const result = collectEnvironmentEvidence(
    {
      MAIN_VITE_AGENTERA_CLOUD_PUBLIC_URL: "https://cloud.example.test/",
      HTTPS_PROXY: "http://proxy-user:proxy-secret@example.test:8080",
      HERMES_HOME: "/Users/alice/.hermes",
      RANDOM_SECRET: "do-not-copy",
    },
    { platform: "darwin", arch: "arm64", versions: { electron: "35" } },
  );
  assert.equal(result.status, "collected");
  assert.equal(result.environment.proxy.https, true);
  assert.equal(result.environment.hermesHome, true);
  assert.equal(result.environment.keys.RANDOM_SECRET, undefined);
  assert.doesNotMatch(
    JSON.stringify(result),
    /proxy-secret|alice|cloud\.example/,
  );
});

test("cloud origin evidence reports presence without exposing the origin", () => {
  const result = collectCloudOriginEvidence({
    env: { MAIN_VITE_AGENTERA_CLOUD_PUBLIC_URL: "https://cloud.example.test/" },
    logText: "",
  });
  assert.equal(result.status, "collected");
  assert.equal(result.configured, true);
  assert.match(result.originSha256, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(result), /cloud\.example/);
});

test("cloud origin evidence distinguishes an unobservable origin", () => {
  const result = collectCloudOriginEvidence({ env: {}, logText: "" });
  assert.equal(result.status, "missing");
  assert.equal(result.reason, "cloud_origin_not_observable");
  assert.equal(result.configured, false);
});
