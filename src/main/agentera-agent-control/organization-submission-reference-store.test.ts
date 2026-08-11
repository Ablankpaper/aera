// @vitest-environment node

import { mkdtempSync, rmSync } from "node:fs";
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
  OrganizationSubmissionReferenceStore,
  OrganizationSubmissionReferenceStoreError,
} from "./organization-submission-reference-store";

const OWNER: AgenteraRuntimeOwner = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  ownerId: "22222222-2222-4222-8222-222222222222",
  deviceInstallationId: "33333333-3333-4333-8333-333333333333",
};
const OTHER_OWNER: AgenteraRuntimeOwner = {
  ...OWNER,
  ownerId: "44444444-4444-4444-8444-444444444444",
};
const ORGANIZATION_ID = "55555555-5555-4555-8555-555555555555";
const DRAFT_ID = "66666666-6666-4666-8666-666666666666";
const DEFINITION_ID = "77777777-7777-4777-8777-777777777777";
const VERSION_ID = "88888888-8888-4888-8888-888888888888";
const SUBMISSION_ID = "99999999-9999-4999-8999-999999999999";
const CONTENT_DIGEST = "a".repeat(64);
const NOW = "2026-08-11T01:00:00.000Z";

function nodeSqliteFactory(path: string): AgenteraSqliteDatabase {
  return new DatabaseSync(path) as unknown as AgenteraSqliteDatabase;
}

function insertDraftReference(
  database: AgenteraControlPlaneDatabase,
  cloudRevision = 2,
): void {
  database.sqlite
    .prepare(
      `INSERT INTO agent_drafts (
         id, tenant_id, owner_id, target_scope, workspace_id, organization_id,
         display_name, manifest_json, revision,
         published_definition_id, published_version_id, published_revision,
         created_at, updated_at
       ) VALUES (?, ?, ?, 'ORGANIZATION', NULL, ?, ?, '{}', 2, ?, ?, 2, ?, ?)`,
    )
    .run(
      DRAFT_ID,
      OWNER.tenantId,
      OWNER.ownerId,
      ORGANIZATION_ID,
      "Enterprise Agent",
      DEFINITION_ID,
      VERSION_ID,
      NOW,
      NOW,
    );
  database.sqlite
    .prepare(
      `INSERT INTO organization_agent_submission_refs (
         local_draft_id, local_draft_revision, organization_id,
         cloud_submission_id, content_digest, cloud_status, cloud_revision,
         submitted_at, last_verified_at
       ) VALUES (?, 2, ?, ?, ?, 'approved', ?, ?, ?)`,
    )
    .run(
      DRAFT_ID,
      ORGANIZATION_ID,
      SUBMISSION_ID,
      CONTENT_DIGEST,
      cloudRevision,
      NOW,
      NOW,
    );
}

function snapshotBusinessRows(
  database: AgenteraControlPlaneDatabase,
): Record<string, unknown> {
  return {
    draft: database.sqlite
      .prepare(
        `SELECT id, tenant_id, owner_id, revision,
                published_definition_id, published_version_id,
                published_revision
         FROM agent_drafts WHERE id = ?`,
      )
      .get(DRAFT_ID),
    versions: database.sqlite
      .prepare("SELECT COUNT(*) AS count FROM cached_agent_versions")
      .get(),
    installations: database.sqlite
      .prepare("SELECT COUNT(*) AS count FROM local_agent_installations")
      .get(),
    bindings: database.sqlite
      .prepare("SELECT COUNT(*) AS count FROM runtime_bindings")
      .get(),
  };
}

