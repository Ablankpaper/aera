/* eslint-disable @typescript-eslint/explicit-function-return-type */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import {
  INTERNAL_BETA_ARTIFACTS,
  INTERNAL_BETA_OIDC_ISSUER,
  INTERNAL_BETA_RUNTIME_SOURCE_SHA,
  INTERNAL_BETA_SIGNING_STATUS,
  INTERNAL_BETA_VERSION,
  INTERNAL_BETA_WORKFLOW_IDENTITY,
  canonicalJSONStringify,
} from "./manifest.mjs";
import {
  LIVE_OUTCOME_KEYS,
  parseAndValidateLiveEvidence,
  validateLiveEvidence,
  validateLiveEvidenceSchema,
} from "./verify-live-evidence.mjs";
import { BETA33_ACCEPTANCE_SCENARIOS } from "./verify-beta33-acceptance.mjs";

const DESKTOP_SHA = "a".repeat(40);
const CLOUD_SHA = "b".repeat(40);
const ADMIN_SHA = "c".repeat(40);
const CLOUD_DIGEST = `sha256:${"1".repeat(64)}`;
const ADMIN_DIGEST = `sha256:${"2".repeat(64)}`;
const DESKTOP_CI =
  "https://github.com/Ablankpaper/aera/actions/runs/30100000001";
const DESKTOP_CANDIDATE =
  "https://github.com/Ablankpaper/aera/actions/runs/30100000002";
const CLOUD_CI =
  "https://github.com/Ablankpaper/aera-cloud/actions/runs/30100000003";
const CLOUD_CANDIDATE =
  "https://github.com/Ablankpaper/aera-cloud/actions/runs/30100000004";
const ADMIN_CI =
  "https://github.com/Ablankpaper/aera-admin/actions/runs/30100000005";
const ADMIN_CANDIDATE =
  "https://github.com/Ablankpaper/aera-admin/actions/runs/30100000006";
const CREATED_AT = "2026-07-24T02:00:00Z";
const COMPLETED_AT = "2026-07-24T04:00:00Z";
const NOW = new Date("2026-07-24T05:00:00Z");
const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

const ACCEPTANCE_SUCCESS_SEQUENCE = [
  ["metadata", "started"],
  ["metadata", "succeeded"],
  ["verify", "started"],
  ["verify", "succeeded"],
  ["download", "started"],
  ["download", "succeeded"],
  ["verify", "started"],
  ["verify", "succeeded"],
  ["extract", "started"],
  ["extract", "succeeded"],
  ["stage", "started"],
  ["stage", "succeeded"],
  ["swap", "started"],
  ["swap", "succeeded"],
  ["launch", "started"],
  ["launch", "succeeded"],
  ["health", "started"],
  ["health", "succeeded"],
  ["finalize", "started"],
  ["finalize", "succeeded"],
];
const ACCEPTANCE_ROLLBACK_SEQUENCE = [
  ...ACCEPTANCE_SUCCESS_SEQUENCE.slice(0, -4),
  ["health", "started"],
  ["health", "failed", "update_health_timeout", "after_restart"],
  ["rollback", "started"],
  ["rollback", "rolled_back", "update_health_timeout", "after_restart"],
];

