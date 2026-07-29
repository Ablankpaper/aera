#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  stat,
} from "node:fs/promises";
import { isIP } from "node:net";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { canonicalJSONStringify } from "./candidate-manifest.mjs";
import {
  candidateManifestSha256,
  validateDeviceEvidence,
} from "./verify-device-evidence.mjs";
import {
  validateStagingEvidence,
  verifyStagingEvidenceSignature,
} from "./verify-staging-evidence.mjs";
import {
  validateCandidateDocument,
  verifyCandidateFiles,
} from "./verify-candidate.mjs";

const execFile = promisify(execFileCallback);
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const IMAGE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u;
const RUN_ID_PATTERN = /^[1-9][0-9]*$/u;
const TAG_PATTERN = /^v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u;
const SAFE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u;
const APPROVER_PATTERN =
  /^(?:employee|contractor):[A-Za-z0-9][A-Za-z0-9._-]{1,99}$/u;
const CANDIDATE_WORKFLOW = "Desktop signed candidate";
const CANDIDATE_SIGNER_WORKFLOW =
  "github.com/bignormal/aera/.github/workflows/release-candidate.yml";

export async function promoteDesktopRelease(options, dependencies = {}) {
  validatePromotionOptions(options);
  const github = dependencies.github ?? createGitHubClient();
  const verifyDeviceEvidenceFile =
    dependencies.verifyDeviceEvidenceFile ?? verifyDeviceFile;
  const verifyStagingEvidenceFile =
    dependencies.verifyStagingEvidenceFile ?? verifyStagingFile;

  const run = await github.getWorkflowRun({
    repository: options.repository,
    runId: options.candidateRunId,
  });
  validateCandidateRun(run, options);

  await mkdir(options.workspace, { recursive: true });
  const candidateDirectory = join(
    options.workspace,
    `desktop-candidate-${options.candidateRunId}`,
  );
  await mkdir(candidateDirectory);
  await github.downloadWorkflowArtifact({
    repository: options.repository,
    runId: options.candidateRunId,
    artifactName: `desktop-candidate-${options.sourceSha}`,
    destination: candidateDirectory,
  });

  const verified = await verifyCandidateBundle(candidateDirectory, {
    expectedSourceSha: options.sourceSha,
    expectedManifestSha256: options.candidateManifestSha256,
    expectedRunUrl: run.url,
  });
  if (options.releaseTag !== `v${verified.candidate.version}`) {
    throw new Error("Release tag does not match the candidate version");
  }

  for (const path of verified.attestedPaths) {
    await github.verifyAttestation({
      repository: options.repository,
      path,
      signerWorkflow: CANDIDATE_SIGNER_WORKFLOW,
    });
  }

  await verifyDeviceEvidenceFile({
    path: options.deviceEvidencePath,
    expectedSha256: options.deviceEvidenceSha256,
    candidate: verified.candidate,
    candidateManifestSha256: options.candidateManifestSha256,
  });
  await verifyStagingEvidenceFile({
    path: options.stagingEvidencePath,
    expectedSha256: options.stagingEvidenceSha256,
    signaturePath: options.stagingSignaturePath,
    expectedSignatureSha256: options.stagingSignatureSha256,
    publicKeyPath: options.stagingPublicKeyPath,
    cloudSourceSha: options.cloudSourceSha,
    cloudImageDigest: options.cloudImageDigest,
    cloudCandidateManifestSha256: options.cloudCandidateManifestSha256,
    cloudDisabledRunId: options.cloudDisabledRunId,
    cloudEnabledRunId: options.cloudEnabledRunId,
    adminSourceSha: options.adminSourceSha,
    adminImageDigest: options.adminImageDigest,
    adminCandidateManifestSha256: options.adminCandidateManifestSha256,
    adminDisabledRunId: options.adminDisabledRunId,
    adminEnabledRunId: options.adminEnabledRunId,
    desktopSourceSha: options.sourceSha,
    desktopCandidateManifestSha256: options.candidateManifestSha256,
  });

  const gate = await readCanonicalHashedJSON(
    options.productionGatePath,
    options.productionGateSha256,
    "Production gate evidence",
  );
  validateProductionGateDocument(gate.document, {
    desktopSourceSha: options.sourceSha,
    desktopVersion: verified.candidate.version,
    desktopCandidateManifestSha256: options.candidateManifestSha256,
    cloudSourceSha: options.cloudSourceSha,
    cloudImageDigest: options.cloudImageDigest,
    cloudCandidateManifestSha256: options.cloudCandidateManifestSha256,
    cloudDisabledRunId: options.cloudDisabledRunId,
    cloudEnabledRunId: options.cloudEnabledRunId,
    adminSourceSha: options.adminSourceSha,
    adminImageDigest: options.adminImageDigest,
    adminCandidateManifestSha256: options.adminCandidateManifestSha256,
    adminDisabledRunId: options.adminDisabledRunId,
    adminEnabledRunId: options.adminEnabledRunId,
    deviceEvidenceSha256: options.deviceEvidenceSha256,
    stagingEvidenceSha256: options.stagingEvidenceSha256,
    stagingSignatureSha256: options.stagingSignatureSha256,
  });
  github.markProductionGateValidated?.();

  const existingTagSha = await github.resolveTag({
    repository: options.repository,
    tag: options.releaseTag,
  });
  if (existingTagSha !== null && existingTagSha !== options.sourceSha) {
    throw new Error(
      "Existing release tag resolves to a different source commit",
    );
  }
  if (existingTagSha === null) {
    await github.createAnnotatedTag({
      repository: options.repository,
      tag: options.releaseTag,
      sourceSha: options.sourceSha,
      message: `Aera ${verified.candidate.version}`,
    });
  }

  const existingRelease = await github.getReleaseByTag({
    repository: options.repository,
    tag: options.releaseTag,
  });
  if (existingRelease !== null) {
    throw new Error(
      "A GitHub Release already exists for this tag; verify its assets before retrying",
    );
  }
  const release = await github.createDraftRelease({
    repository: options.repository,
    tag: options.releaseTag,
    name: `Aera ${verified.candidate.version}`,
    body: releaseBody(verified, options),
  });
  if (
    !Number.isSafeInteger(release?.id) ||
    release.id <= 0 ||
    release.draft !== true
  ) {
    throw new Error("GitHub did not create a valid draft release");
  }
  for (const path of verified.releaseAssets) {
    await github.uploadReleaseAsset({
      repository: options.repository,
      tag: options.releaseTag,
      releaseId: release.id,
      path,
    });
  }
  const published = await github.publishRelease({
    repository: options.repository,
    releaseId: release.id,
  });
  return {
    status: "published",
    tag: options.releaseTag,
    sourceSha: options.sourceSha,
    candidateManifestSha256: options.candidateManifestSha256,
    releaseUrl: published?.url,
  };
}

