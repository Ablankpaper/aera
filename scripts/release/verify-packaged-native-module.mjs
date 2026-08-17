#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */

import {
  lstat,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import { join, posix } from "node:path";

import {
  inspectNativeModuleBytes,
  listUnpackedNativeModules,
  resolveElectronAbi,
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
  const readModule = options.readFile ?? readFile;
  const inspectPath = options.lstat ?? lstat;
  const resolveCanonicalPath = options.realpath ?? realpath;
  const app =
    platform === "darwin"
      ? await resolveMacApp(appOutDir, readDirectory)
      : appOutDir;
  const unpackedRoot = resolveUnpackedRoot(app, platform);
  const modules = await listUnpackedNativeModules(unpackedRoot, {
    readdir: readDirectory,
    lstat: inspectPath,
    realpath: resolveCanonicalPath,
  });
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
    const bytes = await readModule(entry.absolutePath);
    const inspected = inspectNativeModuleBytes(bytes, {
      label: entry.relativePath,
      expectedElectronAbi,
      expectedArchitecture: targetArchitecture,
      expectedPlatform: platform,
    });
    inventory.push({
      path: entry.relativePath,
      sha256: inspected.sha256,
      abi: inspected.abi,
      architecture: inspected.architecture,
    });
  }

  const inventoryPath = join(
    appOutDir,
    "..",
    `native-module-inventory-${platform}-${targetArchitecture}.json`,
  );
  await writeFile(
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
