import { isIP } from "node:net";

export interface AgenteraCloudOriginOptions {
  rechargePublicUrls?: readonly string[];
}

export interface AgenteraCloudOriginSources extends AgenteraCloudOriginOptions {
  runtimePublicUrl?: string;
  buildPublicUrl?: string;
}

/**
 * Offline verification is fail-closed until a reviewed release adds its public
 * key IDs here. Development signing keys must never become desktop trust roots.
 */
export const BUNDLED_AGENTERA_OFFLINE_PUBLIC_KEYS: Readonly<
  Record<string, string>
> = Object.freeze({});

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (normalized === "localhost") return true;
  const family = isIP(normalized);
  if (family === 4) return normalized.split(".")[0] === "127";
  return family === 6 && normalized === "::1";
}

function comparableOrigin(raw: string, label: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new Error(`${label} is not a valid URL.`);
  }
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.host === ""
  ) {
    throw new Error(`${label} is not a valid HTTP origin.`);
  }
  return parsed.origin;
}

export function parseAgenteraCloudOrigin(
  raw: string,
  options: AgenteraCloudOriginOptions = {},
): string {
  if (raw.trim() === "") {
    throw new Error("AgentEra cloud origin is not configured.");
  }

  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new Error("AgentEra cloud origin is not a valid URL.");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error("AgentEra cloud origin cannot contain credentials.");
  }
  if (
    parsed.protocol !== "https:" &&
    !(parsed.protocol === "http:" && isLoopbackHostname(parsed.hostname))
  ) {
    throw new Error(
      "AgentEra cloud origin requires HTTPS except for loopback development.",
    );
  }
  if (parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") {
    throw new Error(
      "AgentEra cloud endpoint must be configured as an exact origin.",
    );
  }
  if (parsed.host === "") {
    throw new Error("AgentEra cloud origin is not a valid URL.");
  }

  for (const rechargeUrl of options.rechargePublicUrls ?? []) {
    if (rechargeUrl.trim() === "") continue;
    if (
      comparableOrigin(rechargeUrl, "AgentEra recharge origin") ===
      parsed.origin
    ) {
      throw new Error(
        "AgentEra cloud authentication cannot reuse the recharge-site origin.",
      );
    }
  }
  return parsed.origin;
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

/** Build one same-origin cloud URL without accepting absolute/host-relative input. */
export function agenteraCloudUrl(origin: string, path: string): URL {
  const normalizedOrigin = parseAgenteraCloudOrigin(origin);
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new Error(
      "AgentEra cloud path must remain on the configured origin.",
    );
  }
  const resolved = new URL(path, `${normalizedOrigin}/`);
  if (resolved.origin !== normalizedOrigin) {
    throw new Error(
      "AgentEra cloud path must remain on the configured origin.",
    );
  }
  return resolved;
}
