#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const ACTION_RUN =
  /^https:\/\/github\.com\/bignormal\/(aera|aera-cloud|aera-admin)\/actions\/runs\/[1-9][0-9]*$/u;
const TIMESTAMP =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/u;

const TOP_LEVEL_STATUS = new Set([
  "prepared",
  "candidate_ready",
  "deployed",
  "live_smoke_passed",
  "rolled_back",
  "blocked",
]);
const REPOSITORY_ROLES = new Set(["desktop", "cloud", "admin", "runtime"]);
const REPOSITORY_STATUS = new Set([
  "local_verified",
  "ci_passed",
  "merged",
  "locked",
]);
const CANDIDATE_ROLES = new Set(["cloud", "admin"]);
const CANDIDATE_STATUS = new Set([
  "candidate_created",
  "signature_verified",
  "deployed",
  "rolled_back",
]);
const PACKAGE_ROLES = new Set([
  "macos_arm64_dmg",
  "macos_arm64_zip",
  "windows_x64_exe",
  "windows_x64_zip",
]);
const PACKAGE_STATUS = new Set([
  "built",
  "hash_verified",
  "signature_verified",
  "installed",
]);
const CHECK_ROLES = new Set([
  "host_bootstrap",
  "ip_certificate",
  "cloud_deployment",
  "admin_deployment",
  "registration_mode",
  "encrypted_backup",
  "rollback",
  "live_acceptance",
]);
const CHECK_STATUS = new Set(["pending", "passed", "failed", "rolled_back"]);
const DEVICE_ROLES = new Set(["macos_arm64", "windows_x64"]);
const DEVICE_STATUS = new Set(["pending", "passed", "failed"]);
const COARSE_PLATFORM = /^(?:macOS|Windows) [0-9]{1,2}$/u;

function fail(message) {
  throw new TypeError(`Invalid internal Beta operator record: ${message}`);
}

function plainObject(value, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    fail(`${label} must be a JSON object`);
  }
  return value;
}

function exactKeys(value, required, optional, label) {
  plainObject(value, label);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      fail(`${label} contains unknown field ${key}`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      fail(`${label} is missing ${key}`);
    }
  }
}

function exactString(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) {
    fail(`${label} is invalid`);
  }
  return value;
}

function enumString(value, choices, label) {
  if (typeof value !== "string" || !choices.has(value)) {
    fail(`${label} is invalid`);
  }
  return value;
}

function timestamp(value, label) {
  exactString(value, TIMESTAMP, label);
  if (new Date(value).toISOString() !== value) {
    fail(`${label} is not a canonical timestamp`);
  }
  return value;
}

function boundedArray(value, maximum, label) {
  if (!Array.isArray(value) || value.length > maximum) {
    fail(`${label} must be a bounded array`);
  }
  return value;
}

function assertUniqueRoles(items, label) {
  const roles = new Set();
  for (const item of items) {
    if (roles.has(item.role)) {
      fail(`${label} contains duplicate role ${item.role}`);
    }
    roles.add(item.role);
  }
}

function validateRunUrl(value, role, label) {
  exactString(value, ACTION_RUN, label);
  const repository = new URL(value).pathname.split("/")[2];
  const expected =
    role === "desktop"
      ? "aera"
      : role === "cloud"
        ? "aera-cloud"
        : "aera-admin";
  if (repository !== expected) {
    fail(`${label} names the wrong repository`);
  }
}

function validateRepository(entry, index) {
  const label = `repositories[${index}]`;
  enumString(entry.role, REPOSITORY_ROLES, `${label}.role`);
  if (entry.role === "runtime") {
    exactKeys(entry, ["role", "sha", "status", "verifiedAt"], [], label);
  } else {
    exactKeys(
      entry,
      ["role", "sha", "status", "verifiedAt", "runUrl"],
      [],
      label,
    );
  }
  exactString(entry.sha, SHA, `${label}.sha`);
  enumString(entry.status, REPOSITORY_STATUS, `${label}.status`);
  timestamp(entry.verifiedAt, `${label}.verifiedAt`);
  if (entry.role !== "runtime") {
    validateRunUrl(entry.runUrl, entry.role, `${label}.runUrl`);
  }
}

function validateCandidate(entry, index) {
  const label = `candidates[${index}]`;
  exactKeys(
    entry,
    ["role", "sha", "imageDigest", "status", "verifiedAt", "runUrl"],
    [],
    label,
  );
  enumString(entry.role, CANDIDATE_ROLES, `${label}.role`);
  exactString(entry.sha, SHA, `${label}.sha`);
  const expectedRepository =
    entry.role === "cloud" ? "aera-cloud" : "aera-admin";
  const digestPattern = new RegExp(
    `^ghcr\\.io/bignormal/${expectedRepository}@sha256:[0-9a-f]{64}$`,
    "u",
  );
  exactString(entry.imageDigest, digestPattern, `${label}.imageDigest`);
  enumString(entry.status, CANDIDATE_STATUS, `${label}.status`);
  timestamp(entry.verifiedAt, `${label}.verifiedAt`);
  validateRunUrl(entry.runUrl, entry.role, `${label}.runUrl`);
}

