#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { hashArtifact } from "../release/candidate-manifest.mjs";
import { validateBeta33AcceptanceForRelease } from "./verify-beta33-acceptance.mjs";
import {
  INTERNAL_BETA_RUNTIME_SOURCE_SHA,
  canonicalJSONStringify,
  parseAndValidateInternalBetaManifest,
} from "./manifest.mjs";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIRECTORY, "..", "..");
const DEFAULT_SCHEMA = path.join(
  PROJECT_ROOT,
  "release",
  "internal-beta-evidence.schema.json",
);
const SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const SAFE_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u;
const COARSE_PLATFORM = /^(?:macOS|Windows) [0-9]{1,2}$/u;
const TIMESTAMP =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{3})?Z$/u;

export const LIVE_OUTCOME_KEYS = Object.freeze([
  "httpsHealth",
  "cloudHealth",
  "adminPrivateHealth",
  "directRegistration",
  "registrationRecoveryUnavailable",
  "login",
  "offlineEntitlement",
  "offlineBoundedUse",
  "invalidOfflineIssuerRejected",
  "invalidOfflineKeyRejected",
  "invalidOfflineSignatureRejected",
  "invalidOfflineBindingRejected",
  "macosInstall",
  "windowsInstall",
  "officialAgentInstall",
  "officialAgentTurn",
  "qualityOffNoUpload",
  "qualityOnFixedCodeOnly",
  "encryptedBackupCreate",
  "backupInterruptedResume",
  "secondDeviceRestore",
  "backupTamperRejected",
  "backupWrongPhraseRejected",
  "backupRevokedDeviceRejected",
  "appRestart",
  "signOutSignIn",
  "uninstallReinstall",
]);

const PACKAGE_ROLES = Object.freeze([
  "macos_arm64_dmg",
  "macos_arm64_zip",
  "windows_x64_setup",
  "windows_x64_portable",
  "windows_x64_app_zip",
]);

function fail(message) {
  throw new Error(`Internal Beta live evidence is invalid: ${message}`);
}

function exactObject(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  if (Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) {
    fail(`${label} contains an unknown or missing field`);
  }
  return value;
}

function exactString(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) {
    fail(`${label} is invalid`);
  }
  return value;
}

function parseTimestamp(value, label) {
  exactString(value, TIMESTAMP, label);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    fail(`${label} is invalid`);
  }
  const canonical = parsed.toISOString();
  if (canonical !== value && canonical.replace(/\.000Z$/u, "Z") !== value) {
    fail(`${label} is not canonical`);
  }
  return parsed;
}

function runUrl(value, repository, label) {
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname !== "github.com" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.port !== "" ||
      parsed.search !== "" ||
      parsed.hash !== "" ||
      parsed.href !== value ||
      parsed.pathname !==
        `/Ablankpaper/${repository}/actions/runs/${parsed.pathname
          .split("/")
          .at(-1)}` ||
      !/^[1-9][0-9]*$/u.test(parsed.pathname.split("/").at(-1) ?? "")
    ) {
      throw new Error();
    }
    return value;
  } catch {
    fail(`${label} must be one exact ${repository} Actions run URL`);
  }
}

function hashRaw(raw) {
  return createHash("sha256").update(raw).digest("hex");
}

function parseCanonicalJson(raw, label) {
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > 1024 * 1024) {
    fail(`${label} bytes are unavailable or oversized`);
  }
  let document;
  try {
    document = JSON.parse(raw);
  } catch {
    fail(`${label} JSON is invalid`);
  }
  if (canonicalJSONStringify(document) !== raw) {
    fail(`${label} JSON is not canonical`);
  }
  return document;
}

function validateImage(image, repository, label) {
  exactObject(image, ["reference", "digest"], label);
  exactString(image.digest, IMAGE_DIGEST, `${label} digest`);
  if (image.reference !== `ghcr.io/ablankpaper/${repository}@${image.digest}`) {
    fail(`${label} reference is not its immutable GHCR digest`);
  }
}

function validateSupplyChain(value, label) {
  exactObject(value, ["sbomDigest", "provenanceDigest"], label);
  exactString(value.sbomDigest, IMAGE_DIGEST, `${label} SBOM digest`);
  exactString(
    value.provenanceDigest,
    IMAGE_DIGEST,
    `${label} provenance digest`,
  );
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail(`${label} must be a positive integer`);
  }
}

