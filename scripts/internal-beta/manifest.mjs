#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { isIP } from "node:net";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  buildSpdxDocument,
  canonicalJSONStringify,
  hashArtifact,
} from "../release/candidate-manifest.mjs";

export { canonicalJSONStringify };

export const INTERNAL_BETA_VERSION = "0.7.4-internal-beta.19";
export const INTERNAL_BETA_RUNTIME_SOURCE_SHA =
  "dcb0f0bc6a0e2d18c55beedc6517dbc41d8b01e0";
export const INTERNAL_BETA_WORKFLOW_IDENTITY =
  "https://github.com/bignormal/aera/.github/workflows/internal-beta.yml@refs/heads/main";
export const INTERNAL_BETA_OIDC_ISSUER =
  "https://token.actions.githubusercontent.com";

export const INTERNAL_BETA_ARTIFACTS = Object.freeze([
  Object.freeze({
    name: `Aera-Internal-Beta-${INTERNAL_BETA_VERSION}-macos-arm64.dmg`,
    platform: "macos",
    arch: "arm64",
    kind: "dmg",
  }),
  Object.freeze({
    name: `Aera-Internal-Beta-${INTERNAL_BETA_VERSION}-macos-arm64.zip`,
    platform: "macos",
    arch: "arm64",
    kind: "zip",
  }),
  Object.freeze({
    name: `Aera-Internal-Beta-${INTERNAL_BETA_VERSION}-windows-x64-setup.exe`,
    platform: "windows",
    arch: "x64",
    kind: "setup",
  }),
  Object.freeze({
    name: `Aera-Internal-Beta-${INTERNAL_BETA_VERSION}-windows-x64-portable.exe`,
    platform: "windows",
    arch: "x64",
    kind: "portable",
  }),
]);

const SHA1_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const KEY_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{2,63}$/u;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const ISO_SECONDS_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u;

const TOP_LEVEL_KEYS = [
  "artifacts",
  "build",
  "createdAt",
  "offlineTrust",
  "origin",
  "repository",
  "runtimeSeed",
  "schemaVersion",
  "signingStatus",
  "sourceSha",
  "supplyChain",
  "version",
];
const BUILD_KEYS = ["ciRunUrl", "runUrl", "workflow"];
const TRUST_KEYS = ["algorithm", "issuer", "keyId", "publicKey"];
const ARTIFACT_KEYS = ["arch", "kind", "name", "platform", "sha256", "size"];
const RUNTIME_KEYS = [
  "channel",
  "lockSha256",
  "releaseTag",
  "repository",
  "runtimeVersion",
  "sourceCommit",
  "targets",
];
const RUNTIME_TARGET_KEYS = [
  "arch",
  "archive",
  "manifest",
  "manifestSha256",
  "platform",
  "signature",
];
const SUPPLY_CHAIN_KEYS = [
  "manifestBundle",
  "oidcIssuer",
  "provenance",
  "provenanceBundle",
  "sbom",
  "signerIdentity",
];
const SUPPLY_FILE_KEYS = ["name", "sha256", "size"];
const RUNTIME_LOCK_KEYS = [
  "assets",
  "channel",
  "release_tag",
  "repository",
  "runtime_version",
  "schema_version",
  "source_commit",
];
const RUNTIME_ASSET_KEYS = [
  "arch",
  "archive",
  "manifest",
  "platform",
  "signature",
];

function exactObject(value, expectedKeys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  if (
    Object.keys(value).sort().join("\0") !== [...expectedKeys].sort().join("\0")
  ) {
    throw new Error(`${label} contains an unknown or missing field`);
  }
  return value;
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is required`);
  }
  return value;
}

function requiredDigest(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`${label} digest is invalid`);
  }
  return value;
}

function requiredPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} size is invalid`);
  }
  return value;
}

