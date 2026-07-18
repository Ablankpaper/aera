#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */

import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";

const MANIFEST_FIELDS = [
  "schema_version",
  "key_id",
  "runtime_version",
  "source_repository",
  "source_commit",
  "channel",
  "platform",
  "arch",
  "archive_name",
  "archive_size",
  "archive_sha256",
  "python_version",
  "entrypoints",
  "minimum_desktop_version",
  "compatibility_gate_revision",
  "created_at",
  "files",
];
const SIGNATURE_FIELDS = [
  "schema_version",
  "key_id",
  "algorithm",
  "signature_base64",
];
const ENTRYPOINT_FIELDS = ["python", "hermes", "module"];
const INVENTORY_FIELDS = [
  "path",
  "kind",
  "size",
  "sha256",
  "mode",
  "link_target",
];
const TRUST_FIELDS = ["schema_version", "keys"];
const TRUST_KEY_FIELDS = ["key_id", "algorithm", "public_key_pem"];
const CHANNELS = new Set(["candidate", "stable"]);
const TARGETS = new Set(["darwin-arm64", "windows-x64"]);
const KEY_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const VERSION_LABEL_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const PYTHON_VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const ARCHIVE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const VERSION_PATTERN =
  /^(\d+(?:\.\d+)*)(?:-([0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*))?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;
const CREATED_AT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?Z$/;

class RuntimeProtocolError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "RuntimeProtocolError";
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasPublicKeyPemEnvelope(value) {
  const lines = value.replaceAll("\r\n", "\n").trimEnd().split("\n");
  return (
    lines.length >= 3 &&
    lines[0] === "-----BEGIN PUBLIC KEY-----" &&
    lines.at(-1) === "-----END PUBLIC KEY-----" &&
    lines.slice(1, -1).every((line) => /^[A-Za-z0-9+/]+={0,2}$/.test(line))
  );
}

function hasUnpairedSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function canonicalValue(value, label) {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (hasUnpairedSurrogate(value)) {
      throw new RuntimeProtocolError(`${label} contains invalid Unicode`);
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new RuntimeProtocolError(`${label} contains a non-finite number`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      canonicalValue(item, `${label}[${index}]`),
    );
  }
  if (isObject(value)) {
    const normalized = Object.create(null);
    for (const key of Object.keys(value).sort()) {
      if (
        !Array.from(key).every((character) => character.charCodeAt(0) <= 0x7f)
      ) {
        throw new RuntimeProtocolError("JSON object keys must be ASCII");
      }
      normalized[key] = canonicalValue(value[key], `${label}.${key}`);
    }
    return normalized;
  }
  throw new RuntimeProtocolError(`${label} is not canonical JSON data`);
}

function canonicalBytes(value) {
  if (!isObject(value)) {
    throw new RuntimeProtocolError("canonical JSON root must be an object");
  }
  return Buffer.from(
    JSON.stringify(canonicalValue(value, "JSON value")),
    "utf8",
  );
}

class StrictJsonParser {
  index = 0;

  constructor(source) {
    this.source = source;
  }

  parse() {
    this.skipWhitespace();
    const value = this.parseValue();
    this.skipWhitespace();
    if (this.index !== this.source.length)
      this.fail("unexpected trailing data");
    return value;
  }

  parseValue() {
    const token = this.source[this.index];
    if (token === "{") return this.parseObject();
    if (token === "[") return this.parseArray();
    if (token === '"') return this.parseString();
    if (token === "t") return this.parseLiteral("true", true);
    if (token === "f") return this.parseLiteral("false", false);
    if (token === "n") return this.parseLiteral("null", null);
    if (token === "-" || (token >= "0" && token <= "9")) {
      return this.parseNumber();
    }
    this.fail("unexpected token");
  }

  parseObject() {
    this.index += 1;
    const value = Object.create(null);
    const keys = new Set();
    this.skipWhitespace();
    if (this.consume("}")) return value;
    while (true) {
      this.skipWhitespace();
      if (this.source[this.index] !== '"')
        this.fail("object key must be a string");
      const key = this.parseString();
      if (keys.has(key)) {
        throw new RuntimeProtocolError(`duplicate JSON object key: ${key}`);
      }
      keys.add(key);
      this.skipWhitespace();
      if (!this.consume(":")) this.fail("missing colon after object key");
      this.skipWhitespace();
      value[key] = this.parseValue();
      this.skipWhitespace();
      if (this.consume("}")) return value;
      if (!this.consume(",")) this.fail("missing comma between object fields");
    }
  }

  parseArray() {
    this.index += 1;
    const value = [];
    this.skipWhitespace();
    if (this.consume("]")) return value;
    while (true) {
      this.skipWhitespace();
      value.push(this.parseValue());
      this.skipWhitespace();
      if (this.consume("]")) return value;
      if (!this.consume(",")) this.fail("missing comma between array items");
    }
  }

  parseString() {
    const start = this.index;
    this.index += 1;
    let escaped = false;
    while (this.index < this.source.length) {
      const token = this.source[this.index];
      if (!escaped && token === '"') {
        this.index += 1;
        try {
          return JSON.parse(this.source.slice(start, this.index));
        } catch (error) {
          throw new RuntimeProtocolError("invalid JSON string", {
            cause: error,
          });
        }
      }
      if (!escaped && token === "\\") escaped = true;
      else escaped = false;
      this.index += 1;
    }
    this.fail("unterminated JSON string");
  }

  parseNumber() {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(
      this.source.slice(this.index),
    );
    if (!match) this.fail("invalid JSON number");
    this.index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) this.fail("non-finite JSON number");
    return value;
  }

  parseLiteral(token, value) {
    if (!this.source.startsWith(token, this.index))
      this.fail("invalid literal");
    this.index += token.length;
    return value;
  }

  skipWhitespace() {
    while (/\s/.test(this.source[this.index] ?? "")) this.index += 1;
  }

  consume(token) {
    if (this.source[this.index] !== token) return false;
    this.index += 1;
    return true;
  }

  fail(message) {
    throw new RuntimeProtocolError(`${message} at JSON offset ${this.index}`);
  }
}

