#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  resolveElectronAbi,
  resolvePackagedNativeModule,
  verifyNativeModuleAbi,
} from "./native-module-abi.mjs";

async function resolveMacApp(appOutDir) {
  if (appOutDir.endsWith(".app")) return appOutDir;
  const entries = await readdir(appOutDir, { withFileTypes: true });
  const apps = entries.filter(
    (entry) => entry.isDirectory() && entry.name.endsWith(".app"),
  );
  if (apps.length !== 1) {
    throw new Error("packaged macOS output must contain exactly one app");
  }
  return join(appOutDir, apps[0].name);
}

function resolveNonMacNativeModule(appOutDir) {
  return join(
    appOutDir,
    "resources",
    "app.asar.unpacked",
    "node_modules",
    "better-sqlite3",
    "build",
    "Release",
    "better_sqlite3.node",
  );
}

export async function verifyPackagedNativeModule(context, options = {}) {
  const appOutDir = context?.appOutDir;
  if (typeof appOutDir !== "string" || appOutDir === "") {
    throw new Error("Electron Builder application output directory is missing");
  }
  const projectDirectory = context?.packager?.projectDir ?? process.cwd();
  const platform =
    context?.electronPlatformName ?? context?.packager?.platform?.name;
  const app =
    platform === "darwin" ? await resolveMacApp(appOutDir) : appOutDir;
  const nativeModule =
    platform === "darwin"
      ? resolvePackagedNativeModule(app)
      : resolveNonMacNativeModule(app);
  const expectedElectronAbi = await (
    options.resolveElectronAbi ?? resolveElectronAbi
  )(projectDirectory);
  await verifyNativeModuleAbi(nativeModule, expectedElectronAbi);
  return { platform, nativeModule, electronAbi: expectedElectronAbi };
}

export default verifyPackagedNativeModule;
