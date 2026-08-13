import { readFile } from "node:fs/promises";

import { expect, test, type Page } from "playwright/test";

import type {
  AgenteraAgentControlResult,
  AgenteraAgentInstallationSummary,
  OfficialAgentInstallPreview,
  OfficialAgentSummary,
} from "../../src/shared/agentera-agent-control";
import {
  agentControlRequests,
  authenticateFirstAgentControlDevice,
  claimDefaultProfile,
  closeAgentControlHarness,
  createContentDeliveryHarness,
  invokeAgentera,
  launchAgentControlDevice,
  type AgentControlDevice,
  type AgentControlHarness,
} from "./support/agentera-agent-control-harness";
import { authenticateAdminBrowser } from "./support/agentera-desktop-fleet-harness";

type AdminRole = "operations_admin" | "publisher" | "super_admin";

type AdminFixture = {
  email: string;
  password: string;
  role: AdminRole;
};

type ContentDeliveryFixture = {
  admins: AdminFixture[];
  agentId: string;
};

type DeliveryLink = {
  cloudDefinitionId?: string | null;
  cloudDraftId?: string | null;
  cloudReleaseId?: string | null;
  cloudSubmissionId?: string | null;
  cloudVersionId?: string | null;
  contentDigest?: string | null;
  desktopVerification?: {
    stages?: Array<{
      contentDigest?: string;
      releaseRevisionId?: string;
      verificationStatus?: string;
      versionId?: string;
    }>;
  };
  syncStatus?: string;
};

type OfficialSubmission = {
  revision: number;
  status: string;
  submission_id: string;
};

type OfficialRelease = {
  channel: string;
  definition_id: string;
  head_revision: number;
  release_id: string;
  state: string;
};

type CloudPage<T> = { items: T[] };

type ApiEnvelope<T> = {
  data: T;
  requestId: string;
};

const allowedReceiptFields = new Set([
  "content_digest",
  "definition_id",
  "desktop_version",
  "error_code",
  "occurred_at",
  "release_revision_id",
  "request_id",
  "runtime_version",
  "verification_status",
  "version_id",
]);

let harness: AgentControlHarness | null = null;
let device: AgentControlDevice | null = null;

test.setTimeout(900_000);
test.use({ trace: "off" });

function unwrap<T>(result: AgenteraAgentControlResult<T>): T {
  if (!result.ok)
    throw new Error(`Desktop operation failed: ${result.errorCode}`);
  return result.data;
}

function fixtureAdmin(
  fixture: ContentDeliveryFixture,
  role: AdminRole,
): AdminFixture {
  const admin = fixture.admins.find((candidate) => candidate.role === role);
  if (!admin) throw new Error(`Content delivery ${role} fixture is missing.`);
  return admin;
}

async function api<T>(
  page: Page,
  path: string,
  method = "GET",
  body?: unknown,
): Promise<{ body: T; status: number }> {
  return page.evaluate(
    async (request) => {
      const response = await fetch(request.path, {
        body:
          request.body === undefined ? undefined : JSON.stringify(request.body),
        credentials: "include",
        headers:
          request.body === undefined
            ? undefined
            : { "content-type": "application/json" },
        method: request.method,
      });
      const text = await response.text();
      return {
        body: (text ? JSON.parse(text) : undefined) as T,
        status: response.status,
      };
    },
    { body, method, path },
  );
}

async function successful<T>(
  page: Page,
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const response = await api<T>(page, path, method, body);
  if (response.status < 200 || response.status >= 300) {
    const value =
      response.body &&
      typeof response.body === "object" &&
      !Array.isArray(response.body)
        ? (response.body as Record<string, unknown>)
        : {};
    const error =
      value.error &&
      typeof value.error === "object" &&
      !Array.isArray(value.error)
        ? (value.error as Record<string, unknown>)
        : {};
    throw new Error(
      `Admin API ${method} ${path} returned ${response.status}: ${JSON.stringify(
        {
          code: typeof error.code === "string" ? error.code : undefined,
          message:
            typeof error.message === "string" ? error.message : undefined,
          requestId:
            typeof value.requestId === "string" ? value.requestId : undefined,
        },
      )}.`,
    );
  }
  return response.body;
}

