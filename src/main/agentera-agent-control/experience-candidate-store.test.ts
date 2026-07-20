// @vitest-environment node

import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
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
import {
  canonicalizeExperienceCandidate,
  EXPERIENCE_CANDIDATE_DLP_VERSION,
} from "./experience-candidate-contract";
import {
  ExperienceCandidateStore,
  ExperienceCandidateStoreError,
  type PrepareLocalExperienceCandidate,
} from "./experience-candidate-store";

const OWNER: AgenteraRuntimeOwner = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  ownerId: "22222222-2222-4222-8222-222222222222",
  deviceInstallationId: "33333333-3333-4333-8333-333333333333",
};
const OTHER_OWNER: AgenteraRuntimeOwner = {
  tenantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  ownerId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  deviceInstallationId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
};
const INSTALLATION_ID = "44444444-4444-4444-8444-444444444444";
const WORKSPACE_ID = "55555555-5555-4555-8555-555555555555";
const DEFINITION_ID = "66666666-6666-4666-8666-666666666666";
const VERSION_ID = "77777777-7777-4777-8777-777777777777";
const PROFILE_ID = "88888888-8888-4888-8888-888888888888";
const CANDIDATE_ID = "99999999-9999-4999-8999-999999999999";
const CLOUD_CANDIDATE_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const NOW = new Date("2026-07-20T15:00:00.000Z");

let root: string;
let database: AgenteraControlPlaneDatabase;
let store: ExperienceCandidateStore;

function nodeSqliteFactory(path: string): AgenteraSqliteDatabase {
  return new DatabaseSync(path) as unknown as AgenteraSqliteDatabase;
}