function parseJsonObject(raw, label) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch (error) {
    throw new RuntimeProtocolError(`${label} is not valid UTF-8`, {
      cause: error,
    });
  }
  const value = new StrictJsonParser(text).parse();
  if (!isObject(value)) {
    throw new RuntimeProtocolError(`${label} root must be an object`);
  }
  return value;
}

function parseCanonicalObject(raw, label) {
  const value = parseJsonObject(raw, label);
  if (!canonicalBytes(value).equals(raw)) {
    throw new RuntimeProtocolError(`${label} bytes are not canonical JSON`);
  }
  return value;
}

function exactFields(value, expected, label) {
  const actual = Object.keys(value);
  const missing = expected.filter((field) => !actual.includes(field));
  const extra = actual.filter((field) => !expected.includes(field));
  if (missing.length > 0 || extra.length > 0) {
    throw new RuntimeProtocolError(
      `${label} fields differ: missing=${missing.sort().join(",")}, extra=${extra.sort().join(",")}`,
    );
  }
}

function requiredString(value, field) {
  const item = value[field];
  if (typeof item !== "string" || item.length === 0) {
    throw new RuntimeProtocolError(`${field} must be a non-empty string`);
  }
  return item;
}

function requiredInteger(value, field, minimum) {
  const item = value[field];
  if (!Number.isSafeInteger(item) || item < minimum) {
    throw new RuntimeProtocolError(
      `${field} must be a safe integer >= ${minimum}`,
    );
  }
  return item;
}

function validateKeyId(value) {
  if (!KEY_ID_PATTERN.test(value)) {
    throw new RuntimeProtocolError("invalid Runtime signing key id");
  }
}

function validateRelativePath(value, label) {
  if (
    value.length === 0 ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.includes("//") ||
    value
      .split("/")
      .some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new RuntimeProtocolError(
      `${label} must be a normalized relative POSIX path`,
    );
  }
}

