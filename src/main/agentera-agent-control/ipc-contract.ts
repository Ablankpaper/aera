import type {
  AgentDraft,
  AgentDraftAssetKind,
  AgenteraAgentControlErrorCode,
  AgenteraAgentControlResult,
  AgenteraAgentDefinitionSummary,
  AgenteraAgentInstallationSummary,
  AgenteraAgentVersionSummary,
  AgenteraClaimVersionInput,
  AgenteraInstallVersionInput,
  AgenteraRetryPendingInstallationInput,
  AgenteraSelectInstallationVersionInput,
  CreateAgentDraftInput,
  ExperienceCandidateFinding,
  PrepareExperienceCandidateInput,
  ReviewExperienceCandidateInput,
  SubmitExperienceCandidateInput,
  UpdateAgentDraftInput,
} from "../../shared/agentera-agent-control";
import type { AgentDefinition, AgentVersion } from "./client";
import type { LocalAgentInstallation } from "./installation-manager";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROFILE_ID_PATTERN = /^[a-z0-9_][a-z0-9_-]{0,63}$/;
const SKILL_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,98}[a-z0-9])?$/;
const REASON_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const FINDING_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_DRAFT_IPC_BYTES = 3 * 1024 * 1024;
const MAX_SAFE_NOTE_LENGTH = 240;
const MAX_FINDING_PATH_BYTES = 512;
const MAX_IPC_FINDINGS = 128;

function invalidRequest(): never {
  const error = new Error("AgentEra Agent control request is invalid.");
  Object.assign(error, { code: "invalid_request" });
  throw error;
}

function exactObject(
  value: unknown,
  fields: readonly string[],
): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value);
  return (
    keys.length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field))
  );
}

function cloneBounded<T>(value: unknown): T {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return invalidRequest();
  }
  if (
    typeof serialized !== "string" ||
    Buffer.byteLength(serialized, "utf8") > MAX_DRAFT_IPC_BYTES
  ) {
    return invalidRequest();
  }
  try {
    return JSON.parse(serialized) as T;
  } catch {
    return invalidRequest();
  }
}

export function parseAgentControlId(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    return invalidRequest();
  }
  return value.toLowerCase();
}

function parseProfileId(value: unknown): string {
  if (typeof value !== "string" || !PROFILE_ID_PATTERN.test(value)) {
    return invalidRequest();
  }
  return value;
}

function assertDraftShape(
  value: unknown,
  fields: readonly string[],
): asserts value is Record<string, unknown> {
  if (!exactObject(value, fields)) invalidRequest();
}

export function parseCreateDraftInput(value: unknown): CreateAgentDraftInput {
  assertDraftShape(value, [
    "sourceAgentDefinitionId",
    "baseAgentVersionId",
    "displayName",
    "icon",
    "manifest",
    "assets",
  ]);
  return cloneBounded<CreateAgentDraftInput>(value);
}

export function parseUpdateDraftInput(value: unknown): UpdateAgentDraftInput {
  assertDraftShape(value, [
    "id",
    "expectedRevision",
    "displayName",
    "icon",
    "manifest",
    "assets",
  ]);
  parseAgentControlId(value.id);
  if (
    !Number.isSafeInteger(value.expectedRevision) ||
    (value.expectedRevision as number) < 1
  ) {
    invalidRequest();
  }
  return cloneBounded<UpdateAgentDraftInput>(value);
}

export function parseInstallVersionInput(
  value: unknown,
): AgenteraInstallVersionInput {
  if (!exactObject(value, ["definitionId", "versionId", "profileName"])) {
    return invalidRequest();
  }
  return {
    definitionId: parseAgentControlId(value.definitionId),
    versionId: parseAgentControlId(value.versionId),
    profileName: parseProfileId(value.profileName),
  };
}

export function parseClaimVersionInput(
  value: unknown,
): AgenteraClaimVersionInput {
  if (
    !exactObject(value, [
      "definitionId",
      "versionId",
      "localProfileId",
      "confirmation",
    ]) ||
    value.confirmation !== "claim-existing-profile"
  ) {
    return invalidRequest();
  }
  return {
    definitionId: parseAgentControlId(value.definitionId),
    versionId: parseAgentControlId(value.versionId),
    localProfileId: parseProfileId(value.localProfileId),
    confirmation: "claim-existing-profile",
  };
}

