export type OrganizationRole = "owner" | "admin" | "auditor" | "member";
export type OrganizationAssignableRole = "admin" | "auditor" | "member";
export type OrganizationStatus = "active" | "archived" | "dissolved";
export type OrganizationMutationState = "writable" | "archived" | "dissolved";
export type OrganizationDepartmentStatus = "active" | "archived";
export type OrganizationInvitationStatus =
  | "pending"
  | "accepted"
  | "revoked"
  | "expired";

export interface OrganizationSummary {
  id: string;
  displayName: string;
  status: OrganizationStatus;
  revision: number;
  role: OrganizationRole;
  memberCount: number;
  departmentCount: number;
  currentPolicyVersion: number;
  currentPolicyDigest: string;
  mutationState: OrganizationMutationState;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface OrganizationMember {
  userId: string;
  nickname: string | null;
  role: OrganizationRole;
  departmentId: string | null;
  revision: number;
  joinedAt: string;
  updatedAt: string;
}

export interface OrganizationDepartment {
  id: string;
  displayName: string;
  status: OrganizationDepartmentStatus;
  memberCount: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface OrganizationInvitation {
  id: string;
  status: OrganizationInvitationStatus;
  createdByUserId: string | null;
  acceptedByUserId: string | null;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
}

/**
 * Volatile invitation result. Token and inviteUrl exist only on the first
 * successful creation response and must never enter public state or a cache.
 */
export interface OrganizationInvitationCreation {
  invitation: OrganizationInvitation;
  token?: string;
  inviteUrl?: string;
  secretReplayable: false;
}

export interface OrganizationInvitationAcceptance {
  organization: OrganizationSummary;
  member: OrganizationMember;
}

export interface OrganizationModelIdentifier {
  provider: string;
  model: string;
}

export interface OrganizationPolicyDocument {
  schemaVersion: 1;
  models: { allowlist: OrganizationModelIdentifier[] | null };
  tools: { allowlist: string[] | null };
  experienceCandidates: { mode: "disabled" | "manual_review" };
  officialAgents: { installation: "allowed" | "blocked" };
}

export interface OrganizationPolicySummary {
  id: string;
  policyVersion: number;
  schemaVersion: 1;
  contentDigest: string;
  issuer: string;
  signingKeyId: string;
  createdAt: string;
}

export interface OrganizationPolicySnapshot extends OrganizationPolicySummary {
  document: OrganizationPolicyDocument | null;
  signature: string | null;
}

export interface OrganizationAuditEvent {
  id: string;
  eventType: string;
  objectType: string | null;
  objectId: string | null;
  outcome: string;
  reasonCode: string | null;
  requestId: string | null;
  actorDisplay: string | null;
  subjectDisplay: string | null;
  createdAt: string;
}

export interface OrganizationPage<T> {
  items: T[];
  nextCursor: string | null;
}

export interface OrganizationPageRequest {
  limit?: number;
  cursor?: string;
}

export interface OrganizationMemberPatch {
  role?: OrganizationAssignableRole;
  departmentId?: string | null;
  expectedRevision: number;
}

export type AgenteraOrganizationErrorCode =
  | "invalid_request"
  | "authentication_required"
  | "organization_forbidden"
  | "organization_not_found"
  | "invitation_unavailable"
  | "organization_conflict"
  | "organization_archived"
  | "organization_limit_reached"
  | "organization_owner_transfer_required"
  | "owner_transfer_target_invalid"
  | "membership_conflict"
  | "member_limit_reached"
  | "department_not_empty"
  | "department_limit_reached"
  | "invitation_limit_reached"
  | "policy_version_conflict"
  | "idempotency_conflict"
  | "dissolution_blocked"
  | "rate_limited"
  | "service_unavailable";
