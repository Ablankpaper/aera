import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from "node:crypto";
import type { components } from "../../shared/agentera-cloud-api.generated";
import { parseAgenteraCloudOrigin } from "../agentera-auth/config";

export type AgentSigningPurpose = "agent_version" | "agent_policy";
export type AgentVersion = components["schemas"]["AgentVersion"];
export type AgentPolicySnapshot = components["schemas"]["AgentPolicySnapshot"];
export type AgentSigningKeySet = components["schemas"]["SigningKeySet"];

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{86}$/;
const PUBLIC_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const UINT64_MAX = 18_446_744_073_709_551_615n;

export type AgenteraAgentTrustErrorCode =
  | "invalid_trust_cache"
  | "invalid_signing_keys"
  | "issuer_mismatch"
  | "unknown_signing_key"
  | "signing_purpose_mismatch"
  | "digest_mismatch"
  | "signature_invalid"
  | "runtime_incompatible";

export class AgenteraAgentTrustError extends Error {
  readonly code: AgenteraAgentTrustErrorCode;

  constructor(code: AgenteraAgentTrustErrorCode) {
    super(`AgentEra Agent trust verification failed: ${code}.`);
    this.name = "AgenteraAgentTrustError";
    this.code = code;
  }
}

export interface AgenteraAgentTrustCacheKey {
  origin: string;
  purpose: AgentSigningPurpose;
  keyId: string;
  publicKey: string;
  fetchedAt: string;
}

export interface AgenteraAgentTrustCache {
  schemaVersion: 1;
  keys: readonly AgenteraAgentTrustCacheKey[];
}

export interface AgenteraAgentTrustStoreOptions {
  cache?: AgenteraAgentTrustCache;
}

export interface AgentVersionVerificationContext {
  issuer: string;
  runtimeVersion: string;
}

export interface AgentPolicyVerificationContext {
  runtimeVersion: string;
}

export interface AgentVerificationResult {
  contentDigest: string;
}

export interface CanonicalAgentVersionContent {
  manifestBytes: Buffer;
  bundleBytes: Buffer;
  manifestDigest: string;
  bundleDigest: string;
  contentDigest: string;
}

interface TrustedKey extends AgenteraAgentTrustCacheKey {
  raw: Buffer;
}

interface ParsedVersion {
  major: bigint;
  minor: bigint;
  patch: bigint;
  prerelease: readonly string[];
}

interface CanonicalModelConstraints {
  allowed_models: string[];
  allowed_providers: string[];
}

interface CanonicalTools {
  allowed: string[];
  denied: string[];
}

interface CanonicalRuntimeCompatibility {
  minimum_version: string;
  maximum_version_exclusive: string | null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> {
  if (!isObject(value)) return false;
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((field) => Object.hasOwn(value, field)) &&
    Object.keys(value).every((field) => allowed.has(field))
  );
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 64) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function canonicalBase64URL(
  value: string,
  pattern: RegExp,
  bytes: number,
): boolean {
  if (!pattern.test(value)) return false;
  const decoded = Buffer.from(value, "base64url");
  return decoded.length === bytes && decoded.toString("base64url") === value;
}

function cacheKey(
  origin: string,
  purpose: AgentSigningPurpose,
  keyId: string,
): string {
  return `${origin}\0${purpose}\0${keyId}`;
}

function parseCacheKey(value: AgenteraAgentTrustCacheKey): TrustedKey {
  let origin: string;
  try {
    origin = parseAgenteraCloudOrigin(value.origin);
  } catch {
    throw new AgenteraAgentTrustError("invalid_trust_cache");
  }
  if (
    origin !== value.origin ||
    (value.purpose !== "agent_version" && value.purpose !== "agent_policy") ||
    !KEY_ID_PATTERN.test(value.keyId) ||
    !canonicalBase64URL(value.publicKey, PUBLIC_KEY_PATTERN, 32) ||
    !canonicalTimestamp(value.fetchedAt)
  ) {
    throw new AgenteraAgentTrustError("invalid_trust_cache");
  }
  return { ...value, origin, raw: Buffer.from(value.publicKey, "base64url") };
}

function digest(raw: Buffer): string {
  return createHash("sha256").update(raw).digest("hex");
}

function goCanonicalJsonBytes(value: unknown): Buffer {
  return Buffer.from(
    JSON.stringify(value)
      .replace(/\u2028/g, "\\u2028")
      .replace(/\u2029/g, "\\u2029"),
    "utf8",
  );
}

