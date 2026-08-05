// @vitest-environment node

import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import type { AgenteraRuntimeOwner } from "../agentera-profile-binding";
import type { AgentEditableManifestV3 } from "../../shared/agentera-agent-control";
import type {
  AgentDefinition,
  AgentVersion,
  CloudExperienceCandidateDetail,
} from "./client";
import {
  openAgenteraControlPlaneDatabase,
  type AgenteraControlPlaneDatabase,
  type AgenteraSqliteDatabase,
} from "./db";
import { AgentDraftStore } from "./draft-store";
import {
  canonicalizeExperienceCandidate,
  EXPERIENCE_CANDIDATE_DLP_VERSION,
} from "./experience-candidate-contract";
import {
  ExperienceCandidateImporter,
  ExperienceCandidateImporterError,
  type ExperienceCandidateImportClient,
  type ExperienceCandidateImportVersionCache,
} from "./experience-candidate-importer";
import { ExperienceCandidateStore } from "./experience-candidate-store";
import { canonicalizeEditableAgent } from "./manifest";

const OWNER: AgenteraRuntimeOwner = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  ownerId: "22222222-2222-4222-8222-222222222222",
  deviceInstallationId: "33333333-3333-4333-8333-333333333333",
};
const SECOND_DEVICE_OWNER: AgenteraRuntimeOwner = {
  ...OWNER,
  deviceInstallationId: "44444444-4444-4444-8444-444444444444",
};
const WORKSPACE_ID = "55555555-5555-4555-8555-555555555555";
const OTHER_WORKSPACE_ID = "66666666-6666-4666-8666-666666666666";
const DEFINITION_ID = "77777777-7777-4777-8777-777777777777";
const SOURCE_VERSION_ID = "88888888-8888-4888-8888-888888888888";
const LATEST_VERSION_ID = "99999999-9999-4999-8999-999999999999";
const ADVANCED_VERSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CANDIDATE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const REVIEW_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const REVIEWER_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const NOW = new Date("2026-07-20T17:00:00.000Z");

function nodeSqliteFactory(path: string): AgenteraSqliteDatabase {
  return new DatabaseSync(path) as unknown as AgenteraSqliteDatabase;
}

function baseVersion(id = LATEST_VERSION_ID, number = 3): AgentVersion {
  const manifest = {
    schemaVersion: 1 as const,
    identity: { systemPrompt: "Keep the stable Workspace identity." },
    assets: [
      {
        path: "knowledge/base.md",
        kind: "knowledge" as const,
        mediaType: "text/markdown" as const,
      },
      {
        path: "skills/other-skill/SKILL.md",
        kind: "skill" as const,
        mediaType: "text/markdown" as const,
      },
      {
        path: "skills/weekly-summary/SKILL.md",
        kind: "skill" as const,
        mediaType: "text/markdown" as const,
      },
      {
        path: "skills/weekly-summary/old.md",
        kind: "skill" as const,
        mediaType: "text/markdown" as const,
      },
    ],
    modelConstraints: {
      allowedProviders: ["openai"],
      allowedModels: ["gpt-5.6"],
    },
    tools: { allowed: ["files.read"], denied: ["shell.exec"] },
    dependencies: [
      {
        agentDefinitionId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        agentVersionId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      },
    ],
    runtimeCompatibility: {
      minimumVersion: "v0.18.2-agentera.1",
      maximumVersionExclusive: "v0.19.0",
    },
  };
  const assets = [
    { path: "knowledge/base.md", content: "# Stable knowledge\n" },
    {
      path: "skills/other-skill/SKILL.md",
      content: "# Unrelated skill\n",
    },
    {
      path: "skills/weekly-summary/SKILL.md",
      content: "# Old weekly summary\n",
    },
    {
      path: "skills/weekly-summary/old.md",
      content: "old helper\n",
    },
  ];
  const canonical = canonicalizeEditableAgent(manifest, assets);
  return {
    id,
    definition_id: DEFINITION_ID,
    version_number: number,
    manifest: JSON.parse(
      canonical.manifestBytes.toString("utf8"),
    ) as AgentVersion["manifest"],
    bundle: JSON.parse(
      canonical.bundleBytes.toString("utf8"),
    ) as AgentVersion["bundle"],
    content_digest: canonical.contentDigest,
    signing_key_id: "candidate-import-test-key",
    signature: "A".repeat(86),
    runtime_minimum_version: "v0.18.2-agentera.1",
    runtime_maximum_version_exclusive: "v0.19.0",
    published_at: NOW.toISOString(),
  };
}

