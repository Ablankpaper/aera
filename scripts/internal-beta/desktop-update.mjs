#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { canonicalJSONStringify } from "./manifest.mjs";

export const DESKTOP_UPDATE_CHANNEL = "internal-beta";
export const DESKTOP_UPDATE_KEY_ID = "desktop-update-2026-07";

const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+-internal-beta\.[1-9][0-9]*$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const SHA512_PATTERN = /^[A-Za-z0-9+/]{86}==$/u;
const FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u;
const ISO_SECONDS_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u;
const MANIFEST_FIELDS = [
  "artifacts",
  "channel",
  "key_id",
  "published_at",
  "release_notes",
  "schema_version",
  "version",
];
const ARTIFACT_FIELDS = [
  "arch",
  "kind",
  "name",
  "platform",
  "sha256",
  "sha512",
  "size",
  "url",
];
const SIGNATURE_FIELDS = [
  "algorithm",
  "key_id",
  "schema_version",
  "signature_base64",
];

export function canonicalDesktopUpdateJSONStringify(value) {
  const rendered = canonicalJSONStringify(value);
  if (!rendered.endsWith("\n")) {
    throw new Error("Canonical JSON renderer did not terminate with newline");
  }
  return rendered.slice(0, -1);
}

function exactObject(value, fields, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  if (Object.keys(value).sort().join("\n") !== [...fields].sort().join("\n")) {
    throw new Error(`${label} fields differ`);
  }
  return value;
}

function requiredVersion(value) {
  if (typeof value !== "string" || !VERSION_PATTERN.test(value)) {
    throw new Error("Desktop update version is invalid");
  }
  return value;
}

function requiredTimestamp(value) {
  if (
    typeof value !== "string" ||
    !ISO_SECONDS_PATTERN.test(value) ||
    Number.isNaN(new Date(value).valueOf())
  ) {
    throw new Error("Desktop update published_at is invalid");
  }
  return value;
}

function requiredBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Desktop update base URL is invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    url.pathname !== "/desktop-updates/internal-beta"
  ) {
    throw new Error("Desktop update base URL is outside the reviewed channel");
  }
  return url.href.replace(/\/$/u, "");
}

function artifactSpecifications(version) {
  return [
    {
      platform: "darwin",
      arch: "arm64",
      kind: "zip",
      name: `Aera-Internal-Beta-${version}-macos-arm64.zip`,
    },
    {
      platform: "win32",
      arch: "x64",
      kind: "nsis",
      name: `Aera-Internal-Beta-${version}-windows-x64-setup.exe`,
    },
  ];
}

async function hashArtifact(path) {
  const sha256 = createHash("sha256");
  const sha512 = createHash("sha512");
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (!Number.isSafeInteger(size)) {
      throw new Error("Desktop update artifact size exceeds the safe range");
    }
    sha256.update(bytes);
    sha512.update(bytes);
  }
  return {
    size,
    sha256: sha256.digest("hex"),
    sha512: sha512.digest("base64"),
  };
}

function loadPrivateKey(value) {
  let key;
  try {
    key = createPrivateKey(value);
  } catch (error) {
    throw new Error("Desktop update signing private key is invalid", {
      cause: error,
    });
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error("Desktop update signing key must be Ed25519");
  }
  return key;
}

function loadPublicKey(value) {
  let key;
  try {
    key = createPublicKey(value);
  } catch (error) {
    throw new Error("Desktop update signing public key is invalid", {
      cause: error,
    });
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error("Desktop update signing public key must be Ed25519");
  }
  return key;
}

export async function buildDesktopUpdateManifest(options) {
  const version = requiredVersion(options.version);
  const baseUrl = requiredBaseUrl(options.baseUrl);
  const artifacts = [];
  for (const specification of artifactSpecifications(version)) {
    const digest = await hashArtifact(
      join(options.artifactsDirectory, specification.name),
    );
    artifacts.push({
      ...specification,
      ...digest,
      url: `${baseUrl}/releases/${version}/${specification.name}`,
    });
  }
  const releaseNotes =
    typeof options.releaseNotes === "string" ? options.releaseNotes.trim() : "";
  if (
    releaseNotes.length === 0 ||
    releaseNotes.length > 2_000 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(releaseNotes)
  ) {
    throw new Error("Desktop update release notes are invalid");
  }
  const document = {
    schema_version: 1,
    key_id: DESKTOP_UPDATE_KEY_ID,
    channel: DESKTOP_UPDATE_CHANNEL,
    version,
    published_at: requiredTimestamp(options.publishedAt),
    release_notes: releaseNotes,
    artifacts,
  };
  validateDesktopUpdateManifest(document, { version, baseUrl });
  return document;
}

