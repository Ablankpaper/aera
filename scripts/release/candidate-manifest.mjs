#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { parse as parseYAML } from "yaml";

const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const UPDATE_SHA512_PATTERN = /^[A-Za-z0-9+/]{86}==$/u;
const SAFE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u;
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u;

export function canonicalJSONStringify(value) {
  return `${JSON.stringify(sortJSON(value))}\n`;
}

function sortJSON(value) {
  if (Array.isArray(value)) return value.map(sortJSON);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortJSON(value[key])]),
    );
  }
  if (
    value === undefined ||
    typeof value === "function" ||
    typeof value === "symbol" ||
    (typeof value === "number" && !Number.isFinite(value))
  ) {
    throw new TypeError("Candidate evidence contains a non-JSON value");
  }
  return value;
}

export function buildUpdateMetadata({ version, target, releaseDate }) {
  if (
    !VERSION_PATTERN.test(version) ||
    !SAFE_NAME_PATTERN.test(target?.name ?? "") ||
    !Number.isSafeInteger(target?.size) ||
    target.size <= 0 ||
    !UPDATE_SHA512_PATTERN.test(target?.sha512 ?? "") ||
    !isISOTime(releaseDate)
  ) {
    throw new Error("Update metadata inputs are invalid");
  }
  return [
    `version: ${version}`,
    "files:",
    `  - url: ${target.name}`,
    `    sha512: ${target.sha512}`,
    `    size: ${target.size}`,
    `path: ${target.name}`,
    `sha512: ${target.sha512}`,
    `releaseDate: '${releaseDate}'`,
    "",
  ].join("\n");
}