function requireString(value: unknown, maximum = 4096): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum
  ) {
    throw new AgenteraAgentTrustError("digest_mismatch");
  }
  return value;
}

function requireStringArray(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 512 ||
    !value.every(
      (item) =>
        typeof item === "string" && item.length > 0 && item.length <= 512,
    )
  ) {
    throw new AgenteraAgentTrustError("digest_mismatch");
  }
  return [...value];
}

function canonicalModelConstraints(value: unknown): CanonicalModelConstraints {
  if (!exactObject(value, ["allowed_models", "allowed_providers"])) {
    throw new AgenteraAgentTrustError("digest_mismatch");
  }
  const allowedModels = requireStringArray(value.allowed_models);
  const allowedProviders = requireStringArray(value.allowed_providers);
  if (allowedModels.length === 0 || allowedProviders.length === 0) {
    throw new AgenteraAgentTrustError("digest_mismatch");
  }
  return {
    allowed_models: allowedModels,
    allowed_providers: allowedProviders,
  };
}

function canonicalTools(value: unknown): CanonicalTools {
  if (!exactObject(value, ["allowed", "denied"])) {
    throw new AgenteraAgentTrustError("digest_mismatch");
  }
  return {
    allowed: requireStringArray(value.allowed),
    denied: requireStringArray(value.denied),
  };
}

function canonicalRuntimeCompatibility(
  value: unknown,
): CanonicalRuntimeCompatibility {
  if (!exactObject(value, ["minimum_version"], ["maximum_version_exclusive"])) {
    throw new AgenteraAgentTrustError("digest_mismatch");
  }
  const maximum = value.maximum_version_exclusive;
  if (
    maximum !== undefined &&
    maximum !== null &&
    typeof maximum !== "string"
  ) {
    throw new AgenteraAgentTrustError("digest_mismatch");
  }
  return {
    maximum_version_exclusive:
      maximum === undefined ? null : (maximum as string | null),
    minimum_version: requireString(value.minimum_version, 64),
  };
}

function canonicalManifestBytes(value: unknown): Buffer {
  if (
    !exactObject(value, [
      "assets",
      "dependencies",
      "identity",
      "model_constraints",
      "runtime_compatibility",
      "schema_version",
      "tools",
    ]) ||
    value.schema_version !== 1 ||
    !Array.isArray(value.assets) ||
    value.assets.length > 128 ||
    !Array.isArray(value.dependencies) ||
    value.dependencies.length > 128 ||
    !exactObject(value.identity, ["system_prompt"])
  ) {
    throw new AgenteraAgentTrustError("digest_mismatch");
  }
  const assets = value.assets.map((asset) => {
    if (
      !exactObject(asset, ["kind", "media_type", "path", "sha256"]) ||
      (asset.kind !== "skill" &&
        asset.kind !== "sop" &&
        asset.kind !== "knowledge") ||
      (asset.media_type !== "text/markdown" &&
        asset.media_type !== "text/plain") ||
      typeof asset.path !== "string" ||
      !DIGEST_PATTERN.test(String(asset.sha256))
    ) {
      throw new AgenteraAgentTrustError("digest_mismatch");
    }
    return {
      kind: asset.kind,
      media_type: asset.media_type,
      path: requireString(asset.path, 512),
      sha256: asset.sha256,
    };
  });
  const dependencies = value.dependencies.map((dependency) => {
    if (
      !exactObject(dependency, ["agent_definition_id", "agent_version_id"]) ||
      !UUID_PATTERN.test(String(dependency.agent_definition_id)) ||
      !UUID_PATTERN.test(String(dependency.agent_version_id))
    ) {
      throw new AgenteraAgentTrustError("digest_mismatch");
    }
    return {
      agent_definition_id: dependency.agent_definition_id,
      agent_version_id: dependency.agent_version_id,
    };
  });
  const canonical = {
    assets,
    dependencies,
    identity: {
      system_prompt: requireString(value.identity.system_prompt, 262_144),
    },
    model_constraints: canonicalModelConstraints(value.model_constraints),
    runtime_compatibility: canonicalRuntimeCompatibility(
      value.runtime_compatibility,
    ),
    schema_version: 1,
    tools: canonicalTools(value.tools),
  };
  return goCanonicalJsonBytes(canonical);
}

