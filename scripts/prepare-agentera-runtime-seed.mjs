#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { execFile } from "node:child_process";
import { constants, createWriteStream } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIRECTORY, "..");
const DEFAULT_LOCK_PATH = join(
  PROJECT_ROOT,
  "build",
  "agentera-runtime-seed.lock.json",
);
const DEFAULT_TRUST_PATH = join(
  PROJECT_ROOT,
  "resources",
  "agentera-runtime-trust.json",
);
const DEFAULT_DESTINATION = join(
  PROJECT_ROOT,
  "resources",
  "agentera-runtime-seed",
);
const DEFAULT_PROTOCOL_PATH = join(
  SCRIPT_DIRECTORY,
  "lib",
  "agentera-runtime-protocol.mjs",
);
const DEFAULT_RELEASE_ORIGIN = new URL("https://github.com/");
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const TARGETS = new Map([
  [
    "darwin-arm64",
    { platform: "darwin", arch: "arm64", extension: ".tar.zst" },
  ],
  ["windows-x64", { platform: "windows", arch: "x64", extension: ".zip" }],
]);
const LOCK_FIELDS = [
  "schema_version",
  "repository",
  "release_tag",
  "source_commit",
  "runtime_version",
  "channel",
  "assets",
];
const ASSET_FIELDS = ["platform", "arch", "archive", "manifest", "signature"];
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$/;

export class RuntimeSeedPackagingError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "RuntimeSeedPackagingError";
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactFields(value, expected, label) {
  if (!isObject(value)) {
    throw new RuntimeSeedPackagingError(`${label} must be an object`);
  }
  const actual = Object.keys(value);
  const missing = expected.filter((field) => !actual.includes(field));
  const extra = actual.filter((field) => !expected.includes(field));
  if (missing.length > 0 || extra.length > 0) {
    throw new RuntimeSeedPackagingError(
      `${label} fields differ: missing=${missing.sort().join(",")}, extra=${extra.sort().join(",")}`,
    );
  }
}

