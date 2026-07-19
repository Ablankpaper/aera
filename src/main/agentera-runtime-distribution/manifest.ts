import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, posix } from "node:path";
import { TextDecoder } from "node:util";

export type RuntimeReleaseChannel = "candidate" | "stable";
export type RuntimePlatform = "darwin" | "windows";
export type RuntimeArchitecture = "arm64" | "x64";
export type RuntimeInventoryKind = "file" | "directory" | "symlink";

export const RUNTIME_MANIFEST_METADATA_NAME = ".agentera-runtime-manifest.json";
export const RUNTIME_SIGNATURE_METADATA_NAME = ".agentera-runtime-manifest.sig";

export interface RuntimeManifestEntrypoints extends Record<string, unknown> {
  python: string;
  hermes: string;
  module: "hermes_cli.main";
}

export interface RuntimeManifestFile extends Record<string, unknown> {
  path: string;
  kind: RuntimeInventoryKind;
  size: number;
  sha256: string | null;
  mode: number;
  link_target: string | null;
}

export interface RuntimeManifest extends Record<string, unknown> {
  schema_version: 1;
  key_id: string;
  runtime_version: string;
  source_repository: string;
  source_commit: string;
  channel: RuntimeReleaseChannel;
  platform: RuntimePlatform;
  arch: RuntimeArchitecture;
  archive_name: string;
  archive_size: number;
  archive_sha256: string;
  python_version: string;
  entrypoints: RuntimeManifestEntrypoints;
  minimum_desktop_version: string;
  compatibility_gate_revision: number;
  created_at: string;
  files: RuntimeManifestFile[];
}

export interface RuntimeManifestValidationContext {
  repository: string;
  platform: RuntimePlatform;
  arch: RuntimeArchitecture;
  desktopVersion: string;
  allowedChannels: ReadonlySet<RuntimeReleaseChannel>;
}

export class RuntimeProtocolError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RuntimeProtocolError";
  }
}

export class RuntimeSignatureVerificationError extends RuntimeProtocolError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RuntimeSignatureVerificationError";
  }
}

export class UnknownRuntimeSigningKeyError extends RuntimeSignatureVerificationError {
  constructor(keyId: string) {
    super(`unknown Runtime signing key: ${keyId}`);
    this.name = "UnknownRuntimeSigningKeyError";
  }
}

export class RuntimeArchiveVerificationError extends RuntimeProtocolError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RuntimeArchiveVerificationError";
  }
}

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
] as const;

const SIGNATURE_FIELDS = [
  "schema_version",
  "key_id",
  "algorithm",
  "signature_base64",
] as const;

const ENTRYPOINT_FIELDS = ["python", "hermes", "module"] as const;
const INVENTORY_FIELDS = [
  "path",
  "kind",
  "size",
  "sha256",
  "mode",
  "link_target",
] as const;

const SUPPORTED_CHANNELS = new Set<RuntimeReleaseChannel>([
  "candidate",
  "stable",
]);
const SUPPORTED_TARGETS = new Set(["darwin-arm64", "windows-x64"]);
const KEY_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const VERSION_LABEL_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SOURCE_COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const PYTHON_VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const ARCHIVE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const DESKTOP_VERSION_PATTERN =
  /^(\d+(?:\.\d+)*)(?:-([0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*))?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;
const CREATED_AT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?Z$/;

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasUnpairedSurrogate(value: string): boolean {
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

function normalizeCanonicalJson(value: unknown, label: string): unknown {
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
      normalizeCanonicalJson(item, `${label}[${index}]`),
    );
  }
  if (isJsonObject(value)) {
    const normalized: JsonObject = Object.create(null) as JsonObject;
    for (const key of Object.keys(value).sort()) {
      if (
        !Array.from(key).every((character) => character.charCodeAt(0) <= 0x7f)
      ) {
        throw new RuntimeProtocolError("JSON object keys must be ASCII");
      }
      normalized[key] = normalizeCanonicalJson(value[key], `${label}.${key}`);
    }
    return normalized;
  }
  throw new RuntimeProtocolError(`${label} is not canonical JSON data`);
}

