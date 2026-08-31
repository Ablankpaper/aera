import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const diagnosticPath = new URL(
  "../diagnose-windows-runtime-extraction-app-boundary.mjs",
  import.meta.url,
);

test("passes the no-op extractor path into the packaged app evaluation", async () => {
  const source = await readFile(diagnosticPath, "utf8");

  assert.match(
    source,
    /app\.evaluate\([\s\S]*?noOpModulePath,[\s\S]*?timeoutMs,[\s\S]*?\},\s*\n\s*\);/u,
  );
  assert.match(source, /moduleOverridePath:\s*config\.noOpModulePath/u);
  assert.match(source, /sequentialModulePath/u);
  assert.match(source, /name: "app-user-data-noasar-yauzl"/u);
  assert.match(
    source,
    /moduleBuiltin\.createRequire\([\s\S]*?\)\(\s*["']electron["']\s*\)/u,
  );
  assert.match(source, /await\s+terminate\(\);/u);
  assert.ok(
    source.indexOf('name: "app-user-data-noasar-noop"') <
      source.indexOf('name: "app-user-data-noasar",'),
  );
});

test("includes a callback-driven yauzl control for the Electron app boundary", async () => {
  const source = await readFile(diagnosticPath, "utf8");

  assert.match(source, /callbackModulePath/u);
  assert.match(source, /name: "app-user-data-noasar-yauzl-callback"/u);
  assert.match(source, /name: "app-user-data-noasar-yauzl-callback-w"/u);
  assert.match(source, /createWriteStream\(target, \{ flags:/u);
  assert.match(source, /snapshot/u);
  assert.match(source, /zipfile\.on\(["']entry["']/u);
  assert.match(source, /zipfile\.readEntry\(\)/u);
});

test("supports selecting one app-boundary variant for a bounded diagnostic run", async () => {
  const source = await readFile(diagnosticPath, "utf8");

  assert.match(source, /values\.get\(["']only["']\)/u);
  assert.match(
    source,
    /async function runInApplication\([\s\S]*?\bonly,\n\s*\}\)/u,
  );
  assert.match(source, /config\.only/u);
  assert.match(source, /variants\.filter/u);
});