export async function verifyCandidateBundle(candidateDirectory, expected) {
  const root = await realpath(candidateDirectory);
  const manifestPath = join(root, "candidate-manifest.json");
  const rawManifest = await readFile(manifestPath, "utf8");
  const candidate = JSON.parse(rawManifest);
  if (rawManifest !== canonicalJSONStringify(candidate)) {
    throw new Error("Candidate manifest is not canonical JSON");
  }
  const manifestDigest = candidateManifestSha256(rawManifest);
  if (manifestDigest !== expected.expectedManifestSha256) {
    throw new Error("Candidate manifest hash differs");
  }
  validateCandidateDocument(candidate, {
    expectedSourceSha: expected.expectedSourceSha,
  });
  if (candidate.build.runUrl !== expected.expectedRunUrl) {
    throw new Error("Candidate manifest belongs to another workflow run");
  }

  const artifactsDirectory = join(root, "artifacts");
  const evidenceDirectory = join(root, "evidence");
  await verifyCandidateFiles(candidate, {
    artifactsDirectory,
    runtimeLock: join(evidenceDirectory, "agentera-runtime-seed.lock.json"),
    sbom: join(evidenceDirectory, candidate.supplyChain.sbom.name),
    provenance: join(evidenceDirectory, candidate.supplyChain.provenance.name),
    expectedSourceSha: expected.expectedSourceSha,
    expectedVersion: candidate.version,
  });
  const attestationBundle = join(evidenceDirectory, "github-attestation.json");
  if ((await stat(attestationBundle)).size <= 0) {
    throw new Error("GitHub attestation bundle is empty");
  }
  const checksummedPaths = await verifyChecksumInventory(
    root,
    join(evidenceDirectory, "SHA256SUMS"),
  );
  const attestedPaths = [
    ...checksummedPaths.map((path) => join(root, path)),
    join(evidenceDirectory, "SHA256SUMS"),
  ];
  const releaseAssets = releaseAssetPaths(root, candidate);
  await requireRegularContainedFiles(root, releaseAssets);
  return {
    candidate,
    manifestDigest,
    attestedPaths,
    releaseAssets,
  };
}

export async function verifyChecksumInventory(root, checksumPath) {
  const raw = await readFile(checksumPath, "utf8");
  if (raw.length === 0 || !raw.endsWith("\n")) {
    throw new Error("Candidate checksum inventory is not canonical");
  }
  const expected = new Map();
  for (const line of raw.trimEnd().split("\n")) {
    const match = /^([0-9a-f]{64}) [ *]([^\0\r\n]+)$/u.exec(line);
    if (!match) {
      throw new Error("Candidate checksum inventory is malformed");
    }
    const [, digest, path] = match;
    validateRelativeCandidatePath(path);
    if (expected.has(path)) {
      throw new Error("Candidate checksum path is duplicated");
    }
    expected.set(path, digest);
  }

  const actualInventory = (await listRegularFiles(root)).filter(
    (path) =>
      path !== "evidence/SHA256SUMS" &&
      path !== "evidence/github-attestation.json",
  );
  if (
    [...expected.keys()].sort().join("\n") !== actualInventory.sort().join("\n")
  ) {
    throw new Error("Candidate checksum inventory is incomplete or open");
  }
  for (const [path, digest] of expected) {
    const actual = await fileSha256(join(root, path));
    if (actual !== digest) {
      throw new Error(`Candidate checksum differs: ${path}`);
    }
  }
  return [...expected.keys()].sort();
}

