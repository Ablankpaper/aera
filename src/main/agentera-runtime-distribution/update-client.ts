import { createPublicKey, verify as verifySignature } from "node:crypto";

import {
  RuntimeProtocolError,
  canonicalJsonBytes,
  parseJsonObjectRejectDuplicates,
  requireExactObjectFields,
  validateRuntimeKeyId,
  verifyRuntimeManifestSignature,
  type RuntimeArchitecture,
  type RuntimeManifest,
  type RuntimePlatform,
} from "./manifest";
import { nodeRuntimeFetch, type RuntimeFetch } from "./fetch";

export type RuntimeUpdateErrorCode =
  | "runtime_update_unavailable"
  | "runtime_update_metadata_invalid";

export type RuntimeUpdateUrlKind = "stable-index" | "release-asset";

export interface RuntimeMetadataTransport {
  get(url: URL, signal: AbortSignal): Promise<Buffer>;
}

export interface RuntimeUpdateContext {
  currentVersion: string;
  currentSourceCommit: string | null;
  repository: string;
  platform: RuntimePlatform;
  arch: RuntimeArchitecture;
  desktopVersion: string;
  trustedPublicKeys: ReadonlyMap<string, string>;
  signal: AbortSignal;
  transport?: RuntimeMetadataTransport;
  onCheckError?: (code: RuntimeUpdateErrorCode) => void;
}

export interface RuntimeUpdateOffer {
  runtimeVersion: string;
  sourceCommit: string;
  releaseTag: string;
  archiveName: string;
  archiveSize: number;
  archiveSha256: string;
  archiveUrl: URL;
  manifestUrl: URL;
  signatureUrl: URL;
  manifestBytes: Buffer;
  signatureBytes: Buffer;
}

interface RuntimeChannelIndexTarget extends Record<string, unknown> {
  platform: RuntimePlatform;
  arch: RuntimeArchitecture;
  archive_name: string;
  manifest_name: string;
  signature_name: string;
  archive_sha256: string;
}

interface RuntimeChannelIndex extends Record<string, unknown> {
  schema_version: 1;
  key_id: string;
  channel: "stable";
  runtime_version: string;
  source_repository: string;
  source_commit: string;
  release_tag: string;
  created_at: string;
  targets: RuntimeChannelIndexTarget[];
}

interface SignatureEnvelope extends Record<string, unknown> {
  schema_version: 1;
  key_id: string;
  algorithm: "Ed25519";
  signature_base64: string;
}

const APPROVED_REPOSITORY = "bignormal/aera-runtime";
const GITHUB_ORIGIN = "https://github.com";
const RELEASE_PATH_PREFIX = `/${APPROVED_REPOSITORY}/releases/download/`;
const LATEST_PATH_PREFIX = `/${APPROVED_REPOSITORY}/releases/latest/download/`;
const INDEX_NAME = "agentera-runtime-stable.index.json";
const INDEX_SIGNATURE_NAME = "agentera-runtime-stable.index.sig";
const INDEX_FIELDS = [
  "schema_version",
  "key_id",
  "channel",
  "runtime_version",
  "source_repository",
  "source_commit",
  "release_tag",
  "created_at",
  "targets",
] as const;
const INDEX_TARGET_FIELDS = [
  "platform",
  "arch",
  "archive_name",
  "manifest_name",
  "signature_name",
  "archive_sha256",
] as const;
const SIGNATURE_FIELDS = [
  "schema_version",
  "key_id",
  "algorithm",
  "signature_base64",
] as const;
const SOURCE_COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const VERSION_PATTERN =
  /^(\d+(?:\.\d+)*)(?:-([0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*))?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;
const FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const CREATED_AT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;
const DEFAULT_METADATA_LIMIT = 32 * 1024 * 1024;
const DEFAULT_METADATA_TIMEOUT_MS = 30_000;

export class RuntimeUpdateError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RuntimeUpdateError";
  }
}

export class RuntimeUpdateUrlError extends RuntimeUpdateError {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeUpdateUrlError";
  }
}

export class RuntimeUpdateTransportError extends RuntimeUpdateError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RuntimeUpdateTransportError";
  }
}

export class RuntimeUpdateMetadataError extends RuntimeUpdateError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RuntimeUpdateMetadataError";
  }
}

