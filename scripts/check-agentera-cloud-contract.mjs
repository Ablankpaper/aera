/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parse } from "yaml";
import {
  generatedPath,
  projectRoot,
  renderAgenteraCloudTypes,
} from "./generate-agentera-cloud-types.mjs";

const REQUIRED_PATHS = [
  "/.well-known/agentera-signing-keys.json",
  "/api/v1/accounts/deletion",
  "/api/v1/accounts/deletion/recover",
  "/api/v1/accounts/identities/bind",
  "/api/v1/accounts/identities/{kind}",
  "/api/v1/accounts/me",
  "/api/v1/accounts/password/change",
  "/api/v1/accounts/password/reset",
  "/api/v1/accounts/register",
  "/api/v1/agent-definitions",
  "/api/v1/agent-definitions/{definition_id}",
  "/api/v1/agent-definitions/{definition_id}/versions",
  "/api/v1/agent-installations",
  "/api/v1/agent-installations/{installation_id}/apply-managed-update",
  "/api/v1/agent-installations/{installation_id}/activate",
  "/api/v1/agent-installations/{installation_id}/archive",
  "/api/v1/agent-installations/{installation_id}/managed-update",
  "/api/v1/agent-installations/{installation_id}/select-version",
  "/api/v1/agent-versions/{version_id}",
  "/api/v1/agent-versions/{version_id}/revocations",
  "/api/v1/policy-snapshots/{policy_snapshot_id}",
  "/api/v1/browser/login",
  "/api/v1/browser/login/code",
  "/api/v1/browser/logout",
  "/api/v1/devices",
  "/api/v1/devices/current/logout",
  "/api/v1/devices/self-revoke",
  "/api/v1/devices/{device_id}",
  "/api/v1/legal/current",
  "/api/v1/oauth/authorize/approve",
  "/api/v1/oauth/refresh",
  "/api/v1/oauth/revoke",
  "/api/v1/oauth/token",
  "/api/v1/organization-invitations/accept",
  "/api/v1/organization-policy-snapshots/{policy_snapshot_id}",
  "/api/v1/organizations",
  "/api/v1/organizations/{organization_id}",
  "/api/v1/organizations/{organization_id}/archive",
  "/api/v1/organizations/{organization_id}/agent-definitions",
  "/api/v1/organizations/{organization_id}/agent-definitions/{definition_id}",
  "/api/v1/organizations/{organization_id}/agent-definitions/{definition_id}/versions",
  "/api/v1/organizations/{organization_id}/agent-publication-submissions",
  "/api/v1/organizations/{organization_id}/agent-publication-submissions/{submission_id}",
  "/api/v1/organizations/{organization_id}/agent-publication-submissions/{submission_id}/withdraw",
  "/api/v1/organizations/{organization_id}/agent-publication-submissions/{submission_id}/reviews",
  "/api/v1/organizations/{organization_id}/audit-events",
  "/api/v1/organizations/{organization_id}/departments",
  "/api/v1/organizations/{organization_id}/departments/{department_id}",
  "/api/v1/organizations/{organization_id}/departments/{department_id}/archive",
  "/api/v1/organizations/{organization_id}/departments/{department_id}/restore",
  "/api/v1/organizations/{organization_id}/dissolve",
  "/api/v1/organizations/{organization_id}/invitations",
  "/api/v1/organizations/{organization_id}/invitations/{invitation_id}",
  "/api/v1/organizations/{organization_id}/leave",
  "/api/v1/organizations/{organization_id}/members",
  "/api/v1/organizations/{organization_id}/members/{user_id}",
  "/api/v1/organizations/{organization_id}/owner-transfer",
  "/api/v1/organizations/{organization_id}/policy",
  "/api/v1/organizations/{organization_id}/policy-snapshots",
  "/api/v1/organizations/{organization_id}/restore",
  "/api/v1/official-agents",
  "/api/v1/official-agents/{definition_id}",
  "/api/v1/official-agents/{definition_id}/release",
  "/api/v1/runtime-binding-records",
  "/api/v1/verification/challenges",
  "/api/v1/verification/challenges/verify",
  "/api/v1/workspace-invitations/accept",
  "/api/v1/workspaces",
  "/api/v1/workspaces/{workspace_id}",
  "/api/v1/workspaces/{workspace_id}/archive",
  "/api/v1/workspaces/{workspace_id}/agent-definitions",
  "/api/v1/workspaces/{workspace_id}/agent-definitions/{definition_id}",
  "/api/v1/workspaces/{workspace_id}/agent-definitions/{definition_id}/experience-candidates",
  "/api/v1/workspaces/{workspace_id}/agent-definitions/{definition_id}/versions",
  "/api/v1/workspaces/{workspace_id}/experience-candidates",
  "/api/v1/workspaces/{workspace_id}/experience-candidates/mine",
  "/api/v1/workspaces/{workspace_id}/experience-candidates/{candidate_id}",
  "/api/v1/workspaces/{workspace_id}/experience-candidates/{candidate_id}/review",
  "/api/v1/workspaces/{workspace_id}/invitations",
  "/api/v1/workspaces/{workspace_id}/invitations/{invitation_id}",
  "/api/v1/workspaces/{workspace_id}/leave",
  "/api/v1/workspaces/{workspace_id}/members",
  "/api/v1/workspaces/{workspace_id}/members/{user_id}",
  "/api/v1/workspaces/{workspace_id}/restore",
  "/oauth/authorize",
];

const TOKEN_FIELDS = [
  "access_expires_at",
  "access_token",
  "device_id",
  "offline_entitlement",
  "offline_expires_at",
  "personal_space_id",
  "refresh_expires_at",
  "refresh_token",
  "user_id",
];

const ERROR_CODES = [
  "account_disabled",
  "account_not_found",
  "account_pending_deletion",
  "activation_conflict",
  "authorization_expired",
  "authorization_replayed",
  "candidate_already_reviewed",
  "candidate_dlp_blocked",
  "cloud_unavailable",
  "definition_archived",
  "deletion_window_expired",
  "device_limit_reached",
  "device_not_found",
  "idempotency_conflict",
  "identity_conflict",
  "installation_archived",
  "invalid_agent_content",
  "invalid_credentials",
  "invalid_device_proof",
  "invalid_experience_candidate",
  "invalid_request",
  "last_identity",
  "not_found",
  "organization_agent_forbidden",
  "organization_agent_not_found",
  "organization_archived",
  "organization_owner_transfer_required",
  "organization_publication_dlp_blocked",
  "organization_publication_policy_blocked",
  "organization_submission_conflict",
  "organization_submission_superseded",
  "official_agent_not_eligible",
  "official_client_version_unsupported",
  "official_installation_policy_blocked",
  "official_managed_update_conflict",
  "official_release_paused",
  "official_release_revision_conflict",
  "invitation_expired",
  "invitation_limit_reached",
  "invitation_revoked",
  "invitation_unavailable",
  "invitation_used",
  "member_limit_reached",
  "membership_conflict",
  "rate_limited",
  "runtime_incompatible",
  "self_revoke_replayed",
  "service_unavailable",
  "session_revoked",
  "verification_required",
  "version_conflict",
  "version_revoked",
  "workspace_archived",
  "workspace_conflict",
  "workspace_forbidden",
  "workspace_limit_reached",
  "workspace_not_found",
  "workspace_owner_unavailable",
];

const AGENT_SCHEMAS = [
  "AgentDefinition",
  "AgentInstallation",
  "AgentPolicySnapshot",
  "AgentVersion",
  "PublishInitialAgentRequest",
  "PublishNextAgentVersionRequest",
  "RuntimeBindingRecord",
];

const ORGANIZATION_AGENT_SCHEMAS = [
  "OrganizationAgentSubmission",
  "OrganizationAgentSubmissionDetail",
  "OrganizationAgentReview",
  "SubmitInitialOrganizationAgentRequest",
  "SubmitNextOrganizationAgentRequest",
  "ReviewOrganizationAgentRequest",
];

const ORGANIZATION_AGENT_ERROR_CODES = [
  "idempotency_conflict",
  "invalid_agent_content",
  "invalid_request",
  "organization_agent_forbidden",
  "organization_agent_not_found",
  "organization_archived",
  "organization_publication_dlp_blocked",
  "organization_publication_policy_blocked",
  "organization_submission_conflict",
  "organization_submission_superseded",
  "service_unavailable",
  "session_revoked",
];