function baseVersionV3(): AgentVersion {
  const base = baseVersion();
  const manifest: AgentEditableManifestV3 = {
    schemaVersion: 3,
    identity: { systemPrompt: "Keep the stable Workspace identity." },
    assets: base.manifest.assets.map((asset) => ({
      path: asset.path,
      kind: asset.kind,
      mediaType: asset.media_type,
    })),
    modelPolicy: {
      mode: "user_select",
      allowedProviders: [],
      allowedModels: [],
    },
    mcpRequirements: [
      {
        logicalName: "docs-read",
        tools: ["files.read"],
        required: true,
        permissionReason: "Read selected documents",
      },
    ],
    tools: { allowed: ["files.read"], denied: ["shell.exec"] },
    dependencies: [
      {
        agentDefinitionId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        agentVersionId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      },
    ],
    runtimeCompatibility: {
      minimumVersion: "v0.18.2-agentera.1",
      maximumVersionExclusive: "v0.19.0",
    },
  };
  const assets = base.bundle.assets.map((asset) => ({
    path: asset.path,
    content: asset.content,
  }));
  const canonical = canonicalizeEditableAgent(manifest, assets);
  return {
    ...base,
    manifest: JSON.parse(
      canonical.manifestBytes.toString("utf8"),
    ) as AgentVersion["manifest"],
    bundle: JSON.parse(
      canonical.bundleBytes.toString("utf8"),
    ) as AgentVersion["bundle"],
    content_digest: canonical.contentDigest,
  };
}

function candidateBundle(): ReturnType<typeof canonicalizeExperienceCandidate> {
  return canonicalizeExperienceCandidate({
    schemaVersion: 1,
    skillName: "weekly-summary",
    assets: [
      {
        path: "skills/weekly-summary/SKILL.md",
        mediaType: "text/markdown",
        content: "# Improved weekly summary\n",
      },
      {
        path: "skills/weekly-summary/guide.md",
        mediaType: "text/markdown",
        content: "# New guide\n",
      },
    ],
  });
}

function approvedCandidate(
  overrides: Partial<CloudExperienceCandidateDetail> = {},
): CloudExperienceCandidateDetail {
  const candidate = candidateBundle();
  return {
    id: CANDIDATE_ID,
    workspace_id: WORKSPACE_ID,
    agent_definition_id: DEFINITION_ID,
    source_agent_version_id: SOURCE_VERSION_ID,
    submitted_by_user_id: OWNER.ownerId,
    skill_name: candidate.bundle.skillName,
    dlp_contract_version: EXPERIENCE_CANDIDATE_DLP_VERSION,
    content_digest: candidate.contentDigest,
    created_at: NOW.toISOString(),
    bundle: {
      schema_version: 1,
      skill_name: candidate.bundle.skillName,
      assets: candidate.bundle.assets.map((asset) => ({
        path: asset.path,
        media_type: asset.mediaType,
        content: asset.content,
      })),
    },
    review: {
      id: REVIEW_ID,
      reviewed_by_user_id: REVIEWER_ID,
      decision: "APPROVED",
      reviewed_at: NOW.toISOString(),
    },
    ...overrides,
  };
}

function definition(
  latestVersionId: string = LATEST_VERSION_ID,
): AgentDefinition {
  return {
    id: DEFINITION_ID,
    display_name: "Workspace Research Agent",
    status: "active",
    latest_version_id: latestVersionId,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
  };
}

