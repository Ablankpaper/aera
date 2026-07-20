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
  "/api/v1/agent-installations/{installation_id}/activate",
  "/api/v1/agent-installations/{installation_id}/archive",
  "/api/v1/agent-installations/{installation_id}/select-version",
  "/api/v1/agent-versions/{version_id}",
  "/api/v1/agent-versions/{version_id}/revocations",
  "/api/v1/policy-snapshots/{policy_snapshot_id}",
  "/api/v1/browser/login",
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
  "invitation_limit_reached",
  "invitation_unavailable",
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
  "CreateAgentInstallationRequest",
  "PublishInitialAgentRequest",
  "PublishNextAgentVersionRequest",
  "RuntimeBindingRecord",
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
  throw new Error(`AgentEra cloud contract check failed: ${message}`);
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
  if (document.info?.version !== "0.5.0") {
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
  if (Object.hasOwn(schemas, "AgentDraft")) {
    fail("AgentDraft must remain desktop-local");
  }
  const installationRequest = object(
    schemas.CreateAgentInstallationRequest,
    "CreateAgentInstallationRequest",
  );
  exactMembers(
    installationRequest.required ?? [],
    ["definition_id", "version_id"],
    "CreateAgentInstallationRequest.required",
  );
  exactMembers(
    Object.keys(
      object(
        installationRequest.properties,
        "CreateAgentInstallationRequest.properties",
      ),
    ),
    ["definition_id", "version_id", "workspace_id"],
    "CreateAgentInstallationRequest.properties",
  );
  if (
    installationRequest.properties.workspace_id?.type !== "string" ||
    installationRequest.properties.workspace_id?.format !== "uuid"
  ) {
    fail("CreateAgentInstallationRequest.workspace_id changed");
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
      ?.const !== EXPERIENCE_CANDIDATE_DLP_VERSION ||
    schemas.ExperienceCandidateDetail.properties?.dlp_contract_version
      ?.const !== EXPERIENCE_CANDIDATE_DLP_VERSION
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

  exactMembers(
    object(
      object(schemas.SigningKey, "SigningKey").properties,
      "SigningKey.properties",
    ).purpose.enum ?? [],
    ["access", "agent_policy", "agent_version", "offline_entitlement"],
    "SigningKey.purpose.enum",
  );

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

process.stdout.write(`AgentEra cloud contract OK: ${contractSha256}\n`);
