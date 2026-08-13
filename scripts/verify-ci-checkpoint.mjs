/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { readFile } from "node:fs/promises";

const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const RUN_URL_PATTERN =
  /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/actions\/runs\/[1-9][0-9]*$/u;
const REQUIRED_PLATFORMS = new Map([
  [
    "Ablankpaper/aera",
    new Set(["ubuntu-latest", "macos-latest", "windows-latest"]),
  ],
  ["Ablankpaper/aera-cloud", new Set(["ubuntu-24.04"])],
  ["Ablankpaper/aera-admin", new Set(["ubuntu-24.04"])],
]);

function fail(message) {
  throw new Error(`CI checkpoint verification failed: ${message}`);
}

function object(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value;
}

function string(value, label) {
  if (typeof value !== "string" || value.trim() !== value || value === "") {
    fail(`${label} must be a non-empty canonical string`);
  }
  return value;
}

function timestamp(value, label) {
  const text = string(value, label);
  const milliseconds = Date.parse(text);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== text
  ) {
    fail(`${label} must be a canonical ISO timestamp`);
  }
  return milliseconds;
}

function parseExpected(args) {
  const expected = new Map();
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--expect" || index + 1 >= args.length) {
      fail("usage: verify-ci-checkpoint.mjs MANIFEST --expect repository=sha");
    }
    const assignment = args[index + 1];
    index += 1;
    const separator = assignment.indexOf("=");
    if (separator <= 0) fail(`invalid expected checkpoint ${assignment}`);
    const repository = assignment.slice(0, separator);
    const commitSha = assignment.slice(separator + 1);
    if (!REQUIRED_PLATFORMS.has(repository) || !SHA_PATTERN.test(commitSha)) {
      fail(`invalid expected repository or commit SHA ${assignment}`);
    }
    if (expected.has(repository)) {
      fail(`duplicate expected repository ${repository}`);
    }
    expected.set(repository, commitSha);
  }
  if (expected.size === 0)
    fail("at least one --expect repository=sha is required");
  return expected;
}

function verifyRepository(raw, expected, seen) {
  const entry = object(raw, "repository checkpoint");
  const repository = string(entry.repository, "repository");
  if (seen.has(repository)) fail(`duplicate repository ${repository}`);
  seen.add(repository);
  if (!expected.has(repository)) fail(`unexpected repository ${repository}`);
  if (entry.commitSha !== expected.get(repository)) {
    fail(`${repository} commit SHA does not match the expected source`);
  }
  if (!SHA_PATTERN.test(entry.commitSha)) {
    fail(`${repository} commit SHA is invalid`);
  }
  const committedAt = timestamp(
    entry.commitCommittedAt,
    `${repository} commitCommittedAt`,
  );
  string(entry.workflowName, `${repository} workflowName`);
  const runUrl = string(entry.runUrl, `${repository} runUrl`);
  const urlMatch = runUrl.match(RUN_URL_PATTERN);
  if (!urlMatch || urlMatch[1].toLowerCase() !== repository.toLowerCase()) {
    fail(`${repository} run URL is not an exact GitHub Actions URL`);
  }
  if (entry.conclusion !== "success") {
    fail(`${repository} workflow conclusion must be success`);
  }
  const completedAt = timestamp(entry.completedAt, `${repository} completedAt`);
  if (completedAt < committedAt) {
    fail(`${repository} run is older than its commit`);
  }
  if (!Array.isArray(entry.jobs) || entry.jobs.length === 0) {
    fail(`${repository} has no jobs`);
  }
  const observedPlatforms = new Set();
  let jobCount = 0;
  for (const rawJob of entry.jobs) {
    const job = object(rawJob, `${repository} job`);
    const name = string(job.name, `${repository} job name`);
    const platform = string(job.platform, `${repository} job platform`);
    if (job.conclusion !== "success") {
      fail(`${repository} job conclusion for ${name} must be success`);
    }
    if (!Number.isSafeInteger(job.stepsExecuted) || job.stepsExecuted <= 0) {
      fail(`${repository} job ${name} executed no steps`);
    }
    if (observedPlatforms.has(platform)) {
      fail(`${repository} repeats platform ${platform}`);
    }
    observedPlatforms.add(platform);
    jobCount += 1;
  }
  for (const platform of REQUIRED_PLATFORMS.get(repository)) {
    if (!observedPlatforms.has(platform)) {
      fail(`${repository} is missing required platform ${platform}`);
    }
  }
  return jobCount;
}

async function main() {
  const [manifestPath, ...args] = process.argv.slice(2);
  if (!manifestPath) {
    fail("manifest path is required");
  }
  const expected = parseExpected(args);
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    fail(
      `cannot read manifest: ${error instanceof Error ? error.message : error}`,
    );
  }
  object(manifest, "checkpoint manifest");
  if (manifest.schemaVersion !== 1) fail("schemaVersion must equal 1");
  timestamp(manifest.generatedAt, "generatedAt");
  if (!Array.isArray(manifest.repositories)) {
    fail("repositories must be an array");
  }
  const seen = new Set();
  let jobCount = 0;
  for (const entry of manifest.repositories) {
    jobCount += verifyRepository(entry, expected, seen);
  }
  for (const repository of expected.keys()) {
    if (!seen.has(repository)) fail(`missing repository ${repository}`);
  }
  console.log(
    `CI checkpoint verified: ${seen.size} repositories and ${jobCount} executed jobs.`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
