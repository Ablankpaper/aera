import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  assertTargetMatches,
  inspectTargetIdentity,
  isProcessIdentityStable,
  resolveTargetExecutable,
} from "./aera-diagnostic-target.mjs";

const SHA = (char) => char.repeat(64);

function fakeApp() {
  const root = mkdtempSync(join(tmpdir(), "aera-target-fixture-"));
  const app = join(root, "Aera.app");
  const macos = join(app, "Contents", "MacOS");
  mkdirSync(macos, { recursive: true });
  mkdirSync(join(app, "Contents", "Resources"), { recursive: true });
  writeFileSync(
    join(app, "Contents", "Info.plist"),
    "<key>CFBundleIdentifier</key><string>com.example.aera</string>\n" +
      "<key>CFBundleShortVersionString</key><string>0.7.4-internal-beta.33</string>",
  );
  const executable = join(macos, "Aera");
  writeFileSync(executable, "fixture executable");
  chmodSync(executable, 0o755);
  return { root, app, executable };
}

test("resolves one exact macOS app executable and hashes its package", () => {
  const fixture = fakeApp();
  try {
    assert.equal(resolveTargetExecutable(fixture.app, "darwin"), realpathSync(fixture.executable));
    const identity = inspectTargetIdentity({ appPath: fixture.app, platform: "darwin" });
    assert.equal(identity.bundleId, "com.example.aera");
    assert.equal(identity.version, "0.7.4-internal-beta.33");
    assert.match(identity.executableSha256, /^[0-9a-f]{64}$/u);
    assert.match(identity.packageSha256, /^[0-9a-f]{64}$/u);
    assert.notEqual(identity.executableSha256, identity.packageSha256);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("rejects a stale descriptor before capture", () => {
  const fixture = fakeApp();
  try {
    const identity = inspectTargetIdentity({ appPath: fixture.app, platform: "darwin" });
    assert.throws(
      () => assertTargetMatches(identity, {
        schemaVersion: 1,
        platform: "darwin",
        version: identity.version,
        bundleId: identity.bundleId,
        architecture: identity.architecture,
        executableSha256: SHA("a"),
        packageSha256: identity.packageSha256,
      }),
      /executableSha256/u,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("process continuity requires the same pid, start identity, and executable digest", () => {
  const before = { pid: 42, startTime: "2026-08-19T00:00:00.000Z", executableSha256: SHA("a") };
  assert.equal(isProcessIdentityStable(before, { ...before }), true);
  assert.equal(isProcessIdentityStable(before, { ...before, pid: 43 }), false);
  assert.equal(isProcessIdentityStable(before, { ...before, startTime: "2026-08-19T00:01:00.000Z" }), false);
  assert.equal(isProcessIdentityStable(before, { ...before, executableSha256: SHA("b") }), false);
});