export function canonicalJsonBytes(value: unknown): Buffer {
  if (!isJsonObject(value)) {
    throw new RuntimeProtocolError("canonical JSON root must be an object");
  }
  return Buffer.from(
    JSON.stringify(normalizeCanonicalJson(value, "JSON value")),
    "utf8",
  );
}

class StrictJsonParser {
  private index = 0;

  constructor(private readonly source: string) {}

  parse(): unknown {
    this.skipWhitespace();
    const value = this.parseValue();
    this.skipWhitespace();
    if (this.index !== this.source.length)
      this.fail("unexpected trailing data");
    return value;
  }

  private parseValue(): unknown {
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

  private parseObject(): JsonObject {
    this.index += 1;
    const value: JsonObject = Object.create(null) as JsonObject;
    const keys = new Set<string>();
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

  private parseArray(): unknown[] {
    this.index += 1;
    const value: unknown[] = [];
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

  private parseString(): string {
    const start = this.index;
    this.index += 1;
    let escaped = false;
    while (this.index < this.source.length) {
      const token = this.source[this.index];
      if (!escaped && token === '"') {
        this.index += 1;
        try {
          return JSON.parse(this.source.slice(start, this.index)) as string;
        } catch (error) {
          throw new RuntimeProtocolError("invalid JSON string", {
            cause: error,
          });
        }
      }
      if (!escaped && token === "\\") {
        escaped = true;
      } else {
        escaped = false;
      }
      this.index += 1;
    }
    this.fail("unterminated JSON string");
  }

  private parseNumber(): number {
    const remainder = this.source.slice(this.index);
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(
      remainder,
    );
    if (!match) this.fail("invalid JSON number");
    this.index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) this.fail("non-finite JSON number");
    return value;
  }

  private parseLiteral<T>(token: string, value: T): T {
    if (!this.source.startsWith(token, this.index))
      this.fail("invalid literal");
    this.index += token.length;
    return value;
  }

  private skipWhitespace(): void {
    while (/\s/.test(this.source[this.index] ?? "")) this.index += 1;
  }

  private consume(token: string): boolean {
    if (this.source[this.index] !== token) return false;
    this.index += 1;
    return true;
  }

  private fail(message: string): never {
    throw new RuntimeProtocolError(`${message} at JSON offset ${this.index}`);
  }
}

/** @internal Shared with the production trust-document parser. */
export function parseJsonObjectRejectDuplicates(
  raw: Buffer,
  label: string,
): JsonObject {
  if (!Buffer.isBuffer(raw)) {
    throw new RuntimeProtocolError(`${label} must be bytes`);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch (error) {
    throw new RuntimeProtocolError(`${label} is not valid UTF-8`, {
      cause: error,
    });
  }
  let value: unknown;
  try {
    value = new StrictJsonParser(text).parse();
  } catch (error) {
    if (error instanceof RuntimeProtocolError) throw error;
    throw new RuntimeProtocolError(`${label} is not valid JSON`, {
      cause: error,
    });
  }
  if (!isJsonObject(value)) {
    throw new RuntimeProtocolError(`${label} root must be an object`);
  }
  return value;
}

/** @internal Shared with the production trust-document parser. */
export function requireExactObjectFields(
  value: JsonObject,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value);
  const missing = expected.filter((field) => !actual.includes(field));
  const extra = actual.filter((field) => !expected.includes(field));
  if (missing.length > 0 || extra.length > 0) {
    throw new RuntimeProtocolError(
      `${label} fields differ: missing=${missing.sort().join(",")}, extra=${extra.sort().join(",")}`,
    );
  }
}

function requireString(value: JsonObject, field: string): string {
  const item = value[field];
  if (typeof item !== "string" || item.length === 0) {
    throw new RuntimeProtocolError(`${field} must be a non-empty string`);
  }
  if (hasUnpairedSurrogate(item)) {
    throw new RuntimeProtocolError(`${field} contains invalid Unicode`);
  }
  return item;
}

function requireInteger(
  value: JsonObject,
  field: string,
  minimum: number,
): number {
  const item = value[field];
  if (!Number.isSafeInteger(item) || (item as number) < minimum) {
    throw new RuntimeProtocolError(
      `${field} must be a safe integer >= ${minimum}`,
    );
  }
  return item as number;
}

/** @internal Shared with the production trust-document parser. */
export function validateRuntimeKeyId(keyId: string): void {
  if (!KEY_ID_PATTERN.test(keyId)) {
    throw new RuntimeProtocolError("invalid Runtime signing key id");
  }
}

function validateRelativePosixPath(value: string, label: string): void {
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

function validateSymlinkTarget(
  filePath: string,
  target: string,
  label: string,
): void {
  if (
    target.startsWith("/") ||
    target.includes("\\") ||
    target.includes("\0")
  ) {
    throw new RuntimeProtocolError(`${label} must be a relative POSIX path`);
  }
  const resolved = posix.normalize(posix.join(posix.dirname(filePath), target));
  if (
    resolved === ".." ||
    resolved.startsWith("../") ||
    resolved.startsWith("/")
  ) {
    throw new RuntimeProtocolError(`${label} escapes the Runtime root`);
  }
}

function compareCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (item) => item.codePointAt(0) ?? 0);
  const rightPoints = Array.from(right, (item) => item.codePointAt(0) ?? 0);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    if (leftPoints[index] !== rightPoints[index]) {
      return leftPoints[index] < rightPoints[index] ? -1 : 1;
    }
  }
  return leftPoints.length - rightPoints.length;
}

