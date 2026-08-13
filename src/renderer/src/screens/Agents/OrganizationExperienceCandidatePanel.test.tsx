import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentDraftDetail,
  AgenteraAgentControlResult,
  AgenteraAgentInstallationSummary,
  OrganizationExperienceCandidateDetail,
  OrganizationExperienceCandidateSummary,
} from "../../../../shared/agentera-agent-control";
import OrganizationExperienceCandidatePanel from "./OrganizationExperienceCandidatePanel";

vi.mock("../../components/useI18n", () => ({
  useI18n: () => ({ t: (key: string): string => key }),
}));

const INSTALLATION_ID = "11111111-1111-4111-8111-111111111111";
const ORGANIZATION_ID = "22222222-2222-4222-8222-222222222222";
const DEFINITION_ID = "33333333-3333-4333-8333-333333333333";
const VERSION_ID = "44444444-4444-4444-8444-444444444444";
const CANDIDATE_ID = "55555555-5555-4555-8555-555555555555";
const CANDIDATE_HANDLE = "66666666-6666-4666-8666-666666666666";
const REVIEW_HANDLE = "77777777-7777-4777-8777-777777777777";
const IMPORT_HANDLE = "88888888-8888-4888-8888-888888888888";

function success<T>(data: T): AgenteraAgentControlResult<T> {
  return { ok: true, data };
}

const installation: AgenteraAgentInstallationSummary = {
  id: INSTALLATION_ID,
  sourceScope: "ORGANIZATION",
  officialReleaseId: null,
  selectedReleaseRevisionId: null,
  updatePolicy: "manual",
  definitionId: DEFINITION_ID,
  selectedVersionId: VERSION_ID,
  runtimeProfileId: "99999999-9999-4999-8999-999999999999",
  policySnapshotId: null,
  status: "active",
  retryCode: null,
  createdAt: "2026-08-05T00:00:00.000Z",
  updatedAt: "2026-08-05T00:00:00.000Z",
};

function candidate(
  overrides: Partial<OrganizationExperienceCandidateSummary> = {},
): OrganizationExperienceCandidateSummary {
  return {
    candidateHandle: null,
    reviewHandle: REVIEW_HANDLE,
    cloudCandidateId: CANDIDATE_ID,
    organizationId: ORGANIZATION_ID,
    agentDefinitionId: DEFINITION_ID,
    sourceAgentVersionId: VERSION_ID,
    skillName: "weekly-summary",
    contentDigest: "a".repeat(64),
    localStatus: null,
    reviewStatus: "PENDING_REVIEW",
    lastErrorCode: null,
    createdAt: "2026-08-05T00:00:00.000Z",
    reviewedAt: null,
    ...overrides,
  };
}

function detail(
  overrides: Partial<OrganizationExperienceCandidateDetail> = {},
): OrganizationExperienceCandidateDetail {
  return {
    ...candidate(),
    bundle: {
      schemaVersion: 1,
      skillName: "weekly-summary",
      assets: [
        {
          path: "skills/weekly-summary/SKILL.md",
          mediaType: "text/markdown",
          content: "# Weekly summary\n",
        },
      ],
    },
    decisionReasonCode: null,
    safeNote: null,
    ...overrides,
  };
}

type MockOrganizationExperienceAPI = Record<string, ReturnType<typeof vi.fn>>;

function installAPI(
  overrides: Partial<MockOrganizationExperienceAPI> = {},
): MockOrganizationExperienceAPI {
  const api: MockOrganizationExperienceAPI = {
    listEligibleOrganizationExperienceSkills: vi.fn(async () =>
      success([{ skillName: "weekly-summary", description: "Weekly summary" }]),
    ),
    prepareOrganizationExperienceCandidate: vi.fn(async () =>
      success({
        candidateHandle: CANDIDATE_HANDLE,
        installationId: INSTALLATION_ID,
        sourceAgentVersionId: VERSION_ID,
        skillName: "weekly-summary",
        assets: [
          {
            path: "skills/weekly-summary/SKILL.md",
            mediaType: "text/markdown",
            sizeBytes: 17,
          },
        ],
        fileCount: 1,
        totalBytes: 17,
        contentDigest: "a".repeat(64),
        findings: [],
      }),
    ),
    submitOrganizationExperienceCandidate: vi.fn(async () =>
      success(candidate({ candidateHandle: CANDIDATE_HANDLE })),
    ),
    listMyOrganizationExperienceCandidates: vi.fn(async () => success([])),
    listOrganizationExperienceReviewQueue: vi.fn(async () => success([])),
    getOrganizationExperienceCandidate: vi.fn(async () => success(detail())),
    reviewOrganizationExperienceCandidate: vi.fn(async () =>
      success(
        detail({
          reviewHandle: null,
          reviewStatus: "APPROVED",
          reviewedAt: "2026-08-05T01:00:00.000Z",
        }),
      ),
    ),
    prepareOrganizationExperienceImport: vi.fn(async () =>
      success({
        importHandle: IMPORT_HANDLE,
        candidateId: CANDIDATE_ID,
        sourceVersionId: VERSION_ID,
        latestVersionId: VERSION_ID,
        latestVersionNumber: 2,
        skillName: "weekly-summary",
        replacesExistingSkill: true,
        addedPaths: [],
        replacedPaths: ["skills/weekly-summary/SKILL.md"],
        removedPaths: [],
      }),
    ),
    confirmOrganizationExperienceImport: vi.fn(async () =>
      success({
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      } as AgentDraftDetail),
    ),
    ...overrides,
  };
  Object.defineProperty(window, "agenteraAgents", {
    configurable: true,
    value: api,
  });
  return api;
}

