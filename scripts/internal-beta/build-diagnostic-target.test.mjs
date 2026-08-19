/* eslint-disable @typescript-eslint/explicit-function-return-type */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildDiagnosticTarget, main } from "./build-diagnostic-target.mjs";

const SHA = (char) => char.repeat(64);

test("binds an exact candidate manifest to a target descriptor", () => {
  const result = buildDiagnosticTarget({
    schemaVersion: 1,
    platform: "darwin",
    version: "0.7.4-internal-beta.33",
    bundleId: "com.example.aera",
    architecture: "arm64",
    executableSha256: SHA("a"),
    packageSha256: SHA("b"),
    artifactSha256: SHA("b"),
    appAsarSha256: SHA("e"),
    mainSha256: SHA("f"),
    preloadSha256: SHA("1"),
    rendererSha256: SHA("2"),
    sourceSha: "c".repeat(40),
    candidateManifestSha256: SHA("d"),
  });
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.bindingStatus, "candidate-bound");
  assert.equal(result.packageSha256, SHA("b"));
});

test("rejects conflicting platform hashes and never reads process secrets", () => {
  assert.throws(
    () =>
      buildDiagnosticTarget({
        schemaVersion: 1,
        platform: "darwin",
        version: "0.7.4-internal-beta.33",
        bundleId: "com.example.aera",
        architecture: "arm64",
        executableSha256: SHA("a"),
        packageSha256: SHA("b"),
        artifactSha256: SHA("c"),
        appAsarSha256: SHA("f"),
        mainSha256: SHA("1"),
        preloadSha256: SHA("2"),
        rendererSha256: SHA("3"),
        sourceSha: "d".repeat(40),
        candidateManifestSha256: SHA("e"),
        executable: "fixture-secret-token",
      }),
    /unknown|conflict/i,
  );
});

test("CLI writes canonical descriptor bytes", () => {
  const root = mkdtempSync(join(tmpdir(), "aera-target-builder-test-"));
  try {
    const manifest = join(root, "manifest.json");
    const output = join(root, "target.json");
    writeFileSync(
      manifest,
      JSON.stringify({
        schemaVersion: 1,
        platform: "win32",
        version: "0.7.4-internal-beta.33",
        applicationId: "com.example.aera",
        architecture: "x64",
        executableSha256: SHA("a"),
        packageSha256: SHA("b"),
        artifactSha256: SHA("b"),
        appAsarSha256: SHA("e"),
        mainSha256: SHA("f"),
        preloadSha256: SHA("1"),
        rendererSha256: SHA("2"),
        sourceSha: "c".repeat(40),
        candidateManifestSha256: SHA("d"),
      }),
    );
    assert.equal(main(["--manifest", manifest, "--output", output]), 0);
    const parsed = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(parsed.platform, "win32");
    assert.equal(parsed.bindingStatus, "candidate-bound");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
