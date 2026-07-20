// @vitest-environment node

import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgenteraAuthPublicState } from "../../shared/agentera-auth";
import type {
  AgentDraftDetail,
  AgenteraAgentControlContext,
  ConfirmExperienceCandidateImportInput,
  ExperienceCandidateBundleV1,
  ExperienceCandidateImportPreview,
} from "../../shared/agentera-agent-control";
import type { AgenteraRuntimeOwner } from "../agentera-profile-binding";
import {
  AgenteraAgentControlClientError,
  type AgenteraAgentControlClient,
  type CloudExperienceCandidateDetail,
  type CloudExperienceCandidateSummary,
  type SubmitExperienceCandidateRequest,
} from "./client";
import {
  openAgenteraControlPlaneDatabase,
  type AgenteraControlPlaneDatabase,
  type AgenteraSqliteDatabase,
} from "./db";
import {
  ExperienceCandidateService,
  ExperienceCandidateServiceError,
  type ExperienceCandidateImportOrchestrator,
} from "./experience-candidate-service";
import { ExperienceCandidateStore } from "./experience-candidate-store";
import type {
  EligibleExperienceSkill,
  HermesSkillCandidateSource,
} from "./hermes-skill-candidate-source";
import type { LocalAgentInstallation } from "./installation-manager";

const OWNER: AgenteraRuntimeOwner = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  ownerId: "22222222-2222-4222-8222-222222222222",
  deviceInstallationId: "33333333-3333-4333-8333-333333333333",
};
const INSTALLATION_ID = "44444444-4444-4444-8444-444444444444";
const WORKSPACE_ID = "55555555-5555-4555-8555-555555555555";
const DEFINITION_ID = "66666666-6666-4666-8666-666666666666";
const VERSION_ID = "77777777-7777-4777-8777-777777777777";
const PROFILE_ID = "88888888-8888-4888-8888-888888888888";
const CANDIDATE_ID = "99999999-9999-4999-8999-999999999999";
const SECOND_CANDIDATE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CLOUD_CANDIDATE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CLOUD_ONLY_CANDIDATE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const REVIEW_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const NOW = new Date("2026-07-20T16:00:00.000Z");
const PROFILE_PATH = "/private/agentera/profile-do-not-expose";

let root = "";
let database: AgenteraControlPlaneDatabase;
let store: ExperienceCandidateStore;
let authState: AgenteraAuthPublicState;
let context: AgenteraAgentControlContext;
let installation: LocalAgentInstallation;
let candidateIds: string[];
let source: HermesSkillCandidateSource;
let client: AgenteraAgentControlClient;
let resolveProfilePath: ReturnType<
  typeof vi.fn<
    (runtimeProfileId: string, agentInstallationId: string) => string
  >
>;
let candidateImporter: ExperienceCandidateImportOrchestrator;

function nodeSqliteFactory(path: string): AgenteraSqliteDatabase {
  return new DatabaseSync(path) as unknown as AgenteraSqliteDatabase;
}

function safeBundle(skillName = "weekly-summary"): ExperienceCandidateBundleV1 {
  return {
    schemaVersion: 1 as const,
    skillName,
    assets: [
      {
        path: `skills/${skillName}/SKILL.md`,
        mediaType: "text/markdown" as const,
        content: `---\nname: ${skillName}\n---\n\n# ${skillName}\n`,
      },
    ],
  };
}

function cloudBundle(
  request: SubmitExperienceCandidateRequest,
): SubmitExperienceCandidateRequest["bundle"] {
  return request.bundle;
}

function onlineAuthState(): Extract<
  AgenteraAuthPublicState,
  { cloudAvailable: boolean }
> {
  return {
    status: "authenticated",
    userId: OWNER.ownerId,
    personalSpaceId: OWNER.tenantId,
    deviceId: OWNER.deviceInstallationId,
    offlineExpiresAt: "2026-07-27T00:00:00.000Z",
    cloudAvailable: true,
  };
}

