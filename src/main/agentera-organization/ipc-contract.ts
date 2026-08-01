import type {
  AgenteraOrganizationErrorCode,
  AgenteraOrganizationResult,
  OrganizationAuditEvent,
  OrganizationCachedCollection,
  OrganizationCurrentPolicyState,
  OrganizationDepartment,
  OrganizationInvitation,
  OrganizationInvitationAcceptance,
  OrganizationInvitationCreation,
  OrganizationMember,
  OrganizationPage,
  OrganizationPageRequest,
  OrganizationPolicyDocument,
  OrganizationPolicySnapshot,
  OrganizationPolicySummary,
  OrganizationPublicState,
  OrganizationSummary,
} from "../../shared/agentera-organization";
import { parseAgenteraCloudOrigin } from "../agentera-auth/origin";
import {
  AgenteraOrganizationPolicyVerificationError,
  canonicalizeOrganizationPolicyDocument,
} from "./policy-verifier";
import { parseOrganizationInvitationDeepLink } from "./deep-link";
import type {
  AcceptOrganizationInvitationInput,
  CreateOrganizationDepartmentInput,
  CreateOrganizationInput,
  DissolveOrganizationInput,
  GetOrganizationPolicySnapshotInput,
  OrganizationIDInput,
  OrganizationRevisionInput,
  PatchOrganizationMemberInput,
  PublishOrganizationPolicyInput,
  RemoveOrganizationMemberInput,
  RenameOrganizationDepartmentInput,
  RenameOrganizationInput,
  ReviseOrganizationDepartmentInput,
  RevokeOrganizationInvitationInput,
  TransferOrganizationOwnerInput,
} from "./manager";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{86}$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const EVENT_TYPE_PATTERN = /^[a-z][a-z0-9._:-]{0,127}$/;
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,684}$/;

function invalidRequest(): never {
  throw Object.assign(new Error("Invalid Aera Organization request."), {
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
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!isPlainObject(value)) invalidRequest();
  const allowed = new Set([...required, ...optional]);
  if (
    !required.every((field) => Object.hasOwn(value, field)) ||
    Object.keys(value).some((field) => !allowed.has(field))
  ) {
    invalidRequest();
  }
  return value;
}

function requireUUID(value: unknown): string {
  if (
    typeof value !== "string" ||
    !UUID_PATTERN.test(value) ||
    value === "00000000-0000-0000-0000-000000000000"
  ) {
    invalidRequest();
  }
  return value;
}

function requirePositiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) invalidRequest();
  return Number(value);
}

function requireNonNegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) invalidRequest();
  return Number(value);
}

function safeText(
  value: unknown,
  maximum: number,
  options: { trimmed?: boolean; normalized?: boolean } = {},
): string {
  if (
    typeof value !== "string" ||
    (options.trimmed && value !== value.trim()) ||
    (options.normalized && value !== value.normalize("NFC")) ||
    Array.from(value).length < 1 ||
    Array.from(value).length > maximum
  ) {
    invalidRequest();
  }
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) invalidRequest();
      index += 1;
      continue;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) invalidRequest();
  }
  for (const character of value) {
    const point = character.codePointAt(0);
    if (
      point !== undefined &&
      (point <= 0x1f || (point >= 0x7f && point <= 0x9f))
    ) {
      invalidRequest();
    }
  }
  return value;
}

function optionalSafeText(value: unknown, maximum: number): string | null {
  return value === null ? null : safeText(value, maximum);
}

function requireTimestamp(value: unknown): string {
  if (typeof value !== "string" || !TIMESTAMP_PATTERN.test(value)) {
    invalidRequest();
  }
  const parsed = new Date(value);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 19) !== value.slice(0, 19)
  ) {
    invalidRequest();
  }
  return value;
}

function optionalTimestamp(value: unknown): string | null {
  return value === null ? null : requireTimestamp(value);
}

function canonicalBase64URL(
  value: unknown,
  pattern: RegExp,
  bytes?: number,
): string {
  if (typeof value !== "string" || !pattern.test(value)) invalidRequest();
  try {
    const decoded = Buffer.from(value, "base64url");
    if (
      (bytes !== undefined && decoded.byteLength !== bytes) ||
      decoded.toString("base64url") !== value
    ) {
      invalidRequest();
    }
  } catch {
    invalidRequest();
  }
  return value;
}