export function buildSpdxDocument({
  packageLock,
  runtimeLock,
  sourceSha,
  createdAt,
}) {
  if (
    packageLock === null ||
    typeof packageLock !== "object" ||
    runtimeLock === null ||
    typeof runtimeLock !== "object" ||
    !SHA_PATTERN.test(sourceSha) ||
    !isISOTime(createdAt)
  ) {
    throw new Error("SPDX inputs are invalid");
  }
  const rootName = packageLock.name ?? packageLock.packages?.[""]?.name;
  const rootVersion =
    packageLock.version ?? packageLock.packages?.[""]?.version;
  if (
    typeof rootName !== "string" ||
    typeof rootVersion !== "string" ||
    typeof packageLock.packages !== "object"
  ) {
    throw new Error("package-lock.json is incomplete");
  }
  if (
    typeof runtimeLock.repository !== "string" ||
    typeof runtimeLock.runtime_version !== "string" ||
    !SHA_PATTERN.test(runtimeLock.source_commit ?? "")
  ) {
    throw new Error("Runtime Seed lock is incomplete");
  }

  const packages = [];
  const rootID = spdxID(`npm:${rootName}@${rootVersion}:root`);
  packages.push({
    SPDXID: rootID,
    copyrightText: "NOASSERTION",
    downloadLocation: "NOASSERTION",
    filesAnalyzed: false,
    licenseConcluded: "NOASSERTION",
    licenseDeclared: "NOASSERTION",
    name: rootName,
    versionInfo: rootVersion,
  });

  const dependencyIDs = [];
  for (const [location, descriptor] of Object.entries(
    packageLock.packages,
  ).sort(([left], [right]) => left.localeCompare(right))) {
    if (
      location === "" ||
      descriptor === null ||
      typeof descriptor !== "object" ||
      typeof descriptor.version !== "string"
    ) {
      continue;
    }
    const name =
      descriptor.name ??
      location
        .replace(/^node_modules\//u, "")
        .replaceAll("/node_modules/", "/");
    if (typeof name !== "string" || name.length === 0) continue;
    const id = spdxID(`npm:${name}@${descriptor.version}:${location}`);
    dependencyIDs.push(id);
    packages.push({
      SPDXID: id,
      copyrightText: "NOASSERTION",
      downloadLocation:
        typeof descriptor.resolved === "string"
          ? descriptor.resolved
          : "NOASSERTION",
      filesAnalyzed: false,
      licenseConcluded: "NOASSERTION",
      licenseDeclared:
        typeof descriptor.license === "string"
          ? descriptor.license
          : "NOASSERTION",
      name,
      versionInfo: descriptor.version,
    });
  }

  const runtimeID = spdxID(
    `runtime:${runtimeLock.repository}@${runtimeLock.source_commit}`,
  );
  packages.push({
    SPDXID: runtimeID,
    copyrightText: "NOASSERTION",
    downloadLocation: `https://github.com/${runtimeLock.repository}/commit/${runtimeLock.source_commit}`,
    externalRefs: [
      {
        referenceCategory: "OTHER",
        referenceLocator: runtimeLock.source_commit,
        referenceType: "source-commit",
      },
    ],
    filesAnalyzed: false,
    licenseConcluded: "NOASSERTION",
    licenseDeclared: "NOASSERTION",
    name: "Aera Runtime Seed",
    versionInfo: runtimeLock.runtime_version,
  });

  return {
    SPDXID: "SPDXRef-DOCUMENT",
    creationInfo: {
      created: createdAt,
      creators: ["Tool: Aera Desktop candidate-manifest.mjs"],
      licenseListVersion: "3.25",
    },
    dataLicense: "CC0-1.0",
    documentDescribes: [rootID, runtimeID],
    documentNamespace: `https://github.com/Ablankpaper/aera/candidate/${sourceSha}`,
    name: `Aera Desktop ${rootVersion} candidate SBOM`,
    packages,
    relationships: [
      ...dependencyIDs.map((id) => ({
        relatedSpdxElement: id,
        relationshipType: "DEPENDS_ON",
        spdxElementId: rootID,
      })),
      {
        relatedSpdxElement: runtimeID,
        relationshipType: "CONTAINS",
        spdxElementId: rootID,
      },
    ],
    spdxVersion: "SPDX-2.3",
  };
}

function spdxID(value) {
  return `SPDXRef-${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

export async function hashArtifact(path) {
  const sha256 = createHash("sha256");
  const sha512 = createHash("sha512");
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    size += chunk.length;
    sha256.update(chunk);
    sha512.update(chunk);
  }
  return {
    size,
    sha256: sha256.digest("hex"),
    sha512: sha512.digest("hex"),
  };
}

export async function buildCandidateManifest(options) {
  const sourceSha = requiredMatch(options.sourceSha, SHA_PATTERN, "source SHA");
  const version = requiredMatch(
    options.version,
    VERSION_PATTERN,
    "desktop version",
  );
  const createdAt = requiredISO(options.createdAt, "candidate creation time");
  const repository = requiredString(options.repository, "repository");
  if (repository !== "Ablankpaper/aera") {
    throw new Error("Candidate repository must be Ablankpaper/aera");
  }

  const packageDocument = await readJSON(options.packageJson);
  if (packageDocument.version !== version) {
    throw new Error("Candidate version differs from package.json");
  }
  const runtimeLock = await readJSON(options.runtimeLock);
  const runtimeLockHash = await hashArtifact(options.runtimeLock);
  const macEvidence = await readJSON(options.macEvidence);
  const windowsEvidence = await readJSON(options.windowsEvidence);
  const artifactsDirectory = resolve(options.artifactsDirectory);

  const artifactSpecs = [
    ...evidenceArtifacts(macEvidence, "macOS"),
    ...evidenceArtifacts(windowsEvidence, "Windows"),
  ];
  const macZip = oneKind(artifactSpecs, "macos_zip");
  const windowsSetup = oneKind(artifactSpecs, "windows_setup");
  const macZipUpdateTarget = updateTarget(macZip);
  const windowsSetupUpdateTarget = updateTarget(windowsSetup);

  const latestMacPath = join(artifactsDirectory, "latest-mac.yml");
  const latestWindowsPath = join(artifactsDirectory, "latest.yml");
  await Promise.all([
    writeFile(
      latestMacPath,
      buildUpdateMetadata({
        version,
        target: macZipUpdateTarget,
        releaseDate: createdAt,
      }),
      { flag: "wx", mode: 0o600 },
    ),
    writeFile(
      latestWindowsPath,
      buildUpdateMetadata({
        version,
        target: windowsSetupUpdateTarget,
        releaseDate: createdAt,
      }),
      { flag: "wx", mode: 0o600 },
    ),
  ]);

  const artifactEntries = [];
  for (const spec of [
    ...artifactSpecs,
    {
      name: "latest-mac.yml",
      platform: "macos",
      arch: "arm64",
      kind: "update_metadata",
    },
    {
      name: "latest.yml",
      platform: "windows",
      arch: "x64",
      kind: "update_metadata",
    },
  ]) {
    const path = join(artifactsDirectory, spec.name);
    const actual = await hashArtifact(path);
    if (
      spec.size !== undefined &&
      (actual.size !== spec.size ||
        actual.sha256 !== spec.sha256 ||
        actual.sha512 !== spec.sha512)
    ) {
      throw new Error(`Platform evidence differs from ${spec.name}`);
    }
    artifactEntries.push({
      name: spec.name,
      platform: spec.platform,
      arch: spec.arch,
      kind: spec.kind,
      ...actual,
      releasable: true,
    });
  }
  artifactEntries.sort((left, right) => left.name.localeCompare(right.name));

  const sbomHash = await hashArtifact(options.sbom);
  const provenanceHash = await hashArtifact(options.provenance);
  const macManifest = runtimeManifest(macEvidence, "macos", "arm64");
  const windowsManifest = runtimeManifest(windowsEvidence, "windows", "x64");
  const metadata = (file, targetKind) => {
    const fileEntry = oneKind(artifactEntries, "update_metadata", file);
    const target = oneKind(artifactEntries, targetKind);
    return {
      file: fileEntry.name,
      version,
      target: target.name,
      targetSha512: updaterSha512(target.sha512),
      targetSize: target.size,
    };
  };

  return {
    schemaVersion: 1,
    repository,
    sourceSha,
    version,
    build: {
      workflow: requiredString(options.workflow, "workflow"),
      runUrl: requiredURL(options.runUrl, "candidate run URL"),
      ciRunUrl: requiredURL(options.ciRunUrl, "CI run URL"),
    },
    runtimeSeed: {
      lockSha256: runtimeLockHash.sha256,
      sourceCommit: requiredMatch(
        runtimeLock.source_commit,
        SHA_PATTERN,
        "Runtime Seed source commit",
      ),
      runtimeVersion: requiredString(
        runtimeLock.runtime_version,
        "Runtime Seed version",
      ),
      targets: [macManifest, windowsManifest],
    },
    platformEvidence: {
      macos: withoutArtifacts(macEvidence),
      windows: withoutArtifacts(windowsEvidence),
    },
    artifacts: artifactEntries,
    updateMetadata: {
      macos: metadata("latest-mac.yml", "macos_zip"),
      windows: metadata("latest.yml", "windows_setup"),
    },
    supplyChain: {
      sbom: {
        name: options.sbomName ?? "sbom.spdx.json",
        sha256: sbomHash.sha256,
      },
      provenance: {
        name: options.provenanceName ?? "provenance.json",
        sha256: provenanceHash.sha256,
      },
      githubAttestation: {
        required: true,
        signerWorkflow:
          "github.com/Ablankpaper/aera/.github/workflows/release-candidate.yml",
      },
    },
    linuxReleasable: false,
    createdAt,
  };
}

function evidenceArtifacts(evidence, label) {
  if (!Array.isArray(evidence?.artifacts) || evidence.artifacts.length === 0) {
    throw new Error(`${label} artifact evidence is missing`);
  }
  return evidence.artifacts.map((artifact) => {
    if (
      !SAFE_NAME_PATTERN.test(artifact?.name ?? "") ||
      !["macos", "windows"].includes(artifact?.platform) ||
      !["arm64", "x64"].includes(artifact?.arch) ||
      typeof artifact?.kind !== "string" ||
      !Number.isSafeInteger(artifact?.size) ||
      artifact.size <= 0 ||
      !DIGEST_PATTERN.test(artifact?.sha256 ?? "") ||
      !/^[0-9a-f]{128}$/u.test(artifact?.sha512 ?? "")
    ) {
      throw new Error(`${label} artifact evidence is invalid`);
    }
    return artifact;
  });
}

function withoutArtifacts(evidence) {
  const rest = { ...evidence };
  delete rest.artifacts;
  delete rest.runtimeSeedManifest;
  return rest;
}

function runtimeManifest(evidence, platform, arch) {
  const item = evidence?.runtimeSeedManifest;
  if (
    !SAFE_NAME_PATTERN.test(item?.manifest ?? "") ||
    !DIGEST_PATTERN.test(item?.manifestSha256 ?? "")
  ) {
    throw new Error(`${platform} Runtime Seed manifest evidence is missing`);
  }
  return { platform, arch, ...item };
}

function oneKind(entries, kind, name) {
  const matches = entries.filter(
    (entry) =>
      entry.kind === kind && (name === undefined || entry.name === name),
  );
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one ${kind} artifact`);
  }
  return matches[0];
}

