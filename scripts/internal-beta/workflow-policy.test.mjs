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
const ciWorkflowPath = new URL(
  "../../.github/workflows/ci.yml",
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
const windowsSmokePath = new URL("./windows-update-smoke.ps1", import.meta.url);
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
  successfulJob("windows-model-recovery"),
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

test("CI and candidate workflows execute and keep collectors separate from product artifacts", async () => {
  const [ci, internalBeta, releaseCandidate] = await Promise.all([
    readFile(ciWorkflowPath, "utf8"),
    readFile(workflowPath, "utf8"),
    readFile(productionCandidatePath, "utf8"),
  ]);
  assert.match(
    ci,
    /node --test\s+deliveries\/beta33-external-diagnostic\/\*\.test\.mjs/u,
  );
  for (const raw of [internalBeta, releaseCandidate]) {
    assert.match(raw, /package-diagnostic-collectors\.mjs/u);
    assert.match(raw, /diagnostic-collectors/u);
    assert.doesNotMatch(
      raw,
      /cp[^\n]*(?:Aera\.app|resources)[^\n]*beta33-external-diagnostic/iu,
    );
  }

  const production = parseYAML(releaseCandidate);
  const assembleSteps = production.jobs.assemble.steps;
  const assembleInputs = assembleSteps.find(
    (step) => step.name === "Assemble candidate inputs",
  );
  assert.ok(assembleInputs);
  assert.doesNotMatch(
    assembleInputs.run,
    /^\s+candidate\/(?:evidence\/diagnostic-collectors\.json|diagnostic-collectors\/\*)$/mu,
  );

  const attestation = assembleSteps.find(
    (step) => step.name === "Attest candidate bytes",
  );
  assert.ok(attestation);
  assert.match(
    attestation.with["subject-path"],
    /candidate\/diagnostic-collectors\/\*/u,
  );
  assert.match(
    attestation.with["subject-path"],
    /candidate\/evidence\/diagnostic-collectors\.json/u,
  );

  const verifyAttestation = assembleSteps.find(
    (step) => step.name === "Verify GitHub attestation and preserve bundle",
  );
  assert.ok(verifyAttestation);
  assert.match(
    verifyAttestation.run,
    /find candidate\/diagnostic-collectors -type f -print0/u,
  );
});

test("internal-Beta candidate is exact-SHA, notarized on macOS, explicitly unsigned on Windows, update-signed, unpublished, and Sigstore-bound", async () => {
  const [
    raw,
    productionRaw,
    macVerifierRaw,
    windowsVerifierRaw,
    packagedUpdaterVerifierRaw,
  ] = await Promise.all([
    readFile(workflowPath, "utf8"),
    readFile(productionCandidatePath, "utf8"),
    readFile(macVerifierPath, "utf8"),
    readFile(windowsVerifierPath, "utf8"),
    readFile(packagedUpdaterVerifierPath, "utf8"),
  ]);
  const workflow = parseYAML(raw);

  assert.match(raw, /test "\$VERSION" = "0\.7\.4-internal-beta\.33"/u);
  assert.ok(
    raw.includes(
      '--release-notes "Beta.33 修复模型配置恢复与保存、Owner 切换写入屏障、模型发现错误分类、Product Space 降级和更新器恢复链路；保留 Beta.32 的 macOS 启动路径修复与 Beta.31 的更新解压修复。Beta.29 故障机使用 DMG 桥接安装，Beta.31/Beta.32 支持在线升级。macOS 内测包已签名并公证；Windows 内测包未进行 Authenticode 签名，仅供受控内测使用。"',
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
  assert.match(raw, /test -n "\$BETA_ORIGIN"[\s\S]*AERA_INTERNAL_BETA_ORIGIN/u);
  assert.match(raw, /test -n "\$MAIN_VITE_AGENTERA_CLOUD_PUBLIC_URL"/u);
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
  assert.equal(
    workflow.jobs.macos.steps[packagedUpdaterGateIndex].env.BETA_ORIGIN,
    "${{ vars.AERA_INTERNAL_BETA_ORIGIN }}",
  );
  assert.match(
    workflow.jobs.macos.steps[packagedUpdaterGateIndex].run,
    /node scripts\/internal-beta\/verify-packaged-updater-extraction\.mjs\s+--app "\$\{\{ steps\.mac_paths\.outputs\.app \}\}"\s+--zip "\$\{\{ steps\.mac_paths\.outputs\.zip \}\}"\s+--desktop-version "\$VERSION"\s+--expected-cloud-origin "\$BETA_ORIGIN"\s+--require-runtime-entries/u,
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
  assert.match(
    raw,
    /Package unsigned Windows setup, portable, and app ZIP payload/u,
  );
  assert.match(
    raw,
    /--win nsis portable dir --x64 --publish never[\s\\`]*--config\.forceCodeSigning=false/u,
  );
  assert.doesNotMatch(raw, /-c\.forceCodeSigning=false/u);
  assert.match(raw, /CSC_IDENTITY_AUTO_DISCOVERY:\s*"false"/u);
  assert.match(raw, /Aera-Internal-Beta-\$env:VERSION-windows-x64-app\.zip/u);
  assert.match(raw, /verify-packaged-windows-app-zip\.mjs/u);
  assert.match(
    raw,
    /verify-packaged-windows-app-zip\.mjs[\s\S]*--expected-cloud-origin \$env:BETA_ORIGIN/u,
  );
  assert.doesNotMatch(raw, /secrets\.WIN_CSC_LINK/u);
  assert.doesNotMatch(raw, /secrets\.WIN_CSC_KEY_PASSWORD/u);
  assert.doesNotMatch(raw, /Require Authenticode credentials/u);
  assert.match(raw, /scripts\/release\/verify-windows\.ps1/u);
  assert.match(raw, /-SigningMode unsigned_internal_beta/u);
  assert.match(
    windowsVerifierRaw,
    /ValidateSet\("authenticode", "unsigned_internal_beta"\)/u,
  );
  assert.match(windowsVerifierRaw, /\[string\]\$SigningMode = "authenticode"/u);
  assert.match(windowsVerifierRaw, /SignatureStatus\]::NotSigned/u);
  assert.match(windowsVerifierRaw, /unsignedVerifiedArtifacts/u);
  assert.match(
    windowsVerifierRaw,
    /function Assert-WindowsArtifactWrapperPE[\s\S]*\$machine -ne 0x014c -and \$machine -ne 0x8664/u,
  );
  assert.match(
    windowsVerifierRaw,
    /\$item\.peMachine = Assert-WindowsArtifactWrapperPE \$file\.FullName/u,
  );
  assert.match(
    windowsVerifierRaw,
    /\$nativeModule = Join-Path[\s\S]*Assert-X64PE \$nativeModule/u,
  );
  assert.match(raw, /candidate\/evidence\/windows-evidence\.json/u);

  assert.match(productionRaw, /Build and Authenticode-sign Windows x64/u);
  assert.match(
    productionRaw,
    /npx electron-rebuild --force --only better-sqlite3\s+--version 41\.10\.5 --arch arm64 --build-from-source/u,
  );
  assert.match(productionRaw, /secrets\.WIN_CSC_LINK/u);
  assert.match(productionRaw, /secrets\.WIN_CSC_KEY_PASSWORD/u);
  assert.match(productionRaw, /scripts\/release\/verify-windows\.ps1/u);
  assert.doesNotMatch(productionRaw, /-SigningMode unsigned_internal_beta/u);

  assert.doesNotMatch(raw, /actions\/attest/iu);
  assert.doesNotMatch(raw, /attestations:\s*write/iu);
  assert.doesNotMatch(raw, /\bgh\s+release\b|create[-_ ]tag|refs\/tags/iu);
  assert.doesNotMatch(raw, /WIN_CSC_LINK/u);
  assert.doesNotMatch(
    raw,
    /repository:\s*Ablankpaper\/aera-runtime|git\s+clone[\s\S]*aera-runtime/iu,
  );
});

test("internal-Beta promotion publishes one verified candidate without rebuilding or resigning", async () => {
  const raw = await readFile(promotionWorkflowPath, "utf8");
  const workflow = parseYAML(raw);

  assert.match(raw, /test "\$VERSION" = "0\.7\.4-internal-beta\.33"/u);

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
  assert.match(raw, /Aera-Internal-Beta-\$VERSION-windows-x64-app\.zip/u);
  assert.doesNotMatch(
    raw,
    /releases\/\$VERSION\/Aera-Internal-Beta-\$VERSION-windows-x64-setup\.exe/u,
  );
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

test("packaging excludes foreign extract-zip prebuilds before native verification", async () => {
  const config = parseYAML(await readFile(baseBuilderPath, "utf8"));
  assert.deepEqual(config.mac.files, [
    "!node_modules/@electron-internal/extract-zip/index.linux-*.node",
    "!node_modules/@electron-internal/extract-zip/index.win32-*.node",
  ]);
  assert.deepEqual(config.win.files, [
    "!node_modules/@electron-internal/extract-zip/index.darwin-*.node",
    "!node_modules/@electron-internal/extract-zip/index.linux-*.node",
    "!node_modules/@electron-internal/extract-zip/index.win32-arm64-msvc.node",
  ]);
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

test(
  "Windows runner accepts the internal-Beta smoke PowerShell syntax",
  { skip: process.platform !== "win32" },
  async () => {
    await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "$tokens = $null; $errors = $null; [System.Management.Automation.Language.Parser]::ParseFile($env:WINDOWS_SMOKE_PATH, [ref]$tokens, [ref]$errors) | Out-Null; if ($errors.Count -gt 0) { $errors | ForEach-Object { Write-Error $_.Message }; exit 1 }",
      ],
      {
        env: {
          ...process.env,
          WINDOWS_SMOKE_PATH: fileURLToPath(windowsSmokePath),
        },
      },
    );
  },
);

test("Internal Beta Windows candidate runs disposable install/start/update/rollback smoke", async () => {
  const raw = await readFile(workflowPath, "utf8");
  const workflow = parseYAML(raw);
  const step = workflow.jobs.windows.steps.find(
    (candidate) =>
      candidate.name === "Exercise Windows install/start/update/rollback smoke",
  );
  assert.ok(step, "Windows candidate must run the disposable smoke gate");
  assert.match(step.run, /scripts\/internal-beta\/windows-update-smoke\.ps1/u);
  for (const argument of [
    "-AppDirectory",
    "-SetupPath",
    "-PortablePath",
    "-Version",
    "-HelperScript",
  ]) {
    assert.match(step.run, new RegExp(argument, "u"));
  }
  const smokeScript = await readFile(windowsSmokePath, "utf8");
  assert.match(smokeScript, /HERMES_DESKTOP_USER_DATA_DIR/u);
  assert.match(smokeScript, /Start-Process/u);
  assert.match(smokeScript, /rollback|Restore/u);
  assert.match(smokeScript, /synthetic|disposable/u);
  assert.doesNotMatch(smokeScript, /\?\?/u);
});

test("Internal Beta candidate proves packaged Main Preload and Renderer startup on both platforms", async () => {
  const raw = await readFile(workflowPath, "utf8");
  const workflow = parseYAML(raw);
  for (const jobName of ["macos", "windows"]) {
    const step = workflow.jobs[jobName].steps.find(
      (candidate) =>
        candidate.name === "Verify exact packaged application startup",
    );
    assert.ok(step, `${jobName} must verify the exact packaged startup`);
    assert.match(step.run, /scripts\/release\/verify-packaged-startup\.mjs/u);
    assert.match(step.run, /--source-sha/u);
    assert.match(step.run, /--desktop-version/u);
    assert.match(step.run, /--output/u);
  }
  assert.match(raw, /packaged-startup-macos\.json/u);
  assert.match(raw, /packaged-startup-windows\.json/u);
});

test("Internal Beta binds native inventories to every final distributable", async () => {
  const raw = await readFile(workflowPath, "utf8");
  for (const name of [
    "native-inventory-macos-dmg.json",
    "native-inventory-macos-zip.json",
    "native-inventory-windows-setup.json",
    "native-inventory-windows-portable.json",
    "native-inventory-windows-app-zip.json",
  ]) {
    assert.match(raw, new RegExp(name.replaceAll(".", "\\."), "u"));
  }
  assert.equal(
    [
      ...raw.matchAll(
        /scripts\/release\/final-artifact-native-inventory\.mjs/gu,
      ),
    ].length,
    3,
  );
  assert.match(raw, /--native-evidence-dir candidate\/evidence/u);
});