export function validateDesktopUpdateManifest(document, { version, baseUrl }) {
  exactObject(document, MANIFEST_FIELDS, "Desktop update manifest");
  if (
    document.schema_version !== 1 ||
    document.key_id !== DESKTOP_UPDATE_KEY_ID ||
    document.channel !== DESKTOP_UPDATE_CHANNEL ||
    document.version !== requiredVersion(version)
  ) {
    throw new Error("Desktop update manifest identity is invalid");
  }
  requiredTimestamp(document.published_at);
  if (
    typeof document.release_notes !== "string" ||
    document.release_notes.length === 0 ||
    document.release_notes.length > 2_000
  ) {
    throw new Error("Desktop update release notes are invalid");
  }
  const reviewedBaseUrl = requiredBaseUrl(baseUrl);
  const specifications = artifactSpecifications(version);
  if (
    !Array.isArray(document.artifacts) ||
    document.artifacts.length !== specifications.length
  ) {
    throw new Error("Desktop update artifacts are incomplete");
  }
  for (const [index, specification] of specifications.entries()) {
    const artifact = exactObject(
      document.artifacts[index],
      ARTIFACT_FIELDS,
      `Desktop update artifact ${index}`,
    );
    if (
      artifact.platform !== specification.platform ||
      artifact.arch !== specification.arch ||
      artifact.kind !== specification.kind ||
      artifact.name !== specification.name ||
      !FILE_NAME_PATTERN.test(artifact.name) ||
      !Number.isSafeInteger(artifact.size) ||
      artifact.size <= 0 ||
      typeof artifact.sha256 !== "string" ||
      !SHA256_PATTERN.test(artifact.sha256) ||
      typeof artifact.sha512 !== "string" ||
      !SHA512_PATTERN.test(artifact.sha512) ||
      artifact.url !==
        `${reviewedBaseUrl}/releases/${version}/${specification.name}`
    ) {
      throw new Error(`Desktop update artifact ${index} is invalid`);
    }
  }
  return document;
}

export function signDesktopUpdateManifest(manifestBytes, privateKeyPem) {
  const signature = sign(
    null,
    manifestBytes,
    loadPrivateKey(privateKeyPem),
  ).toString("base64");
  return {
    schema_version: 1,
    key_id: DESKTOP_UPDATE_KEY_ID,
    algorithm: "Ed25519",
    signature_base64: signature,
  };
}

export async function verifyDesktopUpdateBundle(options) {
  const manifestBytes = await readFile(options.manifest);
  const signatureBytes = await readFile(options.signature);
  let manifest;
  let envelope;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
    envelope = JSON.parse(signatureBytes.toString("utf8"));
  } catch {
    throw new Error("Desktop update metadata JSON is invalid");
  }
  if (
    canonicalDesktopUpdateJSONStringify(manifest) !==
    manifestBytes.toString("utf8")
  ) {
    throw new Error("Desktop update manifest is not canonical JSON");
  }
  if (
    canonicalDesktopUpdateJSONStringify(envelope) !==
    signatureBytes.toString("utf8")
  ) {
    throw new Error("Desktop update signature is not canonical JSON");
  }
  exactObject(envelope, SIGNATURE_FIELDS, "Desktop update signature");
  if (
    envelope.schema_version !== 1 ||
    envelope.key_id !== DESKTOP_UPDATE_KEY_ID ||
    envelope.algorithm !== "Ed25519" ||
    typeof envelope.signature_base64 !== "string"
  ) {
    throw new Error("Desktop update signature envelope is invalid");
  }
  const publicKeyPem = await readFile(options.publicKey, "utf8");
  if (
    !verify(
      null,
      manifestBytes,
      loadPublicKey(publicKeyPem),
      Buffer.from(envelope.signature_base64, "base64"),
    )
  ) {
    throw new Error("Desktop update manifest signature is invalid");
  }
  validateDesktopUpdateManifest(manifest, {
    version: options.version,
    baseUrl: options.baseUrl,
  });
  for (const artifact of manifest.artifacts) {
    const path = join(options.artifactsDirectory, artifact.name);
    const info = await stat(path);
    if (!info.isFile()) {
      throw new Error(
        `Desktop update artifact is not a file: ${artifact.name}`,
      );
    }
    const digest = await hashArtifact(path);
    if (
      digest.size !== artifact.size ||
      digest.sha256 !== artifact.sha256 ||
      digest.sha512 !== artifact.sha512
    ) {
      throw new Error(`Desktop update artifact differs: ${artifact.name}`);
    }
  }
  return manifest;
}

function parseOptions(arguments_) {
  if (arguments_.length === 0 || arguments_.length % 2 !== 0) {
    throw new Error("Desktop update options must be flag/value pairs");
  }
  const options = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error("Desktop update options must be flag/value pairs");
    }
    const key = flag.slice(2).replaceAll("-", "_");
    if (Object.hasOwn(options, key)) {
      throw new Error(`Duplicate option: ${flag}`);
    }
    options[key] = value;
  }
  return options;
}

async function writeNewFile(path, contents) {
  await mkdir(dirname(resolve(path)), { recursive: true, mode: 0o700 });
  await writeFile(path, contents, { flag: "wx", mode: 0o600 });
}

async function runCli(arguments_) {
  const [command, ...rest] = arguments_;
  const values = parseOptions(rest);
  if (command === "build") {
    const privateKeyPem = process.env[values.private_key_env];
    if (!privateKeyPem) {
      throw new Error("Desktop update signing private key is unavailable");
    }
    const manifest = await buildDesktopUpdateManifest({
      artifactsDirectory: values.artifacts_dir,
      baseUrl: values.base_url,
      publishedAt: values.published_at,
      releaseNotes: values.release_notes,
      version: values.version,
    });
    const manifestBytes = Buffer.from(
      canonicalDesktopUpdateJSONStringify(manifest),
    );
    const envelope = signDesktopUpdateManifest(manifestBytes, privateKeyPem);
    await writeNewFile(values.manifest, manifestBytes);
    await writeNewFile(
      values.signature,
      canonicalDesktopUpdateJSONStringify(envelope),
    );
    return;
  }
  if (command === "verify") {
    await verifyDesktopUpdateBundle({
      artifactsDirectory: values.artifacts_dir,
      baseUrl: values.base_url,
      manifest: values.manifest,
      publicKey: values.public_key,
      signature: values.signature,
      version: values.version,
    });
    return;
  }
  throw new Error("usage: desktop-update.mjs build|verify --flag value ...");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  runCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `Desktop update metadata failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  });
}