describe("OrganizationExperienceCandidatePanel", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("prepares and submits exactly one selected Skill after one Member action", async () => {
    const api = installAPI();
    render(
      <OrganizationExperienceCandidatePanel
        online
        role="member"
        contextKey="organization-member"
        refreshToken={0}
        contributionTarget={{ installation, agentName: "Research Agent" }}
        onCloseContribution={vi.fn()}
        onDraftReady={vi.fn()}
      />,
    );

    expect(
      await screen.findByRole("option", { name: "weekly-summary" }),
    ).toBeTruthy();
    expect(api.submitOrganizationExperienceCandidate).not.toHaveBeenCalled();
    expect(api.reviewOrganizationExperienceCandidate).not.toHaveBeenCalled();
    expect(api.confirmOrganizationExperienceImport).not.toHaveBeenCalled();

    fireEvent.change(
      screen.getByLabelText("agents.control.organizationExperience.skill"),
      { target: { value: "weekly-summary" } },
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "agents.control.organizationExperience.share",
      }),
    );
    await waitFor(() =>
      expect(api.prepareOrganizationExperienceCandidate).toHaveBeenCalledWith({
        installationId: INSTALLATION_ID,
        skillName: "weekly-summary",
      }),
    );
    await waitFor(() =>
      expect(api.submitOrganizationExperienceCandidate).toHaveBeenCalledWith({
        candidateHandle: CANDIDATE_HANDLE,
        confirmation: "submit-selected-organization-skill",
      }),
    );
  });

  it("lets an Owner review an exact handle and explicitly import the approved candidate", async () => {
    const pending = candidate();
    const api = installAPI({
      listMyOrganizationExperienceCandidates: vi.fn(async () => success([])),
      listOrganizationExperienceReviewQueue: vi.fn(async () =>
        success([pending]),
      ),
    });
    const onDraftReady = vi.fn();
    render(
      <OrganizationExperienceCandidatePanel
        online
        role="owner"
        contextKey="organization-owner"
        refreshToken={0}
        contributionTarget={null}
        onCloseContribution={vi.fn()}
        onDraftReady={onDraftReady}
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", {
        name: "agents.control.organizationExperience.review",
      }),
    );
    await waitFor(() =>
      expect(api.getOrganizationExperienceCandidate).toHaveBeenCalledWith(
        CANDIDATE_ID,
      ),
    );
    fireEvent.click(
      screen.getByRole("radio", {
        name: "agents.control.organizationExperience.approve",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "agents.control.organizationExperience.commitReview",
      }),
    );
    await waitFor(() =>
      expect(api.reviewOrganizationExperienceCandidate).toHaveBeenCalledWith({
        reviewHandle: REVIEW_HANDLE,
        confirmation: "approve-organization-experience",
        reasonCode: null,
        safeNote: null,
      }),
    );
    expect(
      await screen.findByText(
        "agents.control.organizationExperience.replacementWarning",
      ),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByLabelText(
        "agents.control.organizationExperience.importConfirmation",
      ),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "agents.control.organizationExperience.createDraft",
      }),
    );
    await waitFor(() =>
      expect(api.confirmOrganizationExperienceImport).toHaveBeenCalledWith({
        importHandle: IMPORT_HANDLE,
        confirmation: "apply-approved-skill-to-organization-draft",
      }),
    );
    expect(onDraftReady).toHaveBeenCalledTimes(1);
  });

  it("shows an Auditor a read-only queue without exposing mutation controls", async () => {
    const api = installAPI({
      listOrganizationExperienceReviewQueue: vi.fn(async () =>
        success([candidate()]),
      ),
    });
    render(
      <OrganizationExperienceCandidatePanel
        online
        role="auditor"
        contextKey="organization-auditor"
        refreshToken={0}
        contributionTarget={null}
        onCloseContribution={vi.fn()}
        onDraftReady={vi.fn()}
      />,
    );

    expect(await screen.findByText("weekly-summary")).toBeTruthy();
    expect(api.listMyOrganizationExperienceCandidates).not.toHaveBeenCalled();
    expect(api.reviewOrganizationExperienceCandidate).not.toHaveBeenCalled();
    expect(api.prepareOrganizationExperienceImport).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", {
        name: "agents.control.organizationExperience.review",
      }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", {
        name: "agents.control.organizationExperience.view",
      }),
    );
    await waitFor(() =>
      expect(api.getOrganizationExperienceCandidate).toHaveBeenCalledWith(
        CANDIDATE_ID,
      ),
    );
    expect(
      screen.queryByRole("radio", {
        name: "agents.control.organizationExperience.approve",
      }),
    ).toBeNull();
  });

  it("keeps an offline failed upload local and retries only after an explicit online click", async () => {
    const uploadFailed = candidate({
      candidateHandle: CANDIDATE_HANDLE,
      reviewHandle: null,
      cloudCandidateId: null,
      localStatus: "UPLOAD_FAILED",
      reviewStatus: null,
      lastErrorCode: "cloud_unavailable",
    });
    const api = installAPI({
      listMyOrganizationExperienceCandidates: vi.fn(async () =>
        success([uploadFailed]),
      ),
    });
    const rendered = render(
      <OrganizationExperienceCandidatePanel
        online={false}
        role="member"
        contextKey="organization-member"
        refreshToken={0}
        contributionTarget={null}
        onCloseContribution={vi.fn()}
        onDraftReady={vi.fn()}
      />,
    );

    const retry = await screen.findByRole("button", {
      name: "agents.control.organizationExperience.retryUpload",
    });
    expect(retry).toBeDisabled();
    expect(api.submitOrganizationExperienceCandidate).not.toHaveBeenCalled();
    rendered.rerender(
      <OrganizationExperienceCandidatePanel
        online
        role="member"
        contextKey="organization-member"
        refreshToken={0}
        contributionTarget={null}
        onCloseContribution={vi.fn()}
        onDraftReady={vi.fn()}
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", {
        name: "agents.control.organizationExperience.retryUpload",
      }),
    );
    await waitFor(() =>
      expect(api.submitOrganizationExperienceCandidate).toHaveBeenCalledWith({
        candidateHandle: CANDIDATE_HANDLE,
        confirmation: "submit-selected-organization-skill",
      }),
    );
  });

  // @lat: [[agentera-self-evolution#AgentEra self-evolution compatibility#Candidate promotion loop#Organization experience contribution]]
  it("shares one selected Skill with one click and keeps technical details hidden", async () => {
    const api = installAPI();
    const onCloseContribution = vi.fn();
    render(
      <OrganizationExperienceCandidatePanel
        online
        role="member"
        contextKey="organization-member"
        refreshToken={0}
        contributionTarget={{ installation, agentName: "Research Agent" }}
        onCloseContribution={onCloseContribution}
        onDraftReady={vi.fn()}
      />,
    );

    await screen.findByRole("option", { name: "weekly-summary" });
    fireEvent.change(
      screen.getByLabelText("agents.control.organizationExperience.skill"),
      { target: { value: "weekly-summary" } },
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "agents.control.organizationExperience.share",
      }),
    );

    await waitFor(() =>
      expect(api.prepareOrganizationExperienceCandidate).toHaveBeenCalledWith({
        installationId: INSTALLATION_ID,
        skillName: "weekly-summary",
      }),
    );
    await waitFor(() =>
      expect(api.submitOrganizationExperienceCandidate).toHaveBeenCalledWith({
        candidateHandle: CANDIDATE_HANDLE,
        confirmation: "submit-selected-organization-skill",
      }),
    );
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(document.body.textContent).not.toContain(VERSION_ID);
    expect(document.body.textContent).not.toContain("a".repeat(64));
    expect(document.body.textContent).not.toContain("skills/weekly-summary/");
    expect(onCloseContribution).toHaveBeenCalled();
  });

  it("blocks organization sharing when the local privacy scan finds sensitive data", async () => {
    const api = installAPI({
      prepareOrganizationExperienceCandidate: vi.fn(async () =>
        success({
          candidateHandle: CANDIDATE_HANDLE,
          installationId: INSTALLATION_ID,
          sourceAgentVersionId: VERSION_ID,
          skillName: "weekly-summary",
          assets: [],
          fileCount: 1,
          totalBytes: 12,
          contentDigest: "a".repeat(64),
          findings: [
            {
              code: "credential_api_key",
              path: "skills/weekly-summary/SKILL.md",
              line: 4,
            },
          ],
        }),
      ),
    });
    render(
      <OrganizationExperienceCandidatePanel
        online
        role="member"
        contextKey="organization-member"
        refreshToken={0}
        contributionTarget={{ installation, agentName: "Research Agent" }}
        onCloseContribution={vi.fn()}
        onDraftReady={vi.fn()}
      />,
    );

    await screen.findByRole("option", { name: "weekly-summary" });
    fireEvent.change(
      screen.getByLabelText("agents.control.organizationExperience.skill"),
      { target: { value: "weekly-summary" } },
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "agents.control.organizationExperience.share",
      }),
    );

    expect(
      await screen.findByText(
        "agents.control.organizationExperience.dlpBlockedUser",
      ),
    ).toBeTruthy();
    expect(api.submitOrganizationExperienceCandidate).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain(
      "skills/weekly-summary/SKILL.md:4",
    );
  });
});