export function validateProductionGateDocument(document, expected) {
  exactFields(
    document,
    [
      "schemaVersion",
      "decision",
      "desktop",
      "cloud",
      "admin",
      "evidence",
      "deploymentRuns",
      "legal",
      "providers",
      "domain",
      "rollout",
      "approval",
    ],
    "production gate",
  );
  if (document.schemaVersion !== 1 || document.decision !== "approved") {
    throw new Error("Production approval decision is invalid");
  }
  validateDesktopGate(document.desktop, expected);
  validateImageGate(document.cloud, expected, "cloud");
  validateImageGate(document.admin, expected, "admin");
  exactFields(
    document.evidence,
    ["deviceEvidenceSha256", "stagingEvidenceSha256", "stagingSignatureSha256"],
    "production gate evidence",
  );
  for (const [field, expectedValue] of [
    ["deviceEvidenceSha256", expected.deviceEvidenceSha256],
    ["stagingEvidenceSha256", expected.stagingEvidenceSha256],
    ["stagingSignatureSha256", expected.stagingSignatureSha256],
  ]) {
    if (
      !DIGEST_PATTERN.test(document.evidence[field] ?? "") ||
      document.evidence[field] !== expectedValue
    ) {
      throw new Error("Production evidence digest differs");
    }
  }
  validateDeploymentRunGate(document.deploymentRuns, expected);
  validateLegalGate(document.legal);
  validateProviderGate(document.providers);
  validateDomainGate(document.domain);
  validateRolloutGate(document.rollout);
  validateApprovalGate(document.approval, expected?.now);
  return document;
}

export function validateProductionRunSequence(sequence, expected) {
  exactFields(
    sequence,
    ["cloudDisabled", "adminDisabled", "cloudEnabled", "adminEnabled"],
    "production run sequence",
  );
  const descriptors = [
    [
      "cloudDisabled",
      {
        repository: "bignormal/aera-cloud",
        workflowName: "Promote Cloud candidate to production",
        sourceSha: expected.cloudSourceSha,
        runId: expected.cloudDisabledRunId,
        deployJob: "Deploy exact digest with every new feature disabled",
        enableJob: "Apply separately approved production cohort",
        enabled: false,
      },
    ],
    [
      "adminDisabled",
      {
        repository: "bignormal/aera-admin",
        workflowName: "Promote Admin candidate to production",
        sourceSha: expected.adminSourceSha,
        runId: expected.adminDisabledRunId,
        deployJob: "Deploy exact digest with mutations disabled",
        enableJob: "Enable mutations only after separate production approval",
        enabled: false,
      },
    ],
    [
      "cloudEnabled",
      {
        repository: "bignormal/aera-cloud",
        workflowName: "Promote Cloud candidate to production",
        sourceSha: expected.cloudSourceSha,
        runId: expected.cloudEnabledRunId,
        deployJob: "Deploy exact digest with every new feature disabled",
        enableJob: "Apply separately approved production cohort",
        enabled: true,
      },
    ],
    [
      "adminEnabled",
      {
        repository: "bignormal/aera-admin",
        workflowName: "Promote Admin candidate to production",
        sourceSha: expected.adminSourceSha,
        runId: expected.adminEnabledRunId,
        deployJob: "Deploy exact digest with mutations disabled",
        enableJob: "Enable mutations only after separate production approval",
        enabled: true,
      },
    ],
  ];
  const windows = [];
  const runIds = new Set();
  for (const [name, descriptor] of descriptors) {
    if (runIds.has(descriptor.runId)) {
      throw new Error("Production deployment run ID is reused");
    }
    runIds.add(descriptor.runId);
    windows.push(validateProductionRun(sequence[name], descriptor));
  }
  for (let index = 1; index < windows.length; index += 1) {
    if (
      windows[index - 1].completedAt.getTime() >
      windows[index].startedAt.getTime()
    ) {
      throw new Error(
        "Production deployment order must be Cloud disabled, Admin disabled, Cloud enabled, Admin enabled",
      );
    }
  }
  return sequence;
}

export function validateProductionDeploymentEvidence(evidence, expected) {
  exactFields(
    evidence,
    ["cloudDisabled", "adminDisabled", "cloudEnabled", "adminEnabled"],
    "production deployment evidence",
  );
  const cloudDisabled = validateDeploymentEvidencePair(evidence.cloudDisabled, {
    kind: "cloud",
    sourceSha: expected.cloudSourceSha,
    imageDigest: expected.cloudImageDigest,
    candidateManifestSha256: expected.cloudCandidateManifestSha256,
  });
  const adminDisabled = validateDeploymentEvidencePair(evidence.adminDisabled, {
    kind: "admin",
    sourceSha: expected.adminSourceSha,
    imageDigest: expected.adminImageDigest,
    candidateManifestSha256: expected.adminCandidateManifestSha256,
  });
  const cloudEnabled = validateDeploymentEvidencePair(evidence.cloudEnabled, {
    kind: "cloud",
    sourceSha: expected.cloudSourceSha,
    imageDigest: expected.cloudImageDigest,
    candidateManifestSha256: expected.cloudCandidateManifestSha256,
  });
  const adminEnabled = validateDeploymentEvidencePair(evidence.adminEnabled, {
    kind: "admin",
    sourceSha: expected.adminSourceSha,
    imageDigest: expected.adminImageDigest,
    candidateManifestSha256: expected.adminCandidateManifestSha256,
  });

  const disabledCloudFeatures = {
    publicRegistration: false,
    officialAgents: false,
    officialQuality: false,
    encryptedBackup: false,
  };
  const enabledCloudFeatures = {
    publicRegistration: expected.rollout?.publicRegistrationEnabled,
    officialAgents: expected.rollout?.officialAgentsEnabled,
    officialQuality: expected.rollout?.officialQualityEnabled,
    encryptedBackup: expected.rollout?.encryptedBackupEnabled,
  };
  validateFeatureState(
    cloudDisabled.state.features,
    disabledCloudFeatures,
    "disabled Cloud",
  );
  validateFeatureState(
    cloudEnabled.state.features,
    enabledCloudFeatures,
    "enabled Cloud",
  );
  if (
    adminDisabled.state.mutationsEnabled !== false ||
    typeof expected.rollout?.adminMutationsEnabled !== "boolean" ||
    adminEnabled.state.mutationsEnabled !==
      expected.rollout.adminMutationsEnabled
  ) {
    throw new Error("Admin deployment mutation state differs from rollout");
  }
  return evidence;
}

