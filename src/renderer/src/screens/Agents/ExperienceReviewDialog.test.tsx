import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentDraftDetail,
  AgenteraAgentControlResult,
  ExperienceCandidateDetail,
  ExperienceCandidateImportPreview,
} from "../../../../shared/agentera-agent-control";
import ExperienceReviewDialog from "./ExperienceReviewDialog";

vi.mock("../../components/useI18n", () => ({
  useI18n: () => ({ t: (key: string): string => key }),
}));

const CANDIDATE_ID = "11111111-1111-4111-8111-111111111111";
const DEFINITION_ID = "22222222-2222-4222-8222-222222222222";
const SOURCE_VERSION_ID = "33333333-3333-4333-8333-333333333333";
const LATEST_VERSION_ID = "44444444-4444-4444-8444-444444444444";
const DRAFT_ID = "55555555-5555-4555-8555-555555555555";

function success<T>(data: T): AgenteraAgentControlResult<T> {
  return { ok: true, data };
}

function candidate(
  status: ExperienceCandidateDetail["reviewStatus"] = "PENDING_REVIEW",
): ExperienceCandidateDetail {
  return {
    localCandidateId: null,
    cloudCandidateId: CANDIDATE_ID,
    agentDefinitionId: DEFINITION_ID,
    sourceAgentVersionId: SOURCE_VERSION_ID,
    skillName: "research-notes",
    contentDigest: `sha256:${"a".repeat(64)}`,
    localStatus: null,
    reviewStatus: status,
    lastErrorCode: null,
    createdAt: "2026-07-20T00:00:00.000Z",
    reviewedAt: status === "PENDING_REVIEW" ? null : "2026-07-20T01:00:00.000Z",
    bundle: {
      schemaVersion: 1,
      skillName: "research-notes",
      assets: [
        {
          path: "skills/research-notes/SKILL.md",
          mediaType: "text/markdown",
          content: "Reusable research procedure",
        },
      ],
    },
    decisionReasonCode: null,
    safeNote: null,
  };
}

function importPreview(
  overrides: Partial<ExperienceCandidateImportPreview> = {},
): ExperienceCandidateImportPreview {
  return {
    importHandle: "66666666-6666-4666-8666-666666666666",
    candidateId: CANDIDATE_ID,
    sourceVersionId: SOURCE_VERSION_ID,
    latestVersionId: LATEST_VERSION_ID,
    latestVersionNumber: 8,
    skillName: "research-notes",
    replacesExistingSkill: true,
    addedPaths: ["skills/research-notes/references/new.md"],
    replacedPaths: ["skills/research-notes/SKILL.md"],
    removedPaths: ["skills/research-notes/old.md"],
    ...overrides,
  };
}

function draft(): AgentDraftDetail {
  return {
    id: DRAFT_ID,
    sourceAgentDefinitionId: DEFINITION_ID,
    baseAgentVersionId: LATEST_VERSION_ID,
    displayName: "Workspace Research Agent",
    icon: null,
    manifest: {
      schemaVersion: 1,
      identity: { systemPrompt: "Research carefully" },
      assets: [],
      modelConstraints: { allowedProviders: [], allowedModels: [] },
      tools: { allowed: [], denied: [] },
      dependencies: [],
      runtimeCompatibility: {
        minimumVersion: "v0.18.2-agentera.1",
        maximumVersionExclusive: null,
      },
    },
    assets: [],
    editableAssets: [],
    revision: 1,
    createdAt: "2026-07-20T02:00:00.000Z",
    updatedAt: "2026-07-20T02:00:00.000Z",
    lastPublicationAttempt: null,
    publishedRevision: null,
  };
}

type MockReviewAPI = Window["agenteraAgents"] & {
  getExperienceCandidate: ReturnType<typeof vi.fn>;
  reviewExperienceCandidate: ReturnType<typeof vi.fn>;
  prepareExperienceCandidateImport: ReturnType<typeof vi.fn>;
  confirmExperienceCandidateImport: ReturnType<typeof vi.fn>;
};

function installAPI(
  overrides: Partial<Window["agenteraAgents"]> = {},
): MockReviewAPI {
  const api = {
    getExperienceCandidate: vi.fn(async () => success(candidate())),
    reviewExperienceCandidate: vi.fn(async () =>
      success(candidate("APPROVED")),
    ),
    prepareExperienceCandidateImport: vi.fn(async () =>
      success(importPreview()),
    ),
    confirmExperienceCandidateImport: vi.fn(async () => success(draft())),
    ...overrides,
  } as unknown as MockReviewAPI;
  Object.defineProperty(window, "agenteraAgents", {
    configurable: true,
    value: api,
  });
  return api;
}

function renderDialog(onImported = vi.fn()): void {
  render(
    <ExperienceReviewDialog
      open
      candidateId={CANDIDATE_ID}
      online
      onClose={vi.fn()}
      onChanged={vi.fn()}
      onImported={onImported}
    />,
  );
}

