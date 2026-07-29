import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from "node:crypto";
import type { components } from "../../shared/agentera-cloud-api.generated";
import type {
  OrganizationModelIdentifier,
  OrganizationPolicyDocument,
  OrganizationPolicySnapshot,
} from "../../shared/agentera-organization";
import { parseAgenteraCloudOrigin } from "../agentera-auth/origin";

export type OrganizationSigningKeySet = components["schemas"]["SigningKeySet"];

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9._:/-]{1,128}$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{86}$/;
const PUBLIC_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export type AgenteraOrganizationPolicyVerificationErrorCode =
  | "invalid_snapshot"
  | "invalid_signing_keys"
  | "issuer_mismatch"
  | "unknown_signing_key"
  | "signing_purpose_mismatch"
  | "schema_mismatch"
  | "digest_mismatch"
  | "signature_invalid"
  | "canonicalization_mismatch";

export class AgenteraOrganizationPolicyVerificationError extends Error {
  readonly code: AgenteraOrganizationPolicyVerificationErrorCode;

  constructor(code: AgenteraOrganizationPolicyVerificationErrorCode) {
    super(`Aera Organization policy verification failed: ${code}.`);
    this.name = "AgenteraOrganizationPolicyVerificationError";
    this.code = code;
  }
}

export interface AgenteraOrganizationPolicyVerifierOptions {
  origin: string;
}

export interface OrganizationPolicyVerificationInput {
  organizationId: string;
  snapshot: OrganizationPolicySnapshot;
  keySet: OrganizationSigningKeySet;
}

export interface VerifiedOrganizationPolicySnapshot {
  organizationId: string;
  snapshot: OrganizationPolicySnapshot & {
    document: OrganizationPolicyDocument;
    signature: string;
  };
  canonicalJson: string;
  contentDigest: string;
}

export interface CanonicalOrganizationPolicy {
  document: OrganizationPolicyDocument;
  canonicalJson: string;
  contentDigest: string;
}

interface TrustedOrganizationKey {
  kid: string;
  purpose:
    | "access"
    | "offline_entitlement"
    | "agent_version"
    | "agent_policy"
    | "organization_policy";
  raw: Buffer;
}

function failure(code: AgenteraOrganizationPolicyVerificationErrorCode): never {
  throw new AgenteraOrganizationPolicyVerificationError(code);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactObject(
  value: unknown,
  fields: readonly string[],
): value is Record<string, unknown> {
  return (
    isObject(value) &&
    fields.every((field) => Object.hasOwn(value, field)) &&
    Object.keys(value).every((field) => fields.includes(field))
  );
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !TIMESTAMP_PATTERN.test(value)) return false;
  const parsed = new Date(value);
  return (
    Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 19) === value.slice(0, 19)
  );
}

function isCanonicalBase64URL(
  value: unknown,
  pattern: RegExp,
  bytes: number,
): value is string {
  if (typeof value !== "string" || !pattern.test(value)) return false;
  try {
    const decoded = Buffer.from(value, "base64url");
    return decoded.length === bytes && decoded.toString("base64url") === value;
  } catch {
    return false;
  }
}

function compareModel(
  left: OrganizationModelIdentifier,
  right: OrganizationModelIdentifier,
): number {
  if (left.provider !== right.provider) {
    return left.provider < right.provider ? -1 : 1;
  }
  if (left.model === right.model) return 0;
  return left.model < right.model ? -1 : 1;
}

function parseModelAllowlist(
  value: unknown,
): OrganizationModelIdentifier[] | null {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length > 128) {
    failure("canonicalization_mismatch");
  }
  const result: OrganizationModelIdentifier[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (
      !exactObject(item, ["provider", "model"]) ||
      typeof item.provider !== "string" ||
      typeof item.model !== "string" ||
      !IDENTIFIER_PATTERN.test(item.provider) ||
      !IDENTIFIER_PATTERN.test(item.model)
    ) {
      failure("canonicalization_mismatch");
    }
    const identifier = `${item.provider}\0${item.model}`;
    if (seen.has(identifier)) failure("canonicalization_mismatch");
    seen.add(identifier);
    result.push({ provider: item.provider, model: item.model });
  }
  return result.sort(compareModel);
}

