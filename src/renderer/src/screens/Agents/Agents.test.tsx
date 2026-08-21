import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type React from "react";
import { describe, expect, it, vi } from "vitest";
import type {
  AgenteraAgentDefinitionSummary,
  AgenteraAgentInstallationSummary,
} from "../../../../shared/agentera-agent-control";
import type { OwnerModelRouteCatalogSnapshot } from "../../../../shared/model-configuration";

vi.mock("../../components/useI18n", () => ({
  useI18n: () => ({
    t: (key: string): string => key,
  }),
}));

vi.mock("../../components/common/HermesLogo", () => ({
  default: (): React.JSX.Element => <div data-testid="hermes-logo" />,
}));

vi.mock("../../components/profile/ProfileModalContext", () => ({
  useProfileModal: () => ({
    openProfile: vi.fn(),
    closeProfile: vi.fn(),
  }),
}));

import Agents, { selectAgentModelProfileId } from "./Agents";

const DEFINITION_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const PREVIOUS_VERSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const INSTALLATION_ID = "33333333-3333-4333-8333-333333333333";

interface ProfileInfo {
  id: string;
  name: string;
  path: string;
  isDefault: boolean;
  isActive: boolean;
  model: string;
  provider: string;
  hasEnv: boolean;
  hasSoul: boolean;
  skillCount: number;
  gatewayRunning: boolean;
  agentInstallationId?: string | null;
  runtimeProfileId?: string | null;
}

function profile(
  id: string,
  options: {
    isDefault?: boolean;
    name?: string;
    agentInstallationId?: string | null;
  } = {},
): ProfileInfo {
  return {
    id,
    name: options.name ?? id,
    path: options.isDefault ? "C:/hermes" : `C:/hermes/profiles/${id}`,
    isDefault: options.isDefault ?? false,
    isActive: options.isDefault ?? false,
    model: "gpt-5.6-sol",
    provider: "custom",
    hasEnv: true,
    hasSoul: true,
    skillCount: 0,
    gatewayRunning: false,
    agentInstallationId: options.agentInstallationId ?? null,
    runtimeProfileId: null,
  };
}

function definition(): AgenteraAgentDefinitionSummary {
  return {
    id: DEFINITION_ID,
    displayName: "Research Agent",
    status: "active",
    latestVersionId: VERSION_ID,
    createdAt: "2026-07-29T00:00:00.000Z",
    updatedAt: "2026-07-29T00:00:00.000Z",
  };
}

function installation(): AgenteraAgentInstallationSummary {
  return {
    id: INSTALLATION_ID,
    sourceScope: "USER",
    officialReleaseId: null,
    selectedReleaseRevisionId: null,
    updatePolicy: "manual",
    definitionId: DEFINITION_ID,
    selectedVersionId: VERSION_ID,
    runtimeProfileId: "research-agent",
    policySnapshotId: "44444444-4444-4444-8444-444444444444",
    status: "active",
    retryCode: null,
    createdAt: "2026-07-29T00:00:00.000Z",
    updatedAt: "2026-07-29T00:00:00.000Z",
  };
}

function installHermesAPI(): {
  listProfiles: ReturnType<typeof vi.fn>;
  createProfile: ReturnType<typeof vi.fn>;
  setActiveProfile: ReturnType<typeof vi.fn>;
  emitModelLibraryChanged: () => void;
} {
  let modelLibraryChanged: (() => void) | null = null;
  const api = {
    listProfiles: vi.fn(),
    createProfile: vi.fn(),
    setActiveProfile: vi.fn(async () => true),
    getAgentSyncStatus: vi.fn(async () => ({
      signedIn: false,
      running: false,
      accountLabel: null,
      lastResult: null,
    })),
    syncAgents: vi.fn(),
    onAgentSyncUpdated: vi.fn(() => () => undefined),
    onModelLibraryChanged: vi.fn((callback: () => void) => {
      modelLibraryChanged = callback;
      return () => {
        modelLibraryChanged = null;
      };
    }),
    onCustomProvidersChanged: vi.fn(() => () => undefined),
    onConnectionConfigChanged: vi.fn(() => () => undefined),
  };
  Object.defineProperty(window, "hermesAPI", {
    configurable: true,
    value: api,
  });
  return {
    ...api,
    emitModelLibraryChanged: () => modelLibraryChanged?.(),
  };
}