describe("ExperienceReviewDialog", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("requires a rejection reason, bounds the safe note, and sends no replacement content", async () => {
    const api = installAPI({
      reviewExperienceCandidate: vi.fn(async () =>
        success(candidate("REJECTED")),
      ),
    });
    renderDialog();

    fireEvent.click(
      await screen.findByRole("radio", {
        name: "agents.control.experience.reject",
      }),
    );
    const submit = screen.getByRole("button", {
      name: "agents.control.experience.commitReview",
    });
    expect(submit).toBeDisabled();

    fireEvent.change(
      screen.getByRole("combobox", {
        name: "agents.control.experience.rejectionReason",
      }),
      { target: { value: "not_reusable" } },
    );
    fireEvent.change(
      screen.getByRole("textbox", {
        name: "agents.control.experience.safeNote",
      }),
      { target: { value: "n".repeat(700) } },
    );
    expect(
      screen.getByRole<HTMLInputElement>("textbox", {
        name: "agents.control.experience.safeNote",
      }).value,
    ).toHaveLength(500);
    fireEvent.click(submit);

    await waitFor(() =>
      expect(api.reviewExperienceCandidate).toHaveBeenCalledTimes(1),
    );
    expect(api.reviewExperienceCandidate).toHaveBeenCalledWith({
      candidateId: CANDIDATE_ID,
      decision: "REJECTED",
      reasonCode: "not_reusable",
      safeNote: "n".repeat(500),
    });
    expect(
      Object.keys(api.reviewExperienceCandidate.mock.calls[0][0]).sort(),
    ).toEqual(["candidateId", "decision", "reasonCode", "safeNote"]);
    expect(api.prepareExperienceCandidateImport).not.toHaveBeenCalled();
  });

  it("commits approval before preparing the latest-base replacement preview", async () => {
    const api = installAPI();
    renderDialog();

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
    expect(screen.getByText("skills/research-notes/SKILL.md")).toBeTruthy();
    expect(screen.getByText("skills/research-notes/old.md")).toBeTruthy();
    expect(screen.getByText("v8")).toBeTruthy();
    expect(api.reviewExperienceCandidate).toHaveBeenCalledWith({
      candidateId: CANDIDATE_ID,
      decision: "APPROVED",
      reasonCode: null,
      safeNote: null,
    });
    expect(
      api.reviewExperienceCandidate.mock.invocationCallOrder[0],
    ).toBeLessThan(
      api.prepareExperienceCandidateImport.mock.invocationCallOrder[0],
    );
    expect(api.confirmExperienceCandidateImport).not.toHaveBeenCalled();
  });

  it("refreshes a stale-base preview without producing a draft", async () => {
    const refreshed = importPreview({
      importHandle: "77777777-7777-4777-8777-777777777777",
      latestVersionId: "88888888-8888-4888-8888-888888888888",
      latestVersionNumber: 9,
    });
    const api = installAPI({
      getExperienceCandidate: vi.fn(async () => success(candidate("APPROVED"))),
      prepareExperienceCandidateImport: vi
        .fn()
        .mockResolvedValueOnce(success(importPreview()))
        .mockResolvedValueOnce(success(refreshed)),
      confirmExperienceCandidateImport: vi.fn(async () => ({
        ok: false as const,
        errorCode: "candidate_base_advanced" as const,
      })),
    });
    const onImported = vi.fn();
    renderDialog(onImported);

    expect(
      await screen.findByText("agents.control.experience.replacementWarning"),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "agents.control.experience.importConfirmation",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "agents.control.experience.createDraft",
      }),
    );

    expect(
      await screen.findByText("agents.control.experience.baseRefreshed"),
    ).toBeTruthy();
    expect(screen.getByText("v9")).toBeTruthy();
    expect(api.confirmExperienceCandidateImport).toHaveBeenCalledTimes(1);
    expect(api.prepareExperienceCandidateImport).toHaveBeenCalledTimes(2);
    expect(onImported).not.toHaveBeenCalled();
  });

  it("imports an already approved candidate only after explicit confirmation", async () => {
    const api = installAPI({
      getExperienceCandidate: vi.fn(async () => success(candidate("APPROVED"))),
    });
    const onImported = vi.fn();
    renderDialog(onImported);

    const create = await screen.findByRole("button", {
      name: "agents.control.experience.createDraft",
    });
    expect(create).toBeDisabled();
    expect(api.confirmExperienceCandidateImport).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "agents.control.experience.importConfirmation",
      }),
    );
    fireEvent.click(create);

    await waitFor(() => expect(onImported).toHaveBeenCalledWith(draft()));
    expect(api.confirmExperienceCandidateImport).toHaveBeenCalledWith({
      importHandle: importPreview().importHandle,
      confirmation: "apply-approved-skill-to-latest",
    });
  });
});
