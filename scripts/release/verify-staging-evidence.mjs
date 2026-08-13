#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */

import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from "node:crypto";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { canonicalJSONStringify } from "./candidate-manifest.mjs";

export const REQUIRED_STAGING_SUITES = Object.freeze([
  "auth_device_offline",
  "workspace_organization",
  "official_managed_agent",
  "quality_governance",
  "encrypted_backup_migration",
  "admin_dual_auth_rbac_audit",
  "database_restore_object_reconciliation",
  "release_control_rollback",
]);

export const REQUIRED_STAGING_SCENARIOS = Object.freeze([
  "registrationDisabled",
  "loginAndDeviceManagement",
  "offlineEntitlement",
  "accountRecovery",
  "workspaceLifecycle",
  "organizationLifecycle",
  "officialDraftSeparateApproval",
  "officialImmutableRelease",
  "officialDeterministicRollout",
  "officialPauseResumeRollback",
  "officialRuntimeBindingStability",
  "qualityConsentOffOnRevoke",
  "qualityMinimizedUpload",
  "qualityThresholdSuppression",
  "qualityAggregateVisibility",
  "qualityProposalSeparation",
  "qualityDraftLinkage",
  "qualityNoPrivateMarker",
  "backupEnablementAndPhraseConfirmation",
  "backupDeviceEnrollment",
  "backupManualAndScheduled",
  "backupResumableUpload",
  "backupFailureRejections",
  "backupAuthorizedAndPhraseRestore",
  "backupCryptographicDeletion",
  "backupFreshProfileRestore",
  "adminDualAuthentication",
  "adminRBAC",
  "adminAudit",
  "dependenciesFailClosed",
  "databaseDisposableRestore",
  "objectInventoryReconciliation",
  "featureShutdownPreservesProfiles",
  "releaseRollbackDrill",
]);

const REPOSITORIES = new Set([
  "Ablankpaper/aera",
  "Ablankpaper/aera-cloud",
  "Ablankpaper/aera-admin",
]);
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const IMAGE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const SIGNING_KEY_PATTERN = /^ed25519:[0-9a-f]{64}$/u;

export function stagingSigningKeyId(publicKey) {
  const key = asPublicKey(publicKey);
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error("Staging acceptance key must be Ed25519");
  }
  const digest = createHash("sha256")
    .update(key.export({ format: "der", type: "spki" }))
    .digest("hex");
  return `ed25519:${digest}`;
}

export function verifyStagingEvidenceSignature(document, publicKey, signature) {
  const key = asPublicKey(publicKey);
  const expectedKeyId = stagingSigningKeyId(key);
  const signatureBytes = Buffer.isBuffer(signature)
    ? signature
    : Buffer.from(signature);
  if (
    document?.signingKeyId !== expectedKeyId ||
    signatureBytes.length !== 64 ||
    !verifySignature(
      null,
      Buffer.from(canonicalJSONStringify(document)),
      key,
      signatureBytes,
    )
  ) {
    throw new Error("Staging acceptance signature is invalid");
  }
  return true;
}

function asPublicKey(value) {
  return value?.type === "public" ? value : createPublicKey(value);
}

export function validateStagingEvidence(document, options) {
  exactFields(
    document,
    [
      "schemaVersion",
      "environment",
      "releaseInputs",
      "finalStagingOrigin",
      "identityIssuer",
      "networkBoundary",
      "safety",
      "testPopulation",
      "suiteRuns",
      "scenarioResults",
      "recoveryEvidence",
      "signingKeyId",
      "completedAt",
    ],
    "staging evidence",
  );
  if (
    document.schemaVersion !== 1 ||
    document.environment !== "private_staging"
  ) {
    throw new Error("Staging evidence schema or environment is invalid");
  }
  validateReleaseInputs(document.releaseInputs, options);
  validateHTTPSOrigin(document.finalStagingOrigin, "final staging origin");
  validateHTTPSOrigin(document.identityIssuer, "identity issuer");
  validateNetworkBoundary(document.networkBoundary);
  validateSafety(document.safety);
  validatePopulation(document.testPopulation);
  const completedAt = parseTime(
    document.completedAt,
    "staging completion time",
  );
  const now =
    options?.now instanceof Date && Number.isFinite(options.now.getTime())
      ? options.now
      : new Date();
  if (completedAt.getTime() > now.getTime() + 5 * 60 * 1000) {
    throw new Error("Staging evidence completion time is in the future");
  }
  validateSuiteRuns(document.suiteRuns, document.releaseInputs, completedAt);
  validateScenarioResults(document.scenarioResults);
  validateRecoveryEvidence(document.recoveryEvidence);
  if (!SIGNING_KEY_PATTERN.test(document.signingKeyId ?? "")) {
    throw new Error("Staging signing key identity is invalid");
  }
  return document;
}

