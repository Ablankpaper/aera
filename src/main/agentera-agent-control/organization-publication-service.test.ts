// @vitest-environment node

import { mkdtempSync, rmSync } from "node:fs";
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
import type {
  AgentEditableManifest,
  AgenteraAgentControlContext,
} from "../../shared/agentera-agent-control";
import {
  openAgenteraControlPlaneDatabase,
  type AgenteraControlPlaneDatabase,
  type AgenteraSqliteDatabase,
} from "./db";
import { AgentDraftStore } from "./draft-store";
import type {
  OrganizationAgentSubmissionDetailRecord,
  OrganizationAgentSubmissionRecord,
  SubmitOrganizationAgentRequest,
} from "./client";
import { canonicalizeEditableAgent } from "./manifest";
import {
  OrganizationPublicationService,
  type OrganizationPublicationClient,
} from "./organization-publication-service";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const DEVICE_ID = "12121212-1212-4121-8121-121212121212";
const OTHER_USER_ID = "33333333-3333-4333-8333-333333333333";
const ORGANIZATION_ID = "44444444-4444-4444-8444-444444444444";
const OTHER_ORGANIZATION_ID = "55555555-5555-4555-8555-555555555555";
const DRAFT_ID = "66666666-6666-4666-8666-666666666666";
const HANDLE_ID = "77777777-7777-4777-8777-777777777777";
const SUBMISSION_ID = "88888888-8888-4888-8888-888888888888";
const DEFINITION_ID = "99999999-9999-4999-8999-999999999999";
const VERSION_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OTHER_DEFINITION_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const OTHER_DRAFT_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const OTHER_SUBMISSION_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const REVIEW_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const POLICY_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NOW = new Date("2026-07-21T04:00:00.000Z");

function nodeSqliteFactory(path: string): AgenteraSqliteDatabase {
  return new DatabaseSync(path) as unknown as AgenteraSqliteDatabase;
}

function manifest(systemPrompt = "Research safely"): AgentEditableManifest {
  return {
    schemaVersion: 1,
    identity: { systemPrompt },
    assets: [
      {
        path: "knowledge/notes.md",
        kind: "knowledge",
        mediaType: "text/markdown",
      },
    ],
    modelConstraints: {
      allowedProviders: ["openai"],
      allowedModels: ["gpt-5.6"],
    },
    tools: { allowed: ["files.read"], denied: [] },
    dependencies: [],
    runtimeCompatibility: {
      minimumVersion: "v0.18.2-agentera.1",
      maximumVersionExclusive: null,
    },
  };
}

function submissionDetail(
  overrides: Partial<OrganizationAgentSubmissionDetailRecord> = {},
): OrganizationAgentSubmissionDetailRecord {
  const canonical = canonicalizeEditableAgent(manifest(), [
    { path: "knowledge/notes.md", content: "# Notes\n" },
  ]);
  const status = overrides.status ?? "pending";
  return {
    id: SUBMISSION_ID,
    organization_id: ORGANIZATION_ID,
    kind: "initial",
    definition_id: DEFINITION_ID,
    base_version_id: null,
    published_version_id: status === "approved" ? VERSION_ID : null,
    submitted_by_user_id: USER_ID,
    content_digest: canonical.contentDigest,
    status: "pending",
    revision: 1,
    submitted_at: NOW.toISOString(),
    terminal_at: null,
    updated_at: NOW.toISOString(),
    review: null,
    display_name: "Organization Research Agent",
    manifest: JSON.parse(canonical.manifestBytes.toString("utf8")),
    bundle: JSON.parse(canonical.bundleBytes.toString("utf8")),
    manifest_digest: canonical.manifestDigest,
    bundle_digest: canonical.bundleDigest,
    ...overrides,
  };
}

