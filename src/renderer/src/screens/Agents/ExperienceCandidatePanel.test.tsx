import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgenteraAgentControlResult,
  ExperienceCandidateDetail,
  ExperienceCandidateSummary,
} from "../../../../shared/agentera-agent-control";
import ExperienceCandidatePanel from "./ExperienceCandidatePanel";

vi.mock("../../components/useI18n", () => ({
  useI18n: () => ({ t: (key: string): string => key }),
}));

const CANDIDATE_ID = "11111111-1111-4111-8111-111111111111";
const REVIEW_ID = "22222222-2222-4222-8222-222222222222";
const DEFINITION_ID = "33333333-3333-4333-8333-333333333333";
const VERSION_ID = "44444444-4444-4444-8444-444444444444";

function success<T>(data: T): AgenteraAgentControlResult<T> {
  return { ok: true, data };
}

function candidate(
  id: string,
  skillName: string,
  overrides: Partial<ExperienceCandidateSummary> = {},
): ExperienceCandidateSummary {
  return {
    localCandidateId: id === CANDIDATE_ID ? id : null,
    cloudCandidateId: id,
    agentDefinitionId: DEFINITION_ID,
    sourceAgentVersionId: VERSION_ID,
    skillName,
    contentDigest: `sha256:${"a".repeat(64)}`,
    localStatus: id === CANDIDATE_ID ? "SUBMITTED" : null,
    reviewStatus: "PENDING_REVIEW",
    lastErrorCode: null,
    createdAt: "2026-07-20T00:00:00.000Z",
    reviewedAt: null,
    ...overrides,
  };
}

function detail(
  summary: ExperienceCandidateSummary,
): ExperienceCandidateDetail {
  return {
    ...summary,
    bundle: {
      schemaVersion: 1,
      skillName: summary.skillName,
      assets: [
        {
          path: `skills/${summary.skillName}/SKILL.md`,
          mediaType: "text/markdown",
          content: "Reviewed reusable instructions",
        },
      ],
    },
    decisionReasonCode: null,
    safeNote: null,
  };
}

type MockCandidateAPI = Window["agenteraAgents"] & {
  listMyExperienceCandidates: ReturnType<typeof vi.fn>;
  listExperienceReviewQueue: ReturnType<typeof vi.fn>;
  getExperienceCandidate: ReturnType<typeof vi.fn>;
};

function installAPI(
  overrides: Partial<Window["agenteraAgents"]> = {},
): MockCandidateAPI {
  const own = candidate(CANDIDATE_ID, "my-private-selection");
  const queued = candidate(REVIEW_ID, "team-review-skill");
  const api = {
    listMyExperienceCandidates: vi.fn(async () => success([own])),
    listExperienceReviewQueue: vi.fn(async () => success([queued])),
    getExperienceCandidate: vi.fn(async () => success(detail(queued))),
    reviewExperienceCandidate: vi.fn(),
    prepareExperienceCandidateImport: vi.fn(),
    confirmExperienceCandidateImport: vi.fn(),
    ...overrides,
  } as unknown as MockCandidateAPI;
  Object.defineProperty(window, "agenteraAgents", {
    configurable: true,
    value: api,
  });
  return api;
}

describe("ExperienceCandidatePanel", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("shows only returned own candidates to a Member and never invokes review APIs", async () => {
    const api = installAPI();
    render(
      <ExperienceCandidatePanel
        online
        canReview={false}
        contextKey="workspace-member"
        refreshToken={0}
        onDraftReady={vi.fn()}
      />,
    );

    expect(
      await screen.findByText("agents.control.experience.myCandidates"),
    ).toBeTruthy();
    expect(screen.getByText("my-private-selection")).toBeTruthy();
    expect(screen.queryByText("team-review-skill")).toBeNull();
    expect(
      screen.queryByText("agents.control.experience.reviewQueue"),
    ).toBeNull();
    expect(api.listMyExperienceCandidates).toHaveBeenCalledTimes(1);
    expect(api.listExperienceReviewQueue).not.toHaveBeenCalled();
    expect(api.getExperienceCandidate).not.toHaveBeenCalled();
  });

  it("shows the review queue only to Owner/Admin and opens the selected detail", async () => {
    const api = installAPI();
    render(
      <ExperienceCandidatePanel
        online
        canReview
        contextKey="workspace-owner"
        refreshToken={0}
        onDraftReady={vi.fn()}
      />,
    );

    expect(
      await screen.findByText("agents.control.experience.reviewQueue"),
    ).toBeTruthy();
    expect(screen.getByText("team-review-skill")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", {
        name: "agents.control.experience.review",
      }),
    );

    await waitFor(() =>
      expect(api.getExperienceCandidate).toHaveBeenCalledWith(REVIEW_ID),
    );
    expect(
      screen.getByRole("dialog", {
        name: "agents.control.experience.reviewTitle",
      }),
    ).toBeTruthy();
  });

  it("exposes an explicit create-draft retry for an approved local import failure", async () => {
    const approved = candidate(CANDIDATE_ID, "approved-skill", {
      reviewStatus: "APPROVED",
      lastErrorCode: "candidate_import_failed",
      reviewedAt: "2026-07-20T01:00:00.000Z",
    });
    const api = installAPI({
      listMyExperienceCandidates: vi.fn(async () => success([approved])),
      listExperienceReviewQueue: vi.fn(async () => success([])),
      getExperienceCandidate: vi.fn(async () => success(detail(approved))),
      prepareExperienceCandidateImport: vi.fn(async () => ({
        ok: false as const,
        errorCode: "candidate_import_failed" as const,
      })),
    });
    render(
      <ExperienceCandidatePanel
        online
        canReview
        contextKey="workspace-owner"
        refreshToken={0}
        onDraftReady={vi.fn()}
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", {
        name: "agents.control.experience.createDraftRetry",
      }),
    );
    await waitFor(() =>
      expect(api.getExperienceCandidate).toHaveBeenCalledWith(CANDIDATE_ID),
    );
    expect(api.prepareExperienceCandidateImport).toHaveBeenCalledWith(
      CANDIDATE_ID,
    );
  });

  it("keeps an approved review open while refreshing lists for the import preview", async () => {
    const queued = candidate(REVIEW_ID, "team-review-skill");
    const approved = detail({
      ...queued,
      reviewStatus: "APPROVED",
      reviewedAt: "2026-07-20T01:00:00.000Z",
    });
    installAPI({
      reviewExperienceCandidate: vi.fn(async () => success(approved)),
      prepareExperienceCandidateImport: vi.fn(async () =>
        success({
          importHandle: "55555555-5555-4555-8555-555555555555",
          candidateId: REVIEW_ID,
          sourceVersionId: VERSION_ID,
          latestVersionId: VERSION_ID,
          latestVersionNumber: 4,
          skillName: "team-review-skill",
          replacesExistingSkill: true,
          addedPaths: [],
          replacedPaths: ["skills/team-review-skill/SKILL.md"],
          removedPaths: [],
        }),
      ),
    });
    render(
      <ExperienceCandidatePanel
        online
        canReview
        contextKey="workspace-owner"
        refreshToken={0}
        onDraftReady={vi.fn()}
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", {
        name: "agents.control.experience.review",
      }),
    );
    fireEvent.click(
      await screen.findByRole("radio", {
        name: "agents.control.experience.approve",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "agents.control.experience.commitReview",
      }),
    );

    expect(
      await screen.findByText("agents.control.experience.replacementWarning"),
    ).toBeTruthy();
    expect(
      screen.getByRole("dialog", {
        name: "agents.control.experience.reviewTitle",
      }),
    ).toBeTruthy();
  });
});