function validateDeploymentEvidencePair(value, expected) {
  exactFields(
    value,
    ["stateRaw", "manifestRaw"],
    `production ${expected.kind} deployment evidence pair`,
  );
  const state = parseCanonicalJSON(
    value.stateRaw,
    `production ${expected.kind} deployment state`,
  );
  const manifest = parseCanonicalJSON(
    value.manifestRaw,
    `production ${expected.kind} current manifest`,
  );
  const repository = `bignormal/aera-${expected.kind}`;
  const imageReference = `ghcr.io/${repository}@${expected.imageDigest}`;
  if (
    sha256(Buffer.from(value.manifestRaw)) !==
      expected.candidateManifestSha256 ||
    manifest?.repository !== repository ||
    manifest.commitSha !== expected.sourceSha ||
    manifest.image?.digest !== expected.imageDigest ||
    manifest.image?.reference !== imageReference
  ) {
    throw new Error(
      `Production ${expected.kind} current manifest identity differs`,
    );
  }
  const stateFields =
    expected.kind === "cloud"
      ? ["environment", "current", "previousImageDigest", "features"]
      : [
          "environment",
          "current",
          "previousImageDigest",
          "mutationsEnabled",
          "cloudDualAuthentication",
          "cloudCompatibility",
          "restoreVerification",
        ];
  exactFields(
    state,
    stateFields,
    `production ${expected.kind} deployment state`,
  );
  exactFields(
    state.current,
    ["commitSha", "imageReference", "imageDigest", "deployedAt"],
    `production ${expected.kind} current deployment`,
  );
  if (
    state.environment !== "production" ||
    state.current.commitSha !== expected.sourceSha ||
    state.current.imageReference !== imageReference ||
    state.current.imageDigest !== expected.imageDigest
  ) {
    throw new Error(
      `Production ${expected.kind} deployment state identity differs`,
    );
  }
  parseTime(
    state.current.deployedAt,
    `production ${expected.kind} deployment time`,
  );
  if (
    state.previousImageDigest !== null &&
    !IMAGE_DIGEST_PATTERN.test(state.previousImageDigest ?? "")
  ) {
    throw new Error(
      `Production ${expected.kind} previous image digest is invalid`,
    );
  }
  if (
    expected.kind === "admin" &&
    (state.cloudDualAuthentication !== "passed" ||
      state.cloudCompatibility !== "passed" ||
      state.restoreVerification !== "passed")
  ) {
    throw new Error("Production Admin verification state is incomplete");
  }
  return { state, manifest };
}

function validateFeatureState(actual, expected, label) {
  exactFields(
    actual,
    [
      "publicRegistration",
      "officialAgents",
      "officialQuality",
      "encryptedBackup",
    ],
    `${label} feature state`,
  );
  for (const [field, wanted] of Object.entries(expected)) {
    if (typeof wanted !== "boolean" || actual[field] !== wanted) {
      throw new Error(`${label} feature state differs from rollout`);
    }
  }
}

function parseCanonicalJSON(raw, label) {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error(`${label} is empty`);
  }
  const value = JSON.parse(raw);
  if (raw !== canonicalJSONStringify(value)) {
    throw new Error(`${label} is not canonical JSON`);
  }
  return value;
}

function validateProductionRun(run, expected) {
  if (
    run?.workflowName !== expected.workflowName ||
    run.conclusion !== "success" ||
    run.headSha !== expected.sourceSha ||
    run.url !==
      `https://github.com/${expected.repository}/actions/runs/${expected.runId}` ||
    !Array.isArray(run.jobs) ||
    run.jobs.length !== 2
  ) {
    throw new Error("Production deployment workflow identity is invalid");
  }
  const jobs = new Map(run.jobs.map((job) => [job?.name, job]));
  if (jobs.size !== 2) {
    throw new Error("Production deployment jobs are duplicated");
  }
  const deploy = jobs.get(expected.deployJob);
  const enable = jobs.get(expected.enableJob);
  if (deploy?.conclusion !== "success" || executedSteps(deploy).length === 0) {
    throw new Error("Production disabled deployment did not execute");
  }
  if (expected.enabled) {
    if (
      enable?.conclusion !== "success" ||
      executedSteps(enable).length === 0
    ) {
      throw new Error("Production enablement did not execute");
    }
  } else if (
    enable?.conclusion !== "skipped" ||
    executedSteps(enable).length !== 0
  ) {
    throw new Error("Production disabled-only run unexpectedly enabled");
  }
  const startedAt = parseTime(run.startedTime, "production run start time");
  const completedAt = parseTime(
    run.updatedAt,
    "production run completion time",
  );
  if (completedAt.getTime() < startedAt.getTime()) {
    throw new Error("Production run completed before it started");
  }
  return { startedAt, completedAt };
}

function executedSteps(job) {
  return job?.steps?.filter((step) => step?.conclusion !== "skipped") ?? [];
}

function validateDeploymentRunGate(value, expected) {
  exactFields(
    value,
    [
      "cloudDisabledRunId",
      "adminDisabledRunId",
      "cloudEnabledRunId",
      "adminEnabledRunId",
    ],
    "production deployment run gate",
  );
  for (const field of [
    "cloudDisabledRunId",
    "adminDisabledRunId",
    "cloudEnabledRunId",
    "adminEnabledRunId",
  ]) {
    if (
      !RUN_ID_PATTERN.test(value[field] ?? "") ||
      value[field] !== expected[field]
    ) {
      throw new Error("Production deployment run identity differs");
    }
  }
}

