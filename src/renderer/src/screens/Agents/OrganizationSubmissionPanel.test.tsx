import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgenteraAgentControlResult,
  DisconnectOrganizationSubmissionReferenceInput,
  OrganizationAgentSubmissionListItem,
} from "../../../../shared/agentera-agent-control";
import OrganizationSubmissionPanel from "./OrganizationSubmissionPanel";

vi.mock("../../components/useI18n", () => ({
  useI18n: () => ({ t: (key: string): string => key }),
}));

const SUBMISSION_ID = "11111111-1111-4111-8111-111111111111";
const WITHDRAWAL_HANDLE = "22222222-2222-4222-8222-222222222222";

function success<T>(data: T): AgenteraAgentControlResult<T> {
  return { ok: true, data };
}

function submission(): OrganizationAgentSubmissionListItem {
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
    revision: 2,
    submittedAt: "2026-07-21T01:00:00.000Z",
    terminalAt: null,
    review: null,
    referenceState: {
      kind: "verified",
      draftId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      draftRevision: 2,
    },
  };
}

function approvedSubmission(): OrganizationAgentSubmissionListItem {
  return {
    ...submission(),
    publishedVersionId: "99999999-9999-4999-8999-999999999999",
    status: "approved",
    terminalAt: "2026-07-21T02:00:00.000Z",
    review: {
      id: "66666666-6666-4666-8666-666666666666",
      reviewerUserId: "77777777-7777-4777-8777-777777777777",
      decision: "approve",
      reasonCode: null,
      safeNote: null,
      organizationPolicySnapshotId: "88888888-8888-4888-8888-888888888888",
      organizationPolicyVersion: 4,
      reviewedContentDigest: submission().contentDigest,
      reviewedAt: "2026-07-21T02:00:00.000Z",
    },
  };
}

function quarantinedSubmission(): OrganizationAgentSubmissionListItem {
  return {
    ...submission(),
    localDraftId: null,
    localDraftRevision: null,
    referenceState: {
      kind: "quarantined",
      stage: "content_digest",
    },
  };
}

function remoteOnlySubmission(): OrganizationAgentSubmissionListItem {
  return {
    ...quarantinedSubmission(),
    referenceState: { kind: "remote_only" },
  };
}

function installAPI(overrides: Partial<Window["agenteraAgents"]> = {}): {
  listOrganizationSubmissions: ReturnType<typeof vi.fn>;
  prepareOrganizationWithdrawal: ReturnType<typeof vi.fn>;
  confirmOrganizationWithdrawal: ReturnType<typeof vi.fn>;
} {
  const api = {
    listOrganizationSubmissions: vi.fn(async () => success([])),
    getOrganizationSubmission: vi.fn(),
    prepareOrganizationWithdrawal: vi.fn(async () =>
      success({
        withdrawalHandle: WITHDRAWAL_HANDLE,
        submission: submission(),
        revision: 2,
        contentDigest: submission().contentDigest,
        expiresAt: "2026-07-21T02:00:00.000Z",
      }),
    ),
    confirmOrganizationWithdrawal: vi.fn(async () =>
      success({ ...submission(), status: "withdrawn" as const }),
    ),
    ...overrides,
  };
  Object.defineProperty(window, "agenteraAgents", {
    configurable: true,
    value: api,
  });
  return api as unknown as {
    listOrganizationSubmissions: ReturnType<typeof vi.fn>;
    prepareOrganizationWithdrawal: ReturnType<typeof vi.fn>;
    confirmOrganizationWithdrawal: ReturnType<typeof vi.fn>;
  };
}

