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

export const REQUIRED_ROLLBACK_FAILURE_MODES = Object.freeze([
  "objectStoreOutage",
  "adminCloudMTLSFailure",
  "expiredSigningEvidence",
  "failedNotarization",
  "incompleteBackupCleanup",
]);

export const PRESERVED_ROLLBACK_HASHES = Object.freeze([
  "profile",
  "memory",
  "user",
  "session",
  "learnedSkill",
  "curator",
  "publishedProjection",
  "runtimeBinding",
]);

const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const IMAGE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+$/u;
const SIGNING_KEY_PATTERN = /^ed25519:[0-9a-f]{64}$/u;
const APPROVER_PATTERN =
  /^(?:employee|contractor):[A-Za-z0-9][A-Za-z0-9._-]{1,99}$/u;

export function rollbackSigningKeyId(publicKey) {
  const key = asPublicKey(publicKey);
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error("Rollback evidence key must be Ed25519");
  }
  return `ed25519:${createHash("sha256")
    .update(key.export({ format: "der", type: "spki" }))
    .digest("hex")}`;
}

export function verifyRollbackEvidenceSignature(
  document,
  publicKey,
  signature,
) {
  const key = asPublicKey(publicKey);
  const signatureBytes = Buffer.isBuffer(signature)
    ? signature
    : Buffer.from(signature);
  if (
    document?.signingKeyId !== rollbackSigningKeyId(key) ||
    signatureBytes.length !== 64 ||
    !verifySignature(
      null,
      Buffer.from(canonicalJSONStringify(document)),
      key,
      signatureBytes,
    )
  ) {
    throw new Error("Rollback evidence signature is invalid");
  }
  return true;
}

function asPublicKey(value) {
  return value?.type === "public" ? value : createPublicKey(value);
}

export function validateRollbackEvidence(document, options) {
  exactFields(
    document,
    [
      "schemaVersion",
      "environment",
      "result",
      "releaseInputs",
      "drillWindow",
      "databaseProtection",
      "objectProtection",
      "services",
      "officialAgentControl",
      "desktopResponse",
      "failureModes",
      "preservedState",
      "approver",
      "signingKeyId",
      "completedAt",
    ],
    "rollback evidence",
  );
  if (
    document.schemaVersion !== 1 ||
    document.environment !== "private_staging" ||
    document.result !== "passed"
  ) {
    throw new Error(
      "Rollback evidence schema, environment, or result is invalid",
    );
  }

  validateReleaseInputs(document.releaseInputs, options);
  const window = validateDrillWindow(document.drillWindow);
  validateDatabaseProtection(document.databaseProtection, window);
  validateObjectProtection(document.objectProtection);
  validateServices(document.services, document.releaseInputs, window);
  validateOfficialAgentControl(document.officialAgentControl);
  validateDesktopResponse(
    document.desktopResponse,
    document.releaseInputs.desktop,
    window,
  );
  validateFailureModes(document.failureModes);
  validatePreservedState(document.preservedState);
  validateApprover(document.approver, window.startedAt);

  if (!SIGNING_KEY_PATTERN.test(document.signingKeyId ?? "")) {
    throw new Error("Rollback signing key identity is invalid");
  }
  const completedAt = parseTime(
    document.completedAt,
    "rollback evidence completion time",
  );
  const now =
    options?.now instanceof Date && Number.isFinite(options.now.getTime())
      ? options.now
      : new Date();
  if (completedAt.getTime() > now.getTime() + 5 * 60 * 1000) {
    throw new Error("Rollback evidence completion time is in the future");
  }
  if (completedAt.getTime() < window.completedAt.getTime()) {
    throw new Error("Rollback evidence completed before the drill");
  }
  for (const run of [
    document.services.cloud.run,
    document.services.admin.run,
    document.desktopResponse.run,
  ]) {
    const runCompletedAt = parseTime(
      run.completedAt,
      "rollback run completion",
    );
    if (runCompletedAt.getTime() > completedAt.getTime()) {
      throw new Error("Rollback run completed after the evidence manifest");
    }
  }
  return document;
}

