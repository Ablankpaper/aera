#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  parseDiagnosticTargetV1,
  canonicalDiagnosticJson,
} from "../../deliveries/beta33-external-diagnostic/aera-diagnostic-schema.mjs";

const ALLOWED = new Set([
  "schemaVersion",
  "platform",
  "version",
  "bundleId",
  "applicationId",
  "architecture",
  "executableSha256",
  "packageSha256",
  "artifactSha256",
  "appAsarSha256",
  "mainSha256",
  "preloadSha256",
  "rendererSha256",
  "sourceSha",
  "candidateManifestSha256",
]);

export function buildDiagnosticTarget(candidate) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
    throw new Error("candidate manifest must be an object");
  for (const key of Object.keys(candidate)) {
    if (!ALLOWED.has(key))
      throw new Error(`candidate contains unknown field: ${key}`);
  }
  const artifact = candidate.artifactSha256;
  const packageSha256 = candidate.packageSha256 || artifact;
  if (
    artifact &&
    candidate.packageSha256 &&
    artifact !== candidate.packageSha256
  )
    throw new Error("artifactSha256 and packageSha256 conflict");
  const target = {
    schemaVersion: 1,
    platform: candidate.platform,
    version: candidate.version,
    bundleId: candidate.bundleId || candidate.applicationId,
    applicationId: candidate.applicationId,
    architecture: candidate.architecture,
    executableSha256: candidate.executableSha256,
    packageSha256,
    artifactSha256: artifact,
    appAsarSha256: candidate.appAsarSha256,
    mainSha256: candidate.mainSha256,
    preloadSha256: candidate.preloadSha256,
    rendererSha256: candidate.rendererSha256,
    sourceSha: candidate.sourceSha,
    candidateManifestSha256: candidate.candidateManifestSha256,
    bindingStatus: "candidate-bound",
  };
  for (const key of Object.keys(target))
    if (target[key] == null) delete target[key];
  return parseDiagnosticTargetV1(target);
}

export function main(argv = process.argv.slice(2)) {
  let manifestPath;
  let outputPath;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--manifest") manifestPath = argv[++index];
    else if (argv[index] === "--output") outputPath = argv[++index];
    else if (argv[index] === "--help") return 0;
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  if (!manifestPath || !outputPath)
    throw new Error("--manifest and --output are required");
  const candidate = JSON.parse(readFileSync(resolve(manifestPath), "utf8"));
  const target = buildDiagnosticTarget(candidate);
  writeFileSync(
    resolve(outputPath),
    `${canonicalDiagnosticJson(target)}\n`,
    "utf8",
  );
  return 0;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)
) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error?.message || "target builder failed");
    process.exitCode = 1;
  }
}