function requiredTimestamp(value, label) {
  if (
    typeof value !== "string" ||
    !ISO_SECONDS_PATTERN.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new Error(`${label} timestamp is invalid`);
  }
  return value;
}

function githubRunUrl(value, label) {
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname !== "github.com" ||
      !/^\/bignormal\/aera\/actions\/runs\/[1-9][0-9]*$/u.test(
        parsed.pathname,
      ) ||
      parsed.search !== "" ||
      parsed.hash !== ""
    ) {
      throw new Error();
    }
    return parsed.href;
  } catch {
    throw new Error(`${label} is not an exact GitHub Actions run URL`);
  }
}

function canonicalHttpsIpOrigin(value, label) {
  try {
    const parsed = new URL(value);
    const hostname = parsed.hostname.replace(/^\[|\]$/gu, "");
    if (
      parsed.protocol !== "https:" ||
      isIP(hostname) === 0 ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.pathname !== "/" ||
      parsed.search !== "" ||
      parsed.hash !== "" ||
      parsed.origin !== value
    ) {
      throw new Error();
    }
    return parsed.origin;
  } catch {
    throw new Error(`${label} must be one canonical HTTPS IP origin`);
  }
}

function canonicalEd25519PublicKey(value) {
  if (typeof value !== "string" || !BASE64URL_PATTERN.test(value)) {
    throw new Error("Offline public key must use canonical base64url");
  }
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length !== 32 || bytes.toString("base64url") !== value) {
    throw new Error("Offline public key must be one 32-byte Ed25519 key");
  }
  return value;
}

export function validateInternalBetaTrustInputs({
  origin,
  trustIssuer,
  offlineKeyId,
  offlinePublicKey,
}) {
  const canonicalOrigin = canonicalHttpsIpOrigin(
    origin,
    "Internal Beta origin",
  );
  const canonicalIssuer = canonicalHttpsIpOrigin(
    trustIssuer,
    "Offline trust issuer",
  );
  if (canonicalOrigin !== canonicalIssuer) {
    throw new Error("Offline trust issuer differs from the build origin");
  }
  if (typeof offlineKeyId !== "string" || !KEY_ID_PATTERN.test(offlineKeyId)) {
    throw new Error("Offline key ID is invalid");
  }
  return {
    origin: canonicalOrigin,
    trustIssuer: canonicalIssuer,
    offlineKeyId,
    offlinePublicKey: canonicalEd25519PublicKey(offlinePublicKey),
  };
}

function safeFilename(value, label) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u.test(value)
  ) {
    throw new Error(`${label} filename is invalid`);
  }
  return value;
}

async function readJson(path, label) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error(`${label} JSON is invalid`);
  }
}

function validateRuntimeLock(lock) {
  exactObject(lock, RUNTIME_LOCK_KEYS, "Runtime Seed lock");
  if (
    lock.schema_version !== 1 ||
    lock.repository !== "bignormal/aera-runtime" ||
    lock.source_commit !== INTERNAL_BETA_RUNTIME_SOURCE_SHA ||
    lock.channel !== "candidate" ||
    lock.runtime_version !== "0.18.2-agentera.1" ||
    lock.release_tag !== "runtime-v0.18.2-agentera.1-rc.4"
  ) {
    throw new Error(
      "Runtime Seed commit, channel, version, or release is not approved for internal Beta",
    );
  }
  exactObject(
    lock.assets,
    ["darwin-arm64", "windows-x64"],
    "Runtime Seed assets",
  );
  const expectedTargets = [
    ["darwin-arm64", "darwin", "arm64"],
    ["windows-x64", "windows", "x64"],
  ];
  for (const [key, platform, arch] of expectedTargets) {
    const asset = exactObject(
      lock.assets[key],
      RUNTIME_ASSET_KEYS,
      `Runtime Seed ${key} asset`,
    );
    if (asset.platform !== platform || asset.arch !== arch) {
      throw new Error(`Runtime Seed ${key} platform identity is invalid`);
    }
    for (const field of ["archive", "manifest", "signature"]) {
      safeFilename(asset[field], `Runtime Seed ${key} ${field}`);
    }
  }
  return lock;
}