function requireToken(value: unknown): string {
  return canonicalBase64URL(value, TOKEN_PATTERN, 32);
}

function requireDisplayName(value: unknown, maximum: number): string {
  return safeText(value, maximum, { trimmed: true, normalized: true });
}

function requireWorkspacePage(
  value: Record<string, unknown>,
): OrganizationPageRequest {
  const page: OrganizationPageRequest = {};
  if (value.limit !== undefined) {
    const limit = requirePositiveInteger(value.limit);
    if (limit > 100) invalidRequest();
    page.limit = limit;
  }
  if (value.cursor !== undefined) {
    const cursor = canonicalBase64URL(value.cursor, CURSOR_PATTERN);
    if (Buffer.from(cursor, "base64url").byteLength > 512) invalidRequest();
    page.cursor = cursor;
  }
  return page;
}

export function parseOrganizationIDInput(value: unknown): OrganizationIDInput {
  const object = exactObject(value, ["organizationId"]);
  return { organizationId: requireUUID(object.organizationId) };
}

export function parseOrganizationInvitationLinkInput(value: unknown): {
  inviteUrl: string;
} {
  const object = exactObject(value, ["inviteUrl"]);
  const inviteUrl = safeText(object.inviteUrl, 512, {
    trimmed: true,
    normalized: true,
  });
  if (parseOrganizationInvitationDeepLink(inviteUrl) === null) {
    invalidRequest();
  }
  return { inviteUrl };
}

export function parseCreateOrganizationInput(
  value: unknown,
): CreateOrganizationInput {
  const object = exactObject(value, ["displayName"]);
  return { displayName: requireDisplayName(object.displayName, 120) };
}

export function parseRenameOrganizationInput(
  value: unknown,
): RenameOrganizationInput {
  const object = exactObject(value, [
    "displayName",
    "expectedRevision",
    "organizationId",
  ]);
  return {
    organizationId: requireUUID(object.organizationId),
    displayName: requireDisplayName(object.displayName, 120),
    expectedRevision: requirePositiveInteger(object.expectedRevision),
  };
}

export function parseOrganizationRevisionInput(
  value: unknown,
): OrganizationRevisionInput {
  const object = exactObject(value, ["expectedRevision", "organizationId"]);
  return {
    organizationId: requireUUID(object.organizationId),
    expectedRevision: requirePositiveInteger(object.expectedRevision),
  };
}

export function parseTransferOrganizationOwnerInput(
  value: unknown,
): TransferOrganizationOwnerInput {
  const object = exactObject(value, [
    "confirmation",
    "expectedOrganizationRevision",
    "expectedOwnerRevision",
    "expectedTargetRevision",
    "organizationId",
    "targetUserId",
  ]);
  if (object.confirmation !== "transfer-organization-owner") invalidRequest();
  return {
    organizationId: requireUUID(object.organizationId),
    targetUserId: requireUUID(object.targetUserId),
    expectedOrganizationRevision: requirePositiveInteger(
      object.expectedOrganizationRevision,
    ),
    expectedOwnerRevision: requirePositiveInteger(object.expectedOwnerRevision),
    expectedTargetRevision: requirePositiveInteger(
      object.expectedTargetRevision,
    ),
    confirmation: object.confirmation,
  };
}

export function parseDissolveOrganizationInput(
  value: unknown,
): DissolveOrganizationInput {
  const object = exactObject(value, [
    "confirmation",
    "displayName",
    "expectedRevision",
    "organizationId",
  ]);
  if (object.confirmation !== "dissolve-organization") invalidRequest();
  return {
    organizationId: requireUUID(object.organizationId),
    displayName: requireDisplayName(object.displayName, 120),
    expectedRevision: requirePositiveInteger(object.expectedRevision),
    confirmation: object.confirmation,
  };
}