function requiredString(value, field, label = "Runtime Seed lock") {
  const item = value[field];
  if (typeof item !== "string" || item.length === 0) {
    throw new RuntimeSeedPackagingError(
      `${label}.${field} must be a non-empty string`,
    );
  }
  return item;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function expectedAssetNames(runtimeVersion, target) {
  const base = `agentera-runtime-${runtimeVersion}-${target.platform}-${target.arch}`;
  return {
    archive: `${base}${target.extension}`,
    manifest: `${base}.manifest.json`,
    signature: `${base}.manifest.sig`,
  };
}

function validateReleaseTag(lock) {
  const tag = requiredString(lock, "release_tag");
  if (/latest/i.test(tag)) {
    throw new RuntimeSeedPackagingError(
      "Runtime Seed release tag must be exact and cannot use latest",
    );
  }
  const version = escapeRegex(lock.runtime_version);
  const expected =
    lock.channel === "candidate"
      ? new RegExp(`^runtime-v${version}-rc\\.[1-9][0-9]*$`)
      : new RegExp(`^runtime-v${version}$`);
  if (!expected.test(tag)) {
    throw new RuntimeSeedPackagingError(
      "Runtime Seed release tag does not match the locked Runtime version and channel",
    );
  }
}

export async function readRuntimeSeedLock(lockPath = DEFAULT_LOCK_PATH) {
  let lock;
  try {
    lock = JSON.parse(await readFile(lockPath, "utf8"));
  } catch (error) {
    throw new RuntimeSeedPackagingError(
      `Cannot read Runtime Seed lock: ${lockPath}`,
      { cause: error },
    );
  }
  exactFields(lock, LOCK_FIELDS, "Runtime Seed lock");
  if (lock.schema_version !== 1) {
    throw new RuntimeSeedPackagingError(
      "Unsupported Runtime Seed lock schema_version",
    );
  }
  if (!REPOSITORY_PATTERN.test(requiredString(lock, "repository"))) {
    throw new RuntimeSeedPackagingError(
      "Runtime Seed lock repository must be owner/name",
    );
  }
  if (!COMMIT_PATTERN.test(requiredString(lock, "source_commit"))) {
    throw new RuntimeSeedPackagingError(
      "Runtime Seed lock source commit must be a full lowercase Git SHA",
    );
  }
  if (!VERSION_PATTERN.test(requiredString(lock, "runtime_version"))) {
    throw new RuntimeSeedPackagingError(
      "Runtime Seed lock runtime version is invalid",
    );
  }
  if (!new Set(["candidate", "stable"]).has(lock.channel)) {
    throw new RuntimeSeedPackagingError(
      "Runtime Seed lock channel must be candidate or stable",
    );
  }
  validateReleaseTag(lock);

  exactFields(lock.assets, [...TARGETS.keys()], "Runtime Seed lock assets");
  for (const [targetKey, target] of TARGETS) {
    const asset = lock.assets[targetKey];
    exactFields(asset, ASSET_FIELDS, `Runtime Seed lock assets.${targetKey}`);
    if (asset.platform !== target.platform || asset.arch !== target.arch) {
      throw new RuntimeSeedPackagingError(
        `Runtime Seed lock asset target drifted for ${targetKey}`,
      );
    }
    const expected = expectedAssetNames(lock.runtime_version, target);
    for (const field of ["archive", "manifest", "signature"]) {
      if (asset[field] !== expected[field]) {
        throw new RuntimeSeedPackagingError(
          `Runtime Seed lock ${targetKey} ${field} name drifted`,
        );
      }
    }
  }
  return lock;
}

export function resolveRuntimeSeedTarget(lock, platform, arch) {
  const targetKey = `${platform}-${arch}`;
  if (!TARGETS.has(targetKey) || !Object.hasOwn(lock.assets, targetKey)) {
    throw new RuntimeSeedPackagingError(
      `Unsupported Runtime Seed target: ${targetKey}`,
    );
  }
  return { targetKey, asset: lock.assets[targetKey] };
}

export async function assertRegularFile(path, label) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    throw new RuntimeSeedPackagingError(`${label} is missing: ${path}`, {
      cause: error,
    });
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new RuntimeSeedPackagingError(`${label} must be a regular file`);
  }
}

function safeVerifierEnvironment() {
  const allowed = ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR"];
  return Object.fromEntries(
    allowed
      .filter((name) => process.env[name] !== undefined)
      .map((name) => [name, process.env[name]]),
  );
}