function validateInventoryEntry(value: unknown, index: number): string {
  const label = `files[${index}]`;
  if (!isJsonObject(value)) {
    throw new RuntimeProtocolError(`${label} must be an object`);
  }
  requireExactObjectFields(value, INVENTORY_FIELDS, label);
  const filePath = requireString(value, "path");
  validateRelativePosixPath(filePath, `${label}.path`);
  const kind = requireString(value, "kind");
  if (kind !== "file" && kind !== "directory" && kind !== "symlink") {
    throw new RuntimeProtocolError(`${label}.kind is invalid`);
  }
  const size = requireInteger(value, "size", 0);
  const mode = requireInteger(value, "mode", 0);
  if (mode > 0o7777) {
    throw new RuntimeProtocolError(`${label}.mode is out of range`);
  }
  const sha256 = value.sha256;
  const linkTarget = value.link_target;
  if (kind === "file") {
    if (typeof sha256 !== "string" || !SHA256_PATTERN.test(sha256)) {
      throw new RuntimeProtocolError(`${label}.sha256 is invalid`);
    }
    if (linkTarget !== null) {
      throw new RuntimeProtocolError(
        `${label}.link_target must be null for a file`,
      );
    }
  } else if (kind === "directory") {
    if (size !== 0 || sha256 !== null || linkTarget !== null) {
      throw new RuntimeProtocolError(`${label} has invalid directory metadata`);
    }
  } else {
    if (
      sha256 !== null ||
      typeof linkTarget !== "string" ||
      linkTarget.length === 0
    ) {
      throw new RuntimeProtocolError(`${label} has invalid symlink metadata`);
    }
    validateSymlinkTarget(filePath, linkTarget, `${label}.link_target`);
  }
  return filePath;
}

function validateArchiveName(
  value: string,
  platform: RuntimePlatform,
  arch: RuntimeArchitecture,
): void {
  if (
    !ARCHIVE_NAME_PATTERN.test(value) ||
    value === "." ||
    value === ".." ||
    !value.startsWith("agentera-runtime-")
  ) {
    throw new RuntimeProtocolError(
      "archive_name must be a plain AgentEra file name",
    );
  }
  const extension = platform === "darwin" ? ".tar.zst" : ".zip";
  if (!value.endsWith(`-${platform}-${arch}${extension}`)) {
    throw new RuntimeProtocolError(
      "archive_name does not match the Runtime target",
    );
  }
}