export function parsePatchOrganizationMemberInput(
  value: unknown,
): PatchOrganizationMemberInput {
  const object = exactObject(value, ["organizationId", "patch", "userId"]);
  const patch = exactObject(
    object.patch,
    ["expectedRevision"],
    ["departmentId", "role"],
  );
  const hasRole = Object.hasOwn(patch, "role");
  const hasDepartment = Object.hasOwn(patch, "departmentId");
  if (!hasRole && !hasDepartment) invalidRequest();
  if (
    hasRole &&
    patch.role !== "admin" &&
    patch.role !== "auditor" &&
    patch.role !== "member"
  ) {
    invalidRequest();
  }
  return {
    organizationId: requireUUID(object.organizationId),
    userId: requireUUID(object.userId),
    patch: {
      ...(hasRole
        ? { role: patch.role as "admin" | "auditor" | "member" }
        : {}),
      ...(hasDepartment
        ? {
            departmentId:
              patch.departmentId === null
                ? null
                : requireUUID(patch.departmentId),
          }
        : {}),
      expectedRevision: requirePositiveInteger(patch.expectedRevision),
    },
  };
}

export function parseRemoveOrganizationMemberInput(
  value: unknown,
): RemoveOrganizationMemberInput {
  const object = exactObject(value, [
    "expectedRevision",
    "organizationId",
    "userId",
  ]);
  return {
    organizationId: requireUUID(object.organizationId),
    userId: requireUUID(object.userId),
    expectedRevision: requirePositiveInteger(object.expectedRevision),
  };
}

export function parseCreateOrganizationDepartmentInput(
  value: unknown,
): CreateOrganizationDepartmentInput {
  const object = exactObject(value, ["displayName", "organizationId"]);
  return {
    organizationId: requireUUID(object.organizationId),
    displayName: requireDisplayName(object.displayName, 80),
  };
}

export function parseRenameOrganizationDepartmentInput(
  value: unknown,
): RenameOrganizationDepartmentInput {
  const object = exactObject(value, [
    "departmentId",
    "displayName",
    "expectedRevision",
    "organizationId",
  ]);
  return {
    organizationId: requireUUID(object.organizationId),
    departmentId: requireUUID(object.departmentId),
    displayName: requireDisplayName(object.displayName, 80),
    expectedRevision: requirePositiveInteger(object.expectedRevision),
  };
}

export function parseReviseOrganizationDepartmentInput(
  value: unknown,
): ReviseOrganizationDepartmentInput {
  const object = exactObject(value, [
    "departmentId",
    "expectedRevision",
    "organizationId",
  ]);
  return {
    organizationId: requireUUID(object.organizationId),
    departmentId: requireUUID(object.departmentId),
    expectedRevision: requirePositiveInteger(object.expectedRevision),
  };
}

export function parseRevokeOrganizationInvitationInput(
  value: unknown,
): RevokeOrganizationInvitationInput {
  const object = exactObject(value, ["invitationId", "organizationId"]);
  return {
    organizationId: requireUUID(object.organizationId),
    invitationId: requireUUID(object.invitationId),
  };
}

export function parseAcceptOrganizationInvitationInput(
  value: unknown,
): AcceptOrganizationInvitationInput {
  const object = exactObject(value, ["token"]);
  return { token: requireToken(object.token) };
}

export const parseDismissOrganizationInvitationInput =
  parseAcceptOrganizationInvitationInput;

export function parsePublishOrganizationPolicyInput(
  value: unknown,
): PublishOrganizationPolicyInput {
  const object = exactObject(value, [
    "document",
    "expectedOrganizationRevision",
    "expectedPolicyVersion",
    "organizationId",
  ]);
  let document: OrganizationPolicyDocument;
  try {
    document = canonicalizeOrganizationPolicyDocument(object.document, {
      requireCanonical: true,
    }).document;
  } catch (error) {
    if (error instanceof AgenteraOrganizationPolicyVerificationError) {
      invalidRequest();
    }
    throw error;
  }
  const expectedPolicyVersion = requirePositiveInteger(
    object.expectedPolicyVersion,
  );
  if (expectedPolicyVersion < 2) invalidRequest();
  return {
    organizationId: requireUUID(object.organizationId),
    document,
    expectedOrganizationRevision: requirePositiveInteger(
      object.expectedOrganizationRevision,
    ),
    expectedPolicyVersion,
  };
}

export function parseGetOrganizationPolicySnapshotInput(
  value: unknown,
): GetOrganizationPolicySnapshotInput {
  const object = exactObject(value, ["organizationId", "policySnapshotId"]);
  return {
    organizationId: requireUUID(object.organizationId),
    policySnapshotId: requireUUID(object.policySnapshotId),
  };
}