function validateDesktopGate(value, expected) {
  exactFields(
    value,
    ["repository", "sourceSha", "version", "candidateManifestSha256"],
    "production Desktop gate",
  );
  if (
    value.repository !== "bignormal/aera" ||
    value.sourceSha !== expected.desktopSourceSha ||
    value.version !== expected.desktopVersion ||
    value.candidateManifestSha256 !== expected.desktopCandidateManifestSha256 ||
    !SHA_PATTERN.test(value.sourceSha ?? "") ||
    !VERSION_PATTERN.test(value.version ?? "") ||
    !DIGEST_PATTERN.test(value.candidateManifestSha256 ?? "")
  ) {
    throw new Error("Production Desktop candidate identity differs");
  }
}

function validateImageGate(value, expected, kind) {
  const title = kind === "cloud" ? "Cloud" : "Admin";
  exactFields(
    value,
    ["repository", "sourceSha", "imageDigest", "candidateManifestSha256"],
    `production ${title} gate`,
  );
  if (
    value.repository !== `bignormal/aera-${kind}` ||
    value.sourceSha !== expected[`${kind}SourceSha`] ||
    value.imageDigest !== expected[`${kind}ImageDigest`] ||
    value.candidateManifestSha256 !==
      expected[`${kind}CandidateManifestSha256`] ||
    !SHA_PATTERN.test(value.sourceSha ?? "") ||
    !IMAGE_DIGEST_PATTERN.test(value.imageDigest ?? "") ||
    !DIGEST_PATTERN.test(value.candidateManifestSha256 ?? "")
  ) {
    throw new Error(`Production ${title} image identity differs`);
  }
}

function validateLegalGate(value) {
  exactFields(
    value,
    [
      "privacyPolicyApproved",
      "termsApproved",
      "dataProcessingApproved",
      "evidenceUrl",
      "evidenceSha256",
    ],
    "production legal gate",
  );
  if (
    value.privacyPolicyApproved !== true ||
    value.termsApproved !== true ||
    value.dataProcessingApproved !== true
  ) {
    throw new Error("Production legal approvals are incomplete");
  }
  validateEvidenceLink(value, "Production legal");
}

function validateProviderGate(value) {
  exactFields(
    value,
    [
      "identityReady",
      "emailReady",
      "paymentsReady",
      "objectStorageReady",
      "observabilityReady",
      "productionCredentialsVerified",
      "evidenceUrl",
      "evidenceSha256",
    ],
    "production provider gate",
  );
  for (const field of [
    "identityReady",
    "emailReady",
    "paymentsReady",
    "objectStorageReady",
    "observabilityReady",
    "productionCredentialsVerified",
  ]) {
    if (value[field] !== true) {
      throw new Error("Production provider readiness is incomplete");
    }
  }
  validateEvidenceLink(value, "Production provider");
}

function validateDomainGate(value) {
  exactFields(
    value,
    [
      "productionOrigin",
      "identityIssuer",
      "dnsApproved",
      "tlsValidated",
      "evidenceUrl",
      "evidenceSha256",
    ],
    "production domain gate",
  );
  validateHTTPSOrigin(value.productionOrigin, "production origin");
  validateHTTPSOrigin(value.identityIssuer, "production identity issuer");
  if (value.dnsApproved !== true || value.tlsValidated !== true) {
    throw new Error("Production domain DNS or TLS approval is incomplete");
  }
  validateEvidenceLink(value, "Production domain");
}

function validateRolloutGate(value) {
  exactFields(
    value,
    [
      "cloudCanaryPercent",
      "cloudMonitoringMinutes",
      "desktopCanaryPercent",
      "desktopMonitoringMinutes",
      "publicRegistrationEnabled",
      "officialAgentsEnabled",
      "officialQualityEnabled",
      "encryptedBackupEnabled",
      "adminMutationsEnabled",
    ],
    "production rollout gate",
  );
  for (const field of ["cloudCanaryPercent", "desktopCanaryPercent"]) {
    if (
      !Number.isSafeInteger(value[field]) ||
      value[field] < 1 ||
      value[field] > 10
    ) {
      throw new Error("Production rollout canary percentage is invalid");
    }
  }
  for (const field of ["cloudMonitoringMinutes", "desktopMonitoringMinutes"]) {
    if (
      !Number.isSafeInteger(value[field]) ||
      value[field] < 30 ||
      value[field] > 1440
    ) {
      throw new Error("Production rollout monitoring window is invalid");
    }
  }
  for (const field of [
    "publicRegistrationEnabled",
    "officialAgentsEnabled",
    "officialQualityEnabled",
    "encryptedBackupEnabled",
    "adminMutationsEnabled",
  ]) {
    if (typeof value[field] !== "boolean") {
      throw new Error("Production rollout feature decision is invalid");
    }
  }
}

function validateApprovalGate(value, suppliedNow) {
  exactFields(
    value,
    [
      "approverIdentityRef",
      "responsibility",
      "approvedAt",
      "changeTicketUrl",
      "productionDeployApproved",
      "publicDesktopReleaseApproved",
    ],
    "production approval gate",
  );
  const approvedAt = parseTime(value.approvedAt, "production approval time");
  const now =
    suppliedNow instanceof Date && Number.isFinite(suppliedNow.getTime())
      ? suppliedNow
      : new Date();
  if (
    !APPROVER_PATTERN.test(value.approverIdentityRef ?? "") ||
    value.responsibility !== "release_approver" ||
    approvedAt.getTime() > now.getTime() + 5 * 60 * 1000 ||
    value.productionDeployApproved !== true ||
    value.publicDesktopReleaseApproved !== true
  ) {
    throw new Error("Production approval is incomplete or invalid");
  }
  validateHTTPSURL(value.changeTicketUrl, "Production change ticket");
}

