import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { parse as parseYAML } from "yaml";

const workflowPath = new URL(
  "../../.github/workflows/internal-beta.yml",
  import.meta.url,
);
const builderPath = new URL(
  "../../build/electron-builder.internal-beta.yml",
  import.meta.url,
);
const baseBuilderPath = new URL("../../electron-builder.yml", import.meta.url);

test("internal-Beta workflow is exact-SHA, unsigned, nonpublishing, and Sigstore-bound", async () => {
  const raw = await readFile(workflowPath, "utf8");
  const workflow = parseYAML(raw);

  assert.equal(workflow.name, "Desktop internal Beta candidate");
  assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs).sort(), [
    "ci_run_id",
    "source_sha",
  ]);
  assert.equal(workflow.permissions.actions, "read");
  assert.equal(workflow.permissions.contents, "read");
  assert.equal(workflow.permissions["id-token"], undefined);
  assert.equal(workflow.permissions.attestations, undefined);
  assert.deepEqual(workflow.jobs.assemble.permissions, {
    actions: "read",
    contents: "read",
    "id-token": "write",
  });
  for (const jobName of ["validate", "macos", "windows"]) {
    assert.equal(workflow.jobs[jobName].permissions, undefined);
  }
  for (const jobName of ["validate", "macos", "windows", "assemble"]) {
    const checkout = workflow.jobs[jobName].steps.find(
      (step) => step.uses === "actions/checkout@v4",
    );
    assert.ok(checkout, `${jobName} must check out exact source`);
    assert.equal(checkout.with["persist-credentials"], false);
  }
  assert.match(raw, /environment:\s*internal-beta/u);
  for (const variable of [
    "AERA_INTERNAL_BETA_ORIGIN",
    "AERA_INTERNAL_BETA_OFFLINE_KEY_ID",
    "AERA_INTERNAL_BETA_OFFLINE_PUBLIC_KEY",
  ]) {
    assert.match(raw, new RegExp(`vars\\.${variable}`, "u"));
  }
  assert.match(
    raw,
    /go install github\.com\/sigstore\/cosign\/v3\/cmd\/cosign@v3\.0\.6/iu,
  );
  assert.match(
    raw,
    /go install github\.com\/anchore\/syft\/cmd\/syft@v1\.44\.0/iu,
  );
  assert.match(raw, /cosign sign-blob[\s\S]*internal-beta-manifest\.json/iu);
  assert.match(raw, /cosign sign-blob[\s\S]*internal-beta\.provenance\.json/iu);
  assert.match(
    raw,
    /identity="\^https:\/\/github\\\\\.com\/bignormal\/aera\/\\\\\.github\/workflows\/internal-beta\\\\\.yml@refs\/heads\/main\$"/u,
  );
  assert.match(raw, /--certificate-identity-regexp "\$identity"/u);
  assert.match(
    raw,
    /issuer="https:\/\/token\.actions\.githubusercontent\.com"/u,
  );
  assert.match(raw, /--certificate-oidc-issuer "\$issuer"/u);
  assert.match(raw, /retention-days:\s*30/u);
  assert.match(raw, /--publish never/u);

  assert.doesNotMatch(raw, /actions\/attest/iu);
  assert.doesNotMatch(raw, /attestations:\s*write/iu);
  assert.doesNotMatch(raw, /\bgh\s+release\b|create[-_ ]tag|refs\/tags/iu);
  assert.doesNotMatch(
    raw,
    /CSC_LINK|CSC_KEY_PASSWORD|WIN_CSC|signtool|notarytool|codesign/iu,
  );
  assert.doesNotMatch(
    raw,
    /repository:\s*bignormal\/aera-runtime|git\s+clone[\s\S]*aera-runtime/iu,
  );
});

test("internal-Beta Electron Builder overlay stays unsigned while preserving Windows resources", async () => {
  const [raw, baseRaw] = await Promise.all([
    readFile(builderPath, "utf8"),
    readFile(baseBuilderPath, "utf8"),
  ]);
  const config = parseYAML(raw);
  const baseConfig = parseYAML(baseRaw);

  assert.equal(config.extends, "electron-builder.yml");
  assert.equal(config.forceCodeSigning, false);
  assert.deepEqual(config.publish, []);
  assert.equal(config.mac.identity, null);
  assert.equal(config.mac.notarize, false);
  assert.equal(config.mac.hardenedRuntime, true);
  assert.equal(
    config.dmg.artifactName,
    "Aera-Internal-Beta-${version}-macos-${arch}.${ext}",
  );
  assert.notEqual(
    config.win?.signAndEditExecutable,
    false,
    "Windows internal-beta packages must keep PE resource editing enabled so icon/version metadata is embedded",
  );
  assert.equal(baseConfig.win.icon, "build/icon.ico");
  assert.equal(
    config.mac.artifactName,
    "Aera-Internal-Beta-${version}-macos-${arch}.${ext}",
  );
  assert.equal(
    config.nsis.artifactName,
    "Aera-Internal-Beta-${version}-windows-${arch}-setup.${ext}",
  );
  assert.equal(
    config.portable.artifactName,
    "Aera-Internal-Beta-${version}-windows-${arch}-portable.${ext}",
  );
});