function acceptanceScenario(key, index, artifacts) {
  const isWindows = key.startsWith("windows_");
  const isBridge = key === "macos_beta29_manual_bridge";
  const isRollback = key.endsWith("health_failure_rollback");
  const sourceVersion = isBridge
    ? "0.7.4-internal-beta.29"
    : key.includes("beta31")
      ? "0.7.4-internal-beta.31"
      : "0.7.4-internal-beta.32";
  const artifactIndex = isBridge ? 0 : isWindows ? 4 : 1;
  const startedAt = new Date(
    Date.parse("2026-07-24T01:00:00Z") + index * 60_000,
  )
    .toISOString()
    .replace(".000Z", "Z");
  const operationId = `019f0000-0000-4000-8000-${String(index + 33).padStart(12, "0")}`;
  const diagnosticId = (index + 1).toString(16).padStart(12, "0");
  const sequence = isRollback
    ? ACCEPTANCE_ROLLBACK_SEQUENCE
    : ACCEPTANCE_SUCCESS_SEQUENCE;
  const timeline = isBridge
    ? []
    : sequence.map(
        (
          [stage, state, code = null, retryability = "not_retryable"],
          eventIndex,
        ) => ({
          at: new Date(Date.parse(startedAt) + eventIndex * 1_000)
            .toISOString()
            .replace(".000Z", "Z"),
          schemaVersion: 2,
          operationId,
          stage,
          state,
          code,
          retryability,
          diagnosticId,
          targetVersion:
            stage === "metadata" && eventIndex < 2
              ? null
              : "0.7.4-internal-beta.33",
        }),
      );
  return {
    platform: isWindows ? "win32" : "darwin",
    architecture: isWindows ? "x64" : "arm64",
    environment: isRollback ? "isolated_ci" : "physical",
    sourceVersion,
    targetVersion: "0.7.4-internal-beta.33",
    method: isBridge
      ? "manual_dmg_bridge"
      : isRollback
        ? "injected_health_failure"
        : "online_update",
    installedArtifact: {
      name: artifacts[artifactIndex].name,
      sha256: artifacts[artifactIndex].sha256,
    },
    executableSha256: String((index % 8) + 1).repeat(64),
    protectedUserDataBeforeSha256: "c".repeat(64),
    protectedUserDataAfterSha256: "c".repeat(64),
    startupPassed: true,
    modelSavePassed: true,
    startedAt,
    completedAt: new Date(Date.parse(startedAt) + 30_000)
      .toISOString()
      .replace(".000Z", "Z"),
    operationId: isBridge ? null : operationId,
    diagnosticId: isBridge ? null : diagnosticId,
    timeline,
    evidenceFileDigests: {
      modelSave: String((index % 7) + 1).repeat(64),
      processLog: String(((index + 1) % 7) + 1).repeat(64),
      updateTimeline: String(((index + 2) % 7) + 1).repeat(64),
    },
  };
}

function buildAcceptanceLedger(desktopManifestRaw, artifacts) {
  return canonicalJSONStringify({
    schemaVersion: 1,
    status: "BETA33_ACCEPTED",
    candidate: {
      repository: "Ablankpaper/aera",
      sourceSha: DESKTOP_SHA,
      version: INTERNAL_BETA_VERSION,
      manifestSha256: digest(desktopManifestRaw),
    },
    scenarios: Object.fromEntries(
      BETA33_ACCEPTANCE_SCENARIOS.map((key, index) => [
        key,
        acceptanceScenario(key, index, artifacts),
      ]),
    ),
    completedAt: "2026-07-24T03:00:00Z",
  });
}

