#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function resolveProjectNativeModule(projectDirectory) {
  return join(
    projectDirectory,
    "node_modules",
    "better-sqlite3",
    "build",
    "Release",
    "better_sqlite3.node",
  );
}

export function resolvePackagedNativeModule(app) {
  return join(
    app,
    "Contents",
    "Resources",
    "app.asar.unpacked",
    "node_modules",
    "better-sqlite3",
    "build",
    "Release",
    "better_sqlite3.node",
  );
}

export async function readNativeModuleAbi(nativeModule) {
  const bytes = await readFile(nativeModule);
  const matches = new Set(
    [...bytes.toString("latin1").matchAll(/node_register_module_v(\d+)/gu)].map(
      (match) => match[1],
    ),
  );
  return matches.size === 1 ? [...matches][0] : null;
}

export async function verifyNativeModuleAbi(nativeModule, expectedElectronAbi) {
  const actualAbi = await readNativeModuleAbi(nativeModule);
  if (actualAbi !== expectedElectronAbi) {
    throw new Error(
      `better-sqlite3 ABI ${actualAbi ?? "unknown"} differs from Electron ABI ${expectedElectronAbi}`,
    );
  }
  return actualAbi;
}

export async function resolveElectronAbi(projectDirectory) {
  const projectRequire = createRequire(
    resolve(projectDirectory, "package.json"),
  );
  const electronExecutable = projectRequire("electron");
  const { stdout } = await execFileAsync(
    electronExecutable,
    ["-p", "process.versions.modules"],
    {
      encoding: "utf8",
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    },
  );
  const abi = stdout.trim();
  if (!/^\d+$/u.test(abi)) {
    throw new Error("Electron ABI could not be resolved");
  }
  return abi;
}