function updateTarget(artifact) {
  return { ...artifact, sha512: updaterSha512(artifact.sha512) };
}

export function updaterSha512(hexDigest) {
  if (!/^[0-9a-f]{128}$/u.test(hexDigest ?? "")) {
    throw new Error("Artifact SHA-512 digest is invalid");
  }
  return Buffer.from(hexDigest, "hex").toString("base64");
}

export function parseUpdateMetadata(raw) {
  const value = parseYAML(raw, { maxAliasCount: 0 });
  if (
    value === null ||
    typeof value !== "object" ||
    typeof value.version !== "string" ||
    !Array.isArray(value.files) ||
    value.files.length !== 1 ||
    typeof value.path !== "string" ||
    !UPDATE_SHA512_PATTERN.test(value.sha512 ?? "") ||
    typeof value.releaseDate !== "string"
  ) {
    throw new Error("Update metadata document is invalid");
  }
  const file = value.files[0];
  if (
    file === null ||
    typeof file !== "object" ||
    file.url !== value.path ||
    file.sha512 !== value.sha512 ||
    !UPDATE_SHA512_PATTERN.test(file.sha512 ?? "") ||
    !Number.isSafeInteger(file.size) ||
    file.size <= 0
  ) {
    throw new Error("Update metadata target is inconsistent");
  }
  return {
    version: value.version,
    target: value.path,
    targetSha512: value.sha512,
    targetSize: file.size,
    releaseDate: value.releaseDate,
  };
}

