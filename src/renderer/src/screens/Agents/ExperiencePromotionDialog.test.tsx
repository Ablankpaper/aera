import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgenteraAgentControlResult,
  AgenteraAgentInstallationSummary,
  ExperienceCandidatePreview,
  ExperienceCandidateSummary,
} from "../../../../shared/agentera-agent-control";
import ExperiencePromotionDialog from "./ExperiencePromotionDialog";

vi.mock("../../components/useI18n", () => ({
  useI18n: () => ({ t: (key: string): string => key }),
}));

const INSTALLATION_ID = "11111111-1111-4111-8111-111111111111";
const DEFINITION_ID = "22222222-2222-4222-8222-222222222222";
const VERSION_ID = "33333333-3333-4333-8333-333333333333";
const CANDIDATE_ID = "44444444-4444-4444-8444-444444444444";

function success<T>(data: T): AgenteraAgentControlResult<T> {
  return { ok: true, data };
}

function installation(): AgenteraAgentInstallationSummary {
  return {
    id: INSTALLATION_ID,
    sourceScope: "WORKSPACE",
    officialReleaseId: null,
    selectedReleaseRevisionId: null,
    updatePolicy: "manual",
    definitionId: DEFINITION_ID,
    selectedVersionId: VERSION_ID,
    runtimeProfileId: "55555555-5555-4555-8555-555555555555",
    policySnapshotId: "66666666-6666-4666-8666-666666666666",
    status: "active",
    retryCode: null,
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z",
  };
}

function preview(
  findings: ExperienceCandidatePreview["findings"] = [],
): ExperienceCandidatePreview {
  return {
    localCandidateId: CANDIDATE_ID,
    installationId: INSTALLATION_ID,
    sourceAgentVersionId: VERSION_ID,
    skillName: "research-notes",
    assets: [
      {
        path: "skills/research-notes/SKILL.md",
        mediaType: "text/markdown",
        sizeBytes: 321,
      },
      {
        path: "skills/research-notes/references/checklist.md",
        mediaType: "text/markdown",
        sizeBytes: 79,
      },
    ],
    fileCount: 2,
    totalBytes: 400,
    contentDigest: `sha256:${"a".repeat(64)}`,
    findings,
  };
}

function submitted(): ExperienceCandidateSummary {
  return {
    localCandidateId: CANDIDATE_ID,
    cloudCandidateId: "77777777-7777-4777-8777-777777777777",
    agentDefinitionId: DEFINITION_ID,
    sourceAgentVersionId: VERSION_ID,
    skillName: "research-notes",
    contentDigest: `sha256:${"a".repeat(64)}`,
    localStatus: "SUBMITTED",
    reviewStatus: "PENDING_REVIEW",
    lastErrorCode: null,
    createdAt: "2026-07-20T00:00:00.000Z",
    reviewedAt: null,
  };
}

type MockCandidateAPI = Window["agenteraAgents"] & {
  listEligibleExperienceSkills: ReturnType<typeof vi.fn>;
  prepareExperienceCandidate: ReturnType<typeof vi.fn>;
  submitExperienceCandidate: ReturnType<typeof vi.fn>;
};

function installAPI(
  overrides: Partial<Window["agenteraAgents"]> = {},
): MockCandidateAPI {
  const api = {
    listEligibleExperienceSkills: vi.fn(async () =>
      success([
        { skillName: "research-notes", description: "Research checklist" },
        { skillName: "release-helper", description: "Release workflow" },
      ]),
    ),
    prepareExperienceCandidate: vi.fn(async () => success(preview())),
    submitExperienceCandidate: vi.fn(async () => success(submitted())),
    ...overrides,
  } as unknown as MockCandidateAPI;
  Object.defineProperty(window, "agenteraAgents", {
    configurable: true,
    value: api,
  });
  return api;
}

function renderDialog(online = true, onSubmitted = vi.fn()): void {
  render(
    <ExperiencePromotionDialog
      open
      installation={installation()}
      agentName="Workspace Research Agent"
      online={online}
      onClose={vi.fn()}
      onSubmitted={onSubmitted}
    />,
  );
}

async function selectEligibleSkill(
  skillName = "research-notes",
): Promise<void> {
  const select = await screen.findByRole("combobox", {
    name: "agents.control.experience.skill",
  });
  await screen.findByRole("option", { name: skillName });
  await waitFor(() => expect(select).toBeEnabled());
  fireEvent.change(select, { target: { value: skillName } });
}