const ORGANIZATION_AGENT_SCHEMA_PROPERTIES = {
  OrganizationAgentReview: [
    "decision",
    "id",
    "organization_policy_snapshot_id",
    "organization_policy_version",
    "reason_code",
    "reviewed_at",
    "reviewed_content_digest",
    "reviewer_user_id",
    "safe_note",
  ],
  OrganizationAgentSubmission: [
    "base_version_id",
    "content_digest",
    "definition_id",
    "id",
    "kind",
    "organization_id",
    "review",
    "revision",
    "status",
    "submitted_at",
    "submitted_by_user_id",
    "terminal_at",
    "updated_at",
  ],
  ReviewOrganizationAgentRequest: [
    "decision",
    "expected_revision",
    "reason_code",
    "safe_note",
  ],
  SubmitInitialOrganizationAgentRequest: [
    "bundle",
    "display_name",
    "icon_data",
    "icon_media_type",
    "kind",
    "manifest",
  ],
  SubmitNextOrganizationAgentRequest: [
    "base_version_id",
    "bundle",
    "definition_id",
    "kind",
    "manifest",
  ],
  WithdrawOrganizationAgentRequest: ["expected_revision"],
  OrganizationAgentErrorEnvelope: ["error"],
  OrganizationAgentSupersededEnvelope: ["error", "submission"],
};

const ORGANIZATION_AGENT_OPERATIONS = [
  [
    "/api/v1/organizations/{organization_id}/agent-definitions",
    "get",
    ["200", "400", "401", "404", "503"],
  ],
  [
    "/api/v1/organizations/{organization_id}/agent-definitions/{definition_id}",
    "get",
    ["200", "400", "401", "404", "503"],
  ],
  [
    "/api/v1/organizations/{organization_id}/agent-definitions/{definition_id}/versions",
    "get",
    ["200", "400", "401", "404", "503"],
  ],
  [
    "/api/v1/organizations/{organization_id}/agent-publication-submissions",
    "get",
    ["200", "400", "401", "403", "404", "503"],
  ],
  [
    "/api/v1/organizations/{organization_id}/agent-publication-submissions",
    "post",
    ["201", "400", "401", "403", "404", "409", "413", "422", "503"],
  ],
  [
    "/api/v1/organizations/{organization_id}/agent-publication-submissions/{submission_id}",
    "get",
    ["200", "400", "401", "403", "404", "503"],
  ],
  [
    "/api/v1/organizations/{organization_id}/agent-publication-submissions/{submission_id}/withdraw",
    "post",
    ["200", "400", "401", "403", "404", "409", "503"],
  ],
  [
    "/api/v1/organizations/{organization_id}/agent-publication-submissions/{submission_id}/reviews",
    "post",
    ["200", "400", "401", "403", "404", "409", "422", "503"],
  ],
];

const OFFICIAL_AGENT_SCHEMA_PROPERTIES = {
  OfficialAgentSummary: [
    "channel",
    "definition_id",
    "display_name",
    "icon_data",
    "icon_media_type",
    "installation_state",
    "official",
    "release_id",
    "release_revision_id",
    "runtime_maximum_version_exclusive",
    "runtime_minimum_version",
    "update_state",
    "version_id",
    "version_number",
  ],
  OfficialAgentListResponse: ["official_agents"],
  OfficialAgentDetail: ["agent", "version"],
  ApplyManagedOfficialUpdateRequest: [
    "expected_selected_release_revision_id",
    "target_release_revision_id",
  ],
  OfficialAgentInstallationSource: [
    "definition_id",
    "official_release_revision_id",
  ],
  NormalAgentInstallationSource: [
    "definition_id",
    "organization_id",
    "version_id",
    "workspace_id",
  ],
};

const OFFICIAL_AGENT_OPERATIONS = [
  [
    "/api/v1/official-agents",
    "get",
    ["200", "400", "401", "403", "409", "422", "503"],
  ],
  [
    "/api/v1/official-agents/{definition_id}",
    "get",
    ["200", "400", "401", "403", "409", "422", "503"],
  ],
  [
    "/api/v1/official-agents/{definition_id}/release",
    "get",
    ["200", "400", "401", "403", "409", "422", "503"],
  ],
  [
    "/api/v1/agent-installations/{installation_id}/managed-update",
    "get",
    ["200", "400", "401", "403", "404", "409", "422", "503"],
  ],
  [
    "/api/v1/agent-installations/{installation_id}/apply-managed-update",
    "post",
    ["200", "400", "401", "403", "404", "409", "413", "422", "503"],
  ],
];

const OFFICIAL_HEADER_REFS = [
  "#/components/parameters/OfficialAgentChannel",
  "#/components/parameters/OfficialDesktopVersion",
  "#/components/parameters/OfficialProductContext",
  "#/components/parameters/OfficialProductContextID",
];

const ORGANIZATION_ERROR_CODES = [
  "authentication_required",
  "department_limit_reached",
  "department_not_empty",
  "dissolution_blocked",
  "idempotency_conflict",
  "invalid_request",
  "invitation_expired",
  "invitation_limit_reached",
  "invitation_revoked",
  "invitation_unavailable",
  "invitation_used",
  "member_limit_reached",
  "membership_conflict",
  "organization_archived",
  "organization_conflict",
  "organization_forbidden",
  "organization_limit_reached",
  "organization_not_found",
  "organization_owner_transfer_required",
  "owner_transfer_target_invalid",
  "policy_version_conflict",
  "rate_limited",
  "service_unavailable",
];

const ORGANIZATION_SCHEMA_PROPERTIES = {
  AccountDeletionOwnershipErrorEnvelope: ["error"],
  OrganizationSummary: [
    "archived_at",
    "created_at",
    "current_policy_digest",
    "current_policy_version",
    "department_count",
    "display_name",
    "id",
    "member_count",
    "mutation_state",
    "revision",
    "role",
    "status",
    "updated_at",
  ],
  OrganizationMember: [
    "department_id",
    "joined_at",
    "nickname",
    "revision",
    "role",
    "updated_at",
    "user_id",
  ],
  OrganizationDepartment: [
    "archived_at",
    "created_at",
    "display_name",
    "id",
    "member_count",
    "revision",
    "status",
    "updated_at",
  ],
  OrganizationInvitation: [
    "accepted_at",
    "accepted_by_user_id",
    "created_at",
    "created_by_user_id",
    "expires_at",
    "id",
    "revoked_at",
    "status",
  ],
  OrganizationInvitationCreation: [
    "invitation",
    "invite_url",
    "secret_replayable",
    "token",
  ],
  OrganizationInvitationAcceptance: ["member", "organization"],
  OrganizationPolicySummary: [
    "content_digest",
    "created_at",
    "id",
    "issuer",
    "policy_version",
    "schema_version",
    "signing_key_id",
  ],
  OrganizationPolicySnapshot: [
    "content_digest",
    "created_at",
    "id",
    "issuer",
    "policy_document",
    "policy_version",
    "schema_version",
    "signature",
    "signing_key_id",
  ],
  OrganizationAuditEvent: [
    "actor_display",
    "created_at",
    "event_type",
    "id",
    "object_id",
    "object_type",
    "outcome",
    "reason_code",
    "request_id",
    "subject_display",
  ],
  OrganizationListResponse: ["items", "next_cursor"],
  OrganizationMemberListResponse: ["items", "next_cursor"],
  OrganizationDepartmentListResponse: ["items", "next_cursor"],
  OrganizationInvitationListResponse: ["items", "next_cursor"],
  OrganizationPolicyListResponse: ["items", "next_cursor"],
  OrganizationAuditListResponse: ["items", "next_cursor"],
  CreateOrganizationRequest: ["display_name"],
  RenameOrganizationRequest: ["display_name", "expected_revision"],
  OrganizationRevisionRequest: ["expected_revision"],
  TransferOrganizationOwnerRequest: [
    "confirmation",
    "expected_organization_revision",
    "expected_owner_revision",
    "expected_target_revision",
    "target_user_id",
  ],
  DissolveOrganizationRequest: [
    "confirmation",
    "display_name",
    "expected_revision",
  ],
  PatchOrganizationMemberRequest: [
    "department_id",
    "expected_revision",
    "role",
  ],
  CreateOrganizationDepartmentRequest: ["display_name"],
  RenameOrganizationDepartmentRequest: ["display_name", "expected_revision"],
  OrganizationDepartmentRevisionRequest: ["expected_revision"],
  AcceptOrganizationInvitationRequest: ["token"],
  PublishOrganizationPolicyRequest: [
    "expected_organization_revision",
    "expected_policy_version",
    "policy_document",
  ],
  OrganizationPolicyDocument: [
    "experience_candidates",
    "models",
    "official_agents",
    "schema_version",
    "tools",
  ],
  OrganizationErrorEnvelope: ["error"],
};