function validateReleaseInputs(inputs, options) {
  exactFields(inputs, ["cloud", "admin", "desktop"], "rollback release inputs");
  validateServiceCandidates(inputs.cloud, {
    repository: "bignormal/aera-cloud",
    currentSourceSha: options?.cloudCurrentSourceSha,
    currentImageDigest: options?.cloudCurrentImageDigest,
    previousSourceSha: options?.cloudPreviousSourceSha,
    previousImageDigest: options?.cloudPreviousImageDigest,
    label: "Cloud",
  });
  validateServiceCandidates(inputs.admin, {
    repository: "bignormal/aera-admin",
    currentSourceSha: options?.adminCurrentSourceSha,
    currentImageDigest: options?.adminCurrentImageDigest,
    previousSourceSha: options?.adminPreviousSourceSha,
    previousImageDigest: options?.adminPreviousImageDigest,
    label: "Admin",
  });
  exactFields(
    inputs.desktop,
    ["repository", "sourceSha", "version", "candidateManifestSha256"],
    "Desktop rollback input",
  );
  if (
    inputs.desktop.repository !== "bignormal/aera" ||
    inputs.desktop.sourceSha !== options?.desktopSourceSha ||
    !SHA_PATTERN.test(inputs.desktop.sourceSha ?? "") ||
    !VERSION_PATTERN.test(inputs.desktop.version ?? "") ||
    inputs.desktop.candidateManifestSha256 !==
      options?.desktopCandidateManifestSha256 ||
    !DIGEST_PATTERN.test(inputs.desktop.candidateManifestSha256 ?? "")
  ) {
    throw new Error("Desktop rollback candidate identity differs");
  }
}

function validateServiceCandidates(value, expected) {
  exactFields(
    value,
    ["current", "previous"],
    `${expected.label} rollback candidates`,
  );
  validateImageCandidate(value.current, {
    repository: expected.repository,
    sourceSha: expected.currentSourceSha,
    imageDigest: expected.currentImageDigest,
    label: `current ${expected.label}`,
  });
  validateImageCandidate(value.previous, {
    repository: expected.repository,
    sourceSha: expected.previousSourceSha,
    imageDigest: expected.previousImageDigest,
    label: `previous ${expected.label}`,
  });
  if (value.current.imageDigest === value.previous.imageDigest) {
    throw new Error(`${expected.label} rollback digests must differ`);
  }
}

function validateImageCandidate(value, expected) {
  exactFields(
    value,
    ["repository", "sourceSha", "imageDigest", "candidateManifestSha256"],
    `${expected.label} image candidate`,
  );
  if (
    value.repository !== expected.repository ||
    value.sourceSha !== expected.sourceSha ||
    value.imageDigest !== expected.imageDigest ||
    !SHA_PATTERN.test(value.sourceSha ?? "") ||
    !IMAGE_DIGEST_PATTERN.test(value.imageDigest ?? "") ||
    !DIGEST_PATTERN.test(value.candidateManifestSha256 ?? "")
  ) {
    throw new Error(`${expected.label} candidate digest or source differs`);
  }
}

function validateDrillWindow(value) {
  exactFields(value, ["startedAt", "completedAt"], "rollback drill window");
  const startedAt = parseTime(value.startedAt, "rollback drill start");
  const completedAt = parseTime(value.completedAt, "rollback drill completion");
  if (completedAt.getTime() <= startedAt.getTime()) {
    throw new Error("Rollback drill completion must follow its start");
  }
  return { startedAt, completedAt };
}

function validateDatabaseProtection(value, window) {
  exactFields(
    value,
    [
      "encryptedBackupSha256",
      "backupCompletedAt",
      "disposableRestoreVerified",
      "disposableRestoreCompletedAt",
      "forwardSchemaPreserved",
      "downMigrationExecuted",
      "additiveDataCreated",
      "additiveDataReadableOnPrevious",
      "additiveDataReadableAfterRestore",
    ],
    "rollback database protection",
  );
  const backupAt = parseTime(value.backupCompletedAt, "backup completion");
  const restoreAt = parseTime(
    value.disposableRestoreCompletedAt,
    "disposable restore completion",
  );
  if (
    !DIGEST_PATTERN.test(value.encryptedBackupSha256 ?? "") ||
    value.disposableRestoreVerified !== true ||
    value.forwardSchemaPreserved !== true ||
    value.downMigrationExecuted !== false ||
    value.additiveDataCreated !== true ||
    value.additiveDataReadableOnPrevious !== true ||
    value.additiveDataReadableAfterRestore !== true
  ) {
    throw new Error(
      "Rollback backup, restore, or forward-only schema proof is incomplete",
    );
  }
  if (
    backupAt.getTime() > restoreAt.getTime() ||
    restoreAt.getTime() > window.startedAt.getTime()
  ) {
    throw new Error(
      "Encrypted backup and disposable restore must complete before the drill",
    );
  }
}