function installAgenteraAPI(
  overrides: Partial<Window["agenteraAgents"]> = {},
): Window["agenteraAgents"] & {
  installVersion: ReturnType<typeof vi.fn>;
} {
  const api = {
    getState: vi.fn(async () => ({
      ok: true as const,
      data: {
        access: "online" as const,
        cloudAvailable: true,
        context: { scope: "USER" as const },
        draftCount: 0,
        installationCount: 0,
      },
    })),
    listDrafts: vi.fn(async () => ({ ok: true as const, data: [] })),
    getDraft: vi.fn(),
    createDraft: vi.fn(),
    updateDraft: vi.fn(),
    deleteDraft: vi.fn(),
    preparePublication: vi.fn(),
    confirmPublication: vi.fn(),
    prepareOrganizationSubmission: vi.fn(),
    confirmOrganizationSubmission: vi.fn(),
    listOrganizationSubmissions: vi.fn(async () => ({
      ok: true as const,
      data: [],
    })),
    getOrganizationSubmission: vi.fn(),
    prepareOrganizationReview: vi.fn(),
    confirmOrganizationReview: vi.fn(),
    prepareOrganizationWithdrawal: vi.fn(),
    confirmOrganizationWithdrawal: vi.fn(),
    listDefinitions: vi.fn(async () => ({ ok: true as const, data: [] })),
    listOfficialAgents: vi.fn(async () => ({ ok: true as const, data: [] })),
    getOfficialAgentDetail: vi.fn(),
    prepareOfficialInstall: vi.fn(),
    confirmOfficialInstall: vi.fn(),
    refreshOfficialUpdates: vi.fn(async () => ({
      ok: true as const,
      data: [],
    })),
    applyOfficialUpdate: vi.fn(),
    listVersions: vi.fn(async () => ({ ok: true as const, data: [] })),
    listInstallations: vi.fn(async () => ({
      ok: true as const,
      data: [],
    })),
    installVersion: vi.fn(),
    claimVersion: vi.fn(),
    retryPendingInstallation: vi.fn(),
    selectInstallationVersion: vi.fn(),
    repairInstallationModel: vi.fn(),
    archiveInstallation: vi.fn(),
    listEligibleExperienceSkills: vi.fn(async () => ({
      ok: true as const,
      data: [],
    })),
    prepareExperienceCandidate: vi.fn(),
    submitExperienceCandidate: vi.fn(),
    listMyExperienceCandidates: vi.fn(async () => ({
      ok: true as const,
      data: [],
    })),
    listExperienceReviewQueue: vi.fn(async () => ({
      ok: true as const,
      data: [],
    })),
    getExperienceCandidate: vi.fn(),
    reviewExperienceCandidate: vi.fn(),
    prepareExperienceCandidateImport: vi.fn(),
    confirmExperienceCandidateImport: vi.fn(),
    onStateChanged: vi.fn(() => () => undefined),
    ...overrides,
  } as unknown as Window["agenteraAgents"] & {
    installVersion: ReturnType<typeof vi.fn>;
  };
  Object.defineProperty(window, "agenteraAgents", {
    configurable: true,
    value: api,
  });
  return api;
}

