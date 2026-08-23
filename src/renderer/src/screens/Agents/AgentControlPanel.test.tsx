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
  AgentCapabilityBindingConfiguration,
  AgenteraAgentDefinitionSummary,
  AgenteraAgentInstallationSummary,
  AgentRuntimeModelRouteSource,
  ExperienceCandidateDetail,
  ExperienceCandidateImportPreview,
  ExperienceCandidateSummary,
  OfficialAgentDetail,
  OfficialAgentInstallPreview,
  OfficialAgentSummary,
  OfficialManagedUpdate,
  OrganizationAgentSubmissionList,
  OrganizationAgentSubmissionListItem,
  OrganizationAgentSubmissionSummary,
} from "../../../../shared/agentera-agent-control";
import AgentControlPanel, {
  type AgentControlProfileOption,
} from "./AgentControlPanel";

vi.mock("../../components/useI18n", () => ({
  useI18n: () => ({ t: (key: string): string => key }),
}));

const DEFINITION_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const NEXT_VERSION_ID = "aaaaaaaa-2222-4222-8222-222222222222";
const INSTALLATION_ID = "33333333-3333-4333-8333-333333333333";
const WORKSPACE_ID = "66666666-6666-4666-8666-666666666666";
const ORGANIZATION_ID = "99999999-9999-4999-8999-999999999999";
const NEXT_ORGANIZATION_ID = "99999999-9999-4999-8999-999999999998";
const DRAFT_ID = "77777777-7777-4777-8777-777777777777";
const SUBMISSION_ID = "88888888-8888-4888-8888-888888888888";
const OFFICIAL_RELEASE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OFFICIAL_REVISION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CATALOG_REVISION = "a".repeat(64);

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

function organizationSubmission(
  status: OrganizationAgentSubmissionSummary["status"],
  localDraftRevision = 1,
): OrganizationAgentSubmissionListItem {
  return {
    id: SUBMISSION_ID,
    organizationId: ORGANIZATION_ID,
    kind: "initial",
    definitionId: DEFINITION_ID,
    baseVersionId: null,
    publishedVersionId: status === "approved" ? VERSION_ID : null,
    localDraftId: DRAFT_ID,
    localDraftRevision,
    submittedByUserId: "55555555-5555-4555-8555-555555555555",
    contentDigest: "a".repeat(64),
    status,
    revision: status === "pending" ? 1 : 2,
    submittedAt: "2026-07-21T01:00:00.000Z",
    terminalAt: status === "pending" ? null : "2026-07-21T02:00:00.000Z",
    review:
      status === "approved"
        ? {
            id: "66666666-6666-4666-8666-666666666666",
            reviewerUserId: "55555555-5555-4555-8555-555555555555",
            decision: "approve",
            reasonCode: null,
            safeNote: null,
            organizationPolicySnapshotId:
              "99999999-9999-4999-8999-999999999998",
            organizationPolicyVersion: 1,
            reviewedContentDigest: "a".repeat(64),
            reviewedAt: "2026-07-21T02:00:00.000Z",
          }
        : null,
    referenceState: {
      kind: "verified",
      draftId: DRAFT_ID,
      draftRevision: localDraftRevision,
    },
  };
}

