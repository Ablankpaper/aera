import { URL_KEY_MAP } from "../shared/url-key-map";

/**
 * Shared URL → host-derived env-var lookup.
 *
 * This is a main-process wrapper around PR369's shared URL map. PR400
 * depends on PR369 so the desktop only maintains one provider URL table.
 */

/**
 * Return the canonical `<VENDOR>_API_KEY` env-var name for a base URL,
 * or null if the URL doesn't match a known vendor pattern.
 *
 * Used by both:
 *   - `hermes.ts` runtime spawn (CLI path) — writes the host-derived
 *     var into the child process env so a freshly-spawned hermes-agent
 *     can resolve the key.
 *   - `models.ts` custom-provider persistence — writes the host-derived
 *     var into `.env` so the long-running gateway (started from
 *     `.env`-only state) can resolve it without a respawn.
 *
 * Local LLM hosts (localhost, 127.0.0.1, RFC1918) and unknown commercial
 * hosts (e.g. unsloth.ai) intentionally return null — no vendor binding,
 * the upstream engine falls back to `no-key-required` for those.
 */
export function hostDerivedEnvKeyForUrl(baseUrl: string): string | null {
  for (const { pattern, envKey } of URL_KEY_MAP) {
    if (pattern.test(baseUrl)) return envKey;
  }
  return null;
}

/**
 * Return the env-var name Hermes Runtime derives for a plain custom endpoint.
 *
 * This intentionally mirrors
 * `hermes_cli.runtime_provider._host_derived_api_key`: it derives the vendor
 * from the parsed hostname (not a substring), rejects local/IP hosts, and
 * leaves OPENAI/OPENROUTER/OLLAMA to Runtime's explicit host-gated paths.
 * Keeping this separate from `hostDerivedEnvKeyForUrl` preserves that
 * function's narrower "known desktop provider" contract.
 */
export function runtimeHostDerivedEnvKeyForUrl(baseUrl: string): string | null {
  let hostname = "";
  try {
    hostname = new URL(baseUrl).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }

  if (!hostname || hostname === "localhost" || hostname.includes(":")) {
    return null;
  }

  const lastLabel = hostname.split(".").at(-1) || "";
  if (/\d/.test(lastLabel)) return null;

  const labels = hostname.split(".").filter(Boolean);
  while (labels[0] === "api" || labels[0] === "www") labels.shift();
  if (labels.length < 2) return null;

  const vendor = labels.at(-2) || "";
  const sanitized = vendor.replace(/[^A-Za-z0-9]/g, "_").toUpperCase();
  if (!/^[A-Z]/.test(sanitized)) return null;
  if (["OPENAI", "OPENROUTER", "OLLAMA"].includes(sanitized)) return null;

  return `${sanitized}_API_KEY`;
}

export function shouldPruneOpenRouterApiKey(
  hostDerivedEnvKey: string | null,
): boolean {
  return hostDerivedEnvKey !== "OPENROUTER_API_KEY";
}
