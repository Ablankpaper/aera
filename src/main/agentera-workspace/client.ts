import type { components } from "../../shared/agentera-cloud-api.generated";
import type {
  WorkspaceInvitation,
  WorkspaceInvitationAcceptance,
  WorkspaceInvitationCreation,
  WorkspaceInvitationStatus,
  WorkspaceMember,
  WorkspaceMutationState,
  WorkspaceRole,
  WorkspaceStatus,
  WorkspaceSummary,
} from "../../shared/agentera-workspace";
import {
  agenteraCloudUrl,
  parseAgenteraCloudOrigin,
} from "../agentera-auth/config";

const DEFAULT_TIMEOUT_MS = 15_000;
const RESPONSE_LIMIT = 256 * 1024;
const MAX_RETRY_AFTER_SECONDS = 86_400;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

type RawWorkspaceSummary = components["schemas"]["WorkspaceSummary"];
type RawWorkspaceMember = components["schemas"]["WorkspaceMember"];
type RawWorkspaceInvitation = components["schemas"]["WorkspaceInvitation"];
type RawWorkspaceInvitationCreation =
  components["schemas"]["WorkspaceInvitationCreation"];
type RawWorkspaceInvitationAcceptance =
  components["schemas"]["WorkspaceInvitationAcceptance"];
type RawWorkspaceListResponse = components["schemas"]["WorkspaceListResponse"];
type RawWorkspaceMemberListResponse =
  components["schemas"]["WorkspaceMemberListResponse"];
type RawWorkspaceInvitationListResponse =
  components["schemas"]["WorkspaceInvitationListResponse"];
type RawCreateWorkspaceRequest =
  components["schemas"]["CreateWorkspaceRequest"];
type RawRenameWorkspaceRequest =
  components["schemas"]["RenameWorkspaceRequest"];
type RawWorkspaceRevisionRequest =
  components["schemas"]["WorkspaceRevisionRequest"];
type RawChangeWorkspaceMemberRoleRequest =
  components["schemas"]["ChangeWorkspaceMemberRoleRequest"];
type RawAcceptWorkspaceInvitationRequest =
  components["schemas"]["AcceptWorkspaceInvitationRequest"];
type RawWorkspaceErrorCode = components["schemas"]["WorkspaceErrorCode"];
type RawWorkspaceErrorEnvelope =
  components["schemas"]["WorkspaceErrorEnvelope"];

const STABLE_ERROR_CODES: ReadonlySet<RawWorkspaceErrorCode> = new Set([
  "invalid_request",
  "session_revoked",
  "workspace_forbidden",
  "workspace_not_found",
  "invitation_unavailable",
  "workspace_conflict",
  "workspace_archived",
  "workspace_owner_unavailable",
  "membership_conflict",
  "workspace_limit_reached",
  "member_limit_reached",
  "invitation_limit_reached",
  "idempotency_conflict",
  "rate_limited",
  "service_unavailable",
]);

export interface AgenteraWorkspaceClientOptions {
  origin: string;
  getAccessToken: () => string | null;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class AgenteraWorkspaceClientError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfterSeconds: number | null;

