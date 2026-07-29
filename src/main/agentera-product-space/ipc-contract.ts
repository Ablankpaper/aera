import type {
  ProductSpaceErrorCode,
  ProductSpaceOption,
  ProductSpacePublicState,
  ProductSpaceResult,
  ProductSpaceSelection,
} from "../../shared/agentera-product-space";
import type { ProductSpaceSelectionInput } from "./manager";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function invalidRequest(): Error {
  return Object.assign(new Error("Invalid Aera product-space request."), {
    code: "invalid_request",
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function exactObject(
  value: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  if (!isPlainObject(value)) throw invalidRequest();
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (
    actual.length !== expected.length ||
    actual.some((field, index) => field !== expected[index])
  ) {
    throw invalidRequest();
  }
  return value;
}

function requireUUID(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw invalidRequest();
  }
  return value;
}

function requireDisplayName(value: unknown): string {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    value.length < 1 ||
    value.length > 256
  ) {
    throw invalidRequest();
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
    ) {
      throw invalidRequest();
    }
  }
  return value;
}

function requireWorkspaceRole(value: unknown): "owner" | "admin" | "member" {
  if (value !== "owner" && value !== "admin" && value !== "member") {
    throw invalidRequest();
  }
  return value;
}

function requireOrganizationRole(
  value: unknown,
): "owner" | "admin" | "auditor" | "member" {
  if (
    value !== "owner" &&
    value !== "admin" &&
    value !== "auditor" &&
    value !== "member"
  ) {
    throw invalidRequest();
  }
  return value;
}

export function parseProductSpaceSelectionInput(
  value: unknown,
): ProductSpaceSelectionInput {
  if (!isPlainObject(value)) throw invalidRequest();
  switch (value.kind) {
    case "PERSONAL":
      exactObject(value, ["kind"]);
      return { kind: "PERSONAL" };
    case "WORKSPACE": {
      const object = exactObject(value, ["kind", "workspaceId"]);
      return {
        kind: "WORKSPACE",
        workspaceId: requireUUID(object.workspaceId),
      };
    }
    case "ORGANIZATION": {
      const object = exactObject(value, ["kind", "organizationId"]);
      return {
        kind: "ORGANIZATION",
        organizationId: requireUUID(object.organizationId),
      };
    }
    default:
      throw invalidRequest();
  }
}

function serializeSelection(value: unknown): ProductSpaceSelection {
  if (!isPlainObject(value)) throw invalidRequest();
  switch (value.kind) {
    case "PERSONAL":
      exactObject(value, ["kind"]);
      return { kind: "PERSONAL" };
    case "WORKSPACE": {
      const object = exactObject(value, ["kind", "role", "workspaceId"]);
      return {
        kind: "WORKSPACE",
        workspaceId: requireUUID(object.workspaceId),
        role: requireWorkspaceRole(object.role),
      };
    }
    case "ORGANIZATION": {
      const object = exactObject(value, ["kind", "organizationId", "role"]);
      return {
        kind: "ORGANIZATION",
        organizationId: requireUUID(object.organizationId),
        role: requireOrganizationRole(object.role),
      };
    }
    default:
      throw invalidRequest();
  }
}

function serializeOption(value: unknown): ProductSpaceOption {
  if (!isPlainObject(value)) throw invalidRequest();
  switch (value.kind) {
    case "PERSONAL":
      exactObject(value, ["kind"]);
      return { kind: "PERSONAL" };
    case "WORKSPACE": {
      const object = exactObject(value, [
        "displayName",
        "kind",
        "role",
        "workspaceId",
      ]);
      return {
        kind: "WORKSPACE",
        workspaceId: requireUUID(object.workspaceId),
        displayName: requireDisplayName(object.displayName),
        role: requireWorkspaceRole(object.role),
      };
    }
    case "ORGANIZATION": {
      const object = exactObject(value, [
        "displayName",
        "kind",
        "organizationId",
        "role",
      ]);
      return {
        kind: "ORGANIZATION",
        organizationId: requireUUID(object.organizationId),
        displayName: requireDisplayName(object.displayName),
        role: requireOrganizationRole(object.role),
      };
    }
    default:
      throw invalidRequest();
  }
}

function selectionKey(
  value: ProductSpaceSelection | ProductSpaceOption,
): string {
  switch (value.kind) {
    case "PERSONAL":
      return "PERSONAL";
    case "WORKSPACE":
      return `WORKSPACE\0${value.workspaceId}`;
    case "ORGANIZATION":
      return `ORGANIZATION\0${value.organizationId}`;
  }
}

export function serializeProductSpacePublicState(
  value: ProductSpacePublicState,
): ProductSpacePublicState {
  const object = exactObject(value, ["access", "options", "selected", "stale"]);
  if (
    (object.access !== "online" && object.access !== "offline") ||
    typeof object.stale !== "boolean" ||
    !Array.isArray(object.options)
  ) {
    throw invalidRequest();
  }
  const selected = serializeSelection(object.selected);
  const options = object.options.map(serializeOption);
  const keys = options.map(selectionKey);
  if (
    keys[0] !== "PERSONAL" ||
    new Set(keys).size !== keys.length ||
    !keys.includes(selectionKey(selected))
  ) {
    throw invalidRequest();
  }
  return {
    access: object.access,
    stale: object.stale,
    selected,
    options,
  };
}

const STABLE_CODES = new Set<ProductSpaceErrorCode>([
  "unauthenticated",
  "invalid_request",
  "selection_unavailable",
  "closed",
  "online_required",
  "service_unavailable",
]);

function mapProductSpaceError(error: unknown): ProductSpaceErrorCode {
  let code = "";
  try {
    if (
      error !== null &&
      typeof error === "object" &&
      typeof (error as { code?: unknown }).code === "string"
    ) {
      code = (error as { code: string }).code;
    }
  } catch {
    return "service_unavailable";
  }
  if (STABLE_CODES.has(code as ProductSpaceErrorCode)) {
    return code as ProductSpaceErrorCode;
  }
  if (
    code === "sign_in_required" ||
    code === "authentication_required" ||
    code === "invalid_credentials"
  ) {
    return "unauthenticated";
  }
  if (code.startsWith("invalid_")) return "invalid_request";
  return "service_unavailable";
}

export async function executeProductSpaceIpc<T>(
  task: () => T | Promise<T>,
): Promise<ProductSpaceResult<T>> {
  try {
    return { ok: true, data: await task() };
  } catch (error) {
    return { ok: false, errorCode: mapProductSpaceError(error) };
  }
}