function validateCloudManifest(raw) {
  const document = parseCanonicalJson(raw, "Cloud candidate manifest");
  exactObject(
    document,
    [
      "schemaVersion",
      "repository",
      "commitSha",
      "image",
      "build",
      "schema",
      "supplyChain",
      "features",
      "createdAt",
    ],
    "Cloud candidate manifest",
  );
  if (
    document.schemaVersion !== 1 ||
    document.repository !== "Ablankpaper/aera-cloud"
  ) {
    fail("Cloud candidate schema or repository is invalid");
  }
  exactString(document.commitSha, SHA, "Cloud candidate SHA");
  validateImage(document.image, "aera-cloud", "Cloud candidate image");
  exactObject(document.build, ["workflow", "runUrl"], "Cloud candidate build");
  if (document.build.workflow !== "Cloud candidate") {
    fail("Cloud candidate workflow is invalid");
  }
  runUrl(document.build.runUrl, "aera-cloud", "Cloud candidate run");
  exactObject(
    document.schema,
    ["minimum", "maximum", "highestMigration"],
    "Cloud candidate schema range",
  );
  positiveInteger(document.schema.minimum, "Cloud schema minimum");
  positiveInteger(document.schema.maximum, "Cloud schema maximum");
  positiveInteger(document.schema.highestMigration, "Cloud highest migration");
  if (
    document.schema.minimum > document.schema.highestMigration ||
    document.schema.highestMigration > document.schema.maximum
  ) {
    fail("Cloud highest migration is outside its candidate range");
  }
  validateSupplyChain(document.supplyChain, "Cloud candidate supply chain");
  exactObject(
    document.features,
    ["officialQualityEnabledByDefault", "encryptedBackupEnabledByDefault"],
    "Cloud candidate feature defaults",
  );
  if (
    document.features.officialQualityEnabledByDefault !== false ||
    document.features.encryptedBackupEnabledByDefault !== false
  ) {
    fail("Cloud candidate must keep features disabled by default");
  }
  parseTimestamp(document.createdAt, "Cloud candidate creation");
  return document;
}

function validateAdminManifest(raw, cloud) {
  const document = parseCanonicalJson(raw, "Admin candidate manifest");
  exactObject(
    document,
    [
      "schemaVersion",
      "repository",
      "commitSha",
      "image",
      "build",
      "adminSchema",
      "compatibility",
      "supplyChain",
      "mutationsEnabledByDefault",
      "createdAt",
    ],
    "Admin candidate manifest",
  );
  if (
    document.schemaVersion !== 1 ||
    document.repository !== "Ablankpaper/aera-admin"
  ) {
    fail("Admin candidate schema or repository is invalid");
  }
  exactString(document.commitSha, SHA, "Admin candidate SHA");
  validateImage(document.image, "aera-admin", "Admin candidate image");
  exactObject(document.build, ["workflow", "runUrl"], "Admin candidate build");
  if (document.build.workflow !== "Admin candidate") {
    fail("Admin candidate workflow is invalid");
  }
  runUrl(document.build.runUrl, "aera-admin", "Admin candidate run");
  exactObject(
    document.adminSchema,
    ["minimum", "maximum", "highestMigration"],
    "Admin candidate schema range",
  );
  for (const field of ["minimum", "maximum", "highestMigration"]) {
    positiveInteger(document.adminSchema[field], `Admin schema ${field}`);
  }
  if (
    document.adminSchema.minimum > document.adminSchema.highestMigration ||
    document.adminSchema.highestMigration > document.adminSchema.maximum
  ) {
    fail("Admin highest migration is outside its candidate range");
  }
  exactObject(
    document.compatibility,
    [
      "cloudCommitSha",
      "cloudInternalApiVersion",
      "cloudSchemaMinimum",
      "cloudSchemaMaximum",
    ],
    "Admin Cloud compatibility",
  );
  if (
    document.compatibility.cloudCommitSha !== cloud.commitSha ||
    document.compatibility.cloudInternalApiVersion !== "v1" ||
    document.compatibility.cloudSchemaMinimum > cloud.schema.highestMigration ||
    document.compatibility.cloudSchemaMaximum < cloud.schema.highestMigration
  ) {
    fail("Admin candidate does not bind the exact compatible Cloud candidate");
  }
  positiveInteger(
    document.compatibility.cloudSchemaMinimum,
    "Admin Cloud schema minimum",
  );
  positiveInteger(
    document.compatibility.cloudSchemaMaximum,
    "Admin Cloud schema maximum",
  );
  validateSupplyChain(document.supplyChain, "Admin candidate supply chain");
  if (document.mutationsEnabledByDefault !== false) {
    fail("Admin candidate must keep mutations disabled by default");
  }
  parseTimestamp(document.createdAt, "Admin candidate creation");
  return document;
}