function validateReleaseInputs(inputs, expected) {
  exactFields(inputs, ["cloud", "admin", "desktop"], "staging release inputs");
  validateImageInput(inputs.cloud, {
    repository: "Ablankpaper/aera-cloud",
    sourceSha: expected?.cloudSourceSha,
    imageDigest: expected?.cloudImageDigest,
    label: "Cloud",
  });
  validateImageInput(inputs.admin, {
    repository: "Ablankpaper/aera-admin",
    sourceSha: expected?.adminSourceSha,
    imageDigest: expected?.adminImageDigest,
    label: "Admin",
  });
  exactFields(
    inputs.desktop,
    ["repository", "sourceSha", "candidateManifestSha256"],
    "Desktop staging input",
  );
  if (
    inputs.desktop.repository !== "Ablankpaper/aera" ||
    !SHA_PATTERN.test(inputs.desktop.sourceSha ?? "") ||
    inputs.desktop.sourceSha !== expected?.desktopSourceSha ||
    !DIGEST_PATTERN.test(inputs.desktop.candidateManifestSha256 ?? "") ||
    inputs.desktop.candidateManifestSha256 !==
      expected?.desktopCandidateManifestSha256
  ) {
    throw new Error("Desktop candidate manifest digest or identity differs");
  }
}

function validateImageInput(input, expected) {
  exactFields(
    input,
    ["repository", "sourceSha", "imageDigest", "candidateManifestSha256"],
    `${expected.label} staging input`,
  );
  if (
    input.repository !== expected.repository ||
    !SHA_PATTERN.test(input.sourceSha ?? "") ||
    input.sourceSha !== expected.sourceSha ||
    !IMAGE_DIGEST_PATTERN.test(input.imageDigest ?? "") ||
    input.imageDigest !== expected.imageDigest ||
    !DIGEST_PATTERN.test(input.candidateManifestSha256 ?? "")
  ) {
    throw new Error(
      `${expected.label} candidate image digest or identity differs`,
    );
  }
}

function validateNetworkBoundary(network) {
  exactFields(
    network,
    [
      "accessMode",
      "cloudPublicListenerInternetReachable",
      "cloudPublicListenerAccessControlled",
      "adminBrowserInternetReachable",
      "internalAdminInternetReachable",
      "internalAdminMTLSVerified",
      "internalAdminServiceJWTVerified",
      "postgresInternetReachable",
      "redisInternetReachable",
      "objectStoreInternetReachable",
      "evidenceSha256",
      "evidenceUrl",
    ],
    "staging network boundary",
  );
  if (!["vpn", "ssh_tunnel", "https_allowlist"].includes(network.accessMode)) {
    throw new Error("Staging network access mode is invalid");
  }
  for (const field of [
    "cloudPublicListenerInternetReachable",
    "adminBrowserInternetReachable",
    "internalAdminInternetReachable",
    "postgresInternetReachable",
    "redisInternetReachable",
    "objectStoreInternetReachable",
  ]) {
    if (network[field] !== false) {
      throw new Error("Staging services must remain private from the Internet");
    }
  }
  if (
    network.cloudPublicListenerAccessControlled !== true ||
    network.internalAdminMTLSVerified !== true ||
    network.internalAdminServiceJWTVerified !== true ||
    !DIGEST_PATTERN.test(network.evidenceSha256 ?? "")
  ) {
    throw new Error("Staging private network or dual-auth evidence is missing");
  }
  validateRedactedURL(network.evidenceUrl, "network evidence URL");
}

