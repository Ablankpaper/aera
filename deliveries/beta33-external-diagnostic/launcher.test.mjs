import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
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
  assert.match(ps, /@args/);
  assert.match(bat, /run-windows\.ps1/);
  assert.doesNotMatch(bat, /node\.exe .*beta29/);
});