function validateObjectProtection(value) {
  exactFields(
    value,
    [
      "inventorySha256",
      "committedRowsReconciled",
      "orphanObjectCount",
      "missingObjectCount",
      "ciphertextObjectReadVerified",
      "clientDecryptionVerified",
      "serverPlaintextObserved",
    ],
    "rollback object protection",
  );
  if (
    !DIGEST_PATTERN.test(value.inventorySha256 ?? "") ||
    value.committedRowsReconciled !== true ||
    value.orphanObjectCount !== 0 ||
    value.missingObjectCount !== 0 ||
    value.ciphertextObjectReadVerified !== true ||
    value.clientDecryptionVerified !== true ||
    value.serverPlaintextObserved !== false
  ) {
    throw new Error(
      "Ciphertext object reconciliation, client decryption, or server plaintext proof is incomplete",
    );
  }
}

function validateServices(services, releaseInputs, window) {
  exactFields(services, ["cloud", "admin"], "rollback service drills");
  validateServiceDrill(services.cloud, {
    repository: "bignormal/aera-cloud",
    sourceSha: releaseInputs.cloud.current.sourceSha,
    currentDigest: releaseInputs.cloud.current.imageDigest,
    previousDigest: releaseInputs.cloud.previous.imageDigest,
    checks: [
      "authReadVerified",
      "officialAgentReadVerified",
      "qualityReadVerified",
      "encryptedBackupReadVerified",
    ],
    label: "Cloud",
    window,
  });
  validateServiceDrill(services.admin, {
    repository: "bignormal/aera-admin",
    sourceSha: releaseInputs.admin.current.sourceSha,
    currentDigest: releaseInputs.admin.current.imageDigest,
    previousDigest: releaseInputs.admin.previous.imageDigest,
    checks: [
      "browserAuthVerified",
      "cloudDualAuthenticationVerified",
      "rbacVerified",
      "auditReadVerified",
      "mutationsDisabled",
    ],
    label: "Admin",
    window,
  });
}

function validateServiceDrill(value, expected) {
  exactFields(
    value,
    [
      "run",
      "currentDigestBefore",
      "previousDigestDuring",
      "currentDigestAfter",
      "previousSignatureVerified",
      "previousSchemaCompatible",
      "downMigrationExecuted",
      "healthBefore",
      "healthOnPrevious",
      "healthAfterRestore",
      "checks",
    ],
    `${expected.label} rollback drill`,
  );
  validateSuccessfulRun(value.run, {
    repository: expected.repository,
    sourceSha: expected.sourceSha,
    label: expected.label,
    window: expected.window,
  });
  if (
    value.currentDigestBefore !== expected.currentDigest ||
    value.previousDigestDuring !== expected.previousDigest ||
    value.currentDigestAfter !== expected.currentDigest
  ) {
    throw new Error(`${expected.label} rollback digest restoration differs`);
  }
  if (
    value.previousSignatureVerified !== true ||
    value.previousSchemaCompatible !== true ||
    value.downMigrationExecuted !== false ||
    value.healthBefore !== true ||
    value.healthOnPrevious !== true ||
    value.healthAfterRestore !== true
  ) {
    throw new Error(
      `${expected.label} signature, schema, or health proof is incomplete`,
    );
  }
  exactFields(value.checks, expected.checks, `${expected.label} read checks`);
  if (expected.checks.some((field) => value.checks[field] !== true)) {
    throw new Error(`${expected.label} rollback read checks are incomplete`);
  }
}