function cloudDetail(
  request: SubmitExperienceCandidateRequest,
  options: {
    id?: string;
    reviewed?: boolean;
    skillName?: string;
  } = {},
): CloudExperienceCandidateDetail {
  const id = options.id ?? CLOUD_CANDIDATE_ID;
  const skillName = options.skillName ?? request.bundle.skill_name;
  return {
    id,
    workspace_id: WORKSPACE_ID,
    agent_definition_id: DEFINITION_ID,
    source_agent_version_id: request.source_version_id,
    submitted_by_user_id: OWNER.ownerId,
    skill_name: skillName,
    dlp_contract_version: "experience-candidate-dlp-v1",
    content_digest: request.content_digest,
    created_at: NOW.toISOString(),
    ...(options.reviewed
      ? {
          review: {
            id: REVIEW_ID,
            reviewed_by_user_id: OWNER.ownerId,
            decision: "APPROVED" as const,
            reviewed_at: NOW.toISOString(),
          },
        }
      : {}),
    bundle: cloudBundle(request),
  };
}

function cloudSummary(
  options: {
    id?: string;
    digest?: string;
    skillName?: string;
    reviewed?: boolean;
  } = {},
): CloudExperienceCandidateSummary {
  return {
    id: options.id ?? CLOUD_ONLY_CANDIDATE_ID,
    workspace_id: WORKSPACE_ID,
    agent_definition_id: DEFINITION_ID,
    source_agent_version_id: VERSION_ID,
    submitted_by_user_id: OWNER.ownerId,
    skill_name: options.skillName ?? "cloud-only",
    dlp_contract_version: "experience-candidate-dlp-v1",
    content_digest: options.digest ?? "ab".repeat(32),
    created_at: NOW.toISOString(),
    ...(options.reviewed
      ? {
          review: {
            id: REVIEW_ID,
            reviewed_by_user_id: OWNER.ownerId,
            decision: "REJECTED" as const,
            reason_code: "not_reusable",
            safe_note: "Needs a reusable template.",
            reviewed_at: NOW.toISOString(),
          },
        }
      : {}),
  };
}

function insertInstallation(): void {
  database.sqlite
    .prepare(
      `INSERT INTO local_agent_installations (
         agent_installation_id, tenant_id, owner_id, device_installation_id,
         source_scope, source_workspace_id, definition_id, selected_version_id,
         runtime_profile_id, status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'WORKSPACE', ?, ?, ?, ?, 'active', ?, ?)`,
    )
    .run(
      INSTALLATION_ID,
      OWNER.tenantId,
      OWNER.ownerId,
      OWNER.deviceInstallationId,
      WORKSPACE_ID,
      DEFINITION_ID,
      VERSION_ID,
      PROFILE_ID,
      NOW.toISOString(),
      NOW.toISOString(),
    );
}

function createService(): ExperienceCandidateService {
  return new ExperienceCandidateService({
    client,
    store,
    source,
    getInstallation: (id) => {
      if (id !== INSTALLATION_ID) {
        throw Object.assign(new Error("not found"), {
          code: "installation_not_found",
        });
      }
      return { ...installation };
    },
    resolveProfilePath,
    getContext: () => context,
    getAuthState: () => authState,
    importer: candidateImporter,
    now: () => NOW,
    randomUUID: () => candidateIds.shift() ?? randomUUID(),
  });
}