function validateSafety(safety) {
  exactFields(
    safety,
    [
      "publicRegistrationEnabled",
      "productionProviderCredentialsPresent",
      "productionDataUsed",
      "stagingOnlyKeysVerified",
    ],
    "staging safety",
  );
  if (safety.publicRegistrationEnabled !== false) {
    throw new Error("Public registration must remain disabled in staging");
  }
  if (safety.productionProviderCredentialsPresent !== false) {
    throw new Error("Production provider credentials are forbidden in staging");
  }
  if (
    safety.productionDataUsed !== false ||
    safety.stagingOnlyKeysVerified !== true
  ) {
    throw new Error("Staging must use only isolated test data and keys");
  }
}

function validatePopulation(population) {
  exactFields(
    population,
    ["accountCount", "authorizedBackupDeviceCount", "desktopDeviceCount"],
    "staging test population",
  );
  if (
    !Number.isSafeInteger(population.accountCount) ||
    population.accountCount < 2 ||
    !Number.isSafeInteger(population.authorizedBackupDeviceCount) ||
    population.authorizedBackupDeviceCount < 2 ||
    !Number.isSafeInteger(population.desktopDeviceCount) ||
    population.desktopDeviceCount < 2
  ) {
    throw new Error(
      "Staging requires two accounts and two independently authorized devices",
    );
  }
}

function validateSuiteRuns(suiteRuns, releaseInputs, completedAt) {
  exactFields(suiteRuns, REQUIRED_STAGING_SUITES, "staging suite runs");
  for (const suite of REQUIRED_STAGING_SUITES) {
    const run = suiteRuns[suite];
    exactFields(
      run,
      [
        "repository",
        "runUrl",
        "sourceSha",
        "conclusion",
        "stepsExecuted",
        "evidenceSha256",
        "completedAt",
      ],
      `${suite} run`,
    );
    if (!REPOSITORIES.has(run.repository)) {
      throw new Error(`Staging suite repository is invalid: ${suite}`);
    }
    const expectedSourceSha =
      run.repository === "Ablankpaper/aera-cloud"
        ? releaseInputs.cloud.sourceSha
        : run.repository === "Ablankpaper/aera-admin"
          ? releaseInputs.admin.sourceSha
          : releaseInputs.desktop.sourceSha;
    if (
      run.sourceSha !== expectedSourceSha ||
      run.conclusion !== "success" ||
      !Number.isSafeInteger(run.stepsExecuted) ||
      run.stepsExecuted <= 0 ||
      !DIGEST_PATTERN.test(run.evidenceSha256 ?? "")
    ) {
      if (run.stepsExecuted === 0) {
        throw new Error(`Staging suite executed no real steps: ${suite}`);
      }
      throw new Error(`Staging suite run did not succeed: ${suite}`);
    }
    validateRunURL(run.runUrl, run.repository);
    const runCompletedAt = parseTime(
      run.completedAt,
      `${suite} completion time`,
    );
    if (runCompletedAt.getTime() > completedAt.getTime()) {
      throw new Error(`Staging suite completed after the manifest: ${suite}`);
    }
  }
}

function validateScenarioResults(results) {
  exactFields(results, REQUIRED_STAGING_SCENARIOS, "staging scenario results");
  if (REQUIRED_STAGING_SCENARIOS.some((name) => results[name] !== true)) {
    throw new Error("Every required staging scenario must pass");
  }
}

function validateRecoveryEvidence(recovery) {
  exactFields(
    recovery,
    [
      "encryptedDatabaseBackupSha256",
      "disposableRestoreVerified",
      "objectInventorySha256",
      "committedRowsReconciled",
      "orphanObjectCount",
      "missingObjectCount",
      "rollbackDrillVerified",
    ],
    "staging recovery evidence",
  );
  if (
    !DIGEST_PATTERN.test(recovery.encryptedDatabaseBackupSha256 ?? "") ||
    recovery.disposableRestoreVerified !== true
  ) {
    throw new Error(
      "Disposable encrypted database restore evidence is missing",
    );
  }
  if (
    !DIGEST_PATTERN.test(recovery.objectInventorySha256 ?? "") ||
    recovery.committedRowsReconciled !== true ||
    recovery.orphanObjectCount !== 0 ||
    recovery.missingObjectCount !== 0
  ) {
    throw new Error("Backup metadata and object reconciliation did not pass");
  }
  if (recovery.rollbackDrillVerified !== true) {
    throw new Error("Staging rollback drill evidence is missing");
  }
}