function canonicalBundleBytes(value: unknown): {
  bytes: Buffer;
  assets: ReadonlyMap<string, string>;
} {
  if (
    !exactObject(value, ["assets"]) ||
    !Array.isArray(value.assets) ||
    value.assets.length > 128
  ) {
    throw new AgenteraAgentTrustError("digest_mismatch");
  }
  const byPath = new Map<string, string>();
  const assets = value.assets.map((asset) => {
    if (
      !exactObject(asset, ["content", "path"]) ||
      typeof asset.content !== "string" ||
      Buffer.byteLength(asset.content, "utf8") > 262_144 ||
      typeof asset.path !== "string" ||
      asset.path.length === 0 ||
      asset.path.length > 512 ||
      byPath.has(asset.path)
    ) {
      throw new AgenteraAgentTrustError("digest_mismatch");
    }
    byPath.set(asset.path, asset.content);
    return { content: asset.content, path: asset.path };
  });
  return {
    bytes: goCanonicalJsonBytes({ assets }),
    assets: byPath,
  };
}

function canonicalOfficialPolicyContext(value: unknown): {
  platform_id: string;
  release_id: string;
  release_revision_id: string;
  user_id: string;
  device_installation_id: string;
  installation_id: string;
  product_scope: "USER" | "WORKSPACE" | "ORGANIZATION";
  product_context_id: string;
} {
  if (
    !exactObject(value, [
      "device_installation_id",
      "installation_id",
      "platform_id",
      "product_context_id",
      "product_scope",
      "release_id",
      "release_revision_id",
      "user_id",
    ])
  ) {
    throw new AgenteraAgentTrustError("digest_mismatch");
  }
  const identifiers = [
    value.platform_id,
    value.release_id,
    value.release_revision_id,
    value.user_id,
    value.device_installation_id,
    value.installation_id,
    value.product_context_id,
  ];
  if (
    identifiers.some(
      (identifier) =>
        typeof identifier !== "string" ||
        !UUID_PATTERN.test(identifier) ||
        identifier !== identifier.toLowerCase(),
    ) ||
    (value.product_scope !== "USER" &&
      value.product_scope !== "WORKSPACE" &&
      value.product_scope !== "ORGANIZATION")
  ) {
    throw new AgenteraAgentTrustError("digest_mismatch");
  }
  return {
    platform_id: value.platform_id as string,
    release_id: value.release_id as string,
    release_revision_id: value.release_revision_id as string,
    user_id: value.user_id as string,
    device_installation_id: value.device_installation_id as string,
    installation_id: value.installation_id as string,
    product_scope: value.product_scope,
    product_context_id: value.product_context_id as string,
  };
}

function verifyManifestAssets(
  manifest: AgentVersion["manifest"],
  bundleAssets: ReadonlyMap<string, string>,
): void {
  if (manifest.assets.length !== bundleAssets.size) {
    throw new AgenteraAgentTrustError("digest_mismatch");
  }
  for (const asset of manifest.assets) {
    const content = bundleAssets.get(asset.path);
    if (
      content === undefined ||
      digest(Buffer.from(content, "utf8")) !== asset.sha256
    ) {
      throw new AgenteraAgentTrustError("digest_mismatch");
    }
  }
}

function canonicalPolicyDocumentBytes(value: unknown): Buffer {
  if (
    !exactObject(
      value,
      [
        "agent_definition_id",
        "agent_version_id",
        "deny_rules",
        "model_constraints",
        "publication_allowed",
        "runtime_compatibility",
        "schema_version",
        "tools",
        "version_digest",
      ],
      ["official_context"],
    ) ||
    value.schema_version !== 1 ||
    !UUID_PATTERN.test(String(value.agent_definition_id)) ||
    !UUID_PATTERN.test(String(value.agent_version_id)) ||
    !DIGEST_PATTERN.test(String(value.version_digest)) ||
    value.publication_allowed !== false
  ) {
    throw new AgenteraAgentTrustError("digest_mismatch");
  }
  const canonical = {
    schema_version: 1,
    agent_definition_id: value.agent_definition_id,
    agent_version_id: value.agent_version_id,
    version_digest: value.version_digest,
    model_constraints: canonicalModelConstraints(value.model_constraints),
    tools: canonicalTools(value.tools),
    runtime_compatibility: canonicalRuntimeCompatibility(
      value.runtime_compatibility,
    ),
    publication_allowed: false,
    deny_rules: requireStringArray(value.deny_rules),
    ...(value.official_context === undefined
      ? {}
      : {
          official_context: canonicalOfficialPolicyContext(
            value.official_context,
          ),
        }),
  };
  return goCanonicalJsonBytes(canonical);
}

