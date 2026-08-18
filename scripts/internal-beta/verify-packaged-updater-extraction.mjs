#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import electronPath from "electron";
import { listPackage } from "@electron/asar";

const execFileAsync = promisify(execFile);
const PROBE_PATH = fileURLToPath(
  new URL("./packaged-updater-extraction-probe.cjs", import.meta.url),
);
const SUCCESS_MARKER = "AERA_PACKAGED_UPDATER_EXTRACTION_OK";
const VERSION_PATTERN =
  /^[0-9]+\.[0-9]+\.[0-9]+-internal-beta\.[1-9][0-9]*(?:\.[1-9][0-9]*)?$/u;

async function run(command, arguments_, options = {}) {
  try {
    return await execFileAsync(command, arguments_, {
      encoding: "utf8",
      env: options.env ?? process.env,
      timeout: options.timeout ?? 30_000,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (error) {
    const detail =
      typeof error?.stderr === "string" && error.stderr.trim() !== ""
        ? error.stderr.trim()
        : error instanceof Error
          ? error.message
          : String(error);
    throw new Error(`${basename(command)} failed: ${detail}`);
  }
}

function required(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is required`);
  }
  return value;
}

async function plistValue(infoPlist, key, runCommand) {
  const result = await runCommand("/usr/bin/plutil", [
    "-extract",
    key,
    "raw",
    "-o",
    "-",
    infoPlist,
  ]);
  return result.stdout.trim();
}

export function validatePackagedRuntimeEntries(asarEntries, nativeEntries) {
  if (!Array.isArray(asarEntries) || !Array.isArray(nativeEntries)) {
    throw new Error("Packaged runtime entry inventory is invalid");
  }
  const normalizedAsar = new Set(
    asarEntries
      .filter((entry) => typeof entry === "string")
      .map((entry) => entry.replace(/^\/+/, "")),
  );
  const required = [
    "out/main/index.js",
    "out/preload/index.js",
    "out/renderer/index.html",
  ];
  const missing = required.filter((entry) => !normalizedAsar.has(entry));
  const normalizedNative = nativeEntries
    .filter((entry) => typeof entry === "string")
    .map((entry) => entry.replace(/^\/+/, ""))
    .filter((entry) => entry.endsWith(".node"))
    .sort();
  if (
    missing.length > 0 ||
    !normalizedNative.some((entry) =>
      entry.endsWith("better-sqlite3/build/Release/better_sqlite3.node"),
    )
  ) {
    throw new Error(
      `Packaged runtime entries are incomplete: ${[
        ...missing,
        ...(normalizedNative.length === 0 ? ["native module"] : []),
      ].join(", ")}`,
    );
  }
  return { required, nativeModules: normalizedNative };
}

async function collectNativeEntries(root, prefix = "") {
  const entries = await readdir(root, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) {
      throw new Error(
        `Packaged native entry is a symbolic link: ${relativePath}`,
      );
    }
    if (entry.isDirectory()) {
      result.push(
        ...(await collectNativeEntries(join(root, entry.name), relativePath)),
      );
    } else if (entry.isFile() && entry.name.endsWith(".node")) {
      result.push(relativePath);
    }
  }
  return result;
}

export async function validateExtractedMacApp(
  stagingDirectory,
  desktopVersion,
  runCommand = run,
  options = {},
) {
  const entries = await readdir(stagingDirectory, { withFileTypes: true });
  const apps = entries.filter(
    (entry) => entry.isDirectory() && entry.name.endsWith(".app"),
  );
  if (entries.length !== 1 || apps.length !== 1) {
    throw new Error("Packaged updater must extract exactly one app");
  }
  const app = join(stagingDirectory, apps[0].name);
  const appInfo = await lstat(app);
  if (!appInfo.isDirectory() || appInfo.isSymbolicLink()) {
    throw new Error("Packaged updater app bundle is invalid");
  }

  const infoPlist = join(app, "Contents", "Info.plist");
  const [version, bundleIdentifier, executableName] = await Promise.all([
    plistValue(infoPlist, "CFBundleShortVersionString", runCommand),
    plistValue(infoPlist, "CFBundleIdentifier", runCommand),
    plistValue(infoPlist, "CFBundleExecutable", runCommand),
  ]);
  if (
    version !== desktopVersion ||
    bundleIdentifier !== "com.bignormal.agentera.studio"
  ) {
    throw new Error("Packaged updater app identity differs");
  }
  if (
    executableName.length === 0 ||
    executableName.includes("/") ||
    executableName.includes("\\")
  ) {
    throw new Error("Packaged updater executable name is invalid");
  }

  const executable = join(app, "Contents", "MacOS", executableName);
  const executableInfo = await lstat(executable);
  if (!executableInfo.isFile() || executableInfo.isSymbolicLink()) {
    throw new Error("Packaged updater executable is invalid");
  }
  const architectures = await runCommand("/usr/bin/lipo", [
    "-archs",
    executable,
  ]);
  if (!architectures.stdout.trim().split(/\s+/u).includes("arm64")) {
    throw new Error("Packaged updater app is not Apple Silicon");
  }

  const appAsar = join(app, "Contents", "Resources", "app.asar");
  let appAsarInfo;
  try {
    appAsarInfo = await stat(appAsar);
  } catch {
    throw new Error("Packaged updater app.asar is missing or empty");
  }
  if (!appAsarInfo.isFile() || appAsarInfo.size === 0) {
    throw new Error("Packaged updater app.asar is missing or empty");
  }
  if (options.requireRuntimeEntries === true) {
    const asarEntries = listPackage(appAsar, { isPack: false });
    const unpackedRoot = join(
      app,
      "Contents",
      "Resources",
      "app.asar.unpacked",
    );
    const nativeEntries = await collectNativeEntries(unpackedRoot);
    validatePackagedRuntimeEntries(asarEntries, nativeEntries);
  }
  await runCommand("/usr/bin/codesign", [
    "--verify",
    "--deep",
    "--strict",
    "--verbose=2",
    app,
  ]);
  return app;
}

async function executeProbe(options) {
  const result = await run(electronPath, [PROBE_PATH], {
    env: {
      ...process.env,
      AERA_PACKAGED_UPDATER_ENTRY: options.updaterEntry,
      AERA_PACKAGED_UPDATER_ARCHIVE: options.zip,
      AERA_PACKAGED_UPDATER_STAGING: options.staging,
      AERA_PACKAGED_UPDATER_USER_DATA: options.userData,
    },
    timeout: 120_000,
  });
  if (!result.stdout.split(/\r?\n/u).includes(SUCCESS_MARKER)) {
    throw new Error(
      "Packaged updater extraction probe did not confirm success",
    );
  }
}

export async function verifyPackagedUpdaterExtraction(
  options,
  dependencies = {},
) {
  if ((dependencies.platform ?? process.platform) !== "darwin") {
    throw new Error("Packaged updater extraction requires macOS");
  }
  const app = resolve(required(options.app, "packaged app"));
  const zip = resolve(required(options.zip, "update ZIP"));
  const desktopVersion = required(options.desktopVersion, "desktop version");
  if (!VERSION_PATTERN.test(desktopVersion)) {
    throw new Error("Packaged updater desktop version is invalid");
  }
  if (
    basename(zip) !== `Aera-Internal-Beta-${desktopVersion}-macos-arm64.zip`
  ) {
    throw new Error("Packaged updater ZIP identity differs");
  }
  const [appInfo, zipInfo] = await Promise.all([lstat(app), lstat(zip)]);
  if (!appInfo.isDirectory() || appInfo.isSymbolicLink()) {
    throw new Error("Packaged updater source app is invalid");
  }
  if (!zipInfo.isFile() || zipInfo.isSymbolicLink()) {
    throw new Error("Packaged updater source ZIP is invalid");
  }
  const appAsar = join(app, "Contents", "Resources", "app.asar");
  const appAsarInfo = await stat(appAsar);
  if (!appAsarInfo.isFile() || appAsarInfo.size === 0) {
    throw new Error("Packaged updater source app.asar is missing or empty");
  }

  const root = await mkdtemp(join(tmpdir(), "aera-packaged-updater-"));
  const staging = join(root, "staging");
  const userData = join(root, "user-data");
  await Promise.all([
    mkdir(staging, { recursive: true }),
    mkdir(userData, { recursive: true }),
  ]);
  try {
    await (dependencies.executeProbe ?? executeProbe)({
      updaterEntry: join(appAsar, "out", "main", "internal-beta-updater.js"),
      zip,
      staging,
      userData,
    });
    await validateExtractedMacApp(
      staging,
      desktopVersion,
      dependencies.runCommand ?? run,
      { requireRuntimeEntries: options.requireRuntimeEntries === true },
    );
    return { version: desktopVersion, archive: basename(zip) };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function parseOptions(arguments_) {
  if (arguments_.length === 0) {
    throw new Error("Packaged updater options must be flag/value pairs");
  }
  const allowed = new Set(["app", "zip", "desktop_version"]);
  const values = {};
  for (let index = 0; index < arguments_.length; index += 1) {
    const flag = arguments_[index];
    if (flag === "--require-runtime-entries") {
      if (values.require_runtime_entries === true) {
        throw new Error(`Duplicate option: ${flag}`);
      }
      values.require_runtime_entries = true;
      continue;
    }
    const value = arguments_[index + 1];
    if (!flag.startsWith("--") || value === undefined) {
      throw new Error("Packaged updater options must be flag/value pairs");
    }
    const key = flag.slice(2).replaceAll("-", "_");
    if (!allowed.has(key)) throw new Error(`Unknown option: ${flag}`);
    if (Object.hasOwn(values, key)) {
      throw new Error(`Duplicate option: ${flag}`);
    }
    values[key] = value;
    index += 1;
  }
  return values;
}

async function runCli(arguments_) {
  const values = parseOptions(arguments_);
  await verifyPackagedUpdaterExtraction({
    app: values.app,
    zip: values.zip,
    desktopVersion: values.desktop_version,
    requireRuntimeEntries: values.require_runtime_entries === true,
  });
  process.stdout.write("packaged macOS updater extracted the final ZIP\n");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  runCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `Packaged macOS updater verification failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
