/* eslint-disable @typescript-eslint/explicit-function-return-type */

import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { parse as parseYAML } from "yaml";

import { canonicalJSONStringify } from "./candidate-manifest.mjs";
import {
  PRESERVED_ROLLBACK_HASHES,
  REQUIRED_ROLLBACK_FAILURE_MODES,
  rollbackSigningKeyId,
  validateRollbackEvidence,
  verifyRollbackEvidenceSignature,
} from "./verify-rollback-evidence.mjs";

const CLOUD_CURRENT_SHA = "a".repeat(40);
const CLOUD_PREVIOUS_SHA = "b".repeat(40);
const ADMIN_CURRENT_SHA = "c".repeat(40);
const ADMIN_PREVIOUS_SHA = "d".repeat(40);
const DESKTOP_SHA = "e".repeat(40);
const CLOUD_CURRENT_DIGEST = `sha256:${"1".repeat(64)}`;
const CLOUD_PREVIOUS_DIGEST = `sha256:${"2".repeat(64)}`;
const ADMIN_CURRENT_DIGEST = `sha256:${"3".repeat(64)}`;
const ADMIN_PREVIOUS_DIGEST = `sha256:${"4".repeat(64)}`;
const DESKTOP_MANIFEST_SHA256 = "5".repeat(64);
const NOW = new Date("2026-07-23T23:30:00Z");

test("accepts one signed rollback rehearsal bound to exact candidates", () => {
  const keys = generateKeyPairSync("ed25519");
  const document = evidence(keys.publicKey);
  assert.doesNotThrow(() => validate(document));
  const signature = sign(
    null,
    Buffer.from(canonicalJSONStringify(document)),
    keys.privateKey,
  );
  assert.doesNotThrow(() =>
    verifyRollbackEvidenceSignature(document, keys.publicKey, signature),
  );
});

test("requires encrypted backup and disposable restore before the drill", () => {
  const keys = generateKeyPairSync("ed25519");
  const noRestore = evidence(keys.publicKey);
  noRestore.databaseProtection.disposableRestoreVerified = false;
  assert.throws(() => validate(noRestore), /restore|backup/iu);

  const lateBackup = evidence(keys.publicKey);
  lateBackup.databaseProtection.backupCompletedAt = "2026-07-23T22:05:00Z";
  assert.throws(() => validate(lateBackup), /before|backup/iu);

  const downMigration = evidence(keys.publicKey);
  downMigration.databaseProtection.downMigrationExecuted = true;
  assert.throws(() => validate(downMigration), /down migration|schema/iu);
});

test("requires signed compatible previous digests and restoration to current", () => {
  const keys = generateKeyPairSync("ed25519");
  for (const mutate of [
    (document) => {
      document.services.cloud.previousSignatureVerified = false;
    },
    (document) => {
      document.services.admin.previousSchemaCompatible = false;
    },
    (document) => {
      document.services.cloud.currentDigestAfter =
        document.services.cloud.previousDigestDuring;
    },
    (document) => {
      document.services.admin.healthAfterRestore = false;
    },
  ]) {
    const malformed = evidence(keys.publicKey);
    mutate(malformed);
    assert.throws(
      () => validate(malformed),
      /signature|schema|digest|restore|health/iu,
    );
  }
});

test("requires append-only Agent rollback and a higher signed Desktop correction", () => {
  const keys = generateKeyPairSync("ed25519");
  const rebound = evidence(keys.publicKey);
  rebound.officialAgentControl.existingRuntimeBindingAfterSha256 = "9".repeat(
    64,
  );
  assert.throws(() => validate(rebound), /RuntimeBinding/iu);

  const rewritten = evidence(keys.publicKey);
  rewritten.desktopResponse.existingTagRewritten = true;
  assert.throws(() => validate(rewritten), /tag|Desktop/iu);

  const unsigned = evidence(keys.publicKey);
  unsigned.desktopResponse.correctiveCandidateSigned = false;
  assert.throws(() => validate(unsigned), /signed|Desktop/iu);

  const lowerVersion = evidence(keys.publicKey);
  lowerVersion.desktopResponse.correctiveVersion = "0.7.3";
  assert.throws(() => validate(lowerVersion), /higher|version|Desktop/iu);
});