function validateSupplyFile(value, expectedName, label) {
  exactObject(value, SUPPLY_FILE_KEYS, label);
  if (value.name !== expectedName) {
    throw new Error(`${label} filename is invalid`);
  }
  requiredDigest(value.sha256, label);
  requiredPositiveInteger(value.size, label);
}

export function validateInternalBetaManifest(document) {
  exactObject(document, TOP_LEVEL_KEYS, "Internal Beta manifest");
  if (
    document.schemaVersion !== 1 ||
    document.repository !== "bignormal/aera" ||
    typeof document.sourceSha !== "string" ||
    !SHA1_PATTERN.test(document.sourceSha) ||
    document.version !== INTERNAL_BETA_VERSION ||
    document.signingStatus !== "internal_only_unsigned"
  ) {
    throw new Error("Internal Beta manifest identity or schema is invalid");
  }
  requiredTimestamp(document.createdAt, "Internal Beta creation");
  const origin = canonicalHttpsIpOrigin(
    document.origin,
    "Internal Beta origin",
  );

  exactObject(document.build, BUILD_KEYS, "Internal Beta build");
  if (document.build.workflow !== "Desktop internal Beta candidate") {
    throw new Error("Internal Beta build workflow is invalid");
  }
  githubRunUrl(document.build.runUrl, "Internal Beta build run");
  githubRunUrl(document.build.ciRunUrl, "Internal Beta CI run");

  exactObject(document.offlineTrust, TRUST_KEYS, "Offline trust");
  if (
    document.offlineTrust.algorithm !== "Ed25519" ||
    document.offlineTrust.issuer !== origin ||
    typeof document.offlineTrust.keyId !== "string" ||
    !KEY_ID_PATTERN.test(document.offlineTrust.keyId)
  ) {
    throw new Error("Offline trust issuer or key ID is invalid");
  }
  canonicalEd25519PublicKey(document.offlineTrust.publicKey);

  if (
    !Array.isArray(document.artifacts) ||
    document.artifacts.length !== INTERNAL_BETA_ARTIFACTS.length
  ) {
    throw new Error(
      "Internal Beta artifact set is incomplete or contains duplicates",
    );
  }
  for (let index = 0; index < INTERNAL_BETA_ARTIFACTS.length; index += 1) {
    const actual = exactObject(
      document.artifacts[index],
      ARTIFACT_KEYS,
      `Internal Beta artifact ${index}`,
    );
    const expected = INTERNAL_BETA_ARTIFACTS[index];
    for (const field of ["name", "platform", "arch", "kind"]) {
      if (actual[field] !== expected[field]) {
        throw new Error(
          "Internal Beta artifact filename or platform identity is invalid",
        );
      }
    }
    requiredDigest(actual.sha256, `Internal Beta ${actual.name}`);
    requiredPositiveInteger(actual.size, `Internal Beta ${actual.name}`);
  }

  exactObject(document.runtimeSeed, RUNTIME_KEYS, "Runtime Seed evidence");
  if (
    document.runtimeSeed.repository !== "bignormal/aera-runtime" ||
    document.runtimeSeed.sourceCommit !== INTERNAL_BETA_RUNTIME_SOURCE_SHA ||
    document.runtimeSeed.channel !== "candidate" ||
    document.runtimeSeed.runtimeVersion !== "0.18.2-agentera.1" ||
    document.runtimeSeed.releaseTag !== "runtime-v0.18.2-agentera.1-rc.4"
  ) {
    throw new Error("Runtime Seed identity is not approved for internal Beta");
  }
  requiredDigest(document.runtimeSeed.lockSha256, "Runtime Seed lock");
  if (
    !Array.isArray(document.runtimeSeed.targets) ||
    document.runtimeSeed.targets.length !== 2
  ) {
    throw new Error("Runtime Seed platform evidence is incomplete");
  }
  const expectedRuntimeTargets = [
    { platform: "darwin", arch: "arm64" },
    { platform: "windows", arch: "x64" },
  ];
  for (let index = 0; index < expectedRuntimeTargets.length; index += 1) {
    const target = exactObject(
      document.runtimeSeed.targets[index],
      RUNTIME_TARGET_KEYS,
      `Runtime Seed target ${index}`,
    );
    const expected = expectedRuntimeTargets[index];
    if (
      target.platform !== expected.platform ||
      target.arch !== expected.arch
    ) {
      throw new Error("Runtime Seed platform identity is invalid");
    }
    for (const field of ["archive", "manifest", "signature"]) {
      safeFilename(target[field], `Runtime Seed ${field}`);
    }
    requiredDigest(target.manifestSha256, "Runtime Seed manifest");
  }

  exactObject(
    document.supplyChain,
    SUPPLY_CHAIN_KEYS,
    "Internal Beta supply chain",
  );
  if (
    document.supplyChain.manifestBundle !==
      "internal-beta-manifest.cosign.bundle.json" ||
    document.supplyChain.provenanceBundle !==
      "internal-beta-provenance.cosign.bundle.json" ||
    document.supplyChain.oidcIssuer !== INTERNAL_BETA_OIDC_ISSUER ||
    document.supplyChain.signerIdentity !== INTERNAL_BETA_WORKFLOW_IDENTITY
  ) {
    throw new Error("Internal Beta supply-chain identity is invalid");
  }
  validateSupplyFile(
    document.supplyChain.sbom,
    "internal-beta.spdx.json",
    "Internal Beta SBOM",
  );
  validateSupplyFile(
    document.supplyChain.provenance,
    "internal-beta.provenance.json",
    "Internal Beta provenance",
  );
  return document;
}