async function verifyDeviceFile(context) {
  const evidence = await readCanonicalHashedJSON(
    context.path,
    context.expectedSha256,
    "Device evidence",
  );
  validateDeviceEvidence(evidence.document, {
    candidate: context.candidate,
    candidateManifestSha256: context.candidateManifestSha256,
  });
}

async function verifyStagingFile(context) {
  const [evidence, signatureRaw, publicKey] = await Promise.all([
    readCanonicalHashedJSON(
      context.path,
      context.expectedSha256,
      "Staging evidence",
    ),
    readFile(context.signaturePath),
    readFile(context.publicKeyPath, "utf8"),
  ]);
  if (sha256(signatureRaw) !== context.expectedSignatureSha256) {
    throw new Error("Staging signature hash differs");
  }
  const signature = decodeStagingSignature(signatureRaw);
  validateStagingEvidence(evidence.document, {
    cloudImageDigest: context.cloudImageDigest,
    adminImageDigest: context.adminImageDigest,
    desktopCandidateManifestSha256: context.desktopCandidateManifestSha256,
    cloudSourceSha: context.cloudSourceSha,
    adminSourceSha: context.adminSourceSha,
    desktopSourceSha: context.desktopSourceSha,
  });
  if (
    evidence.document.releaseInputs.cloud.candidateManifestSha256 !==
      context.cloudCandidateManifestSha256 ||
    evidence.document.releaseInputs.admin.candidateManifestSha256 !==
      context.adminCandidateManifestSha256
  ) {
    throw new Error("Staging candidate manifest digest differs");
  }
  verifyStagingEvidenceSignature(evidence.document, publicKey, signature);
}

async function readCanonicalHashedJSON(path, expectedSha256, label) {
  if (!DIGEST_PATTERN.test(expectedSha256 ?? "")) {
    throw new Error(`${label} expected digest is invalid`);
  }
  const raw = await readFile(path, "utf8");
  if (sha256(Buffer.from(raw)) !== expectedSha256) {
    throw new Error(`${label} hash differs`);
  }
  const document = JSON.parse(raw);
  if (raw !== canonicalJSONStringify(document)) {
    throw new Error(`${label} is not canonical JSON`);
  }
  return { raw, document };
}

function decodeStagingSignature(raw) {
  const text = raw.toString("utf8").trim();
  if (!/^[A-Za-z0-9+/]{86}==$/u.test(text)) {
    throw new Error("Staging signature is not canonical base64");
  }
  const decoded = Buffer.from(text, "base64");
  if (decoded.length !== 64 || decoded.toString("base64") !== text) {
    throw new Error("Staging signature is invalid");
  }
  return decoded;
}

function validatePromotionOptions(options) {
  exactFields(
    options,
    [
      "repository",
      "candidateRunId",
      "sourceSha",
      "candidateManifestSha256",
      "cloudSourceSha",
      "cloudImageDigest",
      "cloudCandidateManifestSha256",
      "cloudDisabledRunId",
      "cloudEnabledRunId",
      "adminSourceSha",
      "adminImageDigest",
      "adminCandidateManifestSha256",
      "adminDisabledRunId",
      "adminEnabledRunId",
      "deviceEvidencePath",
      "deviceEvidenceSha256",
      "stagingEvidencePath",
      "stagingEvidenceSha256",
      "stagingSignaturePath",
      "stagingSignatureSha256",
      "stagingPublicKeyPath",
      "productionGatePath",
      "productionGateSha256",
      "releaseTag",
      "workspace",
    ],
    "publication options",
  );
  if (
    options.repository !== "bignormal/aera" ||
    !RUN_ID_PATTERN.test(options.candidateRunId ?? "") ||
    !SHA_PATTERN.test(options.sourceSha ?? "") ||
    !DIGEST_PATTERN.test(options.candidateManifestSha256 ?? "") ||
    !SHA_PATTERN.test(options.cloudSourceSha ?? "") ||
    !IMAGE_DIGEST_PATTERN.test(options.cloudImageDigest ?? "") ||
    !DIGEST_PATTERN.test(options.cloudCandidateManifestSha256 ?? "") ||
    !RUN_ID_PATTERN.test(options.cloudDisabledRunId ?? "") ||
    !RUN_ID_PATTERN.test(options.cloudEnabledRunId ?? "") ||
    !SHA_PATTERN.test(options.adminSourceSha ?? "") ||
    !IMAGE_DIGEST_PATTERN.test(options.adminImageDigest ?? "") ||
    !DIGEST_PATTERN.test(options.adminCandidateManifestSha256 ?? "") ||
    !RUN_ID_PATTERN.test(options.adminDisabledRunId ?? "") ||
    !RUN_ID_PATTERN.test(options.adminEnabledRunId ?? "") ||
    !DIGEST_PATTERN.test(options.deviceEvidenceSha256 ?? "") ||
    !DIGEST_PATTERN.test(options.stagingEvidenceSha256 ?? "") ||
    !DIGEST_PATTERN.test(options.stagingSignatureSha256 ?? "") ||
    !DIGEST_PATTERN.test(options.productionGateSha256 ?? "") ||
    !TAG_PATTERN.test(options.releaseTag ?? "") ||
    !isAbsolute(options.workspace ?? "")
  ) {
    throw new Error("Publication options contain an invalid release identity");
  }
  for (const path of [
    options.deviceEvidencePath,
    options.stagingEvidencePath,
    options.stagingSignaturePath,
    options.stagingPublicKeyPath,
    options.productionGatePath,
  ]) {
    if (!isAbsolute(path ?? "")) {
      throw new Error("Publication evidence paths must be absolute");
    }
  }
}

