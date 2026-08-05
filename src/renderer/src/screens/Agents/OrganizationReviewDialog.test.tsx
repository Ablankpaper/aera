import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgenteraAgentControlResult,
  OrganizationAgentSubmissionDetail,
  OrganizationAgentSubmissionSummary,
  OrganizationReviewPreview,
} from "../../../../shared/agentera-agent-control";
import OrganizationReviewDialog from "./OrganizationReviewDialog";

vi.mock("../../components/useI18n", () => ({
  useI18n: () => ({ t: (key: string): string => key }),
}));

const SUBMISSION_ID = "11111111-1111-4111-8111-111111111111";
const REVIEW_HANDLE = "22222222-2222-4222-8222-222222222222";

function success<T>(data: T): AgenteraAgentControlResult<T> {
  return { ok: true, data };
}

function summary(): OrganizationAgentSubmissionSummary {
  return {
    id: SUBMISSION_ID,
    organizationId: "33333333-3333-4333-8333-333333333333",
    kind: "initial",
    definitionId: "44444444-4444-4444-8444-444444444444",
    baseVersionId: null,
    publishedVersionId: null,
    localDraftId: null,
    localDraftRevision: null,
    submittedByUserId: "55555555-5555-4555-8555-555555555555",
    contentDigest: `sha256:${"a".repeat(64)}`,
    status: "pending",
    revision: 1,
    submittedAt: "2026-07-21T01:00:00.000Z",
    terminalAt: null,
    review: null,
  };
}

function detail(): OrganizationAgentSubmissionDetail {
  return {
    summary: summary(),
    displayName: "Enterprise Research Agent",
    icon: null,
    systemPrompt: "Research carefully",
    assets: [
      {
        path: "knowledge/research.md",
        kind: "knowledge",
        mediaType: "text/markdown",
        sha256: "b".repeat(64),
        content: "# Research",
        sizeBytes: 10,
      },
    ],
    modelConstraints: {
      allowedProviders: ["openai"],
      allowedModels: ["gpt-5.6"],
    },
    tools: { allowed: [], denied: [] },
    dependencies: [],
    runtimeCompatibility: {
      minimumVersion: "v0.18.2-agentera.1",
      maximumVersionExclusive: null,
    },
    manifestDigest: `sha256:${"c".repeat(64)}`,
    bundleDigest: `sha256:${"d".repeat(64)}`,
    assetCounts: { skill: 0, sop: 0, knowledge: 1 },
    totalBytes: 10,
  };
}

function preview(selfReview = false): OrganizationReviewPreview {
  return {
    reviewHandle: REVIEW_HANDLE,
    selfReview,
    decision: "approve",
    reasonCode: null,
    safeNote: null,
    detail: detail(),
    expiresAt: "2026-07-21T02:00:00.000Z",
  };
}

function installAPI(overrides: Partial<Window["agenteraAgents"]> = {}): void {
  Object.defineProperty(window, "agenteraAgents", {
    configurable: true,
    value: {
      prepareOrganizationReview: vi.fn(),
      confirmOrganizationReview: vi.fn(),
      ...overrides,
    },
  });
}

describe("OrganizationReviewDialog", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("allows an authorized submission author to confirm the single approval", async () => {
    const approved = { ...summary(), status: "approved" as const };
    const confirmOrganizationReview = vi.fn(async () => success(approved));
    installAPI({ confirmOrganizationReview });
    render(
      <OrganizationReviewDialog
        open
        detail={detail()}
        initialPreview={preview(true)}
        onClose={() => undefined}
        onCompleted={() => undefined}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "agents.control.organization.confirmApproval",
      }),
    );
    await waitFor(() =>
      expect(confirmOrganizationReview).toHaveBeenCalledWith({
        reviewHandle: REVIEW_HANDLE,
        confirmation: "approve-organization-agent",
      }),
    );
  });

  it("prepares and confirms approval using only the one-use review handle", async () => {
    const approved = { ...summary(), status: "approved" as const };
    const prepareOrganizationReview = vi.fn(async () => success(preview()));
    const confirmOrganizationReview = vi.fn(async () => success(approved));
    installAPI({ prepareOrganizationReview, confirmOrganizationReview });
    const onCompleted = vi.fn();
    render(
      <OrganizationReviewDialog
        open
        detail={detail()}
        onClose={() => undefined}
        onCompleted={onCompleted}
      />,
    );

    expect(screen.getByText("Enterprise Research Agent")).toBeInTheDocument();
    expect(screen.getByText("knowledge/research.md")).toBeInTheDocument();
    expect(screen.getByText(summary().contentDigest)).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", {
        name: "agents.control.organization.approve",
      }),
    );

    await waitFor(() =>
      expect(prepareOrganizationReview).toHaveBeenCalledWith({
        submissionId: SUBMISSION_ID,
        decision: "approve",
        reasonCode: null,
        safeNote: null,
      }),
    );
    fireEvent.click(
      await screen.findByRole("button", {
        name: "agents.control.organization.confirmApproval",
      }),
    );
    await waitFor(() =>
      expect(confirmOrganizationReview).toHaveBeenCalledWith({
        reviewHandle: REVIEW_HANDLE,
        confirmation: "approve-organization-agent",
      }),
    );
    expect(onCompleted).toHaveBeenCalledWith(approved);
    expect(document.body.textContent).toContain(
      "agents.control.organization.approvedNotInstalled",
    );
  });
});