function parseToolAllowlist(value: unknown): string[] | null {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length > 128) {
    failure("canonicalization_mismatch");
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || !IDENTIFIER_PATTERN.test(item)) {
      failure("canonicalization_mismatch");
    }
    if (seen.has(item)) failure("canonicalization_mismatch");
    seen.add(item);
    result.push(item);
  }
  return result.sort();
}

export function canonicalizeOrganizationPolicyDocument(
  value: unknown,
  options: { requireCanonical?: boolean } = {},
): CanonicalOrganizationPolicy {
  if (
    !exactObject(value, [
      "schemaVersion",
      "models",
      "tools",
      "experienceCandidates",
      "officialAgents",
    ]) ||
    value.schemaVersion !== 1
  ) {
    failure("schema_mismatch");
  }
  if (
    !exactObject(value.models, ["allowlist"]) ||
    !exactObject(value.tools, ["allowlist"]) ||
    !exactObject(value.experienceCandidates, ["mode"]) ||
    !exactObject(value.officialAgents, ["installation"]) ||
    (value.experienceCandidates.mode !== "disabled" &&
      value.experienceCandidates.mode !== "manual_review") ||
    (value.officialAgents.installation !== "allowed" &&
      value.officialAgents.installation !== "blocked")
  ) {
    failure("canonicalization_mismatch");
  }
  const document: OrganizationPolicyDocument = {
    schemaVersion: 1,
    models: { allowlist: parseModelAllowlist(value.models.allowlist) },
    tools: { allowlist: parseToolAllowlist(value.tools.allowlist) },
    experienceCandidates: { mode: value.experienceCandidates.mode },
    officialAgents: { installation: value.officialAgents.installation },
  };
  if (options.requireCanonical) {
    const rawModels = value.models.allowlist;
    const models = document.models.allowlist;
    if (
      (rawModels === null) !== (models === null) ||
      (Array.isArray(rawModels) &&
        models !== null &&
        (rawModels.length !== models.length ||
          rawModels.some((item, index) => {
            const canonical = models[index];
            return (
              !isObject(item) ||
              item.provider !== canonical.provider ||
              item.model !== canonical.model
            );
          })))
    ) {
      failure("canonicalization_mismatch");
    }
    const rawTools = value.tools.allowlist;
    const tools = document.tools.allowlist;
    if (
      (rawTools === null) !== (tools === null) ||
      (Array.isArray(rawTools) &&
        tools !== null &&
        (rawTools.length !== tools.length ||
          rawTools.some((item, index) => item !== tools[index])))
    ) {
      failure("canonicalization_mismatch");
    }
  }
  const canonicalJson = JSON.stringify({
    schema_version: 1,
    models: { allowlist: document.models.allowlist },
    tools: { allowlist: document.tools.allowlist },
    experience_candidates: { mode: document.experienceCandidates.mode },
    official_agents: { installation: document.officialAgents.installation },
  });
  return {
    document,
    canonicalJson,
    contentDigest: createHash("sha256")
      .update(canonicalJson, "utf8")
      .digest("hex"),
  };
}

function parseKeySet(value: unknown): TrustedOrganizationKey[] {
  if (
    !exactObject(value, ["keys"]) ||
    !Array.isArray(value.keys) ||
    value.keys.length < 5 ||
    value.keys.length > 64
  ) {
    failure("invalid_signing_keys");
  }
  const result: TrustedOrganizationKey[] = [];
  const seen = new Set<string>();
  for (const candidate of value.keys) {
    if (
      !exactObject(candidate, [
        "kid",
        "kty",
        "crv",
        "alg",
        "use",
        "purpose",
        "x",
      ]) ||
      typeof candidate.kid !== "string" ||
      !KEY_ID_PATTERN.test(candidate.kid) ||
      candidate.kty !== "OKP" ||
      candidate.crv !== "Ed25519" ||
      candidate.alg !== "EdDSA" ||
      candidate.use !== "sig" ||
      (candidate.purpose !== "access" &&
        candidate.purpose !== "offline_entitlement" &&
        candidate.purpose !== "agent_version" &&
        candidate.purpose !== "agent_policy" &&
        candidate.purpose !== "organization_policy") ||
      !isCanonicalBase64URL(candidate.x, PUBLIC_KEY_PATTERN, 32)
    ) {
      failure("invalid_signing_keys");
    }
    const identifier = `${candidate.purpose}\0${candidate.kid}`;
    if (seen.has(identifier)) failure("invalid_signing_keys");
    seen.add(identifier);
    result.push({
      kid: candidate.kid,
      purpose: candidate.purpose,
      raw: Buffer.from(candidate.x, "base64url"),
    });
  }
  return result;
}

