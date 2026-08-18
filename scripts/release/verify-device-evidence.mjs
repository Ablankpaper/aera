#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { canonicalJSONStringify } from "./candidate-manifest.mjs";
import { validateCandidateDocument } from "./verify-candidate.mjs";
import { validateBeta33AcceptanceForRelease } from "../internal-beta/verify-beta33-acceptance.mjs";

export const REQUIRED_DEVICE_ROLES = Object.freeze([
  "macos_current",
  "macos_previous",
  "windows_physical",
  "windows_second",
]);

export const REQUIRED_SCENARIOS = Object.freeze([
  "cleanInstall",
  "upgradeFromPriorStable",
  "loginOnline",
  "validOfflineEntitlement",
  "officialAgentInstall",
  "officialAgentRun",
  "officialAgentUpdate",
  "officialAgentRollback",
  "existingRuntimeBindingStable",
  "newRuntimeBindingUsesSelectedRelease",
  "qualityConsentOffNoUpload",
  "qualityConsentOnFixedCodeOnly",
  "qualityConsentRevocationStopsUpload",
  "encryptedBackupCreate",
  "backupInterruptedResume",
  "backupDiskExhaustionFailsClosed",
  "backupCiphertextCorruptionRejected",
  "backupWrongPhraseRejected",
  "backupRevokedDeviceRejected",
  "authorizedDeviceRestore",
  "recoveryPhraseRestore",
  "restoredSessionRules",
  "appRestart",
  "osRestart",
  "uninstallReinstallPreservesProfile",
  "noPrivateDataUploadCanary",
]);

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIRECTORY, "..", "..");
const DEFAULT_SCHEMA = resolve(PROJECT_ROOT, "release", "evidence.schema.json");
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u;
const UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SAFE_TEXT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._ ()+-]{0,127}$/u;
const TESTER_REF_PATTERN =
  /^(?:employee|contractor):[A-Za-z0-9][A-Za-z0-9._-]{1,99}$/u;
const ACCOUNT_REF_PATTERN = /^qa-account:[A-Za-z0-9][A-Za-z0-9._-]{1,99}$/u;
const BACKUP_DEVICE_REF_PATTERN =
  /^backup-device:[A-Za-z0-9][A-Za-z0-9._-]{1,99}$/u;

export function candidateManifestSha256(raw) {
  if (typeof raw !== "string") {
    throw new Error("Candidate manifest bytes are required");
  }
  return createHash("sha256").update(raw).digest("hex");
}

export function validateDeviceEvidence(document, options) {
  const candidate = options?.candidate;
  const expectedManifestSha256 = options?.candidateManifestSha256;
  validateCandidateDocument(candidate);
  validateBeta33AcceptanceForRelease({
    acceptanceRaw: options?.beta33AcceptanceRaw,
    candidateManifestRaw: options?.beta33CandidateManifestRaw,
    sourceSha: candidate.sourceSha,
    version: candidate.version,
  });
  if (!DIGEST_PATTERN.test(expectedManifestSha256 ?? "")) {
    throw new Error("Expected candidate manifest digest is invalid");
  }

  exactFields(
    document,
    [
      "schemaVersion",
      "candidate",
      "supportPolicy",
      "coverage",
      "entries",
      "completedAt",
    ],
    "device evidence",
  );
  if (document.schemaVersion !== 1) {
    throw new Error("Device evidence schema version is unsupported");
  }
  validateCandidateIdentity(
    document.candidate,
    candidate,
    expectedManifestSha256,
  );
  validateSupportPolicy(document.supportPolicy);
  const coverage = validateCoverage(document.coverage);
  const completedAt = parseTime(document.completedAt, "completion time");
  const candidateCreatedAt = parseTime(
    candidate.createdAt,
    "candidate creation time",
  );
  const now =
    options?.now instanceof Date && Number.isFinite(options.now.getTime())
      ? options.now
      : new Date();
  if (completedAt.getTime() > now.getTime() + 5 * 60 * 1000) {
    throw new Error("Device evidence completion time is in the future");
  }
  if (!Array.isArray(document.entries) || document.entries.length !== 4) {
    throw new Error("Device evidence requires four independent entries");
  }

  const expectedRoles = new Set(REQUIRED_DEVICE_ROLES);
  const evidenceIds = new Set();
  const fingerprints = new Set();
  for (const entry of document.entries) {
    validateEntry(entry, {
      candidate,
      expectedManifestSha256,
      supportPolicy: document.supportPolicy,
      coverage,
      candidateCreatedAt,
      completedAt,
    });
    if (!expectedRoles.delete(entry.role)) {
      throw new Error("Each required device role must appear exactly once");
    }
    if (evidenceIds.has(entry.evidenceId)) {
      throw new Error("Device evidence ID is duplicated");
    }
    if (fingerprints.has(entry.deviceFingerprint)) {
      throw new Error("Device fingerprint is duplicated");
    }
    evidenceIds.add(entry.evidenceId);
    fingerprints.add(entry.deviceFingerprint);
  }
  if (expectedRoles.size !== 0) {
    throw new Error("Required device role evidence is missing");
  }
  const physicalWindows = document.entries.find(
    (entry) => entry.role === "windows_physical",
  );
  if (physicalWindows?.deviceClass !== "physical") {
    throw new Error("At least one physical Windows device is required");
  }
  return document;
}