function validateSymlinkTarget(filePath, target, label) {
  if (
    target.startsWith("/") ||
    target.includes("\\") ||
    target.includes("\0")
  ) {
    throw new RuntimeProtocolError(`${label} must be a relative POSIX path`);
  }
  const resolvedTarget = posix.normalize(
    posix.join(posix.dirname(filePath), target),
  );
  if (
    resolvedTarget === ".." ||
    resolvedTarget.startsWith("../") ||
    resolvedTarget.startsWith("/")
  ) {
    throw new RuntimeProtocolError(`${label} escapes the Runtime root`);
  }
}

function compareCodePoints(left, right) {
  const leftPoints = Array.from(left, (item) => item.codePointAt(0));
  const rightPoints = Array.from(right, (item) => item.codePointAt(0));
  for (
    let index = 0;
    index < Math.min(leftPoints.length, rightPoints.length);
    index += 1
  ) {
    if (leftPoints[index] !== rightPoints[index]) {
      return leftPoints[index] < rightPoints[index] ? -1 : 1;
    }
  }
  return leftPoints.length - rightPoints.length;
}

function parseVersion(value, label) {
  const match = VERSION_PATTERN.exec(value);
  if (!match) throw new RuntimeProtocolError(`${label} is not a valid version`);
  return {
    release: match[1].split(".").map((part) => BigInt(part)),
    prerelease: match[2]
      ? match[2]
          .split(/[.-]/)
          .map((part) =>
            /^\d+$/.test(part) ? BigInt(part) : part.toLowerCase(),
          )
      : null,
  };
}