function validateCandidateRun(run, options) {
  if (
    run?.workflowName !== CANDIDATE_WORKFLOW ||
    run.headSha !== options.sourceSha ||
    run.conclusion !== "success" ||
    run.url !==
      `https://github.com/${options.repository}/actions/runs/${options.candidateRunId}` ||
    !Array.isArray(run.jobs) ||
    run.jobs.length < 3
  ) {
    throw new Error("Candidate workflow run identity or conclusion is invalid");
  }
  for (const job of run.jobs) {
    const executed =
      job?.steps?.filter((step) => step?.conclusion !== "skipped") ?? [];
    if (job?.conclusion !== "success" || executed.length === 0) {
      throw new Error("Candidate workflow contains an unexecuted job");
    }
  }
}

function releaseAssetPaths(root, candidate) {
  const paths = [
    ...candidate.artifacts.map((artifact) =>
      join(root, "artifacts", artifact.name),
    ),
    join(root, "candidate-manifest.json"),
    join(root, "evidence", "SHA256SUMS"),
    join(root, "evidence", candidate.supplyChain.sbom.name),
    join(root, "evidence", candidate.supplyChain.provenance.name),
  ];
  const names = paths.map((path) => basename(path));
  if (
    paths.length !== 10 ||
    new Set(names).size !== names.length ||
    names.some((name) => !SAFE_NAME_PATTERN.test(name))
  ) {
    throw new Error("Desktop release asset inventory is invalid");
  }
  return paths.sort((left, right) =>
    basename(left).localeCompare(basename(right), "en"),
  );
}

async function requireRegularContainedFiles(root, paths) {
  const canonicalRoot = `${await realpath(root)}/`;
  for (const path of paths) {
    const info = await lstat(path);
    const canonical = await realpath(path);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      !canonical.startsWith(canonicalRoot)
    ) {
      throw new Error("Release asset is not a contained regular file");
    }
  }
}

async function listRegularFiles(root) {
  const result = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error("Candidate bundle contains a symbolic link");
      }
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile()) {
        result.push(relative(root, absolute).replaceAll("\\", "/"));
      } else {
        throw new Error("Candidate bundle contains an unsupported file");
      }
    }
  }
  await walk(root);
  return result;
}

function validateRelativeCandidatePath(path) {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((segment) => segment === "" || segment === "..") ||
    !(
      path === "candidate-manifest.json" ||
      path.startsWith("artifacts/") ||
      path.startsWith("evidence/")
    )
  ) {
    throw new Error("Candidate checksum path is unsafe");
  }
}

function validateEvidenceLink(value, label) {
  validateHTTPSURL(value.evidenceUrl, `${label} evidence`);
  if (!DIGEST_PATTERN.test(value.evidenceSha256 ?? "")) {
    throw new Error(`${label} evidence digest is invalid`);
  }
}

