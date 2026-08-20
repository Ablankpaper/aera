import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const EXPECTED_VERSION = "0.7.4-internal-beta.34";

const packageJsonPath = new URL("../../package.json", import.meta.url);
const packageLockPath = new URL("../../package-lock.json", import.meta.url);
const manifestPath = new URL("./manifest.mjs", import.meta.url);
const candidateWorkflowPath = new URL(
  "../../.github/workflows/internal-beta.yml",
  import.meta.url,
);
const promotionWorkflowPath = new URL(
  "../../.github/workflows/internal-beta-promote.yml",
  import.meta.url,
);

test("Beta.34 package, manifest, and release workflows share one version identity", async () => {
  const [
    packageJsonRaw,
    packageLockRaw,
    manifestRaw,
    candidateRaw,
    promotionRaw,
  ] = await Promise.all([
    readFile(packageJsonPath, "utf8"),
    readFile(packageLockPath, "utf8"),
    readFile(manifestPath, "utf8"),
    readFile(candidateWorkflowPath, "utf8"),
    readFile(promotionWorkflowPath, "utf8"),
  ]);
  const packageJson = JSON.parse(packageJsonRaw);
  const packageLock = JSON.parse(packageLockRaw);

  assert.equal(packageJson.version, EXPECTED_VERSION);
  assert.equal(packageLock.version, EXPECTED_VERSION);
  assert.equal(packageLock.packages?.[""]?.version, EXPECTED_VERSION);
  assert.match(
    manifestRaw,
    new RegExp(
      `INTERNAL_BETA_VERSION = "${EXPECTED_VERSION.replaceAll(".", "\\.")}"`,
      "u",
    ),
  );
  for (const workflow of [candidateRaw, promotionRaw]) {
    assert.match(
      workflow,
      new RegExp(
        `test "\\$VERSION" = "${EXPECTED_VERSION.replaceAll(".", "\\.")}"`,
        "u",
      ),
    );
  }
});