export interface OrganizationAuditPageInput extends OrganizationIDInput {
  page?: OrganizationPageRequest;
}

export function parseOrganizationAuditPageInput(
  value: unknown,
): OrganizationAuditPageInput {
  const object = exactObject(value, ["organizationId"], ["cursor", "limit"]);
  const page = requireWorkspacePage(object);
  return {
    organizationId: requireUUID(object.organizationId),
    ...(Object.keys(page).length === 0 ? {} : { page }),
  };
}

function requireRole(value: unknown): "owner" | "admin" | "auditor" | "member" {
  if (
    value !== "owner" &&
    value !== "admin" &&
    value !== "auditor" &&
    value !== "member"
  ) {
    invalidRequest();
  }
  return value;
}

export function serializeOrganizationSummary(
  value: OrganizationSummary,
): OrganizationSummary {
  const status = value.status;
  if (status !== "active" && status !== "archived" && status !== "dissolved") {
    invalidRequest();
  }
  const mutationState = value.mutationState;
  if (
    mutationState !== "writable" &&
    mutationState !== "archived" &&
    mutationState !== "dissolved"
  ) {
    invalidRequest();
  }
  const archivedAt = optionalTimestamp(value.archivedAt);
  if (
    (status === "active" &&
      (mutationState !== "writable" || archivedAt !== null)) ||
    (status !== "active" && (mutationState !== status || archivedAt === null))
  ) {
    invalidRequest();
  }
  if (
    typeof value.currentPolicyDigest !== "string" ||
    !DIGEST_PATTERN.test(value.currentPolicyDigest)
  ) {
    invalidRequest();
  }
  return {
    id: requireUUID(value.id),
    displayName: requireDisplayName(value.displayName, 120),
    status,
    revision: requirePositiveInteger(value.revision),
    role: requireRole(value.role),
    memberCount: requireNonNegativeInteger(value.memberCount),
    departmentCount: requireNonNegativeInteger(value.departmentCount),
    currentPolicyVersion: requirePositiveInteger(value.currentPolicyVersion),
    currentPolicyDigest: value.currentPolicyDigest,
    mutationState,
    createdAt: requireTimestamp(value.createdAt),
    updatedAt: requireTimestamp(value.updatedAt),
    archivedAt,
  };
}

export function serializeOrganizationMember(
  value: OrganizationMember,
): OrganizationMember {
  return {
    userId: requireUUID(value.userId),
    nickname: optionalSafeText(value.nickname, 80),
    role: requireRole(value.role),
    departmentId:
      value.departmentId === null ? null : requireUUID(value.departmentId),
    revision: requirePositiveInteger(value.revision),
    joinedAt: requireTimestamp(value.joinedAt),
    updatedAt: requireTimestamp(value.updatedAt),
  };
}

export function serializeOrganizationDepartment(
  value: OrganizationDepartment,
): OrganizationDepartment {
  if (value.status !== "active" && value.status !== "archived")
    invalidRequest();
  const archivedAt = optionalTimestamp(value.archivedAt);
  if (
    (value.status === "active" && archivedAt !== null) ||
    (value.status === "archived" && archivedAt === null)
  ) {
    invalidRequest();
  }
  return {
    id: requireUUID(value.id),
    displayName: requireDisplayName(value.displayName, 80),
    status: value.status,
    memberCount: requireNonNegativeInteger(value.memberCount),
    revision: requirePositiveInteger(value.revision),
    createdAt: requireTimestamp(value.createdAt),
    updatedAt: requireTimestamp(value.updatedAt),
    archivedAt,
  };
}

export function serializeOrganizationInvitation(
  value: OrganizationInvitation,
): OrganizationInvitation {
  if (
    value.status !== "pending" &&
    value.status !== "accepted" &&
    value.status !== "revoked" &&
    value.status !== "expired"
  ) {
    invalidRequest();
  }
  return {
    id: requireUUID(value.id),
    status: value.status,
    createdByUserId:
      value.createdByUserId === null
        ? null
        : requireUUID(value.createdByUserId),
    acceptedByUserId:
      value.acceptedByUserId === null
        ? null
        : requireUUID(value.acceptedByUserId),
    createdAt: requireTimestamp(value.createdAt),
    expiresAt: requireTimestamp(value.expiresAt),
    acceptedAt: optionalTimestamp(value.acceptedAt),
    revokedAt: optionalTimestamp(value.revokedAt),
  };
}