async function fixture() {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "aera-live-evidence-fixture-"),
  );
  temporaryRoots.push(root);
  const artifactsDirectory = path.join(root, "artifacts");
  await mkdir(artifactsDirectory);
  const artifacts = [];
  for (let index = 0; index < INTERNAL_BETA_ARTIFACTS.length; index += 1) {
    const specification = INTERNAL_BETA_ARTIFACTS[index];
    const bytes = Buffer.alloc(128 + index, index + 1);
    await writeFile(path.join(artifactsDirectory, specification.name), bytes);
    artifacts.push({
      ...specification,
      sha256: digest(bytes),
      size: bytes.length,
    });
  }

  const desktopManifest = {
    schemaVersion: 3,
    repository: "Ablankpaper/aera",
    sourceSha: DESKTOP_SHA,
    version: INTERNAL_BETA_VERSION,
    origin: `https://${[203, 0, 113, 10].join(".")}`,
    offlineTrust: {
      algorithm: "Ed25519",
      issuer: `https://${[203, 0, 113, 10].join(".")}`,
      keyId: "offline-internal-beta-v1",
      publicKey: Buffer.alloc(32, 73).toString("base64url"),
    },
    build: {
      workflow: "Desktop internal Beta candidate",
      runUrl: DESKTOP_CANDIDATE,
      ciRunUrl: DESKTOP_CI,
    },
    signingStatus: INTERNAL_BETA_SIGNING_STATUS,
    runtimeSeed: {
      repository: "Ablankpaper/aera-runtime",
      sourceCommit: INTERNAL_BETA_RUNTIME_SOURCE_SHA,
      runtimeVersion: "0.20.0-agentera.3",
      releaseTag: "runtime-v0.20.0-agentera.3",
      channel: "stable",
      lockSha256: "3".repeat(64),
      targets: [
        {
          platform: "darwin",
          arch: "arm64",
          archive: "agentera-runtime-0.20.0-agentera.3-darwin-arm64.tar.zst",
          manifest:
            "agentera-runtime-0.20.0-agentera.3-darwin-arm64.manifest.json",
          signature:
            "agentera-runtime-0.20.0-agentera.3-darwin-arm64.manifest.sig",
          manifestSha256: "4".repeat(64),
        },
        {
          platform: "windows",
          arch: "x64",
          archive: "agentera-runtime-0.20.0-agentera.3-windows-x64.zip",
          manifest:
            "agentera-runtime-0.20.0-agentera.3-windows-x64.manifest.json",
          signature:
            "agentera-runtime-0.20.0-agentera.3-windows-x64.manifest.sig",
          manifestSha256: "5".repeat(64),
        },
      ],
    },
    artifacts,
    supplyChain: {
      macosEvidence: {
        name: "macos-evidence.json",
        sha256: "f".repeat(64),
        size: 10,
      },
      windowsEvidence: {
        name: "windows-evidence.json",
        sha256: "e".repeat(64),
        size: 10,
      },
      nativeEvidence: [
        "native-inventory-macos-dmg.json",
        "native-inventory-macos-zip.json",
        "native-inventory-windows-setup.json",
        "native-inventory-windows-portable.json",
        "native-inventory-windows-app-zip.json",
      ].map((name) => ({ name, sha256: "d".repeat(64), size: 10 })),
      packagedStartupEvidence: [
        "packaged-startup-macos.json",
        "packaged-startup-windows.json",
      ].map((name) => ({ name, sha256: "c".repeat(64), size: 10 })),
      sbom: {
        name: "internal-beta.spdx.json",
        sha256: "6".repeat(64),
        size: 10,
      },
      provenance: {
        name: "internal-beta.provenance.json",
        sha256: "7".repeat(64),
        size: 10,
      },
      manifestBundle: "internal-beta-manifest.cosign.bundle.json",
      provenanceBundle: "internal-beta-provenance.cosign.bundle.json",
      signerIdentity: INTERNAL_BETA_WORKFLOW_IDENTITY,
      oidcIssuer: INTERNAL_BETA_OIDC_ISSUER,
    },
    createdAt: CREATED_AT,
  };
  const cloudManifest = {
    schemaVersion: 1,
    repository: "Ablankpaper/aera-cloud",
    commitSha: CLOUD_SHA,
    image: {
      reference: `ghcr.io/ablankpaper/aera-cloud@${CLOUD_DIGEST}`,
      digest: CLOUD_DIGEST,
    },
    build: {
      workflow: "Cloud candidate",
      runUrl: CLOUD_CANDIDATE,
    },
    schema: { minimum: 17, maximum: 20, highestMigration: 20 },
    supplyChain: {
      sbomDigest: `sha256:${"8".repeat(64)}`,
      provenanceDigest: `sha256:${"9".repeat(64)}`,
    },
    features: {
      officialQualityEnabledByDefault: false,
      encryptedBackupEnabledByDefault: false,
    },
    createdAt: CREATED_AT,
  };
  const adminManifest = {
    schemaVersion: 1,
    repository: "Ablankpaper/aera-admin",
    commitSha: ADMIN_SHA,
    image: {
      reference: `ghcr.io/ablankpaper/aera-admin@${ADMIN_DIGEST}`,
      digest: ADMIN_DIGEST,
    },
    build: {
      workflow: "Admin candidate",
      runUrl: ADMIN_CANDIDATE,
    },
    adminSchema: { minimum: 1, maximum: 1, highestMigration: 1 },
    compatibility: {
      cloudCommitSha: CLOUD_SHA,
      cloudInternalApiVersion: "v1",
      cloudSchemaMinimum: 17,
      cloudSchemaMaximum: 20,
    },
    supplyChain: {
      sbomDigest: `sha256:${"d".repeat(64)}`,
      provenanceDigest: `sha256:${"e".repeat(64)}`,
    },
    mutationsEnabledByDefault: false,
    createdAt: CREATED_AT,
  };
  const desktopManifestRaw = canonicalJSONStringify(desktopManifest);
  const cloudManifestRaw = canonicalJSONStringify(cloudManifest);
  const adminManifestRaw = canonicalJSONStringify(adminManifest);

  const packageRoles = [
    "macos_arm64_dmg",
    "macos_arm64_zip",
    "windows_x64_setup",
    "windows_x64_portable",
    "windows_x64_app_zip",
  ];
  const evidence = {
    schemaVersion: 1,
    status: "INTERNAL_BETA_ACCEPTED",
    completedAt: COMPLETED_AT,
    sources: {
      desktop: {
        sha: DESKTOP_SHA,
        ciRunUrl: DESKTOP_CI,
        candidateRunUrl: DESKTOP_CANDIDATE,
        candidateManifestSha256: digest(desktopManifestRaw),
      },
      cloud: {
        sha: CLOUD_SHA,
        ciRunUrl: CLOUD_CI,
        candidateRunUrl: CLOUD_CANDIDATE,
        candidateManifestSha256: digest(cloudManifestRaw),
        imageDigest: CLOUD_DIGEST,
      },
      admin: {
        sha: ADMIN_SHA,
        ciRunUrl: ADMIN_CI,
        candidateRunUrl: ADMIN_CANDIDATE,
        candidateManifestSha256: digest(adminManifestRaw),
        imageDigest: ADMIN_DIGEST,
      },
      runtime: {
        sha: INTERNAL_BETA_RUNTIME_SOURCE_SHA,
        lockSha256: desktopManifest.runtimeSeed.lockSha256,
      },
    },
    deployment: {
      cloudImageDigest: CLOUD_DIGEST,
      adminImageDigest: ADMIN_DIGEST,
      certificateExpiresAt: "2026-07-30T04:00:00Z",
      registrationMode: "direct",
      publicRegistrationEnabled: true,
      officialAgentsEnabled: true,
      officialQualityEnabled: true,
      encryptedBackupEnabled: true,
      adminMutationsEnabled: false,
    },
    packages: artifacts.map((artifact, index) => ({
      role: packageRoles[index],
      name: artifact.name,
      sha256: artifact.sha256,
    })),
    platforms: [
      {
        role: "macos_arm64",
        platformVersion: "macOS 15",
        installedPackageRole: "macos_arm64_dmg",
        installedPackageSha256: artifacts[0].sha256,
      },
      {
        role: "windows_x64",
        platformVersion: "Windows 11",
        installedPackageRole: "windows_x64_setup",
        installedPackageSha256: artifacts[2].sha256,
      },
    ],
    outcomes: Object.fromEntries(
      LIVE_OUTCOME_KEYS.map((key) => [key, "passed"]),
    ),
  };
  const schema = JSON.parse(
    await readFile(
      path.resolve("release/internal-beta-evidence.schema.json"),
      "utf8",
    ),
  );
  return {
    adminManifest,
    adminManifestRaw,
    artifactsDirectory,
    cloudManifest,
    cloudManifestRaw,
    desktopManifest,
    desktopManifestRaw,
    evidence,
    options: {
      adminManifestRaw,
      artifactsDirectory,
      cloudManifestRaw,
      desktopManifestRaw,
      now: NOW,
      schema,
      beta33AcceptanceRaw: buildAcceptanceLedger(desktopManifestRaw, artifacts),
    },
    schema,
  };
}

