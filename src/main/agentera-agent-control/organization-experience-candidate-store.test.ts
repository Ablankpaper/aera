// @vitest-environment node

import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgenteraRuntimeOwner } from "../agentera-profile-binding";
import {
  openAgenteraControlPlaneDatabase,
  type AgenteraControlPlaneDatabase,
  type AgenteraSqliteDatabase,
} from "./db";
import { canonicalizeExperienceCandidate } from "./experience-candidate-contract";
import {
  OrganizationExperienceCandidateStore,
  OrganizationExperienceCandidateStoreError,
  type PrepareLocalOrganizationExperienceCandidate,
} from "./organization-experience-candidate-store";

const OWNER: AgenteraRuntimeOwner = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  ownerId: "22222222-2222-4222-8222-222222222222",
  deviceInstallationId: "33333333-3333-4333-8333-333333333333",
};
const OTHER_DEVICE: AgenteraRuntimeOwner = {
  ...OWNER,
  deviceInstallationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
};
const INSTALLATION_ID = "44444444-4444-4444-8444-444444444444";
const ORGANIZATION_ID = "55555555-5555-4555-8555-555555555555";
const DEFINITION_ID = "66666666-6666-4666-8666-666666666666";
const VERSION_ID = "77777777-7777-4777-8777-777777777777";
const PROFILE_ID = "88888888-8888-4888-8888-888888888888";
const CANDIDATE_ID = "99999999-9999-4999-8999-999999999999";
const CLOUD_CANDIDATE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DRAFT_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const NOW = new Date("2026-08-05T08:00:00.000Z");

let root: string;
let database: AgenteraControlPlaneDatabase;
let store: OrganizationExperienceCandidateStore;

function nodeSqliteFactory(path: string): AgenteraSqliteDatabase {
  return new DatabaseSync(path) as unknown as AgenteraSqliteDatabase;
}

function canonicalCandidate(): ReturnType<
  typeof canonicalizeExperienceCandidate
> {
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

function prepareInput(
  overrides: Partial<PrepareLocalOrganizationExperienceCandidate> = {},
): PrepareLocalOrganizationExperienceCandidate {
  return {
    id: CANDIDATE_ID,
    agentInstallationId: INSTALLATION_ID,
    organizationId: ORGANIZATION_ID,
    agentDefinitionId: DEFINITION_ID,
    sourceAgentVersionId: VERSION_ID,
    runtimeProfileId: PROFILE_ID,
    skillName: "weekly-summary",
    sourceRelativePath: "skills/writing/weekly-summary",
    canonical: canonicalCandidate(),
    ...overrides,
  };
}

function snapshotPath(candidateId = CANDIDATE_ID): string {
  return join(
    database.paths.candidatesPath,
    OWNER.tenantId,
    OWNER.ownerId,
    OWNER.deviceInstallationId,
    ORGANIZATION_ID,
    candidateId,
    "candidate.json",
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agentera-organization-candidate-store-"));
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
    randomUUID,
  });
});

afterEach(() => {
  database.close();
  rmSync(root, { recursive: true, force: true });
});