describe("ExperienceCandidateImporter", () => {
  let root: string;
  let database: AgenteraControlPlaneDatabase;
  let candidates: ExperienceCandidateStore;
  let drafts: AgentDraftStore;
  let currentCandidate: CloudExperienceCandidateDetail;
  let currentDefinition: AgentDefinition;
  let currentVersion: AgentVersion;
  let client: {
    getExperienceCandidate: Mock<
      ExperienceCandidateImportClient["getExperienceCandidate"]
    >;
    getWorkspaceDefinition: Mock<
      ExperienceCandidateImportClient["getWorkspaceDefinition"]
    >;
    getVersion: Mock<ExperienceCandidateImportClient["getVersion"]>;
  };
  let cache: {
    cacheVerifiedVersion: Mock<
      ExperienceCandidateImportVersionCache["cacheVerifiedVersion"]
    >;
    getVerifiedVersion: Mock<
      ExperienceCandidateImportVersionCache["getVerifiedVersion"]
    >;
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "agentera-candidate-importer-"));
    database = openAgenteraControlPlaneDatabase(join(root, "user-data"), {
      databaseFactory: nodeSqliteFactory,
    });
    candidates = new ExperienceCandidateStore({
      database,
      owner: OWNER,
      now: () => NOW,
      randomUUID,
    });
    drafts = new AgentDraftStore({
      database,
      owner: OWNER,
      context: {
        scope: "WORKSPACE",
        workspaceId: WORKSPACE_ID,
        role: "admin",
      },
      now: () => NOW,
      randomUUID,
    });
    currentCandidate = approvedCandidate();
    currentDefinition = definition();
    currentVersion = baseVersion();
    client = {
      getExperienceCandidate: vi.fn<
        ExperienceCandidateImportClient["getExperienceCandidate"]
      >(async () => currentCandidate),
      getWorkspaceDefinition: vi.fn<
        ExperienceCandidateImportClient["getWorkspaceDefinition"]
      >(async () => currentDefinition),
      getVersion: vi.fn<ExperienceCandidateImportClient["getVersion"]>(
        async () => currentVersion,
      ),
    };
    cache = {
      cacheVerifiedVersion: vi.fn<
        ExperienceCandidateImportVersionCache["cacheVerifiedVersion"]
      >((version) => version),
      getVerifiedVersion: vi.fn<
        ExperienceCandidateImportVersionCache["getVerifiedVersion"]
      >(() => currentVersion),
    };
  });

  afterEach(() => {
    database.close();
    rmSync(root, { recursive: true, force: true });
  });

  function importer(
    overrides: Partial<
      ConstructorParameters<typeof ExperienceCandidateImporter>[0]
    > = {},
  ): ExperienceCandidateImporter {
    return new ExperienceCandidateImporter({
      database,
      client,
      candidates,
      drafts,
      cache,
      owner: OWNER,
      now: () => NOW,
      randomUUID,
      ...overrides,
    });
  }

  it("previews the exact same-name Skill overlay only after latest-version verification", async () => {
    const value = await importer().prepare(WORKSPACE_ID, CANDIDATE_ID);

    expect(value).toMatchObject({
      candidateId: CANDIDATE_ID,
      sourceVersionId: SOURCE_VERSION_ID,
      latestVersionId: LATEST_VERSION_ID,
      latestVersionNumber: 3,
      skillName: "weekly-summary",
      replacesExistingSkill: true,
      addedPaths: ["skills/weekly-summary/guide.md"],
      replacedPaths: ["skills/weekly-summary/SKILL.md"],
      removedPaths: ["skills/weekly-summary/old.md"],
    });
    expect(value.importHandle).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(client.getExperienceCandidate).toHaveBeenCalledWith(
      WORKSPACE_ID,
      CANDIDATE_ID,
    );
    expect(client.getWorkspaceDefinition).toHaveBeenCalledWith(
      WORKSPACE_ID,
      DEFINITION_ID,
    );
    expect(client.getVersion).toHaveBeenCalledWith(LATEST_VERSION_ID);
    expect(cache.cacheVerifiedVersion).toHaveBeenCalledWith(currentVersion);
    expect(drafts.listDrafts()).toEqual([]);
    expect(candidates.findImport(CANDIDATE_ID)).toBeNull();
  });

  it("rejects non-approved, cross-Workspace, digest-mismatched, and unverified candidates before mutation", async () => {
    const cases: Array<{
      name: string;
      candidate: CloudExperienceCandidateDetail;
      expectedCode: ExperienceCandidateImporterError["code"];
      failVerification?: boolean;
    }> = [
      {
        name: "pending",
        candidate: approvedCandidate({ review: undefined }),
        expectedCode: "candidate_not_approved",
      },
      {
        name: "Workspace mismatch",
        candidate: approvedCandidate({ workspace_id: OTHER_WORKSPACE_ID }),
        expectedCode: "workspace_forbidden",
      },
      {
        name: "candidate digest mismatch",
        candidate: approvedCandidate({ content_digest: "ab".repeat(32) }),
        expectedCode: "verification_failed",
      },
      {
        name: "version verification failure",
        candidate: approvedCandidate(),
        expectedCode: "verification_failed",
        failVerification: true,
      },
    ];

    for (const testCase of cases) {
      currentCandidate = testCase.candidate;
      cache.cacheVerifiedVersion
        .mockReset()
        .mockImplementation((version: AgentVersion) => version);
      if (testCase.failVerification) {
        cache.cacheVerifiedVersion.mockImplementationOnce(() => {
          throw new Error("invalid signature");
        });
      }
      await expect(
        importer().prepare(WORKSPACE_ID, CANDIDATE_ID),
        testCase.name,
      ).rejects.toMatchObject({
        code: testCase.expectedCode,
      } satisfies Partial<ExperienceCandidateImporterError>);
      expect(drafts.listDrafts(), testCase.name).toEqual([]);
      expect(candidates.findImport(CANDIDATE_ID), testCase.name).toBeNull();
      vi.clearAllMocks();
    }
  });

  it("requires explicit confirmation, preserves unrelated base bytes, and reopens the same local draft", async () => {
    const subject = importer();
    const preview = await subject.prepare(WORKSPACE_ID, CANDIDATE_ID);
    await expect(
      subject.confirm(WORKSPACE_ID, {
        importHandle: preview.importHandle,
        confirmation: "yes" as "apply-approved-skill-to-latest",
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });

    const freshPreview = await subject.prepare(WORKSPACE_ID, CANDIDATE_ID);
    const created = await subject.confirm(WORKSPACE_ID, {
      importHandle: freshPreview.importHandle,
      confirmation: "apply-approved-skill-to-latest",
    });

    expect(created).toMatchObject({
      sourceAgentDefinitionId: DEFINITION_ID,
      baseAgentVersionId: LATEST_VERSION_ID,
      displayName: "Workspace Research Agent",
      revision: 1,
    });
    expect(created.manifest).toMatchObject({
      identity: { systemPrompt: "Keep the stable Workspace identity." },
      modelConstraints: {
        allowedProviders: ["openai"],
        allowedModels: ["gpt-5.6"],
      },
      tools: { allowed: ["files.read"], denied: ["shell.exec"] },
      dependencies: [
        {
          agentDefinitionId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
          agentVersionId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        },
      ],
      runtimeCompatibility: {
        minimumVersion: "v0.18.2-agentera.1",
        maximumVersionExclusive: "v0.19.0",
      },
    });
    expect(created.editableAssets).toEqual([
      { path: "knowledge/base.md", content: "# Stable knowledge\n" },
      {
        path: "skills/other-skill/SKILL.md",
        content: "# Unrelated skill\n",
      },
      {
        path: "skills/weekly-summary/SKILL.md",
        content: "# Improved weekly summary\n",
      },
      {
        path: "skills/weekly-summary/guide.md",
        content: "# New guide\n",
      },
    ]);
    expect(candidates.findImport(CANDIDATE_ID)).toMatchObject({
      candidateId: CANDIDATE_ID,
      workspaceId: WORKSPACE_ID,
      agentDefinitionId: DEFINITION_ID,
      baseAgentVersionId: LATEST_VERSION_ID,
      candidateContentDigest: currentCandidate.content_digest,
      draftId: created.id,
    });

    const retryPreview = await subject.prepare(WORKSPACE_ID, CANDIDATE_ID);
    const reopened = await subject.confirm(WORKSPACE_ID, {
      importHandle: retryPreview.importHandle,
      confirmation: "apply-approved-skill-to-latest",
    });
    expect(reopened).toEqual(created);
    expect(drafts.listDrafts()).toHaveLength(1);
  });

  it("preserves a V3 base manifest while importing an approved Skill", async () => {
    currentVersion = baseVersionV3();
    const subject = importer();
    const preview = await subject.prepare(WORKSPACE_ID, CANDIDATE_ID);
    const created = await subject.confirm(WORKSPACE_ID, {
      importHandle: preview.importHandle,
      confirmation: "apply-approved-skill-to-latest",
    });

    expect(created.manifest).toMatchObject({
      schemaVersion: 3,
      modelPolicy: {
        mode: "user_select",
        allowedProviders: [],
        allowedModels: [],
      },
      mcpRequirements: [
        {
          logicalName: "docs-read",
          tools: ["files.read"],
          required: true,
          permissionReason: "Read selected documents",
        },
      ],
    });
  });

  it("rejects an advanced latest base before opening a SQLite transaction", async () => {
    const subject = importer();
    const preview = await subject.prepare(WORKSPACE_ID, CANDIDATE_ID);
    currentDefinition = definition(ADVANCED_VERSION_ID);

    await expect(
      subject.confirm(WORKSPACE_ID, {
        importHandle: preview.importHandle,
        confirmation: "apply-approved-skill-to-latest",
      }),
    ).rejects.toMatchObject({ code: "candidate_base_advanced" });
    expect(drafts.listDrafts()).toEqual([]);
    expect(candidates.findImport(CANDIDATE_ID)).toBeNull();
  });

  it("rechecks the bound verified base digest before draft mutation", async () => {
    const subject = importer();
    const preview = await subject.prepare(WORKSPACE_ID, CANDIDATE_ID);
    cache.getVerifiedVersion.mockReturnValueOnce({
      ...currentVersion,
      content_digest: "ab".repeat(32),
    });

    await expect(
      subject.confirm(WORKSPACE_ID, {
        importHandle: preview.importHandle,
        confirmation: "apply-approved-skill-to-latest",
      }),
    ).rejects.toMatchObject({ code: "verification_failed" });
    expect(drafts.listDrafts()).toEqual([]);
    expect(candidates.findImport(CANDIDATE_ID)).toBeNull();
  });

  it.each(["after-draft", "after-receipt"] as const)(
    "rolls back both rows and local files when import fails %s",
    async (failurePoint) => {
      const subject = importer({
        afterDraftRowsWritten: () => {
          if (failurePoint === "after-draft") throw new Error("draft failure");
        },
        afterImportReceiptWritten: () => {
          if (failurePoint === "after-receipt") {
            throw new Error("receipt failure");
          }
        },
      });
      const preview = await subject.prepare(WORKSPACE_ID, CANDIDATE_ID);
      await expect(
        subject.confirm(WORKSPACE_ID, {
          importHandle: preview.importHandle,
          confirmation: "apply-approved-skill-to-latest",
        }),
      ).rejects.toMatchObject({ code: "candidate_import_failed" });

      expect(
        database.sqlite.prepare("SELECT id FROM agent_drafts").all(),
      ).toEqual([]);
      expect(
        database.sqlite
          .prepare("SELECT draft_id FROM local_experience_candidate_imports")
          .all(),
      ).toEqual([]);
      const draftEntries = existsSync(database.paths.draftsPath)
        ? readdirSync(database.paths.draftsPath)
        : [];
      expect(draftEntries).toEqual([]);
      expect(currentCandidate.review?.decision).toBe("APPROVED");
    },
  );

  it("leaves no receipt or partial draft when asset materialization fails", async () => {
    const failingDrafts = new AgentDraftStore({
      database,
      owner: OWNER,
      context: {
        scope: "WORKSPACE",
        workspaceId: WORKSPACE_ID,
        role: "admin",
      },
      now: () => NOW,
      randomUUID,
      writeFile: () => {
        throw new Error("simulated disk failure");
      },
    });
    const subject = importer({ drafts: failingDrafts });
    const preview = await subject.prepare(WORKSPACE_ID, CANDIDATE_ID);

    await expect(
      subject.confirm(WORKSPACE_ID, {
        importHandle: preview.importHandle,
        confirmation: "apply-approved-skill-to-latest",
      }),
    ).rejects.toMatchObject({ code: "candidate_import_failed" });
    expect(drafts.listDrafts()).toEqual([]);
    expect(candidates.findImport(CANDIDATE_ID)).toBeNull();
    expect(currentCandidate.review?.decision).toBe("APPROVED");
  });

  it("keeps receipts device-local so another authorized device creates its own draft", async () => {
    const first = importer();
    const firstPreview = await first.prepare(WORKSPACE_ID, CANDIDATE_ID);
    const firstDraft = await first.confirm(WORKSPACE_ID, {
      importHandle: firstPreview.importHandle,
      confirmation: "apply-approved-skill-to-latest",
    });

    const secondCandidates = new ExperienceCandidateStore({
      database,
      owner: SECOND_DEVICE_OWNER,
      now: () => NOW,
      randomUUID,
    });
    const secondDrafts = new AgentDraftStore({
      database,
      owner: SECOND_DEVICE_OWNER,
      context: {
        scope: "WORKSPACE",
        workspaceId: WORKSPACE_ID,
        role: "owner",
      },
      now: () => NOW,
      randomUUID,
    });
    const second = importer({
      candidates: secondCandidates,
      drafts: secondDrafts,
      owner: SECOND_DEVICE_OWNER,
    });
    const secondPreview = await second.prepare(WORKSPACE_ID, CANDIDATE_ID);
    const secondDraft = await second.confirm(WORKSPACE_ID, {
      importHandle: secondPreview.importHandle,
      confirmation: "apply-approved-skill-to-latest",
    });

    expect(secondDraft.id).not.toBe(firstDraft.id);
    expect(candidates.findImport(CANDIDATE_ID)?.draftId).toBe(firstDraft.id);
    expect(secondCandidates.findImport(CANDIDATE_ID)?.draftId).toBe(
      secondDraft.id,
    );
  });
});