function validatePackage(entry, index) {
  const label = `packages[${index}]`;
  exactKeys(entry, ["role", "sha256", "status", "verifiedAt"], [], label);
  enumString(entry.role, PACKAGE_ROLES, `${label}.role`);
  exactString(entry.sha256, SHA256, `${label}.sha256`);
  enumString(entry.status, PACKAGE_STATUS, `${label}.status`);
  timestamp(entry.verifiedAt, `${label}.verifiedAt`);
}

function validateCheck(entry, index) {
  const label = `checks[${index}]`;
  exactKeys(entry, ["role", "status", "verifiedAt"], ["expiresAt"], label);
  enumString(entry.role, CHECK_ROLES, `${label}.role`);
  enumString(entry.status, CHECK_STATUS, `${label}.status`);
  timestamp(entry.verifiedAt, `${label}.verifiedAt`);
  if (entry.expiresAt !== undefined) {
    if (entry.role !== "ip_certificate") {
      fail(`${label}.expiresAt is allowed only for the certificate check`);
    }
    timestamp(entry.expiresAt, `${label}.expiresAt`);
  }
}

function validateDevice(entry, index) {
  const label = `devices[${index}]`;
  exactKeys(
    entry,
    ["role", "platformVersion", "status", "verifiedAt"],
    [],
    label,
  );
  enumString(entry.role, DEVICE_ROLES, `${label}.role`);
  exactString(
    entry.platformVersion,
    COARSE_PLATFORM,
    `${label}.platformVersion`,
  );
  if (
    (entry.role === "macos_arm64" &&
      !entry.platformVersion.startsWith("macOS ")) ||
    (entry.role === "windows_x64" &&
      !entry.platformVersion.startsWith("Windows "))
  ) {
    fail(`${label}.platformVersion does not match its device role`);
  }
  enumString(entry.status, DEVICE_STATUS, `${label}.status`);
  timestamp(entry.verifiedAt, `${label}.verifiedAt`);
}

export function validateOperatorRecord(value) {
  exactKeys(
    value,
    [
      "schemaVersion",
      "status",
      "updatedAt",
      "repositories",
      "candidates",
      "packages",
      "checks",
      "devices",
    ],
    [],
    "record",
  );
  if (value.schemaVersion !== 1) {
    fail("schemaVersion must be 1");
  }
  enumString(value.status, TOP_LEVEL_STATUS, "status");
  timestamp(value.updatedAt, "updatedAt");

  const repositories = boundedArray(value.repositories, 4, "repositories");
  const candidates = boundedArray(value.candidates, 2, "candidates");
  const packages = boundedArray(value.packages, 4, "packages");
  const checks = boundedArray(value.checks, 8, "checks");
  const devices = boundedArray(value.devices, 2, "devices");

  repositories.forEach(validateRepository);
  candidates.forEach(validateCandidate);
  packages.forEach(validatePackage);
  checks.forEach(validateCheck);
  devices.forEach(validateDevice);
  assertUniqueRoles(repositories, "repositories");
  assertUniqueRoles(candidates, "candidates");
  assertUniqueRoles(packages, "packages");
  assertUniqueRoles(checks, "checks");
  assertUniqueRoles(devices, "devices");
  return value;
}

function sortObject(value) {
  if (Array.isArray(value)) {
    return value.map(sortObject);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortObject(value[key])]),
    );
  }
  return value;
}

export function canonicalOperatorRecord(value) {
  validateOperatorRecord(value);
  return `${JSON.stringify(sortObject(value), null, 2)}\n`;
}

export async function renderOperatorRecord(value, outputPath) {
  if (typeof outputPath !== "string" || !path.isAbsolute(outputPath)) {
    fail("output path must be absolute");
  }
  const directory = path.dirname(outputPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const directoryMetadata = await stat(directory);
  if (!directoryMetadata.isDirectory()) {
    fail("output directory is not a directory");
  }

  const temporaryPath = path.join(
    directory,
    `.${path.basename(outputPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(canonicalOperatorRecord(value), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, outputPath);
  await chmod(outputPath, 0o600);
}

async function main(argv) {
  if (argv.length !== 4 || argv[0] !== "--input" || argv[2] !== "--output") {
    throw new Error(
      "usage: render-operator-record.mjs --input INPUT_JSON --output ABSOLUTE_OUTPUT_JSON",
    );
  }
  const inputPath = argv[1];
  const outputPath = argv[3];
  const source = await readFile(inputPath, "utf8");
  if (Buffer.byteLength(source, "utf8") > 1024 * 1024) {
    fail("input exceeds one MiB");
  }
  await renderOperatorRecord(JSON.parse(source), outputPath);
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