const ORGANIZATION_OPERATIONS = [
  ["/api/v1/organizations", "get", ["200", "400", "401", "503"]],
  [
    "/api/v1/organizations",
    "post",
    ["200", "201", "400", "401", "409", "413", "429", "503"],
  ],
  [
    "/api/v1/organizations/{organization_id}",
    "get",
    ["200", "400", "401", "404", "503"],
  ],
  [
    "/api/v1/organizations/{organization_id}",
    "patch",
    ["200", "400", "401", "403", "404", "409", "413", "429", "503"],
  ],
  ...["archive", "restore", "owner-transfer", "dissolve"].map((action) => [
    `/api/v1/organizations/{organization_id}/${action}`,
    "post",
    ["200", "400", "401", "403", "404", "409", "413", "429", "503"],
  ]),
  [
    "/api/v1/organizations/{organization_id}/members",
    "get",
    ["200", "400", "401", "404", "503"],
  ],
  [
    "/api/v1/organizations/{organization_id}/members/{user_id}",
    "patch",
    ["200", "400", "401", "403", "404", "409", "413", "429", "503"],
  ],
  [
    "/api/v1/organizations/{organization_id}/members/{user_id}",
    "delete",
    ["204", "400", "401", "403", "404", "409", "429", "503"],
  ],
  [
    "/api/v1/organizations/{organization_id}/leave",
    "post",
    ["204", "400", "401", "403", "404", "409", "413", "429", "503"],
  ],
  [
    "/api/v1/organizations/{organization_id}/departments",
    "get",
    ["200", "400", "401", "404", "503"],
  ],
  [
    "/api/v1/organizations/{organization_id}/departments",
    "post",
    ["201", "400", "401", "403", "404", "409", "413", "429", "503"],
  ],
  [
    "/api/v1/organizations/{organization_id}/departments/{department_id}",
    "patch",
    ["200", "400", "401", "403", "404", "409", "413", "429", "503"],
  ],
  ...["archive", "restore"].map((action) => [
    `/api/v1/organizations/{organization_id}/departments/{department_id}/${action}`,
    "post",
    ["200", "400", "401", "403", "404", "409", "413", "429", "503"],
  ]),
  [
    "/api/v1/organizations/{organization_id}/invitations",
    "get",
    ["200", "400", "401", "403", "404", "503"],
  ],
  [
    "/api/v1/organizations/{organization_id}/invitations",
    "post",
    ["200", "201", "400", "401", "403", "404", "409", "413", "429", "503"],
  ],
  [
    "/api/v1/organizations/{organization_id}/invitations/{invitation_id}",
    "delete",
    ["204", "400", "401", "403", "404", "409", "429", "503"],
  ],
  [
    "/api/v1/organization-invitations/accept",
    "post",
    ["200", "400", "401", "404", "409", "410", "413", "429", "503"],
  ],
  [
    "/api/v1/organizations/{organization_id}/policy",
    "get",
    ["200", "400", "401", "404", "503"],
  ],
  [
    "/api/v1/organizations/{organization_id}/policy-snapshots",
    "get",
    ["200", "400", "401", "403", "404", "503"],
  ],
  [
    "/api/v1/organizations/{organization_id}/policy-snapshots",
    "post",
    ["201", "400", "401", "403", "404", "409", "413", "429", "503"],
  ],
  [
    "/api/v1/organization-policy-snapshots/{policy_snapshot_id}",
    "get",
    ["200", "400", "401", "403", "404", "503"],
  ],
  [
    "/api/v1/organizations/{organization_id}/audit-events",
    "get",
    ["200", "400", "401", "403", "404", "503"],
  ],
];

