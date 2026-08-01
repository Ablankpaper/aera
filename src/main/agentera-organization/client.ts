import type { components } from "../../shared/agentera-cloud-api.generated";
import type {
  OrganizationAssignableRole,
  OrganizationAuditEvent,
  OrganizationDepartment,
  OrganizationDepartmentStatus,
  OrganizationInvitation,
  OrganizationInvitationAcceptance,
  OrganizationInvitationCreation,
  OrganizationInvitationStatus,
  OrganizationMember,
  OrganizationMemberPatch,
  OrganizationMutationState,
  OrganizationPage,
  OrganizationPageRequest,
  OrganizationPolicyDocument,
  OrganizationPolicySnapshot,
  OrganizationPolicySummary,
  OrganizationRole,
  OrganizationStatus,
  OrganizationSummary,
} from "../../shared/agentera-organization";
import {
  agenteraCloudUrl,
  parseAgenteraCloudOrigin,
} from "../agentera-auth/origin";
import {
  AgenteraOrganizationPolicyVerificationError,
  canonicalizeOrganizationPolicyDocument,
  type OrganizationSigningKeySet,
} from "./policy-verifier";

const DEFAULT_TIMEOUT_MS = 15_000;
const RESPONSE_LIMIT = 256 * 1024;
const MAX_RETRY_AFTER_SECONDS = 86_400;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{86}$/;
const PUBLIC_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,684}$/;

type RawOrganizationSummary = components["schemas"]["OrganizationSummary"];
type RawOrganizationMember = components["schemas"]["OrganizationMember"];
type RawOrganizationDepartment =
  components["schemas"]["OrganizationDepartment"];
type RawOrganizationInvitation =
  components["schemas"]["OrganizationInvitation"];
type RawOrganizationPolicySummary =
  components["schemas"]["OrganizationPolicySummary"];
type RawOrganizationAuditEvent =
  components["schemas"]["OrganizationAuditEvent"];
type RawOrganizationErrorCode = components["schemas"]["OrganizationErrorCode"];
type RawOrganizationErrorEnvelope =
  components["schemas"]["OrganizationErrorEnvelope"];

const STABLE_ERROR_CODES: ReadonlySet<RawOrganizationErrorCode> = new Set([
  "invalid_request",
  "authentication_required",
  "organization_forbidden",
  "organization_not_found",
  "invitation_unavailable",
  "invitation_expired",
  "invitation_revoked",
  "invitation_used",
  "organization_conflict",
  "organization_archived",
  "organization_limit_reached",
  "organization_owner_transfer_required",
  "owner_transfer_target_invalid",
  "membership_conflict",
  "member_limit_reached",
  "department_not_empty",
  "department_limit_reached",
  "invitation_limit_reached",
  "policy_version_conflict",
  "idempotency_conflict",
  "dissolution_blocked",
  "rate_limited",
  "service_unavailable",
]);

const SIGNING_PURPOSES = new Set([
  "access",
  "offline_entitlement",
  "agent_version",
  "agent_policy",
  "organization_policy",
]);

export interface AgenteraOrganizationClientOptions {
  origin: string;
  getAccessToken: () => string | null;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class AgenteraOrganizationClientError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfterSeconds: number | null;