async function runCLI(argv) {
  const [command, ...rest] = argv;
  const values = parseOptions(rest);
  switch (command) {
    case "metadata": {
      const target = await hashArtifact(values.target);
      target.name = values.target_name ?? values.target.split(/[\\/]/u).at(-1);
      await writeOutput(
        values.output,
        buildUpdateMetadata({
          version: values.version,
          target,
          releaseDate: values.release_date,
        }),
      );
      break;
    }
    case "sbom": {
      const document = buildSpdxDocument({
        packageLock: await readJSON(values.package_lock),
        runtimeLock: await readJSON(values.runtime_lock),
        sourceSha: values.source_sha,
        createdAt: values.created_at,
      });
      await writeOutput(values.output, canonicalJSONStringify(document));
      break;
    }
    case "build": {
      const document = await buildCandidateManifest({
        artifactsDirectory: values.artifacts_dir,
        macEvidence: values.mac_evidence,
        windowsEvidence: values.windows_evidence,
        runtimeLock: values.runtime_lock,
        packageJson: values.package_json,
        sbom: values.sbom,
        provenance: values.provenance,
        sourceSha: values.source_sha,
        version: values.version,
        repository: values.repository,
        workflow: values.workflow,
        runUrl: values.run_url,
        ciRunUrl: values.ci_run_url,
        createdAt: values.created_at,
      });
      const { validateCandidateDocument } =
        await import("./verify-candidate.mjs");
      validateCandidateDocument(document, {
        expectedSourceSha: values.source_sha,
        expectedVersion: values.version,
      });
      await writeOutput(values.output, canonicalJSONStringify(document));
      break;
    }
    default:
      throw new Error(
        "usage: candidate-manifest.mjs metadata|sbom|build --flag value ...",
      );
  }
}

function parseOptions(arguments_) {
  if (arguments_.length === 0 || arguments_.length % 2 !== 0) {
    throw new Error("Candidate command options must be flag/value pairs");
  }
  const values = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (!flag.startsWith("--") || value === undefined) {
      throw new Error("Candidate command options must be flag/value pairs");
    }
    const key = flag.slice(2).replaceAll("-", "_");
    if (Object.hasOwn(values, key))
      throw new Error(`Duplicate option: ${flag}`);
    values[key] = value;
  }
  return values;
}

async function writeOutput(path, contents) {
  if (typeof path !== "string" || path.length === 0) {
    throw new Error("Output path is required");
  }
  await mkdir(dirname(resolve(path)), { recursive: true });
  await writeFile(path, contents, { flag: "wx", mode: 0o600 });
}

async function readJSON(path) {
  if (typeof path !== "string" || path.length === 0) {
    throw new Error("JSON input path is required");
  }
  return JSON.parse(await readFile(path, "utf8"));
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is required`);
  }
  return value;
}

function requiredMatch(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function requiredISO(value, label) {
  if (!isISOTime(value)) throw new Error(`${label} is invalid`);
  return value;
}

function requiredURL(value, label) {
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname !== "github.com" ||
      !/^\/Ablankpaper\/aera\/actions\/runs\/[1-9][0-9]*$/u.test(
        parsed.pathname,
      ) ||
      parsed.search !== "" ||
      parsed.hash !== ""
    ) {
      throw new Error();
    }
    return parsed.toString();
  } catch {
    throw new Error(`${label} is invalid`);
  }
}

function isISOTime(value) {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  runCLI(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `Desktop candidate manifest failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
