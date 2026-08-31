/* eslint-disable @typescript-eslint/explicit-function-return-type */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const configPath = new URL("../../electron.vite.config.ts", import.meta.url);
const updaterPath = new URL(
  "../../src/main/app/internal-beta-updater.ts",
  import.meta.url,
);

test("the packaged updater entry loads the extractor after disabling ASAR", async () => {
  // @lat: [[desktop-updates#Desktop Updates#Internal Beta signed update channel#Test specifications]]
  const [config, updater] = await Promise.all([
    readFile(configPath, "utf8"),
    readFile(updaterPath, "utf8"),
  ]);

  assert.match(
    config,
    /["']internal-beta-updater["']:\s*resolve\(\s*["']src\/main\/app\/internal-beta-updater\.ts["']\s*,?\s*\)/u,
  );
  assert.doesNotMatch(
    updater,
    /^\s*import\s*\{[^\n]*extract[^\n]*\}\s*from\s*["']@electron-internal\/extract-zip["']/mu,
  );
  assert.doesNotMatch(
    updater,
    /import\s+extractZip\s+from\s+["']@electron-internal\/extract-zip["']/u,
  );
  assert.match(
    updater,
    /electronProcess\.noAsar\s*=\s*true[\s\S]*await\s+import\(\s*["']@electron-internal\/extract-zip["']\s*\)/u,
  );
});
