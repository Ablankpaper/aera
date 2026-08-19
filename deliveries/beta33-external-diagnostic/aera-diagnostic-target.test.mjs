/* eslint-disable @typescript-eslint/explicit-function-return-type */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  assertTargetMatches,
  inspectTargetIdentity,
  isProcessIdentityStable,
  resolveTargetExecutable,
  windowsFileVersion,
} from "./aera-diagnostic-target.mjs";

const SHA = (char) => char.repeat(64);

function fakeApp() {
  const root = mkdtempSync(join(tmpdir(), "aera-target-fixture-"));
  const app = join(root, "Aera.app");
  const macos = join(app, "Contents", "MacOS");
  mkdirSync(macos, { recursive: true });
  mkdirSync(join(app, "Contents", "Resources"), { recursive: true });
  writeFileSync(join(app, "Contents", "Resources", "app.asar"), "fixture asar");
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
    assert.equal(
      resolveTargetExecutable(fixture.app, "darwin"),
      realpathSync(fixture.executable),
    );
    const identity = inspectTargetIdentity({
      appPath: fixture.app,
      platform: "darwin",
    });
    assert.equal(identity.bundleId, "com.example.aera");
    assert.equal(identity.version, "0.7.4-internal-beta.33");
    assert.match(identity.executableSha256, /^[0-9a-f]{64}$/u);
    assert.match(identity.packageSha256, /^[0-9a-f]{64}$/u);
    assert.equal(
      identity.packageSha256,
      createHash("sha256").update("fixture asar").digest("hex"),
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("rejects a stale descriptor before capture", () => {
  const fixture = fakeApp();
  try {
    const identity = inspectTargetIdentity({
      appPath: fixture.app,
      platform: "darwin",
    });
    assert.throws(
      () =>
        assertTargetMatches(identity, {
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

test("rejects a supplied version that differs from installed metadata", () => {
  const fixture = fakeApp();
  try {
    assert.throws(
      () =>
        inspectTargetIdentity({
          appPath: fixture.app,
          platform: "darwin",
          version: "0.7.4-internal-beta.32",
        }),
      /version/u,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("process continuity requires the same pid, start identity, and executable digest", () => {
  const before = {
    pid: 42,
    startTime: "2026-08-19T00:00:00.000Z",
    executableSha256: SHA("a"),
  };
  assert.equal(isProcessIdentityStable(before, { ...before }), true);
  assert.equal(isProcessIdentityStable(before, { ...before, pid: 43 }), false);
  assert.equal(
    isProcessIdentityStable(before, {
      ...before,
      startTime: "2026-08-19T00:01:00.000Z",
    }),
    false,
  );
  assert.equal(
    isProcessIdentityStable(before, { ...before, executableSha256: SHA("b") }),
    false,
  );
});

test("resolves a Windows unpacked directory to its one executable", () => {
  const root = mkdtempSync(join(tmpdir(), "aera-target-windows-fixture-"));
  try {
    const executable = join(root, "Aera.exe");
    writeFileSync(executable, "fixture executable");
    assert.equal(
      resolveTargetExecutable(root, "win32"),
      realpathSync(executable),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects an installed package without app.asar identity", () => {
  const root = mkdtempSync(join(tmpdir(), "aera-target-missing-asar-"));
  try {
    writeFileSync(join(root, "Aera.exe"), "fixture executable");
    assert.throws(
      () =>
        inspectTargetIdentity({
          appPath: root,
          platform: "win32",
          version: "0.7.4-internal-beta.33",
          applicationId: "com.example.aera",
        }),
      /app\.asar|package/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reads the full prerelease version from bounded Windows FileVersion metadata", () => {
  const calls = [];
  const version = windowsFileVersion(
    "C:\\Program Files\\Aera\\Aera.exe",
    (command, args, options) => {
      calls.push({ command, args, options });
      return { code: 0, stdout: "0.7.4-internal-beta.33\r\n" };
    },
    "win32",
  );
  assert.equal(version, "0.7.4-internal-beta.33");
  assert.equal(calls[0].command, "powershell.exe");
  assert.match(calls[0].args.at(-1), /\.VersionInfo\.FileVersion/u);
  assert.ok(calls[0].options.timeoutMs <= 5_000);
  assert.ok(calls[0].options.maximumBytes <= 8 * 1024);
});

test("candidate matching tolerates only an unobservable Windows application id", () => {
  const common = {
    platform: "win32",
    version: "0.7.4-internal-beta.33",
    architecture: "x64",
    executableSha256: SHA("a"),
    packageSha256: SHA("b"),
  };
  assert.doesNotThrow(() =>
    assertTargetMatches(
      { ...common, applicationId: "unknown" },
      { ...common, applicationId: "com.bignormal.agentera.studio" },
    ),
  );
  assert.throws(
    () =>
      assertTargetMatches(
        { ...common, applicationId: "com.example.wrong" },
        { ...common, applicationId: "com.bignormal.agentera.studio" },
      ),
    /application identity/u,
  );
});