interface ParsedDesktopVersion {
  release: bigint[];
  prerelease: Array<bigint | string> | null;
}

function parseDesktopVersion(
  value: string,
  label: string,
): ParsedDesktopVersion {
  const match = DESKTOP_VERSION_PATTERN.exec(value);
  if (!match) {
    throw new RuntimeProtocolError(`${label} is not a valid version`);
  }
  const release = match[1].split(".").map((part) => BigInt(part));
  const prerelease = match[2]
    ? match[2]
        .split(/[.-]/)
        .map((part) => (/^\d+$/.test(part) ? BigInt(part) : part.toLowerCase()))
    : null;
  return { release, prerelease };
}

function compareDesktopVersions(
  left: ParsedDesktopVersion,
  right: ParsedDesktopVersion,
): number {
  const releaseLength = Math.max(left.release.length, right.release.length);
  for (let index = 0; index < releaseLength; index += 1) {
    const leftPart = left.release[index] ?? 0n;
    const rightPart = right.release[index] ?? 0n;
    if (leftPart !== rightPart) return leftPart < rightPart ? -1 : 1;
  }
  if (left.prerelease === null && right.prerelease === null) return 0;
  if (left.prerelease === null) return 1;
  if (right.prerelease === null) return -1;
  const prereleaseLength = Math.max(
    left.prerelease.length,
    right.prerelease.length,
  );
  for (let index = 0; index < prereleaseLength; index += 1) {
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

function validateCreatedAt(value: string): void {
  const match = CREATED_AT_PATTERN.exec(value);
  if (!match) {
    throw new RuntimeProtocolError("created_at must be RFC3339 UTC");
  }
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

function validateManifestShape(
  value: JsonObject,
): asserts value is RuntimeManifest {
  requireExactObjectFields(value, MANIFEST_FIELDS, "manifest");
  if (requireInteger(value, "schema_version", 1) !== 1) {
    throw new RuntimeProtocolError("unsupported manifest schema_version");
  }
  const keyId = requireString(value, "key_id");
  validateRuntimeKeyId(keyId);
  const runtimeVersion = requireString(value, "runtime_version");
  if (!VERSION_LABEL_PATTERN.test(runtimeVersion)) {
    throw new RuntimeProtocolError("invalid runtime_version");
  }
  const repository = requireString(value, "source_repository");
  if (!REPOSITORY_PATTERN.test(repository)) {
    throw new RuntimeProtocolError("source_repository must be owner/name");
  }
  if (!SOURCE_COMMIT_PATTERN.test(requireString(value, "source_commit"))) {
    throw new RuntimeProtocolError(
      "source_commit must be a full lowercase Git SHA",
    );
  }
  const channel = requireString(value, "channel");
  if (!SUPPORTED_CHANNELS.has(channel as RuntimeReleaseChannel)) {
    throw new RuntimeProtocolError("unknown Runtime release channel");
  }
  const platform = requireString(value, "platform") as RuntimePlatform;
  const arch = requireString(value, "arch") as RuntimeArchitecture;
  if (!SUPPORTED_TARGETS.has(`${platform}-${arch}`)) {
    throw new RuntimeProtocolError("unsupported Runtime platform/architecture");
  }
  validateArchiveName(requireString(value, "archive_name"), platform, arch);
  requireInteger(value, "archive_size", 1);
  if (!SHA256_PATTERN.test(requireString(value, "archive_sha256"))) {
    throw new RuntimeProtocolError(
      "archive_sha256 must be a lowercase SHA-256",
    );
  }
  if (!PYTHON_VERSION_PATTERN.test(requireString(value, "python_version"))) {
    throw new RuntimeProtocolError(
      "python_version must contain major.minor.patch",
    );
  }
  parseDesktopVersion(
    requireString(value, "minimum_desktop_version"),
    "minimum_desktop_version",
  );
  requireInteger(value, "compatibility_gate_revision", 1);
  validateCreatedAt(requireString(value, "created_at"));

  if (!isJsonObject(value.entrypoints)) {
    throw new RuntimeProtocolError("entrypoints must be an object");
  }
  requireExactObjectFields(value.entrypoints, ENTRYPOINT_FIELDS, "entrypoints");
  const pythonEntrypoint = requireString(value.entrypoints, "python");
  const hermesEntrypoint = requireString(value.entrypoints, "hermes");
  validateRelativePosixPath(pythonEntrypoint, "entrypoints.python");
  validateRelativePosixPath(hermesEntrypoint, "entrypoints.hermes");
  if (value.entrypoints.module !== "hermes_cli.main") {
    throw new RuntimeProtocolError(
      "entrypoints.module must be hermes_cli.main",
    );
  }

  if (!Array.isArray(value.files) || value.files.length === 0) {
    throw new RuntimeProtocolError("files must be a non-empty array");
  }
  const paths = value.files.map(validateInventoryEntry);
  const sortedPaths = [...paths].sort(compareCodePoints);
  if (paths.some((item, index) => item !== sortedPaths[index])) {
    throw new RuntimeProtocolError("files inventory must be sorted by path");
  }
  const comparablePaths =
    platform === "windows"
      ? paths.map((item) => item.normalize("NFKC").toLocaleLowerCase("en-US"))
      : paths;
  if (new Set(comparablePaths).size !== comparablePaths.length) {
    throw new RuntimeProtocolError("files inventory contains duplicate paths");
  }
  if (!paths.includes(pythonEntrypoint) || !paths.includes(hermesEntrypoint)) {
    throw new RuntimeProtocolError(
      "entrypoints must exist in the files inventory",
    );
  }
}

export function parseRuntimeManifest(raw: Buffer): RuntimeManifest {
  const value = parseJsonObjectRejectDuplicates(raw, "manifest");
  if (!canonicalJsonBytes(value).equals(raw)) {
    throw new RuntimeProtocolError("manifest bytes are not canonical JSON");
  }
  validateManifestShape(value);
  return value;
}

interface RuntimeSignatureEnvelope extends Record<string, unknown> {
  schema_version: 1;
  key_id: string;
  algorithm: "Ed25519";
  signature_base64: string;
}

function parseSignatureEnvelope(raw: Buffer): RuntimeSignatureEnvelope {
  const value = parseJsonObjectRejectDuplicates(raw, "signature envelope");
  if (!canonicalJsonBytes(value).equals(raw)) {
    throw new RuntimeProtocolError(
      "signature envelope bytes are not canonical JSON",
    );
  }
  requireExactObjectFields(value, SIGNATURE_FIELDS, "signature envelope");
  if (requireInteger(value, "schema_version", 1) !== 1) {
    throw new RuntimeProtocolError("unsupported signature schema_version");
  }
  validateRuntimeKeyId(requireString(value, "key_id"));
  if (value.algorithm !== "Ed25519") {
    throw new RuntimeProtocolError("unsupported signature algorithm");
  }
  const signatureText = requireString(value, "signature_base64");
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
  return value as RuntimeSignatureEnvelope;
}

function validateManifestContext(
  manifest: RuntimeManifest,
  context: RuntimeManifestValidationContext,
): void {
  if (!REPOSITORY_PATTERN.test(context.repository)) {
    throw new RuntimeProtocolError("validation repository must be owner/name");
  }
  if (!SUPPORTED_TARGETS.has(`${context.platform}-${context.arch}`)) {
    throw new RuntimeProtocolError("unsupported Runtime validation target");
  }
  if (context.allowedChannels.size === 0) {
    throw new RuntimeProtocolError("allowedChannels must not be empty");
  }
  for (const channel of context.allowedChannels) {
    if (!SUPPORTED_CHANNELS.has(channel)) {
      throw new RuntimeProtocolError(
        "allowedChannels contains an unknown channel",
      );
    }
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
  if (!context.allowedChannels.has(manifest.channel)) {
    throw new RuntimeProtocolError("manifest channel is not allowed");
  }
  const desktop = parseDesktopVersion(context.desktopVersion, "desktopVersion");
  const minimum = parseDesktopVersion(
    manifest.minimum_desktop_version,
    "minimum_desktop_version",
  );
  if (compareDesktopVersions(desktop, minimum) < 0) {
    throw new RuntimeProtocolError(
      "desktop version is below the manifest minimum",
    );
  }
}

export interface VerifyRuntimeManifestOptions {
  manifestBytes: Buffer;
  signatureBytes: Buffer;
  trustedPublicKeys: ReadonlyMap<string, string>;
  context: RuntimeManifestValidationContext;
}

// @lat: [[agentera-runtime-distribution#Release gate]]
export function verifyRuntimeManifestSignature({
  manifestBytes,
  signatureBytes,
  trustedPublicKeys,
  context,
}: VerifyRuntimeManifestOptions): RuntimeManifest {
  const manifest = parseRuntimeManifest(manifestBytes);
  const envelope = parseSignatureEnvelope(signatureBytes);
  const publicKeyPem = trustedPublicKeys.get(envelope.key_id);
  if (publicKeyPem === undefined) {
    throw new UnknownRuntimeSigningKeyError(envelope.key_id);
  }
  if (manifest.key_id !== envelope.key_id) {
    throw new RuntimeSignatureVerificationError(
      "manifest and signature key ids differ",
    );
  }
  let publicKey: ReturnType<typeof createPublicKey>;
  try {
    publicKey = createPublicKey(publicKeyPem);
  } catch (error) {
    throw new RuntimeSignatureVerificationError(
      "trusted Runtime public key is invalid",
      { cause: error },
    );
  }
  if (publicKey.asymmetricKeyType !== "ed25519") {
    throw new RuntimeSignatureVerificationError(
      "trusted Runtime public key is not Ed25519",
    );
  }
  const signature = Buffer.from(envelope.signature_base64, "base64");
  if (!verifySignature(null, manifestBytes, publicKey, signature)) {
    throw new RuntimeSignatureVerificationError(
      "manifest signature is invalid",
    );
  }
  validateManifestContext(manifest, context);
  return manifest;
}

export interface VerifyRuntimeArtifactOptions extends VerifyRuntimeManifestOptions {
  archivePath: string;
}

export async function verifyRuntimeArtifact({
  archivePath,
  ...manifestOptions
}: VerifyRuntimeArtifactOptions): Promise<RuntimeManifest> {
  const manifest = verifyRuntimeManifestSignature(manifestOptions);
  if (basename(archivePath) !== manifest.archive_name) {
    throw new RuntimeArchiveVerificationError(
      "Runtime archive name differs from the signed manifest",
    );
  }
  let archiveStat;
  try {
    archiveStat = await stat(archivePath);
  } catch (error) {
    throw new RuntimeArchiveVerificationError(
      "cannot inspect Runtime archive",
      { cause: error },
    );
  }
  if (!archiveStat.isFile()) {
    throw new RuntimeArchiveVerificationError("Runtime archive is not a file");
  }
  if (archiveStat.size !== manifest.archive_size) {
    throw new RuntimeArchiveVerificationError(
      "Runtime archive size differs from the signed manifest",
    );
  }
  const digest = createHash("sha256");
  let bytesRead = 0;
  try {
    for await (const chunk of createReadStream(archivePath)) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytesRead += bytes.length;
      digest.update(bytes);
    }
  } catch (error) {
    throw new RuntimeArchiveVerificationError("cannot read Runtime archive", {
      cause: error,
    });
  }
  if (bytesRead !== manifest.archive_size) {
    throw new RuntimeArchiveVerificationError(
      "Runtime archive size changed during verification",
    );
  }
  if (digest.digest("hex") !== manifest.archive_sha256) {
    throw new RuntimeArchiveVerificationError(
      "Runtime archive hash differs from the signed manifest",
    );
  }
  return manifest;
}