describe("OrganizationSubmissionPanel", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("shows immutable submission history without any direct Publish action", async () => {
    const api = installAPI();
    render(
      <OrganizationSubmissionPanel
        online
        canAuthor
        canReview
        submissions={[submission()]}
        issues={[]}
        loading={false}
        onRefresh={vi.fn()}
        onDisconnect={vi.fn()}
      />,
    );

    expect(
      await screen.findByText("agents.control.organization.reviewTitle"),
    ).toBeVisible();
    expect(screen.getByText(submission().contentDigest)).toBeVisible();
    expect(
      screen.getByText((content) =>
        content.includes(submission().submittedByUserId),
      ),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: /publish/i })).toBeNull();
    expect(api.listOrganizationSubmissions).not.toHaveBeenCalled();
  });

  it("prepares and confirms withdrawal with a one-use handle", async () => {
    const api = installAPI();
    render(
      <OrganizationSubmissionPanel
        online
        canAuthor
        canReview={false}
        submissions={[submission()]}
        issues={[]}
        loading={false}
        onRefresh={vi.fn()}
        onDisconnect={vi.fn()}
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", {
        name: "agents.control.organization.withdraw",
      }),
    );
    expect(api.prepareOrganizationWithdrawal).toHaveBeenCalledWith(
      SUBMISSION_ID,
    );
    fireEvent.click(
      await screen.findByRole("button", {
        name: "agents.control.organization.confirmWithdrawal",
      }),
    );
    await waitFor(() =>
      expect(api.confirmOrganizationWithdrawal).toHaveBeenCalledWith({
        withdrawalHandle: WITHDRAWAL_HANDLE,
        confirmation: "withdraw-organization-agent",
      }),
    );
  });

  it("shows terminal reviewer and policy metadata", async () => {
    installAPI();
    render(
      <OrganizationSubmissionPanel
        online
        canAuthor
        canReview
        submissions={[approvedSubmission()]}
        issues={[]}
        loading={false}
        onRefresh={vi.fn()}
        onDisconnect={vi.fn()}
      />,
    );

    expect(
      await screen.findByText((content) =>
        content.includes(approvedSubmission().review!.reviewerUserId),
      ),
    ).toBeVisible();
    expect(
      screen.getByText((content) =>
        content.includes("agents.control.organization.policyVersion 4"),
      ),
    ).toBeVisible();
  });

  it("renders cached history without mutation controls while offline", async () => {
    const api = installAPI();
    render(
      <OrganizationSubmissionPanel
        online={false}
        canAuthor={false}
        canReview={false}
        submissions={[submission()]}
        issues={[]}
        loading={false}
        onRefresh={vi.fn()}
        onDisconnect={vi.fn()}
      />,
    );

    expect(
      screen.getByText("agents.control.organization.cachedReadOnly"),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", {
        name: "agents.control.organization.withdraw",
      }),
    ).toBeNull();
    expect(api.listOrganizationSubmissions).not.toHaveBeenCalled();
  });

  it("confirms disconnect with the exact literal and accepts the parent remote-only update", async () => {
    installAPI();
    const onDisconnect = vi.fn(
      async (_input: DisconnectOrganizationSubmissionReferenceInput) =>
        success(remoteOnlySubmission()),
    );
    const props = {
      online: true,
      canAuthor: true,
      canReview: true,
      issues: [],
      loading: false,
      onRefresh: vi.fn(),
      onDisconnect,
    };
    const { rerender } = render(
      <OrganizationSubmissionPanel
        {...props}
        submissions={[quarantinedSubmission()]}
      />,
    );

    expect(
      screen.getByTestId(`submission-reference-conflict:${SUBMISSION_ID}`),
    ).toBeVisible();
    expect(
      screen
        .getByText(quarantinedSubmission().contentDigest)
        .closest("article"),
    ).toHaveAttribute("data-submission-id", SUBMISSION_ID);
    fireEvent.click(
      screen.getByRole("button", {
        name: "agents.control.organization.disconnectReference",
      }),
    );
    expect(
      screen.getByRole("dialog", {
        name: "agents.control.organization.disconnectReferenceTitle",
      }),
    ).toHaveTextContent(
      "agents.control.organization.disconnectReferenceBoundary",
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "agents.control.organization.confirmDisconnectReference",
      }),
    );
    await waitFor(() =>
      expect(onDisconnect).toHaveBeenCalledWith({
        submissionId: SUBMISSION_ID,
        confirmation: "disconnect-local-draft-link",
      }),
    );

    rerender(
      <OrganizationSubmissionPanel
        {...props}
        submissions={[remoteOnlySubmission()]}
      />,
    );
    expect(
      screen.queryByTestId(`submission-reference-conflict:${SUBMISSION_ID}`),
    ).toBeNull();
    expect(
      screen.queryByRole("button", {
        name: "agents.control.organization.disconnectReference",
      }),
    ).toBeNull();
  });

  it("shows one bounded warning when Cloud omits an invalid submission record", () => {
    const api = installAPI();
    render(
      <OrganizationSubmissionPanel
        online
        canAuthor
        canReview
        submissions={[]}
        issues={[{ submissionId: null, code: "cloud_record_invalid" }]}
        loading={false}
        onRefresh={vi.fn()}
        onDisconnect={vi.fn()}
      />,
    );

    expect(
      screen.getByText(
        "agents.control.organization.submissionRecordUnavailable",
      ),
    ).toBeVisible();
    expect(api.listOrganizationSubmissions).not.toHaveBeenCalled();
  });

  it("keeps the confirmation open and reports a failed detach", async () => {
    installAPI();
    const onDisconnect = vi.fn(async () => ({
      ok: false as const,
      errorCode: "organization_submission_reference_detach_failed" as const,
    }));
    render(
      <OrganizationSubmissionPanel
        online
        canAuthor
        canReview
        submissions={[quarantinedSubmission()]}
        issues={[]}
        loading={false}
        onRefresh={vi.fn()}
        onDisconnect={onDisconnect}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "agents.control.organization.disconnectReference",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "agents.control.organization.confirmDisconnectReference",
      }),
    );

    expect(
      await screen.findByText(
        "agents.control.errors.organization_submission_reference_detach_failed",
      ),
    ).toBeVisible();
    expect(
      screen.getByRole("dialog", {
        name: "agents.control.organization.disconnectReferenceTitle",
      }),
    ).toBeVisible();
  });
});
