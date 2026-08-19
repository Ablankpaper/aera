#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { readFile } from "node:fs/promises";
import { lstat, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { extract as extractZip } from "@electron-internal/extract-zip";
import { extractFile, listPackage } from "@electron/asar";

import { verifyPackagedNativeModule } from "../release/verify-packaged-native-module.mjs";
import { verifyPackagedRuntimeSeed } from "../verify-packaged-runtime-seed.mjs";
import { verifyPackagedAsarAuthConfig } from "./verify-built-auth-config.mjs";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIRECTORY, "..", "..");
const VERSION_PATTERN =
  /^[0-9]+\.[0-9]+\.[0-9]+-internal-beta\.[1-9][0-9]*(?:\.[1-9][0-9]*)?$/u;

function required(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is required`);
  }
  return value;
}

function normalizeEntries(entries) {
  if (!Array.isArray(entries)) {
    throw new Error("Windows app ZIP root inventory is invalid");
  }
  return entries.map((entry) => {
    if (
      entry === null ||
      typeof entry !== "object" ||
      typeof entry.name !== "string" ||
      (entry.type !== "file" && entry.type !== "directory")
    ) {
      throw new Error("Windows app ZIP root entry is invalid");
    }
    return entry;
  });
}

export function validateWindowsAppRootEntries(entries) {
  const normalized = normalizeEntries(entries);
  const executable = normalized.find(
    (entry) => entry.name === "Aera.exe" && entry.type === "file",
  );
  const resources = normalized.find(
    (entry) => entry.name === "resources" && entry.type === "directory",
  );
  const wrapper = normalized.find(
    (entry) => entry.type === "directory" && entry.name === "win-unpacked",
  );
  if (!executable || !resources || wrapper) {
    throw new Error(
      "Windows app ZIP must contain Aera.exe and resources at its root without a wrapper directory",
    );
  }
  return { executable: executable.name, resources: resources.name };
}

export function validateWindowsAppAsarEntries(
  entries,
  packageDocument,
  expectedVersion,
) {
  if (!Array.isArray(entries)) {
    throw new Error("Windows app.asar entry inventory is invalid");
  }
  const normalized = new Set(
    entries
      .filter((entry) => typeof entry === "string")
      .map((entry) => entry.replace(/^\/+/, "")),
  );
  const requiredEntries = [
    "out/main/index.js",
    "out/preload/index.js",
    "out/renderer/index.html",
    "package.json",
  ];
  const missing = requiredEntries.filter((entry) => !normalized.has(entry));
  if (
    missing.length > 0 ||
    packageDocument === null ||
    typeof packageDocument !== "object" ||
    Array.isArray(packageDocument) ||
    packageDocument.name !== "agentera-studio" ||
    packageDocument.version !== expectedVersion
  ) {
    throw new Error(
      `Windows app.asar identity is invalid${
        missing.length > 0 ? `: ${missing.join(", ")}` : ""
      }`,
    );
  }
  return { required: requiredEntries };
}

export function validateWindowsPeX64(bytes, label = "Windows executable") {
  const image = Buffer.from(bytes);
  if (image.length < 0x40 || image.readUInt16LE(0) !== 0x5a4d) {
    throw new Error(`${label} has no valid MZ header`);
  }
  const peOffset = image.readUInt32LE(0x3c);
  if (
    peOffset > image.length - 6 ||
    image.readUInt32LE(peOffset) !== 0x00004550 ||
    image.readUInt16LE(peOffset + 4) !== 0x8664
  ) {
    throw new Error(`${label} is not an x64 PE image`);
  }
  return true;
}

async function regularEntry(root, name, type) {
  const path = join(root, name);
  const info = await lstat(path).catch(() => null);
  if (
    info === null ||
    (type === "file" ? !info.isFile() : !info.isDirectory()) ||
    info.isSymbolicLink()
  ) {
    throw new Error(`Windows app ZIP ${name} is unavailable or unsafe`);
  }
  return path;
}

async function validateExtractedWindowsApp(
  stagingDirectory,
  desktopVersion,
  options,
  dependencies,
) {
  const entries = await readdir(stagingDirectory, { withFileTypes: true });
  validateWindowsAppRootEntries(
    entries.map((entry) => ({
      name: entry.name,
      type: entry.isDirectory() ? "directory" : "file",
    })),
  );
  const executable = await regularEntry(stagingDirectory, "Aera.exe", "file");
  const resources = await regularEntry(
    stagingDirectory,
    "resources",
    "directory",
  );
  const appAsar = await regularEntry(resources, "app.asar", "file");
  const asarEntries = listPackage(appAsar, { isPack: false });
  const packageDocument = JSON.parse(
    extractFile(appAsar, "package.json").toString("utf8"),
  );
  validateWindowsAppAsarEntries(asarEntries, packageDocument, desktopVersion);
  if (options.expectedCloudOrigin) {
    verifyPackagedAsarAuthConfig(appAsar, options.expectedCloudOrigin);
  }
  validateWindowsPeX64(await readFile(executable));

  await (dependencies.verifyNative ?? verifyPackagedNativeModule)({
    appOutDir: stagingDirectory,
    electronPlatformName: "win32",
    arch: 1,
    packager: { projectDir: PROJECT_ROOT, platform: { name: "win32" } },
  });

  if (options.runtimeSeedReference) {
    await (dependencies.verifyRuntimeSeed ?? verifyPackagedRuntimeSeed)({
      directory: join(resources, "agentera-runtime-seed"),
      referenceDirectory: options.runtimeSeedReference,
      desktopVersion,
    });
  }
  return stagingDirectory;
}

export async function verifyPackagedWindowsAppZip(options, dependencies = {}) {
  const zip = resolve(required(options?.zip, "Windows app ZIP"));
  const desktopVersion = required(options?.desktopVersion, "desktop version");
  if (!VERSION_PATTERN.test(desktopVersion)) {
    throw new Error("Windows app ZIP desktop version is invalid");
  }
  if (
    basename(zip) !== `Aera-Internal-Beta-${desktopVersion}-windows-x64-app.zip`
  ) {
    throw new Error("Windows app ZIP identity differs");
  }
  const zipInfo = await lstat(zip);
  if (!zipInfo.isFile() || zipInfo.isSymbolicLink()) {
    throw new Error("Windows app ZIP source is invalid");
  }
  const root = await mkdtemp(join(tmpdir(), "aera-packaged-windows-app-"));
  const staging = join(root, "staging");
  await mkdir(staging, { recursive: true });
  try {
    await (dependencies.extract ?? extractZip)(zip, { dir: staging });
    await validateExtractedWindowsApp(
      staging,
      desktopVersion,
      options,
      dependencies,
    );
    return { version: desktopVersion, archive: basename(zip) };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function parseOptions(arguments_) {
  const values = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error("Windows app ZIP options require flag/value pairs");
    }
    const key = flag.slice(2).replaceAll("-", "_");
    if (
      !new Set([
        "zip",
        "desktop_version",
        "runtime_seed_reference",
        "expected_cloud_origin",
      ]).has(key)
    ) {
      throw new Error(`Unknown option: ${flag}`);
    }
    if (Object.hasOwn(values, key))
      throw new Error(`Duplicate option: ${flag}`);
    values[key] = value;
  }
  return values;
}

async function runCli(arguments_) {
  const values = parseOptions(arguments_);
  await verifyPackagedWindowsAppZip({
    zip: values.zip,
    desktopVersion: values.desktop_version,
    runtimeSeedReference: values.runtime_seed_reference,
    expectedCloudOrigin: required(
      values.expected_cloud_origin,
      "expected Cloud origin",
    ),
  });
  process.stdout.write("packaged Windows app ZIP verification passed\n");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  runCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `Packaged Windows app ZIP verification failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
