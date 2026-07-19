import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type React from "react";
import { describe, expect, it, vi } from "vitest";
import type { AgentDraftDetail } from "../../../../shared/agentera-agent-control";

vi.mock("../../components/useI18n", () => ({
  useI18n: () => ({
    t: (key: string): string => key,
  }),
}));

vi.mock("../../components/common/HermesLogo", () => ({
  default: (): React.JSX.Element => <div data-testid="hermes-logo" />,
}));

// Agents reads the global profile modal via useProfileModal, which throws
// outside a ProfileModalProvider. These tests render Agents in isolation, so
// stub the hook with a no-op modal opener.
vi.mock("../../components/profile/ProfileModalContext", () => ({
  useProfileModal: () => ({
    openProfile: vi.fn(),
    closeProfile: vi.fn(),
  }),
}));

import Agents from "./Agents";

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
}

function profile(name: string, isDefault = false): ProfileInfo {
  return {
    id: name,
    name,
    path: isDefault ? "C:/hermes" : `C:/hermes/profiles/${name}`,
    isDefault,
    isActive: isDefault,
    model: "",
    provider: "auto",
    hasEnv: false,
    hasSoul: false,
    skillCount: 0,
    gatewayRunning: false,
  };
}

function installHermesAPI(): {
  listProfiles: ReturnType<typeof vi.fn>;
  createProfile: ReturnType<typeof vi.fn>;
  deleteProfile: ReturnType<typeof vi.fn>;
  setActiveProfile: ReturnType<typeof vi.fn>;
  getAgentSyncStatus: ReturnType<typeof vi.fn>;
  syncAgents: ReturnType<typeof vi.fn>;
} {
  const api = {
    listProfiles: vi.fn(),
    createProfile: vi.fn(),
    deleteProfile: vi.fn(),
    setActiveProfile: vi.fn(),
    getAgentSyncStatus: vi.fn(async () => ({
      signedIn: false,
      running: false,
      accountLabel: null,
      lastResult: null,
    })),
    syncAgents: vi.fn(),
  };
  Object.defineProperty(window, "hermesAPI", {
    configurable: true,
    value: api,
  });
  return api;
}

function localDraft(): AgentDraftDetail {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    sourceAgentDefinitionId: null,
    baseAgentVersionId: null,
    displayName: "Research Agent",
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
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:00.000Z",
    lastPublicationAttempt: null,
    publishedRevision: null,
  };
}

function installAgenteraAPI(): {
  createDraft: ReturnType<typeof vi.fn>;
} {
  const api = {
    getState: vi.fn(async () => ({
      ok: true as const,
      data: {
        access: "online" as const,
        cloudAvailable: true,
        draftCount: 0,
        installationCount: 0,
      },
    })),
    listDrafts: vi.fn(async () => ({ ok: true as const, data: [] })),
    getDraft: vi.fn(),
    createDraft: vi.fn(async () => ({
      ok: true as const,
      data: localDraft(),
    })),
    updateDraft: vi.fn(),
    deleteDraft: vi.fn(),
    preparePublication: vi.fn(),
    confirmPublication: vi.fn(),
    listDefinitions: vi.fn(async () => ({ ok: true as const, data: [] })),
    listVersions: vi.fn(),
    listInstallations: vi.fn(async () => ({ ok: true as const, data: [] })),
    installVersion: vi.fn(),
    claimVersion: vi.fn(),
    retryPendingInstallation: vi.fn(),
    selectInstallationVersion: vi.fn(),
    archiveInstallation: vi.fn(),
    onStateChanged: vi.fn(() => () => undefined),
  };
  Object.defineProperty(window, "agenteraAgents", {
    configurable: true,
    value: api,
  });
  return api;
}

describe("Agents profile creation", () => {
  it("refreshes profiles after a failed create so ambiguous successes appear", async () => {
    const api = installHermesAPI();
    installAgenteraAPI();
    api.listProfiles
      .mockResolvedValueOnce([profile("default", true)])
      .mockResolvedValueOnce([profile("default", true), profile("test2")]);
    api.createProfile.mockResolvedValue({
      success: false,
      error:
        "Error: Profile 'test2' already exists at C:/hermes/profiles/test2",
    });

    render(
      <Agents
        activeProfile="default"
        onSelectProfile={() => {}}
        onChatWith={() => {}}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("default")).toBeTruthy();
    });

    fireEvent.click(screen.getByText("agents.legacyNewProfile"));
    fireEvent.change(screen.getByPlaceholderText("agents.namePlaceholder"), {
      target: { value: "test2" },
    });
    fireEvent.click(screen.getByText("agents.create"));

    expect(api.createProfile).toHaveBeenCalledWith("test2", "default");

    // The create modal stays open on failure (so the user can retry), and its
    // clone-from <select> also lists profiles — so "test2" can appear both as
    // an <option> and as the refreshed table row. Assert it shows up at all.
    await waitFor(() => {
      expect(screen.getAllByText("test2").length).toBeGreaterThan(0);
    });
    expect(screen.getByText(/already exists/)).toBeTruthy();
    expect(api.listProfiles).toHaveBeenCalledTimes(2);
  });

  it("keeps AgentEra actions on the new namespace and legacy Hermes One controls separate", async () => {
    const hermes = installHermesAPI();
    const agentera = installAgenteraAPI();
    hermes.listProfiles.mockResolvedValue([profile("default", true)]);

    render(
      <Agents
        activeProfile="default"
        onSelectProfile={() => {}}
        onChatWith={() => {}}
      />,
    );

    expect(
      await screen.findByText("agents.control.personalSpaceTitle"),
    ).toBeTruthy();
    expect(screen.getByText("agents.legacyTitle")).toBeTruthy();
    expect(screen.getByText("agents.legacyAccountSyncLabel")).toBeTruthy();
    const syncStatusCalls = hermes.getAgentSyncStatus.mock.calls.length;

    fireEvent.click(
      screen.getByRole("button", { name: "agents.control.newAgent" }),
    );
    fireEvent.change(screen.getByLabelText("agents.control.name"), {
      target: { value: "Research Agent" },
    });
    fireEvent.change(screen.getByLabelText("agents.control.systemPrompt"), {
      target: { value: "Research carefully" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "agents.control.saveLocal" }),
    );

    await waitFor(() => expect(agentera.createDraft).toHaveBeenCalledTimes(1));
    expect(hermes.createProfile).not.toHaveBeenCalled();
    expect(hermes.syncAgents).not.toHaveBeenCalled();
    expect(hermes.getAgentSyncStatus).toHaveBeenCalledTimes(syncStatusCalls);
  });

  // Profile deletion (optimistic hide + rollback on failure) moved out of the
  // Agents screen into the ProfileModal danger zone, so its rendering tests no
  // longer belong here. The Agents screen only opens that modal now.
});