const WORKSPACE_SCHEMA_PROPERTIES = {
  WorkspaceSummary: [
    "archived_at",
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
  WorkspaceMember: ["joined_at", "nickname", "revision", "role", "user_id"],
  WorkspaceInvitation: [
    "accepted_at",
    "accepted_by_user_id",
    "created_at",
    "created_by_user_id",
    "expires_at",
    "id",
    "revoked_at",
    "status",
  ],
  WorkspaceInvitationCreation: [
    "accepted_at",
    "accepted_by_user_id",
    "created_at",
    "created_by_user_id",
    "expires_at",
    "id",
    "invite_url",
    "revoked_at",
    "secret_replayable",
    "status",
    "token",
  ],
  WorkspaceInvitationAcceptance: ["member", "workspace"],
  WorkspaceListResponse: ["workspaces"],
  WorkspaceMemberListResponse: ["members"],
  WorkspaceInvitationListResponse: ["invitations"],
  CreateWorkspaceRequest: ["display_name"],
  RenameWorkspaceRequest: ["display_name", "expected_revision"],
  WorkspaceRevisionRequest: ["expected_revision"],
  ChangeWorkspaceMemberRoleRequest: ["expected_revision", "role"],
  AcceptWorkspaceInvitationRequest: ["token"],
};

const WORKSPACE_OPERATIONS = [
  ["/api/v1/workspaces", "get", ["200", "401", "503"]],
  [
    "/api/v1/workspaces",
    "post",
    ["200", "201", "400", "401", "409", "413", "429", "503"],
  ],
  [
    "/api/v1/workspaces/{workspace_id}",
    "patch",
    ["200", "400", "401", "403", "404", "409", "413", "503"],
  ],
  [
    "/api/v1/workspaces/{workspace_id}/archive",
    "post",
    ["200", "400", "401", "403", "404", "409", "413", "503"],
  ],
  [
    "/api/v1/workspaces/{workspace_id}/restore",
    "post",
    ["200", "400", "401", "403", "404", "409", "413", "503"],
  ],
  [
    "/api/v1/workspaces/{workspace_id}/members",
    "get",
    ["200", "400", "401", "404", "503"],
  ],
  [
    "/api/v1/workspaces/{workspace_id}/members/{user_id}",
    "patch",
    ["200", "400", "401", "403", "404", "409", "413", "503"],
  ],
  [
    "/api/v1/workspaces/{workspace_id}/members/{user_id}",
    "delete",
    ["204", "400", "401", "403", "404", "409", "503"],
  ],
  [
    "/api/v1/workspaces/{workspace_id}/leave",
    "post",
    ["204", "400", "401", "403", "404", "409", "413", "503"],
  ],
  [
    "/api/v1/workspaces/{workspace_id}/invitations",
    "get",
    ["200", "400", "401", "403", "404", "503"],
  ],
  [
    "/api/v1/workspaces/{workspace_id}/invitations",
    "post",
    ["200", "201", "400", "401", "403", "404", "409", "413", "429", "503"],
  ],
  [
    "/api/v1/workspaces/{workspace_id}/invitations/{invitation_id}",
    "delete",
    ["204", "400", "401", "403", "404", "409", "503"],
  ],
  [
    "/api/v1/workspace-invitations/accept",
    "post",
    ["200", "400", "401", "404", "409", "413", "429", "503"],
  ],
];

const WORKSPACE_AGENT_OPERATIONS = [
  [
    "/api/v1/workspaces/{workspace_id}/agent-definitions",
    "get",
    ["200", "400", "401", "404", "409", "503"],
  ],
  [
    "/api/v1/workspaces/{workspace_id}/agent-definitions",
    "post",
    ["201", "400", "401", "403", "404", "409", "413", "503"],
  ],
  [
    "/api/v1/workspaces/{workspace_id}/agent-definitions/{definition_id}",
    "get",
    ["200", "400", "401", "404", "409", "503"],
  ],
  [
    "/api/v1/workspaces/{workspace_id}/agent-definitions/{definition_id}/versions",
    "get",
    ["200", "400", "401", "404", "409", "503"],
  ],
  [
    "/api/v1/workspaces/{workspace_id}/agent-definitions/{definition_id}/versions",
    "post",
    ["201", "400", "401", "403", "404", "409", "413", "503"],
  ],
];

const EXPERIENCE_CANDIDATE_DLP_VERSION = "experience-candidate-dlp-v1";
const EXPERIENCE_CANDIDATE_VECTOR_DIGEST =
  "6fa5c97e58ee22e623505c2c80c7d1b0dd998c81a87bdadc317275e8165f91a2";

const EXPERIENCE_CANDIDATE_SCHEMA_PROPERTIES = {
  ExperienceCandidateAsset: ["content", "media_type", "path"],
  ExperienceCandidateBundle: ["assets", "schema_version", "skill_name"],
  SubmitExperienceCandidateRequest: [
    "bundle",
    "content_digest",
    "source_version_id",
  ],
  ReviewExperienceCandidateRequest: ["decision", "reason_code", "safe_note"],
  ExperienceCandidateReview: [
    "decision",
    "id",
    "reason_code",
    "reviewed_at",
    "reviewed_by_user_id",
    "safe_note",
  ],
  ExperienceCandidateSummary: [
    "agent_definition_id",
    "content_digest",
    "created_at",
    "dlp_contract_version",
    "id",
    "review",
    "skill_name",
    "source_agent_version_id",
    "submitted_by_user_id",
    "workspace_id",
  ],
  ExperienceCandidateDetail: [
    "agent_definition_id",
    "bundle",
    "content_digest",
    "created_at",
    "dlp_contract_version",
    "id",
    "review",
    "skill_name",
    "source_agent_version_id",
    "submitted_by_user_id",
    "workspace_id",
  ],
  ExperienceCandidateListResponse: ["candidates"],
  ExperienceCandidateFinding: ["code", "line", "path"],
  ExperienceCandidateErrorEnvelope: ["error"],
};

const EXPERIENCE_CANDIDATE_OPERATIONS = [
  [
    "/api/v1/workspaces/{workspace_id}/agent-definitions/{definition_id}/experience-candidates",
    "post",
    ["201", "400", "401", "403", "404", "409", "413", "503"],
  ],
  [
    "/api/v1/workspaces/{workspace_id}/experience-candidates/mine",
    "get",
    ["200", "400", "401", "404", "409", "503"],
  ],
  [
    "/api/v1/workspaces/{workspace_id}/experience-candidates",
    "get",
    ["200", "400", "401", "403", "404", "409", "503"],
  ],
  [
    "/api/v1/workspaces/{workspace_id}/experience-candidates/{candidate_id}",
    "get",
    ["200", "400", "401", "403", "404", "409", "503"],
  ],
  [
    "/api/v1/workspaces/{workspace_id}/experience-candidates/{candidate_id}/review",
    "post",
    ["200", "400", "401", "403", "404", "409", "413", "503"],
  ],
];

const EXACT_LOOPBACK_REDIRECT =
  "^http://127\\.0\\.0\\.1:[1-9][0-9]{0,4}/agentera/oauth/callback$";
const LOOPBACK_CALLBACK_RESPONSE =
  "^http://127\\.0\\.0\\.1:[1-9][0-9]{0,4}/agentera/oauth/callback\\?";

function fail(message) {
  throw new Error(`Aera cloud contract check failed: ${message}`);
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} is missing or invalid`);
  }
  return value;
}

function exactMembers(actual, expected, label) {
  const normalized = [...actual].sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(normalized) !== JSON.stringify(wanted)) {
    fail(`${label} changed: ${JSON.stringify(normalized)}`);
  }
}

function validateCriticalContract(document) {
  if (document.openapi !== "3.0.3") {
    fail(`OpenAPI dialect changed: ${String(document.openapi)}`);
  }
  if (document.info?.version !== "0.9.0") {
    fail(`OpenAPI version changed: ${String(document.info?.version)}`);
  }
  const paths = object(document.paths, "paths");
  for (const path of REQUIRED_PATHS) {
    if (!Object.hasOwn(paths, path))
      fail(`required endpoint ${path} is missing`);
  }

  const schemas = object(
    object(document.components, "components").schemas,
    "components.schemas",
  );
  const token = object(schemas.TokenResponse, "TokenResponse");
  exactMembers(token.required ?? [], TOKEN_FIELDS, "TokenResponse.required");
  exactMembers(
    Object.keys(object(token.properties, "TokenResponse.properties")),
    TOKEN_FIELDS,
    "TokenResponse.properties",
  );

  const codeLoginRequest = object(
    schemas.BrowserCodeLoginRequest,
    "BrowserCodeLoginRequest",
  );
  if (
    codeLoginRequest.type !== "object" ||
    codeLoginRequest.additionalProperties !== false
  ) {
    fail("BrowserCodeLoginRequest is no longer a strict object");
  }
  exactMembers(
    codeLoginRequest.required ?? [],
    ["verification_receipt"],
    "BrowserCodeLoginRequest.required",
  );
  const codeLoginProperties = object(
    codeLoginRequest.properties,
    "BrowserCodeLoginRequest.properties",
  );
  exactMembers(
    Object.keys(codeLoginProperties),
    ["verification_receipt"],
    "BrowserCodeLoginRequest.properties",
  );
  if (
    codeLoginProperties.verification_receipt?.type !== "string" ||
    codeLoginProperties.verification_receipt?.maxLength !== 8192
  ) {
    fail("BrowserCodeLoginRequest.verification_receipt changed");
  }
  exactMembers(
    object(
      object(paths["/api/v1/browser/login/code"], "/api/v1/browser/login/code")
        .post,
      "/api/v1/browser/login/code.post",
    ).responses
      ? Object.keys(
          object(
            object(
              paths["/api/v1/browser/login/code"],
              "/api/v1/browser/login/code",
            ).post.responses,
            "/api/v1/browser/login/code.post.responses",
          ),
        )
      : [],
    ["200", "400", "401", "403", "503"],
    "/api/v1/browser/login/code.post.responses",
  );
  if (
    !(
      object(schemas.VerificationPurpose, "VerificationPurpose").enum ?? []
    ).includes("login")
  ) {
    fail("VerificationPurpose no longer includes login");
  }

  const exchange = object(
    schemas.AuthorizationCodeExchangeRequest,
    "AuthorizationCodeExchangeRequest",
  );
  exactMembers(
    exchange.required ?? [],
    ["authorization_code", "code_verifier", "device_proof", "installation_id"],
    "AuthorizationCodeExchangeRequest.required",
  );

  const selfRevoke = object(
    schemas.DeviceSelfRevokeRequest,
    "DeviceSelfRevokeRequest",
  );
  exactMembers(
    selfRevoke.required ?? [],
    ["device_id", "installation_id", "nonce", "signature", "timestamp"],
    "DeviceSelfRevokeRequest.required",
  );

  exactMembers(
    object(schemas.ErrorCode, "ErrorCode").enum ?? [],
    ERROR_CODES,
    "ErrorCode.enum",
  );

  for (const schemaName of AGENT_SCHEMAS) {
    const schema = object(schemas[schemaName], schemaName);
    if (schema.type !== "object" || schema.additionalProperties !== false) {
      fail(`${schemaName} is no longer a strict object`);
    }
  }
  const nextPublicationRequest = object(
    schemas.PublishNextAgentVersionRequest,
    "PublishNextAgentVersionRequest",
  );
  exactMembers(
    nextPublicationRequest.required ?? [],
    ["base_version_id", "bundle", "display_name", "manifest"],
    "PublishNextAgentVersionRequest.required",
  );
  exactMembers(
    Object.keys(
      object(
        nextPublicationRequest.properties,
        "PublishNextAgentVersionRequest.properties",
      ),
    ),
    ["base_version_id", "bundle", "display_name", "manifest"],
    "PublishNextAgentVersionRequest.properties",
  );
  for (const schemaName of ORGANIZATION_AGENT_SCHEMAS) {
    object(schemas[schemaName], schemaName);
  }
  if (Object.hasOwn(schemas, "AgentDraft")) {
    fail("AgentDraft must remain desktop-local");
  }
  const installationRequest = object(
    schemas.CreateAgentInstallationRequest,
    "CreateAgentInstallationRequest",
  );
  exactMembers(
    (installationRequest.oneOf ?? []).map((arm) => arm?.$ref),
    [
      "#/components/schemas/NormalAgentInstallationSource",
      "#/components/schemas/OfficialAgentInstallationSource",
    ],
    "CreateAgentInstallationRequest.oneOf",
  );
  const normalInstallationSource = object(
    schemas.NormalAgentInstallationSource,
    "NormalAgentInstallationSource",
  );
  exactMembers(
    normalInstallationSource.required ?? [],
    ["definition_id", "version_id"],
    "NormalAgentInstallationSource.required",
  );
  const normalInstallationProperties = object(
    normalInstallationSource.properties,
    "NormalAgentInstallationSource.properties",
  );
  for (const sourceField of ["workspace_id", "organization_id"]) {
    if (
      normalInstallationProperties[sourceField]?.type !== "string" ||
      normalInstallationProperties[sourceField]?.format !== "uuid"
    ) {
      fail(`NormalAgentInstallationSource.${sourceField} changed`);
    }
  }
  const expectedInstallationSourceUnion = [
    {
      required: ["workspace_id"],
      not: { required: ["organization_id"] },
    },
    {
      required: ["organization_id"],
      not: { required: ["workspace_id"] },
    },
    {
      not: {
        anyOf: [
          { required: ["workspace_id"] },
          { required: ["organization_id"] },
        ],
      },
    },
  ];
  if (
    JSON.stringify(normalInstallationSource.oneOf) !==
    JSON.stringify(expectedInstallationSourceUnion)
  ) {
    fail("NormalAgentInstallationSource source union changed");
  }

  for (const [schemaName, expectedProperties] of Object.entries(
    OFFICIAL_AGENT_SCHEMA_PROPERTIES,
  )) {
    const schema = object(schemas[schemaName], schemaName);
    if (schema.type !== "object" || schema.additionalProperties !== false) {
      fail(`${schemaName} is no longer a strict object`);
    }
    exactMembers(
      Object.keys(object(schema.properties, `${schemaName}.properties`)),
      expectedProperties,
      `${schemaName}.properties`,
    );
  }
  exactMembers(
    schemas.OfficialAgentInstallationSource.required ?? [],
    ["definition_id", "official_release_revision_id"],
    "OfficialAgentInstallationSource.required",
  );
  exactMembers(
    schemas.ApplyManagedOfficialUpdateRequest.required ?? [],
    ["expected_selected_release_revision_id", "target_release_revision_id"],
    "ApplyManagedOfficialUpdateRequest.required",
  );
  const managedUpdate = object(
    schemas.OfficialManagedUpdateResponse,
    "OfficialManagedUpdateResponse",
  );
  if (!Array.isArray(managedUpdate.oneOf) || managedUpdate.oneOf.length !== 2) {
    fail("OfficialManagedUpdateResponse union changed");
  }
  for (const [index, arm] of managedUpdate.oneOf.entries()) {
    if (arm?.type !== "object" || arm?.additionalProperties !== false) {
      fail(`OfficialManagedUpdateResponse.oneOf[${index}] is not strict`);
    }
  }
  exactMembers(
    managedUpdate.oneOf[0].required ?? [],
    ["update_available"],
    "OfficialManagedUpdateResponse.no-update.required",
  );
  exactMembers(
    managedUpdate.oneOf[1].required ?? [],
    [
      "expected_selected_release_revision_id",
      "installation_id",
      "runtime_minimum_version",
      "target_release_revision_id",
      "target_version_id",
      "update_available",
    ],
    "OfficialManagedUpdateResponse.update.required",
  );
  const officialPublicSchemas = JSON.stringify({
    detail: schemas.OfficialAgentDetail,
    list: schemas.OfficialAgentListResponse,
    managedUpdate: schemas.OfficialManagedUpdateResponse,
    summary: schemas.OfficialAgentSummary,
  }).toLowerCase();
  for (const field of [
    "allowlist",
    "bucket",
    "device_id",
    "platform_id",
    "profile",
    "rollout_key",
    "session",
    "user_id",
  ]) {
    if (officialPublicSchemas.includes(`"${field}"`)) {
      fail(`Official catalog schemas exposed private field ${field}`);
    }
  }

  for (const [schemaName, expectedProperties] of Object.entries(
    ORGANIZATION_AGENT_SCHEMA_PROPERTIES,
  )) {
    const schema = object(schemas[schemaName], schemaName);
    if (schema.type !== "object" || schema.additionalProperties !== false) {
      fail(`${schemaName} is no longer a strict object`);
    }
    exactMembers(
      Object.keys(object(schema.properties, `${schemaName}.properties`)),
      expectedProperties,
      `${schemaName}.properties`,
    );
  }
  const organizationSubmissionDetail = object(
    schemas.OrganizationAgentSubmissionDetail,
    "OrganizationAgentSubmissionDetail",
  );
  if (
    organizationSubmissionDetail.allOf?.[0]?.$ref !==
      "#/components/schemas/OrganizationAgentSubmission" ||
    organizationSubmissionDetail.allOf?.[1]?.type !== "object"
  ) {
    fail("OrganizationAgentSubmissionDetail composition changed");
  }
  exactMembers(
    organizationSubmissionDetail.allOf[1].required ?? [],
    ["bundle", "bundle_digest", "manifest", "manifest_digest"],
    "OrganizationAgentSubmissionDetail.required",
  );
  exactMembers(
    Object.keys(
      object(
        organizationSubmissionDetail.allOf[1].properties,
        "OrganizationAgentSubmissionDetail.properties",
      ),
    ),
    [
      "bundle",
      "bundle_digest",
      "display_name",
      "icon_data",
      "icon_media_type",
      "manifest",
      "manifest_digest",
    ],
    "OrganizationAgentSubmissionDetail.properties",
  );
  exactMembers(
    object(
      schemas.OrganizationAgentSubmissionStatus,
      "OrganizationAgentSubmissionStatus",
    ).enum ?? [],
    ["approved", "pending", "rejected", "superseded", "withdrawn"],
    "OrganizationAgentSubmissionStatus.enum",
  );
  exactMembers(
    object(schemas.OrganizationAgentErrorCode, "OrganizationAgentErrorCode")
      .enum ?? [],
    ORGANIZATION_AGENT_ERROR_CODES,
    "OrganizationAgentErrorCode.enum",
  );
  const organizationMutationRequests = JSON.stringify({
    initial: schemas.SubmitInitialOrganizationAgentRequest,
    next: schemas.SubmitNextOrganizationAgentRequest,
    review: schemas.ReviewOrganizationAgentRequest,
    withdraw: schemas.WithdrawOrganizationAgentRequest,
  });
  for (const field of [
    "actor_id",
    "api_key",
    "credential",
    "memory",
    "organization_id",
    "owner_scope",
    "profile_path",
    "reviewer_user_id",
    "role",
    "runtime_profile_id",
    "session",
  ]) {
    if (organizationMutationRequests.includes(`"${field}"`)) {
      fail(`Organization Agent request schemas exposed ${field}`);
    }
  }

  for (const [schemaName, expectedProperties] of Object.entries(
    WORKSPACE_SCHEMA_PROPERTIES,
  )) {
    const schema = object(schemas[schemaName], schemaName);
    if (schema.type !== "object" || schema.additionalProperties !== false) {
      fail(`${schemaName} is no longer a strict object`);
    }
    exactMembers(
      Object.keys(object(schema.properties, `${schemaName}.properties`)),
      expectedProperties,
      `${schemaName}.properties`,
    );
  }
  for (const [schemaName, expectedProperties] of Object.entries(
    EXPERIENCE_CANDIDATE_SCHEMA_PROPERTIES,
  )) {
    const schema = object(schemas[schemaName], schemaName);
    if (schema.type !== "object" || schema.additionalProperties !== false) {
      fail(`${schemaName} is no longer a strict object`);
    }
    exactMembers(
      Object.keys(object(schema.properties, `${schemaName}.properties`)),
      expectedProperties,
      `${schemaName}.properties`,
    );
  }
  for (const [schemaName, expectedProperties] of Object.entries(
    ORGANIZATION_SCHEMA_PROPERTIES,
  )) {
    const schema = object(schemas[schemaName], schemaName);
    if (schema.type !== "object" || schema.additionalProperties !== false) {
      fail(`${schemaName} is no longer a strict object`);
    }
    exactMembers(
      Object.keys(object(schema.properties, `${schemaName}.properties`)),
      expectedProperties,
      `${schemaName}.properties`,
    );
  }
  exactMembers(
    object(schemas.ExperienceCandidateErrorCode, "ExperienceCandidateErrorCode")
      .enum ?? [],
    [
      "candidate_already_reviewed",
      "candidate_dlp_blocked",
      "definition_archived",
      "idempotency_conflict",
      "invalid_experience_candidate",
      "invalid_request",
      "not_found",
      "service_unavailable",
      "workspace_archived",
      "workspace_forbidden",
      "workspace_owner_unavailable",
    ],
    "ExperienceCandidateErrorCode.enum",
  );
  exactMembers(
    schemas.SubmitExperienceCandidateRequest.required ?? [],
    ["bundle", "content_digest", "source_version_id"],
    "SubmitExperienceCandidateRequest.required",
  );
  exactMembers(
    schemas.ReviewExperienceCandidateRequest.required ?? [],
    ["decision"],
    "ReviewExperienceCandidateRequest.required",
  );
  if (
    schemas.ExperienceCandidateSummary.properties?.dlp_contract_version
      ?.enum?.[0] !== EXPERIENCE_CANDIDATE_DLP_VERSION ||
    schemas.ExperienceCandidateDetail.properties?.dlp_contract_version
      ?.enum?.[0] !== EXPERIENCE_CANDIDATE_DLP_VERSION
  ) {
    fail("ExperienceCandidate DLP contract version changed");
  }
  if (
    schemas.ExperienceCandidateBundle.properties?.assets?.maxItems !== 32 ||
    schemas.ExperienceCandidateAsset.properties?.content?.maxLength !==
      256 * 1024
  ) {
    fail("ExperienceCandidate package limits changed");
  }
  const candidateRequestSchemas = JSON.stringify({
    submit: schemas.SubmitExperienceCandidateRequest,
    review: schemas.ReviewExperienceCandidateRequest,
  });
  for (const field of [
    "agent_installation_id",
    "definition_id",
    "device_id",
    "dlp_override",
    "installation_id",
    "owner_id",
    "owner_scope",
    "profile_path",
    "reviewed_by_user_id",
    "runtime_profile_id",
    "source_path",
    "workspace_id",
  ]) {
    if (candidateRequestSchemas.includes(`"${field}"`)) {
      fail(`ExperienceCandidate request schemas exposed ${field}`);
    }
  }
  exactMembers(
    object(schemas.WorkspaceRole, "WorkspaceRole").enum ?? [],
    ["owner", "admin", "member"],
    "WorkspaceRole.enum",
  );
  exactMembers(
    object(schemas.WorkspaceStatus, "WorkspaceStatus").enum ?? [],
    ["active", "archived"],
    "WorkspaceStatus.enum",
  );
  exactMembers(
    object(schemas.WorkspaceMutationState, "WorkspaceMutationState").enum ?? [],
    ["writable", "archived", "owner_unavailable"],
    "WorkspaceMutationState.enum",
  );
  exactMembers(
    object(schemas.WorkspaceInvitationStatus, "WorkspaceInvitationStatus")
      .enum ?? [],
    ["pending", "accepted", "revoked", "expired"],
    "WorkspaceInvitationStatus.enum",
  );
  exactMembers(
    object(schemas.OrganizationRole, "OrganizationRole").enum ?? [],
    ["owner", "admin", "auditor", "member"],
    "OrganizationRole.enum",
  );
  exactMembers(
    object(schemas.OrganizationStatus, "OrganizationStatus").enum ?? [],
    ["active", "archived", "dissolved"],
    "OrganizationStatus.enum",
  );
  exactMembers(
    object(schemas.OrganizationMutationState, "OrganizationMutationState")
      .enum ?? [],
    ["writable", "archived", "dissolved"],
    "OrganizationMutationState.enum",
  );
  exactMembers(
    object(schemas.OrganizationDepartmentStatus, "OrganizationDepartmentStatus")
      .enum ?? [],
    ["active", "archived"],
    "OrganizationDepartmentStatus.enum",
  );
  exactMembers(
    object(schemas.OrganizationInvitationStatus, "OrganizationInvitationStatus")
      .enum ?? [],
    ["pending", "accepted", "revoked", "expired"],
    "OrganizationInvitationStatus.enum",
  );
  exactMembers(
    object(schemas.OrganizationErrorCode, "OrganizationErrorCode").enum ?? [],
    ORGANIZATION_ERROR_CODES,
    "OrganizationErrorCode.enum",
  );

  const accountProfile = object(schemas.AccountProfile, "AccountProfile");
  if (
    !Object.hasOwn(
      object(accountProfile.properties, "AccountProfile.properties"),
      "owned_workspace_count",
    ) ||
    !(accountProfile.required ?? []).includes("owned_workspace_count")
  ) {
    fail("AccountProfile no longer discloses owned_workspace_count");
  }
  const invitationCreation = object(
    schemas.WorkspaceInvitationCreation,
    "WorkspaceInvitationCreation",
  );
  const invitationCreationProperties = object(
    invitationCreation.properties,
    "WorkspaceInvitationCreation.properties",
  );
  if (
    invitationCreationProperties.token?.minLength !== 43 ||
    invitationCreationProperties.token?.maxLength !== 43 ||
    invitationCreationProperties.token?.pattern !== "^[A-Za-z0-9_-]{43}$"
  ) {
    fail("Workspace invitation token constraint changed");
  }
  if (
    invitationCreationProperties.invite_url?.pattern !==
    "^agentera://workspace-invitation#[A-Za-z0-9_-]{43}$"
  ) {
    fail("Workspace invitation URL is no longer fragment-only");
  }
  const forbiddenWorkspaceFields = [
    "owner_scope",
    "MEMORY",
    "USER",
    "profile_path",
    "session",
    "credential",
    "api_key",
    "raw_token",
  ];
  const workspaceSchemas = JSON.stringify(
    Object.fromEntries(
      Object.keys(WORKSPACE_SCHEMA_PROPERTIES).map((name) => [
        name,
        schemas[name],
      ]),
    ),
  );
  for (const field of forbiddenWorkspaceFields) {
    if (workspaceSchemas.includes(`"${field}"`)) {
      fail(`Workspace schemas exposed private field ${field}`);
    }
  }

  const organizationSchemas = JSON.stringify(
    Object.fromEntries(
      Object.keys(ORGANIZATION_SCHEMA_PROPERTIES).map((name) => [
        name,
        schemas[name],
      ]),
    ),
  ).toLowerCase();
  for (const field of [
    "owner_scope",
    "runtimebinding",
    "runtime_binding",
    "profile",
    "memory",
    "session",
    "credential",
    "api_key",
    "private_skill",
    "curator",
    "token_digest",
    "email",
    "phone",
  ]) {
    if (organizationSchemas.includes(field)) {
      fail(`Organization schemas exposed private field ${field}`);
    }
  }

  const invitation = object(
    schemas.OrganizationInvitationCreation,
    "OrganizationInvitationCreation",
  ).properties;
  if (
    invitation.token?.minLength !== 43 ||
    invitation.token?.maxLength !== 43 ||
    invitation.token?.pattern !== "^[A-Za-z0-9_-]{43}$" ||
    invitation.invite_url?.pattern !==
      "^agentera://organization-invitation#[A-Za-z0-9_-]{43}$" ||
    invitation.secret_replayable?.enum?.[0] !== false
  ) {
    fail("Organization invitation one-time secret boundary changed");
  }
  const policySnapshot = object(
    schemas.OrganizationPolicySnapshot,
    "OrganizationPolicySnapshot",
  ).properties;
  if (
    policySnapshot.content_digest?.pattern !== "^[0-9a-f]{64}$" ||
    policySnapshot.signature?.pattern !== "^[A-Za-z0-9_-]{86}$"
  ) {
    fail("Organization policy digest or signature boundary changed");
  }
  const accountDeletionOwnershipError = object(
    object(
      object(
        schemas.AccountDeletionOwnershipErrorEnvelope,
        "AccountDeletionOwnershipErrorEnvelope",
      ).properties,
      "AccountDeletionOwnershipErrorEnvelope.properties",
    ).error,
    "AccountDeletionOwnershipErrorEnvelope.error",
  );
  exactMembers(
    Object.keys(
      object(
        accountDeletionOwnershipError.properties,
        "AccountDeletionOwnershipErrorEnvelope.error.properties",
      ),
    ),
    ["code", "message", "owned_organization_count", "request_id"],
    "AccountDeletionOwnershipErrorEnvelope.error.properties",
  );
  if (
    accountDeletionOwnershipError.properties.owned_organization_count
      ?.minimum !== 1
  ) {
    fail("Account deletion no longer returns only a positive safe owned count");
  }

  const workspaceIdempotency = object(
    object(
      object(document.components, "components").parameters,
      "components.parameters",
    ).WorkspaceIdempotencyKey,
    "WorkspaceIdempotencyKey",
  );
  if (
    workspaceIdempotency.name !== "Idempotency-Key" ||
    workspaceIdempotency.in !== "header" ||
    workspaceIdempotency.required !== true ||
    workspaceIdempotency.schema?.maxLength !== 128
  ) {
    fail("Workspace Idempotency-Key boundary changed");
  }
  for (const [path, method, statuses] of WORKSPACE_OPERATIONS) {
    const operation = object(
      object(paths[path], path)[method],
      `${path}.${method}`,
    );
    exactMembers(
      Object.keys(object(operation.responses, `${path}.${method}.responses`)),
      statuses,
      `${path}.${method}.responses`,
    );
    if (
      JSON.stringify(operation.security) !==
      JSON.stringify([{ desktopAccessToken: [] }])
    ) {
      fail(`${path}.${method} no longer uses only the desktop access token`);
    }
  }
  for (const [path, method, statuses] of WORKSPACE_AGENT_OPERATIONS) {
    const operation = object(
      object(paths[path], path)[method],
      `${path}.${method}`,
    );
    exactMembers(
      Object.keys(object(operation.responses, `${path}.${method}.responses`)),
      statuses,
      `${path}.${method}.responses`,
    );
    if (
      JSON.stringify(operation.security) !==
      JSON.stringify([{ desktopAccessToken: [] }])
    ) {
      fail(`${path}.${method} no longer uses only the desktop access token`);
    }
  }
  for (const [path, method, statuses] of EXPERIENCE_CANDIDATE_OPERATIONS) {
    const operation = object(
      object(paths[path], path)[method],
      `${path}.${method}`,
    );
    exactMembers(
      Object.keys(object(operation.responses, `${path}.${method}.responses`)),
      statuses,
      `${path}.${method}.responses`,
    );
    if (
      JSON.stringify(operation.security) !==
      JSON.stringify([{ desktopAccessToken: [] }])
    ) {
      fail(`${path}.${method} no longer uses only the desktop access token`);
    }
  }
  for (const [path, method, statuses] of ORGANIZATION_OPERATIONS) {
    const operation = object(
      object(paths[path], path)[method],
      `${path}.${method}`,
    );
    exactMembers(
      Object.keys(object(operation.responses, `${path}.${method}.responses`)),
      statuses,
      `${path}.${method}.responses`,
    );
    if (
      JSON.stringify(operation.security) !==
      JSON.stringify([{ desktopAccessToken: [] }])
    ) {
      fail(`${path}.${method} no longer uses only the desktop access token`);
    }
  }
  for (const [path, method, statuses] of ORGANIZATION_AGENT_OPERATIONS) {
    const operation = object(
      object(paths[path], path)[method],
      `${path}.${method}`,
    );
    exactMembers(
      Object.keys(object(operation.responses, `${path}.${method}.responses`)),
      statuses,
      `${path}.${method}.responses`,
    );
    if (
      JSON.stringify(operation.security) !==
      JSON.stringify([{ desktopAccessToken: [] }])
    ) {
      fail(`${path}.${method} no longer uses only the desktop access token`);
    }
  }
  for (const [path, method, statuses] of OFFICIAL_AGENT_OPERATIONS) {
    const operation = object(
      object(paths[path], path)[method],
      `${path}.${method}`,
    );
    exactMembers(
      Object.keys(object(operation.responses, `${path}.${method}.responses`)),
      statuses,
      `${path}.${method}.responses`,
    );
    if (
      JSON.stringify(operation.security) !==
      JSON.stringify([{ desktopAccessToken: [] }])
    ) {
      fail(`${path}.${method} no longer uses only the desktop access token`);
    }
    const headerRefs = (operation.parameters ?? [])
      .map((parameter) => parameter?.$ref)
      .filter((reference) => OFFICIAL_HEADER_REFS.includes(reference));
    exactMembers(headerRefs, OFFICIAL_HEADER_REFS, `${path}.${method}.headers`);
  }
  const createInstallationParameterRefs = object(
    object(paths["/api/v1/agent-installations"], "/api/v1/agent-installations")
      .post,
    "/api/v1/agent-installations.post",
  ).parameters.map((parameter) => parameter?.$ref);
  exactMembers(
    createInstallationParameterRefs,
    [
      "#/components/parameters/IdempotencyKey",
      "#/components/parameters/OfficialProductContextID",
      "#/components/parameters/OptionalOfficialAgentChannel",
      "#/components/parameters/OptionalOfficialDesktopVersion",
      "#/components/parameters/OptionalOfficialProductContext",
    ],
    "/api/v1/agent-installations.post.parameters",
  );
  const applyManagedUpdateParameters = object(
    object(
      paths[
        "/api/v1/agent-installations/{installation_id}/apply-managed-update"
      ],
      "/api/v1/agent-installations/{installation_id}/apply-managed-update",
    ).post,
    "/api/v1/agent-installations/{installation_id}/apply-managed-update.post",
  ).parameters;
  if (
    !Array.isArray(applyManagedUpdateParameters) ||
    !applyManagedUpdateParameters.some(
      (parameter) =>
        parameter?.$ref === "#/components/parameters/IdempotencyKey",
    )
  ) {
    fail("apply managed update is missing Idempotency-Key");
  }
  if (Object.keys(paths).some((path) => path.startsWith("/internal/"))) {
    fail("public contract exposed an Internal Admin endpoint");
  }
  for (const path of [
    "/api/v1/organizations/{organization_id}/agent-definitions",
    "/api/v1/organizations/{organization_id}/agent-definitions/{definition_id}/versions",
  ]) {
    if (object(paths[path], path).post !== undefined) {
      fail(
        `${path}.post must remain unavailable; Organization publication requires review`,
      );
    }
  }
  for (const path of [
    "/api/v1/organizations/{organization_id}/agent-publication-submissions",
    "/api/v1/organizations/{organization_id}/agent-publication-submissions/{submission_id}/withdraw",
    "/api/v1/organizations/{organization_id}/agent-publication-submissions/{submission_id}/reviews",
  ]) {
    const parameters = object(
      object(paths[path], path).post,
      `${path}.post`,
    ).parameters;
    if (
      !Array.isArray(parameters) ||
      !parameters.some(
        (parameter) =>
          parameter?.$ref === "#/components/parameters/IdempotencyKey",
      )
    ) {
      fail(`${path}.post is missing Idempotency-Key`);
    }
  }
  for (const path of [
    "/api/v1/workspaces/{workspace_id}/agent-definitions/{definition_id}/experience-candidates",
    "/api/v1/workspaces/{workspace_id}/experience-candidates/{candidate_id}/review",
  ]) {
    const parameters = object(
      object(paths[path], path).post,
      `${path}.post`,
    ).parameters;
    if (
      !Array.isArray(parameters) ||
      !parameters.some(
        (parameter) =>
          parameter?.$ref === "#/components/parameters/IdempotencyKey",
      )
    ) {
      fail(`${path}.post is missing Idempotency-Key`);
    }
  }
  for (const [path, method] of [
    ["/api/v1/workspaces", "post"],
    ["/api/v1/workspaces/{workspace_id}/invitations", "post"],
    ["/api/v1/workspace-invitations/accept", "post"],
  ]) {
    const parameters =
      object(object(paths[path], path)[method], `${path}.${method}`)
        .parameters ?? [];
    if (
      !Array.isArray(parameters) ||
      !parameters.some(
        (parameter) =>
          parameter?.$ref === "#/components/parameters/WorkspaceIdempotencyKey",
      )
    ) {
      fail(`${path}.${method} is missing Workspace Idempotency-Key`);
    }
  }

  const organizationParameters = object(
    object(document.components, "components").parameters,
    "components.parameters",
  );
  const organizationIdempotency = object(
    organizationParameters.OrganizationIdempotencyKey,
    "OrganizationIdempotencyKey",
  );
  if (
    organizationIdempotency.name !== "Idempotency-Key" ||
    organizationIdempotency.in !== "header" ||
    organizationIdempotency.required !== true ||
    organizationIdempotency.schema?.maxLength !== 128
  ) {
    fail("Organization Idempotency-Key boundary changed");
  }
  if (
    organizationParameters.OrganizationPageLimit?.schema?.minimum !== 1 ||
    organizationParameters.OrganizationPageLimit?.schema?.maximum !== 100 ||
    organizationParameters.OrganizationPageLimit?.schema?.default !== 50 ||
    organizationParameters.OrganizationCursor?.schema?.maxLength !== 684 ||
    organizationParameters.OrganizationCursor?.schema?.pattern !==
      "^[A-Za-z0-9_-]+$"
  ) {
    fail("Organization pagination boundary changed");
  }
  for (const [path, method] of [
    ["/api/v1/organizations", "post"],
    ["/api/v1/organizations/{organization_id}/archive", "post"],
    ["/api/v1/organizations/{organization_id}/restore", "post"],
    ["/api/v1/organizations/{organization_id}/owner-transfer", "post"],
    ["/api/v1/organizations/{organization_id}/dissolve", "post"],
    ["/api/v1/organizations/{organization_id}/invitations", "post"],
    ["/api/v1/organization-invitations/accept", "post"],
    ["/api/v1/organizations/{organization_id}/policy-snapshots", "post"],
  ]) {
    const parameters =
      object(object(paths[path], path)[method], `${path}.${method}`)
        .parameters ?? [];
    if (
      !Array.isArray(parameters) ||
      !parameters.some(
        (parameter) =>
          parameter?.$ref ===
          "#/components/parameters/OrganizationIdempotencyKey",
      )
    ) {
      fail(`${path}.${method} is missing Organization Idempotency-Key`);
    }
  }

  const deletionResponses = object(
    object(
      object(paths["/api/v1/accounts/deletion"], "/api/v1/accounts/deletion")
        .post,
      "/api/v1/accounts/deletion.post",
    ).responses,
    "/api/v1/accounts/deletion.post.responses",
  );
  if (
    deletionResponses["409"]?.content?.["application/json"]?.schema?.$ref !==
    "#/components/schemas/AccountDeletionOwnershipErrorEnvelope"
  ) {
    fail("Account deletion ownership conflict contract changed");
  }

  exactMembers(
    object(
      object(schemas.SigningKey, "SigningKey").properties,
      "SigningKey.properties",
    ).purpose.enum ?? [],
    [
      "access",
      "agent_policy",
      "agent_version",
      "offline_entitlement",
      "organization_policy",
    ],
    "SigningKey.purpose.enum",
  );
  const signingKeySetKeys = object(
    object(schemas.SigningKeySet, "SigningKeySet").properties,
    "SigningKeySet.properties",
  ).keys;
  if (
    signingKeySetKeys?.minItems !== 5 ||
    signingKeySetKeys?.maxItems !== 64 ||
    signingKeySetKeys?.uniqueItems !== true
  ) {
    fail("SigningKeySet rotation boundary changed");
  }

  const refreshResponses = object(
    object(
      object(paths["/api/v1/oauth/refresh"], "/api/v1/oauth/refresh").post,
      "/api/v1/oauth/refresh.post",
    ).responses,
    "/api/v1/oauth/refresh.responses",
  );
  if (
    object(refreshResponses["403"], "/api/v1/oauth/refresh.responses.403")
      .$ref !== "#/components/responses/AccountUnavailable"
  ) {
    fail("OAuth refresh no longer reports unavailable account state");
  }

  const authorize = object(paths["/oauth/authorize"], "/oauth/authorize");
  const parameters = object(authorize.get, "/oauth/authorize.get").parameters;
  if (!Array.isArray(parameters))
    fail("OAuth authorize parameters are missing");
  const redirect = parameters.find(
    (parameter) => parameter?.name === "redirect_uri",
  );
  if (redirect?.schema?.pattern !== EXACT_LOOPBACK_REDIRECT) {
    fail("OAuth redirect_uri is no longer confined to the exact loopback path");
  }
  if (
    schemas.AuthorizationApprovalResponse?.properties?.redirect_uri?.pattern !==
    LOOPBACK_CALLBACK_RESPONSE
  ) {
    fail("OAuth callback response constraint changed");
  }
}

const { contractSha256, output } = await renderAgenteraCloudTypes();
const contract = await readFile(
  resolve(projectRoot, "contracts/agentera-cloud.openapi.yaml"),
  "utf8",
);
let parsed;
try {
  parsed = parse(contract, { strict: true, uniqueKeys: true });
} catch (error) {
  fail(`pinned OpenAPI YAML is invalid: ${error.message}`);
}
validateCriticalContract(object(parsed, "OpenAPI document"));

const candidateVectorPath = resolve(
  projectRoot,
  "contracts/experience-candidate-v1-vectors.json",
);
let candidateVectorText;
let candidateVectors;
try {
  candidateVectorText = await readFile(candidateVectorPath, "utf8");
  candidateVectors = JSON.parse(candidateVectorText);
} catch (error) {
  fail(`candidate vectors are missing or invalid: ${error.message}`);
}
const candidateVectorDocument = object(
  candidateVectors,
  "ExperienceCandidate vectors",
);
if (
  candidateVectorDocument.contract_version !== EXPERIENCE_CANDIDATE_DLP_VERSION
) {
  fail(
    `candidate vector contract changed: ${String(candidateVectorDocument.contract_version)}`,
  );
}
if (
  !Array.isArray(candidateVectorDocument.canonical_cases) ||
  candidateVectorDocument.canonical_cases[0]?.content_digest !==
    EXPERIENCE_CANDIDATE_VECTOR_DIGEST ||
  !Array.isArray(candidateVectorDocument.canonical_rejections) ||
  !Array.isArray(candidateVectorDocument.dlp_cases)
) {
  fail(
    "candidate vectors no longer contain the locked canonical and DLP cases",
  );
}

let generated;
try {
  generated = await readFile(generatedPath, "utf8");
} catch {
  fail("generated TypeScript is missing; run npm run generate:agentera-cloud");
}
if (generated !== output) {
  fail("generated TypeScript is stale; run npm run generate:agentera-cloud");
}

const sibling = process.env.AGENTERA_CLOUD_CONTRACT_SOURCE
  ? resolve(projectRoot, process.env.AGENTERA_CLOUD_CONTRACT_SOURCE)
  : resolve(projectRoot, "../aera-cloud/api/openapi.yaml");
if (process.env.AGENTERA_SKIP_SIBLING_CONTRACT !== "1" && existsSync(sibling)) {
  const siblingBytes = await readFile(sibling);
  const siblingSha256 = createHash("sha256").update(siblingBytes).digest("hex");
  if (
    siblingSha256 !== contractSha256 ||
    siblingBytes.toString() !== contract
  ) {
    fail(
      `pinned SHA-256 ${contractSha256} differs from sibling ${siblingSha256}`,
    );
  }
  const siblingCandidateVectors = resolve(
    dirname(sibling),
    "experience-candidate-v1-vectors.json",
  );
  if (!existsSync(siblingCandidateVectors)) {
    fail("sibling ExperienceCandidate vectors are missing");
  }
  const siblingCandidateVectorText = await readFile(
    siblingCandidateVectors,
    "utf8",
  );
  if (siblingCandidateVectorText !== candidateVectorText) {
    fail("pinned ExperienceCandidate vectors differ from sibling");
  }
}

process.stdout.write(`Aera cloud contract OK: ${contractSha256}\n`);