function requireFullSnapshot(value: unknown): OrganizationPolicySnapshot & {
  document: OrganizationPolicyDocument;
  signature: string;
} {
  if (
    !exactObject(value, [
      "id",
      "policyVersion",
      "schemaVersion",
      "contentDigest",
      "issuer",
      "signingKeyId",
      "createdAt",
      "document",
      "signature",
    ]) ||
    typeof value.id !== "string" ||
    !UUID_PATTERN.test(value.id) ||
    value.id === "00000000-0000-0000-0000-000000000000" ||
    !Number.isSafeInteger(value.policyVersion) ||
    Number(value.policyVersion) <= 0 ||
    typeof value.contentDigest !== "string" ||
    !DIGEST_PATTERN.test(value.contentDigest) ||
    typeof value.issuer !== "string" ||
    typeof value.signingKeyId !== "string" ||
    !KEY_ID_PATTERN.test(value.signingKeyId) ||
    !isCanonicalTimestamp(value.createdAt) ||
    value.document === null ||
    !isCanonicalBase64URL(value.signature, SIGNATURE_PATTERN, 64)
  ) {
    failure("invalid_snapshot");
  }
  if (value.schemaVersion !== 1) failure("schema_mismatch");
  return value as unknown as OrganizationPolicySnapshot & {
    document: OrganizationPolicyDocument;
    signature: string;
  };
}

export class AgenteraOrganizationPolicyVerifier {
  readonly origin: string;

  constructor(options: AgenteraOrganizationPolicyVerifierOptions) {
    try {
      this.origin = parseAgenteraCloudOrigin(options.origin);
    } catch {
      throw new Error("Aera Organization policy verifier is invalid.");
    }
  }

  verify(
    input: OrganizationPolicyVerificationInput,
  ): VerifiedOrganizationPolicySnapshot {
    if (
      !exactObject(input, ["organizationId", "snapshot", "keySet"]) ||
      typeof input.organizationId !== "string" ||
      !UUID_PATTERN.test(input.organizationId) ||
      input.organizationId === "00000000-0000-0000-0000-000000000000"
    ) {
      failure("invalid_snapshot");
    }
    const snapshot = requireFullSnapshot(input.snapshot);
    if (snapshot.issuer !== this.origin) failure("issuer_mismatch");
    const canonical = canonicalizeOrganizationPolicyDocument(
      snapshot.document,
      { requireCanonical: true },
    );
    if (canonical.contentDigest !== snapshot.contentDigest) {
      failure("digest_mismatch");
    }
    const keys = parseKeySet(input.keySet);
    const key = keys.find(
      (candidate) =>
        candidate.kid === snapshot.signingKeyId &&
        candidate.purpose === "organization_policy",
    );
    if (!key) {
      if (keys.some((candidate) => candidate.kid === snapshot.signingKeyId)) {
        failure("signing_purpose_mismatch");
      }
      failure("unknown_signing_key");
    }
    let publicKey;
    try {
      publicKey = createPublicKey({
        key: Buffer.concat([SPKI_PREFIX, key.raw]),
        format: "der",
        type: "spki",
      });
    } catch {
      failure("invalid_signing_keys");
    }
    const payload = Buffer.from(
      `agentera-organization-policy-v1\0${input.organizationId}\0${snapshot.id}\0${snapshot.policyVersion}\0${snapshot.contentDigest}`,
      "utf8",
    );
    if (
      !verifySignature(
        null,
        payload,
        publicKey,
        Buffer.from(snapshot.signature, "base64url"),
      )
    ) {
      failure("signature_invalid");
    }
    const verifiedSnapshot = {
      ...snapshot,
      document: canonical.document,
      signature: snapshot.signature,
    };
    return {
      organizationId: input.organizationId,
      snapshot: verifiedSnapshot,
      canonicalJson: canonical.canonicalJson,
      contentDigest: canonical.contentDigest,
    };
  }
}