function candidateSnapshotExists(candidateId: string): boolean {
  return existsSync(
    join(
      database.paths.candidatesPath,
      OWNER.tenantId,
      OWNER.ownerId,
      OWNER.deviceInstallationId,
      candidateId,
      "candidate.json",
    ),
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agentera-experience-service-"));
  database = openAgenteraControlPlaneDatabase(join(root, "user-data"), {
    databaseFactory: nodeSqliteFactory,
  });
  insertInstallation();
  store = new ExperienceCandidateStore({
    database,
    owner: OWNER,
    now: () => NOW,
  });
  authState = {
    status: "offline",
    userId: OWNER.ownerId,
    personalSpaceId: OWNER.tenantId,
    deviceId: OWNER.deviceInstallationId,
    offlineExpiresAt: "2026-07-27T00:00:00.000Z",
    cloudAvailable: false,
  };
  context = { scope: "WORKSPACE", workspaceId: WORKSPACE_ID, role: "member" };
  installation = {
    agentInstallationId: INSTALLATION_ID,
    sourceScope: "WORKSPACE",
    sourceWorkspaceId: WORKSPACE_ID,
    definitionId: DEFINITION_ID,
    selectedVersionId: VERSION_ID,
    runtimeProfileId: PROFILE_ID,
    policySnapshotId: null,
    status: "active",
    retryCode: null,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  };
  candidateIds = [CANDIDATE_ID, SECOND_CANDIDATE_ID];
  source = {
    listEligible: vi.fn((): EligibleExperienceSkill[] => [
      { skillName: "weekly-summary", description: "Weekly summary" },
    ]),
    readCandidate: vi.fn((_profilePath, skillName) => ({
      sourceRelativePath: `skills/${skillName}`,
      bundle: safeBundle(skillName),
    })),
  };
  client = {
    submitExperienceCandidate: vi.fn(
      async (_workspaceId, _definitionId, request) => cloudDetail(request),
    ),
    listOwnExperienceCandidates: vi.fn(async () => []),
    listWorkspaceExperienceCandidates: vi.fn(async () => []),
    getExperienceCandidate: vi.fn(async () => {
      throw new Error("not configured");
    }),
    reviewExperienceCandidate: vi.fn(async () => {
      throw new Error("not configured");
    }),
  } as unknown as AgenteraAgentControlClient;
  resolveProfilePath = vi.fn<
    (runtimeProfileId: string, agentInstallationId: string) => string
  >(() => PROFILE_PATH);
  candidateImporter = {
    prepare: vi.fn(async () => {
      throw new Error("not configured");
    }),
    confirm: vi.fn(async () => {
      throw new Error("not configured");
    }),
    clearPreparedImports: vi.fn(),
  };
});

afterEach(() => {
  database.close();
  rmSync(root, { recursive: true, force: true });
});

