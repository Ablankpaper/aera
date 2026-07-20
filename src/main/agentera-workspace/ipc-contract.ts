import { randomUUID } from "node:crypto";
import type {
  AgenteraWorkspaceErrorCode,
  AgenteraWorkspaceResult,
  WorkspaceInvitation,
  WorkspaceInvitationAcceptance,
  WorkspaceInvitationCreation,
  WorkspaceMember,
  WorkspacePublicState,
  WorkspaceSummary,
} from "../../shared/agentera-workspace";
import {
  parseWorkspaceInvitation,
  parseWorkspaceMember,
  parseWorkspaceSummary,
} from "./client";
import type {
  ChangeWorkspaceMemberRoleInput,
  RemoveWorkspaceMemberInput,
  RenameWorkspaceInput,
  RevokeWorkspaceInvitationInput,
  WorkspaceIDInput,
  WorkspaceRevisionInput,
} from "./manager";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function invalidRequest(): Error {
  return Object.assign(new Error("Invalid AgentEra Workspace request."), {
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

function requireRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw invalidRequest();
  }
  return Number(value);
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
    ) {
      return true;
    }
  }
  return false;
}

function requireDisplayName(value: unknown): string {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    !isWellFormedUnicode(value) ||
    hasControlCharacter(value) ||
    Array.from(value).length < 1 ||
    Array.from(value).length > 80
  ) {
    throw invalidRequest();
  }
  return value;
}

function requireToken(value: unknown): string {
  if (typeof value !== "string" || !TOKEN_PATTERN.test(value)) {
    throw invalidRequest();
  }
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.length !== 32 || bytes.toString("base64url") !== value) {
      throw invalidRequest();
    }
  } catch {
    throw invalidRequest();
  }
  return value;
}

export function parseSelectWorkspaceInput(value: unknown): {
  workspaceId: string | null;
} {
  const object = exactObject(value, ["workspaceId"]);
  return {
    workspaceId:
      object.workspaceId === null ? null : requireUUID(object.workspaceId),
  };
}

export function parseCreateWorkspaceInput(value: unknown): {
  displayName: string;
} {
  const object = exactObject(value, ["displayName"]);
  return { displayName: requireDisplayName(object.displayName) };
}

export function parseRenameWorkspaceInput(
  value: unknown,
): RenameWorkspaceInput {
  const object = exactObject(value, [
    "displayName",
    "expectedRevision",
    "workspaceId",
  ]);
  return {
    workspaceId: requireUUID(object.workspaceId),
    displayName: requireDisplayName(object.displayName),
    expectedRevision: requireRevision(object.expectedRevision),
  };
}

export function parseWorkspaceRevisionInput(
  value: unknown,
): WorkspaceRevisionInput {
  const object = exactObject(value, ["expectedRevision", "workspaceId"]);
  return {
    workspaceId: requireUUID(object.workspaceId),
    expectedRevision: requireRevision(object.expectedRevision),
  };
}

export function parseWorkspaceIDInput(value: unknown): WorkspaceIDInput {
  const object = exactObject(value, ["workspaceId"]);
  return { workspaceId: requireUUID(object.workspaceId) };
}

export function parseChangeWorkspaceMemberRoleInput(
  value: unknown,
): ChangeWorkspaceMemberRoleInput {
  const object = exactObject(value, [
    "expectedRevision",
    "role",
    "userId",
    "workspaceId",
  ]);
  if (object.role !== "admin" && object.role !== "member") {
    throw invalidRequest();
  }
  return {
    workspaceId: requireUUID(object.workspaceId),
    userId: requireUUID(object.userId),
    role: object.role,
    expectedRevision: requireRevision(object.expectedRevision),
  };
}

export function parseRemoveWorkspaceMemberInput(
  value: unknown,
): RemoveWorkspaceMemberInput {
  const object = exactObject(value, [
    "expectedRevision",
    "userId",
    "workspaceId",
  ]);
  return {
    workspaceId: requireUUID(object.workspaceId),
    userId: requireUUID(object.userId),
    expectedRevision: requireRevision(object.expectedRevision),
  };
}

export function parseRevokeWorkspaceInvitationInput(
  value: unknown,
): RevokeWorkspaceInvitationInput {
  const object = exactObject(value, ["invitationId", "workspaceId"]);
  return {
    workspaceId: requireUUID(object.workspaceId),
    invitationId: requireUUID(object.invitationId),
  };
}

export function parseAcceptWorkspaceInvitationInput(value: unknown): {
  token: string;
} {
  const object = exactObject(value, ["token"]);
  return { token: requireToken(object.token) };
}

export function parseDismissWorkspaceInvitationInput(value: unknown): {
  token: string;
} {
  return parseAcceptWorkspaceInvitationInput(value);
}

export function createWorkspaceIdempotencyKey(
  generate: () => string = randomUUID,
): string {
  return requireUUID(generate());
}

export function serializeWorkspaceSummary(
  value: WorkspaceSummary,
): WorkspaceSummary {
  return parseWorkspaceSummary({
    id: value.id,
    display_name: value.displayName,
    status: value.status,
    revision: value.revision,
    mutation_state: value.mutationState,
    role: value.role,
    member_count: value.memberCount,
    created_at: value.createdAt,
    updated_at: value.updatedAt,
    ...(value.archivedAt === null ? {} : { archived_at: value.archivedAt }),
  });
}

