import { isIP } from "node:net";
import {
  agenteraCloudUrl as buildAgenteraCloudUrl,
  isAgenteraLoopbackHostname,
  parseAgenteraCloudOrigin as parseCloudOrigin,
  type AgenteraCloudOriginOptions,
} from "./origin";

export type { AgenteraCloudOriginOptions } from "./origin";

export function parseAgenteraCloudOrigin(
  raw: string,
  options: AgenteraCloudOriginOptions = {},
): string {
  return parseCloudOrigin(raw, options);
}

export interface AgenteraCloudOriginSources extends AgenteraCloudOriginOptions {
  runtimePublicUrl?: string;
  buildPublicUrl?: string;
}

export interface BundledAgenteraOfflinePublicKey {
  publicKey: string;
  allowedIssuers: readonly string[];
}

export interface AgenteraOfflinePublicKeyBuildSources {
  buildOfflinePublicKeysJson?: string;
  buildPublicUrl?: string;
}

const OFFLINE_TRUST_CONFIG_KEYS = ["issuer", "keys"] as const;
const OFFLINE_TRUST_KEY_KEYS = ["keyId", "publicKey"] as const;
const OFFLINE_KEY_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const CANONICAL_BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

const DEVELOPMENT_OFFLINE_PUBLIC_KEYS: Readonly<
  Record<string, BundledAgenteraOfflinePublicKey>
> = Object.freeze({
  "offline-dev-v1": Object.freeze({
    publicKey: "C1E62bSSQBXKCQLtB5BE06xdvsIwbwaUjBDajrbjny0",
    allowedIssuers: Object.freeze(["http://127.0.0.1:8086"]),
  }),
});

