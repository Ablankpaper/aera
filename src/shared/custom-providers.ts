/**
 * A user-configured custom (OpenAI-compatible) LLM provider, persisted as a
 * first-class record in the desktop's per-profile `providers.json`.
 *
 * This store owns provider *identity* only — its name and base URL. The API key
 * still lives in the profile's `.env` (under `customProviderEnvKey(name)`, the
 * value never stored here) and the provider's models still live in the global
 * `models.json`. Keeping identity here is what lets a provider render as a card
 * the moment it is saved, before any model is added — previously the card was
 * re-derived solely from `models.json`, so a keyed-but-modelless provider was
 * invisible.
 */
export interface CustomProviderRecord {
  /** Stable id (uuid). */
  id: string;
  /** Display name; also the anchor from which the `.env` key name is derived. */
  name: string;
  /** OpenAI-compatible endpoint base URL. */
  baseUrl: string;
  /** Epoch ms the record was first created. */
  createdAt: number;
}

/** Stable public identity carried through coordinated model mutations. */
export type CustomProviderId = string;

/** Versioned on-disk envelope for `providers.json`. */
export interface CustomProviderFile {
  version: 1;
  providers: CustomProviderRecord[];
}

/** Match Hermes Agent's canonical normalisation for a named custom provider. */
export function normalizeCustomProviderRuntimeName(name: string): string {
  return (name || "").trim().toLowerCase().replace(/ /g, "-");
}

/** Durable provider identity understood by Hermes Agent's native resolver. */
export function customProviderRuntimeRoute(name: string): string {
  const normalized = normalizeCustomProviderRuntimeName(name);
  if (!normalized) throw new Error("Custom provider name is required.");
  return `custom:${normalized}`;
}

/** Normalized native name from `custom:<name>`, or null for non-named routes. */
export function namedCustomProviderRuntimeName(
  provider: string | null | undefined,
): string | null {
  const normalized = (provider || "").trim().toLowerCase();
  if (!normalized.startsWith("custom:")) return null;
  const name = normalized.slice("custom:".length).trim();
  return name || null;
}

/** True for either the legacy bare route or a native named custom route. */
export function isCustomProviderRoute(
  provider: string | null | undefined,
): boolean {
  const normalized = (provider || "").trim().toLowerCase();
  return (
    normalized === "custom" || namedCustomProviderRuntimeName(provider) !== null
  );
}