export class RuntimeUpdateCheckCancelledError extends RuntimeUpdateError {
  constructor() {
    super("Runtime update check was cancelled");
    this.name = "RuntimeUpdateCheckCancelledError";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireString(
  value: Record<string, unknown>,
  field: string,
  label: string,
): string {
  const item = value[field];
  if (typeof item !== "string" || item.length === 0) {
    throw new RuntimeUpdateMetadataError(
      `${label}.${field} must be a non-empty string`,
    );
  }
  return item;
}

function parseVersion(
  value: string,
  label: string,
): {
  release: bigint[];
  prerelease: Array<bigint | string> | null;
} {
  const match = VERSION_PATTERN.exec(value);
  if (!match) {
    throw new RuntimeUpdateMetadataError(`${label} is not a valid version`);
  }
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

export function compareRuntimeVersions(left: string, right: string): number {
  const leftVersion = parseVersion(left, "left Runtime version");
  const rightVersion = parseVersion(right, "right Runtime version");
  const releaseLength = Math.max(
    leftVersion.release.length,
    rightVersion.release.length,
  );
  for (let index = 0; index < releaseLength; index += 1) {
    const leftPart = leftVersion.release[index] ?? 0n;
    const rightPart = rightVersion.release[index] ?? 0n;
    if (leftPart !== rightPart) return leftPart < rightPart ? -1 : 1;
  }
  if (leftVersion.prerelease === null && rightVersion.prerelease === null)
    return 0;
  if (leftVersion.prerelease === null) return 1;
  if (rightVersion.prerelease === null) return -1;
  const length = Math.max(
    leftVersion.prerelease.length,
    rightVersion.prerelease.length,
  );
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftVersion.prerelease[index];
    const rightPart = rightVersion.prerelease[index];
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

export function assertAllowedRuntimeUpdateUrl(
  url: URL,
  kind: RuntimeUpdateUrlKind,
): void {
  if (
    url.origin !== GITHUB_ORIGIN ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    url.pathname.includes("%")
  ) {
    throw new RuntimeUpdateUrlError("Runtime update URL origin is not allowed");
  }
  if (kind === "stable-index") {
    if (
      url.pathname !== `${LATEST_PATH_PREFIX}${INDEX_NAME}` &&
      url.pathname !== `${LATEST_PATH_PREFIX}${INDEX_SIGNATURE_NAME}`
    ) {
      throw new RuntimeUpdateUrlError(
        "Runtime stable index URL is not the reviewed latest-channel redirect",
      );
    }
    return;
  }
  if (!url.pathname.startsWith(RELEASE_PATH_PREFIX)) {
    throw new RuntimeUpdateUrlError(
      "Runtime release asset URL is outside the approved repository",
    );
  }
  const remainder = url.pathname.slice(RELEASE_PATH_PREFIX.length);
  const parts = remainder.split("/");
  if (
    parts.length !== 2 ||
    !/^runtime-v[0-9A-Za-z][0-9A-Za-z._-]{0,191}$/.test(parts[0]) ||
    /latest/i.test(parts[0]) ||
    !FILE_NAME_PATTERN.test(parts[1]) ||
    parts[1] === "." ||
    parts[1] === ".."
  ) {
    throw new RuntimeUpdateUrlError("Runtime release asset URL is malformed");
  }
}

function createMetadataSignal(signal: AbortSignal): {
  signal: AbortSignal;
  dispose: () => void;
  timedOut: () => boolean;
} {
  const controller = new AbortController();
  let didTimeout = false;
  const onAbort = (): void => controller.abort(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) controller.abort(signal.reason);
  const timer = setTimeout(() => {
    didTimeout = true;
    controller.abort();
  }, DEFAULT_METADATA_TIMEOUT_MS);
  timer.unref?.();
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    },
    timedOut: () => didTimeout,
  };
}

export class FetchRuntimeMetadataTransport implements RuntimeMetadataTransport {
  constructor(private readonly fetcher: RuntimeFetch = nodeRuntimeFetch) {}

  async get(url: URL, signal: AbortSignal): Promise<Buffer> {
    const operation = createMetadataSignal(signal);
    try {
      const response = await this.fetcher(url.href, {
        method: "GET",
        redirect: "follow",
        signal: operation.signal,
        headers: {
          Accept: "application/octet-stream",
          "User-Agent": "Aera-Studio-Runtime-Updater",
        },
      });
      if (!response.ok || response.body === null) {
        throw new RuntimeUpdateTransportError(
          `Runtime metadata returned HTTP ${response.status}`,
        );
      }
      const declaredLength = response.headers.get("content-length");
      if (
        declaredLength !== null &&
        (!/^(?:0|[1-9][0-9]*)$/.test(declaredLength) ||
          Number(declaredLength) > DEFAULT_METADATA_LIMIT)
      ) {
        throw new RuntimeUpdateTransportError(
          "Runtime metadata exceeds the download limit",
        );
      }
      const chunks: Buffer[] = [];
      let received = 0;
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        const bytes = Buffer.from(chunk);
        received += bytes.length;
        if (received > DEFAULT_METADATA_LIMIT) {
          throw new RuntimeUpdateTransportError(
            "Runtime metadata exceeds the download limit",
          );
        }
        chunks.push(bytes);
      }
      return Buffer.concat(chunks, received);
    } catch (error) {
      if (signal.aborted) throw new RuntimeUpdateCheckCancelledError();
      if (error instanceof RuntimeUpdateError) throw error;
      throw new RuntimeUpdateTransportError(
        operation.timedOut()
          ? "Runtime metadata request timed out"
          : "Runtime metadata request failed",
        error instanceof Error ? { cause: error } : undefined,
      );
    } finally {
      operation.dispose();
    }
  }
}

function parseSignatureEnvelope(raw: Buffer): SignatureEnvelope {
  const value = parseJsonObjectRejectDuplicates(raw, "channel signature");
  if (!canonicalJsonBytes(value).equals(raw)) {
    throw new RuntimeUpdateMetadataError(
      "Runtime channel signature is not canonical JSON",
    );
  }
  requireExactObjectFields(value, SIGNATURE_FIELDS, "channel signature");
  if (value.schema_version !== 1) {
    throw new RuntimeUpdateMetadataError(
      "Unsupported Runtime channel signature schema",
    );
  }
  const keyId = requireString(value, "key_id", "channel signature");
  validateRuntimeKeyId(keyId);
  if (value.algorithm !== "Ed25519") {
    throw new RuntimeUpdateMetadataError(
      "Runtime channel signature algorithm is not Ed25519",
    );
  }
  const signatureText = requireString(
    value,
    "signature_base64",
    "channel signature",
  );
  if (!/^[A-Za-z0-9+/]{86}==$/.test(signatureText)) {
    throw new RuntimeUpdateMetadataError(
      "Runtime channel signature base64 is invalid",
    );
  }
  const signature = Buffer.from(signatureText, "base64");
  if (
    signature.length !== 64 ||
    signature.toString("base64") !== signatureText
  ) {
    throw new RuntimeUpdateMetadataError(
      "Runtime channel signature must contain exactly 64 bytes",
    );
  }
  return value as SignatureEnvelope;
}

function validateIndexTarget(
  value: unknown,
  runtimeVersion: string,
): RuntimeChannelIndexTarget {
  if (!isObject(value)) {
    throw new RuntimeUpdateMetadataError(
      "Runtime channel target must be an object",
    );
  }
  requireExactObjectFields(value, INDEX_TARGET_FIELDS, "channel target");
  const platform = requireString(value, "platform", "channel target");
  const arch = requireString(value, "arch", "channel target");
  const target = `${platform}-${arch}`;
  if (target !== "darwin-arm64" && target !== "windows-x64") {
    throw new RuntimeUpdateMetadataError(
      "Runtime channel target is not supported",
    );
  }
  const base = `agentera-runtime-${runtimeVersion}-${target}`;
  const extension = platform === "darwin" ? ".tar.zst" : ".zip";
  if (value.archive_name !== `${base}${extension}`) {
    throw new RuntimeUpdateMetadataError(
      "Runtime channel archive name does not match its target",
    );
  }
  if (value.manifest_name !== `${base}.manifest.json`) {
    throw new RuntimeUpdateMetadataError(
      "Runtime channel manifest name does not match its target",
    );
  }
  if (value.signature_name !== `${base}.manifest.sig`) {
    throw new RuntimeUpdateMetadataError(
      "Runtime channel signature name does not match its target",
    );
  }
  if (
    typeof value.archive_sha256 !== "string" ||
    !SHA256_PATTERN.test(value.archive_sha256)
  ) {
    throw new RuntimeUpdateMetadataError(
      "Runtime channel archive SHA-256 is invalid",
    );
  }
  return value as RuntimeChannelIndexTarget;
}

function verifyChannelIndex(
  indexBytes: Buffer,
  signatureBytes: Buffer,
  trustedPublicKeys: ReadonlyMap<string, string>,
): RuntimeChannelIndex {
  const value = parseJsonObjectRejectDuplicates(indexBytes, "channel index");
  if (!canonicalJsonBytes(value).equals(indexBytes)) {
    throw new RuntimeUpdateMetadataError(
      "Runtime channel index is not canonical JSON",
    );
  }
  requireExactObjectFields(value, INDEX_FIELDS, "channel index");
  if (value.schema_version !== 1 || value.channel !== "stable") {
    throw new RuntimeUpdateMetadataError(
      "Runtime channel index schema or channel is invalid",
    );
  }
  const keyId = requireString(value, "key_id", "channel index");
  validateRuntimeKeyId(keyId);
  const runtimeVersion = requireString(
    value,
    "runtime_version",
    "channel index",
  );
  parseVersion(runtimeVersion, "Runtime channel version");
  if (value.source_repository !== APPROVED_REPOSITORY) {
    throw new RuntimeUpdateMetadataError(
      "Runtime channel repository is not approved",
    );
  }
  if (
    typeof value.source_commit !== "string" ||
    !SOURCE_COMMIT_PATTERN.test(value.source_commit)
  ) {
    throw new RuntimeUpdateMetadataError(
      "Runtime channel source commit is invalid",
    );
  }
  if (value.release_tag !== `runtime-v${runtimeVersion}`) {
    throw new RuntimeUpdateMetadataError(
      "Runtime stable release tag does not match its version",
    );
  }
  if (
    typeof value.created_at !== "string" ||
    !CREATED_AT_PATTERN.test(value.created_at) ||
    Number.isNaN(new Date(value.created_at).valueOf())
  ) {
    throw new RuntimeUpdateMetadataError(
      "Runtime channel timestamp is invalid",
    );
  }
  if (!Array.isArray(value.targets) || value.targets.length !== 2) {
    throw new RuntimeUpdateMetadataError(
      "Runtime channel index must contain both native targets",
    );
  }
  const targets = value.targets.map((item) =>
    validateIndexTarget(item, runtimeVersion),
  );
  if (
    `${targets[0].platform}-${targets[0].arch}` !== "darwin-arm64" ||
    `${targets[1].platform}-${targets[1].arch}` !== "windows-x64"
  ) {
    throw new RuntimeUpdateMetadataError(
      "Runtime channel targets must be unique and sorted",
    );
  }

  const envelope = parseSignatureEnvelope(signatureBytes);
  if (envelope.key_id !== keyId) {
    throw new RuntimeUpdateMetadataError(
      "Runtime channel index and signature key ids differ",
    );
  }
  const publicKeyPem = trustedPublicKeys.get(keyId);
  if (publicKeyPem === undefined) {
    throw new RuntimeUpdateMetadataError(
      "Runtime channel signing key is not trusted",
    );
  }
  let publicKey;
  try {
    publicKey = createPublicKey(publicKeyPem);
  } catch (error) {
    throw new RuntimeUpdateMetadataError(
      "Runtime channel trusted public key is invalid",
      { cause: error },
    );
  }
  if (publicKey.asymmetricKeyType !== "ed25519") {
    throw new RuntimeUpdateMetadataError(
      "Runtime channel trusted public key is not Ed25519",
    );
  }
  const signature = Buffer.from(envelope.signature_base64, "base64");
  if (!verifySignature(null, indexBytes, publicKey, signature)) {
    throw new RuntimeUpdateMetadataError(
      "Runtime channel index signature is invalid",
    );
  }
  return { ...value, targets } as RuntimeChannelIndex;
}

function releaseAssetUrl(releaseTag: string, name: string): URL {
  const url = new URL(
    `${GITHUB_ORIGIN}${RELEASE_PATH_PREFIX}${releaseTag}/${name}`,
  );
  assertAllowedRuntimeUpdateUrl(url, "release-asset");
  return url;
}

async function getMetadata(
  transport: RuntimeMetadataTransport,
  url: URL,
  kind: RuntimeUpdateUrlKind,
  signal: AbortSignal,
): Promise<Buffer> {
  assertAllowedRuntimeUpdateUrl(url, kind);
  try {
    const result = await transport.get(url, signal);
    if (!Buffer.isBuffer(result)) {
      throw new RuntimeUpdateTransportError(
        "Runtime metadata transport did not return bytes",
      );
    }
    return result;
  } catch (error) {
    if (signal.aborted || error instanceof RuntimeUpdateCheckCancelledError) {
      throw new RuntimeUpdateCheckCancelledError();
    }
    if (error instanceof RuntimeUpdateTransportError) throw error;
    throw new RuntimeUpdateTransportError(
      "Runtime metadata transport failed",
      error instanceof Error ? { cause: error } : undefined,
    );
  }
}

function crossCheckManifest(
  manifest: RuntimeManifest,
  index: RuntimeChannelIndex,
  target: RuntimeChannelIndexTarget,
): void {
  if (
    manifest.runtime_version !== index.runtime_version ||
    manifest.source_commit !== index.source_commit ||
    manifest.source_repository !== index.source_repository ||
    manifest.channel !== "stable" ||
    manifest.platform !== target.platform ||
    manifest.arch !== target.arch ||
    manifest.archive_name !== target.archive_name ||
    manifest.archive_sha256 !== target.archive_sha256
  ) {
    throw new RuntimeUpdateMetadataError(
      "Runtime manifest differs from the signed channel index",
    );
  }
}

function reportCheckError(
  callback: RuntimeUpdateContext["onCheckError"],
  code: RuntimeUpdateErrorCode,
): void {
  try {
    callback?.(code);
  } catch {
    // UI error reporting cannot change the safe update-check result.
  }
}

export async function checkStableRuntimeUpdate(
  context: RuntimeUpdateContext,
): Promise<RuntimeUpdateOffer | null> {
  if (context.repository !== APPROVED_REPOSITORY) {
    reportCheckError(context.onCheckError, "runtime_update_metadata_invalid");
    return null;
  }
  const transport = context.transport ?? new FetchRuntimeMetadataTransport();
  const indexUrl = new URL(
    `${GITHUB_ORIGIN}${LATEST_PATH_PREFIX}${INDEX_NAME}`,
  );
  const indexSignatureUrl = new URL(
    `${GITHUB_ORIGIN}${LATEST_PATH_PREFIX}${INDEX_SIGNATURE_NAME}`,
  );
  try {
    const indexBytes = await getMetadata(
      transport,
      indexUrl,
      "stable-index",
      context.signal,
    );
    const indexSignatureBytes = await getMetadata(
      transport,
      indexSignatureUrl,
      "stable-index",
      context.signal,
    );
    const index = verifyChannelIndex(
      indexBytes,
      indexSignatureBytes,
      context.trustedPublicKeys,
    );
    const comparison = compareRuntimeVersions(
      index.runtime_version,
      context.currentVersion,
    );
    if (comparison < 0) return null;
    if (comparison === 0) {
      if (
        context.currentSourceCommit !== null &&
        context.currentSourceCommit !== index.source_commit
      ) {
        throw new RuntimeUpdateMetadataError(
          "Runtime version was reused for a different source commit",
        );
      }
      return null;
    }

    const target = index.targets.find(
      (item) =>
        item.platform === context.platform && item.arch === context.arch,
    );
    if (target === undefined) {
      throw new RuntimeUpdateMetadataError(
        "Runtime channel index has no matching native target",
      );
    }
    const manifestUrl = releaseAssetUrl(
      index.release_tag,
      target.manifest_name,
    );
    const signatureUrl = releaseAssetUrl(
      index.release_tag,
      target.signature_name,
    );
    const manifestBytes = await getMetadata(
      transport,
      manifestUrl,
      "release-asset",
      context.signal,
    );
    const signatureBytes = await getMetadata(
      transport,
      signatureUrl,
      "release-asset",
      context.signal,
    );
    let manifest: RuntimeManifest;
    try {
      manifest = verifyRuntimeManifestSignature({
        manifestBytes,
        signatureBytes,
        trustedPublicKeys: context.trustedPublicKeys,
        context: {
          repository: APPROVED_REPOSITORY,
          platform: context.platform,
          arch: context.arch,
          desktopVersion: context.desktopVersion,
          allowedChannels: new Set(["stable"]),
        },
      });
    } catch (error) {
      if (
        error instanceof RuntimeProtocolError &&
        error.message.includes("desktop version is below")
      ) {
        return null;
      }
      throw error;
    }
    crossCheckManifest(manifest, index, target);
    const archiveUrl = releaseAssetUrl(index.release_tag, target.archive_name);
    return {
      runtimeVersion: manifest.runtime_version,
      sourceCommit: manifest.source_commit,
      releaseTag: index.release_tag,
      archiveName: manifest.archive_name,
      archiveSize: manifest.archive_size,
      archiveSha256: manifest.archive_sha256,
      archiveUrl,
      manifestUrl,
      signatureUrl,
      manifestBytes,
      signatureBytes,
    };
  } catch (error) {
    if (
      context.signal.aborted ||
      error instanceof RuntimeUpdateCheckCancelledError
    ) {
      throw new RuntimeUpdateCheckCancelledError();
    }
    reportCheckError(
      context.onCheckError,
      error instanceof RuntimeUpdateTransportError
        ? "runtime_update_unavailable"
        : "runtime_update_metadata_invalid",
    );
    return null;
  }
}
