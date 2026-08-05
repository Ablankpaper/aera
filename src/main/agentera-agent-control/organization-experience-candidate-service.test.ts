// @vitest-environment node

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgenteraAuthPublicState } from "../../shared/agentera-auth";
import type { AgenteraAgentControlContext } from "../../shared/agentera-agent-control";
import type { AgenteraRuntimeOwner } from "../agentera-profile-binding";
import {
  AgenteraAgentControlClientError,
  type AgenteraAgentControlClient,
  type CloudOrganizationExperienceCandidateDetail,
  type CloudOrganizationExperienceCandidateSummary,
  type SubmitOrganizationExperienceCandidateRequest,
} from "./client";
import {
  openAgenteraControlPlaneDatabase,
  type AgenteraControlPlaneDatabase,
  type AgenteraSqliteDatabase,
} from "./db";
import { canonicalizeExperienceCandidate } from "./experience-candidate-contract";
import type { HermesSkillCandidateSource } from "./hermes-skill-candidate-source";
import type { LocalAgentInstallation } from "./installation-manager";
import {
  OrganizationExperienceCandidateService,
  OrganizationExperienceCandidateServiceError,
  type OrganizationExperienceCandidateImportOrchestrator,
} from "./organization-experience-candidate-service";
import { OrganizationExperienceCandidateStore } from "./organization-experience-candidate-store";

const OWNER: AgenteraRuntimeOwner = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  ownerId: "22222222-2222-4222-8222-222222222222",
  deviceInstallationId: "33333333-3333-4333-8333-333333333333",
};
const INSTALLATION_ID = "44444444-4444-4444-8444-444444444444";
const ORGANIZATION_ID = "55555555-5555-4555-8555-555555555555";
const DEFINITION_ID = "66666666-6666-4666-8666-666666666666";
const VERSION_ID = "77777777-7777-4777-8777-777777777777";
const PROFILE_ID = "88888888-8888-4888-8888-888888888888";
const LOCAL_CANDIDATE_ID = "99999999-9999-4999-8999-999999999999";
const CANDIDATE_HANDLE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CLOUD_CANDIDATE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const REVIEW_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const REVIEW_HANDLE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const IMPORT_HANDLE = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const PROFILE_PATH = "/isolated/profile";
const NOW = new Date("2026-08-05T09:00:00.000Z");

let root: string;
let database: AgenteraControlPlaneDatabase;
let store: OrganizationExperienceCandidateStore;
let source: HermesSkillCandidateSource;
let client: AgenteraAgentControlClient;
let importer: OrganizationExperienceCandidateImportOrchestrator;
let authState: AgenteraAuthPublicState;
let context: AgenteraAgentControlContext;
let installation: LocalAgentInstallation;
let generatedIds: string[];

function nodeSqliteFactory(path: string): AgenteraSqliteDatabase {
  return new DatabaseSync(path) as unknown as AgenteraSqliteDatabase;
}

function bundle() {
  return canonicalizeExperienceCandidate({
    schemaVersion: 1,
    skillName: "weekly-summary",
    assets: [
      {
        path: "skills/weekly-summary/SKILL.md",
        mediaType: "text/markdown",
        content: "# Weekly summary\n",
      },
    ],
  });
}

function cloudSummary(
  reviewed = false,
): CloudOrganizationExperienceCandidateSummary {
  const canonical = bundle();
  return {
    id: CLOUD_CANDIDATE_ID,
    organization_id: ORGANIZATION_ID,
    agent_definition_id: DEFINITION_ID,
    source_agent_version_id: VERSION_ID,
    submitted_by_user_id: OWNER.ownerId,
    skill_name: canonical.bundle.skillName,
    dlp_contract_version: "experience-candidate-dlp-v1",
    content_digest: canonical.contentDigest,
    created_at: NOW.toISOString(),
    ...(reviewed
      ? {
          review: {
            id: REVIEW_ID,
            reviewed_by_user_id: OWNER.ownerId,
            decision: "APPROVED" as const,
            reviewed_at: NOW.toISOString(),
          },
        }
      : {}),
  };
}

function cloudDetail(
  _request?: SubmitOrganizationExperienceCandidateRequest,
  reviewed = false,
): CloudOrganizationExperienceCandidateDetail {
  const canonical = bundle();
  return {
    ...cloudSummary(reviewed),
    bundle: {
      schema_version: 1,
      skill_name: canonical.bundle.skillName,
      assets: canonical.bundle.assets.map((asset) => ({
        path: asset.path,
        media_type: asset.mediaType,
        content: asset.content,
      })),
    },
  };
}

function onlineAuthState(): AgenteraAuthPublicState {
  return {
    status: "authenticated",
    userId: OWNER.ownerId,
    personalSpaceId: OWNER.tenantId,
    deviceId: OWNER.deviceInstallationId,
    offlineExpiresAt: "2026-08-12T00:00:00.000Z",
    cloudAvailable: true,
  };
}

