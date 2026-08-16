#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { validateInternalBetaTrustInputs } from "./manifest.mjs";
import {
  resolveElectronAbi,
  resolveProjectNativeModule,
  verifyNativeModuleAbi,
} from "../release/native-module-abi.mjs";

async function readJavaScriptSources(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const sourceGroups = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        return readJavaScriptSources(entryPath);
      }
      if (entry.isFile() && entry.name.endsWith(".js")) {
        return [await readFile(entryPath, "utf8")];
      }
      return [];
    }),
  );
  return sourceGroups.flat();
}

function parseBakedOfflineTrust(sources) {
  const match = sources
    .join("\n")
    .match(
      /buildOfflinePublicKeysJson:\s*(?:'(?<single>[^'\r\n]+)'|"(?<double>(?:\\.|[^"\\])*)")/u,
    );
  if (!match?.groups) {
    throw new Error("baked offline trust is missing");
  }
  const raw =
    match.groups.single ?? JSON.parse(`"${match.groups.double ?? ""}"`);
  let document;
  try {
    document = JSON.parse(raw);
  } catch {
    throw new Error("baked offline trust is invalid JSON");
  }
  if (
    !document ||
    typeof document !== "object" ||
    Array.isArray(document) ||
    !Array.isArray(document.keys) ||
    document.keys.length !== 1
  ) {
    throw new Error("baked offline trust must contain one key");
  }
  return {
    issuer: document.issuer,
    keyId: document.keys[0]?.keyId,
    publicKey: document.keys[0]?.publicKey,
  };
}

export async function verifyBuiltAuthConfig(mainDirectory, options = {}) {
  const sources = await readJavaScriptSources(mainDirectory);
  const cloudResolver = sources
    .map(
      (source) =>
        source.match(
          /function getAgenteraCloudOrigin\(\)\s*\{[\s\S]*?\n\}/u,
        )?.[0],
    )
    .find(Boolean);
  const cloudOrigin = cloudResolver?.match(
    /buildPublicUrl:\s*["'](?<origin>https:\/\/[^"'\s]+)["']/u,
  )?.groups?.origin;
  if (!cloudOrigin) {
    throw new Error("baked Cloud origin is missing");
  }
  const trust = parseBakedOfflineTrust(sources);
  if (trust.issuer !== cloudOrigin) {
    throw new Error("baked offline trust differs from the Cloud origin");
  }
  validateInternalBetaTrustInputs({
    origin: cloudOrigin,
    trustIssuer: trust.issuer,
    offlineKeyId: trust.keyId,
    offlinePublicKey: trust.publicKey,
  });
  if (options.projectDirectory && options.expectedElectronAbi) {
    await verifyNativeModuleAbi(
      resolveProjectNativeModule(options.projectDirectory),
      options.expectedElectronAbi,
    );
  }
}

export default async function beforePack(context, options = {}) {
  const projectDirectory = context?.packager?.projectDir;
  if (typeof projectDirectory !== "string" || projectDirectory === "") {
    throw new Error("Electron Builder project directory is missing");
  }
  const expectedElectronAbi = await (
    options.resolveElectronAbi ?? resolveElectronAbi
  )(projectDirectory);
  await verifyBuiltAuthConfig(resolve(projectDirectory, "out", "main"), {
    projectDirectory,
    expectedElectronAbi,
  });
}

async function runCli(arguments_) {
  if (arguments_.length !== 1) {
    throw new Error("usage: verify-built-auth-config.mjs OUT_MAIN_DIRECTORY");
  }
  await verifyBuiltAuthConfig(resolve(arguments_[0]));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  runCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `Internal Beta packaged auth config failed: ${error.message}\n`,
    );
    process.exitCode = 1;
  });
}
