import type { SessionModelOverride } from "../../shared/model-override";
import { isLocalBaseUrl } from "../../shared/url-key-map";
import type { ResolvedOwnerModelRoute } from "./owner-model-route-catalog";

const LEGACY_FIELDS = ["provider", "model", "baseUrl"] as const;
const FROZEN_FIELDS = [
  "provider",
  "model",
  "baseUrl",
  "apiMode",
  "sourceProfileId",
  "modelLibraryId",
  "credentialRef",
  "legacy",
] as const;
const CREDENTIAL_REFERENCE_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;

export interface FrozenAgentModelRoute {
  provider: string;
  model: string;
  baseUrl: string;
  apiMode: string | null;
  sourceProfileId: string | null;
  modelLibraryId: string | null;
  credentialRef: string | null;
  legacy: boolean;
}

export type FrozenAgentModelRouteErrorCode =
  | "invalid_binding"
  | "binding_corrupt";

export class FrozenAgentModelRouteError extends Error {
  readonly code: FrozenAgentModelRouteErrorCode;

  constructor(code: FrozenAgentModelRouteErrorCode) {
    super(`Aera frozen Agent model route failed: ${code}.`);
    this.name = "FrozenAgentModelRouteError";
    this.code = code;
  }
}

function exactKeys(value: object, fields: readonly string[]): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field))
  );
}

function boundedText(
  value: unknown,
  maximum: number,
  code: FrozenAgentModelRouteErrorCode,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > maximum ||
    /[\0\r\n]/.test(value)
  ) {
    throw new FrozenAgentModelRouteError(code);
  }
  const normalized = value.trim();
  if (!normalized) throw new FrozenAgentModelRouteError(code);
  return normalized;
}

function nullableText(
  value: unknown,
  maximum: number,
  code: FrozenAgentModelRouteErrorCode,
): string | null {
  return value === null ? null : boundedText(value, maximum, code);
}

function opaqueIdentifier(
  value: unknown,
  maximum: number,
  code: FrozenAgentModelRouteErrorCode,
): string {
  const identifier = boundedText(value, maximum, code);
  if (
    identifier.includes("/") ||
    identifier.includes("\\") ||
    identifier === "." ||
    identifier === ".." ||
    identifier.includes("../") ||
    identifier.includes("..\\")
  ) {
    throw new FrozenAgentModelRouteError(code);
  }
  return identifier;
}

function baseUrl(value: unknown, code: FrozenAgentModelRouteErrorCode): string {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") > 2_048 ||
    /[\0\r\n]/.test(value)
  ) {
    throw new FrozenAgentModelRouteError(code);
  }
  const normalized = value.trim();
  if (!normalized) return "";
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new FrozenAgentModelRouteError(code);
  }
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new FrozenAgentModelRouteError(code);
  }
  return normalized;
}

function apiMode(
  value: unknown,
  code: FrozenAgentModelRouteErrorCode,
): string | null {
  const normalized = nullableText(value, 64, code);
  if (
    normalized !== null &&
    !/^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/.test(normalized)
  ) {
    throw new FrozenAgentModelRouteError(code);
  }
  return normalized;
}

function credentialReference(
  value: unknown,
  code: FrozenAgentModelRouteErrorCode,
): string | null {
  if (value === null) return null;
  const reference = boundedText(value, 128, code);
  if (!CREDENTIAL_REFERENCE_PATTERN.test(reference)) {
    throw new FrozenAgentModelRouteError(code);
  }
  return reference;
}

function commonRoute(
  value: Record<string, unknown>,
  code: FrozenAgentModelRouteErrorCode,
): Pick<FrozenAgentModelRoute, "provider" | "model" | "baseUrl"> {
  const provider = boundedText(value.provider, 128, code);
  if (provider.toLocaleLowerCase() === "auto") {
    throw new FrozenAgentModelRouteError(code);
  }
  return {
    provider,
    model: boundedText(value.model, 512, code),
    baseUrl: baseUrl(value.baseUrl, code),
  };
}

function parseRoute(
  value: unknown,
  code: FrozenAgentModelRouteErrorCode,
): FrozenAgentModelRoute {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new FrozenAgentModelRouteError(code);
  }
  const record = value as Record<string, unknown>;
  if (exactKeys(record, LEGACY_FIELDS)) {
    return {
      ...commonRoute(record, code),
      apiMode: null,
      sourceProfileId: null,
      modelLibraryId: null,
      credentialRef: null,
      legacy: true,
    };
  }
  if (!exactKeys(record, FROZEN_FIELDS)) {
    throw new FrozenAgentModelRouteError(code);
  }
  if (typeof record.legacy !== "boolean") {
    throw new FrozenAgentModelRouteError(code);
  }
  const parsed: FrozenAgentModelRoute = {
    ...commonRoute(record, code),
    apiMode: apiMode(record.apiMode, code),
    sourceProfileId:
      record.sourceProfileId === null
        ? null
        : opaqueIdentifier(record.sourceProfileId, 64, code),
    modelLibraryId:
      record.modelLibraryId === null
        ? null
        : opaqueIdentifier(record.modelLibraryId, 512, code),
    credentialRef: credentialReference(record.credentialRef, code),
    legacy: record.legacy,
  };
  const hasSource = parsed.sourceProfileId !== null;
  const hasModel = parsed.modelLibraryId !== null;
  if (hasSource !== hasModel) throw new FrozenAgentModelRouteError(code);
  if (
    parsed.legacy &&
    (hasSource || parsed.apiMode !== null || parsed.credentialRef !== null)
  ) {
    throw new FrozenAgentModelRouteError(code);
  }
  if (!parsed.legacy && !hasSource) {
    throw new FrozenAgentModelRouteError(code);
  }
  return parsed;
}

export function freezeResolvedOwnerModelRoute(
  route: ResolvedOwnerModelRoute,
): FrozenAgentModelRoute {
  if (route?.credentialAvailable === false) {
    throw new FrozenAgentModelRouteError("invalid_binding");
  }
  const frozen = parseRoute(
    {
      provider: route?.provider,
      model: route?.model,
      baseUrl: route?.baseUrl,
      apiMode: route?.apiMode,
      sourceProfileId: route?.sourceProfileId,
      modelLibraryId: route?.modelLibraryId,
      credentialRef: route?.credentialRef,
      legacy: false,
    },
    "invalid_binding",
  );
  if (frozen.credentialRef === null && !isLocalBaseUrl(frozen.baseUrl)) {
    throw new FrozenAgentModelRouteError("invalid_binding");
  }
  return frozen;
}

export function parseFrozenAgentModelRoute(
  value: unknown,
): FrozenAgentModelRoute {
  return parseRoute(value, "binding_corrupt");
}

export function serializeFrozenAgentModelRoute(
  route: FrozenAgentModelRoute,
): string {
  return JSON.stringify(parseFrozenAgentModelRoute(route));
}

export function sessionModelOverrideFromFrozenRoute(
  route: FrozenAgentModelRoute,
): SessionModelOverride {
  const parsed = parseFrozenAgentModelRoute(route);
  return {
    provider: parsed.provider,
    model: parsed.model,
    baseUrl: parsed.baseUrl,
  };
}
