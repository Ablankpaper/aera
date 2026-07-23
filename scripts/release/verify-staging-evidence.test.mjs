/* eslint-disable @typescript-eslint/explicit-function-return-type */

import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";

import { canonicalJSONStringify } from "./candidate-manifest.mjs";
import {
  REQUIRED_STAGING_SCENARIOS,
  REQUIRED_STAGING_SUITES,
  stagingSigningKeyId,
  validateStagingEvidence,
  verifyStagingEvidenceSignature,
} from "./verify-staging-evidence.mjs";

const CLOUD_DIGEST = `sha256:${"1".repeat(64)}`;
const ADMIN_DIGEST = `sha256:${"2".repeat(64)}`;
const DESKTOP_MANIFEST_DIGEST = "3".repeat(64);
const CLOUD_SOURCE_SHA = "a".repeat(40);
const ADMIN_SOURCE_SHA = "b".repeat(40);
const DESKTOP_SOURCE_SHA = "c".repeat(40);
const NOW = new Date("2026-07-23T20:00:00Z");

test("accepts one signed private-staging manifest bound to all candidates", () => {
  const keys = generateKeyPairSync("ed25519");
  const document = evidence(keys.publicKey);
  assert.doesNotThrow(() => validate(document));
  const signature = sign(
    null,
    Buffer.from(canonicalJSONStringify(document)),
    keys.privateKey,
  );
  assert.doesNotThrow(() =>
    verifyStagingEvidenceSignature(document, keys.publicKey, signature),
  );
});

test("rejects schema and exact candidate identity drift", () => {
  const keys = generateKeyPairSync("ed25519");
  const badSchema = evidence(keys.publicKey);
  badSchema.schemaVersion = 2;
  assert.throws(() => validate(badSchema), /schema/u);

  for (const mutate of [
    (document) => {
      document.releaseInputs.cloud.imageDigest = `sha256:${"9".repeat(64)}`;
    },
    (document) => {
      document.releaseInputs.admin.imageDigest = `sha256:${"9".repeat(64)}`;
    },
    (document) => {
      document.releaseInputs.desktop.candidateManifestSha256 = "9".repeat(64);
    },
  ]) {
    const malformed = evidence(keys.publicKey);
    mutate(malformed);
    assert.throws(() => validate(malformed), /digest|candidate/u);
  }
});

test("rejects raw-IP origins or identity issuers", () => {
  const keys = generateKeyPairSync("ed25519");
  const rawOrigin = evidence(keys.publicKey);
  rawOrigin.finalStagingOrigin = "https://203.0.113.10";
  assert.throws(() => validate(rawOrigin), /origin|IP/u);

  const rawIssuer = evidence(keys.publicKey);
  rawIssuer.identityIssuer = "https://198.51.100.20";
  assert.throws(() => validate(rawIssuer), /issuer|IP/u);
});

test("rejects public registration, production credentials, or public services", () => {
  const keys = generateKeyPairSync("ed25519");
  const registration = evidence(keys.publicKey);
  registration.safety.publicRegistrationEnabled = true;
  assert.throws(() => validate(registration), /registration/u);

  const productionCredentials = evidence(keys.publicKey);
  productionCredentials.safety.productionProviderCredentialsPresent = true;
  assert.throws(() => validate(productionCredentials), /production provider/iu);

  const exposedAdmin = evidence(keys.publicKey);
  exposedAdmin.networkBoundary.internalAdminInternetReachable = true;
  assert.throws(() => validate(exposedAdmin), /private|Internet/u);
});

test("requires disposable restore, object reconciliation, and rollback drill", () => {
  const keys = generateKeyPairSync("ed25519");
  const missingRestore = evidence(keys.publicKey);
  missingRestore.recoveryEvidence.disposableRestoreVerified = false;
  assert.throws(() => validate(missingRestore), /restore/u);

  const missingObject = evidence(keys.publicKey);
  missingObject.recoveryEvidence.missingObjectCount = 1;
  assert.throws(() => validate(missingObject), /reconciliation|object/u);

  const missingRollback = evidence(keys.publicKey);
  missingRollback.recoveryEvidence.rollbackDrillVerified = false;
  assert.throws(() => validate(missingRollback), /rollback/u);
});

test("requires every successful real run URL with executed steps", () => {
  const keys = generateKeyPairSync("ed25519");
  const missingSuite = evidence(keys.publicKey);
  delete missingSuite.suiteRuns.release_control_rollback;
  assert.throws(() => validate(missingSuite), /suite/u);

  const failed = evidence(keys.publicKey);
  failed.suiteRuns.official_managed_agent.conclusion = "failure";
  assert.throws(() => validate(failed), /run|success/u);

  const noSteps = evidence(keys.publicKey);
  noSteps.suiteRuns.quality_governance.stepsExecuted = 0;
  assert.throws(() => validate(noSteps), /steps/u);

  const searchURL = evidence(keys.publicKey);
  searchURL.suiteRuns.auth_device_offline.runUrl =
    "https://github.com/bignormal/aera/actions?query=staging";
  assert.throws(() => validate(searchURL), /run URL/u);
});

test("rejects any failed or missing staging scenario", () => {
  const keys = generateKeyPairSync("ed25519");
  const failed = evidence(keys.publicKey);
  failed.scenarioResults.qualityThresholdSuppression = false;
  assert.throws(() => validate(failed), /scenario/u);

  const missing = evidence(keys.publicKey);
  delete missing.scenarioResults.backupAuthorizedAndPhraseRestore;
  assert.throws(() => validate(missing), /scenario/u);
});

