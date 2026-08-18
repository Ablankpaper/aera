export const MODEL_ROUTE_KEY_VERSION = 2 as const;

export interface ModelRouteIdentityV2 {
  providerId: string;
  modelId: string;
  endpoint: string;
  apiMode: string;
}

function identityField(
  value: string,
  label: string,
  options: { allowEmpty?: boolean; lowercase?: boolean } = {},
): string {
  const normalized = value.trim();
  if (
    (!options.allowEmpty && normalized.length === 0) ||
    normalized.length > 4096 ||
    /[\0\r\n]/.test(normalized)
  ) {
    throw new Error(`Invalid model route ${label}.`);
  }
  return options.lowercase ? normalized.toLocaleLowerCase() : normalized;
}

/**
 * Canonical endpoint identity for new route keys.
 *
 * URL scheme and host are case-insensitive; path and query are not. Empty is
 * retained for the built-in `auto` route, while every non-empty endpoint must
 * be an HTTP(S) URL without credentials or a fragment.
 */
export function canonicalModelEndpointV2(value: string): string {
  const raw = identityField(value, "endpoint", { allowEmpty: true });
  if (!raw) return "";

  let endpoint: URL;
  try {
    endpoint = new URL(raw);
  } catch {
    throw new Error("Invalid model route endpoint.");
  }
  if (
    (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") ||
    endpoint.username.length > 0 ||
    endpoint.password.length > 0 ||
    endpoint.hash.length > 0
  ) {
    throw new Error("Invalid model route endpoint.");
  }

  endpoint.protocol = endpoint.protocol.toLocaleLowerCase();
  endpoint.hostname = endpoint.hostname.toLocaleLowerCase();
  if (
    (endpoint.protocol === "http:" && endpoint.port === "80") ||
    (endpoint.protocol === "https:" && endpoint.port === "443")
  ) {
    endpoint.port = "";
  }
  const pathname =
    endpoint.pathname === "/" ? "" : endpoint.pathname.replace(/\/+$/, "");
  return `${endpoint.protocol}//${endpoint.host}${pathname}${endpoint.search}`;
}

function stableProvider(value: string): string {
  return identityField(value, "provider identity", { lowercase: true });
}

function stableModel(value: string): string {
  return identityField(value, "model identity", { allowEmpty: true });
}

function stableMode(value: string): string {
  return identityField(value, "API mode", {
    allowEmpty: true,
    lowercase: true,
  });
}

export function routeKeyV2(route: ModelRouteIdentityV2): string {
  return [
    `v${MODEL_ROUTE_KEY_VERSION}`,
    stableProvider(route.providerId),
    stableModel(route.modelId),
    canonicalModelEndpointV2(route.endpoint),
    stableMode(route.apiMode),
  ].join("\0");
}

function parseModelRouteKeyV2(value: string): ModelRouteIdentityV2 | null {
  if (value.length === 0 || value.length > 4096 || /[\r\n]/.test(value)) {
    return null;
  }
  const fields = value.split("\0");
  if (fields.length !== 5 || fields[0] !== `v${MODEL_ROUTE_KEY_VERSION}`) {
    return null;
  }
  const route = {
    providerId: fields[1],
    modelId: fields[2],
    endpoint: fields[3],
    apiMode: fields[4],
  };
  try {
    return routeKeyV2(route) === value ? route : null;
  } catch {
    return null;
  }
}

/** The pre-Beta.33 normalizer is retained only for reading old journal rows. */
function legacyRouteKeyV1(route: ModelRouteIdentityV2): string {
  return [
    stableProvider(route.providerId),
    stableModel(route.modelId),
    identityField(route.endpoint, "legacy endpoint", {
      allowEmpty: true,
      lowercase: true,
    }).replace(/\/+$/, ""),
    stableMode(route.apiMode),
  ].join("\0");
}

export function isModelRouteKeyV2(value: unknown): value is string {
  return typeof value === "string" && parseModelRouteKeyV2(value) !== null;
}

export function isLegacyModelRouteKeyV1(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 4096 &&
    !/[\r\n]/.test(value) &&
    value.split("\0").length === 4
  );
}

export function routeKeyMatches(
  storedKey: string,
  route: ModelRouteIdentityV2,
): boolean {
  try {
    if (isModelRouteKeyV2(storedKey)) return storedKey === routeKeyV2(route);
    if (isLegacyModelRouteKeyV1(storedKey)) {
      return storedKey === legacyRouteKeyV1(route);
    }
    return false;
  } catch {
    return false;
  }
}

/** Match a stored V1/V2 journal key to the canonical V2 key read now. */
export function routeKeysMatch(
  storedKey: string,
  currentV2Key: string,
): boolean {
  const current = parseModelRouteKeyV2(currentV2Key);
  return current !== null && routeKeyMatches(storedKey, current);
}