export function parseAndValidateInternalBetaManifest(raw) {
  let document;
  try {
    document = JSON.parse(raw);
  } catch {
    throw new Error("Internal Beta manifest JSON is invalid");
  }
  validateInternalBetaManifest(document);
  if (canonicalJSONStringify(document) !== raw) {
    throw new Error("Internal Beta manifest JSON is not canonical");
  }
  return document;
}

export async function buildInternalBetaManifest(options) {
  if (options.repository !== "bignormal/aera") {
    throw new Error("Internal Beta repository is invalid");
  }
  if (
    typeof options.sourceSha !== "string" ||
    !SHA1_PATTERN.test(options.sourceSha)
  ) {
    throw new Error("Internal Beta source SHA is invalid");
  }
  if (options.version !== INTERNAL_BETA_VERSION) {
    throw new Error("Internal Beta version is invalid");
  }
  const packageDocument = await readJson(options.packageJson, "package.json");
  if (
    packageDocument.name !== "agentera-studio" ||
    packageDocument.version !== INTERNAL_BETA_VERSION
  ) {
    throw new Error("package.json does not identify the internal Beta version");
  }
  const trust = validateInternalBetaTrustInputs(options);
  const runtime = validateRuntimeLock(
    await readJson(options.runtimeLock, "Runtime Seed lock"),
  );

  const artifacts = [];
  for (const specification of INTERNAL_BETA_ARTIFACTS) {
    const digest = await hashArtifact(
      join(options.artifactsDirectory, specification.name),
    );
    artifacts.push({
      ...specification,
      sha256: digest.sha256,
      size: digest.size,
    });
  }
  const runtimeTargets = [];
  for (const key of ["darwin-arm64", "windows-x64"]) {
    const asset = runtime.assets[key];
    const manifestDigest = await hashArtifact(
      join(options.runtimeManifestsDirectory, asset.manifest),
    );
    runtimeTargets.push({
      platform: asset.platform,
      arch: asset.arch,
      archive: asset.archive,
      manifest: asset.manifest,
      signature: asset.signature,
      manifestSha256: manifestDigest.sha256,
    });
  }
  const [runtimeLockDigest, sbomDigest, provenanceDigest] = await Promise.all([
    hashArtifact(options.runtimeLock),
    hashArtifact(options.sbom),
    hashArtifact(options.provenance),
  ]);

  const document = {
    schemaVersion: 1,
    repository: options.repository,
    sourceSha: options.sourceSha,
    version: options.version,
    origin: trust.origin,
    offlineTrust: {
      algorithm: "Ed25519",
      issuer: trust.trustIssuer,
      keyId: trust.offlineKeyId,
      publicKey: trust.offlinePublicKey,
    },
    build: {
      workflow: "Desktop internal Beta candidate",
      runUrl: githubRunUrl(options.buildRunUrl, "Internal Beta build run"),
      ciRunUrl: githubRunUrl(options.ciRunUrl, "Internal Beta CI run"),
    },
    signingStatus: "internal_only_unsigned",
    runtimeSeed: {
      repository: runtime.repository,
      sourceCommit: runtime.source_commit,
      runtimeVersion: runtime.runtime_version,
      releaseTag: runtime.release_tag,
      channel: runtime.channel,
      lockSha256: runtimeLockDigest.sha256,
      targets: runtimeTargets,
    },
    artifacts,
    supplyChain: {
      sbom: {
        name: "internal-beta.spdx.json",
        sha256: sbomDigest.sha256,
        size: sbomDigest.size,
      },
      provenance: {
        name: "internal-beta.provenance.json",
        sha256: provenanceDigest.sha256,
        size: provenanceDigest.size,
      },
      manifestBundle: "internal-beta-manifest.cosign.bundle.json",
      provenanceBundle: "internal-beta-provenance.cosign.bundle.json",
      signerIdentity: INTERNAL_BETA_WORKFLOW_IDENTITY,
      oidcIssuer: INTERNAL_BETA_OIDC_ISSUER,
    },
    createdAt: requiredTimestamp(options.createdAt, "Internal Beta creation"),
  };
  return validateInternalBetaManifest(document);
}