function compareVersions(left, right) {
  const releaseLength = Math.max(left.release.length, right.release.length);
  for (let index = 0; index < releaseLength; index += 1) {
    const leftPart = left.release[index] ?? 0n;
    const rightPart = right.release[index] ?? 0n;
    if (leftPart !== rightPart) return leftPart < rightPart ? -1 : 1;
  }
  if (left.prerelease === null && right.prerelease === null) return 0;
  if (left.prerelease === null) return 1;
  if (right.prerelease === null) return -1;
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    if (typeof leftPart === "bigint" && typeof rightPart === "string")
      return -1;
    if (typeof leftPart === "string" && typeof rightPart === "bigint") return 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

function validateCreatedAt(value) {
  const match = CREATED_AT_PATTERN.exec(value);
  if (!match) throw new RuntimeProtocolError("created_at must be RFC3339 UTC");
  const [, year, month, day, hour, minute, second] = match;
  const parsed = new Date(value);
  if (
    Number.isNaN(parsed.valueOf()) ||
    parsed.getUTCFullYear() !== Number(year) ||
    parsed.getUTCMonth() + 1 !== Number(month) ||
    parsed.getUTCDate() !== Number(day) ||
    parsed.getUTCHours() !== Number(hour) ||
    parsed.getUTCMinutes() !== Number(minute) ||
    parsed.getUTCSeconds() !== Number(second)
  ) {
    throw new RuntimeProtocolError("created_at must be a valid UTC timestamp");
  }
}

function validateInventoryEntry(value, index) {
  const label = `files[${index}]`;
  if (!isObject(value))
    throw new RuntimeProtocolError(`${label} must be an object`);
  exactFields(value, INVENTORY_FIELDS, label);
  const filePath = requiredString(value, "path");
  validateRelativePath(filePath, `${label}.path`);
  const kind = requiredString(value, "kind");
  if (!new Set(["file", "directory", "symlink"]).has(kind)) {
    throw new RuntimeProtocolError(`${label}.kind is invalid`);
  }
  const size = requiredInteger(value, "size", 0);
  const mode = requiredInteger(value, "mode", 0);
  if (mode > 0o7777)
    throw new RuntimeProtocolError(`${label}.mode is out of range`);
  if (kind === "file") {
    if (
      typeof value.sha256 !== "string" ||
      !SHA256_PATTERN.test(value.sha256)
    ) {
      throw new RuntimeProtocolError(`${label}.sha256 is invalid`);
    }
    if (value.link_target !== null) {
      throw new RuntimeProtocolError(
        `${label}.link_target must be null for a file`,
      );
    }
  } else if (kind === "directory") {
    if (size !== 0 || value.sha256 !== null || value.link_target !== null) {
      throw new RuntimeProtocolError(`${label} has invalid directory metadata`);
    }
  } else {
    if (
      value.sha256 !== null ||
      typeof value.link_target !== "string" ||
      value.link_target.length === 0
    ) {
      throw new RuntimeProtocolError(`${label} has invalid symlink metadata`);
    }
    validateSymlinkTarget(filePath, value.link_target, `${label}.link_target`);
  }
  return filePath;
}

function validateManifest(manifest, context) {
  exactFields(manifest, MANIFEST_FIELDS, "manifest");
  if (requiredInteger(manifest, "schema_version", 1) !== 1) {
    throw new RuntimeProtocolError("unsupported manifest schema_version");
  }
  validateKeyId(requiredString(manifest, "key_id"));
  if (
    !VERSION_LABEL_PATTERN.test(requiredString(manifest, "runtime_version"))
  ) {
    throw new RuntimeProtocolError("invalid runtime_version");
  }
  if (!REPOSITORY_PATTERN.test(requiredString(manifest, "source_repository"))) {
    throw new RuntimeProtocolError("source_repository must be owner/name");
  }
  if (!COMMIT_PATTERN.test(requiredString(manifest, "source_commit"))) {
    throw new RuntimeProtocolError(
      "source_commit must be a full lowercase Git SHA",
    );
  }
  const channel = requiredString(manifest, "channel");
  if (!CHANNELS.has(channel)) {
    throw new RuntimeProtocolError("unknown Runtime release channel");
  }
  const platform = requiredString(manifest, "platform");
  const arch = requiredString(manifest, "arch");
  if (!TARGETS.has(`${platform}-${arch}`)) {
    throw new RuntimeProtocolError("unsupported Runtime platform/architecture");
  }
  const archiveName = requiredString(manifest, "archive_name");
  const extension = platform === "darwin" ? ".tar.zst" : ".zip";
  if (
    !ARCHIVE_PATTERN.test(archiveName) ||
    !archiveName.startsWith("agentera-runtime-") ||
    !archiveName.endsWith(`-${platform}-${arch}${extension}`)
  ) {
    throw new RuntimeProtocolError(
      "archive_name does not match the Runtime target",
    );
  }
  requiredInteger(manifest, "archive_size", 1);
  if (!SHA256_PATTERN.test(requiredString(manifest, "archive_sha256"))) {
    throw new RuntimeProtocolError(
      "archive_sha256 must be a lowercase SHA-256",
    );
  }
  if (
    !PYTHON_VERSION_PATTERN.test(requiredString(manifest, "python_version"))
  ) {
    throw new RuntimeProtocolError(
      "python_version must contain major.minor.patch",
    );
  }
  const minimumVersion = parseVersion(
    requiredString(manifest, "minimum_desktop_version"),
    "minimum_desktop_version",
  );
  requiredInteger(manifest, "compatibility_gate_revision", 1);
  validateCreatedAt(requiredString(manifest, "created_at"));

  if (!isObject(manifest.entrypoints)) {
    throw new RuntimeProtocolError("entrypoints must be an object");
  }
  exactFields(manifest.entrypoints, ENTRYPOINT_FIELDS, "entrypoints");
  const pythonEntrypoint = requiredString(manifest.entrypoints, "python");
  const hermesEntrypoint = requiredString(manifest.entrypoints, "hermes");
  validateRelativePath(pythonEntrypoint, "entrypoints.python");
  validateRelativePath(hermesEntrypoint, "entrypoints.hermes");
  if (manifest.entrypoints.module !== "hermes_cli.main") {
    throw new RuntimeProtocolError(
      "entrypoints.module must be hermes_cli.main",
    );
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new RuntimeProtocolError("files must be a non-empty array");
  }
  const paths = manifest.files.map(validateInventoryEntry);
  const sorted = [...paths].sort(compareCodePoints);
  if (paths.some((item, index) => item !== sorted[index])) {
    throw new RuntimeProtocolError("files inventory must be sorted by path");
  }
  const comparable =
    platform === "windows"
      ? paths.map((item) => item.normalize("NFKC").toLocaleLowerCase("en-US"))
      : paths;
  if (new Set(comparable).size !== comparable.length) {
    throw new RuntimeProtocolError("files inventory contains duplicate paths");
  }
  if (!paths.includes(pythonEntrypoint) || !paths.includes(hermesEntrypoint)) {
    throw new RuntimeProtocolError(
      "entrypoints must exist in the files inventory",
    );
  }

  if (!REPOSITORY_PATTERN.test(context.repository)) {
    throw new RuntimeProtocolError("validation repository must be owner/name");
  }
  if (!TARGETS.has(`${context.platform}-${context.arch}`)) {
    throw new RuntimeProtocolError("unsupported Runtime validation target");
  }
  if (!CHANNELS.has(context.channel)) {
    throw new RuntimeProtocolError("unknown validation channel");
  }
  if (manifest.source_repository !== context.repository) {
    throw new RuntimeProtocolError("manifest source repository does not match");
  }
  if (
    manifest.platform !== context.platform ||
    manifest.arch !== context.arch
  ) {
    throw new RuntimeProtocolError("manifest target does not match");
  }
  if (manifest.channel !== context.channel) {
    throw new RuntimeProtocolError("manifest channel is not allowed");
  }
  const desktopVersion = parseVersion(
    context.desktopVersion,
    "desktop version",
  );
  if (compareVersions(desktopVersion, minimumVersion) < 0) {
    throw new RuntimeProtocolError(
      "desktop version is below the manifest minimum",
    );
  }
}

function parseTrust(raw) {
  const document = parseJsonObject(raw, "Runtime trust document");
  exactFields(document, TRUST_FIELDS, "Runtime trust document");
  if (document.schema_version !== 1) {
    throw new RuntimeProtocolError("unsupported Runtime trust schema_version");
  }
  if (!Array.isArray(document.keys) || document.keys.length === 0) {
    throw new RuntimeProtocolError(
      "Runtime trust keys must be a non-empty array",
    );
  }
  const keys = new Map();
  for (const [index, item] of document.keys.entries()) {
    const label = `Runtime trust keys[${index}]`;
    if (!isObject(item))
      throw new RuntimeProtocolError(`${label} must be an object`);
    exactFields(item, TRUST_KEY_FIELDS, label);
    const keyId = requiredString(item, "key_id");
    validateKeyId(keyId);
    if (item.algorithm !== "Ed25519") {
      throw new RuntimeProtocolError(`${label} uses an unsupported algorithm`);
    }
    const publicKeyPem = requiredString(item, "public_key_pem");
    if (!hasPublicKeyPemEnvelope(publicKeyPem)) {
      throw new RuntimeProtocolError(
        `${label}.public_key_pem must contain a public key PEM envelope`,
      );
    }
    if (keys.has(keyId)) {
      throw new RuntimeProtocolError(
        `duplicate Runtime trust key id: ${keyId}`,
      );
    }
    let publicKey;
    try {
      publicKey = createPublicKey(publicKeyPem);
    } catch (error) {
      throw new RuntimeProtocolError(
        `${label} contains an invalid public key`,
        {
          cause: error,
        },
      );
    }
    if (publicKey.asymmetricKeyType !== "ed25519") {
      throw new RuntimeProtocolError(`${label} public key is not Ed25519`);
    }
    keys.set(keyId, publicKey);
  }
  return keys;
}

function verifySignedManifest(manifestBytes, signatureBytes, trust, context) {
  const manifest = parseCanonicalObject(manifestBytes, "manifest");
  const envelope = parseCanonicalObject(signatureBytes, "signature envelope");
  exactFields(envelope, SIGNATURE_FIELDS, "signature envelope");
  if (envelope.schema_version !== 1) {
    throw new RuntimeProtocolError("unsupported signature schema_version");
  }
  const keyId = requiredString(envelope, "key_id");
  validateKeyId(keyId);
  if (envelope.algorithm !== "Ed25519") {
    throw new RuntimeProtocolError("unsupported signature algorithm");
  }
  const signatureText = requiredString(envelope, "signature_base64");
  if (!/^[A-Za-z0-9+/]{86}==$/.test(signatureText)) {
    throw new RuntimeProtocolError("signature_base64 is invalid");
  }
  const signature = Buffer.from(signatureText, "base64");
  if (
    signature.length !== 64 ||
    signature.toString("base64") !== signatureText
  ) {
    throw new RuntimeProtocolError(
      "Ed25519 signature must be exactly 64 bytes",
    );
  }
  const publicKey = trust.get(keyId);
  if (publicKey === undefined) {
    throw new RuntimeProtocolError(`unknown Runtime signing key: ${keyId}`);
  }
  if (manifest.key_id !== keyId) {
    throw new RuntimeProtocolError("manifest and signature key ids differ");
  }
  if (!verifySignature(null, manifestBytes, publicKey, signature)) {
    throw new RuntimeProtocolError("manifest signature is invalid");
  }
  validateManifest(manifest, context);
  return manifest;
}

async function hashArchive(path) {
  const digest = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    size += chunk.length;
    digest.update(chunk);
  }
  return { size, sha256: digest.digest("hex") };
}