test("schema is closed and complete", async () => {
  const { schema } = await fixture();
  assert.doesNotThrow(() => validateLiveEvidenceSchema(schema));

  const openSchema = structuredClone(schema);
  openSchema.$defs.platform.additionalProperties = true;
  assert.throws(() => validateLiveEvidenceSchema(openSchema), /not closed/i);

  const incompleteSchema = structuredClone(schema);
  incompleteSchema.properties.outcomes.required.pop();
  assert.throws(
    () => validateLiveEvidenceSchema(incompleteSchema),
    /outcome requirements/i,
  );
});

// @lat: [[agentera-post-official-delivery#Production readiness and release#Internal-Beta live acceptance boundary]]
test("accepts complete canonical evidence bound to candidates and package bytes", async () => {
  const { evidence, options } = await fixture();
  assert.deepEqual(await validateLiveEvidence(evidence, options), evidence);
  const raw = canonicalJSONStringify(evidence);
  assert.deepEqual(await parseAndValidateLiveEvidence(raw, options), evidence);
});

test("requires every acceptance and rejection outcome", async () => {
  for (const key of LIVE_OUTCOME_KEYS) {
    const { evidence, options } = await fixture();
    delete evidence.outcomes[key];
    await assert.rejects(
      validateLiveEvidence(evidence, options),
      /outcome|field|scenario/i,
    );
  }
});