export async function verifyInternalBetaManifestFiles(document, options) {
  validateInternalBetaManifest(document);
  const rebuilt = await buildInternalBetaManifest(options);
  if (canonicalJSONStringify(rebuilt) !== canonicalJSONStringify(document)) {
    throw new Error(
      "Internal Beta manifest differs from artifact bytes or reviewed inputs",
    );
  }
  return document;
}

export async function buildInternalBetaProvenance(options) {
  const runtime = validateRuntimeLock(
    await readJson(options.runtimeLock, "Runtime Seed lock"),
  );
  const subjects = [];
  for (const artifact of INTERNAL_BETA_ARTIFACTS) {
    const digest = await hashArtifact(
      join(options.artifactsDirectory, artifact.name),
    );
    subjects.push({
      name: `artifacts/${artifact.name}`,
      digest: { sha256: digest.sha256 },
    });
  }
  const lockDigest = await hashArtifact(options.runtimeLock);
  return {
    _type: "https://in-toto.io/Statement/v1",
    subject: subjects,
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: {
      buildDefinition: {
        buildType: "https://github.com/bignormal/aera/internal-beta/v1",
        externalParameters: {
          origin: canonicalHttpsIpOrigin(
            options.origin,
            "Internal Beta origin",
          ),
          offlineKeyId: requiredString(options.offlineKeyId, "Offline key ID"),
          sourceSha: options.sourceSha,
          version: options.version,
        },
        internalParameters: {},
        resolvedDependencies: [
          {
            uri: `git+https://github.com/bignormal/aera@${options.sourceSha}`,
            digest: { gitCommit: options.sourceSha },
          },
          {
            uri: `git+https://github.com/${runtime.repository}@${runtime.source_commit}`,
            digest: { gitCommit: runtime.source_commit },
          },
          {
            uri: "file:build/agentera-runtime-seed.lock.json",
            digest: { sha256: lockDigest.sha256 },
          },
        ],
      },
      runDetails: {
        builder: { id: INTERNAL_BETA_WORKFLOW_IDENTITY },
        metadata: {
          invocationId: githubRunUrl(
            options.buildRunUrl,
            "Internal Beta build run",
          ),
          startedOn: requiredTimestamp(
            options.createdAt,
            "Internal Beta creation",
          ),
          finishedOn: requiredTimestamp(
            options.createdAt,
            "Internal Beta creation",
          ),
        },
        byproducts: [],
      },
    },
  };
}