describe("OrganizationSubmissionReferenceStore", () => {
  let root = "";
  let database: AgenteraControlPlaneDatabase;
  let store: OrganizationSubmissionReferenceStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "agentera-submission-reference-"));
    database = openAgenteraControlPlaneDatabase(join(root, "user-data"), {
      databaseFactory: nodeSqliteFactory,
    });
    insertDraftReference(database);
    store = new OrganizationSubmissionReferenceStore({
      database,
      owner: OWNER,
      now: () => new Date(NOW),
    });
  });

  afterEach(() => {
    database.close();
    rmSync(root, { recursive: true, force: true });
  });

  // @lat: [[agentera-agent-control-plane#Release gate#Organization Agent isolation#Conflict persistence and public privacy#Conflict journal allowlist]]
  it("quarantines idempotently and clears only the current owner's conflict", () => {
    const input = {
      organizationId: ORGANIZATION_ID,
      submissionId: SUBMISSION_ID,
      stage: "content_digest" as const,
      referenceRevision: 2,
    };
    store.quarantine(input);
    store.quarantine(input);

    expect(store.get(ORGANIZATION_ID, SUBMISSION_ID)).toMatchObject({
      stage: "content_digest",
      state: "quarantined",
      referenceRevision: 2,
      firstObservedAt: NOW,
      lastObservedAt: NOW,
    });
    expect(
      new OrganizationSubmissionReferenceStore({
        database,
        owner: OTHER_OWNER,
      }).get(ORGANIZATION_ID, SUBMISSION_ID),
    ).toBeNull();
    const persisted = database.sqlite
      .prepare("SELECT * FROM organization_agent_submission_ref_conflicts")
      .get() as Record<string, unknown>;
    expect(Object.keys(persisted)).not.toEqual(
      expect.arrayContaining([
        "content_digest",
        "local_draft_id",
        "api_key",
        "secret_value",
        "prompt",
        "profile_path",
      ]),
    );
    expect(JSON.stringify(persisted)).not.toContain(CONTENT_DIGEST);
    expect(store.clear(ORGANIZATION_ID, SUBMISSION_ID)).toBe(true);
    expect(store.get(ORGANIZATION_ID, SUBMISSION_ID)).toBeNull();
  });

  it("detaches only the link and preserves draft and publication rows", () => {
    store.quarantine({
      organizationId: ORGANIZATION_ID,
      submissionId: SUBMISSION_ID,
      stage: "definition",
      referenceRevision: 2,
    });
    const before = snapshotBusinessRows(database);

    const detached = store.detach({
      organizationId: ORGANIZATION_ID,
      submissionId: SUBMISSION_ID,
      expectedReferenceRevision: 2,
    });

    expect(
      database.sqlite
        .prepare(
          `SELECT cloud_submission_id
           FROM organization_agent_submission_refs
           WHERE cloud_submission_id = ?`,
        )
        .get(SUBMISSION_ID),
    ).toBeUndefined();
    expect(snapshotBusinessRows(database)).toEqual(before);
    expect(detached).toMatchObject({
      state: "detached",
      stage: "definition",
      referenceRevision: 2,
      resolvedAt: NOW,
    });
    expect(JSON.stringify(detached)).not.toMatch(
      /content_digest|draft_id|api_key|secret|prompt|profile_path/i,
    );
  });

  it("rolls back detach when the active reference revision changed", () => {
    store.quarantine({
      organizationId: ORGANIZATION_ID,
      submissionId: SUBMISSION_ID,
      stage: "compare_and_set",
      referenceRevision: 2,
    });
    database.sqlite
      .prepare(
        `UPDATE organization_agent_submission_refs
         SET cloud_revision = 3 WHERE cloud_submission_id = ?`,
      )
      .run(SUBMISSION_ID);

    expect(() =>
      store.detach({
        organizationId: ORGANIZATION_ID,
        submissionId: SUBMISSION_ID,
        expectedReferenceRevision: 2,
      }),
    ).toThrowError(
      expect.objectContaining<
        Partial<OrganizationSubmissionReferenceStoreError>
      >({ code: "organization_submission_reference_conflict" }),
    );
    expect(
      database.sqlite
        .prepare(
          `SELECT cloud_revision
           FROM organization_agent_submission_refs
           WHERE cloud_submission_id = ?`,
        )
        .get(SUBMISSION_ID),
    ).toEqual({ cloud_revision: 3 });
    expect(store.get(ORGANIZATION_ID, SUBMISSION_ID)?.state).toBe(
      "quarantined",
    );
  });
});
