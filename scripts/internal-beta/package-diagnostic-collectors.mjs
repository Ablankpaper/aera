#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalDiagnosticJson } from "../../deliveries/beta33-external-diagnostic/aera-diagnostic-schema.mjs";
import { packageCollector } from "../../deliveries/beta33-external-diagnostic/package-collector.mjs";
import { buildDiagnosticTarget } from "./build-diagnostic-target.mjs";

function digest(bytes, algorithm) {
  return createHash(algorithm).update(bytes).digest("hex");
}

export function buildCandidateDiagnosticTarget({
  manifestBytes,
  manifest,
  startup,
  identity,
  artifact,
}) {
  if (!Buffer.isBuffer(manifestBytes) || manifestBytes.length === 0)
    throw new Error("candidate manifest bytes are required");
  if (identity.version !== manifest.version)
    throw new Error(
      "installed application version differs from candidate manifest",
    );
  if (
    startup.sourceSha !== manifest.sourceSha ||
    startup.version !== manifest.version
  )
    throw new Error(
      "packaged startup evidence differs from candidate manifest",
    );
  if (
    startup.platform !== identity.platform ||
    startup.architecture !== identity.architecture ||
    startup.executable?.sha256 !== identity.executableSha256
  ) {
    throw new Error(
      "packaged startup evidence differs from installed application",
    );
  }
  if (startup.appAsar?.sha256 !== identity.packageSha256)
    throw new Error(
      "packaged app.asar differs from installed package identity",
    );
  return buildDiagnosticTarget({
    schemaVersion: 1,
    platform: identity.platform,
    version: identity.version,
    bundleId: identity.bundleId || undefined,
    applicationId: identity.applicationId || undefined,
    architecture: identity.architecture,
    executableSha256: identity.executableSha256,
    packageSha256: identity.packageSha256,
    artifactSha256: artifact.sha256,
    appAsarSha256: startup.appAsar.sha256,
    mainSha256: startup.entries.main.sha256,
    preloadSha256: startup.entries.preload.sha256,
    rendererSha256: startup.entries.renderer.sha256,
    sourceSha: manifest.sourceSha,
    candidateManifestSha256: digest(manifestBytes, "sha256"),
  });
}

export function packageCandidateDiagnosticCollectors({
  manifestBytes,
  manifest,
  macos,
  windows,
  outputDir,
}) {
  const destination = resolve(outputDir);
  mkdirSync(destination, { recursive: true });
  const collectors = [];
  for (const [platform, input] of [
    ["darwin", macos],
    ["win32", windows],
  ]) {
    const target = buildCandidateDiagnosticTarget({
      manifestBytes,
      manifest,
      ...input,
    });
    const targetPath = join(destination, `target-${platform}.json`);
    writeFileSync(targetPath, `${canonicalDiagnosticJson(target)}\n`, "utf8");
    const packaged = packageCollector({
      platform,
      outputDir: join(destination, `.staging-${platform}`),
      targetPath,
    });
    const bytes = readFileSync(packaged.zipPath);
    const name = basename(packaged.zipPath);
    const artifactPath = join(destination, name);
    writeFileSync(artifactPath, bytes, { flag: "wx", mode: 0o600 });
    collectors.push({
      platform,
      name,
      size: bytes.length,
      sha256: digest(bytes, "sha256"),
      sha512: digest(bytes, "sha512"),
      targetSha256: digest(
        Buffer.from(`${canonicalDiagnosticJson(target)}\n`),
        "sha256",
      ),
      collectorVersion: "4.0.0",
      schemaVersion: 4,
    });
  }
  for (const platform of ["darwin", "win32"])
    rmSync(join(destination, `.staging-${platform}`), {
      recursive: true,
      force: true,
    });
  for (const platform of ["darwin", "win32"])
    rmSync(join(destination, `target-${platform}.json`), { force: true });
  return {
    schemaVersion: 1,
    candidateManifestSha256: digest(manifestBytes, "sha256"),
    collectors,
  };
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value == null)
      throw new Error("collector packaging options must be flag/value pairs");
    values[flag.slice(2).replaceAll("-", "_")] = value;
  }
  return values;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  try {
    const values = parseArgs(process.argv.slice(2));
    const manifestBytes = readFileSync(resolve(values.manifest));
    const manifest = JSON.parse(manifestBytes);
    const read = (path) => JSON.parse(readFileSync(resolve(path), "utf8"));
    const result = packageCandidateDiagnosticCollectors({
      manifestBytes,
      manifest,
      macos: {
        identity: read(values.macos_identity),
        startup: read(values.macos_startup),
        artifact: read(values.macos_artifact),
      },
      windows: {
        identity: read(values.windows_identity),
        startup: read(values.windows_startup),
        artifact: read(values.windows_artifact),
      },
      outputDir: values.output,
    });
    writeFileSync(
      resolve(values.ledger),
      `${canonicalDiagnosticJson(result)}\n`,
      { flag: "wx", mode: 0o600 },
    );
  } catch (error) {
    console.error(error?.message || "collector packaging failed");
    process.exitCode = 1;
  }
}
