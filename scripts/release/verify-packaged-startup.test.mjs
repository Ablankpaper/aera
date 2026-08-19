import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPackagedStartupEnvironment,
  buildPackagedStartupEvidence,
  validateRendererProbe,
} from "./verify-packaged-startup.mjs";

const HASH = "a".repeat(64);

test("isolates packaged startup from the daily Hermes home", () => {
  assert.deepEqual(
    buildPackagedStartupEnvironment(
      { PATH: "/bin", HERMES_HOME: "/daily/profile" },
      "/isolated/profile",
      9337,
    ),
    {
      PATH: "/bin",
      HERMES_HOME: "/isolated/profile",
      ENABLE_CDP: "1",
      CDP_PORT: "9337",
    },
  );
});

// @lat: [[desktop-updates#Desktop Updates#Internal Beta signed update channel#Test specifications]]
test("accepts one live packaged Main Preload Renderer startup", () => {
  const renderer = validateRendererProbe(
    {
      readyState: "complete",
      visibilityState: "visible",
      locationProtocol: "file:",
      bodyTextLength: 120,
      hasHermesApi: true,
      hasRendererReadyBridge: true,
      rendererReadyAccepted: true,
      appVersion: "0.7.4-internal-beta.32",
    },
    "0.7.4-internal-beta.32",
  );

  const evidence = buildPackagedStartupEvidence({
    sourceSha: "1".repeat(40),
    version: "0.7.4-internal-beta.32",
    platform: "darwin",
    architecture: "arm64",
    executableSha256: HASH,
    appAsarSha256: "b".repeat(64),
    entryHashes: {
      main: "c".repeat(64),
      preload: "d".repeat(64),
      renderer: "e".repeat(64),
    },
    renderer,
  });

  assert.equal(evidence.schemaVersion, 1);
  assert.deepEqual(evidence.events, [
    "main_loaded",
    "preload_loaded",
    "renderer_loaded",
    "first_window_visible",
    "health_marked",
  ]);
  assert.equal(evidence.entries.preload.sha256, "d".repeat(64));
});

test("rejects a blank Renderer or missing Preload bridge", () => {
  assert.throws(
    () =>
      validateRendererProbe(
        {
          readyState: "complete",
          visibilityState: "visible",
          locationProtocol: "file:",
          bodyTextLength: 0,
          hasHermesApi: true,
          hasRendererReadyBridge: true,
          rendererReadyAccepted: true,
          appVersion: "0.7.4-internal-beta.32",
        },
        "0.7.4-internal-beta.32",
      ),
    /Renderer body is blank/u,
  );
  assert.throws(
    () =>
      validateRendererProbe(
        {
          readyState: "complete",
          visibilityState: "visible",
          locationProtocol: "file:",
          bodyTextLength: 5,
          hasHermesApi: false,
          hasRendererReadyBridge: false,
          rendererReadyAccepted: false,
          appVersion: null,
        },
        "0.7.4-internal-beta.32",
      ),
    /Preload bridge is unavailable/u,
  );
});

test("rejects a packaged Renderer from a different version", () => {
  assert.throws(
    () =>
      validateRendererProbe(
        {
          readyState: "complete",
          visibilityState: "visible",
          locationProtocol: "file:",
          bodyTextLength: 5,
          hasHermesApi: true,
          hasRendererReadyBridge: true,
          rendererReadyAccepted: true,
          appVersion: "0.7.4-internal-beta.31",
        },
        "0.7.4-internal-beta.32",
      ),
    /version differs/u,
  );
});