function validateCandidateIdentity(identity, candidate, expectedDigest) {
  exactFields(
    identity,
    ["repository", "sourceSha", "version", "manifestSha256"],
    "device evidence candidate",
  );
  if (
    identity.repository !== "Ablankpaper/aera" ||
    identity.repository !== candidate.repository ||
    !SHA_PATTERN.test(identity.sourceSha ?? "") ||
    identity.sourceSha !== candidate.sourceSha ||
    !VERSION_PATTERN.test(identity.version ?? "") ||
    identity.version !== candidate.version ||
    identity.manifestSha256 !== expectedDigest
  ) {
    throw new Error("Device evidence candidate identity differs");
  }
}

function validateSupportPolicy(policy) {
  exactFields(
    policy,
    ["currentMacosMajor", "previousMacosMajor", "windowsMajor"],
    "device support policy",
  );
  if (
    !Number.isSafeInteger(policy.currentMacosMajor) ||
    !Number.isSafeInteger(policy.previousMacosMajor) ||
    policy.currentMacosMajor !== policy.previousMacosMajor + 1 ||
    policy.previousMacosMajor < 12 ||
    policy.windowsMajor !== 11
  ) {
    throw new Error("Device support policy is invalid");
  }
}

function validateCoverage(coverage) {
  exactFields(
    coverage,
    ["accountIdentityRefs", "backupDeviceIdentityRefs"],
    "device coverage",
  );
  const accounts = exactReferenceSet(
    coverage.accountIdentityRefs,
    ACCOUNT_REF_PATTERN,
    "two account identity references",
  );
  const backupDevices = exactReferenceSet(
    coverage.backupDeviceIdentityRefs,
    BACKUP_DEVICE_REF_PATTERN,
    "two backup device identity references",
  );
  return { accounts, backupDevices };
}

function exactReferenceSet(value, pattern, label) {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    new Set(value).size !== 2 ||
    value.some((item) => typeof item !== "string" || !pattern.test(item))
  ) {
    throw new Error(`Device evidence requires ${label}`);
  }
  return new Set(value);
}

function validateEntry(entry, context) {
  exactFields(
    entry,
    [
      "evidenceId",
      "role",
      "deviceFingerprint",
      "deviceClass",
      "os",
      "arch",
      "installedArtifact",
      "candidateManifestSha256",
      "signatureVerification",
      "scenarioResults",
      "testedAccountIdentityRefs",
      "backupAuthorizedDeviceIdentityRefs",
      "testedAt",
      "testerIdentityRef",
      "evidenceLinks",
    ],
    "device evidence entry",
  );
  if (
    !UUID_V7_PATTERN.test(entry.evidenceId ?? "") ||
    !REQUIRED_DEVICE_ROLES.includes(entry.role) ||
    !/^sha256:[0-9a-f]{64}$/u.test(entry.deviceFingerprint ?? "")
  ) {
    throw new Error("Device evidence ID, role, or fingerprint is invalid");
  }
  if (!TESTER_REF_PATTERN.test(entry.testerIdentityRef ?? "")) {
    throw new Error("Tester identity reference is invalid");
  }
  if (entry.candidateManifestSha256 !== context.expectedManifestSha256) {
    throw new Error("Entry candidate manifest digest differs");
  }
  validateRole(entry, context.supportPolicy);
  validateArtifact(entry, context.candidate);
  validateSignature(entry, context.candidate);
  validateScenarios(entry.scenarioResults);
  requireSameReferences(
    entry.testedAccountIdentityRefs,
    context.coverage.accounts,
    ACCOUNT_REF_PATTERN,
    "tested account",
  );
  requireSameReferences(
    entry.backupAuthorizedDeviceIdentityRefs,
    context.coverage.backupDevices,
    BACKUP_DEVICE_REF_PATTERN,
    "backup device",
  );
  const testedAt = parseTime(entry.testedAt, "device test time");
  if (
    testedAt.getTime() < context.candidateCreatedAt.getTime() ||
    testedAt.getTime() > context.completedAt.getTime()
  ) {
    throw new Error(
      "Device test time is outside the candidate evidence window",
    );
  }
  validateEvidenceLinks(entry.evidenceLinks);
}

