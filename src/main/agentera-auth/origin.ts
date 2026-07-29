import { isIP } from "node:net";

export interface AgenteraCloudOriginOptions {
  rechargePublicUrls?: readonly string[];
}

export function isAgenteraLoopbackHostname(hostname: string): boolean {
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
    throw new Error("Aera cloud origin is not configured.");
  }

  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new Error("Aera cloud origin is not a valid URL.");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error("Aera cloud origin cannot contain credentials.");
  }
  if (
    parsed.protocol !== "https:" &&
    !(
      parsed.protocol === "http:" && isAgenteraLoopbackHostname(parsed.hostname)
    )
  ) {
    throw new Error(
      "Aera cloud origin requires HTTPS except for loopback development.",
    );
  }
  if (parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") {
    throw new Error(
      "Aera cloud endpoint must be configured as an exact origin.",
    );
  }
  if (parsed.host === "") {
    throw new Error("Aera cloud origin is not a valid URL.");
  }

  for (const rechargeUrl of options.rechargePublicUrls ?? []) {
    if (rechargeUrl.trim() === "") continue;
    if (
      comparableOrigin(rechargeUrl, "Aera recharge origin") ===
      parsed.origin
    ) {
      throw new Error(
        "Aera cloud authentication cannot reuse the recharge-site origin.",
      );
    }
  }
  return parsed.origin;
}

/** Build one same-origin cloud URL without accepting absolute/host-relative input. */
export function agenteraCloudUrl(origin: string, path: string): URL {
  const normalizedOrigin = parseAgenteraCloudOrigin(origin);
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new Error(
      "Aera cloud path must remain on the configured origin.",
    );
  }
  const resolved = new URL(path, `${normalizedOrigin}/`);
  if (resolved.origin !== normalizedOrigin) {
    throw new Error(
      "Aera cloud path must remain on the configured origin.",
    );
  }
  return resolved;
}