// @lat: [[agentera-agent-control-plane#Official Managed Agent V1#Admin-to-Desktop content delivery gate]]
test("Payload Admin publishes one official Agent through Cloud and verifies its Desktop activation", async () => {
  harness = await createContentDeliveryHarness();
  const official = harness.official;
  if (!official)
    throw new Error("Content delivery Admin harness is unavailable.");

  const fixture = JSON.parse(
    await readFile(official.adminFixtureFile, "utf8"),
  ) as ContentDeliveryFixture;
  const publisher = await authenticateAdminBrowser(
    harness,
    fixtureAdmin(fixture, "publisher"),
  );
  const reviewer = await authenticateAdminBrowser(
    harness,
    fixtureAdmin(fixture, "super_admin"),
  );
  const operator = await authenticateAdminBrowser(
    harness,
    fixtureAdmin(fixture, "operations_admin"),
  );

  device = await launchAgentControlDevice(harness, "A");
  await authenticateFirstAgentControlDevice(harness, device, {
    displayName: "Content Delivery E2E User",
    phone: "+8613900000081",
  });
  await claimDefaultProfile(device);
  const identity = await device.page.evaluate(() =>
    window.agenteraAuth.getState(),
  );
  if (identity.status !== "authenticated" || !identity.userId) {
    throw new Error("Content delivery Desktop user did not authenticate.");
  }

  const synced = await successful<ApiEnvelope<DeliveryLink>>(
    publisher.page,
    `/api/content-delivery/sync-agent/${fixture.agentId}`,
    "POST",
  );
  expect(synced.data).toMatchObject({
    cloudDefinitionId: expect.any(String),
    cloudDraftId: expect.any(String),
    contentDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
    syncStatus: "draft_synced",
  });

  const validated = await successful<ApiEnvelope<DeliveryLink>>(
    publisher.page,
    `/api/content-delivery/validate/${fixture.agentId}`,
    "POST",
  );
  expect(validated.data.syncStatus).toBe("draft_synced");

  const submitted = await successful<ApiEnvelope<DeliveryLink>>(
    publisher.page,
    `/api/content-delivery/submit/${fixture.agentId}`,
    "POST",
    { reason_code: "content_delivery_e2e" },
  );
  const submissionID = submitted.data.cloudSubmissionId;
  if (!submissionID) throw new Error("Cloud submission ID is missing.");
  expect(submitted.data.syncStatus).toBe("submitted");

  const submission = await successful<ApiEnvelope<OfficialSubmission>>(
    reviewer.page,
    `/api/cloud/v1/getOfficialSubmission?submission_id=${submissionID}`,
  );
  expect(submission.data).toMatchObject({
    status: "pending",
    submission_id: submissionID,
  });
  await successful<ApiEnvelope<unknown>>(
    reviewer.page,
    `/api/cloud/v1/reviewOfficialSubmission?submission_id=${submissionID}`,
    "POST",
    {
      expected_revision: submission.data.revision,
      payload: {
        decision: "approve",
        initial_channels: ["internal"],
      },
      reason_code: "content_delivery_e2e",
    },
  );

  const approved = await successful<ApiEnvelope<DeliveryLink>>(
    operator.page,
    `/api/content-delivery/agent/${fixture.agentId}`,
  );
  expect(approved.data).toMatchObject({
    cloudDefinitionId: synced.data.cloudDefinitionId,
    cloudVersionId: expect.any(String),
    syncStatus: "approved",
  });
  const versionID = approved.data.cloudVersionId;
  if (!versionID) throw new Error("Approved Cloud version ID is missing.");

  const releases = await successful<ApiEnvelope<CloudPage<OfficialRelease>>>(
    operator.page,
    "/api/cloud/v1/listOfficialReleases?limit=50",
  );
  const release = releases.data.items.find(
    (candidate) =>
      candidate.channel === "internal" &&
      candidate.definition_id === synced.data.cloudDefinitionId,
  );
  if (!release) throw new Error("Cloud internal release is missing.");
  expect(release.state).toBe("paused");

  await successful<ApiEnvelope<unknown>>(
    operator.page,
    `/api/cloud/v1/activateOfficialRelease?release_id=${release.release_id}`,
    "POST",
    {
      expected_revision: release.head_revision,
      payload: {
        allowlisted_user_ids: [identity.userId],
        minimum_desktop_version: "0.7.0",
        rollout_basis_points: 0,
        version_id: versionID,
      },
      reason_code: "content_delivery_e2e",
    },
  );

  const released = await successful<ApiEnvelope<DeliveryLink>>(
    operator.page,
    `/api/content-delivery/agent/${fixture.agentId}`,
  );
  expect(released.data).toMatchObject({
    cloudReleaseId: release.release_id,
    cloudVersionId: versionID,
    contentDigest: synced.data.contentDigest,
    syncStatus: "released",
  });

  const catalog = unwrap(
    await invokeAgentera<OfficialAgentSummary[]>(device, "listOfficialAgents"),
  );
  expect(catalog).toEqual([
    expect.objectContaining({
      definitionId: synced.data.cloudDefinitionId,
      installationState: "not_installed",
      releaseId: release.release_id,
      versionId: versionID,
    }),
  ]);

  const preview = unwrap(
    await invokeAgentera<OfficialAgentInstallPreview>(
      device,
      "prepareOfficialInstall",
      synced.data.cloudDefinitionId!,
    ),
  );
  const installation = unwrap(
    await invokeAgentera<AgenteraAgentInstallationSummary>(
      device,
      "confirmOfficialInstall",
      {
        confirmation: "install-official-agent",
        installHandle: preview.installHandle,
      },
    ),
  );
  expect(installation).toMatchObject({
    officialReleaseId: release.release_id,
    selectedVersionId: versionID,
    sourceScope: "PLATFORM",
    status: "active",
    updatePolicy: "managed",
  });

  await expect
    .poll(
      async () => {
        const current = await successful<ApiEnvelope<DeliveryLink>>(
          operator.page,
          `/api/content-delivery/agent/${fixture.agentId}`,
        );
        return current.data;
      },
      { timeout: 60_000 },
    )
    .toMatchObject({ syncStatus: "desktop_verified" });

  const verified = await successful<ApiEnvelope<DeliveryLink>>(
    operator.page,
    `/api/content-delivery/agent/${fixture.agentId}`,
  );
  expect(verified.data.desktopVerification?.stages).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        contentDigest: synced.data.contentDigest,
        verificationStatus: "activated",
        versionId: versionID,
      }),
    ]),
  );

  const receipts = agentControlRequests(harness).filter(
    (request) =>
      request.path === "/api/v1/official-agent-delivery-verifications",
  );
  expect(receipts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        body: expect.objectContaining({
          content_digest: synced.data.contentDigest,
          verification_status: "activated",
        }),
        method: "POST",
      }),
    ]),
  );
  for (const receipt of receipts) {
    const body = receipt.body as Record<string, unknown>;
    expect(
      Object.keys(body).every((key) => allowedReceiptFields.has(key)),
    ).toBe(true);
  }
});

test.afterEach(async () => {
  await closeAgentControlHarness(harness);
  harness = null;
  device = null;
});