export function parseRetryPendingInstallationInput(
  value: unknown,
): AgenteraRetryPendingInstallationInput {
  if (!exactObject(value, ["id", "target"])) return invalidRequest();
  const id = parseAgentControlId(value.id);
  const target = value.target;
  if (exactObject(target, ["kind", "profileName"]) && target.kind === "fresh") {
    return {
      id,
      target: {
        kind: "fresh",
        profileName: parseProfileId(target.profileName),
      },
    };
  }
  if (
    exactObject(target, ["kind", "localProfileId", "confirmation"]) &&
    target.kind === "claim" &&
    target.confirmation === "claim-existing-profile"
  ) {
    return {
      id,
      target: {
        kind: "claim",
        localProfileId: parseProfileId(target.localProfileId),
        confirmation: "claim-existing-profile",
      },
    };
  }
  return invalidRequest();
}

export function parseSelectInstallationVersionInput(
  value: unknown,
): AgenteraSelectInstallationVersionInput {
  if (!exactObject(value, ["id", "versionId", "localProfileId"])) {
    return invalidRequest();
  }
  return {
    id: parseAgentControlId(value.id),
    versionId: parseAgentControlId(value.versionId),
    localProfileId: parseProfileId(value.localProfileId),
  };
}

export function parsePrepareExperienceCandidateInput(
  value: unknown,
): PrepareExperienceCandidateInput {
  if (!exactObject(value, ["installationId", "skillName"])) {
    return invalidRequest();
  }
  if (
    typeof value.skillName !== "string" ||
    !SKILL_NAME_PATTERN.test(value.skillName)
  ) {
    return invalidRequest();
  }
  return {
    installationId: parseAgentControlId(value.installationId),
    skillName: value.skillName,
  };
}

export function parseSubmitExperienceCandidateInput(
  value: unknown,
): SubmitExperienceCandidateInput {
  if (
    !exactObject(value, ["candidateId", "confirmation"]) ||
    value.confirmation !== "submit-selected-skill"
  ) {
    return invalidRequest();
  }
  return {
    candidateId: parseAgentControlId(value.candidateId),
    confirmation: "submit-selected-skill",
  };
}

export function parseReviewExperienceCandidateInput(
  value: unknown,
): ReviewExperienceCandidateInput {
  if (
    !exactObject(value, ["candidateId", "decision", "reasonCode", "safeNote"])
  ) {
    return invalidRequest();
  }
  const candidateId = parseAgentControlId(value.candidateId);
  if (value.decision === "APPROVED") {
    if (value.reasonCode !== null || value.safeNote !== null) {
      return invalidRequest();
    }
    return {
      candidateId,
      decision: "APPROVED",
      reasonCode: null,
      safeNote: null,
    };
  }
  if (
    value.decision !== "REJECTED" ||
    typeof value.reasonCode !== "string" ||
    !REASON_CODE_PATTERN.test(value.reasonCode) ||
    (value.safeNote !== null &&
      (typeof value.safeNote !== "string" ||
        value.safeNote.length < 1 ||
        value.safeNote.length > MAX_SAFE_NOTE_LENGTH ||
        /[\r\n\0]/.test(value.safeNote)))
  ) {
    return invalidRequest();
  }
  return {
    candidateId,
    decision: "REJECTED",
    reasonCode: value.reasonCode,
    safeNote: value.safeNote,
  };
}

function safeFindingPath(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    value !== value.normalize("NFC") ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.includes("://") ||
    (value.length >= 2 && value[1] === ":") ||
    Buffer.byteLength(value, "utf8") > MAX_FINDING_PATH_BYTES
  ) {
    return false;
  }
  const segments = value.split("/");
  return (
    segments.length >= 3 &&
    segments[0] === "skills" &&
    segments.every(
      (segment) =>
        segment.length > 0 &&
        segment !== "." &&
        segment !== ".." &&
        !segment.startsWith("."),
    )
  );
}

function sanitizeExperienceCandidateFindings(
  error: unknown,
): ExperienceCandidateFinding[] {
  if (error === null || typeof error !== "object") return [];
  const raw = (error as { findings?: unknown }).findings;
  if (!Array.isArray(raw)) return [];
  const findings: ExperienceCandidateFinding[] = [];
  for (const candidate of raw.slice(0, MAX_IPC_FINDINGS)) {
    if (candidate === null || typeof candidate !== "object") continue;
    const finding = candidate as {
      code?: unknown;
      path?: unknown;
      line?: unknown;
    };
    if (
      typeof finding.code !== "string" ||
      !FINDING_CODE_PATTERN.test(finding.code) ||
      !safeFindingPath(finding.path) ||
      !(
        finding.line === null ||
        (Number.isSafeInteger(finding.line) && (finding.line as number) >= 1)
      )
    ) {
      continue;
    }
    findings.push({
      code: finding.code,
      path: finding.path,
      line: finding.line as number | null,
    });
  }
  return findings;
}

