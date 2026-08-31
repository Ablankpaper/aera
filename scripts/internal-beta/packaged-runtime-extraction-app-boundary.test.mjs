/* eslint-disable @typescript-eslint/explicit-function-return-type */

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
    /app\.evaluate\([\s\S]*?noOpModulePath,\s*\n\s*timeoutMs,\s*\n\s*\},\s*\n\s*\);/u,
  );
});
