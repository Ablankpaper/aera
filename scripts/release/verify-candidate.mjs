#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  canonicalJSONStringify,
  hashArtifact,
  parseUpdateMetadata,
  updaterSha512,
} from "./candidate-manifest.mjs";

const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const SHA512_PATTERN = /^[0-9a-f]{128}$/u;
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u;
const SAFE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export function validateCandidateDocument(document, expected = {}) {
  exactFields(
    document,
    [
      "schemaVersion",
      "repository",
      "sourceSha",
      "version",
      "build",
      "runtimeSeed",
      "platformEvidence",
      "artifacts",
      "updateMetadata",
      "supplyChain",
      "linuxReleasable",
      "createdAt",
    ],
    "candidate",
  );
  if (
    document.schemaVersion !== 1 ||
    document.repository !== "Ablankpaper/aera"
  ) {
    throw new Error("Candidate schema or repository is invalid");
  }
  if (!SHA_PATTERN.test(document.sourceSha ?? "")) {
    throw new Error("Candidate source SHA is invalid");
  }
  if (
    expected.expectedSourceSha !== undefined &&
    document.sourceSha !== expected.expectedSourceSha
  ) {
    throw new Error(
      "Candidate source SHA does not match the expected source SHA",
    );
  }
  if (!VERSION_PATTERN.test(document.version ?? "")) {
    throw new Error("Candidate version is invalid");
  }
  if (
    expected.expectedVersion !== undefined &&
    document.version !== expected.expectedVersion
  ) {
    throw new Error("Candidate version does not match package version");
  }
  validateBuild(document.build);
  validateRuntimeSeed(document.runtimeSeed);
  const artifacts = validateArtifacts(document.artifacts);
  validateMacEvidence(document.platformEvidence?.macos, artifacts);
  validateWindowsEvidence(document.platformEvidence?.windows, artifacts);
  validateUpdateMetadata(document.updateMetadata, artifacts, document.version);
  validateSupplyChain(document.supplyChain);
  if (document.linuxReleasable !== false) {
    throw new Error("Linux must never be marked releasable");
  }
  if (!isISOTime(document.createdAt)) {
    throw new Error("Candidate creation time is invalid");
  }
  return document;
}

function validateBuild(build) {
  exactFields(build, ["workflow", "runUrl", "ciRunUrl"], "candidate build");
  if (build.workflow !== "Desktop signed candidate") {
    throw new Error("Candidate workflow identity is invalid");
  }
  for (const [label, value] of [
    ["candidate", build.runUrl],
    ["CI", build.ciRunUrl],
  ]) {
    if (
      typeof value !== "string" ||
      !/^https:\/\/github\.com\/Ablankpaper\/aera\/actions\/runs\/[1-9][0-9]*$/u.test(
        value,
      )
    ) {
      throw new Error(`${label} run URL is invalid`);
    }
  }
}

function validateRuntimeSeed(runtimeSeed) {
  exactFields(
    runtimeSeed,
    ["lockSha256", "sourceCommit", "runtimeVersion", "targets"],
    "Runtime Seed",
  );
  if (
    !DIGEST_PATTERN.test(runtimeSeed.lockSha256 ?? "") ||
    !SHA_PATTERN.test(runtimeSeed.sourceCommit ?? "") ||
    typeof runtimeSeed.runtimeVersion !== "string" ||
    runtimeSeed.runtimeVersion.length === 0 ||
    !Array.isArray(runtimeSeed.targets) ||
    runtimeSeed.targets.length !== 2
  ) {
    throw new Error("Runtime Seed evidence is invalid");
  }
  const expected = new Map([
    ["macos:arm64", false],
    ["windows:x64", false],
  ]);
  for (const target of runtimeSeed.targets) {
    exactFields(
      target,
      ["platform", "arch", "manifest", "manifestSha256"],
      "Runtime Seed manifest target",
    );
    const key = `${target.platform}:${target.arch}`;
    if (
      !expected.has(key) ||
      expected.get(key) ||
      !SAFE_NAME_PATTERN.test(target.manifest ?? "") ||
      !target.manifest.endsWith(".manifest.json") ||
      !DIGEST_PATTERN.test(target.manifestSha256 ?? "")
    ) {
      throw new Error("Runtime Seed manifest evidence is missing or invalid");
    }
    expected.set(key, true);
  }
}

