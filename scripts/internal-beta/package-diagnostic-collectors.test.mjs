/* eslint-disable @typescript-eslint/explicit-function-return-type */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  buildCandidateDiagnosticTarget,
  packageCandidateDiagnosticCollectors,
} from "./package-diagnostic-collectors.mjs";
import { canonicalDiagnosticJson } from "../../deliveries/beta33-external-diagnostic/aera-diagnostic-schema.mjs";

const SHA = (char) => char.repeat(64);

function appFixture(root, platform) {
  if (platform === "darwin") {
    const app = join(root, "Aera.app");
    mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
    mkdirSync(join(app, "Contents", "Resources"), { recursive: true });
    const executable = join(app, "Contents", "MacOS", "Aera");
    writeFileSync(executable, "mac executable");
    chmodSync(executable, 0o755);
    writeFileSync(join(app, "Contents", "Resources", "app.asar"), "mac asar");
    writeFileSync(
      join(app, "Contents", "Info.plist"),
      "<key>CFBundleIdentifier</key><string>com.example.aera</string><key>CFBundleShortVersionString</key><string>0.7.4-internal-beta.33</string>",
    );
    return app;
  }
  const app = join(root, "win-unpacked");
  mkdirSync(app, { recursive: true });
  const executable = join(app, "Aera.exe");
  writeFileSync(executable, "win executable");
  mkdirSync(join(app, "resources"), { recursive: true });
  writeFileSync(join(app, "resources", "app.asar"), "windows asar");
  return executable;
}

function startup(identity, platform) {
  return {
    schemaVersion: 1,
    sourceSha: "1".repeat(40),
    version: "0.7.4-internal-beta.33",
    platform,
    architecture: identity.architecture,
    executable: { sha256: identity.executableSha256 },
    appAsar: { sha256: identity.packageSha256 },
    entries: {
      main: { sha256: SHA("b") },
      preload: { sha256: SHA("c") },
      renderer: { sha256: SHA("d") },
    },
  };
}

test("builds one complete candidate-bound descriptor from signed evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "aera-diagnostic-target-package-"));
  try {
    const app = appFixture(root, "darwin");
    const { inspectTargetIdentity } =
      await import("../../deliveries/beta33-external-diagnostic/aera-diagnostic-target.mjs");
    const identity = inspectTargetIdentity({
      appPath: app,
      platform: "darwin",
    });
    const manifestBytes = Buffer.from('{"schemaVersion":3}\n');
    const target = buildCandidateDiagnosticTarget({
      manifestBytes,
      manifest: { sourceSha: "1".repeat(40), version: identity.version },
      startup: startup(identity, "darwin"),
      identity,
      artifact: { sha256: SHA("e") },
    });
    assert.equal(target.bindingStatus, "candidate-bound");
    assert.equal(target.appAsarSha256, identity.packageSha256);
    assert.equal(target.packageSha256, identity.packageSha256);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// @lat: [[lat.md/beta27-reliability-plan#Beta.27 Reliability Plan#Acceptance and release boundary#Beta.33 external diagnostic collector V4#Candidate binding and launch boundary]]
test("packages both candidate-bound collectors and records their exact hashes", async () => {
  const root = mkdtempSync(
    join(tmpdir(), "aera-diagnostic-collectors-package-"),
  );
  try {
    const macApp = appFixture(join(root, "mac"), "darwin");
    const windowsExe = appFixture(join(root, "windows"), "win32");
    const { inspectTargetIdentity } =
      await import("../../deliveries/beta33-external-diagnostic/aera-diagnostic-target.mjs");
    const macIdentity = inspectTargetIdentity({
      appPath: macApp,
      platform: "darwin",
    });
    const windowsIdentity = inspectTargetIdentity({
      appPath: windowsExe,
      platform: "win32",
      version: "0.7.4-internal-beta.33",
      applicationId: "com.example.aera",
    });
    const output = join(root, "output");
    const manifestBytes = Buffer.from('{"schemaVersion":3}\n');
    const manifest = {
      sourceSha: "1".repeat(40),
      version: "0.7.4-internal-beta.33",
    };
    const macos = {
      identity: macIdentity,
      startup: startup(macIdentity, "darwin"),
      artifact: { sha256: SHA("e") },
    };
    const windows = {
      identity: windowsIdentity,
      startup: startup(windowsIdentity, "win32"),
      artifact: { sha256: SHA("f") },
    };
    const result = packageCandidateDiagnosticCollectors({
      manifestBytes,
      manifest,
      macos,
      windows,
      outputDir: output,
    });
    assert.equal(result.schemaVersion, 1);
    assert.deepEqual(
      result.collectors.map((entry) => entry.platform),
      ["darwin", "win32"],
    );
    for (const entry of result.collectors) {
      assert.deepEqual(Object.keys(entry).sort(), [
        "collectorVersion",
        "name",
        "platform",
        "schemaVersion",
        "sha256",
        "sha512",
        "size",
        "targetSha256",
      ]);
      assert.match(entry.sha256, /^[0-9a-f]{64}$/u);
      assert.match(entry.sha512, /^[0-9a-f]{128}$/u);
      assert.ok(readFileSync(join(output, entry.name)).length > 0);
      const target = buildCandidateDiagnosticTarget({
        manifestBytes,
        manifest,
        ...(entry.platform === "darwin" ? macos : windows),
      });
      const targetBytes = Buffer.from(`${canonicalDiagnosticJson(target)}\n`);
      assert.equal(
        entry.targetSha256,
        createHash("sha256").update(targetBytes).digest("hex"),
      );
    }
    assert.deepEqual(
      readdirSync(output).sort(),
      result.collectors.map((entry) => entry.name).sort(),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects candidate evidence that differs from the installed package", async () => {
  const root = mkdtempSync(join(tmpdir(), "aera-diagnostic-target-mismatch-"));
  try {
    const app = appFixture(root, "darwin");
    const { inspectTargetIdentity } =
      await import("../../deliveries/beta33-external-diagnostic/aera-diagnostic-target.mjs");
    const identity = inspectTargetIdentity({
      appPath: app,
      platform: "darwin",
    });
    const input = {
      manifestBytes: Buffer.from('{"schemaVersion":3}\n'),
      manifest: { sourceSha: "1".repeat(40), version: identity.version },
      startup: startup(identity, "darwin"),
      identity,
      artifact: { sha256: SHA("e") },
    };
    assert.throws(
      () =>
        buildCandidateDiagnosticTarget({
          ...input,
          identity: { ...identity, version: "0.7.4-internal-beta.32" },
        }),
      /version/u,
    );
    assert.throws(
      () =>
        buildCandidateDiagnosticTarget({
          ...input,
          startup: { ...input.startup, appAsar: { sha256: SHA("f") } },
        }),
      /app\.asar|package/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