function validateSuccessfulRun(value, expected) {
  exactFields(
    value,
    [
      "repository",
      "runUrl",
      "sourceSha",
      "conclusion",
      "stepsExecuted",
      "evidenceSha256",
      "completedAt",
    ],
    `${expected.label} rollback run`,
  );
  if (
    value.repository !== expected.repository ||
    value.sourceSha !== expected.sourceSha ||
    value.conclusion !== "success" ||
    !Number.isSafeInteger(value.stepsExecuted) ||
    value.stepsExecuted <= 0 ||
    !DIGEST_PATTERN.test(value.evidenceSha256 ?? "")
  ) {
    throw new Error(`${expected.label} rollback run did not execute`);
  }
  validateRunURL(value.runUrl, expected.repository);
  const completedAt = parseTime(
    value.completedAt,
    `${expected.label} rollback run completion`,
  );
  if (
    expected.window &&
    (completedAt.getTime() < expected.window.startedAt.getTime() ||
      completedAt.getTime() > expected.window.completedAt.getTime())
  ) {
    throw new Error(
      `${expected.label} rollback run is outside the drill window`,
    );
  }
}

function validateOfficialAgentControl(value) {
  exactFields(
    value,
    [
      "v2Activated",
      "pauseVerified",
      "appendOnlyRollbackToV1",
      "immutableReleaseHistoryPreserved",
      "existingRuntimeBindingBeforeSha256",
      "existingRuntimeBindingAfterSha256",
      "existingSessionContinued",
      "newRuntimeBindingUsesRollbackRelease",
      "evidenceSha256",
      "evidenceUrl",
    ],
    "official Agent rollback control",
  );
  if (
    value.v2Activated !== true ||
    value.pauseVerified !== true ||
    value.appendOnlyRollbackToV1 !== true ||
    value.immutableReleaseHistoryPreserved !== true ||
    value.existingSessionContinued !== true ||
    value.newRuntimeBindingUsesRollbackRelease !== true ||
    !DIGEST_PATTERN.test(value.existingRuntimeBindingBeforeSha256 ?? "") ||
    value.existingRuntimeBindingAfterSha256 !==
      value.existingRuntimeBindingBeforeSha256 ||
    !DIGEST_PATTERN.test(value.evidenceSha256 ?? "")
  ) {
    throw new Error(
      "Official Agent pause, append-only rollback, or RuntimeBinding proof is incomplete",
    );
  }
  validateRedactedURL(value.evidenceUrl, "official Agent evidence URL");
}

function validateDesktopResponse(value, desktopInput, window) {
  exactFields(
    value,
    [
      "run",
      "badCandidateVersion",
      "correctiveVersion",
      "badCandidatePublicationStopped",
      "updateMetadataWithdrawn",
      "existingTagRewritten",
      "unsignedDowngradeServed",
      "correctiveVersionHigher",
      "correctiveCandidateSigned",
      "macOSNotarizationVerified",
      "windowsAuthenticodeTimestampVerified",
    ],
    "Desktop rollback response",
  );
  validateSuccessfulRun(value.run, {
    repository: "bignormal/aera",
    sourceSha: desktopInput.sourceSha,
    label: "Desktop",
    window,
  });
  if (
    value.badCandidateVersion !== desktopInput.version ||
    !VERSION_PATTERN.test(value.correctiveVersion ?? "") ||
    compareVersions(value.correctiveVersion, value.badCandidateVersion) <= 0 ||
    value.badCandidatePublicationStopped !== true ||
    value.updateMetadataWithdrawn !== true ||
    value.existingTagRewritten !== false ||
    value.unsignedDowngradeServed !== false ||
    value.correctiveVersionHigher !== true ||
    value.correctiveCandidateSigned !== true ||
    value.macOSNotarizationVerified !== true ||
    value.windowsAuthenticodeTimestampVerified !== true
  ) {
    throw new Error(
      "Desktop withdrawal or higher signed corrective-candidate proof is incomplete",
    );
  }
}

function compareVersions(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] - rightParts[index];
    }
  }
  return 0;
}

function validateFailureModes(value) {
  exactFields(value, REQUIRED_ROLLBACK_FAILURE_MODES, "rollback failure modes");
  for (const name of REQUIRED_ROLLBACK_FAILURE_MODES) {
    const result = value[name];
    exactFields(
      result,
      [
        "triggerObserved",
        "operationRejected",
        "unsafeStatePublished",
        "chatContinued",
        "localLearningUnchanged",
        "evidenceSha256",
        "evidenceUrl",
      ],
      `${name} failure mode`,
    );
    if (
      result.triggerObserved !== true ||
      result.operationRejected !== true ||
      result.unsafeStatePublished !== false ||
      result.chatContinued !== true ||
      result.localLearningUnchanged !== true ||
      !DIGEST_PATTERN.test(result.evidenceSha256 ?? "")
    ) {
      throw new Error(`Failure mode did not fail closed: ${name}`);
    }
    validateRedactedURL(result.evidenceUrl, `${name} evidence URL`);
  }
}