function insertInstallation(
  owner: AgenteraRuntimeOwner = OWNER,
  overrides: Partial<{
    installationId: string;
    workspaceId: string;
    definitionId: string;
    versionId: string;
    profileId: string;
    status: string;
  }> = {},
): void {
  database.sqlite
    .prepare(
      `INSERT INTO local_agent_installations (
         agent_installation_id, tenant_id, owner_id, device_installation_id,
         source_scope, source_workspace_id, definition_id, selected_version_id,
         runtime_profile_id, status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'WORKSPACE', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      overrides.installationId ?? INSTALLATION_ID,
      owner.tenantId,
      owner.ownerId,
      owner.deviceInstallationId,
      overrides.workspaceId ?? WORKSPACE_ID,
      overrides.definitionId ?? DEFINITION_ID,
      overrides.versionId ?? VERSION_ID,
      overrides.profileId ?? PROFILE_ID,
      overrides.status ?? "active",
      NOW.toISOString(),
      NOW.toISOString(),
    );
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
  overrides: Partial<PrepareLocalExperienceCandidate> = {},
): PrepareLocalExperienceCandidate {
  return {
    id: CANDIDATE_ID,
    agentInstallationId: INSTALLATION_ID,
    workspaceId: WORKSPACE_ID,
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
    candidateId,
    "candidate.json",
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agentera-candidate-store-"));
  database = openAgenteraControlPlaneDatabase(join(root, "user-data"), {
    databaseFactory: nodeSqliteFactory,
  });
  insertInstallation();
  store = new ExperienceCandidateStore({
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

describe("ExperienceCandidateStore", () => {
  it("atomically stores a detached immutable snapshot in the current owner/device partition", () => {
    const canonical = canonicalCandidate();
    const created = store.prepare(prepareInput({ canonical }));
    expect(created).toEqual({
      id: CANDIDATE_ID,
      agentInstallationId: INSTALLATION_ID,
      workspaceId: WORKSPACE_ID,
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

    const path = snapshotPath();
    expect(readFileSync(path, "utf8")).toBe(canonical.canonicalJson);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(store.get(CANDIDATE_ID)).toEqual(created);
    expect(store.listForContext(WORKSPACE_ID)).toEqual([created]);
    expect(store.readSnapshot(CANDIDATE_ID)).toEqual(canonical);
    expect(
      database.sqlite
        .prepare(
          `SELECT runtime_profile_id, source_relative_path,
                  snapshot_relative_path, dlp_contract_version
           FROM local_experience_candidates WHERE id = ?`,
        )
        .get(CANDIDATE_ID),
    ).toEqual({
      runtime_profile_id: PROFILE_ID,
      source_relative_path: "skills/writing/weekly-summary",
      snapshot_relative_path: [
        OWNER.tenantId,
        OWNER.ownerId,
        OWNER.deviceInstallationId,
        CANDIDATE_ID,
        "candidate.json",
      ].join("/"),
      dlp_contract_version: EXPERIENCE_CANDIDATE_DLP_VERSION,
    });

    const other = new ExperienceCandidateStore({
      database,
      owner: OTHER_OWNER,
    });
    expect(other.listForContext(WORKSPACE_ID)).toEqual([]);
    expect(() => other.get(CANDIDATE_ID)).toThrowError(
      new ExperienceCandidateStoreError("candidate_not_found"),
    );
  });

  it("checks the exact active Workspace Installation before materializing bytes", () => {
    for (const [name, override] of [
      ["installation", { agentInstallationId: randomUUID() }],
      ["workspace", { workspaceId: randomUUID() }],
      ["definition", { agentDefinitionId: randomUUID() }],
      ["version", { sourceAgentVersionId: randomUUID() }],
      ["profile", { runtimeProfileId: randomUUID() }],
    ] as const) {
      const id = randomUUID();
      expect(
        () => store.prepare(prepareInput({ id, ...override })),
        name,
      ).toThrowError(new ExperienceCandidateStoreError("invalid_candidate"));
      expect(existsSync(snapshotPath(id)), name).toBe(false);
    }
    for (const sourceRelativePath of [
      "/skills/weekly-summary",
      "skills/../weekly-summary",
      "skills/.hidden/weekly-summary",
      "skills/a/b/weekly-summary",
      "skills/writing\\weekly-summary",
    ]) {
      const id = randomUUID();
      expect(() =>
        store.prepare(prepareInput({ id, sourceRelativePath })),
      ).toThrowError(new ExperienceCandidateStoreError("invalid_candidate"));
      expect(existsSync(snapshotPath(id))).toBe(false);
    }
  });

  it("rejects digest reuse and tampering while cleaning only the new candidate tree", () => {
    store.prepare(prepareInput());
    const duplicateId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    expect(() => store.prepare(prepareInput({ id: duplicateId }))).toThrow();
    expect(existsSync(snapshotPath(duplicateId))).toBe(false);
    expect(existsSync(snapshotPath())).toBe(true);

    writeFileSync(snapshotPath(), "{}", { mode: 0o600 });
    expect(() => store.readSnapshot(CANDIDATE_ID)).toThrowError(
      new ExperienceCandidateStoreError("snapshot_invalid"),
    );
  });

  it("keeps retry state local and deletes snapshot bytes only after cloud acceptance commits", () => {
    store.prepare(prepareInput());
    expect(
      store.markUploadFailed(CANDIDATE_ID, "cloud_unavailable"),
    ).toMatchObject({
      status: "UPLOAD_FAILED",
      lastErrorCode: "cloud_unavailable",
    });
    expect(
      store.markPreparedWithError(CANDIDATE_ID, "workspace_forbidden"),
    ).toMatchObject({
      status: "PREPARED",
      lastErrorCode: "workspace_forbidden",
    });
    const submitted = store.markSubmitted(CANDIDATE_ID, CLOUD_CANDIDATE_ID);
    expect(submitted).toMatchObject({
      status: "SUBMITTED",
      cloudCandidateId: CLOUD_CANDIDATE_ID,
      lastErrorCode: null,
      submittedAt: NOW.toISOString(),
    });
    expect(existsSync(snapshotPath())).toBe(false);
    expect(store.markSubmitted(CANDIDATE_ID, CLOUD_CANDIDATE_ID)).toEqual(
      submitted,
    );
    expect(() => store.markSubmitted(CANDIDATE_ID, randomUUID())).toThrowError(
      new ExperienceCandidateStoreError("candidate_conflict"),
    );
  });

  it("reuses only identical sanitized mutation intents", () => {
    store.prepare(prepareInput());
    const requestHash = "ab".repeat(32);
    const first = store.getOrCreateMutationIntent(
      "SUBMIT",
      CANDIDATE_ID,
      requestHash,
    );
    expect(
      store.getOrCreateMutationIntent("SUBMIT", CANDIDATE_ID, requestHash),
    ).toEqual(first);
    expect(() =>
      store.getOrCreateMutationIntent("SUBMIT", CANDIDATE_ID, "cd".repeat(32)),
    ).toThrowError(new ExperienceCandidateStoreError("mutation_conflict"));
    const review = store.getOrCreateMutationIntent(
      "REVIEW",
      CANDIDATE_ID,
      "ef".repeat(32),
    );
    expect(review.idempotencyKey).not.toBe(first.idempotencyKey);

    const rows = database.sqlite
      .prepare(
        `SELECT id, record_type, payload_json
         FROM pending_sanitized_records ORDER BY record_type`,
      )
      .all() as Array<{
      id: string;
      record_type: string;
      payload_json: string;
    }>;
    expect(rows.map(({ record_type }) => record_type)).toEqual([
      "experience_candidate_review",
      "experience_candidate_submit",
    ]);
    for (const row of rows) {
      expect(JSON.parse(row.payload_json)).toEqual({
        candidateId: CANDIDATE_ID,
        requestHash:
          row.record_type === "experience_candidate_submit"
            ? requestHash
            : "ef".repeat(32),
      });
      for (const forbidden of [
        "bundle",
        "content",
        "finding",
        "note",
        "path",
        "profile",
      ]) {
        expect(row.payload_json).not.toContain(forbidden);
      }
    }
    store.completeMutationIntent(first.idempotencyKey);
    expect(
      database.sqlite
        .prepare("SELECT id FROM pending_sanitized_records WHERE id = ?")
        .get(first.idempotencyKey),
    ).toBeUndefined();
  });

  it("finds only the current reviewer device's imported draft receipt", () => {
    const draftId = "12121212-1212-4212-8212-121212121212";
    database.sqlite
      .prepare(
        `INSERT INTO agent_drafts (
           id, tenant_id, owner_id, target_scope, workspace_id,
           display_name, manifest_json, revision, created_at, updated_at
         ) VALUES (?, ?, ?, 'WORKSPACE', ?, ?, '{}', 1, ?, ?)`,
      )
      .run(
        draftId,
        OWNER.tenantId,
        OWNER.ownerId,
        WORKSPACE_ID,
        "Imported candidate",
        NOW.toISOString(),
        NOW.toISOString(),
      );
    database.sqlite
      .prepare(
        `INSERT INTO local_experience_candidate_imports (
           tenant_id, owner_id, device_installation_id, workspace_id,
           candidate_id, agent_definition_id, base_agent_version_id,
           candidate_content_digest, draft_id, imported_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        OWNER.tenantId,
        OWNER.ownerId,
        OWNER.deviceInstallationId,
        WORKSPACE_ID,
        CLOUD_CANDIDATE_ID,
        DEFINITION_ID,
        VERSION_ID,
        "ab".repeat(32),
        draftId,
        NOW.toISOString(),
      );
    expect(store.findImport(CLOUD_CANDIDATE_ID)).toEqual({
      candidateId: CLOUD_CANDIDATE_ID,
      workspaceId: WORKSPACE_ID,
      agentDefinitionId: DEFINITION_ID,
      baseAgentVersionId: VERSION_ID,
      candidateContentDigest: "ab".repeat(32),
      draftId,
      importedAt: NOW.toISOString(),
    });
    const other = new ExperienceCandidateStore({
      database,
      owner: OTHER_OWNER,
    });
    expect(other.findImport(CLOUD_CANDIDATE_ID)).toBeNull();
  });

  it("records an import receipt only inside its caller-owned transaction", () => {
    const draftId = "13131313-1313-4313-8313-131313131313";
    database.sqlite
      .prepare(
        `INSERT INTO agent_drafts (
           id, tenant_id, owner_id, target_scope, workspace_id,
           source_agent_definition_id, base_agent_version_id,
           display_name, manifest_json, revision, created_at, updated_at
         ) VALUES (?, ?, ?, 'WORKSPACE', ?, ?, ?, ?, '{}', 1, ?, ?)`,
      )
      .run(
        draftId,
        OWNER.tenantId,
        OWNER.ownerId,
        WORKSPACE_ID,
        DEFINITION_ID,
        VERSION_ID,
        "Imported candidate",
        NOW.toISOString(),
        NOW.toISOString(),
      );
    const receipt = {
      candidateId: CLOUD_CANDIDATE_ID,
      workspaceId: WORKSPACE_ID,
      agentDefinitionId: DEFINITION_ID,
      baseAgentVersionId: VERSION_ID,
      candidateContentDigest: "ab".repeat(32),
      draftId,
    };

    database.sqlite.exec("BEGIN IMMEDIATE");
    expect(store.recordImportInCurrentTransaction(receipt)).toMatchObject(
      receipt,
    );
    database.sqlite.exec("ROLLBACK");
    expect(store.findImport(CLOUD_CANDIDATE_ID)).toBeNull();

    database.sqlite.exec("BEGIN IMMEDIATE");
    const committed = store.recordImportInCurrentTransaction(receipt);
    database.sqlite.exec("COMMIT");
    expect(store.findImport(CLOUD_CANDIDATE_ID)).toEqual(committed);
    expect(committed.importedAt).toBe(NOW.toISOString());
  });
});
