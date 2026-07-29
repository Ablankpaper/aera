import { createPublicKey, verify } from "node:crypto";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const TOKEN_MAX_LENGTH = 8192;
const OFFLINE_LIFETIME_SECONDS = 7 * 24 * 60 * 60;
const FUTURE_ISSUE_TOLERANCE_SECONDS = 60;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

const HEADER_KEYS = ["alg", "kid", "typ"] as const;
const PAYLOAD_KEYS = [
  "aud",
  "device_id",
  "exp",
  "iat",
  "installation_id",
  "iss",
  "jti",
  "personal_space_id",
  "policy_version",
  "sub",
] as const;

export interface AgenteraOfflineEntitlementBinding {
  userId: string;
  deviceId: string;
  installationId: string;
  personalSpaceId: string;
}

export interface AgenteraOfflineEntitlementClaims extends AgenteraOfflineEntitlementBinding {
  keyId: string;
  jti: string;
  policyVersion: number;
  issuedAt: string;
  expiresAt: string;
}

export interface VerifyAgenteraOfflineEntitlementOptions {
  serialized: string;
  issuer: string;
  audience: string;
  publicKeys: Readonly<Record<string, string>>;
  expectedBinding: AgenteraOfflineEntitlementBinding;
  expectedExpiresAt: string;
  now: Date;
}

export class AgenteraOfflineEntitlementError extends Error {
  readonly code: "invalid" | "expired";

  constructor(code: "invalid" | "expired") {
    super(
      code === "expired"
        ? "Aera offline entitlement is expired."
        : "Aera offline entitlement is invalid.",
    );
    this.name = "AgenteraOfflineEntitlementError";
    this.code = code;
  }
}

function invalid(): never {
  throw new AgenteraOfflineEntitlementError("invalid");
}

function decodeCanonicalBase64Url(value: string): Buffer {
  if (
    value.length === 0 ||
    !BASE64URL_PATTERN.test(value) ||
    value.length % 4 === 1
  ) {
    return invalid();
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length === 0 || decoded.toString("base64url") !== value) {
    return invalid();
  }
  return decoded;
}

function parseStrictObject(
  encoded: string,
  expectedKeys: readonly string[],
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeCanonicalBase64Url(encoded).toString("utf8"));
  } catch (error) {
    if (error instanceof AgenteraOfflineEntitlementError) throw error;
    return invalid();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return invalid();
  }
  const record = parsed as Record<string, unknown>;
  if (
    Object.keys(record).sort().join("\0") !==
    [...expectedKeys].sort().join("\0")
  ) {
    return invalid();
  }
  return record;
}

function canonicalDate(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    return invalid();
  }
  return value;
}

function validUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function validUnixSeconds(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/**
 * Verify a cloud-issued offline exception without consulting the network.
 * Every claim is allowlisted and bound to the current product session plus
 * the stable installation key; a copied token therefore cannot authorize a
 * different installation.
 */
export function verifyAgenteraOfflineEntitlement(
  options: VerifyAgenteraOfflineEntitlementOptions,
): AgenteraOfflineEntitlementClaims {
  if (
    typeof options.serialized !== "string" ||
    options.serialized.length === 0 ||
    options.serialized.length > TOKEN_MAX_LENGTH ||
    options.serialized.split(".").length !== 3 ||
    !Number.isFinite(options.now.getTime())
  ) {
    return invalid();
  }

  const [encodedHeader, encodedPayload, encodedSignature] =
    options.serialized.split(".");
  const header = parseStrictObject(encodedHeader, HEADER_KEYS);
  if (
    header.alg !== "EdDSA" ||
    header.typ !== "agentera-offline-entitlement+jwt" ||
    typeof header.kid !== "string" ||
    header.kid.trim() === "" ||
    header.kid.length > 128
  ) {
    return invalid();
  }

  const rawPublicKey = options.publicKeys[header.kid];
  if (typeof rawPublicKey !== "string") return invalid();
  const publicKeyBytes = decodeCanonicalBase64Url(rawPublicKey);
  if (publicKeyBytes.length !== 32) return invalid();
  const signature = decodeCanonicalBase64Url(encodedSignature);
  if (signature.length !== 64) return invalid();

  let publicKey;
  try {
    publicKey = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, publicKeyBytes]),
      format: "der",
      type: "spki",
    });
  } catch {
    return invalid();
  }
  if (
    !verify(
      null,
      Buffer.from(`${encodedHeader}.${encodedPayload}`, "utf8"),
      publicKey,
      signature,
    )
  ) {
    return invalid();
  }

  const payload = parseStrictObject(encodedPayload, PAYLOAD_KEYS);
  if (
    payload.iss !== options.issuer ||
    payload.aud !== options.audience ||
    !validUuid(payload.jti) ||
    !validUuid(payload.sub) ||
    !validUuid(payload.device_id) ||
    !validUuid(payload.installation_id) ||
    !validUuid(payload.personal_space_id) ||
    typeof payload.policy_version !== "number" ||
    !Number.isSafeInteger(payload.policy_version) ||
    payload.policy_version <= 0 ||
    !validUnixSeconds(payload.iat) ||
    !validUnixSeconds(payload.exp) ||
    payload.exp - payload.iat !== OFFLINE_LIFETIME_SECONDS
  ) {
    return invalid();
  }

  const expected = options.expectedBinding;
  if (
    payload.sub !== expected.userId ||
    payload.device_id !== expected.deviceId ||
    payload.installation_id !== expected.installationId ||
    payload.personal_space_id !== expected.personalSpaceId
  ) {
    return invalid();
  }

  const issuedAtMs = payload.iat * 1000;
  const expiresAtMs = payload.exp * 1000;
  const expectedExpiresAt = canonicalDate(options.expectedExpiresAt);
  if (new Date(expiresAtMs).toISOString() !== expectedExpiresAt) {
    return invalid();
  }
  if (
    options.now.getTime() + FUTURE_ISSUE_TOLERANCE_SECONDS * 1000 <
    issuedAtMs
  ) {
    return invalid();
  }
  if (options.now.getTime() >= expiresAtMs) {
    throw new AgenteraOfflineEntitlementError("expired");
  }

  return {
    keyId: header.kid,
    jti: payload.jti,
    userId: payload.sub,
    deviceId: payload.device_id,
    installationId: payload.installation_id,
    personalSpaceId: payload.personal_space_id,
    policyVersion: payload.policy_version,
    issuedAt: new Date(issuedAtMs).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
}