function validatePreservedState(value) {
  exactFields(
    value,
    [
      "digests",
      "hermesLearningInterrupted",
      "runtimeCheckoutChanged",
      "unrelatedBytesChanged",
    ],
    "rollback preserved state",
  );
  exactFields(
    value.digests,
    PRESERVED_ROLLBACK_HASHES,
    "rollback preserved hashes",
  );
  for (const name of PRESERVED_ROLLBACK_HASHES) {
    const pair = value.digests[name];
    exactFields(pair, ["before", "after"], `${name} preserved hash`);
    if (!DIGEST_PATTERN.test(pair.before ?? "") || pair.after !== pair.before) {
      throw new Error(`Preserved ${name} digest changed during rollback`);
    }
  }
  if (
    value.hermesLearningInterrupted !== false ||
    value.runtimeCheckoutChanged !== false ||
    value.unrelatedBytesChanged !== false
  ) {
    throw new Error("Rollback changed preserved Profile or learning state");
  }
}

function validateApprover(value, drillStartedAt) {
  exactFields(
    value,
    ["identityRef", "responsibility", "approvedAt"],
    "rollback rehearsal approver",
  );
  const approvedAt = parseTime(value.approvedAt, "rollback approval time");
  if (
    !APPROVER_PATTERN.test(value.identityRef ?? "") ||
    value.responsibility !== "rollback_rehearsal_approver" ||
    approvedAt.getTime() > drillStartedAt.getTime()
  ) {
    throw new Error("Rollback rehearsal approval is invalid");
  }
}

function validateRunURL(value, repository) {
  const expected = new RegExp(
    `^https://github\\.com/${escapeRegex(repository)}/actions/runs/[1-9][0-9]*$`,
    "u",
  );
  if (typeof value !== "string" || !expected.test(value)) {
    throw new Error("Rollback run URL is invalid");
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

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseOptions(arguments_) {
  if (arguments_.length === 0 || arguments_.length % 2 !== 0) {
    throw new Error("Rollback verifier options must be flag/value pairs");
  }
  const result = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error("Rollback verifier options must be flag/value pairs");
    }
    const name = flag.slice(2).replaceAll("-", "_");
    if (Object.hasOwn(result, name)) {
      throw new Error(`Duplicate rollback verifier option: ${flag}`);
    }
    result[name] = value;
  }
  return result;
}

async function runCLI(argv) {
  const values = parseOptions(argv);
  const raw = await readFile(resolve(values.evidence), "utf8");
  const document = JSON.parse(raw);
  if (raw !== canonicalJSONStringify(document)) {
    throw new Error("Rollback evidence is not canonical JSON");
  }
  if (
    !DIGEST_PATTERN.test(values.evidence_sha256 ?? "") ||
    sha256(Buffer.from(raw)) !== values.evidence_sha256
  ) {
    throw new Error("Rollback evidence SHA-256 differs");
  }
  validateRollbackEvidence(document, {
    cloudCurrentSourceSha: values.cloud_current_source_sha,
    cloudCurrentImageDigest: values.cloud_current_image_digest,
    cloudPreviousSourceSha: values.cloud_previous_source_sha,
    cloudPreviousImageDigest: values.cloud_previous_image_digest,
    adminCurrentSourceSha: values.admin_current_source_sha,
    adminCurrentImageDigest: values.admin_current_image_digest,
    adminPreviousSourceSha: values.admin_previous_source_sha,
    adminPreviousImageDigest: values.admin_previous_image_digest,
    desktopSourceSha: values.desktop_source_sha,
    desktopCandidateManifestSha256: values.desktop_candidate_manifest_sha256,
  });
  const signature = await readFile(resolve(values.signature));
  const publicKey = await readFile(resolve(values.public_key), "utf8");
  verifyRollbackEvidenceSignature(document, publicKey, signature);
  process.stdout.write(
    `${canonicalJSONStringify({
      status: "verified",
      evidenceSha256: values.evidence_sha256,
      completedAt: document.completedAt,
    })}`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  runCLI(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `Rollback evidence verification failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