describe("OrganizationExperienceCandidateStore", () => {
  it("stores one immutable snapshot in the exact owner/device/Organization partition", () => {
    const canonical = canonicalCandidate();
    const created = store.prepare(prepareInput({ canonical }));
    expect(created).toEqual({
      id: CANDIDATE_ID,
      agentInstallationId: INSTALLATION_ID,
      organizationId: ORGANIZATION_ID,
      agentDefinitionId: DEFINITION_ID,
      sourceAgentVersionId: VERSION_ID,
      skillName: "weekly-summary",
      contentDigest: canonical.contentDigest,
      status: "PREPARED",
      cloudCandidateId: null,
      lastErrorCode: null,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      submittedAt: null,
    });
    expect(created).not.toHaveProperty("runtimeProfileId");
    expect(created).not.toHaveProperty("sourceRelativePath");
    expect(created).not.toHaveProperty("snapshotRelativePath");
    expect(readFileSync(snapshotPath(), "utf8")).toBe(canonical.canonicalJson);
    expect(store.readSnapshot(CANDIDATE_ID)).toEqual(canonical);
    expect(store.listForOrganization(ORGANIZATION_ID)).toEqual([created]);
    expect(
      database.sqlite
        .prepare(
          `SELECT runtime_profile_id, source_relative_path, snapshot_relative_path
           FROM local_organization_experience_candidates WHERE id = ?`,
        )
        .get(CANDIDATE_ID),
    ).toEqual({
      runtime_profile_id: PROFILE_ID,
      source_relative_path: "skills/writing/weekly-summary",
      snapshot_relative_path: [
        OWNER.tenantId,
        OWNER.ownerId,
        OWNER.deviceInstallationId,
        ORGANIZATION_ID,
        CANDIDATE_ID,
        "candidate.json",
      ].join("/"),
    });

    const otherDevice = new OrganizationExperienceCandidateStore({
      database,
      owner: OTHER_DEVICE,
    });
    expect(otherDevice.listForOrganization(ORGANIZATION_ID)).toEqual([]);
    expect(() => otherDevice.get(CANDIDATE_ID)).toThrowError(
      new OrganizationExperienceCandidateStoreError("candidate_not_found"),
    );
  });

  it("keeps retry state local and removes snapshot bytes only after Cloud acceptance", () => {
    store.prepare(prepareInput());
    expect(
      store.markUploadFailed(CANDIDATE_ID, "cloud_unavailable"),
    ).toMatchObject({
      status: "UPLOAD_FAILED",
      lastErrorCode: "cloud_unavailable",
    });
    expect(
      store.markPreparedWithError(CANDIDATE_ID, "organization_agent_forbidden"),
    ).toMatchObject({
      status: "PREPARED",
      lastErrorCode: "organization_agent_forbidden",
    });
    expect(store.markSubmitted(CANDIDATE_ID, CLOUD_CANDIDATE_ID)).toMatchObject(
      {
        status: "SUBMITTED",
        cloudCandidateId: CLOUD_CANDIDATE_ID,
        submittedAt: NOW.toISOString(),
      },
    );
    expect(existsSync(snapshotPath())).toBe(false);
  });

  it("keys import receipts by owner/device/Organization/candidate", () => {
    database.sqlite
      .prepare(
        `INSERT INTO agent_drafts (
           id, tenant_id, owner_id, target_scope, workspace_id, organization_id,
           source_agent_definition_id, base_agent_version_id,
           display_name, manifest_json, revision, created_at, updated_at
         ) VALUES (?, ?, ?, 'ORGANIZATION', NULL, ?, ?, ?, ?, '{}', 1, ?, ?)`,
      )
      .run(
        DRAFT_ID,
        OWNER.tenantId,
        OWNER.ownerId,
        ORGANIZATION_ID,
        DEFINITION_ID,
        VERSION_ID,
        "Imported Organization candidate",
        NOW.toISOString(),
        NOW.toISOString(),
      );
    database.sqlite.exec("BEGIN IMMEDIATE");
    let receipt;
    try {
      receipt = store.recordImportInCurrentTransaction({
        candidateId: CLOUD_CANDIDATE_ID,
        organizationId: ORGANIZATION_ID,
        agentDefinitionId: DEFINITION_ID,
        baseAgentVersionId: VERSION_ID,
        candidateContentDigest: "ab".repeat(32),
        draftId: DRAFT_ID,
      });
      database.sqlite.exec("COMMIT");
    } catch (error) {
      database.sqlite.exec("ROLLBACK");
      throw error;
    }
    expect(receipt).toEqual({
      candidateId: CLOUD_CANDIDATE_ID,
      organizationId: ORGANIZATION_ID,
      agentDefinitionId: DEFINITION_ID,
      baseAgentVersionId: VERSION_ID,
      candidateContentDigest: "ab".repeat(32),
      draftId: DRAFT_ID,
      importedAt: NOW.toISOString(),
    });
    expect(store.findImport(ORGANIZATION_ID, CLOUD_CANDIDATE_ID)).toEqual(
      receipt,
    );
    const otherDevice = new OrganizationExperienceCandidateStore({
      database,
      owner: OTHER_DEVICE,
    });
    expect(
      otherDevice.findImport(ORGANIZATION_ID, CLOUD_CANDIDATE_ID),
    ).toBeNull();
  });
});