export async function runIndependentRuntimeSeedVerifier(options) {
  const arguments_ = [
    options.protocolPath ?? DEFAULT_PROTOCOL_PATH,
    "verify",
    "--manifest",
    options.manifest,
    "--signature",
    options.signature,
    "--archive",
    options.archive,
    "--trust",
    options.trust,
    "--repository",
    options.repository,
    "--platform",
    options.platform,
    "--arch",
    options.arch,
    "--desktop-version",
    options.desktopVersion,
    "--channel",
    options.channel,
  ];
  try {
    const result = await execFileAsync(process.execPath, arguments_, {
      encoding: "utf8",
      env: safeVerifierEnvironment(),
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    return JSON.parse(result.stdout);
  } catch (error) {
    const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : "";
    const detail =
      stderr || (error instanceof Error ? error.message : String(error));
    throw new RuntimeSeedPackagingError(
      `Independent Runtime Seed verification failed: ${detail}`,
      { cause: error },
    );
  }
}

async function copyLocalAsset(sourceDirectory, name, destination) {
  const source = join(sourceDirectory, name);
  await assertRegularFile(source, `Local Runtime Seed asset ${name}`);
  await copyFile(source, destination, constants.COPYFILE_EXCL);
}

function releaseAssetUrl(origin, lock, name) {
  const base = new URL(origin);
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  const relative = `${lock.repository}/releases/download/${encodeURIComponent(lock.release_tag)}/${encodeURIComponent(name)}`;
  return new URL(relative, base);
}

async function downloadAsset(url, destination, githubToken) {
  const headers = {
    Accept: "application/octet-stream",
    "User-Agent": "AgentEra-Studio-Runtime-Seed-Builder",
  };
  if (
    githubToken &&
    url.protocol === "https:" &&
    url.hostname === "github.com"
  ) {
    headers.Authorization = `Bearer ${githubToken}`;
  }
  let response;
  try {
    response = await fetch(url, {
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
  } catch (error) {
    throw new RuntimeSeedPackagingError(
      `Failed to fetch locked Runtime Seed asset: ${url.pathname}`,
      { cause: error },
    );
  }
  if (!response.ok || response.body === null) {
    throw new RuntimeSeedPackagingError(
      `Locked Runtime Seed asset returned HTTP ${response.status}: ${url.pathname}`,
    );
  }
  await pipeline(
    Readable.fromWeb(response.body),
    createWriteStream(destination, { flags: "wx", mode: 0o600 }),
  );
}

async function stageVerifiedDirectory(transactionDirectory, destination) {
  const parent = dirname(destination);
  await mkdir(parent, { recursive: true });
  let destinationExists = true;
  try {
    const metadata = await lstat(destination);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new RuntimeSeedPackagingError(
        "Runtime Seed staging destination must be a real directory",
      );
    }
  } catch (error) {
    if (error?.code === "ENOENT") destinationExists = false;
    else throw error;
  }

  if (destinationExists) {
    const gitkeep = join(destination, ".gitkeep");
    try {
      await assertRegularFile(gitkeep, "Runtime Seed .gitkeep");
      await copyFile(
        gitkeep,
        join(transactionDirectory, ".gitkeep"),
        constants.COPYFILE_EXCL,
      );
    } catch (error) {
      if (error?.cause?.code !== "ENOENT") throw error;
    }
  }

  const backup = `${destination}.backup-${process.pid}-${Date.now()}`;
  if (destinationExists) await rename(destination, backup);
  try {
    await rename(transactionDirectory, destination);
  } catch (error) {
    if (destinationExists) await rename(backup, destination);
    throw error;
  }
  if (destinationExists) await rm(backup, { recursive: true, force: true });
}

function compareVerifiedManifestToLock(manifest, lock) {
  if (manifest.source_repository !== lock.repository) {
    throw new RuntimeSeedPackagingError(
      "Verified manifest repository differs from the Runtime Seed lock",
    );
  }
  if (manifest.source_commit !== lock.source_commit) {
    throw new RuntimeSeedPackagingError(
      "Verified manifest source commit differs from the Runtime Seed lock",
    );
  }
  if (manifest.runtime_version !== lock.runtime_version) {
    throw new RuntimeSeedPackagingError(
      "Verified manifest Runtime version differs from the Runtime Seed lock",
    );
  }
}

async function readVerifiedManifest(path, lock) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new RuntimeSeedPackagingError(
      "Cannot read verified Runtime manifest",
      {
        cause: error,
      },
    );
  }
  compareVerifiedManifestToLock(manifest, lock);
  return manifest;
}

export async function prepareRuntimeSeed(options) {
  const lock = await readRuntimeSeedLock(options.lockPath ?? DEFAULT_LOCK_PATH);
  const { asset } = resolveRuntimeSeedTarget(
    lock,
    options.platform,
    options.arch,
  );
  const localSourceDirectory = options.localSourceDirectory ?? null;
  if (options.ci && localSourceDirectory !== null) {
    throw new RuntimeSeedPackagingError(
      "CI release builds cannot use a local Runtime Seed override",
    );
  }
  const destination = resolve(options.destination ?? DEFAULT_DESTINATION);
  const parent = dirname(destination);
  await mkdir(parent, { recursive: true });
  const transactionDirectory = await mkdtemp(
    join(parent, ".agentera-runtime-seed-transaction-"),
  );
  const paths = {
    archive: join(transactionDirectory, asset.archive),
    manifest: join(transactionDirectory, asset.manifest),
    signature: join(transactionDirectory, asset.signature),
  };

  try {
    for (const field of ["manifest", "signature", "archive"]) {
      if (localSourceDirectory !== null) {
        await copyLocalAsset(localSourceDirectory, asset[field], paths[field]);
      } else {
        const url = releaseAssetUrl(
          options.releaseOrigin ?? DEFAULT_RELEASE_ORIGIN,
          lock,
          asset[field],
        );
        await downloadAsset(url, paths[field], options.githubToken);
      }
    }

    const verified = await runIndependentRuntimeSeedVerifier({
      ...paths,
      trust: options.trustPath ?? DEFAULT_TRUST_PATH,
      repository: lock.repository,
      platform: options.platform,
      arch: options.arch,
      desktopVersion: options.desktopVersion,
      channel: lock.channel,
      protocolPath: options.protocolPath,
    });
    const manifest = await readVerifiedManifest(paths.manifest, lock);
    await stageVerifiedDirectory(transactionDirectory, destination);
    return {
      verified: true,
      platform: manifest.platform,
      arch: manifest.arch,
      runtimeVersion: manifest.runtime_version,
      sourceCommit: manifest.source_commit,
      files: [asset.archive, asset.manifest, asset.signature],
      source:
        localSourceDirectory === null ? "locked-release" : "local-override",
      verifier: verified,
    };
  } catch (error) {
    await rm(transactionDirectory, { recursive: true, force: true });
    throw error;
  }
}

function parseArguments(argv) {
  const values = Object.create(null);
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new RuntimeSeedPackagingError(
        "usage: prepare-agentera-runtime-seed.mjs --platform <darwin|windows> --arch <arm64|x64>",
      );
    }
    const key = flag.slice(2).replaceAll("-", "_");
    if (Object.hasOwn(values, key)) {
      throw new RuntimeSeedPackagingError(`Duplicate option: ${flag}`);
    }
    values[key] = value;
  }
  const allowed = new Set([
    "platform",
    "arch",
    "lock",
    "trust",
    "destination",
    "desktop_version",
  ]);
  const unknown = Object.keys(values).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new RuntimeSeedPackagingError(
      `Unknown Runtime Seed options: ${unknown.join(", ")}`,
    );
  }
  if (!values.platform || !values.arch) {
    throw new RuntimeSeedPackagingError(
      "Runtime Seed preparation requires --platform and --arch",
    );
  }
  return values;
}

async function readDesktopVersion() {
  const packageJson = JSON.parse(
    await readFile(join(PROJECT_ROOT, "package.json"), "utf8"),
  );
  if (
    typeof packageJson.version !== "string" ||
    packageJson.version.length === 0
  ) {
    throw new RuntimeSeedPackagingError("package.json version is invalid");
  }
  return packageJson.version;
}

function environmentFlag(value) {
  return value !== undefined && value !== "" && value.toLowerCase() !== "false";
}

async function main() {
  try {
    const values = parseArguments(process.argv.slice(2));
    const result = await prepareRuntimeSeed({
      platform: values.platform,
      arch: values.arch,
      lockPath: values.lock,
      trustPath: values.trust,
      destination: values.destination,
      localSourceDirectory: process.env.AGENTERA_RUNTIME_SEED_DIR || null,
      desktopVersion: values.desktop_version ?? (await readDesktopVersion()),
      ci: environmentFlag(process.env.CI),
      githubToken: process.env.GITHUB_TOKEN,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `AgentEra Runtime Seed preparation failed: ${message}\n`,
    );
    process.exitCode = 1;
  }
}

const isMain =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) await main();