describe("ExperiencePromotionDialog", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("lists only eligible Skill names and prepares the explicitly selected Skill", async () => {
    const api = installAPI();
    renderDialog();

    expect(
      await screen.findByRole("dialog", {
        name: "agents.control.experience.promotionTitle",
      }),
    ).toBeTruthy();
    expect(screen.getByText("research-notes")).toBeTruthy();
    expect(screen.getByText("release-helper")).toBeTruthy();
    expect(document.body.textContent).not.toContain("/.hermes/profiles/");
    expect(document.body.textContent).not.toContain("private skill content");
    expect(api.prepareExperienceCandidate).not.toHaveBeenCalled();

    fireEvent.change(
      screen.getByRole("combobox", {
        name: "agents.control.experience.skill",
      }),
      { target: { value: "research-notes" } },
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "agents.control.experience.preparePreview",
      }),
    );

    await waitFor(() =>
      expect(api.prepareExperienceCandidate).toHaveBeenCalledWith({
        installationId: INSTALLATION_ID,
        skillName: "research-notes",
      }),
    );
    expect(screen.getByText("Workspace Research Agent")).toBeTruthy();
    expect(screen.getByText(VERSION_ID)).toBeTruthy();
    expect(screen.getByText("skills/research-notes/SKILL.md")).toBeTruthy();
    expect(
      screen.getByText("skills/research-notes/references/checklist.md"),
    ).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.getByText("400")).toBeTruthy();
    expect(screen.getByText(`sha256:${"a".repeat(64)}`)).toBeTruthy();
    expect(
      screen.getByText("agents.control.experience.dlpPassed"),
    ).toBeTruthy();
    expect(
      screen.getByText("agents.control.experience.privateBoundary"),
    ).toBeTruthy();
  });

  it("prepares offline but disables upload with explicit online guidance", async () => {
    const api = installAPI();
    renderDialog(false);

    await selectEligibleSkill();
    fireEvent.click(
      screen.getByRole("button", {
        name: "agents.control.experience.preparePreview",
      }),
    );
    expect(
      await screen.findByText("agents.control.experience.onlineToSubmit"),
    ).toBeTruthy();
    expect(api.prepareExperienceCandidate).toHaveBeenCalled();
    expect(
      screen.getByRole("button", {
        name: "agents.control.experience.submitForReview",
      }),
    ).toBeDisabled();
    expect(api.submitExperienceCandidate).not.toHaveBeenCalled();
  });

  it("requires explicit confirmation and never uploads on open or preview", async () => {
    const api = installAPI();
    const onSubmitted = vi.fn();
    renderDialog(true, onSubmitted);

    await selectEligibleSkill();
    fireEvent.click(
      screen.getByRole("button", {
        name: "agents.control.experience.preparePreview",
      }),
    );
    const submit = await screen.findByRole("button", {
      name: "agents.control.experience.submitForReview",
    });
    expect(submit).toBeDisabled();
    expect(api.submitExperienceCandidate).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "agents.control.experience.submitConfirmation",
      }),
    );
    fireEvent.click(submit);

    await waitFor(() =>
      expect(api.submitExperienceCandidate).toHaveBeenCalledWith({
        candidateId: CANDIDATE_ID,
        confirmation: "submit-selected-skill",
      }),
    );
    expect(onSubmitted).toHaveBeenCalledWith(submitted());
  });

  it("shows safe localized DLP locations without rendering evidence", async () => {
    installAPI({
      prepareExperienceCandidate: vi.fn(async () =>
        success(
          preview([
            {
              code: "credential_api_key",
              path: "skills/research-notes/SKILL.md",
              line: 12,
            },
          ]),
        ),
      ),
    });
    renderDialog();

    await selectEligibleSkill();
    fireEvent.click(
      screen.getByRole("button", {
        name: "agents.control.experience.preparePreview",
      }),
    );

    expect(
      await screen.findByText(
        "agents.control.experience.dlp.credential_api_key",
      ),
    ).toBeTruthy();
    expect(screen.getByText("skills/research-notes/SKILL.md:12")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/sk-[A-Za-z0-9]+/);
    expect(
      screen.getByRole("button", {
        name: "agents.control.experience.submitForReview",
      }),
    ).toBeDisabled();
  });

  it("keeps failed uploads as an explicit manual retry without a timer", async () => {
    const submitExperienceCandidate = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false as const,
        errorCode: "cloud_unavailable" as const,
      })
      .mockResolvedValueOnce(success(submitted()));
    const api = installAPI({ submitExperienceCandidate });
    renderDialog();

    await selectEligibleSkill();
    fireEvent.click(
      screen.getByRole("button", {
        name: "agents.control.experience.preparePreview",
      }),
    );
    fireEvent.click(
      await screen.findByRole("checkbox", {
        name: "agents.control.experience.submitConfirmation",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "agents.control.experience.submitForReview",
      }),
    );

    expect(
      await screen.findByText("agents.control.errors.cloud_unavailable"),
    ).toBeTruthy();
    const retry = screen.getByRole("button", {
      name: "agents.control.experience.retryUpload",
    });
    expect(submitExperienceCandidate).toHaveBeenCalledTimes(1);

    fireEvent.click(retry);
    await waitFor(() =>
      expect(api.submitExperienceCandidate).toHaveBeenCalledTimes(2),
    );
  });
});