function mappedCode(error: unknown): AgenteraAgentControlErrorCode {
  const code =
    error !== null &&
    typeof error === "object" &&
    typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : "";
  if (code === "local_runtime_required") return "local_runtime_required";
  if (
    code === "authorization_expired" ||
    code === "offline_expired" ||
    code === "entitlement_required"
  ) {
    return "entitlement_required";
  }
  if (
    code === "draft_not_found" ||
    code === "installation_not_found" ||
    code === "candidate_not_found" ||
    code === "not_found" ||
    code === "cache_not_found"
  ) {
    return "not_found";
  }
  if (
    code.includes("conflict") ||
    code === "draft_conflict" ||
    code === "version_revoked" ||
    code === "installation_archived"
  ) {
    return "conflict";
  }
  if (
    code === "verification_failed" ||
    code.includes("signature") ||
    code.includes("digest") ||
    code === "cache_corrupt" ||
    code === "published_content_mismatch"
  ) {
    return "verification_failed";
  }
  if (code === "runtime_incompatible" || code === "runtime_drift") {
    return "runtime_incompatible";
  }
  if (
    code === "service_unavailable" ||
    code === "creation_failed" ||
    code === "cloud_unavailable"
  ) {
    return "cloud_unavailable";
  }
  if (code === "sign_in_required" || code === "invalid_credentials") {
    return "sign_in_required";
  }
  if (code === "online_required") return "online_required";
  if (code === "workspace_forbidden") return "workspace_forbidden";
  if (code === "workspace_archived") return "workspace_archived";
  if (code === "workspace_owner_unavailable") {
    return "workspace_owner_unavailable";
  }
  if (code === "candidate_source_ineligible") {
    return "candidate_source_ineligible";
  }
  if (code === "candidate_dlp_blocked") return "candidate_dlp_blocked";
  if (code === "candidate_already_reviewed") {
    return "candidate_already_reviewed";
  }
  if (code.startsWith("invalid_")) return "invalid_request";
  return "operation_failed";
}

export async function executeAgentControlIpc<T>(
  task: () => T | Promise<T>,
): Promise<AgenteraAgentControlResult<T>> {
  try {
    return { ok: true, data: await task() };
  } catch (error) {
    const errorCode = mappedCode(error);
    if (errorCode === "candidate_dlp_blocked") {
      const findings = sanitizeExperienceCandidateFindings(error);
      if (findings.length > 0) {
        return { ok: false, errorCode, findings };
      }
    }
    return { ok: false, errorCode };
  }
}

export function serializeDefinition(
  definition: AgentDefinition,
): AgenteraAgentDefinitionSummary {
  return {
    id: parseAgentControlId(definition.id),
    displayName: definition.display_name,
    status: definition.status,
    latestVersionId: definition.latest_version_id ?? null,
    createdAt: definition.created_at,
    updatedAt: definition.updated_at,
  };
}

export function serializeVersion(
  version: AgentVersion,
): AgenteraAgentVersionSummary {
  const assetCounts: Record<AgentDraftAssetKind, number> = {
    skill: 0,
    sop: 0,
    knowledge: 0,
  };
  for (const asset of version.manifest.assets) assetCounts[asset.kind] += 1;
  return {
    id: parseAgentControlId(version.id),
    definitionId: parseAgentControlId(version.definition_id),
    versionNumber: version.version_number,
    contentDigest: version.content_digest,
    publishedAt: version.published_at,
    runtimeMinimumVersion: version.runtime_minimum_version,
    runtimeMaximumVersionExclusive:
      version.runtime_maximum_version_exclusive ?? null,
    assetCounts,
  };
}

export function serializeInstallation(
  installation: LocalAgentInstallation,
): AgenteraAgentInstallationSummary {
  return {
    id: installation.agentInstallationId,
    definitionId: installation.definitionId,
    selectedVersionId: installation.selectedVersionId,
    runtimeProfileId: installation.runtimeProfileId,
    policySnapshotId: installation.policySnapshotId,
    status: installation.status,
    retryCode: installation.retryCode,
    createdAt: installation.createdAt,
    updatedAt: installation.updatedAt,
  };
}

/** Marker used by type-level boundary tests: drafts are already exact public DTOs. */
export function serializeDraft(draft: AgentDraft): AgentDraft {
  return draft;
}
