/* eslint-disable @typescript-eslint/explicit-function-return-type */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const configPath = new URL("../../electron.vite.config.ts", import.meta.url);
const updaterPath = new URL(
  "../../src/main/app/internal-beta-updater.ts",
  import.meta.url,
);

test("the packaged updater entry binds the extractor named export", async () => {
  // @lat: [[desktop-updates#Desktop Updates#Internal Beta signed update channel#Test specifications]]
  const [config, updater] = await Promise.all([
    readFile(configPath, "utf8"),
    readFile(updaterPath, "utf8"),
  ]);

  assert.match(
    config,
    /["']internal-beta-updater["']:\s*resolve\(\s*["']src\/main\/app\/internal-beta-updater\.ts["']\s*,?\s*\)/u,
  );
  assert.match(
    updater,
    /import\s*\{\s*extract\s+as\s+extractZip\s*\}\s*from\s*["']@electron-internal\/extract-zip["'];/u,
  );
  assert.doesNotMatch(
    updater,
    /import\s+extractZip\s+from\s+["']@electron-internal\/extract-zip["']/u,
  );
});