describe("Agents unified product surface", () => {
  it("forwards the team task entry without invoking an Agent operation", async () => {
    const hermes = installHermesAPI();
    hermes.listProfiles.mockResolvedValue([]);
    const agentera = installAgenteraAPI();
    const onOpenTeams = vi.fn();
    render(
      <Agents
        activeProfile="default"
        onChatWith={vi.fn()}
        onOpenTeams={onOpenTeams}
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "agents.teams.startTask" }),
    );

    expect(onOpenTeams).toHaveBeenCalledOnce();
    expect(agentera.installVersion).not.toHaveBeenCalled();
    expect(hermes.setActiveProfile).not.toHaveBeenCalled();
  });

  // @lat: [[provider-setup#Owner-scoped model route catalog]]
  it("offers a model saved on the active installed Profile from the owner catalog", async () => {
    const hermes = installHermesAPI();
    const accountProfile = {
      ...profile("account", { isDefault: true, name: "Account" }),
      model: "old-model",
      provider: "openai",
    };
    const installedProfile = {
      ...profile("installed", {
        name: "Research Agent",
        agentInstallationId: INSTALLATION_ID,
      }),
      model: "",
      provider: "auto",
    };
    const modelLibraryId = "66666666-6666-4666-8666-666666666666";
    const catalog: OwnerModelRouteCatalogSnapshot = {
      revision: "a".repeat(64),
      targetProfileId: "account",
      routes: [
        {
          id: ["installed", modelLibraryId].join("\0"),
          provider: "custom:petoi",
          model: "new-model",
          baseUrl: "https://api.petoi.cn/v1",
          apiMode: "chat_completions",
          providerLabel: "Petoi",
          displayName: "New model",
          sourceProfileId: "installed",
          sourceKind: "legacy_agent",
          selection: {
            sourceProfileId: "installed",
            modelLibraryId,
            catalogRevision: "a".repeat(64),
          },
        },
      ],
    };
    Object.assign(window.hermesAPI, {
      getOwnerModelRouteCatalog: vi.fn(
        async (): Promise<OwnerModelRouteCatalogSnapshot> => catalog,
      ),
    });
    const agentera = installAgenteraAPI({
      listDefinitions: vi.fn(async () => ({
        ok: true as const,
        data: [definition()],
      })),
      listInstallations: vi.fn(async () => ({
        ok: true as const,
        data: [installation()],
      })),
      repairInstallationModel: vi.fn(async () => ({
        ok: true as const,
        data: installation(),
      })),
    });
    hermes.listProfiles.mockResolvedValue([accountProfile, installedProfile]);

    render(<Agents activeProfile="installed" onChatWith={vi.fn()} />);

    fireEvent.click(
      await screen.findByRole("tab", { name: "agents.hub.mineTab" }),
    );
    fireEvent.click(
      (await screen.findByText("Research Agent")).closest("button")!,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "agents.hub.useAgent" }),
    );

    expect(
      screen.queryByRole("dialog", {
        name: "agents.hub.chooseRuntimeModel",
      }),
    ).toBeNull();
    expect(screen.queryByText("agents.hub.modelRequired")).toBeNull();
    await waitFor(() =>
      expect(agentera.repairInstallationModel).toHaveBeenCalledWith(
        {
          id: INSTALLATION_ID,
          localProfileId: "installed",
          modelSelection: {
            sourceProfileId: "installed",
            modelLibraryId,
            catalogRevision: "a".repeat(64),
          },
        },
        undefined,
      ),
    );
  });

  it("uses the active configured Profile even when it belongs to an installed Agent", () => {
    const accountProfile = {
      ...profile("account-home", { name: "Account home" }),
      provider: "openai",
      model: "gpt-5.4",
    };
    const installedProfile = {
      ...profile("previous-agent", {
        agentInstallationId: INSTALLATION_ID,
      }),
      provider: "custom:gpt",
      model: "gpt-5.6-sol",
    };

    expect(
      selectAgentModelProfileId(
        [installedProfile, accountProfile],
        installedProfile.id,
      ),
    ).toBe(installedProfile.id);
  });

  it("prefers the active configured account Profile over another stale account Profile", () => {
    const staleDefault = {
      ...profile("default", { isDefault: true, name: "Default Agent" }),
      provider: "openai",
      model: "gpt-5.6",
    };
    const activeCustomProfile = profile("agent", {
      name: "Custom gateway",
    });

    expect(
      selectAgentModelProfileId(
        [staleDefault, activeCustomProfile],
        activeCustomProfile.id,
      ),
    ).toBe(activeCustomProfile.id);
  });

  it("reuses only the model route from a configured current-owner Agent when no account Profile is configured", () => {
    const installedProfile = profile("configured-agent", {
      agentInstallationId: INSTALLATION_ID,
    });

    expect(
      selectAgentModelProfileId([installedProfile], installedProfile.id),
    ).toBe(installedProfile.id);
  });

  it("shows and opens an existing local runtime only as an Agent", async () => {
    const hermes = installHermesAPI();
    installAgenteraAPI();
    hermes.listProfiles.mockResolvedValue([
      profile("default", { isDefault: true, name: "Default Agent" }),
    ]);
    const onChatWith = vi.fn();

    render(<Agents activeProfile="default" onChatWith={onChatWith} />);

    fireEvent.click(
      await screen.findByRole("tab", { name: "agents.hub.mineTab" }),
    );
    const grid = await screen.findByTestId("personal-agent-grid");
    fireEvent.click(within(grid).getByText("Default Agent").closest("button")!);
    fireEvent.click(
      screen.getByRole("button", { name: "agents.hub.useAgent" }),
    );

    await waitFor(() =>
      expect(hermes.setActiveProfile).toHaveBeenCalledWith("default"),
    );
    expect(onChatWith).toHaveBeenCalledWith("default");
    expect(hermes.createProfile).not.toHaveBeenCalled();
    expect(screen.queryByTestId("local-runtime-profiles")).toBeNull();
    expect(screen.queryByText("agents.legacyTitle")).toBeNull();
  });

  // @lat: [[agentera-agent-control-plane#AgentEra Agent control plane V1#Trusted Workspace Agent context#Product-facing Agent projection]]
  it("automatically prepares the local runtime and opens a newly used Agent", async () => {
    const hermes = installHermesAPI();
    const defaultProfile = profile("default", {
      isDefault: true,
      name: "Default Agent",
    });
    const installedProfile = profile("research-agent", {
      name: "Research Agent",
      agentInstallationId: INSTALLATION_ID,
    });
    hermes.listProfiles
      .mockResolvedValueOnce([defaultProfile])
      .mockResolvedValue([defaultProfile, installedProfile]);
    const agentera = installAgenteraAPI({
      listDefinitions: vi.fn(async () => ({
        ok: true as const,
        data: [definition()],
      })),
      installVersion: vi.fn(async () => ({
        ok: true as const,
        data: installation(),
      })),
    });
    const onChatWith = vi.fn();

    render(<Agents activeProfile="default" onChatWith={onChatWith} />);

    fireEvent.click(
      await screen.findByRole("tab", { name: "agents.hub.mineTab" }),
    );
    fireEvent.click(
      (await screen.findByText("Research Agent")).closest("button")!,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "agents.hub.useAgent" }),
    );

    await waitFor(() =>
      expect(agentera.installVersion).toHaveBeenCalledWith(
        {
          definitionId: DEFINITION_ID,
          versionId: VERSION_ID,
          profileName: "aera-agent-11111111-111",
          modelProfileId: "default",
        },
        undefined,
      ),
    );
    await waitFor(() =>
      expect(hermes.setActiveProfile).toHaveBeenCalledWith("research-agent"),
    );
    expect(onChatWith).toHaveBeenCalledWith("research-agent");
    expect(hermes.createProfile).not.toHaveBeenCalled();
  });

  it("starts a newly used Agent with the preferred model without asking the user to choose runtime details", async () => {
    const hermes = installHermesAPI();
    const defaultProfile = profile("default", {
      isDefault: true,
      name: "Default Agent",
    });
    const installedProfile = profile("research-agent", {
      name: "Research Agent",
      agentInstallationId: INSTALLATION_ID,
    });
    hermes.listProfiles
      .mockResolvedValueOnce([defaultProfile])
      .mockResolvedValue([defaultProfile, installedProfile]);
    const agentera = installAgenteraAPI({
      listDefinitions: vi.fn(async () => ({
        ok: true as const,
        data: [definition()],
      })),
      installVersion: vi.fn(async () => ({
        ok: true as const,
        data: installation(),
      })),
    });
    const onChatWith = vi.fn();

    render(<Agents activeProfile="default" onChatWith={onChatWith} />);

    fireEvent.click(
      await screen.findByRole("tab", { name: "agents.hub.mineTab" }),
    );
    fireEvent.click(
      (await screen.findByText("Research Agent")).closest("button")!,
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
      expect(agentera.installVersion).toHaveBeenCalledWith(
        {
          definitionId: DEFINITION_ID,
          versionId: VERSION_ID,
          profileName: "aera-agent-11111111-111",
          modelProfileId: "default",
        },
        undefined,
      ),
    );
    await waitFor(() =>
      expect(hermes.setActiveProfile).toHaveBeenCalledWith("research-agent"),
    );
    expect(onChatWith).toHaveBeenCalledWith("research-agent");
  });

  it("opens model configuration when an Agent cannot be started yet", async () => {
    const hermes = installHermesAPI();
    hermes.listProfiles.mockResolvedValue([
      {
        ...profile("default", {
          isDefault: true,
          name: "Default Agent",
        }),
        model: "",
        provider: "auto",
      },
    ]);
    const agentera = installAgenteraAPI({
      listDefinitions: vi.fn(async () => ({
        ok: true as const,
        data: [definition()],
      })),
    });
    const onConfigureModels = vi.fn();

    render(
      <Agents
        activeProfile="default"
        onChatWith={vi.fn()}
        onConfigureModels={onConfigureModels}
      />,
    );

    fireEvent.click(
      await screen.findByRole("tab", { name: "agents.hub.mineTab" }),
    );
    fireEvent.click(
      (await screen.findByText("Research Agent")).closest("button")!,
    );
    const configure = screen.getByRole("button", {
      name: "agents.hub.configureModel",
    });
    expect(configure).toBeEnabled();
    fireEvent.click(configure);

    expect(onConfigureModels).toHaveBeenCalledTimes(1);
    expect(agentera.installVersion).not.toHaveBeenCalled();
    expect(agentera.retryPendingInstallation).not.toHaveBeenCalled();
    expect(agentera.repairInstallationModel).not.toHaveBeenCalled();
  });

  it("forwards a forced fresh run after selecting a new version on the active Agent Profile", async () => {
    const hermes = installHermesAPI();
    const installedProfile = profile("research-agent", {
      name: "Research Agent",
      agentInstallationId: INSTALLATION_ID,
    });
    hermes.listProfiles.mockResolvedValue([installedProfile]);
    const oldInstallation = {
      ...installation(),
      selectedVersionId: PREVIOUS_VERSION_ID,
    };
    const updatedInstallation = installation();
    const repairInstallationModel = vi.fn(async () => ({
      ok: true as const,
      data: updatedInstallation,
    }));
    const agentera = installAgenteraAPI({
      listDefinitions: vi.fn(async () => ({
        ok: true as const,
        data: [definition()],
      })),
      listInstallations: vi.fn(async () => ({
        ok: true as const,
        data: [oldInstallation],
      })),
      selectInstallationVersion: vi.fn(async () => ({
        ok: true as const,
        data: updatedInstallation,
      })),
      repairInstallationModel,
    });
    const onChatWith = vi.fn();

    render(<Agents activeProfile="research-agent" onChatWith={onChatWith} />);

    fireEvent.click(
      await screen.findByRole("tab", { name: "agents.hub.mineTab" }),
    );
    fireEvent.click(
      (await screen.findByText("Research Agent")).closest("button")!,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "agents.hub.useAgent" }),
    );

    await waitFor(() => expect(repairInstallationModel).toHaveBeenCalled());
    expect(agentera.selectInstallationVersion).toHaveBeenCalledWith(
      {
        id: INSTALLATION_ID,
        versionId: VERSION_ID,
        localProfileId: "research-agent",
      },
      undefined,
    );
    expect(onChatWith).toHaveBeenCalledWith("research-agent", {
      forceNewRun: true,
    });
  });

  it("refreshes the Agent model source after the model library changes", async () => {
    const hermes = installHermesAPI();
    const unconfiguredDefault = {
      ...profile("default", {
        isDefault: true,
        name: "Default Agent",
      }),
      model: "",
      provider: "auto",
    };
    const configuredDefault = profile("default", {
      isDefault: true,
      name: "Default Agent",
    });
    hermes.listProfiles
      .mockResolvedValueOnce([unconfiguredDefault])
      .mockResolvedValue([configuredDefault]);
    const agentera = installAgenteraAPI({
      listDefinitions: vi.fn(async () => ({
        ok: true as const,
        data: [definition()],
      })),
      installVersion: vi.fn(async () => ({
        ok: true as const,
        data: installation(),
      })),
    });

    render(<Agents activeProfile="default" onChatWith={vi.fn()} />);

    await screen.findByText("Research Agent");
    await act(async () => {
      hermes.emitModelLibraryChanged();
    });

    await waitFor(() => expect(hermes.listProfiles).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByText("Research Agent").closest("button")!);
    fireEvent.click(
      screen.getByRole("button", { name: "agents.hub.useAgent" }),
    );

    await waitFor(() =>
      expect(agentera.installVersion).toHaveBeenCalledWith(
        {
          definitionId: DEFINITION_ID,
          versionId: VERSION_ID,
          profileName: "aera-agent-11111111-111",
          modelProfileId: "default",
        },
        undefined,
      ),
    );
  });
});