export function serializeWorkspaceMember(
  value: WorkspaceMember,
): WorkspaceMember {
  return parseWorkspaceMember({
    user_id: value.userId,
    role: value.role,
    revision: value.revision,
    joined_at: value.joinedAt,
    ...(value.nickname === null ? {} : { nickname: value.nickname }),
  });
}

export function serializeWorkspaceInvitation(
  value: WorkspaceInvitation,
): WorkspaceInvitation {
  return parseWorkspaceInvitation({
    id: value.id,
    status: value.status,
    created_at: value.createdAt,
    expires_at: value.expiresAt,
    ...(value.createdByUserId === null
      ? {}
      : { created_by_user_id: value.createdByUserId }),
    ...(value.acceptedByUserId === null
      ? {}
      : { accepted_by_user_id: value.acceptedByUserId }),
    ...(value.acceptedAt === null ? {} : { accepted_at: value.acceptedAt }),
    ...(value.revokedAt === null ? {} : { revoked_at: value.revokedAt }),
  });
}

export function serializeWorkspaceInvitationCreation(
  value: WorkspaceInvitationCreation,
): WorkspaceInvitationCreation {
  if (value.secretReplayable !== false) throw invalidRequest();
  const invitation = serializeWorkspaceInvitation(value);
  const hasToken = value.token !== undefined;
  const hasURL = value.inviteUrl !== undefined;
  if (hasToken !== hasURL) throw invalidRequest();
  if (!hasToken) return { ...invitation, secretReplayable: false };
  const token = requireToken(value.token);
  if (value.inviteUrl !== `agentera://workspace-invitation#${token}`) {
    throw invalidRequest();
  }
  return {
    ...invitation,
    token,
    inviteUrl: value.inviteUrl,
    secretReplayable: false,
  };
}

export function serializeWorkspacePublicState(
  value: WorkspacePublicState,
): WorkspacePublicState {
  if (
    (value.access !== "online" && value.access !== "offline") ||
    typeof value.cloudAvailable !== "boolean" ||
    typeof value.stale !== "boolean" ||
    !Array.isArray(value.workspaces)
  ) {
    throw invalidRequest();
  }
  const userId = requireUUID(value.selected.userId);
  const selected =
    value.selected.kind === "personal"
      ? {
          kind: "personal" as const,
          userId,
          personalSpaceId: requireUUID(value.selected.personalSpaceId),
        }
      : value.selected.kind === "workspace" &&
          (value.selected.role === "owner" ||
            value.selected.role === "admin" ||
            value.selected.role === "member")
        ? {
            kind: "workspace" as const,
            userId,
            workspaceId: requireUUID(value.selected.workspaceId),
            role: value.selected.role,
          }
        : (() => {
            throw invalidRequest();
          })();
  return {
    access: value.access,
    cloudAvailable: value.cloudAvailable,
    stale: value.stale,
    selected,
    workspaces: value.workspaces.map(serializeWorkspaceSummary),
  };
}

export function serializeWorkspaceInvitationAcceptance(
  value: WorkspaceInvitationAcceptance,
): WorkspaceInvitationAcceptance {
  return {
    workspace: serializeWorkspaceSummary(value.workspace),
    member: serializeWorkspaceMember(value.member),
  };
}

const ERROR_MAP: Readonly<Record<string, AgenteraWorkspaceErrorCode>> = {
  unauthenticated: "unauthenticated",
  sign_in_required: "unauthenticated",
  session_revoked: "unauthenticated",
  online_required: "online_required",
  workspace_forbidden: "forbidden",
  workspace_not_found: "not_found",
  invitation_unavailable: "not_found",
  workspace_conflict: "conflict",
  membership_conflict: "conflict",
  idempotency_conflict: "conflict",
  workspace_archived: "archived",
  workspace_owner_unavailable: "owner_unavailable",
  workspace_limit_reached: "limit_reached",
  member_limit_reached: "limit_reached",
  invitation_limit_reached: "limit_reached",
  rate_limited: "rate_limited",
  service_unavailable: "cloud_unavailable",
  request_failed: "cloud_unavailable",
  invalid_response: "cloud_unavailable",
  invalid_request: "invalid_request",
};

function safeErrorCode(error: unknown): AgenteraWorkspaceErrorCode {
  try {
    if (typeof error !== "object" || error === null || !("code" in error)) {
      return "cloud_unavailable";
    }
    const code = (error as { code?: unknown }).code;
    return typeof code === "string"
      ? (ERROR_MAP[code] ?? "cloud_unavailable")
      : "cloud_unavailable";
  } catch {
    return "cloud_unavailable";
  }
}

export async function executeWorkspaceIpc<T, R = T>(
  action: () => T | Promise<T>,
  serialize?: (value: T) => R,
): Promise<AgenteraWorkspaceResult<R>> {
  try {
    const value = await action();
    return { ok: true, value: serialize ? serialize(value) : (value as R) };
  } catch (error) {
    return { ok: false, errorCode: safeErrorCode(error) };
  }
}