export function canonicalizeAgentVersionContent(
  version: AgentVersion,
): CanonicalAgentVersionContent {
  const manifestBytes = canonicalManifestBytes(version.manifest);
  const bundle = canonicalBundleBytes(version.bundle);
  verifyManifestAssets(version.manifest, bundle.assets);
  const manifestDigest = digest(manifestBytes);
  const bundleDigest = digest(bundle.bytes);
  const contentDigest = createHash("sha256")
    .update(manifestBytes)
    .update(Buffer.from([0]))
    .update(bundle.bytes)
    .digest("hex");
  return {
    manifestBytes,
    bundleBytes: bundle.bytes,
    manifestDigest,
    bundleDigest,
    contentDigest,
  };
}

function parseSemanticVersion(raw: string): ParsedVersion {
  const match =
    /^(?:v)?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/.exec(
      raw,
    );
  if (!match) throw new AgenteraAgentTrustError("runtime_incompatible");
  const numeric = match.slice(1, 4).map((part) => BigInt(part));
  if (numeric.some((part) => part > UINT64_MAX)) {
    throw new AgenteraAgentTrustError("runtime_incompatible");
  }
  for (const [rawIdentifiers, rejectLeadingZero] of [
    [match[4] ?? "", true],
    [match[5] ?? "", false],
  ] as const) {
    if (rawIdentifiers === "") continue;
    for (const identifier of rawIdentifiers.split(".")) {
      if (
        identifier === "" ||
        !/^[0-9A-Za-z-]+$/.test(identifier) ||
        (rejectLeadingZero && /^0[0-9]+$/.test(identifier))
      ) {
        throw new AgenteraAgentTrustError("runtime_incompatible");
      }
    }
  }
  return {
    major: numeric[0],
    minor: numeric[1],
    patch: numeric[2],
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

function compareSemanticVersion(
  left: ParsedVersion,
  right: ParsedVersion,
): number {
  for (const field of ["major", "minor", "patch"] as const) {
    if (left[field] < right[field]) return -1;
    if (left[field] > right[field]) return 1;
  }
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
  if (left.prerelease.length === 0) return 1;
  if (right.prerelease.length === 0) return -1;
  const length = Math.min(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === rightPart) continue;
    const leftNumeric = /^[0-9]+$/.test(leftPart);
    const rightNumeric = /^[0-9]+$/.test(rightPart);
    if (leftNumeric && rightNumeric) {
      const leftValue = BigInt(leftPart);
      const rightValue = BigInt(rightPart);
      if (leftValue < rightValue) return -1;
      if (leftValue > rightValue) return 1;
      continue;
    }
    if (leftNumeric) return -1;
    if (rightNumeric) return 1;
    return leftPart < rightPart ? -1 : 1;
  }
  if (left.prerelease.length < right.prerelease.length) return -1;
  if (left.prerelease.length > right.prerelease.length) return 1;
  return 0;
}

function assertRuntimeCompatibility(
  runtimeVersion: string,
  compatibility: {
    minimum_version: string;
    maximum_version_exclusive: string | null;
  },
): void {
  let current: ParsedVersion;
  let minimum: ParsedVersion;
  try {
    current = parseSemanticVersion(runtimeVersion);
    minimum = parseSemanticVersion(compatibility.minimum_version);
  } catch {
    throw new AgenteraAgentTrustError("runtime_incompatible");
  }
  if (compareSemanticVersion(current, minimum) < 0) {
    throw new AgenteraAgentTrustError("runtime_incompatible");
  }
  if (compatibility.maximum_version_exclusive !== null) {
    const maximum = parseSemanticVersion(
      compatibility.maximum_version_exclusive,
    );
    if (compareSemanticVersion(current, maximum) >= 0) {
      throw new AgenteraAgentTrustError("runtime_incompatible");
    }
  }
}

export class AgenteraAgentTrustStore {
  private readonly keys = new Map<string, TrustedKey>();

  constructor(options: AgenteraAgentTrustStoreOptions = {}) {
    if (options.cache !== undefined) this.importCache(options.cache);
  }

  replaceKeys(
    rawOrigin: string,
    keySet: AgentSigningKeySet,
    fetchedAt: string,
  ): void {
    let origin: string;
    try {
      origin = parseAgenteraCloudOrigin(rawOrigin);
    } catch {
      throw new AgenteraAgentTrustError("invalid_signing_keys");
    }
    if (
      !canonicalTimestamp(fetchedAt) ||
      !exactObject(keySet, ["keys"]) ||
      !Array.isArray(keySet.keys)
    ) {
      throw new AgenteraAgentTrustError("invalid_signing_keys");
    }
    const incoming = new Map<string, TrustedKey>();
    for (const candidate of keySet.keys) {
      if (
        !exactObject(candidate, [
          "alg",
          "crv",
          "kid",
          "kty",
          "purpose",
          "use",
          "x",
        ]) ||
        candidate.alg !== "EdDSA" ||
        candidate.crv !== "Ed25519" ||
        candidate.kty !== "OKP" ||
        candidate.use !== "sig" ||
        typeof candidate.kid !== "string" ||
        !KEY_ID_PATTERN.test(candidate.kid) ||
        typeof candidate.x !== "string" ||
        !canonicalBase64URL(candidate.x, PUBLIC_KEY_PATTERN, 32)
      ) {
        throw new AgenteraAgentTrustError("invalid_signing_keys");
      }
      if (
        candidate.purpose !== "agent_version" &&
        candidate.purpose !== "agent_policy"
      ) {
        continue;
      }
      const identifier = cacheKey(origin, candidate.purpose, candidate.kid);
      if (incoming.has(identifier)) {
        throw new AgenteraAgentTrustError("invalid_signing_keys");
      }
      incoming.set(identifier, {
        origin,
        purpose: candidate.purpose,
        keyId: candidate.kid,
        publicKey: candidate.x,
        fetchedAt,
        raw: Buffer.from(candidate.x, "base64url"),
      });
    }
    if (incoming.size === 0) {
      throw new AgenteraAgentTrustError("invalid_signing_keys");
    }
    for (const [identifier, key] of this.keys) {
      if (key.origin === origin) this.keys.delete(identifier);
    }
    for (const [identifier, key] of incoming) this.keys.set(identifier, key);
  }

  exportCache(): AgenteraAgentTrustCache {
    const keys = [...this.keys.values()]
      .sort((left, right) =>
        `${left.origin}\0${left.purpose}\0${left.keyId}`.localeCompare(
          `${right.origin}\0${right.purpose}\0${right.keyId}`,
        ),
      )
      .map(({ origin, purpose, keyId, publicKey, fetchedAt }) => ({
        origin,
        purpose,
        keyId,
        publicKey,
        fetchedAt,
      }));
    return { schemaVersion: 1, keys };
  }

  verifyVersion(
    version: AgentVersion,
    context: AgentVersionVerificationContext,
  ): AgentVerificationResult {
    const key = this.requireKey(
      context.issuer,
      "agent_version",
      version.signing_key_id,
    );
    if (
      !UUID_PATTERN.test(version.id) ||
      !UUID_PATTERN.test(version.definition_id) ||
      !Number.isSafeInteger(version.version_number) ||
      version.version_number <= 0 ||
      !DIGEST_PATTERN.test(version.content_digest)
    ) {
      throw new AgenteraAgentTrustError("digest_mismatch");
    }
    const canonical = canonicalizeAgentVersionContent(version);
    const { manifestDigest, bundleDigest, contentDigest } = canonical;
    if (contentDigest !== version.content_digest) {
      throw new AgenteraAgentTrustError("digest_mismatch");
    }
    const compatibility = canonicalRuntimeCompatibility(
      version.manifest.runtime_compatibility,
    );
    if (
      version.runtime_minimum_version !== compatibility.minimum_version ||
      (compatibility.maximum_version_exclusive === null
        ? version.runtime_maximum_version_exclusive !== undefined
        : version.runtime_maximum_version_exclusive !==
          compatibility.maximum_version_exclusive)
    ) {
      throw new AgenteraAgentTrustError("runtime_incompatible");
    }
    assertRuntimeCompatibility(context.runtimeVersion, compatibility);
    const payload = Buffer.from(
      `agentera-agent-version-v1\0${version.definition_id}\0${version.id}\0${version.version_number}\0${manifestDigest}\0${bundleDigest}`,
      "utf8",
    );
    this.verifyEd25519(key, payload, version.signature);
    return { contentDigest };
  }

  verifyPolicy(
    policy: AgentPolicySnapshot,
    context: AgentPolicyVerificationContext,
  ): AgentVerificationResult {
    const key = this.requireKey(
      policy.issuer,
      "agent_policy",
      policy.signing_key_id,
    );
    if (
      !UUID_PATTERN.test(policy.id) ||
      !UUID_PATTERN.test(policy.installation_id) ||
      !UUID_PATTERN.test(policy.agent_version_id) ||
      !Number.isSafeInteger(policy.policy_version) ||
      policy.policy_version <= 0 ||
      !DIGEST_PATTERN.test(policy.content_digest) ||
      policy.document.agent_version_id !== policy.agent_version_id
    ) {
      throw new AgenteraAgentTrustError("digest_mismatch");
    }
    const documentBytes = canonicalPolicyDocumentBytes(policy.document);
    const contentDigest = digest(documentBytes);
    if (contentDigest !== policy.content_digest) {
      throw new AgenteraAgentTrustError("digest_mismatch");
    }
    const compatibility = canonicalRuntimeCompatibility(
      policy.document.runtime_compatibility,
    );
    assertRuntimeCompatibility(context.runtimeVersion, compatibility);
    const payload = Buffer.from(
      `agentera-agent-policy-v1\0${policy.id}\0${policy.policy_version}\0${contentDigest}`,
      "utf8",
    );
    this.verifyEd25519(key, payload, policy.signature);
    return { contentDigest };
  }

  private importCache(cache: AgenteraAgentTrustCache): void {
    if (
      !exactObject(cache, ["keys", "schemaVersion"]) ||
      cache.schemaVersion !== 1 ||
      !Array.isArray(cache.keys) ||
      cache.keys.length > 1024
    ) {
      throw new AgenteraAgentTrustError("invalid_trust_cache");
    }
    for (const value of cache.keys) {
      if (
        !exactObject(value, [
          "fetchedAt",
          "keyId",
          "origin",
          "publicKey",
          "purpose",
        ])
      ) {
        throw new AgenteraAgentTrustError("invalid_trust_cache");
      }
      const parsed = parseCacheKey(
        value as unknown as AgenteraAgentTrustCacheKey,
      );
      const identifier = cacheKey(parsed.origin, parsed.purpose, parsed.keyId);
      if (this.keys.has(identifier)) {
        throw new AgenteraAgentTrustError("invalid_trust_cache");
      }
      this.keys.set(identifier, parsed);
    }
  }

  private requireKey(
    rawOrigin: string,
    purpose: AgentSigningPurpose,
    keyId: string,
  ): TrustedKey {
    let origin: string;
    try {
      origin = parseAgenteraCloudOrigin(rawOrigin);
    } catch {
      throw new AgenteraAgentTrustError("issuer_mismatch");
    }
    const exact = this.keys.get(cacheKey(origin, purpose, keyId));
    if (exact) return exact;
    const sameOrigin = [...this.keys.values()].filter(
      (candidate) => candidate.origin === origin,
    );
    if (sameOrigin.length === 0 && this.keys.size > 0) {
      throw new AgenteraAgentTrustError("issuer_mismatch");
    }
    if (sameOrigin.some((candidate) => candidate.keyId === keyId)) {
      throw new AgenteraAgentTrustError("signing_purpose_mismatch");
    }
    throw new AgenteraAgentTrustError("unknown_signing_key");
  }

  private verifyEd25519(
    key: TrustedKey,
    payload: Buffer,
    encodedSignature: string,
  ): void {
    if (!canonicalBase64URL(encodedSignature, SIGNATURE_PATTERN, 64)) {
      throw new AgenteraAgentTrustError("signature_invalid");
    }
    let publicKey;
    try {
      publicKey = createPublicKey({
        key: Buffer.concat([SPKI_PREFIX, key.raw]),
        format: "der",
        type: "spki",
      });
    } catch {
      throw new AgenteraAgentTrustError("invalid_trust_cache");
    }
    if (
      !verifySignature(
        null,
        payload,
        publicKey,
        Buffer.from(encodedSignature, "base64url"),
      )
    ) {
      throw new AgenteraAgentTrustError("signature_invalid");
    }
  }
}
