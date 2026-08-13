import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  afterEach(async () => {
    // Radix FocusScope defers its unmount autofocus event with setTimeout(0).
    // Drain it before Vitest replaces this jsdom realm so the old element and
    // its CustomEvent always come from the same Event implementation.
    cleanup();
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  });

  beforeEach(() => vi.restoreAllMocks());

  it("lists eligible saved capabilities without exposing local private data", async () => {
    const api = installAPI();
    renderDialog();

    expect(
      await screen.findByRole("dialog", {
        name: "agents.control.experience.promotionTitle",
      }),
    ).toBeTruthy();
    expect(
      await screen.findByRole("option", { name: "research-notes" }),
    ).toBeTruthy();
    expect(
      await screen.findByRole("option", { name: "release-helper" }),
    ).toBeTruthy();
    expect(document.body.textContent).not.toContain("/.hermes/profiles/");
    expect(document.body.textContent).not.toContain("private skill content");
    expect(api.prepareExperienceCandidate).not.toHaveBeenCalled();

    expect(
      screen.getByText("agents.control.experience.privateBoundary"),
    ).toBeTruthy();
    expect(api.prepareExperienceCandidate).not.toHaveBeenCalled();
    expect(api.submitExperienceCandidate).not.toHaveBeenCalled();
  });

  it("prepares offline but never uploads and gives simple reconnect guidance", async () => {
    const api = installAPI();
    renderDialog(false);

    await selectEligibleSkill();
    fireEvent.click(
      screen.getByRole("button", {
        name: "agents.control.experience.share",
      }),
    );
    expect(
      await screen.findByText("agents.control.experience.onlineToShare"),
    ).toBeTruthy();
    expect(api.prepareExperienceCandidate).toHaveBeenCalled();
    expect(api.submitExperienceCandidate).not.toHaveBeenCalled();
  });

  it("blocks sharing on DLP findings without exposing technical paths", async () => {
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
        name: "agents.control.experience.share",
      }),
    );

    expect(
      await screen.findByText("agents.control.experience.dlpBlockedUser"),
    ).toBeTruthy();
    expect(document.body.textContent).not.toContain(
      "skills/research-notes/SKILL.md:12",
    );
    expect(document.body.textContent).not.toMatch(/sk-[A-Za-z0-9]+/);
    expect(
      window.agenteraAgents.submitExperienceCandidate,
    ).not.toHaveBeenCalled();
  });

  it("keeps failed sharing as an explicit retry without a timer", async () => {
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
        name: "agents.control.experience.share",
      }),
    );

    expect(
      await screen.findByText("agents.control.errors.cloud_unavailable"),
    ).toBeTruthy();
    const retry = screen.getByRole("button", {
      name: "agents.control.experience.retryShare",
    });
    expect(submitExperienceCandidate).toHaveBeenCalledTimes(1);

    fireEvent.click(retry);
    await waitFor(() =>
      expect(api.submitExperienceCandidate).toHaveBeenCalledTimes(2),
    );
  });

  // @lat: [[agentera-self-evolution#AgentEra self-evolution compatibility#Candidate promotion loop#ExperienceCandidate V1]]
  it("shares one selected Skill with one click after the local privacy scan", async () => {
    const api = installAPI();
    const onSubmitted = vi.fn();
    renderDialog(true, onSubmitted);

    await selectEligibleSkill();
    fireEvent.click(
      screen.getByRole("button", {
        name: "agents.control.experience.share",
      }),
    );

    await waitFor(() =>
      expect(api.prepareExperienceCandidate).toHaveBeenCalledWith({
        installationId: INSTALLATION_ID,
        skillName: "research-notes",
      }),
    );
    await waitFor(() =>
      expect(api.submitExperienceCandidate).toHaveBeenCalledWith({
        candidateId: CANDIDATE_ID,
        confirmation: "submit-selected-skill",
      }),
    );
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(document.body.textContent).not.toContain(VERSION_ID);
    expect(document.body.textContent).not.toContain("sha256:");
    expect(document.body.textContent).not.toContain("skills/research-notes/");
    expect(onSubmitted).toHaveBeenCalledWith(submitted());
  });
});
