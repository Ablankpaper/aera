#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import { canonicalJSONStringify, hashArtifact } from "./candidate-manifest.mjs";

const execFileAsync = promisify(execFile);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export async function verifyMacCandidate(options) {
  const app = resolve(options.app);
  const dmg = resolve(options.dmg);
  const zip = resolve(options.zip);
  const reference = resolve(options.runtimeSeedReference);
  const manifest = resolve(options.runtimeSeedManifest);
  const desktopVersion = required(options.desktopVersion, "desktop version");

  await run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
  const signature = await run("codesign", ["-dv", "--verbose=4", app], {
    acceptStderr: true,
  });
  const signatureText = `${signature.stdout}\n${signature.stderr}`;
  const signingIdentity = firstMatch(
    signatureText,
    /^Authority=(Developer ID Application: .+)$/mu,
    "Developer ID Application identity",
  );
  const teamId = firstMatch(
    signatureText,
    /^TeamIdentifier=([A-Z0-9]{10})$/mu,
    "Developer ID team identifier",
  );
  if (!signingIdentity.includes(`(${teamId})`)) {
    throw new Error("Developer ID identity and TeamIdentifier differ");
  }
  await run("spctl", ["--assess", "--type", "execute", "--verbose=4", app]);
  await run("xcrun", ["stapler", "validate", app]);
  await run("xcrun", ["stapler", "validate", dmg]);

  const nativeModule = join(
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
  const architecture = await run("file", [nativeModule]);
  if (!/\barm64\b/u.test(architecture.stdout)) {
    throw new Error("macOS native module is not arm64");
  }

  const appSeed = join(app, "Contents", "Resources", "agentera-runtime-seed");
  await verifyRuntimeSeed(appSeed, reference, desktopVersion);

  const zipRoot = await mkdtemp(join(tmpdir(), "aera-mac-zip."));
  const mountRoot = await mkdtemp(join(tmpdir(), "aera-mac-dmg."));
  let mounted = false;
  try {
    await run("ditto", ["-x", "-k", zip, zipRoot]);
    const zipSeed = await findSeed(zipRoot);
    await verifyRuntimeSeed(zipSeed, reference, desktopVersion);

    await run("hdiutil", [
      "attach",
      "-nobrowse",
      "-readonly",
      "-mountpoint",
      mountRoot,
      dmg,
    ]);
    mounted = true;
    const dmgSeed = await findSeed(mountRoot);
    await verifyRuntimeSeed(dmgSeed, reference, desktopVersion);
  } finally {
    if (mounted) {
      await run("hdiutil", ["detach", mountRoot]).catch(() => {});
    }
    await Promise.all([
      rm(zipRoot, { recursive: true, force: true }),
      rm(mountRoot, { recursive: true, force: true }),
    ]);
  }

  const notarization = JSON.parse(
    await readFile(options.notarizationEvidence, "utf8"),
  );
  const notarizations = validateNotarizations(notarization, [
    basename(dmg),
    basename(zip),
  ]);
  const [dmgHash, zipHash, manifestHash] = await Promise.all([
    hashArtifact(dmg),
    hashArtifact(zip),
    hashArtifact(manifest),
  ]);
  return {
    arch: "arm64",
    signingIdentity,
    teamId,
    codesignVerified: true,
    gatekeeperAccepted: true,
    appStapled: true,
    dmgStapled: true,
    notarizations,
    runtimeSeedVerifiedArtifacts: [basename(dmg), basename(zip)],
    nativeModuleArchitecture: "arm64",
    runtimeSeedManifest: {
      manifest: basename(manifest),
      manifestSha256: manifestHash.sha256,
    },
    artifacts: [
      {
        name: basename(dmg),
        platform: "macos",
        arch: "arm64",
        kind: "macos_dmg",
        ...dmgHash,
      },
      {
        name: basename(zip),
        platform: "macos",
        arch: "arm64",
        kind: "macos_zip",
        ...zipHash,
      },
    ],
  };
}

function validateNotarizations(document, requiredArtifacts) {
  if (!Array.isArray(document?.notarizations)) {
    throw new Error("macOS notarization evidence is missing");
  }
  const byArtifact = new Map(
    document.notarizations.map((entry) => [entry?.artifact, entry]),
  );
  return requiredArtifacts.map((artifact) => {
    const entry = byArtifact.get(artifact);
    if (entry?.status !== "Accepted" || !UUID_PATTERN.test(entry?.id ?? "")) {
      throw new Error(
        `Accepted notarization evidence is missing for ${artifact}`,
      );
    }
    return { artifact, id: entry.id, status: entry.status };
  });
}

async function verifyRuntimeSeed(directory, reference, desktopVersion) {
  await run(process.execPath, [
    resolve("scripts/verify-packaged-runtime-seed.mjs"),
    directory,
    "--reference-dir",
    reference,
    "--desktop-version",
    desktopVersion,
  ]);
}

async function findSeed(root) {
  const result = await run("find", [
    root,
    "-type",
    "d",
    "-path",
    "*/Contents/Resources/agentera-runtime-seed",
    "-print",
    "-quit",
  ]);
  const found = result.stdout.trim();
  if (found.length === 0) {
    throw new Error("Packaged macOS Runtime Seed is missing");
  }
  return found;
}

async function run(command, arguments_, options = {}) {
  try {
    return await execFileAsync(command, arguments_, {
      encoding: "utf8",
      env: process.env,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (error) {
    if (
      options.acceptStderr &&
      typeof error?.stderr === "string" &&
      error.code === 0
    ) {
      return { stdout: error.stdout ?? "", stderr: error.stderr };
    }
    const detail =
      typeof error?.stderr === "string" && error.stderr.trim() !== ""
        ? error.stderr.trim()
        : error instanceof Error
          ? error.message
          : String(error);
    throw new Error(`${command} verification failed: ${detail}`);
  }
}

function firstMatch(value, pattern, label) {
  const match = pattern.exec(value);
  if (!match) throw new Error(`${label} is missing`);
  return match[1];
}

function required(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is required`);
  }
  return value;
}

function parseOptions(arguments_) {
  if (arguments_.length === 0 || arguments_.length % 2 !== 0) {
    throw new Error("macOS verifier options must be flag/value pairs");
  }
  const values = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (!flag.startsWith("--") || value === undefined) {
      throw new Error("macOS verifier options must be flag/value pairs");
    }
    const key = flag.slice(2).replaceAll("-", "_");
    if (Object.hasOwn(values, key))
      throw new Error(`Duplicate option: ${flag}`);
    values[key] = value;
  }
  return values;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const values = parseOptions(process.argv.slice(2));
  verifyMacCandidate({
    app: values.app,
    dmg: values.dmg,
    zip: values.zip,
    runtimeSeedReference: values.runtime_seed_reference,
    runtimeSeedManifest: values.runtime_seed_manifest,
    desktopVersion: values.desktop_version,
    notarizationEvidence: values.notarization_evidence,
  })
    .then(async (evidence) => {
      await writeFile(values.output, canonicalJSONStringify(evidence), {
        flag: "wx",
        mode: 0o600,
      });
      process.stdout.write(
        "macOS candidate signatures and notarization verified\n",
      );
    })
    .catch((error) => {
      process.stderr.write(
        `macOS candidate verification failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}