export function serializeOrganizationInvitationCreation(
  value: OrganizationInvitationCreation,
): OrganizationInvitationCreation {
  if (value.secretReplayable !== false) invalidRequest();
  const invitation = serializeOrganizationInvitation(value.invitation);
  const hasToken = value.token !== undefined;
  const hasURL = value.inviteUrl !== undefined;
  if (hasToken !== hasURL) invalidRequest();
  if (!hasToken) return { invitation, secretReplayable: false };
  const token = requireToken(value.token);
  const inviteUrl = `aera://organization-invitation#${token}`;
  if (
    value.inviteUrl !== inviteUrl &&
    value.inviteUrl !== `agentera://organization-invitation#${token}`
  ) {
    invalidRequest();
  }
  return { invitation, token, inviteUrl, secretReplayable: false };
}

export function serializeOrganizationInvitationAcceptance(
  value: OrganizationInvitationAcceptance,
): OrganizationInvitationAcceptance {
  return {
    organization: serializeOrganizationSummary(value.organization),
    member: serializeOrganizationMember(value.member),
  };
}

function serializePolicyDocument(
  value: OrganizationPolicyDocument,
): OrganizationPolicyDocument {
  try {
    return canonicalizeOrganizationPolicyDocument(value, {
      requireCanonical: true,
    }).document;
  } catch {
    invalidRequest();
  }
}

export function serializeOrganizationPolicySummary(
  value: OrganizationPolicySummary,
): OrganizationPolicySummary {
  if (
    value.schemaVersion !== 1 ||
    typeof value.contentDigest !== "string" ||
    !DIGEST_PATTERN.test(value.contentDigest) ||
    typeof value.issuer !== "string" ||
    value.issuer.length > 2048 ||
    typeof value.signingKeyId !== "string" ||
    !KEY_ID_PATTERN.test(value.signingKeyId)
  ) {
    invalidRequest();
  }
  try {
    if (parseAgenteraCloudOrigin(value.issuer) !== value.issuer) {
      invalidRequest();
    }
  } catch {
    invalidRequest();
  }
  return {
    id: requireUUID(value.id),
    policyVersion: requirePositiveInteger(value.policyVersion),
    schemaVersion: 1,
    contentDigest: value.contentDigest,
    issuer: value.issuer,
    signingKeyId: value.signingKeyId,
    createdAt: requireTimestamp(value.createdAt),
  };
}

export function serializeOrganizationPolicySnapshot(
  value: OrganizationPolicySnapshot,
): OrganizationPolicySnapshot {
  const summary = serializeOrganizationPolicySummary(value);
  const hasDocument = value.document !== null;
  const hasSignature = value.signature !== null;
  if (hasDocument !== hasSignature) invalidRequest();
  const document = value.document;
  return {
    ...summary,
    document: document === null ? null : serializePolicyDocument(document),
    signature: hasSignature
      ? canonicalBase64URL(value.signature, SIGNATURE_PATTERN, 64)
      : null,
  };
}

export function serializeOrganizationCurrentPolicyState(
  value: OrganizationCurrentPolicyState,
): OrganizationCurrentPolicyState {
  if (
    typeof value.stale !== "boolean" ||
    (value.errorCode !== null &&
      value.errorCode !== "policy_verification_failed")
  ) {
    invalidRequest();
  }
  return {
    policy:
      value.policy === null
        ? null
        : serializeOrganizationPolicySnapshot(value.policy),
    stale: value.stale,
    verifiedAt: optionalTimestamp(value.verifiedAt),
    errorCode: value.errorCode,
  };
}

function serializeCollection<T, U>(
  value: OrganizationCachedCollection<T>,
  serializer: (item: T) => U,
): OrganizationCachedCollection<U> {
  if (!Array.isArray(value.items) || typeof value.stale !== "boolean") {
    invalidRequest();
  }
  return {
    items: value.items.map(serializer),
    stale: value.stale,
    refreshedAt: optionalTimestamp(value.refreshedAt),
  };
}

