import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgenteraAgentInstallationSummary,
  OfficialAgentDetail,
  OfficialAgentSummary,
  OfficialManagedUpdate,
} from "../../../../shared/agentera-agent-control";
import OfficialAgentSection from "./OfficialAgentSection";

vi.mock("../../components/useI18n", () => ({
  useI18n: () => ({ t: (key: string): string => key }),
}));

const DEFINITION_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const INSTALLATION_ID = "33333333-3333-4333-8333-333333333333";
const RELEASE_ID = "44444444-4444-4444-8444-444444444444";
const REVISION_ID = "55555555-5555-4555-8555-555555555555";

function agent(
  overrides: Partial<OfficialAgentSummary> = {},
): OfficialAgentSummary {
  return {
    definitionId: DEFINITION_ID,
    displayName: "Official Research Agent",
    iconMediaType: null,
    iconDataBase64Url: null,
    versionId: VERSION_ID,
    versionNumber: 1,
    releaseId: RELEASE_ID,
    releaseRevisionId: REVISION_ID,
    channel: "stable",
    runtimeMinimumVersion: "v0.18.2-agentera.1",
    runtimeMaximumVersionExclusive: null,
    installationState: "not_installed",
    updateState: "current",
    ...overrides,
  };
}

function installation(): AgenteraAgentInstallationSummary {
  return {
    id: INSTALLATION_ID,
    sourceScope: "PLATFORM",
    officialReleaseId: RELEASE_ID,
    selectedReleaseRevisionId: REVISION_ID,
    updatePolicy: "managed",
    definitionId: DEFINITION_ID,
    selectedVersionId: VERSION_ID,
    runtimeProfileId: "66666666-6666-4666-8666-666666666666",
    policySnapshotId: "77777777-7777-4777-8777-777777777777",
    status: "active",
    retryCode: null,
    createdAt: "2026-07-22T00:00:00.000Z",
    updatedAt: "2026-07-22T00:00:00.000Z",
  };
}

function detail(): OfficialAgentDetail {
  return {
    agent: agent(),
    capabilitySummary: "Official capability summary",
    assetCounts: { skill: 2, sop: 1, knowledge: 3 },
    allowedProviders: ["openai"],
    allowedModels: ["openai/gpt-5.6"],
    allowedToolCount: 4,
  };
}

let getOfficialAgentDetail: ReturnType<typeof vi.fn>;

describe("OfficialAgentSection", () => {
  beforeEach(() => {
    getOfficialAgentDetail = vi.fn(async () => ({
      ok: true as const,
      data: detail(),
    }));
    Object.defineProperty(window, "agenteraAgents", {
      configurable: true,
      value: { getOfficialAgentDetail },
    });
  });

  it("opens an official detail and requests a fresh isolated install", async () => {
    const onInstall = vi.fn();
    render(
      <OfficialAgentSection
        online
        agents={[agent()]}
        installations={[]}
        updates={[]}
        busyInstallationId={null}
        onInstall={onInstall}
        onApplyUpdate={vi.fn()}
      />,
    );

    expect(screen.getByText("Official Research Agent")).toBeTruthy();
    expect(screen.getByText("agents.control.official.badge")).toBeTruthy();
    fireEvent.click(
      screen.getByText("Official Research Agent").closest("button")!,
    );
    expect(
      await screen.findByRole("dialog", { name: "Official Research Agent" }),
    ).toBeTruthy();
    expect(await screen.findByText("Official capability summary")).toBeTruthy();
    expect(getOfficialAgentDetail).toHaveBeenCalledWith(DEFINITION_ID);
    fireEvent.click(
      screen.getByRole("button", {
        name: "agents.hub.installAgent",
      }),
    );
    expect(onInstall).toHaveBeenCalledWith(DEFINITION_ID);
  });

  it("offers a managed update from the Agent detail", async () => {
    const update: OfficialManagedUpdate = {
      installationId: INSTALLATION_ID,
      expectedSelectedReleaseRevisionId: REVISION_ID,
      targetReleaseRevisionId: "88888888-8888-4888-8888-888888888888",
      targetVersionId: "99999999-9999-4999-8999-999999999999",
    };
    const onApplyUpdate = vi.fn();
    render(
      <OfficialAgentSection
        online
        agents={[
          agent({
            installationState: "installed",
            updateState: "update_available",
          }),
        ]}
        installations={[installation()]}
        updates={[update]}
        busyInstallationId={null}
        onInstall={vi.fn()}
        onApplyUpdate={onApplyUpdate}
      />,
    );

    expect(screen.getByText("agents.hub.updateAvailable")).toBeTruthy();
    fireEvent.click(
      screen.getByText("Official Research Agent").closest("button")!,
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
      expect(onApplyUpdate).toHaveBeenCalledWith(INSTALLATION_ID),
    );
  });

  it("keeps a verified local official Agent usable as a card offline without remote actions", async () => {
    render(
      <OfficialAgentSection
        online={false}
        agents={[]}
        installations={[installation()]}
        updates={[]}
        busyInstallationId={null}
        onInstall={vi.fn()}
        onApplyUpdate={vi.fn()}
      />,
    );

    const offlineCard = screen
      .getByText("agents.control.official.installedSource")
      .closest("button");
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
    expect(getOfficialAgentDetail).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", {
        name: "agents.hub.installAgent",
      }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", {
        name: "agents.control.official.applyUpdate",
      }),
    ).toBeNull();
  });
});