  constructor(
    status: number,
    code: string,
    retryAfterSeconds: number | null = null,
  ) {
    super(`AgentEra Workspace request failed: ${code}.`);
    this.name = "AgenteraWorkspaceClientError";
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  idempotencyKey?: string;
  expectedStatuses: readonly number[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactFields(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> {
  if (!isObject(value)) return false;
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return (
    required.every((field) => Object.hasOwn(value, field)) &&
    keys.every((field) => allowed.has(field))
  );
}

function isUUID(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !TIMESTAMP_PATTERN.test(value)) {
    return false;
  }
  const parsed = new Date(value);
  return (
    Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 19) === value.slice(0, 19)
  );
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isWorkspaceRole(value: unknown): value is WorkspaceRole {
  return value === "owner" || value === "admin" || value === "member";
}

function isWorkspaceStatus(value: unknown): value is WorkspaceStatus {
  return value === "active" || value === "archived";
}

function isWorkspaceMutationState(
  value: unknown,
): value is WorkspaceMutationState {
  return (
    value === "writable" ||
    value === "archived" ||
    value === "owner_unavailable"
  );
}

function isWorkspaceInvitationStatus(
  value: unknown,
): value is WorkspaceInvitationStatus {
  return (
    value === "pending" ||
    value === "accepted" ||
    value === "revoked" ||
    value === "expired"
  );
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

function isSafeDisplayName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    isWellFormedUnicode(value) &&
    value === value.trim() &&
    Array.from(value).length >= 1 &&
    Array.from(value).length <= 80 &&
    !hasControlCharacter(value)
  );
}

function isSafeNickname(value: unknown): value is string {
  return (
    typeof value === "string" &&
    isWellFormedUnicode(value) &&
    Array.from(value).length >= 1 &&
    Array.from(value).length <= 80 &&
    !hasControlCharacter(value)
  );
}

function isCanonicalInvitationToken(value: unknown): value is string {
  if (typeof value !== "string" || !TOKEN_PATTERN.test(value)) return false;
  try {
    const bytes = Buffer.from(value, "base64url");
    return bytes.length === 32 && bytes.toString("base64url") === value;
  } catch {
    return false;
  }
}

function isRawWorkspaceSummary(value: unknown): value is RawWorkspaceSummary {
  if (
    !hasExactFields(
      value,
      [
        "created_at",
        "display_name",
        "id",
        "member_count",
        "mutation_state",
        "revision",
        "role",
        "status",
        "updated_at",
      ],
      ["archived_at"],
    ) ||
    !isUUID(value.id) ||
    !isSafeDisplayName(value.display_name) ||
    !isWorkspaceStatus(value.status) ||
    !isPositiveInteger(value.revision) ||
    !isWorkspaceMutationState(value.mutation_state) ||
    !isWorkspaceRole(value.role) ||
    !isPositiveInteger(value.member_count) ||
    !isTimestamp(value.created_at) ||
    !isTimestamp(value.updated_at) ||
    new Date(value.updated_at).getTime() < new Date(value.created_at).getTime()
  ) {
    return false;
  }
  if (value.status === "active") {
    return (
      value.archived_at === undefined &&
      (value.mutation_state === "writable" ||
        value.mutation_state === "owner_unavailable")
    );
  }
  return value.mutation_state === "archived" && isTimestamp(value.archived_at);
}

function copyWorkspaceSummary(value: unknown): WorkspaceSummary | null {
  if (!isRawWorkspaceSummary(value)) return null;
  return {
    id: value.id,
    displayName: value.display_name,
    status: value.status,
    revision: value.revision,
    mutationState: value.mutation_state,
    role: value.role,
    memberCount: value.member_count,
    createdAt: value.created_at,
    updatedAt: value.updated_at,
    archivedAt: value.archived_at ?? null,
  };
}

function isRawWorkspaceMember(value: unknown): value is RawWorkspaceMember {
  return (
    hasExactFields(
      value,
      ["joined_at", "revision", "role", "user_id"],
      ["nickname"],
    ) &&
    isUUID(value.user_id) &&
    (value.nickname === undefined || isSafeNickname(value.nickname)) &&
    isWorkspaceRole(value.role) &&
    isPositiveInteger(value.revision) &&
    isTimestamp(value.joined_at)
  );
}

function copyWorkspaceMember(value: unknown): WorkspaceMember | null {
  if (!isRawWorkspaceMember(value)) return null;
  return {
    userId: value.user_id,
    nickname: value.nickname ?? null,
    role: value.role,
    revision: value.revision,
    joinedAt: value.joined_at,
  };
}

interface InvitationLifecycleFields {
  status: WorkspaceInvitationStatus;
  createdAt: string;
  expiresAt: string;
  acceptedByUserId?: string;
  acceptedAt?: string;
  revokedAt?: string;
}

function hasValidInvitationLifecycle(
  value: InvitationLifecycleFields,
): boolean {
  if (
    new Date(value.expiresAt).getTime() <= new Date(value.createdAt).getTime()
  ) {
    return false;
  }
  switch (value.status) {
    case "pending":
    case "expired":
      return (
        value.acceptedByUserId === undefined &&
        value.acceptedAt === undefined &&
        value.revokedAt === undefined
      );
    case "accepted":
      return value.acceptedAt !== undefined && value.revokedAt === undefined;
    case "revoked":
      return (
        value.acceptedByUserId === undefined &&
        value.acceptedAt === undefined &&
        value.revokedAt !== undefined
      );
  }
}

function invitationFieldsAreValid(value: Record<string, unknown>): boolean {
  if (
    !isUUID(value.id) ||
    !isWorkspaceInvitationStatus(value.status) ||
    (value.created_by_user_id !== undefined &&
      !isUUID(value.created_by_user_id)) ||
    (value.accepted_by_user_id !== undefined &&
      !isUUID(value.accepted_by_user_id)) ||
    !isTimestamp(value.created_at) ||
    !isTimestamp(value.expires_at) ||
    (value.accepted_at !== undefined && !isTimestamp(value.accepted_at)) ||
    (value.revoked_at !== undefined && !isTimestamp(value.revoked_at))
  ) {
    return false;
  }
  return hasValidInvitationLifecycle({
    status: value.status,
    createdAt: value.created_at,
    expiresAt: value.expires_at,
    acceptedByUserId: value.accepted_by_user_id,
    acceptedAt: value.accepted_at,
    revokedAt: value.revoked_at,
  });
}

function isRawWorkspaceInvitation(
  value: unknown,
): value is RawWorkspaceInvitation {
  return (
    hasExactFields(
      value,
      ["created_at", "expires_at", "id", "status"],
      [
        "accepted_at",
        "accepted_by_user_id",
        "created_by_user_id",
        "revoked_at",
      ],
    ) && invitationFieldsAreValid(value)
  );
}

function copyInvitationFields(
  value: RawWorkspaceInvitation | RawWorkspaceInvitationCreation,
): WorkspaceInvitation {
  return {
    id: value.id,
    status: value.status,
    createdByUserId: value.created_by_user_id ?? null,
    acceptedByUserId: value.accepted_by_user_id ?? null,
    createdAt: value.created_at,
    expiresAt: value.expires_at,
    acceptedAt: value.accepted_at ?? null,
    revokedAt: value.revoked_at ?? null,
  };
}

function copyWorkspaceInvitation(value: unknown): WorkspaceInvitation | null {
  return isRawWorkspaceInvitation(value) ? copyInvitationFields(value) : null;
}

function isRawWorkspaceInvitationCreation(
  value: unknown,
): value is RawWorkspaceInvitationCreation {
  return (
    hasExactFields(
      value,
      ["created_at", "expires_at", "id", "secret_replayable", "status"],
      [
        "accepted_at",
        "accepted_by_user_id",
        "created_by_user_id",
        "invite_url",
        "revoked_at",
        "token",
      ],
    ) &&
    invitationFieldsAreValid(value) &&
    value.secret_replayable === false &&
    (value.token === undefined || isCanonicalInvitationToken(value.token)) &&
    (value.invite_url === undefined || typeof value.invite_url === "string")
  );
}

function copyWorkspaceInvitationCreation(
  value: unknown,
  responseStatus: number,
): WorkspaceInvitationCreation | null {
  if (!isRawWorkspaceInvitationCreation(value)) return null;
  const firstCreation = responseStatus === 201;
  if (
    firstCreation !== (value.token !== undefined) ||
    firstCreation !== (value.invite_url !== undefined) ||
    (firstCreation &&
      value.invite_url !== `agentera://workspace-invitation#${value.token}`)
  ) {
    return null;
  }
  return {
    ...copyInvitationFields(value),
    ...(firstCreation
      ? { token: value.token, inviteUrl: value.invite_url }
      : {}),
    secretReplayable: false,
  };
}

function isRawWorkspaceListResponse(
  value: unknown,
): value is RawWorkspaceListResponse {
  return (
    hasExactFields(value, ["workspaces"]) &&
    Array.isArray(value.workspaces) &&
    value.workspaces.length <= 4096 &&
    value.workspaces.every(isRawWorkspaceSummary)
  );
}

function isRawWorkspaceMemberListResponse(
  value: unknown,
): value is RawWorkspaceMemberListResponse {
  return (
    hasExactFields(value, ["members"]) &&
    Array.isArray(value.members) &&
    value.members.length <= 4096 &&
    value.members.every(isRawWorkspaceMember)
  );
}

function isRawWorkspaceInvitationListResponse(
  value: unknown,
): value is RawWorkspaceInvitationListResponse {
  return (
    hasExactFields(value, ["invitations"]) &&
    Array.isArray(value.invitations) &&
    value.invitations.length <= 4096 &&
    value.invitations.every(isRawWorkspaceInvitation)
  );
}

function isRawWorkspaceInvitationAcceptance(
  value: unknown,
): value is RawWorkspaceInvitationAcceptance {
  return (
    hasExactFields(value, ["member", "workspace"]) &&
    isRawWorkspaceSummary(value.workspace) &&
    isRawWorkspaceMember(value.member)
  );
}

function invalidResponse(): AgenteraWorkspaceClientError {
  return new AgenteraWorkspaceClientError(0, "invalid_response");
}

export function parseWorkspaceSummary(value: unknown): WorkspaceSummary {
  const copied = copyWorkspaceSummary(value);
  if (!copied) throw invalidResponse();
  return copied;
}

export function parseWorkspaceMember(value: unknown): WorkspaceMember {
  const copied = copyWorkspaceMember(value);
  if (!copied) throw invalidResponse();
  return copied;
}

export function parseWorkspaceInvitation(value: unknown): WorkspaceInvitation {
  const copied = copyWorkspaceInvitation(value);
  if (!copied) throw invalidResponse();
  return copied;
}

function requireUUID(value: string): void {
  if (!isUUID(value)) {
    throw new AgenteraWorkspaceClientError(0, "invalid_request");
  }
}

function requireRevision(value: number): void {
  if (!isPositiveInteger(value)) {
    throw new AgenteraWorkspaceClientError(0, "invalid_request");
  }
}

function requireDisplayName(value: string): void {
  if (!isSafeDisplayName(value)) {
    throw new AgenteraWorkspaceClientError(0, "invalid_request");
  }
}

function requireIdempotencyKey(value: string): void {
  if (
    typeof value !== "string" ||
    !isWellFormedUnicode(value) ||
    value.length === 0 ||
    value !== value.trim() ||
    Buffer.byteLength(value, "utf8") > 128 ||
    /[\r\n\0]/.test(value)
  ) {
    throw new AgenteraWorkspaceClientError(0, "invalid_request");
  }
}

function requireAssignableRole(
  value: WorkspaceRole,
): asserts value is "admin" | "member" {
  if (value !== "admin" && value !== "member") {
    throw new AgenteraWorkspaceClientError(0, "invalid_request");
  }
}

function scanJSONForDuplicateKeys(source: string): boolean {
  let index = 0;
  let duplicate = false;
  const skipWhitespace = (): void => {
    while (index < source.length && /[\t\n\r ]/.test(source[index])) index += 1;
  };
  const scanString = (): string => {
    const start = index;
    if (source[index] !== '"') throw new Error("expected JSON string");
    index += 1;
    while (index < source.length) {
      const character = source[index++];
      if (character === '"') {
        return JSON.parse(source.slice(start, index)) as string;
      }
      if (character === "\\") {
        if (index >= source.length) throw new Error("invalid JSON escape");
        const escaped = source[index++];
        if (escaped === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(source.slice(index, index + 4))) {
            throw new Error("invalid JSON unicode escape");
          }
          index += 4;
        } else if (!'"\\/bfnrt'.includes(escaped)) {
          throw new Error("invalid JSON escape");
        }
      } else if (character.charCodeAt(0) < 0x20) {
        throw new Error("invalid JSON string character");
      }
    }
    throw new Error("unterminated JSON string");
  };
  const scanValue = (depth: number): void => {
    if (depth > 128) throw new Error("JSON nesting limit exceeded");
    skipWhitespace();
    const character = source[index];
    if (character === "{") {
      index += 1;
      skipWhitespace();
      const keys = new Set<string>();
      if (source[index] === "}") {
        index += 1;
        return;
      }
      for (;;) {
        skipWhitespace();
        const key = scanString();
        if (keys.has(key)) duplicate = true;
        keys.add(key);
        skipWhitespace();
        if (source[index++] !== ":") throw new Error("missing JSON colon");
        scanValue(depth + 1);
        skipWhitespace();
        const separator = source[index++];
        if (separator === "}") return;
        if (separator !== ",") throw new Error("invalid JSON object");
      }
    }
    if (character === "[") {
      index += 1;
      skipWhitespace();
      if (source[index] === "]") {
        index += 1;
        return;
      }
      for (;;) {
        scanValue(depth + 1);
        skipWhitespace();
        const separator = source[index++];
        if (separator === "]") return;
        if (separator !== ",") throw new Error("invalid JSON array");
      }
    }
    if (character === '"') {
      scanString();
      return;
    }
    for (const literal of ["true", "false", "null"]) {
      if (source.startsWith(literal, index)) {
        index += literal.length;
        return;
      }
    }
    const number = source
      .slice(index)
      .match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/);
    if (!number) throw new Error("invalid JSON value");
    index += number[0].length;
  };
  try {
    scanValue(0);
    skipWhitespace();
    if (index !== source.length) throw new Error("trailing JSON input");
    return duplicate;
  } catch {
    return true;
  }
}

