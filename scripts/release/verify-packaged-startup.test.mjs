import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPackagedStartupEnvironment,
  buildPackagedStartupEvidence,
  packagedAsarEntryPath,
  removePackagedStartupDirectory,
  validateRendererProbe,
} from "./verify-packaged-startup.mjs";

const HASH = "a".repeat(64);

test("uses Windows separators when locating packaged ASAR entries", () => {
  assert.equal(
    packagedAsarEntryPath("win32", "out", "main", "index.js"),
    "out\\main\\index.js",
  );
  assert.equal(
    packagedAsarEntryPath("darwin", "out", "main", "index.js"),
    "out/main/index.js",
  );
});

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

test("retries Windows-style busy handles while removing isolated startup data", async () => {
  const calls = [];
  await removePackagedStartupDirectory(
    "C:\\isolated\\startup",
    async (...args) => {
      calls.push(args);
    },
  );

  assert.deepEqual(calls, [
    [
      "C:\\isolated\\startup",
      {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 250,
      },
    ],
  ]);
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
      appVersion: "0.7.4-internal-beta.36",
    },
    "0.7.4-internal-beta.36",
  );

  const evidence = buildPackagedStartupEvidence({
    sourceSha: "1".repeat(40),
    version: "0.7.4-internal-beta.36",
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
          appVersion: "0.7.4-internal-beta.36",
        },
        "0.7.4-internal-beta.36",
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
        "0.7.4-internal-beta.36",
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
        "0.7.4-internal-beta.36",
      ),
    /version differs/u,
  );
});