function validateHTTPSOrigin(value, label) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be a trusted DNS HTTPS origin`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    !safeHostname(parsed.hostname)
  ) {
    throw new Error(`${label} must be a trusted DNS HTTPS origin`);
  }
}

function validateHTTPSURL(value, label) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} URL is invalid`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.pathname === "/" ||
    !safeHostname(parsed.hostname)
  ) {
    throw new Error(`${label} URL is invalid`);
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

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fileSha256(path) {
  return sha256(await readFile(path));
}

function releaseBody(verified, options) {
  return [
    `Exact signed candidate from ${options.sourceSha}.`,
    "",
    `Candidate manifest SHA-256: ${verified.manifestDigest}`,
    `Cloud image: ${options.cloudImageDigest}`,
    `Admin image: ${options.adminImageDigest}`,
    `Cloud disabled/enabled runs: ${options.cloudDisabledRunId}/${options.cloudEnabledRunId}`,
    `Admin disabled/enabled runs: ${options.adminDisabledRunId}/${options.adminEnabledRunId}`,
    `Device evidence SHA-256: ${options.deviceEvidenceSha256}`,
    `Staging evidence SHA-256: ${options.stagingEvidenceSha256}`,
    "",
    "This release was promoted from candidate bytes without rebuilding.",
  ].join("\n");
}

export function createGitHubClient() {
  return {
    async getWorkflowRun({ repository, runId }) {
      return ghJSON([
        "run",
        "view",
        runId,
        "--repo",
        repository,
        "--json",
        "conclusion,headSha,jobs,url,workflowName",
      ]);
    },
    async downloadWorkflowArtifact({
      repository,
      runId,
      artifactName,
      destination,
    }) {
      await gh([
        "run",
        "download",
        runId,
        "--repo",
        repository,
        "--name",
        artifactName,
        "--dir",
        destination,
      ]);
    },
    async verifyAttestation({ repository, path, signerWorkflow }) {
      await gh([
        "attestation",
        "verify",
        path,
        "--repo",
        repository,
        "--signer-workflow",
        signerWorkflow,
      ]);
    },
    async resolveTag({ repository, tag }) {
      const ref = await ghAPINullable(
        `repos/${repository}/git/ref/tags/${encodeURIComponent(tag)}`,
      );
      if (ref === null) return null;
      let object = ref.object;
      for (let depth = 0; object?.type === "tag" && depth < 4; depth += 1) {
        const annotated = await ghJSON([
          "api",
          `repos/${repository}/git/tags/${object.sha}`,
        ]);
        object = annotated.object;
      }
      if (object?.type !== "commit" || !SHA_PATTERN.test(object.sha ?? "")) {
        throw new Error("Existing tag does not resolve to a commit");
      }
      return object.sha;
    },
    async createAnnotatedTag({ repository, tag, sourceSha, message }) {
      const tagObject = await ghJSON([
        "api",
        "--method",
        "POST",
        `repos/${repository}/git/tags`,
        "-f",
        `tag=${tag}`,
        "-f",
        `message=${message}`,
        "-f",
        `object=${sourceSha}`,
        "-f",
        "type=commit",
      ]);
      if (!SHA_PATTERN.test(tagObject?.sha ?? "")) {
        throw new Error("GitHub did not create an annotated tag object");
      }
      await gh([
        "api",
        "--method",
        "POST",
        `repos/${repository}/git/refs`,
        "-f",
        `ref=refs/tags/${tag}`,
        "-f",
        `sha=${tagObject.sha}`,
      ]);
    },
    async getReleaseByTag({ repository, tag }) {
      return ghAPINullable(
        `repos/${repository}/releases/tags/${encodeURIComponent(tag)}`,
      );
    },
    async createDraftRelease({ repository, tag, name, body }) {
      return ghJSON([
        "api",
        "--method",
        "POST",
        `repos/${repository}/releases`,
        "-f",
        `tag_name=${tag}`,
        "-f",
        `name=${name}`,
        "-f",
        `body=${body}`,
        "-F",
        "draft=true",
        "-F",
        "prerelease=false",
      ]);
    },
    async uploadReleaseAsset({ repository, tag, path }) {
      await gh(["release", "upload", tag, path, "--repo", repository]);
    },
    async publishRelease({ repository, releaseId }) {
      const release = await ghJSON([
        "api",
        "--method",
        "PATCH",
        `repos/${repository}/releases/${releaseId}`,
        "-F",
        "draft=false",
      ]);
      return { id: release.id, url: release.html_url };
    },
  };
}

async function gh(arguments_) {
  try {
    return await execFile("gh", arguments_, {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    const details = [error?.stderr, error?.stdout]
      .filter((value) => typeof value === "string" && value.trim() !== "")
      .join("\n");
    throw new Error(
      `GitHub CLI command failed: gh ${arguments_.join(" ")}${details ? `\n${details.trim()}` : ""}`,
      { cause: error },
    );
  }
}

async function ghJSON(arguments_) {
  const result = await gh(arguments_);
  return JSON.parse(result.stdout);
}

async function ghAPINullable(endpoint) {
  try {
    return await ghJSON(["api", endpoint]);
  } catch (error) {
    if (error instanceof Error && /\bHTTP 404\b/u.test(error.message)) {
      return null;
    }
    throw error;
  }
}

function parseOptions(arguments_) {
  if (arguments_.length === 0 || arguments_.length % 2 !== 0) {
    throw new Error("Publisher options must be flag/value pairs");
  }
  const values = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error("Publisher options must be flag/value pairs");
    }
    const key = flag.slice(2).replaceAll("-", "_");
    if (Object.hasOwn(values, key))
      throw new Error(`Duplicate option: ${flag}`);
    values[key] = value;
  }
  return values;
}

async function runCLI(argv) {
  const values = parseOptions(argv);
  if (
    process.env.GITHUB_ACTIONS !== "true" ||
    process.env.GITHUB_REPOSITORY !== "bignormal/aera" ||
    values.confirm_production_publication !==
      "EXACT_BYTES_APPROVED_FOR_PUBLICATION"
  ) {
    throw new Error(
      "Public release execution requires the protected GitHub Actions production workflow",
    );
  }
  const result = await promoteDesktopRelease({
    repository: "bignormal/aera",
    candidateRunId: values.candidate_run_id,
    sourceSha: values.source_sha,
    candidateManifestSha256: values.candidate_manifest_sha256,
    cloudSourceSha: values.cloud_source_sha,
    cloudImageDigest: values.cloud_image_digest,
    cloudCandidateManifestSha256: values.cloud_candidate_manifest_sha256,
    cloudDisabledRunId: values.cloud_disabled_run_id,
    cloudEnabledRunId: values.cloud_enabled_run_id,
    adminSourceSha: values.admin_source_sha,
    adminImageDigest: values.admin_image_digest,
    adminCandidateManifestSha256: values.admin_candidate_manifest_sha256,
    adminDisabledRunId: values.admin_disabled_run_id,
    adminEnabledRunId: values.admin_enabled_run_id,
    deviceEvidencePath: resolve(values.device_evidence),
    deviceEvidenceSha256: values.device_evidence_sha256,
    stagingEvidencePath: resolve(values.staging_evidence),
    stagingEvidenceSha256: values.staging_evidence_sha256,
    stagingSignaturePath: resolve(values.staging_signature),
    stagingSignatureSha256: values.staging_signature_sha256,
    stagingPublicKeyPath: resolve(values.staging_public_key),
    productionGatePath: resolve(values.production_gate),
    productionGateSha256: values.production_gate_sha256,
    releaseTag: values.release_tag,
    workspace: resolve(values.workspace),
  });
  process.stdout.write(`${canonicalJSONStringify(result)}`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  runCLI(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `Desktop publication failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
