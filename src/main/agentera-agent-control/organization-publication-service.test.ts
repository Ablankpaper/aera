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
  SubmitOrganizationAgentRequest,
} from "./client";
import { canonicalizeEditableAgent } from "./manifest";
import {
  OrganizationPublicationService,
  type OrganizationPublicationClient,
} from "./organization-publication-service";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_USER_ID = "33333333-3333-4333-8333-333333333333";
const ORGANIZATION_ID = "44444444-4444-4444-8444-444444444444";
const OTHER_ORGANIZATION_ID = "55555555-5555-4555-8555-555555555555";
const DRAFT_ID = "66666666-6666-4666-8666-666666666666";
const HANDLE_ID = "77777777-7777-4777-8777-777777777777";
const SUBMISSION_ID = "88888888-8888-4888-8888-888888888888";
const DEFINITION_ID = "99999999-9999-4999-8999-999999999999";
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
  return {
    id: SUBMISSION_ID,
    organization_id: ORGANIZATION_ID,
    kind: "initial",
    definition_id: DEFINITION_ID,
    base_version_id: null,
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
      .mockResolvedValue([submissionDetail()]);
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
    database.close();
    rmSync(root, { recursive: true, force: true });
  });

  function service(): OrganizationPublicationService {
    return new OrganizationPublicationService({
      database,
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

  it("omits review confirmation for the submission author", async () => {
    const preview = await service().prepareReview({
      submissionId: SUBMISSION_ID,
      decision: "approve",
      reasonCode: null,
      safeNote: null,
    });
    expect(preview).toMatchObject({ selfReview: true, reviewHandle: null });
    expect(reviewSubmission).not.toHaveBeenCalled();
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