function parseOptions(arguments_) {
  if (arguments_.length === 0 || arguments_.length % 2 !== 0) {
    throw new Error("Internal Beta options must be flag/value pairs");
  }
  const options = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error("Internal Beta options must be flag/value pairs");
    }
    const key = flag.slice(2).replaceAll("-", "_");
    if (Object.hasOwn(options, key)) {
      throw new Error(`Duplicate option: ${flag}`);
    }
    options[key] = value;
  }
  return options;
}

function buildOptions(values) {
  return {
    artifactsDirectory: values.artifacts_dir,
    buildRunUrl: values.build_run_url,
    ciRunUrl: values.ci_run_url,
    createdAt: values.created_at,
    offlineKeyId: values.offline_key_id,
    offlinePublicKey: values.offline_public_key,
    origin: values.origin,
    packageJson: values.package_json,
    provenance: values.provenance,
    repository: values.repository,
    runtimeLock: values.runtime_lock,
    runtimeManifestsDirectory: values.runtime_manifests_dir,
    sbom: values.sbom,
    sourceSha: values.source_sha,
    trustIssuer: values.trust_issuer,
    version: values.version,
  };
}

async function writeNewFile(path, contents) {
  await mkdir(dirname(resolve(path)), { recursive: true });
  await writeFile(path, contents, { flag: "wx", mode: 0o600 });
}

async function runCli(arguments_) {
  const [command, ...rest] = arguments_;
  const values = parseOptions(rest);
  if (command === "trust") {
    validateInternalBetaTrustInputs({
      origin: values.origin,
      trustIssuer: values.trust_issuer,
      offlineKeyId: values.offline_key_id,
      offlinePublicKey: values.offline_public_key,
    });
    return;
  }
  if (command === "sbom") {
    const document = buildSpdxDocument({
      packageLock: await readJson(values.package_lock, "package-lock.json"),
      runtimeLock: await readJson(values.runtime_lock, "Runtime Seed lock"),
      sourceSha: values.source_sha,
      createdAt: values.created_at,
    });
    await writeNewFile(values.output, canonicalJSONStringify(document));
    return;
  }
  if (command === "provenance") {
    const document = await buildInternalBetaProvenance({
      artifactsDirectory: values.artifacts_dir,
      buildRunUrl: values.build_run_url,
      createdAt: values.created_at,
      offlineKeyId: values.offline_key_id,
      origin: values.origin,
      runtimeLock: values.runtime_lock,
      sourceSha: values.source_sha,
      version: values.version,
    });
    await writeNewFile(values.output, canonicalJSONStringify(document));
    return;
  }
  if (command === "build") {
    const document = await buildInternalBetaManifest(buildOptions(values));
    await writeNewFile(values.output, canonicalJSONStringify(document));
    return;
  }
  if (command === "verify") {
    const raw = await readFile(values.manifest, "utf8");
    const document = parseAndValidateInternalBetaManifest(raw);
    await verifyInternalBetaManifestFiles(document, buildOptions(values));
    return;
  }
  throw new Error(
    "usage: manifest.mjs trust|sbom|provenance|build|verify --flag value ...",
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  runCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `Internal Beta manifest failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  });
}