function validateArtifacts(artifacts) {
  if (!Array.isArray(artifacts) || artifacts.length < 6) {
    throw new Error("Candidate artifact inventory is incomplete");
  }
  const byName = new Map();
  const byKind = new Map();
  for (const artifact of artifacts) {
    exactFields(
      artifact,
      [
        "name",
        "platform",
        "arch",
        "kind",
        "size",
        "sha256",
        "sha512",
        "releasable",
      ],
      "candidate artifact",
    );
    if (
      !SAFE_NAME_PATTERN.test(artifact.name ?? "") ||
      byName.has(artifact.name) ||
      !Number.isSafeInteger(artifact.size) ||
      artifact.size <= 0 ||
      !DIGEST_PATTERN.test(artifact.sha256 ?? "") ||
      !SHA512_PATTERN.test(artifact.sha512 ?? "") ||
      artifact.releasable !== true
    ) {
      throw new Error("Candidate artifact inventory is invalid");
    }
    if (artifact.platform === "linux") {
      throw new Error("Linux artifact cannot be releasable");
    }
    byName.set(artifact.name, artifact);
    if (!byKind.has(artifact.kind)) byKind.set(artifact.kind, []);
    byKind.get(artifact.kind).push(artifact);
  }

  const required = [
    ["macos_dmg", "macos", "arm64"],
    ["macos_zip", "macos", "arm64"],
    ["windows_setup", "windows", "x64"],
    ["windows_portable", "windows", "x64"],
  ];
  for (const [kind, platform, arch] of required) {
    const entries = byKind.get(kind) ?? [];
    if (
      entries.length !== 1 ||
      entries[0].platform !== platform ||
      entries[0].arch !== arch
    ) {
      throw new Error(`${kind} architecture or cardinality is invalid`);
    }
  }
  const metadata = byKind.get("update_metadata") ?? [];
  if (
    metadata.length !== 2 ||
    metadata.some(
      (entry) =>
        !(
          (entry.name === "latest-mac.yml" &&
            entry.platform === "macos" &&
            entry.arch === "arm64") ||
          (entry.name === "latest.yml" &&
            entry.platform === "windows" &&
            entry.arch === "x64")
        ),
    )
  ) {
    throw new Error("Candidate update metadata artifacts are invalid");
  }
  return { byName, byKind };
}

function validateMacEvidence(evidence, artifacts) {
  exactFields(
    evidence,
    [
      "arch",
      "signingIdentity",
      "teamId",
      "codesignVerified",
      "gatekeeperAccepted",
      "appStapled",
      "dmgStapled",
      "notarizations",
      "runtimeSeedVerifiedArtifacts",
      "nativeModuleArchitecture",
    ],
    "macOS evidence",
  );
  if (
    evidence.arch !== "arm64" ||
    evidence.nativeModuleArchitecture !== "arm64"
  ) {
    throw new Error("macOS native-module architecture evidence is invalid");
  }
  if (
    typeof evidence.signingIdentity !== "string" ||
    !evidence.signingIdentity.startsWith("Developer ID Application:") ||
    !/^[A-Z0-9]{10}$/u.test(evidence.teamId ?? "") ||
    !evidence.signingIdentity.includes(`(${evidence.teamId})`) ||
    evidence.codesignVerified !== true
  ) {
    throw new Error("macOS Developer ID signature evidence is invalid");
  }
  if (evidence.gatekeeperAccepted !== true) {
    throw new Error("macOS Gatekeeper evidence is invalid");
  }
  if (evidence.appStapled !== true || evidence.dmgStapled !== true) {
    throw new Error("macOS app and DMG must have stapled notarization tickets");
  }
  const required = [
    oneArtifact(artifacts, "macos_dmg").name,
    oneArtifact(artifacts, "macos_zip").name,
  ];
  requireExactNames(
    evidence.runtimeSeedVerifiedArtifacts,
    required,
    "macOS Runtime Seed",
  );
  if (!Array.isArray(evidence.notarizations)) {
    throw new Error("macOS notarization evidence is missing");
  }
  const notarized = new Map(
    evidence.notarizations.map((entry) => [entry?.artifact, entry]),
  );
  for (const name of required) {
    const entry = notarized.get(name);
    if (entry?.status !== "Accepted" || !UUID_PATTERN.test(entry?.id ?? "")) {
      throw new Error("macOS notarization evidence is missing or rejected");
    }
  }
}