function validateHTTPSOrigin(value, label) {
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.pathname !== "/" ||
      parsed.search !== "" ||
      parsed.hash !== "" ||
      !safeHostname(parsed.hostname)
    ) {
      throw new Error();
    }
  } catch {
    throw new Error(
      `${label} must be a trusted DNS HTTPS origin, not a raw IP`,
    );
  }
}

function validateRunURL(value, repository) {
  const expected = new RegExp(
    `^https://github\\.com/${escapeRegex(repository)}/actions/runs/[1-9][0-9]*$`,
    "u",
  );
  if (typeof value !== "string" || !expected.test(value)) {
    throw new Error("Staging suite run URL is invalid");
  }
}

function validateRedactedURL(value, label) {
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.search !== "" ||
      parsed.hash !== "" ||
      parsed.pathname === "/" ||
      !safeHostname(parsed.hostname)
    ) {
      throw new Error();
    }
  } catch {
    throw new Error(`${label} must be a redacted HTTPS URL`);
  }
}

function safeHostname(hostname) {
  return (
    isIP(hostname) === 0 &&
    hostname !== "localhost" &&
    !hostname.endsWith(".local") &&
    hostname.includes(".")
  );
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function parseTime(value, label) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(value)
  ) {
    throw new Error(`${label} is invalid`);
  }
  const parsed = new Date(value);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().replace(".000Z", "Z") !== value
  ) {
    throw new Error(`${label} is invalid`);
  }
  return parsed;
}

function exactFields(value, expected, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.join("\n") !== wanted.join("\n")) {
    throw new Error(`${label} fields are incomplete or unexpected`);
  }
}

function parseOptions(arguments_) {
  if (arguments_.length === 0 || arguments_.length % 2 !== 0) {
    throw new Error("Staging verifier options must be flag/value pairs");
  }
  const values = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error("Staging verifier options must be flag/value pairs");
    }
    const key = flag.slice(2).replaceAll("-", "_");
    if (Object.hasOwn(values, key))
      throw new Error(`Duplicate option: ${flag}`);
    values[key] = value;
  }
  return values;
}

function decodeSignature(value) {
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9+/]{86}==$/u.test(trimmed)) {
    throw new Error("Staging signature file is not canonical base64");
  }
  const decoded = Buffer.from(trimmed, "base64");
  if (decoded.length !== 64 || decoded.toString("base64") !== trimmed) {
    throw new Error("Staging signature file is invalid");
  }
  return decoded;
}

async function runCLI(argv) {
  const [evidencePath, ...rest] = argv;
  if (!evidencePath) {
    throw new Error(
      "usage: verify-staging-evidence.mjs EVIDENCE --cloud-image-digest DIGEST --admin-image-digest DIGEST --desktop-candidate-manifest-sha256 DIGEST --cloud-source-sha SHA --admin-source-sha SHA --desktop-source-sha SHA --public-key KEY --signature SIGNATURE",
    );
  }
  const options = parseOptions(rest);
  const [raw, publicKey, signatureText] = await Promise.all([
    readFile(evidencePath, "utf8"),
    readFile(options.public_key, "utf8"),
    readFile(options.signature, "utf8"),
  ]);
  const document = JSON.parse(raw);
  if (raw !== canonicalJSONStringify(document)) {
    throw new Error("Staging evidence is not canonical JSON");
  }
  validateStagingEvidence(document, {
    cloudImageDigest: options.cloud_image_digest,
    adminImageDigest: options.admin_image_digest,
    desktopCandidateManifestSha256: options.desktop_candidate_manifest_sha256,
    cloudSourceSha: options.cloud_source_sha,
    adminSourceSha: options.admin_source_sha,
    desktopSourceSha: options.desktop_source_sha,
  });
  verifyStagingEvidenceSignature(
    document,
    publicKey,
    decodeSignature(signatureText),
  );
  process.stdout.write(
    `Private-staging evidence verified for ${document.releaseInputs.desktop.sourceSha}\n`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  runCLI(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `Private-staging evidence verification failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