function sameKeys(actual, expected, label) {
  if (
    !Array.isArray(actual) ||
    actual.length !== expected.length ||
    actual.some((value, index) => value !== expected[index])
  ) {
    fail(`${label} is incomplete or reordered`);
  }
}

export function validateLiveEvidenceSchema(schema) {
  exactObject(
    schema,
    [
      "$schema",
      "$id",
      "title",
      "type",
      "additionalProperties",
      "$defs",
      "properties",
      "required",
    ],
    "live evidence JSON schema",
  );
  if (
    schema.$schema !== "https://json-schema.org/draft/2020-12/schema" ||
    schema.type !== "object" ||
    schema.additionalProperties !== false
  ) {
    fail("live evidence JSON schema root is not closed");
  }

  function inspect(node, label) {
    if (node === null || typeof node !== "object" || Array.isArray(node)) {
      fail(`${label} schema is invalid`);
    }
    if (node.type === "object" && node.additionalProperties !== false) {
      fail(`${label} object schema is not closed`);
    }
    if (node.properties) {
      for (const [key, child] of Object.entries(node.properties)) {
        inspect(child, `${label}.${key}`);
      }
    }
    if (node.items) {
      inspect(node.items, `${label}[]`);
    }
  }
  inspect(schema, "root");
  for (const [key, definition] of Object.entries(schema.$defs)) {
    inspect(definition, `$defs.${key}`);
  }
  sameKeys(
    schema.required,
    [
      "schemaVersion",
      "status",
      "completedAt",
      "sources",
      "deployment",
      "packages",
      "platforms",
      "outcomes",
    ],
    "schema root requirements",
  );
  sameKeys(
    schema.properties.outcomes.required,
    LIVE_OUTCOME_KEYS,
    "schema outcome requirements",
  );
  if (
    Object.keys(schema.properties.outcomes.properties).sort().join("\0") !==
    [...LIVE_OUTCOME_KEYS].sort().join("\0")
  ) {
    fail("schema outcome properties differ from the fixed scenario set");
  }
  for (const key of LIVE_OUTCOME_KEYS) {
    if (schema.properties.outcomes.properties[key]?.const !== "passed") {
      fail(`schema outcome ${key} is not fixed to passed`);
    }
  }
  return schema;
}

function validateSources(sources, context) {
  exactObject(sources, ["desktop", "cloud", "admin", "runtime"], "sources");
  exactObject(
    sources.desktop,
    ["sha", "ciRunUrl", "candidateRunUrl", "candidateManifestSha256"],
    "Desktop source",
  );
  exactString(sources.desktop.sha, SHA, "Desktop source SHA");
  runUrl(sources.desktop.ciRunUrl, "aera", "Desktop CI run");
  runUrl(sources.desktop.candidateRunUrl, "aera", "Desktop candidate run");
  exactString(
    sources.desktop.candidateManifestSha256,
    SHA256,
    "Desktop candidate manifest digest",
  );
  if (
    sources.desktop.sha !== context.desktop.sourceSha ||
    sources.desktop.ciRunUrl !== context.desktop.build.ciRunUrl ||
    sources.desktop.candidateRunUrl !== context.desktop.build.runUrl ||
    sources.desktop.candidateManifestSha256 !==
      hashRaw(context.desktopManifestRaw)
  ) {
    fail("Desktop candidate identity or manifest digest differs");
  }

  for (const [role, repository, manifest, raw] of [
    ["cloud", "aera-cloud", context.cloud, context.cloudManifestRaw],
    ["admin", "aera-admin", context.admin, context.adminManifestRaw],
  ]) {
    const source = sources[role];
    exactObject(
      source,
      [
        "sha",
        "ciRunUrl",
        "candidateRunUrl",
        "candidateManifestSha256",
        "imageDigest",
      ],
      `${role} source`,
    );
    exactString(source.sha, SHA, `${role} source SHA`);
    runUrl(source.ciRunUrl, repository, `${role} CI run`);
    runUrl(source.candidateRunUrl, repository, `${role} candidate run`);
    exactString(
      source.candidateManifestSha256,
      SHA256,
      `${role} candidate manifest digest`,
    );
    exactString(source.imageDigest, IMAGE_DIGEST, `${role} image digest`);
    if (
      source.sha !== manifest.commitSha ||
      source.candidateRunUrl !== manifest.build.runUrl ||
      source.candidateManifestSha256 !== hashRaw(raw) ||
      source.imageDigest !== manifest.image.digest
    ) {
      fail(`${role} candidate identity or manifest digest differs`);
    }
  }

  exactObject(sources.runtime, ["sha", "lockSha256"], "Runtime source");
  exactString(sources.runtime.sha, SHA, "Runtime source SHA");
  exactString(sources.runtime.lockSha256, SHA256, "Runtime lock digest");
  if (
    sources.runtime.sha !== INTERNAL_BETA_RUNTIME_SOURCE_SHA ||
    sources.runtime.sha !== context.desktop.runtimeSeed.sourceCommit ||
    sources.runtime.lockSha256 !== context.desktop.runtimeSeed.lockSha256
  ) {
    fail("Runtime source or lock identity differs");
  }
}