test("requires ciphertext inventory and client decryption proof", () => {
  const keys = generateKeyPairSync("ed25519");
  const missingObject = evidence(keys.publicKey);
  missingObject.objectProtection.missingObjectCount = 1;
  assert.throws(() => validate(missingObject), /object|reconcil/iu);

  const noDecrypt = evidence(keys.publicKey);
  noDecrypt.objectProtection.clientDecryptionVerified = false;
  assert.throws(() => validate(noDecrypt), /decrypt|ciphertext/iu);

  const plaintext = evidence(keys.publicKey);
  plaintext.objectProtection.serverPlaintextObserved = true;
  assert.throws(() => validate(plaintext), /plaintext|server/iu);
});

test("requires every failure mode to fail closed without learning damage", () => {
  const keys = generateKeyPairSync("ed25519");
  const missing = evidence(keys.publicKey);
  delete missing.failureModes.incompleteBackupCleanup;
  assert.throws(() => validate(missing), /failure mode|field/iu);

  const unsafe = evidence(keys.publicKey);
  unsafe.failureModes.adminCloudMTLSFailure.operationRejected = false;
  assert.throws(() => validate(unsafe), /fail closed|failure mode/iu);

  const interrupted = evidence(keys.publicKey);
  interrupted.failureModes.objectStoreOutage.chatContinued = false;
  assert.throws(() => validate(interrupted), /chat|failure mode/iu);
});

test("requires every preserved Profile and learning hash to remain identical", () => {
  const keys = generateKeyPairSync("ed25519");
  const changed = evidence(keys.publicKey);
  changed.preservedState.digests.memory.after = "8".repeat(64);
  assert.throws(() => validate(changed), /preserved|Memory|digest/iu);

  const privateField = evidence(keys.publicKey);
  privateField.profilePath = "/Users/example/.hermes";
  assert.throws(() => validate(privateField), /field|unexpected/iu);
});

test("requires successful real runs and ordered timestamps", () => {
  const keys = generateKeyPairSync("ed25519");
  const noSteps = evidence(keys.publicKey);
  noSteps.services.cloud.run.stepsExecuted = 0;
  assert.throws(() => validate(noSteps), /steps|run/iu);

  const searchURL = evidence(keys.publicKey);
  searchURL.desktopResponse.run.runUrl =
    "https://github.com/Ablankpaper/aera/actions?query=rollback";
  assert.throws(() => validate(searchURL), /run URL/iu);

  const future = evidence(keys.publicKey);
  future.completedAt = "2026-07-24T00:30:00Z";
  assert.throws(() => validate(future), /future|completion/iu);
});

test("Cloud and Admin workflows support protected staging restore rehearsal", async () => {
  const workflows = [
    {
      label: "cloud",
      path: join(
        import.meta.dirname,
        "..",
        "..",
        "..",
        "..",
        "..",
        "aera-cloud",
        ".worktrees",
        "official-quality-v1",
        ".github",
        "workflows",
        "rollback-production.yml",
      ),
    },
    {
      label: "admin",
      path: join(
        import.meta.dirname,
        "..",
        "..",
        "..",
        "..",
        "..",
        "aera-admin",
        ".worktrees",
        "official-quality-v1",
        ".github",
        "workflows",
        "rollback-production.yml",
      ),
    },
  ];
  for (const workflow of workflows) {
    const raw = await readFile(workflow.path, "utf8");
    parseYAML(raw);
    assert.match(raw, /target_environment/u, workflow.label);
    assert.match(raw, /restore_current_after_rehearsal/u, workflow.label);
    assert.match(raw, /current_candidate_run_id/u, workflow.label);
    assert.match(
      raw,
      /AERA_RELEASE_REHEARSAL_RESTORE_CURRENT/u,
      workflow.label,
    );
    assert.match(raw, /rehearsal-restore-evidence\.json/u, workflow.label);
    assert.match(raw, /environment: \$\{\{ inputs\.target_environment \}\}/u);
  }
});