function validateWindowsEvidence(evidence, artifacts) {
  exactFields(
    evidence,
    [
      "arch",
      "signerSubject",
      "signerThumbprint",
      "authenticodeVerifiedArtifacts",
      "timestampVerifiedArtifacts",
      "runtimeSeedVerifiedArtifacts",
      "nativeModuleArchitecture",
    ],
    "Windows evidence",
  );
  if (evidence.arch !== "x64" || evidence.nativeModuleArchitecture !== "x64") {
    throw new Error("Windows native-module architecture evidence is invalid");
  }
  if (
    typeof evidence.signerSubject !== "string" ||
    evidence.signerSubject.length === 0 ||
    !/^[0-9A-F]{40}$/u.test(evidence.signerThumbprint ?? "")
  ) {
    throw new Error("Windows Authenticode signer evidence is invalid");
  }
  const required = [
    oneArtifact(artifacts, "windows_setup").name,
    oneArtifact(artifacts, "windows_portable").name,
  ];
  requireExactNames(
    evidence.authenticodeVerifiedArtifacts,
    required,
    "Windows Authenticode",
  );
  requireExactNames(
    evidence.timestampVerifiedArtifacts,
    required,
    "Windows Authenticode timestamp",
  );
  requireExactNames(
    evidence.runtimeSeedVerifiedArtifacts,
    required,
    "Windows Runtime Seed",
  );
}

function validateUpdateMetadata(updateMetadata, artifacts, version) {
  exactFields(updateMetadata, ["macos", "windows"], "update metadata");
  for (const [platform, kind, file] of [
    ["macos", "macos_zip", "latest-mac.yml"],
    ["windows", "windows_setup", "latest.yml"],
  ]) {
    const item = updateMetadata[platform];
    exactFields(
      item,
      ["file", "version", "target", "targetSha512", "targetSize"],
      `${platform} update metadata`,
    );
    const target = oneArtifact(artifacts, kind);
    if (
      item.file !== file ||
      !artifacts.byName.has(file) ||
      item.version !== version ||
      item.target !== target.name ||
      item.targetSha512 !== updaterSha512(target.sha512) ||
      item.targetSize !== target.size
    ) {
      throw new Error(`${platform} update metadata is inconsistent`);
    }
  }
}

function validateSupplyChain(supplyChain) {
  exactFields(
    supplyChain,
    ["sbom", "provenance", "githubAttestation"],
    "supply chain",
  );
  for (const [label, value] of [
    ["SBOM", supplyChain.sbom],
    ["provenance", supplyChain.provenance],
  ]) {
    exactFields(value, ["name", "sha256"], label);
    if (
      !SAFE_NAME_PATTERN.test(value.name ?? "") ||
      !DIGEST_PATTERN.test(value.sha256 ?? "")
    ) {
      throw new Error(`${label} evidence is invalid`);
    }
  }
  exactFields(
    supplyChain.githubAttestation,
    ["required", "signerWorkflow"],
    "GitHub attestation",
  );
  if (
    supplyChain.githubAttestation.required !== true ||
    supplyChain.githubAttestation.signerWorkflow !==
      "github.com/Ablankpaper/aera/.github/workflows/release-candidate.yml"
  ) {
    throw new Error("GitHub artifact attestation policy is invalid");
  }
}

