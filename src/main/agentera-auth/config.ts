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

/**
 * Trust roots are issuer-scoped. The local development key can therefore
 * validate the isolated loopback stack without ever authorizing a production
 * issuer. Production public keys are added here only during a reviewed key
 * ceremony; private signing material never enters this repository.
 */
export const BUNDLED_AGENTERA_OFFLINE_PUBLIC_KEYS: Readonly<
  Record<string, BundledAgenteraOfflinePublicKey>
> = Object.freeze({
  "offline-dev-v1": Object.freeze({
    publicKey: "C1E62bSSQBXKCQLtB5BE06xdvsIwbwaUjBDajrbjny0",
    allowedIssuers: Object.freeze(["http://127.0.0.1:8086"]),
  }),
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
    throw new Error("AgentEra cloud origin is not configured.");
  }
  return parseAgenteraCloudOrigin(configured, {
    rechargePublicUrls: sources.rechargePublicUrls,
  });
}

/** Resolve the independent AgentEra APP control-plane origin, runtime first. */
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
    throw new Error("AgentEra recharge URL is not configured.");
  }
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new Error("AgentEra recharge URL is invalid.");
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
      "AgentEra recharge URL requires HTTPS except for loopback development.",
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