function organizationSubmissionList(
  submissions: OrganizationAgentSubmissionListItem[] = [],
): OrganizationAgentSubmissionList {
  return { submissions, issues: [] };
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

function capabilityPendingInstallation(): AgenteraAgentInstallationSummary {
  return {
    ...installation("pending"),
    runtimeProfileId: "44444444-4444-4444-8444-444444444444",
    retryCode: "profile_capability_configuration_required",
  };
}

function capabilityBindingConfiguration(): AgentCapabilityBindingConfiguration {
  return {
    installationId: INSTALLATION_ID,
    requirements: [
      {
        logicalName: "private-docs",
        tools: ["docs.read"],
        required: true,
        permissionReason: "Read employee-approved documents",
        mappedLocalMcpName: null,
        compatibleServers: [
          {
            mappingHandle: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            displayName: "employee-docs",
            current: false,
          },
        ],
      },
    ],
  };
}

function configuredModelProfile(
  id = "configured-source",
): AgentControlProfileOption {
  return {
    id,
    name: "Configured source",
    provider: "openai",
    model: "gpt-5.6",
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
  listOrganizationSubmissionList: ReturnType<typeof vi.fn>;
  listOrganizationSubmissions: ReturnType<typeof vi.fn>;
  disconnectOrganizationSubmissionReference: ReturnType<typeof vi.fn>;
  archiveInstallation: ReturnType<typeof vi.fn>;
  installVersion: ReturnType<typeof vi.fn>;
};

type PanelAgenteraAPIOverrides = Partial<MockedPanelAgenteraAPI>;

function installAPI(
  overrides: PanelAgenteraAPIOverrides = {},
): MockedPanelAgenteraAPI {
  const api = {
    getState: vi.fn(async () => success(controlState())),
    listDrafts: vi.fn(async () => success([])),
    getDraft: vi.fn(),
    createDraft: vi.fn(),
    updateDraft: vi.fn(),
    deleteDraft: vi.fn(),
    discardUnpublishedDraft: vi.fn(),
    preparePublication: vi.fn(),
    confirmPublication: vi.fn(),
    prepareOrganizationSubmission: vi.fn(),
    confirmOrganizationSubmission: vi.fn(),
    listOrganizationSubmissionList: vi.fn(async () =>
      success(organizationSubmissionList()),
    ),
    listOrganizationSubmissions: vi.fn(async () => success([])),
    disconnectOrganizationSubmissionReference: vi.fn(),
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
    listCapabilityBindings: vi.fn(),
    confirmCapabilityBindings: vi.fn(),
    selectInstallationVersion: vi.fn(),
    repairInstallationModel: vi.fn(),
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

  it("opens the existing Hermes task board from the honest team entry", async () => {
    installAPI({ listDefinitions: vi.fn(async () => success([])) });
    const onOpenTeams = vi.fn();
    render(<AgentControlPanel profiles={[]} onOpenTeams={onOpenTeams} />);

    expect(await screen.findByText("agents.teams.title")).toBeVisible();
    expect(screen.getByText("agents.teams.hermesBoardStatus")).toBeVisible();
    expect(screen.getByText("agents.teams.capabilities")).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "agents.teams.startTask" }),
    );

    expect(onOpenTeams).toHaveBeenCalledOnce();
    expect(screen.queryByText("agents.teams.fakeProgress")).toBeNull();
  });

  // @lat: [[sidebar-navigation#Agents page]]
  it("keeps governance closed by default while allowing an Owner to open it", async () => {
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
    });

    render(<AgentControlPanel profiles={[]} />);

    const governance = await screen.findByRole("button", {
      name: "agents.hub.advancedTitle agents.hub.advancedSubtitle",
    });
    expect(governance).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByText("agents.control.experience.myCandidates"),
    ).toBeNull();

    fireEvent.click(governance);

    expect(governance).toHaveAttribute("aria-expanded", "true");
    expect(
      await screen.findByText("agents.control.experience.myCandidates"),
    ).toBeVisible();
  });

  it("does not show governance controls to a Workspace Member", async () => {
    installAPI({
      getState: vi.fn(async () =>
        success(
          controlState({
            scope: "WORKSPACE",
            workspaceId: WORKSPACE_ID,
            role: "member",
          }),
        ),
      ),
    });

    render(<AgentControlPanel profiles={[]} />);

    await screen.findByText("agents.hub.workspaceSubtitle");
    expect(screen.queryByText("agents.hub.advancedTitle")).toBeNull();
  });

  it("offers one retry action for a recoverable Cloud error and reloads authoritative state", async () => {
    const api = installAPI({
      listDefinitions: vi
        .fn()
        .mockResolvedValueOnce({
          ok: false as const,
          errorCode: "cloud_unavailable" as const,
        })
        .mockResolvedValueOnce(success([definition()])),
    });

    render(<AgentControlPanel profiles={[]} />);

    expect(
      await screen.findByText("agents.control.errors.cloud_unavailable"),
    ).toBeVisible();
    const retry = screen.getByRole("button", {
      name: "agents.control.tryAgain",
    });
    expect(
      screen.getAllByRole("button", { name: "agents.control.tryAgain" }),
    ).toHaveLength(1);

    fireEvent.click(retry);

    await waitFor(() => expect(api.getState).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Research Agent")).toBeVisible();
    expect(
      screen.queryByText("agents.control.errors.cloud_unavailable"),
    ).toBeNull();
  });

  it.each([
    "profile_model_configuration_failed",
    "model_route_unavailable",
  ] as const)(
    "opens model settings for the recoverable %s error",
    async (errorCode) => {
      installAPI({
        listDefinitions: vi.fn(async () => ({
          ok: false as const,
          errorCode,
        })),
      });
      const onConfigureModels = vi.fn();

      render(
        <AgentControlPanel
          profiles={[]}
          onConfigureModels={onConfigureModels}
        />,
      );

      expect(
        await screen.findByText(`agents.control.errors.${errorCode}`),
      ).toBeVisible();
      fireEvent.click(
        screen.getByRole("button", { name: "agents.hub.configureModel" }),
      );

      expect(onConfigureModels).toHaveBeenCalledOnce();
      expect(
        screen.queryByRole("button", { name: "agents.control.tryAgain" }),
      ).toBeNull();
    },
  );

  it.each([
    "capability_dlp_blocked",
    "organization_agent_forbidden",
    "conflict",
  ] as const)(
    "keeps the fail-closed %s error informational",
    async (errorCode) => {
      installAPI({
        listDefinitions: vi.fn(async () => ({
          ok: false as const,
          errorCode,
        })),
      });

      render(<AgentControlPanel profiles={[]} onConfigureModels={vi.fn()} />);

      expect(
        await screen.findByText(`agents.control.errors.${errorCode}`),
      ).toBeVisible();
      expect(
        screen.queryByRole("button", { name: "agents.control.tryAgain" }),
      ).toBeNull();
      expect(
        screen.queryByRole("button", { name: "agents.hub.configureModel" }),
      ).toBeNull();
    },
  );

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

  it("keeps My Agents usable when the unrelated official catalog is unavailable", async () => {
    const api = installAPI({
      listOfficialAgents: vi.fn(async () => ({
        ok: false as const,
        errorCode: "cloud_unavailable" as const,
      })),
    });

    render(<AgentControlPanel profiles={[]} initialTab="mine" />);

    expect(await screen.findByText("Research Agent")).toBeVisible();
    expect(
      screen.queryByText("agents.control.errors.cloud_unavailable"),
    ).toBeNull();
    expect(api.listOfficialAgents).not.toHaveBeenCalled();
    expect(api.refreshOfficialUpdates).not.toHaveBeenCalled();
  });

  it("presents an existing local runtime only as a ready Agent", async () => {
    installAPI({
      listDefinitions: vi.fn(async () => success([])),
    });
    const onChatWithProfile = vi.fn();
    render(
      <AgentControlPanel
        profiles={[
          {
            id: "default",
            name: "Default",
            provider: "openai",
            model: "openai/gpt-5.6",
          },
        ]}
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

  it("does not present an unconfigured Runtime Profile as ready", async () => {
    installAPI({
      listDefinitions: vi.fn(async () => success([])),
    });
    render(
      <AgentControlPanel
        profiles={[
          {
            id: "unconfigured",
            name: "Unconfigured",
            provider: "auto",
            model: "",
          },
        ]}
        advancedOpenByDefault={false}
      />,
    );

    const grid = await screen.findByTestId("personal-agent-grid");
    expect(within(grid).getByText("Unconfigured")).toBeTruthy();
    expect(
      within(grid).queryByText("agents.hub.ready"),
    ).not.toBeInTheDocument();
    fireEvent.click(within(grid).getByText("Unconfigured").closest("button")!);
    const detailDialog = screen.getByRole("dialog", { name: "Unconfigured" });
    expect(
      within(detailDialog).queryByText("agents.hub.ready"),
    ).not.toBeInTheDocument();
    fireEvent.click(
      within(detailDialog).getByRole("button", {
        name: "agents.control.close",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "agents.hub.mineFilter.ready" }),
    );
    expect(screen.getByText("agents.hub.noFilteredResults")).toBeTruthy();
  });

  it("renders one card-local primary action and keeps retry failure on its card", async () => {
    const pendingDefinitionId = "12121212-1212-4212-8212-121212121212";
    const pendingInstallationId = "13131313-1313-4313-8313-131313131313";
    const pendingVersionId = "14141414-1414-4414-8414-141414141414";
    const readyInstallation = installation("active");
    const pendingInstallation = {
      ...installation("pending"),
      id: pendingInstallationId,
      definitionId: pendingDefinitionId,
      selectedVersionId: pendingVersionId,
      retryCode: "activation_failed",
    } satisfies AgenteraAgentInstallationSummary;
    const api = installAPI({
      listDefinitions: vi.fn(async () =>
        success([
          definition(),
          {
            ...definition(),
            id: pendingDefinitionId,
            displayName: "Pending Agent",
            latestVersionId: pendingVersionId,
          },
        ]),
      ),
      listInstallations: vi.fn(async () =>
        success([readyInstallation, pendingInstallation]),
      ),
      retryPendingInstallation: vi.fn(async () => ({
        ok: false as const,
        errorCode: "cloud_unavailable" as const,
      })),
    });
    const onConfigureModels = vi.fn();
    render(
      <AgentControlPanel
        profiles={[
          {
            ...configuredModelProfile("ready-profile"),
            name: "Ready Agent",
            agentInstallationId: INSTALLATION_ID,
          },
          {
            id: "missing-model-profile",
            name: "Missing Model Agent",
            provider: "auto",
            model: "",
          },
        ]}
        onChatWithProfile={vi.fn()}
        onConfigureModels={onConfigureModels}
      />,
    );

    const grid = await screen.findByTestId("personal-agent-grid");
    const cards = within(grid).getAllByTestId("agent-capability-card");
    const readyCard = cards.find((card) =>
      within(card).queryByText("Research Agent"),
    )!;
    const pendingCard = cards.find((card) =>
      within(card).queryByText("Pending Agent"),
    )!;
    const missingModelCard = cards.find((card) =>
      within(card).queryByText("Missing Model Agent"),
    )!;

    expect(
      within(readyCard).getAllByTestId("agent-card-primary-action"),
    ).toHaveLength(1);
    expect(
      within(readyCard).getByRole("button", { name: "agents.hub.useAgent" }),
    ).toBeVisible();
    expect(
      within(pendingCard).getAllByTestId("agent-card-primary-action"),
    ).toHaveLength(1);
    expect(
      within(pendingCard).getByRole("button", {
        name: "agents.control.retryAgent",
      }),
    ).toBeVisible();
    expect(
      within(missingModelCard).getAllByTestId("agent-card-primary-action"),
    ).toHaveLength(1);
    expect(
      within(missingModelCard).getByRole("button", {
        name: "agents.hub.configureModel",
      }),
    ).toBeVisible();

    fireEvent.click(
      within(pendingCard).getByRole("button", {
        name: "agents.control.retryAgent",
      }),
    );
    expect(
      await within(pendingCard).findByText(
        "agents.control.errors.cloud_unavailable",
      ),
    ).toBeVisible();
    expect(
      within(readyCard).queryByText("agents.control.errors.cloud_unavailable"),
    ).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(api.retryPendingInstallation).toHaveBeenCalledOnce();
  });

  it("opens model configuration instead of installing a published Agent without a model", async () => {
    const api = installAPI({
      listDefinitions: vi.fn(async () => success([definition()])),
    });
    const onConfigureModels = vi.fn();
    render(
      <AgentControlPanel
        profiles={[]}
        advancedOpenByDefault={false}
        onConfigureModels={onConfigureModels}
      />,
    );

    fireEvent.click(
      (await screen.findByText("Research Agent")).closest("button")!,
    );
    const action = screen.getByRole("button", {
      name: "agents.hub.configureModel",
    });
    expect(action).toBeEnabled();
    fireEvent.click(action);

    expect(onConfigureModels).toHaveBeenCalledTimes(1);
    expect(api.installVersion).not.toHaveBeenCalled();
    expect(api.retryPendingInstallation).not.toHaveBeenCalled();
    expect(api.repairInstallationModel).not.toHaveBeenCalled();
  });

  it("opens model configuration instead of retrying a pending Agent without a model", async () => {
    const api = installAPI({
      listDefinitions: vi.fn(async () => success([definition()])),
      listInstallations: vi.fn(async () => success([installation("pending")])),
    });
    const onConfigureModels = vi.fn();
    render(
      <AgentControlPanel
        profiles={[]}
        advancedOpenByDefault={false}
        onConfigureModels={onConfigureModels}
      />,
    );

    fireEvent.click(
      (await screen.findByText("Research Agent")).closest("button")!,
    );
    const action = screen.getByRole("button", {
      name: "agents.hub.configureModel",
    });
    expect(action).toBeEnabled();
    fireEvent.click(action);

    expect(onConfigureModels).toHaveBeenCalledTimes(1);
    expect(api.installVersion).not.toHaveBeenCalled();
    expect(api.retryPendingInstallation).not.toHaveBeenCalled();
    expect(api.repairInstallationModel).not.toHaveBeenCalled();
  });

  it("opens required capability mapping instead of retrying the pending installation blindly", async () => {
    const completed = {
      ...capabilityPendingInstallation(),
      status: "active" as const,
      retryCode: null,
    };
    const api = installAPI({
      listDefinitions: vi.fn(async () => success([definition()])),
      listInstallations: vi.fn(async () =>
        success([capabilityPendingInstallation()]),
      ),
      listCapabilityBindings: vi.fn(async () =>
        success(capabilityBindingConfiguration()),
      ),
      confirmCapabilityBindings: vi.fn(async () =>
        success({
          installation: completed,
          forceNewConversation: true as const,
        }),
      ),
    });
    const onAgentReady = vi.fn(async () => true);
    render(
      <AgentControlPanel
        profiles={[
          {
            id: "employee-agent",
            name: "Employee Agent",
            provider: "openai",
            model: "gpt-5.6",
            agentInstallationId: INSTALLATION_ID,
            runtimeProfileId: capabilityPendingInstallation().runtimeProfileId,
          },
        ]}
        onAgentReady={onAgentReady}
      />,
    );

    fireEvent.click(
      (await screen.findByText("Research Agent")).closest("button")!,
    );
    const detail = screen.getByRole("dialog", { name: "Research Agent" });
    expect(detail).toHaveTextContent("agents.capabilityBinding.requiredState");
    fireEvent.click(
      within(detail).getByRole("button", {
        name: "agents.capabilityBinding.configure",
      }),
    );
    const bindingDialog = await screen.findByRole("dialog", {
      name: "agents.capabilityBinding.title",
    });
    fireEvent.change(
      within(bindingDialog).getByRole("combobox", { name: "private-docs" }),
      { target: { value: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" } },
    );
    fireEvent.click(
      within(bindingDialog).getByRole("button", {
        name: "agents.capabilityBinding.save",
      }),
    );

    await waitFor(() =>
      expect(api.confirmCapabilityBindings).toHaveBeenCalledWith({
        installationId: INSTALLATION_ID,
        mappingHandles: ["cccccccc-cccc-4ccc-8ccc-cccccccccccc"],
        confirmation: "bind-profile-capabilities",
      }),
    );
    expect(api.retryPendingInstallation).not.toHaveBeenCalled();
    expect(onAgentReady).toHaveBeenCalledWith(INSTALLATION_ID, {
      forceNewRun: true,
    });
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
    render(
      <AgentControlPanel
        profiles={[configuredModelProfile()]}
        modelProfileId="configured-source"
      />,
    );

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

  // @lat: [[agentera-agent-control-plane#AgentEra Agent control plane V1#Official Managed Agent V1#Catalog and detail presentation]]
  it("starts an official Agent with one click through prepare and confirm", async () => {
    const HANDLE_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const preview: OfficialAgentInstallPreview = {
      installHandle: HANDLE_ID,
      agent: officialAgent(),
      expiresAt: "2026-07-22T00:05:00.000Z",
    };
    const api = installAPI({
      listOfficialAgents: vi.fn(async () => success([officialAgent()])),
      prepareOfficialInstall: vi.fn(async () => success(preview)),
      confirmOfficialInstall: vi.fn(async () =>
        success(officialInstallation()),
      ),
    });
    const onProfilesChanged = vi.fn(async () => undefined);
    const onAgentReady = vi.fn(async () => true);

    render(
      <AgentControlPanel
        profiles={[]}
        initialTab="official"
        onProfilesChanged={onProfilesChanged}
        onAgentReady={onAgentReady}
      />,
    );

    fireEvent.click(
      (await screen.findByText("Official Research Agent")).closest("button")!,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "agents.hub.installAgent" }),
    );

    await waitFor(() =>
      expect(api.prepareOfficialInstall).toHaveBeenCalledWith(DEFINITION_ID),
    );
    await waitFor(() =>
      expect(api.confirmOfficialInstall).toHaveBeenCalledWith({
        installHandle: HANDLE_ID,
        confirmation: "install-official-agent",
      }),
    );
    expect(onProfilesChanged).toHaveBeenCalledOnce();
    expect(onAgentReady).toHaveBeenCalledWith(INSTALLATION_ID);
    expect(
      screen.queryByRole("dialog", {
        name: "agents.control.official.installTitle",
      }),
    ).toBeNull();
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
      <AgentControlPanel
        profiles={[configuredModelProfile("default")]}
        modelProfileId="default"
      />,
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
      render(
        <AgentControlPanel
          profiles={[configuredModelProfile()]}
          modelProfileId="configured-source"
          advancedOpenByDefault={history}
        />,
      );

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
      expect(
        api.listDrafts.mock.calls.some(([scope]) => scope === undefined),
      ).toBe(author);
      expect(api.listOrganizationSubmissionList.mock.calls.length > 0).toBe(
        history,
      );
    },
  );

  // @lat: [[agentera-agent-control-plane#Release gate#Organization Agent isolation#Single-list renderer ownership]]
  it("lists once and renders one warning on only the quarantined card", async () => {
    const healthySubmission: OrganizationAgentSubmissionListItem = {
      ...organizationSubmission("pending"),
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
      contentDigest: `sha256:${"b".repeat(64)}`,
      localDraftId: null,
      localDraftRevision: null,
      referenceState: { kind: "remote_only" },
    };
    const quarantinedSubmission: OrganizationAgentSubmissionListItem = {
      ...organizationSubmission("pending"),
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
      contentDigest: `sha256:${"c".repeat(64)}`,
      localDraftId: null,
      localDraftRevision: null,
      referenceState: {
        kind: "quarantined",
        stage: "content_digest",
      },
    };
    const api = installAPI({
      getState: vi.fn(async () =>
        success(
          controlState({
            scope: "ORGANIZATION",
            organizationId: ORGANIZATION_ID,
            role: "owner",
          }),
        ),
      ),
      listOrganizationSubmissionList: vi.fn(async () =>
        success(
          organizationSubmissionList([
            healthySubmission,
            quarantinedSubmission,
          ]),
        ),
      ),
    });

    render(
      <AgentControlPanel
        profiles={[]}
        initialTab="enterprise"
        advancedOpenByDefault
      />,
    );

    expect(
      await screen.findByText(healthySubmission.contentDigest),
    ).toBeVisible();
    expect(screen.getByText(quarantinedSubmission.contentDigest)).toBeVisible();
    expect(
      screen.getAllByText("agents.control.organization.referenceConflict"),
    ).toHaveLength(1);
    expect(
      screen.getByTestId(
        `submission-reference-conflict:${quarantinedSubmission.id}`,
      ),
    ).toBeVisible();
    expect(api.listOrganizationSubmissionList).toHaveBeenCalledTimes(1);
    expect(api.listOrganizationSubmissions).not.toHaveBeenCalled();
  });

  it("disconnects one quarantined card without issuing another list request", async () => {
    const quarantinedSubmission: OrganizationAgentSubmissionListItem = {
      ...organizationSubmission("approved"),
      localDraftId: null,
      localDraftRevision: null,
      referenceState: {
        kind: "quarantined",
        stage: "published_version",
      },
    };
    const remoteOnlySubmission: OrganizationAgentSubmissionListItem = {
      ...quarantinedSubmission,
      referenceState: { kind: "remote_only" },
    };
    const api = installAPI({
      getState: vi.fn(async () =>
        success(
          controlState({
            scope: "ORGANIZATION",
            organizationId: ORGANIZATION_ID,
            role: "owner",
          }),
        ),
      ),
      listOrganizationSubmissionList: vi.fn(async () =>
        success(organizationSubmissionList([quarantinedSubmission])),
      ),
      disconnectOrganizationSubmissionReference: vi.fn(async () =>
        success(remoteOnlySubmission),
      ),
    });

    render(
      <AgentControlPanel
        profiles={[]}
        initialTab="enterprise"
        advancedOpenByDefault
      />,
    );

    expect(
      await screen.findByTestId(
        `submission-reference-conflict:${quarantinedSubmission.id}`,
      ),
    ).toBeVisible();
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

    await waitFor(() =>
      expect(
        api.disconnectOrganizationSubmissionReference,
      ).toHaveBeenCalledWith({
        submissionId: quarantinedSubmission.id,
        confirmation: "disconnect-local-draft-link",
      }),
    );
    await waitFor(() =>
      expect(
        screen.queryByTestId(
          `submission-reference-conflict:${quarantinedSubmission.id}`,
        ),
      ).toBeNull(),
    );
    expect(api.listOrganizationSubmissionList).toHaveBeenCalledTimes(1);
  });

  // @lat: [[agentera-agent-control-plane#Trusted Workspace Agent context#Context-only refresh#Independent catalog reads]]
  it("keeps successful Organization definitions visible when submission history fails", async () => {
    const api = installAPI({
      getState: vi.fn(async () =>
        success(
          controlState({
            scope: "ORGANIZATION",
            organizationId: ORGANIZATION_ID,
            role: "owner",
          }),
        ),
      ),
      listOrganizationSubmissionList: vi.fn(async () => ({
        ok: false as const,
        errorCode: "cloud_unavailable" as const,
      })),
      listDefinitions: vi.fn(async () => success([definition()])),
    });

    render(
      <AgentControlPanel
        profiles={[]}
        initialTab="enterprise"
        advancedOpenByDefault={false}
      />,
    );

    expect(await screen.findByText("Research Agent")).toBeVisible();
    expect(
      screen.getByText("agents.control.errors.cloud_unavailable"),
    ).toBeVisible();
    expect(api.listDefinitions).toHaveBeenCalledTimes(1);
  });

  it("reconciles Organization submissions before drafts and renders one dirty published card", async () => {
    const dirtyDraft = {
      ...publishedDraft(),
      revision: 2,
      updatedAt: "2026-07-21T03:00:00.000Z",
    };
    const api = installAPI({
      getState: vi.fn(async () =>
        success(
          controlState({
            scope: "ORGANIZATION",
            organizationId: ORGANIZATION_ID,
            role: "owner",
          }),
        ),
      ),
      listOrganizationSubmissionList: vi.fn(async () =>
        success(
          organizationSubmissionList([organizationSubmission("approved")]),
        ),
      ),
      listDrafts: vi.fn(async () => success([dirtyDraft as AgentDraft])),
      listDefinitions: vi.fn(async () => success([definition()])),
    });

    render(
      <AgentControlPanel
        profiles={[]}
        initialTab="enterprise"
        advancedOpenByDefault={false}
      />,
    );

    const grid = await screen.findByTestId("personal-agent-grid");
    expect(within(grid).getAllByText("Research Agent")).toHaveLength(1);
    expect(
      within(grid).getByText(
        "agents.control.organization.lifecycle.approvedDirty",
      ),
    ).toBeVisible();
    expect(
      api.listOrganizationSubmissionList.mock.invocationCallOrder[0],
    ).toBeLessThan(api.listDrafts.mock.invocationCallOrder[0]);
  });

  it("deletes only a local Organization draft after its own confirmation", async () => {
    const api = installAPI({
      getState: vi.fn(async () =>
        success(
          controlState({
            scope: "ORGANIZATION",
            organizationId: ORGANIZATION_ID,
            role: "owner",
          }),
        ),
      ),
      listOrganizationSubmissionList: vi.fn(async () =>
        success(organizationSubmissionList()),
      ),
      listDrafts: vi.fn(async () => success([draft() as AgentDraft])),
      listDefinitions: vi.fn(async () => success([])),
      deleteDraft: vi.fn(async () => success(true as const)),
    });

    render(
      <AgentControlPanel
        profiles={[]}
        initialTab="enterprise"
        advancedOpenByDefault={false}
      />,
    );

    fireEvent.click(
      (await screen.findByText("Workspace Research Agent")).closest("button")!,
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "agents.control.organization.deleteDraft",
      }),
    );
    expect(
      screen.getByRole("dialog", {
        name: "agents.control.organization.deleteDraftTitle",
      }),
    ).toHaveTextContent("agents.control.organization.deleteDraftBoundary");
    expect(api.deleteDraft).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", {
        name: "agents.control.organization.confirmDeleteDraft",
      }),
    );
    await waitFor(() => expect(api.deleteDraft).toHaveBeenCalledWith(DRAFT_ID));
    expect(api.archiveInstallation).not.toHaveBeenCalled();
    expect(api.discardUnpublishedDraft).not.toHaveBeenCalled();
  });

  it("discards only unpublished edits from a dirty published card", async () => {
    const dirtyDraft = { ...publishedDraft(), revision: 2 };
    const api = installAPI({
      getState: vi.fn(async () =>
        success(
          controlState({
            scope: "ORGANIZATION",
            organizationId: ORGANIZATION_ID,
            role: "owner",
          }),
        ),
      ),
      listOrganizationSubmissionList: vi.fn(async () =>
        success(
          organizationSubmissionList([organizationSubmission("approved")]),
        ),
      ),
      listDrafts: vi.fn(async () => success([dirtyDraft as AgentDraft])),
      discardUnpublishedDraft: vi.fn(async () => success(true as const)),
    });

    render(
      <AgentControlPanel
        profiles={[]}
        initialTab="enterprise"
        advancedOpenByDefault={false}
      />,
    );

    fireEvent.click(
      (await screen.findByText("Research Agent")).closest("button")!,
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "agents.control.organization.discardUnpublished",
      }),
    );
    expect(
      screen.getByRole("dialog", {
        name: "agents.control.organization.discardUnpublishedTitle",
      }),
    ).toHaveTextContent(
      "agents.control.organization.discardUnpublishedBoundary",
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "agents.control.organization.confirmDiscardUnpublished",
      }),
    );
    await waitFor(() =>
      expect(api.discardUnpublishedDraft).toHaveBeenCalledWith(DRAFT_ID),
    );
    expect(api.deleteDraft).not.toHaveBeenCalled();
    expect(api.archiveInstallation).not.toHaveBeenCalled();
  });

  it("withdraws a pending card without exposing draft deletion", async () => {
    const pending = organizationSubmission("pending");
    const withdrawn = {
      ...pending,
      status: "withdrawn" as const,
      terminalAt: "2026-07-21T02:00:00.000Z",
    };
    const api = installAPI({
      getState: vi.fn(async () =>
        success(
          controlState({
            scope: "ORGANIZATION",
            organizationId: ORGANIZATION_ID,
            role: "owner",
          }),
        ),
      ),
      listOrganizationSubmissionList: vi.fn(async () =>
        success(organizationSubmissionList([pending])),
      ),
      listDrafts: vi.fn(async () => success([draft() as AgentDraft])),
      listDefinitions: vi.fn(async () => success([])),
      prepareOrganizationWithdrawal: vi.fn(async () =>
        success({
          withdrawalHandle: "aaaaaaaa-8888-4888-8888-888888888888",
          submission: pending,
          revision: pending.revision,
          contentDigest: pending.contentDigest,
          expiresAt: "2026-07-21T02:00:00.000Z",
        }),
      ),
      confirmOrganizationWithdrawal: vi.fn(async () => success(withdrawn)),
    });

    render(
      <AgentControlPanel
        profiles={[]}
        initialTab="enterprise"
        advancedOpenByDefault={false}
      />,
    );

    fireEvent.click(
      (await screen.findByText("Workspace Research Agent")).closest("button")!,
    );
    expect(
      screen.queryByRole("button", {
        name: "agents.control.organization.deleteDraft",
      }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", {
        name: "agents.control.organization.withdraw",
      }),
    );
    expect(
      await screen.findByRole("dialog", {
        name: "agents.control.organization.withdraw",
      }),
    ).toHaveTextContent("agents.control.organization.withdrawalBoundary");
    fireEvent.click(
      screen.getByRole("button", {
        name: "agents.control.organization.confirmWithdrawal",
      }),
    );
    await waitFor(() =>
      expect(api.confirmOrganizationWithdrawal).toHaveBeenCalledWith({
        withdrawalHandle: "aaaaaaaa-8888-4888-8888-888888888888",
        confirmation: "withdraw-organization-agent",
      }),
    );
    expect(api.deleteDraft).not.toHaveBeenCalled();
    expect(api.discardUnpublishedDraft).not.toHaveBeenCalled();
  });

  it("keeps the selected Organization while My Agents explicitly operates on USER assets", async () => {
    const context: AgenteraAgentControlPublicState["context"] = {
      scope: "ORGANIZATION",
      organizationId: ORGANIZATION_ID,
      role: "member",
    };
    const api = installAPI({
      getState: vi.fn(async () => success(controlState(context))),
    });
    const select = vi.fn();
    Object.defineProperty(window, "agenteraProductSpace", {
      configurable: true,
      value: { select },
    });

    render(
      <AgentControlPanel
        profiles={[configuredModelProfile()]}
        initialTab="mine"
        modelProfileId="configured-source"
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", {
        name: "agents.control.newAgent",
      }),
    );

    expect(select).not.toHaveBeenCalled();
    expect(api.getState).toHaveBeenCalledTimes(1);
    expect(api.listDrafts).toHaveBeenCalledWith("USER");
    expect(api.listDefinitions).toHaveBeenCalledWith("USER");
    expect(api.listInstallations).toHaveBeenCalledWith("USER");
    expect(
      await screen.findByRole("dialog", {
        name: "agents.control.newDraftTitle",
      }),
    ).toBeInTheDocument();
  });

  it("installs a Chinese-named personal Agent with a valid private Runtime profile id", async () => {
    const chineseDraft = {
      ...publishedDraft(),
      displayName: "小助理",
    };
    const api = installAPI({
      getState: vi.fn(async () =>
        success(
          controlState({
            scope: "ORGANIZATION",
            organizationId: ORGANIZATION_ID,
            role: "member",
          }),
        ),
      ),
      listDrafts: vi.fn(async () => success([chineseDraft as AgentDraft])),
      listDefinitions: vi.fn(async () => success([])),
      installVersion: vi.fn(async () => success(installation("active"))),
    });
    render(
      <AgentControlPanel
        profiles={[configuredModelProfile()]}
        initialTab="mine"
        modelProfileId="configured-source"
      />,
    );

    fireEvent.click((await screen.findByText("小助理")).closest("button")!);
    fireEvent.click(
      screen.getByRole("button", {
        name: "agents.hub.useAgent",
      }),
    );
    expect(
      screen.queryByRole("dialog", {
        name: "agents.hub.chooseRuntimeModel",
      }),
    ).toBeNull();

    await waitFor(() =>
      expect(api.installVersion).toHaveBeenCalledWith(
        {
          definitionId: DEFINITION_ID,
          versionId: VERSION_ID,
          profileName: "aera-agent-11111111-111",
          modelProfileId: "configured-source",
        },
        "USER",
      ),
    );
    expect(api.installVersion.mock.calls[0]?.[0]?.profileName).toMatch(
      /^[a-z0-9_][a-z0-9_-]{0,63}$/,
    );
  });

  it("installs with the exact live model route selected at use time", async () => {
    const api = installAPI({
      listDrafts: vi.fn(async () => success([publishedDraft() as AgentDraft])),
      listDefinitions: vi.fn(async () => success([])),
      installVersion: vi.fn(async () => success(installation("active"))),
    });
    const selectedLibraryId = "55555555-5555-4555-8555-555555555555";
    const selectedRouteId = ["account-home", selectedLibraryId].join("\0");
    const yunduRouteId = [
      "account-home",
      "66666666-6666-4666-8666-666666666666",
    ].join("\0");
    render(
      <AgentControlPanel
        profiles={[configuredModelProfile("account-home")]}
        modelProfileId="account-home"
        runtimeModelRoutes={[
          {
            id: selectedRouteId,
            sourceProfileId: "account-home",
            modelLibraryId: selectedLibraryId,
            provider: "custom:petoi",
            providerLabel: "Petoi",
            model: "gpt-5.6-sol",
            displayName: "GPT 5.6",
            baseUrl: "https://api.petoi.cn/v1",
            sourceKind: "account",
            selection: {
              sourceProfileId: "account-home",
              modelLibraryId: selectedLibraryId,
              catalogRevision: CATALOG_REVISION,
            },
          },
          {
            id: yunduRouteId,
            sourceProfileId: "account-home",
            modelLibraryId: "66666666-6666-4666-8666-666666666666",
            provider: "custom:yundu.lat",
            providerLabel: "yundu.lat",
            model: "claude-sonnet-4-6",
            displayName: "Claude Sonnet",
            baseUrl: "https://yundu.lat/v1",
            sourceKind: "account",
            selection: {
              sourceProfileId: "account-home",
              modelLibraryId: "66666666-6666-4666-8666-666666666666",
              catalogRevision: CATALOG_REVISION,
            },
          },
        ]}
      />,
    );

    fireEvent.click(
      (await screen.findByText("Workspace Research Agent")).closest("button")!,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "agents.hub.useAgent" }),
    );
    expect(
      screen.queryByRole("dialog", {
        name: "agents.hub.chooseRuntimeModel",
      }),
    ).toBeNull();

    await waitFor(() =>
      expect(api.installVersion).toHaveBeenCalledWith(
        {
          definitionId: DEFINITION_ID,
          versionId: VERSION_ID,
          profileName: "aera-agent-11111111-111",
          modelSelection: {
            sourceProfileId: "account-home",
            modelLibraryId: selectedLibraryId,
            catalogRevision: CATALOG_REVISION,
          },
        },
        undefined,
      ),
    );
  });

  it("uses the visible preferred route at the moment the Agent is started", async () => {
    const api = installAPI({
      listDrafts: vi.fn(async () => success([publishedDraft() as AgentDraft])),
      listDefinitions: vi.fn(async () => success([])),
      installVersion: vi.fn(async () => success(installation("active"))),
    });
    const originalLibraryId = "55555555-5555-4555-8555-555555555555";
    const replacementLibraryId = "77777777-5555-4555-8555-555555555555";
    const route = (modelLibraryId: string): AgentRuntimeModelRouteSource => ({
      id: ["account-home", modelLibraryId].join("\0"),
      sourceProfileId: "account-home",
      modelLibraryId,
      provider: "custom:petoi",
      providerLabel: "Petoi",
      model: "gpt-5.6-sol",
      displayName: "GPT 5.6",
      baseUrl: "https://api.petoi.cn/v1",
      // The catalog revision is carried alongside the legacy route fields in
      // this focused fixture to prove the renderer forwards the full handle.
      selection: {
        sourceProfileId: "account-home",
        modelLibraryId,
        catalogRevision: CATALOG_REVISION,
      },
    });
    const renderPanel = (modelLibraryId: string): React.JSX.Element => (
      <AgentControlPanel
        profiles={[configuredModelProfile("account-home")]}
        modelProfileId="account-home"
        runtimeModelRoutes={[route(modelLibraryId)]}
      />
    );
    const view = render(renderPanel(originalLibraryId));

    fireEvent.click(
      (await screen.findByText("Workspace Research Agent")).closest("button")!,
    );
    view.rerender(renderPanel(replacementLibraryId));
    fireEvent.click(
      screen.getByRole("button", { name: "agents.hub.useAgent" }),
    );
    expect(
      screen.queryByRole("dialog", {
        name: "agents.hub.chooseRuntimeModel",
      }),
    ).toBeNull();

    await waitFor(() =>
      expect(api.installVersion).toHaveBeenCalledWith(
        {
          definitionId: DEFINITION_ID,
          versionId: VERSION_ID,
          profileName: "aera-agent-11111111-111",
          modelSelection: {
            sourceProfileId: "account-home",
            modelLibraryId: replacementLibraryId,
            catalogRevision: CATALOG_REVISION,
          },
        },
        undefined,
      ),
    );
  });

  it("repairs an active unconfigured personal Agent from the current owner's model before opening chat", async () => {
    const context: AgenteraAgentControlPublicState["context"] = {
      scope: "ORGANIZATION",
      organizationId: ORGANIZATION_ID,
      role: "owner",
    };
    const activeInstallation = installation("active");
    const api = installAPI({
      getState: vi.fn(async () => success(controlState(context))),
      listInstallations: vi.fn(async () => success([activeInstallation])),
      repairInstallationModel: vi.fn(async () => success(activeInstallation)),
    });
    const onProfilesChanged = vi.fn(async () => undefined);
    const onChatWithProfile = vi.fn();
    render(
      <AgentControlPanel
        profiles={[
          {
            id: "installed-agent",
            name: "Research Agent",
            provider: "auto",
            model: "",
            agentInstallationId: INSTALLATION_ID,
          },
          configuredModelProfile(),
        ]}
        modelProfileId="configured-source"
        onProfilesChanged={onProfilesChanged}
        onChatWithProfile={onChatWithProfile}
      />,
    );

    fireEvent.click(
      (await screen.findByText("Research Agent")).closest("button")!,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "agents.hub.useAgent" }),
    );

    await waitFor(() =>
      expect(api.repairInstallationModel).toHaveBeenCalledWith(
        {
          id: INSTALLATION_ID,
          localProfileId: "installed-agent",
          modelProfileId: "configured-source",
        },
        "USER",
      ),
    );
    expect(onProfilesChanged).toHaveBeenCalledOnce();
    expect(onChatWithProfile).toHaveBeenCalledWith("installed-agent", {
      forceNewRun: true,
    });
  });

  it("opens an already configured active Agent without repairing the global model", async () => {
    const activeInstallation = installation("active");
    const api = installAPI({
      listInstallations: vi.fn(async () => success([activeInstallation])),
    });
    const onChatWithProfile = vi.fn();
    render(
      <AgentControlPanel
        profiles={[
          {
            id: "installed-agent",
            name: "Research Agent",
            provider: "custom:petoi",
            model: "gpt-5.6-sol",
            agentInstallationId: INSTALLATION_ID,
          },
          configuredModelProfile(),
        ]}
        modelProfileId="configured-source"
        onChatWithProfile={onChatWithProfile}
      />,
    );

    fireEvent.click(
      (await screen.findByText("Research Agent")).closest("button")!,
    );
    const detailDialog = screen.getByRole("dialog", {
      name: "Research Agent",
    });
    fireEvent.click(
      within(detailDialog).getByRole("button", {
        name: "agents.hub.useAgent",
      }),
    );

    await waitFor(() =>
      expect(onChatWithProfile).toHaveBeenCalledWith("installed-agent"),
    );
    expect(api.repairInstallationModel).not.toHaveBeenCalled();
  });

  it("keeps an active user's Agent model when selecting a new published version", async () => {
    const activeInstallation = installation("active");
    const updatedInstallation = {
      ...activeInstallation,
      selectedVersionId: NEXT_VERSION_ID,
    };
    const api = installAPI({
      listDefinitions: vi.fn(async () =>
        success([{ ...definition(), latestVersionId: NEXT_VERSION_ID }]),
      ),
      listInstallations: vi.fn(async () => success([activeInstallation])),
      selectInstallationVersion: vi.fn(async () =>
        success(updatedInstallation),
      ),
      repairInstallationModel: vi.fn(async () => success(updatedInstallation)),
    });
    const onChatWithProfile = vi.fn();
    render(
      <AgentControlPanel
        profiles={[
          {
            id: "installed-agent",
            name: "Research Agent",
            provider: "custom:petoi",
            model: "gpt-5.6-sol",
            agentInstallationId: INSTALLATION_ID,
          },
          configuredModelProfile(),
        ]}
        modelProfileId="configured-source"
        onChatWithProfile={onChatWithProfile}
      />,
    );

    fireEvent.click(
      (await screen.findByText("Research Agent")).closest("button")!,
    );
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "Research Agent" })).getByRole(
        "button",
        { name: "agents.hub.useAgent" },
      ),
    );

    await waitFor(() =>
      expect(api.selectInstallationVersion).toHaveBeenCalled(),
    );
    expect(api.repairInstallationModel).toHaveBeenCalledWith(
      {
        id: INSTALLATION_ID,
        localProfileId: "installed-agent",
        modelProfileId: "installed-agent",
      },
      undefined,
    );
    expect(onChatWithProfile).toHaveBeenCalledWith("installed-agent", {
      forceNewRun: true,
    });
  });

  it("revalidates an active shared Agent with the model chosen for this new run", async () => {
    const context: AgenteraAgentControlPublicState["context"] = {
      scope: "ORGANIZATION",
      organizationId: ORGANIZATION_ID,
      role: "owner",
    };
    const activeInstallation = {
      ...installation("active"),
      sourceScope: "ORGANIZATION" as const,
    };
    const api = installAPI({
      getState: vi.fn(async () => success(controlState(context))),
      listInstallations: vi.fn(async () => success([activeInstallation])),
      repairInstallationModel: vi.fn(async () => success(activeInstallation)),
    });
    const onChatWithProfile = vi.fn();
    render(
      <AgentControlPanel
        profiles={[
          {
            id: "installed-agent",
            name: "Research Agent",
            provider: "custom:yundu.lat",
            model: "claude-opus-4-6",
            agentInstallationId: INSTALLATION_ID,
          },
        ]}
        runtimeModelRoutes={[
          {
            id: "petoi-route",
            sourceProfileId: "account-home",
            modelLibraryId: "66666666-6666-4666-8666-666666666666",
            provider: "custom:petoi",
            providerLabel: "Petoi",
            model: "gpt-5.6-sol",
            displayName: "gpt-5.6-sol",
            baseUrl: "https://api.petoi.cn/v1",
            sourceKind: "account",
            selection: {
              sourceProfileId: "account-home",
              modelLibraryId: "66666666-6666-4666-8666-666666666666",
              catalogRevision: CATALOG_REVISION,
            },
          },
        ]}
        onChatWithProfile={onChatWithProfile}
      />,
    );

    fireEvent.click(
      await screen.findByRole("tab", { name: "agents.hub.enterpriseTab" }),
    );
    fireEvent.click(
      (await screen.findByText("Research Agent")).closest("button")!,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "agents.hub.useAgent" }),
    );

    expect(onChatWithProfile).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(api.repairInstallationModel).toHaveBeenCalledWith(
        {
          id: INSTALLATION_ID,
          localProfileId: "installed-agent",
          modelSelection: {
            sourceProfileId: "account-home",
            modelLibraryId: "66666666-6666-4666-8666-666666666666",
            catalogRevision: CATALOG_REVISION,
          },
        },
        undefined,
      ),
    );
    expect(onChatWithProfile).toHaveBeenCalledWith("installed-agent", {
      forceNewRun: true,
    });
  });

  it("repairs a published Agent with the user's selected model even when its legacy signature names another model", async () => {
    const activeInstallation = installation("active");
    const incompatibleDraft = publishedDraft();
    const api = installAPI({
      listDrafts: vi.fn(async () => success([incompatibleDraft as AgentDraft])),
      getDraft: vi.fn(async () => success(incompatibleDraft)),
      listInstallations: vi.fn(async () => success([activeInstallation])),
      repairInstallationModel: vi.fn(async () => success(activeInstallation)),
    });
    render(
      <AgentControlPanel
        profiles={[
          {
            id: "installed-agent",
            name: "Research Agent",
            provider: "auto",
            model: "",
            agentInstallationId: INSTALLATION_ID,
          },
          {
            id: "configured-source",
            name: "Configured source",
            provider: "custom:aera-local",
            model: "aera-e2e-model",
          },
        ]}
        modelProfileId="configured-source"
      />,
    );

    fireEvent.click(
      (await screen.findByText("Research Agent")).closest("button")!,
    );
    const detailDialog = screen.getByRole("dialog", {
      name: "Research Agent",
    });
    fireEvent.click(
      within(detailDialog).getByRole("button", {
        name: "agents.hub.useAgent",
      }),
    );

    await waitFor(() =>
      expect(api.repairInstallationModel).toHaveBeenCalledWith(
        {
          id: INSTALLATION_ID,
          localProfileId: "installed-agent",
          modelProfileId: "configured-source",
        },
        undefined,
      ),
    );
    expect(api.getDraft).not.toHaveBeenCalled();
  });

  it("selects a compatible newly published version before repairing its existing Runtime Profile", async () => {
    const oldInstallation = installation("active");
    const updatedInstallation = {
      ...oldInstallation,
      selectedVersionId: NEXT_VERSION_ID,
    };
    const compatibleDraft = {
      ...publishedDraft(),
      baseAgentVersionId: NEXT_VERSION_ID,
      manifest: {
        ...publishedDraft().manifest,
        modelConstraints: {
          allowedProviders: ["custom:aera-local"],
          allowedModels: ["aera-e2e-model"],
        },
      },
      publishedRevision: {
        revision: 1,
        definitionId: DEFINITION_ID,
        versionId: NEXT_VERSION_ID,
      },
    };
    const calls: string[] = [];
    const api = installAPI({
      listDrafts: vi.fn(async () => success([compatibleDraft as AgentDraft])),
      listDefinitions: vi.fn(async () =>
        success([
          {
            ...definition(),
            latestVersionId: NEXT_VERSION_ID,
          },
        ]),
      ),
      listInstallations: vi.fn(async () => success([oldInstallation])),
      selectInstallationVersion: vi.fn(async () => {
        calls.push("select");
        return success(updatedInstallation);
      }),
      repairInstallationModel: vi.fn(async () => {
        calls.push("repair");
        return success(updatedInstallation);
      }),
    });
    const onProfilesChanged = vi.fn(async () => undefined);
    const onChatWithProfile = vi.fn();
    render(
      <AgentControlPanel
        profiles={[
          {
            id: "installed-agent",
            name: "Research Agent",
            provider: "auto",
            model: "",
            agentInstallationId: INSTALLATION_ID,
          },
          {
            id: "configured-source",
            name: "Configured source",
            provider: "custom:aera-local",
            model: "aera-e2e-model",
          },
        ]}
        modelProfileId="configured-source"
        onProfilesChanged={onProfilesChanged}
        onChatWithProfile={onChatWithProfile}
      />,
    );

    fireEvent.click(
      (await screen.findByText("Research Agent")).closest("button")!,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "agents.hub.useAgent" }),
    );

    await waitFor(() => expect(api.repairInstallationModel).toHaveBeenCalled());
    expect(calls).toEqual(["select", "repair"]);
    expect(api.selectInstallationVersion).toHaveBeenCalledWith(
      {
        id: INSTALLATION_ID,
        versionId: NEXT_VERSION_ID,
        localProfileId: "installed-agent",
      },
      undefined,
    );
    expect(onProfilesChanged).toHaveBeenCalledOnce();
    expect(onChatWithProfile).toHaveBeenCalledWith("installed-agent", {
      forceNewRun: true,
    });
  });

  it("updates from the active Agent Profile without reporting a self-repair conflict", async () => {
    const oldInstallation = installation("active");
    const updatedInstallation = {
      ...oldInstallation,
      selectedVersionId: NEXT_VERSION_ID,
    };
    const compatibleDraft = {
      ...publishedDraft(),
      baseAgentVersionId: NEXT_VERSION_ID,
      manifest: {
        ...publishedDraft().manifest,
        modelConstraints: {
          allowedProviders: ["custom:aera-local"],
          allowedModels: ["aera-e2e-model"],
        },
      },
      publishedRevision: {
        revision: 1,
        definitionId: DEFINITION_ID,
        versionId: NEXT_VERSION_ID,
      },
    };
    const api = installAPI({
      listDrafts: vi.fn(async () => success([compatibleDraft as AgentDraft])),
      listDefinitions: vi.fn(async () =>
        success([
          {
            ...definition(),
            latestVersionId: NEXT_VERSION_ID,
          },
        ]),
      ),
      listInstallations: vi.fn(async () => success([oldInstallation])),
      selectInstallationVersion: vi.fn(async () =>
        success(updatedInstallation),
      ),
      repairInstallationModel: vi.fn(async () => success(updatedInstallation)),
    });
    const onChatWithProfile = vi.fn();
    render(
      <AgentControlPanel
        profiles={[
          {
            id: "installed-agent",
            name: "Research Agent",
            provider: "custom:aera-local",
            model: "aera-e2e-model",
            agentInstallationId: INSTALLATION_ID,
          },
        ]}
        modelProfileId="installed-agent"
        onChatWithProfile={onChatWithProfile}
      />,
    );

    fireEvent.click(
      (await screen.findByText("Research Agent")).closest("button")!,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "agents.hub.useAgent" }),
    );

    await waitFor(() => expect(api.repairInstallationModel).toHaveBeenCalled());
    expect(api.repairInstallationModel).toHaveBeenCalledWith(
      {
        id: INSTALLATION_ID,
        localProfileId: "installed-agent",
        modelProfileId: "installed-agent",
      },
      undefined,
    );
    expect(onChatWithProfile).toHaveBeenCalledWith("installed-agent", {
      forceNewRun: true,
    });
  });

  it("keeps a configured Runtime Profile route when selecting a new published version", async () => {
    const oldInstallation = installation("active");
    const updatedInstallation = {
      ...oldInstallation,
      selectedVersionId: NEXT_VERSION_ID,
    };
    const updatedDraft = {
      ...publishedDraft(),
      baseAgentVersionId: NEXT_VERSION_ID,
      manifest: {
        ...publishedDraft().manifest,
        modelConstraints: {
          allowedProviders: ["custom:aera-local"],
          allowedModels: ["aera-e2e-model"],
        },
      },
      publishedRevision: {
        revision: 1,
        definitionId: DEFINITION_ID,
        versionId: NEXT_VERSION_ID,
      },
    };
    const calls: string[] = [];
    const api = installAPI({
      listDrafts: vi.fn(async () => success([updatedDraft as AgentDraft])),
      listDefinitions: vi.fn(async () =>
        success([
          {
            ...definition(),
            latestVersionId: NEXT_VERSION_ID,
          },
        ]),
      ),
      listInstallations: vi.fn(async () => success([oldInstallation])),
      selectInstallationVersion: vi.fn(async () => {
        calls.push("select");
        return success(updatedInstallation);
      }),
      repairInstallationModel: vi.fn(async () => {
        calls.push("repair");
        return success(updatedInstallation);
      }),
    });
    const onChatWithProfile = vi.fn();
    render(
      <AgentControlPanel
        profiles={[
          {
            id: "configured-source",
            name: "Configured source",
            provider: "custom:aera-local",
            model: "aera-e2e-model",
          },
          {
            id: "installed-agent",
            name: "Research Agent",
            agentInstallationId: INSTALLATION_ID,
            provider: "openai",
            model: "gpt-5.6",
          },
        ]}
        modelProfileId="configured-source"
        onChatWithProfile={onChatWithProfile}
      />,
    );

    fireEvent.click(
      (await screen.findByText("Research Agent")).closest("button")!,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "agents.hub.useAgent" }),
    );

    await waitFor(() => expect(api.repairInstallationModel).toHaveBeenCalled());
    expect(calls).toEqual(["select", "repair"]);
    expect(api.repairInstallationModel).toHaveBeenCalledWith(
      {
        id: INSTALLATION_ID,
        localProfileId: "installed-agent",
        modelProfileId: "installed-agent",
      },
      undefined,
    );
    expect(onChatWithProfile).toHaveBeenCalledWith("installed-agent", {
      forceNewRun: true,
    });
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
    expect(api.listOrganizationSubmissionList).not.toHaveBeenCalled();
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
    render(<AgentControlPanel profiles={[]} advancedOpenByDefault />);

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

  // @lat: [[agentera-agent-control-plane#Trusted Workspace Agent context#Context-only refresh#Context change clearing]]
  it("clears stale Organization cards and role before the next peer read settles", async () => {
    let current = controlState({
      scope: "ORGANIZATION",
      organizationId: ORGANIZATION_ID,
      role: "owner",
    });
    let notify: (() => void) | null = null;
    let settleSecondSubmission:
      | ((
          result: AgenteraAgentControlResult<OrganizationAgentSubmissionList>,
        ) => void)
      | null = null;
    const api = installAPI({
      getState: vi.fn(async () => success(current)),
      listOrganizationSubmissionList: vi
        .fn()
        .mockResolvedValueOnce(success(organizationSubmissionList()))
        .mockImplementationOnce(
          () =>
            new Promise<
              AgenteraAgentControlResult<OrganizationAgentSubmissionList>
            >((resolve) => {
              settleSecondSubmission = resolve;
            }),
        ),
      listDefinitions: vi
        .fn()
        .mockResolvedValueOnce(success([definition()]))
        .mockResolvedValueOnce(success([])),
      onStateChanged: vi.fn((listener) => {
        notify = () => listener(current);
        return () => undefined;
      }),
    });
    render(
      <AgentControlPanel
        profiles={[]}
        initialTab="enterprise"
        advancedOpenByDefault={false}
      />,
    );

    expect(await screen.findByText("Research Agent")).toBeVisible();
    expect(
      screen.getByRole("button", {
        name: "agents.control.organization.newDraft",
      }),
    ).toBeVisible();

    current = controlState({
      scope: "ORGANIZATION",
      organizationId: NEXT_ORGANIZATION_ID,
      role: "auditor",
    });
    await act(async () => notify?.());
    await waitFor(() =>
      expect(api.listOrganizationSubmissionList).toHaveBeenCalledTimes(2),
    );

    expect(screen.queryByText("Research Agent")).toBeNull();
    expect(
      screen.queryByRole("button", {
        name: "agents.control.organization.newDraft",
      }),
    ).toBeNull();

    await act(async () =>
      settleSecondSubmission?.({
        ok: false,
        errorCode: "cloud_unavailable",
      }),
    );
    expect(
      await screen.findByText("agents.control.errors.cloud_unavailable"),
    ).toBeVisible();
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
        undefined,
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
    render(
      <AgentControlPanel
        profiles={[configuredModelProfile()]}
        modelProfileId="configured-source"
      />,
    );

    fireEvent.click(
      (await screen.findByText("Research Agent")).closest("button")!,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "agents.control.retryAgent" }),
    );
    await waitFor(() =>
      expect(api.retryPendingInstallation).toHaveBeenCalledWith(
        {
          id: INSTALLATION_ID,
          target: {
            kind: "fresh",
            profileName: "aera-agent-11111111-111",
            modelProfileId: "configured-source",
          },
        },
        undefined,
      ),
    );
    expect(
      screen.queryByRole("dialog", { name: "agents.control.retryTitle" }),
    ).toBeNull();
  });

  it("shows the signed model compatibility failure instead of claiming a pending Agent is usable", async () => {
    const modelMismatch = {
      ...installation("pending"),
      retryCode: "profile_model_configuration_failed",
    };
    const api = installAPI({
      listInstallations: vi.fn(async () => success([modelMismatch])),
      retryPendingInstallation: vi.fn(async () => ({
        ok: false as const,
        errorCode: "profile_model_configuration_failed" as const,
      })),
    });
    render(
      <AgentControlPanel
        profiles={[configuredModelProfile()]}
        modelProfileId="configured-source"
      />,
    );

    expect(
      await screen.findByText(
        "agents.hub.modelCompatibilityPendingCardDescription",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByText("agents.hub.publishedCardDescription"),
    ).toBeNull();

    fireEvent.click(screen.getByText("Research Agent").closest("button")!);
    fireEvent.click(
      screen.getByRole("button", { name: "agents.control.retryAgent" }),
    );

    expect(
      await screen.findByText(
        "agents.control.errors.profile_model_configuration_failed",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByText("agents.control.errors.operation_failed"),
    ).toBeNull();
    expect(api.retryPendingInstallation).toHaveBeenCalledOnce();
  });

  it("retries a pending Agent through its already prepared runtime instead of opening chat", async () => {
    const pendingWithProfile = {
      ...installation("pending"),
      runtimeProfileId: "44444444-4444-4444-8444-444444444444",
      retryCode: "activation_failed",
    };
    const api = installAPI({
      listInstallations: vi.fn(async () => success([pendingWithProfile])),
      retryPendingInstallation: vi.fn(async () =>
        success(installation("active")),
      ),
    });
    const onChatWithProfile = vi.fn();
    render(
      <AgentControlPanel
        profiles={[
          configuredModelProfile(),
          {
            id: "prepared-agent",
            name: "Research Agent",
            agentInstallationId: INSTALLATION_ID,
            provider: "openai",
            model: "gpt-5.6",
          },
        ]}
        modelProfileId="configured-source"
        onChatWithProfile={onChatWithProfile}
      />,
    );

    fireEvent.click(
      (await screen.findByText("Research Agent")).closest("button")!,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "agents.control.retryAgent" }),
    );

    await waitFor(() =>
      expect(api.retryPendingInstallation).toHaveBeenCalledWith(
        {
          id: INSTALLATION_ID,
          target: {
            kind: "claim",
            localProfileId: "prepared-agent",
            confirmation: "claim-existing-profile",
          },
        },
        undefined,
      ),
    );
    expect(api.installVersion).not.toHaveBeenCalled();
    expect(onChatWithProfile).not.toHaveBeenCalled();
  });

  it("activates an existing pending v1 runtime before selecting and re-seeding published v2", async () => {
    const pendingWithProfile = {
      ...installation("pending"),
      runtimeProfileId: "44444444-4444-4444-8444-444444444444",
      retryCode: "activation_failed",
    };
    const activeV1 = installation("active");
    const activeV2 = {
      ...activeV1,
      selectedVersionId: NEXT_VERSION_ID,
    };
    const calls: string[] = [];
    const api = installAPI({
      listDefinitions: vi.fn(async () =>
        success([
          {
            ...definition(),
            latestVersionId: NEXT_VERSION_ID,
          },
        ]),
      ),
      listInstallations: vi.fn(async () => success([pendingWithProfile])),
      retryPendingInstallation: vi.fn(async () => {
        calls.push("activate-v1");
        return success(activeV1);
      }),
      selectInstallationVersion: vi.fn(async () => {
        calls.push("select-v2");
        return success(activeV2);
      }),
      repairInstallationModel: vi.fn(async () => {
        calls.push("seed-v2");
        return success(activeV2);
      }),
    });
    const onAgentReady = vi.fn(async () => true);
    render(
      <AgentControlPanel
        profiles={[
          {
            id: "configured-source",
            name: "Configured source",
            provider: "custom:aera-local",
            model: "aera-e2e-model",
          },
          {
            id: "prepared-agent",
            name: "Research Agent",
            agentInstallationId: INSTALLATION_ID,
            provider: "openai",
            model: "gpt-5.6",
          },
        ]}
        modelProfileId="configured-source"
        onAgentReady={onAgentReady}
      />,
    );

    fireEvent.click(
      (await screen.findByText("Research Agent")).closest("button")!,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "agents.control.retryAgent" }),
    );

    await waitFor(() => expect(api.repairInstallationModel).toHaveBeenCalled());
    expect(calls).toEqual(["activate-v1", "select-v2", "seed-v2"]);
    expect(api.retryPendingInstallation).toHaveBeenCalledWith(
      {
        id: INSTALLATION_ID,
        target: {
          kind: "claim",
          localProfileId: "prepared-agent",
          confirmation: "claim-existing-profile",
        },
      },
      undefined,
    );
    expect(api.selectInstallationVersion).toHaveBeenCalledWith(
      {
        id: INSTALLATION_ID,
        versionId: NEXT_VERSION_ID,
        localProfileId: "prepared-agent",
      },
      undefined,
    );
    expect(api.repairInstallationModel).toHaveBeenCalledWith(
      {
        id: INSTALLATION_ID,
        localProfileId: "prepared-agent",
        modelProfileId: "configured-source",
      },
      undefined,
    );
    expect(onAgentReady).toHaveBeenCalledWith(INSTALLATION_ID, {
      forceNewRun: true,
    });
  });

  it("archives a profile-less pending v1 before installing a newly published v2", async () => {
    const calls: string[] = [];
    const oldPending = installation("pending");
    const archived = {
      ...oldPending,
      status: "archived" as const,
      retryCode: null,
    };
    const installed = {
      ...installation("active"),
      id: "bbbbbbbb-3333-4333-8333-333333333333",
      selectedVersionId: NEXT_VERSION_ID,
    };
    const api = installAPI({
      listDefinitions: vi.fn(async () =>
        success([
          {
            ...definition(),
            latestVersionId: NEXT_VERSION_ID,
          },
        ]),
      ),
      listInstallations: vi.fn(async () => success([oldPending])),
      archiveInstallation: vi.fn(async () => {
        calls.push("archive");
        return success(archived);
      }),
      installVersion: vi.fn(async () => {
        calls.push("install-v2");
        return success(installed);
      }),
    });
    const onAgentReady = vi.fn(async () => true);
    render(
      <AgentControlPanel
        profiles={[configuredModelProfile()]}
        modelProfileId="configured-source"
        onAgentReady={onAgentReady}
      />,
    );

    fireEvent.click(
      (await screen.findByText("Research Agent")).closest("button")!,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "agents.control.retryAgent" }),
    );

    await waitFor(() => expect(api.installVersion).toHaveBeenCalled());
    expect(calls).toEqual(["archive", "install-v2"]);
    expect(api.archiveInstallation).toHaveBeenCalledWith(
      INSTALLATION_ID,
      undefined,
    );
    expect(api.installVersion).toHaveBeenCalledWith(
      {
        definitionId: DEFINITION_ID,
        versionId: NEXT_VERSION_ID,
        profileName: "aera-agent-11111111-111",
        modelProfileId: "configured-source",
      },
      undefined,
    );
    expect(api.retryPendingInstallation).not.toHaveBeenCalled();
    expect(onAgentReady).toHaveBeenCalledWith(installed.id);
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
      expect(api.archiveInstallation).toHaveBeenCalledWith(
        INSTALLATION_ID,
        undefined,
      ),
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