function approvedDetail(
  overrides: Partial<OrganizationAgentSubmissionDetailRecord> = {},
): OrganizationAgentSubmissionDetailRecord {
  const contentDigest =
    overrides.content_digest ?? submissionDetail().content_digest;
  return submissionDetail({
    status: "approved",
    revision: 2,
    terminal_at: NOW.toISOString(),
    published_version_id: VERSION_ID,
    review: {
      id: REVIEW_ID,
      reviewer_user_id: OTHER_USER_ID,
      decision: "approve",
      reason_code: null,
      safe_note: null,
      organization_policy_snapshot_id: POLICY_ID,
      organization_policy_version: 1,
      reviewed_content_digest: contentDigest,
      reviewed_at: NOW.toISOString(),
    },
    ...overrides,
  });
}

function submissionRecord(
  detail: OrganizationAgentSubmissionDetailRecord,
): OrganizationAgentSubmissionRecord {
  return {
    id: detail.id,
    organization_id: detail.organization_id,
    kind: detail.kind,
    definition_id: detail.definition_id,
    base_version_id: detail.base_version_id,
    published_version_id: detail.published_version_id,
    submitted_by_user_id: detail.submitted_by_user_id,
    content_digest: detail.content_digest,
    status: detail.status,
    revision: detail.revision,
    submitted_at: detail.submitted_at,
    terminal_at: detail.terminal_at,
    updated_at: detail.updated_at,
    review: detail.review,
  };
}