export async function verifyRuntimeBundle(options) {
  const manifestBytes = readFileSync(options.manifest);
  const signatureBytes = readFileSync(options.signature);
  const trust = parseTrust(readFileSync(options.trust));
  const manifest = verifySignedManifest(
    manifestBytes,
    signatureBytes,
    trust,
    options,
  );
  if (basename(options.archive) !== manifest.archive_name) {
    throw new RuntimeProtocolError(
      "Runtime archive name differs from the signed manifest",
    );
  }
  const metadata = await stat(options.archive);
  if (!metadata.isFile()) {
    throw new RuntimeProtocolError("Runtime archive is not a file");
  }
  if (metadata.size !== manifest.archive_size) {
    throw new RuntimeProtocolError(
      "Runtime archive size differs from the signed manifest",
    );
  }
  const actual = await hashArchive(options.archive);
  if (actual.size !== manifest.archive_size) {
    throw new RuntimeProtocolError(
      "Runtime archive size changed during verification",
    );
  }
  if (actual.sha256 !== manifest.archive_sha256) {
    throw new RuntimeProtocolError(
      "Runtime archive hash differs from the signed manifest",
    );
  }
  return manifest;
}

function parseArguments(argv) {
  if (argv[0] !== "verify") {
    throw new RuntimeProtocolError(
      "usage: agentera-runtime-protocol.mjs verify [options]",
    );
  }
  const values = Object.create(null);
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new RuntimeProtocolError(
        "Runtime verifier options require flag/value pairs",
      );
    }
    const key = flag.slice(2).replaceAll("-", "_");
    if (Object.hasOwn(values, key)) {
      throw new RuntimeProtocolError(
        `duplicate Runtime verifier option: ${flag}`,
      );
    }
    values[key] = value;
  }
  const required = [
    "manifest",
    "signature",
    "archive",
    "trust",
    "repository",
    "platform",
    "arch",
    "desktop_version",
    "channel",
  ];
  const missing = required.filter((key) => !values[key]);
  if (missing.length > 0) {
    throw new RuntimeProtocolError(
      `missing Runtime verifier options: ${missing.join(", ")}`,
    );
  }
  return {
    manifest: values.manifest,
    signature: values.signature,
    archive: values.archive,
    trust: values.trust,
    repository: values.repository,
    platform: values.platform,
    arch: values.arch,
    desktopVersion: values.desktop_version,
    channel: values.channel,
  };
}

async function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    const manifest = await verifyRuntimeBundle(options);
    process.stdout.write(
      `${JSON.stringify({
        verified: true,
        repository: manifest.source_repository,
        platform: manifest.platform,
        arch: manifest.arch,
        runtimeVersion: manifest.runtime_version,
        sourceCommit: manifest.source_commit,
      })}\n`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`AgentEra Runtime verification failed: ${message}\n`);
    process.exitCode = 1;
  }
}

const isMain =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) await main();
