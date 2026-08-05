// @vitest-environment node

import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgenteraRuntimeOwner } from "../agentera-profile-binding";
import type {
  AgentDefinition,
  AgentVersion,
  CloudOrganizationExperienceCandidateDetail,
} from "./client";
import {
  openAgenteraControlPlaneDatabase,
  type AgenteraControlPlaneDatabase,
  type AgenteraSqliteDatabase,
} from "./db";
import { AgentDraftStore } from "./draft-store";
import { canonicalizeExperienceCandidate } from "./experience-candidate-contract";
import {
  OrganizationExperienceCandidateImporter,
  OrganizationExperienceCandidateImporterError,
  type OrganizationExperienceCandidateImportClient,
} from "./organization-experience-candidate-importer";
import { OrganizationExperienceCandidateStore } from "./organization-experience-candidate-store";

const OWNER: AgenteraRuntimeOwner = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  ownerId: "22222222-2222-4222-8222-222222222222",
  deviceInstallationId: "33333333-3333-4333-8333-333333333333",
};
const ORGANIZATION_ID = "44444444-4444-4444-8444-444444444444";
const CANDIDATE_ID = "55555555-5555-4555-8555-555555555555";
const DEFINITION_ID = "66666666-6666-4666-8666-666666666666";
const SOURCE_VERSION_ID = "77777777-7777-4777-8777-777777777777";
const LATEST_VERSION_ID = "88888888-8888-4888-8888-888888888888";
const REVIEW_ID = "99999999-9999-4999-8999-999999999999";
const IMPORT_HANDLE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DRAFT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NOW = new Date("2026-08-05T10:00:00.000Z");

let root: string;
let database: AgenteraControlPlaneDatabase;
let candidates: OrganizationExperienceCandidateStore;
let drafts: AgentDraftStore;
let client: OrganizationExperienceCandidateImportClient;
let latestDefinition: AgentDefinition;
let latestVersion: AgentVersion;
let importer: OrganizationExperienceCandidateImporter;
let sourceSkillPath: string;

function nodeSqliteFactory(path: string): AgenteraSqliteDatabase {
  return new DatabaseSync(path) as unknown as AgenteraSqliteDatabase;
}

function candidate(): CloudOrganizationExperienceCandidateDetail {
  const canonical = canonicalizeExperienceCandidate({
    schemaVersion: 1,
    skillName: "weekly-summary",
    assets: [
      {
        path: "skills/weekly-summary/SKILL.md",
        mediaType: "text/markdown",
        content: "# Improved weekly summary\n",
      },
    ],
  });
  return {
    id: CANDIDATE_ID,
    organization_id: ORGANIZATION_ID,
    agent_definition_id: DEFINITION_ID,
    source_agent_version_id: SOURCE_VERSION_ID,
    submitted_by_user_id: OWNER.ownerId,
    skill_name: canonical.bundle.skillName,
    dlp_contract_version: "experience-candidate-dlp-v1",
    content_digest: canonical.contentDigest,
    created_at: NOW.toISOString(),
    review: {
      id: REVIEW_ID,
      reviewed_by_user_id: OWNER.ownerId,
      decision: "APPROVED",
      reviewed_at: NOW.toISOString(),
    },
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

function definition(): AgentDefinition {
  return {
    id: DEFINITION_ID,
    display_name: "Organization Research Agent",
    status: "active",
    latest_version_id: LATEST_VERSION_ID,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
  };
}

function version(): AgentVersion {
  return {
    id: LATEST_VERSION_ID,
    definition_id: DEFINITION_ID,
    version_number: 3,
    manifest: {
      schema_version: 1,
      identity: { system_prompt: "Research safely." },
      assets: [
        {
          path: "knowledge/notes.md",
          kind: "knowledge",
          media_type: "text/markdown",
          sha256: createHash("sha256").update("# Notes\n").digest("hex"),
        },
        {
          path: "skills/weekly-summary/SKILL.md",
          kind: "skill",
          media_type: "text/markdown",
          sha256: createHash("sha256")
            .update("# Previous weekly summary\n")
            .digest("hex"),
        },
      ],
      model_constraints: {
        allowed_providers: ["openai"],
        allowed_models: ["gpt-5.6"],
      },
      tools: { allowed: ["files.read"], denied: [] },
      dependencies: [],
      runtime_compatibility: {
        minimum_version: "v0.18.2-agentera.1",
        maximum_version_exclusive: null,
      },
    },
    bundle: {
      assets: [
        { path: "knowledge/notes.md", content: "# Notes\n" },
        {
          path: "skills/weekly-summary/SKILL.md",
          content: "# Previous weekly summary\n",
        },
      ],
    },
    content_digest: "ab".repeat(32),
    signing_key_id: "organization-agent-v1",
    signature: "A".repeat(86),
    runtime_minimum_version: "v0.18.2-agentera.1",
    published_at: NOW.toISOString(),
  };
}

function fileHash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agentera-org-experience-import-"));
  database = openAgenteraControlPlaneDatabase(join(root, "user-data"), {
    databaseFactory: nodeSqliteFactory,
  });
  candidates = new OrganizationExperienceCandidateStore({
    database,
    owner: OWNER,
    now: () => NOW,
  });
  drafts = new AgentDraftStore({
    database,
    owner: OWNER,
    context: {
      scope: "ORGANIZATION",
      organizationId: ORGANIZATION_ID,
      role: "admin",
    },
    now: () => NOW,
    randomUUID: () => DRAFT_ID,
  });
  latestDefinition = definition();
  latestVersion = version();
  client = {
    getOrganizationExperienceCandidate: vi.fn(async () => candidate()),
    getOrganizationDefinition: vi.fn(async () => latestDefinition),
    listOrganizationVersions: vi.fn(async () => [latestVersion]),
  };
  const cache = {
    cacheVerifiedVersion: vi.fn((value: AgentVersion) => value),
    getVerifiedVersion: vi.fn(() => latestVersion),
  };
  importer = new OrganizationExperienceCandidateImporter({
    database,
    client,
    candidates,
    drafts,
    cache,
    owner: OWNER,
    now: () => NOW,
    randomUUID: () => IMPORT_HANDLE,
  });
  sourceSkillPath = join(
    root,
    "private-profile",
    "skills",
    "weekly-summary",
    "SKILL.md",
  );
  mkdirSync(join(root, "private-profile", "skills", "weekly-summary"), {
    recursive: true,
  });
  writeFileSync(sourceSkillPath, "# Private learned source\n", { mode: 0o600 });
});