test("rejects private fields and unredacted network evidence links", () => {
  const keys = generateKeyPairSync("ed25519");
  const privateField = evidence(keys.publicKey);
  privateField.profilePath = "/Users/example/.hermes";
  assert.throws(() => validate(privateField), /field|unexpected/u);

  const secretURL = evidence(keys.publicKey);
  secretURL.networkBoundary.evidenceUrl =
    "https://evidence.staging.example.test/network?token=secret";
  assert.throws(() => validate(secretURL), /redacted|URL/u);
});

test("rejects a signature from a different Ed25519 key", () => {
  const keys = generateKeyPairSync("ed25519");
  const other = generateKeyPairSync("ed25519");
  const document = evidence(keys.publicKey);
  const signature = sign(
    null,
    Buffer.from(canonicalJSONStringify(document)),
    other.privateKey,
  );
  assert.throws(
    () => verifyStagingEvidenceSignature(document, keys.publicKey, signature),
    /signature/u,
  );
});

function validate(document) {
  return validateStagingEvidence(document, {
    cloudImageDigest: CLOUD_DIGEST,
    adminImageDigest: ADMIN_DIGEST,
    desktopCandidateManifestSha256: DESKTOP_MANIFEST_DIGEST,
    cloudSourceSha: CLOUD_SOURCE_SHA,
    adminSourceSha: ADMIN_SOURCE_SHA,
    desktopSourceSha: DESKTOP_SOURCE_SHA,
    now: NOW,
  });
}

function evidence(publicKey) {
  const suiteRepositories = {
    auth_device_offline: "bignormal/aera",
    workspace_organization: "bignormal/aera",
    official_managed_agent: "bignormal/aera",
    quality_governance: "bignormal/aera-admin",
    encrypted_backup_migration: "bignormal/aera",
    admin_dual_auth_rbac_audit: "bignormal/aera-admin",
    database_restore_object_reconciliation: "bignormal/aera-cloud",
    release_control_rollback: "bignormal/aera-cloud",
  };
  return {
    schemaVersion: 1,
    environment: "private_staging",
    releaseInputs: {
      cloud: {
        repository: "bignormal/aera-cloud",
        sourceSha: CLOUD_SOURCE_SHA,
        imageDigest: CLOUD_DIGEST,
        candidateManifestSha256: "4".repeat(64),
      },
      admin: {
        repository: "bignormal/aera-admin",
        sourceSha: ADMIN_SOURCE_SHA,
        imageDigest: ADMIN_DIGEST,
        candidateManifestSha256: "5".repeat(64),
      },
      desktop: {
        repository: "bignormal/aera",
        sourceSha: DESKTOP_SOURCE_SHA,
        candidateManifestSha256: DESKTOP_MANIFEST_DIGEST,
      },
    },
    finalStagingOrigin: "https://desktop.staging.example.test",
    identityIssuer: "https://identity.staging.example.test",
    networkBoundary: {
      accessMode: "vpn",
      cloudPublicListenerInternetReachable: false,
      cloudPublicListenerAccessControlled: true,
      adminBrowserInternetReachable: false,
      internalAdminInternetReachable: false,
      internalAdminMTLSVerified: true,
      internalAdminServiceJWTVerified: true,
      postgresInternetReachable: false,
      redisInternetReachable: false,
      objectStoreInternetReachable: false,
      evidenceSha256: "6".repeat(64),
      evidenceUrl:
        "https://evidence.staging.example.test/runs/network-boundary-1234",
    },
    safety: {
      publicRegistrationEnabled: false,
      productionProviderCredentialsPresent: false,
      productionDataUsed: false,
      stagingOnlyKeysVerified: true,
    },
    testPopulation: {
      accountCount: 2,
      authorizedBackupDeviceCount: 3,
      desktopDeviceCount: 3,
    },
    suiteRuns: Object.fromEntries(
      REQUIRED_STAGING_SUITES.map((suite, index) => {
        const repository = suiteRepositories[suite];
        return [
          suite,
          {
            repository,
            runUrl: `https://github.com/${repository}/actions/runs/${3000 + index}`,
            sourceSha:
              repository === "bignormal/aera-cloud"
                ? CLOUD_SOURCE_SHA
                : repository === "bignormal/aera-admin"
                  ? ADMIN_SOURCE_SHA
                  : DESKTOP_SOURCE_SHA,
            conclusion: "success",
            stepsExecuted: 10 + index,
            evidenceSha256: String((index % 3) + 7).repeat(64),
            completedAt: `2026-07-23T1${index}:30:00Z`,
          },
        ];
      }),
    ),
    scenarioResults: Object.fromEntries(
      REQUIRED_STAGING_SCENARIOS.map((scenario) => [scenario, true]),
    ),
    recoveryEvidence: {
      encryptedDatabaseBackupSha256: "d".repeat(64),
      disposableRestoreVerified: true,
      objectInventorySha256: "e".repeat(64),
      committedRowsReconciled: true,
      orphanObjectCount: 0,
      missingObjectCount: 0,
      rollbackDrillVerified: true,
    },
    signingKeyId: stagingSigningKeyId(publicKey),
    completedAt: "2026-07-23T19:30:00Z",
  };
}

assert.deepEqual(REQUIRED_STAGING_SUITES, [
  "auth_device_offline",
  "workspace_organization",
  "official_managed_agent",
  "quality_governance",
  "encrypted_backup_migration",
  "admin_dual_auth_rbac_audit",
  "database_restore_object_reconciliation",
  "release_control_rollback",
]);