function validateDeployment(deployment, context, completedAt) {
  exactObject(
    deployment,
    [
      "cloudImageDigest",
      "adminImageDigest",
      "certificateExpiresAt",
      "registrationMode",
      "publicRegistrationEnabled",
      "officialAgentsEnabled",
      "officialQualityEnabled",
      "encryptedBackupEnabled",
      "adminMutationsEnabled",
    ],
    "deployment",
  );
  if (
    deployment.cloudImageDigest !== context.cloud.image.digest ||
    deployment.adminImageDigest !== context.admin.image.digest
  ) {
    fail("deployed image digest differs from its candidate");
  }
  if (
    deployment.registrationMode !== "direct" ||
    deployment.publicRegistrationEnabled !== true ||
    deployment.officialAgentsEnabled !== true ||
    deployment.officialQualityEnabled !== true ||
    deployment.encryptedBackupEnabled !== true ||
    deployment.adminMutationsEnabled !== false
  ) {
    fail("deployment feature or direct-registration mode is invalid");
  }
  const expiresAt = parseTimestamp(
    deployment.certificateExpiresAt,
    "certificate expiry",
  );
  const remaining = expiresAt.getTime() - completedAt.getTime();
  if (remaining <= 24 * 60 * 60 * 1000 || remaining > 8 * 24 * 60 * 60 * 1000) {
    fail("certificate expiry is outside the short-lived acceptance window");
  }
}

async function validatePackages(packages, context) {
  if (!Array.isArray(packages) || packages.length !== PACKAGE_ROLES.length) {
    fail("package evidence requires the complete candidate artifact set");
  }
  if (
    typeof context.artifactsDirectory !== "string" ||
    !path.isAbsolute(context.artifactsDirectory)
  ) {
    fail("artifact directory must be absolute");
  }
  const packageMap = new Map();
  for (let index = 0; index < packages.length; index += 1) {
    const item = packages[index];
    const expectedRole = PACKAGE_ROLES[index];
    const expected = context.desktop.artifacts[index];
    exactObject(item, ["role", "name", "sha256"], `package ${index}`);
    if (
      item.role !== expectedRole ||
      item.name !== expected.name ||
      item.sha256 !== expected.sha256 ||
      !SAFE_FILENAME.test(item.name)
    ) {
      fail("package identity or manifest hash differs");
    }
    const artifactPath = path.join(context.artifactsDirectory, item.name);
    const metadata = await lstat(artifactPath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      fail("package artifact must be one regular file");
    }
    const actual = await hashArtifact(artifactPath);
    if (actual.sha256 !== item.sha256 || actual.size !== expected.size) {
      fail("package artifact digest or size differs from the manifest");
    }
    packageMap.set(item.role, item);
  }
  return packageMap;
}

function validatePlatforms(platforms, packageMap) {
  if (!Array.isArray(platforms) || platforms.length !== 2) {
    fail("platform evidence requires Mac and Windows roles");
  }
  const expected = [
    {
      role: "macos_arm64",
      prefix: "macOS ",
      packageRole: "macos_arm64_dmg",
    },
    {
      role: "windows_x64",
      prefix: "Windows ",
      packageRole: "windows_x64_setup",
    },
  ];
  for (let index = 0; index < expected.length; index += 1) {
    const item = platforms[index];
    const requirement = expected[index];
    exactObject(
      item,
      [
        "role",
        "platformVersion",
        "installedPackageRole",
        "installedPackageSha256",
      ],
      `platform ${index}`,
    );
    const installed = packageMap.get(requirement.packageRole);
    if (
      item.role !== requirement.role ||
      !COARSE_PLATFORM.test(item.platformVersion ?? "") ||
      !item.platformVersion.startsWith(requirement.prefix) ||
      item.installedPackageRole !== requirement.packageRole ||
      item.installedPackageSha256 !== installed?.sha256
    ) {
      fail("platform role or installed package identity differs");
    }
  }
}