function parseStrictJSON(raw: string): unknown {
  if (scanJSONForDuplicateKeys(raw)) throw invalidResponse();
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw invalidResponse();
  }
}

function isRawWorkspaceErrorEnvelope(
  value: unknown,
): value is RawWorkspaceErrorEnvelope {
  return (
    hasExactFields(value, ["error"]) &&
    hasExactFields(value.error, ["code", "request_id"]) &&
    typeof value.error.code === "string" &&
    STABLE_ERROR_CODES.has(value.error.code as RawWorkspaceErrorCode) &&
    typeof value.error.request_id === "string" &&
    value.error.request_id.length >= 1 &&
    value.error.request_id.length <= 128
  );
}

function safeServerErrorCode(raw: string): string {
  try {
    if (scanJSONForDuplicateKeys(raw)) return "request_failed";
    const parsed = JSON.parse(raw) as unknown;
    if (isRawWorkspaceErrorEnvelope(parsed)) {
      return parsed.error.code;
    }
  } catch {
    // Return a stable generic code without exposing response content.
  }
  return "request_failed";
}

function parseRetryAfter(response: Response): number | null {
  const raw = response.headers.get("retry-after");
  if (raw === null || !/^[1-9][0-9]{0,4}$/.test(raw)) return null;
  const seconds = Number(raw);
  return seconds <= MAX_RETRY_AFTER_SECONDS ? seconds : null;
}