function validateRole(entry, policy) {
  exactFields(entry.os, ["name", "major", "version", "build"], "device OS");
  if (
    !SAFE_TEXT_PATTERN.test(entry.os.name ?? "") ||
    !SAFE_TEXT_PATTERN.test(entry.os.version ?? "") ||
    !SAFE_TEXT_PATTERN.test(entry.os.build ?? "") ||
    !Number.isSafeInteger(entry.os.major)
  ) {
    throw new Error("Device OS evidence is invalid");
  }
  if (entry.role === "windows_physical" && entry.deviceClass !== "physical") {
    throw new Error("A physical Windows device is required");
  }
  const expectations = {
    macos_current: {
      classes: ["physical"],
      osName: "macOS",
      major: policy.currentMacosMajor,
      arch: "arm64",
    },
    macos_previous: {
      classes: ["physical"],
      osName: "macOS",
      major: policy.previousMacosMajor,
      arch: "arm64",
    },
    windows_physical: {
      classes: ["physical"],
      osName: "Windows 11",
      major: policy.windowsMajor,
      arch: "x64",
    },
    windows_second: {
      classes: ["physical", "trusted_vm"],
      osName: "Windows 11",
      major: policy.windowsMajor,
      arch: "x64",
    },
  };
  const expected = expectations[entry.role];
  if (
    !expected.classes.includes(entry.deviceClass) ||
    entry.os.name !== expected.osName ||
    entry.os.major !== expected.major ||
    entry.arch !== expected.arch
  ) {
    throw new Error(`Device role evidence is invalid for ${entry.role}`);
  }
}

function validateArtifact(entry, candidate) {
  exactFields(
    entry.installedArtifact,
    ["name", "sha256"],
    "installed candidate artifact",
  );
  const artifact = candidate.artifacts.find(
    (item) => item.name === entry.installedArtifact.name,
  );
  const expectedKind = {
    macos_current: "macos_dmg",
    macos_previous: "macos_dmg",
    windows_physical: "windows_setup",
    windows_second: "windows_portable",
  }[entry.role];
  if (
    artifact?.kind !== expectedKind ||
    artifact.sha256 !== entry.installedArtifact.sha256 ||
    artifact.releasable !== true
  ) {
    throw new Error("Installed artifact differs from the signed candidate");
  }
}

function validateSignature(entry, candidate) {
  const signature = entry.signatureVerification;
  exactFields(
    signature,
    [
      "verified",
      "method",
      "signerIdentityRef",
      "timestampVerified",
      "verificationLogSha256",
    ],
    "device signature verification",
  );
  if (
    signature.verified !== true ||
    !DIGEST_PATTERN.test(signature.verificationLogSha256 ?? "")
  ) {
    throw new Error("Device signature verification is missing");
  }
  const isMac = entry.role.startsWith("macos_");
  if (isMac) {
    const expectedSigner = `developer-id-team:${candidate.platformEvidence.macos.teamId}`;
    if (
      signature.method !== "codesign_spctl_stapler" ||
      signature.signerIdentityRef !== expectedSigner ||
      signature.timestampVerified !== true
    ) {
      throw new Error("macOS signer or notarization verification differs");
    }
  } else {
    const expectedSigner = `authenticode-thumbprint:${candidate.platformEvidence.windows.signerThumbprint}`;
    if (
      signature.method !== "authenticode_signtool" ||
      signature.signerIdentityRef !== expectedSigner
    ) {
      throw new Error("Windows Authenticode signer differs");
    }
    if (signature.timestampVerified !== true) {
      throw new Error("Windows Authenticode timestamp is missing");
    }
  }
}

function validateScenarios(scenarios) {
  exactFields(scenarios, REQUIRED_SCENARIOS, "device scenario results");
  if (REQUIRED_SCENARIOS.some((name) => scenarios[name] !== true)) {
    throw new Error("Every required device scenario must pass");
  }
}

function requireSameReferences(actual, expected, pattern, label) {
  if (
    !Array.isArray(actual) ||
    actual.length !== expected.size ||
    new Set(actual).size !== actual.length ||
    actual.some((item) => !pattern.test(item) || !expected.has(item))
  ) {
    throw new Error(`${label} coverage is incomplete`);
  }
}