function service(): OrganizationExperienceCandidateService {
  return new OrganizationExperienceCandidateService({
    client,
    store,
    source,
    getInstallation: (id) => {
      if (id !== INSTALLATION_ID) throw new Error("not found");
      return { ...installation };
    },
    resolveProfilePath: () => PROFILE_PATH,
    getContext: () => context,
    getAuthState: () => authState,
    importer,
    now: () => NOW,
    randomUUID: () => generatedIds.shift() ?? randomUUID(),
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agentera-org-experience-service-"));
  database = openAgenteraControlPlaneDatabase(join(root, "user-data"), {
    databaseFactory: nodeSqliteFactory,
  });
  database.sqlite
    .prepare(
      `INSERT INTO local_agent_installations (
         agent_installation_id, tenant_id, owner_id, device_installation_id,
         source_scope, source_workspace_id, source_organization_id,
         official_release_id, selected_release_revision_id, update_policy,
         definition_id, selected_version_id, runtime_profile_id,
         policy_snapshot_id, status, retry_code, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'ORGANIZATION', NULL, ?, NULL, NULL, 'manual',
                 ?, ?, ?, NULL, 'active', NULL, ?, ?)`,
    )
    .run(
      INSTALLATION_ID,
      OWNER.tenantId,
      OWNER.ownerId,
      OWNER.deviceInstallationId,
      ORGANIZATION_ID,
      DEFINITION_ID,
      VERSION_ID,
      PROFILE_ID,
      NOW.toISOString(),
      NOW.toISOString(),
    );
  store = new OrganizationExperienceCandidateStore({
    database,
    owner: OWNER,
    now: () => NOW,
  });
  installation = {
    agentInstallationId: INSTALLATION_ID,
    sourceScope: "ORGANIZATION",
    sourceWorkspaceId: null,
    sourceOrganizationId: ORGANIZATION_ID,
    officialReleaseId: null,
    selectedReleaseRevisionId: null,
    updatePolicy: "manual",
    definitionId: DEFINITION_ID,
    selectedVersionId: VERSION_ID,
    runtimeProfileId: PROFILE_ID,
    policySnapshotId: null,
    status: "active",
    retryCode: null,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  };
  source = {
    listEligible: vi.fn(() => [
      { skillName: "weekly-summary", description: "Weekly summary" },
    ]),
    readCandidate: vi.fn(() => ({
      provenance: { kind: "agent-created" as const },
      sourceRelativePath: "skills/writing/weekly-summary",
      bundle: bundle().bundle,
    })),
  };
  client = {
    submitOrganizationExperienceCandidate: vi.fn(async (_org, _def, request) =>
      cloudDetail(request),
    ),
    listOwnOrganizationExperienceCandidates: vi.fn(async () => []),
    listOrganizationExperienceCandidates: vi.fn(async () => []),
    getOrganizationExperienceCandidate: vi.fn(async () => cloudDetail()),
    reviewOrganizationExperienceCandidate: vi.fn(async () =>
      cloudDetail(undefined, true),
    ),
  } as unknown as AgenteraAgentControlClient;
  importer = {
    prepare: vi.fn(async () => ({
      importHandle: IMPORT_HANDLE,
      candidateId: CLOUD_CANDIDATE_ID,
      sourceVersionId: VERSION_ID,
      latestVersionId: VERSION_ID,
      latestVersionNumber: 1,
      skillName: "weekly-summary",
      replacesExistingSkill: false,
      addedPaths: ["skills/weekly-summary/SKILL.md"],
      replacedPaths: [],
      removedPaths: [],
    })),
    confirm: vi.fn(async () => ({ id: LOCAL_CANDIDATE_ID }) as never),
    clearPreparedImports: vi.fn(),
  };
  authState = {
    status: "offline",
    userId: OWNER.ownerId,
    personalSpaceId: OWNER.tenantId,
    deviceId: OWNER.deviceInstallationId,
    offlineExpiresAt: "2026-08-12T00:00:00.000Z",
    cloudAvailable: false,
  };
  context = {
    scope: "ORGANIZATION",
    organizationId: ORGANIZATION_ID,
    role: "member",
  };
  generatedIds = [LOCAL_CANDIDATE_ID, CANDIDATE_HANDLE, REVIEW_HANDLE];
});

afterEach(() => {
  database.close();
  rmSync(root, { recursive: true, force: true });
});

describe("OrganizationExperienceCandidateService", () => {
  it("requires an exact active Organization Installation and agent-created provenance", () => {
    expect(service().listEligibleSkills(INSTALLATION_ID)).toEqual([
      { skillName: "weekly-summary", description: "Weekly summary" },
    ]);
    for (const invalid of [
      { status: "pending" as const },
      { sourceScope: "WORKSPACE" as const, sourceOrganizationId: null },
      { sourceOrganizationId: randomUUID() },
      { runtimeProfileId: null },
    ]) {
      installation = { ...installation, ...invalid };
      expect(() => service().listEligibleSkills(INSTALLATION_ID)).toThrowError(
        new OrganizationExperienceCandidateServiceError(
          "candidate_source_ineligible",
        ),
      );
      installation = {
        ...installation,
        sourceScope: "ORGANIZATION",
        sourceOrganizationId: ORGANIZATION_ID,
        runtimeProfileId: PROFILE_ID,
        status: "active",
      };
    }
  });

  it("prepares offline, DLP-scans locally, and retries one explicit Cloud submission", async () => {
    const candidateService = service();
    const preview = candidateService.prepare({
      installationId: INSTALLATION_ID,
      skillName: "weekly-summary",
    });
    expect(preview).toMatchObject({
      candidateHandle: CANDIDATE_HANDLE,
      installationId: INSTALLATION_ID,
      sourceAgentVersionId: VERSION_ID,
      skillName: "weekly-summary",
      findings: [],
    });
    expect(JSON.stringify(preview)).not.toMatch(/profile|sourceRelativePath/i);
    await expect(
      candidateService.submit({
        candidateHandle: CANDIDATE_HANDLE,
        confirmation: "submit-selected-organization-skill",
      }),
    ).rejects.toMatchObject({ code: "online_required" });
    expect(client.submitOrganizationExperienceCandidate).not.toHaveBeenCalled();

    authState = onlineAuthState();
    vi.mocked(
      client.submitOrganizationExperienceCandidate,
    ).mockRejectedValueOnce(
      new AgenteraAgentControlClientError(0, "network_unavailable"),
    );
    await expect(
      candidateService.submit({
        candidateHandle: CANDIDATE_HANDLE,
        confirmation: "submit-selected-organization-skill",
      }),
    ).rejects.toMatchObject({ code: "cloud_unavailable" });
    await expect(
      candidateService.submit({
        candidateHandle: CANDIDATE_HANDLE,
        confirmation: "submit-selected-organization-skill",
      }),
    ).resolves.toMatchObject({
      candidateHandle: CANDIDATE_HANDLE,
      cloudCandidateId: CLOUD_CANDIDATE_ID,
      localStatus: "SUBMITTED",
    });
    const calls = vi.mocked(client.submitOrganizationExperienceCandidate).mock
      .calls;
    expect(calls[0][3]).toBe(calls[1][3]);
    expect(calls[1]).toEqual([
      ORGANIZATION_ID,
      DEFINITION_ID,
      expect.objectContaining({
        source_version_id: VERSION_ID,
        skill_name: "weekly-summary",
        schema_version: 1,
        dlp_contract_version: "experience-candidate-dlp-v1",
      }),
      expect.any(String),
    ]);
    expect(JSON.stringify(calls[1][2])).not.toMatch(
      /HERMES_HOME|MEMORY\.md|USER\.md|token|profilePath/i,
    );
  });

  it("allows Member own-list while Owner/Admin alone receive review handles", async () => {
    authState = onlineAuthState();
    const candidateService = service();
    await expect(candidateService.listMine()).resolves.toEqual([]);
    await expect(candidateService.listReviewQueue()).rejects.toMatchObject({
      code: "organization_agent_forbidden",
    });

    context = {
      scope: "ORGANIZATION",
      organizationId: ORGANIZATION_ID,
      role: "owner",
    };
    vi.mocked(
      client.listOrganizationExperienceCandidates,
    ).mockResolvedValueOnce([cloudSummary()]);
    generatedIds = [REVIEW_HANDLE];
    const [pending] = await candidateService.listReviewQueue();
    expect(pending).toMatchObject({
      cloudCandidateId: CLOUD_CANDIDATE_ID,
      reviewHandle: REVIEW_HANDLE,
    });
    await expect(
      candidateService.review({
        reviewHandle: REVIEW_HANDLE,
        confirmation: "approve-organization-experience",
        reasonCode: null,
        safeNote: null,
      }),
    ).resolves.toMatchObject({ reviewStatus: "APPROVED" });
    expect(client.reviewOrganizationExperienceCandidate).toHaveBeenCalledWith(
      ORGANIZATION_ID,
      CLOUD_CANDIDATE_ID,
      { decision: "APPROVED" },
      expect.any(String),
    );
  });

  it("routes approved import only through online Owner/Admin context", async () => {
    authState = onlineAuthState();
    const candidateService = service();
    await expect(
      candidateService.prepareImport(CLOUD_CANDIDATE_ID),
    ).rejects.toMatchObject({ code: "organization_agent_forbidden" });
    context = {
      scope: "ORGANIZATION",
      organizationId: ORGANIZATION_ID,
      role: "admin",
    };
    await expect(
      candidateService.prepareImport(CLOUD_CANDIDATE_ID),
    ).resolves.toMatchObject({ importHandle: IMPORT_HANDLE });
    expect(importer.prepare).toHaveBeenCalledWith(
      ORGANIZATION_ID,
      CLOUD_CANDIDATE_ID,
    );
    await candidateService.confirmImport({
      importHandle: IMPORT_HANDLE,
      confirmation: "apply-approved-skill-to-organization-draft",
    });
    expect(importer.confirm).toHaveBeenCalledWith(ORGANIZATION_ID, {
      importHandle: IMPORT_HANDLE,
      confirmation: "apply-approved-skill-to-organization-draft",
    });
  });
});
