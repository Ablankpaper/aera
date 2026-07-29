import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentDraft,
  AgentDraftDetail,
  AgenteraAgentControlContext,
  AgenteraAgentControlPublicState,
  AgenteraAgentControlResult,
  AgenteraAgentDefinitionSummary,
  AgenteraAgentInstallationSummary,
  ExperienceCandidateDetail,
  ExperienceCandidateImportPreview,
  ExperienceCandidateSummary,
  OfficialAgentDetail,
  OfficialAgentSummary,
  OfficialManagedUpdate,
} from "../../../../shared/agentera-agent-control";
import AgentControlPanel from "./AgentControlPanel";

vi.mock("../../components/useI18n", () => ({
  useI18n: () => ({ t: (key: string): string => key }),
}));

const DEFINITION_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const INSTALLATION_ID = "33333333-3333-4333-8333-333333333333";
const WORKSPACE_ID = "66666666-6666-4666-8666-666666666666";
const ORGANIZATION_ID = "99999999-9999-4999-8999-999999999999";
const OFFICIAL_RELEASE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OFFICIAL_REVISION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function success<T>(data: T): AgenteraAgentControlResult<T> {
  return { ok: true, data };
}

function controlState(
  context: AgenteraAgentControlContext = { scope: "USER" },
  overrides: Partial<AgenteraAgentControlPublicState> = {},
): AgenteraAgentControlPublicState {
  return {
    access: "online",
    cloudAvailable: true,
    draftCount: 0,
    installationCount: 0,
    context,
    ...overrides,
  };
}

function draft(): AgentDraftDetail {
  return {
    id: "77777777-7777-4777-8777-777777777777",
    sourceAgentDefinitionId: null,
    baseAgentVersionId: null,
    displayName: "Workspace Research Agent",
    icon: null,
    manifest: {
      schemaVersion: 1,
      identity: { systemPrompt: "Research carefully" },
      assets: [],
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
    },
    assets: [],
    editableAssets: [],
    revision: 1,
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z",
    lastPublicationAttempt: null,
    publishedRevision: null,
  };
}

function publishedDraft(): AgentDraftDetail {
  return {
    ...draft(),
    publishedRevision: {
      revision: 1,
      definitionId: DEFINITION_ID,
      versionId: VERSION_ID,
    },
  };
}

function definition(): AgenteraAgentDefinitionSummary {
  return {
    id: DEFINITION_ID,
    displayName: "Research Agent",
    status: "active",
    latestVersionId: VERSION_ID,
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:00.000Z",
  };
}

function installation(
  status: "pending" | "active" = "active",
): AgenteraAgentInstallationSummary {
  return {
    id: INSTALLATION_ID,
    sourceScope: "USER",
    officialReleaseId: null,
    selectedReleaseRevisionId: null,
    updatePolicy: "manual",
    definitionId: DEFINITION_ID,
    selectedVersionId: VERSION_ID,
    runtimeProfileId:
      status === "active" ? "44444444-4444-4444-8444-444444444444" : null,
    policySnapshotId: "55555555-5555-4555-8555-555555555555",
    status,
    retryCode: status === "pending" ? "materialization_failed" : null,
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:00.000Z",
  };
}

function officialAgent(): OfficialAgentSummary {
  return {
    definitionId: DEFINITION_ID,
    displayName: "Official Research Agent",
    iconMediaType: null,
    iconDataBase64Url: null,
    versionId: VERSION_ID,
    versionNumber: 2,
    releaseId: OFFICIAL_RELEASE_ID,
    releaseRevisionId: OFFICIAL_REVISION_ID,
    channel: "stable",
    runtimeMinimumVersion: "v0.18.2-agentera.1",
    runtimeMaximumVersionExclusive: null,
    installationState: "installed",
    updateState: "update_available",
  };
}

function officialInstallation(): AgenteraAgentInstallationSummary {
  return {
    ...installation("active"),
    sourceScope: "PLATFORM",
    officialReleaseId: OFFICIAL_RELEASE_ID,
    selectedReleaseRevisionId: OFFICIAL_REVISION_ID,
    updatePolicy: "managed",
  };
}

