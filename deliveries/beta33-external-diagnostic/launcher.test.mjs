import assert from "node:assert/strict";
import {
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = new URL(".", import.meta.url).pathname;

test("macOS launcher uses the signed app Electron runtime and no global Node", () => {
  const script = readFileSync(join(root, "run-macos.sh"), "utf8");
  assert.match(script, /ELECTRON_RUN_AS_NODE=1/);
  assert.match(script, /aera-diagnostic\.mjs/);
  assert.doesNotMatch(script, /command -v node|node "/);
  assert.equal(statSync(join(root, "run-macos.sh")).mode & 0o111, 0o111);
});

test("Windows wrappers forward to PowerShell and preserve arguments", () => {
  const ps = readFileSync(join(root, "run-windows.ps1"), "utf8");
  const bat = readFileSync(join(root, "run-windows.bat"), "utf8");
  assert.match(ps, /ELECTRON_RUN_AS_NODE/);
  assert.match(ps, /aera-diagnostic\.mjs/);
  assert.match(ps, /GetUnresolvedProviderPathFromPSPath/);
  assert.match(ps, /collectorArgs/);
  assert.doesNotMatch(ps, /--platform windows @args/);
  assert.match(bat, /run-windows\.ps1/);
  assert.doesNotMatch(bat, /node\.exe .*beta29/);
});

test("collector main executes when its path contains spaces", () => {
  const root = mkdtempSync(join(tmpdir(), "aera collector launcher "));
  try {
    const copied = join(root, "collector with spaces.mjs");
    const sourceDir = fileURLToPath(new URL(".", import.meta.url));
    for (const name of readdirSync(sourceDir)) {
      if (/^(?:aera-diagnostic[^/]*\.mjs|aera-diagnostic-[^/]*\.json)$/.test(name))
        cpSync(join(sourceDir, name), join(root, name));
    }
    cpSync(join(sourceDir, "aera-diagnostic.mjs"), copied);
    const result = spawnSync(process.execPath, [copied, "--help"], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Aera external diagnostic collector V4/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