export function serializeOrganizationMemberCollection(
  value: OrganizationCachedCollection<OrganizationMember>,
): OrganizationCachedCollection<OrganizationMember> {
  return serializeCollection(value, serializeOrganizationMember);
}

export function serializeOrganizationDepartmentCollection(
  value: OrganizationCachedCollection<OrganizationDepartment>,
): OrganizationCachedCollection<OrganizationDepartment> {
  return serializeCollection(value, serializeOrganizationDepartment);
}

export function serializeOrganizationInvitationCollection(
  value: OrganizationCachedCollection<OrganizationInvitation>,
): OrganizationCachedCollection<OrganizationInvitation> {
  return serializeCollection(value, serializeOrganizationInvitation);
}

export function serializeOrganizationAuditEvent(
  value: OrganizationAuditEvent,
): OrganizationAuditEvent {
  if (
    typeof value.eventType !== "string" ||
    !EVENT_TYPE_PATTERN.test(value.eventType) ||
    typeof value.outcome !== "string" ||
    !EVENT_TYPE_PATTERN.test(value.outcome)
  ) {
    invalidRequest();
  }
  return {
    id: requireUUID(value.id),
    eventType: value.eventType,
    objectType: optionalSafeText(value.objectType, 128),
    objectId: value.objectId === null ? null : requireUUID(value.objectId),
    outcome: value.outcome,
    reasonCode: optionalSafeText(value.reasonCode, 128),
    requestId: optionalSafeText(value.requestId, 128),
    actorDisplay: optionalSafeText(value.actorDisplay, 160),
    subjectDisplay: optionalSafeText(value.subjectDisplay, 160),
    createdAt: requireTimestamp(value.createdAt),
  };
}

export function serializeOrganizationAuditPage(
  value: OrganizationPage<OrganizationAuditEvent>,
): OrganizationPage<OrganizationAuditEvent> {
  if (!Array.isArray(value.items)) invalidRequest();
  return {
    items: value.items.map(serializeOrganizationAuditEvent),
    nextCursor:
      value.nextCursor === null
        ? null
        : canonicalBase64URL(value.nextCursor, CURSOR_PATTERN),
  };
}

export function serializeOrganizationPolicySummaries(
  value: readonly OrganizationPolicySummary[],
): readonly OrganizationPolicySummary[] {
  if (!Array.isArray(value)) invalidRequest();
  return value.map(serializeOrganizationPolicySummary);
}

export function serializeOrganizationPublicState(
  value: OrganizationPublicState,
): OrganizationPublicState {
  if (
    (value.access !== "online" && value.access !== "offline") ||
    typeof value.cloudAvailable !== "boolean" ||
    typeof value.stale !== "boolean" ||
    !Array.isArray(value.organizations)
  ) {
    invalidRequest();
  }
  return {
    access: value.access,
    cloudAvailable: value.cloudAvailable,
    stale: value.stale,
    refreshedAt: optionalTimestamp(value.refreshedAt),
    organizations: value.organizations.map(serializeOrganizationSummary),
  };
}

const STABLE_CODES = new Set<AgenteraOrganizationErrorCode>([
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
  "online_required",
  "policy_verification_failed",
  "service_unavailable",
]);

function mapError(error: unknown): AgenteraOrganizationErrorCode {
  let code = "";
  try {
    if (error instanceof AgenteraOrganizationPolicyVerificationError) {
      return "policy_verification_failed";
    }
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
  if (STABLE_CODES.has(code as AgenteraOrganizationErrorCode)) {
    return code as AgenteraOrganizationErrorCode;
  }
  if (
    code === "unauthenticated" ||
    code === "sign_in_required" ||
    code === "invalid_credentials"
  ) {
    return "authentication_required";
  }
  if (code.startsWith("invalid_")) return "invalid_request";
  if (code.includes("policy") || code.includes("signature")) {
    return "policy_verification_failed";
  }
  return "service_unavailable";
}

export async function executeOrganizationIpc<T>(
  task: () => T | Promise<T>,
): Promise<AgenteraOrganizationResult<T>> {
  try {
    return { ok: true, data: await task() };
  } catch (error) {
    return { ok: false, errorCode: mapError(error) };
  }
}
