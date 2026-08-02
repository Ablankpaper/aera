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
const macBuilderPath = new URL(
  "../../build/electron-builder.internal-beta-macos.yml",
  import.meta.url,
);
const baseBuilderPath = new URL("../../electron-builder.yml", import.meta.url);

test("internal-Beta workflow is exact-SHA, Developer-ID-notarized, update-signed, published, and Sigstore-bound", async () => {
  const raw = await readFile(workflowPath, "utf8");
  const workflow = parseYAML(raw);

  assert.match(raw, /test "\$VERSION" = "0\.7\.4-internal-beta\.21"/u);
  assert.match(
    raw,
    /--release-notes "Beta\.21 修复主动退出后的账户重新选择与 Runtime Seed 重装状态同步，并恢复 macOS Apple 公证、装订与 Gatekeeper 验证。"/u,
  );
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
  assert.match(raw, /AERA_DESKTOP_UPDATE_SIGNING_PRIVATE_KEY/u);
  assert.match(raw, /AERA_DESKTOP_UPDATE_PUBLISH_SSH_PRIVATE_KEY/u);
  assert.match(raw, /AERA_DESKTOP_UPDATE_PUBLISH_SSH_KNOWN_HOSTS/u);
  assert.match(raw, /node scripts\/internal-beta\/desktop-update\.mjs build/iu);
  assert.match(raw, /"aera-updates@\$PUBLISH_HOST" publish/u);
  assert.match(
    raw,
    /curl[\s\S]*\/desktop-updates\/internal-beta|base_url=.*\/desktop-updates\/internal-beta/iu,
  );
  for (const secret of ["CSC_LINK", "CSC_KEY_PASSWORD"]) {
    assert.match(raw, new RegExp(`secrets\\.${secret}`, "u"));
  }
  for (const secret of ["ASC_API_KEY", "ASC_KEY_ID", "ASC_ISSUER_ID"]) {
    assert.match(raw, new RegExp(`secrets\\.${secret}`, "u"));
  }
  assert.match(raw, /-c\.forceCodeSigning=true/u);
  assert.match(raw, /-c\.mac\.notarize=false/u);
  assert.match(raw, /--prepackaged "\$APP_PATH"/u);
  assert.match(raw, /xcrun notarytool submit[\s\S]*--no-wait/iu);
  assert.match(raw, /xcrun notarytool wait/iu);
  assert.match(
    raw,
    /wait_for_submission "\$DMG_SUBMISSION_ID" "\$DMG_RESULT" &[\s\S]*DMG_WAIT_PID=\$!/u,
  );
  assert.match(
    raw,
    /wait_for_submission "\$ZIP_SUBMISSION_ID" "\$ZIP_RESULT" &[\s\S]*ZIP_WAIT_PID=\$!/u,
  );
  assert.match(raw, /wait "\$DMG_WAIT_PID"/u);
  assert.match(raw, /wait "\$ZIP_WAIT_PID"/u);
  assert.match(raw, /xcrun stapler staple "\$APP_PATH"/u);
  assert.match(raw, /xcrun stapler staple "\$DMG_PATH"/u);
  assert.match(raw, /xcrun stapler validate "\$APP_PATH"/u);
  assert.match(raw, /xcrun stapler validate "\$DMG_PATH"/u);
  assert.match(raw, /timeout-minutes:\s*355/u);
  assert.doesNotMatch(raw, /--notarization-mode deferred/u);
  assert.match(raw, /node scripts\/release\/verify-macos\.mjs/iu);
  assert.match(raw, /candidate\/evidence\/macos-evidence\.json/u);

  assert.doesNotMatch(raw, /actions\/attest/iu);
  assert.doesNotMatch(raw, /attestations:\s*write/iu);
  assert.doesNotMatch(raw, /\bgh\s+release\b|create[-_ ]tag|refs\/tags/iu);
  assert.doesNotMatch(raw, /WIN_CSC|signtool/iu);
  assert.doesNotMatch(
    raw,
    /repository:\s*bignormal\/aera-runtime|git\s+clone[\s\S]*aera-runtime/iu,
  );
});

test("internal-Beta overlays separate unsigned Windows from strict macOS signing", async () => {
  const [raw, macRaw, baseRaw] = await Promise.all([
    readFile(builderPath, "utf8"),
    readFile(macBuilderPath, "utf8"),
    readFile(baseBuilderPath, "utf8"),
  ]);
  const config = parseYAML(raw);
  const macConfig = parseYAML(macRaw);
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
  assert.equal(macConfig.extends, "electron-builder.yml");
  assert.equal(macConfig.forceCodeSigning, true);
  assert.deepEqual(macConfig.publish, []);
  assert.equal(macConfig.mac.identity, undefined);
  assert.equal(macConfig.mac.notarize, false);
  assert.equal(macConfig.mac.hardenedRuntime, true);
  assert.equal(
    macConfig.mac.artifactName,
    "Aera-Internal-Beta-${version}-macos-${arch}.${ext}",
  );
  assert.equal(
    macConfig.dmg.artifactName,
    "Aera-Internal-Beta-${version}-macos-${arch}.${ext}",
  );
});