  constructor(
    status: number,
    code: string,
    retryAfterSeconds: number | null = null,
  ) {
    super(`Aera Organization request failed: ${code}.`);
    this.name = "AgenteraOrganizationClientError";
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
  authenticated?: boolean;
}

function invalidResponse(): AgenteraOrganizationClientError {
  return new AgenteraOrganizationClientError(0, "invalid_response");
}

function invalidRequest(): never {
  throw new AgenteraOrganizationClientError(0, "invalid_request");
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
  return (
    required.every((field) => Object.hasOwn(value, field)) &&
    Object.keys(value).every((field) => allowed.has(field))
  );
}

function isUUID(value: unknown): value is string {
  return (
    typeof value === "string" &&
    UUID_PATTERN.test(value) &&
    value !== "00000000-0000-0000-0000-000000000000"
  );
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

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const current = value.charCodeAt(index);
    if (current >= 0xd800 && current <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (current >= 0xdc00 && current <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const point = character.codePointAt(0);
    if (
      point !== undefined &&
      (point <= 0x1f || (point >= 0x7f && point <= 0x9f))
    ) {
      return true;
    }
  }
  return false;
}

function isSafeText(
  value: unknown,
  maximum: number,
  options: { trimmed?: boolean; normalized?: boolean } = {},
): value is string {
  return (
    typeof value === "string" &&
    isWellFormedUnicode(value) &&
    (!options.trimmed || value === value.trim()) &&
    (!options.normalized || value === value.normalize("NFC")) &&
    Array.from(value).length >= 1 &&
    Array.from(value).length <= maximum &&
    !hasControlCharacter(value)
  );
}

function isOrganizationRole(value: unknown): value is OrganizationRole {
  return (
    value === "owner" ||
    value === "admin" ||
    value === "auditor" ||
    value === "member"
  );
}

function isAssignableRole(value: unknown): value is OrganizationAssignableRole {
  return value === "admin" || value === "auditor" || value === "member";
}

function isOrganizationStatus(value: unknown): value is OrganizationStatus {
  return value === "active" || value === "archived" || value === "dissolved";
}

function isMutationState(value: unknown): value is OrganizationMutationState {
  return value === "writable" || value === "archived" || value === "dissolved";
}

function isDepartmentStatus(
  value: unknown,
): value is OrganizationDepartmentStatus {
  return value === "active" || value === "archived";
}

function isInvitationStatus(
  value: unknown,
): value is OrganizationInvitationStatus {
  return (
    value === "pending" ||
    value === "accepted" ||
    value === "revoked" ||
    value === "expired"
  );
}

function isCanonicalBase64URL(
  value: unknown,
  pattern: RegExp,
  bytes?: number,
): value is string {
  if (typeof value !== "string" || !pattern.test(value)) return false;
  try {
    const decoded = Buffer.from(value, "base64url");
    return (
      (bytes === undefined || decoded.length === bytes) &&
      decoded.toString("base64url") === value
    );
  } catch {
    return false;
  }
}

function requireUUID(value: string): void {
  if (!isUUID(value)) invalidRequest();
}

function requireRevision(value: number): void {
  if (!isPositiveInteger(value)) invalidRequest();
}

function requireDisplayName(value: string, maximum: number): void {
  if (!isSafeText(value, maximum, { trimmed: true, normalized: true })) {
    invalidRequest();
  }
}

function requireIdempotencyKey(value: string): void {
  if (typeof value !== "string" || !IDEMPOTENCY_PATTERN.test(value)) {
    invalidRequest();
  }
}

function requireConfirmation(
  value: string,
  expected: "transfer-organization-owner" | "dissolve-organization",
): void {
  if (value !== expected) invalidRequest();
}

function requireCursor(value: string): void {
  if (!isCanonicalBase64URL(value, CURSOR_PATTERN)) invalidRequest();
  if (Buffer.from(value, "base64url").byteLength > 512) invalidRequest();
}

function pageQuery(page: OrganizationPageRequest | undefined): string {
  if (page === undefined) return "";
  if (!hasExactFields(page, [], ["limit", "cursor"])) invalidRequest();
  const requested = page as OrganizationPageRequest;
  const query = new URLSearchParams();
  if (requested.limit !== undefined) {
    if (
      !Number.isSafeInteger(requested.limit) ||
      requested.limit < 1 ||
      requested.limit > 100
    ) {
      invalidRequest();
    }
    query.set("limit", String(requested.limit));
  }
  if (requested.cursor !== undefined) {
    requireCursor(requested.cursor);
    query.set("cursor", requested.cursor);
  }
  const encoded = query.toString();
  return encoded === "" ? "" : `?${encoded}`;
}

function copyOrganizationSummary(value: unknown): OrganizationSummary | null {
  if (
    !hasExactFields(
      value,
      [
        "id",
        "display_name",
        "status",
        "revision",
        "role",
        "member_count",
        "department_count",
        "current_policy_version",
        "current_policy_digest",
        "mutation_state",
        "created_at",
        "updated_at",
      ],
      ["archived_at"],
    ) ||
    !isUUID(value.id) ||
    !isSafeText(value.display_name, 120, {
      trimmed: true,
      normalized: true,
    }) ||
    !isOrganizationStatus(value.status) ||
    !isPositiveInteger(value.revision) ||
    !isOrganizationRole(value.role) ||
    !isNonNegativeInteger(value.member_count) ||
    !isNonNegativeInteger(value.department_count) ||
    !isPositiveInteger(value.current_policy_version) ||
    typeof value.current_policy_digest !== "string" ||
    !DIGEST_PATTERN.test(value.current_policy_digest) ||
    !isMutationState(value.mutation_state) ||
    !isTimestamp(value.created_at) ||
    !isTimestamp(value.updated_at) ||
    new Date(value.updated_at).getTime() < new Date(value.created_at).getTime()
  ) {
    return null;
  }
  if (
    value.status === "active"
      ? value.mutation_state !== "writable" || value.archived_at !== undefined
      : value.mutation_state !== value.status ||
        !isTimestamp(value.archived_at) ||
        new Date(value.archived_at).getTime() <
          new Date(value.created_at).getTime()
  ) {
    return null;
  }
  const raw = value as unknown as RawOrganizationSummary;
  return {
    id: raw.id,
    displayName: raw.display_name,
    status: raw.status,
    revision: raw.revision,
    role: raw.role,
    memberCount: raw.member_count,
    departmentCount: raw.department_count,
    currentPolicyVersion: raw.current_policy_version,
    currentPolicyDigest: raw.current_policy_digest,
    mutationState: raw.mutation_state,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    archivedAt: raw.archived_at ?? null,
  };
}

function copyMember(value: unknown): OrganizationMember | null {
  if (
    !hasExactFields(
      value,
      ["user_id", "role", "revision", "joined_at", "updated_at"],
      ["nickname", "department_id"],
    ) ||
    !isUUID(value.user_id) ||
    (value.nickname !== undefined && !isSafeText(value.nickname, 80)) ||
    !isOrganizationRole(value.role) ||
    (value.department_id !== undefined && !isUUID(value.department_id)) ||
    !isPositiveInteger(value.revision) ||
    !isTimestamp(value.joined_at) ||
    !isTimestamp(value.updated_at) ||
    new Date(value.updated_at).getTime() < new Date(value.joined_at).getTime()
  ) {
    return null;
  }
  const raw = value as unknown as RawOrganizationMember;
  return {
    userId: raw.user_id,
    nickname: raw.nickname ?? null,
    role: raw.role,
    departmentId: raw.department_id ?? null,
    revision: raw.revision,
    joinedAt: raw.joined_at,
    updatedAt: raw.updated_at,
  };
}

function copyDepartment(value: unknown): OrganizationDepartment | null {
  if (
    !hasExactFields(
      value,
      [
        "id",
        "display_name",
        "status",
        "member_count",
        "revision",
        "created_at",
        "updated_at",
      ],
      ["archived_at"],
    ) ||
    !isUUID(value.id) ||
    !isSafeText(value.display_name, 80, {
      trimmed: true,
      normalized: true,
    }) ||
    !isDepartmentStatus(value.status) ||
    !isNonNegativeInteger(value.member_count) ||
    !isPositiveInteger(value.revision) ||
    !isTimestamp(value.created_at) ||
    !isTimestamp(value.updated_at) ||
    new Date(value.updated_at).getTime() < new Date(value.created_at).getTime()
  ) {
    return null;
  }
  if (
    value.status === "active"
      ? value.archived_at !== undefined
      : !isTimestamp(value.archived_at) || value.member_count !== 0
  ) {
    return null;
  }
  const raw = value as unknown as RawOrganizationDepartment;
  return {
    id: raw.id,
    displayName: raw.display_name,
    status: raw.status,
    memberCount: raw.member_count,
    revision: raw.revision,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    archivedAt: raw.archived_at ?? null,
  };
}

function invitationLifecycleIsValid(value: Record<string, unknown>): boolean {
  if (
    !isUUID(value.id) ||
    !isInvitationStatus(value.status) ||
    (value.created_by_user_id !== undefined &&
      !isUUID(value.created_by_user_id)) ||
    (value.accepted_by_user_id !== undefined &&
      !isUUID(value.accepted_by_user_id)) ||
    !isTimestamp(value.created_at) ||
    !isTimestamp(value.expires_at) ||
    (value.accepted_at !== undefined && !isTimestamp(value.accepted_at)) ||
    (value.revoked_at !== undefined && !isTimestamp(value.revoked_at)) ||
    new Date(value.expires_at).getTime() <= new Date(value.created_at).getTime()
  ) {
    return false;
  }
  if (value.status === "accepted") {
    return (
      value.accepted_at !== undefined &&
      value.revoked_at === undefined &&
      new Date(value.accepted_at as string).getTime() >=
        new Date(value.created_at as string).getTime() &&
      new Date(value.accepted_at as string).getTime() <=
        new Date(value.expires_at as string).getTime()
    );
  }
  if (value.status === "revoked") {
    return (
      value.accepted_at === undefined &&
      value.revoked_at !== undefined &&
      new Date(value.revoked_at as string).getTime() >=
        new Date(value.created_at as string).getTime()
    );
  }
  return value.accepted_at === undefined && value.revoked_at === undefined;
}

function copyInvitation(value: unknown): OrganizationInvitation | null {
  if (
    !hasExactFields(
      value,
      ["id", "status", "created_at", "expires_at"],
      [
        "created_by_user_id",
        "accepted_by_user_id",
        "accepted_at",
        "revoked_at",
      ],
    ) ||
    !invitationLifecycleIsValid(value)
  ) {
    return null;
  }
  const raw = value as unknown as RawOrganizationInvitation;
  return {
    id: raw.id,
    status: raw.status,
    createdByUserId: raw.created_by_user_id ?? null,
    acceptedByUserId: raw.accepted_by_user_id ?? null,
    createdAt: raw.created_at,
    expiresAt: raw.expires_at,
    acceptedAt: raw.accepted_at ?? null,
    revokedAt: raw.revoked_at ?? null,
  };
}

function copyInvitationCreation(
  value: unknown,
  status: number,
): OrganizationInvitationCreation | null {
  if (
    !hasExactFields(
      value,
      ["invitation", "secret_replayable"],
      ["token", "invite_url"],
    ) ||
    value.secret_replayable !== false
  ) {
    return null;
  }
  const invitation = copyInvitation(value.invitation);
  if (!invitation) return null;
  const first = status === 201;
  const token = typeof value.token === "string" ? value.token : "";
  const expectedCurrentURL = `aera://organization-invitation#${token}`;
  const expectedLegacyURL = `agentera://organization-invitation#${token}`;
  if (
    first !== Object.hasOwn(value, "token") ||
    first !== Object.hasOwn(value, "invite_url") ||
    (first &&
      (!isCanonicalBase64URL(value.token, TOKEN_PATTERN, 32) ||
        (value.invite_url !== expectedCurrentURL &&
          value.invite_url !== expectedLegacyURL)))
  ) {
    return null;
  }
  return {
    invitation,
    ...(first ? { token, inviteUrl: expectedCurrentURL } : {}),
    secretReplayable: false,
  };
}

function copyPolicyDocument(value: unknown): OrganizationPolicyDocument | null {
  if (
    !hasExactFields(value, [
      "schema_version",
      "models",
      "tools",
      "experience_candidates",
      "official_agents",
    ]) ||
    value.schema_version !== 1 ||
    !hasExactFields(value.models, ["allowlist"]) ||
    !hasExactFields(value.tools, ["allowlist"]) ||
    !hasExactFields(value.experience_candidates, ["mode"]) ||
    !hasExactFields(value.official_agents, ["installation"])
  ) {
    return null;
  }
  const modelAllowlist = Array.isArray(value.models.allowlist)
    ? value.models.allowlist.map((item) =>
        isObject(item) ? { provider: item.provider, model: item.model } : item,
      )
    : value.models.allowlist;
  const toolAllowlist = Array.isArray(value.tools.allowlist)
    ? [...value.tools.allowlist]
    : value.tools.allowlist;
  const candidate = {
    schemaVersion: 1,
    models: { allowlist: modelAllowlist },
    tools: { allowlist: toolAllowlist },
    experienceCandidates: { mode: value.experience_candidates.mode },
    officialAgents: { installation: value.official_agents.installation },
  };
  try {
    return canonicalizeOrganizationPolicyDocument(candidate, {
      requireCanonical: true,
    }).document;
  } catch (error) {
    if (error instanceof AgenteraOrganizationPolicyVerificationError) {
      return null;
    }
    throw error;
  }
}

function copyPolicySummary(
  value: unknown,
  allowSnapshotFields = false,
): OrganizationPolicySummary | null {
  if (
    !hasExactFields(
      value,
      [
        "id",
        "policy_version",
        "schema_version",
        "content_digest",
        "issuer",
        "signing_key_id",
        "created_at",
      ],
      allowSnapshotFields ? ["policy_document", "signature"] : [],
    ) ||
    !isUUID(value.id) ||
    !isPositiveInteger(value.policy_version) ||
    value.schema_version !== 1 ||
    typeof value.content_digest !== "string" ||
    !DIGEST_PATTERN.test(value.content_digest) ||
    typeof value.issuer !== "string" ||
    typeof value.signing_key_id !== "string" ||
    !KEY_ID_PATTERN.test(value.signing_key_id) ||
    !isTimestamp(value.created_at)
  ) {
    return null;
  }
  let issuer: string;
  try {
    issuer = parseAgenteraCloudOrigin(value.issuer);
  } catch {
    return null;
  }
  if (issuer !== value.issuer) return null;
  const raw = value as unknown as RawOrganizationPolicySummary;
  return {
    id: raw.id,
    policyVersion: raw.policy_version,
    schemaVersion: 1,
    contentDigest: raw.content_digest,
    issuer,
    signingKeyId: raw.signing_key_id,
    createdAt: raw.created_at,
  };
}

function copyPolicySnapshot(
  value: unknown,
  requireFull: boolean,
): OrganizationPolicySnapshot | null {
  if (
    !hasExactFields(
      value,
      [
        "id",
        "policy_version",
        "schema_version",
        "content_digest",
        "issuer",
        "signing_key_id",
        "created_at",
      ],
      ["policy_document", "signature"],
    )
  ) {
    return null;
  }
  const summary = copyPolicySummary(value, true);
  if (!summary) return null;
  const hasDocument = Object.hasOwn(value, "policy_document");
  const hasSignature = Object.hasOwn(value, "signature");
  if (hasDocument !== hasSignature || (requireFull && !hasDocument)) {
    return null;
  }
  if (!hasDocument) return { ...summary, document: null, signature: null };
  const document = copyPolicyDocument(value.policy_document);
  if (
    !document ||
    !isCanonicalBase64URL(value.signature, SIGNATURE_PATTERN, 64)
  ) {
    return null;
  }
  return { ...summary, document, signature: value.signature };
}

function copyAuditEvent(value: unknown): OrganizationAuditEvent | null {
  if (
    !hasExactFields(
      value,
      ["id", "event_type", "outcome", "created_at"],
      [
        "object_type",
        "object_id",
        "reason_code",
        "request_id",
        "actor_display",
        "subject_display",
      ],
    ) ||
    !isUUID(value.id) ||
    !isSafeText(value.event_type, 128) ||
    (value.object_type !== undefined && !isSafeText(value.object_type, 64)) ||
    (value.object_id !== undefined && !isUUID(value.object_id)) ||
    !isSafeText(value.outcome, 32) ||
    (value.reason_code !== undefined && !isSafeText(value.reason_code, 128)) ||
    (value.request_id !== undefined && !isSafeText(value.request_id, 128)) ||
    (value.actor_display !== undefined &&
      !isSafeText(value.actor_display, 120)) ||
    (value.subject_display !== undefined &&
      !isSafeText(value.subject_display, 120)) ||
    !isTimestamp(value.created_at)
  ) {
    return null;
  }
  const raw = value as unknown as RawOrganizationAuditEvent;
  return {
    id: raw.id,
    eventType: raw.event_type,
    objectType: raw.object_type ?? null,
    objectId: raw.object_id ?? null,
    outcome: raw.outcome,
    reasonCode: raw.reason_code ?? null,
    requestId: raw.request_id ?? null,
    actorDisplay: raw.actor_display ?? null,
    subjectDisplay: raw.subject_display ?? null,
    createdAt: raw.created_at,
  };
}

function copyPage<T>(
  value: unknown,
  copyItem: (item: unknown) => T | null,
): OrganizationPage<T> | null {
  if (
    !hasExactFields(value, ["items"], ["next_cursor"]) ||
    !Array.isArray(value.items) ||
    value.items.length > 100 ||
    (value.next_cursor !== undefined &&
      (!isCanonicalBase64URL(value.next_cursor, CURSOR_PATTERN) ||
        Buffer.from(value.next_cursor, "base64url").byteLength > 512))
  ) {
    return null;
  }
  const items: T[] = [];
  for (const item of value.items) {
    const copied = copyItem(item);
    if (!copied) return null;
    items.push(copied);
  }
  return { items, nextCursor: value.next_cursor ?? null };
}

function copySigningKeySet(value: unknown): OrganizationSigningKeySet | null {
  if (
    !hasExactFields(value, ["keys"]) ||
    !Array.isArray(value.keys) ||
    value.keys.length < 5 ||
    value.keys.length > 64
  ) {
    return null;
  }
  const seen = new Set<string>();
  const purposes = new Set<string>();
  const keys: Array<OrganizationSigningKeySet["keys"][number]> = [];
  for (const key of value.keys) {
    if (
      !hasExactFields(key, [
        "kid",
        "kty",
        "crv",
        "alg",
        "use",
        "purpose",
        "x",
      ]) ||
      typeof key.kid !== "string" ||
      !KEY_ID_PATTERN.test(key.kid) ||
      key.kty !== "OKP" ||
      key.crv !== "Ed25519" ||
      key.alg !== "EdDSA" ||
      key.use !== "sig" ||
      typeof key.purpose !== "string" ||
      !SIGNING_PURPOSES.has(key.purpose) ||
      !isCanonicalBase64URL(key.x, PUBLIC_KEY_PATTERN, 32)
    ) {
      return null;
    }
    const identifier = `${key.purpose}\0${key.kid}`;
    if (seen.has(identifier)) return null;
    seen.add(identifier);
    purposes.add(key.purpose);
    keys.push({
      kid: key.kid,
      kty: "OKP",
      crv: "Ed25519",
      alg: "EdDSA",
      use: "sig",
      purpose:
        key.purpose as OrganizationSigningKeySet["keys"][number]["purpose"],
      x: key.x,
    });
  }
  if ([...SIGNING_PURPOSES].some((purpose) => !purposes.has(purpose))) {
    return null;
  }
  return { keys };
}

function scanJSONForDuplicateKeys(source: string): boolean {
  let index = 0;
  let duplicate = false;
  const whitespace = (): void => {
    while (index < source.length && /[\t\n\r ]/.test(source[index])) index += 1;
  };
  const string = (): string => {
    const start = index;
    if (source[index] !== '"') throw new Error("string");
    index += 1;
    while (index < source.length) {
      const character = source[index++];
      if (character === '"')
        return JSON.parse(source.slice(start, index)) as string;
      if (character === "\\") {
        const escaped = source[index++];
        if (escaped === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(source.slice(index, index + 4))) {
            throw new Error("unicode");
          }
          index += 4;
        } else if (!'"\\/bfnrt'.includes(escaped)) {
          throw new Error("escape");
        }
      } else if (character.charCodeAt(0) < 0x20) {
        throw new Error("control");
      }
    }
    throw new Error("unterminated");
  };
  const value = (depth: number): void => {
    if (depth > 128) throw new Error("depth");
    whitespace();
    const character = source[index];
    if (character === "{") {
      index += 1;
      whitespace();
      const keys = new Set<string>();
      if (source[index] === "}") {
        index += 1;
        return;
      }
      for (;;) {
        whitespace();
        const key = string();
        if (keys.has(key)) duplicate = true;
        keys.add(key);
        whitespace();
        if (source[index++] !== ":") throw new Error("colon");
        value(depth + 1);
        whitespace();
        const separator = source[index++];
        if (separator === "}") return;
        if (separator !== ",") throw new Error("object");
      }
    }
    if (character === "[") {
      index += 1;
      whitespace();
      if (source[index] === "]") {
        index += 1;
        return;
      }
      for (;;) {
        value(depth + 1);
        whitespace();
        const separator = source[index++];
        if (separator === "]") return;
        if (separator !== ",") throw new Error("array");
      }
    }
    if (character === '"') {
      string();
      return;
    }
    for (const literal of ["true", "false", "null"]) {
      if (source.startsWith(literal, index)) {
        index += literal.length;
        return;
      }
    }
    const numeric = source
      .slice(index)
      .match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/);
    if (!numeric) throw new Error("value");
    index += numeric[0].length;
  };
  try {
    value(0);
    whitespace();
    return duplicate || index !== source.length;
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

function isErrorEnvelope(
  value: unknown,
): value is RawOrganizationErrorEnvelope {
  return (
    hasExactFields(value, ["error"]) &&
    hasExactFields(value.error, ["code", "request_id"]) &&
    typeof value.error.code === "string" &&
    STABLE_ERROR_CODES.has(value.error.code as RawOrganizationErrorCode) &&
    typeof value.error.request_id === "string" &&
    value.error.request_id.length >= 1 &&
    value.error.request_id.length <= 128
  );
}

function safeServerErrorCode(raw: string): string {
  try {
    if (scanJSONForDuplicateKeys(raw)) return "request_failed";
    const value = JSON.parse(raw) as unknown;
    if (isErrorEnvelope(value)) return value.error.code;
  } catch {
    // The raw server response is intentionally discarded.
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
    throw new AgenteraOrganizationClientError(0, "response_too_large");
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
        throw new AgenteraOrganizationClientError(0, "response_too_large");
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

export class AgenteraOrganizationClient {
  readonly origin: string;
  private readonly getAccessToken: () => string | null;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: AgenteraOrganizationClientOptions) {
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
      throw new Error("Aera Organization client configuration is invalid.");
    }
  }

  async listOrganizations(
    page?: OrganizationPageRequest,
  ): Promise<OrganizationPage<OrganizationSummary>> {
    const raw = await this.requestJSON(
      `/api/v1/organizations${pageQuery(page)}`,
      {
        expectedStatuses: [200],
      },
    );
    const copied = copyPage(raw, copyOrganizationSummary);
    if (!copied) throw invalidResponse();
    return copied;
  }

  async createOrganization(
    displayName: string,
    idempotencyKey: string,
  ): Promise<OrganizationSummary> {
    requireDisplayName(displayName, 120);
    requireIdempotencyKey(idempotencyKey);
    const raw = await this.requestJSON("/api/v1/organizations", {
      method: "POST",
      body: { display_name: displayName },
      idempotencyKey,
      expectedStatuses: [200, 201],
    });
    return this.requireSummary(raw);
  }

  async getOrganization(organizationId: string): Promise<OrganizationSummary> {
    requireUUID(organizationId);
    return this.requireSummary(
      await this.requestJSON(`/api/v1/organizations/${organizationId}`, {
        expectedStatuses: [200],
      }),
    );
  }

  async renameOrganization(
    organizationId: string,
    displayName: string,
    expectedRevision: number,
  ): Promise<OrganizationSummary> {
    requireUUID(organizationId);
    requireDisplayName(displayName, 120);
    requireRevision(expectedRevision);
    return this.requireSummary(
      await this.requestJSON(`/api/v1/organizations/${organizationId}`, {
        method: "PATCH",
        body: {
          display_name: displayName,
          expected_revision: expectedRevision,
        },
        expectedStatuses: [200],
      }),
    );
  }

  archiveOrganization(
    organizationId: string,
    expectedRevision: number,
    idempotencyKey: string,
  ): Promise<OrganizationSummary> {
    return this.reviseOrganization(
      organizationId,
      expectedRevision,
      idempotencyKey,
      "archive",
    );
  }

  restoreOrganization(
    organizationId: string,
    expectedRevision: number,
    idempotencyKey: string,
  ): Promise<OrganizationSummary> {
    return this.reviseOrganization(
      organizationId,
      expectedRevision,
      idempotencyKey,
      "restore",
    );
  }

  async transferOwner(
    organizationId: string,
    targetUserId: string,
    expectedOrganizationRevision: number,
    expectedOwnerRevision: number,
    expectedTargetRevision: number,
    confirmation: "transfer-organization-owner",
    idempotencyKey: string,
  ): Promise<OrganizationSummary> {
    requireUUID(organizationId);
    requireUUID(targetUserId);
    requireRevision(expectedOrganizationRevision);
    requireRevision(expectedOwnerRevision);
    requireRevision(expectedTargetRevision);
    requireConfirmation(confirmation, "transfer-organization-owner");
    requireIdempotencyKey(idempotencyKey);
    return this.requireSummary(
      await this.requestJSON(
        `/api/v1/organizations/${organizationId}/owner-transfer`,
        {
          method: "POST",
          body: {
            target_user_id: targetUserId,
            expected_organization_revision: expectedOrganizationRevision,
            expected_owner_revision: expectedOwnerRevision,
            expected_target_revision: expectedTargetRevision,
            confirmation,
          },
          idempotencyKey,
          expectedStatuses: [200],
        },
      ),
    );
  }

  async dissolveOrganization(
    organizationId: string,
    displayName: string,
    expectedRevision: number,
    confirmation: "dissolve-organization",
    idempotencyKey: string,
  ): Promise<OrganizationSummary> {
    requireUUID(organizationId);
    requireDisplayName(displayName, 120);
    requireRevision(expectedRevision);
    requireConfirmation(confirmation, "dissolve-organization");
    requireIdempotencyKey(idempotencyKey);
    return this.requireSummary(
      await this.requestJSON(
        `/api/v1/organizations/${organizationId}/dissolve`,
        {
          method: "POST",
          body: {
            display_name: displayName,
            expected_revision: expectedRevision,
            confirmation,
          },
          idempotencyKey,
          expectedStatuses: [200],
        },
      ),
    );
  }

  async listMembers(
    organizationId: string,
    page?: OrganizationPageRequest,
  ): Promise<OrganizationPage<OrganizationMember>> {
    requireUUID(organizationId);
    const raw = await this.requestJSON(
      `/api/v1/organizations/${organizationId}/members${pageQuery(page)}`,
      { expectedStatuses: [200] },
    );
    const copied = copyPage(raw, copyMember);
    if (!copied) throw invalidResponse();
    return copied;
  }

  async patchMember(
    organizationId: string,
    userId: string,
    patch: OrganizationMemberPatch,
  ): Promise<OrganizationMember> {
    requireUUID(organizationId);
    requireUUID(userId);
    if (
      !hasExactFields(patch, ["expectedRevision"], ["role", "departmentId"]) ||
      (!Object.hasOwn(patch, "role") &&
        !Object.hasOwn(patch, "departmentId")) ||
      (patch.role !== undefined && !isAssignableRole(patch.role)) ||
      (Object.hasOwn(patch, "departmentId") &&
        patch.departmentId !== null &&
        !isUUID(patch.departmentId))
    ) {
      invalidRequest();
    }
    requireRevision(patch.expectedRevision);
    const body = {
      ...(patch.role === undefined ? {} : { role: patch.role }),
      ...(Object.hasOwn(patch, "departmentId")
        ? { department_id: patch.departmentId }
        : {}),
      expected_revision: patch.expectedRevision,
    };
    const copied = copyMember(
      await this.requestJSON(
        `/api/v1/organizations/${organizationId}/members/${userId}`,
        { method: "PATCH", body, expectedStatuses: [200] },
      ),
    );
    if (!copied) throw invalidResponse();
    return copied;
  }

  async removeMember(
    organizationId: string,
    userId: string,
    expectedRevision: number,
  ): Promise<void> {
    requireUUID(organizationId);
    requireUUID(userId);
    requireRevision(expectedRevision);
    await this.requestNoContent(
      `/api/v1/organizations/${organizationId}/members/${userId}?expected_revision=${expectedRevision}`,
      { method: "DELETE", expectedStatuses: [204] },
    );
  }

  async leaveOrganization(organizationId: string): Promise<void> {
    requireUUID(organizationId);
    await this.requestNoContent(
      `/api/v1/organizations/${organizationId}/leave`,
      { method: "POST", body: {}, expectedStatuses: [204] },
    );
  }

  async listDepartments(
    organizationId: string,
    page?: OrganizationPageRequest,
  ): Promise<OrganizationPage<OrganizationDepartment>> {
    requireUUID(organizationId);
    const copied = copyPage(
      await this.requestJSON(
        `/api/v1/organizations/${organizationId}/departments${pageQuery(page)}`,
        { expectedStatuses: [200] },
      ),
      copyDepartment,
    );
    if (!copied) throw invalidResponse();
    return copied;
  }

  async createDepartment(
    organizationId: string,
    displayName: string,
  ): Promise<OrganizationDepartment> {
    requireUUID(organizationId);
    requireDisplayName(displayName, 80);
    return this.requireDepartment(
      await this.requestJSON(
        `/api/v1/organizations/${organizationId}/departments`,
        {
          method: "POST",
          body: { display_name: displayName },
          expectedStatuses: [201],
        },
      ),
    );
  }

  async renameDepartment(
    organizationId: string,
    departmentId: string,
    displayName: string,
    expectedRevision: number,
  ): Promise<OrganizationDepartment> {
    requireUUID(organizationId);
    requireUUID(departmentId);
    requireDisplayName(displayName, 80);
    requireRevision(expectedRevision);
    return this.requireDepartment(
      await this.requestJSON(
        `/api/v1/organizations/${organizationId}/departments/${departmentId}`,
        {
          method: "PATCH",
          body: {
            display_name: displayName,
            expected_revision: expectedRevision,
          },
          expectedStatuses: [200],
        },
      ),
    );
  }

  archiveDepartment(
    organizationId: string,
    departmentId: string,
    expectedRevision: number,
  ): Promise<OrganizationDepartment> {
    return this.reviseDepartment(
      organizationId,
      departmentId,
      expectedRevision,
      "archive",
    );
  }

  restoreDepartment(
    organizationId: string,
    departmentId: string,
    expectedRevision: number,
  ): Promise<OrganizationDepartment> {
    return this.reviseDepartment(
      organizationId,
      departmentId,
      expectedRevision,
      "restore",
    );
  }

  async listInvitations(
    organizationId: string,
    page?: OrganizationPageRequest,
  ): Promise<OrganizationPage<OrganizationInvitation>> {
    requireUUID(organizationId);
    const copied = copyPage(
      await this.requestJSON(
        `/api/v1/organizations/${organizationId}/invitations${pageQuery(page)}`,
        { expectedStatuses: [200] },
      ),
      copyInvitation,
    );
    if (!copied) throw invalidResponse();
    return copied;
  }

  async createInvitation(
    organizationId: string,
    idempotencyKey: string,
  ): Promise<OrganizationInvitationCreation> {
    requireUUID(organizationId);
    requireIdempotencyKey(idempotencyKey);
    const { raw, status } = await this.requestJSONWithStatus(
      `/api/v1/organizations/${organizationId}/invitations`,
      {
        method: "POST",
        body: {},
        idempotencyKey,
        expectedStatuses: [200, 201],
      },
    );
    const copied = copyInvitationCreation(raw, status);
    if (!copied) throw invalidResponse();
    return copied;
  }

  async revokeInvitation(
    organizationId: string,
    invitationId: string,
  ): Promise<void> {
    requireUUID(organizationId);
    requireUUID(invitationId);
    await this.requestNoContent(
      `/api/v1/organizations/${organizationId}/invitations/${invitationId}`,
      { method: "DELETE", expectedStatuses: [204] },
    );
  }

  async acceptInvitation(
    token: string,
    idempotencyKey: string,
  ): Promise<OrganizationInvitationAcceptance> {
    if (!isCanonicalBase64URL(token, TOKEN_PATTERN, 32)) invalidRequest();
    requireIdempotencyKey(idempotencyKey);
    const raw = await this.requestJSON(
      "/api/v1/organization-invitations/accept",
      {
        method: "POST",
        body: { token },
        idempotencyKey,
        expectedStatuses: [200],
      },
    );
    if (!hasExactFields(raw, ["organization", "member"])) {
      throw invalidResponse();
    }
    const organization = copyOrganizationSummary(raw.organization);
    const member = copyMember(raw.member);
    if (!organization || !member) throw invalidResponse();
    return { organization, member };
  }

  async getCurrentPolicy(
    organizationId: string,
  ): Promise<OrganizationPolicySnapshot> {
    requireUUID(organizationId);
    const copied = copyPolicySnapshot(
      await this.requestJSON(`/api/v1/organizations/${organizationId}/policy`, {
        expectedStatuses: [200],
      }),
      false,
    );
    if (!copied || copied.issuer !== this.origin) throw invalidResponse();
    return copied;
  }

  async listPolicySnapshots(
    organizationId: string,
    page?: OrganizationPageRequest,
  ): Promise<OrganizationPage<OrganizationPolicySummary>> {
    requireUUID(organizationId);
    const copied = copyPage(
      await this.requestJSON(
        `/api/v1/organizations/${organizationId}/policy-snapshots${pageQuery(page)}`,
        { expectedStatuses: [200] },
      ),
      copyPolicySummary,
    );
    if (
      !copied ||
      copied.items.some((snapshot) => snapshot.issuer !== this.origin)
    ) {
      throw invalidResponse();
    }
    return copied;
  }

  async publishPolicy(
    organizationId: string,
    document: OrganizationPolicyDocument,
    expectedOrganizationRevision: number,
    expectedPolicyVersion: number,
    idempotencyKey: string,
  ): Promise<OrganizationPolicySnapshot> {
    requireUUID(organizationId);
    requireRevision(expectedOrganizationRevision);
    if (
      !Number.isSafeInteger(expectedPolicyVersion) ||
      expectedPolicyVersion < 2
    ) {
      invalidRequest();
    }
    requireIdempotencyKey(idempotencyKey);
    let canonical;
    try {
      canonical = canonicalizeOrganizationPolicyDocument(document);
    } catch (error) {
      if (error instanceof AgenteraOrganizationPolicyVerificationError) {
        invalidRequest();
      }
      throw error;
    }
    const rawDocument = {
      schema_version: 1,
      models: { allowlist: canonical.document.models.allowlist },
      tools: { allowlist: canonical.document.tools.allowlist },
      experience_candidates: {
        mode: canonical.document.experienceCandidates.mode,
      },
      official_agents: {
        installation: canonical.document.officialAgents.installation,
      },
    };
    const copied = copyPolicySnapshot(
      await this.requestJSON(
        `/api/v1/organizations/${organizationId}/policy-snapshots`,
        {
          method: "POST",
          body: {
            policy_document: rawDocument,
            expected_organization_revision: expectedOrganizationRevision,
            expected_policy_version: expectedPolicyVersion,
          },
          idempotencyKey,
          expectedStatuses: [201],
        },
      ),
      true,
    );
    if (!copied || copied.issuer !== this.origin) throw invalidResponse();
    return copied;
  }

  async getPolicySnapshot(
    policySnapshotId: string,
  ): Promise<OrganizationPolicySnapshot> {
    requireUUID(policySnapshotId);
    const copied = copyPolicySnapshot(
      await this.requestJSON(
        `/api/v1/organization-policy-snapshots/${policySnapshotId}`,
        { expectedStatuses: [200] },
      ),
      true,
    );
    if (!copied || copied.issuer !== this.origin) throw invalidResponse();
    return copied;
  }

  async listAuditEvents(
    organizationId: string,
    page?: OrganizationPageRequest,
  ): Promise<OrganizationPage<OrganizationAuditEvent>> {
    requireUUID(organizationId);
    const copied = copyPage(
      await this.requestJSON(
        `/api/v1/organizations/${organizationId}/audit-events${pageQuery(page)}`,
        { expectedStatuses: [200] },
      ),
      copyAuditEvent,
    );
    if (!copied) throw invalidResponse();
    return copied;
  }

  async getSigningKeys(): Promise<OrganizationSigningKeySet> {
    const copied = copySigningKeySet(
      await this.requestJSON("/.well-known/agentera-signing-keys.json", {
        authenticated: false,
        expectedStatuses: [200],
      }),
    );
    if (!copied) throw invalidResponse();
    return copied;
  }

  private async reviseOrganization(
    organizationId: string,
    expectedRevision: number,
    idempotencyKey: string,
    action: "archive" | "restore",
  ): Promise<OrganizationSummary> {
    requireUUID(organizationId);
    requireRevision(expectedRevision);
    requireIdempotencyKey(idempotencyKey);
    return this.requireSummary(
      await this.requestJSON(
        `/api/v1/organizations/${organizationId}/${action}`,
        {
          method: "POST",
          body: { expected_revision: expectedRevision },
          idempotencyKey,
          expectedStatuses: [200],
        },
      ),
    );
  }

  private async reviseDepartment(
    organizationId: string,
    departmentId: string,
    expectedRevision: number,
    action: "archive" | "restore",
  ): Promise<OrganizationDepartment> {
    requireUUID(organizationId);
    requireUUID(departmentId);
    requireRevision(expectedRevision);
    return this.requireDepartment(
      await this.requestJSON(
        `/api/v1/organizations/${organizationId}/departments/${departmentId}/${action}`,
        {
          method: "POST",
          body: { expected_revision: expectedRevision },
          expectedStatuses: [200],
        },
      ),
    );
  }

  private requireSummary(value: unknown): OrganizationSummary {
    const copied = copyOrganizationSummary(value);
    if (!copied) throw invalidResponse();
    return copied;
  }

  private requireDepartment(value: unknown): OrganizationDepartment {
    const copied = copyDepartment(value);
    if (!copied) throw invalidResponse();
    return copied;
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
      throw new AgenteraOrganizationClientError(
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
      throw new AgenteraOrganizationClientError(
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
    const headers: Record<string, string> = { accept: "application/json" };
    if (options.authenticated !== false) {
      const token = this.getAccessToken();
      if (
        typeof token !== "string" ||
        token.length === 0 ||
        token.length > 8192 ||
        token !== token.trim() ||
        /\s/.test(token)
      ) {
        throw new AgenteraOrganizationClientError(
          401,
          "authentication_required",
        );
      }
      headers.authorization = `Bearer ${token}`;
    }
    if (options.body !== undefined)
      headers["content-type"] = "application/json";
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
      if (error instanceof AgenteraOrganizationClientError) throw error;
      throw new AgenteraOrganizationClientError(
        0,
        timedOut ? "request_timeout" : "network_unavailable",
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

export type { OrganizationSigningKeySet } from "./policy-verifier";
