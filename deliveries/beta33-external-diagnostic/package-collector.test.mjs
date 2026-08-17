import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { packageCollector } from "./package-collector.mjs";

test("packages a macOS-only collector bundle without product source or legacy CLI", () => {
  const root = mkdtempSync(join(tmpdir(), "aera-collector-package-test-"));
  try {
    const output = join(root, "out");
    const result = packageCollector({ platform: "darwin", outputDir: output });
    assert.equal(result.platform, "darwin");
    assert.match(result.zipPath, /macos/);
    const entries = readdirSync(join(output, "staging")).sort();
    assert.ok(entries.includes("aera-diagnostic.mjs"));
    assert.ok(entries.includes("run-macos.sh"));
    assert.ok(entries.includes("aera-diagnostic-bundle-v4.schema.json"));
    assert.ok(entries.includes("aera-diagnostic-environment.mjs"));
    assert.ok(!entries.includes("beta29-external-model-save-diagnostic.mjs"));
    assert.ok(!entries.some((name) => name.startsWith("src")));
    assert.ok(readdirSync(output).some((name) => name.endsWith(".zip")));
    assert.ok(readdirSync(output).some((name) => name === "SHASUMS.txt"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("packages a Windows collector from a non-Windows release host", () => {
  const root = mkdtempSync(
    join(tmpdir(), "aera-windows-collector-package-test-"),
  );
  try {
    const output = join(root, "out");
    const result = packageCollector({ platform: "win32", outputDir: output });
    assert.equal(result.platform, "win32");
    assert.match(result.zipPath, /windows/);
    const entries = readdirSync(join(output, "staging")).sort();
    assert.ok(entries.includes("run-windows.ps1"));
    assert.ok(entries.includes("run-windows.bat"));
    assert.ok(!entries.includes("run-macos.sh"));
    assert.ok(readdirSync(output).some((name) => name.endsWith(".zip")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects unknown platform before creating an artifact", () => {
  assert.throws(
    () => packageCollector({ platform: "linux", outputDir: "/tmp/no" }),
    /platform/i,
  );
});