function validateEvidenceLinks(links) {
  if (!Array.isArray(links) || links.length === 0 || links.length > 8) {
    throw new Error("Redacted evidence links are required");
  }
  for (const link of links) {
    try {
      if (typeof link !== "string" || link.length > 512) throw new Error();
      const parsed = new URL(link);
      if (
        parsed.protocol !== "https:" ||
        parsed.username !== "" ||
        parsed.password !== "" ||
        parsed.search !== "" ||
        parsed.hash !== "" ||
        parsed.hostname === "localhost" ||
        parsed.hostname.endsWith(".local") ||
        isIP(parsed.hostname) !== 0 ||
        parsed.pathname === "/"
      ) {
        throw new Error();
      }
    } catch {
      throw new Error("Evidence link is not a redacted HTTPS artifact link");
    }
  }
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

export function validateDeviceEvidenceSchema(schema) {
  const topLevelFields = [
    "schemaVersion",
    "candidate",
    "supportPolicy",
    "coverage",
    "entries",
    "completedAt",
  ];
  if (
    schema?.$id !==
      "https://github.com/Ablankpaper/aera/release/evidence.schema.json" ||
    schema?.properties?.schemaVersion?.const !== 1 ||
    schema?.additionalProperties !== false ||
    !sameNames(schema.required, topLevelFields) ||
    !sameNames(Object.keys(schema.properties ?? {}), topLevelFields)
  ) {
    throw new Error("Device evidence JSON schema identity is invalid");
  }
  const entry = schema?.$defs?.entry;
  const scenarios = schema?.$defs?.scenarioResults;
  if (
    entry?.additionalProperties !== false ||
    scenarios?.additionalProperties !== false ||
    !sameNames(entry.required, Object.keys(entry.properties ?? {})) ||
    !sameNames(scenarios.required, REQUIRED_SCENARIOS) ||
    !sameNames(Object.keys(scenarios.properties ?? {}), REQUIRED_SCENARIOS) ||
    REQUIRED_SCENARIOS.some(
      (name) => scenarios.properties[name]?.const !== true,
    )
  ) {
    throw new Error("Device evidence JSON schema differs from verifier policy");
  }
  return schema;
}

function sameNames(left, right) {
  return (
    Array.isArray(left) &&
    [...left].sort().join("\n") === [...right].sort().join("\n")
  );
}

function parseOptions(arguments_) {
  if (arguments_.length === 0 || arguments_.length % 2 !== 0) {
    throw new Error(
      "Device evidence verifier options must be flag/value pairs",
    );
  }
  const values = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error(
        "Device evidence verifier options must be flag/value pairs",
      );
    }
    const key = flag.slice(2).replaceAll("-", "_");
    if (Object.hasOwn(values, key))
      throw new Error(`Duplicate option: ${flag}`);
    values[key] = value;
  }
  return values;
}

async function runCLI(argv) {
  const [evidencePath, ...rest] = argv;
  if (!evidencePath) {
    throw new Error(
      "usage: verify-device-evidence.mjs EVIDENCE --candidate-manifest MANIFEST [--schema SCHEMA] [--beta33-acceptance LEDGER --beta33-candidate-manifest MANIFEST]",
    );
  }
  const options = parseOptions(rest);
  const [evidenceRaw, candidateRaw, schemaRaw] = await Promise.all([
    readFile(evidencePath, "utf8"),
    readFile(options.candidate_manifest, "utf8"),
    readFile(options.schema ?? DEFAULT_SCHEMA, "utf8"),
  ]);
  const [beta33AcceptanceRaw, beta33CandidateManifestRaw] = await Promise.all([
    options.beta33_acceptance
      ? readFile(options.beta33_acceptance, "utf8")
      : Promise.resolve(undefined),
    options.beta33_candidate_manifest
      ? readFile(options.beta33_candidate_manifest, "utf8")
      : Promise.resolve(undefined),
  ]);
  const evidence = JSON.parse(evidenceRaw);
  const candidate = JSON.parse(candidateRaw);
  const schema = JSON.parse(schemaRaw);
  if (evidenceRaw !== canonicalJSONStringify(evidence)) {
    throw new Error("Device evidence is not canonical JSON");
  }
  if (candidateRaw !== canonicalJSONStringify(candidate)) {
    throw new Error("Candidate manifest is not canonical JSON");
  }
  validateDeviceEvidenceSchema(schema);
  validateDeviceEvidence(evidence, {
    beta33AcceptanceRaw,
    beta33CandidateManifestRaw,
    candidate,
    candidateManifestSha256: candidateManifestSha256(candidateRaw),
  });
  process.stdout.write(
    `Real-device evidence verified for ${candidate.sourceSha} ${candidate.version}\n`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  runCLI(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `Real-device evidence verification failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