function validateOutcomes(outcomes) {
  exactObject(outcomes, LIVE_OUTCOME_KEYS, "outcomes");
  for (const key of LIVE_OUTCOME_KEYS) {
    if (outcomes[key] !== "passed") {
      fail(`outcome scenario ${key} did not pass`);
    }
  }
}

export async function validateLiveEvidence(document, options) {
  validateLiveEvidenceSchema(options?.schema);
  const desktopManifestRaw = options?.desktopManifestRaw;
  const cloudManifestRaw = options?.cloudManifestRaw;
  const adminManifestRaw = options?.adminManifestRaw;
  const desktop = parseAndValidateInternalBetaManifest(desktopManifestRaw);
  const cloud = validateCloudManifest(cloudManifestRaw);
  const admin = validateAdminManifest(adminManifestRaw, cloud);
  const context = {
    admin,
    adminManifestRaw,
    artifactsDirectory: options?.artifactsDirectory,
    cloud,
    cloudManifestRaw,
    desktop,
    desktopManifestRaw,
  };

  exactObject(
    document,
    [
      "schemaVersion",
      "status",
      "completedAt",
      "sources",
      "deployment",
      "packages",
      "platforms",
      "outcomes",
    ],
    "live evidence",
  );
  if (
    document.schemaVersion !== 1 ||
    document.status !== "INTERNAL_BETA_ACCEPTED"
  ) {
    fail("status or schema version is invalid");
  }
  const completedAt = parseTimestamp(document.completedAt, "completion time");
  const now =
    options?.now instanceof Date && Number.isFinite(options.now.getTime())
      ? options.now
      : new Date();
  if (completedAt.getTime() > now.getTime() + 5 * 60 * 1000) {
    fail("completion time is in the future");
  }
  for (const [label, manifest] of [
    ["Desktop", desktop],
    ["Cloud", cloud],
    ["Admin", admin],
  ]) {
    if (
      parseTimestamp(
        manifest.createdAt,
        `${label} candidate creation`,
      ).getTime() > completedAt.getTime()
    ) {
      fail(`${label} candidate was created after acceptance`);
    }
  }

  validateSources(document.sources, context);
  validateDeployment(document.deployment, context, completedAt);
  const packageMap = await validatePackages(document.packages, context);
  validatePlatforms(document.platforms, packageMap);
  validateOutcomes(document.outcomes);
  validateBeta33AcceptanceForRelease({
    acceptanceRaw: options?.beta33AcceptanceRaw,
    candidateManifestRaw: desktopManifestRaw,
    releaseCompletedAt: document.completedAt,
    sourceSha: desktop.sourceSha,
    version: desktop.version,
  });
  return document;
}

export async function parseAndValidateLiveEvidence(raw, options) {
  const document = parseCanonicalJson(raw, "live evidence");
  await validateLiveEvidence(document, options);
  return document;
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (
      ![
        "--evidence",
        "--desktop-manifest",
        "--cloud-manifest",
        "--admin-manifest",
        "--artifacts",
        "--schema",
        "--beta33-acceptance",
      ].includes(key) ||
      typeof value !== "string"
    ) {
      fail("command arguments are invalid");
    }
    if (Object.hasOwn(values, key)) {
      fail("command argument is duplicated");
    }
    values[key] = value;
  }
  for (const key of [
    "--evidence",
    "--desktop-manifest",
    "--cloud-manifest",
    "--admin-manifest",
    "--artifacts",
  ]) {
    if (!values[key]) {
      fail(`${key} is required`);
    }
  }
  return values;
}

async function main(argv) {
  const values = parseArguments(argv);
  const [
    evidenceRaw,
    desktopManifestRaw,
    cloudManifestRaw,
    adminManifestRaw,
    schemaRaw,
    beta33AcceptanceRaw,
  ] = await Promise.all([
    readFile(values["--evidence"], "utf8"),
    readFile(values["--desktop-manifest"], "utf8"),
    readFile(values["--cloud-manifest"], "utf8"),
    readFile(values["--admin-manifest"], "utf8"),
    readFile(values["--schema"] ?? DEFAULT_SCHEMA, "utf8"),
    values["--beta33-acceptance"]
      ? readFile(values["--beta33-acceptance"], "utf8")
      : Promise.resolve(undefined),
  ]);
  await parseAndValidateLiveEvidence(evidenceRaw, {
    adminManifestRaw,
    artifactsDirectory: path.resolve(values["--artifacts"]),
    beta33AcceptanceRaw,
    cloudManifestRaw,
    desktopManifestRaw,
    schema: JSON.parse(schemaRaw),
  });
  process.stdout.write("Internal Beta live evidence accepted.\n");
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
