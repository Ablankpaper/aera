/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { createHash } from "node:crypto";

const OBSERVABLE_KEYS = [
  "MAIN_VITE_AGENTERA_CLOUD_PUBLIC_URL",
  "MAIN_VITE_AGENTERA_RECHARGE_PUBLIC_URL",
  "MAIN_VITE_HERMES_API_URL",
  "HERMES_HOME",
];

function present(env, key) {
  return typeof env?.[key] === "string" && env[key].trim().length > 0;
}

function relationHash(domain, value) {
  return createHash("sha256")
    .update(`${domain}\0${String(value)}`, "utf8")
    .digest("hex");
}

function safeVersion(value) {
  const text = String(value || "");
  return /^[0-9]+(?:\.[0-9A-Za-z-]+){0,5}$/.test(text) ? text : "unknown";
}

export function collectEnvironmentEvidence(env = process.env, runtime = {}) {
  const versions = runtime.versions || process.versions;
  return {
    status: "collected",
    reason: null,
    environment: {
      platform: String(runtime.platform || process.platform),
      architecture: String(runtime.arch || process.arch),
      versions: {
        electron: safeVersion(versions?.electron),
        node: safeVersion(versions?.node),
        modules: safeVersion(versions?.modules),
      },
      proxy: {
        http: present(env, "HTTP_PROXY") || present(env, "http_proxy"),
        https: present(env, "HTTPS_PROXY") || present(env, "https_proxy"),
        noProxy: present(env, "NO_PROXY") || present(env, "no_proxy"),
      },
      hermesHome: present(env, "HERMES_HOME"),
      keys: Object.fromEntries(
        OBSERVABLE_KEYS.map((key) => [key, present(env, key)]),
      ),
    },
  };
}

export function collectCloudOriginEvidence({
  env = process.env,
  logText = "",
} = {}) {
  const raw = String(env?.MAIN_VITE_AGENTERA_CLOUD_PUBLIC_URL || "").trim();
  const reportedUnavailable =
    /Aera cloud origin is not configured|Internal Beta update origin is unavailable/i.test(
      String(logText),
    );
  if (!raw) {
    return {
      status: "missing",
      reason: reportedUnavailable
        ? "cloud_origin_reported_unavailable"
        : "cloud_origin_not_observable",
      configured: false,
      reportedUnavailable,
      originSha256: null,
    };
  }
  try {
    const url = new URL(raw);
    if (
      !new Set(["http:", "https:"]).has(url.protocol) ||
      url.username ||
      url.password
    ) {
      throw new Error("invalid cloud origin");
    }
    const normalized = `${url.protocol}//${url.host.toLowerCase()}`;
    return {
      status: "collected",
      reason: null,
      configured: true,
      reportedUnavailable,
      originSha256: relationHash("aera-diagnostic-cloud-origin-v1", normalized),
    };
  } catch {
    return {
      status: "failed",
      reason: "cloud_origin_invalid",
      configured: true,
      reportedUnavailable,
      originSha256: null,
    };
  }
}
