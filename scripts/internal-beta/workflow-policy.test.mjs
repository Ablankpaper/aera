/* eslint-disable @typescript-eslint/explicit-function-return-type */

import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";

import { parse as parseYAML } from "yaml";

const workflowPath = new URL(
  "../../.github/workflows/internal-beta.yml",
  import.meta.url,
);
const productionCandidatePath = new URL(
  "../../.github/workflows/release-candidate.yml",
  import.meta.url,
);
const promotionWorkflowPath = new URL(
  "../../.github/workflows/internal-beta-promote.yml",
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
const windowsVerifierPath = new URL(
  "../release/verify-windows.ps1",
  import.meta.url,
);
const macVerifierPath = new URL("../release/verify-macos.mjs", import.meta.url);
const packagedUpdaterVerifierPath = new URL(
  "./verify-packaged-updater-extraction.mjs",
  import.meta.url,
);
const execFileAsync = promisify(execFile);
const sourceSha = "a".repeat(40);

function ciValidationModule(raw) {
  const workflow = parseYAML(raw);
  const step = workflow.jobs.validate.steps.find(
    (candidate) =>
      candidate.name === "Verify successful CI belongs to the exact source",
  );
  assert.ok(step, "candidate workflow must validate the supplied CI run");
  const match = step.run.match(
    /node --input-type=module <<'NODE'\n([\s\S]*?)\nNODE/gu,
  );
  assert.equal(match?.length, 1, "candidate CI validator must be one module");
  return [
    ...step.run.matchAll(
      /node --input-type=module <<'NODE'\n([\s\S]*?)\nNODE/gu,
    ),
  ][0][1];
}

async function runCiValidation(raw, jobs) {
  const root = await mkdtemp(join(tmpdir(), "aera-candidate-ci-"));
  const runPath = join(root, "ci-run.json");
  await writeFile(
    runPath,
    `${JSON.stringify({
      workflowName: "CI",
      headSha: sourceSha,
      conclusion: "success",
      jobs,
    })}\n`,
    "utf8",
  );
  try {
    return spawnSync(process.execPath, ["--input-type=module"], {
      encoding: "utf8",
      env: {
        ...process.env,
        CI_RUN_JSON: runPath,
        SOURCE_SHA: sourceSha,
      },
      input: ciValidationModule(raw),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function successfulJob(name) {
  return {
    name,
    conclusion: "success",
    steps: [{ name: "Execute gate", conclusion: "success" }],
  };
}

const fullMatrixJobs = [
  successfulJob("check (ubuntu-latest)"),
  successfulJob("check (macos-latest)"),
  successfulJob("check (windows-latest)"),
];

const skippedDiagnosticJob = {
  name: "windows-process-tree-diagnostic",
  conclusion: "skipped",
  steps: [],
};

test("candidate CI validators accept the full matrix when only the diagnostic job is skipped", async () => {
  const workflows = await Promise.all([
    readFile(workflowPath, "utf8"),
    readFile(productionCandidatePath, "utf8"),
  ]);

  for (const raw of workflows) {
    const result = await runCiValidation(raw, [
      ...fullMatrixJobs,
      skippedDiagnosticJob,
    ]);
    assert.equal(result.status, 0, result.stderr);
  }
});

test("candidate CI validators reject a diagnostic-only run", async () => {
  const workflows = await Promise.all([
    readFile(workflowPath, "utf8"),
    readFile(productionCandidatePath, "utf8"),
  ]);

  for (const raw of workflows) {
    const result = await runCiValidation(raw, [
      { name: "check", conclusion: "skipped", steps: [] },
      successfulJob("windows-process-tree-diagnostic"),
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /matrix|job/u);
  }
});

test("candidate CI validators reject a missing required platform", async () => {
  const workflows = await Promise.all([
    readFile(workflowPath, "utf8"),
    readFile(productionCandidatePath, "utf8"),
  ]);

  for (const raw of workflows) {
    const result = await runCiValidation(raw, [
      ...fullMatrixJobs.slice(0, 2),
      skippedDiagnosticJob,
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /matrix|job/u);
  }
});

test("internal-Beta candidate is exact-SHA, notarized, update-signed, unpublished, and Sigstore-bound", async () => {
  const [raw, productionRaw, macVerifierRaw, packagedUpdaterVerifierRaw] =
    await Promise.all([
      readFile(workflowPath, "utf8"),
      readFile(productionCandidatePath, "utf8"),
      readFile(macVerifierPath, "utf8"),
      readFile(packagedUpdaterVerifierPath, "utf8"),
    ]);
  const workflow = parseYAML(raw);

  assert.match(raw, /test "\$VERSION" = "0\.7\.4-internal-beta\.31"/u);
  assert.ok(
    raw.includes(
      '--release-notes "Beta.31 修复 macOS 在线更新在下载完成后的打包模块兼容错误，并新增 app.asar updater 解压最终 ZIP 的发布门禁；Beta.29 和 Beta.30 的 macOS 用户需手动覆盖安装一次 Beta.31，之后恢复在线升级。Beta.30 的模型配置自愈修复继续保留；Runtime 仍为 0.20.0-agentera.2 签名候选，Windows 提供内测包。"',
    ),
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
    /identity="\^https:\/\/github\\\\\.com\/Ablankpaper\/aera\/\\\\\.github\/workflows\/internal-beta\\\\\.yml@refs\/heads\/main\$"/u,
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
  assert.match(raw, /node scripts\/internal-beta\/desktop-update\.mjs build/iu);
  assert.doesNotMatch(raw, /AERA_DESKTOP_UPDATE_PUBLISH_SSH_PRIVATE_KEY/u);
  assert.doesNotMatch(raw, /AERA_DESKTOP_UPDATE_PUBLISH_SSH_KNOWN_HOSTS/u);
  assert.doesNotMatch(raw, /"aera-updates@\$PUBLISH_HOST" publish/u);
  for (const secret of ["CSC_LINK", "CSC_KEY_PASSWORD"]) {
    assert.match(raw, new RegExp(`secrets\\.${secret}`, "u"));
  }
  for (const secret of ["ASC_API_KEY", "ASC_KEY_ID", "ASC_ISSUER_ID"]) {
    assert.match(raw, new RegExp(`secrets\\.${secret}`, "u"));
  }
  assert.match(raw, /-c\.forceCodeSigning=true/u);
  assert.match(raw, /-c\.mac\.notarize=false/u);
  assert.match(
    raw,
    /npx electron-rebuild --force --only better-sqlite3\s+--version 41\.10\.5 --arch arm64 --build-from-source/u,
  );
  assert.match(raw, /--prepackaged "\$APP_PATH"/u);
  const packagedUpdaterGateIndex = workflow.jobs.macos.steps.findIndex(
    (step) => step.name === "Exercise packaged updater against final macOS ZIP",
  );
  const containerSubmissionIndex = workflow.jobs.macos.steps.findIndex(
    (step) => step.name === "Submit final DMG and ZIP exactly once",
  );
  assert.ok(packagedUpdaterGateIndex >= 0);
  assert.ok(packagedUpdaterGateIndex < containerSubmissionIndex);
  assert.match(
    workflow.jobs.macos.steps[packagedUpdaterGateIndex].run,
    /node scripts\/internal-beta\/verify-packaged-updater-extraction\.mjs\s+--app "\$\{\{ steps\.mac_paths\.outputs\.app \}\}"\s+--zip "\$\{\{ steps\.mac_paths\.outputs\.zip \}\}"\s+--desktop-version "\$VERSION"/u,
  );
  assert.match(
    packagedUpdaterVerifierRaw,
    /AERA_PACKAGED_UPDATER_EXTRACTION_OK/u,
  );
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
  assert.match(macVerifierRaw, /resolvePackagedNativeModule/iu);
  assert.match(macVerifierRaw, /verifyNativeModuleAbi/iu);
  assert.match(raw, /candidate\/evidence\/macos-evidence\.json/u);
  assert.match(raw, /Build unsigned Windows x64 internal Beta/u);
  assert.match(raw, /CSC_IDENTITY_AUTO_DISCOVERY:\s*"false"/u);
  assert.match(raw, /Package unsigned Windows setup and portable executables/u);
  assert.doesNotMatch(
    raw,
    /secrets\.WIN_CSC_LINK|secrets\.WIN_CSC_KEY_PASSWORD/u,
  );
  assert.doesNotMatch(raw, /candidate\/evidence\/windows-evidence\.json/u);

  assert.match(productionRaw, /Build and Authenticode-sign Windows x64/u);
  assert.match(
    productionRaw,
    /npx electron-rebuild --force --only better-sqlite3\s+--version 41\.10\.5 --arch arm64 --build-from-source/u,
  );
  assert.match(productionRaw, /secrets\.WIN_CSC_LINK/u);
  assert.match(productionRaw, /secrets\.WIN_CSC_KEY_PASSWORD/u);
  assert.match(productionRaw, /scripts\/release\/verify-windows\.ps1/u);

  assert.doesNotMatch(raw, /actions\/attest/iu);
  assert.doesNotMatch(raw, /attestations:\s*write/iu);
  assert.doesNotMatch(raw, /\bgh\s+release\b|create[-_ ]tag|refs\/tags/iu);
  assert.doesNotMatch(raw, /WIN_CSC|signtool/iu);
  assert.doesNotMatch(
    raw,
    /repository:\s*Ablankpaper\/aera-runtime|git\s+clone[\s\S]*aera-runtime/iu,
  );
});

test("internal-Beta promotion publishes one verified candidate without rebuilding or resigning", async () => {
  const raw = await readFile(promotionWorkflowPath, "utf8");
  const workflow = parseYAML(raw);

  assert.match(raw, /test "\$VERSION" = "0\.7\.4-internal-beta\.31"/u);

  assert.equal(workflow.name, "Promote Desktop internal Beta");
  assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs).sort(), [
    "candidate_run_id",
    "source_sha",
  ]);
  assert.deepEqual(workflow.permissions, {
    actions: "read",
    contents: "read",
  });
  assert.deepEqual(Object.keys(workflow.jobs), ["promote"]);
  assert.equal(workflow.jobs.promote.environment, "internal-beta");
  assert.match(raw, /test "\$GITHUB_REF" = "refs\/heads\/main"/u);
  assert.match(raw, /internal-beta-promote\.yml@refs\/heads\/main/u);
  assert.match(raw, /gh run view "\$CANDIDATE_RUN_ID"/u);
  assert.match(raw, /Desktop internal Beta candidate/u);
  assert.match(raw, /run\.headSha !== process\.env\.SOURCE_SHA/u);
  assert.match(raw, /run\.conclusion !== "success"/u);
  assert.match(raw, /run-id:\s*\$\{\{ inputs\.candidate_run_id \}\}/u);
  assert.match(raw, /sha256sum --check SHA256SUMS/u);
  assert.match(raw, /desktop-update\.mjs verify/u);
  assert.match(raw, /AERA_DESKTOP_UPDATE_PUBLISH_SSH_PRIVATE_KEY/u);
  assert.match(raw, /AERA_DESKTOP_UPDATE_PUBLISH_SSH_KNOWN_HOSTS/u);
  assert.match(raw, /"aera-updates@\$PUBLISH_HOST" publish/u);
  assert.match(raw, /cmp candidate\/desktop-update\/manifest\.json/u);
  assert.doesNotMatch(raw, /desktop-update\.mjs build/u);
  assert.doesNotMatch(raw, /electron-builder|notarytool|cosign sign-blob/iu);
});

test("internal-Beta promotion inline Node modules parse before publication", async () => {
  const raw = await readFile(promotionWorkflowPath, "utf8");
  const workflow = parseYAML(raw);
  const modules = workflow.jobs.promote.steps.flatMap((step) =>
    [
      ...(step.run ?? "").matchAll(
        /node --input-type=module <<'NODE'\n([\s\S]*?)\nNODE/gu,
      ),
    ].map((match) => match[1]),
  );

  assert.equal(modules.length, 2);
  for (const module of modules) {
    const result = spawnSync(
      process.execPath,
      ["--check", "--input-type=module"],
      {
        encoding: "utf8",
        input: module,
      },
    );
    assert.equal(result.status, 0, result.stderr);
  }
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

  assert.equal(
    baseConfig.afterPack,
    "scripts/release/verify-packaged-native-module.mjs",
  );
  assert.equal(config.extends, "electron-builder.yml");
  assert.equal(
    config.beforePack,
    "scripts/internal-beta/verify-built-auth-config.mjs",
  );
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
  assert.equal(
    macConfig.beforePack,
    "scripts/internal-beta/verify-built-auth-config.mjs",
  );
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

test(
  "Windows runner accepts the production Authenticode verifier PowerShell syntax",
  { skip: process.platform !== "win32" },
  async () => {
    await execFileAsync(
      "pwsh",
      [
        "-NoProfile",
        "-Command",
        "$tokens = $null; $errors = $null; [System.Management.Automation.Language.Parser]::ParseFile($env:VERIFY_WINDOWS_PATH, [ref]$tokens, [ref]$errors) | Out-Null; if ($errors.Count -gt 0) { $errors | ForEach-Object { Write-Error $_.Message }; exit 1 }",
      ],
      {
        env: {
          ...process.env,
          VERIFY_WINDOWS_PATH: fileURLToPath(windowsVerifierPath),
        },
      },
    );
  },
);