async function readBoundedText(response: Response): Promise<string> {
  const declared = response.headers.get("content-length");
  if (
    declared !== null &&
    (!/^(?:0|[1-9][0-9]*)$/.test(declared) || Number(declared) > RESPONSE_LIMIT)
  ) {
    throw new AgenteraWorkspaceClientError(0, "response_too_large");
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      received += part.value.byteLength;
      if (received > RESPONSE_LIMIT) {
        await reader.cancel();
        throw new AgenteraWorkspaceClientError(0, "response_too_large");
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw invalidResponse();
  }
}

export class AgenteraWorkspaceClient {
  readonly origin: string;
  private readonly getAccessToken: () => string | null;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: AgenteraWorkspaceClientOptions) {
    this.origin = parseAgenteraCloudOrigin(options.origin);
    this.getAccessToken = options.getAccessToken;
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (
      typeof this.getAccessToken !== "function" ||
      typeof this.fetcher !== "function" ||
      !Number.isInteger(this.timeoutMs) ||
      this.timeoutMs < 1 ||
      this.timeoutMs > 120_000
    ) {
      throw new Error("AgentEra Workspace client configuration is invalid.");
    }
  }

  async listWorkspaces(): Promise<WorkspaceSummary[]> {
    const raw = await this.requestJSON("/api/v1/workspaces", {
      expectedStatuses: [200],
    });
    if (!isRawWorkspaceListResponse(raw)) throw invalidResponse();
    return raw.workspaces.map((workspace) => copyWorkspaceSummary(workspace)!);
  }

  async createWorkspace(
    displayName: string,
    idempotencyKey: string,
  ): Promise<WorkspaceSummary> {
    requireDisplayName(displayName);
    requireIdempotencyKey(idempotencyKey);
    const body: RawCreateWorkspaceRequest = { display_name: displayName };
    const raw = await this.requestJSON("/api/v1/workspaces", {
      method: "POST",
      body,
      idempotencyKey,
      expectedStatuses: [200, 201],
    });
    return parseWorkspaceSummary(raw);
  }

  async renameWorkspace(
    workspaceId: string,
    displayName: string,
    expectedRevision: number,
  ): Promise<WorkspaceSummary> {
    requireUUID(workspaceId);
    requireDisplayName(displayName);
    requireRevision(expectedRevision);
    const body: RawRenameWorkspaceRequest = {
      display_name: displayName,
      expected_revision: expectedRevision,
    };
    const raw = await this.requestJSON(`/api/v1/workspaces/${workspaceId}`, {
      method: "PATCH",
      body,
      expectedStatuses: [200],
    });
    return parseWorkspaceSummary(raw);
  }

  archiveWorkspace(
    workspaceId: string,
    expectedRevision: number,
  ): Promise<WorkspaceSummary> {
    return this.reviseWorkspace(workspaceId, expectedRevision, "archive");
  }

  restoreWorkspace(
    workspaceId: string,
    expectedRevision: number,
  ): Promise<WorkspaceSummary> {
    return this.reviseWorkspace(workspaceId, expectedRevision, "restore");
  }

  async listMembers(workspaceId: string): Promise<WorkspaceMember[]> {
    requireUUID(workspaceId);
    const raw = await this.requestJSON(
      `/api/v1/workspaces/${workspaceId}/members`,
      { expectedStatuses: [200] },
    );
    if (!isRawWorkspaceMemberListResponse(raw)) throw invalidResponse();
    return raw.members.map((entry) => copyWorkspaceMember(entry)!);
  }

  async changeMemberRole(
    workspaceId: string,
    userId: string,
    role: "admin" | "member",
    expectedRevision: number,
  ): Promise<WorkspaceMember> {
    requireUUID(workspaceId);
    requireUUID(userId);
    requireAssignableRole(role);
    requireRevision(expectedRevision);
    const body: RawChangeWorkspaceMemberRoleRequest = {
      role,
      expected_revision: expectedRevision,
    };
    const raw = await this.requestJSON(
      `/api/v1/workspaces/${workspaceId}/members/${userId}`,
      { method: "PATCH", body, expectedStatuses: [200] },
    );
    return parseWorkspaceMember(raw);
  }

  async removeMember(
    workspaceId: string,
    userId: string,
    expectedRevision: number,
  ): Promise<void> {
    requireUUID(workspaceId);
    requireUUID(userId);
    requireRevision(expectedRevision);
    await this.requestNoContent(
      `/api/v1/workspaces/${workspaceId}/members/${userId}?expected_revision=${expectedRevision}`,
      { method: "DELETE", expectedStatuses: [204] },
    );
  }

  async leaveWorkspace(workspaceId: string): Promise<void> {
    requireUUID(workspaceId);
    await this.requestNoContent(`/api/v1/workspaces/${workspaceId}/leave`, {
      method: "POST",
      body: {},
      expectedStatuses: [204],
    });
  }

  async listInvitations(workspaceId: string): Promise<WorkspaceInvitation[]> {
    requireUUID(workspaceId);
    const raw = await this.requestJSON(
      `/api/v1/workspaces/${workspaceId}/invitations`,
      { expectedStatuses: [200] },
    );
    if (!isRawWorkspaceInvitationListResponse(raw)) throw invalidResponse();
    return raw.invitations.map((entry) => copyWorkspaceInvitation(entry)!);
  }

  async createInvitation(
    workspaceId: string,
    idempotencyKey: string,
  ): Promise<WorkspaceInvitationCreation> {
    requireUUID(workspaceId);
    requireIdempotencyKey(idempotencyKey);
    const { raw, status } = await this.requestJSONWithStatus(
      `/api/v1/workspaces/${workspaceId}/invitations`,
      {
        method: "POST",
        body: {},
        idempotencyKey,
        expectedStatuses: [200, 201],
      },
    );
    const copied = copyWorkspaceInvitationCreation(raw, status);
    if (!copied) throw invalidResponse();
    return copied;
  }

  async revokeInvitation(
    workspaceId: string,
    invitationId: string,
  ): Promise<void> {
    requireUUID(workspaceId);
    requireUUID(invitationId);
    await this.requestNoContent(
      `/api/v1/workspaces/${workspaceId}/invitations/${invitationId}`,
      { method: "DELETE", expectedStatuses: [204] },
    );
  }

  async acceptInvitation(
    token: string,
    idempotencyKey: string,
  ): Promise<WorkspaceInvitationAcceptance> {
    if (!isCanonicalInvitationToken(token)) {
      throw new AgenteraWorkspaceClientError(0, "invalid_request");
    }
    requireIdempotencyKey(idempotencyKey);
    const body: RawAcceptWorkspaceInvitationRequest = { token };
    const raw = await this.requestJSON("/api/v1/workspace-invitations/accept", {
      method: "POST",
      body,
      idempotencyKey,
      expectedStatuses: [200],
    });
    if (!isRawWorkspaceInvitationAcceptance(raw)) throw invalidResponse();
    return {
      workspace: copyWorkspaceSummary(raw.workspace)!,
      member: copyWorkspaceMember(raw.member)!,
    };
  }

  private async reviseWorkspace(
    workspaceId: string,
    expectedRevision: number,
    operation: "archive" | "restore",
  ): Promise<WorkspaceSummary> {
    requireUUID(workspaceId);
    requireRevision(expectedRevision);
    const body: RawWorkspaceRevisionRequest = {
      expected_revision: expectedRevision,
    };
    const raw = await this.requestJSON(
      `/api/v1/workspaces/${workspaceId}/${operation}`,
      { method: "POST", body, expectedStatuses: [200] },
    );
    return parseWorkspaceSummary(raw);
  }

  private async requestJSON(
    path: string,
    options: RequestOptions,
  ): Promise<unknown> {
    return (await this.requestJSONWithStatus(path, options)).raw;
  }

  private async requestJSONWithStatus(
    path: string,
    options: RequestOptions,
  ): Promise<{ raw: unknown; status: number }> {
    const response = await this.request(path, options);
    const raw = await readBoundedText(response);
    if (!options.expectedStatuses.includes(response.status)) {
      throw new AgenteraWorkspaceClientError(
        response.status,
        safeServerErrorCode(raw),
        response.status === 429 ? parseRetryAfter(response) : null,
      );
    }
    const contentType = response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      .trim()
      .toLowerCase();
    if (contentType !== "application/json") throw invalidResponse();
    return { raw: parseStrictJSON(raw), status: response.status };
  }

  private async requestNoContent(
    path: string,
    options: RequestOptions,
  ): Promise<void> {
    const response = await this.request(path, options);
    const raw = await readBoundedText(response);
    if (!options.expectedStatuses.includes(response.status)) {
      throw new AgenteraWorkspaceClientError(
        response.status,
        safeServerErrorCode(raw),
        response.status === 429 ? parseRetryAfter(response) : null,
      );
    }
    if (raw !== "") throw invalidResponse();
  }

  private async request(
    path: string,
    options: RequestOptions,
  ): Promise<Response> {
    const token = this.getAccessToken();
    if (
      typeof token !== "string" ||
      token.length === 0 ||
      token.length > 8192 ||
      token !== token.trim() ||
      /\s/.test(token)
    ) {
      throw new AgenteraWorkspaceClientError(401, "session_revoked");
    }
    const headers: Record<string, string> = {
      accept: "application/json",
      authorization: `Bearer ${token}`,
    };
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
    }
    if (options.idempotencyKey !== undefined) {
      headers["idempotency-key"] = options.idempotencyKey;
    }

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    timer.unref?.();
    try {
      return await this.fetcher(agenteraCloudUrl(this.origin, path), {
        method: options.method ?? "GET",
        headers,
        body:
          options.body === undefined ? undefined : JSON.stringify(options.body),
        redirect: "error",
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof AgenteraWorkspaceClientError) throw error;
      throw new AgenteraWorkspaceClientError(
        0,
        timedOut ? "request_timeout" : "network_unavailable",
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
