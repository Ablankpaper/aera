import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  AgenteraAgentInstallationSummary,
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

describe("OfficialAgentSection", () => {
  it("shows an online official source and requests a fresh isolated install", () => {
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
    expect(
      screen.getByText("agents.control.official.freshProfileBoundary"),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", {
        name: "agents.control.official.install",
      }),
    );
    expect(onInstall).toHaveBeenCalledWith(DEFINITION_ID);
  });

  it("shows a managed update for new conversations without changing existing ones", () => {
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

    expect(
      screen.getByText("agents.control.official.updateReady"),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "agents.control.official.existingConversationsUnchanged",
      ),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", {
        name: "agents.control.official.applyUpdate",
      }),
    );
    expect(onApplyUpdate).toHaveBeenCalledWith(INSTALLATION_ID);
  });

  it("shows only verified local official installations offline and disables remote actions", () => {
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

    expect(
      screen.getByText("agents.control.official.offlineLocalVersion"),
    ).toBeTruthy();
    expect(
      screen.getByText("agents.control.official.offlineMayBeStale"),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", {
        name: "agents.control.official.install",
      }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", {
        name: "agents.control.official.applyUpdate",
      }),
    ).toBeNull();
  });
});