test("rejects secrets, identities, content, paths, and arbitrary notes", async () => {
  const forbidden = [
    ["password", "fixture-value"],
    ["email", "person@example.invalid"],
    ["recoveryPhrase", "alpha beta gamma delta"],
    ["accountId", "raw-account-identifier"],
    ["deviceId", "raw-device-identifier"],
    ["prompt", "private prompt"],
    ["response", "private response"],
    ["profilePath", "/private/profile"],
    ["notes", "free-form note"],
    ["logs", "raw log output"],
  ];
  for (const [field, value] of forbidden) {
    const { evidence, options } = await fixture();
    evidence[field] = value;
    await assert.rejects(validateLiveEvidence(evidence, options), /field/i);
  }
});

test("rejects changed package bytes and manifest hash substitution", async () => {
  const first = await fixture();
  const changedPackage = path.join(
    first.artifactsDirectory,
    INTERNAL_BETA_ARTIFACTS[0].name,
  );
  await writeFile(changedPackage, "changed package bytes");
  await assert.rejects(
    validateLiveEvidence(first.evidence, first.options),
    /package.*hash|artifact.*digest/i,
  );

  const second = await fixture();
  second.evidence.sources.desktop.candidateManifestSha256 = "f".repeat(64);
  await assert.rejects(
    validateLiveEvidence(second.evidence, second.options),
    /manifest.*digest|candidate.*identity/i,
  );
});

test("rejects identity, deployment, certificate, mode, and platform drift", async () => {
  const mutations = [
    (evidence) => {
      evidence.sources.cloud.sha = "f".repeat(40);
    },
    (evidence) => {
      evidence.sources.admin.candidateRunUrl = ADMIN_CI;
    },
    (evidence) => {
      evidence.deployment.cloudImageDigest = `sha256:${"f".repeat(64)}`;
    },
    (evidence) => {
      evidence.deployment.certificateExpiresAt = "2026-07-24T05:00:00Z";
    },
    (evidence) => {
      evidence.deployment.registrationMode = "verified";
    },
    (evidence) => {
      evidence.platforms[0].role = "linux_x64";
    },
    (evidence) => {
      evidence.sources.runtime.sha = "f".repeat(40);
    },
  ];
  for (const mutate of mutations) {
    const { evidence, options } = await fixture();
    mutate(evidence);
    await assert.rejects(validateLiveEvidence(evidence, options));
  }
});

test("rejects noncanonical evidence JSON", async () => {
  const { evidence, options } = await fixture();
  const noncanonical = `${JSON.stringify(evidence, null, 2)}\n`;
  await assert.rejects(
    parseAndValidateLiveEvidence(noncanonical, options),
    /canonical/i,
  );
});

test("wires the Beta.33 acceptance ledger into live evidence verification", async () => {
  const source = await readFile(
    new URL("./verify-live-evidence.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /--beta33-acceptance/u);
  assert.match(source, /validateBeta33AcceptanceForRelease/u);
});