describe("Organization publication service", () => {
  let root = "";
  let database: AgenteraControlPlaneDatabase;
  let drafts: AgentDraftStore;
  let context: AgenteraAgentControlContext;
  let online = true;
  let submitOrganizationAgent: Mock<
    OrganizationPublicationClient["submitOrganizationAgent"]
  >;
  let listSubmissions: Mock<
    OrganizationPublicationClient["listOrganizationAgentSubmissions"]
  >;
  let getSubmission: Mock<
    OrganizationPublicationClient["getOrganizationAgentSubmission"]
  >;
  let withdrawSubmission: Mock<
    OrganizationPublicationClient["withdrawOrganizationAgentSubmission"]
  >;
  let reviewSubmission: Mock<
    OrganizationPublicationClient["reviewOrganizationAgentSubmission"]
  >;
  let client: OrganizationPublicationClient;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "agentera-organization-publication-"));
    database = openAgenteraControlPlaneDatabase(join(root, "user-data"), {
      databaseFactory: nodeSqliteFactory,
    });
    context = {
      scope: "ORGANIZATION",
      organizationId: ORGANIZATION_ID,
      role: "owner",
    };
    drafts = new AgentDraftStore({
      database,
      owner: { tenantId: TENANT_ID, ownerId: USER_ID },
      context,
      now: () => NOW,
      randomUUID: () => DRAFT_ID,
    });
    drafts.createDraft({
      sourceAgentDefinitionId: null,
      baseAgentVersionId: null,
      displayName: "Organization Research Agent",
      icon: null,
      manifest: manifest(),
      assets: [{ path: "knowledge/notes.md", content: "# Notes\n" }],
    });
    submitOrganizationAgent = vi
      .fn<OrganizationPublicationClient["submitOrganizationAgent"]>()
      .mockResolvedValue(submissionDetail());
    listSubmissions = vi
      .fn<OrganizationPublicationClient["listOrganizationAgentSubmissions"]>()
      .mockResolvedValue([submissionRecord(submissionDetail())]);
    getSubmission = vi
      .fn<OrganizationPublicationClient["getOrganizationAgentSubmission"]>()
      .mockResolvedValue(submissionDetail());
    withdrawSubmission = vi
      .fn<
        OrganizationPublicationClient["withdrawOrganizationAgentSubmission"]
      >()
      .mockResolvedValue(
        submissionDetail({
          status: "withdrawn",
          revision: 2,
          terminal_at: NOW.toISOString(),
        }),
      );
    reviewSubmission = vi
      .fn<OrganizationPublicationClient["reviewOrganizationAgentSubmission"]>()
      .mockResolvedValue(
        submissionDetail({
          status: "approved",
          revision: 2,
          terminal_at: NOW.toISOString(),
          review: {
            id: REVIEW_ID,
            reviewer_user_id: OTHER_USER_ID,
            decision: "approve",
            reason_code: null,
            safe_note: null,
            organization_policy_snapshot_id: POLICY_ID,
            organization_policy_version: 1,
            reviewed_content_digest: submissionDetail().content_digest,
            reviewed_at: NOW.toISOString(),
          },
        }),
      );
    client = {
      submitOrganizationAgent,
      listOrganizationAgentSubmissions: listSubmissions,
      getOrganizationAgentSubmission: getSubmission,
      withdrawOrganizationAgentSubmission: withdrawSubmission,
      reviewOrganizationAgentSubmission: reviewSubmission,
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    database.close();
    rmSync(root, { recursive: true, force: true });
  });

  function service(): OrganizationPublicationService {
    return new OrganizationPublicationService({
      database,
      owner: {
        tenantId: TENANT_ID,
        ownerId: USER_ID,
        deviceInstallationId: DEVICE_ID,
      },
      drafts,
      client,
      getContext: () => context,
      getActorUserId: () => USER_ID,
      isOnline: () => online,
      now: () => NOW,
      randomUUID: () => HANDLE_ID,
    });
  }

  it("invalidates a prepared submission when trusted context changes", async () => {
    const publication = service();
    const preview = publication.prepareSubmission(DRAFT_ID);
    context = {
      scope: "ORGANIZATION",
      organizationId: OTHER_ORGANIZATION_ID,
      role: "owner",
    };

    await expect(
      publication.submitPrepared({
        publicationHandle: preview.publicationHandle,
        confirmation: "submit-organization-agent",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(submitOrganizationAgent).not.toHaveBeenCalled();
  });

  it("submits one immutable draft revision and stores only its cloud reference", async () => {
    const publication = service();
    const preview = publication.prepareSubmission(DRAFT_ID);
    expect(preview).toMatchObject({
      draftId: DRAFT_ID,
      revision: 1,
      kind: "initial",
      assetCounts: { skill: 0, sop: 0, knowledge: 1 },
      totalBytes: Buffer.byteLength("# Notes\n"),
    });
    await publication.submitPrepared({
      publicationHandle: preview.publicationHandle,
      confirmation: "submit-organization-agent",
    });

    expect(submitOrganizationAgent).toHaveBeenCalledWith(
      ORGANIZATION_ID,
      expect.objectContaining<Partial<SubmitOrganizationAgentRequest>>({
        kind: "initial",
        display_name: "Organization Research Agent",
      }),
      expect.any(String),
    );
    expect(
      database.sqlite
        .prepare("SELECT * FROM organization_agent_submission_refs")
        .all(),
    ).toEqual([
      {
        local_draft_id: DRAFT_ID,
        local_draft_revision: 1,
        organization_id: ORGANIZATION_ID,
        cloud_submission_id: SUBMISSION_ID,
        content_digest: preview.contentDigest,
        cloud_status: "pending",
        cloud_revision: 1,
        submitted_at: NOW.toISOString(),
        last_verified_at: NOW.toISOString(),
      },
    ]);
  });

  // @lat: [[agentera-organizations#Organization Agent approval#Submission reference recovery#Six-stage quarantine and exact repair#Exact automatic repair]]
  it("reconciles an approved older revision without overwriting newer edits", async () => {
    const publication = service();
    const preview = publication.prepareSubmission(DRAFT_ID);
    await publication.submitPrepared({
      publicationHandle: preview.publicationHandle,
      confirmation: "submit-organization-agent",
    });
    drafts.updateDraft({
      id: DRAFT_ID,
      expectedRevision: 1,
      displayName: "Organization Research Agent 2",
      icon: null,
      manifest: manifest("Unpublished revision"),
      assets: [{ path: "knowledge/notes.md", content: "# New notes\n" }],
    });
    listSubmissions.mockResolvedValue([submissionRecord(approvedDetail())]);

    const summaries = await publication.listSubmissions();
    expect(summaries[0]).toMatchObject({
      id: SUBMISSION_ID,
      status: "approved",
      publishedVersionId: VERSION_ID,
      localDraftId: DRAFT_ID,
      localDraftRevision: 1,
    });
    const reconciled = drafts.getDraft(DRAFT_ID);
    expect(reconciled).toMatchObject({
      revision: 2,
      sourceAgentDefinitionId: DEFINITION_ID,
      baseAgentVersionId: VERSION_ID,
      publishedRevision: {
        revision: 1,
        definitionId: DEFINITION_ID,
        versionId: VERSION_ID,
      },
    });
    expect(reconciled.manifest.identity.systemPrompt).toBe(
      "Unpublished revision",
    );
    expect(drafts.readAsset(DRAFT_ID, "knowledge/notes.md").toString()).toBe(
      "# New notes\n",
    );

    await expect(publication.listSubmissions()).resolves.toHaveLength(1);
    expect(drafts.getDraft(DRAFT_ID)).toEqual(reconciled);
  });

  // @lat: [[agentera-organizations#Organization Agent approval#Submission reference recovery#Per-record list isolation#Healthy and conflicted rows coexist]]
  it("returns healthy and digest-conflicted submissions together", async () => {
    const publication = service();
    const preview = publication.prepareSubmission(DRAFT_ID);
    await publication.submitPrepared({
      publicationHandle: preview.publicationHandle,
      confirmation: "submit-organization-agent",
    });
    const wrongDigest = "12".repeat(32);
    listSubmissions.mockResolvedValue([
      submissionRecord(submissionDetail({ id: OTHER_SUBMISSION_ID })),
      submissionRecord(
        approvedDetail({
          content_digest: wrongDigest,
          review: {
            ...approvedDetail().review!,
            reviewed_content_digest: wrongDigest,
          },
        }),
      ),
    ]);

    const result = await publication.listSubmissionList();

    expect(result.submissions).toHaveLength(2);
    expect(
      result.submissions.find((item) => item.id === SUBMISSION_ID),
    ).toMatchObject({
      localDraftId: null,
      localDraftRevision: null,
      referenceState: { kind: "quarantined", stage: "content_digest" },
    });
    expect(
      result.submissions.find((item) => item.id === OTHER_SUBMISSION_ID),
    ).toMatchObject({ referenceState: { kind: "remote_only" } });
  });

  // @lat: [[agentera-organizations#Organization Agent approval#Submission reference recovery#Per-record list isolation#Malformed row omission]]
  it("omits one malformed Cloud row without hiding valid rows", async () => {
    listSubmissions.mockResolvedValue([
      submissionRecord(submissionDetail()),
      {
        ...submissionRecord(submissionDetail({ id: OTHER_SUBMISSION_ID })),
        revision: 0,
      },
    ]);

    const result = await service().listSubmissionList();

    expect(result.submissions).toHaveLength(1);
    expect(result.issues).toEqual([
      {
        submissionId: OTHER_SUBMISSION_ID,
        code: "cloud_record_invalid",
      },
    ]);
  });

  // @lat: [[agentera-organizations#Organization Agent approval#Submission reference recovery#Six-stage quarantine and exact repair#Six-stage conflict classification]]
  it.each([
    {
      stage: "reference_shape" as const,
      arrange: (): OrganizationAgentSubmissionRecord => {
        database.sqlite.exec("PRAGMA ignore_check_constraints = ON");
        database.sqlite
          .prepare(
            `UPDATE organization_agent_submission_refs
             SET local_draft_revision = 'invalid'
             WHERE cloud_submission_id = ?`,
          )
          .run(SUBMISSION_ID);
        return submissionRecord(approvedDetail());
      },
    },
    {
      stage: "content_digest" as const,
      arrange: (): OrganizationAgentSubmissionRecord => {
        const digest = "34".repeat(32);
        return submissionRecord(
          approvedDetail({
            content_digest: digest,
            review: {
              ...approvedDetail().review!,
              reviewed_content_digest: digest,
            },
          }),
        );
      },
    },
    {
      stage: "definition" as const,
      arrange: (): OrganizationAgentSubmissionRecord => {
        database.sqlite
          .prepare(
            `UPDATE agent_drafts
             SET source_agent_definition_id = ?, base_agent_version_id = ?
             WHERE id = ?`,
          )
          .run(DEFINITION_ID, VERSION_ID, DRAFT_ID);
        return submissionRecord(
          approvedDetail({ definition_id: OTHER_DEFINITION_ID }),
        );
      },
    },
    {
      stage: "published_version" as const,
      arrange: (): OrganizationAgentSubmissionRecord => {
        database.sqlite
          .prepare(
            `UPDATE agent_drafts
             SET source_agent_definition_id = ?, base_agent_version_id = ?,
                 published_definition_id = ?, published_version_id = ?,
                 published_revision = 1
             WHERE id = ?`,
          )
          .run(
            DEFINITION_ID,
            OTHER_DEFINITION_ID,
            DEFINITION_ID,
            OTHER_DEFINITION_ID,
            DRAFT_ID,
          );
        return submissionRecord(approvedDetail());
      },
    },
    {
      stage: "draft_publication" as const,
      arrange: (): OrganizationAgentSubmissionRecord => {
        vi.spyOn(drafts, "recordPublishedRevision").mockImplementation(() => {
          throw new Error("private draft write failure");
        });
        return submissionRecord(approvedDetail());
      },
    },
    {
      stage: "compare_and_set" as const,
      arrange: (): OrganizationAgentSubmissionRecord => {
        database.sqlite.exec(`
          CREATE TRIGGER ignore_submission_reference_update
          BEFORE UPDATE OF cloud_status, cloud_revision, last_verified_at
          ON organization_agent_submission_refs
          BEGIN
            SELECT RAISE(IGNORE);
          END;
        `);
        return submissionRecord(approvedDetail());
      },
    },
  ])(
    "quarantines the $stage reference stage safely",
    async ({ stage, arrange }) => {
      const publication = service();
      const preview = publication.prepareSubmission(DRAFT_ID);
      await publication.submitPrepared({
        publicationHandle: preview.publicationHandle,
        confirmation: "submit-organization-agent",
      });
      listSubmissions.mockResolvedValue([arrange()]);

      const result = await publication.listSubmissionList();

      expect(result.submissions).toEqual([
        expect.objectContaining({
          id: SUBMISSION_ID,
          localDraftId: null,
          localDraftRevision: null,
          referenceState: { kind: "quarantined", stage },
        }),
      ]);
      expect(
        database.sqlite
          .prepare(
            `SELECT stage, state, reference_revision
           FROM organization_agent_submission_ref_conflicts
           WHERE cloud_submission_id = ?`,
          )
          .get(SUBMISSION_ID),
      ).toEqual({
        stage,
        state: "quarantined",
        reference_revision: 1,
      });
      expect(
        database.sqlite
          .prepare(
            `SELECT cloud_submission_id
           FROM organization_agent_submission_refs
           WHERE cloud_submission_id = ?`,
          )
          .get(SUBMISSION_ID),
      ).toEqual({ cloud_submission_id: SUBMISSION_ID });
    },
  );

  it("isolates malformed Cloud rows and classifies local reference drift", async () => {
    const publication = service();
    const preview = publication.prepareSubmission(DRAFT_ID);
    await publication.submitPrepared({
      publicationHandle: preview.publicationHandle,
      confirmation: "submit-organization-agent",
    });

    listSubmissions.mockResolvedValue([
      submissionRecord(approvedDetail({ published_version_id: null })),
    ]);
    await expect(publication.listSubmissionList()).resolves.toEqual({
      submissions: [],
      issues: [{ submissionId: SUBMISSION_ID, code: "cloud_record_invalid" }],
    });

    const wrongDigest = "12".repeat(32);
    listSubmissions.mockResolvedValue([
      submissionRecord(
        approvedDetail({
          content_digest: wrongDigest,
          review: {
            ...approvedDetail().review!,
            reviewed_content_digest: wrongDigest,
          },
        }),
      ),
    ]);
    await expect(publication.listSubmissionList()).resolves.toMatchObject({
      submissions: [
        {
          id: SUBMISSION_ID,
          referenceState: {
            kind: "quarantined",
            stage: "content_digest",
          },
        },
      ],
    });

    listSubmissions.mockResolvedValue([submissionRecord(approvedDetail())]);
    await publication.listSubmissions();
    listSubmissions.mockResolvedValue([
      submissionRecord(approvedDetail({ definition_id: OTHER_DEFINITION_ID })),
    ]);
    await expect(publication.listSubmissionList()).resolves.toMatchObject({
      submissions: [
        {
          id: SUBMISSION_ID,
          referenceState: {
            kind: "quarantined",
            stage: "definition",
          },
        },
      ],
    });
    expect(drafts.getDraft(DRAFT_ID).publishedRevision).toEqual({
      revision: 1,
      definitionId: DEFINITION_ID,
      versionId: VERSION_ID,
    });
  });

  it("does not reconcile a submission reference owned by another account", async () => {
    const otherDrafts = new AgentDraftStore({
      database,
      owner: { tenantId: TENANT_ID, ownerId: OTHER_USER_ID },
      context,
      now: () => NOW,
      randomUUID: () => OTHER_DRAFT_ID,
    });
    otherDrafts.createDraft({
      sourceAgentDefinitionId: null,
      baseAgentVersionId: null,
      displayName: "Other account Agent",
      icon: null,
      manifest: manifest(),
      assets: [{ path: "knowledge/notes.md", content: "# Notes\n" }],
    });
    const response = approvedDetail({
      id: OTHER_SUBMISSION_ID,
      submitted_by_user_id: OTHER_USER_ID,
    });
    database.sqlite
      .prepare(
        `INSERT INTO organization_agent_submission_refs (
           local_draft_id, local_draft_revision, organization_id,
           cloud_submission_id, content_digest, cloud_status, cloud_revision,
           submitted_at, last_verified_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        OTHER_DRAFT_ID,
        1,
        ORGANIZATION_ID,
        OTHER_SUBMISSION_ID,
        response.content_digest,
        "pending",
        1,
        NOW.toISOString(),
        NOW.toISOString(),
      );
    listSubmissions.mockResolvedValue([submissionRecord(response)]);

    await expect(service().listSubmissions()).resolves.toEqual([
      expect.objectContaining({
        id: OTHER_SUBMISSION_ID,
        localDraftId: null,
        localDraftRevision: null,
      }),
    ]);
    expect(otherDrafts.getDraft(OTHER_DRAFT_ID).publishedRevision).toBeNull();
    expect(
      database.sqlite
        .prepare(
          `SELECT cloud_status FROM organization_agent_submission_refs
           WHERE cloud_submission_id = ?`,
        )
        .get(OTHER_SUBMISSION_ID),
    ).toEqual({ cloud_status: "pending" });
  });

  it("binds withdrawal to the fetched pending revision and consumes its handle", async () => {
    const publication = service();
    const preview = await publication.prepareWithdrawal(SUBMISSION_ID);
    await publication.confirmWithdrawal({
      withdrawalHandle: preview.withdrawalHandle,
      confirmation: "withdraw-organization-agent",
    });
    expect(withdrawSubmission).toHaveBeenCalledWith(
      ORGANIZATION_ID,
      SUBMISSION_ID,
      preview.revision,
      expect.any(String),
    );
    await expect(
      publication.confirmWithdrawal({
        withdrawalHandle: preview.withdrawalHandle,
        confirmation: "withdraw-organization-agent",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(withdrawSubmission).toHaveBeenCalledOnce();
  });

  it("allows one authorized owner to submit and approve", async () => {
    reviewSubmission.mockResolvedValue(
      submissionDetail({
        status: "approved",
        revision: 2,
        terminal_at: NOW.toISOString(),
        review: {
          id: REVIEW_ID,
          reviewer_user_id: USER_ID,
          decision: "approve",
          reason_code: null,
          safe_note: null,
          organization_policy_snapshot_id: POLICY_ID,
          organization_policy_version: 1,
          reviewed_content_digest: submissionDetail().content_digest,
          reviewed_at: NOW.toISOString(),
        },
      }),
    );
    const publication = service();
    const preview = await publication.prepareReview({
      submissionId: SUBMISSION_ID,
      decision: "approve",
      reasonCode: null,
      safeNote: null,
    });
    expect(preview).toMatchObject({
      selfReview: true,
      reviewHandle: HANDLE_ID,
    });
    await publication.reviewPrepared({
      reviewHandle: HANDLE_ID,
      confirmation: "approve-organization-agent",
    });
    expect(reviewSubmission).toHaveBeenCalledWith(
      ORGANIZATION_ID,
      SUBMISSION_ID,
      {
        expected_revision: 1,
        decision: "approve",
      },
      expect.any(String),
    );
  });

  it("fails stale cloud review revisions before dispatching a mutation", async () => {
    getSubmission
      .mockResolvedValueOnce(
        submissionDetail({ submitted_by_user_id: OTHER_USER_ID }),
      )
      .mockResolvedValueOnce(
        submissionDetail({
          submitted_by_user_id: OTHER_USER_ID,
          revision: 2,
        }),
      );
    const publication = service();
    const preview = await publication.prepareReview({
      submissionId: SUBMISSION_ID,
      decision: "approve",
      reasonCode: null,
      safeNote: null,
    });
    expect(preview.reviewHandle).toBe(HANDLE_ID);
    await expect(
      publication.reviewPrepared({
        reviewHandle: HANDLE_ID,
        confirmation: "approve-organization-agent",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(reviewSubmission).not.toHaveBeenCalled();
  });

  it("dispatches one exact rejection for a different author", async () => {
    getSubmission.mockResolvedValue(
      submissionDetail({ submitted_by_user_id: OTHER_USER_ID }),
    );
    reviewSubmission.mockResolvedValue(
      submissionDetail({
        submitted_by_user_id: OTHER_USER_ID,
        status: "rejected",
        revision: 2,
        terminal_at: NOW.toISOString(),
        review: {
          id: REVIEW_ID,
          reviewer_user_id: USER_ID,
          decision: "reject",
          reason_code: "needs_revision",
          safe_note: "Remove the unsupported tool.",
          organization_policy_snapshot_id: POLICY_ID,
          organization_policy_version: 1,
          reviewed_content_digest: submissionDetail().content_digest,
          reviewed_at: NOW.toISOString(),
        },
      }),
    );
    const publication = service();
    const preview = await publication.prepareReview({
      submissionId: SUBMISSION_ID,
      decision: "reject",
      reasonCode: "needs_revision",
      safeNote: "Remove the unsupported tool.",
    });
    await publication.reviewPrepared({
      reviewHandle: preview.reviewHandle as string,
      confirmation: "reject-organization-agent",
    });

    expect(reviewSubmission).toHaveBeenCalledWith(
      ORGANIZATION_ID,
      SUBMISSION_ID,
      {
        expected_revision: 1,
        decision: "reject",
        reason_code: "needs_revision",
        safe_note: "Remove the unsupported tool.",
      },
      expect.any(String),
    );
  });

  it("fails offline and stale draft confirmations before mutation", async () => {
    const offlinePublication = service();
    const offlinePreview = offlinePublication.prepareSubmission(DRAFT_ID);
    online = false;
    await expect(
      offlinePublication.submitPrepared({
        publicationHandle: offlinePreview.publicationHandle,
        confirmation: "submit-organization-agent",
      }),
    ).rejects.toMatchObject({ code: "online_required" });
    expect(submitOrganizationAgent).not.toHaveBeenCalled();

    online = true;
    const stalePublication = service();
    const stalePreview = stalePublication.prepareSubmission(DRAFT_ID);
    drafts.updateDraft({
      id: DRAFT_ID,
      expectedRevision: 1,
      displayName: "Organization Research Agent",
      icon: null,
      manifest: manifest("Changed after preview"),
      assets: [{ path: "knowledge/notes.md", content: "# Notes\n" }],
    });
    await expect(
      stalePublication.submitPrepared({
        publicationHandle: stalePreview.publicationHandle,
        confirmation: "submit-organization-agent",
      }),
    ).rejects.toMatchObject({ code: "draft_conflict" });
    expect(submitOrganizationAgent).not.toHaveBeenCalled();
  });
});