function officialDetail(): OfficialAgentDetail {
  return {
    agent: officialAgent(),
    capabilitySummary: "Official capability summary",
    assetCounts: { skill: 2, sop: 1, knowledge: 1 },
    allowedProviders: ["openai"],
    allowedModels: ["openai/gpt-5.6"],
    allowedToolCount: 3,
  };
}

function approvedCandidate(): ExperienceCandidateSummary {
  return {
    localCandidateId: "88888888-8888-4888-8888-888888888888",
    cloudCandidateId: "88888888-8888-4888-8888-888888888888",
    agentDefinitionId: DEFINITION_ID,
    sourceAgentVersionId: VERSION_ID,
    skillName: "research-notes",
    contentDigest: `sha256:${"a".repeat(64)}`,
    localStatus: "SUBMITTED",
    reviewStatus: "APPROVED",
    lastErrorCode: "candidate_import_failed",
    createdAt: "2026-07-20T00:00:00.000Z",
    reviewedAt: "2026-07-20T01:00:00.000Z",
  };
}

function approvedCandidateDetail(): ExperienceCandidateDetail {
  return {
    ...approvedCandidate(),
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

function candidateImportPreview(): ExperienceCandidateImportPreview {
  return {
    importHandle: "99999999-9999-4999-8999-999999999999",
    candidateId: approvedCandidate().cloudCandidateId!,
    sourceVersionId: VERSION_ID,
    latestVersionId: VERSION_ID,
    latestVersionNumber: 3,
    skillName: "research-notes",
    replacesExistingSkill: false,
    addedPaths: ["skills/research-notes/SKILL.md"],
    replacedPaths: [],
    removedPaths: [],
  };
}

type MockedPanelAgenteraAPI = Window["agenteraAgents"] & {
  listDefinitions: ReturnType<typeof vi.fn>;
  listDrafts: ReturnType<typeof vi.fn>;
  listOrganizationSubmissions: ReturnType<typeof vi.fn>;
  archiveInstallation: ReturnType<typeof vi.fn>;
};

function installAPI(
  overrides: Partial<Window["agenteraAgents"]> = {},
): MockedPanelAgenteraAPI {
  const api = {
    getState: vi.fn(async () => success(controlState())),
    listDrafts: vi.fn(async () => success([])),
    getDraft: vi.fn(),
    createDraft: vi.fn(),
    updateDraft: vi.fn(),
    deleteDraft: vi.fn(),
    preparePublication: vi.fn(),
    confirmPublication: vi.fn(),
    prepareOrganizationSubmission: vi.fn(),
    confirmOrganizationSubmission: vi.fn(),
    listOrganizationSubmissions: vi.fn(async () => success([])),
    getOrganizationSubmission: vi.fn(),
    prepareOrganizationReview: vi.fn(),
    confirmOrganizationReview: vi.fn(),
    prepareOrganizationWithdrawal: vi.fn(),
    confirmOrganizationWithdrawal: vi.fn(),
    listDefinitions: vi.fn(async () => success([definition()])),
    listOfficialAgents: vi.fn(async () => success([])),
    getOfficialAgentDetail: vi.fn(async () => success(officialDetail())),
    prepareOfficialInstall: vi.fn(),
    confirmOfficialInstall: vi.fn(),
    refreshOfficialUpdates: vi.fn(async () => success([])),
    applyOfficialUpdate: vi.fn(),
    listVersions: vi.fn(async () => success([])),
    listInstallations: vi.fn(async () => success([])),
    installVersion: vi.fn(),
    claimVersion: vi.fn(),
    retryPendingInstallation: vi.fn(),
    selectInstallationVersion: vi.fn(),
    archiveInstallation: vi.fn(),
    listEligibleExperienceSkills: vi.fn(async () => success([])),
    prepareExperienceCandidate: vi.fn(),
    submitExperienceCandidate: vi.fn(),
    listMyExperienceCandidates: vi.fn(async () => success([])),
    listExperienceReviewQueue: vi.fn(async () => success([])),
    getExperienceCandidate: vi.fn(),
    reviewExperienceCandidate: vi.fn(),
    prepareExperienceCandidateImport: vi.fn(),
    confirmExperienceCandidateImport: vi.fn(),
    onStateChanged: vi.fn(() => () => undefined),
    ...overrides,
  } as unknown as MockedPanelAgenteraAPI;
  Object.defineProperty(window, "agenteraAgents", {
    configurable: true,
    value: api,
  });
  return api;
}

describe("AgentControlPanel", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("keeps local drafts/installations available offline and pauses cloud discovery", async () => {
    const api = installAPI({
      getState: vi.fn(async () =>
        success(
          controlState(
            { scope: "USER" },
            {
              access: "offline",
              cloudAvailable: false,
              installationCount: 1,
            },
          ),
        ),
      ),
      listInstallations: vi.fn(async () => success([installation("active")])),
    });
    render(
      <AgentControlPanel profiles={[{ id: "default", name: "Default" }]} />,
    );

    expect(
      await screen.findByText("agents.control.offlineNotice"),
    ).toBeTruthy();
    expect(api.listDefinitions).not.toHaveBeenCalled();
    expect(
      screen.getAllByText("agents.control.installedLocally").length,
    ).toBeGreaterThan(0);
    expect(
      screen.getByRole("button", { name: "agents.control.newAgent" }),
    ).toBeEnabled();
    expect(screen.getByText("agents.control.personalSpaceTitle")).toBeTruthy();
    expect(
      screen.queryByRole("button", {
        name: "agents.control.experience.promoteLocalExperience",
      }),
    ).toBeNull();
  });

  it("presents an existing local runtime only as a ready Agent", async () => {
    installAPI({
      listDefinitions: vi.fn(async () => success([])),
    });
    const onChatWithProfile = vi.fn();
    render(
      <AgentControlPanel
        profiles={[{ id: "default", name: "Default" }]}
        advancedOpenByDefault={false}
        onChatWithProfile={onChatWithProfile}
      />,
    );

    const grid = await screen.findByTestId("personal-agent-grid");
    const card = within(grid).getByText("Default").closest("button");
    expect(card).toBeTruthy();
    expect(screen.queryByTestId("local-runtime-profiles")).toBeNull();
    expect(screen.queryByText("agents.legacyTitle")).toBeNull();

    fireEvent.click(card!);
    expect(await screen.findByRole("dialog", { name: "Default" })).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "agents.hub.editAppearance" }),
    ).toBeNull();

    fireEvent.click(
      screen.getByRole("button", {
        name: "agents.hub.useAgent",
      }),
    );
    expect(onChatWithProfile).toHaveBeenCalledWith("default");
  });

  it("distinguishes an empty filter from a truly empty My Agents catalog", async () => {
    installAPI({
      listDrafts: vi.fn(async () => success([draft() as AgentDraft])),
      listDefinitions: vi.fn(async () => success([])),
    });
    render(<AgentControlPanel profiles={[]} advancedOpenByDefault={false} />);

    expect(
      within(await screen.findByTestId("personal-agent-grid")).getByText(
        "Workspace Research Agent",
      ),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "agents.hub.mineFilter.ready" }),
    );

    expect(screen.getByText("agents.hub.noFilteredResults")).toBeTruthy();
    expect(screen.getByText("agents.hub.noFilteredResultsHint")).toBeTruthy();
    expect(screen.queryByText("agents.hub.noPersonalAgents")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "agents.hub.createAgent" }),
    ).toBeNull();
  });

  it("gives a search-specific empty result without suggesting the catalog is empty", async () => {
    installAPI({
      listDrafts: vi.fn(async () => success([draft() as AgentDraft])),
      listDefinitions: vi.fn(async () => success([])),
    });
    render(<AgentControlPanel profiles={[]} advancedOpenByDefault={false} />);

    await screen.findByTestId("personal-agent-grid");
    fireEvent.change(
      screen.getByRole("textbox", {
        name: "agents.hub.searchPlaceholder",
      }),
      { target: { value: "missing" } },
    );

    expect(screen.getByText("agents.hub.noSearchResults")).toBeTruthy();
    expect(screen.getByText("agents.hub.noSearchResultsHint")).toBeTruthy();
    expect(screen.queryByText("agents.hub.noPersonalAgentsHint")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "agents.hub.createAgent" }),
    ).toBeNull();
  });

  it("shows a published Agent as usable even before the catalog refresh catches up", async () => {
    installAPI({
      listDrafts: vi.fn(async () => success([publishedDraft() as AgentDraft])),
      listDefinitions: vi.fn(async () => success([])),
    });
    render(<AgentControlPanel profiles={[]} />);

    fireEvent.click(
      (await screen.findByText("Workspace Research Agent")).closest("button")!,
    );
    const detailDialog = await screen.findByRole("dialog", {
      name: "Workspace Research Agent",
    });
    expect(detailDialog).toHaveTextContent("agents.hub.published");
    expect(
      within(detailDialog).getByRole("button", {
        name: "agents.hub.useAgent",
      }),
    ).toBeEnabled();
    expect(
      within(detailDialog).getByRole("button", {
        name: "agents.control.edit",
      }),
    ).toBeEnabled();
  });

  it("loads and applies a managed official update only through the official API", async () => {
    const update: OfficialManagedUpdate = {
      installationId: INSTALLATION_ID,
      expectedSelectedReleaseRevisionId: OFFICIAL_REVISION_ID,
      targetReleaseRevisionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      targetVersionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    };
    const api = installAPI({
      listInstallations: vi.fn(async () => success([officialInstallation()])),
      listOfficialAgents: vi.fn(async () => success([officialAgent()])),
      refreshOfficialUpdates: vi.fn(async () => success([update])),
      applyOfficialUpdate: vi.fn(async () => success(officialInstallation())),
    });

    render(<AgentControlPanel profiles={[]} initialTab="official" />);

    fireEvent.click(
      (await screen.findByText("Official Research Agent")).closest("button")!,
    );
    expect(
      await screen.findByRole("dialog", { name: "Official Research Agent" }),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", {
        name: "agents.control.official.applyUpdate",
      }),
    );
    await waitFor(() =>
      expect(api.applyOfficialUpdate).toHaveBeenCalledWith(INSTALLATION_ID),
    );
    expect(api.selectInstallationVersion).not.toHaveBeenCalled();
    expect(api.archiveInstallation).not.toHaveBeenCalled();
  });

  it("keeps a verified official installation visible offline without remote calls", async () => {
    const api = installAPI({
      getState: vi.fn(async () =>
        success(
          controlState(
            { scope: "USER" },
            { access: "offline", cloudAvailable: false },
          ),
        ),
      ),
      listInstallations: vi.fn(async () => success([officialInstallation()])),
    });

    render(<AgentControlPanel profiles={[]} initialTab="official" />);

    const offlineCard = (
      await screen.findByText("agents.control.official.installedSource")
    ).closest("button");
    expect(offlineCard).toBeTruthy();
    expect(screen.getByText("agents.hub.installed")).toBeTruthy();
    fireEvent.click(offlineCard!);
    expect(
      await screen.findByRole("dialog", {
        name: "agents.control.official.installedSource",
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: "agents.hub.localProfileUnavailable",
      }),
    ).toBeDisabled();
    expect(api.listOfficialAgents).not.toHaveBeenCalled();
    expect(api.refreshOfficialUpdates).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", {
        name: "agents.control.official.applyUpdate",
      }),
    ).toBeNull();
    expect(screen.queryByText("agents.control.installedLocally")).toBeNull();
  });

  // @lat: [[agentera-agent-control-plane#Trusted Workspace Agent context#Role-aware presentation]]
  it.each(["owner", "admin"] as const)(
    "shows Workspace author controls for an online %s",
    async (role) => {
      installAPI({
        getState: vi.fn(async () =>
          success(
            controlState({
              scope: "WORKSPACE",
              workspaceId: WORKSPACE_ID,
              role,
            }),
          ),
        ),
        listDrafts: vi.fn(async () => success([draft() as AgentDraft])),
      });
      render(<AgentControlPanel profiles={[]} />);

      expect(
        await screen.findByText("agents.control.workspaceSpaceTitle"),
      ).toBeTruthy();
      expect(screen.getByText(`agents.control.role.${role}`)).toBeTruthy();
      expect(
        screen.getByRole("button", { name: "agents.control.newAgent" }),
      ).toBeEnabled();
      fireEvent.click(
        screen.getByText("Workspace Research Agent").closest("button")!,
      );
      expect(
        screen.getByRole("button", { name: "agents.control.edit" }),
      ).toBeEnabled();
    },
  );

  it("renders a Workspace Member as install-only without reading local drafts", async () => {
    const api = installAPI({
      getState: vi.fn(async () =>
        success(
          controlState({
            scope: "WORKSPACE",
            workspaceId: WORKSPACE_ID,
            role: "member",
          }),
        ),
      ),
      listDrafts: vi.fn(async () => success([draft() as AgentDraft])),
    });
    render(
      <AgentControlPanel profiles={[{ id: "default", name: "Default" }]} />,
    );

    expect(
      await screen.findByText("agents.hub.workspaceSubtitle"),
    ).toBeTruthy();
    expect(screen.queryByText("agents.control.localDrafts")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "agents.control.newAgent" }),
    ).toBeNull();
    expect(api.listDrafts).not.toHaveBeenCalled();
    const personalGrid = await screen.findByTestId("personal-agent-grid");
    fireEvent.click(
      within(personalGrid).getByText("Research Agent").closest("button")!,
    );
    expect(
      screen.getByRole("button", { name: "agents.hub.useAgent" }),
    ).toBeEnabled();
  });

  it.each([
    ["owner", true, true, true],
    ["admin", true, true, true],
    ["auditor", false, true, false],
    ["member", false, false, true],
  ] as const)(
    // @lat: [[agentera-organizations#AgentEra Organization and Organization Agent V1#Desktop product context]]
    "renders Organization role %s with author=%s history=%s install=%s",
    async (role, author, history, install) => {
      const api = installAPI({
        getState: vi.fn(async () =>
          success(
            controlState({
              scope: "ORGANIZATION",
              organizationId: ORGANIZATION_ID,
              role,
            }),
          ),
        ),
      });
      render(<AgentControlPanel profiles={[]} />);

      fireEvent.click(
        await screen.findByRole("tab", {
          name: "agents.hub.enterpriseTab",
        }),
      );
      expect(
        await screen.findByRole("heading", {
          name: "agents.control.organization.title",
        }),
      ).toBeVisible();
      expect(
        screen.queryByRole("button", {
          name: "agents.control.organization.newDraft",
        }) !== null,
      ).toBe(author);
      expect(
        screen.queryByText("agents.control.organization.reviewTitle") !== null,
      ).toBe(history);
      fireEvent.click(screen.getByText("Research Agent").closest("button")!);
      const useButton = screen.getByRole("button", {
        name: "agents.hub.useAgent",
      });
      expect(useButton).toBeTruthy();
      expect(useButton).toHaveProperty("disabled", !install);
      expect(api.listDrafts.mock.calls.length > 0).toBe(author);
      expect(api.listOrganizationSubmissions.mock.calls.length > 0).toBe(
        history,
      );
    },
  );

  it("switches an Organization member to Personal before creating from My Agents", async () => {
    let context: AgenteraAgentControlPublicState["context"] = {
      scope: "ORGANIZATION",
      organizationId: ORGANIZATION_ID,
      role: "member",
    };
    const api = installAPI({
      getState: vi.fn(async () => success(controlState(context))),
    });
    const select = vi.fn(async () => {
      context = { scope: "USER" };
      return success({
        access: "online" as const,
        stale: false,
        selected: { kind: "PERSONAL" as const },
        options: [{ kind: "PERSONAL" as const }],
      });
    });
    Object.defineProperty(window, "agenteraProductSpace", {
      configurable: true,
      value: { select },
    });

    render(<AgentControlPanel profiles={[]} initialTab="mine" />);

    fireEvent.click(
      await screen.findByRole("button", {
        name: "agents.control.newAgent",
      }),
    );

    await waitFor(() =>
      expect(select).toHaveBeenCalledWith({ kind: "PERSONAL" }),
    );
    expect(api.getState).toHaveBeenCalledTimes(2);
    expect(
      await screen.findByRole("dialog", {
        name: "agents.control.newDraftTitle",
      }),
    ).toBeInTheDocument();
  });

  it("shows cached Organization content read-only while offline", async () => {
    const api = installAPI({
      getState: vi.fn(async () =>
        success(
          controlState(
            {
              scope: "ORGANIZATION",
              organizationId: ORGANIZATION_ID,
              role: "owner",
            },
            { access: "offline", cloudAvailable: false },
          ),
        ),
      ),
    });
    render(<AgentControlPanel profiles={[]} />);

    fireEvent.click(
      await screen.findByRole("tab", {
        name: "agents.hub.enterpriseTab",
      }),
    );
    expect(
      (await screen.findAllByText("agents.control.organization.cachedReadOnly"))
        .length,
    ).toBeGreaterThan(0);
    expect(
      screen.queryByRole("button", {
        name: "agents.control.organization.newDraft",
      }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", {
        name: "agents.control.organization.submitForReview",
      }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "agents.hub.useAgent" }),
    ).toBeNull();
    expect(api.listDefinitions).not.toHaveBeenCalled();
    expect(api.listOrganizationSubmissions).not.toHaveBeenCalled();
  });

  it("offers explicit local experience promotion only for an active selected-Workspace installation", async () => {
    const api = installAPI({
      getState: vi.fn(async () =>
        success(
          controlState({
            scope: "WORKSPACE",
            workspaceId: WORKSPACE_ID,
            role: "member",
          }),
        ),
      ),
      listInstallations: vi.fn(async () => success([installation("active")])),
    });
    render(<AgentControlPanel profiles={[]} />);

    fireEvent.click(
      (await screen.findByText("Research Agent")).closest("button")!,
    );
    const promote = screen.getByRole("button", {
      name: "agents.control.experience.promoteLocalExperience",
    });
    expect(api.listEligibleExperienceSkills).not.toHaveBeenCalled();
    fireEvent.click(promote);

    expect(
      await screen.findByRole("dialog", {
        name: "agents.control.experience.promotionTitle",
      }),
    ).toBeTruthy();
    expect(api.listEligibleExperienceSkills).toHaveBeenCalledWith(
      INSTALLATION_ID,
    );
  });

  it("opens the imported approved candidate in the existing draft editor without publishing", async () => {
    const approved = approvedCandidate();
    const importedDraft = draft();
    const api = installAPI({
      getState: vi.fn(async () =>
        success(
          controlState({
            scope: "WORKSPACE",
            workspaceId: WORKSPACE_ID,
            role: "owner",
          }),
        ),
      ),
      listMyExperienceCandidates: vi.fn(async () => success([approved])),
      listExperienceReviewQueue: vi.fn(async () => success([])),
      getExperienceCandidate: vi.fn(async () =>
        success(approvedCandidateDetail()),
      ),
      prepareExperienceCandidateImport: vi.fn(async () =>
        success(candidateImportPreview()),
      ),
      confirmExperienceCandidateImport: vi.fn(async () =>
        success(importedDraft),
      ),
    });
    render(<AgentControlPanel profiles={[]} />);

    fireEvent.click(
      await screen.findByRole("button", {
        name: "agents.control.experience.createDraftRetry",
      }),
    );
    fireEvent.click(
      await screen.findByRole("checkbox", {
        name: "agents.control.experience.importConfirmation",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "agents.control.experience.createDraft",
      }),
    );

    expect(
      await screen.findByDisplayValue("Workspace Research Agent"),
    ).toBeTruthy();
    expect(api.confirmExperienceCandidateImport).toHaveBeenCalledWith({
      importHandle: candidateImportPreview().importHandle,
      confirmation: "apply-approved-skill-to-latest",
    });
    expect(api.preparePublication).not.toHaveBeenCalled();
    expect(api.confirmPublication).not.toHaveBeenCalled();
  });

  it("closes one-use experience dialogs on a control-state invalidation even when the visible scope key is unchanged", async () => {
    const current = controlState({
      scope: "WORKSPACE",
      workspaceId: WORKSPACE_ID,
      role: "member",
    });
    let notify: (() => void) | null = null;
    installAPI({
      getState: vi.fn(async () => success(current)),
      listInstallations: vi.fn(async () => success([installation("active")])),
      onStateChanged: vi.fn((listener) => {
        notify = () => listener(current);
        return () => undefined;
      }),
    });
    render(<AgentControlPanel profiles={[]} />);

    fireEvent.click(
      (await screen.findByText("Research Agent")).closest("button")!,
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "agents.control.experience.promoteLocalExperience",
      }),
    );
    expect(
      screen.getByRole("dialog", {
        name: "agents.control.experience.promotionTitle",
      }),
    ).toBeTruthy();

    await act(async () => notify?.());
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", {
          name: "agents.control.experience.promotionTitle",
        }),
      ).toBeNull(),
    );
  });

    // @lat: [[agentera-agent-control-plane#AgentEra Agent control plane V1#Trusted Workspace Agent context#Context-only refresh]]
  it("keeps the create-and-publish workflow open across same-context state invalidations", async () => {
    const current = controlState();
    const created = draft();
    let notify: (() => void) | null = null;
    let completeCreate:
      | ((result: AgenteraAgentControlResult<AgentDraftDetail>) => void)
      | null = null;
    const api = installAPI({
      getState: vi.fn(async () => success(current)),
      listDrafts: vi.fn(async () => success([])),
      listDefinitions: vi.fn(async () => success([])),
      createDraft: vi.fn(
        () =>
          new Promise<AgenteraAgentControlResult<AgentDraftDetail>>(
            (resolve) => {
              completeCreate = resolve;
            },
          ),
      ),
      preparePublication: vi.fn(async () =>
        success({
          publicationHandle: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          draftId: created.id,
          revision: created.revision,
          targetScope: "USER" as const,
          assetCounts: { skill: 0, sop: 0, knowledge: 0 },
          totalBytes: 0,
        }),
      ),
      confirmPublication: vi.fn(async () =>
        success({
          draftId: created.id,
          revision: created.revision,
          definitionId: DEFINITION_ID,
          versionId: VERSION_ID,
          versionNumber: 1,
          contentDigest: "b".repeat(64),
          publishedAt: "2026-07-20T01:00:00.000Z",
          replayed: false,
        }),
      ),
      onStateChanged: vi.fn((listener) => {
        notify = () => listener(current);
        return () => undefined;
      }),
    });
    render(<AgentControlPanel profiles={[]} />);

    fireEvent.click(
      await screen.findByRole("button", {
        name: "agents.control.newAgent",
      }),
    );
    fireEvent.change(screen.getByLabelText("agents.control.name"), {
      target: { value: created.displayName },
    });
    fireEvent.change(screen.getByLabelText("agents.control.systemPrompt"), {
      target: { value: created.manifest.identity.systemPrompt },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "agents.control.publish" }),
    );
    await waitFor(() => expect(api.createDraft).toHaveBeenCalledTimes(1));

    await act(async () => notify?.());
    expect(
      screen.getByRole("dialog", {
        name: "agents.control.newDraftTitle",
      }),
    ).toBeTruthy();

    await act(async () => completeCreate?.(success(created)));
    await waitFor(() =>
      expect(api.confirmPublication).toHaveBeenCalledWith(
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      ),
    );
  });

  it("keeps Workspace drafts visible but read-only while offline", async () => {
    const workspaceDraft = draft();
    const api = installAPI({
      getState: vi.fn(async () =>
        success(
          controlState(
            {
              scope: "WORKSPACE",
              workspaceId: WORKSPACE_ID,
              role: "owner",
            },
            { access: "offline", cloudAvailable: false, draftCount: 1 },
          ),
        ),
      ),
      listDrafts: vi.fn(async () => success([workspaceDraft as AgentDraft])),
      getDraft: vi.fn(async () => success(workspaceDraft)),
    });
    render(<AgentControlPanel profiles={[]} />);

    expect(
      await screen.findByText("agents.control.workspaceOfflineNotice"),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "agents.control.newAgent" }),
    ).toBeDisabled();
    fireEvent.click(
      screen.getByText("Workspace Research Agent").closest("button")!,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "agents.control.view" }),
    );
    expect(
      await screen.findByDisplayValue("Workspace Research Agent"),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "agents.control.saveLocal" }),
    ).toBeDisabled();
    expect(api.listDefinitions).not.toHaveBeenCalled();
  });

  it("follows Agent control state when the selected space changes", async () => {
    let current = controlState();
    let notify: (() => void) | null = null;
    const api = installAPI({
      getState: vi.fn(async () => success(current)),
      onStateChanged: vi.fn((listener) => {
        notify = () => listener(current);
        return () => undefined;
      }),
    });
    render(<AgentControlPanel profiles={[]} />);
    expect(
      await screen.findByText("agents.control.personalSpaceTitle"),
    ).toBeTruthy();

    current = controlState({
      scope: "WORKSPACE",
      workspaceId: WORKSPACE_ID,
      role: "member",
    });
    await act(async () => notify?.());

    expect(
      await screen.findByText("agents.control.workspaceSpaceTitle"),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "agents.control.newAgent" }),
    ).toBeNull();
    expect(api.getState).toHaveBeenCalledTimes(2);
  });

  it.each(["workspace_archived", "workspace_owner_unavailable"] as const)(
    "renders the stable %s lifecycle error",
    async (errorCode) => {
      installAPI({
        getState: vi.fn(async () =>
          success(
            controlState({
              scope: "WORKSPACE",
              workspaceId: WORKSPACE_ID,
              role: "owner",
            }),
          ),
        ),
        listDefinitions: vi.fn(async () => ({ ok: false as const, errorCode })),
      });
      render(<AgentControlPanel profiles={[]} />);

      expect(
        await screen.findByText(`agents.control.errors.${errorCode}`),
      ).toBeTruthy();
      expect(document.body.textContent).not.toMatch(
        /token|response body|stack/i,
      );
    },
  );

  it("retries a pending Agent with an automatically prepared local runtime", async () => {
    const api = installAPI({
      listInstallations: vi.fn(async () => success([installation("pending")])),
      retryPendingInstallation: vi.fn(async () =>
        success(installation("active")),
      ),
    });
    render(<AgentControlPanel profiles={[]} />);

    fireEvent.click(
      (await screen.findByText("Research Agent")).closest("button")!,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "agents.control.retryAgent" }),
    );
    await waitFor(() =>
      expect(api.retryPendingInstallation).toHaveBeenCalledWith({
        id: INSTALLATION_ID,
        target: {
          kind: "fresh",
          profileName: "Research Agent",
        },
      }),
    );
    expect(
      screen.queryByRole("dialog", { name: "agents.control.retryTitle" }),
    ).toBeNull();
  });

  it("archives an active Agent without exposing or deleting its local runtime", async () => {
    const api = installAPI({
      listInstallations: vi.fn(async () => success([installation("active")])),
      archiveInstallation: vi.fn(async () => success(installation("active"))),
    });
    render(
      <AgentControlPanel
        profiles={[
          {
            id: "research-runtime",
            name: "Research Agent",
            agentInstallationId: INSTALLATION_ID,
          },
        ]}
      />,
    );

    fireEvent.click(
      (await screen.findByText("Research Agent")).closest("button")!,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "agents.control.archive" }),
    );
    const archiveDialog = screen.getByRole("dialog", {
      name: "agents.control.archiveTitle",
    });
    expect(archiveDialog).toHaveTextContent(
      "agents.control.archiveKeepsLocalData",
    );
    expect(api.archiveInstallation).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "agents.control.confirmArchive" }),
    );
    await waitFor(() =>
      expect(api.archiveInstallation).toHaveBeenCalledWith(INSTALLATION_ID),
    );
  });

  it("renders only stable safe error text", async () => {
    installAPI({
      listDefinitions: vi.fn(async () => ({
        ok: false as const,
        errorCode: "cloud_unavailable" as const,
      })),
    });
    render(<AgentControlPanel profiles={[]} />);

    expect(
      await screen.findByText("agents.control.errors.cloud_unavailable"),
    ).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/token|response body|stack/i);
  });
});