function oneArtifact(artifacts, kind) {
  const entries = artifacts.byKind.get(kind) ?? [];
  if (entries.length !== 1) {
    throw new Error(`Expected exactly one ${kind} artifact`);
  }
  return entries[0];
}

function requireExactNames(actual, expected, label) {
  if (
    !Array.isArray(actual) ||
    actual.length !== expected.length ||
    [...actual].sort().join("\n") !== [...expected].sort().join("\n")
  ) {
    throw new Error(`${label} artifact evidence is incomplete`);
  }
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

export async function verifyCandidateFiles(document, options) {
  validateCandidateDocument(document, options);
  const artifactsDirectory = resolve(options.artifactsDirectory);
  for (const artifact of document.artifacts) {
    const actual = await hashArtifact(join(artifactsDirectory, artifact.name));
    if (
      actual.size !== artifact.size ||
      actual.sha256 !== artifact.sha256 ||
      actual.sha512 !== artifact.sha512
    ) {
      throw new Error(`Candidate artifact hash differs: ${artifact.name}`);
    }
  }
  const runtimeLock = await hashArtifact(options.runtimeLock);
  if (runtimeLock.sha256 !== document.runtimeSeed.lockSha256) {
    throw new Error("Runtime Seed lock hash differs");
  }
  const runtimeDocument = JSON.parse(
    await readFile(options.runtimeLock, "utf8"),
  );
  if (
    runtimeDocument.source_commit !== document.runtimeSeed.sourceCommit ||
    runtimeDocument.runtime_version !== document.runtimeSeed.runtimeVersion
  ) {
    throw new Error("Runtime Seed lock identity differs");
  }
  for (const [label, descriptor, path] of [
    ["SBOM", document.supplyChain.sbom, options.sbom],
    ["provenance", document.supplyChain.provenance, options.provenance],
  ]) {
    const actual = await hashArtifact(path);
    if (actual.sha256 !== descriptor.sha256) {
      throw new Error(`${label} hash differs`);
    }
  }
  for (const [platform, file] of [
    ["macos", "latest-mac.yml"],
    ["windows", "latest.yml"],
  ]) {
    const parsed = parseUpdateMetadata(
      await readFile(join(artifactsDirectory, file), "utf8"),
    );
    const expected = document.updateMetadata[platform];
    for (const field of ["version", "target", "targetSha512", "targetSize"]) {
      if (parsed[field] !== expected[field]) {
        throw new Error(`${platform} update metadata file is inconsistent`);
      }
    }
  }
  return document;
}

async function runCLI(argv) {
  const [manifestPath, ...rest] = argv;
  if (!manifestPath) {
    throw new Error(
      "usage: verify-candidate.mjs MANIFEST --artifacts-dir DIR --runtime-lock FILE --sbom FILE --provenance FILE --expected-source-sha SHA --expected-version VERSION",
    );
  }
  const options = parseOptions(rest);
  const raw = await readFile(manifestPath, "utf8");
  const document = JSON.parse(raw);
  if (raw !== canonicalJSONStringify(document)) {
    throw new Error("Candidate manifest is not canonical JSON");
  }
  await verifyCandidateFiles(document, {
    artifactsDirectory: options.artifacts_dir,
    runtimeLock: options.runtime_lock,
    sbom: options.sbom,
    provenance: options.provenance,
    expectedSourceSha: options.expected_source_sha,
    expectedVersion: options.expected_version,
  });
  process.stdout.write(
    `Desktop candidate verified: ${document.sourceSha} ${document.version}\n`,
  );
}

function parseOptions(arguments_) {
  if (arguments_.length === 0 || arguments_.length % 2 !== 0) {
    throw new Error("Candidate verifier options must be flag/value pairs");
  }
  const values = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error("Candidate verifier options must be flag/value pairs");
    }
    const key = flag.slice(2).replaceAll("-", "_");
    if (Object.hasOwn(values, key))
      throw new Error(`Duplicate option: ${flag}`);
    values[key] = value;
  }
  return values;
}

function isISOTime(value) {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  runCLI(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `Desktop candidate verification failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
