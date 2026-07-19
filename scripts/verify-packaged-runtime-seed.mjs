#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  RuntimeSeedPackagingError,
  assertRegularFile,
  readRuntimeSeedLock,
  resolveRuntimeSeedTarget,
  runIndependentRuntimeSeedVerifier,
} from "./prepare-agentera-runtime-seed.mjs";

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

async function hashFile(path) {
  const digest = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    size += chunk.length;
    digest.update(chunk);
  }
  return { size, sha256: digest.digest("hex") };
}

async function findPackagedTarget(directory, lock) {
  const entries = await readdir(directory, { withFileTypes: true });
  const visibleEntries = entries.filter((entry) => entry.name !== ".gitkeep");
  if (
    entries.some(
      (entry) =>
        (entry.name === ".gitkeep" && !entry.isFile()) ||
        (entry.name !== ".gitkeep" && !entry.isFile()),
    )
  ) {
    throw new RuntimeSeedPackagingError(
      "Packaged Runtime Seed may contain regular files only",
    );
  }
  const names = new Set(visibleEntries.map((entry) => entry.name));
  const matches = [];
  for (const [targetKey, asset] of Object.entries(lock.assets)) {
    const expected = [asset.archive, asset.manifest, asset.signature];
    if (expected.every((name) => names.has(name))) {
      matches.push({ targetKey, asset, expected });
    } else if (expected.some((name) => names.has(name))) {
      throw new RuntimeSeedPackagingError(
        `Packaged Runtime Seed is incomplete for ${targetKey}`,
      );
    }
  }
  if (matches.length !== 1) {
    throw new RuntimeSeedPackagingError(
      `Packaged Runtime Seed must contain exactly one target; found ${matches.length}`,
    );
  }
  const selected = matches[0];
  const extras = [...names].filter((name) => !selected.expected.includes(name));
  if (extras.length > 0) {
    throw new RuntimeSeedPackagingError(
      `Packaged Runtime Seed contains unexpected files: ${extras.sort().join(", ")}`,
    );
  }
  return selected;
}

async function compareReference(directory, referenceDirectory, names) {
  for (const name of names) {
    const packagedPath = join(directory, name);
    const referencePath = join(referenceDirectory, name);
    await assertRegularFile(referencePath, `Runtime Seed reference ${name}`);
    const [packaged, reference] = await Promise.all([
      hashFile(packagedPath),
      hashFile(referencePath),
    ]);
    if (
      packaged.size !== reference.size ||
      packaged.sha256 !== reference.sha256
    ) {
      throw new RuntimeSeedPackagingError(
        `Packaged Runtime Seed byte drift detected for ${name}`,
      );
    }
  }
}

export async function verifyPackagedRuntimeSeed(options) {
  const directory = resolve(options.directory);
  const metadata = await lstat(directory).catch((error) => {
    throw new RuntimeSeedPackagingError(
      `Packaged Runtime Seed directory is missing: ${directory}`,
      { cause: error },
    );
  });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new RuntimeSeedPackagingError(
      "Packaged Runtime Seed path must be a real directory",
    );
  }
  const lock = await readRuntimeSeedLock(options.lockPath ?? DEFAULT_LOCK_PATH);
  const selected = await findPackagedTarget(directory, lock);
  const target = resolveRuntimeSeedTarget(
    lock,
    selected.asset.platform,
    selected.asset.arch,
  );
  if (target.targetKey !== selected.targetKey) {
    throw new RuntimeSeedPackagingError("Packaged Runtime Seed target drifted");
  }

  const paths = {
    archive: join(directory, selected.asset.archive),
    manifest: join(directory, selected.asset.manifest),
    signature: join(directory, selected.asset.signature),
  };
  await Promise.all(
    Object.entries(paths).map(([label, path]) =>
      assertRegularFile(path, `Packaged Runtime Seed ${label}`),
    ),
  );
  const verified = await runIndependentRuntimeSeedVerifier({
    ...paths,
    trust: options.trustPath ?? DEFAULT_TRUST_PATH,
    repository: lock.repository,
    platform: selected.asset.platform,
    arch: selected.asset.arch,
    desktopVersion: options.desktopVersion,
    channel: lock.channel,
    protocolPath: options.protocolPath,
  });
  const manifest = JSON.parse(await readFile(paths.manifest, "utf8"));
  if (manifest.source_commit !== lock.source_commit) {
    throw new RuntimeSeedPackagingError(
      "Packaged Runtime Seed source commit differs from the lock",
    );
  }
  if (manifest.runtime_version !== lock.runtime_version) {
    throw new RuntimeSeedPackagingError(
      "Packaged Runtime Seed Runtime version differs from the lock",
    );
  }
  if (options.referenceDirectory) {
    await compareReference(
      directory,
      resolve(options.referenceDirectory),
      selected.expected,
    );
  }
  return {
    verified: true,
    target: selected.targetKey,
    runtimeVersion: manifest.runtime_version,
    sourceCommit: manifest.source_commit,
    files: selected.expected,
    verifier: verified,
  };
}

function parseArguments(argv) {
  if (argv.length === 0 || argv[0].startsWith("--")) {
    throw new RuntimeSeedPackagingError(
      "usage: verify-packaged-runtime-seed.mjs <directory> [--reference-dir <directory>]",
    );
  }
  const values = { directory: argv[0] };
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new RuntimeSeedPackagingError(
        "Packaged Runtime Seed verifier options require flag/value pairs",
      );
    }
    const key = flag.slice(2).replaceAll("-", "_");
    if (Object.hasOwn(values, key)) {
      throw new RuntimeSeedPackagingError(`Duplicate option: ${flag}`);
    }
    values[key] = value;
  }
  const allowed = new Set([
    "directory",
    "reference_dir",
    "lock",
    "trust",
    "desktop_version",
  ]);
  const unknown = Object.keys(values).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new RuntimeSeedPackagingError(
      `Unknown packaged Runtime Seed options: ${unknown.join(", ")}`,
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

async function main() {
  try {
    const values = parseArguments(process.argv.slice(2));
    const result = await verifyPackagedRuntimeSeed({
      directory: values.directory,
      referenceDirectory: values.reference_dir,
      lockPath: values.lock,
      trustPath: values.trust,
      desktopVersion: values.desktop_version ?? (await readDesktopVersion()),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `AgentEra packaged Runtime Seed verification failed: ${message}\n`,
    );
    process.exitCode = 1;
  }
}

const isMain =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) await main();