function validate(document) {
  return validateRollbackEvidence(document, {
    cloudCurrentSourceSha: CLOUD_CURRENT_SHA,
    cloudCurrentImageDigest: CLOUD_CURRENT_DIGEST,
    cloudPreviousSourceSha: CLOUD_PREVIOUS_SHA,
    cloudPreviousImageDigest: CLOUD_PREVIOUS_DIGEST,
    adminCurrentSourceSha: ADMIN_CURRENT_SHA,
    adminCurrentImageDigest: ADMIN_CURRENT_DIGEST,
    adminPreviousSourceSha: ADMIN_PREVIOUS_SHA,
    adminPreviousImageDigest: ADMIN_PREVIOUS_DIGEST,
    desktopSourceSha: DESKTOP_SHA,
    desktopCandidateManifestSha256: DESKTOP_MANIFEST_SHA256,
    now: NOW,
  });
}

function evidence(publicKey) {
  const completedAt = "2026-07-23T23:00:00Z";
  const releaseInputs = {
    cloud: {
      current: imageCandidate(
        "Ablankpaper/aera-cloud",
        CLOUD_CURRENT_SHA,
        CLOUD_CURRENT_DIGEST,
        "6",
      ),
      previous: imageCandidate(
        "Ablankpaper/aera-cloud",
        CLOUD_PREVIOUS_SHA,
        CLOUD_PREVIOUS_DIGEST,
        "7",
      ),
    },
    admin: {
      current: imageCandidate(
        "Ablankpaper/aera-admin",
        ADMIN_CURRENT_SHA,
        ADMIN_CURRENT_DIGEST,
        "8",
      ),
      previous: imageCandidate(
        "Ablankpaper/aera-admin",
        ADMIN_PREVIOUS_SHA,
        ADMIN_PREVIOUS_DIGEST,
        "9",
      ),
    },
    desktop: {
      repository: "Ablankpaper/aera",
      sourceSha: DESKTOP_SHA,
      version: "0.7.4",
      candidateManifestSha256: DESKTOP_MANIFEST_SHA256,
    },
  };
  return {
    schemaVersion: 1,
    environment: "private_staging",
    result: "passed",
    releaseInputs,
    drillWindow: {
      startedAt: "2026-07-23T22:00:00Z",
      completedAt: "2026-07-23T22:50:00Z",
    },
    databaseProtection: {
      encryptedBackupSha256: "a".repeat(64),
      backupCompletedAt: "2026-07-23T21:30:00Z",
      disposableRestoreVerified: true,
      disposableRestoreCompletedAt: "2026-07-23T21:45:00Z",
      forwardSchemaPreserved: true,
      downMigrationExecuted: false,
      additiveDataCreated: true,
      additiveDataReadableOnPrevious: true,
      additiveDataReadableAfterRestore: true,
    },
    objectProtection: {
      inventorySha256: "b".repeat(64),
      committedRowsReconciled: true,
      orphanObjectCount: 0,
      missingObjectCount: 0,
      ciphertextObjectReadVerified: true,
      clientDecryptionVerified: true,
      serverPlaintextObserved: false,
    },
    services: {
      cloud: serviceDrill({
        repository: "Ablankpaper/aera-cloud",
        sourceSha: CLOUD_CURRENT_SHA,
        runId: "4101",
        currentDigest: CLOUD_CURRENT_DIGEST,
        previousDigest: CLOUD_PREVIOUS_DIGEST,
        checks: {
          authReadVerified: true,
          officialAgentReadVerified: true,
          qualityReadVerified: true,
          encryptedBackupReadVerified: true,
        },
      }),
      admin: serviceDrill({
        repository: "Ablankpaper/aera-admin",
        sourceSha: ADMIN_CURRENT_SHA,
        runId: "4102",
        currentDigest: ADMIN_CURRENT_DIGEST,
        previousDigest: ADMIN_PREVIOUS_DIGEST,
        checks: {
          browserAuthVerified: true,
          cloudDualAuthenticationVerified: true,
          rbacVerified: true,
          auditReadVerified: true,
          mutationsDisabled: true,
        },
      }),
    },
    officialAgentControl: {
      v2Activated: true,
      pauseVerified: true,
      appendOnlyRollbackToV1: true,
      immutableReleaseHistoryPreserved: true,
      existingRuntimeBindingBeforeSha256: "c".repeat(64),
      existingRuntimeBindingAfterSha256: "c".repeat(64),
      existingSessionContinued: true,
      newRuntimeBindingUsesRollbackRelease: true,
      evidenceSha256: "d".repeat(64),
      evidenceUrl:
        "https://evidence.staging.example.test/rollback/official-agent",
    },
    desktopResponse: {
      run: successfulRun(
        "Ablankpaper/aera",
        DESKTOP_SHA,
        "4103",
        "2026-07-23T22:48:00Z",
      ),
      badCandidateVersion: "0.7.4",
      correctiveVersion: "0.7.5",
      badCandidatePublicationStopped: true,
      updateMetadataWithdrawn: true,
      existingTagRewritten: false,
      unsignedDowngradeServed: false,
      correctiveVersionHigher: true,
      correctiveCandidateSigned: true,
      macOSNotarizationVerified: true,
      windowsAuthenticodeTimestampVerified: true,
    },
    failureModes: Object.fromEntries(
      REQUIRED_ROLLBACK_FAILURE_MODES.map((name, index) => [
        name,
        {
          triggerObserved: true,
          operationRejected: true,
          unsafeStatePublished: false,
          chatContinued: true,
          localLearningUnchanged: true,
          evidenceSha256: String(index + 1).repeat(64),
          evidenceUrl: `https://evidence.staging.example.test/rollback/${name}`,
        },
      ]),
    ),
    preservedState: {
      digests: Object.fromEntries(
        PRESERVED_ROLLBACK_HASHES.map((name, index) => {
          const digest = String((index % 9) + 1).repeat(64);
          return [name, { before: digest, after: digest }];
        }),
      ),
      hermesLearningInterrupted: false,
      runtimeCheckoutChanged: false,
      unrelatedBytesChanged: false,
    },
    approver: {
      identityRef: "employee:staging-release-owner",
      responsibility: "rollback_rehearsal_approver",
      approvedAt: "2026-07-23T21:00:00Z",
    },
    signingKeyId: rollbackSigningKeyId(publicKey),
    completedAt,
  };
}