function assertExactObjectKeys(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Aera offline ${label} must be a JSON object.`);
  }
  if (
    Object.keys(value).sort().join("\0") !== [...expectedKeys].sort().join("\0")
  ) {
    throw new Error(`Aera offline ${label} contains an unknown field.`);
  }
}

function parseCanonicalHttpsIpIssuer(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error("Aera offline issuer is required.");
  }
  const issuer = parseAgenteraCloudOrigin(raw);
  const parsed = new URL(issuer);
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  if (parsed.protocol !== "https:" || isIP(hostname) === 0) {
    throw new Error(
      "Aera offline issuer must be a canonical HTTPS IP origin.",
    );
  }
  if (raw.trim() !== issuer) {
    throw new Error("Aera offline issuer must be a canonical origin.");
  }
  return issuer;
}

function parseEd25519PublicKey(raw: unknown): string {
  if (typeof raw !== "string" || !CANONICAL_BASE64URL_PATTERN.test(raw)) {
    throw new Error(
      "Aera offline public key must use canonical base64url.",
    );
  }
  const decoded = Buffer.from(raw, "base64url");
  if (decoded.length !== 32 || decoded.toString("base64url") !== raw) {
    throw new Error(
      "Aera offline public key must be a 32-byte Ed25519 key.",
    );
  }
  return raw;
}

/**
 * Parse only reviewed data baked into the Electron main-process bundle. This
 * intentionally has no process.env fallback: a packaged app cannot gain a new
 * entitlement issuer or public key at runtime.
 */
export function parseAgenteraOfflinePublicKeysBuildConfig(
  rawJson: string,
  buildPublicUrl: string | undefined,
): Readonly<Record<string, BundledAgenteraOfflinePublicKey>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new Error("Aera offline trust configuration is invalid JSON.");
  }
  assertExactObjectKeys(
    parsed,
    OFFLINE_TRUST_CONFIG_KEYS,
    "trust configuration",
  );

  const issuer = parseCanonicalHttpsIpIssuer(parsed.issuer);
  if (typeof buildPublicUrl !== "string" || buildPublicUrl.trim() === "") {
    throw new Error(
      "Aera Cloud build origin is required with offline trust keys.",
    );
  }
  const buildOrigin = parseAgenteraCloudOrigin(buildPublicUrl);
  if (buildPublicUrl.trim() !== buildOrigin || buildOrigin !== issuer) {
    throw new Error(
      "Aera Cloud build origin must exactly match the offline issuer.",
    );
  }
  if (!Array.isArray(parsed.keys) || parsed.keys.length === 0) {
    throw new Error("Aera offline trust configuration requires keys.");
  }

  const roots: Record<string, BundledAgenteraOfflinePublicKey> = {};
  for (const entry of parsed.keys) {
    assertExactObjectKeys(entry, OFFLINE_TRUST_KEY_KEYS, "key");
    if (
      typeof entry.keyId !== "string" ||
      !OFFLINE_KEY_ID_PATTERN.test(entry.keyId)
    ) {
      throw new Error("Aera offline key ID is invalid.");
    }
    if (Object.hasOwn(roots, entry.keyId)) {
      throw new Error("Aera offline key IDs must be unique.");
    }
    roots[entry.keyId] = Object.freeze({
      publicKey: parseEd25519PublicKey(entry.publicKey),
      allowedIssuers: Object.freeze([issuer]),
    });
  }
  return Object.freeze(roots);
}

export function resolveBundledAgenteraOfflinePublicKeys(
  sources: AgenteraOfflinePublicKeyBuildSources,
): Readonly<Record<string, BundledAgenteraOfflinePublicKey>> {
  const buildJson = sources.buildOfflinePublicKeysJson?.trim();
  const buildRoots = buildJson
    ? parseAgenteraOfflinePublicKeysBuildConfig(
        buildJson,
        sources.buildPublicUrl,
      )
    : {};
  for (const keyId of Object.keys(buildRoots)) {
    if (Object.hasOwn(DEVELOPMENT_OFFLINE_PUBLIC_KEYS, keyId)) {
      throw new Error(
        "Aera offline build key ID collides with development trust.",
      );
    }
  }
  return Object.freeze({
    ...DEVELOPMENT_OFFLINE_PUBLIC_KEYS,
    ...buildRoots,
  });
}

/**
 * Trust roots are issuer-scoped. The local development key can therefore
 * validate the isolated loopback stack without ever authorizing a production
 * issuer. Beta public keys enter only through reviewed Vite build inputs;
 * private signing material never enters this repository or the app bundle.
 */
export const BUNDLED_AGENTERA_OFFLINE_PUBLIC_KEYS: Readonly<
  Record<string, BundledAgenteraOfflinePublicKey>
> = resolveBundledAgenteraOfflinePublicKeys({
  buildOfflinePublicKeysJson: import.meta.env
    .MAIN_VITE_AGENTERA_OFFLINE_PUBLIC_KEYS_JSON,
  buildPublicUrl: import.meta.env.MAIN_VITE_AGENTERA_CLOUD_PUBLIC_URL,
});

export function getBundledAgenteraOfflinePublicKeys(
  issuer: string,
): Readonly<Record<string, string>> {
  const canonicalIssuer = parseAgenteraCloudOrigin(issuer);
  const selected: Record<string, string> = {};
  for (const [keyId, root] of Object.entries(
    BUNDLED_AGENTERA_OFFLINE_PUBLIC_KEYS,
  )) {
    if (root.allowedIssuers.includes(canonicalIssuer)) {
      selected[keyId] = root.publicKey;
    }
  }
  return Object.freeze(selected);
}

export function resolveAgenteraCloudOrigin(
  sources: AgenteraCloudOriginSources,
): string {
  const configured =
    sources.runtimePublicUrl?.trim() || sources.buildPublicUrl?.trim();
  if (!configured) {
    throw new Error("Aera cloud origin is not configured.");
  }
  return parseAgenteraCloudOrigin(configured, {
    rechargePublicUrls: sources.rechargePublicUrls,
  });
}

/** Resolve the independent Aera APP control-plane origin, runtime first. */
export function getAgenteraCloudOrigin(): string {
  return resolveAgenteraCloudOrigin({
    runtimePublicUrl:
      process.env.AGENTERA_CLOUD_PUBLIC_URL?.trim() ||
      process.env.MAIN_VITE_AGENTERA_CLOUD_PUBLIC_URL?.trim(),
    buildPublicUrl: import.meta.env.MAIN_VITE_AGENTERA_CLOUD_PUBLIC_URL?.trim(),
    rechargePublicUrls: [
      process.env.AGENTERA_RECHARGE_PUBLIC_URL ?? "",
      process.env.MAIN_VITE_AGENTERA_RECHARGE_PUBLIC_URL ?? "",
      import.meta.env.MAIN_VITE_AGENTERA_RECHARGE_PUBLIC_URL ?? "",
    ],
  });
}

export function parseAgenteraRechargePublicUrl(raw: string): string {
  if (raw.trim() === "") {
    throw new Error("Aera recharge URL is not configured.");
  }
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new Error("Aera recharge URL is invalid.");
  }
  if (
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.hash !== "" ||
    (parsed.protocol !== "https:" &&
      !(
        parsed.protocol === "http:" &&
        isAgenteraLoopbackHostname(parsed.hostname)
      ))
  ) {
    throw new Error(
      "Aera recharge URL requires HTTPS except for loopback development.",
    );
  }
  return parsed.href;
}

export function getAgenteraRechargePublicUrl(): string | null {
  const configured =
    process.env.AGENTERA_RECHARGE_PUBLIC_URL?.trim() ||
    process.env.MAIN_VITE_AGENTERA_RECHARGE_PUBLIC_URL?.trim() ||
    import.meta.env.MAIN_VITE_AGENTERA_RECHARGE_PUBLIC_URL?.trim();
  return configured ? parseAgenteraRechargePublicUrl(configured) : null;
}

export function agenteraCloudUrl(origin: string, path: string): URL {
  return buildAgenteraCloudUrl(origin, path);
}