afterEach(() => {
  database.close();
  rmSync(root, { recursive: true, force: true });
});

describe("OrganizationExperienceCandidateImporter", () => {
  it("previews an approved candidate against the latest exact Organization Version", async () => {
    const preview = await importer.prepare(ORGANIZATION_ID, CANDIDATE_ID);
    expect(preview).toEqual({
      importHandle: IMPORT_HANDLE,
      candidateId: CANDIDATE_ID,
      sourceVersionId: SOURCE_VERSION_ID,
      latestVersionId: LATEST_VERSION_ID,
      latestVersionNumber: 3,
      skillName: "weekly-summary",
      replacesExistingSkill: true,
      addedPaths: [],
      replacedPaths: ["skills/weekly-summary/SKILL.md"],
      removedPaths: [],
    });
    expect(client.getOrganizationDefinition).toHaveBeenCalledWith(
      ORGANIZATION_ID,
      DEFINITION_ID,
    );
    expect(client.listOrganizationVersions).toHaveBeenCalledWith(
      ORGANIZATION_ID,
      DEFINITION_ID,
    );
  });

  it("creates one Organization next-version draft and reopens its device-local receipt", async () => {
    const sourceBefore = fileHash(sourceSkillPath);
    const preview = await importer.prepare(ORGANIZATION_ID, CANDIDATE_ID);
    const created = await importer.confirm(ORGANIZATION_ID, {
      importHandle: preview.importHandle,
      confirmation: "apply-approved-skill-to-organization-draft",
    });
    expect(created).toMatchObject({
      id: DRAFT_ID,
      sourceAgentDefinitionId: DEFINITION_ID,
      baseAgentVersionId: LATEST_VERSION_ID,
    });
    expect(created.editableAssets).toEqual([
      { path: "knowledge/notes.md", content: "# Notes\n" },
      {
        path: "skills/weekly-summary/SKILL.md",
        content: "# Improved weekly summary\n",
      },
    ]);
    expect(candidates.findImport(ORGANIZATION_ID, CANDIDATE_ID)).toMatchObject({
      candidateId: CANDIDATE_ID,
      organizationId: ORGANIZATION_ID,
      draftId: DRAFT_ID,
    });
    expect(fileHash(sourceSkillPath)).toBe(sourceBefore);

    const repeated = await importer.prepare(ORGANIZATION_ID, CANDIDATE_ID);
    await expect(
      importer.confirm(ORGANIZATION_ID, {
        importHandle: repeated.importHandle,
        confirmation: "apply-approved-skill-to-organization-draft",
      }),
    ).resolves.toEqual(created);
    expect(
      database.sqlite
        .prepare("SELECT COUNT(*) AS count FROM agent_drafts")
        .get(),
    ).toEqual({ count: 1 });
  });

  it("fails closed when the Organization base advances before confirmation", async () => {
    const preview = await importer.prepare(ORGANIZATION_ID, CANDIDATE_ID);
    latestDefinition = {
      ...latestDefinition,
      latest_version_id: randomUUID(),
    };
    await expect(
      importer.confirm(ORGANIZATION_ID, {
        importHandle: preview.importHandle,
        confirmation: "apply-approved-skill-to-organization-draft",
      }),
    ).rejects.toThrowError(
      new OrganizationExperienceCandidateImporterError(
        "candidate_base_advanced",
      ),
    );
    expect(
      database.sqlite
        .prepare("SELECT COUNT(*) AS count FROM agent_drafts")
        .get(),
    ).toEqual({ count: 0 });
    expect(candidates.findImport(ORGANIZATION_ID, CANDIDATE_ID)).toBeNull();
  });
});