function imageCandidate(repository, sourceSha, imageDigest, marker) {
  return {
    repository,
    sourceSha,
    imageDigest,
    candidateManifestSha256: marker.repeat(64),
  };
}

function serviceDrill({
  repository,
  sourceSha,
  runId,
  currentDigest,
  previousDigest,
  checks,
}) {
  return {
    run: successfulRun(repository, sourceSha, runId, "2026-07-23T22:45:00Z"),
    currentDigestBefore: currentDigest,
    previousDigestDuring: previousDigest,
    currentDigestAfter: currentDigest,
    previousSignatureVerified: true,
    previousSchemaCompatible: true,
    downMigrationExecuted: false,
    healthBefore: true,
    healthOnPrevious: true,
    healthAfterRestore: true,
    checks,
  };
}

function successfulRun(repository, sourceSha, runId, completedAt) {
  return {
    repository,
    runUrl: `https://github.com/${repository}/actions/runs/${runId}`,
    sourceSha,
    conclusion: "success",
    stepsExecuted: 12,
    evidenceSha256: "f".repeat(64),
    completedAt,
  };
}

assert.deepEqual(REQUIRED_ROLLBACK_FAILURE_MODES, [
  "objectStoreOutage",
  "adminCloudMTLSFailure",
  "expiredSigningEvidence",
  "failedNotarization",
  "incompleteBackupCleanup",
]);
assert.deepEqual(PRESERVED_ROLLBACK_HASHES, [
  "profile",
  "memory",
  "user",
  "session",
  "learnedSkill",
  "curator",
  "publishedProjection",
  "runtimeBinding",
]);
