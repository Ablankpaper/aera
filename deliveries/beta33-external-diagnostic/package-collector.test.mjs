import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

test("rebuilds staging safely for a path containing spaces", () => {
  const root = mkdtempSync(join(tmpdir(), "aera collector staging "));
  try {
    const output = join(root, "release output with spaces");
    packageCollector({ platform: "win32", outputDir: output });
    writeFileSync(join(output, "staging", "run-macos.sh"), "stale launcher");
    writeFileSync(join(output, "staging", "target.json"), "stale target");
    const result = packageCollector({ platform: "darwin", outputDir: output });
    const entries = readdirSync(join(output, "staging"));
    assert.ok(entries.includes("run-macos.sh"));
    assert.ok(!entries.includes("run-windows.ps1"));
    assert.ok(!entries.includes("run-windows.bat"));
    assert.ok(!entries.includes("target.json"));
    const archive = spawnSync("unzip", ["-Z1", result.zipPath], {
      encoding: "utf8",
    });
    assert.equal(archive.status, 0, archive.stderr);
    const archiveEntries = archive.stdout.split(/\r?\n/u).filter(Boolean);
    assert.ok(archiveEntries.includes("run-macos.sh"));
    assert.ok(!archiveEntries.includes("run-windows.ps1"));
    assert.ok(!archiveEntries.includes("run-windows.bat"));
    assert.ok(!archiveEntries.includes("target.json"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("uses wildcard-aware PowerShell packaging instead of LiteralPath star", () => {
  for (const name of ["package-collector.mjs", "aera-diagnostic.mjs"]) {
    const source = readFileSync(new URL(name, import.meta.url), "utf8");
    assert.match(source, /Compress-Archive -Path/);
    assert.doesNotMatch(source, /Compress-Archive -LiteralPath[^\n]*\\\\\*/);
  }
});
