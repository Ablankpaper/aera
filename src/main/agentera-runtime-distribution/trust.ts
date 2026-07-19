import { createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  RuntimeProtocolError,
  parseJsonObjectRejectDuplicates,
  requireExactObjectFields,
  validateRuntimeKeyId,
} from "./manifest";

const TRUST_FIELDS = ["schema_version", "keys"] as const;
const TRUST_KEY_FIELDS = ["key_id", "algorithm", "public_key_pem"] as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasPublicKeyPemEnvelope(value: string): boolean {
  const lines = value.replaceAll("\r\n", "\n").trimEnd().split("\n");
  return (
    lines.length >= 3 &&
    lines[0] === "-----BEGIN PUBLIC KEY-----" &&
    lines.at(-1) === "-----END PUBLIC KEY-----" &&
    lines.slice(1, -1).every((line) => /^[A-Za-z0-9+/]+={0,2}$/.test(line))
  );
}

export function parseRuntimeTrustDocument(
  raw: Buffer,
): ReadonlyMap<string, string> {
  const document = parseJsonObjectRejectDuplicates(
    raw,
    "Runtime trust document",
  );
  requireExactObjectFields(document, TRUST_FIELDS, "Runtime trust document");
  if (document.schema_version !== 1) {
    throw new RuntimeProtocolError(
      "unsupported Runtime trust document schema_version",
    );
  }
  if (!Array.isArray(document.keys) || document.keys.length === 0) {
    throw new RuntimeProtocolError(
      "Runtime trust document keys must be a non-empty array",
    );
  }
  const trustedKeys = new Map<string, string>();
  for (const [index, item] of document.keys.entries()) {
    const label = `Runtime trust document keys[${index}]`;
    if (!isObject(item)) {
      throw new RuntimeProtocolError(`${label} must be an object`);
    }
    requireExactObjectFields(item, TRUST_KEY_FIELDS, label);
    if (typeof item.key_id !== "string") {
      throw new RuntimeProtocolError(`${label}.key_id must be a string`);
    }
    validateRuntimeKeyId(item.key_id);
    if (item.algorithm !== "Ed25519") {
      throw new RuntimeProtocolError(`${label} uses an unsupported algorithm`);
    }
    if (
      typeof item.public_key_pem !== "string" ||
      item.public_key_pem.length === 0
    ) {
      throw new RuntimeProtocolError(
        `${label}.public_key_pem must be a non-empty string`,
      );
    }
    if (!hasPublicKeyPemEnvelope(item.public_key_pem)) {
      throw new RuntimeProtocolError(
        `${label}.public_key_pem must contain a public key PEM envelope`,
      );
    }
    if (trustedKeys.has(item.key_id)) {
      throw new RuntimeProtocolError(
        `duplicate Runtime trust key id: ${item.key_id}`,
      );
    }
    let publicKey;
    try {
      publicKey = createPublicKey(item.public_key_pem);
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
    trustedKeys.set(item.key_id, item.public_key_pem);
  }
  return trustedKeys;
}

export function loadRuntimeTrustFile(
  path: string,
): ReadonlyMap<string, string> {
  let raw: Buffer;
  try {
    raw = readFileSync(path);
  } catch (error) {
    throw new RuntimeProtocolError("cannot read Runtime trust document", {
      cause: error,
    });
  }
  return parseRuntimeTrustDocument(raw);
}
