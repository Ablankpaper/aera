#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { constants } from "node:fs";
import { lstat, open, readdir, realpath, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";

import {
  inspectNativeModuleBytes,
  resolveElectronAbi,
  scanUnpackedNativeModules,
} from "./native-module-abi.mjs";

const ELECTRON_BUILDER_ARCHITECTURES = new Map([
  [0, "ia32"],
  [1, "x64"],
  [2, "armv7l"],
  [3, "arm64"],
  [4, "universal"],
]);

const BETTER_SQLITE_RELATIVE_PATH = posix.join(
  "node_modules",
  "better-sqlite3",
  "build",
  "Release",
  "better_sqlite3.node",
);

function resolveTargetArchitecture(context, override) {
  const raw = override ?? context?.arch;
  const mapped =
    typeof raw === "number"
      ? ELECTRON_BUILDER_ARCHITECTURES.get(raw)
      : typeof raw === "string"
        ? raw.trim().toLowerCase()
        : undefined;
  const architecture =
    mapped === "amd64" ? "x64" : mapped === "aarch64" ? "arm64" : mapped;
  if (architecture !== "x64" && architecture !== "arm64") {
    throw new Error(
      `packaged native target architecture is unsupported: ${architecture ?? "missing"}`,
    );
  }
  return architecture;
}

async function resolveMacApp(appOutDir, readDirectory) {
  if (appOutDir.endsWith(".app")) return appOutDir;
  const entries = await readDirectory(appOutDir, { withFileTypes: true });
  const apps = entries.filter(
    (entry) => entry.isDirectory() && entry.name.endsWith(".app"),
  );
  if (apps.length !== 1) {
    throw new Error("packaged macOS output must contain exactly one app");
  }
  return join(appOutDir, apps[0].name);
}

function resolveUnpackedRoot(app, platform) {
  return platform === "darwin"
    ? join(app, "Contents", "Resources", "app.asar.unpacked")
    : join(app, "resources", "app.asar.unpacked");
}

const NATIVE_MODULE_OPEN_FLAGS =
  constants.O_RDONLY |
  (process.platform !== "win32" && typeof constants.O_NOFOLLOW === "number"
    ? constants.O_NOFOLLOW
    : 0);

function nativeModuleChangedError(relativePath) {
  return new Error(`native module ${relativePath} changed after validation`);
}

function hasVerifiedIdentity(status, identity) {
  return (
    status.isFile() &&
    status.dev === identity.dev &&
    status.ino === identity.ino &&
    status.size === identity.size &&
    (status.mode & constants.S_IFMT) === (identity.mode & constants.S_IFMT)
  );
}

function hasSameSurfaceIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    (left.mode & constants.S_IFMT) === (right.mode & constants.S_IFMT)
  );
}

function assertStableNativeSurface(initialSurface, finalSurface) {
  const count = Math.max(initialSurface.length, finalSurface.length);
  for (let index = 0; index < count; index += 1) {
    const initial = initialSurface[index];
    const final = finalSurface[index];
    if (
      initial?.relativePath !== final?.relativePath ||
      !initial ||
      !final ||
      !hasSameSurfaceIdentity(initial.identity, final.identity)
    ) {
      const relativePath =
        initial?.relativePath || final?.relativePath || "root";
      throw new Error(
        `native module inventory surface changed after module inspection ${relativePath}`,
      );
    }
  }
}

async function readVerifiedNativeModule(entry, openNativeModule) {
  let handle;
  try {
    handle = await openNativeModule(
      entry.absolutePath,
      NATIVE_MODULE_OPEN_FLAGS,
    );
  } catch {
    throw nativeModuleChangedError(entry.relativePath);
  }
  let bytes;
  let changed = false;
  try {
    const status = await handle.stat();
    if (!hasVerifiedIdentity(status, entry.identity)) {
      changed = true;
    } else {
      bytes = await handle.readFile();
    }
  } catch {
    changed = true;
  }
  try {
    await handle.close();
  } catch {
    changed = true;
  }
  if (changed) {
    throw nativeModuleChangedError(entry.relativePath);
  }
  return bytes;
}

export async function verifyPackagedNativeModule(context, options = {}) {
  const appOutDir = context?.appOutDir;
  if (typeof appOutDir !== "string" || appOutDir === "") {
    throw new Error("Electron Builder application output directory is missing");
  }
  const projectDirectory = context?.packager?.projectDir ?? process.cwd();
  const platform =
    context?.electronPlatformName ?? context?.packager?.platform?.name;
  if (platform !== "darwin" && platform !== "win32") {
    throw new Error(`packaged native platform is unsupported: ${platform}`);
  }
  const targetArchitecture = resolveTargetArchitecture(
    context,
    options.targetArchitecture,
  );
  const readDirectory = options.readdir ?? readdir;
  const openNativeModule = options.open ?? open;
  const inspectPath = options.lstat ?? lstat;
  const resolveCanonicalPath = options.realpath ?? realpath;
  const app =
    platform === "darwin"
      ? await resolveMacApp(appOutDir, readDirectory)
      : appOutDir;
  const unpackedRoot = resolveUnpackedRoot(app, platform);
  const scanOptions = {
    readdir: readDirectory,
    lstat: inspectPath,
    realpath: resolveCanonicalPath,
  };
  const initialScan = await scanUnpackedNativeModules(
    unpackedRoot,
    scanOptions,
  );
  const modules = initialScan.modules;
  if (modules.length === 0) {
    throw new Error("packaged native module inventory is empty");
  }
  const betterSqlite = modules.find(
    (entry) => entry.relativePath === BETTER_SQLITE_RELATIVE_PATH,
  );
  if (!betterSqlite) {
    throw new Error(
      "better-sqlite3 native module is missing from the packaged app.asar.unpacked tree",
    );
  }

  const expectedElectronAbi = await (
    options.resolveElectronAbi ?? resolveElectronAbi
  )(projectDirectory);
  const inventory = [];
  for (const entry of modules) {
    const bytes = await readVerifiedNativeModule(entry, openNativeModule);
    const inspected = inspectNativeModuleBytes(bytes, {
      label: entry.relativePath,
      expectedElectronAbi,
      expectedArchitecture: targetArchitecture,
      expectedPlatform: platform,
    });
    const inventoryEntry = {
      path: entry.relativePath,
      sha256: inspected.sha256,
      abi: inspected.abi,
      architecture: inspected.architecture,
      format: inspected.format,
    };
    if (inspected.architectures.length > 1) {
      inventoryEntry.architectures = inspected.architectures;
    }
    inventory.push(inventoryEntry);
  }

  const finalScan = await scanUnpackedNativeModules(unpackedRoot, scanOptions);
  assertStableNativeSurface(initialScan.surface, finalScan.surface);

  const inventoryPath = join(
    appOutDir,
    "..",
    `native-module-inventory-${platform}-${targetArchitecture}.json`,
  );
  await (options.writeFile ?? writeFile)(
    inventoryPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        platform,
        targetArchitecture,
        electronAbi: expectedElectronAbi,
        modules: inventory,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return {
    platform,
    targetArchitecture,
    nativeModule: betterSqlite.absolutePath,
    electronAbi: expectedElectronAbi,
    inventory,
    inventoryPath,
  };
}

export default verifyPackagedNativeModule;