describe("ExperienceCandidateService", () => {
  it("resolves a Profile only after exact active Workspace Installation checks", () => {
    const service = createService();
    expect(service.listEligibleSkills(INSTALLATION_ID)).toEqual([
      { skillName: "weekly-summary", description: "Weekly summary" },
    ]);
    expect(resolveProfilePath).toHaveBeenCalledWith(
      PROFILE_ID,
      INSTALLATION_ID,
    );
    expect(source.listEligible).toHaveBeenCalledWith(PROFILE_PATH);

    for (const invalid of [
      { status: "pending" as const },
      { sourceScope: "USER" as const, sourceWorkspaceId: null },
      { sourceWorkspaceId: randomUUID() },
      { runtimeProfileId: null },
    ]) {
      resolveProfilePath.mockClear();
      installation = { ...installation, ...invalid };
      expect(() => service.listEligibleSkills(INSTALLATION_ID)).toThrowError(
        new ExperienceCandidateServiceError("candidate_source_ineligible"),
      );
      expect(resolveProfilePath).not.toHaveBeenCalled();
      installation = {
        ...installation,
        sourceScope: "WORKSPACE",
        sourceWorkspaceId: WORKSPACE_ID,
        runtimeProfileId: PROFILE_ID,
        status: "active",
      };
    }
    expect(
      JSON.stringify(service.listEligibleSkills(INSTALLATION_ID)),
    ).not.toContain(PROFILE_PATH);
  });

  it("runs local DLP before snapshot creation and maps invalid provenance safely", () => {
    source = {
      ...source,
      readCandidate: vi.fn(() => ({
        sourceRelativePath: "skills/unsafe",
        bundle: {
          schemaVersion: 1 as const,
          skillName: "unsafe",
          assets: [
            {
              path: "skills/unsafe/SKILL.md",
              mediaType: "text/markdown" as const,
              content: "API_KEY=super-secret-candidate-value\n",
            },
          ],
        },
      })),
    };
    const blocked = (() => {
      try {
        createService().prepare({
          installationId: INSTALLATION_ID,
          skillName: "unsafe",
        });
      } catch (error) {
        return error;
      }
      return null;
    })();
    expect(blocked).toBeInstanceOf(ExperienceCandidateServiceError);
    expect(blocked).toMatchObject({
      code: "candidate_dlp_blocked",
      findings: [
        {
          code: "credential_environment_secret",
          path: "skills/unsafe/SKILL.md",
          line: 1,
        },
      ],
    });
    expect(`${String(blocked)}${JSON.stringify(blocked)}`).not.toContain(
      "super-secret-candidate-value",
    );
    expect(candidateSnapshotExists(CANDIDATE_ID)).toBe(false);
    expect(
      database.sqlite
        .prepare("SELECT COUNT(*) AS count FROM local_experience_candidates")
        .get(),
    ).toEqual({ count: 0 });

    source = {
      ...source,
      readCandidate: vi.fn(() => {
        throw Object.assign(new Error("private source path"), {
          code: "candidate_source_ineligible",
        });
      }),
    };
    expect(() =>
      createService().prepare({
        installationId: INSTALLATION_ID,
        skillName: "missing",
      }),
    ).toThrowError(
      new ExperienceCandidateServiceError("candidate_source_ineligible"),
    );
  });

  it("prepares offline but requires explicit online submission and manually reuses one intent", async () => {
    const service = createService();
    const preview = service.prepare({
      installationId: INSTALLATION_ID,
      skillName: "weekly-summary",
    });
    expect(preview).toMatchObject({
      localCandidateId: CANDIDATE_ID,
      installationId: INSTALLATION_ID,
      sourceAgentVersionId: VERSION_ID,
      skillName: "weekly-summary",
      fileCount: 1,
      findings: [],
    });
    expect(preview).not.toHaveProperty("profilePath");
    expect(candidateSnapshotExists(CANDIDATE_ID)).toBe(true);

    await expect(
      service.submit({
        candidateId: CANDIDATE_ID,
        confirmation: "wrong" as "submit-selected-skill",
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      service.submit({
        candidateId: CANDIDATE_ID,
        confirmation: "submit-selected-skill",
      }),
    ).rejects.toMatchObject({ code: "online_required" });
    expect(client.submitExperienceCandidate).not.toHaveBeenCalled();
    expect(candidateSnapshotExists(CANDIDATE_ID)).toBe(true);

    authState = onlineAuthState();
    vi.mocked(client.submitExperienceCandidate).mockRejectedValueOnce(
      new AgenteraAgentControlClientError(0, "network_unavailable"),
    );
    await expect(
      service.submit({
        candidateId: CANDIDATE_ID,
        confirmation: "submit-selected-skill",
      }),
    ).rejects.toMatchObject({ code: "cloud_unavailable" });
    expect(store.get(CANDIDATE_ID)).toMatchObject({
      status: "UPLOAD_FAILED",
      lastErrorCode: "cloud_unavailable",
    });
    expect(candidateSnapshotExists(CANDIDATE_ID)).toBe(true);
    const firstKey = vi.mocked(client.submitExperienceCandidate).mock
      .calls[0][3];

    await expect(
      service.submit({
        candidateId: CANDIDATE_ID,
        confirmation: "submit-selected-skill",
      }),
    ).resolves.toMatchObject({
      localCandidateId: CANDIDATE_ID,
      cloudCandidateId: CLOUD_CANDIDATE_ID,
      localStatus: "SUBMITTED",
      reviewStatus: "PENDING_REVIEW",
    });
    const secondKey = vi.mocked(client.submitExperienceCandidate).mock
      .calls[1][3];
    expect(secondKey).toBe(firstKey);
    expect(store.get(CANDIDATE_ID).status).toBe("SUBMITTED");
    expect(candidateSnapshotExists(CANDIDATE_ID)).toBe(false);
  });

  it("keeps deterministic cloud denial PREPARED with only a bounded error", async () => {
    authState = onlineAuthState();
    const service = createService();
    service.prepare({
      installationId: INSTALLATION_ID,
      skillName: "weekly-summary",
    });
    vi.mocked(client.submitExperienceCandidate).mockRejectedValueOnce(
      new AgenteraAgentControlClientError(403, "workspace_forbidden"),
    );
    await expect(
      service.submit({
        candidateId: CANDIDATE_ID,
        confirmation: "submit-selected-skill",
      }),
    ).rejects.toMatchObject({ code: "workspace_forbidden" });
    expect(store.get(CANDIDATE_ID)).toMatchObject({
      status: "PREPARED",
      lastErrorCode: "workspace_forbidden",
    });
    expect(candidateSnapshotExists(CANDIDATE_ID)).toBe(true);
  });

  it("always includes local candidates and merges cloud terminal state only while online", async () => {
    const service = createService();
    const first = service.prepare({
      installationId: INSTALLATION_ID,
      skillName: "weekly-summary",
    });
    source = {
      ...source,
      readCandidate: vi.fn((_profilePath, skillName) => ({
        sourceRelativePath: `skills/${skillName}`,
        bundle: safeBundle(skillName),
      })),
    };
    const second = service.prepare({
      installationId: INSTALLATION_ID,
      skillName: "daily-summary",
    });
    store.markSubmitted(first.localCandidateId, CLOUD_CANDIDATE_ID);
    const submitted = store.get(first.localCandidateId);

    expect(await service.listMine()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          localCandidateId: second.localCandidateId,
          localStatus: "PREPARED",
          reviewStatus: null,
        }),
        expect.objectContaining({
          localCandidateId: first.localCandidateId,
          cloudCandidateId: CLOUD_CANDIDATE_ID,
          localStatus: "SUBMITTED",
          reviewStatus: null,
        }),
      ]),
    );
    expect(client.listOwnExperienceCandidates).not.toHaveBeenCalled();

    authState = onlineAuthState();
    vi.mocked(client.listOwnExperienceCandidates).mockResolvedValueOnce([
      cloudSummary({
        id: CLOUD_CANDIDATE_ID,
        digest: submitted.contentDigest,
        skillName: submitted.skillName,
        reviewed: true,
      }),
      cloudSummary(),
    ]);
    const merged = await service.listMine();
    expect(merged).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          localCandidateId: first.localCandidateId,
          cloudCandidateId: CLOUD_CANDIDATE_ID,
          localStatus: "SUBMITTED",
          reviewStatus: "REJECTED",
        }),
        expect.objectContaining({
          localCandidateId: second.localCandidateId,
          localStatus: "PREPARED",
        }),
        expect.objectContaining({
          localCandidateId: null,
          cloudCandidateId: CLOUD_ONLY_CANDIDATE_ID,
          localStatus: null,
        }),
      ]),
    );
  });

  it("allows Member own-list but gates review locally to Owner/Admin", async () => {
    authState = onlineAuthState();
    const service = createService();
    await expect(service.listMine()).resolves.toEqual([]);
    await expect(service.listReviewQueue()).rejects.toMatchObject({
      code: "workspace_forbidden",
    });
    await expect(
      service.review({
        candidateId: CLOUD_CANDIDATE_ID,
        decision: "APPROVED",
        reasonCode: null,
        safeNote: null,
      }),
    ).rejects.toMatchObject({ code: "workspace_forbidden" });
    expect(client.listWorkspaceExperienceCandidates).not.toHaveBeenCalled();
    expect(client.reviewExperienceCandidate).not.toHaveBeenCalled();

    context = { scope: "WORKSPACE", workspaceId: WORKSPACE_ID, role: "admin" };
    vi.mocked(client.listWorkspaceExperienceCandidates).mockResolvedValueOnce([
      cloudSummary({ id: CLOUD_CANDIDATE_ID }),
    ]);
    await expect(service.listReviewQueue()).resolves.toEqual([
      expect.objectContaining({ cloudCandidateId: CLOUD_CANDIDATE_ID }),
    ]);
    const approved = cloudDetail(
      {
        source_version_id: VERSION_ID,
        bundle: {
          schema_version: 1,
          skill_name: "weekly-summary",
          assets: [
            {
              path: "skills/weekly-summary/SKILL.md",
              media_type: "text/markdown",
              content: "# Weekly summary\n",
            },
          ],
        },
        content_digest: "ab".repeat(32),
      },
      { id: CLOUD_CANDIDATE_ID, reviewed: true },
    );
    vi.mocked(client.reviewExperienceCandidate).mockResolvedValueOnce(approved);
    await expect(
      service.review({
        candidateId: CLOUD_CANDIDATE_ID,
        decision: "APPROVED",
        reasonCode: null,
        safeNote: null,
      }),
    ).resolves.toMatchObject({
      cloudCandidateId: CLOUD_CANDIDATE_ID,
      reviewStatus: "APPROVED",
    });
    expect(client.reviewExperienceCandidate).toHaveBeenCalledWith(
      WORKSPACE_ID,
      CLOUD_CANDIDATE_ID,
      { decision: "APPROVED" },
      expect.any(String),
    );
  });

  it("routes approved import only through online Owner/Admin context and clears handles", async () => {
    authState = onlineAuthState();
    const preview: ExperienceCandidateImportPreview = {
      importHandle: CANDIDATE_ID,
      candidateId: CLOUD_CANDIDATE_ID,
      sourceVersionId: VERSION_ID,
      latestVersionId: VERSION_ID,
      latestVersionNumber: 1,
      skillName: "weekly-summary",
      replacesExistingSkill: true,
      addedPaths: [],
      replacedPaths: ["skills/weekly-summary/SKILL.md"],
      removedPaths: [],
    };
    const imported = {
      id: CANDIDATE_ID,
    } as AgentDraftDetail;
    vi.mocked(candidateImporter.prepare).mockResolvedValue(preview);
    vi.mocked(candidateImporter.confirm).mockResolvedValue(imported);
    const service = createService();

    await expect(
      service.prepareImport(CLOUD_CANDIDATE_ID),
    ).rejects.toMatchObject({ code: "workspace_forbidden" });
    expect(candidateImporter.prepare).not.toHaveBeenCalled();

    context = { scope: "WORKSPACE", workspaceId: WORKSPACE_ID, role: "admin" };
    await expect(service.prepareImport(CLOUD_CANDIDATE_ID)).resolves.toEqual(
      preview,
    );
    expect(candidateImporter.prepare).toHaveBeenCalledWith(
      WORKSPACE_ID,
      CLOUD_CANDIDATE_ID,
    );
    const confirmation: ConfirmExperienceCandidateImportInput = {
      importHandle: CANDIDATE_ID,
      confirmation: "apply-approved-skill-to-latest",
    };
    await expect(service.confirmImport(confirmation)).resolves.toBe(imported);
    expect(candidateImporter.confirm).toHaveBeenCalledWith(
      WORKSPACE_ID,
      confirmation,
    );

    service.clearPreparedImports();
    expect(candidateImporter.clearPreparedImports).toHaveBeenCalledOnce();
    authState = { ...onlineAuthState(), cloudAvailable: false };
    await expect(
      service.prepareImport(CLOUD_CANDIDATE_ID),
    ).rejects.toMatchObject({ code: "online_required" });
  });
});
